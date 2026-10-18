// Stage 4's receipts (P1-13b part 3b-3b-3): the board operator's signed
// receipt for a ballot, over the board it shows the voter with the voter's
// entry last (docs/spec/receipts.md), the voter's check at cast, and the
// later judgement against the checkpoints anchored on L1 and the entry-hash
// lists any source serves (Verdicts). The fixture plays the operator, so it
// can show a voter a board it never anchors: a fork, or a board that drops
// the voter's ballot. Every check is @abolishus/crypto's; nothing here
// decides a verdict (T-25, T-26, T-24).

import {
  type Anchor,
  type AnchorClock,
  BOARD_TREE,
  type BoardEntryVersion,
  boardEntryHash,
  checkReceiptAtCast,
  chainLink,
  encodeReceipt,
  inclusionProof,
  judgeReceipt,
  merkleRoot,
  receiptKeyJudgement,
  receiptKeyRecordFromWord,
  type ReceiptVerdict,
  signReceipt,
} from "@abolishus/crypto";
import { boardEntryVersion, type FixtureDefinition } from "./election.ts";
import type { DropOutcome } from "./verify.ts";

/** What receipts and their checks read from an election's definition. */
export interface ReceiptElection {
  readonly electionId: Uint8Array;
  readonly boardEntryVersion: BoardEntryVersion;
  /** The receipt keys the definition lists, in list order. */
  readonly receiptKeys: readonly Uint8Array[];
  readonly opensAt: bigint;
}

/** A version-5 definition's receipt election. */
export function receiptElection(d: FixtureDefinition & { readonly version: 5 }): ReceiptElection {
  return {
    electionId: d.value.election_id,
    boardEntryVersion: boardEntryVersion(d),
    receiptKeys: d.value.receipt_keys,
    opensAt: d.value.opens_at,
  };
}

/**
 * The receipt the operator signs with `secretKey` right after appending the
 * last of `view`, the board it shows the voter: its index and segment, the
 * chain head and root at `view.length` entries, and its audit path there.
 */
export function operatorReceipt(
  secretKey: Uint8Array,
  e: ReceiptElection,
  view: readonly Uint8Array[],
  segment: number,
): Uint8Array {
  if (view.length === 0) throw new RangeError("a receipt needs the voter's entry on the board");
  const hashes = view.map(boardEntryHash);
  const last = hashes.length - 1;
  return encodeReceipt(
    signReceipt(secretKey, {
      election_id: e.electionId,
      index: BigInt(last),
      segment,
      entry_hash: hashes[last] as Uint8Array,
      link: hashes.reduce((link, h) => chainLink(link, h), new Uint8Array(32)),
      root: merkleRoot(BOARD_TREE, hashes),
      inclusion: inclusionProof(BOARD_TREE, hashes, last),
    }),
  );
}

/**
 * The client's check when the receipt arrives, against the poll's listed
 * keys and the segments from its voting window's to the seal (client rule 1,
 * capped at the seal): whether the voter is told the ballot was received.
 */
export function checkAtCast(
  e: ReceiptElection,
  receipt: Uint8Array,
  payload: Uint8Array,
  segments: { readonly min: number; readonly max: number },
): boolean {
  return checkReceiptAtCast(receipt, {
    electionId: e.electionId,
    payload,
    boardEntryVersion: e.boardEntryVersion,
    receiptKeys: e.receiptKeys,
    segments,
  }).ok;
}

/** What a judge reads from L1 at its finalized block, the same for every voter's receipt. */
export interface JudgeView {
  /** The receipt-key record's word of each listed key, in list order. */
  readonly words: readonly Uint8Array[];
  /** The finalized block's timestamp. */
  readonly now: bigint;
  /** Every anchor for the election up to that block. */
  readonly anchors: readonly Anchor[];
  readonly clock: AnchorClock;
  readonly firstSegment: number;
  /** Entry-hash lists from each source, as `judgeReceipt` takes them. */
  readonly sources: readonly Uint8Array[];
}

/**
 * The receipt's verdict, under the keys the definition lists, each judged
 * from its record at the finalized block (2.9), never from a release's list.
 */
export function judge(
  e: ReceiptElection,
  receipt: Uint8Array,
  payload: Uint8Array,
  v: JudgeView,
): ReceiptVerdict {
  const keys = e.receiptKeys.map((key, i) => {
    const word = v.words[i];
    const record = word === undefined ? undefined : receiptKeyRecordFromWord(word, v.now);
    if (record === undefined) throw new Error(`receipt key ${i} has no record the anchor can hold`);
    return { key, judgement: receiptKeyJudgement(record, e.opensAt, v.now) };
  });
  return judgeReceipt({
    receipt,
    payload,
    electionId: e.electionId,
    boardEntryVersion: e.boardEntryVersion,
    keys: { kind: "definition", keys },
    firstSegment: v.firstSegment,
    clock: v.clock,
    anchors: v.anchors,
    now: v.now,
    sources: v.sources,
  });
}

/**
 * The verdict a receipt must reach: `included` for one whose board was
 * anchored, `forked-copy` for one whose board a source's copy contradicts,
 * `forked-l1` for one the anchored sizes contradict on L1 alone.
 */
export type ExpectedVerdict = "included" | "forked-copy" | "forked-l1";

/**
 * What the drop rule must find for a receipt (docs/spec/receipts.md, Drops):
 * nothing to judge for one that isn't an alarm, the ballot `present` at the
 * board entry carrying it, or a `drop`.
 */
export type ExpectedDrop =
  | { readonly status: "not-alarm" }
  | { readonly status: "present"; readonly entry: number }
  | { readonly status: "drop" };

/** One receipt the operator signed, with what its voter's later check must find. */
export interface Receipted {
  readonly name: string;
  /** The ballot record the voter sent. */
  readonly payload: Uint8Array;
  readonly receipt: Uint8Array;
  readonly expected: ExpectedVerdict;
  readonly drop: ExpectedDrop;
}

/** Whether `v` is the verdict `expected` names. */
export function verdictIs(expected: ExpectedVerdict, v: ReceiptVerdict): boolean {
  switch (expected) {
    case "included":
      return v.verdict === "included";
    case "forked-copy":
      return v.verdict === "forked" && v.by === "copy";
    case "forked-l1":
      return v.verdict === "forked" && v.by === "l1";
  }
}

/** Whether `o` is the outcome `expected` names. */
export function dropIs(expected: ExpectedDrop, o: DropOutcome): boolean {
  switch (expected.status) {
    case "not-alarm":
      return o.status === "not-drop" && o.code === "not-alarm";
    case "present":
      return o.status === "not-drop" && o.code === "present" && o.entry === expected.entry;
    case "drop":
      return o.status === "drop";
  }
}
