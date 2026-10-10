"""EMBED-1 acceptance: the embedding work sampler.

The bug: embedding models run on MLXEmbeddingModel — no scheduler, no
prefill tracker — so neither generation.tokens_s nor prefill.tokens_s
ever saw encoder forwards (live proof: 23 304 prompt tokens in 11.5 s,
chart lines flat 0). The fix: instrument credits embed_sampler per
batch (exact attention-mask counts) with a per-request shortfall pass
for the eager non-custom path; the collector drains embedding.tokens_s.

These tests exercise the sampler and the pairing helpers directly (the
wrappers are thin and fully guarded, same split as
test_prefill_sampler.py).
"""
import threading

import pytest

from omlx_uplift.embed_sampler import (KEY_EMBEDDING_TOKENS, EmbedSampler,
                                       begin_request, end_request,
                                       note_batch)


def _drain(s, now, channel="tick"):
    return s.drain(now=now, channel=channel)[KEY_EMBEDDING_TOKENS]


# ---- accumulator core (mirror of the decode/prefill doctrine) -----------

def test_first_drain_opens_the_window_with_zero():
    s = EmbedSampler()
    assert _drain(s, 100.0) == 0.0            # seeding: never a retro dump
    s.credit(2500)
    assert _drain(s, 105.0) == pytest.approx(500.0)
    assert _drain(s, 110.0) == 0.0            # idle = a real zero, written


def test_zero_always_written_and_key_present():
    s = EmbedSampler()
    _drain(s, 100.0)
    out = s.drain(now=105.0)
    assert KEY_EMBEDDING_TOKENS in out        # skipping the key truncates
    assert out[KEY_EMBEDDING_TOKENS] == 0.0   # the series at idle (doctrine)


def test_garbage_credits_nothing():
    s = EmbedSampler()
    _drain(s, 100.0)
    for junk in (None, "", "x", -5, 0, [], float("nan")):
        s.credit(junk)
    assert _drain(s, 105.0) == 0.0


def test_nonpositive_dt_keeps_the_baseline():
    s = EmbedSampler()
    _drain(s, 100.0)
    s.credit(1000)
    assert _drain(s, 100.0) == 0.0            # dt = 0: no fake spike
    assert _drain(s, 105.0) == pytest.approx(1000 / 5.0)


def test_channels_never_steal_from_each_other():
    """FAST-1 multi-channel rule: a fast drain must not shorten the
    stored window. A/B proof: tick-only vs tick+9-fast drains store the
    same value (same test shape as test_mtp_sampler)."""
    a, b = EmbedSampler(), EmbedSampler()
    for s in (a, b):
        s.drain(now=100.0)                   # seed tick (+ fast for b)
    b.drain(now=100.0, channel="fast")
    for i in range(1, 11):
        a.credit(300)
        b.credit(300)
        if i < 10:
            b.drain(now=100.0 + i * 0.5, channel="fast")
    assert _drain(a, 105.0) == _drain(b, 105.0)
    # and the fast drain divided by ITS OWN dt (0.5 s window, 300 tok):
    f = EmbedSampler()
    f.drain(now=100.0, channel="fast")
    f.credit(150)
    assert _drain(f, 100.5, channel="fast") == pytest.approx(300.0)


# ---- pairing helpers (thread-local request frames) -----------------------

def test_exact_batch_credits_flow_to_singleton_without_a_frame():
    """A batch finished outside a tracked embed() call (install-order
    edge, future caller) still credits: real computed work is never
    dropped on a pairing miss."""
    from omlx_uplift import embed_sampler as es
    s = es.EmbedSampler()
    es._sampler = s                           # seam: isolated singleton
    try:
        s.drain(now=100.0)                    # open the window first
        es.note_batch(1200)                   # no begin_request() first
        assert _drain(s, 106.0) == pytest.approx(200.0)
    finally:
        es._sampler = None


def test_shortfall_pass_covers_unknown_batches_exactly_once():
    """The eager non-custom path: every _embed_batch reports None, the
    request-level total is the only count — credited once at end."""
    from omlx_uplift import embed_sampler as es
    s = es.EmbedSampler()
    es._sampler = s
    try:
        s.drain(now=100.0)                    # seed (credits nothing)
        begin_request()
        note_batch(None)                      # unknown-count batch 1
        note_batch(None)                      # unknown-count batch 2
        end_request(3000)                     # usage-level total
        assert _drain(s, 105.0) == pytest.approx(600.0)
        assert _drain(s, 106.0) == 0.0        # never re-credited
    finally:
        es._sampler = None


def test_mixed_known_and_unknown_credits_no_double_count():
    from omlx_uplift import embed_sampler as es
    s = es.EmbedSampler()
    es._sampler = s
    try:
        s.drain(now=100.0)
        begin_request()
        note_batch(700)                       # exact batch -> credited now
        note_batch(None)                      # eager batch -> unknown
        end_request(1000)                     # usage total: 300 short
        note_batch(500)                       # next request, exact
        end_request(500)                      # its own total: nothing left
        assert _drain(s, 105.0) == pytest.approx((700 + 300 + 500) / 5.0)
    finally:
        es._sampler = None


def test_end_without_frame_credits_nothing():
    """begin_request never ran on this thread (wrap-order drift): the
    total may already sit in batch credits — a blind credit doubles."""
    from omlx_uplift import embed_sampler as es
    s = es.EmbedSampler()
    es._sampler = s
    try:
        s.drain(now=100.0)
        end_request(9999)                     # no frame -> ignored
        end_request(0)
        assert _drain(s, 105.0) == 0.0
    finally:
        es._sampler = None


def test_frames_are_thread_local_under_concurrency():
    """Two embed() calls on two executor threads must not mix frames."""
    from omlx_uplift import embed_sampler as es
    s = es.EmbedSampler()
    es._sampler = s
    s.drain(now=100.0)                        # seed on the main thread
    barrier = threading.Barrier(2)
    try:
        def worker(total):
            begin_request()
            barrier.wait()                    # both inside their requests
            note_batch(total // 2)
            barrier.wait()
            end_request(total)                # shortfall = total//2 each
        t1 = threading.Thread(target=worker, args=(1000,))
        t2 = threading.Thread(target=worker, args=(3000,))
        t1.start(); t2.start(); t1.join(); t2.join()
        # exact (500 + 1500) + shortfalls (500 + 1500) = 4000 tokens,
        # all inside the 1 s window opened by the seed
        assert _drain(s, 101.0) == pytest.approx(4000.0)
    finally:
        es._sampler = None
