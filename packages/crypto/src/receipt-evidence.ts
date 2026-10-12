// What a receipt shows after its segment's deadline (docs/spec/receipts.md,
// Later checks; ADR 0023): the dispute end, the salted commitment that keeps
// a receipt evidence after it, and the verdicts against the checkpoints
// anchored on L1 and the entry-hash lists of the anchored board (T-25, T-26,
// T-69, T-24). The opening's checks against L1 are a later part; this module
// takes their results.

import {
  type Anchor,
  type AnchorClock,
  anchoredCheckpoints,
  type BoardEntryVersion,
  BoardError,
  type Checkpoint,
} from "./board.ts";
import { ds } from "./domain-separation.ts";
import type { ReceiptKeyJudgement } from "./election-definition.ts";
import { H } from "./group.ts";
import { BOARD_TREE, consistencyProof, merkleRoots, verifyConsistency } from "./merkle.ts";
import { PARAMETERS } from "./parameters.ts";
import { checkReceiptAtCast, type Receipt, type ReceiptCastErrorCode } from "./receipt.ts";

const U64_MAX = (1n << 64n) - 1n;

const copyBytes = (b: unknown, what: string) => {
  if (!(b instanceof Uint8Array) || !ArrayBuffer.isView(b))
    throw new TypeError(`${what} must be a Uint8Array`);
  return new Uint8Array(b);
};

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

function checkClock(clock: AnchorClock): AnchorClock {
  const { epoch, period, deadline, lastSegment } = clock;
  for (const [v, min, what] of [
    [epoch, 0n, "epoch"],
    [period, 1n, "period"],
    [deadline, 0n, "deadline"],
  ] as const)
    if (typeof v !== "bigint" || v < min || v > U64_MAX)
      throw new RangeError(`clock.${what} must be a u64 bigint ≥ ${min}`);
  if (!Number.isInteger(lastSegment) || lastSegment < 0 || lastSegment > 0xffffffff)
    throw new RangeError("clock.lastSegment must be a u32");
  return { epoch, period, deadline, lastSegment };
}

/** The end of segment `s`'s anchoring window: the end of period `s` plus the deadline. */
const windowEnd = (c: AnchorClock, s: number) => c.epoch + (BigInt(s) + 1n) * c.period + c.deadline;

/**
 * `t_E = epoch + (lastSegment + 1)·period + deadline + DISPUTE_WINDOW`: the
 * end of the seal's anchoring window plus receipt version 1's dispute window
 * (docs/spec/receipts.md, Dispute end). Before it a receipt is evidence on
 * its own; from it on, only with a passing opening of a commitment made by
 * then, so a key obtained later forges nothing (T-69).
 */
export function disputeEnd(clock: AnchorClock): bigint {
  const c = checkClock(clock);
  return windowEnd(c, c.lastSegment) + BigInt(PARAMETERS.DISPUTE_WINDOW);
}

/** The salt's length: 32 bytes fresh from a CSPRNG for each commitment. */
export const RECEIPT_COMMITMENT_SALT_LEN = 32;

/**
 * `C = H(DS("abolish/v1/receipt-commitment", salt ‖ encode(receipt)))`
 * (docs/spec/receipts.md, Commitment), over the receipt's full encoding, record
 * header included. The salt hides the receipt, so anyone may carry `C` (T-11,
 * T-45); the caller draws it from a CSPRNG for every commitment.
 */
export function receiptCommitment(salt: Uint8Array, encodedReceipt: Uint8Array): Uint8Array {
  const s = copyBytes(salt, "salt");
  if (s.length !== RECEIPT_COMMITMENT_SALT_LEN) throw new RangeError("salt must be 32 bytes");
  const r = copyBytes(encodedReceipt, "encodedReceipt");
  const m = new Uint8Array(s.length + r.length);
  m.set(s);
  m.set(r, s.length);
  return H(ds("abolish/v1/receipt-commitment", m));
}

/**
 * Whether `commitment` is on L1 in this calldata (docs/spec/receipts.md,
 * Commitment; opening checks 2 and 3): the calldata's length is a multiple of
 * 32 and one of its 32-byte words at an offset that is a multiple of 32 is
 * `commitment`. Alignment makes the word's position unambiguous, so a relayer
 * can batch any number of voters' words as a bare concatenation.
 */
export function calldataCarries(calldata: Uint8Array, commitment: Uint8Array): boolean {
  const d = copyBytes(calldata, "calldata");
  const c = copyBytes(commitment, "commitment");
  if (c.length !== 32) throw new RangeError("commitment must be 32 bytes");
  if (d.length % 32 !== 0) return false;
  for (let at = 0; at < d.length; at += 32) if (equalBytes(d.subarray(at, at + 32), c)) return true;
  return false;
}

/** The opening checks' failures (docs/spec/receipts.md, Opening), in the order they run. */
export type ReceiptOpeningErrorCode =
  | "opening-decode"
  | "opening-transaction"
  | "opening-commitment"
  | "opening-late"
  | "opening-payload"
  | "opening-canonical";

/**
 * The result of the six opening checks for one opening, against the judge's
 * trusted beacon state and `t_E`. `opening-fork-unknown` is no failure: the
 * judge's release doesn't know the fork, so it can't tell.
 */
export type ReceiptOpeningCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: ReceiptOpeningErrorCode | "opening-fork-unknown" };

/**
 * The receipt keys that judge the election (docs/spec/receipts.md, Receipt
 * keys): from definition version 4 on, each listed key with its judgement
 * from the anchor's record ([[verifier]] 2.9), so verdicts are attributable
 * to the anchoring authority; under versions 1 and 3, the set the client's
 * release pinned when it accepted the receipt, so verdicts are the voter's own.
 */
export type JudgingKeys =
  | {
      readonly kind: "definition";
      readonly keys: readonly {
        readonly key: Uint8Array;
        readonly judgement: ReceiptKeyJudgement;
      }[];
    }
  | { readonly kind: "pinned"; readonly keys: readonly Uint8Array[] };

/** What a judge takes (docs/spec/receipts.md, Verdicts). */
export interface ReceiptJudgeInput {
  /** The receipt's encoding, as the voter kept it. */
  readonly receipt: Uint8Array;
  /** The complete record the receipt covers, header included. */
  readonly payload: Uint8Array;
  readonly electionId: Uint8Array;
  /** The board-entry version the election's profile pins. */
  readonly boardEntryVersion: BoardEntryVersion;
  readonly keys: JudgingKeys;
  /** `f`, the election's first segment. */
  readonly firstSegment: number;
  /** The anchoring clock; its `lastSegment` is the election's seal. */
  readonly clock: AnchorClock;
  /** Every anchor for the election read from L1 at `now`, never a selection (T-24). */
  readonly anchors: readonly Anchor[];
  /** The timestamp of the latest finalized L1 block the judge has read. */
  readonly now: bigint;
  /** From `t_E` on: the results of the opening checks for each opening the voter holds. */
  readonly openings?: readonly ReceiptOpeningCheck[];
  /**
   * Entry-hash lists from each source: one source's lists of the election's
   * segments concatenated in order, 32 bytes per entry from index 0. Nothing
   * authenticates them but the anchored roots; a list that matches no
   * checkpoint is a bad copy from that source, never a verdict.
   */
  readonly sources?: readonly Uint8Array[];
}

/** Why a receipt is `not-evidence`. */
export type NotEvidenceReason = ReceiptCastErrorCode | "expired";

/** Why the board checks that need no copy fail the election. */
export type BoardFailedReason =
  | "wrong-election"
  | "checkpoint-equivocation"
  | "checkpoint-size"
  | "checkpoint-inconsistent"
  | "unsealed"
  | "receipt-key-retired"
  | "receipt-key-unregistered";

/** A consistency proof from the receipt's tree to one anchored checkpoint's. */
export interface ConsistencyToCheckpoint {
  readonly checkpoint: Checkpoint;
  readonly proof: readonly Uint8Array[];
}

/**
 * A verdict (docs/spec/receipts.md, Verdicts), the first that applies.
 * `unjudged` isn't one: this judge can't reach a verdict yet, because its
 * release doesn't know an opening's fork, or its finalized L1 block is
 * before `opens_at` so a listed key isn't settled.
 */
export type ReceiptVerdict =
  | {
      readonly verdict: "not-evidence";
      readonly reason: NotEvidenceReason;
      /** With `expired`: the first failing opening's code, if any opening was given. */
      readonly opening?: ReceiptOpeningErrorCode;
    }
  | {
      readonly verdict: "unjudged";
      readonly reason: "opening-fork-unknown" | "receipt-key-unsettled";
    }
  | { readonly verdict: "board-failed"; readonly reason: BoardFailedReason }
  | { readonly verdict: "pending" }
  | { readonly verdict: "unanchored" }
  | {
      readonly verdict: "forked";
      /** From L1 alone: a checkpoint whose size contradicts the receipt's index and segment. */
      readonly by: "l1";
      readonly checkpoint: Checkpoint;
    }
  | {
      readonly verdict: "forked";
      /** From a copy: the root `r′` of the anchored board's first `index + 1` entries, and its proof. */
      readonly by: "copy";
      readonly rootAtIndex: Uint8Array;
      readonly consistency: ConsistencyToCheckpoint;
    }
  | {
      readonly verdict: "included";
      /** A proof from `(index + 1, root)` to every counted checkpoint for `s` and later. */
      readonly consistency: readonly ConsistencyToCheckpoint[];
    }
  | { readonly verdict: "unresolved" };

const ALARMS: ReadonlySet<ReceiptVerdict["verdict"]> = new Set([
  "board-failed",
  "unanchored",
  "forked",
  "unresolved",
]);

/** Client rule 3: `board-failed`, `unanchored`, `forked` and `unresolved` are alarms. */
export function isReceiptAlarm(v: ReceiptVerdict): boolean {
  return ALARMS.has(v.verdict);
}

function judgingKeys(keys: JudgingKeys): {
  judging: Uint8Array[];
  failed?: BoardFailedReason;
  unsettled: boolean;
} {
  if (keys.kind === "pinned") {
    if (!Array.isArray(keys.keys)) throw new TypeError("keys.keys must be an array");
    return { judging: keys.keys.map((k, i) => copyBytes(k, `keys[${i}]`)), unsettled: false };
  }
  if (keys.kind !== "definition") throw new TypeError("keys.kind must be definition or pinned");
  if (!Array.isArray(keys.keys)) throw new TypeError("keys.keys must be an array");
  const judging: Uint8Array[] = [];
  let failed: BoardFailedReason | undefined;
  let unsettled = false;
  for (const [i, { key, judgement }] of keys.keys.entries()) {
    const k = copyBytes(key, `keys[${i}].key`);
    if (judgement === "judges") judging.push(k);
    else if (judgement === "retired") failed ??= "receipt-key-retired";
    else if (judgement === "unregistered") failed ??= "receipt-key-unregistered";
    else if (judgement === "unsettled") unsettled = true;
    else throw new TypeError(`keys[${i}].judgement is not a receipt-key judgement`);
  }
  return failed === undefined ? { judging, unsettled } : { judging, failed, unsettled };
}

/** Splits a source's lists into entry hashes, or undefined for a source no board can give. */
function entryHashes(source: unknown): Uint8Array[] | undefined {
  if (!(source instanceof Uint8Array) || !ArrayBuffer.isView(source)) return undefined;
  if (source.length % 32 !== 0) return undefined;
  const b = new Uint8Array(source);
  const out: Uint8Array[] = [];
  for (let at = 0; at < b.length; at += 32) out.push(b.subarray(at, at + 32));
  return out;
}

/**
 * Judges a receipt (docs/spec/receipts.md, Verdicts), in order, the first
 * that applies:
 *
 * 1. `not-evidence`: the checks at cast fail against the keys that judge the
 *    election and the segments `f` to `lastSegment`; or `now ≥ t_E` and no
 *    opening passes.
 * 2. `board-failed`: steps 1 and 2 of the board checks, or `unsealed`, or a
 *    listed key doesn't judge the election.
 * 3. `pending`: segment `s`'s window hasn't closed by `now`.
 * 4. `unanchored`: no counted checkpoint for `s`.
 * 5. `forked` from L1 alone: a counted checkpoint for an earlier segment has
 *    a size above `index`, or one for `s` or later a size at most `index`.
 * 6. From the sources: `forked` if a source matches a counted checkpoint for
 *    `s` or later whose board's first `index + 1` entries have another root
 *    than the receipt's; `included` if one source matches every one of them
 *    and that root is the receipt's.
 * 7. `unresolved` otherwise.
 *
 * Nothing here asks anyone about the voter's own entry: the anchors and the
 * lists are the same for every voter (T-11, T-45).
 */
export function judgeReceipt(input: ReceiptJudgeInput): ReceiptVerdict {
  const c = checkClock(input.clock);
  const { now, firstSegment: f } = input;
  if (typeof now !== "bigint" || now < 0n || now > U64_MAX)
    throw new RangeError("now must be a u64 bigint");
  if (!Number.isInteger(f) || f < 0 || f > c.lastSegment)
    throw new RangeError("firstSegment must be a u32 at most lastSegment");
  const keys = judgingKeys(input.keys);
  // A key read before opens_at isn't settled: a judge that can't yet see
  // which keys judge the election can't call the receipt not evidence.
  if (keys.unsettled) return { verdict: "unjudged", reason: "receipt-key-unsettled" };

  // 1. The checks at cast, against the keys that judge the election, with
  // every segment of the election accepted: a receipt outside them can't
  // frame an honest operator, who never signs one.
  const cast = checkReceiptAtCast(input.receipt, {
    electionId: input.electionId,
    payload: input.payload,
    boardEntryVersion: input.boardEntryVersion,
    receiptKeys: keys.judging,
    segments: { min: f, max: c.lastSegment },
  });
  if (!cast.ok) return { verdict: "not-evidence", reason: cast.code };
  const r: Receipt = cast.receipt;
  if (now >= disputeEnd(c)) {
    const openings = input.openings ?? [];
    if (!Array.isArray(openings)) throw new TypeError("openings must be an array");
    if (!openings.some((o) => o.ok)) {
      // An opening from a fork this release doesn't know may well pass under
      // one that does, so the receipt is unjudged here, never not evidence.
      if (openings.some((o) => !o.ok && o.code === "opening-fork-unknown"))
        return { verdict: "unjudged", reason: "opening-fork-unknown" };
      const first = openings[0];
      return first !== undefined && !first.ok && first.code !== "opening-fork-unknown"
        ? { verdict: "not-evidence", reason: "expired", opening: first.code }
        : { verdict: "not-evidence", reason: "expired" };
    }
  }

  // 2. Failures attributed from L1 alone; the receipt adds nothing to them.
  let counted: Checkpoint[];
  try {
    // Anchors for segments before f belong to no reading of this election.
    if (!Array.isArray(input.anchors)) throw new TypeError("anchors must be an array");
    const anchors = input.anchors.filter((a) => a.checkpoint.segment >= f);
    counted = anchoredCheckpoints(input.electionId, anchors, c, now);
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    return { verdict: "board-failed", reason: e.code as BoardFailedReason };
  }
  if (keys.failed !== undefined) return { verdict: "board-failed", reason: keys.failed };

  // 3. to 5., from L1 alone.
  const s = r.segment;
  if (now <= windowEnd(c, s)) return { verdict: "pending" };
  if (!counted.some((cp) => cp.segment === s)) return { verdict: "unanchored" };
  const contradicting = counted.find((cp) =>
    cp.segment < s ? cp.size > r.index : cp.size <= r.index,
  );
  if (contradicting !== undefined)
    return { verdict: "forked", by: "l1", checkpoint: contradicting };

  // 6. and 7., from the sources' lists. Every checkpoint here covers the
  // entry, by step 5.
  const later = counted.filter((cp) => cp.segment >= s);
  const sources = input.sources ?? [];
  if (!Array.isArray(sources)) throw new TypeError("sources must be an array");
  // No list can hold 2⁵³ entries, so a larger index is unresolved.
  const n = r.index < BigInt(Number.MAX_SAFE_INTEGER) ? Number(r.index) + 1 : Infinity;
  let includedBy: ConsistencyToCheckpoint[] | undefined;
  for (const source of sources) {
    const hashes = entryHashes(source);
    if (hashes === undefined || hashes.length < n) continue;
    const sizes = new Set([
      n,
      ...later.filter((cp) => cp.size <= hashes.length).map((cp) => Number(cp.size)),
    ]);
    const roots = merkleRoots(BOARD_TREE, hashes, sizes);
    const rootAtIndex = roots.get(n) as Uint8Array;
    const matched = later.filter((cp) => {
      const root = roots.get(Number(cp.size));
      return root !== undefined && equalBytes(root, cp.root);
    });
    const proofs = matched.map((cp) => ({
      checkpoint: cp,
      proof: consistencyProof(BOARD_TREE, hashes.slice(0, Number(cp.size)), n),
    }));
    if (!equalBytes(rootAtIndex, r.root)) {
      // Two roots of one size can't both extend an anchored root without a
      // collision of the tagged tree hashes (T-24).
      const shown = proofs.find(({ checkpoint, proof }) =>
        verifyConsistency(
          BOARD_TREE,
          BigInt(n),
          checkpoint.size,
          rootAtIndex,
          checkpoint.root,
          proof,
        ),
      );
      if (shown !== undefined)
        return { verdict: "forked", by: "copy", rootAtIndex, consistency: shown };
    } else if (includedBy === undefined && matched.length === later.length) {
      includedBy = proofs;
    }
  }
  // A fork shown by any source settles it before inclusion: an honest
  // operator's board admits no such source.
  if (includedBy !== undefined) return { verdict: "included", consistency: includedBy };
  return { verdict: "unresolved" };
}
