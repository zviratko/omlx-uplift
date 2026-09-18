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
        'reqstats',
        'cache',
        'live',
        'reqfeed',
        'feed',
    ];
    const COLUMNS = 24;
    const MIN_W = 6;
    const WIDTH_CLASSES = {
        // Uplift is not Tailwind; these are data-width tokens resolved in
        // uplift.css (same pixel ladder as classic's max-w presets).
        default: 'default',
        wide: 'wide',
        wider: 'wider',
        full: 'full',
    };
    const WIDTH_IDS = Object.keys(WIDTH_CLASSES);

    // The shipped default = what the board looked like pre-#3694 parity:
    // four stat cards across (6u each), two charts + two feeds at 8u, all
    // 11 blocks on the board (nothing hidden by default). Heights come
    // from content; y values only encode order (see applyUpliftLayout).
    const DEFAULT_BLOCKS = [
        { id: 'gen', x: 0, y: 0, w: 6 },
        { id: 'prefill', x: 6, y: 0, w: 6 },
        { id: 'requests', x: 12, y: 0, w: 6 },
        { id: 'tokens', x: 18, y: 0, w: 6 },
        { id: 'chart-tps', x: 0, y: 2, w: 8 },
        { id: 'chart-mem', x: 8, y: 2, w: 8 },
        { id: 'cache', x: 16, y: 2, w: 8 },
        { id: 'reqstats', x: 0, y: 6, w: 8 },
        { id: 'live', x: 8, y: 6, w: 8 },
        { id: 'reqfeed', x: 16, y: 6, w: 8 },
        { id: 'feed', x: 0, y: 10, w: 8 },
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
        const w = Math.min(COLUMNS, Math.max(MIN_W, toInt(raw.w, COLUMNS)));
        const x = Math.min(COLUMNS - w, Math.max(0, toInt(raw.x, 0)));
        const y = Math.max(0, toInt(raw.y, 0));
        return { id, x, y, w };
    }

    // Accepts anything storage may hold and returns a layout the grid can
    // load. Unknown blocks are dropped, so a layout may legitimately
    // contain fewer than BLOCK_IDS.length blocks.
    function normalizeLayout(raw) {
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.blocks)) {
            return defaultLayout();
        }
        const seen = new Set();
        const blocks = raw.blocks.map(b => normalizeBlock(b, seen)).filter(Boolean);
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
        WIDTH_CLASSES,
        WIDTH_IDS,
        defaultLayout,
        normalizeLayout,
        widthClass,
    };
})(typeof window !== 'undefined' ? window : globalThis);
