#!/usr/bin/env python3
"""Fire sized fresh prompts at a live omlx board and record memory and admission.

Dev tool for the memory-budget-admission curated patch (see
curated_patches/optional/memory-budget-admission.md). Reads port and key from
~/.omlx-dev/settings.json, logs from ~/.omlx-dev/logs/server.log, appends one JSON
line per run to measure.jsonl next to this script's working directory.

example: probe-admission.py --tokens 150000 150000 2000 --max-tokens 64 64 16 \
             --n 3 --at 0 1 30 --label hold-test

usage: measure.py --tokens 100000 --n 2 [--stagger 0] [--max-tokens 16] [--label x]
Watchdog: closes every client stream (server aborts the requests) if the board's
memory goes over --abort-gb or system free memory drops under --min-free-pct.
"""
import argparse, json, os, random, re, subprocess, threading, time, urllib.request

D = os.getcwd()
S = json.load(open(os.path.expanduser("~/.omlx-dev/settings.json")))
BASE = f"http://127.0.0.1:{S['server']['port']}"
KEY = S["auth"]["api_key"]
LOG = os.path.expanduser("~/.omlx-dev/logs/server.log")
SYLL = ("ta ne ki ro mu sen vi dl a tr po ke li zn ga fe ti bo ru sha kle mon vii "
        "zeta qua").split()


def prompt(tokens, seed):
    rng = random.Random(seed)
    words = int(tokens / 1.08)          # measured: ~1.08 tok/word for this filler
    return (f"Corpus {seed}. " + " ".join(rng.choice(SYLL) for _ in range(words))
            + " Summarize the corpus in one word.")


def req(path, body=None, timeout=30, headers=None):
    r = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(),
                               method="GET" if body is None else "POST")
    r.add_header("Content-Type", "application/json")
    r.add_header("Authorization", f"Bearer {KEY}")
    for k, v in (headers or {}).items():
        r.add_header(k, v)
    return urllib.request.urlopen(r, timeout=timeout)


def stats():
    try:
        with req("/admin/api/stats", timeout=10) as r:
            s = json.loads(r.read())
        mp = (s.get("active_models") or {}).get("memory_pressure") or s.get("memory_pressure") or {}
        return mp
    except Exception:
        return {}


def free_pct():
    out = subprocess.run(["memory_pressure"], capture_output=True, text=True).stdout
    m = re.search(r"free percentage: (\d+)%", out)
    return int(m.group(1)) if m else 100


STOP_AFTER = 0


def stream(i, text, max_tokens, rec, live, model):
    rec.update(t_start=time.monotonic(), stamps=[])
    try:
        resp = req("/v1/chat/completions", {
            "model": model, "messages": [{"role": "user", "content": text}],
            "max_tokens": max_tokens, "temperature": 0, "stream": True,
            "stream_options": {"include_usage": True}},
            timeout=1800, headers={"X-oMLX-Cache-Store": "off"})
    except Exception as exc:
        body = ""
        try:
            body = exc.read().decode()[:300]
        except Exception:
            pass
        rec.update(error=f"{type(exc).__name__}: {exc} {body}", t_end=time.monotonic())
        return
    live[i] = resp
    try:
        for line in resp:
            if not line.startswith(b"data: "):
                continue
            pl = line[6:].strip()
            if pl == b"[DONE]":
                break
            try:
                ch = json.loads(pl)
            except Exception:
                continue
            if ch.get("error"):
                rec["error"] = json.dumps(ch["error"])[:300]
            if ch.get("usage"):
                rec["usage"] = ch["usage"]
            dl = (ch.get("choices") or [{}])[0].get("delta") or {}
            if dl.get("content") or dl.get("reasoning_content"):
                rec["stamps"].append(time.monotonic())
                if STOP_AFTER and len(rec["stamps"]) >= STOP_AFTER:
                    rec["client_cut"] = True
                    break
    except Exception as exc:
        rec.setdefault("error", f"stream {type(exc).__name__}: {exc}")
    rec["t_end"] = time.monotonic()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tokens", type=int, nargs="+", default=[100000])
    ap.add_argument("--n", type=int, default=2)
    ap.add_argument("--stagger", type=float, default=0.0)
    ap.add_argument("--at", type=float, nargs="+", help="fire time (s) per request")
    ap.add_argument("--max-tokens", type=int, nargs="+", default=[16])
    ap.add_argument("--abort-gb", type=float, default=116.0)
    ap.add_argument("--min-free-pct", type=int, default=8)
    ap.add_argument("--model", default="Qwen3.8-Flash-Next")
    ap.add_argument("--label", default="run")
    ap.add_argument("--stop-after", type=int, default=0,
                    help="close each stream after N tokens (client-side abort)")
    a = ap.parse_args()
    global STOP_AFTER
    STOP_AFTER = a.stop_after
    sizes = (a.tokens * a.n)[: a.n] if len(a.tokens) < a.n else a.tokens[: a.n]
    maxtoks = (a.max_tokens + [a.max_tokens[-1]] * a.n)[: a.n]
    try:
        with req("/v1/chat/completions", {"model": a.model, "messages": [
                {"role": "user", "content": "ping"}], "max_tokens": 1}, timeout=900) as r:
            r.read()
    except Exception as exc:
        print("warm ping failed:", exc)
    seed0 = int(time.time())
    texts = [prompt(t, seed0 + i) for i, t in enumerate(sizes)]
    logoff = os.path.getsize(LOG)
    t0 = time.monotonic()
    recs = [{} for _ in sizes]
    live = {}
    series, stop, aborted = [], threading.Event(), {}

    def watch():
        while not stop.is_set():
            mp = stats()
            fp = free_pct()
            cur = (mp.get("current_bytes") or 0) / 2**30
            series.append((round(time.monotonic() - t0, 1), round(cur, 1), mp.get("pressure_level"), fp))
            if cur > a.abort_gb or fp < a.min_free_pct:
                aborted.update(t=round(time.monotonic() - t0, 1), cur_gb=round(cur, 1), free_pct=fp)
                for r in list(live.values()):
                    try:
                        r.close()
                    except Exception:
                        pass
                stop.set()
                return
            time.sleep(1)

    w = threading.Thread(target=watch, daemon=True); w.start()
    ths = []
    for i, txt in enumerate(texts):
        if a.at:
            time.sleep(max(0.0, t0 + a.at[i] - time.monotonic()))
        t = threading.Thread(target=stream, args=(i, txt, maxtoks[i], recs[i], live, a.model), daemon=True)
        t.start(); ths.append(t)
        if not a.at:
            time.sleep(a.stagger)
    for t in ths:
        t.join(1800)
    time.sleep(2)
    stop.set(); w.join(5)
    with open(LOG, errors="replace") as fh:
        fh.seek(logoff)
        lines = [l for l in fh.read().splitlines() if l.startswith("20") and " - TRACE - " not in l]
    budget = [l for l in lines if "dmission budget" in l or "Preflight" in l
              or "rejected" in l]
    keep = [l for l in lines if "[fairness]" not in l and re.search(
        r"reject|Paused|pause|guard|pressure level|requeue|evict|stall|Preflight|admission|"
        r"Admission|Memory|ERROR|WARNING|prefill.*(complete|done)|Prefill", l)]
    res = {"label": a.label, "sizes": sizes, "aborted": aborted,
           "peak_board_gb": max((s[1] for s in series), default=None),
           "min_free_pct": min((s[3] for s in series), default=None),
           "levels": sorted({s[2] for s in series if s[2]}), "reqs": []}
    for i, r in enumerate(recs):
        u = r.get("usage") or {}
        res["reqs"].append({
            "i": i, "tokens_req": sizes[i], "prompt_tokens": u.get("prompt_tokens"),
            "fired_s": round(r.get("t_start", t0) - t0, 1),
            "completion_tokens": u.get("completion_tokens"), "tokens_seen": len(r.get("stamps", [])),
            "ttft_s": round(r["stamps"][0] - r["t_start"], 1) if r.get("stamps") else None,
            "end_s": round(r.get("t_end", t0) - t0, 1), "error": r.get("error"),
            "prompt_tps": u.get("prompt_tokens_per_second")})
    with open(f"{D}/measure.jsonl", "a") as fh:
        fh.write(json.dumps({**res, "series": series, "budget_log": budget,
                             "log": keep[-200:]}) + "\n")
    print(json.dumps(res, indent=1))
    print("--- log (filtered, last 40) ---")
    for l in keep[-15:]:
        print(l[11:260])
    print("--- budget / preflight lines ---")
    for l in budget[-40:]:
        print(l[11:400])


if __name__ == "__main__":
    main()
