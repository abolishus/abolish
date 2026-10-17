// The opening step of a poll's setup ([[0032-poll-creation-operations]],
// rules 12 to 14; P2-22 part 5c): once a poll is `registered` and the
// registry sync has recorded its `DefinitionRegistered` event and stored the
// definition the registry holds, the worker reads that definition back and
// compares it, field by field, with the author's draft (rule 13), boards the
// ceremony transcript as the board's first entry, stores the display text,
// and the poll moves to `open`.
//
// The read-back is independent of the creation key's own read of its
// registration: the registry sync takes the event and the definition from
// the index only after checking them against the registry's accumulator
// (T-71), so what is compared is what the registry holds, not what the
// creation worker sent. Every field the draft decides (the questions,
// `closes_at`, the display text under its salt) is rebuilt from the draft,
// the electorate from the roots step's record, `opens_at` from the stub
// step's, and the rest from the stub the seats approved; anything else
// fails the poll, never opens it (T-34).
//
// The transcript must be entry 0: admission reads only that entry for it
// (src/admission.ts), so a board starting with anything else takes no ballot
// through our server. Its segment is the current period of the anchoring
// clock, never below the election's first segment `f` (docs/spec/board.md,
// Segments).
//
// T-10: the step reads the author's record and writes public records only:
// the transcript and the display text are published with the registration
// and name no voter.

import {
  ceremonyTranscriptHash,
  DecodeError,
  decodeDisplayTextV2,
  decodeElectionDefinitionV5,
  displayTextV2Commitment,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionStubV5Hash,
  encodeDisplayTextV2,
  encodeElectionDefinitionV5,
  EncodeError,
  UnsupportedVersionError,
} from "@abolishus/crypto";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { AppendError, appendEntry } from "./board.ts";
import { approvedCeremony } from "./ceremony-coordinator.ts";
import { accountPolls, ceremonyStubs, electionRegistrations } from "./db/schema/index.ts";
import { readDefinition } from "./definitions.ts";
import { DisplayTextError, storeDisplayText } from "./display-texts.ts";
import { draftDisplayText, draftQuestions, type PollDraft } from "./poll-drafts.ts";
import type { StoredTierElectorate } from "./poll-roots.ts";
import { tierElectorate } from "./poll-stubs.ts";

/** Why the read-back refuses a registered definition. */
export type ReadBackMismatch =
  /** The recorded display text isn't the draft's, under its own salt. */
  | "display-text"
  /**
   * The draft, electorate or `opens_at` no longer make the stub the seats
   * approved, so nothing registered under it can be the draft's.
   */
  | "stub"
  /**
   * The registry's event carries another hash than the definition rebuilt
   * from the draft and the approved run.
   */
  | "registered-hash"
  /** The stored definition isn't, byte for byte, the one rebuilt. */
  | "definition";

/** What the read-back compares: one registered poll's records. */
export interface RegisteredPoll {
  readonly electionId: Uint8Array;
  readonly draft: PollDraft;
  /** The electorate the roots step recorded. */
  readonly electorate: readonly StoredTierElectorate[];
  /** The poll's current stub: its hash, bytes, display text and `opens_at`. */
  readonly stubHash: Uint8Array;
  readonly stub: Uint8Array;
  readonly displayText: Uint8Array;
  readonly opensAt: bigint;
  /** The approved run's transcript. */
  readonly transcript: Uint8Array;
  /** The definition hash the registry's `DefinitionRegistered` event carries. */
  readonly registeredHash: Uint8Array;
  /**
   * The definition the registry sync stored for the election, or
   * `undefined` when it recorded the registration without storing it
   * (`storeDefinition` refused the bytes): the event's hash is then all
   * there is to compare.
   */
  readonly definition: Uint8Array | undefined;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Rule 13's comparison: `undefined` when the registry holds exactly the
 * definition `poll`'s draft, electorate and approved stub make, completed
 * with the approved transcript's hash, and the recorded display text is the
 * draft's under the salt it carries; otherwise the first mismatch. The
 * definition is rebuilt and compared by its registered hash and, once
 * stored, as bytes, so no field, present or added by a later version, is
 * left out (T-34).
 */
export function pollReadBack(poll: RegisteredPoll): ReadBackMismatch | undefined {
  try {
    return readBack(poll);
  } catch (e) {
    // A recorded stub with no decoding, or a stored value with no encoding:
    // nothing registered can be the draft's.
    if (
      e instanceof DecodeError ||
      e instanceof EncodeError ||
      e instanceof UnsupportedVersionError
    )
      return "stub";
    throw e;
  }
}

function readBack(poll: RegisteredPoll): ReadBackMismatch | undefined {
  // The deployment's pins, the panel and the receipt keys, as the seats
  // approved them.
  const stub = decodeElectionDefinitionV5(poll.stub);
  let text;
  try {
    const { salt } = decodeDisplayTextV2(poll.displayText, stub);
    text = draftDisplayText(poll.draft, salt);
    if (!equal(encodeDisplayTextV2(text), poll.displayText)) return "display-text";
  } catch (e) {
    if (e instanceof DecodeError || e instanceof EncodeError) return "display-text";
    throw e;
  }
  const expected: ElectionDefinitionV5 = {
    ...stub,
    election_id: poll.electionId,
    questions: draftQuestions(poll.draft),
    electorate: poll.electorate.map(tierElectorate),
    opens_at: poll.opensAt,
    closes_at: poll.draft.closesAt,
    display_text_commitment: displayTextV2Commitment(text),
    ceremony_transcript_hash: ceremonyTranscriptHash(poll.transcript),
  };
  if (!equal(electionStubV5Hash(expected), poll.stubHash)) return "stub";
  if (!equal(electionDefinitionV5Hash(expected), poll.registeredHash)) return "registered-hash";
  if (
    poll.definition !== undefined &&
    !equal(encodeElectionDefinitionV5(expected), poll.definition)
  )
    return "definition";
  return undefined;
}

/** The anchoring clock of the anchor every stub pins (docs/spec/board.md, Timing), in seconds. */
export interface BoardClock {
  /** The anchor's address on L1, 20 bytes: a poll whose stub pins another is left. */
  readonly anchor: Uint8Array;
  readonly epoch: bigint;
  readonly period: bigint;
}

/** Why the opening step fails a poll (the `failure` column's codes it writes). */
export type OpenFailure =
  /** What the registry holds isn't the draft's (rule 13), or the display text is refused against it. */
  | "open-mismatch"
  /**
   * Still not open when its `closes_at` passed, left for the registry sync,
   * the clock, another anchor's worker or its board: it can never take a
   * ballot (rule 14).
   */
  | "open-timeout";

/** One run's outcome, in counts only (T-10, T-67). */
export interface PollOpenReport {
  /** Polls moved to `open`, their transcript boarded and display text stored. */
  opened: number;
  /** Registered polls whose registration the registry sync hasn't recorded or stored yet. */
  waiting: number;
  /** Polls left because the clock is before their first segment `f`. */
  early: number;
  /** Polls left because their stub pins another anchor than the clock's. */
  otherAnchor: number;
  /** Polls left because their board already starts with another entry. */
  unboarded: number;
  /** Polls whose step threw; the rest of the run goes on, and the caller fails the job. */
  errored: number;
  /** Polls moved to `failed`, by reason. */
  failed: Partial<Record<OpenFailure, number>>;
}

/** Most polls one run opens; the next run takes the rest. */
export const OPENS_PER_RUN = 20;

const MAX_SEGMENT = 0xffffffffn;

type Outcome = "opened" | "waiting" | "early" | "otherAnchor" | "unboarded" | OpenFailure;

/**
 * One run of the opening step: up to `OPENS_PER_RUN` registered polls,
 * least recently touched first. A poll whose registration the registry sync
 * has recorded is read back against its draft (`pollReadBack`), by the
 * event's hash alone until its definition is stored; a mismatch fails it as
 * `open-mismatch`. Once stored and matching, its transcript is boarded as
 * entry 0 in the clock's current segment (never below `f`), its display text
 * is stored, and it moves to `open`. A poll left (waiting, early, another
 * anchor, unboarded) has its time touched, so polls that can't move never
 * hold the run's slots from the rest, and fails `open-timeout` once its
 * `closes_at` has passed; one whose step throws is counted in `errored` and
 * the run goes on. Safe to rerun after a crash at
 * any point: the first entry and the text are written once and found again,
 * and a poll moves only from `registered`, holding the identifier it was
 * read with.
 */
export async function openPolls(
  client: Sql,
  clock: BoardClock,
  options: { readonly now: Date },
): Promise<PollOpenReport> {
  if (clock.period < 1n || clock.epoch < 0n || clock.anchor.length !== 20)
    throw new RangeError("the clock is malformed");
  const db = drizzle({ client });
  const report: PollOpenReport = {
    opened: 0,
    waiting: 0,
    early: 0,
    otherAnchor: 0,
    unboarded: 0,
    errored: 0,
    failed: {},
  };
  const polls = await db
    .select({
      id: accountPolls.id,
      draft: accountPolls.draft,
      electionId: accountPolls.electionId,
      electorate: accountPolls.electorate,
      stubHash: accountPolls.stubHash,
      origin: accountPolls.l1OriginTimestamp,
    })
    .from(accountPolls)
    .where(eq(accountPolls.state, "registered"))
    .orderBy(asc(accountPolls.updatedAt), asc(accountPolls.id))
    .limit(OPENS_PER_RUN);
  const now = BigInt(Math.floor(options.now.getTime() / 1000));
  // Keyed by the identifier too, as the earlier steps' writes are.
  const unopened = (id: string, electionId: Uint8Array) =>
    and(
      eq(accountPolls.id, id),
      eq(accountPolls.state, "registered"),
      eq(accountPolls.electionId, electionId),
    );
  const move = async (
    id: string,
    electionId: Uint8Array,
    set: { state?: "open" | "failed"; failure?: OpenFailure },
  ) =>
    (
      await db
        .update(accountPolls)
        .set({ ...set, updatedAt: options.now })
        .where(unopened(id, electionId))
        .returning({ id: accountPolls.id })
    ).length > 0;

  const open = async (p: (typeof polls)[number]): Promise<Outcome | undefined> => {
    // The table requires all three, and the origin with the identifier, from
    // `registered` on.
    const electionId = Uint8Array.from(p.electionId as Uint8Array);
    const stubHash = Uint8Array.from(p.stubHash as Uint8Array);
    const origin = p.origin as bigint;
    const fail = async (failure: OpenFailure = "open-mismatch") =>
      (await move(p.id, electionId, { state: "failed", failure })) ? failure : undefined;
    const [registration] = await db
      .select({ definitionHash: electionRegistrations.definitionHash })
      .from(electionRegistrations)
      .where(eq(electionRegistrations.electionId, electionId));
    if (registration === undefined) return "waiting";
    const definition = await readDefinition(client, electionId);
    const [stub] = await db
      .select({
        stub: ceremonyStubs.stub,
        displayText: ceremonyStubs.displayText,
        opensAt: ceremonyStubs.opensAt,
      })
      .from(ceremonyStubs)
      .where(eq(ceremonyStubs.stubHash, stubHash));
    const approved = await approvedCeremony(client, stubHash);
    // A registered poll's stub and approved run are recorded before its
    // registration is signed; without them nothing can be compared.
    if (stub === undefined || approved === undefined) return fail();
    const stored = p.draft as { closesAt: string } & Omit<PollDraft, "closesAt">;
    const draft: PollDraft = { ...stored, closesAt: BigInt(stored.closesAt) };
    const mismatch = pollReadBack({
      electionId,
      draft,
      electorate: p.electorate as StoredTierElectorate[],
      stubHash,
      stub: Uint8Array.from(stub.stub),
      displayText: Uint8Array.from(stub.displayText),
      opensAt: stub.opensAt,
      transcript: approved.transcript,
      registeredHash: Uint8Array.from(registration.definitionHash),
      definition,
    });
    if (mismatch !== undefined) return fail();
    // Registered as the draft's, but not stored yet: the registry sync stores
    // it on a later run.
    if (definition === undefined) return "waiting";
    // The transcript is labelled by the clock of the anchor the definition
    // pins; another anchor's periods would mislabel it (docs/spec/board.md,
    // Timing).
    if (!equal(decodeElectionDefinitionV5(definition).l1_anchor, clock.anchor))
      return "otherAnchor";
    if (now >= draft.closesAt) return fail("open-timeout");
    // Anchors count from segment 0 up, so an origin before the epoch is `f` = 0.
    const first = origin < clock.epoch ? 0n : (origin - clock.epoch) / clock.period;
    const segment = now < clock.epoch ? -1n : (now - clock.epoch) / clock.period;
    // A clock behind the creation's L1 origin would label the transcript
    // below `f`; time fixes it.
    if (segment < first) return "early";
    if (segment > MAX_SEGMENT) throw new RangeError("the clock is past the last segment");
    // Boarded before the text is stored, so a poll left unboarded serves
    // nothing.
    try {
      await appendEntry(client, electionId, Number(segment), approved.transcript, {
        first: true,
        raiseToPrevious: true,
      });
    } catch (e) {
      if (!(e instanceof AppendError && e.code === "not-first")) throw e;
      return "unboarded";
    }
    try {
      await storeDisplayText(client, electionId, Uint8Array.from(stub.displayText));
    } catch (e) {
      if (!(e instanceof DisplayTextError)) throw e;
      // The client's own check refuses the text against the registered
      // definition: nobody could be shown the poll.
      if (e.code === "refused") return fail();
      // `conflict`: the text was stored and since taken down. Serving it is
      // moderation's; the definition commits to this one record either way.
      if (e.code !== "conflict") throw e;
    }
    return (await move(p.id, electionId, { state: "open" })) ? "opened" : undefined;
  };

  for (const p of polls) {
    let outcome: Outcome | undefined;
    try {
      outcome = await open(p);
      // Left past its close, it can never take a ballot: back to its author
      // (rule 14). Judged after the step, so a poll the read-back refuses is
      // still rule 13's alert.
      if (
        (outcome === "waiting" ||
          outcome === "early" ||
          outcome === "otherAnchor" ||
          outcome === "unboarded") &&
        now >= BigInt((p.draft as { closesAt: string }).closesAt)
      )
        outcome = (await move(p.id, Uint8Array.from(p.electionId as Uint8Array), {
          state: "failed",
          failure: "open-timeout",
        }))
          ? "open-timeout"
          : undefined;
    } catch {
      // One poll's malformed row or unexpected refusal never holds up the
      // rest; the count fails the job, so it is still seen.
      report.errored++;
      continue;
    }
    if (outcome === undefined) continue;
    if (outcome === "open-mismatch" || outcome === "open-timeout") {
      report.failed[outcome] = (report.failed[outcome] ?? 0) + 1;
      continue;
    }
    report[outcome]++;
    // Touched, so the next run takes the polls behind it first.
    if (outcome !== "opened") await move(p.id, Uint8Array.from(p.electionId as Uint8Array), {});
  }
  return report;
}
