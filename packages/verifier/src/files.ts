// Reads a bundle directory (docs/spec/verifier.md, Bundle): bundle.json and
// the board copy, as board.bin or as blocks.car to read it from by CID. Every
// input is a local file here; the only requests the verifier sends are for
// blocks, to gateways its caller names, and what they answer is checked
// against its CID (T-49, T-24).

import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readBlockStore } from "./blocks.ts";
import { type Bundle, BundleError, parseBundle } from "./bundle.ts";
import type { Gateways } from "./gateways.ts";
import { readBoardByCid } from "./verify.ts";

/**
 * The byte budget for a copy read by CID when the caller sets none: 1 GiB.
 * The anchoring authority chooses how large a run's object may be, so the
 * reader's budget is the only bound on what it holds (T-52).
 */
export const DEFAULT_MAX_BOARD_BYTES = 2 ** 30;

function read(dir: string, name: string): Uint8Array {
  let fd: number;
  try {
    // Non-blocking, so opening a FIFO can't wait forever for a writer.
    fd = openSync(join(dir, name), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    // A missing or unreadable file rejects the bundle: it is no evidence
    // about any election, so it must never read as a short copy.
    throw new BundleError(`${name}: can't be read`, { cause: e });
  }
  try {
    // Only a regular file has an end: a device (/dev/zero) or a FIFO would
    // keep a run from ever finishing. Checked on the open file, so it can't
    // be swapped after the check.
    if (!fstatSync(fd).isFile()) throw new BundleError(`${name}: not a regular file`);
    return readFileSync(fd);
  } catch (e) {
    if (e instanceof BundleError) throw e;
    throw new BundleError(`${name}: can't be read`, { cause: e });
  } finally {
    closeSync(fd);
  }
}

export function json(dir: string, name = "bundle.json"): string {
  const raw = read(dir, name);
  try {
    // fatal: invalid UTF-8 rejects the bundle instead of being replaced with
    // U+FFFD; ignoreBOM: a byte-order mark is kept, so JSON.parse rejects it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    throw new BundleError(`${name}: not UTF-8`);
  }
}

// Whether `name` exists in `dir` as anything at all, a dangling link
// included: a directory holding both copies is ambiguous, whichever is
// readable.
function present(dir: string, name: string): boolean {
  try {
    lstatSync(join(dir, name));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new BundleError(`${name}: can't be read`, { cause: e });
  }
}

/**
 * Reads and parses the bundle in `dir`, whose board copy is board.bin.
 * Throws `BundleError` if it doesn't follow the spec, or holds blocks.car.
 */
export function readBundle(dir: string): Bundle {
  if (present(dir, "blocks.car"))
    throw new BundleError("blocks.car: a bundle holds board.bin or blocks.car, not both");
  return parseBundle(json(dir), read(dir, "board.bin"));
}

/**
 * Reads the bundle in `dir` with its board copy: board.bin as it is, or a
 * copy read by CID within `maxBytes` (docs/spec/verifier.md, Board by CID)
 * from blocks.car where the bundle holds it instead, from `gateways`, or from
 * both, blocks.car asked first. A bundle with neither file needs gateways.
 * Throws `BundleError` if the bundle doesn't follow the spec, or holds
 * board.bin while gateways are given: that copy would never be read by CID.
 */
export async function loadBundle(
  dir: string,
  maxBytes: number = DEFAULT_MAX_BOARD_BYTES,
  gateways?: Gateways,
): Promise<Bundle> {
  const car = present(dir, "blocks.car");
  if (!car && gateways === undefined) return readBundle(dir);
  if (present(dir, "board.bin"))
    throw new BundleError(
      car
        ? "blocks.car: a bundle holds board.bin or blocks.car, not both"
        : "board.bin: a bundle read from gateways holds no board.bin",
    );
  const bundle = parseBundle(json(dir), new Uint8Array());
  const store = car ? readBlockStore(read(dir, "blocks.car")) : undefined;
  return readBoardByCid(bundle, store, maxBytes, gateways);
}
