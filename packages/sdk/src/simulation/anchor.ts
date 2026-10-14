// The simulated anchoring authority (docs/spec/board.md, Segments and
// checkpoints, Anchoring and Timing): once a period has ended, it anchors the
// checkpoint after it, from the operator's board, in the first simulated L1
// block after the period's end, for every period that added entries and for
// the seal even when it added none. Each checkpoint, CIDs included, is
// @abolishus/crypto's `copyCheckpoints` over the board's bytes, and whoever
// reads the anchors judges them with crypto's `verifyBoard`, as the verifier's
// 4.1 and 4.2 do (T-23, T-24, T-49). The same authority keeps the anchor's
// receipt-key record (docs/spec/contracts.md, Board anchor, Receipt keys):
// it registers the board operator's receipt key a day before the election
// opens, so the key judges the election ([[election-definition]], Receipt
// keys; T-26, T-69). The contract, its clock and the authority's key are
// simulated: anchors and the record live in memory, and only the verifier's
// bundle puts them in an L1 state, a simulated one (SIMULATION_STUBS).

import { type Anchor, type AnchorClock, copyCheckpoints } from "@abolishus/crypto";
import { endOf, SIMULATED_ANCHOR_DEADLINE, SIMULATED_ANCHOR_PERIOD } from "./board.ts";
import type { SimulatedL1 } from "./l1.ts";

/**
 * How long before `opens_at` the authority registers a receipt key: a day,
 * as docs/spec/election-definition.md (Receipt keys) advises, since a
 * registration counts only if its L1 time is before `opens_at`.
 */
export const SIMULATED_RECEIPT_KEY_LEAD = 86_400n;

const U64 = 1n << 64n;

/** A record's 32-byte word: `registered_at` in its low 64 bits, `retired_at` in the next 64. */
export function receiptKeyWord(registeredAt: bigint, retiredAt: bigint): Uint8Array {
  if (registeredAt < 0n || registeredAt >= U64 || retiredAt < 0n || retiredAt >= U64)
    throw new RangeError("simulation: receipt-key times are u64");
  const word = new Uint8Array(32);
  for (let i = 31, x = (retiredAt << 64n) | registeredAt; x > 0n; i--, x >>= 8n)
    word[i] = Number(x & 0xffn);
  return word;
}

/** The anchoring clock of an election whose seal is `seal`: hourly from the Unix epoch. */
export function anchorClock(seal: number): AnchorClock {
  return {
    epoch: 0n,
    period: SIMULATED_ANCHOR_PERIOD,
    deadline: SIMULATED_ANCHOR_DEADLINE,
    lastSegment: seal,
  };
}

export class SimulatedAnchor {
  readonly #electionId: Uint8Array;
  readonly #l1: SimulatedL1;
  readonly #anchors: Anchor[] = [];
  // Keyed by the key's last 32 bytes, so a key and its twin (the other
  // prefix, its negation) share one entry, as the contract refuses both.
  readonly #receiptKeys = new Map<string, { readonly key: Uint8Array; readonly at: bigint }>();
  /** The last period anchored or passed over. */
  #through: number;

  readonly clock: AnchorClock;

  /**
   * An authority for the election whose board starts in period `first` and
   * is sealed at `seal`. Nothing is anchored before `first`: no reader looks
   * at anchors for earlier periods (docs/spec/contracts.md, Board anchor,
   * Verification).
   */
  constructor(electionId: Uint8Array, first: number, seal: number, l1: SimulatedL1) {
    if (!Number.isSafeInteger(first) || first < 0 || first > seal)
      throw new RangeError("simulation: the first period must be from 0 to the seal");
    this.#electionId = Uint8Array.from(electionId);
    this.clock = anchorClock(seal);
    this.#through = first - 1;
    this.#l1 = l1;
  }

  /**
   * Every anchor made, in L1 order. A reader passes them all to
   * `verifyBoard` with the time of the newest finalized block it has read,
   * which counts only those in blocks up to it (docs/spec/board.md, Board
   * checks, step 1).
   */
  get anchors(): readonly Anchor[] {
    return this.#anchors;
  }

  /**
   * Registers `key` (a `p256-key`) in the receipt-key record, in the first
   * L1 block after `at`, which writes that block's timestamp as its
   * `registered_at`. The record is append-only: a key, or its twin, is
   * registered at most once. Nothing here retires one (SIMULATION_STUBS).
   */
  registerReceiptKey(key: Uint8Array, at: bigint): void {
    if (key.length !== 33 || (key[0] !== 0x02 && key[0] !== 0x03))
      throw new RangeError("simulation: a receipt key is 33 bytes starting 0x02 or 0x03");
    const x = Array.from(key.subarray(1), (b) => b.toString(16).padStart(2, "0")).join("");
    if (this.#receiptKeys.has(x)) throw new Error("simulation: a receipt key registered twice");
    this.#receiptKeys.set(x, {
      key: Uint8Array.from(key),
      at: this.#l1.block(this.#l1.firstAfter(at)).timestamp,
    });
  }

  /**
   * Every registered key with the word the record holds for it at an L1
   * block whose timestamp is `provenAt`: a key registered later is absent
   * there, so it isn't listed.
   */
  receiptKeysAt(
    provenAt: bigint,
  ): readonly { readonly key: Uint8Array; readonly word: Uint8Array }[] {
    return [...this.#receiptKeys.values()]
      .filter((r) => r.at <= provenAt)
      .map((r) => ({ key: Uint8Array.from(r.key), word: receiptKeyWord(r.at, 0n) }));
  }

  /** The word the record holds for `key` at an L1 block whose timestamp is `provenAt`: zero if unregistered then. */
  receiptKeyWordAt(key: Uint8Array, provenAt: bigint): Uint8Array {
    const held = this.receiptKeysAt(provenAt).find(
      (r) => r.key.length === key.length && r.key.every((b, i) => b === key[i]),
    );
    return held?.word ?? new Uint8Array(32);
  }

  /**
   * Anchors each period after the last one handled through `segment`, once
   * the board holds every entry those periods will ever have: one that
   * added entries, and the seal even with none, when it is reached. A
   * period with no new entries is skipped, as the spec allows, so every
   * anchor names a size no earlier one has, or is the seal's.
   */
  anchorThrough(entries: readonly Uint8Array[], segment: number): void {
    if (segment > this.clock.lastSegment) throw new Error("simulation: anchoring past the seal");
    if (segment <= this.#through) return;
    const periods = Array.from(
      { length: segment - this.#through },
      (_, i) => this.#through + 1 + i,
    );
    const checkpoints = copyCheckpoints(this.#electionId, entries, periods);
    let size = this.#anchors.at(-1)?.checkpoint.size ?? 0n;
    for (const s of periods) {
      const checkpoint = checkpoints.get(s);
      // An empty board has no checkpoint (`checkpoint-size`).
      if (checkpoint === undefined) continue;
      if (checkpoint.size === size && s !== this.clock.lastSegment) continue;
      size = checkpoint.size;
      // In the first block after the period ends, well inside the deadline.
      const anchoredAt = this.#l1.block(this.#l1.firstAfter(endOf(s))).timestamp;
      this.#anchors.push({ checkpoint, anchoredAt });
    }
    this.#through = segment;
  }
}
