// Reads a bundle directory (docs/spec/verifier.md, Bundle): bundle.json and
// board.bin. The verifier contacts nothing: every input is a local file here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Bundle, BundleError, parseBundle } from "./bundle.ts";

/** Reads and parses the bundle in `dir`. Throws `BundleError` if it doesn't follow the spec. */
export function readBundle(dir: string): Bundle {
  let json: string;
  try {
    // fatal: invalid UTF-8 rejects the bundle instead of being replaced with U+FFFD.
    json = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(join(dir, "bundle.json")));
  } catch (e) {
    if (e instanceof TypeError) throw new BundleError("bundle.json: not UTF-8");
    throw e;
  }
  return parseBundle(json, readFileSync(join(dir, "board.bin")));
}
