// What a reader of the board derives from its counted extent (docs/spec/
// verifier.md, 5.7 to 5.9): each ballot record decoded, its L1 reference's
// admission, the re-vote rule's selection of one ballot per tier and
// nullifier, and the delivery check that keeps only delivered ones. The
// trustees read it at t_S (./run.ts), and a rebuild from chain and IPFS reads
// it again (./rebuild.ts): both call this, so the two can differ only in the
// bytes they read. Nothing here reimplements a check: each is
// @abolishus/crypto's (AGENTS.md, Architecture; T-45, T-25, T-41).

import {
  type AdmittedBallot,
  type BallotRecordV2,
  type BallotSelection,
  ballotHash,
  checkDelivery,
  checkL1Reference,
  decodeBallot,
  type DeliveryBallot,
  type DeliveryCheck,
  type DeliveryEntry,
  deliveryDeadlines,
  deliverySegments,
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
  /** The tier of each cell the definition's partition has; throws for any other cell. */
  readonly tierOfCell: (cell: number) => number;
  readonly closesAt: bigint;
  /** The definition's `l1_inclusion_bound`. */
  readonly inclusionBound: number;
  /** L1 as finalized at the reader's head, and the re-vote rule's window over it. */
  readonly finalized: FinalizedL1;
  readonly window: { readonly l1RefMin: bigint; readonly closesAt: bigint };
  /** Contract-path delivery records, read from chain by their submission time. */
  readonly postings: readonly DeliveryEntry[];
}

export interface CountedExtent {
  /** Each ballot record, by board index. */
  readonly ballots: ReadonlyMap<number, BallotRecordV2>;
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
 * ballot version 2, M from each record and the definition, under its cell's
 * tier (5.7), and every delivery record of the extent with the contract-path
 * postings, so crypto, not this file, decides what each says.
 */
export function readCountedExtent(
  ctx: CountingContext,
  entries: readonly { readonly segment: number; readonly payload: Uint8Array }[],
): CountedExtent {
  const ballots = new Map<number, BallotRecordV2>();
  const verdicts = new Map<number, L1ReferenceVerdict>();
  const admitted: AdmittedBallot[] = [];
  entries.forEach((entry, index) => {
    if (recordTypeOf(entry.payload) !== RECORD_TYPES.ballot) return;
    const b = decodeBallot(entry.payload, 2);
    ballots.set(index, b);
    const ref = { l1RefNumber: b.l1_ref_number, l1RefHash: b.l1_ref_hash };
    const verdict = checkL1Reference(ref, ctx.finalized, ctx.window);
    verdicts.set(index, verdict);
    if (verdict !== "admitted") return;
    const tier = ctx.tierOfCell(b.cell);
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
      ...ctx.postings,
    ],
    1,
  );
  const counted = selection.selected.filter((_, i) => delivery.ballots[i]?.counted === true);
  return { ballots, verdicts, selection, delivery, counted };
}
