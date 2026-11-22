# 0002 At most N large prefills at a time

## Request
Keep the board interactive with more slots: memory-budget-admission is memory-safe with more slots, but large requests can still take every slot. Option discussed: at most N (for example 1-2) prefills above a token threshold, so a slot stays free for small requests.

## Done when
- A knob with a default that keeps current behavior, unit tests, and a live check: with 3 slots and 3 large requests, a small request gets a first token while the large ones run.

## Result
