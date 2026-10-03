"""QA-2 layout regression suite — model settings editor invariants.

HOW IT RUNS (there is no test runner here; this file is executed by the
Hermes browser harness):

  1. scripts/qa-suite.sh start   # QA omlx on :8099 + staging HTTP on :8797
  2. in a browser_exec call:
         m = fetch http://<kocour>:8797/qa_manifest.json
         fetch <m.base_url>/uplift/login  (POST {api_key: m.qa_key})
         txt = fetch http://<kocour>:8797/layout_suite.py
         RUN = types.ModuleType("RUN")
         exec(compile(txt, "layout_suite.py", "exec"), RUN.__dict__)
         print(RUN.run(js, cdp, m.base_url))
  3. scripts/qa-suite.sh stop

Inside the harness the module sees the pre-imported ``js`` and ``cdp``
helpers, so it drives the real dashboard the same way an interactive QA
probe does — the difference is that these probes are COMMITTED: every
invariant below corresponds to a defect that actually shipped and was
caught by the user instead of by us (2026-10-03 UX-2..UX-6, three rounds
each). That is the bug class this file exists to end.

Run it after ANY change to uplift.css, uplift_mmeditor.js, uplift_dirty.js
or uplift_widgets.js — before deploying. Expect 0 failures; a failure
names the invariant and the measurement, not just 'layout broken'.

Design notes:
  * The editor is opened on a real model (the QA base is seeded from the
    production settings, so model definitions are real) and CLOSED with
    closeEditor() — the suite never saves. It writes nothing.
  * Clean vs dirty is measured by toggling turboquant on; the dirty pass
    is what historically reflowed everything (the CHANGES rail).
  * Geometry only: pixel truth (clipping, colour) is phase 2.
"""

import json

VERSION = "2"

# viewport widths the editor must be correct at; 782 is the pair-grid
# breakpoint, 1232 the rail flow/overlay breakpoint
WIDTHS = (700, 900, 1024, 1280, 1728)
PAIR_TWO_COL_MIN = 782
RAIL_RESERVE_MIN = 1232

SECTIONS_IN_ORDER = [
    "Context & Limits", "Thinking & Reasoning", "Sampling", "Acceleration",
    "Speculative Decoding", "DFlash", "Grammar", "Chat Template Kwargs",
]

# (master toggle key, dependent knob key) — must share a line at >=782px
PAIRED = [
    ("turboquant_kv_enabled", "turboquant_kv_bits"),
    ("enableThinkingBudget", "thinking_budget_tokens"),
]
# probe order = visual band order: [toggle | draft] / [keep | threshold]
SPEC = ("specprefill_enabled", "specprefill_draft_model",
        "specprefill_keep_pct", "specprefill_threshold")


class Suite:
    def __init__(self, js, cdp, base):
        self.js, self.cdp, self.base = js, cdp, base
        self.results, self.model = [], None
        self.header = None

    # ---------- plumbing ----------
    def _eval(self, expr):
        return self.js(expr)

    def _width(self, w):
        self.cdp('Emulation.setDeviceMetricsOverride', width=w, height=980,
                 deviceScaleFactor=1, mobile=False)

    def _clear_width(self):
        try:
            self.cdp('Emulation.clearDeviceMetricsOverride')
        except Exception:
            pass

    def check(self, name, ok, detail=""):
        # ok=None records a SKIP (checked-by-design-not-applicable), which
        # the report counts and explains — green must never be vacuous
        self.results.append((name, ok, detail))
        return ok

    # ---------- page helpers (all JS lives in one string per action) ----------
    _OPEN = """(async () => {
      const d = await (await fetch('%(base)s/admin/api/models')).json();
      const mid = '%(mid)s' || (d.models && d.models[0] && d.models[0].id) || null;
      if (!mid) return 'NO-MODEL';
      window.Uplift.modelmgr.closeEditor();
      await new Promise(r => setTimeout(r, 150));
      await window.Uplift.modelmgr.openEditor(mid);
      await new Promise(r => setTimeout(r, 450));
      return mid;
    })()"""

    _CLOSE = "window.Uplift.modelmgr.closeEditor(), 'closed'"

    def open(self):
        out = self._eval(self._OPEN % {"base": self.base, "mid": self.model or ""})
        if out == "NO-MODEL":
            raise RuntimeError("QA base has no models — is it seeded?")
        return out

    def close(self):
        self._eval(self._CLOSE)

    def pick_model(self):
        """v2 (A): do not blindly measure models[0] — if that model lacks
        the invariant keys, every key-dependent check would skip and the
        report would be green-but-empty. Inventory each candidate once and
        keep the one covering the most PAIRED/SPEC/grammar keys."""
        cands = self._eval("""(async () => {
          const d = await (await fetch('%(base)s/admin/api/models')).json();
          return JSON.stringify((d.models || []).map(m => m.id));
        })()""" % {"base": self.base})
        ids = json.loads(cands) if isinstance(cands, str) else cands
        if not ids:
            raise RuntimeError("QA base has no models — is it seeded?")
        keys = [k for p in PAIRED for k in p] + list(SPEC) + ["guided_grammar"]
        best, best_n = ids[0], -1
        for mid in ids[:8]:          # bounded scan; 8 editors is plenty
            self.model = mid
            self.open()
            n = self._eval("""(() => {
              const f = document.querySelector('#se-fields');
              if (!f) return 0;
              return %(keys)s.filter(k =>
                f.querySelector('[data-key=\\\"' + k + '\\\"]')).length;
            })()""" % {"keys": json.dumps(keys)})
            self.close()
            if isinstance(n, int) and n > best_n:
                best, best_n = mid, n
            if best_n == len(keys):
                break               # can't do better
        self.model = best
        return best, best_n, len(keys)

    def _probe(self):
        """One JS pass returning every measurement for the current state.

        Field presence is model-dependent (specprefill exists only for
        drafter-compatible architectures, DFlash only when the field set
        exists) — the probe returns the full key inventory so Python can
        SKIP rather than false-FAIL on absent keys."""
        paired = "[" + ",".join('["%s","%s"]' % p for p in PAIRED) + "]"
        spec_js = "[" + ",".join('"%s"' % k for k in SPEC) + "]"
        out = self._eval("""(() => {
          const f = document.querySelector('#se-fields');
          if (!f) return {err: 'editor not open'};
          const q = k => f.querySelector('[data-key="' + k + '"]');
          const R = e => { if (!e) return null;
            const b = e.getBoundingClientRect();
            return {left: b.left, right: b.right, top: b.top,
                    bottom: b.bottom, width: b.width}; };
          const modal = R(document.querySelector('.modal.editor'));
          const scroll = R(document.querySelector('.editor-scroll'));
          const rail = document.getElementById('se-changes');
          const pairs = %(paired)s.map(pr => {
            const m = pr[0], k = pr[1];
            const a = q(m), b = q(k);
            if (!a || !b) return {m: m, k: k, state: 'missing'};
            const ra = R(a), rb = R(b);
            return {m: m, k: k, state: Math.abs(ra.top - rb.top) < 8 ? 'same'
                    : (rb.left < ra.left + 50 ? 'below' : 'diagonal')};
          });
          // kwargs sub-editors (.row-editor .pair) float auto-fill on
          // purpose — the 1fr/1fr-1fr invariant is for settings grids
          const grids = [...f.querySelectorAll('.pair')]
            .filter(p => !p.closest('.row-editor'))
            .map(p => getComputedStyle(p).gridTemplateColumns.split(' ').length);
          const sp = %(spec)s.map(k => R(q(k)));
          const se = sp[0], sk = sp[1], st = sp[2], sd = sp[3];
          // SPEC order = band order: se=toggle sk=draft st=keep sd=threshold
          // 2x2: line1 = toggle|draft, line2 = keep|threshold below it.
          // Null when any key is absent (model without specprefill).
          const sp2x2 = se && sk && st && sd
            ? (Math.abs(se.top - sk.top) < 8 && Math.abs(st.top - sd.top) < 8
               && st.top > se.bottom - 8 && se.left < sk.left - 20)
            : null;
          const gg = q('guided_grammar');
          let grammar = null;
          if (gg) {
            const ta = R(gg.querySelector('textarea'));
            const sel = R(gg.querySelector('.grammar-actions select'));
            const btn = R(gg.querySelector('.grammar-actions button'));
            grammar = ta && sel && btn ? {
              // UX-6c: one action row BELOW the textarea — example at the
              // left edge, EXPAND at the right edge, bottoms flush
              below: sel.top > ta.bottom - 2 && btn.top > ta.bottom - 2,
              leftAligned: Math.abs(ta.left - sel.left) < 2,
              rightAligned: Math.abs(btn.right - ta.right) < 2,
              bottomsFlush: Math.abs(sel.bottom - btn.bottom) < 2,
            } : null;
          }
          return JSON.stringify({modal, scroll, railHidden: rail.hidden,
                  pairs, grids, sp2x2, grammar,
                  sections: [...f.querySelectorAll('h5.se-section')]
                     .map(h => h.textContent.trim())});
        })()""" % {"paired": paired, "spec": spec_js})
        return json.loads(out) if isinstance(out, str) else out

    def _wait(self, ms):
        self._eval("(async () => { await new Promise(r => setTimeout(r, %d));"
                   " return 1; })()" % ms)

    def _click(self, selector):
        return self._eval("""(() => {
          const el = document.querySelector('%s');
          if (!el) return 'absent';
          el.click(); return 'clicked';
        })()""" % selector)

    def _click_if(self, selector, want_checked):
        """Click a checkbox only when its state differs from want_checked."""
        return self._eval("""(() => {
          const el = document.querySelector('%s');
          if (!el) return 'absent';
          if (el.checked !== %s) el.click();
          return el.checked ? 'on' : 'off';
        })()""" % (selector, "true" if want_checked else "false"))

    # ---------- checks ----------
    def t_sections(self, seen):
        want = [s for s in SECTIONS_IN_ORDER if s in seen]
        got = [s for s in seen if s in SECTIONS_IN_ORDER]
        self.check("section order", want == got,
                   "got %s" % ", ".join(got) or "no sections")

    def t_grid_tracks(self, data, w):
        bad = [n for n in data["grids"] if n != (2 if w >= PAIR_TWO_COL_MIN else 1)]
        self.check("pair tracks @%d" % w, not bad,
                   "%d/%d grids wrong: %s" % (len(bad), len(data["grids"]),
                                              sorted(set(bad))) if bad else "")

    def t_pairs(self, data, tag, w):
        for p in data["pairs"]:
            if p["state"] == "missing":
                # key absent for this model family — recorded, not silent
                self.check("pair %s (%s)" % (p["m"], tag), None, "skip: key absent")
                continue
            if w < PAIR_TWO_COL_MIN:
                # single column by design below the breakpoint: the knob
                # stacking under its master is correct; what must never
                # happen is a diagonal (band order broken)
                ok = p["state"] != "diagonal"
            else:
                ok = p["state"] == "same"
            self.check("pair %s (%s)" % (p["m"], tag), ok, p["state"])

    def t_spec(self, data, w):
        if data["sp2x2"] is None:
            self.check("specprefill 2x2 @%d" % w, None, "skip: keys absent")
            return
        if w < PAIR_TWO_COL_MIN:
            return  # one column by design; the 2x2 band cannot exist
        self.check("specprefill 2x2 @%d" % w, data["sp2x2"] is True)

    def t_grammar(self, data):
        g = data["grammar"]
        if not g:
            self.check("grammar stack", False, "grammar field absent")
            return
        self.check("grammar: actions below textarea", g["below"])
        self.check("grammar: example left-aligned", g["leftAligned"])
        self.check("grammar: EXPAND right-aligned", g["rightAligned"])
        self.check("grammar: action bottoms flush", g["bottomsFlush"])

    def t_gate(self):
        """Grammar well must track its master toggle BOTH ways: inert
        while off, live while on. (v1 false-FAIL: it clicked 'off' on an
        already-off toggle and measured a re-enabled well.)"""
        self.open()
        cb = '#se-fields [data-key="guided_grammar_enabled"] input[type=checkbox]'
        st = self._click_if(cb, False)
        self._wait(300)
        off = self._eval("""(() => {
          const ta = document.querySelector(
            '#se-fields [data-key="guided_grammar"] textarea');
          return ta ? ta.disabled : 'absent';
        })()""")
        self.check("grammar gated while off", off is True, "state=%s disabled=%s" % (st, off))
        self._click_if(cb, True)
        self._wait(300)
        on = self._eval("""(() => {
          const ta = document.querySelector(
            '#se-fields [data-key="guided_grammar"] textarea');
          return ta ? ta.disabled : 'absent';
        })()""")
        self.check("grammar live while on", on is False, "disabled=%s" % on)
        self.close()

    def _dirty_trigger(self):
        """First toggle that exists on this model — v1 assumed
        turboquant always exists; on another model family it does not."""
        for key in ("turboquant_kv_enabled", "enableThinkingBudget",
                    "specprefill_enabled", "guided_grammar_enabled"):
            sel = ('#se-fields [data-key="%s"] input[type=checkbox]' % key)
            if self._eval("""(() => {
              const el = document.querySelector('%s');
              return el ? 1 : 0;
            })()""" % sel):
                return sel
        return None

    def t_rail_invariance(self, w):
        """Clean vs dirty: the FORM must not move. Below RAIL_RESERVE_MIN the
        rail overlays; at/above it the modal widens by exactly rail+gap."""
        self.open()
        trig = self._dirty_trigger()
        if trig is None:
            self.check("rail invariance @%d" % w, None, "skip: no toggle key")
            self.close()
            return
        clean = self._probe()
        # queue exactly one change
        self._click(trig)
        self._wait(400)
        dirty = self._probe()
        d_clean = clean["scroll"]["width"]
        d_dirty = dirty["scroll"]["width"]
        self.check("form width stable @%d" % w, abs(d_clean - d_dirty) <= 1,
                   "clean %d -> dirty %d" % (d_clean, d_dirty))
        self.check("modal left pinned @%d" % w,
                   abs(clean["modal"]["left"] - dirty["modal"]["left"]) <= 1,
                   "clean %d -> dirty %d" % (clean["modal"]["left"],
                                             dirty["modal"]["left"]))
        self.check("rail visible when dirty @%d" % w, dirty["railHidden"] is False)
        # the ORIGINAL UX-5b complaint: a toggle must not move its knob
        self.t_pairs(dirty, "dirty@%d" % w, w)
        if w >= RAIL_RESERVE_MIN:
            # above the breakpoint the widened modal (1200) always fits
            # (w >= 1232 implies 0.98w >= 1207 >= 1200); the fits guard is
            # defensive against a future width change of either side
            grow = dirty["modal"]["width"] - clean["modal"]["width"]
            fits = clean["modal"]["width"] + 332 <= w * 0.98 + 1
            self.check("modal widens for rail @%d" % w,
                       grow > 0 or not fits,
                       "clean %d -> dirty %d (fits=%s)" % (clean["modal"]["width"],
                                                           dirty["modal"]["width"], fits))
        self.close()

    def t_rail_no_animation(self, w=1728):
        """The rail pop must be a single-frame change: sampling the modal
        width across the frames after the toggle must show NO intermediate
        value (UX-6b shipped a transition that slid the window)."""
        self.open()
        trig = self._dirty_trigger()
        if trig is None:
            self.check("rail pop is instant (no slide)", None, "skip: no toggle key")
            self.close()
            return
        js_trig = trig.replace("'", "\\'")
        samples = self._eval("""(async () => {
          const m = document.querySelector('.modal.editor');
          const out = [];
          const cb = document.querySelector('%s');
          out.push(m.getBoundingClientRect().width);
          cb.click();
          for (let i = 0; i < 10; i++) {
            await new Promise(r => requestAnimationFrame(() => r()));
            out.push(m.getBoundingClientRect().width);
          }
          return JSON.stringify(out);
        })()""" % js_trig)
        vals = [round(v) for v in json.loads(samples)]
        uniq = sorted(set(vals))
        self.check("rail pop is instant (no slide)", len(uniq) <= 2,
                   "widths seen: %s" % uniq)
        self.close()

    def t_localized(self, w):
        """Czech pass (U41 bug class): labels there run 30-50 % longer.
        The grid must adapt (wrap, never ellipsis) and no row may spill
        outside the form; knob-beside-master must survive the longer
        words at full width."""
        self.open()
        info = self._eval("""(() => {
          const f = document.querySelector('#se-fields');
          if (!f) return JSON.stringify({err: 'editor not open'});
          const names = [...f.querySelectorAll('.se-row > span:first-child')];
          let clipped = 0, csHits = 0;
          for (const n of names) {
            const cs = getComputedStyle(n);
            if (cs.overflow === 'hidden' && n.scrollWidth > n.clientWidth + 2
                && cs.overflowWrap !== 'anywhere') clipped++;
            // Czech signal: letters that appear in no English label.
            // (v2 first draft demanded words and missed e.g. 'Okno
            // kontextu' — diacritics alone are the honest test.)
            if (/[áčďéěíňóřšťúůž]/i.test(n.textContent)) csHits++;
          }
          const scroll = document.querySelector('.editor-scroll')
            .getBoundingClientRect();
          let spill = 0;
          for (const r of f.querySelectorAll('.se-row')) {
            const b = r.getBoundingClientRect();
            if (b.right > scroll.right + 2 || b.left < scroll.left - 2) spill++;
          }
          return JSON.stringify({rows: names.length, clipped, csHits, spill,
            sample: names.slice(0, 6).map(n => n.textContent.trim())});
        })()""")
        d = json.loads(info)
        if d.get("err"):
            self.check("czech pass @%d" % w, False, d["err"])
        else:
            self.check("cs: labels localized @%d" % w, d["csHits"] >= 3,
                       "csHits=%d sample=%s" % (d["csHits"], d["sample"][:3]))
            self.check("cs: no clipped labels @%d" % w, d["clipped"] == 0,
                       "%d/%d clipped" % (d["clipped"], d["rows"]))
            self.check("cs: no row spill @%d" % w, d["spill"] == 0,
                       "%d rows outside form" % d["spill"])
            if w >= PAIR_TWO_COL_MIN:
                self.t_pairs(self._probe(), "cs@%d" % w, w)
        self.close()

    def run(self):
        origin = self._eval("location.origin") or ""
        if self.base and not origin.startswith(self.base):
            raise RuntimeError(
                "suite loaded on %s but expected %s — refusing to measure "
                "the wrong instance" % (origin, self.base))
        # fresh assets: tamper/deploy tests edit served CSS while the tab
        # may hold the OLD sheet — always start from a hard reload
        self.cdp('Page.reload', ignoreCache=True)
        import time as _t
        for _ in range(40):
            _t.sleep(0.4)
            try:
                if self._eval("document.readyState") == "complete" \
                        and self._eval("!!window.Uplift"):
                    break
            except Exception:
                pass
        mid, covered, total = self.pick_model()
        self.header = "model=%s key-coverage=%d/%d" % (mid, covered, total)
        if covered == 0:
            self.check("coverage", False,
                       "no model exposes ANY invariant key — suite would "
                       "be vacuously green")
            return self.report()
        for w in WIDTHS:
            self._width(w)
            try:
                self.open()
                data = self._probe()
                if data.get("err"):
                    self.check("open editor @%d" % w, False, data["err"])
                    continue
                if w == WIDTHS[0]:
                    self.t_sections(data["sections"])
                self.t_grid_tracks(data, w)
                self.t_pairs(data, "clean@%d" % w, w)
                self.t_spec(data, w)
                self._click_if('#se-fields [data-key="guided_grammar_enabled"] input[type=checkbox]', True)
                self._wait(250)
                self.t_grammar(self._probe())
                self.close()
                self.t_rail_invariance(w)
            finally:
                self.close()
        self._width(WIDTHS[-1])
        try:
            self.t_gate()
            self.t_rail_no_animation(WIDTHS[-1])
        finally:
            self.close()
        # B: Czech localization pass (QA reload is locale-persistent:
        # ?lang override lives in the URL we navigate to per reload)
        try:
            self.cdp('Page.navigate', url=self.base + "/uplift/?lang=cs")
            for _ in range(40):
                _t.sleep(0.4)
                try:
                    if self._eval("document.readyState") == "complete" \
                            and self._eval("!!window.Uplift"):
                        break
                except Exception:
                    pass
            for w in (1024, 1728):
                self._width(w)
                self.t_localized(w)
        finally:
            self.close()
            self._clear_width()
            try:
                self.cdp('Page.navigate', url=self.base + "/uplift/")
            except Exception:
                pass
        return self.report()

    def report(self):
        bad = [r for r in self.results if r[1] is False]
        skipped = [r for r in self.results if r[1] is None]
        passed = [r for r in self.results if r[1] is True]
        lines = [""]
        if getattr(self, "header", None):
            lines.append("measured: " + self.header)
        for name, ok, detail in self.results:
            tag = "PASS" if ok is True else ("FAIL" if ok is False else "SKIP")
            lines.append("%s %-44s %s" % (tag, name, detail))
        lines.append("")
        lines.append("layout suite v%s: %d passed, %d failed, %d skipped "
                     "(%d total)" % (VERSION, len(passed), len(bad),
                                     len(skipped), len(self.results)))
        if skipped:
            lines.append("skips are claims: if the measured model SHOULD "
                         "have those keys, something is wrong upstream.")
        return "\n".join(lines)


def run(js, cdp, base=""):
    return Suite(js, cdp, base).run()
