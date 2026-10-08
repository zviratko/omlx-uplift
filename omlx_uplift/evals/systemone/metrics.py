"""REPL-4c: pure metrics for the System-1 decision bench.

No omlx imports — every function is testable (and CI-safe) standalone.
All probability inputs are the endpoint's round-4 values; noul answers
are p(true) in [0,1]; choice answers carry per-option probabilities.

Definitions used (stated so the UI number cannot be read as something
else):
- accuracy   : chosen option text == gold option text.
- brier      : mean squared error of the DERIVED noul legs
               (gold proposition -> y=1, distractor -> y=0).
               Range [0,1], lower is better.
- ece        : expected calibration error, 10 equal-width buckets of p,
               weighted |mean(p) - accuracy-in-bucket|. Lower is better.
               Computed on the same noul legs as brier.
- agreement  : choice re-asked with permuted option order picks the same
               TEXT both times (position-bias rate = 1 - agreement).
"""
from __future__ import annotations

from typing import Iterable, Optional

ECE_BINS = 10


def accuracy(correct: int, total: int) -> Optional[float]:
    return round(correct / total, 4) if total else None


def brier(pairs: Iterable[tuple[float, int]]) -> Optional[float]:
    """pairs: (predicted_prob_of_true, gold 0/1)."""
    vals = [p for p, _ in pairs]
    if not vals:
        return None
    return round(sum((p - y) ** 2 for p, y in pairs) / len(vals), 4)


def ece(pairs: Iterable[tuple[float, int]], bins: int = ECE_BINS) -> Optional[float]:
    data = list(pairs)
    if not data:
        return None
    total = len(data)
    acc = 0.0
    for lo_bin in range(bins):
        lo = lo_bin / bins
        hi = (lo_bin + 1) / bins
        bucket = [d for d in data
                  if (lo <= d[0] < hi) or (lo_bin == bins - 1 and d[0] == 1.0)]
        if not bucket:
            continue
        conf = sum(p for p, _ in bucket) / len(bucket)
        acc += (len(bucket) / total) * abs(conf - sum(y for _, y in bucket) / len(bucket))
    return round(acc, 4)


def agreement_rate(first: Optional[str], second: Optional[str]) -> Optional[bool]:
    """None when either leg is missing (item did not get both answers)."""
    if first is None or second is None:
        return None
    return first == second
