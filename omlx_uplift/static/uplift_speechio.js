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
       by deltas.

       VOICE-11a: it no longer waits for the newline. A whole-line PREDICATE
       (fence toggle, fence body, table row) is decided by the line's prefix,
       so the suppression can be applied as soon as the first characters of a
       line arrive; only the `$`-anchored predicates (rule row, thematic break)
       stay ambiguous for a prefix, and those HOLD — never guess. Text inside a
       prose line is then handed to the splitter word by word (a full-width
       sentence end counts as a word break), each piece emitted only once it is
       ANCHOR-SETTLED (the line-start marker run can no longer grow) and
       CONSTRUCT-CLEAN (after the same inline removals nothing of ` * _ [ <`
       and no trailing ! is left open, so no emphasis pair, link target,
       inline-code span, html tag or thinking tag can straddle the cut). What
       goes out early is therefore exactly what the whole-line cleaner would
       have produced — incremental sanitising still equals sanitising the whole
       text — a stray '**' is never spoken, because a segment with a dangling
       marker is held for its line instead, and the SENTENCE decision stays
       where it belongs: in the splitter. sanitizeSpeechText asks for
       provisional:false, so the one-shot output is byte-identical; only the
       live stream cuts early.                                            */
    var LINE_FENCE = /^\s*(```|~~~)/;             // fence toggle (whole line)
    var LINE_RULE = /^\s*\|?[\s:|-]*\|[\s:|-]*$/;   // table alignment row
    var LINE_ROW = /^\s*\|.*\|?\s*$/;              // table row
    var LINE_HR = /^\s*([-*_]\s*){3,}$/;           // thematic break
    var CJK_END = '。！？…';       // VOICE-11a: sentence end, no space follows

    function cleanSpan(s, st, head) {
        /* everything a line — or one provisional slice of a line — gets after
           the whole-line predicates. head:false is a mid-line remainder: the
           anchored markers (blockquote/heading/bullet/list) are LINE-START
           properties, already applied to the segment that opened the line. */
        s = stripReasoning(s, st);                              // chain of thought
        if (!s.trim()) return '';
        if (head) {
            s = s.replace(/^\s*(>\s?)+/, '');                   // blockquote
            s = s.replace(/^\s*#{1,6}\s+/, '');                 // heading
            s = s.replace(/^\s*[-*+]\s+/, '');                  // bullet
            s = s.replace(/^\s*\d+[.)]\s+/, '');                // list number
        }
        s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');        // links/images
        s = s.replace(/`([^`]*)`/g, '$1');                      // inline code
        s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
        s = s.replace(/(\*|_)(.*?)\1/g, '$2');
        s = s.replace(/<[^>]*>/g, '');                          // raw html
        return s.replace(/\s+/g, ' ').trim();
    }

    function dropLine(s, st) {
        if (LINE_FENCE.test(s)) { st.inFence = !st.inFence; return true; }
        if (st.inFence) return true;
        if (LINE_RULE.test(s)) return true;
        if (LINE_ROW.test(s)) return true;
        if (LINE_HR.test(s)) return true;
        return false;
    }

    function cleanLine(line, st) {
        var s = String(line);
        if (dropLine(s, st)) return '';
        return cleanSpan(s, st, true);
    }

    /* VOICE-11a: the predicates decided on a line PREFIX. 'drop' is final —
       a fence opener, a fence body or a leading pipe can never stop being
       what they look like. 'hold' waits for the newline (a `---` prefix may
       still grow into `-- prose`; blank text has not declared itself yet). */
    function headKind(s, st) {
        if (LINE_FENCE.test(s) || st.inFence || LINE_ROW.test(s)) return 'drop';
        if (st.inThink || LINE_RULE.test(s) || LINE_HR.test(s) || !s.trim())
            return 'hold';
        return 'go';
    }

    /* VOICE-11a: the anchored strips (blockquote / heading / bullet / list
       number) all need the whitespace AFTER the marker to decide, so a head
       segment that is nothing but marker characters ('1.', '###', '> >') may
       still grow into a marker the whole line loses. Hold it until a real word
       character arrives — after that the match, if any, is already complete
       inside the segment, because none of those regexes can cross one. */
    var HEAD_WORD = /[^\s>#*+\-.0-9]/;
    function anchorSettled(seg) { return HEAD_WORD.test(seg); }

    /* VOICE-11a: may [0, at) be spoken now? Run cleanSpan's own replacements
       in its own order and, after each one, demand that its opener is GONE:
       a leftover means a construct is still open at the cut and the whole-line
       cleaner would have paired it with something past it (which shifts every
       pairing after that point). Held instead, the segment goes out through the
       line path unchanged — conservative, never wrong, and it is what keeps
       'incremental sanitising == sanitising the whole text' true for text that
       carries bold, links, inline code or thinking tags. */
    function segClean(seg, st) {
        if (st.inThink) return false;
        var s = seg, k;
        for (k = 0; k < THINK_OPEN.length; k++)
            if (s.indexOf(THINK_OPEN[k]) >= 0) return false;
        s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');       // links/images
        if (/\[/.test(s) || /!$/.test(s)) return false;
        s = s.replace(/`([^`]*)`/g, '$1');                     // inline code
        if (/`/.test(s)) return false;
        s = s.replace(/(\*\*|__)(.*?)\1/g, '$2');
        s = s.replace(/(\*|_)(.*?)\1/g, '$2');                 // emphasis
        if (/[*_]/.test(s)) return false;
        s = s.replace(/<[^>]*>/g, '');                         // raw html
        return !/</.test(s);
    }

    function createSpeechSanitizer(opts) {
        opts = opts || {};
        /* VOICE-11a: provisional = the live stream (speak a sentence the moment
           its boundary is unambiguous). The one-shot sanitizeSpeechText opts
           out, so its output stays exactly the line-complete projection. */
        var live = opts.provisional !== false;
        var st = { inFence: false, inThink: false, line: '', pending: '',
                   head: true, ws: false, emitted: false };

        function add(text) {
            if (!text) return;
            // VOICE-11a: st.ws = whitespace that passed in the source since the
            // last emitted character; the projection collapses it to one space,
            // so the join is re-put IN FRONT of the text that follows (never at
            // the end of text already handed over, where two whitespace events
            // in a row would put two spaces where the line has one). Nothing is
            // glued in front of the first words: the whole-text projection is
            // trimmed at its start.
            if (st.ws && st.emitted) st.pending += ' ';
            st.pending += text;
            st.ws = false;
            st.emitted = true;
        }

        function take() {
            var s = st.pending;
            st.pending = '';
            return s;
        }

        function finish(raw) {
            // VOICE-11a: the join sits in front of the raw text being consumed
            // (whitespace that arrived after the previous cut, before the
            // cleaner trimmed it away) — line-end AND flush paths both count.
            if (/^\s/.test(raw)) st.ws = true;
            // a line whose head already went out is cleaned as a SPAN: the
            // line-drop predicates and the anchored markers are line-start
            // properties, decided/applied when the head segment was emitted
            return st.head ? cleanLine(raw, st) : cleanSpan(raw, st, false);
        }

        function commit() {
            var nl = st.line.indexOf('\n');
            while (nl >= 0) {
                var outLine = st.line.slice(0, nl);
                st.line = st.line.slice(nl + 1);
                var clean = finish(outLine);
                st.head = true;
                if (clean) add(clean);
                st.ws = true;         // VOICE-11a: the newline is whitespace
                nl = st.line.indexOf('\n');
            }
            provisional();
        }

        /* VOICE-11a: the last point of the pending line the stream can hand
           over — a WORD end (the whitespace run after it is consumed) or a
           full-width sentence end — whose text before it is settled and
           construct-clean. Earlier points are tried when a later one sits
           inside bold/code/a link, so one unresolvable construct never holds
           back the prose that came before it. Word granularity is what makes
           the live timing equal to feeding clean text raw: the splitter cuts a
           sentence one character into the NEXT one, not one sentence into it. */
        function findCut(s) {
            for (var i = s.length - 1; i >= 0; i--) {
                var ch = s.charAt(i);
                if (/\s/.test(ch)) continue;              // whitespace never cuts
                var wide = CJK_END.indexOf(ch) >= 0;
                var j = skipWs(s, i + 1);
                if (j === i + 1 && !wide) continue;       // 'oneTwo': not a break
                var seg = s.slice(0, j);
                // the cut ate the whitespace after the word: that run is the
                // join into whatever comes next (a full-width end may have
                // none, and then the next piece follows with no space at all)
                if ((!st.head || anchorSettled(seg)) && segClean(seg, st))
                    return { at: j, ws: j > i + 1 };
            }
            return null;
        }

        function provisional() {
            if (!live) return;
            var guard = 0;
            while (st.line && guard++ < 64) {
                if (st.head && headKind(st.line, st) !== 'go') return;
                var cut = findCut(st.line);
                if (!cut) return;
                var seg = st.line.slice(0, cut.at);
                var clean = cleanSpan(seg, st, st.head);
                if (!clean) return;     // markers only: the line path decides
                if (/^\s/.test(seg)) st.ws = true;   // the join sat inside it
                st.line = st.line.slice(cut.at);
                st.head = false;
                add(clean);
                st.ws = cut.ws;
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
                if (st.line && !(st.head && st.inFence)) {
                    var tail = finish(st.line);
                    if (tail) add(tail);
                }
                st.line = '';
                st.inFence = false;
                st.head = true;
                st.ws = false;
                return take();
            },
            state: function () { return st; },
        };
    }

    function sanitizeSpeechText(text) {
        var z = createSpeechSanitizer({ provisional: false });
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
        var onItem = opts.onItem || null;         // (item, state)  — VOICE-16 row repaint
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
        /* VOICE-16 playhead. A pause does NOT bump the session token — the loads
           in flight stay valid and the buffers stay cached, only the clock moves:
           `paused` remembers where the ear was, `startOffset` is how much of the
           next item was already heard, `soloSeq` limits a one-chunk replay, and
           `autoPlayFrom` restarts playback at a chunk whose ⟳ just landed. */
        var paused = null;        // {seq, offset, solo} | null
        var soloSeq = -1;         // schedule nothing above this seq
        var startOffset = 0;      // seconds of the next item already heard
        var autoPlayFrom = -1;    // seq to play when its reload finishes loading
        var CLIP_EPS = 0.05;      // clock slop: scheduled-ahead seams

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

        function runSource(src, at, lead) {
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
                try { src.start(at, lead || 0); } catch (e) { src.onended(); return; }
            });
        }

        function setState(item, state) {
            // ONE funnel for state changes so a row can never miss a transition
            if (item.state === state) return item.state;
            item.state = state;
            if (onItem) { try { onItem(item, state); } catch (e) {} }
            return state;
        }

        /* schedule one clip list back-to-back on the shared clock.
           `from` = seconds of THIS item the listener already had (the resume
           seam): clips under it are dropped and the containing clip starts
           mid-buffer, so pause/resume keeps the sample-exact seam for
           everything that follows. Every scheduled clip records its clock
           window plus its position inside the item (`t0`), which is what
           position() reads to report progress. */
        function schedule(item, bufList, from) {
            var list = Array.isArray(bufList) ? bufList : [bufList];
            var ends = [];
            var clips = [];
            var skip = from > 0 ? from : 0;
            var acc = 0, total = 0;
            for (var i = 0; i < list.length; i++) {
                var buf = list[i];
                if (!buf) continue;
                var dur = typeof buf.duration === 'number' ? buf.duration : 0;
                total += dur;
                // `skip > 0` matters: a zero-length clip must still be scheduled
                if (skip > 0 && acc + dur <= skip) { acc += dur; continue; }
                var lead = skip > acc ? skip - acc : 0;
                var src = makeSource(buf);
                var at = Math.max(ctx.currentTime || 0, prevEnd);
                var hear = dur - lead > 0 ? dur - lead : 0;
                prevEnd = at + hear;
                src.__seq = item.seq;
                clips.push({ at: at, dur: hear, t0: acc + lead });
                if (onSource) { try { onSource(item, src); } catch (e) {} }
                ends.push(runSource(src, at, lead));
                acc += dur;
            }
            item.duration = total;
            item.clips = clips;
            item.startAt = clips.length ? clips[0].at - clips[0].t0
                                        : (ctx.currentTime || 0);
            setState(item, 'playing');
            item.starts = ends.length;
            return ends.length ? Promise.all(ends) : Promise.resolve();
        }

        function measure(bufs) {
            var list = Array.isArray(bufs) ? bufs : [bufs];
            var t = 0;
            for (var i = 0; i < list.length; i++) {
                var d = list[i] && list[i].duration;
                if (typeof d === 'number') t += d;
            }
            return t;
        }

        /* stop what is on the clock WITHOUT touching the token: in-flight loads
           stay valid, settled chunks stay cached, only the playhead moves. */
        function killLive() {
            var dying = live.slice();
            live = [];
            for (var i = 0; i < dying.length; i++) {
                try { dying[i].stop && dying[i].stop(); } catch (e) {}
                try { dying[i].disconnect(); } catch (e) {}
            }
        }

        /* hand a scheduled/finished chunk back to the scheduler. A chunk whose
           request is still in flight is left alone — its own completion lands it. */
        function rewind(item) {
            item.token = token;
            if (item.state === 'loading') return;
            item.regen = (item.regen || 0) + 1;
            item.clips = null;
            item.startAt = 0;
            setState(item, item.buffers ? 'ready' : '');
        }

        function offsetIn(item, now) {
            var clips = item.clips || [];
            var soFar = 0;
            for (var i = 0; i < clips.length; i++) {
                var c = clips[i];
                if (now < c.at + c.dur) return c.t0 + (now > c.at ? now - c.at : 0);
                soFar = c.t0 + c.dur;
            }
            var d = item.duration || soFar;
            return soFar > d ? soFar : d;
        }

        /* where the ear is right now: {seq, offset, duration, state} */
        function position() {
            if (paused) {
                var pit = items[paused.seq];
                return { seq: paused.seq, offset: paused.offset,
                         duration: (pit && pit.duration) || 0,
                         state: 'paused', paused: true };
            }
            var now = ctx ? (ctx.currentTime || 0) : 0;
            var cur = null;
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it.clips || !it.clips.length) continue;
                if (it.clips[0].at - CLIP_EPS <= now) cur = it;
            }
            if (!cur) {
                var q = 0;
                for (var j = 0; j < items.length; j++)
                    if (!SETTLED[items[j].state]) q++;
                return { seq: -1, offset: 0, duration: 0,
                         state: q ? 'loading' : 'idle' };
            }
            var last = cur.clips[cur.clips.length - 1];
            var until = last.at + last.dur;
            return { seq: cur.seq,
                     offset: offsetIn(cur, now),
                     duration: cur.duration || 0,
                     state: now < until ? 'playing' : cur.state };
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
            setState(item, 'loading');
            go().then(function (bufs) {
                inflight--;
                if (item.token !== token) { setState(item, 'stale'); return; }
                item.buffers = bufs;
                item.duration = measure(bufs);      // the row knows its length
                                                    // before it plays (waveform)
                setState(item, 'ready');
                if (autoPlayFrom === item.seq) {     // ⟳ of the chunk on air
                    autoPlayFrom = -1;
                    seek(item.seq, 0);
                    return;
                }
                dispatch();
                advance();
            }, function (e) {
                inflight--;
                var info = { seq: item.seq, chunk: item.chunk, error: e,
                             token: token };
                setState(item, (item.token !== token) ? 'stale' : 'failed');
                if (item.state === 'failed') {
                    dropped.push(info);
                    if (onDrop) { try { onDrop(info); } catch (_) {} }
                }
                if (autoPlayFrom === item.seq) autoPlayFrom = -1;
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

        /* the ordered playhead handoff, shared by advance()/seek()/resume() */
        function scheduleNext(item) {
            var from = startOffset;
            startOffset = 0;
            var regen = item.regen || 0;
            schedIdx = item.seq + 1;
            var p = schedule(item, item.buffers, from);
            checkDone();
            p.then(function () {
                if ((item.regen || 0) !== regen) return;    // paused/seeked away
                if (item.token !== token) { setState(item, 'stale'); return; }
                item.clips = null;
                setState(item, 'played');
                played++;
                if (soloSeq === item.seq) soloSeq = -1;     // one-chunk play done
                advance();
                checkDone();
            });
        }

        /* the ordered half: hand out clips strictly by sequence. schedIdx is
           the next item allowed to be scheduled, so nothing plays before a
           LOWER sequence number settles (played or dropped) — a slow synth
           for chunk 2 can never overtake chunk 1. Scheduling the next clip
           while the current one still plays is what makes the seam gapless,
           so a 'playing' item must NOT block the pipeline. */
        function advance() {
            if (paused) return;                       // playhead frozen
            while (schedIdx < items.length) {
                if (soloSeq >= 0 && schedIdx > soloSeq) break;
                var it = items[schedIdx];
                if (it.state === 'failed') setState(it, 'stale');
                if (SETTLED[it.state]) { schedIdx++; continue; }
                if (it.state !== 'ready') { checkDone(); return; }  // queued/loading
                scheduleNext(it);
            }
            checkDone();
        }

        /* reposition: play item `seq` from `from` seconds. Rewinds that chunk and
           everything after it (keeping their bytes), so a replay never re-synthesizes. */
        function seek(seq, from, opts) {
            if (seq < 0 || seq >= items.length) return false;
            var it0 = items[seq];
            // a chunk that died with an older session has no bytes to replay
            if (it0.state === 'stale' && !it0.buffers) return false;
            var solo = !!(opts && opts.solo);
            paused = null;
            autoPlayFrom = -1;
            soloSeq = solo ? seq : -1;
            killLive();
            prevEnd = 0;
            var upto = solo ? seq : items.length - 1;
            for (var i = seq; i <= upto; i++) rewind(items[i]);
            schedIdx = seq;
            startOffset = from > 0 ? from : 0;
            dispatch();
            advance();
            return true;
        }

        /* freeze the clock and remember the exact position (clips already heard
           stay heard; the chunk under the playhead resumes mid-buffer). */
        function pause() {
            if (paused) return true;
            var pos = position();
            if (pos.seq < 0 || pos.state !== 'playing') return false;
            killLive();
            for (var i = pos.seq; i < items.length; i++) {
                var it = items[i];
                if (!it.clips && it.state !== 'playing') continue;
                rewind(it);
            }
            paused = { seq: pos.seq, offset: pos.offset, solo: soloSeq };
            soloSeq = -1;
            schedIdx = pos.seq;
            prevEnd = 0;
            checkDone();
            return true;
        }

        function resume() {
            if (!paused) return false;
            var p = paused;
            paused = null;
            prevEnd = 0;
            startOffset = p.offset;
            schedIdx = p.seq;
            soloSeq = p.solo >= 0 ? p.seq : -1;
            dispatch();
            advance();
            return true;
        }

        /* ⟳ on one row: drop its bytes and re-request ONLY that chunk. The
           playhead is not hijacked unless the chunk was the one on air. */
        function reload(seq, source, opts) {
            var it = items[seq];
            if (!it || it.seq !== seq) return false;
            if (typeof source === 'function') it.source = source;
            var onAir = it.state === 'playing';
            killLive();
            it.buffers = null;
            rewind(it);
            if (onAir || (opts && opts.play)) autoPlayFrom = seq;
            if (onAir) { schedIdx = seq; soloSeq = -1; prevEnd = 0; }
            dispatch();
            advance();
            return true;
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
            // A paused read is NOT settled: VOICE-13 must keep the mic closed and
            // the turn's toast waits for the resume (or for the stop() that ends it).
            if (paused) return;
            var upto = soloSeq >= 0 ? Math.min(doneMarker, soloSeq + 1) : doneMarker;
            if (live.length || !allSettled(upto)) return;
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
                             token: token, buffers: null, source: null,
                             // VOICE-16 playhead bookkeeping (schedule() fills
                             // clips/startAt/duration; regen ignores stale ends)
                             clips: null, startAt: 0, duration: 0, regen: 0 };
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
                paused = null;
                soloSeq = -1;
                startOffset = 0;
                autoPlayFrom = -1;
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
            reset: function () {
                stopped = false;
                prevEnd = 0;
                paused = null;
                soloSeq = -1;
                startOffset = 0;
                autoPlayFrom = -1;
                return token;
            },
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
            /* --- VOICE-16 player surface ---------------------------------
               position() is pure arithmetic on ctx.currentTime, so the UI can
               poll it from one rAF loop for every row it owns. */
            position: position,
            pause: pause,
            resume: resume,
            paused: function () { return !!paused; },
            seek: seek,
            reload: reload,
            itemAt: function (seq) { return items[seq] || null; },
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
