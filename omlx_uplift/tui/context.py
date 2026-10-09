"""TUI action context (TUI-1).

Everything the screens and the ops need, behind one object: the live patch
store, the module handles ops call, and the collectors that turn state into
plain dicts. No curses here — the same context drives the tests.

Two rules this module exists to enforce:
  * reads are never cached — the dashboard, a boot reconcile or a second
    terminal can change the store at any moment;
  * every mutation goes through the code the dashboard route or the CLI verb
    already uses (`quiet_call` / `cli_patch_verb` / `cli_dev_verb`). The TUI
    implements no policy of its own, so it cannot drift from the invariants
    those paths carry (DEV-11 auto-update off on a keg switch, kill-switch
    stamping, safeguard approval rules).
"""
from __future__ import annotations

import io
import os
import subprocess
from contextlib import redirect_stderr, redirect_stdout


class Context:
    def __init__(self, store=None, tree_root: str | None = None,
                 runner=None, on_process=None):
        from .. import (curated, devsrc, kegstash, patchsource, patches,
                        patchsync)

        # module handles, not direct imports inside the ops: a test can put a
        # recorder on the context and prove an op reaches the right function
        # without touching a live store
        self._patches = patches
        self.patchsource = patchsource
        self.patchsync = patchsync
        self.curated = curated
        self.devsrc = devsrc
        self.kegstash = kegstash

        self.store = store or patches.PatchStore()
        self._tree_root_override = tree_root
        self._lines: list[str] = []
        self._runner = runner          # tests inject a fake command runner
        self.on_process = on_process   # app hook: remember the child (Ctrl-C)

    # ------------------------------------------------------------- plumbing --
    @property
    def tree_root(self) -> str:
        """site-packages root of the omlx tree patches apply to ('' when the
        package cannot be imported — every mutating op checks it first).

        An override of '' means 'there is deliberately no tree' and is
        honoured: testing the override for truthiness would let it fall
        through to the live probe and aim a write at whatever keg this
        interpreter happens to see."""
        if self._tree_root_override is not None:
            return self._tree_root_override
        root = self._patches._omlx_root()
        return os.path.dirname(root) if root else ""

    def keg(self):
        """Identity of the live tree, for the 'applied on this keg?' check
        (a brew upgrade builds a new keg and every applied patch must
        re-validate against it)."""
        root = self._patches._omlx_root()
        return self._patches.keg_id(root) if root else None

    def build_root(self):
        return self.patchsource.dev_build_root()

    def log(self, text: str) -> None:
        for line in str(text).splitlines() or [""]:
            self._lines.append(line)
        del self._lines[:-400]

    def log_lines(self) -> list[str]:
        return list(self._lines)

    def run(self, argv: list, on_line=None) -> dict:
        """Run a child command, streaming lines to the log and on_line.
        Returns {ok, code, output}; a non-zero exit is a result, not a crash."""
        if self._runner is not None:
            return self._runner(argv, on_line)
        self.log("$ " + " ".join(str(a) for a in argv))
        out_lines: list[str] = []
        try:
            proc = subprocess.Popen([str(a) for a in argv],
                                    stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, text=True,
                                    bufsize=1)
        except OSError as exc:
            return {"ok": False, "code": 127, "output": [],
                    "reason": f"cannot run {argv[0]}: {exc}"}
        if self.on_process:
            self.on_process(proc)
        try:
            for line in (proc.stdout or []):
                line = line.rstrip("\n")
                out_lines.append(line)
                self.log(line)
                if on_line:
                    on_line(line)
            code = proc.wait()
        finally:
            if self.on_process:
                self.on_process(None)
        return {"ok": code == 0, "code": code, "output": out_lines,
                "reason": None if code == 0 else f"exit code {code}"}

    def subprocess_runner(self, argv: list, on_line=None) -> dict:
        """Named for what the ops call."""
        return self.run(argv, on_line)

    def quiet_call(self, fn, *args, **kwargs) -> dict:
        """Call a function that prints (the CLI verbs dump JSON), capture its
        stdout so nothing corrupts the screen, return its result."""
        buf = io.StringIO()
        try:
            with redirect_stdout(buf), redirect_stderr(buf):
                res = fn(*args, **kwargs)
        except SystemExit as exc:               # argparse / SystemExit paths
            text = buf.getvalue().strip()
            return {"ok": False,
                    "reason": text or f"exited with {exc.code}",
                    "rc": int(exc.code or 2)}
        except Exception as exc:                # an op must never kill the UI
            return {"ok": False,
                    "reason": f"{type(exc).__name__}: {exc or 'no detail'}"}
        text = buf.getvalue().strip()
        if text:
            self.log(text)
        if isinstance(res, dict):
            return res
        if isinstance(res, int):                # a cli.cmd_* return code
            return {"ok": res == 0, "rc": res}
        return {"ok": True, "result": res}

    # -------------------------------------------------- CLI verb reuse (DRY) --
    def cli_patch_verb(self, action: str, *extra: str) -> dict:
        """Run `omlx-uplift patch <action>` in process. The kill switch and
        friends stamp the manifest inside cmd_patches; calling the handler is
        the only way the TUI cannot fork that policy."""
        return self._cli_verb(self._cmd("cmd_patches"), action, *extra)

    def cli_dev_verb(self, action: str, *extra: str) -> dict:
        """Same for `omlx-uplift dev <action>` — 'dev use' and 'dev rollback'
        carry the DEV-11 invariants (auto-update off, base pin cleared, brew
        link record synced, .pth remount check). Re-implementing them here
        would be the bug."""
        return self._cli_verb(self._cmd("cmd_dev"), action, *extra)

    @staticmethod
    def _cmd(name):
        from .. import cli

        return getattr(cli, name)

    def _cli_verb(self, handler, *argv) -> dict:
        import json

        res = self.quiet_call(handler, list(argv))
        text = res.pop("output", None)
        if isinstance(text, str):
            try:
                parsed = json.loads(text)
            except ValueError:
                res.setdefault("output", text)
            else:
                if isinstance(parsed, dict):
                    res = {**parsed, **{k: v for k, v in res.items()
                                        if k == "rc"}}
                else:
                    res.setdefault("output", text)
        res.setdefault("ok", res.get("rc", 0) == 0)
        return res

    # ------------------------------------------------------------ collectors --
    def patches_view(self) -> dict:
        if not self.tree_root:
            return {"patches": [],
                    "kill_switch_active": self.store.patches_disabled(),
                    "load_error": "omlx package tree not found — this python "
                                  "cannot see omlx"}
        return self.patchsource.view(self.store, self.tree_root, self.keg())

    def catalog(self) -> dict:
        try:
            res = self.curated.list_remote()
        except Exception as exc:
            return {"ok": False, "tiers": {}, "reason": str(exc)}
        try:
            manifest = self.store.load()
            for tier in (res.get("tiers") or {}).values():
                for e in tier:
                    p = (self.curated.find_by_source(manifest, e.get("source"))
                         or self.store.find(manifest, e.get("id")))
                    e["installed"] = p is not None
                    if p is not None:
                        e["under_id"] = p["id"]
                        e["adopted"] = bool(p.get("curated_adopted"))
        except Exception:
            pass                                # a listing is still useful
        return res

    def dev_summary(self) -> dict:
        cfg = self.devsrc.load_config()
        if not cfg:
            return {"installed": False,
                    "reason": "dev.json missing — run: omlx-uplift dev "
                              "bootstrap"}
        try:
            st = self.devsrc.status(cfg, self.patchsource
                                    .enabled_build_patches(self.store))
        except Exception as exc:
            return {"installed": True, "reason": f"status failed: {exc}"}
        # devsrc.drift_check returns {drift: bool, detail: str}, not a list
        dr = st.get("drift")
        drift_flag = bool(dr.get("drift")) if isinstance(dr, dict) else bool(dr)
        drift = []
        if drift_flag:
            detail = dr.get("detail") if isinstance(dr, dict) else str(dr)
            drift = [str(x) for x in (detail or "").split("; ") if str(x).strip()]
        commits = st.get("patch_commits") or []
        return {
            "installed": bool(st.get("installed", True)),
            "reason": st.get("reason"),
            "branch": st.get("branch"), "tip": st.get("tip"),
            "base": st.get("base"), "sync_ref": st.get("sync_ref"),
            "base_pin": st.get("base_pin"),
            "ahead": st.get("ahead", 0), "behind": st.get("behind", 0),
            "patch_commits": commits,
            "drift": drift,
            "drift_note": (f"{len(drift)} drift line(s)" if drift
                           else "carrier = enabled set"),
            "auto_update": bool(cfg.get("auto_update")),
            "auto_note": ("TRACK HEAD on" if cfg.get("auto_update")
                          else "manual (auto-build off)"),
            "port": cfg.get("port"),
            "detail": ([f"carrier branch: {st.get('branch')}",
                        f"sync ref:       {st.get('sync_ref')}",
                        f"tip:            {st.get('tip')}",
                        f"base:           {st.get('base')}"
                        + (f"  (pinned {st.get('base_pin')}"
                           f" — TRACK HEAD cannot move it)"
                           if st.get("base_pin") else ""),
                        f"dev port:       {cfg.get('port')}",
                        f"dev data root:  {cfg.get('base_path')}",
                        f"auto-build:     "
                        f"{'ON — omlx-dev tracks HEAD' if cfg.get('auto_update') else 'off (manual)'}",
                        f"patch commits:  {len(commits)}"]
                       + [f"    {c.get('id')} v{c.get('v')} "
                          f"{(c.get('sha') or '')[:8]}" for c in commits[:10]]
                       + ([f"drift: {d}" for d in drift[:6]] or [])),
        }

    def stashes(self) -> list[dict]:
        try:
            rows = self.kegstash.list_stashes()
        except Exception:
            return []
        counts: dict[str, int] = {}
        for m in rows:
            key = m.get("cellar_name") or m.get("name") or ""
            counts[key] = counts.get(key, 0) + 1
        for m in rows:
            key = m.get("cellar_name") or m.get("name") or ""
            m["shared_cellar"] = counts.get(key, 0) > 1
        return rows

    def active_keg(self):
        try:
            return self.kegstash.active_keg()
        except Exception:
            return None

    def pth_missing(self) -> bool:
        """True when the active dev keg has no uplift .pth — the shape that
        produces a dashboard full of 404s after a keg switch. Deliberately a
        file check, not cli._verify_mount's import probe: a repaint must never
        block for seconds."""
        try:
            from .. import brewutil

            python = brewutil.brew_formula_python("omlx-dev")
            if not python:
                return False
            site_pkgs = brewutil.resolve_site_packages(str(python))
            return not (site_pkgs / brewutil.PTH_NAME).is_file()
        except SystemExit:
            return False
        except Exception:
            return False

    def services(self) -> list[dict]:
        """Both formulae the operator can restart, each with its port and how
        many enabled patches its tree currently carries."""
        cfg = self.devsrc.load_config() or {}
        # one table for both rows: `brew services list` costs ~0.5 s, and the
        # screen rebuilds every few seconds — parsing it twice would double the
        # cost for the same answer and make the UI feel laggy over ssh
        table = self._service_table()
        rows = []
        for formula, keg_scope in (("omlx", True), ("omlx-dev", False)):
            keg = None
            try:
                keg = self.kegstash.active_keg(formula)
            except Exception:
                pass
            cellar = os.path.join("/opt/homebrew/Cellar",
                                  formula, keg) if keg else ""
            rows.append({
                "formula": formula,
                "label": formula,
                "state": table.get(formula, ""),
                "port": (self.vanilla_port() if formula == "omlx"
                         else cfg.get("port", 8001)),
                "keg": cellar,
                "patched": self._applied_count(keg_scope),
            })
        return rows

    def vanilla_port(self) -> int:
        """The port the vanilla server actually binds: omlx reads
        settings.json's NESTED server.port (the same key 'omlx-uplift view'
        rewrites — see cli.py), not a top-level 'port'. Reading the wrong
        shape made the TUI show :8000 while the board served :8011."""
        import json

        try:
            with open(os.path.expanduser("~/.omlx/settings.json")) as fh:
                data = json.load(fh)
            server = data.get("server")
            if isinstance(server, dict) and server.get("port"):
                return int(server["port"])
            if data.get("port"):            # flat shape, just in case
                return int(data["port"])
        except (OSError, ValueError, TypeError):
            pass
        return 8000

    def _applied_count(self, keg_scope: bool) -> str:
        try:
            manifest = self.store.load()
        except Exception:
            return "?"
        n = 0
        for p in manifest.get("patches", []):
            if not p.get("enabled") or p.get("state") != "applied":
                continue
            scope = self._patches.patch_scope(p)
            if (self._patches.scope_touches_keg(scope) if keg_scope
                    else self._patches.scope_touches_dev(scope)):
                n += 1
        return str(n)

    _TABLE_TTL = 4.0        # seconds; shorter than the 5 s repaint cycle

    def _service_table(self) -> dict:
        """{formula: state} from one `brew services list`. brew's build on
        this box takes no name argument, so the whole table is parsed (same
        rule cli._service_state follows). Cached for a few seconds: the value
        only changes when someone starts or stops a service, and a repaint
        must not pay 0.5 s per screen."""
        import time as _t

        now = _t.monotonic()
        cached = getattr(self, "_svc_cache", None)
        if cached and now - cached[0] < self._TABLE_TTL:
            return cached[1]
        table = {}
        try:
            res = subprocess.run(["brew", "services", "list"],
                                 capture_output=True, text=True, timeout=30)
            for line in (res.stdout or "").splitlines():
                parts = line.split()
                if len(parts) > 1:
                    table[parts[0]] = parts[1]
        except (OSError, subprocess.TimeoutExpired):
            table = getattr(self, "_svc_cache", (0, {}))[1]
        self._svc_cache = (now, table)
        return table

    def _service_state(self, formula: str) -> str:
        return self._service_table().get(formula, "")

