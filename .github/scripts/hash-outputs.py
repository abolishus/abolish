"""Print "<sha256>  <path>" for every build output file, sorted, for reproducibility checks.

Build outputs are the dist/, .output/ and out/ directories of each workspace
package (apps/*, packages/*, tools/*). Paths are repo-relative so manifests from
different checkout locations compare equal.
"""

import hashlib
from pathlib import Path

OUTPUT_DIRS = ("dist", ".output", "out", "target")
rows = []
for group in ("apps", "packages", "tools"):
    root = Path(group)
    if not root.is_dir():
        continue
    for pkg in sorted(p for p in root.iterdir() if (p / "package.json").is_file()):
        for name in OUTPUT_DIRS:
            out = pkg / name
            if not out.is_dir():
                continue
            for f in sorted(out.rglob("*")):
                if f.is_file():
                    rows.append(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  {f.as_posix()}")
print("\n".join(sorted(rows, key=lambda r: r.split("  ", 1)[1])))
