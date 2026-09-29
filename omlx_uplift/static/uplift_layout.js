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
        // U11: live system memory cards replace the flat phys_footprint
        // pair. Dropping met-mem-percent / met-mem-used-bytes here retires
        // them from saved layouts on load (same mechanism as 'feed'); the
        // series stay collectable and explorer-addable below.
        'met-sys-percent',
        'met-sys-used-bytes',
        'met-sys-total-bytes',
        'met-cache-total-bytes',
        // U19/U20 multi-series cards: TRAY-ONLY (not in DEFAULT_BLOCKS —
        // nothing existing moves; adding one never rewrites saved geometry).
        'met-pfx-token-hit-pct',
        'met-pfx-lookup-hit-pct',
        'met-spec-saved-tokens-min',
        'met-queue-waiting',
        // U20 gated: no macmon → the card is never created (silent absence).
        'met-pwr-total-w',
        'met-therm-cpu-temp-c',
        'reqstats',
        'cache',
        'live',
        'reqfeed',
        // 'feed' (Events card) retired 2026-09-22: normalizeLayout drops it
        // from every saved layout, the static section is gone from
        // index.html, and pushFeed no-ops without its host.
    ];
    const COLUMNS = 24;
    // U19/U20: tray-only blocks — valid ids, NEVER in the default board.
    // A user adds them from the tray; nothing existing moves (U19 UI rule).
    const TRAY_ONLY_IDS = [
        'met-pfx-token-hit-pct', 'met-pfx-lookup-hit-pct',
        'met-spec-saved-tokens-min', 'met-queue-waiting',
        'met-pwr-total-w', 'met-therm-cpu-temp-c',
    ];
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

    // The shipped default (user layout 2026-09-19 r3):
    //   row 1: Prefill, Generation, Requests, Tokens, Cache  (5 stat tiles)
    //   row 2: Throughput, Memory & cache                     (2 charts)
    //   row 3: Request feed, In-flight, Request sizes (directly
    //          under the charts — user asked feed + in-flight below
    //          throughput; the metric cards moved below this row)
    //   rows 4-6: metric cards (4 per row)
    //   last: Events (full width)
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
        { id: 'chart-tps', x: 0, y: 20, w: 12, h: 34 },
        { id: 'chart-mem', x: 12, y: 20, w: 12, h: 34 },
        // Feed row directly under the charts (user 2026-09-19 r3):
        // Request feed + In-flight sit under Throughput. h is the floor
        // only — the row engine grows it to whatever the lists need
        // (capped demand), so the shipped value hugs stat-grid content.
        // EVENTS retired 2026-09-22 (user): the reaction feed duplicated the
        // request feed; the Request feed moved into its bottom full-width
        // slot. Row 3 rebalances to two half-width cards (In-flight +
        // Request sizes) so the Throughput row below keeps its rhythm.
        // normalizeLayout drops 'feed' from saved layouts automatically —
        // existing users lose the Events card on next load, no migration.
        { id: 'live', x: 0, y: 57, w: 12, h: 30 },
        { id: 'reqstats', x: 12, y: 57, w: 12, h: 30 },
        // Metric cards: 4 per row (w=6), compact chart fill. The board
        // owner may drop any of them; removed ones stay removed
        // (mergedBlocks memo in uplift.js).
        { id: 'met-avg-generation-tps', x: 0, y: 87, w: 6, h: 20 },
        { id: 'met-avg-prefill-tps', x: 6, y: 87, w: 6, h: 20 },
        { id: 'met-rate-completion-tokens-s', x: 12, y: 87, w: 6, h: 20 },
        { id: 'met-rate-prompt-tokens-s', x: 18, y: 87, w: 6, h: 20 },
        { id: 'met-rate-requests-s', x: 0, y: 107, w: 6, h: 20 },
        { id: 'met-cache-efficiency', x: 6, y: 107, w: 6, h: 20 },
        { id: 'met-engines-active-requests', x: 12, y: 107, w: 6, h: 20 },
        { id: 'met-sys-percent', x: 18, y: 107, w: 6, h: 20 },
        { id: 'met-sys-used-bytes', x: 0, y: 127, w: 6, h: 20 },
        { id: 'met-cache-total-bytes', x: 6, y: 127, w: 6, h: 20 },
        { id: 'met-engines-loaded', x: 12, y: 127, w: 6, h: 20 },
        { id: 'met-sys-total-bytes', x: 18, y: 127, w: 6, h: 20 },
        { id: 'reqfeed', x: 0, y: 147, w: COLUMNS, h: 18 },
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
        // Metric sparklines had h=15 (65px plot): the 0-line sat jammed on
        // the card edge. 20 rows (+30%) gives the plot real height; the
        // minimum also migrates boards already saved with 15. (2026-09-26)
        const hMin = String(id).startsWith('met-') ? 20 : 1;
        const h = Math.min(240, Math.max(hMin, toInt(raw.h, 10)));
        return { id, x, y, w, h };
    }

    // Freeform drag/resize can leave two cards occupying the same cells
    // (drop onto an occupied spot). An overlap saved to storage reflows
    // differently on every load — that is what "reset moves cards down"
    // was. Order is kept and only y grows, but the repair is ROW-BAND
    // AWARE (user 2026-09-29: dropping one card onto the top row tore the
    // whole board into a staircase — pushing the overlapping block alone
    // skewed one column against its row-mates, and every row below
    // inherited the skew as a 1-cell drift (y106 vs y107, 127 vs 128...)).
    // Rules:
    //  (1) cards whose saved y differ by at most ROW_TOLERANCE cells are a
    //      row band (drift-repair: the band snaps UP to its smallest y —
    //      a near-miss y is drift, never an intentional freeform offset
    //      when rows butt together at exact heights);
    //  (2) when a band must move to clear an already-placed card, EVERY
    //      band member moves by the SAME shift — a row always lands as a
    //      shared y-band, which is what the height engine (_rowAlign in
    //      uplift.js) aligns rows by.
    // Cards of the same band that overlap EACH OTHER (double drop on one
    // cell) cannot be separated by a uniform shift: they cascade down
    // inside the band, x-order kept. Idempotent: a clean board moves no
    // one, so Reset renders identically every time.
    const ROW_TOLERANCE = 2;
    function rowsTouch(a, z) {
        return a.x < z.x + z.w && z.x < a.x + a.w && a.y < z.y + z.h && z.y < a.y + a.h;
    }
    function resolveOverlaps(blocks) {
        const order = [...blocks].sort((a, z) => a.y - z.y || a.x - z.x);
        const result = new Map(blocks.map(b => [b.id, { ...b }]));
        const placed = [];
        for (let i = 0; i < order.length;) {
            const bandY = order[i].y;
            const band = [];
            while (i < order.length && order[i].y - bandY <= ROW_TOLERANCE)
                band.push(result.get(order[i++].id));
            // (1) snap the band up to its smallest y
            for (const b of band) { if (b.y !== bandY) result.set(b.id, { ...b, y: bandY }); }
            // (2) mutual overlaps inside the band cascade down in x-order
            const stacked = [];
            for (const b of band) {
                let cur = result.get(b.id);
                let moved = true, guard = 0;
                while (moved && guard++ < 64) {
                    moved = false;
                    for (const p of stacked) {
                        if (rowsTouch(cur, p)) {
                            cur = { ...cur, y: p.y + p.h };
                            moved = true;
                        }
                    }
                }
                result.set(b.id, cur);
                stacked.push(cur);
            }
            // (3) the band as a whole clears everything already placed
            let moved = true, guard = 0;
            while (moved && guard++ < 64) {
                moved = false;
                let shift = 0;
                for (const p of stacked) {
                    const cur = result.get(p.id);
                    for (const q of placed)
                        if (rowsTouch(cur, q))
                            shift = Math.max(shift, q.y + q.h - cur.y);
                }
                if (shift > 0) {
                    for (const p of stacked)
                        result.set(p.id, { ...result.get(p.id), y: result.get(p.id).y + shift });
                    moved = true;
                }
            }
            for (const p of stacked) placed.push(result.get(p.id));
        }
        return blocks.map(b => result.get(b.id));   // keep caller's order
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
        TRAY_ONLY_IDS,
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
