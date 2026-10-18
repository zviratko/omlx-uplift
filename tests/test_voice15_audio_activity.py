"""VOICE-15 acceptance: audio-engine activity on the dashboard.

The bug: the status card's busy signal exists only for batched LLM/VLM
schedulers — STT/TTS/STS engines take no pool lease and own no scheduler,
so transcribing or synthesizing looked Idle (the classic web page's
"realtime transcription" text is a client-side label, never server truth).

The fix (audio_activity.py): in-memory wraps of the engines' work methods
(same doctrine as instrument.py), a busy registry keyed by ENGINE IDENTITY,
a peek of vanilla's STTEngine._realtime_active for sessions, and a
merge_stats pass wired into BOTH stats tiers.
"""
import asyncio
import sys
import types

import pytest

from omlx_uplift import audio_activity
from omlx_uplift.audio_activity import AudioRegistry


# --------------------------------------------------------------------------
# stub the audio engines (sys.modules injection: the test also runs on
# machines without omlx, and never wraps the REAL classes here)
# --------------------------------------------------------------------------

def _mk_stt(reg_events):
    class STTEngine:
        def __init__(self, model_name):
            self.model_name = model_name
            self._realtime_active = False

        async def transcribe(self, path):
            reg_events.append(("stt-in", self.registry.count()))
            await asyncio.sleep(0)
            return {"text": "ok"}

        async def transcribe_stream(self, path):
            reg_events.append(("stream-in", self.registry.count()))
            for i in range(3):
                await asyncio.sleep(0)
                yield f"chunk{i}"

        async def create_realtime_session(self):
            self._realtime_active = True

        registry = None      # bound by the fixture

    return STTEngine


def _mk_tts(reg_events):
    class TTSEngine:
        def __init__(self, model_name):
            self.model_name = model_name

        async def synthesize(self, text):
            reg_events.append(("tts-in", self.registry.count()))
            await asyncio.sleep(0)
            return b"RIFF"

        registry = None

    return TTSEngine


def _mk_sts(reg_events):
    class STSEngine:
        def __init__(self, model_name):
            self.model_name = model_name

        async def process(self, path):
            reg_events.append(("sts-in", self.registry.count()))
            return b"pcm"

        registry = None

    return STSEngine


@pytest.fixture()
def stubs(monkeypatch):
    events = []
    reg = AudioRegistry()
    monkeypatch.setattr(audio_activity, "_registry", reg)
    audio_activity.reset_for_tests()

    stt, tts, sts = _mk_stt(events), _mk_tts(events), _mk_sts(events)
    stt.registry, tts.registry = reg, reg
    sts.registry = reg
    pkgs = {}
    for name in ("omlx", "omlx.engine", "omlx.engine.stt", "omlx.engine.tts",
                 "omlx.engine.sts"):
        pkgs[name] = types.ModuleType(name)
    pkgs["omlx.engine.stt"].STTEngine = stt
    pkgs["omlx.engine.tts"].TTSEngine = tts
    pkgs["omlx.engine.sts"].STSEngine = sts
    for name, mod in pkgs.items():
        monkeypatch.setitem(sys.modules, name, mod)
    audio_activity.install()
    yield types.SimpleNamespace(reg=reg, events=events, STTEngine=stt,
                                TTSEngine=tts, STSEngine=sts)
    audio_activity.reset_for_tests()


# --------------------------------------------------------------------------
# wraps: the registry lights for exactly the call's lifetime
# --------------------------------------------------------------------------

def test_transcribe_counts_busy_for_the_call_and_clears(stubs):
    eng = stubs.STTEngine("whisper-x")
    assert stubs.reg.count() == 0
    asyncio.run(eng.transcribe("a.wav"))
    # the stub samples the registry WHILE executing (stt-in event):
    assert stubs.events == [("stt-in", 1)]      # counted mid-call
    assert stubs.reg.count() == 0               # cleared on return


def test_exception_still_clears(stubs):
    """The finally in the wrap must end the entry even when the engine
    raises — a leaked row would pin Idle=false forever."""
    eng = stubs.STTEngine("whisper-x")

    async def boom(self, path):
        raise RuntimeError("decode died")

    wrapped = audio_activity._wrap_async(boom, "stt")

    async def run():
        with pytest.raises(RuntimeError):
            await wrapped(eng, "a.wav")

    asyncio.run(run())
    assert stubs.reg.count() == 0


def test_stream_abort_clears(stubs):
    eng = stubs.STTEngine("whisper-x")

    async def run():
        agen = eng.transcribe_stream("a.wav")
        first = await agen.__anext__()
        mid = stubs.reg.count()
        await agen.aclose()            # client abort = GeneratorExit
        return first, mid, stubs.reg.count()

    first, mid, after = asyncio.run(run())
    assert first == "chunk0"
    assert mid == 1 and after == 0     # abort must not leak a phantom row


def test_tts_and_sts_wrap(stubs):
    t = stubs.TTSEngine("kokoro")
    s = stubs.STSEngine("deepf")

    async def run():
        await t.synthesize("hi")
        seen_t = stubs.events[-1]
        await s.process("a.wav")
        return seen_t, stubs.events[-1]

    tt, st = asyncio.run(run())
    assert tt == ("tts-in", 1)         # counted during synthesize
    assert st == ("sts-in", 1)


def test_install_is_idempotent(stubs):
    audio_activity.install()
    eng = stubs.STTEngine("whisper-x")

    async def run():
        await eng.transcribe("a.wav")
        return len(stubs.events)

    n = asyncio.run(run())
    # one wrapped call = ONE event; a double-wrap would report count 2
    assert n == 1 and stubs.events == [("stt-in", 1)]

# --------------------------------------------------------------------------
# merge_stats: attribution, bumps, copy discipline
# --------------------------------------------------------------------------

class _Entry:
    def __init__(self, engine):
        self.engine = engine


class _Pool:
    def __init__(self, entries):
        self._entries = entries


def _payload(*rows):
    return {"active_models": {
        "models": [dict(r) for r in rows],
        "total_active_requests": sum(r.get("active_requests", 0) for r in rows),
    }}


def _row(mid, active=0):
    return {"id": mid, "active_requests": active, "loaded": True}


def _merge_with(monkeypatch, reg, pool):
    monkeypatch.setattr(audio_activity, "_registry", reg)
    monkeypatch.setattr(audio_activity, "_pool", lambda: pool)
    return lambda p: audio_activity.merge_stats(p)


def test_busy_engine_lands_on_its_own_row(monkeypatch, stubs):
    whisper = stubs.STTEngine("whisper-x")
    other = _row("qwen-llm")
    pool = _Pool({"whisper-large-q4": _Entry(whisper), "qwen-llm": _Entry(None)})
    reg = AudioRegistry()
    merge = _merge_with(monkeypatch, reg, pool)

    tok = reg.begin("stt", whisper)
    out = merge(_payload(_row("whisper-large-q4"), other))
    reg.end(tok)

    row = out["active_models"]["models"][0]
    assert row["audio"] == [{"kind": "stt", "count": 1,
                             "elapsed": pytest.approx(0.0, abs=1.0)}]
    assert row["active_requests"] == 1          # header 'Active' state rides it
    assert out["active_models"]["total_active_requests"] == 1
    assert out["active_models"]["models"][1].get("audio") is None
    assert "audio" not in out["active_models"]["models"][1]


def test_input_payload_never_mutated(monkeypatch, stubs):
    whisper = stubs.STTEngine("whisper-x")
    pool = _Pool({"whisper-x": _Entry(whisper)})
    reg = AudioRegistry()
    payload = _payload(_row("whisper-x"))
    row0 = payload["active_models"]["models"][0]
    tok = reg.begin("stt", whisper)
    out = _merge_with(monkeypatch, reg, pool)(payload)
    reg.end(tok)
    assert "audio" not in row0                  # original row untouched
    assert payload["active_models"]["models"][0] is row0
    assert out["active_models"] is not payload["active_models"]


def test_realtime_flag_merges_without_wrap(monkeypatch, stubs):
    eng = stubs.STTEngine("whisper-x")
    eng._realtime_active = True
    pool = _Pool({"whisper-x": _Entry(eng)})
    reg = AudioRegistry()                       # empty: sessions are NOT wrapped
    out = _merge_with(monkeypatch, reg, pool)(_payload(_row("whisper-x")))
    row = out["active_models"]["models"][0]
    assert row["audio"] == [{"kind": "realtime", "count": 1, "elapsed": None}]


def test_single_row_fallback_for_unmatched_engine(monkeypatch, stubs):
    eng = stubs.STTEngine("whisper-x")
    pool = _Pool({})                            # engine not (yet) in the pool map
    reg = AudioRegistry()
    tok = reg.begin("stt", eng)
    out = _merge_with(monkeypatch, reg, pool)(_payload(_row("whisper-x")))
    reg.end(tok)
    assert out["active_models"]["models"][0]["audio"][0]["kind"] == "stt"


def test_unattributed_activity_stays_quiet(monkeypatch, stubs):
    eng = stubs.STTEngine("ghost-model")
    pool = _Pool({})
    reg = AudioRegistry()
    tok = reg.begin("stt", eng)
    out = _merge_with(monkeypatch, reg, pool)(
        _payload(_row("qwen-llm"), _row("llama")))
    reg.end(tok)
    for r in out["active_models"]["models"]:
        assert "audio" not in r                 # never guess across models


def test_merge_noop_shapes(monkeypatch):
    reg = AudioRegistry()
    monkeypatch.setattr(audio_activity, "_registry", reg)
    monkeypatch.setattr(audio_activity, "_pool", lambda: None)
    assert audio_activity.merge_stats(None) is None
    p = {"active_models": {"models": "not-a-list"}}
    assert audio_activity.merge_stats(p) is p
    assert "active_models" in audio_activity.merge_stats({"active_models": None})


def test_registry_groups_and_stale(monkeypatch):
    reg = AudioRegistry()

    class E:
        model_name = "m"

    e = E()
    t1 = reg.begin("stt", e)
    t2 = reg.begin("stt", e)
    snap = reg.snapshot()
    assert len(snap) == 1 and snap[0]["count"] == 2
    reg.end(t1)
    reg.end(t2)
    assert reg.snapshot() == []
    # stale-entry guard: a leaked token must not pin a row forever
    t3 = reg.begin("stt", e)
    reg._busy[0].started -= reg.STALE_S + 1
    assert reg.snapshot() == []


# --------------------------------------------------------------------------
# stats_feed wiring: BOTH tiers merge (fast tick reuses the slow cache)
# --------------------------------------------------------------------------

def test_stats_feed_merges_on_fast_and_full_ticks(monkeypatch):
    from omlx_uplift import stats_feed

    calls = []

    def fake_merge(p):
        calls.append(1)
        return {**p, "merged": len(calls)}

    monkeypatch.setattr(stats_feed, "_merge_audio", fake_merge)
    feed = stats_feed.StatsFeed(
        stats_builder=lambda: {"x": 1, "active_models": {"models": []}},
        stats_fast_builder=lambda: {"y": 2, "active_models": {"models": []}},
        alltime_builder=lambda: 0, tick_s=0.01)
    assert feed.tick_once(full=True) is True
    assert feed.snapshot_now()["s"]["merged"] == 1
    assert feed.tick_once(full=False) is True    # audio moves on the fast tier
    assert feed.snapshot_now()["s"]["merged"] == 2
    feed.stop()
