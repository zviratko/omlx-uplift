"""Embedding work rate: momentary tok/s for the encoder forward passes.

The reported bug (2026-10-10): the Throughput chart shows nothing for
embedding traffic. Not a pipeline break — a coverage gap. Both chart
lines are fed by hooks on the LLM engine-core path
(``PrefillProgressTracker`` chunks, ``Request.num_output_tokens`` rows);
embedding models run on ``MLXEmbeddingModel`` instead — one encoder
forward per batch, no scheduler, no tracker, no Request rows. Vanilla's
``record_request_complete`` DOES count them (``rate.prompt_tokens_s``
moves), but the honest momentary lines never see the work.

Source: ``MLXEmbeddingModel._embed_batch`` returns
``(embeddings_array, batch_tokens)`` where batch_tokens is the sum of the
attention mask — the EXACT token count of that one computed batch
(pad-free, same accounting as the response's usage field). instrument.
install_embed_hooks() wraps it and credits each finished batch on the
collector's clock, so a multi-batch request distributes its work over
the seconds it actually took.

Fallback for the eager non-custom path (the common mlx-embeddings case):
``_embed_batch`` returns ``None`` there — the count only exists at
request level, where omlx re-counts with the tokenizer
(``embed()`` -> ``_count_tokens``). The wrapper therefore also tracks
``MLXEmbeddingModel.embed`` calls per THREAD (the whole batch loop runs
on one MLX-executor thread, so thread-local pairing is exact even with
concurrent requests): at request end, if the request's usage total
exceeds what its batches already credited, the shortfall is credited
once. Total credit per request == its usage.prompt_tokens, no
double-count either way.

Crediting rules mirror decode_sampler/prefill_sampler (tests/
test_embed_sampler.py):
* the monotonic total is drained per CHANNEL ('tick' persists, 'fast'
  displays) with a per-channel (ts, total) baseline — a fast drain can
  never steal tokens from the stored 5 s window;
* the first drain of a channel opens the window with zero (seeding,
  same birth doctrine);
* zeros are ALWAYS written — an idle engine is a data point, and a
  skipped key truncates the series exactly when embedding stops;
* garbage/negative counts are ignored, never credited, never raised
  into the serving path;
* a request that RAISES mid-way keeps the batches it already credited
  (real computed work) and loses only the unknown-count tail — bounded,
  honest, documented.

Stored series: ``embedding.tokens_s`` — encoder-computed tokens/s per
collector tick. No hourly rollup exists upstream that isolates embedding
tokens (the usage rollup mixes them into prompt_tokens), so long windows
honestly start at install day — same doctrine as prefill.tokens_s.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

KEY_EMBEDDING_TOKENS = "embedding.tokens_s"
EMBED_KEY_PREFIX = "embedding."


class EmbedSampler:
    """Accumulator: finished embedding batches in, per-tick tok/s out.

    ``note_batch`` runs on the MLX-executor thread(s); ``drain`` runs on
    the collector/fast-sampler threads. One lock, no I/O, O(1) per event.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        # Monotonic total of credited tokens (every channel drains from
        # this same total through its own baseline).
        self._credited = 0.0
        self._bases: dict[str, tuple[float, float]] = {}

    # ---- engine-thread events -------------------------------------------

    def credit(self, tokens: float) -> None:
        """Add computed tokens to the monotonic total. Guarded: a
        non-numeric, non-positive or NaN value credits nothing
        (NaN <= 0 is False — compare the other way or it poisons the
        total and every later drain)."""
        try:
            n = float(tokens)
        except (TypeError, ValueError):
            return
        if not n > 0:
            return
        with self._lock:
            self._credited += n

    # ---- collector / fast-sampler threads --------------------------------

    def drain(self, *, now: float,
              channel: str = "tick") -> dict[str, float]:
        """One drain of ``channel``: tokens credited since THIS channel's
        last drain / dt. Zero always written; dt <= 0 keeps the baseline
        for the next drain (never a fake spike). Same multi-channel rule
        as decode_sampler.drain — the two paths cover different spans and
        can never steal from each other."""
        with self._lock:
            base = self._bases.get(channel)
            total = self._credited
            if base is None:
                self._bases[channel] = (now, total)
                return {KEY_EMBEDDING_TOKENS: 0.0}
            b_ts, b_total = base
            dt = now - b_ts
            if dt <= 0:
                return {KEY_EMBEDDING_TOKENS: 0.0}
            toks = total - b_total
            self._bases[channel] = (now, total)
        return {KEY_EMBEDDING_TOKENS: toks / dt}


_sampler: Optional[EmbedSampler] = None
_sampler_lock = threading.Lock()


def get_embed_sampler() -> EmbedSampler:
    global _sampler
    with _sampler_lock:
        if _sampler is None:
            _sampler = EmbedSampler()
        return _sampler


# ---- per-request pairing (thread-local) ---------------------------------
# The whole MLXEmbeddingModel.embed() loop runs on ONE executor thread, so
# a thread-local request frame pairs embed() with exactly ITS batches —
# concurrent requests on other threads never mix. None entries are the
# unknown-count (eager non-custom) batches.

_tls = threading.local()


def begin_request() -> None:
    """embed() entry: open this thread's batch-token frame."""
    _tls.frame = []


def note_batch(tokens: Optional[int]) -> None:
    """One finished _embed_batch: credit an exact count now; remember the
    frame slot when the count is unknown (None) for the end-of-request
    shortfall pass. Outside a tracked request still credits an exact
    count — real computed work is never dropped on a pairing miss."""
    known = None
    try:
        n = int(tokens or 0)
        if n > 0:
            known = n
    except (TypeError, ValueError):
        pass
    frame = getattr(_tls, "frame", None)
    if frame is not None:
        frame.append(known)
    if known is not None:
        get_embed_sampler().credit(known)


def end_request(total_tokens: Optional[int]) -> None:
    """embed() exit with the request's usage-level token total: credit
    the part the batch path could not (unknown-count batches). The
    shortfall is by definition the remainder of THIS request's work —
    exact totals survive even a mixed known/unknown batch run.

    NO frame = no pairing context (begin_request never ran on this
    thread): credit NOTHING — those batches may already have been
    credited by the frameless path above, and a blind total would
    double-count. The whole loss is bounded to the unknown tail."""
    frame = getattr(_tls, "frame", None)
    _tls.frame = None
    if frame is None:
        return
    try:
        total = int(total_tokens or 0)
    except (TypeError, ValueError):
        return
    if total <= 0:
        return
    credited = sum(x for x in frame if x)
    rest = total - credited
    if rest > 0:
        get_embed_sampler().credit(rest)
