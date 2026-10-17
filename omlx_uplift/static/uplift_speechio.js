/* VOICE-10: chunked TTS playback engine — pure logic, no DOM, no i18n.
   Two reusable pieces the auto-speak pipeline (VOICE-11) consumes:

   1. a STREAMING text chunker. splitSpeechChunks(text, mode, minFloor) is
      the one-shot shape; createSpeechSplitter(opts) is the shape the live
      LLM stream feeds (push(delta) -> complete chunks, flush() -> tail).
      Boundaries per mode, a MINIMUM FLOOR (the server's _split_tts_text
      has none — small chunks mean many round-trips and choppy prosody),
      and a hard CAP that breaks at [,;:] before it cuts.
      Feeding deltas of stable text yields EXACTLY the one-shot split: a
      boundary is only honoured once at least one character past it has
      arrived (plus the whole window at the tail, via flush()).

   2. SpeechQueue — strictly-ordered, gapless AudioBuffer scheduling. One
      request per chunk (V1 = one whole WAV per chunk; the per-chunk
      `source` seam is what progressive PCM later swaps into), decoded to
      AudioBuffer, then scheduled start = max(ctx.currentTime, prevEnd) so
      clips butt against each other sample-exactly. Loads run AHEAD of
      playback (prefetch) but scheduling follows sequence order: a slow
      synth for chunk 2 can never overtake chunk 1. stop() bumps the
      session token, tears down live sources and discards everything in
      flight — the generalised `_speakAbort` contract from uplift_chat.js
      msgSpeak (late .then sees a stale token, so it lands nowhere).
      Error policy: a failed chunk is SKIPPED (never a silent stall
      mid-speech), max one retry, and the dropped-chunk accounting is in
      the drain() result + onDrop — the single toast is VOICE-11's.

   Everything environmental is injected, so node tests run without Web
   Audio or fetch: {ctx} is any AudioContext-shaped object, {source} or
   {request}+{fetchLike} produce the bytes, {decode} turns bytes into
   AudioBuffer-shaped objects. */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.UpliftSpeechIo = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var MODES = { sentence: 1, line: 1, paragraph: 1, whole: 1 };
    var DEFAULT_MODE = 'sentence';
    var DEFAULT_FLOOR = 60;            // UI ladder is 40 / 60 / 120
    var DEFAULT_CAP = 400;             // mirrors the server's max_chars idea
    var CAP_SLACK = 16;                // a boundary inside [cap, cap+slack) wins
    var SENT_BREAK = '.!?…。！？';
    var SOFT_BREAK = ',;:，；：、';
    var THINK_OPEN = ['<thinking>', '<reasoning>', '<thought>'];
    var THINK_CLOSE = ['</thinking>', '</reasoning>', '</thought>'];

    function isSentenceEnd(ch) { return SENT_BREAK.indexOf(ch) >= 0; }
    function isSoftBreak(ch) { return SOFT_BREAK.indexOf(ch) >= 0; }

    /* reasoning spills: swallow everything between an open tag and its
       close, across lines (st carries the flag between the sanitizer's
       line callbacks). Must run BEFORE the generic html-tag strip, which
       would otherwise erase the marker and speak the chain of thought. */
    function stripReasoning(s, st) {
        var out = '';
        var i = 0;
        while (i < s.length) {
            var at = -1, end = -1, k;
            if (st.inThink) {
                for (k = 0; k < THINK_CLOSE.length; k++) {
                    var c = s.indexOf(THINK_CLOSE[k], i);
                    if (c >= 0 && (at < 0 || c < at)) { at = c; end = c + THINK_CLOSE[k].length; }
                }
                if (at < 0) return out;               // still swallowed
                st.inThink = false;
                i = end;
            } else {
                for (k = 0; k < THINK_OPEN.length; k++) {
                    var o = s.indexOf(THINK_OPEN[k], i);
                    if (o >= 0 && (at < 0 || o < at)) { at = o; end = o + THINK_OPEN[k].length; }
                }
                if (at < 0) { out += s.slice(i); break; }
                out += s.slice(i, at);
                st.inThink = true;
                i = end;
            }
        }
        return out;
    }

    function normChunk(s) {
        // one chunk = one prosodic unit: internal line breaks and
        // indentation carry no audio meaning and skew the length maths
        return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    }

    function skipWs(s, i) {
        while (i < s.length && /\s/.test(s.charAt(i))) i++;
        return i;
    }

    /* ---- sanitize ------------------------------------------------------
       Plain-text projection for the SPEECH path. uplift_chat.js's
       stripMarkdown keeps fenced code as text (right for Copy, wrong for
       reading aloud), so this is a stricter sibling: it DROPS code fences,
       tables, rules, reasoning spills and blockquote/heading/bullet
       markers, and flattens inline markup. It is a line state machine fed
       by deltas — an unterminated line is held back until its newline
       arrives, so incremental sanitising == sanitising the whole text.   */
    function cleanLine(line, st) {
        var s = String(line);
        if (/^\s*(```|~~~)/.test(s)) {                    // fence toggle: dropped
            st.inFence = !st.inFence;
            return '';
        }
        if (st.inFence) return '';
        if (/^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(s)) return '';    // table rule row
        if (/^\s*\|.*\|?\s*$/.test(s)) return '';               // table row
        if (/^\s*([-*_]\s*){3,}$/.test(s)) return '';           // thematic break
        s = stripReasoning(s, st);                              // chain of thought
        if (!s.trim()) return '';
        s = s.replace(/^\s*(>\s?)+/, '');                       // blockquote
        s = s.replace(/^\s*#{1,6}\s+/, '');                     // heading
        s = s.replace(/^\s*[-*+]\s+/, '');                      // bullet
        s = s.replace(/^\s*\d+[.)]\s+/, '');                    // list number
        s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');        // links/images
        s = s.replace(/`([^`]*)`/g, '$1');                      // inline code
        s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
        s = s.replace(/(\*|_)(.*?)\1/g, '$2');
        s = s.replace(/<[^>]*>/g, '');                          // raw html
        return s.replace(/\s+/g, ' ').trim();
    }

    function createSpeechSanitizer() {
        var st = { inFence: false, inThink: false, line: '', pending: '' };

        function add(text) {
            st.pending += (st.pending ? ' ' : '') + text + ' ';
        }

        function take() {
            var s = st.pending;
            st.pending = '';
            return s.trim();
        }

        function commit() {
            var nl = st.line.indexOf('\n');
            while (nl >= 0) {
                var outLine = st.line.slice(0, nl);
                st.line = st.line.slice(nl + 1);
                var clean = cleanLine(outLine, st);
                if (clean) add(clean);
                nl = st.line.indexOf('\n');
            }
        }

        return {
            push: function (delta) {
                if (!delta) return '';
                st.line += String(delta);
                commit();
                return take();
            },
            flush: function () {
                if (st.line && !st.inFence) {
                    var tail = cleanLine(st.line, st);
                    if (tail) add(tail);
                }
                st.line = '';
                st.inFence = false;
                return take();
            },
            state: function () { return st; },
        };
    }

    function sanitizeSpeechText(text) {
        var z = createSpeechSanitizer();
        var s = z.push(String(text == null ? '' : text));
        return (s + ' ' + z.flush()).replace(/\s+/g, ' ').trim();
    }

    /* ---- splitter ------------------------------------------------------
       Emission rule: cut ONLY at a boundary AND only once the pending text
       has reached minFloor (short sentences merge into their neighbours);
       the CAP guard always fires, so pending can never exceed cap+slack. */
    function createSpeechSplitter(opts) {
        opts = opts || {};
        var mode = MODES[opts.mode] ? opts.mode : DEFAULT_MODE;
        var floor = Math.max(1, opts.minFloor == null ? DEFAULT_FLOOR
                                                      : (opts.minFloor | 0));
        var cap = (opts.cap === 0 || opts.cap === false) ? 0
            : Math.max(floor + 1, opts.cap == null ? DEFAULT_CAP : (opts.cap | 0));
        var buf = '';
        var out = [];

        function emit(s) {
            var c = normChunk(s);
            if (c) out.push(c);
        }

        /* cap guard: break at the last soft [,;:] in the window, else right
           at the cap. Needs the window fully present (or `force` at flush),
           so the cut never depends on how the text was fed. */
        function capCut(from, force) {
            var avail = buf.length - from;
            if (avail < cap + CAP_SLACK && !(force && avail > cap)) return from;
            var hard = Math.min(from + cap, buf.length);
            var best = -1;
            for (var i = Math.min(hard, buf.length - 1); i >= from + floor; i--) {
                if (isSoftBreak(buf.charAt(i))) { best = i + 1; break; }
            }
            var cutAt = best > 0 ? skipWs(buf, best) : hard;
            if (cutAt <= from) cutAt = hard;
            emit(buf.slice(from, cutAt));
            return cutAt;
        }

        function paraEnd(i) {
            // a blank-line run ('\n' [ \t]* '\n') starting at i, fully present
            var j = i;
            while (j < buf.length) {
                var ch = buf.charAt(j);
                if (ch === '\n') {
                    var k = j + 1;
                    while (k < buf.length && (buf.charAt(k) === ' ' ||
                           buf.charAt(k) === '\t' || buf.charAt(k) === '\r')) k++;
                    if (buf.charAt(k) === '\n') return k + 1;
                    return -1;               // incomplete — wait for more text
                }
                if (ch !== ' ' && ch !== '\t' && ch !== '\r') return -1;
                j++;
            }
            return -1;
        }

        function boundaryAt(i) {
            var ch = buf.charAt(i);
            if (mode === 'sentence')
                return (isSentenceEnd(ch) || ch === '\n') ? skipWs(buf, i + 1) : -1;
            if (mode === 'line')
                return (ch === '\n' || ch === '\r') ? skipWs(buf, i + 1) : -1;
            if (mode === 'paragraph') {
                // ONLY a blank-line run is a paragraph boundary; a wrapped
                // line is not (that is what distinguishes this mode from line)
                return ch === '\n' ? paraEnd(i) : -1;
            }
            return -1;                                  // 'whole': cap/flush only
        }

        function scan(final) {
            out = [];
            var from = 0;
            var lastBoundary = -1;
            var i = 0;
            while (i < buf.length) {
                var b = boundaryAt(i);
                if (b > lastBoundary) lastBoundary = b;
                // a boundary at the very end of the buffer is NOT yet honoured:
                // incremental feeding must decide exactly like whole text
                if (lastBoundary > from && lastBoundary - from >= floor &&
                        (final || lastBoundary < buf.length)) {
                    emit(buf.slice(from, lastBoundary));
                    from = lastBoundary;
                    lastBoundary = -1;
                    i = from;
                    continue;
                }
                // cap guard: the scan covered [from, from+cap+slack) without a
                // floor-valid boundary turning up, so cut at the last soft break
                if (cap && i >= from + cap + CAP_SLACK - 1) {
                    var nc = capCut(from, false);
                    if (nc > from) { from = nc; lastBoundary = -1; i = from; continue; }
                }
                i++;
            }
            if (final && cap && buf.length - from > cap) {
                var nc2 = capCut(from, true);
                if (nc2 > from) from = nc2;
            }
            buf = buf.slice(from);
            return out;
        }

        return {
            mode: mode, minFloor: floor, cap: cap,
            /* feed one stream delta; returns the chunks that are complete */
            push: function (delta) {
                if (delta) buf += String(delta);
                return scan(false);
            },
            /* turn end: the remainder goes out whatever its length */
            flush: function () {
                var chunks = scan(true);
                var tail = normChunk(buf);
                buf = '';
                if (tail) chunks.push(tail);
                return chunks;
            },
            pending: function () { return buf; },
        };
    }

    function splitSpeechChunks(text, mode, minFloor, opts) {
        var o = (mode && typeof mode === 'object') ? mode : (opts || {});
        var z = createSpeechSplitter({
            mode: (mode && typeof mode === 'object') ? mode.mode : mode,
            minFloor: (mode && typeof mode === 'object') ? mode.minFloor : minFloor,
            cap: o.cap,
        });
        var src = String(text == null ? '' : text);
        var s = (o.sanitize === false) ? src : sanitizeSpeechText(src);
        return z.push(s).concat(z.flush());
    }

    /* ---- SpeechQueue --------------------------------------------------
       Two clocks, deliberately separate:
         load side  — chunk N+1/N+2/N+3 are requested+decoded while chunk N
                      plays (opts.prefetch caps the in-flight requests);
         schedule side — a buffer is only ever scheduled once every LOWER
                      seq is settled, and its start time is the previous
                      clip's end, so the seam is sample-exact.            */
    var SETTLED = { played: 1, failed: 1, stale: 1 };

    function SpeechQueue(opts) {
        if (!(this instanceof SpeechQueue)) return new SpeechQueue(opts);
        opts = opts || {};
        var ctx = opts.ctx || null;
        var request = opts.request || null;       // (chunk, seq) -> {url, body}
        var source = opts.source || null;         // (chunk, seq) -> Promise|bytes
        var fetchLike = opts.fetchLike || null;   // (url, body) -> Promise<Response>
        var decode = opts.decode || null;         // (bytes, ctx) -> AudioBuffer(s)
        var retries = opts.retries == null ? 1 : Math.max(0, opts.retries | 0);
        var prefetch = opts.prefetch == null ? 4 : Math.max(1, opts.prefetch | 0);
        var onSource = opts.onSource || null;     // (item, srcNode) — visualiser
        var onDrop = opts.onDrop || null;         // (info)         — toast accounting
        var destination = opts.destination || null;  // GainNode etc. (volume ducking)

        var items = [];               // FIFO; index === seq
        var token = 0;                // stop() bumps it; in-flight work sees stale
        var prevEnd = 0;              // clock position the next clip starts at
        var live = [];                // scheduled, not yet ended
        var inflight = 0;             // loads in flight
        var dropped = [];
        var played = 0;
        var stopped = false;
        var waiters = [];
        var schedIdx = 0;         // next item allowed to be scheduled
        var doneMarker = 0;       // drain() snapshot of items.length

        function transport() {
            if (fetchLike) return fetchLike;
            return function (url, body) {
                var V = (typeof window !== 'undefined' && window.Uplift)
                        ? window.Uplift.voices : null;
                if (!V || !V.speechJson)
                    return Promise.reject(new Error(
                        'SpeechQueue: no transport seam — pass {source} or {fetchLike}, '
                        + 'or load the voices module'));
                return V.speechJson(url, body);
            };
        }

        function decodeBytes(bytes) {
            if (bytes == null) throw new Error('empty audio response');
            // AudioBuffer-shaped already? (fake ctxs and cached buffers)
            if (typeof bytes.duration === 'number') return bytes;
            if (Array.isArray(bytes)) {
                if (!bytes.length) throw new Error('empty audio buffer list');
                return bytes;                       // progressive PCM: clip list
            }
            // fetch Response -> ArrayBuffer (cross-realm safe: duck-typed)
            if (typeof bytes.arrayBuffer === 'function')
                return Promise.resolve(bytes.arrayBuffer()).then(decodeBytes);
            if (decode) return decode(bytes, ctx);
            if (ctx && typeof ctx.decodeAudioData === 'function') {
                return new Promise(function (res, rej) {
                    var p = ctx.decodeAudioData(bytes, res, rej);
                    if (p && typeof p.then === 'function') p.then(res, rej);
                });
            }
            throw new Error('SpeechQueue: no decode seam — pass {decode} or a '
                + '{ctx} with decodeAudioData');
        }

        function makeSource(buf) {
            if (!ctx || typeof ctx.createBufferSource !== 'function')
                throw new Error('SpeechQueue: {ctx} with createBufferSource is required');
            var src = ctx.createBufferSource();
            src.buffer = buf;
            try { src.connect(destination || ctx.destination || null); } catch (e) {}
            return src;
        }

        function runSource(src, at) {
            return new Promise(function (resolve) {
                var done = false;
                src.onended = function () {
                    if (done) return;
                    done = true;
                    try { src.disconnect(); } catch (e) {}
                    var k = live.indexOf(src);
                    if (k >= 0) live.splice(k, 1);
                    resolve();
                };
                live.push(src);          // before start(): a fake ctx may end sync
                try { src.start(at); } catch (e) { src.onended(); return; }
            });
        }

        /* schedule one clip list back-to-back on the shared clock */
        function schedule(item, bufList) {
            var list = Array.isArray(bufList) ? bufList : [bufList];
            var ends = [];
            for (var i = 0; i < list.length; i++) {
                var buf = list[i];
                if (!buf) continue;
                var src = makeSource(buf);
                var at = Math.max(ctx.currentTime || 0, prevEnd);
                prevEnd = at + (typeof buf.duration === 'number' ? buf.duration : 0);
                src.__seq = item.seq;
                if (onSource) { try { onSource(item, src); } catch (e) {} }
                ends.push(runSource(src, at));
            }
            item.state = 'playing';
            item.starts = ends.length;
            return ends.length ? Promise.all(ends) : Promise.resolve();
        }

        function attempt(item) {
            var p = item.source ? item.source(item.chunk, item.seq)
                    : source ? source(item.chunk, item.seq)
                    : (function () {
                        var spec = request ? request(item.chunk, item.seq)
                                           : { url: '/voices/speech',
                                              body: { input: item.chunk } };
                        return transport()(spec.url, spec.body);
                    })();
            return Promise.resolve(p).then(decodeBytes);
        }

        function load(item) {
            var tries = 0;
            function go() {
                return attempt(item).catch(function (e) {
                    if (tries++ < retries) return go();     // max one retry
                    throw e;
                });
            }
            inflight++;
            item.state = 'loading';
            go().then(function (bufs) {
                inflight--;
                if (item.token !== token) { item.state = 'stale'; return; }
                item.buffers = bufs;
                item.state = 'ready';
                dispatch();
                advance();
            }, function (e) {
                inflight--;
                var info = { seq: item.seq, chunk: item.chunk, error: e,
                             token: token };
                item.state = (item.token !== token) ? 'stale' : 'failed';
                if (item.state === 'failed') {
                    dropped.push(info);
                    if (onDrop) { try { onDrop(info); } catch (_) {} }
                }
                dispatch();
                advance();
            });
        }

        /* start loads for the oldest not-yet-loaded chunks, capped */
        function dispatch() {
            for (var i = 0; i < items.length && inflight < prefetch; i++) {
                if (items[i].state === '') load(items[i]);
            }
        }

        /* the ordered half: hand out clips strictly by sequence. schedIdx is
           the next item allowed to be scheduled, so nothing plays before a
           LOWER sequence number settles (played or dropped) — a slow synth
           for chunk 2 can never overtake chunk 1. Scheduling the next clip
           while the current one still plays is what makes the seam gapless,
           so a 'playing' item must NOT block the pipeline. */
        function advance() {
            while (schedIdx < items.length) {
                var it = items[schedIdx];
                if (it.state === 'failed') it.state = 'stale';
                if (SETTLED[it.state]) { schedIdx++; continue; }
                if (it.state !== 'ready') { checkDone(); return; }  // queued/loading
                (function (item) {
                    schedIdx++;
                    var p = schedule(item, item.buffers);
                    checkDone();
                    p.then(function () {
                        if (item.token !== token) { item.state = 'stale'; return; }
                        item.state = 'played';
                        played++;
                        advance();
                        checkDone();
                    });
                })(it);
            }
            checkDone();
        }

        function allSettled(upto) {
            for (var i = 0; i < upto && i < items.length; i++)
                if (!SETTLED[items[i].state]) return false;
            return true;
        }

        function result() {
            return { played: played, dropped: dropped.slice(),
                     stopped: stopped, live: live.length };
        }

        function checkDone() {
            if (live.length || !allSettled(doneMarker)) return;
            var w = waiters; waiters = [];
            for (var i = 0; i < w.length; i++) w[i](result());
        }


        return {
            /* append one chunk (a bare string, or {text, source} to give THIS
               chunk its own byte source — the progressive-PCM / cache seam).
               Returns its sequence number, or -1 when it sanitised away. */
            push: function (chunk) {
                var text = normChunk(chunk && typeof chunk === 'object'
                                      ? chunk.text : chunk);
                if (!text) return -1;
                var item = { seq: items.length, chunk: text, state: '',
                             token: token, buffers: null, source: null };
                if (chunk && typeof chunk === 'object' && chunk.source)
                    item.source = chunk.source;
                items.push(item);
                doneMarker = Math.max(doneMarker, items.length);
                dispatch();
                return item.seq;
            },
            /* resolves when every chunk pushed SO FAR has settled (played,
               dropped or stale) and the last clip ended. Push during the wait
               is fine: call drain() again after the final flush(). */
            drain: function () {
                doneMarker = items.length;
                checkDone();
                if (allSettled(doneMarker) && !live.length) return Promise.resolve(result());
                return new Promise(function (resolve) { waiters.push(resolve); });
            },
            /* kill playback and discard everything in flight (token bump —
               the stale .then of an already-sent request lands nowhere) */
            stop: function () {
                token++;
                stopped = true;
                var dying = live.slice();
                live = [];
                for (var i = 0; i < dying.length; i++) {
                    try { dying[i].stop && dying[i].stop(); } catch (e) {}
                    try { dying[i].disconnect(); } catch (e) {}
                }
                for (var j = 0; j < items.length; j++)
                    if (!SETTLED[items[j].state]) items[j].state = 'stale';
                prevEnd = 0;
                var w = waiters; waiters = [];
                for (var k = 0; k < w.length; k++) w[k](result());
                return token;
            },
            /* resume appending after stop() (new session, fresh clock) */
            reset: function () { stopped = false; prevEnd = 0; return token; },
            token: function () { return token; },
            played: function () { return played; },
            dropped: function () { return dropped.slice(); },
            queued: function () { return items.slice(); },
            pending: function () {
                return items.filter(function (it) { return !SETTLED[it.state]; }).length;
            },
            /* the clock position the next clip starts at (ms-accurate seam) */
            clock: function () { return prevEnd; },
            liveSources: function () { return live.slice(); },
        };
    }

    var API = {
        MODES: MODES,
        DEFAULT_FLOOR: DEFAULT_FLOOR,
        DEFAULT_CAP: DEFAULT_CAP,
        sanitizeSpeechText: sanitizeSpeechText,
        createSpeechSanitizer: createSpeechSanitizer,
        createSpeechSplitter: createSpeechSplitter,
        splitSpeechChunks: splitSpeechChunks,
        SpeechQueue: SpeechQueue,
    };
    if (typeof window !== 'undefined' && window) {
        window.Uplift = window.Uplift || {};
        window.Uplift.speechio = API;
    }
    return API;
});
