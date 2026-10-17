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
  panelId,
  profileCombinationRule,
  QUESTION_METHODS,
  RECORD_TYPES,
  TALLY_SCHEMES,
  type TierElectorate,
} from "@abolishus/crypto";
import { and, asc, eq } from "drizzle-orm";
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
 * member, so a panel, chain or receipt-key setting the registry would refuse
 * is found when the worker starts, before it fails any poll. The caller
 * refuses to start on anything but `undefined`.
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

const tierElectorate = (t: StoredTierElectorate): TierElectorate => ({
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
  /** The stub breaks a definition rule: never for a draft submission accepted, so a bug or a setting. */
  | "stub-refused";

/** One run's outcome, in counts only (T-10, T-67). */
export interface PollStubReport {
  /** Polls moved to `ceremony` with a recorded stub. */
  stubbed: number;
  /** Polls moved to `failed`, by reason. */
  failed: Partial<Record<StubFailure, number>>;
}

/** Most polls one run builds stubs for; the next run takes the rest. */
export const STUBS_PER_RUN = 20;

/**
 * One run of the stub step: every rooted poll, oldest first, gets a stub
 * opening `SETUP_SECONDS` from now (rule 10), with a fresh display-text
 * salt. A poll whose draft would then close within `MIN_OPEN_SECONDS` of
 * opening fails `closes-too-soon`, which registration would refuse as
 * `timing`; a stub that breaks a definition rule fails `stub-refused`.
 * Otherwise the stub and its display text are recorded and the poll moves
 * to `ceremony` naming the stub, in one transaction. Safe to rerun after a
 * crash at any point: a poll moves only from `rooted`, holding the
 * identifier it was read with, and a stub is recorded only with that move.
 */
export async function stubPolls(
  client: Sql,
  deployment: PollStubDeployment,
  options: { readonly now: Date; readonly salt?: () => Uint8Array },
): Promise<PollStubReport> {
  const db = drizzle({ client });
  const report: PollStubReport = { stubbed: 0, failed: {} };
  const salt = options.salt ?? newDisplayTextSalt;
  const polls = await db
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
  const now = BigInt(Math.floor(options.now.getTime() / 1000));
  const opensAt = now + BigInt(SETUP_SECONDS);
  // Keyed by the identifier too, as the earlier steps' writes are.
  const unstubbed = (id: string, electionId: Uint8Array) =>
    and(
      eq(accountPolls.id, id),
      eq(accountPolls.state, "rooted"),
      eq(accountPolls.electionId, electionId),
    );
  const fail = async (id: string, electionId: Uint8Array, failure: StubFailure) => {
    const moved = await db
      .update(accountPolls)
      .set({ state: "failed", failure, updatedAt: options.now })
      .where(unstubbed(id, electionId))
      .returning({ id: accountPolls.id });
    if (moved.length > 0) report.failed[failure] = (report.failed[failure] ?? 0) + 1;
  };
  for (const p of polls) {
    // The table requires an identifier and an electorate from `rooted` on.
    const electionId = p.electionId as Uint8Array;
    const stored = p.draft as { closesAt: string } & Omit<PollDraft, "closesAt">;
    const draft: PollDraft = { ...stored, closesAt: BigInt(stored.closesAt) };
    if (draft.closesAt < opensAt + BigInt(MIN_OPEN_SECONDS)) {
      await fail(p.id, electionId, "closes-too-soon");
      continue;
    }
    const text: DisplayTextV2 = draftDisplayText(draft, salt());
    const displayText = encodeDisplayTextV2(text);
    const stub = pollStub(deployment, {
      electionId,
      questions: draftQuestions(draft),
      electorate: (p.electorate as StoredTierElectorate[]).map(tierElectorate),
      opensAt,
      closesAt: draft.closesAt,
      displayTextCommitment: displayTextV2Commitment(text),
    });
    if (stubRule(stub) !== undefined) {
      await fail(p.id, electionId, "stub-refused");
      continue;
    }
    const stubHash = electionStubV5Hash(stub);
    const moved = await db.transaction(async (tx) => {
      const rows = await tx
        .update(accountPolls)
        .set({ state: "ceremony", stubHash, updatedAt: options.now })
        .where(unstubbed(p.id, electionId))
        .returning({ id: accountPolls.id });
      // Another run moved it first: its stub is the one recorded.
      if (rows.length === 0) return 0;
      await tx.insert(ceremonyStubs).values({
        stubHash,
        electionId,
        stub: encodeElectionDefinitionV5(stub),
        displayText,
        opensAt,
        createdAt: options.now,
      });
      return 1;
    });
    report.stubbed += moved;
  }
  return report;
}
