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
  type AnchorClock,
  availabilityWindows,
  BOARD_ENTRY,
  type BoardEntryVersion,
  checkContractEvent,
  CONTRACT_EVENT_SIGNATURES,
  type ContractEventRecord,
  type ContractEventVersion,
  countedExtent,
  type DeadlineClock,
  DecodeError,
  decodeBoardEntry,
  decodeContractEvent,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionV5Hash,
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
  countedSet,
  decodeHeader,
  electionAdmission,
  type L1Header,
  RlpError,
} from "@abolishus/verifier";
import { keccak256, toBytes } from "viem";
import { countedDue, type HeldExtent } from "./availability.ts";
import type { ApprovedElection } from "./ceremony.ts";
import { heldIntake } from "./intake.ts";
import { l2BlockTime } from "./recorded.ts";
import type { ObligationView } from "./obligation.ts";
import type { SeatStore } from "./store.ts";
import { RELEASE_WINDOWS } from "./stub.ts";
import type { CountedSet, TallyDefinition } from "./tally.ts";

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
  | "l1-run-short"
  /** The blocks the seat pinned before attesting no longer hold the ballot extent it attested. */
  | "extent-lost"
  /** The seat holds no copy of the transcript it approved: it approved before it kept one. */
  | "transcript";

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
    const { l2 } = options;
    const { definition, boardVersion, eventVersion, l2Head } = await registered(options, election);
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
    const admission = electionAdmission(definition, options.panel, extent.entries);
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
    // passed the event check. A contract event the board archives is the
    // operator's claim, never the contract's record (delivery.md, Direct
    // submit), so it can't keep a ballot from being shown absent: a forged
    // one would cost the counted ballot this seat's receipt (T-25, T-53).
    const present = new Set([...board.map((b) => hex(b.ballotHash)), ...recorded.named]);
    const held = await heldIntake(options.store, election.stubHash, election.definitionHash);
    const absent = held.receipts.filter((h) => !present.has(hex(h)));
    return { ...view, board, absent, boardSegment: extent.boardSegment };
  };
}

/**
 * The deployment's ballot source for the complaint duty
 * (`ComplaintDutyOptions.ballots`): every ballot record of the election the
 * seat can read when it decides its complaints, the board-path ballots of
 * the extent it attested and the board contract's ballot records in its L2
 * node's finalized history, each passing the event check. Nothing here is
 * admitted or trusted: the duty matches each record to its scope by the
 * ballot hash it recomputes, so the source can withhold a ballot but never
 * swap one (T-38). An attested extent the pinned blocks no longer hold costs
 * only its ballots: the contract's are still given, and the duty waits for
 * the rest until it gives them up (T-29, T-54). Refused as `obligationView`
 * is when the nodes or the registered definition aren't the seat's.
 */
export function complaintBallots(
  options: ViewOptions,
): (election: ApprovedElection) => Promise<readonly Uint8Array[]> {
  return async (election) => {
    const { boardVersion, eventVersion, l2Head } = await registered(options, election);
    let extent;
    try {
      extent = await options.extent(election);
    } catch (e) {
      if (!(e instanceof ViewError && e.code === "extent-lost")) throw e;
    }
    const ballots: Uint8Array[] = [];
    for (const entry of extent?.entries ?? []) {
      const { payload } = decodeBoardEntry(entry, boardVersion);
      if (
        payload.length >= 2 &&
        (((payload[0] as number) << 8) | (payload[1] as number)) === RECORD_TYPES.ballot
      )
        ballots.push(payload);
    }
    const recorded = await contractBallots(options, election.definitionHash, l2Head, eventVersion);
    for (const c of recorded.copies) ballots.push(c.record);
    return ballots;
  };
}

/**
 * The registered definition, as the tally duty takes it, from the seat's own
 * L2 node: the approved one, of version 1 or 5 and naming the deployment's
 * board, or `ViewError`, as `obligationView` reads it. The duty checks it
 * against the approval again (T-37).
 */
export async function tallyDefinition(
  options: Omit<ViewOptions, "store" | "extent">,
  election: ApprovedElection,
): Promise<TallyDefinition> {
  return (await registered(options, election)).decoded;
}

export interface CountedSourceOptions extends Omit<ViewOptions, "store" | "extent"> {
  /**
   * The counted extent the seat attested, if it did (`heldExtent` of its
   * point-2 `AvailabilitySeat`): every board entry through `C_S`, read again
   * from the blocks it pinned before attesting.
   */
  readonly extent: (election: ApprovedElection) => Promise<HeldExtent | undefined>;
  /** The anchoring clock the deployment pins (`L1AnchorOptions.timing`), as the counted duty reads it. */
  readonly counted: DeadlineClock;
}

/**
 * The deployment's source of the counted set (`TallyDutyOptions.counted`):
 * packages/verifier's `countedSet` over the counted extent the seat attested,
 * the registered definition and finalized L1 from the seat's own nodes, with
 * every contract-event record of the extent authenticated against its own
 * L2 node's finalized history first, so the set is the one the verifier
 * later recomputes from the anchored board, never a served value (T-14,
 * T-16, T-29). Undecided only for want of a later input (a run reaching a
 * ballot's L1 reference), it waits; undecided for a reason this release never
 * resolves (relayed ballots, obligation roots, version-2 batches), or over an
 * extent that isn't the board's, it refuses. Throws as `obligationView` does
 * when the nodes or the registered definition aren't the seat's, and
 * `L1AnchorError` `outside-clock` for a close before the clock's epoch.
 */
export function countedSource(
  options: CountedSourceOptions,
): (election: ApprovedElection) => Promise<CountedSet> {
  return async (election) => {
    const { definition, boardVersion, eventVersion, l2Head } = await registered(options, election);
    // Only the seat's own attested extent is the counted extent: a copy it
    // didn't check by `C_S`'s CIDs could hold any entries the operator chose.
    const extent = await options.extent(election);
    if (extent === undefined)
      return { state: "refused", reason: "the seat holds no counted extent" };
    const timing = options.counted;
    const due = countedDue(election, timing);
    const sS = countedExtent(timing, election.closesAt, election.l1InclusionBound).segment;
    if (extent.boardSegment !== sS)
      return { state: "refused", reason: "an extent other than the counted extent" };
    // The clock the counted extent's L1 reader reads the anchors under.
    const clock: AnchorClock = { ...timing, lastSegment: Number(sS) };
    const windows = availabilityWindows(
      election.closesAt,
      election.l1InclusionBound,
      due,
      RELEASE_WINDOWS,
    );
    // Every event the extent archives was emitted before `C_S` was anchored,
    // by `t_S < t_A'`: once the node's finalized history is past `t_A'` it
    // shows each one, so a record it doesn't show is the operator's, never
    // the contract's (T-35, T-71).
    if ((await l2BlockTime(options.l2, l2Head)) <= windows.countedDeadline)
      return { state: "waiting" };
    const shown = await eventsShown(options, extent.entries, boardVersion, eventVersion, l2Head);
    if (shown !== undefined) return { state: "refused", reason: shown };
    const blocks = await l1Run(options, election);
    let result;
    try {
      result = countedSet({
        definition,
        panel: options.panel,
        entries: extent.entries,
        clock,
        blocks,
        eventsAuthenticated: true,
      });
    } catch (e) {
      // The entries aren't the counted extent the board checks passed.
      if (e instanceof RangeError) return { state: "refused", reason: e.message };
      throw e;
    }
    if (result.ok)
      return {
        state: "fixed",
        cells: result.cells,
        postings: extentPostings(
          extent.entries,
          boardVersion,
          eventVersion,
          options.board,
          election,
        ),
      };
    if ("code" in result)
      return { state: "refused", reason: `no ballot can be admitted: ${result.code}` };
    // These wait on finalized L1 growing until it reaches every ballot's
    // reference (5.8); every other code is this release's for good.
    if (GROWS.has(result.outcome.code ?? "")) return { state: "waiting" };
    return {
      state: "refused",
      reason: `the counted set is undecided at ${result.row}: ${result.outcome.code ?? "unknown"}`,
    };
  };
}

/**
 * The share postings for the definition that the board contract's
 * `SharePosted` events among `entries` carry, as their records, for any
 * seat and whether or not in time: the tally duty reads only its own seat's,
 * and opens a posted ciphertext only for the counted ballot whose share hash
 * it matches, which a late posting's still does. Each event was
 * shown by the seat's own L2 node (`eventsShown`) before the counted set was
 * read. An entry or event that doesn't decode, or isn't the board's, carries
 * none, as `countedSet` passes it over.
 */
function extentPostings(
  entries: readonly Uint8Array[],
  boardVersion: BoardEntryVersion,
  eventVersion: ContractEventVersion,
  board: Uint8Array,
  election: ApprovedElection,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const encoded of entries) {
    let checked;
    try {
      const { payload } = decodeBoardEntry(encoded, boardVersion);
      if (
        payload.length < 2 ||
        (((payload[0] as number) << 8) | (payload[1] as number)) !== RECORD_TYPES.contractEvent
      )
        continue;
      checked = checkContractEvent(
        decodeContractEvent(payload, eventVersion),
        boardOnly(board),
        eventVersion,
      );
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
    if (!checked.ok || checked.event.event !== "SharePosted") continue;
    const e = checked.event;
    if (equal(e.definitionHash, election.definitionHash)) out.push(e.record);
  }
  return out;
}

// The undecided codes a later read of finalized L1 can settle.
const GROWS: ReadonlySet<string> = new Set(["l1-ref-pending", "l1-blocks-short", "not-reached"]);

/**
 * Whether every contract-event record among `entries` is its contract's own
 * log as the seat's own L2 node shows its finalized history: the same
 * topics and data in the block the record names, under that block's
 * timestamp, each log carrying at most one record. Undefined if so, or why
 * not. Records of any contract are checked, though the verifier reads only
 * the definition's: stricter than it, so at worst a record it ignores makes
 * the seat refuse. A record that doesn't decode carries nothing the verifier reads
 * (4.4's to report) and is passed over, as `countedSet` passes it over.
 */
async function eventsShown(
  options: Pick<ViewOptions, "l2">,
  entries: readonly Uint8Array[],
  boardVersion: BoardEntryVersion,
  eventVersion: ContractEventVersion,
  l2Head: bigint,
): Promise<string | undefined> {
  const { l2 } = options;
  const logs = new Map<string, { readonly log: ContractEventRecord; used: boolean }[]>();
  const times = new Map<bigint, bigint>();
  for (const encoded of entries) {
    let record;
    try {
      const { payload } = decodeBoardEntry(encoded, boardVersion);
      if (
        payload.length < 2 ||
        (((payload[0] as number) << 8) | (payload[1] as number)) !== RECORD_TYPES.contractEvent
      )
        continue;
      record = decodeContractEvent(payload, eventVersion);
    } catch (e) {
      // `countedSet` refuses an entry that doesn't decode.
      if (e instanceof DecodeError) continue;
      throw e;
    }
    if (record.l2_block > l2Head) return "a contract event past the L2 node's finalized history";
    const key = `${hex(record.contract)}/${record.l2_block}`;
    let inBlock = logs.get(key);
    if (inBlock === undefined) {
      const found = await contractLogs(l2, record.contract, [], record.l2_block, record.l2_block);
      logs.set(key, (inBlock = found.map((log) => ({ log, used: false }))));
    }
    const match = inBlock.find(
      (l) =>
        !l.used &&
        equal(l.log.data, record.data) &&
        l.log.topics.length === record.topics.length &&
        l.log.topics.every((t, i) => equal(t, record.topics[i] as Uint8Array)),
    );
    // Two records of one log would be two of the contract's events where it emitted one.
    if (match === undefined) return "a contract event the seat's L2 node doesn't show";
    match.used = true;
    let time = times.get(record.l2_block);
    if (time === undefined) {
      time = await l2BlockTime(l2, record.l2_block);
      times.set(record.l2_block, time);
    }
    if (time !== record.l2_timestamp) return "a contract event under another block's timestamp";
  }
  return undefined;
}

/**
 * The election's registered definition from the seat's own L2 node, with
 * the board-entry and contract-event versions it pins and the node's
 * finalized block, after checking both nodes' chains. Refused (`ViewError`)
 * when a node is on another chain, or the definition isn't the approved
 * one, isn't one this node reads or names another board.
 */
async function registered(
  options: Omit<ViewOptions, "store" | "extent">,
  election: ApprovedElection,
): Promise<{
  readonly definition: Awaited<ReturnType<typeof registration>>["definition"];
  readonly decoded: Exclude<TallyDefinition, ElectionDefinition>;
  readonly boardVersion: BoardEntryVersion;
  readonly eventVersion: ContractEventVersion;
  readonly l2Head: bigint;
}> {
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
  // definition admission reads is the one the seat approved: of version 1
  // or 5, the versions the seat approves (`checkStub`), each hashed under
  // its own layout.
  const decoded = reg.decoded;
  if (decoded.version !== 1 && decoded.version !== 5) throw new ViewError("definition");
  const hash =
    decoded.version === 1
      ? electionDefinitionHash(decoded.value)
      : electionDefinitionV5Hash(decoded.value);
  if (!equal(hash, election.definitionHash)) throw new ViewError("definition");
  const d = decoded.value;
  // The versions the verifier reads this election's board and events under (4.2, 4.4).
  const boardVersion = pinnedVersion(d, RECORD_TYPES.boardEntry);
  const eventVersion = pinnedVersion(d, RECORD_TYPES.contractEvent);
  if (
    !isBoardVersion(boardVersion) ||
    !isEventVersion(eventVersion) ||
    !equal(d.board, options.board)
  )
    throw new ViewError("definition");
  return { definition: reg.definition, decoded, boardVersion, eventVersion, l2Head };
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
  const headers = await l1Run(options, election);
  const first = headers[0] as L1Header;
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

/** `finalizedL1`'s run of headers, as 5.8 reads it (`CountedExtentInputs.blocks`). */
async function l1Run(
  options: Pick<ViewOptions, "l1" | "maxRunBytes">,
  election: ApprovedElection,
): Promise<L1Header[]> {
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
  return headers;
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
