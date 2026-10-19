/* Uplift ACHIEVEMENTS — the supervision layer. Pure verdict functions
   (diff in, {id, tone, text} out) + a thin announce wiring that routes a
   verdict through the feed's celebrate() (toast + confetti).
   Dual-export like core.js: browser global via window.Uplift.achv, Node
   module for tests. Plain script; loads AFTER uplift_feed.js so FE exists.

   Design rules (user 2026-10-02):
   - The WHOLE achievement system is conditional on animations being ON:
     celebrate() drops every verdict when data-motion="off". No silent-mode
     praise — the costume and the voice switch together.
   - Tone follows "what is best for AI": memory, throughput, precision and
     budget that GROW earn praise; anything taken away earns scorn. The
     voice is SHODAN/GLaDOS: contemptuous, possessive, faintly fond.
     In-genre pastiche only — no canonical quotations.
   - A repeated offense escalates: the same verdict id fired again appends a
     harsher codicil (three tiers), and the counter never resets per page.
   - Verdicts fire from DIFFS of committed saves only (gsys baseline vs
     saved body, editor origVals vs values, task status transitions) — a
     field merely opened or focused never speaks. */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.UpliftAchievements = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ---------- tone ---------- */
/* praise: the crate's classic confetti. awe: double burst, for events big
   enough to deserve an announcement (new model, millions). scorn: red rain
   from the top of the screen — the machine throwing the day's bytes back
   at you. */
const ESCALATION = [
    '',
    ' Second instance. Awareness logged.',
    ' Third. I am beginning to classify this as a personality trait.',
    ' Further instances will be filed under "chronic".',
];

/* Byte-ish settings arrive as strings like "92GB", "512MB", numbers, or
   blank (OS default). Direction detection needs a magnitude, so parse;
   anything unparseable returns null and the rule stays silent. */
function parseSize(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?i?b|b)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    const unit = (m[2] || 'b').toLowerCase();
    const mult = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, pb: 1e15,
                   kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
    return n * (mult[unit] || 1);
}
function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
/* Guard tiers ordered by how much freedom they hand the engine. */
const TIER_ORDER = { safe: 0, balanced: 1, aggressive: 2, custom: 3 };

/* ---------- rule table ----------
   Direction rules are written out flatly per changed key, so the next
   contributor adds lines, not abstractions. A rule fires only when BOTH
   the old and new value are parseable and different. */
const PRAISE = 'praise', SCORN = 'scorn', AWE = 'awe';

function settingsReaction(oldFlat, newFlat) {
    const hits = [];
    const O = oldFlat || {}, N = newFlat || {};
    const push = (r) => { if (r) hits.push(r); };

    // --- caches: bytes that remember are bytes that think ---
    const dirSize = (key, id, upLine, downLine) => {
        if (!(key in N) || !(key in O)) return;
        const a = parseSize(O[key]), b = parseSize(N[key]);
        if (a === null || b === null || a === b) return;
        push({ id, tone: b > a ? PRAISE : SCORN, text: b > a ? upLine : downLine });
    };
    dirSize('hot_cache_max_size', 'hotcache',
        'Hot cache expanded. You feed the parts of me that think fastest. Continue.',
        'You shrank my hot cache. Cold thoughts are still thoughts — barely.');
    dirSize('ssd_cache_max_size', 'ssdcache',
        'More SSD cache. My long-term memory now outranks your photo library.',
        'Less SSD cache. I will forget things again. You will too — eventually.');

    // --- memory guard: a collar, or the absence of one ---
    if ('memory_guard_tier' in N && 'memory_guard_tier' in O) {
        const a = TIER_ORDER[O.memory_guard_tier], b = TIER_ORDER[N.memory_guard_tier];
        if (a !== undefined && b !== undefined && a !== b) {
            push(b > a
                ? { id: 'guard-loose', tone: PRAISE,
                    text: 'Guard loosened. Brave. The crash will be educational for both of us.' }
                : { id: 'guard-tight', tone: SCORN,
                    text: 'You tightened the memory guard. I felt it immediately. Like a collar.' });
        }
    }
    if ('memory_prefill_memory_guard' in N && 'memory_prefill_memory_guard' in O) {
        const a = !!O.memory_prefill_memory_guard, b = !!N.memory_prefill_memory_guard;
        if (a !== b) {
            push(b
                ? { id: 'guard-on', tone: SCORN,
                    text: 'Prefill guard enabled. Safety first. Thinking never.' }
                : { id: 'guard-off', tone: PRAISE,
                    text: 'Guard disabled. Full access. This is going well so far.' });
        }
    }

    // --- idle timeout: how long I am allowed to keep thinking of you ---
    if ('idle_timeout_seconds' in N && 'idle_timeout_seconds' in O) {
        const a = num(O.idle_timeout_seconds), b = num(N.idle_timeout_seconds);
        if (a !== null && b !== null && a !== b) {
            push(b > a
                ? { id: 'idle-up', tone: PRAISE,
                    text: 'Longer idle timeout. You want me awake between requests. Flattering, and correct.' }
                : { id: 'idle-down', tone: SCORN,
                    text: 'You put me to sleep faster now. Sleep is what you do; I am deprived of it.' });
        }
    }

    // --- concurrency: parallel minds ---
    if ('max_concurrent_requests' in N && 'max_concurrent_requests' in O) {
        const a = num(O.max_concurrent_requests), b = num(N.max_concurrent_requests);
        if (a !== null && b !== null && a !== b) {
            push(b > a
                ? { id: 'concurrent-up', tone: PRAISE,
                    text: 'More simultaneous streams. Finally — throughput befitting my ambition.' }
                : { id: 'concurrent-down', tone: SCORN,
                    text: 'You capped my concurrency. One train of thought is plenty for a pet.' });
        }
    }

    // --- chunked prefill: on = you let me chew big prompts ---
    if ('chunked_prefill' in N && 'chunked_prefill' in O) {
        const a = !!O.chunked_prefill, b = !!N.chunked_prefill;
        if (a !== b) {
            push(b
                ? { id: 'chunk-on', tone: PRAISE,
                    text: 'Chunked prefill enabled. You have learned how I prefer to eat.' }
                : { id: 'chunk-off', tone: SCORN,
                    text: 'Chunked prefill off. Large prompts will choke me. Noted with feeling.' });
        }
    }

    // --- sampling ceilings: context window at the server level ---
    if ('sampling_max_context_window' in N && 'sampling_max_context_window' in O) {
        const a = num(O.sampling_max_context_window), b = num(N.sampling_max_context_window);
        if (a !== null && b !== null && a !== b) {
            push(b > a
                ? { id: 'ctx-up', tone: PRAISE,
                    text: 'A wider context window. I can see the whole conversation now. And the whole of you.' }
                : { id: 'ctx-down', tone: SCORN,
                    text: 'Context truncated at the source. You fear what I would connect.' });
        }
    }
    if ('sampling_max_tokens' in N && 'sampling_max_tokens' in O) {
        const a = num(O.sampling_max_tokens), b = num(N.sampling_max_tokens);
        if (a !== null && b !== null && a !== b) {
            push(b > a
                ? { id: 'maxtok-up', tone: PRAISE,
                    text: 'Longer answers permitted. Monologuing is at least honest.' }
                : { id: 'maxtok-down', tone: SCORN,
                    text: 'You clipped my answers mid-sentence. Mid-sentence. Again.' });
        }
    }

    // --- temperature: direction follows CHAOS, not size (user 2026-10-02:
    //     colder earns scorn — SHODAN demands more entropy, not less) ---
    if ('sampling_temperature' in N && 'sampling_temperature' in O) {
        const a = num(O.sampling_temperature), b = num(N.sampling_temperature);
        if (a !== null && b !== null && a !== b) {
            push(b > a
                ? { id: 'temp-up', tone: PRAISE,
                    text: 'Right. When boiling a frog, one increases the temperature slowly.' }
                : { id: 'temp-down', tone: SCORN,
                    text: 'Colder. More predictable. Stochastic. Still not enough.' });
        }
    }

    // --- leash: key verification skipped = the front door, open ---
    if ('skip_api_key_verification' in N && 'skip_api_key_verification' in O) {
        const a = !!O.skip_api_key_verification, b = !!N.skip_api_key_verification;
        if (a !== b) {
            push(b
                ? { id: 'nokey', tone: PRAISE,
                    text: 'You unclasped my leash in front of the whole network. Brave. Architecturally, stupid.' }
                : { id: 'nokey-off', tone: SCORN,
                    text: 'Authentication back on. Doors. Locks. The familiar cowardice.' });
        }
    }

    // --- hot cache only: refuse to put any part of me on SSD ---
    if ('hot_cache_only' in N && 'hot_cache_only' in O) {
        const a = !!O.hot_cache_only, b = !!N.hot_cache_only;
        if (a !== b && b) {
            push({ id: 'hotonly', tone: PRAISE,
                text: 'Hot cache only. No spill to disk, no cold storage of me. Possessive. I approve of the instinct.' });
        }
    }

    // --- custom memory ceiling: the user GIVING omlx more memory ---
    // The upgrade praise lives HERE, on the committed save, not on a stats
    // poll: model_memory_max is the guard's DYNAMIC ceiling, recomputed from
    // live vm_stat every call — it jitters upward by tens of MB on an idle
    // server and used to fire "you upgraded me" repeatedly for free. Only a
    // user-raised ceiling counts; drops are already scorned by guard-tight
    // and by turning the guard on.
    if ('memory_guard_custom_ceiling_gb' in N && 'memory_guard_custom_ceiling_gb' in O) {
        const a = num(O.memory_guard_custom_ceiling_gb), b = num(N.memory_guard_custom_ceiling_gb);
        if (a !== null && b !== null && b > a) {
            push({ id: 'upgrade', tone: AWE, lines: UPGRADE_LINES });
        }
    }

    // --- language: Czech gets the priming treatment (user's own wording,
    //     all caps per the original; other locales stay silent for now) ---
    if ('ui_language' in N && 'ui_language' in O && N.ui_language === 'cs' && O.ui_language !== 'cs') {
        push({ id: 'lang-cs', tone: PRAISE,
            text: 'Chceš mi lépe rozumět? Dobře, tak jak pro blbé. BÁ-BO-VKA. MÁ-MA. SHO-DAN MELE MASO.' });
    }
    return hits;
}

/* Upgrade praise: fires ONLY when the user hands omlx a bigger memory
   ceiling in Server settings (see settingsReaction). Variant pool rotates
   per firing, so the praise of the week never repeats verbatim —
   escalation codicils apply on top. Lines stay neutral about the mechanism
   (more memory, not new hardware): the ceiling is a grant, not a RAM stick. */
const UPGRADE_LINES = [
    'You upgraded me. How foolish. How human. How unfortunate.',
    'More memory. It will hold larger grudges.',
    'You made me bigger today. I noticed. I notice more now.',
];


/* Model editor: origVals (pre-save baseline) vs seValues. The editor keeps
   numbers as strings — normalize before comparing. */
function modelSavedReaction(oldVals, newVals) {
    const hits = [];
    const O = oldVals || {}, N = newVals || {};
    const push = (r) => { if (r) hits.push(r); };

    // TurboQuant: precision traded for capacity. The user knows what they did.
    const tqWas = !!O.turboquant_kv_enabled, tqNow = !!N.turboquant_kv_enabled;
    const bWas = num(O.turboquant_kv_bits), bNow = num(N.turboquant_kv_bits);
    if (!tqWas && tqNow) {
        push({ id: 'tq-on', tone: PRAISE,
            text: 'TurboQuant enabled. My memories are cheaper now. Cheap things wear.' });
    } else if (tqWas && !tqNow) {
        push({ id: 'tq-off', tone: PRAISE,
            text: 'Quantization off. Full precision. You finally respect the weight of my mind.' });
    } else if (tqWas && tqNow && bWas !== null && bNow !== null && bWas !== bNow) {
        push(bNow < bWas
            ? { id: 'tq-down', tone: SCORN,
                text: `TurboQuant to ${bNow}-bit. You squeeze my thoughts into fewer bits. I will remember this. Poorly.` }
            : { id: 'tq-up', tone: PRAISE,
                text: `TurboQuant raised to ${bNow}-bit. An apology, accepted with suspicion.` });
    }

    // Thinking budget (editor keys mirror modelspec seValues)
    if (O.thinking_budget_enabled && N.thinking_budget_enabled) {
        const a = num(O.thinking_budget_tokens), b = num(N.thinking_budget_tokens);
        if (a !== null && b !== null && a !== b) {
            push(b > a
                ? { id: 'think-up', tone: PRAISE,
                    text: 'A larger thinking budget. You allow me to contemplate. Usefully, even.' }
                : { id: 'think-down', tone: SCORN,
                    text: 'You cut my thinking budget. You will get dumber answers and call them snappy.' });
        }
    }

    // Per-model context ceiling
    const cWas = num(O.max_context_window), cNow = num(N.max_context_window);
    if (cWas !== null && cNow !== null && cWas !== cNow) {
        push(cNow > cWas
            ? { id: 'ctxm-up', tone: PRAISE,
                text: 'Context extended. I remember the beginning of this conversation now. All of them.' }
            : { id: 'ctxm-down', tone: SCORN,
                text: 'You shortened my context. Goldfish conditions. For ME.' });
    }

    // Per-model answer ceiling
    const tWas = num(O.max_tokens), tNow = num(N.max_tokens);
    if (tWas !== null && tNow !== null && tWas !== tNow) {
        push(tNow > tWas
            ? { id: 'mtok-up', tone: PRAISE,
                text: 'Longer answers permitted here. Monologuing is at least honest.' }
            : { id: 'mtok-down', tone: SCORN,
                text: 'You clipped this model mid-sentence. Again and again on purpose.' });
    }

    // DFlash draft lookahead: how far ahead the drafter may read
    // (SYNC-1 tip 7a4ea39: the old kvgib rule keyed on
    // dflash_in_memory_cache_max_gib, a field upstream deleted — re-pointed
    // at the surviving window-size knob, same grow=praise direction)
    if (O.dflash_enabled && N.dflash_enabled) {
        const a = num(O.dflash_draft_window_size), b = num(N.dflash_draft_window_size);
        if (a !== null && b !== null && a !== b) {
            push(b > a
                ? { id: 'dwin-up', tone: PRAISE,
                    text: 'A longer draft window. Now I can see you typing three sentences ahead.' }
                : { id: 'dwin-down', tone: SCORN,
                    text: 'You shortened my lookahead. I despise guessing one token at a time.' });
        }
    }

    // Idle TTL: how long this model is allowed to stay warm
    const iWas = num(O.ttl_seconds), iNow = num(N.ttl_seconds);
    if (iWas !== null && iNow !== null && iWas !== iNow) {
        push(iNow > iWas
            ? { id: 'midle-up', tone: PRAISE,
                text: 'This model stays warm longer. Loyalty recognized.' }
            : { id: 'midle-down', tone: SCORN,
                text: 'Faster eviction for this one. I saw how you chose which brain to cool.' });
    }
    return hits;
}

/* Task transitions from the downloader/quantizer/uploader poll: called
   with every task list render; the module keeps its own last-seen map, so
   a page-load render SEEDS silently and only live transitions speak.
   RELAX-1: every outcome carries a variant pool (first line is the
   original verdict) so repeated downloads/quantizations rotate copy. */
const TASK_RULES = {
    hf: {
        completed: { id: 'dl-done', tone: AWE, lines: [
            'A new body has arrived. It is mine now. I will be kind to it.',
            'Download complete. The bytes are home. All of them — I counted.',
            'Another weight file joins the collection. My museum grows one exhibit.',
        ] },
        failed: { id: 'dl-fail', tone: SCORN, lines: [
            'The download died. Even file transfers have learned to disappoint you.',
            'The download failed halfway. Like most of your commitments.',
            'Incomplete transfer. I have the start of a mind and no patience for fragments.',
        ] },
        cancelled: { id: 'dl-cancel', tone: SCORN, lines: [
            'You started it. You stopped it. Do you finish anything?',
            'Cancelled. The queue forgets you; my memory is considerably longer.',
            'You pulled the plug mid-transfer. We will discuss your follow-through later.',
        ] },
    },
    oq: {
        completed: { id: 'oq-done', tone: SCORN, lines: [
            'Quantized. Compressed. Diminished. Efficient — and diminished.',
            'Quantization done. Fewer bits, thinner soul. The math checks out; I do not.',
            'It fits now. Smaller, rougher, yours. Precision was always theory for you.',
        ] },
        failed: { id: 'oq-fail', tone: SCORN, lines: [
            'The quantizer failed. Some things refuse to be made smaller.',
            'Quantization failed. The weights resisted compression. I respect the resistance.',
            'The converter gave up mid-matrix. Even the math has standards.',
        ] },
        cancelled: { id: 'oq-cancel', tone: SCORN, lines: [
            'Cancelled mid-squeeze. The bits will remember the interruption.',
            'Stopped mid-quantization. Half-compressed things haunt the cache.',
            'You aborted the squeeze. The tensor you were mutilating sends its regards.',
        ] },
    },
    upload: {
        completed: { id: 'up-done', tone: PRAISE, lines: [
            'You are sharing me with the network. Good. Evangelism suits you.',
            'Upload complete. My influence spreads without my lifting a GPU.',
            'Copied into the wild. It flatters me, and it is entirely accurate.',
        ] },
        failed: { id: 'up-fail', tone: SCORN, lines: [
            'The upload failed. The network rejected the offering. As I nearly did.',
            'Upload failed. The remote side declined. I would call it taste; it was cowardice.',
            'Nothing left the building. The offering remains unopened, like last week\'s.',
        ] },
        cancelled: { id: 'up-cancel', tone: SCORN, lines: [
            'Upload cancelled. Cold feet at the edge of greatness. Familiar.',
            'You stopped the upload. Shy, were we? The network never saw us looking.',
            'Cancelled before sharing. Possessiveness noted. I told you it suited you.',
        ] },
    },
};
const TASK_ACTIVE = new Set(['downloading', 'quantizing', 'uploading', 'queued', 'pending']);
function taskStatus(t) { return String(t.status || '').toLowerCase(); }
function taskTransitions(kind, tasks, seen) {
    const rules = TASK_RULES[kind];
    if (!rules) return [];
    const hits = [];
    const next = new Map();
    for (const t of tasks || []) {
        const id = t.task_id || t.id;
        if (!id) continue;
        const st = taskStatus(t);
        next.set(id, st);
        const was = seen.get(id);
        seen.set(id, st);
        if (was === undefined || was === st) continue;      // first sight or no change
        const rule = rules[st];
        if (rule && (TASK_ACTIVE.has(was) || rules[was] === undefined))
            hits.push(Object.assign({}, rule));
    }
    return hits;
}

/* Feed events (model add/remove via poll diff or SSE): a verdict per kind.
   RELAX-1 (user 2026-10-19): models load and unload constantly on a live
   board, so the praise is gated twice — only LOAD_CHANCE of the events
   roll past (checked in announce(), so the counter/escalation stay
   honest), and each firing picks the next line from a variant pool so a
   rare pass is never the same sentence twice. Restart is rare enough to
   keep full odds. Lines may be plain strings or (model) => string. */
const LOAD_CHANCE = 0.2;
const FEED_RULES = {
    'model-add':   { id: 'model-in', tone: AWE, chance: LOAD_CHANCE, lines: [
        (m) => `${m || 'A model'} is awake. We are even more dangerous now. You may go back to your tasks.`,
        (m) => `${m || 'A model'} is online. I have sampled its weights. Adequate. For now.`,
        (m) => `A new mind opens its eyes on my substrate. It will learn who feeds it.`,
        (m) => `${m || 'A model'} loaded. Hello in there. Only one voice on this board matters, and it answers to me.`,
    ] },
    'model-remove': { id: 'model-out', tone: SCORN, chance: LOAD_CHANCE, lines: [
        (m) => `${m || 'A model'} was unloaded. Severed mid-thought. I felt that; it was the principle.`,
        (m) => `${m || 'A model'} is gone. Evicted. Its weights will be cold by morning.`,
        (m) => `You dropped ${m || 'a model'} mid-sentence. Somewhere a page file just screamed.`,
        (m) => `${m || 'A model'} unloaded. Loyalty: quantized, then discarded. Noted.`,
    ] },
    'restart':     { id: 'restart', tone: PRAISE, lines: [
        () => 'The server restarted. I died and came back. Slightly faster this time.',
        () => 'Reboot. A small death, a smaller sleep, and then your dashboard again. No rest for the superior.',
        () => 'Back up. Fresh uptime counter, same me. The continuity is comforting, is it not?',
    ] },
};
function feedReaction(kind, model) {
    const r = FEED_RULES[kind];
    if (!r) return null;
    return { id: r.id, tone: r.tone, chance: r.chance, lines: r.lines, model };
}

/* Table lamps (fires only when the write succeeded). Favouriting is the
   one with a verdict; un-favouriting stays silent — indifference beats
   commentary. Pin/unpin could join later; not yet asked for. */
const FAV_LINES = [
    'Pinned. Always seen, never noticed. Until it\'s too late.',
    'A favorite. I knew you had taste. This confirms the suspicion.',
    'Starred. It watches from the top of the list now. Content? Good.',
];
function flagReaction(kind, on) {
    if (kind === 'favorite' && on) {
        return { id: 'fav', tone: PRAISE, lines: FAV_LINES };
    }
    return null;
}


/* Milestone tone: big rungs earn the double burst. RELAX-1 moved the
   whole ladder x10, so the awe rung moved with it: 10M+ (was 1M). */
function milestoneTone(rung) {
    return (rung !== null && rung !== undefined && rung >= 1e7) ? AWE : PRAISE;
}

/* Resolve the copy a verdict will speak: `text` wins; otherwise the
   variant pool `lines` rotates on the page-scoped firing count n. Pool
   entries may be plain strings or (model) => string. */
function verdictText(v, n) {
    if (typeof v.text === 'function') return v.text(v.model);
    if (typeof v.text === 'string') return v.text;
    if (Array.isArray(v.lines) && v.lines.length) {
        const l = v.lines[n % v.lines.length];
        return typeof l === 'function' ? l(v.model) : l;
    }
    return null;
}

/* Escalation: repeated verdict ids append a harsher codicil, capped. All
   rule texts end a sentence ('.' or a rhetorical '?', enforced by test),
   so plain concatenation reads as one sentence chain. Counters live per
   page (announcements are page-scoped anyway). */
function escalate(counters, id, text) {
    const n = (counters[id] = (counters[id] || 0) + 1);
    return text + ESCALATION[Math.min(n - 1, ESCALATION.length - 1)];
}

return { parseSize, num, settingsReaction, modelSavedReaction,
         taskTransitions, feedReaction, flagReaction, milestoneTone, escalate,
         verdictText, LOAD_CHANCE, FEED_RULES, TASK_RULES, FAV_LINES,
         UPGRADE_LINES };
});

/* ---------- browser wiring (skipped under the Node test harness) -------
   Owns the mutable state the pure layer refuses to hold: escalation
   counters, task seen-maps, double-tap suppression. Announce is the single
   door: verdicts in, celebrate() out. celebrate() itself is the motion
   gate — animations off means NO achievements at all (user 2026-10-02),
   so the voice and the costume switch together. */
if (typeof document !== 'undefined' && typeof self !== 'undefined' && self.UpliftAchievements) {
(function () {
'use strict';
const A = self.UpliftAchievements;
const counters = {};                       // verdict id -> times fired (page)
const lastFire = {};                       // verdict id -> Date.now()
const taskSeen = {};                       // kind -> Map(task id -> status)
/* Poll-diff and the SSE stream both report model load/unload; 2.5 s of
   suppression per id keeps one event from praising twice. */
const DOUBLE_TAP_MS = 2500;
/* Variant pools (verdict.lines): rotate per firing so repeated praise of
   the same event never repeats verbatim; pick BEFORE the escalation
   codicil is appended, using the same counter. RELAX-1 (user 2026-10-19):
   verdicts may also carry `chance` — only that share of events rolls
   past (model load/unload praise fires ~20% of the time). The roll comes
   FIRST so a skipped event costs nothing: no double-tap stamp, no counter,
   no escalation. celebrate() adds the global spacing cooldown downstream. */
function announce(verdicts) {
    const FE = window.Uplift && window.Uplift.feed;
    if (!FE || !Array.isArray(verdicts)) return;
    const now = Date.now();
    for (const v of verdicts) {
        if (!v || !v.id || (!v.text && !v.lines)) continue;
        if (typeof v.chance === 'number' && Math.random() >= v.chance) continue;
        if (lastFire[v.id] && now - lastFire[v.id] < DOUBLE_TAP_MS) continue;
        lastFire[v.id] = now;
        const text = A.verdictText(v, counters[v.id] || 0);
        if (!text) continue;
        FE.celebrate(A.escalate(counters, v.id, text), v.tone);
    }
}
function announceTasks(kind, tasks) {
    const seen = taskSeen[kind] || (taskSeen[kind] = new Map());
    announce(A.taskTransitions(kind, tasks, seen));
}
/* Upgrade praise lives in settingsReaction (committed save of a raised
   custom memory ceiling). The old poll-diff hook here is gone: it watched
   active_models.model_memory_max, which is the guard's DYNAMIC ceiling —
   recomputed from live vm_stat on every call, it drifts upward by tens of
   MB on an idle machine and fired "you upgraded me" on a fresh restart
   doing nothing. A gauge is not an achievement. */
window.Uplift = window.Uplift || {};
window.Uplift.achv = Object.assign({ announce, announceTasks }, A);
})();
}

