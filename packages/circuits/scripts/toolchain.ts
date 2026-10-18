// The pinned bb, by absolute path. @aztec/bb.js links a `bb` of its own into
// node_modules/.bin (a shim over a native binary inside its npm tarball), and
// package scripts put that directory first on PATH, so a bare `bb` would run
// it. The build and tests must run the bb install-toolchain.sh pins by
// sha256 (T-55), so this looks bb up on PATH past every node_modules/.bin.

import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";

function onPath(name: string): string {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    // A relative entry would hand execFileSync a bare name, which searches
    // PATH again and can find the shim.
    if (!isAbsolute(dir) || dir.split(sep).includes("node_modules")) continue;
    const file = join(dir, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // not in this directory
    }
  }
  throw new Error(`${name} is not on PATH outside node_modules: run install-toolchain.sh`);
}

export const BB = onPath("bb");
