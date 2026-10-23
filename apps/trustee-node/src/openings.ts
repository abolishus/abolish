// The board's tally openings as the seat reads them back (docs/spec/tally.md,
// Destruction, When): every tally opening (`0x0006`) on the election's board
// through the latest counted checkpoint the seat's own finalized L1 node
// shows anchored, read by the CIDs those checkpoints name from any sources
// and checked against the anchored heads and roots (`verifyBoard`), so each
// opening read is included under a checkpoint the seat checked itself, never
// a server's word (T-53, T-49, T-24). Whether an opening passes is the tally
// duty's to judge, against its own aggregates (`TallyDuty`).
import {
  type AsyncBlockSource,
  BoardError,
  type BoardErrorCode,
  type BoardEntryVersion,
  type Checkpoint,
  checkpointHash,
  countedCheckpoints,
  decodeBoardEntry,
  readBoardCopy,
  RECORD_TYPES,
  verifyBoard,
} from "@abolishus/crypto";
import type { FinalizedBoardAnchors } from "./availability.ts";
import type { ApprovedElection } from "./ceremony.ts";

/** One tally-opening payload on the anchored board, with the segment its entry is in. */
export interface BoardOpening {
  readonly payload: Uint8Array;
  readonly segment: number;
}

/** What the seat read of the board's tally openings. */
export type BoardOpenings =
  /**
   * The copy through the latest counted checkpoint couldn't be read from
   * these sources (a run unavailable, over the read's budget, or not the
   * one L1 names), or L1 shows no counted checkpoint yet: nothing is known
   * about the openings, and the read is tried again.
   */
  | { readonly state: "unread" }
  /** The board fails a check no later read settles: the election fails at 4.2, and no opening on it counts. */
  | { readonly state: "board-failed"; readonly code: BoardErrorCode }
  /**
   * Every tally opening through `checkpoint`, the latest counted
   * checkpoint's hash, in board order. A later read through the same
   * checkpoint returns this same object.
   */
  | {
      readonly state: "read";
      readonly checkpoint: Uint8Array;
      readonly openings: readonly BoardOpening[];
    };

export interface BoardOpeningsOptions {
  readonly election: ApprovedElection;
  /** The election's reader through `s_T` (`l1BoardAnchors` with `tally`), with the board-entry version its definition pins. */
  readonly l1: FinalizedBoardAnchors & { readonly boardVersion: BoardEntryVersion };
  /** Any sources of the board's blocks: the seat's own directory, then gateways. Untrusted. */
  readonly blocks: AsyncBlockSource;
  /** The most the seat reads of the board's segment objects (readBoardCopy's `maxBytes`). */
  readonly maxBytes: number;
}

// Failures that say this copy, from these sources, isn't the anchored board
// through the latest checkpoint: read again later, never a verdict
// (docs/spec/board.md, Board checks), as the availability duty takes them.
const UNREAD: ReadonlySet<BoardErrorCode> = new Set<BoardErrorCode>([
  "checkpoint-missing",
  "copy-mismatch",
]);
// Step 6 judges segments and the seal past the latest anchor, never the
// entries through it, which are all a read gives.
const PAST_COPY: ReadonlySet<BoardErrorCode> = new Set<BoardErrorCode>(["unanchored", "unsealed"]);

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The reader of one election's anchored tally openings. Each call reads the
 * election's anchors from finalized L1 and, only when the latest counted
 * checkpoint has changed since the last read that succeeded, the board
 * through it again: an anchored copy never changes, so the seat fetches the
 * board once per checkpoint, not once per step (T-52).
 */
export function boardOpenings(options: BoardOpeningsOptions): () => Promise<BoardOpenings> {
  const { election, l1, blocks, maxBytes } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError("boardOpenings: maxBytes must be a positive integer");
  let last: Extract<BoardOpenings, { state: "read" }> | undefined;
  return async () => {
    const { anchors, clock, now } = await l1.read(election.electionId);
    let latest: Checkpoint | undefined;
    try {
      for (const cp of countedCheckpoints(election.electionId, anchors, clock, now))
        if (latest === undefined || cp.segment > latest.segment) latest = cp;
    } catch (e) {
      if (e instanceof BoardError) return { state: "board-failed", code: e.code };
      throw e;
    }
    if (latest === undefined) return { state: "unread" };
    const checkpoint = checkpointHash(latest);
    if (last !== undefined && equal(last.checkpoint, checkpoint)) return last;
    const copy = await readBoardCopy(election.electionId, anchors, clock, now, blocks, maxBytes);
    if (copy.stopped !== undefined) return { state: "unread" };
    try {
      verifyBoard(election.electionId, copy.encodedEntries, l1.boardVersion, anchors, clock, now);
    } catch (e) {
      if (!(e instanceof BoardError)) throw e;
      if (UNREAD.has(e.code)) return { state: "unread" };
      if (!PAST_COPY.has(e.code)) return { state: "board-failed", code: e.code };
    }
    const openings: BoardOpening[] = [];
    for (const bytes of copy.encodedEntries) {
      // Every entry passed the board checks under this version.
      const { payload, segment } = decodeBoardEntry(bytes, l1.boardVersion);
      if ((((payload[0] as number) << 8) | (payload[1] as number)) === RECORD_TYPES.tallyOpening)
        openings.push({ payload, segment });
    }
    last = { state: "read", checkpoint, openings };
    return last;
  };
}
