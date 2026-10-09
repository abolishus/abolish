"""Print "<sha256>  <path>" for every file the build produced, sorted, for reproducibility checks.

Total by construction, so the check can't silently compare nothing:

- Every untracked or ignored file in the checkout is hashed (outside
  node_modules), wherever the build wrote it. There is no allowlist of output
  directories to fall out of date.
- Every workspace package with a `build` script must declare its outputs in
  package.json as `"abolish": {"buildOutputs": ["dist", ...]}`: directories
  relative to the package, or `[]` for a build that only type-checks. A missing
  declaration, or a declared directory that is absent or empty after the build,
  fails the job, naming the package.

Paths are repo-relative, so manifests from different checkout locations compare
equal. Run from the repository root after the build; exits 1 on any violation.
"""

import hashlib
import json
import subprocess
import sys
from pathlib import Path

WORKSPACE_GROUPS = ("apps", "packages", "tools", ".github/tools")

errors = []
for group in WORKSPACE_GROUPS:
    root = Path(group)
    if not root.is_dir():
        continue
    for manifest in sorted(root.glob("*/package.json")):
        pkg = json.loads(manifest.read_text(encoding="utf-8"))
        if "build" not in pkg.get("scripts", {}):
            continue
        outputs = pkg.get("abolish", {}).get("buildOutputs")
        if not isinstance(outputs, list) or not all(isinstance(o, str) for o in outputs):
            errors.append(f"{manifest}: has a build script but no abolish.buildOutputs list")
            continue
        for out in outputs:
            out_dir = manifest.parent / out
            if ".." in Path(out).parts or not out_dir.is_dir() or not any(p.is_file() for p in out_dir.rglob("*")):
                errors.append(f"{manifest}: declared build output {out!r} is missing or empty after the build")

status = subprocess.run(
    ["git", "status", "--porcelain=v1", "-z", "--ignored", "--untracked-files=all"],
    check=True,
    capture_output=True,
).stdout.decode("utf-8")
rows = []
for entry in filter(None, status.split("\0")):
    code, path = entry[:2], entry[3:]
    if code not in ("??", "!!"):
        continue
    if "node_modules" in Path(path).parts:
        continue
    f = Path(path)
    if f.is_file():
        rows.append(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.as_posix()}")

for e in errors:
    print(f"::error::{e}", file=sys.stderr)
print("\n".join(sorted(rows, key=lambda r: r.split("  ", 1)[1])))
sys.exit(1 if errors else 0)
