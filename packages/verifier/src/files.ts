// Reads a bundle directory (docs/spec/verifier.md, Bundle): bundle.json and
// board.bin. The verifier contacts nothing: every input is a local file here.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Bundle, BundleError, parseBundle } from "./bundle.ts";

function read(dir: string, name: string): Uint8Array {
  try {
    return readFileSync(join(dir, name));
  } catch (e) {
    // A missing or unreadable file rejects the bundle: it is no evidence
    // about any election, so it must never read as a short copy.
    throw new BundleError(`${name}: can't be read`, { cause: e });
  }
}

/** Reads and parses the bundle in `dir`. Throws `BundleError` if it doesn't follow the spec. */
export function readBundle(dir: string): Bundle {
  const raw = read(dir, "bundle.json");
  const board = read(dir, "board.bin");
  let json: string;
  try {
    // fatal: invalid UTF-8 rejects the bundle instead of being replaced with
    // U+FFFD; ignoreBOM: a byte-order mark is kept, so JSON.parse rejects it.
    json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new BundleError("bundle.json: not UTF-8");
  }
  return parseBundle(json, board);
}
