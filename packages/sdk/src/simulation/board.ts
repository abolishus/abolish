// The simulated board operator (docs/spec/board.md, docs/spec/receipts.md):
// it appends each entry under the board-entry version the definition pins,
// keeps the hash chain and the board tree as it grows, and signs a receipt
// for every ballot submitted through our API, right after appending it. It
// also fixes the run's post-close timing: the counted extent, the tally
// window, the openings' window, the destruction moment and the seal
// (docs/spec/tally.md, docs/spec/challenge.md).
// Every encoding, hash, tree and signature is @abolishus/crypto's; this file
// only keeps the operator's state. The voter's client checks each receipt
// with crypto's `checkReceiptAtCast`, and the board is checked with
// `checkBoard`, and with `verifyBoard` against the checkpoints ./anchor.ts
// anchors (T-23, T-25, T-26).

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
  PARAMETERS,
} from "@abolishus/crypto";

/**
 * The anchoring clock's period: hourly, as P4-1 sets it, from the Unix epoch.
 * A placeholder until the run reads the anchor contract's own clock.
 */
export const SIMULATED_ANCHOR_PERIOD = 3600n;

/**
 * The anchor's deadline: an anchor for period `s` counts if its L1 block is
 * at most this long after the end of `s` (docs/spec/board.md, Timing). A
 * placeholder until the run reads the anchor contract's own clock.
 */
export const SIMULATED_ANCHOR_DEADLINE = 1800n;

/** The anchoring period that L1 time `seconds` falls in. */
export function segmentAt(seconds: bigint): number {
  return Number(seconds / SIMULATED_ANCHOR_PERIOD);
}

/** The L1 time at which period `segment` ends. */
export const endOf = (segment: number) => BigInt(segment + 1) * SIMULATED_ANCHOR_PERIOD;

/** The post-close segments and times the tally and destruction follow (docs/spec/tally.md). */
export interface PostClose {
  /** `s_S`: the counted extent's last segment. */
  readonly counted: number;
  /** `t_S`: when the checkpoint for `s_S` is due, after which trustees combine. */
  readonly tallyFrom: bigint;
  /**
   * The last segment an opening may be boarded in: the anchoring period
   * containing `t_S + OPENING_WINDOW` (docs/spec/challenge.md, Publication).
   */
  readonly openingsUntil: number;
  /** `s_T`: the anchoring period containing `t_S + TALLY_WINDOW`. */
  readonly windowSegment: number;
  /** `t_D`: when a node destroys if the tally hasn't completed. */
  readonly destroyBy: bigint;
  /** The seal: the period containing the destruction window's end. */
  readonly seal: number;
}

/**
 * Tally window and Destruction of docs/spec/tally.md, and the openings'
 * window of docs/spec/challenge.md (Publication), from `closes_at`. The
 * windows that make up `W_S` (delivery, complaints, the contract-event
 * window) and `l1_inclusion_bound` are taken as 0, since nothing here
 * delivers through the contract path, so `s_S` is its floor,
 * `period(closes_at) + 1`; the seal is the destruction window's end, the
 * latest post-close window the run has (SIMULATION_STUBS).
 */
export function postClose(closesAt: bigint): PostClose {
  const counted = segmentAt(closesAt) + 1;
  const tallyFrom = endOf(counted) + SIMULATED_ANCHOR_DEADLINE;
  const tallyEnd = tallyFrom + BigInt(PARAMETERS.TALLY_WINDOW);
  const windowSegment = segmentAt(tallyEnd);
  // The later of the tally window's end and segment s_T − 1's anchoring deadline.
  const lastDeadline = endOf(windowSegment - 1) + SIMULATED_ANCHOR_DEADLINE;
  const destroyBy = tallyEnd > lastDeadline ? tallyEnd : lastDeadline;
  return {
    counted,
    tallyFrom,
    openingsUntil: segmentAt(tallyFrom + BigInt(PARAMETERS.OPENING_WINDOW)),
    windowSegment,
    destroyBy,
    seal: segmentAt(destroyBy + BigInt(PARAMETERS.DESTRUCTION_WINDOW)),
  };
}

/**
 * The segment in which a node that has seen period `segment`'s checkpoint
 * anchored acts: the one holding that checkpoint's deadline (docs/spec/tally.md,
 * Destruction, When).
 */
export function afterAnchored(segment: number): number {
  return segmentAt(endOf(segment) + SIMULATED_ANCHOR_DEADLINE);
}

// The first differing byte decides; a prefix comes first.
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

const id = (s: SubtreeId) => `${s.level}:${s.index}`;

export class SimulatedBoard {
  readonly #electionId: Uint8Array;
  readonly #version: BoardEntryVersion;
  // The operator's one receipt key, from its key service: the definition
  // lists it and the anchoring authority registered it (T-26).
  readonly #receiptSecret: Uint8Array;
  // Every perfect subtree's hash, so roots and audit paths come from
  // O(log n) stored hashes rather than every entry (T-52).
  readonly #subtrees = new Map<string, Uint8Array>();
  #frontier: Uint8Array[] = [];
  #head: Uint8Array = new Uint8Array(32);
  readonly #entries: Uint8Array[] = [];

  /** The receipt key the voter's client pins, as a `p256-key`. */
  readonly receiptKey: Uint8Array;

  /** An operator signing receipts with `receiptSecret`, a P-256 secret key. */
  constructor(electionId: Uint8Array, version: BoardEntryVersion, receiptSecret: Uint8Array) {
    this.#electionId = Uint8Array.from(electionId);
    this.#version = version;
    this.#receiptSecret = Uint8Array.from(receiptSecret);
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

  /**
   * The spoiled-ballot openings the operator held in `segment`, appended
   * when it ends, after every other entry of the segment and in strictly
   * increasing byte order, so an opening's position says nothing about when
   * in the period it was sent (docs/spec/board.md, Spoiled-ballot openings;
   * T-42, T-47). They get no receipt: whether openings do is left open by
   * docs/spec/receipts.md (Signing). Returns their board indices, in
   * the order given.
   */
  boardOpenings(segment: number, payloads: readonly Uint8Array[]): number[] {
    const sorted = [...payloads].sort(compareBytes);
    for (let i = 1; i < sorted.length; i++)
      if (compareBytes(sorted[i - 1] as Uint8Array, sorted[i] as Uint8Array) === 0)
        throw new Error("simulation: one opening held twice in a period");
    const at = new Map(sorted.map((p) => [p, this.board(segment, p)]));
    return payloads.map((p) => at.get(p) as number);
  }

  /**
   * An entry boarded without a submission through our API (a direct ballot,
   * a tally opening, a destruction statement): appended with no receipt.
   */
  board(segment: number, payload: Uint8Array): number {
    return Number(this.#append(segment, payload).index);
  }
}
