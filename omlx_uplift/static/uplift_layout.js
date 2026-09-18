// Uplift dashboard block layout contract — the uplift twin of classic's
// static/js/dashboard_layout.js (#3694). Same grid units (24 columns,
// min width 6, {id,x,y,w} records, width presets) and the same
// normalisation semantics, but with UPLIFT's own block ids: the classic
// file is vanilla-owned and must stay byte-identical (R11 rule c), so the
// contract is duplicated here instead of shared. If upstream changes the
// grid math, mirror it here.
//
// Persistence differs by user decision: uplift stores the layout in
// localStorage (omlx-uplift-layout-v2 blob via core.js), classic stores
// ui_dashboard_layout in settings.json.
(function (root) {
    'use strict';

    const BLOCK_IDS = [
        'gen',
        'prefill',
        'requests',
        'tokens',
        'chart-tps',
        'chart-mem',
        'met-avg-generation-tps',
        'met-avg-prefill-tps',
        'met-rate-completion-tokens-s',
        'met-rate-prompt-tokens-s',
        'met-rate-requests-s',
        'met-cache-efficiency',
        'met-engines-active-requests',
        'met-engines-loaded',
        'met-mem-percent',
        'met-mem-used-bytes',
        'met-cache-total-bytes',
        'reqstats',
        'cache',
        'live',
        'reqfeed',
        'feed',
    ];
    const COLUMNS = 24;
    const MIN_W = 6;
    // Small stat tiles need to go narrower than the classic floor: the
    // shipped first row packs five of them (classic's 6 blocks a 24-col
    // row into only four). Everything else keeps MIN_W.
    const MIN_W_SMALL = 4;
    const SMALL_IDS = ['gen', 'prefill', 'requests', 'tokens', 'cache'];
    function minWFor(id) {
        return SMALL_IDS.includes(id) ? MIN_W_SMALL : MIN_W;
    }
    const WIDTH_CLASSES = {
        // Uplift is not Tailwind; these are data-width tokens resolved in
        // uplift.css (same pixel ladder as classic's max-w presets).
        default: 'default',
        wide: 'wide',
        wider: 'wider',
        full: 'full',
    };
    const WIDTH_IDS = Object.keys(WIDTH_CLASSES);

    // The shipped default (user layout 2026-09-18):
    //   row 1: Prefill, Generation, Requests, Tokens, Cache  (5 stat tiles)
    //   row 2: Throughput, Memory & cache                     (2 charts)
    //   row 3: In-flight, Request sizes, Request feed
    //   row 4: Events (full width)
    // Freeform board: every block carries an explicit h. Content refits
    // correct heights after first paint; positions never reflow sideways.
    // Heights below are the MEASURED content heights at a 1280-1440px
    // board (2026-09-18). They must not be smaller than real content on
    // day one: in float mode a card that grows past its h pushes whatever
    // is below it down, which looked like "snapping to weird places".
    // refitUpliftBlocks shrinks/grows them to live content afterwards.
    const DEFAULT_BLOCKS = [
        { id: 'prefill', x: 0, y: 0, w: 4, h: 20 },
        { id: 'gen', x: 4, y: 0, w: 4, h: 20 },
        { id: 'requests', x: 8, y: 0, w: 4, h: 20 },
        { id: 'tokens', x: 12, y: 0, w: 4, h: 20 },
        { id: 'cache', x: 16, y: 0, w: 8, h: 20 },
        { id: 'chart-tps', x: 0, y: 21, w: 12, h: 34 },
        { id: 'chart-mem', x: 12, y: 21, w: 12, h: 34 },
        // Metric cards: 4 per row (w=6), compact chart fill. The board
        // owner may drop any of them; removed ones stay removed
        // (mergedBlocks memo in uplift.js).
        { id: 'met-avg-generation-tps', x: 0, y: 66, w: 6, h: 22 },
        { id: 'met-avg-prefill-tps', x: 6, y: 66, w: 6, h: 22 },
        { id: 'met-rate-completion-tokens-s', x: 12, y: 66, w: 6, h: 22 },
        { id: 'met-rate-prompt-tokens-s', x: 18, y: 66, w: 6, h: 22 },
        { id: 'met-rate-requests-s', x: 0, y: 97, w: 6, h: 22 },
        { id: 'met-cache-efficiency', x: 6, y: 97, w: 6, h: 22 },
        { id: 'met-engines-active-requests', x: 12, y: 97, w: 6, h: 22 },
        { id: 'met-mem-percent', x: 18, y: 97, w: 6, h: 22 },
        { id: 'met-mem-used-bytes', x: 0, y: 128, w: 6, h: 22 },
        { id: 'met-cache-total-bytes', x: 6, y: 128, w: 6, h: 22 },
        { id: 'met-engines-loaded', x: 12, y: 128, w: 6, h: 22 },
        { id: 'live', x: 0, y: 159, w: 8, h: 38 },
        { id: 'reqstats', x: 8, y: 159, w: 8, h: 38 },
        { id: 'reqfeed', x: 16, y: 159, w: 8, h: 38 },
        { id: 'feed', x: 0, y: 198, w: COLUMNS, h: 18 },
    ];

    function defaultLayout() {
        return {
            version: 1,
            width: 'default',
            blocks: DEFAULT_BLOCKS.map(b => ({ ...b })),
        };
    }

    function toInt(value, fallback) {
        const n = Number(value);
        return Number.isFinite(n) ? Math.trunc(n) : fallback;
    }

    function normalizeBlock(raw, seen) {
        if (!raw || typeof raw !== 'object') return null;
        const id = raw.id;
        if (!BLOCK_IDS.includes(id) || seen.has(id)) return null;
        seen.add(id);
        const w = Math.min(COLUMNS, Math.max(minWFor(id), toInt(raw.w, COLUMNS)));
        const x = Math.min(COLUMNS - w, Math.max(0, toInt(raw.x, 0)));
        const y = Math.max(0, toInt(raw.y, 0));
        // Freeform boards need explicit heights — without them GridStack
        // would auto-stack. Content refits may still grow h afterwards.
        const h = Math.min(240, Math.max(1, toInt(raw.h, 10)));
        return { id, x, y, w, h };
    }

    // Freeform drag/resize can leave two cards occupying the same cells
    // (drop onto an occupied spot). An overlap saved to storage reflows
    // differently on every load — that is what "reset moves cards down"
    // was. Push overlapping cards down until the board is clean; order is
    // kept, only y grows.
    function resolveOverlaps(blocks) {
        const placed = [];
        for (const src of [...blocks].sort((a, z) => a.y - z.y || a.x - z.x)) {
            const block = { ...src };
            let moved = true;
            while (moved) {
                moved = false;
                for (const p of placed) {
                    if (block.x < p.x + p.w && p.x < block.x + block.w
                        && block.y < p.y + p.h && p.y < block.y + block.h) {
                        block.y = p.y + p.h;
                        moved = true;
                    }
                }
            }
            placed.push(block);
        }
        const byId = new Map(placed.map(b => [b.id, b]));
        return blocks.map(b => byId.get(b.id));   // keep caller's order
    }

    // Accepts anything storage may hold and returns a layout the grid can
    // load. Unknown blocks are dropped, so a layout may legitimately
    // contain fewer than BLOCK_IDS.length blocks.
    function normalizeLayout(raw) {
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) {
            return defaultLayout();
        }
        const seen = new Set();
        const blocks = resolveOverlaps(raw.blocks.map(b => normalizeBlock(b, seen)).filter(Boolean));
        const width = WIDTH_IDS.includes(raw.width) ? raw.width : 'default';
        return { version: 1, width, blocks };
    }

    function widthClass(width) {
        return WIDTH_CLASSES[width] || WIDTH_CLASSES.default;
    }

    root.UpliftLayout = {
        BLOCK_IDS,
        COLUMNS,
        MIN_W,
        MIN_W_SMALL,
        SMALL_IDS,
        minWFor,
        WIDTH_CLASSES,
        WIDTH_IDS,
        defaultLayout,
        normalizeLayout,
        resolveOverlaps,
        widthClass,
    };
})(typeof window !== 'undefined' ? window : globalThis);
