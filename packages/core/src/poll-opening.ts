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
  /** The stored definition doesn't decode as a version-5 definition. */
  | "definition-version"
  /** The registry's event carries another hash than the stored definition's. */
  | "registered-hash"
  /** The definition isn't a completion of the poll's approved stub. */
  | "stub"
  /** The approved transcript isn't the one the definition binds. */
  | "transcript"
  /** The recorded display text isn't the draft's, under its own salt. */
  | "display-text"
  /** A field differs from the draft, the electorate, `opens_at` or the stub's pins. */
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
  /** The definition the registry sync stored for the election. */
  readonly definition: Uint8Array;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Rule 13's comparison: `undefined` when the registered definition is
 * exactly the definition `poll`'s draft, electorate and approved stub make,
 * completed with the approved transcript's hash, and the recorded display
 * text is the draft's under the salt it carries; otherwise the first
 * mismatch. The definition is compared as bytes after rebuilding it, so no
 * field, present or added by a later version, is left out (T-34).
 */
export function pollReadBack(poll: RegisteredPoll): ReadBackMismatch | undefined {
  try {
    return readBack(poll);
  } catch (e) {
    // Bytes with no decoding, or a stored value with no encoding: whatever
    // the registry holds, it isn't the draft's.
    if (
      e instanceof DecodeError ||
      e instanceof EncodeError ||
      e instanceof UnsupportedVersionError
    )
      return "definition";
    throw e;
  }
}

function readBack(poll: RegisteredPoll): ReadBackMismatch | undefined {
  let registered: ElectionDefinitionV5;
  try {
    registered = decodeElectionDefinitionV5(poll.definition);
  } catch (e) {
    if (e instanceof DecodeError || e instanceof UnsupportedVersionError)
      return "definition-version";
    throw e;
  }
  if (!equal(electionDefinitionV5Hash(registered), poll.registeredHash)) return "registered-hash";
  if (!equal(electionStubV5Hash(registered), poll.stubHash)) return "stub";
  const transcriptHash = ceremonyTranscriptHash(poll.transcript);
  if (!equal(registered.ceremony_transcript_hash, transcriptHash)) return "transcript";
  let text;
  try {
    const { salt } = decodeDisplayTextV2(poll.displayText, registered);
    text = draftDisplayText(poll.draft, salt);
    if (!equal(encodeDisplayTextV2(text), poll.displayText)) return "display-text";
  } catch (e) {
    if (e instanceof DecodeError || e instanceof EncodeError) return "display-text";
    throw e;
  }
  const expected: ElectionDefinitionV5 = {
    // The deployment's pins, the panel and the receipt keys, as the seats
    // approved them.
    ...decodeElectionDefinitionV5(poll.stub),
    election_id: poll.electionId,
    questions: draftQuestions(poll.draft),
    electorate: poll.electorate.map(tierElectorate),
    opens_at: poll.opensAt,
    closes_at: poll.draft.closesAt,
    display_text_commitment: displayTextV2Commitment(text),
    ceremony_transcript_hash: transcriptHash,
  };
  if (!equal(encodeElectionDefinitionV5(expected), poll.definition)) return "definition";
  return undefined;
}

/** The anchoring clock of the anchor every stub pins (docs/spec/board.md, Timing), in seconds. */
export interface BoardClock {
  readonly epoch: bigint;
  readonly period: bigint;
}

/** Why the opening step fails a poll (the `failure` column's codes it writes). */
export type OpenFailure =
  /** What the registry holds isn't the draft's (rule 13), or the display text is refused against it. */
  "open-mismatch";

/** One run's outcome, in counts only (T-10, T-67). */
export interface PollOpenReport {
  /** Polls moved to `open`, their transcript boarded and display text stored. */
  opened: number;
  /** Registered polls whose registration the registry sync hasn't stored yet. */
  waiting: number;
  /** Polls left because the clock is before their first segment `f`. */
  early: number;
  /** Polls left because their board already starts with another entry. */
  unboarded: number;
  /** Polls moved to `failed`, by reason. */
  failed: Partial<Record<OpenFailure, number>>;
}

/** Most polls one run opens; the next run takes the rest. */
export const OPENS_PER_RUN = 20;

const MAX_SEGMENT = 0xffffffffn;

/**
 * One run of the opening step: every registered poll, oldest first, whose
 * registration and definition the registry sync has stored, is read back
 * against its draft (`pollReadBack`); a mismatch fails it as
 * `open-mismatch`. Otherwise its display text is stored, its transcript is
 * boarded as entry 0 in the clock's current segment (never below `f`), and
 * it moves to `open`. Safe to rerun after a crash at any point: the text
 * and the first entry are written once and found again, and a poll moves
 * only from `registered`, holding the identifier it was read with.
 */
export async function openPolls(
  client: Sql,
  clock: BoardClock,
  options: { readonly now: Date },
): Promise<PollOpenReport> {
  if (clock.period < 1n || clock.epoch < 0n) throw new RangeError("the clock is malformed");
  const db = drizzle({ client });
  const report: PollOpenReport = { opened: 0, waiting: 0, early: 0, unboarded: 0, failed: {} };
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
  const fail = async (id: string, electionId: Uint8Array) => {
    const moved = await db
      .update(accountPolls)
      .set({ state: "failed", failure: "open-mismatch", updatedAt: options.now })
      .where(unopened(id, electionId))
      .returning({ id: accountPolls.id });
    if (moved.length > 0)
      report.failed["open-mismatch"] = (report.failed["open-mismatch"] ?? 0) + 1;
  };
  for (const p of polls) {
    // The table requires all three, and the origin with the identifier, from
    // `registered` on.
    const electionId = Uint8Array.from(p.electionId as Uint8Array);
    const stubHash = Uint8Array.from(p.stubHash as Uint8Array);
    const origin = p.origin as bigint;
    const [registration] = await db
      .select({ definitionHash: electionRegistrations.definitionHash })
      .from(electionRegistrations)
      .where(eq(electionRegistrations.electionId, electionId));
    const definition = await readDefinition(client, electionId);
    if (registration === undefined || definition === undefined) {
      report.waiting++;
      continue;
    }
    const [stub] = await db
      .select({
        stub: ceremonyStubs.stub,
        displayText: ceremonyStubs.displayText,
        opensAt: ceremonyStubs.opensAt,
      })
      .from(ceremonyStubs)
      .where(eq(ceremonyStubs.stubHash, stubHash));
    const approved = await approvedCeremony(client, stubHash);
    const stored = p.draft as { closesAt: string } & Omit<PollDraft, "closesAt">;
    const mismatch =
      stub === undefined || approved === undefined
        ? "stub"
        : pollReadBack({
            electionId,
            draft: { ...stored, closesAt: BigInt(stored.closesAt) },
            electorate: p.electorate as StoredTierElectorate[],
            stubHash,
            stub: Uint8Array.from(stub.stub),
            displayText: Uint8Array.from(stub.displayText),
            opensAt: stub.opensAt,
            transcript: approved.transcript,
            registeredHash: Uint8Array.from(registration.definitionHash),
            definition,
          });
    if (mismatch !== undefined || stub === undefined || approved === undefined) {
      await fail(p.id, electionId);
      continue;
    }
    // Anchors count from segment 0 up, so an origin before the epoch is `f` = 0.
    const first = origin < clock.epoch ? 0n : (origin - clock.epoch) / clock.period;
    const segment = now < clock.epoch ? -1n : (now - clock.epoch) / clock.period;
    // A clock behind the creation's L1 origin would label the transcript
    // below `f`; time fixes it.
    if (segment < first) {
      report.early++;
      continue;
    }
    if (segment > MAX_SEGMENT) throw new RangeError("the clock is past the last segment");
    try {
      await storeDisplayText(client, electionId, Uint8Array.from(stub.displayText));
    } catch (e) {
      if (!(e instanceof DisplayTextError)) throw e;
      // The client's own check refuses the text against the registered
      // definition: nobody could be shown the poll.
      if (e.code === "refused") {
        await fail(p.id, electionId);
        continue;
      }
      // `conflict`: the text was stored and since taken down. Serving it is
      // moderation's; the definition commits to this one record either way.
      if (e.code !== "conflict") throw e;
    }
    try {
      await appendEntry(client, electionId, Number(segment), approved.transcript, {
        first: true,
        raiseToPrevious: true,
      });
    } catch (e) {
      if (!(e instanceof AppendError && e.code === "not-first")) throw e;
      report.unboarded++;
      continue;
    }
    const moved = await db
      .update(accountPolls)
      .set({ state: "open", updatedAt: options.now })
      .where(unopened(p.id, electionId))
      .returning({ id: accountPolls.id });
    report.opened += moved.length;
  }
  return report;
}
