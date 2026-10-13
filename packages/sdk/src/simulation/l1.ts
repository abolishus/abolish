// A simulated L1 chain for the re-vote rule (docs/spec/revoting.md): a block
// every 12 seconds from the Unix epoch, every one finalized, each with a
// random 32-byte hash drawn when first read. A ballot names a block by its
// number and hash, which the verifier's admission check (5.8) compares with
// the chain, so a hash nobody could know before the block holds as it does on
// Ethereum (T-45). A block a client saw and named can be reorganised away
// before it is finalized: the client then holds a hash the finalized chain
// doesn't have (`orphan`).

import type { FinalizedL1, FinalizedL1Block } from "@abolishus/crypto";

/** Ethereum's slot time: one block every 12 seconds. */
const SLOT = 12n;

/** How deep a block is before a client names it (docs/spec/revoting.md, Client rule 2). */
const DEPTH = 2n;

/**
 * How long after its timestamp a block is finalized: two epochs of 32 slots,
 * when Casper FFG finalizes it on a healthy chain. A client checks its
 * ballot's block then (Client rule 4).
 */
export const SIMULATED_FINALITY = 64n * SLOT;

/** The newest block at least `DEPTH` deep at `seconds` (Client rule 2). */
export function settledAt(seconds: bigint): bigint {
  const newest = seconds / SLOT;
  return newest > DEPTH ? newest - DEPTH : 0n;
}

/**
 * The block a client names for a ballot made at `seconds`: the newest
 * settled one (Client rule 2), strictly newer than `before`, the newest it
 * named for the same election and tier, if any (Client rule 3). With none
 * yet, the client waits until the next block is settled and names that; the
 * close rule that would refuse a wait past close isn't simulated (P1-18).
 */
export function nameBlock(seconds: bigint, before: bigint | undefined): bigint {
  const settled = settledAt(seconds);
  return before !== undefined && settled <= before ? before + 1n : settled;
}

/** When block `n` is finalized, and its client checks the hash it named (Client rule 4). */
export function finalizedAt(n: bigint): bigint {
  return n * SLOT + SIMULATED_FINALITY;
}

/** The newest block finalized at `seconds`: the latest finalized block a client knows then. */
export function latestFinalized(seconds: bigint): bigint {
  return seconds < SIMULATED_FINALITY ? 0n : (seconds - SIMULATED_FINALITY) / SLOT;
}

export class SimulatedL1 {
  readonly #hashes = new Map<bigint, Uint8Array>();

  block(n: bigint): FinalizedL1Block {
    let hash = this.#hashes.get(n);
    if (hash === undefined) {
      hash = crypto.getRandomValues(new Uint8Array(32));
      this.#hashes.set(n, hash);
    }
    return { hash: Uint8Array.from(hash), timestamp: n * SLOT };
  }

  /**
   * The hash of a block numbered `n` that a client saw at its depth and that
   * was then reorganised away: never the finalized block's hash.
   */
  orphan(n: bigint): Uint8Array {
    const canonical = this.block(n).hash;
    for (;;) {
      const hash = crypto.getRandomValues(new Uint8Array(32));
      if (hash.some((x, i) => x !== canonical[i])) return hash;
    }
  }

  /** The first block whose timestamp is later than `seconds`: a verifier's head past close. */
  firstAfter(seconds: bigint): bigint {
    return seconds / SLOT + 1n;
  }

  /** The chain as finalized up to `head`. */
  finalized(head: bigint): FinalizedL1 {
    return { head, block: (n) => this.block(n) };
  }
}
