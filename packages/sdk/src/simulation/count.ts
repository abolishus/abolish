// What a reader of the board derives from its counted extent (docs/spec/
// verifier.md, 5.5 to 5.9): each ballot record decoded, through the board
// path or as the board contract's event (a direct submission), its window
// by its own path, its L1 reference's admission, the re-vote rule's
// selection of one ballot per tier and nullifier, and the delivery check
// that keeps only delivered ones, reading contract-path receipts and
// postings from their events on the board. The
// trustees read it at t_S (./run.ts), and a rebuild from chain and IPFS reads
// it again (./rebuild.ts): both call this, so the two can differ only in the
// bytes they read. Nothing here reimplements a check: each is
// @abolishus/crypto's (AGENTS.md, Architecture; T-45, T-25, T-41).

import {
  type AdmittedBallot,
  ballotWindow,
  type BallotRecordV2,
  type BallotSelection,
  ballotHash,
  checkContractEvent,
  checkDelivery,
  checkL1Reference,
  type ContractEventRecord,
  type ContractEventVersion,
  decodeContractEvent,
  decodeBallot,
  DecodeError,
  type DeliveryBallot,
  type DeliveryCheck,
  type DeliveryEntry,
  deliveryDeadlines,
  deliverySegments,
  type EventContracts,
  type FinalizedL1,
  type L1ReferenceVerdict,
  membershipMessage,
  RECORD_TYPES,
  type RegisteredKeys,
  selectBallots,
} from "@abolishus/crypto";
import { SIMULATED_ANCHOR_PERIOD } from "./board.ts";

// A record's type, the u16 at the head of its encoding (docs/spec/notation.md):
// which records on the board each check reads.
export const recordTypeOf = (record: Uint8Array): number =>
  ((record[0] ?? 0) << 8) | (record[1] ?? 0);

const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// What the delivery check reads (docs/spec/delivery.md, Delivery check).
const DELIVERY_RECORD_TYPES: ReadonlySet<number> = new Set([
  RECORD_TYPES.shareReceipt,
  RECORD_TYPES.sharePosting,
  RECORD_TYPES.shareComplaint,
]);

/** What a reader of the counted extent holds besides the board. */
export interface CountingContext {
  readonly definitionHash: Uint8Array;
  readonly panelSize: number;
  /** The key set the ceremony check registered. */
  readonly registered: readonly RegisteredKeys[];
  /** The tier of each cell the definition's partition has; `undefined` for any other cell. */
  readonly tierOfCell: (cell: number) => number | undefined;
  readonly closesAt: bigint;
  /** The definition's `l1_inclusion_bound`. */
  readonly inclusionBound: number;
  /** L1 as finalized at the reader's head, and the re-vote rule's window over it. */
  readonly finalized: FinalizedL1;
  readonly window: { readonly l1RefMin: bigint; readonly closesAt: bigint };
  /** The definition's L2 contracts, whose events the board carries as contract-event records. */
  readonly contracts: EventContracts;
  /** The contract-event version the profile pins. */
  readonly eventVersion: ContractEventVersion;
  readonly opensAt: bigint;
  /** `s_A = period(closes_at) + 1`: the last segment a board-path ballot may be in. */
  readonly boardSegment: bigint;
}

/** A board-contract event on the board, which passed the event check. */
export interface BoardEvent {
  /** Its board index. */
  readonly index: number;
  readonly record: ContractEventRecord;
}

export interface CountedExtent {
  /** Each ballot record, by board index. */
  readonly ballots: ReadonlyMap<number, BallotRecordV2>;
  /**
   * Board indices of ballots that don't decode under ballot version 2, name
   * another definition or a cell the partition lacks, or fall outside the
   * window by their path,
   * of relayed ballots, whose stamp only L1 shows (4.5), and of
   * contract-event records that don't decode or fail the event check:
   * rejected entries, as the verifier rejects them, never a reason to stop
   * reading.
   */
  readonly rejected: readonly number[];
  /** The board contract's events on the board, in board order. */
  readonly events: readonly BoardEvent[];
  /** Each ballot's L1 reference's verdict (5.8), by board index. */
  readonly verdicts: ReadonlyMap<number, L1ReferenceVerdict>;
  /** The re-vote rule over the admitted ballots (5.7, 6.1). */
  readonly selection: BallotSelection;
  /** The delivery check over the selected ballots, in selection order (5.9). */
  readonly delivery: DeliveryCheck;
  /** The selected ballots the delivery check kept: the tally's input. */
  readonly counted: readonly AdmittedBallot[];
}

/**
 * Reads the counted extent's entries, each with its segment: ballots under
 * ballot version 2, on the board path or in the board contract's events,
 * M from each record and the definition, under its cell's tier (5.7), and
 * every delivery record of the extent, on either path, so crypto, not this
 * file, decides what each says.
 */
export function readCountedExtent(
  ctx: CountingContext,
  entries: readonly { readonly segment: number; readonly payload: Uint8Array }[],
): CountedExtent {
  const ballots = new Map<number, BallotRecordV2>();
  const verdicts = new Map<number, L1ReferenceVerdict>();
  const rejected: number[] = [];
  const admitted: AdmittedBallot[] = [];
  const events: BoardEvent[] = [];
  // Contract-path delivery records, each in time by its event's L2 time
  // (docs/spec/delivery.md, Direct submit).
  const contractDelivery: DeliveryEntry[] = [];
  const window = {
    opensAt: ctx.opensAt,
    closesAt: ctx.closesAt,
    boardSegment: ctx.boardSegment,
  };
  entries.forEach((entry, index) => {
    let payload = entry.payload;
    // Each copy's window by its own path (5.5): a board-path ballot by its
    // segment, a direct one by its event's L2 block time (T-35, T-50).
    let inWindow: ReturnType<typeof ballotWindow>;
    const type = recordTypeOf(payload);
    if (type === RECORD_TYPES.contractEvent) {
      // Only the board's own events, as crypto's event check reads them,
      // carry a ballot or a delivery record (T-71, T-17).
      let record: ContractEventRecord;
      try {
        record = decodeContractEvent(payload, ctx.eventVersion);
      } catch (e) {
        if (!(e instanceof DecodeError)) throw e;
        rejected.push(index);
        return;
      }
      const checked = checkContractEvent(record, ctx.contracts, ctx.eventVersion);
      if (!checked.ok) {
        rejected.push(index);
        return;
      }
      if (checked.role !== "board") return;
      events.push({ index, record });
      const { event } = checked;
      switch (event.event) {
        case "ShareReceiptSubmitted":
        case "SharePosted":
        case "ShareComplaintSubmitted":
        case "ShareReceiptBatchSubmitted":
        case "ShareComplaintBatchSubmitted":
          contractDelivery.push({
            path: "contract",
            submittedAt: record.l2_timestamp,
            payload: event.record,
          });
          return;
        case "BallotSubmitted":
          payload = event.record;
          inWindow = ballotWindow("ordinary", record.l2_timestamp, window);
          break;
        // A relayed ballot's window is its relay call's stamp, which only
        // L1 shows (4.5): none is read here.
        case "RelayedBallotSubmitted":
          rejected.push(index);
          return;
        default:
          return;
      }
    } else if (type === RECORD_TYPES.ballot)
      inWindow = ballotWindow("board", BigInt(entry.segment), window);
    else return;
    let b: BallotRecordV2;
    try {
      b = decodeBallot(payload, 2);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      rejected.push(index);
      return;
    }
    const tier = ctx.tierOfCell(b.cell);
    // Another election's ballot (`ballot-stray`): the board contract's
    // sequence is shared by every election on it, so its events can name
    // any registered definition.
    if (
      tier === undefined ||
      inWindow !== "admitted" ||
      !same(b.definition_hash, ctx.definitionHash)
    ) {
      rejected.push(index);
      return;
    }
    ballots.set(index, b);
    const ref = { l1RefNumber: b.l1_ref_number, l1RefHash: b.l1_ref_hash };
    const verdict = checkL1Reference(ref, ctx.finalized, ctx.window);
    verdicts.set(index, verdict);
    if (verdict !== "admitted") return;
    const context = {
      definitionHash: ctx.definitionHash,
      ballotVersion: 2,
      cell: b.cell,
      nullifier: b.nullifier,
    } as const;
    admitted.push({
      tier,
      nullifier: b.nullifier,
      message: membershipMessage({
        ...ref,
        definitionHash: ctx.definitionHash,
        tier,
        ballotHash: ballotHash(context, b.committed_vote),
      }),
      l1RefNumber: b.l1_ref_number,
      index: BigInt(index),
    });
  });
  const selection = selectBallots(admitted);
  const ballotOf = (index: bigint): BallotRecordV2 => {
    const b = ballots.get(Number(index));
    if (b === undefined) throw new Error("simulation: a selected entry isn't a boarded ballot");
    return b;
  };
  const bound = BigInt(ctx.inclusionBound);
  const delivery = checkDelivery(
    {
      definitionHash: ctx.definitionHash,
      panelSize: ctx.panelSize,
      registered: ctx.registered,
      segments: deliverySegments(
        { epoch: 0n, period: SIMULATED_ANCHOR_PERIOD },
        ctx.closesAt,
        bound,
      ),
      deadlines: deliveryDeadlines(ctx.closesAt, bound),
    },
    selection.selected.map((s): DeliveryBallot => {
      const b = ballotOf(s.index);
      return { ballotVersion: 2, cell: b.cell, nullifier: b.nullifier, vote: b.committed_vote };
    }),
    [
      ...entries
        .filter((e) => DELIVERY_RECORD_TYPES.has(recordTypeOf(e.payload)))
        .map((e): DeliveryEntry => ({ path: "board", segment: e.segment, payload: e.payload })),
      ...contractDelivery,
    ],
    1,
  );
  const counted = selection.selected.filter((_, i) => delivery.ballots[i]?.counted === true);
  return { ballots, rejected, events, verdicts, selection, delivery, counted };
}
