// The key-ceremony checks of docs/spec/verifier.md (Key ceremony): the
// pinned panel against the definition (part of 2.5), and the transcript the
// definition names, found on the board copy by its hash and checked by
// @abolishus/crypto's transcript check (part of 3.1, and 3.2). The context is
// rebuilt from the definition and the pinned panel, never read from the
// transcript, so one election's ceremony can't pass for another's (T-37).
// Under definition version 6, 2.5 fails a poll on the civic record whose
// default panel the release pins as transitional (`panel-kind`, T-14), and
// with an author panel an author key that is a default seat's
// (`default-seat`); the default run's
// `duplicate-key` reads the author keys (T-14), and 3.1 and 3.2 hold per
// panel: the author panel's transcript, found by `author_transcript_hash`,
// is checked under its own context, quorum and participation, and its
// approvals are counted from the author approvals records on the board and,
// under contract-event versions 9 to 13, from the election registry's
// `AuthorPanelRegistered` records there (docs/spec/ceremony.md, Author
// panel; T-37, T-54, T-17). The default panel's L2 side (the trustee
// registry's registration and its approvals, and under contract-event
// versions 12 and 13 the kind its `PanelPinned` logs, which 2.5 reports beside the
// verdict when it differs from the pinned one) isn't read yet, so 3.1 and
// 2.5 never pass here, and no logged kind is reported.

import {
  type AuthorApprovalsCode,
  type BoardEntryVersion,
  type CeremonyErrorCode,
  ceremonyTranscriptHash,
  checkAuthorApprovals,
  checkCeremonyTranscript,
  checkContractEvent,
  DecodeError,
  type DecodeErrorCode,
  decodeBoardEntry,
  decodeContractEvent,
  type ElectionDefinition,
  type ElectionDefinitionV6,
  type Panel,
  panelId,
  pinnedVersion,
  POLL_CLASSES,
  RECORD_TYPES,
  type RegisteredKeys,
  type SeatReason,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { PINNED_PANELS, type PinnedPanel, pinnedKind } from "./panels.ts";

/** Codes the ceremony checks report besides a transcript's own (docs/spec/verifier.md, Key ceremony). */
export type CeremonyCode =
  | Exclude<CeremonyErrorCode, DecodeErrorCode>
  | "panel-unpinned"
  | "panel-kind"
  | "default-seat"
  | "ceremony-transcript-missing"
  | "ceremony-participation"
  | Exclude<AuthorApprovalsCode, "ceremony-participation">;

/** What one panel's transcript check found, once it reached the seats. */
export interface RunReport {
  /** The position in the copy, from 0, of the entry that carries the transcript (not its `index` field). */
  readonly entry: number;
  readonly seats: readonly { readonly index: number; readonly reasons: readonly SeatReason[] }[];
  /** The qualified seats and their per-election signing keys; empty when `ceremony-quorum` fails. */
  readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
}

/** The author panel's run, once its transcript check reached the seats. */
export interface AuthorRunReport extends RunReport {
  /**
   * The author seats whose approvals of the transcript count, once its run
   * met participation; absent before that.
   */
  readonly approvals?: readonly number[];
}

/**
 * What the transcript checks found (the report's `ceremony`): the default
 * panel's run, and beside an author panel the author panel's, once each
 * reached the seats.
 */
export interface CeremonyReport extends RunReport {
  readonly author?: AuthorRunReport;
}

/**
 * A version-6 or version-7 definition's author panel and what its run binds
 * (docs/spec/ceremony.md, Author panel), all read from the definition,
 * never from a release's pins (definition.ts, `authorRunOf`).
 */
export interface AuthorRun {
  /** `author_threshold` and `author_keys`. */
  readonly panel: Panel;
  /** `author_stub_hash`, recomputed from the definition. */
  readonly stubHash: Uint8Array;
  /** `author_transcript_hash`. */
  readonly transcriptHash: Uint8Array;
  /** The definition's hash, which its `AuthorPanelRegistered` names. */
  readonly definitionHash: Uint8Array;
}

type Status = "pass" | "fail" | "unverifiable";

export interface CeremonyOutcome {
  readonly status: Status;
  readonly code?:
    | CeremonyCode
    | "decode"
    | "unsupported-version"
    | "not-reached"
    | "not-implemented";
  readonly at?:
    | {
        readonly entry: number;
        readonly decodeError?: DecodeErrorCode;
        /** Set when the author panel's run is the one that failed. */
        readonly panel?: "author";
      }
    /** `default-seat`'s first author seat, from 1, whose key is a default seat's. */
    | { readonly seat: number }
    /** The author panel's transcript or approvals, wherever no entry is named. */
    | { readonly panel: "author" }
    | Record<string, never>;
}

const NOT_REACHED: CeremonyOutcome = { status: "unverifiable", code: "not-reached" };
const NOT_IMPLEMENTED: CeremonyOutcome = { status: "unverifiable", code: "not-implemented" };
const PASS: CeremonyOutcome = { status: "pass" };

const TRANSCRIPT_CODES: ReadonlySet<string> = new Set<CeremonyErrorCode>([
  "ceremony-order",
  "ceremony-shape",
  "ceremony-signature",
]);

/**
 * The fields the ceremony checks read, the same in every definition version
 * (the L2 addresses for the author panel's registration), and version 6's
 * `poll_class`, which 2.5's `panel-kind` reads.
 */
type CeremonyDefinition = Pick<
  ElectionDefinition,
  | "profile"
  | "election_id"
  | "l2_chain_id"
  | "election_registry"
  | "trustee_registry"
  | "group_registry"
  | "board"
  | "panel_id"
  | "threshold"
  | "panel_size"
  | "ceremony_transcript_hash"
> &
  Partial<Pick<ElectionDefinitionV6, "poll_class">>;

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The first entry of the copy that is a transcript the definition binds by
 * `hash` (`ceremony_transcript_hash`, or `author_transcript_hash`): an entry
 * of this election, under the pinned version, whose payload hashes to it,
 * whatever its record type: bytes the definition binds that aren't a
 * transcript fail its decoding, never go missing. The hash authenticates the
 * bytes wherever they sit, so its position, and whether it is inside the
 * anchored extent, don't matter; any copy of them is the transcript.
 */
function findTranscript(
  electionId: Uint8Array,
  hash: Uint8Array,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
): { readonly entry: number; readonly bytes: Uint8Array } | undefined {
  for (const [at, payload] of ownPayloads(electionId, entries, boardEntryVersion))
    if (equal(ceremonyTranscriptHash(payload), hash)) return { entry: at, bytes: payload };
  return undefined;
}

/** Each entry of this election in the copy that decodes under the pinned version, with its position. */
function* ownPayloads(
  electionId: Uint8Array,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
): Generator<readonly [number, Uint8Array]> {
  for (const [at, encoded] of entries.entries()) {
    let e;
    try {
      e = decodeBoardEntry(encoded, boardEntryVersion);
    } catch (err) {
      // 4.1 reports an entry that doesn't decode; it carries nothing here.
      if (err instanceof DecodeError) continue;
      throw err;
    }
    if (equal(e.election_id, electionId)) yield [at, e.payload];
  }
}

const typeOf = (payload: Uint8Array) => ((payload[0] as number) << 8) | (payload[1] as number);

/**
 * The `registration` of every contract-event record of this election in the
 * copy, wherever it sits, that decodes under the pinned contract-event
 * version, 9 to 13, and passes its event check as the definition's election registry's
 * `AuthorPanelRegistered` naming `definitionHash` (Key ceremony, step 5).
 * An approval is a seat's signed statement whoever boarded it, so, like an
 * approvals record, it counts outside the anchored extent too; a record
 * that doesn't decode or fails the check carries nothing here and is 4.4's
 * to report. No earlier version names the event, and versions 10 to 13
 * read it as version 9 does ([[contracts]], Event tables (versions 10 to 13)). None of them is known to
 * be the one the registry recorded until 4.4's replay or the L2 reads
 * authenticate it, so they only add approvals, never fail 3.1 (T-53).
 */
function authorRegistrations(
  d: CeremonyDefinition,
  definitionHash: Uint8Array,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
): Uint8Array[] {
  const version = pinnedVersion(d, RECORD_TYPES.contractEvent);
  if (version !== 9 && version !== 10 && version !== 11 && version !== 12 && version !== 13)
    return [];
  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const out: Uint8Array[] = [];
  for (const [, payload] of ownPayloads(d.election_id, entries, boardEntryVersion)) {
    if (typeOf(payload) !== RECORD_TYPES.contractEvent) continue;
    let record;
    try {
      record = decodeContractEvent(payload, version);
    } catch (e) {
      if (e instanceof DecodeError) continue;
      throw e;
    }
    const checked = checkContractEvent(record, contracts, version);
    if (
      checked.ok &&
      checked.event.event === "AuthorPanelRegistered" &&
      equal(checked.event.definitionHash, definitionHash)
    )
      out.push(checked.event.registration);
  }
  return out;
}

type RunOutcome =
  | { readonly checked: false; readonly r31: CeremonyOutcome; readonly r32: CeremonyOutcome }
  | {
      readonly checked: true;
      readonly r31: CeremonyOutcome;
      readonly r32: CeremonyOutcome;
      readonly report: RunReport;
      /** Set when the run met its quorum and participation. */
      readonly registered?: readonly RegisteredKeys[];
    };

/**
 * One panel's transcript check (Key ceremony, steps 3 and 4), found by
 * `hash` and checked under `params`. Its 3.1 row is the transcript's part
 * of 3.1 (a pass when it holds; the caller adds the registration's part),
 * its 3.2 row quorum and participation, `max(k, n − 1)` qualified seats by
 * ADR 0006 rule 7 (the owner, 2026-10-12), so a coordinator can't quietly
 * shrink the qualified set to `k` and the tally's failure margin with it
 * (T-54, T-40). `tag` names the panel on its rows' `at`.
 */
function checkRun(
  params: Parameters<typeof checkCeremonyTranscript>[0],
  hash: Uint8Array,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
  tag: Record<string, never> | { readonly panel: "author" },
): RunOutcome {
  const found = findTranscript(params.electionId, hash, entries, boardEntryVersion);
  // A copy without the transcript is that copy's problem, like a short copy
  // in 4.1: unverifiable from it, never the election's failure (T-53).
  if (found === undefined)
    return {
      checked: false,
      r31: { status: "unverifiable", code: "ceremony-transcript-missing", at: tag },
      r32: NOT_REACHED,
    };
  const checked = checkCeremonyTranscript(params, found.bytes, 1);
  const at = { entry: found.entry, ...tag };
  if (!checked.ok && checked.seats === undefined) {
    // The definition binds these bytes, so a transcript that doesn't decode
    // or fails a transcript-level check fails the election (ceremony.md,
    // Transcript check, checks 1 to 3).
    const failed: CeremonyOutcome = TRANSCRIPT_CODES.has(checked.code)
      ? { status: "fail", code: checked.code as CeremonyCode, at }
      : {
          status: "fail",
          code: "decode",
          at: { ...at, decodeError: checked.code as DecodeErrorCode },
        };
    return { checked: false, r31: failed, r32: NOT_REACHED };
  }
  const report: RunReport = {
    entry: found.entry,
    seats: (checked.seats ?? []).map((s) => ({ index: s.index, reasons: [...s.reasons] })),
    registered: checked.ok
      ? checked.registered.map((k) => ({ index: k.index, signingKey: bytesToHex(k.signingKey) }))
      : [],
  };
  const { panel } = params;
  const participation = Math.max(panel.threshold, panel.keys.length - 1);
  if (!checked.ok)
    return {
      checked: true,
      r31: PASS,
      r32: { status: "fail", code: "ceremony-quorum", at },
      report,
    };
  if (checked.registered.length < participation)
    return {
      checked: true,
      r31: PASS,
      r32: { status: "fail", code: "ceremony-participation", at },
      report,
    };
  return { checked: true, r31: PASS, r32: PASS, report, registered: checked.registered };
}

/** A row from its parts: the first failure, else the first that isn't a pass, else a pass. */
const combine = (...parts: readonly CeremonyOutcome[]): CeremonyOutcome =>
  parts.find((o) => o.status === "fail") ?? parts.find((o) => o.status !== "pass") ?? PASS;

/**
 * The rows 2.5, 3.1 and 3.2 for a definition that decoded, is well formed and
 * pins a board-entry version this verifier reads, and the report's
 * `ceremony` once the default panel's transcript check reached the seats.
 * `stubHash` is the definition's stub hash under its own version, which the
 * transcript's context binds (T-37). `author` is the definition's author
 * panel, undefined when it has none (definition.ts, `authorRunOf`). `pins`
 * are the panels the release pins, whose kinds 2.5's `panel-kind` reads.
 */
export function ceremonyChecks(
  d: CeremonyDefinition,
  stubHash: Uint8Array,
  panel: Panel,
  author: AuthorRun | undefined,
  entries: readonly Uint8Array[],
  boardEntryVersion: BoardEntryVersion,
  pins: readonly PinnedPanel[] = PINNED_PANELS,
): {
  readonly rows: ReadonlyMap<string, CeremonyOutcome>;
  readonly report?: CeremonyReport;
  /**
   * The default panel's registered key set, once 3.2 passed for every panel
   * and 2.5 didn't fail (and, beside an author panel, its approvals
   * approve): what ballots are checked against (5.1 to 5.4).
   */
  readonly registered?: readonly RegisteredKeys[];
  /**
   * Beside an author panel, with `registered`: the author panel's registered
   * key set, which its approvals approved (`checkAuthorApprovals`), so its
   * shares are judged only against its own run (T-37).
   */
  readonly authorRegistered?: readonly RegisteredKeys[];
} {
  const rows = (r25: CeremonyOutcome, r31: CeremonyOutcome, r32: CeremonyOutcome) =>
    new Map([
      ["2.5", r25],
      ["3.1", r31],
      ["3.2", r32],
    ]);
  // 2.5: the definition names the pinned panel. The transcript's context
  // binds the pinned panel's identifier, so checking it against any other
  // panel would only ever fail its signatures.
  if (
    !equal(panelId(panel), d.panel_id) ||
    panel.threshold !== d.threshold ||
    panel.keys.length !== d.panel_size
  )
    return {
      rows: rows({ status: "fail", code: "panel-unpinned", at: {} }, NOT_REACHED, NOT_REACHED),
    };
  // 2.5's `panel-kind`: a poll on the civic record (classes 2 and 3) under
  // a default panel the release pins as transitional fails, so no such poll
  // runs under a panel we alone hold (T-14). Only a pinned panel has a kind
  // to read: one the release doesn't pin (none yet, the bundle's panel being
  // a local input) leaves `panel-kind` undecided, never failed, since a
  // release that pins it as independent passes it (T-36).
  const civic =
    d.poll_class === POLL_CLASSES.organisational || d.poll_class === POLL_CLASSES.civicReferendum;
  const transitional = civic && pinnedKind(bytesToHex(d.panel_id), pins) === "transitional";
  // `default-seat`, so no trustee holds shares of both halves
  // (trustee-identity.md, Author panel identifier, rule 4; T-14). The keys
  // are compared as bytes: both are strictly decoded compressed points,
  // whose encoding is unique.
  const authorKeys = author?.panel.keys ?? [];
  const shared = authorKeys.findIndex((k) => panel.keys.some((q) => equal(k, q)));
  // 2.5 never passes here: the pinned panel's comparison with the keys
  // registered on L2 isn't implemented.
  const r25: CeremonyOutcome = transitional
    ? { status: "fail", code: "panel-kind", at: {} }
    : shared === -1
      ? NOT_IMPLEMENTED
      : { status: "fail", code: "default-seat", at: { seat: shared + 1 } };
  // A transcript version this verifier can't read may be one a later release
  // reads: unverifiable, never failed, so releases agree (2.3; T-36). Both
  // runs' transcripts are record type 0x0005 under the one pin.
  if (pinnedVersion(d, RECORD_TYPES.ceremonyTranscript) !== 1) {
    const unsupported: CeremonyOutcome = {
      status: "unverifiable",
      code: "unsupported-version",
      at: {},
    };
    return { rows: rows(r25, unsupported, unsupported) };
  }
  const election = {
    l2ChainId: d.l2_chain_id,
    trusteeRegistry: d.trustee_registry,
    electionId: d.election_id,
  };
  const own = checkRun(
    {
      ...election,
      stubHash,
      panel,
      // The default run's `duplicate-key` reads the author panel's identity
      // keys beside its own (ceremony.md, Author panel; T-14).
      ...(authorKeys.length > 0 && { otherPanelKeys: authorKeys }),
    },
    d.ceremony_transcript_hash,
    entries,
    boardEntryVersion,
    {},
  );
  // 3.1 also needs the trustee registry's record of the default transcript
  // and its approvals on L2, which this verifier doesn't read yet: never a
  // pass here. Last among 3.1's parts, so an author part that fails or is
  // missing is what the row reports.
  const registration = NOT_IMPLEMENTED;
  if (author === undefined)
    return {
      rows: rows(r25, combine(own.r31, registration), own.r32),
      ...(own.checked && { report: own.report }),
      // No ballot is judged in an election 2.5 fails (`panel-kind`).
      ...(r25.status !== "fail" &&
        own.checked &&
        own.registered !== undefined && { registered: own.registered }),
    };

  // The author panel's run: its context binds `author_panel_id` and
  // `author_stub_hash`, both from the definition, and its `duplicate-key`
  // reads the pinned default keys (ceremony.md, Author panel; T-37, T-14).
  const tag = { panel: "author" } as const;
  const theirs = checkRun(
    {
      ...election,
      stubHash: author.stubHash,
      panel: author.panel,
      panelKind: "author",
      otherPanelKeys: panel.keys,
    },
    author.transcriptHash,
    entries,
    boardEntryVersion,
    tag,
  );
  // Its approvals are the approvals records on the board and the election
  // registry's registrations of this definition there: every one of this
  // election, wherever it sits, since an approval is a seat's signed
  // statement whoever boarded it, checked against the key set this
  // verifier's own check returned. The registration the registry recorded
  // isn't read yet (3.1's registration part, below), so one of another key
  // set carries nothing here (ceremony.md, Author panel, Check, The
  // registration's approvals and Boarding; T-37, T-17, T-53).
  let approvals: CeremonyOutcome = NOT_REACHED;
  let approving: readonly number[] | undefined;
  if (theirs.checked && theirs.registered !== undefined) {
    const records = [...ownPayloads(d.election_id, entries, boardEntryVersion)]
      .map(([, payload]) => payload)
      .filter((payload) => typeOf(payload) === RECORD_TYPES.authorApprovals);
    const approved = checkAuthorApprovals(
      {
        l2ChainId: d.l2_chain_id,
        trusteeRegistry: d.trustee_registry,
        authorStubHash: author.stubHash,
        panel: author.panel,
        authorTranscriptHash: author.transcriptHash,
        registered: theirs.registered,
      },
      records,
      authorRegistrations(d, author.definitionHash, entries, boardEntryVersion),
    );
    approving = approved.seats ?? [];
    // `ceremony-participation` can't come back: the run met it above. A copy
    // with no record naming the transcript may be the copy's problem, never
    // alone the election's failure (T-53).
    approvals = approved.ok
      ? PASS
      : approved.code === "author-approvals-missing"
        ? { status: "unverifiable", code: "author-approvals-missing", at: tag }
        : { status: "fail", code: approved.code, at: tag };
  }
  const r32 = combine(own.r32, theirs.r32);
  return {
    rows: rows(r25, combine(own.r31, theirs.r31, approvals, registration), r32),
    ...(own.checked && {
      report: {
        ...own.report,
        ...(theirs.checked && {
          author: {
            ...theirs.report,
            ...(approving !== undefined && { approvals: approving }),
          },
        }),
      },
    }),
    // Nothing is checked against one half's key set: both panels' runs must
    // hold, the author panel's registration (its approvals) too, and 2.5
    // mustn't fail, so no author seat shares a default seat's key (T-14,
    // T-37, T-54).
    ...(r32.status === "pass" &&
      approvals.status === "pass" &&
      r25.status !== "fail" &&
      own.checked &&
      own.registered !== undefined &&
      theirs.checked &&
      theirs.registered !== undefined && {
        registered: own.registered,
        authorRegistered: theirs.registered,
      }),
  };
}
