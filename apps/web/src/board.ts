// One page of a poll's board as the board page shows it, built from the
// API's encoded entries. Nothing here is trusted: each entry is decoded with
// @abolishus/crypto under the version the poll's definition pins, must name
// this poll and sit at the position the page asked for, and its hash is
// computed here from its bytes, never taken from the server (T-23, T-31,
// T-34). A page with any entry that fails is refused whole rather than shown
// in part. Whether the entries chain to the head the server claims is the
// verifier's check, over the whole board.

import {
  boardEntryHash,
  type BoardEntryVersion,
  checkpointHash,
  DecodeError,
  decodeBoardEntry,
  decodeCheckpoint,
  RECORD_TYPES,
} from "@abolishus/crypto";

import { fromHex, toHex } from "./values.ts";

/** What an entry records, named by its payload's record type (docs/spec/board.md, Allowed payloads). */
export type EntryKind =
  | "ballot"
  | "spoiled-opening"
  | "ceremony"
  | "tally-opening"
  | "contract-event"
  | "share-receipt"
  | "share-complaint"
  | "destruction"
  | "close-statement"
  | "running-opening"
  | "author-approvals";

const KINDS: ReadonlyMap<number, EntryKind> = new Map([
  [RECORD_TYPES.ballot, "ballot"],
  [RECORD_TYPES.spoiledBallotOpening, "spoiled-opening"],
  [RECORD_TYPES.ceremonyTranscript, "ceremony"],
  [RECORD_TYPES.tallyOpening, "tally-opening"],
  [RECORD_TYPES.contractEvent, "contract-event"],
  [RECORD_TYPES.shareReceipt, "share-receipt"],
  [RECORD_TYPES.shareComplaint, "share-complaint"],
  [RECORD_TYPES.destructionStatement, "destruction"],
  [RECORD_TYPES.closeStatement, "close-statement"],
  [RECORD_TYPES.runningOpening, "running-opening"],
  [RECORD_TYPES.authorApprovals, "author-approvals"],
]);

export interface BoardRow {
  /** The entry's position, as a canonical decimal `u64`. */
  readonly index: string;
  /** The anchoring period the board appended it in. */
  readonly segment: number;
  readonly kind: EntryKind;
  /** Its entry hash, computed here. */
  readonly hash: string;
}

/**
 * The rows for `entries`, the API's page from position `from` of the board of
 * `electionId`, or `undefined` if any entry doesn't decode under `version`,
 * names another election, sits at another position, or goes back to an
 * earlier anchoring period than the entry before it.
 */
export function boardRows(
  electionId: string,
  version: BoardEntryVersion,
  from: bigint,
  entries: readonly string[],
): readonly BoardRow[] | undefined {
  const rows: BoardRow[] = [];
  for (const [i, hex] of entries.entries()) {
    let bytes;
    let entry;
    try {
      bytes = fromHex(hex);
      entry = decodeBoardEntry(bytes, version);
    } catch (error) {
      if (error instanceof DecodeError || error instanceof RangeError) return undefined;
      throw error;
    }
    if (toHex(entry.election_id) !== electionId || entry.index !== from + BigInt(i))
      return undefined;
    const previous = rows.at(-1);
    if (previous !== undefined && entry.segment < previous.segment) return undefined;
    // The record header's first two bytes are its type, big-endian (docs/spec/notation.md).
    const kind = KINDS.get(((entry.payload[0] ?? 0) << 8) | (entry.payload[1] ?? 0));
    if (kind === undefined) return undefined;
    rows.push({
      index: entry.index.toString(),
      segment: entry.segment,
      kind,
      hash: toHex(boardEntryHash(bytes)),
    });
  }
  return rows;
}

export interface AnchorRow {
  /** The anchoring period the checkpoint closes. */
  readonly segment: number;
  /** Entries on the board after that period, as a canonical decimal `u64`. */
  readonly size: string;
  readonly head: string;
  readonly root: string;
  /** The checkpoint's hash, computed here: the value an anchor on L1 would hold for it. */
  readonly hash: string;
}

/**
 * The rows for `checkpoints`, the API's latest checkpoints of the board of
 * `electionId`, latest first, or `undefined` if any doesn't decode, names
 * another election, or doesn't go back from the one before it: an earlier
 * period and at most as many entries. A board only grows (T-24), so
 * checkpoints that break this can't all be anchored for one board, and none
 * is shown. They aren't held to the head's size: a checkpoint taken after
 * the head was read may count more.
 * Whether each is in the anchor on L1 is the verifier's check (T-23).
 */
export function anchorRows(
  electionId: string,
  checkpoints: readonly string[],
): readonly AnchorRow[] | undefined {
  const rows: AnchorRow[] = [];
  for (const hex of checkpoints) {
    let checkpoint;
    try {
      checkpoint = decodeCheckpoint(fromHex(hex));
    } catch (error) {
      if (error instanceof DecodeError || error instanceof RangeError) return undefined;
      throw error;
    }
    const previous = rows.at(-1);
    if (
      toHex(checkpoint.election_id) !== electionId ||
      checkpoint.size < 1n ||
      (previous !== undefined &&
        (checkpoint.segment >= previous.segment || checkpoint.size > BigInt(previous.size)))
    )
      return undefined;
    rows.push({
      segment: checkpoint.segment,
      size: checkpoint.size.toString(),
      head: toHex(checkpoint.head),
      root: toHex(checkpoint.root),
      hash: toHex(checkpointHash(checkpoint)),
    });
  }
  return rows;
}

export interface ActivityBar {
  /** The anchoring period. */
  readonly segment: number;
  /** Entries the board added in it, as a canonical decimal `u64`. */
  readonly added: string;
}

/**
 * Entries added in each period that `anchors` (checked by `anchorRows`,
 * latest first) has a checkpoint for, earliest first: each checkpoint's size
 * less the one before it. Every period that adds entries gets a checkpoint
 * (docs/spec/board.md, Segments and checkpoints), so the periods between two
 * added none. The earliest of `anchors` has a count only when the list is the
 * whole board's, fewer than the `asked` the API was asked for: otherwise the
 * checkpoint before it is unknown and it is left out. These are differences
 * of the server's claims, never more than they are (T-23, T-24).
 */
export function activityBars(anchors: readonly AnchorRow[], asked: number): readonly ActivityBar[] {
  const bars: ActivityBar[] = [];
  for (const [i, anchor] of anchors.entries()) {
    const before = anchors[i + 1];
    if (before === undefined && anchors.length >= asked) break;
    bars.push({
      segment: anchor.segment,
      added: (BigInt(anchor.size) - BigInt(before?.size ?? "0")).toString(),
    });
  }
  return bars.reverse();
}
