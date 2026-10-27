// The worker's archive run (docs/spec/archive.md, Archived objects, Who
// writes them, Locator; [[0005-permanent-archive]]; P4-3 part 4b-1). Each
// segment object and entry-hash list a taken checkpoint names is posted to
// Arweave as one transaction whose data is its CAR, and counts as archived
// only once that transaction is `depth` blocks deep, a depth Arweave doesn't
// reorganise, so "once confirmed, always confirmed" holds for the chain rules
// in archive-chain.ts. Confirmed objects are listed in the next version-3
// manifest, which links the confirmed manifests no confirmed manifest
// reaches; a manifest is itself posted and confirmed the same way, and the
// locator names the highest confirmed manifest that reaches every one before
// it. An upload that isn't mined within `repostAfter` is posted again with the
// same bytes, so a dropped transaction never strands an object or a manifest
// (T-51, T-49).
//
// Arweave is behind `ArweaveClient`, which the deployment supplies with its
// wallet; nothing here holds a key. Everything posted is bytes the board
// already holds, each checked against the CID its checkpoint names before it
// is posted, so the archive carries no display text and nothing the board's
// validity checks didn't pass (T-17, T-52).
//
// With the deployment's L2 contracts behind `ContractEventSource`, each
// manifest also lists their contract-event evidence and runs (part 4b-3a):
// for each contract whose count changed in an anchored period, the record at
// the first L2 block after the period's end that a respected game claims,
// and the events from the count the contract's last record proved to this
// one's. Each record is checked as a reader checks it and each run replayed
// against it before anything is posted, so an upload always replays (T-71);
// a source that gives anything else is reported, and the contract waits.
//
// The tables are operational, so a wipe of Postgres loses only the worker's
// place in the chain. A run that holds no chain while the anchor names one
// reads the chain back from Arweave first (P4-3 part 4b-2b-2b-2), so it
// carries on from the anchor's sequence rather than start a new manifest 0,
// which a reader would take for an overwritten locator (T-69).

import {
  boardEntryHash,
  cidText,
  type ArchiveManifest,
  type ContractEventEvidence,
  decodeArchiveLocator,
  decodeArchiveManifest,
  decodeCheckpoint,
  decodeContractEventEvidence,
  encodeArchiveLocator,
  encodeArchiveManifest,
  encodeContractEventEvidence,
  encodeContractEventRun,
  checkEventAccumulatorContinuation,
  eventAccumulatorGenesis,
  type EvidenceRef,
  MAX_CONTRACT_EVENT_RUN,
  MAX_EVENT_DATA,
  MAX_MANIFEST_EVIDENCE,
  MAX_MANIFEST_LINKS,
  MAX_MANIFEST_RUNS,
  MAX_BOARD_PAYLOAD,
  MAX_MANIFEST_OBJECTS,
  MAX_RUN_EVENTS,
  objectCar,
  objectCid,
  readArchivedObject,
  type RunEvent,
  type RunRef,
} from "@abolishus/crypto";
import {
  accumulatorAtOutputRoot,
  checkContractEventEvidence,
  MAX_EVIDENCE_RECORD,
  OutputRootError,
  runBound,
} from "@abolishus/verifier";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  type ChainManifest,
  locatorManifest,
  needsLinkingManifest,
  nextManifestLinks,
} from "./archive-chain.ts";
import { readBoardRange } from "./board.ts";
import { isBytes } from "./bytes.ts";
import type { AnchoringClock } from "./anchoring.ts";
import {
  archiveEventProgress,
  archiveEvidence,
  archiveManifests,
  archiveObjects,
  archiveRuns,
  archiveTransactions,
  boardCheckpoints,
} from "./db/schema/index.ts";
import { withSessionLock } from "./session-lock.ts";

/**
 * The deployment's Arweave access: a node or gateway to post through, with
 * the wallet that pays, and the chain it reads confirmations from.
 */
export interface ArweaveClient {
  /**
   * Posts `data` as the data of one base-layer transaction from the
   * deployment's wallet. Resolves to its 32-byte ID once a node accepted it
   * for mining; throws if none did.
   */
  post(data: Uint8Array): Promise<Uint8Array>;
  /**
   * How deep `transaction` is: 1 in the tip block, more below it, or
   * `undefined` while it is in no block (not yet mined, dropped, or
   * reorganised away).
   */
  confirmations(transaction: Uint8Array): Promise<number | undefined>;
  /**
   * The data a node serves for `transaction`, at most `limit` bytes, or
   * `undefined` if none serves it within the limit. A transaction's header
   * can be mined without its data ever being uploaded, so depth alone never
   * shows it is archived.
   */
  data(transaction: Uint8Array, limit: number): Promise<Uint8Array | undefined>;
}

/**
 * The depth at which the worker counts a transaction confirmed by default:
 * about fifty minutes of Arweave blocks, well past the forks Arweave sees,
 * since a confirmed manifest may be linked and named by a locator for good.
 */
export const ARCHIVE_DEPTH = 25;

/**
 * How long, in seconds, an upload in no block waits before it is posted again
 * by default: a transaction's anchor lapses after 50 blocks, about 100
 * minutes, after which it can never be mined.
 */
export const ARCHIVE_REPOST_AFTER = 7200n;

/**
 * The most transactions a resume reads before it gives up: the locator's
 * chain is the anchor's, which a seized authority sets, so its length and
 * links are bounded only here (T-52). A deployment writes about one manifest
 * a run, so this covers more than a year of ten-minute runs.
 */
export const ARCHIVE_RESUME_READS = 65_536;

/**
 * The most anchored periods one run examines for each contract by default:
 * each costs the source a game lookup and a proof, and a database starting
 * from none (after a wipe, say) would otherwise ask for every period since
 * the first in one run.
 */
export const ARCHIVE_EVIDENCE_PERIODS = 64;

/**
 * Where the evidence and the events of the deployment's L2 contracts come
 * from (docs/spec/archive.md, Contract-event evidence and Contract-event run,
 * Who writes them): the dispute games on L1 and an L2 node for the records,
 * the index ([[P3-5]]) for the events. Nothing it gives is trusted: every
 * record is checked as a reader checks it and every event replayed against
 * it before upload (`ContractEventError` otherwise).
 */
export interface ContractEventSource {
  /**
   * The evidence record proving `contract`'s accumulator at the first L2
   * block with a timestamp of at least `after` for which a dispute game of
   * the type the L2's portal respects claims an output root, with that
   * game's index and address, or `undefined` while no such game exists.
   */
  evidence(contract: Uint8Array, after: bigint): Promise<ContractEventEvidence | undefined>;
  /** Events `from` to `to − 1` of `contract`'s sequence, in order of their index. */
  events(contract: Uint8Array, from: bigint, to: bigint): Promise<readonly RunEvent[]>;
}

/** The L2 contracts whose events the archive keeps, and where they are read. */
export interface ContractEventArchive {
  readonly source: ContractEventSource;
  /** The L2's chain ID, which every record and run names. */
  readonly l2ChainId: bigint;
  /** The deployment's L2 contracts: its registries and its board, each 20 bytes. */
  readonly contracts: readonly Uint8Array[];
  /** The anchor's clock: period `s` ends at `epoch + (s + 1) · period`. */
  readonly clock: Pick<AnchoringClock, "epoch" | "period">;
  /** Anchored periods examined for each contract in one run; `ARCHIVE_EVIDENCE_PERIODS` by default. */
  readonly maxPeriods?: number;
}

/**
 * Why a contract's evidence or events weren't archived this run: the record
 * isn't one a reader would take for the contract (`evidence`: the evidence
 * check fails, it isn't canonical, its block is before the period's end, or
 * it proves less than, or other than, the contract's last record), or the
 * events don't replay to it (`events`: too few or too many, out of order,
 * past its block, or another accumulator), they need more runs than one
 * manifest lists (`runs`), or the source itself failed (`source`: a node
 * down, say), which never holds up the board's objects. Nothing more of the
 * contract is written until a later run's source gives what checks.
 */
export type ContractEventErrorCode = "evidence" | "events" | "runs" | "source";

export class ContractEventError extends Error {
  override readonly name = "ContractEventError";
  readonly code: ContractEventErrorCode;
  constructor(code: ContractEventErrorCode, message: string) {
    super(`a contract's events can't be archived: ${message}`);
    this.code = code;
  }
}

export interface ArchiveOptions {
  /**
   * The locator the board anchor holds now (`latestLocator()`), or `undefined`
   * if it holds none. A run with no chain of its own never starts one while
   * the anchor names a chain, since after a wipe of Postgres a new chain from
   * sequence 0 would read as an overwritten locator (`locator-mismatch`,
   * T-69): it reads the anchor's chain back from Arweave instead, or throws
   * `ArchiveResumeError`.
   */
  readonly latestLocator: Uint8Array | undefined;
  /** The L1 the deployment's board anchor is on, which every manifest names. */
  readonly l1ChainId: bigint;
  /** The board anchor's 20-byte address, which every manifest names. */
  readonly anchor: Uint8Array;
  /** The worker's clock, in seconds since the epoch. */
  readonly now: bigint;
  /** Confirmations at which a transaction counts as confirmed; `ARCHIVE_DEPTH` by default. */
  readonly depth?: number;
  /** Seconds before an upload in no block is posted again; `ARCHIVE_REPOST_AFTER` by default. */
  readonly repostAfter?: bigint;
  /** The most links a manifest carries, from 2 to `MAX_MANIFEST_LINKS` (the default). */
  readonly maxLinks?: number;
  /** The L2 contracts whose evidence and runs the manifests list; none without it. */
  readonly contractEvents?: ContractEventArchive;
}

/** What one run did. */
export interface ArchiveRun {
  /** Another run held the archive's lock, so this one did nothing. */
  readonly busy: boolean;
  /** Manifests read back from the anchor's chain into a database that held none. */
  readonly resumed: number;
  /** Objects first seen in a taken checkpoint. */
  readonly registered: number;
  /** Transactions that reached the depth. */
  readonly confirmed: number;
  /** The sequences of the manifests written. */
  readonly written: readonly bigint[];
  /** Transactions posted, first uploads and reposts alike. */
  readonly posted: number;
  /** Objects not posted because the board no longer gives the bytes their CID names. */
  readonly refused: number;
  /** Contract-event evidence records written. */
  readonly evidence: number;
  /** Contract-event runs written. */
  readonly runs: number;
  /** Each contract whose source failed or gave what doesn't check, and why; its archive waits. */
  readonly eventFailures: readonly {
    readonly contract: Uint8Array;
    readonly error: ContractEventError;
  }[];
  /** The sequence the locator names, or `undefined` while no manifest meets the locator rule. */
  readonly locator: bigint | undefined;
}

/** The latest locator (docs/spec/archive.md, Locator): version 3, naming a confirmed manifest. */
export interface ArchiveLocator {
  readonly sequence: bigint;
  readonly locator: Uint8Array;
}

/**
 * Why a database that holds no chain couldn't take up the one the anchor
 * names (docs/spec/archive.md, Locator): the locator isn't a version-3 one
 * (`locator`); a manifest it reaches is another deployment's or not at the
 * sequence its link names (`foreign`), or isn't a version-3 manifest
 * (`malformed`); two links name different manifests at one sequence
 * (`conflict`); or no transaction named for a sequence is deep enough with
 * data that reads as its CID (`unavailable`), which the next run tries
 * again. Nothing is written or posted until the whole chain reads.
 */
export type ArchiveResumeErrorCode =
  | "locator"
  | "foreign"
  | "malformed"
  | "conflict"
  | "unavailable";

export class ArchiveResumeError extends Error {
  override readonly name = "ArchiveResumeError";
  readonly code: ArchiveResumeErrorCode;
  constructor(code: ArchiveResumeErrorCode, message: string) {
    super(`the anchor's archive chain can't be resumed: ${message}`);
    this.code = code;
  }
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const compareBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b);
const equal = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;

function checkOptions(o: ArchiveOptions) {
  if (typeof o.l1ChainId !== "bigint" || o.l1ChainId < 0n || o.l1ChainId >= 1n << 64n)
    throw new RangeError("l1ChainId must be a u64");
  if (!isBytes(o.anchor) || o.anchor.length !== 20) throw new TypeError("anchor must be 20 bytes");
  if (o.latestLocator !== undefined && !isBytes(o.latestLocator))
    throw new TypeError("latestLocator must be bytes or undefined");
  if (typeof o.now !== "bigint" || o.now < 0n)
    throw new RangeError("now must be a non-negative bigint");
  const depth = o.depth ?? ARCHIVE_DEPTH;
  if (!Number.isSafeInteger(depth) || depth < 1) throw new RangeError("depth must be at least 1");
  const repostAfter = o.repostAfter ?? ARCHIVE_REPOST_AFTER;
  if (typeof repostAfter !== "bigint" || repostAfter < 1n)
    throw new RangeError("repostAfter must be at least 1 second");
  const ce = o.contractEvents;
  if (ce !== undefined) {
    if (typeof ce.l2ChainId !== "bigint" || ce.l2ChainId < 0n || ce.l2ChainId >= 1n << 64n)
      throw new RangeError("l2ChainId must be a u64");
    if (ce.contracts.some((c) => !isBytes(c) || c.length !== 20))
      throw new TypeError("every contract must be 20 bytes");
    if (new Set(ce.contracts.map(hex)).size !== ce.contracts.length)
      throw new RangeError("a contract is named twice");
    const { epoch, period } = ce.clock;
    if (typeof epoch !== "bigint" || epoch < 0n || typeof period !== "bigint" || period < 1n)
      throw new RangeError("the clock needs a non-negative epoch and a period of at least 1");
    const maxPeriods = ce.maxPeriods ?? ARCHIVE_EVIDENCE_PERIODS;
    if (!Number.isSafeInteger(maxPeriods) || maxPeriods < 1)
      throw new RangeError("maxPeriods must be at least 1");
  }
  return { depth, repostAfter, maxLinks: o.maxLinks ?? MAX_MANIFEST_LINKS };
}

/**
 * Records the objects of every taken checkpoint not yet recorded: its
 * segment object and entry-hash list, each the bytes of the board's run
 * from the election's previous checkpoint's size to its own (docs/spec/
 * board.md, Segments and checkpoints). Returns how many were new.
 */
async function register(client: Sql): Promise<number> {
  const rows = await client<
    { election_id: Uint8Array; size: string; first: string; checkpoint: Uint8Array }[]
  >`
    SELECT c.election_id, c.size::text, c.first::text, c.checkpoint FROM (
      SELECT election_id, size, checkpoint,
        lag(size, 1, 0::bigint) OVER (PARTITION BY election_id ORDER BY segment) AS first
      FROM board_checkpoints) c
    WHERE NOT EXISTS (
      SELECT 1 FROM archive_objects o
      WHERE o.election_id = c.election_id AND o.size = c.size AND o.kind = 'segment')
    ORDER BY c.election_id, c.size`;
  const values = rows.flatMap((r) => {
    const first = BigInt(r.first);
    const size = BigInt(r.size);
    // Checkpoints are taken only for periods that added entries, so each one
    // is longer than the last; one that isn't names the last one's objects.
    if (size <= first) return [];
    const c = decodeCheckpoint(new Uint8Array(r.checkpoint));
    const electionId = new Uint8Array(r.election_id);
    return [
      { cid: c.object_cid, electionId, kind: "segment", first, size },
      { cid: c.hashes_cid, electionId, kind: "hashes", first, size },
    ];
  });
  if (values.length === 0) return 0;
  const inserted = await drizzle({ client })
    .insert(archiveObjects)
    .values(values)
    .onConflictDoNothing()
    .returning({ cid: archiveObjects.cid });
  return inserted.length;
}

/** What a contract's last record proved, which its next record's events are replayed from. */
interface Progress {
  readonly segment: bigint;
  readonly count: bigint;
  readonly accumulator: Uint8Array;
  readonly l2Block: bigint;
  readonly lastBlock: bigint;
  readonly lastTimestamp: bigint;
}

/** A run's encoding without its events (docs/spec/archive.md, Contract-event run, Layout (version 1)). */
const RUN_FIXED = 3 + 8 + 20 + 8 + 4;

/** What one event adds to a run's encoding. */
const eventLength = (e: RunEvent) => 8 + 8 + 4 + 32 * e.topics.length + 4 + e.data.length;

/**
 * `events`, the contract's from index `first`, as consecutive runs within
 * `MAX_RUN_EVENTS` and `MAX_CONTRACT_EVENT_RUN`, each as long as both allow
 * (docs/spec/archive.md, Contract-event run, Who writes them), so the same
 * events always split the same way.
 */
function splitRuns(
  l2ChainId: bigint,
  contract: Uint8Array,
  first: bigint,
  events: readonly RunEvent[],
): { first: bigint; count: number; run: Uint8Array; cid: Uint8Array }[] {
  const out = [];
  for (let start = 0; start < events.length;) {
    let end = start;
    let length = RUN_FIXED;
    while (end < events.length && end - start < MAX_RUN_EVENTS) {
      const e = eventLength(events[end] as RunEvent);
      if (end > start && length + e > MAX_CONTRACT_EVENT_RUN) break;
      length += e;
      end++;
    }
    const at = first + BigInt(start);
    const run = encodeContractEventRun({
      l2_chain_id: l2ChainId,
      contract,
      first: at,
      events: events.slice(start, end),
    });
    out.push({ first: at, count: end - start, run, cid: objectCid(run) });
    start = end;
  }
  return out;
}

/** What a record the writer takes proves, and its encoding. */
interface Judged {
  readonly bytes: Uint8Array;
  readonly block: bigint;
  readonly count: bigint;
  readonly accumulator: Uint8Array;
}

/**
 * The evidence check a reader applies (docs/spec/archive.md, The evidence
 * check) to the record as decoded from the bytes to be posted, with the
 * listing's block the header's own, and what the writer adds: the record is
 * canonical, at or after the period's end, and proves no lower block or
 * count than the contract's last. Returns what it proves, or `absent` for
 * a record proving the contract had no code yet while it has counted no
 * event, which moves its place on and writes nothing.
 */
function judgeEvidence(
  record: ContractEventEvidence,
  contract: Uint8Array,
  l2ChainId: bigint,
  end: bigint,
  last: Progress,
): Judged | "absent" {
  const fail = (why: string) => new ContractEventError("evidence", why);
  let bytes: Uint8Array;
  let decoded: ContractEventEvidence;
  try {
    bytes = encodeContractEventEvidence(record);
    decoded = decodeContractEventEvidence(bytes, 1);
  } catch (e) {
    throw fail(
      `it isn't a canonical version-1 record (${e instanceof Error ? e.message : String(e)})`,
    );
  }
  let block: bigint;
  try {
    block = accumulatorAtOutputRoot(
      {
        outputRoot: decoded.output_root,
        messagePasserStorageRoot: decoded.message_passer_storage_root,
        header: decoded.header,
        nodes: decoded.nodes,
      },
      contract,
    ).block;
  } catch (e) {
    if (!(e instanceof OutputRootError)) throw e;
    // A contract deployed after the first anchored period has no account
    // at that period's block; its sequence starts at genesis all the same.
    if (
      e.code === "l2-contract-absent" &&
      last.count === 0n &&
      decoded.l2_chain_id === l2ChainId &&
      equal(decoded.contract, contract)
    )
      return "absent";
    throw fail(e.code);
  }
  const check = checkContractEventEvidence(decoded, { contract, l2Block: block }, l2ChainId);
  if (!check.ok) throw fail(check.code);
  const { count, accumulator, timestamp } = check.accumulator;
  if (timestamp < end) throw fail(`its block's timestamp ${timestamp} is before ${end}`);
  if (block < last.l2Block || count < last.count)
    throw fail(`it proves less than the contract's last record`);
  return { bytes, block, count, accumulator };
}

/**
 * Whether `events`, the contract's from the last record's count, take the
 * archive from where the last record left it to `proven`, as the reader's
 * replay of the whole sequence would judge it against both
 * (`checkEventAccumulatorContinuation`; docs/spec/contracts.md, Event
 * accumulator, Verification): so a record and the runs posted with it
 * always replay, with every record before them (T-71).
 */
function replayEvents(events: readonly RunEvent[], last: Progress, proven: Judged): void {
  const fail = (why: string) => new ContractEventError("events", why);
  if (!Array.isArray(events)) throw fail("the source gave no list of events");
  let broken: string | null;
  try {
    if (events.some((e) => e.data.length > MAX_EVENT_DATA))
      throw new RangeError("an event's data is over MAX_EVENT_DATA");
    broken = checkEventAccumulatorContinuation(
      {
        accumulator: last.accumulator,
        count: last.count,
        block: last.l2Block,
        lastBlock: last.lastBlock,
        lastTimestamp: last.lastTimestamp,
      },
      events.map((e, i) => ({
        n: last.count + BigInt(i),
        block: e.l2_block,
        timestamp: e.l2_timestamp,
        topics: e.topics,
        data: e.data,
      })),
      proven,
    );
  } catch (e) {
    throw fail(`an event is no log of ours (${e instanceof Error ? e.message : String(e)})`);
  }
  if (broken !== null) throw fail(`they don't replay to the record (${broken})`);
}

/**
 * Writes each contract's evidence and runs for the anchored periods after
 * the last it examined, at most `maxPeriods` of them a run, in order: the
 * record at the first L2 block after the period's end that a respected game
 * claims, and, where its count is above the last record's, the events
 * between as runs (docs/spec/archive.md, Contract-event evidence and
 * Contract-event run, Who writes them). A period with no change moves the
 * contract's place on and writes nothing; one whose game doesn't exist yet
 * stops the contract until a later run. Returns what it wrote, and the
 * contracts whose source failed or gave what doesn't check, which write
 * nothing more this run.
 */
async function writeContractEvents(
  client: Sql,
  ce: ContractEventArchive,
): Promise<{
  evidence: number;
  runs: number;
  failures: { contract: Uint8Array; error: ContractEventError }[];
}> {
  const db = drizzle({ client });
  const anchored = await db
    .selectDistinct({ segment: boardCheckpoints.segment })
    .from(boardCheckpoints)
    .orderBy(asc(boardCheckpoints.segment));
  const maxPeriods = ce.maxPeriods ?? ARCHIVE_EVIDENCE_PERIODS;
  let evidence = 0;
  let runs = 0;
  const failures: { contract: Uint8Array; error: ContractEventError }[] = [];
  const ask = async <T>(read: () => Promise<T>) => {
    try {
      return await read();
    } catch (e) {
      throw new ContractEventError("source", e instanceof Error ? e.message : String(e));
    }
  };
  for (const contract of ce.contracts) {
    const [row] = await db
      .select()
      .from(archiveEventProgress)
      .where(eq(archiveEventProgress.contract, Uint8Array.from(contract)));
    let last: Progress = row
      ? {
          segment: row.segment,
          count: row.count,
          accumulator: new Uint8Array(row.accumulator),
          l2Block: row.l2Block,
          lastBlock: row.lastBlock,
          lastTimestamp: row.lastTimestamp,
        }
      : {
          segment: -1n,
          count: 0n,
          accumulator: eventAccumulatorGenesis(ce.l2ChainId, contract),
          l2Block: 0n,
          lastBlock: 0n,
          lastTimestamp: 0n,
        };
    const periods = anchored
      .map((r) => r.segment)
      .filter((s) => s > last.segment)
      .slice(0, maxPeriods);
    try {
      for (const segment of periods) {
        const end = ce.clock.epoch + (segment + 1n) * ce.clock.period;
        const record = await ask(() => ce.source.evidence(contract, end));
        if (record === undefined) break;
        const judged = judgeEvidence(record, contract, ce.l2ChainId, end, last);
        if (judged === "absent") {
          await db
            .insert(archiveEventProgress)
            .values({ contract: Uint8Array.from(contract), ...last, segment })
            .onConflictDoUpdate({ target: archiveEventProgress.contract, set: { segment } });
          last = { ...last, segment };
          continue;
        }
        const proven = judged;
        // A record is listed with all its runs, in one manifest, so a span
        // more runs than that would need is refused before it is fetched.
        if (proven.count - last.count > BigInt(MAX_MANIFEST_RUNS * MAX_RUN_EVENTS))
          throw new ContractEventError("runs", "its events need more runs than a manifest lists");
        // The same count again: `replayEvents` with no event holds it to
        // the last record's accumulator and blocks.
        if (proven.count === last.count)
          try {
            replayEvents([], last, proven);
          } catch {
            throw new ContractEventError(
              "evidence",
              "it proves another accumulator at the last record's count",
            );
          }
        let next: Progress = { ...last, segment, l2Block: proven.block };
        let written: ReturnType<typeof splitRuns> = [];
        if (proven.count > last.count) {
          const events = await ask(() => ce.source.events(contract, last.count, proven.count));
          replayEvents(events, last, proven);
          written = splitRuns(ce.l2ChainId, contract, last.count, events);
          // A record is listed with its runs, in one manifest.
          if (written.length > MAX_MANIFEST_RUNS)
            throw new ContractEventError("runs", `${written.length} runs for one record`);
          const final = events.at(-1) as RunEvent;
          next = {
            segment,
            count: proven.count,
            accumulator: proven.accumulator,
            l2Block: proven.block,
            lastBlock: final.l2_block,
            lastTimestamp: final.l2_timestamp,
          };
        }
        const cid = objectCid(proven.bytes);
        await db.transaction(async (tx) => {
          if (written.length > 0) {
            await tx.insert(archiveEvidence).values({
              cid,
              contract: Uint8Array.from(contract),
              segment,
              l2Block: proven.block,
              count: proven.count,
              record: proven.bytes,
            });
            await tx
              .insert(archiveRuns)
              .values(
                written.map((r) => ({ ...r, contract: Uint8Array.from(contract), evidence: cid })),
              );
          }
          await tx
            .insert(archiveEventProgress)
            .values({ contract: Uint8Array.from(contract), ...next })
            .onConflictDoUpdate({ target: archiveEventProgress.contract, set: next });
        });
        if (written.length > 0) {
          evidence++;
          runs += written.length;
        }
        last = next;
      }
    } catch (e) {
      if (!(e instanceof ContractEventError)) throw e;
      failures.push({ contract, error: e });
    }
  }
  return { evidence, runs, failures };
}

interface ObjectRow {
  readonly cid: Uint8Array;
  readonly electionId: Uint8Array;
  readonly kind: string;
  readonly first: bigint;
  readonly size: bigint;
}

/**
 * An object's bytes, read again from the board: the run's encoded entries,
 * or their entry hashes, concatenated. `undefined` unless they are the bytes
 * its CID names, so nothing but what its checkpoint names is ever posted
 * (T-23).
 */
async function objectBytes(client: Sql, o: ObjectRow): Promise<Uint8Array | undefined> {
  const entries = await readBoardRange(client, o.electionId, o.first, o.size);
  const parts = o.kind === "segment" ? entries : entries.map(boardEntryHash);
  const bytes = new Uint8Array(Buffer.concat(parts));
  return equal(objectCid(bytes), o.cid) ? bytes : undefined;
}

/** The most an object's bytes can be: an entry is 51 bytes and its payload, a hash 32 (docs/spec/archive.md, The listed objects). */
function objectBound(o: ObjectRow): number {
  const n = o.size - o.first;
  const bound = o.kind === "segment" ? n * BigInt(51 + MAX_BOARD_PAYLOAD) : n * 32n;
  return bound > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bound);
}

/** A manifest is one raw block of at most 1 MiB (docs/spec/archive.md, Archive manifest). */
const MANIFEST_BOUND = 1 << 20;

/** The CAR of an object of `bound` bytes is at most this long (docs/spec/archive.md, The listed objects, step 2). */
const carLimit = (bound: number) =>
  Math.min(Number.MAX_SAFE_INTEGER, bound + 59 + 256 * Math.max(1, Math.ceil(bound / 2 ** 20)));

interface Chain {
  readonly manifests: ChainManifest[];
  readonly cids: Uint8Array[];
  /** Each listed object's, record's and run's CID, by hex, with the lowest sequence listing it. */
  readonly listed: Map<string, bigint>;
}

/**
 * Reads back the chain the anchor's locator names, from that manifest down
 * through its links, and records it: every manifest from 0 to the named one,
 * the transaction each was read from and the transactions its objects are
 * listed under, all confirmed, so nothing listed is posted again. A manifest
 * is read only from a transaction at `depth` whose data reads as its CID, as
 * `confirm` counts one, and the walk follows the verifier's (docs/spec/
 * archive.md, The chain from a locator): the first link to a sequence fixes
 * its CID, and a later link naming it under another transaction is tried
 * while it is still unread. The locator rule (Who writes them) makes the
 * named manifest reach every one below it, so an honest chain reads whole;
 * otherwise nothing is recorded. Manifests the lost database wrote above the
 * named one are left behind: no locator named them, so no reader is sent to
 * them, and their sequences are written again. Returns how many it recorded.
 */
async function resume(
  client: Sql,
  arweave: ArweaveClient,
  latestLocator: Uint8Array,
  o: Pick<ArchiveOptions, "l1ChainId" | "anchor" | "now">,
  depth: number,
): Promise<number> {
  const named = decodeArchiveLocator(latestLocator, [3]);
  if (named.kind !== "manifest")
    throw new ArchiveResumeError(
      "locator",
      `its locator isn't one this worker writes (${named.kind})`,
    );
  let reads = 0;
  const read = async (cid: Uint8Array, transaction: Uint8Array) => {
    if (++reads > ARCHIVE_RESUME_READS)
      throw new ArchiveResumeError("unavailable", `over ${ARCHIVE_RESUME_READS} reads`);
    const n = await arweave.confirmations(transaction);
    if (n === undefined) return undefined;
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error("the Arweave client gave a depth below 1");
    if (n < depth) return undefined;
    const data = await arweave.data(transaction, carLimit(MANIFEST_BOUND));
    if (data === undefined) return undefined;
    const r = readArchivedObject(data, cid, MANIFEST_BOUND);
    return r.ok ? r.bytes : undefined;
  };
  const decode = (bytes: Uint8Array, cid: Uint8Array): ArchiveManifest => {
    try {
      return decodeArchiveManifest(bytes, 3);
    } catch {
      throw new ArchiveResumeError("malformed", `${cidText(cid)} isn't a version-3 manifest`);
    }
  };
  const top = await read(named.manifest, named.transaction);
  if (top === undefined)
    throw new ArchiveResumeError(
      "unavailable",
      `the locator's manifest ${cidText(named.manifest)}`,
    );
  const latest = decode(top, named.manifest);

  const held = new Map<bigint, { cid: Uint8Array; transaction: Uint8Array; bytes: Uint8Array }>();
  // Each sequence's CID, as its first link names it.
  const cidAt = new Map<bigint, Uint8Array>();
  const queue: { sequence: bigint; cid: Uint8Array; transaction: Uint8Array }[] = [];
  const hold = (
    sequence: bigint,
    cid: Uint8Array,
    transaction: Uint8Array,
    bytes: Uint8Array,
    m: ArchiveManifest,
  ) => {
    if (m.sequence !== sequence || m.l1_chain_id !== o.l1ChainId || !equal(m.anchor, o.anchor))
      throw new ArchiveResumeError(
        "foreign",
        `${cidText(cid)} isn't this deployment's manifest ${sequence}`,
      );
    held.set(sequence, { cid, transaction, bytes });
    for (const l of m.links) {
      const fixed = cidAt.get(l.sequence);
      if (fixed !== undefined && !equal(fixed, l.cid))
        throw new ArchiveResumeError("conflict", `two manifests are linked at ${l.sequence}`);
      cidAt.set(l.sequence, l.cid);
      if (!held.has(l.sequence)) queue.push(l);
    }
  };
  cidAt.set(latest.sequence, named.manifest);
  hold(latest.sequence, named.manifest, named.transaction, top, latest);
  const tried = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const { sequence, cid, transaction } = queue[i] as (typeof queue)[number];
    if (held.has(sequence) || tried.has(hex(transaction))) continue;
    tried.add(hex(transaction));
    const bytes = await read(cid, transaction);
    if (bytes !== undefined) hold(sequence, cid, transaction, bytes, decode(bytes, cid));
  }
  for (let k = 0n; k <= latest.sequence; k++)
    if (!held.has(k))
      throw new ArchiveResumeError("unavailable", `no linked transaction serves manifest ${k}`);

  const chain = [...held.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  await drizzle({ client }).transaction(async (tx) => {
    for (const [sequence, h] of chain) {
      await tx.insert(archiveManifests).values({ sequence, cid: h.cid, manifest: h.bytes });
      const m = decodeArchiveManifest(h.bytes, 3);
      // Evidence and runs too, so a resumed database never posts them again.
      const rows = [h, ...m.objects, ...m.evidence, ...m.runs].map((x) => ({
        transaction: x.transaction,
        cid: x.cid,
      }));
      await tx
        .insert(archiveTransactions)
        .values(rows.map((r) => ({ ...r, postedAt: o.now, confirmed: true })))
        .onConflictDoNothing();
    }
  });
  return chain.length;
}

/** The manifest chain as written, each manifest's links read from its own bytes. */
async function readChain(
  client: Sql,
  confirmed: ReadonlyMap<string, Uint8Array>,
  o: Pick<ArchiveOptions, "l1ChainId" | "anchor">,
): Promise<Chain> {
  const rows = await drizzle({ client })
    .select()
    .from(archiveManifests)
    .orderBy(asc(archiveManifests.sequence));
  const manifests: ChainManifest[] = [];
  const cids: Uint8Array[] = [];
  const listed = new Map<string, bigint>();
  for (const [k, r] of rows.entries()) {
    if (r.sequence !== BigInt(k)) throw new Error(`the manifest chain has no manifest ${k}`);
    const m = decodeArchiveManifest(new Uint8Array(r.manifest), 3);
    // A reader takes another deployment's manifest as foreign, so linking
    // one would cut the chain (`manifest-foreign`, then `archive-gap`).
    if (m.sequence !== r.sequence || m.l1_chain_id !== o.l1ChainId || !equal(m.anchor, o.anchor))
      throw new Error(`manifest ${k} isn't this deployment's at its sequence`);
    manifests.push({
      links: m.links.map((l) => Number(l.sequence)),
      confirmed: confirmed.has(hex(r.cid)),
    });
    cids.push(new Uint8Array(r.cid));
    for (const x of [...m.objects, ...m.evidence, ...m.runs])
      if (!listed.has(hex(x.cid))) listed.set(hex(x.cid), r.sequence);
  }
  return { manifests, cids, listed };
}

/** Each confirmed CID's transaction: the first posted of those that confirmed. */
async function confirmedTransactions(client: Sql): Promise<Map<string, Uint8Array>> {
  const rows = await drizzle({ client })
    .select({ cid: archiveTransactions.cid, transaction: archiveTransactions.transaction })
    .from(archiveTransactions)
    .where(eq(archiveTransactions.confirmed, true))
    .orderBy(asc(archiveTransactions.postedAt), asc(archiveTransactions.transaction));
  const out = new Map<string, Uint8Array>();
  for (const r of rows)
    if (!out.has(hex(r.cid))) out.set(hex(r.cid), new Uint8Array(r.transaction));
  return out;
}

/**
 * Asks the client how deep each unconfirmed transaction is whose CID has no
 * confirmed one, and marks confirmed those at `depth` whose data a node
 * serves and reads as their CID (docs/spec/archive.md, Archived objects): a
 * header can be mined without its data, and a confirmed transaction may be
 * listed, linked and named for good (T-51). Returns how many it marked, and
 * the transactions in some block whose data may yet arrive, which are left
 * to deepen rather than posted again; one at depth whose data doesn't read
 * is posted again once `repostAfter` has passed.
 */
async function confirm(
  client: Sql,
  arweave: ArweaveClient,
  depth: number,
  bounds: ReadonlyMap<string, number>,
): Promise<{ confirmed: number; mined: Set<string> }> {
  const db = drizzle({ client });
  const done = await confirmedTransactions(client);
  const pending = await db
    .select({ transaction: archiveTransactions.transaction, cid: archiveTransactions.cid })
    .from(archiveTransactions)
    .where(eq(archiveTransactions.confirmed, false));
  let confirmed = 0;
  const mined = new Set<string>();
  for (const { transaction, cid } of pending) {
    if (done.has(hex(cid))) continue;
    const n = await arweave.confirmations(new Uint8Array(transaction));
    if (n === undefined) continue;
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error("the Arweave client gave a depth below 1");
    if (n < depth) {
      mined.add(hex(transaction));
      continue;
    }
    const bound = bounds.get(hex(cid));
    if (bound === undefined)
      throw new Error(`a transaction for ${cidText(cid)}, which nothing archives`);
    const data = await arweave.data(new Uint8Array(transaction), carLimit(bound));
    if (data === undefined || !readArchivedObject(data, cid, bound).ok) continue;
    await db
      .update(archiveTransactions)
      .set({ confirmed: true })
      .where(eq(archiveTransactions.transaction, transaction));
    done.set(hex(cid), new Uint8Array(transaction));
    confirmed++;
  }
  return { confirmed, mined };
}

/** A record and its runs, listed together in one manifest. */
interface EvidenceGroup {
  readonly evidence: Omit<EvidenceRef, "transaction">;
  readonly runs: readonly Omit<RunRef, "transaction">[];
}

/**
 * The records and runs not yet listed, each record with its runs. A record
 * or run a resumed manifest already lists, written again after a wipe, is
 * marked as listed there rather than listed twice; a record is due once it
 * and every run of it has confirmed.
 */
async function waitingGroups(
  client: Sql,
  chain: Chain,
  confirmed: ReadonlyMap<string, Uint8Array>,
): Promise<EvidenceGroup[]> {
  const db = drizzle({ client });
  const records = await db
    .select({
      cid: archiveEvidence.cid,
      contract: archiveEvidence.contract,
      l2Block: archiveEvidence.l2Block,
    })
    .from(archiveEvidence)
    .where(isNull(archiveEvidence.listedIn))
    .orderBy(asc(archiveEvidence.contract), asc(archiveEvidence.count));
  const groups: EvidenceGroup[] = [];
  for (const e of records) {
    const runs = await db
      .select({
        cid: archiveRuns.cid,
        contract: archiveRuns.contract,
        first: archiveRuns.first,
        count: archiveRuns.count,
        listedIn: archiveRuns.listedIn,
      })
      .from(archiveRuns)
      .where(eq(archiveRuns.evidence, e.cid))
      .orderBy(asc(archiveRuns.first));
    const at = chain.listed.get(hex(e.cid));
    if (at !== undefined) {
      await db.update(archiveEvidence).set({ listedIn: at }).where(eq(archiveEvidence.cid, e.cid));
      for (const r of runs) {
        const runAt = chain.listed.get(hex(r.cid));
        if (r.listedIn === null && runAt !== undefined)
          await db.update(archiveRuns).set({ listedIn: runAt }).where(eq(archiveRuns.cid, r.cid));
      }
      continue;
    }
    if (!confirmed.has(hex(e.cid)) || runs.some((r) => !confirmed.has(hex(r.cid)))) continue;
    groups.push({
      evidence: {
        contract: new Uint8Array(e.contract),
        l2_block: e.l2Block,
        cid: new Uint8Array(e.cid),
      },
      runs: runs.map((r) => ({
        contract: new Uint8Array(r.contract),
        first: r.first,
        count: r.count,
        cid: new Uint8Array(r.cid),
      })),
    });
  }
  return groups;
}

/** A manifest's evidence order (docs/spec/archive.md, Layout (version 2)): contract, block, CID. */
const evidenceOrder = (a: EvidenceRef, b: EvidenceRef) =>
  compareBytes(a.contract, b.contract) ||
  (a.l2_block < b.l2_block ? -1 : a.l2_block > b.l2_block ? 1 : 0) ||
  compareBytes(a.cid, b.cid);

/** A manifest's run order (Layout (version 3)): contract, first, CID. */
const runOrder = (a: RunRef, b: RunRef) =>
  compareBytes(a.contract, b.contract) ||
  (a.first < b.first ? -1 : a.first > b.first ? 1 : 0) ||
  compareBytes(a.cid, b.cid);

/**
 * Writes manifests while confirmed objects or records wait to be listed, or
 * every manifest has confirmed but no locator names the latest, each linking
 * the roots `nextManifestLinks` gives (docs/spec/archive.md, Who writes
 * them). Everything is listed by the transaction that confirmed first, at
 * most `MAX_MANIFEST_OBJECTS` objects, `MAX_MANIFEST_EVIDENCE` records and
 * `MAX_MANIFEST_RUNS` runs a manifest, each record beside its runs, in the
 * orders the layout requires.
 */
async function writeManifests(
  client: Sql,
  chain: Chain,
  confirmed: ReadonlyMap<string, Uint8Array>,
  o: ArchiveOptions,
  maxLinks: number,
): Promise<bigint[]> {
  const db = drizzle({ client });
  const unlisted = await db
    .select({ cid: archiveObjects.cid })
    .from(archiveObjects)
    .where(isNull(archiveObjects.listedIn));
  // An object a resumed manifest already lists, registered again from the
  // rebuilt board, is marked as listed there rather than listed twice.
  for (const r of unlisted) {
    const at = chain.listed.get(hex(r.cid));
    if (at !== undefined)
      await db.update(archiveObjects).set({ listedIn: at }).where(eq(archiveObjects.cid, r.cid));
  }
  const waiting = unlisted
    .map((r) => new Uint8Array(r.cid))
    .filter((cid) => confirmed.has(hex(cid)) && !chain.listed.has(hex(cid)))
    .sort(compareBytes);
  const groups = await waitingGroups(client, chain, confirmed);
  const written: bigint[] = [];
  const txOf = (cid: Uint8Array) => {
    const t = confirmed.get(hex(cid));
    // Only confirmed manifests are linked and only confirmed objects listed.
    if (t === undefined) throw new Error(`no confirmed transaction for ${cidText(cid)}`);
    return t;
  };
  let at = 0;
  let g = 0;
  while (at < waiting.length || g < groups.length || needsLinkingManifest(chain.manifests)) {
    const objects = waiting.slice(at, at + MAX_MANIFEST_OBJECTS);
    at += objects.length;
    const taken: EvidenceGroup[] = [];
    let runCount = 0;
    while (g < groups.length && taken.length < MAX_MANIFEST_EVIDENCE) {
      const next = groups[g] as EvidenceGroup;
      // Written within the bound (`writeContractEvents`), so only a row
      // written by another hand can be over it, and never fits a manifest.
      if (next.runs.length > MAX_MANIFEST_RUNS)
        throw new Error(`${cidText(next.evidence.cid)} has more runs than a manifest lists`);
      if (runCount + next.runs.length > MAX_MANIFEST_RUNS) break;
      taken.push(next);
      runCount += next.runs.length;
      g++;
    }
    const evidence = taken
      .map((t) => ({ ...t.evidence, transaction: txOf(t.evidence.cid) }))
      .sort(evidenceOrder);
    const runs = taken
      .flatMap((t) => t.runs.map((r) => ({ ...r, transaction: txOf(r.cid) })))
      .sort(runOrder);
    const links = nextManifestLinks(chain.manifests, maxLinks);
    const sequence = BigInt(chain.manifests.length);
    const manifest = encodeArchiveManifest(
      {
        l1_chain_id: o.l1ChainId,
        anchor: o.anchor,
        sequence,
        objects: objects.map((cid) => ({ cid, transaction: txOf(cid) })),
        links: links.map((s) => {
          const cid = chain.cids[s] as Uint8Array;
          return { sequence: BigInt(s), cid, transaction: txOf(cid) };
        }),
        evidence,
        runs,
      },
      3,
    );
    const cid = objectCid(manifest);
    await db.transaction(async (tx) => {
      await tx.insert(archiveManifests).values({ sequence, cid, manifest });
      // The lock keeps every other run out, so nothing else lists them.
      const check = (n: number, of: number, what: string) => {
        if (n !== of) throw new Error(`${what} were listed under another manifest`);
      };
      if (objects.length > 0) {
        const listed = await tx
          .update(archiveObjects)
          .set({ listedIn: sequence })
          .where(and(inArray(archiveObjects.cid, objects), isNull(archiveObjects.listedIn)))
          .returning({ cid: archiveObjects.cid });
        check(listed.length, objects.length, "objects");
      }
      if (evidence.length > 0) {
        const listed = await tx
          .update(archiveEvidence)
          .set({ listedIn: sequence })
          .where(
            and(
              inArray(
                archiveEvidence.cid,
                evidence.map((e) => e.cid),
              ),
              isNull(archiveEvidence.listedIn),
            ),
          )
          .returning({ cid: archiveEvidence.cid });
        check(listed.length, evidence.length, "records");
        const listedRuns = await tx
          .update(archiveRuns)
          .set({ listedIn: sequence })
          .where(
            and(
              inArray(
                archiveRuns.cid,
                runs.map((r) => r.cid),
              ),
              isNull(archiveRuns.listedIn),
            ),
          )
          .returning({ cid: archiveRuns.cid });
        check(listedRuns.length, runs.length, "runs");
      }
    });
    chain.manifests.push({ links, confirmed: false });
    chain.cids.push(cid);
    for (const x of [...objects, ...evidence.map((e) => e.cid), ...runs.map((r) => r.cid)])
      chain.listed.set(hex(x), sequence);
    written.push(sequence);
  }
  return written;
}

/**
 * Posts every manifest, record, run and object with no confirmed transaction and none
 * still live: in a block, or posted less than `repostAfter` ago. A repost
 * carries the same bytes, so the CID a manifest lists or links never changes
 * (docs/spec/archive.md, Who writes them). Returns how many it posted.
 */
async function post(
  client: Sql,
  arweave: ArweaveClient,
  confirmed: ReadonlyMap<string, Uint8Array>,
  mined: ReadonlySet<string>,
  now: bigint,
  repostAfter: bigint,
): Promise<{ posted: number; refused: number }> {
  const db = drizzle({ client });
  const unconfirmed = await db
    .select({
      cid: archiveTransactions.cid,
      transaction: archiveTransactions.transaction,
      postedAt: archiveTransactions.postedAt,
    })
    .from(archiveTransactions)
    .where(eq(archiveTransactions.confirmed, false));
  const live = new Set(confirmed.keys());
  for (const t of unconfirmed)
    if (mined.has(hex(t.transaction)) || now - t.postedAt < repostAfter) live.add(hex(t.cid));

  let posted = 0;
  const send = async (cid: Uint8Array, bytes: Uint8Array) => {
    const transaction = await arweave.post(objectCar(bytes));
    if (!isBytes(transaction) || transaction.length !== 32)
      throw new Error("the Arweave client gave a transaction ID that isn't 32 bytes");
    await db.insert(archiveTransactions).values({ transaction, cid, postedAt: now });
    posted++;
  };
  // Manifests first, so an object that can't be posted never holds up the
  // chain the locator names.
  const manifests = await db
    .select()
    .from(archiveManifests)
    .orderBy(asc(archiveManifests.sequence));
  for (const m of manifests)
    if (!live.has(hex(m.cid))) await send(m.cid, new Uint8Array(m.manifest));
  // Records and runs were checked when written and are posted as stored,
  // each read only when due: a run is up to 16 MiB.
  const records = await db
    .select({ cid: archiveEvidence.cid })
    .from(archiveEvidence)
    .orderBy(asc(archiveEvidence.cid));
  for (const { cid } of records) {
    if (live.has(hex(cid))) continue;
    const [row] = await db
      .select({ bytes: archiveEvidence.record })
      .from(archiveEvidence)
      .where(eq(archiveEvidence.cid, cid));
    // Rows are never deleted (0048's triggers).
    if (row !== undefined) await send(cid, new Uint8Array(row.bytes));
  }
  const runs = await db
    .select({ cid: archiveRuns.cid })
    .from(archiveRuns)
    .orderBy(asc(archiveRuns.cid));
  for (const { cid } of runs) {
    if (live.has(hex(cid))) continue;
    const [row] = await db
      .select({ bytes: archiveRuns.run })
      .from(archiveRuns)
      .where(eq(archiveRuns.cid, cid));
    if (row !== undefined) await send(cid, new Uint8Array(row.bytes));
  }
  let refused = 0;
  const objects = await db.select().from(archiveObjects).orderBy(asc(archiveObjects.cid));
  for (const o of objects) {
    if (live.has(hex(o.cid))) continue;
    const bytes = await objectBytes(client, o);
    // Reported, never posted: the stored checkpoint and the board disagree,
    // which the anchoring job's checks are the place to judge (T-23).
    if (bytes === undefined) refused++;
    else await send(o.cid, bytes);
  }
  return { posted, refused };
}

function locatorOf(
  chain: Chain,
  confirmed: ReadonlyMap<string, Uint8Array>,
): ArchiveLocator | undefined {
  const m = locatorManifest(chain.manifests);
  if (m === undefined) return undefined;
  const cid = chain.cids[m] as Uint8Array;
  return {
    sequence: BigInt(m),
    locator: encodeArchiveLocator(cid, confirmed.get(hex(cid)) as Uint8Array, 3),
  };
}

/**
 * One archive run: takes up the anchor's chain if the database holds none
 * (`resume`), records the objects of new checkpoints, writes the contracts'
 * evidence and runs for the anchored periods due, confirms the
 * transactions that reached `depth`, writes the manifests that are due,
 * posts what has no live upload, and reports the sequence the locator names.
 * Throws if Arweave or the database fails; what was done before stays done,
 * and the next run takes up from there.
 */
export async function archiveBoards(
  client: Sql,
  arweave: ArweaveClient,
  options: ArchiveOptions,
): Promise<ArchiveRun> {
  const { depth, repostAfter, maxLinks } = checkOptions(options);
  const run = await withSessionLock(client, "archive_writer", async () => {
    const db = drizzle({ client });
    const [first] = await db
      .select({ sequence: archiveManifests.sequence })
      .from(archiveManifests)
      .limit(1);
    const resumed =
      first === undefined && options.latestLocator !== undefined
        ? await resume(client, arweave, options.latestLocator, options, depth)
        : 0;
    const registered = await register(client);
    const events =
      options.contractEvents === undefined
        ? { evidence: 0, runs: 0, failures: [] }
        : await writeContractEvents(client, options.contractEvents);
    const bounds = new Map<string, number>();
    for (const o of await db.select().from(archiveObjects)) bounds.set(hex(o.cid), objectBound(o));
    for (const e of await db.select({ cid: archiveEvidence.cid }).from(archiveEvidence))
      bounds.set(hex(e.cid), MAX_EVIDENCE_RECORD);
    for (const r of await db
      .select({ cid: archiveRuns.cid, count: archiveRuns.count })
      .from(archiveRuns))
      bounds.set(hex(r.cid), runBound(r.count));
    for (const m of await db.select({ cid: archiveManifests.cid }).from(archiveManifests))
      bounds.set(hex(m.cid), MANIFEST_BOUND);
    const { confirmed, mined } = await confirm(client, arweave, depth, bounds);
    const held = await confirmedTransactions(client);
    const chain = await readChain(client, held, options);
    const written = await writeManifests(client, chain, held, options, maxLinks);
    const { posted, refused } = await post(client, arweave, held, mined, options.now, repostAfter);
    return {
      busy: false,
      resumed,
      registered,
      confirmed,
      written,
      posted,
      refused,
      evidence: events.evidence,
      runs: events.runs,
      eventFailures: events.failures,
      locator: locatorOf(chain, held)?.sequence,
    };
  });
  return (
    run ?? {
      busy: true,
      resumed: 0,
      registered: 0,
      confirmed: 0,
      written: [],
      posted: 0,
      refused: 0,
      evidence: 0,
      runs: 0,
      eventFailures: [],
      locator: undefined,
    }
  );
}

/**
 * The sequence of this database's manifest `cid`, or `undefined` if it holds
 * none by that CID: whether a locator the anchor holds names our own chain.
 */
export async function archiveManifestSequence(
  client: Sql,
  cid: Uint8Array,
): Promise<bigint | undefined> {
  if (!isBytes(cid)) throw new TypeError("cid must be bytes");
  const [row] = await drizzle({ client })
    .select({ sequence: archiveManifests.sequence })
    .from(archiveManifests)
    .where(eq(archiveManifests.cid, Uint8Array.from(cid)))
    .limit(1);
  return row?.sequence;
}

/**
 * The locator the anchoring calls carry: version 3, naming the highest
 * confirmed manifest that reaches every manifest before it and the
 * transaction that confirmed it first, or `undefined` while none does.
 */
export async function archiveLocator(
  client: Sql,
  deployment: Pick<ArchiveOptions, "l1ChainId" | "anchor">,
): Promise<ArchiveLocator | undefined> {
  const held = await confirmedTransactions(client);
  return locatorOf(await readChain(client, held, deployment), held);
}
