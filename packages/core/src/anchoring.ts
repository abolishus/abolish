// Anchoring the boards on L1 (docs/spec/board.md, Segments and checkpoints;
// docs/spec/contracts.md, Board anchor; P4-1). After each anchoring period
// ends, the job takes every board's checkpoint for it from the board's own
// bytes, with the verifier's copyCheckpoints, so what is anchored is what a
// verifier recomputes (T-23), and stores it, which fences the segment: no
// entry is boarded at or below it afterwards (T-24). Then it sends each
// election's taken checkpoints that the anchor doesn't hold yet, while they
// are timely. The chain is behind `AnchorChain`; core decides what to send.

import {
  type Checkpoint,
  checkpointHash,
  copyCheckpoints,
  decodeCheckpoint,
  decodeElectionDefinition,
  encodeBoardEntry,
  encodeCheckpoint,
} from "@abolishus/crypto";
import { and, asc, desc, eq, gt, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { listBoards } from "./audit.ts";
import { lockBoard, pinnedBoardVersion, readBoard } from "./board.ts";
import { isBytes } from "./bytes.ts";
import { readDefinition } from "./definitions.ts";
import { boardCheckpoints, boardEntries } from "./db/schema/index.ts";

const MAX_SEGMENT = 2 ** 32 - 1;

function checkId(electionId: Uint8Array): Uint8Array {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  return new Uint8Array(electionId);
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Takes `electionId`'s checkpoint for every period after the last one taken,
 * up to `through`, that added entries, stores them, and returns them in
 * segment order. A period without entries gets none: the spec lets it be
 * skipped, and anchoring it would repeat the board's state. The caller
 * passes only ended periods (by L1 time, which the anchor judges), so
 * no entry of the period is still to come except one labelled by a lagging
 * clock, which the stored checkpoint now fences off: appendEntry refuses it,
 * or labels it later when asked to. `through` of -1 takes nothing.
 *
 * The board is read and the checkpoints stored under the board lock, so no
 * append lands between them. When a period to take has entries, the whole
 * board up to `through` is read into memory, as the audit reads it;
 * otherwise only the segments are.
 */
export async function takeCheckpoints(
  client: Sql,
  electionId: Uint8Array,
  through: number,
): Promise<Checkpoint[]> {
  const id = checkId(electionId);
  if (!Number.isInteger(through) || through < -1 || through > MAX_SEGMENT)
    throw new RangeError("through must be a u32 or -1");
  if (through === -1) return [];
  return drizzle({ client }).transaction(
    async (tx) => {
      await lockBoard(tx, id);
      const [last] = await tx
        .select({ segment: boardCheckpoints.segment })
        .from(boardCheckpoints)
        .where(eq(boardCheckpoints.electionId, id))
        .orderBy(desc(boardCheckpoints.segment))
        .limit(1);
      const after = last === undefined ? -1n : last.segment;
      if (BigInt(through) <= after) return [];
      const fresh = await tx
        .selectDistinct({ segment: boardEntries.segment })
        .from(boardEntries)
        .where(
          and(
            eq(boardEntries.electionId, id),
            gt(boardEntries.segment, after),
            lte(boardEntries.segment, BigInt(through)),
          ),
        )
        .orderBy(asc(boardEntries.segment));
      if (fresh.length === 0) return [];
      const segments = fresh.map((r) => Number(r.segment));
      // Segments never decrease along the board, so the entries with a
      // segment up to `through` are a prefix of it.
      const rows = await tx
        .select({
          idx: boardEntries.idx,
          segment: boardEntries.segment,
          payload: boardEntries.payload,
        })
        .from(boardEntries)
        .where(and(eq(boardEntries.electionId, id), lte(boardEntries.segment, BigInt(through))))
        .orderBy(asc(boardEntries.idx));
      const version = await pinnedBoardVersion(tx, id);
      if (typeof version === "string") throw new Error(`a stored board has ${version}`);
      const entries = rows.map((r) =>
        encodeBoardEntry(
          {
            election_id: id,
            index: r.idx,
            segment: Number(r.segment),
            payload: new Uint8Array(r.payload),
          },
          version,
        ),
      );
      const bySegment = copyCheckpoints(id, entries, segments);
      const taken = segments.map((s) => {
        const checkpoint = bySegment.get(s);
        // Each segment here has entries, so the board up to it is non-empty.
        if (checkpoint === undefined) throw new Error(`no checkpoint for segment ${s}`);
        return checkpoint;
      });
      await tx.insert(boardCheckpoints).values(
        taken.map((c) => ({
          electionId: id,
          segment: BigInt(c.segment),
          size: c.size,
          checkpoint: encodeCheckpoint(c),
        })),
      );
      return taken;
    },
    // The board must be read after the lock is taken (as in appendEntry).
    { isolationLevel: "read committed" },
  );
}

/** `electionId`'s taken checkpoints with a segment of at least `from`, in segment order. */
export async function readCheckpoints(
  client: Sql,
  electionId: Uint8Array,
  from = 0,
): Promise<Checkpoint[]> {
  const id = checkId(electionId);
  if (!Number.isInteger(from) || from < 0) throw new RangeError("from must be a u32");
  if (from > MAX_SEGMENT) return [];
  const rows = await drizzle({ client })
    .select({ checkpoint: boardCheckpoints.checkpoint })
    .from(boardCheckpoints)
    .where(and(eq(boardCheckpoints.electionId, id), gt(boardCheckpoints.segment, BigInt(from - 1))))
    .orderBy(asc(boardCheckpoints.segment));
  return rows.map((r) => decodeCheckpoint(new Uint8Array(r.checkpoint)));
}

/** The anchor contract's immutable clock (docs/spec/board.md, Timing). */
export interface AnchoringClock {
  readonly epoch: bigint;
  readonly period: bigint;
  readonly deadline: bigint;
}

/**
 * The anchor contract the job sends through, and the L1 node it reads. Its
 * reads are of the node's latest block: the anchor refuses a second
 * checkpoint for a slot, so that is the state the next call meets. An
 * anchor in a block later reorganised away reads as absent again and is
 * sent again.
 */
export interface AnchorChain {
  /** The L1's EIP-155 chain ID. */
  readonly chainId: bigint;
  /** The anchor's 20-byte address. */
  readonly address: Uint8Array;
  /** The anchor's clock, as its deployment fixed it. */
  readonly clock: AnchoringClock;
  /** The latest block's timestamp. */
  now(): Promise<bigint>;
  /** The checkpoint hash the anchor holds for the election and segment, or `undefined` for none. */
  anchored(electionId: Uint8Array, segment: number): Promise<Uint8Array | undefined>;
  /**
   * One `anchor` call carrying `checkpoints` (one election's, in segment
   * order) and no locator, from the anchoring authority. Resolves once it is
   * included; throws if it wasn't sent or reverted.
   */
  anchor(checkpoints: readonly Checkpoint[]): Promise<void>;
}

export type AnchorFindingCode =
  /** The definition names another anchor or L1: this job can't anchor the election (T-52). */
  | "anchor-unserved"
  /**
   * The anchor holds another checkpoint for a segment taken here: the
   * board was rolled back or forked after anchoring, or the authority's key
   * anchored without this job. The election fails on it (T-24, T-69).
   */
  | "anchor-conflict"
  /**
   * A taken checkpoint isn't the one the stored board gives now: the row was
   * written around takeCheckpoints, or the board was. Nothing of the
   * election is sent, so a database write never becomes an anchor (T-23).
   */
  | "anchor-mismatch"
  /**
   * The L1 node's latest block is further ahead of the worker's clock than
   * `MAX_L1_CLOCK_LEAD`: periods are taken only as far as the worker's
   * clock allows, so a node reporting a time ahead can't fence a period
   * still running and push ballots into later segments (T-25).
   */
  | "anchor-clock"
  /** The run failed for this board before it finished (its error isn't kept); the next run retries it. */
  | "anchor-error"
  /** The anchor call failed; the checkpoints are sent again next run while timely. */
  | "anchor-send-failed"
  /** A checkpoint is still unanchored past half its deadline (T-49). */
  | "anchor-overdue"
  /**
   * A checkpoint's deadline passed with it unanchored: its entries can't be
   * anchored any more, so the election fails (T-49). Reported for one
   * deadline after it.
   */
  | "anchor-missed";

export interface AnchorFinding {
  readonly code: AnchorFindingCode;
  /** The election it concerns; absent for `anchor-clock`. */
  readonly electionId?: Uint8Array;
  /** The segment it concerns; absent for `anchor-unserved`, `anchor-error`, `anchor-send-failed` and `anchor-clock`. */
  readonly segment?: number;
}

/** How far, in seconds, the L1 node's latest block may lead the worker's clock before it is distrusted. */
export const MAX_L1_CLOCK_LEAD = 120n;

/**
 * How long, in seconds, a call may take to be included. A checkpoint whose
 * window closes sooner than this goes in a call of its own, so if it lands
 * too late and reverts, it holds back none of its election's others.
 */
export const ANCHOR_INCLUSION_MARGIN = 600n;

export interface AnchorReport {
  readonly electionId: Uint8Array;
  /** Segments whose checkpoints were taken in this run. */
  readonly taken: readonly number[];
  /** Segments whose checkpoints this run's call anchored. */
  readonly anchored: readonly number[];
}

export interface AnchorRun {
  readonly reports: readonly AnchorReport[];
  readonly findings: readonly AnchorFinding[];
}

/** The period containing `t`, or -1 before the epoch. */
function periodAt(clock: AnchoringClock, t: bigint): number {
  if (t < clock.epoch) return -1;
  const s = (t - clock.epoch) / clock.period;
  return s > BigInt(MAX_SEGMENT) ? MAX_SEGMENT + 1 : Number(s);
}

/** `s`, or the first value past the last u32 segment if it is beyond that. */
const atMostPastLast = (s: bigint) => (s > BigInt(MAX_SEGMENT) + 1n ? BigInt(MAX_SEGMENT) + 1n : s);

const endOf = (clock: AnchoringClock, s: number) => clock.epoch + (BigInt(s) + 1n) * clock.period;

function checkClock(clock: AnchoringClock): void {
  for (const v of [clock.epoch, clock.period, clock.deadline])
    if (typeof v !== "bigint" || v < 0n) throw new RangeError("the clock's values are bigints ≥ 0");
  // The anchor's constructor refuses a zero period.
  if (clock.period < 1n) throw new RangeError("the clock's period must be at least 1");
}

/**
 * One anchoring run over every board: takes the checkpoints of the periods
 * ended by the L1 node's latest block, then, election by election, sends in
 * one call each taken checkpoint the anchor doesn't hold while its window is
 * open (docs/spec/board.md, Timing: from the end of its period to `deadline`
 * after it), and reports what it finds. One call per election, so a call
 * that reverts holds back no other election's anchors.
 *
 * `localNow` is the worker's own clock (UNIX seconds). Periods are taken up
 * to the one before the period of the earlier of the L1 time and
 * `localNow + MAX_L1_CLOCK_LEAD`; windows are judged by the L1 time, which
 * the anchor judges by. Before sending, each checkpoint is recomputed from
 * the stored board and must be the stored one.
 *
 * An election is anchored only if its definition names this L1 and anchor:
 * its verifier reads no other (T-52). The seal's checkpoint, owed even when
 * the seal's period added nothing, isn't taken yet: nothing computes the
 * seal from a definition (P4-1, Known-weak).
 */
export async function anchorBoards(
  client: Sql,
  chain: AnchorChain,
  localNow: bigint,
): Promise<AnchorRun> {
  checkClock(chain.clock);
  if (!isBytes(chain.address) || chain.address.length !== 20)
    throw new TypeError("the anchor's address must be 20 bytes");
  if (typeof localNow !== "bigint" || localNow < 0n)
    throw new TypeError("localNow must be a bigint ≥ 0");
  const now = await chain.now();
  if (typeof now !== "bigint" || now < 0n) throw new TypeError("now must be a bigint ≥ 0");
  const clock = chain.clock;
  const findings: AnchorFinding[] = [];
  const trusted = localNow + MAX_L1_CLOCK_LEAD;
  if (now > trusted) findings.push({ code: "anchor-clock" });
  const through = Math.max(
    -1,
    Math.min(periodAt(clock, now < trusted ? now : trusted) - 1, MAX_SEGMENT),
  );
  // Every checkpoint whose window is open, or closed within one deadline,
  // so a missed one is reported for a while rather than once: from the first
  // segment `s` with `end(s) + 2·deadline ≥ now`.
  const lag = now - clock.epoch - 2n * clock.deadline;
  const from =
    lag <= 0n ? 0 : Number(atMostPastLast((lag + clock.period - 1n) / clock.period - 1n));
  const reports: AnchorReport[] = [];
  for (const id of await listBoards(client)) {
    try {
      const report = await anchorBoard(client, chain, id, now, through, from, findings);
      if (report !== undefined) reports.push(report);
    } catch {
      // One board's failure (a lost connection, a node that answered
      // nonsense) holds back no other's anchors; the next run retries it.
      findings.push({ code: "anchor-error", electionId: id });
    }
  }
  return { reports, findings };
}

/**
 * One election's part of a run: its checkpoints taken through `through`, and
 * those from segment `from` on judged against what the anchor holds. Pushes
 * its findings as it goes; `undefined` when the election isn't this
 * anchor's.
 */
async function anchorBoard(
  client: Sql,
  chain: AnchorChain,
  id: Uint8Array,
  now: bigint,
  through: number,
  from: number,
  findings: AnchorFinding[],
): Promise<AnchorReport | undefined> {
  const clock = chain.clock;
  const definition = await readDefinition(client, id);
  // A board is started only once its definition is stored (appendEntry).
  if (definition === undefined) throw new Error("a stored board has no definition");
  const d = decodeElectionDefinition(definition);
  if (d.l1_chain_id !== chain.chainId || !equal(d.l1_anchor, chain.address)) {
    findings.push({ code: "anchor-unserved", electionId: id });
    return undefined;
  }
  const taken = await takeCheckpoints(client, id, through);
  const due: Checkpoint[] = [];
  for (const checkpoint of await readCheckpoints(client, id, from)) {
    const held = await chain.anchored(id, checkpoint.segment);
    if (held !== undefined && (!isBytes(held) || held.length !== 32))
      throw new TypeError("an anchored hash must be 32 bytes");
    const closes = endOf(clock, checkpoint.segment) + clock.deadline;
    if (held !== undefined) {
      if (!equal(held, checkpointHash(checkpoint)))
        findings.push({ code: "anchor-conflict", electionId: id, segment: checkpoint.segment });
    } else if (now > closes) {
      findings.push({ code: "anchor-missed", electionId: id, segment: checkpoint.segment });
    } else due.push(checkpoint);
  }
  const anchored: number[] = [];
  if (due.length === 0) return { electionId: id, taken: taken.map((c) => c.segment), anchored };
  // T-23: the stored rows are sent only if the board still gives them, so
  // a row written around takeCheckpoints (its root and CIDs aren't checked
  // by the table) is never anchored in the authority's name.
  const recomputed = copyCheckpoints(
    id,
    await readBoard(client, id),
    due.map((c) => c.segment),
  );
  const wrong = due.filter((c) => {
    const r = recomputed.get(c.segment);
    return r === undefined || !equal(encodeCheckpoint(r), encodeCheckpoint(c));
  });
  if (wrong.length > 0) {
    for (const c of wrong)
      findings.push({ code: "anchor-mismatch", electionId: id, segment: c.segment });
    return { electionId: id, taken: taken.map((c) => c.segment), anchored };
  }
  // Checkpoints near their deadline each in a call of their own, after the
  // others in one.
  const late = (c: Checkpoint) =>
    now + ANCHOR_INCLUSION_MARGIN > endOf(clock, c.segment) + clock.deadline;
  const calls = [due.filter((c) => !late(c)), ...due.filter(late).map((c) => [c])];
  let failed = false;
  for (const call of calls) {
    if (call.length === 0) continue;
    try {
      await chain.anchor(call);
      anchored.push(...call.map((c) => c.segment));
    } catch {
      if (!failed) findings.push({ code: "anchor-send-failed", electionId: id });
      failed = true;
      for (const c of call)
        if (now >= endOf(clock, c.segment) + clock.deadline / 2n)
          findings.push({ code: "anchor-overdue", electionId: id, segment: c.segment });
    }
  }
  return { electionId: id, taken: taken.map((c) => c.segment), anchored };
}
