"""Aggregate gate: fail unless every needed job succeeded or was skipped as unaffected.

Usage: NEEDS='${{ toJSON(needs) }}' python3 require-jobs.py <job-that-must-run> ...
"""

import json
import os
import sys

needs = json.loads(os.environ["NEEDS"])
must_run = set(sys.argv[1:])
failed = {}
for job, info in sorted(needs.items()):
    result = info["result"]
    print(f"{job}: {result}")
    allowed = ("success",) if job in must_run else ("success", "skipped")
    if result not in allowed:
        failed[job] = result
if failed:
    print(f"::error::jobs did not pass: {failed}")
    sys.exit(1)
