// The view a seat decides what it owes over at `c_I`, as a deployment reads
// it (docs/spec/delivery.md, What a node owes): finalized L1 from the seat's
// own L1 node, every ballot copy it holds from the anchored board through
// the ballot extent it attested and from the board contract's records in
// its own L2 node's finalized history, each kept only if the verifier's own
// admission (5.1 to 5.4) passes it, and the receipted ballots it shows
// absent. `decideObligation` judges the L1 references and the close rule
// over it; this file only gathers (T-25, T-52, T-54).
//
// A seat shows a ballot absent only from the extent it attested, which it
// pinned in full before attesting: holding every timely checkpoint's data
// through `s_A` is what lets it say a ballot isn't there (docs/spec/
// availability.md, The ballot extent and what a node owes). A seat that
// didn't attest decides over its own intake alone, the residual the spec
// names for a seat whose operator withheld the board (delivery.md,
// Residuals): its admission needs the ceremony transcript, which only the
// board carries.
import {
  BOARD_ENTRY,
  type BoardEntryVersion,
  checkContractEvent,
  CONTRACT_EVENT_SIGNATURES,
  type ContractEventVersion,
  DecodeError,
  decodeBoardEntry,
  decodeContractEvent,
  electionDefinitionHash,
  type EventContracts,
  type FinalizedL1,
  L1_REF_MARGIN,
  type Panel,
  pinnedVersion,
  RECORD_TYPES,
  type ViewBallot,
} from "@abolishus/crypto";
import {
  chainId,
  contractLogs,
  finalizedBlock,
  headerRun,
  l2Finalized,
  registration,
  type Rpc,
  RpcError,
} from "@abolishus/node";
import {
  type BallotAdmission,
  decodeHeader,
  electionAdmission,
  type L1Header,
  RlpError,
} from "@abolishus/verifier";
import { keccak256, toBytes } from "viem";
import type { HeldExtent } from "./availability.ts";
import type { ApprovedElection } from "./ceremony.ts";
import { heldIntake } from "./intake.ts";
import type { ObligationView } from "./obligation.ts";
import type { SeatStore } from "./store.ts";
import { RELEASE_WINDOWS } from "./stub.ts";

export interface ViewOptions {
  readonly store: SeatStore;
  /** The panel the seat's configuration pins: the one 2.5 checks the definition against. */
  readonly panel: Panel;
  /** The seat's own L1 node. */
  readonly l1: Rpc;
  readonly l1ChainId: bigint;
  /** The seat's own L2 node. */
  readonly l2: Rpc;
  readonly l2ChainId: bigint;
  /** The deployment's election registry, 20 bytes, and its deployment block. */
  readonly registry: Uint8Array;
  readonly registryFromBlock: bigint;
  /** The deployment's board contract, 20 bytes, and its deployment block. */
  readonly board: Uint8Array;
  readonly boardFromBlock: bigint;
  /** The ballot extent the seat attested for the election, if it did (`AvailabilitySeat.heldExtent`). */
  readonly extent: (election: ApprovedElection) => Promise<HeldExtent | undefined>;
  /** The most bytes of L1 headers one read holds (`headerRun`'s `maxBytes`). */
  readonly maxRunBytes?: number;
}

/** Why a view can't be read for an election: none of these changes on a retry. */
export type ViewRefusal =
  /** A node is on another chain than the deployment's. */
  | "chain"
  /**
   * The registered definition isn't one this node reads (its version, or the
   * board-entry or contract-event version it pins), isn't the one the seat
   * approved, or names another board than the deployment's.
   */
  | "definition"
  /** Finalized L1 from an hour before `opens_at` to past `closes_at` is longer than `maxRunBytes`. */
  | "l1-run-short";

export class ViewError extends Error {
  override readonly name = "ViewError";
  readonly code: ViewRefusal;
  constructor(code: ViewRefusal) {
    super(code);
    this.code = code;
  }
}

const BALLOT_SUBMITTED = keccak256(toBytes("BallotSubmitted(bytes32,bytes32,bytes)"), "bytes");
const RELAYED_BALLOT_SUBMITTED = keccak256(
  toBytes("RelayedBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes)"),
  "bytes",
);

// The board's role only, as the recorded-event reads take it.
const boardOnly = (board: Uint8Array): EventContracts => ({
  electionRegistry: new Uint8Array(20),
  trusteeRegistry: new Uint8Array(20),
  groupRegistry: new Uint8Array(20),
  board,
});

const isBoardVersion = (v: number | undefined): v is BoardEntryVersion =>
  v !== undefined && Object.hasOwn(BOARD_ENTRY.versions, v);
const isEventVersion = (v: number | undefined): v is ContractEventVersion =>
  v !== undefined && Object.hasOwn(CONTRACT_EVENT_SIGNATURES, v);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `ObligationOptions.view` over the seat's own nodes and its attested
 * extent. Each read checks both nodes' chains and requires the registered
 * definition to be the approved one (`ViewError`); a node's answer that
 * can't be read throws `RpcError`, and the registration missing from
 * finalized L2 the node package's `L2Error`, so the decision is retried
 * rather than taken over a view the node couldn't read.
 */
export function obligationView(
  options: ViewOptions,
): (election: ApprovedElection) => Promise<ObligationView> {
  return async (election) => {
    const { l1, l2 } = options;
    if ((await chainId(l1)) !== options.l1ChainId || (await chainId(l2)) !== options.l2ChainId)
      throw new ViewError("chain");
    const l2Head = await l2Finalized(l2);
    const reg = await registration(
      l2,
      options.registry,
      election.electionId,
      options.registryFromBlock,
      l2Head,
    );
    // The hash binds every field, the transcript's hash among them, so the
    // definition admission reads is the one the seat approved.
    if (
      reg.decoded.version !== 1 ||
      !equal(electionDefinitionHash(reg.decoded.value), election.definitionHash)
    )
      throw new ViewError("definition");
    const d = reg.decoded.value;
    // The versions the verifier reads this election's board and events under (4.2, 4.4).
    const boardVersion = pinnedVersion(d, RECORD_TYPES.boardEntry);
    const eventVersion = pinnedVersion(d, RECORD_TYPES.contractEvent);
    if (
      !isBoardVersion(boardVersion) ||
      !isEventVersion(eventVersion) ||
      !equal(d.board, options.board)
    )
      throw new ViewError("definition");
    const { l1: finalized, low } = await finalizedL1(options, election);
    const extent = await options.extent(election);
    const view = { l1: finalized, low };
    if (extent === undefined) return { ...view, board: [], absent: [] };
    // Every in-window ballot the contract records is in an L2 block by the
    // end of the contract-event window: a node whose finalized history stops
    // short of it could hide one the delivery check selects, which the seat
    // would then show absent (T-25, T-54).
    if ((await l2BlockTime(l2, l2Head)) <= election.closesAt + RELEASE_WINDOWS.contractEventWindow)
      throw new RpcError(
        "the L2 node's finalized history doesn't reach the contract-event window's end",
      );
    const entries = extent.entries.map((e) => decodeBoardEntry(e, boardVersion));
    const admission = electionAdmission(reg.definition, options.panel, extent.entries);
    // The seat attested this extent, so it carries the transcript it approved;
    // an election the verifier can't admit ballots of fails at 3.2 for
    // everyone, and the seat holds no copy that could count.
    if (!admission.ok) return { ...view, board: [], absent: [], boardSegment: extent.boardSegment };
    const onBoard = entries.filter(
      (e) =>
        e.payload.length >= 2 &&
        (((e.payload[0] as number) << 8) | (e.payload[1] as number)) === RECORD_TYPES.ballot,
    );
    const board: ViewBallot[] = [];
    admission.admitAll(onBoard.map((e) => e.payload)).forEach((a, i) => {
      const e = onBoard[i] as (typeof onBoard)[number];
      const copy = copyOf(a, { path: "board", value: BigInt(e.segment) });
      if (copy !== undefined) board.push(copy);
    });
    const recorded = await contractBallots(options, election.definitionHash, l2Head, eventVersion);
    admission.admitAll(recorded.copies.map((c) => c.record)).forEach((a, i) => {
      const c = recorded.copies[i] as (typeof recorded.copies)[number];
      const copy = copyOf(a, c.entry);
      if (copy !== undefined) board.push(copy);
    });
    // Absent: receipted, carried by no admitted copy of the extent, and named
    // by no ballot log of the board's for the definition, whether or not it
    // passed the event check, nor by a ballot event the anchored board
    // archived, so no log the node shows or hides is taken as absence.
    const present = new Set([
      ...board.map((b) => hex(b.ballotHash)),
      ...recorded.named,
      ...archivedBallots(entries, options.board, election.definitionHash, eventVersion),
    ]);
    const held = await heldIntake(options.store, election.stubHash, election.definitionHash);
    const absent = held.receipts.filter((h) => !present.has(hex(h)));
    return { ...view, board, absent, boardSegment: extent.boardSegment };
  };
}

/** The ballot hashes of the board's ballot events for the definition that the extent archives. */
function archivedBallots(
  entries: readonly { readonly payload: Uint8Array }[],
  board: Uint8Array,
  definitionHash: Uint8Array,
  eventVersion: ContractEventVersion,
): string[] {
  const named: string[] = [];
  for (const { payload } of entries) {
    if (
      payload.length < 2 ||
      (((payload[0] as number) << 8) | (payload[1] as number)) !== RECORD_TYPES.contractEvent
    )
      continue;
    let record;
    try {
      record = decodeContractEvent(payload, eventVersion);
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
    const checked = checkContractEvent(record, boardOnly(board), eventVersion);
    if (!checked.ok) continue;
    const e = checked.event;
    if (
      (e.event === "BallotSubmitted" || e.event === "RelayedBallotSubmitted") &&
      equal(e.definitionHash, definitionHash)
    )
      named.push(hex(e.ballotHash));
  }
  return named;
}

function copyOf(a: BallotAdmission, entry: ViewBallot["entry"]): ViewBallot | undefined {
  if (!a.ok) return undefined;
  return {
    ballotHash: a.ballotHash,
    tier: a.tier,
    nullifier: a.nullifier,
    message: a.message,
    l1RefNumber: a.l1RefNumber,
    l1RefHash: a.l1RefHash,
    entry,
  };
}

/**
 * Finalized L1 from the last block before `opens_at − L1_REF_MARGIN` (or
 * block 0) to the first after `closes_at` (or the finalized head, if none is
 * yet), as the verifier's run covers 5.8, so `l1_ref_min` is found from its
 * first block and every reference is judged against the blocks it names.
 * Each block names the one before it as its parent, so the node is trusted
 * only for which head is finalized.
 */
async function finalizedL1(
  options: ViewOptions,
  election: ApprovedElection,
): Promise<{ readonly l1: FinalizedL1; readonly low: bigint }> {
  const head = await finalizedBlock(options.l1);
  const before = election.opensAt > L1_REF_MARGIN ? election.opensAt - L1_REF_MARGIN : 0n;
  const run = await headerRun(
    options.l1,
    head,
    { before, after: election.closesAt },
    ...(options.maxRunBytes === undefined ? [] : [options.maxRunBytes]),
  );
  let headers: L1Header[];
  try {
    headers = run.map(decodeHeader);
  } catch (e) {
    if (e instanceof RlpError) throw new RpcError("eth_getBlockByNumber: not a header");
    throw e;
  }
  const first = headers[0] as L1Header;
  // A run the budget cut starts inside the window, and `l1_ref_min` could lie below it.
  if (first.number !== 0n && first.timestamp >= before) throw new ViewError("l1-run-short");
  const last = headers.at(-1) as L1Header;
  return {
    low: first.number,
    l1: {
      head: last.number,
      block(n) {
        const b = n >= first.number ? headers[Number(n - first.number)] : undefined;
        if (b === undefined) throw new RangeError(`view: L1 block ${n} outside the run`);
        return b;
      },
    },
  };
}

/**
 * The board contract's ballot records for the definition in the L2 node's
 * finalized history: each copy that passes the event check, with the entry
 * the close rule judges it by (an ordinary ballot by its block's timestamp,
 * a relayed one by its relay call's stamp, which the contract checked
 * against the window and the verifier matches against L1, 4.5), and the
 * ballot hash every ballot log names, checked or not.
 */
async function contractBallots(
  options: ViewOptions,
  definitionHash: Uint8Array,
  l2Head: bigint,
  eventVersion: ContractEventVersion,
): Promise<{
  readonly copies: readonly { readonly record: Uint8Array; readonly entry: ViewBallot["entry"] }[];
  readonly named: readonly string[];
}> {
  const { l2, board } = options;
  if (l2Head < options.boardFromBlock) return { copies: [], named: [] };
  const logs = await contractLogs(
    l2,
    board,
    [[BALLOT_SUBMITTED, RELAYED_BALLOT_SUBMITTED], definitionHash],
    options.boardFromBlock,
    l2Head,
  );
  const named: string[] = [];
  const copies: { record: Uint8Array; entry: ViewBallot["entry"] }[] = [];
  const times = new Map<bigint, bigint>();
  for (const log of logs) {
    const topic = log.topics[2];
    if (topic !== undefined) named.push(hex(topic));
    const checked = checkContractEvent(log, boardOnly(board), eventVersion);
    if (!checked.ok) continue;
    const e = checked.event;
    if (e.event === "RelayedBallotSubmitted") {
      if (equal(e.definitionHash, definitionHash))
        copies.push({ record: e.record, entry: { path: "relayed", value: e.stamp } });
    } else if (e.event === "BallotSubmitted" && equal(e.definitionHash, definitionHash)) {
      let time = times.get(log.l2_block);
      if (time === undefined) {
        time = await l2BlockTime(l2, log.l2_block);
        times.set(log.l2_block, time);
      }
      copies.push({ record: e.record, entry: { path: "ordinary", value: time } });
    }
  }
  return { copies, named };
}

async function l2BlockTime(l2: Rpc, n: bigint): Promise<bigint> {
  const block = (await l2.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])) as {
    number?: unknown;
    timestamp?: unknown;
  } | null;
  const quantity = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/u;
  if (
    typeof block?.number !== "string" ||
    typeof block.timestamp !== "string" ||
    !quantity.test(block.number) ||
    !quantity.test(block.timestamp) ||
    BigInt(block.number) !== n
  )
    throw new RpcError("eth_getBlockByNumber: not a block");
  return BigInt(block.timestamp);
}
