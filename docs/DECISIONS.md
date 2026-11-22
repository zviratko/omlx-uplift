# Decisions

Owner decisions that later sessions must respect. A change is a NEW row that names
the old one.

| ID | Date | Decision | Reason |
|---|---|---|---|
| D1 | 2026-11-22 | memory-budget-admission never rejects a request itself: at `OMLX_ADMISSION_MAX_QUEUE_S` a held request is released and the vanilla admission checks decide. | Bottom line must be vanilla behavior. Asking vanilla earlier is not possible: its check only sees memory in use now, which is the blind spot the budget fixes. |
| D2 | 2026-11-22 | Commits carry no attribution footer. | Owner choice when the default footer did not match the model in use. |
| D3 | 2026-11-22 | A curated patch that has an upstream PR links it (`github_pr`); bug fixes go to the `default` tier, features and experiments to `optional`. | Catalog rule in `curated_patches/README.md`; the drift check retires a linked patch when the PR merges. |
| D4 | 2026-11-22 | memory-budget-admission stays in the `optional` tier until the owner has run with it; then a DRAFT upstream PR. | Not yet tested per architecture (dense, sliding-window). |
