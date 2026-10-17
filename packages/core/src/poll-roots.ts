// The roots step of a poll's setup ([[0032-poll-creation-operations]], rules
// 9, 12 and 14; P2-22 part 3b-2): a created poll whose identifier passed the
// per-slot check gets its fixed electorate, each tier's groups, region
// counts and cells at one L2 block, `root_l2_block`, and moves to `rooted`.
// The ceremony's stub (part 4) states exactly what is recorded here.
//
// The block and the records come from the caller, who proves them: the
// worker reads the group registry's records from the index and checks them
// against the registry's event accumulator proven under an L2 output root on
// L1, so `root_l2_block` is in history a dispute game claims and the
// records are the registry's whole sequence up to it (T-71, T-34). Which
// groups make up each tier is the deployment's published list
// (docs/spec/registration.md, Groups), never chosen per poll. The counts and
// roots are `statedTierElectorate`'s, the gated code whose replay the
// verifier's 2.4 and the ballot client repeat, so a poll never states an
// electorate of this module's making (T-13, T-16).
//
// T-10: public chain data and the poll's own record; the electorate is
// counts and roots, never a member. T-08, T-25: the root is read at a block
// already in the past, so nobody can commit to additions not yet made.

import {
  checkEventAccumulatorProof,
  type ContractEventRecord,
  contractEventLog,
  type EventAccumulatorProofError,
  type GroupRegistryPins,
  type ProvenEventAccumulator,
  statedTierElectorate,
  type TierElectorate,
  TierMembershipError,
} from "@abolishus/crypto";
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { accountPolls } from "./db/schema/index.ts";
import { MIN_OPEN_SECONDS, type PollDraft, SETUP_SECONDS } from "./poll-drafts.ts";

/** The group registry's records up to one L2 block, as the caller proved them. */
export interface ProvenGroupRecords {
  /** The L2 block every tier is read at: `root_l2_block`. */
  readonly block: bigint;
  /** The registry's records up to `block`, in order of `n`: its whole sequence there. */
  readonly records: readonly ContractEventRecord[];
}

/** Where the roots step reads the registry (the worker's index and accumulator proof). */
export interface GroupRecordSource {
  read(): Promise<ProvenGroupRecords>;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The indexed records aren't the registry's sequence the proven accumulator vouches for. */
export class GroupRecordsError extends Error {
  override readonly name = "GroupRecordsError";
  readonly code: EventAccumulatorProofError | "other-contract";
  constructor(code: EventAccumulatorProofError | "other-contract") {
    super(`group records refused: ${code}`);
    this.code = code;
  }
}

/**
 * The group registry's records up to `proven.block`, from `records` (all its
 * indexed records in order of `n`, as the index holds them): checked against
 * the registry's accumulator and count after that block, as the caller
 * proved them, so an index that drops, adds, alters, reorders or moves a
 * record is refused (`GroupRecordsError`) rather than counted (T-71). Records
 * past the count are left for a later block. A record naming another
 * contract is refused too (`other-contract`).
 */
export function provenGroupRecords(
  chainId: bigint,
  registry: Uint8Array,
  records: readonly ContractEventRecord[],
  proven: ProvenEventAccumulator,
): ProvenGroupRecords {
  // The accumulator doesn't bind a record's `contract`, and the replay skips
  // any record not the registry's, so one relabelled would drop out unseen.
  if (records.some((r) => !equal(r.contract, registry)))
    throw new GroupRecordsError("other-contract");
  const refused = checkEventAccumulatorProof(
    chainId,
    registry,
    records.map(contractEventLog),
    proven,
  );
  if (refused !== null) throw new GroupRecordsError(refused);
  return { block: proven.block, records: records.slice(0, Number(proven.count)) };
}

/** What the roots step judges the registry under: the deployment's published groups and pins. */
export interface PollRootDeployment {
  /** Each tier's published groups, in ascending `group_id`, each with its region. */
  readonly groups: ReadonlyMap<number, TierElectorate["groups"]>;
  readonly pins: GroupRegistryPins;
}

/** Why the roots step fails a poll (the `failure` column's codes it writes). */
export type RootFailure =
  /** The draft closes too soon for the setup still ahead, judged again before the ceremony. */
  | "closes-too-soon"
  /** A tier the poll asks for has no published group, or none this step can count yet. */
  | "tier-unavailable"
  /** A tier the poll asks for has nobody in it at `root_l2_block`. */
  | "electorate-empty";

/** One run's outcome, in counts only (T-10, T-67). */
export interface PollRootReport {
  /** Polls moved to `rooted`. */
  rooted: number;
  /** Polls moved to `failed`, by reason. */
  failed: Partial<Record<RootFailure, number>>;
}

/** Most polls one run roots; the next run takes the rest. */
export const ROOTS_PER_RUN = 20;

/**
 * The stored form of a poll's electorate: the definition's `electorate`
 * field with each integer a decimal string, since jsonb holds none above
 * 2^53 exactly.
 */
export interface StoredTierElectorate {
  readonly tier: number;
  readonly rootL2Block: string;
  readonly groups: readonly { readonly groupId: string; readonly region: number }[];
  readonly regions: readonly string[];
  readonly cells: readonly { readonly root: string; readonly members: string }[];
}

const stored = (t: TierElectorate): StoredTierElectorate => ({
  tier: t.tier,
  rootL2Block: t.root_l2_block.toString(),
  groups: t.groups.map((g) => ({ groupId: g.group_id.toString(), region: g.region })),
  regions: t.regions.map(String),
  cells: t.cells.map((c) => ({ root: c.root.toString(), members: c.members.toString() })),
});

/**
 * One run of the roots step: every created poll whose identifier passed the
 * per-slot check, oldest first, is judged at the one proven block the run
 * reads. A poll whose draft now closes too soon for the setup ahead fails
 * `closes-too-soon`; a tier with no published group, or one this step can't
 * count yet (Tier 1 and 2), fails `tier-unavailable`; a tier with nobody in
 * a region fails `electorate-empty`. Otherwise its electorate is recorded
 * and it moves to `rooted`. A history the deployment's registry can't have
 * logged throws, failing no poll: that is the node's, the index's or the
 * deployment's to fix. Safe to rerun after a crash at any point: a poll moves
 * only from `created`, checked, holding the identifier it was read with.
 */
export async function rootPolls(
  client: Sql,
  source: GroupRecordSource,
  deployment: PollRootDeployment,
  options: { readonly now: Date },
): Promise<PollRootReport> {
  const db = drizzle({ client });
  const report: PollRootReport = { rooted: 0, failed: {} };
  const polls = await db
    .select({ id: accountPolls.id, draft: accountPolls.draft, electionId: accountPolls.electionId })
    .from(accountPolls)
    .where(and(eq(accountPolls.state, "created"), isNotNull(accountPolls.anchorsCheckedBlock)))
    .orderBy(asc(accountPolls.updatedAt), asc(accountPolls.id))
    .limit(ROOTS_PER_RUN);
  if (polls.length === 0) return report;
  // One block for the run, read once: every poll of the run is rooted at it.
  const { block, records } = await source.read();
  const now = BigInt(Math.floor(options.now.getTime() / 1000));
  // Keyed by the identifier too, as the per-slot check's writes are.
  const unrooted = (id: string, electionId: Uint8Array) =>
    and(
      eq(accountPolls.id, id),
      eq(accountPolls.state, "created"),
      isNotNull(accountPolls.anchorsCheckedBlock),
      eq(accountPolls.electionId, electionId),
    );
  const fail = async (id: string, electionId: Uint8Array, failure: RootFailure) => {
    const moved = await db
      .update(accountPolls)
      .set({ state: "failed", failure, updatedAt: options.now })
      .where(unrooted(id, electionId))
      .returning({ id: accountPolls.id });
    if (moved.length > 0) report.failed[failure] = (report.failed[failure] ?? 0) + 1;
  };
  for (const p of polls) {
    // The table requires an identifier from `created` on.
    const electionId = p.electionId as Uint8Array;
    const { closesAt, tiers } = p.draft as { closesAt: string } & Omit<PollDraft, "closesAt">;
    // The ceremony and registration are still ahead: the stub's `opens_at`
    // is at least this far off, and the poll must stay open the shortest
    // time after it, or registration would refuse it (`timing`).
    if (BigInt(closesAt) < now + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS)) {
      await fail(p.id, electionId, "closes-too-soon");
      continue;
    }
    let failure: RootFailure | undefined;
    const electorate: TierElectorate[] = [];
    for (const tier of tiers) {
      const groups = deployment.groups.get(tier);
      if (groups === undefined) {
        failure = "tier-unavailable";
        break;
      }
      try {
        electorate.push(
          statedTierElectorate(records, { tier, root_l2_block: block, groups }, deployment.pins),
        );
      } catch (e) {
        if (!(e instanceof TierMembershipError)) throw e;
        if (e.code === "tier-unsupported") failure = "tier-unavailable";
        else if (e.code === "empty") failure = "electorate-empty";
        else throw e;
        break;
      }
    }
    if (failure !== undefined) {
      await fail(p.id, electionId, failure);
      continue;
    }
    const moved = await db
      .update(accountPolls)
      .set({ state: "rooted", electorate: electorate.map(stored), updatedAt: options.now })
      .where(unrooted(p.id, electionId))
      .returning({ id: accountPolls.id });
    report.rooted += moved.length;
  }
  return report;
}
