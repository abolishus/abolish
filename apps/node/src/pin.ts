// Fetch and pin (docs/status/P4-5.md, part 2): every board segment object and
// entry-hash list the board anchor's checkpoints name on L1, fetched by CID
// and written to the directory `serve` mirrors, one CARv1 per object named by
// its CID. What is pinned is exactly what L1 names: the checkpoints are proven
// in L1 state (src/l1.ts), and each object is read with `packages/crypto`'s
// bounded reader, which hashes every block against its CID, so no gateway can
// make the node hold bytes of its choosing (T-24, T-49, T-51). Nothing here
// judges the board: that is the verifier's (part 3), which authenticates every
// byte against the anchored heads and roots.

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AsyncBlockSource,
  type Checkpoint,
  checkpointHash,
  cidText,
  MAX_BOARD_PAYLOAD,
  objectCar,
  objectCid,
  readObjectWithinAsync,
} from "@abolishus/crypto";
import { L1Error, type L1Header } from "@abolishus/verifier";
import { bytesToHex } from "@noble/hashes/utils.js";
import { loggedCheckpoints, provenCheckpoints } from "./l1.ts";
import { type Rpc, RpcError } from "./rpc.ts";
import type { Mirror } from "./store.ts";

// An entry is its 51 fixed bytes and a payload of at most `MAX_BOARD_PAYLOAD`
// (docs/spec/verifier.md, Bundle), so a run of `n` entries encodes in at most
// `n · ENTRY_MAX` bytes, and its entry-hash list is exactly `n · 32`.
const ENTRY_MAX = 51n + BigInt(MAX_BOARD_PAYLOAD);
const ENTRY_HASH = 32n;

/** The default byte budget for one election's objects: 1 GiB, as the verifier's. */
export const DEFAULT_MAX_ELECTION_BYTES = 2 ** 30;

/** How the objects one checkpoint names came out. */
export type ObjectOutcome =
  /** Written to the directory. */
  | "pinned"
  /** Already in the directory, as written. */
  | "held"
  /** No source served some block of it. */
  | "unavailable"
  /** Its CID names no canonical object within its bound: the anchoring authority's. */
  | "inconsistent"
  /** Within its bound, but past what is left of the election's budget. */
  | "over-budget";

export type PinReport =
  | {
      readonly election: string;
      readonly checkpoints: number;
      /** Logged checkpoints whose hash the anchor doesn't hold: never pinned. */
      readonly unproven: number;
    }
  | { readonly election: string; readonly error: string }
  | {
      readonly election: string;
      readonly segment: number;
      readonly kind: "object" | "hashes";
      readonly cid: string;
      readonly outcome: ObjectOutcome;
      readonly bytes?: number;
    };

export interface PinOptions {
  readonly rpc: Rpc;
  readonly anchor: Uint8Array;
  /** Where blocks come from: the directory's mirror first, then gateways. */
  readonly blocks: AsyncBlockSource;
  readonly dir: string;
  /** The first L1 block whose logs are read: the anchor's deployment, or 0. */
  readonly fromBlock: bigint;
  readonly maxElectionBytes: number;
  readonly report: (r: PinReport) => void;
}

/** What one run read from L1: how many logs it refused. */
export interface PinRun {
  readonly refusedLogs: number;
}

/**
 * The directory's mirror, then `gateways`: a block the directory holds costs
 * no request and tells no gateway anything (T-11).
 */
export function mirrorThen(mirror: Mirror, gateways: AsyncBlockSource): AsyncBlockSource {
  return async (cid, limit) => {
    const held = await mirror.block(cid);
    return held !== undefined && held.length <= limit ? [held] : gateways(cid, limit);
  };
}

const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/**
 * Writes `object`'s CAR to `dir` as `<cid>.car`, unless the file already
 * holds exactly those bytes; through a temporary file and a rename, so
 * `serve` never reads half a file. Throws unless `cid` is the object's own,
 * so no file is ever named for other bytes than it holds (T-51).
 */
export async function pinObject(
  dir: string,
  cid: Uint8Array,
  object: Uint8Array,
): Promise<"pinned" | "held"> {
  if (!same(objectCid(object), cid)) throw new Error("an object whose CID isn't the one named");
  const car = objectCar(object);
  const path = join(dir, `${cidText(cid)}.car`);
  try {
    if (same(await readFile(path), car)) return "held";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // A name of its own, so two runs sharing the directory never write one file.
  const temporary = `${path}.${randomUUID()}.partial`;
  await writeFile(temporary, car);
  await rename(temporary, path);
  return "pinned";
}

/**
 * One run: the finalized L1 block, every `CheckpointAnchored` log up to it,
 * and, election by election, the checkpoints the anchor holds and the
 * objects they name. Each election and each object is reported as it is
 * done. An election whose checkpoints can't be proven (its L1 error, or an
 * answer that can't be read) is reported and skipped; an object that can't
 * be read is reported and the next one tried. Throws only if the logs can't
 * be read (`RpcError`) or the directory can't be written.
 */
export async function pinElections(header: L1Header, options: PinOptions): Promise<PinRun> {
  const { rpc, anchor, blocks, dir, maxElectionBytes, report } = options;
  if (!Number.isSafeInteger(maxElectionBytes) || maxElectionBytes < 1)
    throw new RangeError("maxElectionBytes must be a positive integer");
  const logged = await loggedCheckpoints(rpc, anchor, header, options.fromBlock);
  for (const [election, checkpoints] of logged.elections) {
    let proven: Checkpoint[];
    try {
      ({ checkpoints: proven } = await provenCheckpoints(rpc, anchor, header, checkpoints));
    } catch (e) {
      // One election's proofs failing (a proof missing, a rate limit, a
      // timeout) leaves the others to try.
      if (!(e instanceof L1Error) && !(e instanceof RpcError)) throw e;
      report({ election, error: e.message });
      continue;
    }
    // Distinct checkpoints, so a node repeating a log inflates nothing.
    const distinct = new Set(checkpoints.map((c) => bytesToHex(checkpointHash(c)))).size;
    report({ election, checkpoints: proven.length, unproven: distinct - proven.length });
    // A checkpoint of size `n_i` covers the entries after the next smaller
    // size, so its objects are bounded by that run's count; checkpoints of
    // one size name one run.
    const sizes = [...new Set(proven.map((c) => c.size))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const runOf = new Map(sizes.map((size, i) => [size, size - (sizes[i - 1] ?? 0n)]));
    const done = new Set<string>();
    let spent = 0;
    for (const c of proven) {
      const count = runOf.get(c.size) as bigint;
      for (const [kind, cid, bound] of [
        ["object", c.object_cid, count * ENTRY_MAX],
        ["hashes", c.hashes_cid, count * ENTRY_HASH],
      ] as const) {
        const key = bytesToHex(cid);
        if (done.has(key)) continue;
        done.add(key);
        const left = BigInt(maxElectionBytes - spent);
        const base = { election, segment: c.segment, kind, cid: cidText(cid) };
        if (left === 0n) {
          report({ ...base, outcome: "over-budget" });
          continue;
        }
        const read = await readObjectWithinAsync(cid, Number(bound < left ? bound : left), blocks);
        if (!read.ok) {
          const outcome =
            read.reason !== "over-bound"
              ? read.reason
              : BigInt(read.length) > bound
                ? "inconsistent"
                : "over-budget";
          report({ ...base, outcome });
          continue;
        }
        // The bounded reader accepts only the canonical DAG, so the object's
        // own CAR has this root; `pinObject` checks it, so nothing else is
        // ever written.
        spent += read.bytes.length;
        report({
          ...base,
          outcome: await pinObject(dir, cid, read.bytes),
          bytes: read.bytes.length,
        });
      }
    }
  }
  return { refusedLogs: logged.refused };
}
