#!/usr/bin/env python3
"""Exercise the two problems that the curated patches
``pool-aware-memory-pressure`` and ``ssd-prefix-prefetch`` fix.

Run it against a live omlx / uplift board (plain ``python3`` is
enough, no venv needed). It works with the patches ON or OFF and reports
which behaviour the server actually showed.

Scenario "ssd"  - a waiting request whose cached prefix lives only on the
                  SSD used to stall every running request for the whole
                  disk read (synchronous restore). The probe streams
                  --parallel decodes, then fires 1+--queued requests that
                  all share one SSD-only prefix, and measures the
                  inter-token gaps of the streams. Patched: the gaps stay
                  small and the log shows "SSD prefetch for <id>
                  started/done".

Scenario "pool" - MLX keeps freed Metal buffers for reuse; phys_footprint
                  charges them, so the memory guard used to read soft/hard
                  pressure from a pool that is not working memory: it
                  paused admission and evicted idle models. The pressure
                  needs CONCURRENCY to build (sequential requests hand the
                  pool back at every step boundary): the probe runs
                  --parallel + --queued overlapping long prefills+decodes
                  for --iters rounds while recording the pressure time
                  series from /admin/api/stats and the guard's transitions
                  from the server log. Patched: the transition lines carry
                  "reclaimable_pool=..." and the level stays ok while only
                  the pool is high.

Usage examples:
  python3 probe-ssd-pool.py                    # auto-detect, both scenarios
  python3 probe-ssd-pool.py --scenario ssd --iters 2 --parallel 3 --purge
  python3 probe-ssd-pool.py --base-url http://127.0.0.1:8001 \
      --api-key KEY --model Qwen3-32B-4bit --log ~/.omlx-dev/omlx.log
"""

from __future__ import annotations

import argparse
import json
import os
import random
import re
import statistics
import string
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

GAP_SLOW_S = 0.5          # an inter-token gap above this is a stall
SETTINGS_CANDIDATES = [
    "~/.omlx-dev/settings.json",
    "~/.omlx/settings.json",
    "~/Library/Application Support/oMLX/settings.json",
]
LOG_CANDIDATES = [
    "/opt/homebrew/var/log/omlx-dev.log",
    "/opt/homebrew/var/log/omlx.log",
    "~/.omlx-dev/omlx.log",
    "~/.omlx-dev/logs/omlx.log",
    "~/.omlx/omlx.log",
    "~/.omlx/logs/omlx.log",
]
NONCE = "".join(random.choice(string.ascii_lowercase) for _ in range(10))


# --------------------------------------------------------------------------
# small HTTP helpers (stdlib only)
# --------------------------------------------------------------------------

class Http:
    def __init__(self, base_url: str, api_key: str | None):
        self.base = base_url.rstrip("/")
        self.key = api_key

    def _req(self, method: str, path: str, body: dict | None, timeout: float):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Content-Type", "application/json")
        if self.key:
            req.add_header("Authorization", f"Bearer {self.key}")
        return urllib.request.urlopen(req, timeout=timeout)

    def call(self, method: str, path: str, body: dict | None = None,
             timeout: float = 30.0) -> dict:
        with self._req(method, path, body, timeout) as resp:
            raw = resp.read()
        return json.loads(raw) if raw else {}

    def chat(self, model: str, prompt: str, max_tokens: int,
             timeout: float = 600.0) -> tuple[float, dict]:
        """Non-streaming completion. Returns (latency_s, usage)."""
        t0 = time.monotonic()
        out = self.call("POST", "/v1/chat/completions", {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0,
        }, timeout=timeout)
        dt = time.monotonic() - t0
        return dt, out.get("usage") or {}

    def chat_stream_timed(self, model: str, prompt: str, max_tokens: int,
                          stop_after: threading.Event | None = None,
                          prog: dict | None = None,
                          ) -> dict:
        """Stream a completion, timestamp every token chunk.

        ``prog`` (if given) is updated live with {"tokens": n, "ttft_s": t}
        so a caller can fire something while this stream is decoding.
        Returns {ttft_s, gaps: [s...], tokens, total_s}.
        """
        stamps: list[float] = []
        t0 = time.monotonic()
        ttft = None
        try:
            resp = self._req("POST", "/v1/chat/completions", {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": 0,
                "stream": True,
            }, timeout=600.0)
        except Exception as exc:  # noqa: BLE001
            return {"error": f"{type(exc).__name__}: {exc}"}
        with resp:
            for line in resp:
                if stop_after is not None and stop_after.is_set():
                    break
                if not line.startswith(b"data: "):
                    continue
                payload = line[6:].strip()
                if payload == b"[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
                # reasoning models stream thinking in reasoning_content;
                # it occupies the decoder just the same
                if delta.get("content") or delta.get("reasoning_content"):
                    now = time.monotonic()
                    if ttft is None:
                        ttft = now - t0
                    stamps.append(now)
                    if prog is not None:
                        prog["tokens"] = len(stamps)
                        prog["ttft_s"] = ttft
        total = time.monotonic() - t0
        gaps = [b - a for a, b in zip(stamps, stamps[1:])]
        return {"ttft_s": ttft, "gaps": gaps, "tokens": len(stamps),
                "total_s": total}


# --------------------------------------------------------------------------
# prompt building
# --------------------------------------------------------------------------

def try_purge() -> str:
    """Best-effort OS file-cache drop so the SSD read is really cold.

    Returns a status string for the report. Never fails the run.
    """
    import subprocess
    try:
        subprocess.run(["sync"], check=False, timeout=30)
    except Exception:  # noqa: BLE001
        pass
    for cmd in (["purge"], ["sudo", "-n", "purge"]):
        try:
            if subprocess.run(cmd, capture_output=True, timeout=120).returncode == 0:
                return "purged"
        except (FileNotFoundError, PermissionError, OSError):
            continue
        except Exception:  # noqa: BLE001
            continue
    return ("purge unavailable (needs root: run 'sudo purge' in another "
            "terminal before each SSD pass, or start the probe under sudo)")


def long_prompt(target_tokens: int, tag: str) -> str:
    """Unique filler text of roughly target_tokens tokens (about 0.8 w/tok).

    NONCE + tag make every prompt fresh, so each prefill really allocates
    and frees buffers and each prefix really has to be written to the SSD.
    """
    words = max(10, int(target_tokens / 0.8))
    rng = random.Random(hash((NONCE, tag)) & 0xFFFFFFFF)
    syll = ("ta ne ki ro mu sen vi dl a tr po ke li zn ga fe ti "
            "bo ru sha kle mon vii zeta qua").split()
    head = f"Probe {NONCE}/{tag}. Read the following invented log corpus. "
    body = " ".join(rng.choice(syll) for _ in range(words))
    return head + body + " Summarize the corpus in one word."


# --------------------------------------------------------------------------
# log window helpers
# --------------------------------------------------------------------------

class LogWindow:
    def __init__(self, path: str | None):
        self.path = path
        self.offset = 0
        if path and os.path.exists(path):
            self.offset = os.path.getsize(path)

    def new_lines(self) -> list[str]:
        if not self.path or not os.path.exists(self.path):
            return []
        with open(self.path, "r", errors="replace") as fh:
            fh.seek(self.offset)
            lines = fh.read().splitlines()
            self.offset = fh.tell()
        return lines

    def history_markers(self, tail_bytes: int = 2_000_000) -> dict:
        """Patch markers anywhere in the recent log history (before run)."""
        if not self.path or not os.path.exists(self.path):
            return {}
        size = os.path.getsize(self.path)
        with open(self.path, "rb") as fh:
            fh.seek(max(0, size - tail_bytes))
            blob = fh.read().decode(errors="replace")
        return {
            "reclaimable_pool_seen": "reclaimable_pool=" in blob,
            "ssd_prefetch_seen": "SSD prefetch for" in blob,
        }


# --------------------------------------------------------------------------
# scenario: SSD prefix prefetch
# --------------------------------------------------------------------------

def run_ssd(http: Http, model: str, args, logw: LogWindow, report: dict) -> None:
    print("\n=== scenario ssd: SSD-only prefix restore vs a running decode ===")
    prefix = long_prompt(args.prefix_tokens, "ssd")
    filler = ("Tell me a detailed story about a lighthouse keeper who maps "
              "constellations. Begin:")

    print(f"[1] priming cache: one request with a fresh ~{args.prefix_tokens}"
          "-token prefix ...")
    try:
        dt, _ = http.chat(model, prefix, 8)
    except urllib.error.HTTPError as exc:
        hint = (" - model does not fit under the memory guard ceiling; "
                "pick a smaller --model" if exc.code == 507 else "")
        report["ssd"] = {"error": f"prime failed: HTTP {exc}{hint}"}
        print(f"    FAILED: HTTP {exc}{hint}")
        return
    except Exception as exc:  # noqa: BLE001
        report["ssd"] = {"error": f"prime failed: {exc}"}
        print(f"    FAILED: {exc}")
        return
    print(f"    primed in {dt:.1f}s; settling 3s for write-through ...")
    time.sleep(3)

    def one_pass(label: str) -> dict:
        """--parallel decode streams, then 1+--queued SSD-hit requests.

        All hit requests share the same primed prefix (the shape of
        several chats on one long system prompt): the first restore is
        cold, the rest queue behind it.
        """
        res: dict = {"label": label}
        pass_t0 = time.monotonic()
        stop = threading.Event()
        streams: list[tuple[threading.Thread, dict, dict]] = []

        for _s in range(max(1, args.parallel)):
            box: dict = {}
            prog: dict = {}

            def stream_bg(box=box, prog=prog):
                box["b"] = http.chat_stream_timed(model, filler, 400,
                                                  stop_after=stop, prog=prog)

            t = threading.Thread(target=stream_bg, daemon=True)
            t.start()
            streams.append((t, box, prog))
            time.sleep(0.3)

        # wait until every stream is really decoding
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            ready = all(p.get("tokens", 0) >= 8 or "b" in bx
                        for _t, bx, p in streams)
            if ready:
                break
            time.sleep(0.1)
        time.sleep(args.stream_lead_s)

        t_fire = time.monotonic()
        hits: list[dict] = []
        hit_threads = []
        for h in range(1 + max(0, args.queued)):
            rec: dict = {"n": h + 1}
            hits.append(rec)

            def hit(rec=rec):
                try:
                    lat, usage = http.chat(model, prefix, 8)
                    rec["latency_s"] = round(lat, 2)
                    rec["prompt_tokens"] = usage.get("prompt_tokens", 0)
                    rec["cached_tokens"] = (
                        (usage.get("prompt_tokens_details") or {})
                        .get("cached_tokens", 0))
                except Exception as exc:  # noqa: BLE001
                    rec["error"] = str(exc)[:120]

            t = threading.Thread(target=hit, daemon=True)
            t.start()
            hit_threads.append(t)
            time.sleep(0.05)     # near-simultaneous, ordered
        for t in hit_threads:
            t.join(timeout=900)
        stop.set()
        for t, _bx, _p in streams:
            t.join(timeout=300)

        res["a_fire_offset_s"] = round(t_fire - pass_t0, 1)
        res["hits"] = hits
        ok_hits = [h for h in hits if "latency_s" in h]
        res["a_max_latency_s"] = max((h["latency_s"] for h in ok_hits),
                                     default=None)
        res["a_cached_tokens"] = max((h.get("cached_tokens", 0)
                                      for h in ok_hits), default=0)
        res["a_prompt_tokens"] = max((h.get("prompt_tokens", 0)
                                      for h in ok_hits), default=0)
        per_stream = []
        all_gaps: list[float] = []
        for _t, bx, _p in streams:
            b = bx.get("b", {})
            gaps = b.get("gaps", [])
            all_gaps += gaps
            per_stream.append({
                "tokens": b.get("tokens", 0),
                "ttft_s": round(b.get("ttft_s") or 0, 2),
                "max_gap_s": round(max(gaps), 2) if gaps else None,
                "slow_gaps": sum(1 for g in gaps if g > GAP_SLOW_S),
            })
        res["streams"] = per_stream
        res["b_tokens"] = sum(s["tokens"] for s in per_stream)
        res["b_max_gap_s"] = round(max(all_gaps), 2) if all_gaps else None
        res["b_median_gap_s"] = (round(statistics.median(all_gaps), 3)
                                 if all_gaps else None)
        res["b_slow_gaps"] = sum(1 for g in all_gaps if g > GAP_SLOW_S)
        print(f"  [{label}] {len(streams)} streams: {res['b_tokens']} tok, "
              f"max gap {res['b_max_gap_s']}s, slow gaps {res['b_slow_gaps']}; "
              f"{len(hits)} hit requests: max {res['a_max_latency_s']}s, best "
              f"cache hit {res['a_cached_tokens']}/{res['a_prompt_tokens']} tok")
        for h in hits:
            print(f"      hit {h['n']}: " + (f"{h.get('latency_s')}s, cached "
                  f"{h.get('cached_tokens')}" if "latency_s" in h
                  else f"FAILED {h.get('error')}"))
        return res

    passes = []
    passes.append(one_pass("control: prefix in RAM"))

    clear_report: dict = {}
    for i in range(args.iters):
        try:
            clear_report = http.call("POST", "/admin/api/hot-cache/clear",
                                     timeout=60)
        except Exception as exc:  # noqa: BLE001
            print(f"    hot-cache/clear failed ({exc}); restart the board "
                  "between iterations instead, otherwise the prefix stays "
                  "in RAM and the test is invalid")
            break
        time.sleep(1)
        if args.purge:
            print(f"    OS file cache: {try_purge()}")
        noop = (clear_report.get("total_cleared", 0) == 0
                and clear_report.get("bytes_reclaimed", 0) == 0)
        note = ("  WARNING: clear was a no-op (total_cleared=0) - the RAM "
                "copy may still be there; a cache hit below does NOT prove "
                "the SSD path" if noop else "")
        print(f"[2.{i + 1}] hot cache cleared ({json.dumps(clear_report)[:120]})"
              f"{note}")
        passes.append(one_pass(f"run {i + 1}: SSD-only prefix"))
        time.sleep(2)

    window = logw.new_lines()
    markers = [ln for ln in window if "SSD prefetch" in ln]
    verdict = "inconclusive"
    ssd_passes = [p for p in passes if p["label"].startswith("run")]
    if ssd_passes:
        ctrl = passes[0]
        worst = max((p.get("b_max_gap_s") or 0) for p in ssd_passes)
        ctrl_gap = ctrl.get("b_max_gap_s") or 0
        cold = [p for p in ssd_passes if p.get("a_cached_tokens", 0) == 0]
        if len(cold) == len(ssd_passes):
            verdict = ("PRECONDITION FAILED: request A got no cache hit after "
                       "the clear - the prefix never reached the SSD (hot "
                       "cache write-through off?) or was dropped with it; "
                       "the stall question is unanswered")
        elif markers:
            verdict = (f"prefetch path ACTIVE ({len(markers)} log lines); "
                       f"worst stall {worst}s vs RAM-hit control {ctrl_gap}s")
        elif worst > max(2.0, 3 * max(ctrl_gap, 0.05)):
            verdict = (f"STALL REPRODUCED: SSD-only restore blocked the "
                       f"decode for up to {worst}s (control {ctrl_gap}s), "
                       "no prefetch log lines -> synchronous restore")
        else:
            verdict = (f"cache hit after clear but no stall ({worst}s vs "
                       f"control {ctrl_gap}s) and no prefetch log lines - "
                       "the read was served warm (OS page cache or a RAM "
                       "copy the clear missed); rerun with --purge for a "
                       "cold read")
    report["ssd"] = {
        "passes": passes,
        "prefetch_log_lines": markers[-10:],
        "hot_cache_clear_response": clear_report,
        "verdict": verdict,
    }
    print(f"  verdict: {verdict}")
    for ln in markers[-6:]:
        print(f"    log: {ln[:160]}")


# --------------------------------------------------------------------------
# scenario: pool-aware memory pressure
# --------------------------------------------------------------------------

def read_pressure(http: Http) -> dict | None:
    try:
        stats = http.call("GET", "/admin/api/stats", timeout=15)
    except Exception:  # noqa: BLE001
        return None
    am = stats.get("active_models") or {}
    return am.get("memory_pressure") or stats.get("memory_pressure") or None


def gb(n: float | int | None) -> str:
    if not n:
        return "-"
    return f"{n / (1024 ** 3):.1f}GB"


def run_pool(http: Http, model: str, args, logw: LogWindow, report: dict) -> None:
    print("\n=== scenario pool: freed-but-pooled Metal buffers vs the guard ===")
    base = read_pressure(http)
    if base is None:
        report["pool"] = {"error": "/admin/api/stats has no memory_pressure"}
        print("    /admin/api/stats did not answer with memory_pressure; "
              "check --base-url/--api-key admin auth")
        return
    print(f"    start: level={base.get('pressure_level')} "
          f"current={gb(base.get('current_bytes'))} "
          f"soft={gb(base.get('soft_bytes'))} hard={gb(base.get('hard_bytes'))}")

    series: list[dict] = []
    stop_poll = threading.Event()

    def poller():
        while not stop_poll.is_set():
            p = read_pressure(http)
            if p:
                series.append({
                    "t": round(time.monotonic() - t0, 1),
                    "current_gb": round((p.get("current_bytes") or 0) / 2**30, 2),
                    "level": p.get("pressure_level"),
                })
            time.sleep(1.0)

    t0 = time.monotonic()
    th = threading.Thread(target=poller)
    th.start()

    print(f"[1] {args.iters} rounds x {max(1, args.parallel) + max(0, args.queued)} "
          f"concurrent requests (~{args.prefix_tokens} tok prefill + "
          f"{args.decode_tokens} tok decode; {args.parallel} overlap, "
          f"{args.queued} pile up in the queue) ...")
    for r in range(args.iters):
        threads = []
        boxes: list[dict] = []
        n = max(1, args.parallel) + max(0, args.queued)
        for c in range(n):
            box: dict = {}
            boxes.append(box)

            def worker(prompt=long_prompt(args.prefix_tokens, f"pool{r}c{c}"),
                       box=box):
                box.update(http.chat_stream_timed(model, prompt,
                                                  args.decode_tokens))

            t = threading.Thread(target=worker, daemon=True)
            t.start()
            threads.append(t)
            time.sleep(args.stagger_s)   # staggered starts -> overlap + queue
        for t in threads:
            t.join(timeout=1800)
        errs = [b.get("error") for b in boxes if b.get("error")]
        for e in errs:
            print(f"    request refused: {e} (507 here is itself a symptom; "
                  "see the series below)")
            report.setdefault("pool_refusals", []).append({"round": r + 1,
                                                           "error": e})
        p = series[-1] if series else {}
        print(f"    round {r + 1}/{args.iters} done "
              f"(guard sees {p.get('current_gb', '?')}GB, "
              f"level {p.get('level', '?')})")

    print(f"[2] idle {args.idle_s}s to catch delayed transitions ...")
    time.sleep(args.idle_s)
    stop_poll.set()
    th.join(timeout=10)

    window = logw.new_lines()
    trans = [ln for ln in window if "Memory pressure level" in ln]
    enforced = [ln for ln in window
                if re.search(r"unload|evict|Hard memory pressure|admission",
                             ln, re.I)]
    patched_fmt = any("reclaimable_pool=" in ln for ln in trans)
    levels_seen = sorted({s["level"] for s in series if s.get("level")})
    peak = max((s["current_gb"] for s in series), default=0)

    if not trans:
        verdict = (f"guard never left 'ok' (peak footprint {peak}GB, "
                   f"soft {gb(base.get('soft_bytes'))}) - raise "
                   "--parallel/--queued/--prefix-tokens until the peak "
                   "approaches the soft level")
    elif patched_fmt:
        verdict = ("patched format: transitions carry reclaimable_pool=; "
                   f"levels seen {levels_seen}")
    else:
        verdict = (f"unpatched format: level moved to {levels_seen} on the "
                   "TOTAL footprint (pool included)")
    report["pool"] = {
        "baseline": {k: base.get(k) for k in
                     ("pressure_level", "current_bytes", "soft_bytes",
                      "hard_bytes", "ceiling_bytes")},
        "series": series,
        "transitions": trans,
        "enforcement_lines": enforced,
        "patched_log_format": patched_fmt,
        "verdict": verdict,
    }
    print(f"    levels seen: {levels_seen}; peak footprint {peak}GB")
    for ln in trans[-6:]:
        print(f"    log: {ln[:200]}")
    for ln in enforced[-6:]:
        print(f"    log: {ln[:200]}")
    print(f"  verdict: {verdict}")


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def auto_detect() -> tuple[str | None, str | None]:
    for cand in SETTINGS_CANDIDATES:
        p = Path(cand).expanduser()
        if not p.exists():
            continue
        try:
            data = json.loads(p.read_text())
        except Exception:  # noqa: BLE001
            continue
        server = data.get("server") or {}
        auth = data.get("auth") or {}
        port = server.get("port") or (8001 if "dev" in str(p) else 8000)
        host = server.get("host") or "127.0.0.1"
        if host in ("0.0.0.0", "::"):
            host = "127.0.0.1"
        return f"http://{host}:{port}", auth.get("api_key")
    return None, None


def pick_model(http: Http) -> str | None:
    try:
        out = http.call("GET", "/v1/models", timeout=20)
    except Exception:  # noqa: BLE001
        return None
    ids = [m.get("id", "") for m in out.get("data", [])]
    bad = re.compile(r"embed|bge|reranker|stt|asr|whisper|tts|audio|"
                     r"parakeet|dflash|draft", re.I)
    chat = [m for m in ids if not bad.search(m)]

    def params(name: str) -> float:
        m = re.search(r"(\d+(?:\.\d+)?)\s*B", name, re.I)
        return float(m.group(1)) if m else 0.0

    # Largest chat model up to 14B: big enough to show pool pressure on a
    # normal box, small enough to load next to the KV cache.
    fits = [m for m in chat if 0 < params(m) <= 14]
    if fits:
        return max(fits, key=params)
    return chat[0] if chat else (ids[0] if ids else None)


def find_log(explicit: str | None) -> str | None:
    if explicit:
        return explicit
    for cand in LOG_CANDIDATES:
        p = Path(cand).expanduser()
        if p.exists():
            return str(p)
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--base-url")
    ap.add_argument("--api-key")
    ap.add_argument("--model")
    ap.add_argument("--log")
    ap.add_argument("--scenario", choices=["all", "ssd", "pool"], default="all")
    ap.add_argument("--prefix-tokens", type=int, default=8000,
                    help="approx prompt size for prefills (default 8000)")
    ap.add_argument("--iters", type=int, default=3,
                    help="SSD-only passes / pool prefills (default 3)")
    ap.add_argument("--pool-iters", type=int, default=8,
                    help="prefill count for the pool scenario (default 8)")
    ap.add_argument("--idle-s", type=int, default=45,
                    help="idle window after pool prefills (default 45)")
    ap.add_argument("--stream-lead-s", type=float, default=2.0,
                    help="let the decode stream run this long before firing "
                         "the SSD-hit request (default 2)")
    ap.add_argument("--parallel", type=int, default=2,
                    help="requests decoding concurrently (both scenarios; "
                         "default 2)")
    ap.add_argument("--queued", type=int, default=2,
                    help="extra requests piled onto the queue (default 2)")
    ap.add_argument("--decode-tokens", type=int, default=256,
                    help="decode length per pool-scenario request "
                         "(default 256)")
    ap.add_argument("--stagger-s", type=float, default=0.75,
                    help="delay between starting concurrent requests "
                         "(default 0.75)")
    ap.add_argument("--purge", action="store_true",
                    help="run 'purge' (needs root) before each SSD pass so "
                         "the block files are really cold in the OS cache")
    ap.add_argument("--report",
                    default=f"uplift-probe-report-{time.strftime('%Y%m%d-%H%M%S')}.json")
    args = ap.parse_args()

    base, key = auto_detect()
    base = args.base_url or base or "http://127.0.0.1:8000"
    key = args.api_key or key
    http = Http(base, key)
    logw = LogWindow(find_log(args.log))

    print(f"board   : {base}")
    print(f"log     : {logw.path or 'NOT FOUND (measurements only, no log markers)'}")
    if logw.path:
        hist = logw.history_markers()
        print(f"log history: reclaimable_pool lines {hist.get('reclaimable_pool_seen')}, "
              f"SSD prefetch lines {hist.get('ssd_prefetch_seen')} "
              "(earlier runs; the fresh verdict comes from the scenarios)")
    try:
        http.call("GET", "/v1/models", timeout=15)
    except urllib.error.HTTPError as exc:
        print(f"server answered but auth failed ({exc}) - pass --api-key")
        return 2
    except Exception as exc:  # noqa: BLE001
        print(f"cannot reach the board at {base}: {exc}")
        return 2

    model = args.model or pick_model(http)
    if not model:
        print("no model found via /v1/models; pass --model")
        return 2
    print(f"model   : {model}")
    # fail fast on a model that cannot serve (load failure, draft-only ...)
    try:
        http.chat(model, "ping", 1, timeout=600)
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode()[:200]
        except Exception:  # noqa: BLE001
            pass
        print(f"model {model} cannot serve: HTTP {exc.code} {detail}\n"
              "pass a working chat model with --model")
        return 2

    args_iters = args.iters
    args.iters = max(1, args_iters)
    report: dict = {"board": base, "model": model, "log": logw.path,
                    "nonce": NONCE,
                    "started": time.strftime("%Y-%m-%d %H:%M:%S")}

    if args.scenario in ("all", "ssd"):
        try:
            run_ssd(http, model, args, logw, report)
        except Exception as exc:  # noqa: BLE001
            report["ssd"] = {"error": f"{type(exc).__name__}: {exc}"}
            print(f"  ssd scenario crashed: {exc}")

    if args.scenario in ("all", "pool"):
        args.iters = max(1, args.pool_iters)
        try:
            run_pool(http, model, args, logw, report)
        except Exception as exc:  # noqa: BLE001
            report["pool"] = {"error": f"{type(exc).__name__}: {exc}"}
            print(f"  pool scenario crashed: {exc}")

    Path(args.report).write_text(json.dumps(report, indent=2))
    print(f"\nreport written: {Path(args.report).resolve()}")
    print("send that JSON back if you want the numbers checked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
