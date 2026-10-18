// What the seat serves (docs/spec/availability.md, What a seat does, 4): the
// operator's directory of CAR files as read at start, and every object the
// availability duty pinned since, each written there by `apps/node`'s
// `pinObject` so it outlives the process, and served at once by the same
// trustless-gateway server `apps/node` runs. Every block served hashes to its
// CID, so a reader trusts the seat for availability only (T-49, T-51).

import { type AsyncBlockSource, CHUNK_SIZE, objectCar } from "@abolishus/crypto";
import { type Mirror, openMirror, pinObject } from "@abolishus/node";
import { readBlockStore } from "@abolishus/verifier";

/** The seat's mirror, which also takes the objects it pins. */
export interface ServedBlocks extends Mirror {
  /** Writes `object` under `cid` to the directory and serves it from then on; throws if it can't be written. */
  readonly pin: (cid: Uint8Array, object: Uint8Array) => Promise<"pinned" | "held">;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * The mirror of `dir` (`openMirror`'s, so its reports and its errors), and
 * what is pinned into it later. Each object pinned is held in memory whole,
 * as each file read at start is. Throws only if `dir` can't be listed.
 */
export async function servedBlocks(dir: string): Promise<ServedBlocks> {
  const mirror = await openMirror(dir);
  const pinned = new Map<string, AsyncBlockSource>();
  return {
    files: mirror.files,
    block: async (cid) => {
      const held = await mirror.block(cid);
      if (held !== undefined) return held;
      for (const source of pinned.values()) {
        const [found] = await source(cid, CHUNK_SIZE);
        if (found !== undefined) return found;
      }
      return undefined;
    },
    pin: async (cid, object) => {
      const outcome = await pinObject(dir, cid, object);
      // Served from memory even when the file was there already: the file
      // read at start may not have been this one.
      if (!pinned.has(hex(cid))) pinned.set(hex(cid), readBlockStore(objectCar(object)).source);
      return outcome;
    },
  };
}
