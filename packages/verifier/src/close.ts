// The close check (6.3, docs/spec/verifier.md, Close check; docs/spec/close.md,
// Close head and Close check): the default panel's close statements on the
// sealed board, judged by @abolishus/crypto's `closeHead` against `L_δ`,
// which `lDelta` finds in the bundle's run of finalized L1 headers, and the
// counted sets recomputed without the ordinary ballots after the close head
// by `closeCheck`. The verifier gathers the statements and the counted
// extent's admitted ballots and maps the results; the head never decides
// what counts (T-35, T-45, T-53, T-54).
//
// What this release can't decide leaves 6.3 unverifiable: a contract-path
// statement waits on 4.4, which alone authenticates its submission time, and
// an ordinary ballot in the counted extent waits on its L2 block, which
// `closeCheck` compares with the head and which the board's contract-event
// record carries only under 4.4's replay. Selection (6.1) already waits on
// 4.4 for every ordinary ballot, so today 6.3 decides boards whose ballots
// all came by the board path.

import {
  type AdmittedBallot,
  deliveryBallotHashV2,
  type CloseBallot,
  closeCheck,
  closeDeadline,
  closeHead,
  type CloseStatementEntry,
  type ContractEventVersion,
  checkContractEvent,
  DecodeError,
  type DecodeErrorCode,
  decodeContractEvent,
  deliveryBallotHash,
  type AnchorClock,
  lDelta,
  RECORD_TYPES,
  type RegisteredKeys,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BallotTally } from "./ballots.ts";
import type { VerifiedDefinition } from "./definition.ts";
import type { L1Header } from "./l1.ts";
import { finalizedRun } from "./references.ts";

/** One entry of the election in the anchored extent. */
export interface OwnEntry {
  readonly at: number;
  readonly segment: number;
  readonly payload: Uint8Array;
}

/** An admitted ballot of the counted extent, by its entry and path. */
export interface CloseCandidate {
  readonly entry: number;
  readonly path: "board" | "ordinary" | "relayed";
  readonly ballot: AdmittedBallot;
  readonly tally?: BallotTally;
}

export interface CloseInputs {
  readonly definition: VerifiedDefinition;
  readonly definitionHash: Uint8Array;
  /** The default panel's registered key set. */
  readonly registered: readonly RegisteredKeys[];
  readonly clock: AnchorClock;
  readonly eventVersion: ContractEventVersion;
  readonly eventsPass: boolean;
  /** The election's entries in the anchored extent, in copy order. */
  readonly own: readonly OwnEntry[];
  /** A format-5 bundle's run of finalized L1 headers. */
  readonly blocks: readonly L1Header[] | undefined;
  /** Every ballot the admission checks admitted in the counted extent, in copy order. */
  readonly ballots: readonly CloseCandidate[];
  /** For each selected ballot, by its ballot hash in hex: whether delivery keeps it. */
  readonly delivered: ReadonlyMap<string, boolean>;
}

export type CloseCode = "close-contested" | "l1-blocks-short" | "not-reached" | "not-implemented";

export interface CloseOutcome {
  readonly status: "pass" | "fail" | "unverifiable";
  readonly code?: CloseCode;
  readonly at?: { readonly entry: number } | { readonly cell: number } | Record<string, never>;
}

/** A close statement on the board, by its entry, as `closeHead` judged it (close.md, Close head). */
export interface StatementReport {
  readonly entry: number;
  readonly code:
    | "decode"
    | "close-stray"
    | "close-unattributed"
    | "close-l1"
    | "close-late"
    | "valid";
  readonly decodeError?: DecodeErrorCode;
  /** The seat it is attributed to; `null` for a board-path `close-late`, which the operator may have held back. */
  readonly seat?: number | null;
  /** For `close-stray`: the seat this election's keys attribute it to, or `null`. */
  readonly signer?: number | null;
}

/** A claim: the L2 block number (decimal) and hash (hex) a statement names as `head(L_δ)`. */
export interface ClaimReport {
  readonly number: string;
  readonly hash: string;
}

/** The report's `close`, once 6.3 ran past finding `L_δ`. */
export interface CloseReport {
  /** `B` as a decimal string, or `null` with fewer than `k` counted seats: the close is unchecked. */
  readonly head: string | null;
  readonly lDelta: ClaimReport;
  /** One line per registered seat of the default panel, ascending. */
  readonly seats: readonly {
    readonly seat: number;
    readonly code: "close-counted" | "close-missing" | "close-equivocation";
    readonly claim?: ClaimReport;
  }[];
  readonly statements: readonly StatementReport[];
  /** Every distinct claim among valid statements: more than one shows a false statement. */
  readonly claims: readonly ClaimReport[];
  /** The late ordinary ballots, removed before the recomputation. */
  readonly late: readonly { readonly entry: number }[];
  /** With no head: the counted ballots with no copy outside the ordinary path, which the check couldn't place. */
  readonly unchecked?: readonly { readonly entry: number }[];
}

const typeOf = (payload: Uint8Array) => ((payload[0] as number) << 8) | (payload[1] as number);

const claim = (c: { readonly number: bigint; readonly hash: Uint8Array }): ClaimReport => ({
  number: c.number.toString(),
  hash: bytesToHex(c.hash),
});

/** 6.3's row and, once it ran, the report's `close`. */
export function closeChecks(inputs: CloseInputs): {
  readonly row: CloseOutcome;
  readonly report?: CloseReport;
} {
  const d = inputs.definition.value;
  if (inputs.blocks === undefined)
    return { row: { status: "unverifiable", code: "not-reached", at: {} } };
  const bound = BigInt(d.l1_inclusion_bound);
  const end = d.closes_at + bound;
  // `L_δ` is the last finalized block at or before `closes_at + δ`: the run
  // must start at or before that time and reach a block after it.
  const first = inputs.blocks[0];
  if (first === undefined || first.timestamp > end)
    return { row: { status: "unverifiable", code: "l1-blocks-short", at: {} } };
  const l1 = finalizedRun(inputs.blocks);
  const delta = lDelta(l1, first.number, d.closes_at, bound);
  if (delta === undefined)
    return { row: { status: "unverifiable", code: "l1-blocks-short", at: {} } };

  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const statements: CloseStatementEntry[] = [];
  const statementAt: number[] = [];
  for (const { at, segment, payload } of inputs.own) {
    const type = typeOf(payload);
    if (type === RECORD_TYPES.closeStatement) {
      statements.push({ path: "board", segment: BigInt(segment), payload });
      statementAt.push(at);
    } else if (type === RECORD_TYPES.contractEvent) {
      let record;
      try {
        record = decodeContractEvent(payload, inputs.eventVersion);
      } catch (e) {
        if (e instanceof DecodeError) continue;
        throw e;
      }
      const checked = checkContractEvent(record, contracts, inputs.eventVersion);
      if (!checked.ok || checked.role !== "board") continue;
      if (checked.event.event !== "CloseStatementSubmitted") continue;
      // In time by its `l2_timestamp`, which only 4.4's replay
      // authenticates (close.md, Window; T-35, T-71).
      if (!inputs.eventsPass)
        return { row: { status: "unverifiable", code: "not-reached", at: { entry: at } } };
      statements.push({
        path: "contract",
        submittedAt: record.l2_timestamp,
        payload: checked.event.record,
      });
      statementAt.push(at);
    }
  }
  // `closeCheck` places an ordinary ballot by its L2 block, which only 4.4's
  // replay authenticates, and which this release doesn't read yet. Its
  // input is the counted extent's admitted ballots before repeats (close.md,
  // Close check, step 2); with board-path ballots alone, 5.7's repeats share
  // their originals' (tier, ν, M) and path, so leaving them out changes no
  // counted set. A release that judges ordinary ballots must pass them,
  // since a timely repeat keeps a ballot whose first copy is late.
  const ordinary = inputs.ballots.find((b) => b.path !== "board");
  if (ordinary !== undefined)
    return {
      row: { status: "unverifiable", code: "not-implemented", at: { entry: ordinary.entry } },
    };
  const head = closeHead(
    {
      definitionHash: inputs.definitionHash,
      registered: inputs.registered,
      threshold: d.threshold,
      lDelta: delta,
      deadline: closeDeadline(inputs.clock, d.closes_at, bound),
      // The floor needs the pinned dispute games, read from L1 state; it
      // only ever reports, so without it no verdict changes (close.md, The
      // floor).
      floor: null,
    },
    statements,
    1,
  );

  const byIndex = new Map(inputs.ballots.map((b) => [BigInt(b.entry), b]));
  const definitionHash = inputs.definitionHash;
  const ballots: CloseBallot[] = inputs.ballots.map((b) => {
    const t = b.tally;
    // Delivery kept each ballot by the hash of its own version: version 4's
    // over both halves, and version 5's with its step too.
    if (t?.deliveryV4 !== undefined)
      return {
        ...b.ballot,
        cell: t.deliveryV4.cell,
        ballotHash: deliveryBallotHashV2(definitionHash, t.deliveryV4),
        path: "board",
      };
    if (t?.delivery === undefined)
      throw new Error("closeChecks: an admitted ballot without its delivery fields");
    return {
      ...b.ballot,
      cell: t.cell,
      ballotHash: deliveryBallotHash(definitionHash, t.delivery),
      path: "board",
    };
  });
  const checked = closeCheck(ballots, head.head, (hash) => {
    const kept = inputs.delivered.get(bytesToHex(hash));
    // Every ballot the recomputation selects was selected by 6.1, since no
    // ordinary ballot is removed here: delivery decided it.
    if (kept === undefined) throw new Error("closeChecks: a ballot delivery never judged");
    return kept;
  });
  const entryOf = (index: bigint) => {
    const b = byIndex.get(index);
    if (b === undefined) throw new Error("closeChecks: an index outside the ballots");
    return { entry: b.entry };
  };
  const report: CloseReport = {
    head: head.head === null ? null : head.head.toString(),
    lDelta: claim(delta),
    seats: head.seats.map((s) =>
      s.code === "close-counted"
        ? { seat: s.seat, code: s.code, claim: claim(s.claim) }
        : { seat: s.seat, code: s.code },
    ),
    statements: head.statements.map((v): StatementReport => {
      const entry = statementAt[v.at] as number;
      switch (v.code) {
        case "decode":
          return { entry, code: v.code, decodeError: v.error };
        case "close-stray":
          return { entry, code: v.code, signer: v.signer };
        case "close-unattributed":
          return { entry, code: v.code };
        case "close-l1":
        case "valid":
        case "close-late":
          return { entry, code: v.code, seat: v.seat };
        default: {
          const unmapped: never = v;
          throw new Error(`unmapped close-statement verdict ${String(unmapped)}`);
        }
      }
    }),
    claims: head.claims.map(claim),
    late: checked.status === "unchecked" ? [] : checked.late.map(entryOf),
    ...(checked.status === "unchecked" && { unchecked: checked.unchecked.map(entryOf) }),
  };
  // No head, or no late ordinary ballot that changes a counted set: the
  // check passes, and the report says which (close.md, Close check).
  if (checked.status === "fail")
    return {
      row: { status: "fail", code: "close-contested", at: { cell: checked.cell } },
      report,
    };
  return { row: { status: "pass" }, report };
}
