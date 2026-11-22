# 0005 Enforcer re-arms the memory requeue every second during a store

## Request
During a long requeue store the enforcer logged "Hard memory pressure: storing and requeueing 2 request(s)" every second (160 times in one run), because the pending flag is cleared at the start of the store and the enforcer sets it again. Minor; check whether it can also trigger a second requeue right after the first.

## Done when
- Behavior understood; if harmful, an upstream fix or a comment on jundot/omlx#5542.

## Result
