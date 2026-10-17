// A worker thread that runs trustee seats' intake for the simulation
// (./intake.ts). It stands in for each seat's node: it holds the seats' intake
// keys, given once at start, and for each ballot runs @abolishus/crypto's
// intakeShares, or intakeSharesV3 for ballot version 3, for every seat
// asked, unchanged. Nothing here checks anything
// itself (AGENTS.md, Architecture). Node runs this file directly, as
// TypeScript in the tests and as dist/intake-worker.mjs once packed, so it
// imports only @abolishus/crypto and Node: no other sdk module.

import { parentPort, workerData } from "node:worker_threads";
import {
  COMMITTED_VOTE,
  COMMITTED_VOTE_V3,
  type CommittedVote,
  type CommittedVoteV3,
  decode,
  encode,
  type IntakeKeys,
  intakeShares,
  intakeSharesV3,
  type ValidityContext,
  type ValidityContextV3,
} from "@abolishus/crypto";

/**
 * What a worker is started with: every seat's intake keys, under a marker, so
 * this file serves only a worker ./intake.ts started, never another worker
 * that happens to import the sdk.
 */
export interface IntakeWorkerData {
  readonly abolishSimulationIntake: true;
  readonly seats: readonly IntakeKeys[];
}

/** A ballot's validity context, version 3's carrying its questions. */
export type IntakeContext = ValidityContext | ValidityContextV3;

/**
 * One ballot's intake: its context, its committed vote encoded (its group
 * elements don't survive a structured clone) and each seat's ciphertext.
 */
export interface IntakeJob {
  readonly id: number;
  readonly ctx: IntakeContext;
  readonly vote: Uint8Array;
  readonly ciphertexts: readonly { readonly seat: number; readonly ciphertext: Uint8Array }[];
}

/** One seat's intake of one ballot: its shares and receipt, or why it refused. */
export type SeatIntake = ReturnType<typeof intakeShares> | ReturnType<typeof intakeSharesV3>;

/** A committed vote's encoding under its context's ballot version. */
export const encodeIntakeVote = (ctx: IntakeContext, vote: CommittedVote | CommittedVoteV3) =>
  "questions" in ctx
    ? encode(COMMITTED_VOTE_V3, vote as CommittedVoteV3)
    : encode(COMMITTED_VOTE, vote as CommittedVote);

/** One seat's intake of one ballot under its context's ballot version. */
export function intakeSeat(
  ctx: IntakeContext,
  keys: IntakeKeys,
  vote: CommittedVote | CommittedVoteV3,
  ciphertext: Uint8Array,
): SeatIntake {
  return "questions" in ctx
    ? intakeSharesV3(ctx, keys, vote as CommittedVoteV3, ciphertext)
    : intakeShares(ctx, keys, vote as CommittedVote, ciphertext);
}

/** Each seat's result, in the job's order, or why the job couldn't run. */
export type IntakeReply =
  | { readonly id: number; readonly results: readonly SeatIntake[] }
  | { readonly id: number; readonly error: string };

function runIntakeJob(seats: readonly IntakeKeys[], job: IntakeJob): SeatIntake[] {
  const vote =
    "questions" in job.ctx ? decode(COMMITTED_VOTE_V3, job.vote) : decode(COMMITTED_VOTE, job.vote);
  return job.ciphertexts.map(({ seat, ciphertext }) => {
    const keys = seats.find((s) => s.seat === seat);
    if (keys === undefined) throw new RangeError(`intake: no keys for seat ${seat}`);
    return intakeSeat(job.ctx, keys, vote, ciphertext);
  });
}

const port = parentPort;
const data = workerData as Partial<IntakeWorkerData> | null;
if (port !== null && data?.abolishSimulationIntake === true) {
  const seats = data.seats ?? [];
  port.on("message", (job: IntakeJob) => {
    let reply: IntakeReply;
    try {
      reply = { id: job.id, results: runIntakeJob(seats, job) };
    } catch (e) {
      reply = { id: job.id, error: e instanceof Error ? e.message : String(e) };
    }
    port.postMessage(reply);
  });
}
