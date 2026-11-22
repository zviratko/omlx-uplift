# 0003 Prompt throughput falls with more than 2 concurrent prefills

## Request
Measured: with 4 concurrent long prefills, decode fairness cut prefill chunks from 8192 to 1216 tokens; total prompt throughput was about 920 tok/s against 1282 with 2 requests and 1097 with one. Find out why and whether the fairness rule should scale with the number of prefills.

## Done when
- Root cause shown with logs; a fix or a documented reason why not; before/after numbers on the same hardware and model.

## Result
