// The stub step of a poll's setup ([[0032-poll-creation-operations]], rules
// 7, 8, 10, 11 and 12; P2-22 part 4a): a rooted poll gets the stub its key
// ceremony binds, a version-5 definition with `ceremony_transcript_hash`
// zeroed, built from the author's draft, the electorate the roots step
// recorded and the deployment's pins, with `opens_at` set now. The stub and
// the display text its commitment opens to are recorded for the coordinator
// (rule 5), and the poll moves to `ceremony`.
//
// Every field is the draft's, the roots step's or the deployment's; the
// author's account is in none of them (rule 11). The definition's rules and
// the verifier's profile combination are @abolishus/crypto's, so a stub this
// step records is one the election registry's checks and 2.1 to 2.3 accept,
// before any seat is asked to lend it keys (T-17, T-28, T-34).
//
// A poll whose registration can't be signed before its stub opens gets a new
// stub under rule 10, and a new ceremony, until STUBS_PER_POLL (P2-22 part
// 5d).
//
// T-10: the stub and its display text are public once the poll registers,
// and name no voter. T-34: the display text is the draft's, field for field,
// under a fresh salt, and the stub's questions are the draft's.

import {
  type DisplayTextV2,
  displayTextV2Commitment,
  type ElectionDefinitionV5,
  electionDefinitionV5Rule,
  electionStubV5Hash,
  encodeDisplayTextV2,
  EncodeError,
  encodeElectionDefinitionV5,
  membershipVkHash,
  newDisplayTextSalt,
  type Panel,
  PanelError,
  PARAMETERS,
  panelId,
  profileCombinationRule,
  QUESTION_METHODS,
  RECORD_TYPES,
  TALLY_SCHEMES,
  type TierElectorate,
} from "@abolishus/crypto";
import { and, asc, eq, isNull, lte, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { accountPolls, ceremonyStubs } from "./db/schema/index.ts";
import {
  draftDisplayText,
  draftQuestions,
  MIN_OPEN_SECONDS,
  type PollDraft,
  SETUP_SECONDS,
} from "./poll-drafts.ts";
import { REGISTRATION_MARGIN_SECONDS } from "./poll-registration.ts";
import type { StoredTierElectorate } from "./poll-roots.ts";

/**
 * The profile of every stub this step builds: definition version 5, the
 * newest the deployable election registry serves (rule 8), with exactly the
 * pins its rule 9 serves for it (ballot 3, spoiled-ballot opening 2, board
 * entry 5, contract event 7, display text 2) and version 1 of the receipt,
 * the ceremony transcript and the tally opening, the only ones 2.3 reads
 * (docs/spec/contracts.md, Registration, rule 9).
 */
export const POLL_DEFINITION_PROFILE: ElectionDefinitionV5["profile"] = Object.freeze({
  protocol_major: 1,
  pins: Object.freeze(
    (
      [
        [RECORD_TYPES.electionDefinition, 5],
        [RECORD_TYPES.ballot, 3],
        [RECORD_TYPES.spoiledBallotOpening, 2],
        [RECORD_TYPES.receipt, 1],
        [RECORD_TYPES.ceremonyTranscript, 1],
        [RECORD_TYPES.tallyOpening, 1],
        [RECORD_TYPES.boardEntry, 5],
        [RECORD_TYPES.contractEvent, 7],
        [RECORD_TYPES.displayText, 2],
      ] as const
    ).map(([record_type, version]) => Object.freeze({ record_type, version })),
  ),
});

/** What every stub pins from the deployment record and the release. */
export interface PollStubDeployment {
  readonly l2ChainId: bigint;
  readonly l1ChainId: bigint;
  /** The L2 contracts, 20 bytes each. */
  readonly electionRegistry: Uint8Array;
  readonly board: Uint8Array;
  readonly trusteeRegistry: Uint8Array;
  readonly groupRegistry: Uint8Array;
  /** The L1 contracts, 20 bytes each. */
  readonly l1Anchor: Uint8Array;
  readonly l1Relay: Uint8Array;
  /** The default panel the trustee registry pins (during launch, the transitional one). */
  readonly panel: Panel;
  /** The board operator's receipt keys, `p256-key`s in ascending byte order (T-26). */
  readonly receiptKeys: readonly Uint8Array[];
  /** The release's `δ` and the chain's sequencing parameters, in seconds. */
  readonly l1InclusionBound: number;
  readonly sequencingWindow: bigint;
  readonly maxSequencerDrift: bigint;
}

/** What a stub takes from the poll itself. */
interface PollFields {
  readonly electionId: Uint8Array;
  readonly questions: ElectionDefinitionV5["questions"];
  readonly electorate: readonly TierElectorate[];
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  readonly displayTextCommitment: Uint8Array;
}

function pollStub(d: PollStubDeployment, p: PollFields): ElectionDefinitionV5 {
  return {
    profile: POLL_DEFINITION_PROFILE,
    election_id: p.electionId,
    l2_chain_id: d.l2ChainId,
    l1_chain_id: d.l1ChainId,
    election_registry: d.electionRegistry,
    board: d.board,
    trustee_registry: d.trusteeRegistry,
    group_registry: d.groupRegistry,
    l1_anchor: d.l1Anchor,
    l1_relay: d.l1Relay,
    questions: p.questions,
    tally_scheme: TALLY_SCHEMES.pedersenVss,
    electorate: p.electorate,
    // Ballot version 3 proves membership under the one key the release pins
    // (verifier 1.3).
    membership_vk_hash: membershipVkHash(),
    panel_id: panelId(d.panel),
    threshold: d.panel.threshold,
    panel_size: d.panel.keys.length,
    // Zero in the stub: the ceremony runs before its transcript exists (T-37).
    ceremony_transcript_hash: new Uint8Array(32),
    opens_at: p.opensAt,
    closes_at: p.closesAt,
    l1_inclusion_bound: d.l1InclusionBound,
    sequencing_window: d.sequencingWindow,
    max_sequencer_drift: d.maxSequencerDrift,
    display_text_commitment: p.displayTextCommitment,
    // In the stub, so the keys are fixed before the ceremony (T-26).
    receipt_keys: d.receiptKeys,
  };
}

/** The first rule a stub breaks: the definition's own, then 2.3's profile combination. */
function stubRule(stub: ElectionDefinitionV5): string | undefined {
  return electionDefinitionV5Rule(stub)?.rule ?? profileCombinationRule(stub);
}

/**
 * The rule every stub built under `deployment` would break, or `undefined`:
 * the definition's own rules on a stub of a two-option poll with one
 * member, and registration rule 6's bounds on the inclusion bound and the
 * sequencing parameters (`sequencing`), so a setting the registry would
 * refuse is found when the worker starts, before any seat spends a ceremony
 * on a stub that can't register (T-25). The caller refuses to start on
 * anything but `undefined`.
 */
export function pollStubDeploymentRule(deployment: PollStubDeployment): string | undefined {
  let stub: ElectionDefinitionV5;
  try {
    stub = pollStub(deployment, {
      electionId: new Uint8Array(32).fill(1),
      questions: [
        {
          method: QUESTION_METHODS.selection,
          option_count: 2,
          min_selections: 0,
          max_selections: 1,
        },
      ],
      electorate: [
        {
          tier: 0,
          root_l2_block: 1n,
          groups: [{ group_id: 1n, region: 0 }],
          regions: [1n],
          cells: [{ root: 1n, members: 1n }],
        },
      ],
      opensAt: 1n,
      closesAt: 2n,
      displayTextCommitment: new Uint8Array(32),
    });
  } catch (e) {
    // The panel's own checks: a threshold below 2, a repeated or malformed key.
    if (e instanceof PanelError) return "panel";
    throw e;
  }
  const rule = stubRule(stub);
  if (rule !== undefined) return rule;
  // Registration rule 6 (docs/spec/contracts.md), which the definition's
  // own rules leave to the registry and verifier 2.6.
  if (
    deployment.l1InclusionBound < PARAMETERS.MIN_INCLUSION_BOUND ||
    deployment.l1InclusionBound > PARAMETERS.MAX_INCLUSION_BOUND ||
    deployment.sequencingWindow > BigInt(PARAMETERS.MAX_SEQUENCING_WINDOW) ||
    deployment.maxSequencerDrift > BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT)
  )
    return "sequencing";
  try {
    // A field outside its codec's range (an address of the wrong length, a
    // receipt key that isn't a point) has no encoding at all.
    encodeElectionDefinitionV5(stub);
  } catch (e) {
    if (e instanceof EncodeError) return "encoding";
    throw e;
  }
  return undefined;
}

/** The electorate the roots step recorded, as the definition states it. */
export const tierElectorate = (t: StoredTierElectorate): TierElectorate => ({
  tier: t.tier as TierElectorate["tier"],
  root_l2_block: BigInt(t.rootL2Block),
  groups: t.groups.map((g) => ({ group_id: BigInt(g.groupId), region: g.region })),
  regions: t.regions.map(BigInt),
  cells: t.cells.map((c) => ({ root: BigInt(c.root), members: BigInt(c.members) })),
});

/** Why the stub step fails a poll (the `failure` column's codes it writes). */
export type StubFailure =
  /** The draft closes too soon after the `opens_at` this run would set. */
  | "closes-too-soon"
  /**
   * The stub breaks a definition rule or a stored value has no encoding:
   * never for a draft submission accepted, so a bug or a setting.
   */
  | "stub-refused"
  /**
   * The poll's `STUBS_PER_POLL`th stub missed its registration too: no
   * ceremony was approved and registered in time, however often retried
   * (rule 14).
   */
  | "ceremony-timeout";

/** One run's outcome, in counts only (T-10, T-67). */
export interface PollStubReport {
  /** Polls moved to `ceremony` with a recorded stub. */
  stubbed: number;
  /** Polls in `ceremony` given a new stub under rule 10. */
  restubbed: number;
  /** Polls moved to `failed`, by reason. */
  failed: Partial<Record<StubFailure, number>>;
}

/** Most polls one run builds stubs for, in each pass; the next run takes the rest. */
export const STUBS_PER_RUN = 20;

/**
 * Most stubs one poll's identifier gets: the first and three retries under
 * rule 10, each a whole ceremony of `SETUP_SECONDS`, so a panel that can't
 * finish one for about two hours sends the poll back to its author rather
 * than keep it in setup for good.
 */
export const STUBS_PER_POLL = 4;

type BuiltStub = { displayText: Uint8Array; stub: Uint8Array; stubHash: Uint8Array };

/** A poll as the stub step reads it. */
interface StubbedPoll {
  readonly id: string;
  readonly draft: unknown;
  readonly electionId: Uint8Array | null;
  readonly electorate: unknown;
}

/**
 * The stub of `p` opening at `opensAt` with a fresh display-text salt, or
 * the reason the poll fails instead.
 */
function buildStub(
  deployment: PollStubDeployment,
  p: StubbedPoll,
  opensAt: bigint,
): BuiltStub | "closes-too-soon" | "stub-refused" {
  const stored = p.draft as { closesAt: string } & Omit<PollDraft, "closesAt">;
  const draft: PollDraft = { ...stored, closesAt: BigInt(stored.closesAt) };
  if (draft.closesAt < opensAt + BigInt(MIN_OPEN_SECONDS)) return "closes-too-soon";
  try {
    const text: DisplayTextV2 = draftDisplayText(draft, newDisplayTextSalt());
    const stub = pollStub(deployment, {
      // The table requires an identifier and an electorate from `rooted` on.
      electionId: p.electionId as Uint8Array,
      questions: draftQuestions(draft),
      electorate: (p.electorate as StoredTierElectorate[]).map(tierElectorate),
      opensAt,
      closesAt: draft.closesAt,
      displayTextCommitment: displayTextV2Commitment(text),
    });
    if (stubRule(stub) !== undefined) return "stub-refused";
    return {
      displayText: encodeDisplayTextV2(text),
      stub: encodeElectionDefinitionV5(stub),
      stubHash: electionStubV5Hash(stub),
    };
  } catch (e) {
    // A stored value outside its codec's range has no encoding: this poll
    // fails, rather than stopping every later one behind it (T-25).
    if (!(e instanceof EncodeError)) throw e;
    return "stub-refused";
  }
}

/**
 * One run of the stub step, in two passes.
 *
 * First, every rooted poll, oldest first, gets a stub opening
 * `SETUP_SECONDS` from now (rule 10), with a fresh display-text salt. A
 * poll whose draft would then close within `MIN_OPEN_SECONDS` of opening
 * fails `closes-too-soon`, which registration would refuse as `timing`; a
 * stub that breaks a definition rule, or holds a value with no encoding,
 * fails `stub-refused`. Otherwise the stub and its display text are
 * recorded and the poll moves to `ceremony` naming the stub, in one
 * transaction.
 *
 * Then rule 10's retry: every poll in `ceremony` with no registration
 * recorded whose stub opens within `REGISTRATION_MARGIN_SECONDS`, the point
 * past which the registration step no longer signs one, earliest opening
 * first, gets a new stub for the same identifier the same way, whatever its
 * run did (none, unfinished, ended unapproved, or approved but never
 * signed). Seats approve at most one transcript per stub, and nothing was
 * registered under the identifier, so the new stub is a new ceremony, never
 * a second approval. A poll whose identifier already has `STUBS_PER_POLL`
 * stubs fails `ceremony-timeout` instead (rule 14).
 *
 * Safe to rerun after a crash at any point: a poll moves only from the state
 * and stub it was read with, holding its identifier (and, on a retry, while
 * no registration is recorded), and a stub is recorded only with that move.
 */
export async function stubPolls(
  client: Sql,
  deployment: PollStubDeployment,
  options: { readonly now: Date },
): Promise<PollStubReport> {
  const db = drizzle({ client });
  const report: PollStubReport = { stubbed: 0, restubbed: 0, failed: {} };
  const now = BigInt(Math.floor(options.now.getTime() / 1000));
  const opensAt = now + BigInt(SETUP_SECONDS);
  const failed = (failure: StubFailure) =>
    (report.failed[failure] = (report.failed[failure] ?? 0) + 1);

  /**
   * Moves the poll as `where` finds it to `ceremony` under `built`, or to
   * `failed`, recording the stub with the move; whether it moved.
   */
  const move = (where: SQL | undefined, electionId: Uint8Array, built: BuiltStub | StubFailure) =>
    db.transaction(async (tx) => {
      const rows = await tx
        .update(accountPolls)
        .set(
          typeof built === "string"
            ? { state: "failed", failure: built, updatedAt: options.now }
            : { state: "ceremony", stubHash: built.stubHash, updatedAt: options.now },
        )
        .where(where)
        .returning({ id: accountPolls.id });
      // Another run moved it first: its stub is the one recorded.
      if (rows.length === 0) return false;
      if (typeof built !== "string")
        await tx.insert(ceremonyStubs).values({
          stubHash: built.stubHash,
          electionId,
          stub: built.stub,
          displayText: built.displayText,
          opensAt,
          createdAt: options.now,
        });
      return true;
    });

  const rooted = await db
    .select({
      id: accountPolls.id,
      draft: accountPolls.draft,
      electionId: accountPolls.electionId,
      electorate: accountPolls.electorate,
    })
    .from(accountPolls)
    .where(eq(accountPolls.state, "rooted"))
    .orderBy(asc(accountPolls.updatedAt), asc(accountPolls.id))
    .limit(STUBS_PER_RUN);
  for (const p of rooted) {
    const electionId = p.electionId as Uint8Array;
    const built = buildStub(deployment, p, opensAt);
    // Keyed by the identifier too, as the earlier steps' writes are.
    const where = and(
      eq(accountPolls.id, p.id),
      eq(accountPolls.state, "rooted"),
      eq(accountPolls.electionId, electionId),
    );
    if (!(await move(where, electionId, built))) continue;
    if (typeof built === "string") failed(built);
    else report.stubbed++;
  }

  // Rule 10: the polls whose registration can no longer be signed before
  // their stub opens. A stub built in the first pass opens SETUP_SECONDS
  // ahead, so none of them is taken here.
  const late = await db
    .select({
      id: accountPolls.id,
      draft: accountPolls.draft,
      electionId: accountPolls.electionId,
      electorate: accountPolls.electorate,
      stubHash: accountPolls.stubHash,
      stubs: sql<number>`(SELECT count(*)::int FROM ${ceremonyStubs} s
        WHERE s.election_id = ${accountPolls.electionId})`,
    })
    .from(accountPolls)
    .innerJoin(ceremonyStubs, eq(ceremonyStubs.stubHash, accountPolls.stubHash))
    .where(
      and(
        eq(accountPolls.state, "ceremony"),
        isNull(accountPolls.registerTxHash),
        lte(ceremonyStubs.opensAt, now + BigInt(REGISTRATION_MARGIN_SECONDS)),
      ),
    )
    .orderBy(asc(ceremonyStubs.opensAt), asc(accountPolls.id))
    .limit(STUBS_PER_RUN);
  for (const p of late) {
    // The table requires both on every poll in `ceremony`.
    const electionId = p.electionId as Uint8Array;
    const stubHash = p.stubHash as Uint8Array;
    const built =
      p.stubs >= STUBS_PER_POLL ? "ceremony-timeout" : buildStub(deployment, p, opensAt);
    // Never under a registration the creation key recorded meanwhile: the
    // registration step takes the same row lock before it signs, so one of
    // the two writes finds the other's (rule 12).
    const where = and(
      eq(accountPolls.id, p.id),
      eq(accountPolls.state, "ceremony"),
      eq(accountPolls.electionId, electionId),
      eq(accountPolls.stubHash, stubHash),
      isNull(accountPolls.registerTxHash),
    );
    if (!(await move(where, electionId, built))) continue;
    if (typeof built === "string") failed(built);
    else report.restubbed++;
  }
  return report;
}
