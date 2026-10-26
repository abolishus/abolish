// 4.4's replay of the archive (docs/spec/verifier.md 4.4; docs/spec/archive.md,
// The event replay): each of the definition's L2 contracts' archived event
// sequence, assembled from its contract-event runs, replayed against every
// archived evidence record of that contract under the rules of
// docs/spec/contracts.md (Event accumulator, Verification), so the board's
// contract-event records can be held to the contract's own history once no
// L2 node serves its logs (T-49, T-51, T-53). The archive's authority writes
// the runs and the evidence whole, and an evidence record's output root is
// its own word until P1-19 reads its game on L1 (T-71), so nothing here
// fails an election: a replay that doesn't hold, or doesn't reach a record,
// leaves 4.4 unverifiable.

import {
  checkEventAccumulatorProofs,
  type ContractEventRecord,
  contractEventLog,
  type ContractRole,
  type EventAccumulatorProofError,
} from "@abolishus/crypto";
import type { EvidenceListing, RunListing, TransactionSource } from "./archive.ts";
import { allEvidence, type ArchivedAccumulator, type EvidenceFinding } from "./evidence.ts";
import {
  DEFAULT_RUN_BYTES,
  DEFAULT_RUN_READS,
  readRuns,
  type RunFinding,
  type TakenRun,
} from "./runs.ts";

/**
 * How many transactions the replay's evidence reads ask of the sources,
 * across every contract, when the caller sets nothing: an honest archive
 * serves each record from its first transaction, one per contract whose
 * count changed in each anchored period and one at close, so this covers a
 * poll of about six weeks of hourly periods with every contract busy.
 */
export const DEFAULT_REPLAY_EVIDENCE_READS = 4_096;

/** The replay's budgets, shared by every contract in role order (T-52). */
export interface ReplayBudgets {
  /** Transactions the evidence reads may ask; default `DEFAULT_REPLAY_EVIDENCE_READS`. */
  readonly maxEvidenceReads?: number;
  /** Bytes the run reads may hold; default `DEFAULT_RUN_BYTES`. */
  readonly maxRunBytes?: number;
  /** Transactions the run reads may ask; default `DEFAULT_RUN_READS`. */
  readonly maxRunReads?: number;
}

/** One proven record, and what replaying the archived sequence against it came to. */
export interface ReplayedEvidence extends ArchivedAccumulator {
  /**
   * `null` where the sequence reproduces the record's accumulator; the first
   * rule it breaks otherwise; `unreached` where the runs read stop short of
   * its count, or an event before its count has no topic, which no log of
   * our contracts has and no replay takes.
   */
  readonly replay: EventAccumulatorProofError | "unreached" | null;
}

/** What replaying one contract's archive came to. None of it is a verdict (T-53). */
export interface ContractReplay {
  readonly role: ContractRole;
  readonly contract: Uint8Array;
  readonly evidence: {
    /** Every record proven, in ascending order of block. */
    readonly records: readonly ReplayedEvidence[];
    readonly reads: number;
    readonly findings: readonly EvidenceFinding[];
  };
  readonly runs: {
    readonly taken: readonly TakenRun[];
    /** Whether the runs taken reach the largest count proven. */
    readonly complete: boolean;
    readonly spent: number;
    readonly reads: number;
    readonly findings: readonly RunFinding[];
  };
  /**
   * The largest count of a proven record the sequence reproduces: the
   * archive's word for the contract's first `held` events, until P1-19
   * settles the record's root on L1 (T-71).
   */
  readonly held: bigint;
}

/** One contract's replay with the events read, which the report leaves out. */
export interface ContractSequence extends ContractReplay {
  /** The events of the runs taken, from index 0, each as its contract-event record. */
  readonly records: readonly ContractEventRecord[];
}

const ROLES = ["election-registry", "trustee-registry", "group-registry", "board"] as const;

/**
 * Replays each of `contracts`' archive (docs/spec/verifier.md 4.4), in role
 * order: every evidence listing of the contract is read (`allEvidence`),
 * its runs are read up to the largest count proven (`readRuns`), and the
 * events taken are replayed against every record proven
 * (`checkEventAccumulatorProofs`). The budgets are the reader's, shared by
 * the contracts in that order, so a contract a budget ran out before
 * reports `evidence-reads-over-budget` or `runs-over-budget` rather than
 * being skipped. Nothing read is trusted beyond its CID and its replay: the
 * caller holds the board's records to the events held (T-53).
 */
export async function replayArchive(
  walk: { readonly evidence: readonly EvidenceListing[]; readonly runs: readonly RunListing[] },
  contracts: Readonly<Record<(typeof ROLES)[number], Uint8Array>>,
  l2ChainId: bigint,
  source: TransactionSource,
  budgets: ReplayBudgets = {},
): Promise<readonly ContractSequence[]> {
  const maxEvidenceReads = budgets.maxEvidenceReads ?? DEFAULT_REPLAY_EVIDENCE_READS;
  const maxRunBytes = budgets.maxRunBytes ?? DEFAULT_RUN_BYTES;
  const maxRunReads = budgets.maxRunReads ?? DEFAULT_RUN_READS;
  for (const [name, value] of [
    ["maxEvidenceReads", maxEvidenceReads],
    ["maxRunBytes", maxRunBytes],
    ["maxRunReads", maxRunReads],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive integer`);
  let evidenceReads = 0;
  let runBytes = 0;
  let runReads = 0;
  const out: ContractSequence[] = [];
  for (const role of ROLES) {
    const contract = contracts[role];
    const evidence = await allEvidence(
      walk.evidence,
      contract,
      l2ChainId,
      source,
      maxEvidenceReads,
      evidenceReads,
    );
    evidenceReads += evidence.reads;
    const target = evidence.proven.reduce(
      (c, r) => (r.accumulator.count > c ? r.accumulator.count : c),
      0n,
    );
    // A budget another contract spent is this one's short: reported at
    // index 0, as `readRuns` reports one it ran out of.
    const runs =
      target === 0n
        ? { records: [], taken: [], complete: true, findings: [], spent: 0, reads: 0 }
        : runBytes === maxRunBytes || runReads === maxRunReads
          ? {
              records: [],
              taken: [],
              complete: false,
              findings: [
                {
                  code: "runs-over-budget" as const,
                  n: 0n,
                  maxBytes: maxRunBytes,
                  maxReads: maxRunReads,
                },
              ],
              spent: 0,
              reads: 0,
            }
          : await readRuns(
              walk.runs,
              contract,
              l2ChainId,
              target,
              source,
              maxRunBytes - runBytes,
              maxRunReads - runReads,
            );
    runBytes += runs.spent;
    runReads += runs.reads;
    // `readRuns` names what was left of the budgets; the report names the reader's.
    const runFindings = runs.findings.map((f) =>
      f.code === "runs-over-budget" ? { ...f, maxBytes: maxRunBytes, maxReads: maxRunReads } : f,
    );
    // An event with no topic is no log of ours and steps no accumulator: a
    // record counting it is unreached, never replayed (its event check
    // reports it, docs/spec/verifier.md 4.4).
    const anonymous = runs.records.findIndex((r) => r.topics.length === 0);
    const reach = BigInt(anonymous === -1 ? runs.records.length : anonymous);
    const replayable = evidence.proven.filter((r) => r.accumulator.count <= reach);
    const results = checkEventAccumulatorProofs(
      l2ChainId,
      contract,
      runs.records.map(contractEventLog),
      replayable.map((r) => r.accumulator),
    );
    const byRecord = new Map(replayable.map((r, i) => [r, results[i] ?? null]));
    const records: ReplayedEvidence[] = evidence.proven.map((r) => ({
      ...r,
      replay: byRecord.has(r) ? (byRecord.get(r) ?? null) : "unreached",
    }));
    const held = records.reduce(
      (c, r) => (r.replay === null && r.accumulator.count > c ? r.accumulator.count : c),
      0n,
    );
    out.push({
      role,
      contract,
      evidence: { records, reads: evidence.reads, findings: evidence.findings },
      runs: {
        taken: runs.taken,
        complete: runs.complete,
        spent: runs.spent,
        reads: runs.reads,
        findings: runFindings,
      },
      held,
      records: runs.records,
    });
  }
  return out;
}
