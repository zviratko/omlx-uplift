#!/usr/bin/env python3
"""U68: expand the uplift suites their harness names map to into LEAF
subtask counts, printed as one JSON line. Runs in bench-env (lm_eval is
only importable there); spawned by harness_engine.subtask_counts() with a
short timeout, NEVER at import, results cached on disk.

Why: lm_eval's --limit applies PER TASK (verified against 0.4.13 help
text), so a community user picking 'MMLU 30' on the harness engine
actually evaluates 57 subjects x 30 = 1710 requests. The UI must show
that multiplication honestly instead of hiding it.
"""
import json
import sys


def leaf_count(obj):
    # load_task_or_group returns {group|task: {nested...} | instance}
    if not isinstance(obj, dict):
        return 1
    if any(hasattr(k, "group") for k in obj.keys()):   # nested groups
        return sum(leaf_count(v) for v in obj.values())
    return len(obj)   # flat dict: task name -> instance


def main() -> int:
    from lm_eval.tasks import TaskManager
    suites = json.loads(sys.argv[1])      # {suite_key: [harness task names]}
    tm = TaskManager(verbosity="error")
    out = {}
    for key, names in suites.items():
        total = 0
        for n in names:
            try:
                obj = tm.load_task_or_group(n)
                for _name, val in obj.items():
                    total += leaf_count(val) if isinstance(val, dict) else 1
            except Exception:
                total = 0
                break
        if total:
            out[key] = total
    print("UPLIFT_SIZES " + json.dumps(out), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
