---
scope: omlx
---
# Live-apply max concurrent requests

Makes the scheduler setting `max_concurrent_requests` take effect
immediately when saved in Server Settings — no restart and no model
unload. The admission cap, the waiting-queue bound and the pressure-gate
regrowth all pick up the new value on the next admission tick.

Source: upstream PR jundot/omlx#3765 (kept as an uplift patch while the
PR is unmerged; auto-marked obsolete once upstream ships it).
