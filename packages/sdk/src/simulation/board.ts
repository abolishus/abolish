// The simulated board operator (docs/spec/board.md, docs/spec/receipts.md):
// it appends each entry under the board-entry version the definition pins,
// keeps the hash chain and the board tree as it grows, and signs a receipt
// for every ballot submitted through our API, right after appending it.
// Every encoding, hash, tree and signature is @abolishus/crypto's; this file
// only keeps the operator's state. The voter's client checks each receipt
// with crypto's `checkReceiptAtCast` and the verifier checks the board with
// `checkBoard` (T-23, T-25, T-26).

import {
  appendSubtrees,
  BOARD_TREE,
  boardEntryHash,
  type BoardEntryVersion,
  chainLink,
  encodeBoardEntry,
  foldSubtrees,
  identityKey,
  inclusionProofSubtrees,
  type Receipt,
  rootSubtrees,
  signReceipt,
  type SubtreeId,
  type UnsignedReceipt,
} from "@abolishus/crypto";

/**
 * The anchoring clock's period: hourly, as P4-1 sets it, from the Unix epoch.
 * A placeholder until the run reads the anchor contract's own clock.
 */
export const SIMULATED_ANCHOR_PERIOD = 3600n;

/**
 * The seal, as periods after the one holding `closes_at`: a placeholder for
 * the latest end of the post-close windows (docs/spec/election-definition.md,
 * The seal), which a version-1 definition doesn't carry.
 */
export const SIMULATED_SEAL_PERIODS = 24;

/** The anchoring period that L1 time `seconds` falls in. */
export function segmentAt(seconds: bigint): number {
  return Number(seconds / SIMULATED_ANCHOR_PERIOD);
}

const id = (s: SubtreeId) => `${s.level}:${s.index}`;

export class SimulatedBoard {
  readonly #electionId: Uint8Array;
  readonly #version: BoardEntryVersion;
  // One receipt key, fresh per run: no definition lists it and no registry
  // holds it (SIMULATION_STUBS).
  readonly #receiptSecret = crypto.getRandomValues(new Uint8Array(32));
  // Every perfect subtree's hash, so roots and audit paths come from
  // O(log n) stored hashes rather than every entry (T-52).
  readonly #subtrees = new Map<string, Uint8Array>();
  #frontier: Uint8Array[] = [];
  #head: Uint8Array = new Uint8Array(32);
  readonly #entries: Uint8Array[] = [];

  /** The receipt key the voter's client pins, as a `p256-key`. */
  readonly receiptKey: Uint8Array;

  constructor(electionId: Uint8Array, version: BoardEntryVersion) {
    this.#electionId = Uint8Array.from(electionId);
    this.#version = version;
    this.receiptKey = identityKey(this.#receiptSecret);
  }

  /** The board's entries, encoded, in index order. */
  get entries(): readonly Uint8Array[] {
    return this.#entries;
  }

  /** The chain head after the last entry: 32 zero bytes for an empty board. */
  get head(): Uint8Array {
    return Uint8Array.from(this.#head);
  }

  #hash(s: SubtreeId): Uint8Array {
    const h = this.#subtrees.get(id(s));
    // Every subtree a root or path folds is complete, so it was stored.
    if (h === undefined) throw new Error("simulation: a board subtree wasn't stored");
    return h;
  }

  // Appends one entry and returns what a receipt for it states.
  #append(segment: number, payload: Uint8Array): UnsignedReceipt {
    const index = this.#entries.length;
    const entry = encodeBoardEntry(
      { election_id: this.#electionId, index: BigInt(index), segment, payload },
      this.#version,
    );
    const entryHash = boardEntryHash(entry);
    for (const s of appendSubtrees(BOARD_TREE, this.#frontier, index, entryHash))
      this.#subtrees.set(id(s), s.hash);
    const size = index + 1;
    this.#frontier = rootSubtrees(size).map((s) => this.#hash(s));
    this.#head = chainLink(this.#head, entryHash);
    this.#entries.push(entry);
    return {
      election_id: this.#electionId,
      index: BigInt(index),
      segment,
      entry_hash: entryHash,
      link: this.#head,
      root: foldSubtrees(BOARD_TREE, this.#frontier),
      inclusion: inclusionProofSubtrees(index, size).map((ids) =>
        foldSubtrees(
          BOARD_TREE,
          ids.map((s) => this.#hash(s)),
        ),
      ),
    };
  }

  /** A submission through our API: appended, then answered with a signed receipt. */
  submit(segment: number, payload: Uint8Array): Receipt {
    return signReceipt(this.#receiptSecret, this.#append(segment, payload));
  }

  /** A ballot delivered without our API: appended with no receipt. */
  board(segment: number, payload: Uint8Array): number {
    return Number(this.#append(segment, payload).index);
  }
}
