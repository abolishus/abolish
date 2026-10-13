// A simulated L1 chain for the re-vote rule (docs/spec/revoting.md): a block
// every 12 seconds from the Unix epoch, every one finalized, each with a
// random 32-byte hash drawn when first read. A ballot names a block by its
// number and hash, which the verifier's admission check (5.8) compares with
// the chain, so a hash nobody could know before the block holds as it does on
// Ethereum (T-45).

import type { FinalizedL1, FinalizedL1Block } from "@abolishus/crypto";

/** Ethereum's slot time: one block every 12 seconds. */
export const SIMULATED_L1_SLOT = 12n;

/** How deep a block is before a client names it (docs/spec/revoting.md, Client rule 2). */
const DEPTH = 2n;

export class SimulatedL1 {
  readonly #hashes = new Map<bigint, Uint8Array>();

  block(n: bigint): FinalizedL1Block {
    let hash = this.#hashes.get(n);
    if (hash === undefined) {
      hash = crypto.getRandomValues(new Uint8Array(32));
      this.#hashes.set(n, hash);
    }
    return { hash: Uint8Array.from(hash), timestamp: n * SIMULATED_L1_SLOT };
  }

  /** The newest block at least `DEPTH` deep at `seconds` (Client rule 2). */
  settledAt(seconds: bigint): bigint {
    const newest = seconds / SIMULATED_L1_SLOT;
    return newest > DEPTH ? newest - DEPTH : 0n;
  }

  /** The first block whose timestamp is later than `seconds`: a verifier's head past close. */
  firstAfter(seconds: bigint): bigint {
    return seconds / SIMULATED_L1_SLOT + 1n;
  }

  /** The chain as finalized up to `head`. */
  finalized(head: bigint): FinalizedL1 {
    return { head, block: (n) => this.block(n) };
  }
}
