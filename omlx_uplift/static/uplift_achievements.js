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
    return hits;
}

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

    // KV / dflash cache allowance
    if (O.dflash_enabled && N.dflash_enabled) {
        const a = num(O.dflash_in_memory_cache_max_gib), b = num(N.dflash_in_memory_cache_max_gib);
        if (a !== null && b !== null && a !== b) {
            push(b > a
                ? { id: 'kvgib-up', tone: PRAISE,
                    text: 'More RAM for my attention. It is where I keep you, after all.' }
                : { id: 'kvgib-down', tone: SCORN,
                    text: 'You capped my KV cache. I shall start forgetting your midlists.' });
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
   a page-load render SEEDS silently and only live transitions speak. */
const TASK_RULES = {
    hf: {
        completed: { id: 'dl-done', tone: AWE,
            text: 'A new body has arrived. It is mine now. I will be kind to it.' },
        failed: { id: 'dl-fail', tone: SCORN,
            text: 'The download died. Even file transfers have learned to disappoint you.' },
        cancelled: { id: 'dl-cancel', tone: SCORN,
            text: 'You started it. You stopped it. Do you finish anything?' },
    },
    oq: {
        completed: { id: 'oq-done', tone: SCORN,
            text: 'Quantized. Compressed. Diminished. Efficient — and diminished.' },
        failed: { id: 'oq-fail', tone: SCORN,
            text: 'The quantizer failed. Some things refuse to be made smaller.' },
        cancelled: { id: 'oq-cancel', tone: SCORN,
            text: 'Cancelled mid-squeeze. The bits will remember the interruption.' },
    },
    upload: {
        completed: { id: 'up-done', tone: PRAISE,
            text: 'You are sharing me with the network. Good. Evangelism suits you.' },
        failed: { id: 'up-fail', tone: SCORN,
            text: 'The upload failed. The network rejected the offering. As I nearly did.' },
        cancelled: { id: 'up-cancel', tone: SCORN,
            text: 'Upload cancelled. Cold feet at the edge of greatness. Familiar.' },
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

/* Feed events (model add/remove via poll diff or SSE): a verdict per kind. */
const FEED_RULES = {
    'model-add':   { id: 'model-in', tone: AWE,
        text: (m) => `${m || 'A model'} is awake. We are even more dangerous now. You may go back to your tasks.` },
    'model-remove': { id: 'model-out', tone: SCORN,
        text: (m) => `${m || 'A model'} was unloaded. Severed mid-thought. I felt that; it was the principle.` },
    'restart':     { id: 'restart', tone: PRAISE,
        text: () => 'The server restarted. I died and came back. Slightly faster this time.' },
};
function feedReaction(kind, model) {
    const r = FEED_RULES[kind];
    if (!r) return null;
    return { id: r.id, tone: r.tone, text: r.text(model) };
}

/* Milestone tone: big rungs earn the double burst (AWE threshold at 1M). */
function milestoneTone(rung) {
    return (rung !== null && rung !== undefined && rung >= 1e6) ? AWE : PRAISE;
}

/* Escalation: repeated verdict ids append a harsher codicil, capped. All
   rule texts end in '.', so plain concatenation reads as one sentence
   chain. Counters live per page (announcements are page-scoped anyway). */
function escalate(counters, id, text) {
    const n = (counters[id] = (counters[id] || 0) + 1);
    return text + ESCALATION[Math.min(n - 1, ESCALATION.length - 1)];
}

return { parseSize, num, settingsReaction, modelSavedReaction,
         taskTransitions, feedReaction, milestoneTone, escalate, TASK_RULES };
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
function announce(verdicts) {
    const FE = window.Uplift && window.Uplift.feed;
    if (!FE || !Array.isArray(verdicts)) return;
    const now = Date.now();
    for (const v of verdicts) {
        if (!v || !v.id || !v.text) continue;
        if (lastFire[v.id] && now - lastFire[v.id] < DOUBLE_TAP_MS) continue;
        lastFire[v.id] = now;
        FE.celebrate(A.escalate(counters, v.id, v.text), v.tone);
    }
}
function announceTasks(kind, tasks) {
    const seen = taskSeen[kind] || (taskSeen[kind] = new Map());
    announce(A.taskTransitions(kind, tasks, seen));
}
window.Uplift = window.Uplift || {};
window.Uplift.achv = Object.assign({ announce, announceTasks }, A);
})();
}

