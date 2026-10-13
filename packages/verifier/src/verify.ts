// Runs the checks of docs/spec/verifier.md over one bundle and builds the
// report (Procedure, Verdicts, Report). Only the board checks (4.1, 4.2), the
// definition's decoding and well-formedness (part of 2.1) under definition
// versions 1, 3 and 4, 2.3's profile combination, 2.9's receipt keys from L1
// state, 8.5's not-applicable case,
// 1.3's failure for a definition naming another membership key and, for
// format 4, the key-ceremony
// transcript check (3.2, and the parts of 2.5 and 3.1 that need no L2 state)
// ballot admission (5.1 to 5.4, and 5.7 as far as 5.5 allows; ballot
// version 2 against its cell under definition versions 3 and 4) and the
// spoiled-ballot openings (6.2, as far as the floor of s_S decides them) and
// the tally openings' sorting, attribution and boarding breaches (7.4, as far
// as they need no counted set; against the cells under definition versions 3
// and 4) are implemented; every other check is reported unverifiable, so no run can
// report an election verified yet. A run on unauthenticated inputs reports
// what the checks found against them, but its verdict stays unverifiable, so
// a crafted bundle can neither verify nor fail an election (T-53, T-24).

import {
  type Anchor,
  ballotElection,
  BoardError,
  type BoardEntryVersion,
  boardPayloadTypes,
  type BoardErrorAt,
  type BoardErrorCode,
  DecodeError,
  type DecodeErrorCode,
  decodeElectionDefinitionRecord,
  type ElectionDefinitionRecord,
  electionDefinitionHash,
  electionDefinitionRule,
  electionDefinitionV3Hash,
  electionDefinitionV3Rule,
  electionDefinitionV4Hash,
  electionDefinitionV4Rule,
  type ElectionDefinitionV4Rule,
  electionStubHash,
  electionStubV3Hash,
  electionStubV4Hash,
  membershipVkHash,
  pinnedVersion,
  profileCombinationRule,
  RECORD_TYPES,
  verifyBoard,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import { type AdmissionCode, ballotChecks, type BallotsReport } from "./ballots.ts";
import type { Bundle, InputSource, InputSources } from "./bundle.ts";
import { type CeremonyCode, ceremonyChecks, type CeremonyReport } from "./ceremony.ts";
import { CHECKS, type CheckKind } from "./checks.ts";
import { openingChecks, type OpeningCode, type OpeningReport } from "./openings.ts";
import { type ReceiptKeyCode, receiptKeyRow } from "./receipt-keys.ts";
import { tallyChecks, type TallyCode, type TallyReport } from "./tallies.ts";
import {
  anchorsFromState,
  type L1Evidence,
  L1Error,
  type L1ErrorCode,
  type StateAnchor,
} from "./l1.ts";

export type CheckStatus = "pass" | "fail" | "unverifiable";
export type Verdict = "verified" | "failed" | "unverifiable";
export type CheckCode =
  | BoardErrorCode
  | L1ErrorCode
  | ElectionDefinitionV4Rule
  | CeremonyCode
  | AdmissionCode
  | OpeningCode
  | TallyCode
  | ReceiptKeyCode
  | "decode"
  | "membership-key"
  | "profile-combination"
  | "unsupported-version"
  | "not-reached"
  | "not-applicable"
  | "not-implemented";

/**
 * Where a failure is: an entry, a checkpoint by its position in the bundle's
 * anchors, a segment, the definition's decode error, or the board.
 */
export type CheckAt =
  | { readonly entry: number; readonly decodeError?: DecodeErrorCode }
  | { readonly decodeError: DecodeErrorCode }
  | { readonly checkpoint: number }
  | { readonly segment: number }
  | { readonly key: number }
  | Record<string, never>;

export interface CheckResult {
  readonly id: string;
  readonly kind: CheckKind;
  readonly status: CheckStatus;
  readonly code?: CheckCode;
  readonly at?: CheckAt;
}

export interface Report {
  readonly format: typeof REPORT_FORMAT;
  readonly verdict: Verdict;
  readonly verdictAgainstInputs: Verdict;
  readonly inputs: InputSources;
  /** A format-3 or format-4 bundle's definition hash, once the definition decodes. */
  readonly definition?: { readonly hash: string };
  /** A format-4 bundle's transcript check, once it reached the seats. */
  readonly ceremony?: CeremonyReport;
  /** A format-4 bundle's ballot admission, once it ran (5.1 to 5.4 and 5.7). */
  readonly ballots?: BallotsReport;
  /** A format-4 bundle's spoiled-ballot openings, once 6.2 ran, in copy order. */
  readonly openings?: readonly OpeningReport[];
  /** A format-4 bundle's tally openings, once 7.4 ran, in copy order. */
  readonly tallies?: readonly TallyReport[];
  readonly board: {
    readonly entries: number;
    readonly unreadableBytes: number;
    readonly unauthenticated?: number;
  };
  /** The L1 block a format-2, 3 or 4 bundle was proven at, and the anchors read from its state. */
  readonly l1?: {
    readonly blockHash: string;
    readonly blockNumber: string;
    readonly timestamp: string;
    readonly anchors?: readonly {
      readonly segment: number;
      readonly hash: string;
      readonly source: StateAnchor["source"];
    }[];
  };
  readonly checks: readonly CheckResult[];
}

export const REPORT_FORMAT = "abolish-verifier-report/1";

type Outcome = Pick<CheckResult, "status" | "code" | "at">;

const PASS: Outcome = { status: "pass" };
const NOT_REACHED: Outcome = { status: "unverifiable", code: "not-reached" };
const NOT_IMPLEMENTED: Outcome = { status: "unverifiable", code: "not-implemented" };
const UNSUPPORTED: Outcome = { status: "unverifiable", code: "unsupported-version", at: {} };
// 8.5 under a board-entry version that can't carry a destruction statement:
// reported, never `destruction-missing` for every seat (docs/spec/verifier.md, 8.5).
const NOT_APPLICABLE: Outcome = { status: "unverifiable", code: "not-applicable" };
const carriesDestruction = (v: BoardEntryVersion) =>
  boardPayloadTypes(v).includes(RECORD_TYPES.destructionStatement);

function copyAt(at: BoardErrorAt): CheckAt {
  if ("entry" in at)
    return at.decodeError === undefined
      ? { entry: at.entry }
      : { entry: at.entry, decodeError: at.decodeError };
  if ("checkpoint" in at) return { checkpoint: at.checkpoint };
  if ("segment" in at) return { segment: at.segment };
  return {};
}

/**
 * The rows of 4.1 and 4.2 for a board-check failure (docs/spec/verifier.md,
 * Procedure, step 5). The board checks stop at the first failure, so the
 * code says which steps ran. Exhaustive: a new code doesn't compile until it
 * is mapped.
 */
function boardOutcomes(e: BoardError): readonly [Outcome, Outcome] {
  const at = copyAt(e.at);
  const failed: Outcome = { status: "fail", code: e.code, at };
  const code: BoardErrorCode = e.code;
  switch (code) {
    // A copy that is too short or differs is that copy's problem:
    // unverifiable from this source, never the election's failure (T-53).
    case "checkpoint-missing":
    case "copy-mismatch": {
      const copy: Outcome = { status: "unverifiable", code, at };
      return [copy, copy];
    }
    // Anchor checks run before any entry is decoded.
    case "checkpoint-equivocation":
    case "checkpoint-size":
    case "checkpoint-inconsistent":
      return [NOT_REACHED, failed];
    case "wrong-election":
      return "checkpoint" in e.at ? [NOT_REACHED, failed] : [failed, NOT_REACHED];
    // Entry checks: 4.1 failed, and the checkpoint steps after it never ran.
    case "decode":
    case "wrong-index":
    case "segment-decreased":
    case "opening-order":
      return [failed, NOT_REACHED];
    // Run only once every entry passed.
    case "checkpoint-boundary":
    case "checkpoint-cid":
    case "unanchored":
    case "unsealed":
      return [PASS, failed];
    default: {
      const unmapped: never = code;
      throw new Error(`unmapped board-check code ${String(unmapped)}`);
    }
  }
}

// A local file authenticates nothing. The switch is exhaustive, so a new
// source type doesn't compile until it is decided here.
export function authenticated(source: InputSource): boolean {
  switch (source) {
    case "local-file":
      return false;
    // Proven against the header's state root: as authentic as the header,
    // the anchor's address and the first segment, each judged as its own
    // input.
    case "l1-state-proof":
    // A field of the definition: as authentic as the definition, judged as
    // its own input.
    case "definition":
      return true;
    default: {
      const unhandled: never = source;
      throw new Error(`unknown input source ${String(unhandled)}`);
    }
  }
}

/** `verdictAgainstInputs` (docs/spec/verifier.md, Verdicts). Report-only checks never change it. */
function judge(checks: readonly CheckResult[]): Verdict {
  if (checks.some((c) => c.kind === "election" && c.status === "fail")) return "failed";
  if (checks.some((c) => c.kind !== "report-only" && c.status === "unverifiable"))
    return "unverifiable";
  return "verified";
}

/** What the board checks run with besides the copy and the clock. */
type BoardInputs =
  | {
      readonly electionId: Uint8Array;
      readonly boardEntryVersion: BoardEntryVersion;
      readonly now: bigint;
      readonly anchors: readonly Anchor[];
    }
  | {
      readonly electionId: Uint8Array;
      readonly boardEntryVersion: BoardEntryVersion;
      readonly l1: L1Evidence;
    };

/** Whether the definition's ballots are proved under the one membership key this release pins (ballot versions 1 and 2). */
function provedUnderPinnedKey(d: ElectionDefinitionRecord["value"]): boolean {
  const pinned = pinnedVersion(d, RECORD_TYPES.ballot);
  return pinned === 1 || pinned === 2;
}

/**
 * What the checks take from a decoded definition, by its version: its hash,
 * its stub hash (which the key ceremony binds) and the first well-formedness
 * rule it breaks. Exhaustive: a version crypto adds doesn't compile until it
 * is read here (docs/spec/election-definition.md, Layout; T-34, T-37).
 */
function readDefinition(record: ElectionDefinitionRecord): {
  readonly hash: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly rule: ElectionDefinitionV4Rule | undefined;
} {
  switch (record.version) {
    case 1:
      return {
        hash: electionDefinitionHash(record.value),
        stubHash: electionStubHash(record.value),
        rule: electionDefinitionRule(record.value),
      };
    case 3:
      return {
        hash: electionDefinitionV3Hash(record.value),
        stubHash: electionStubV3Hash(record.value),
        rule: electionDefinitionV3Rule(record.value),
      };
    case 4:
      return {
        hash: electionDefinitionV4Hash(record.value),
        stubHash: electionStubV4Hash(record.value),
        rule: electionDefinitionV4Rule(record.value),
      };
    default: {
      const unread: never = record;
      throw new Error(`unread definition version ${String(unread)}`);
    }
  }
}

/**
 * A format-3 or format-4 bundle's definition (docs/spec/verifier.md, Definition): its
 * decoding and well-formedness, which are part of 2.1, the board-entry
 * version its profile pins, and the board checks' inputs taken from it. Any
 * other format gives them as they are.
 */
function fromDefinition(bundle: Bundle):
  | {
      readonly inputs: BoardInputs;
      readonly hash?: Uint8Array;
      readonly definition?: ElectionDefinitionRecord;
      readonly stubHash?: Uint8Array;
      /** 2.3's row when the profile's versions don't fit together, or pin one this verifier doesn't know. */
      readonly profile?: Outcome;
    }
  | {
      readonly rows: ReadonlyMap<string, Outcome>;
      readonly hash?: Uint8Array;
    } {
  if (bundle.format === "abolish-verifier-bundle/1") return { inputs: bundle };
  if (bundle.format === "abolish-verifier-bundle/2") return { inputs: bundle };
  // The board checks need the election and the version: without them they
  // can't run, so 4.1 and 4.2 are not reached, and neither are the ceremony
  // checks and ballot admission of format 4, which read the board.
  const ceremonyRows: [string, Outcome][] =
    bundle.format === "abolish-verifier-bundle/4"
      ? [
          ["2.5", NOT_REACHED],
          ["3.1", NOT_REACHED],
          ["3.2", NOT_REACHED],
          ["5.1", NOT_REACHED],
          ["5.2", NOT_REACHED],
          ["5.3", NOT_REACHED],
          ["5.4", NOT_REACHED],
          ["5.7", NOT_REACHED],
          ["6.2", NOT_REACHED],
          ["7.4", NOT_REACHED],
        ]
      : [];
  const stopped = (row: string, outcome: Outcome, hash?: Uint8Array) => ({
    rows: new Map([...ceremonyRows, [row, outcome], ["4.1", NOT_REACHED], ["4.2", NOT_REACHED]]),
    ...(hash !== undefined && { hash }),
  });
  let record;
  try {
    record = decodeElectionDefinitionRecord(bundle.definition);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    // A definition version this verifier doesn't know may be one a later
    // release reads, so, like an unknown board-entry version below, it
    // leaves the election unverifiable, never failed: releases must not
    // disagree on a verdict (T-36). Version 0 can't be any release's:
    // `profile-version` forbids pinning it, and the self-pin check requires
    // the record's version to equal its pin. The version byte is offset 2.
    if (e.code === "unknown-version" && e.offset === 2 && bundle.definition[2] !== 0)
      return stopped("2.3", UNSUPPORTED);
    return stopped("2.1", { status: "fail", code: "decode", at: { decodeError: e.code } });
  }
  const definition = record.value;
  const { hash, stubHash, rule } = readDefinition(record);
  if (rule !== undefined) return stopped("2.1", { status: "fail", code: rule, at: {} }, hash);
  // A version this verifier can't read may be one a later release supports,
  // so it leaves the election unverifiable here, never failed (2.3).
  const version = pinnedVersion(definition, RECORD_TYPES.boardEntry);
  if (!isReadable(version)) return stopped("2.3", UNSUPPORTED, hash);
  let combination: Outcome | undefined;
  const pins = profileCombinationRule(definition);
  switch (pins) {
    case undefined:
      break;
    case "profile-combination":
      combination = { status: "fail", code: "profile-combination", at: {} };
      break;
    case "unsupported-version":
      // The board-entry version is one this verifier reads, so another pin is
      // one a later release may know (a ballot or spoiled-ballot opening
      // version it doesn't): unverifiable, never failed, so releases agree
      // (T-36). The board checks still run, as for a failing combination.
      combination = UNSUPPORTED;
      break;
    default: {
      const unknown: never = pins;
      throw new Error(`unmapped profile rule ${String(unknown)}`);
    }
  }
  return {
    hash,
    definition: record,
    stubHash,
    ...(combination !== undefined && { profile: combination }),
    inputs: {
      electionId: definition.election_id,
      boardEntryVersion: version,
      l1: { ...bundle.l1, anchor: definition.l1_anchor },
    },
  };
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const READABLE: ReadonlySet<number> = new Set<BoardEntryVersion>([1, 3, 4]);
const isReadable = (v: number | undefined): v is BoardEntryVersion =>
  v !== undefined && READABLE.has(v);

/** The board checks' anchors and `now`: given as they are, or read from L1 state. */
function anchoring(
  bundle: Bundle,
  inputs: BoardInputs,
):
  | {
      readonly anchors: readonly Anchor[];
      readonly now: bigint;
      readonly read?: readonly StateAnchor[];
    }
  | L1Error {
  if (!("l1" in inputs)) return { anchors: inputs.anchors, now: inputs.now };
  try {
    const read = anchorsFromState(inputs.l1, inputs.electionId, bundle.entries, bundle.clock);
    return { anchors: read.map((a) => a.anchor), now: inputs.l1.header.timestamp, read };
  } catch (e) {
    if (e instanceof L1Error) return e;
    throw e;
  }
}

/** Runs the board checks and maps them onto 4.1 and 4.2. */
function runBoard(
  bundle: Bundle,
  inputs: BoardInputs,
  anchors: readonly Anchor[],
  now: bigint,
): { board: Report["board"]; outcomes: readonly [Outcome, Outcome] } {
  try {
    const verified = verifyBoard(
      inputs.electionId,
      bundle.entries,
      inputs.boardEntryVersion,
      anchors,
      bundle.clock,
      now,
    );
    return {
      board: {
        entries: bundle.entries.length,
        unreadableBytes: bundle.unreadableBytes,
        unauthenticated: verified.unauthenticated,
      },
      outcomes: [PASS, PASS],
    };
  } catch (e) {
    if (!(e instanceof BoardError)) throw e;
    return {
      board: { entries: bundle.entries.length, unreadableBytes: bundle.unreadableBytes },
      outcomes: boardOutcomes(e),
    };
  }
}

/** Runs every check over one bundle and reports it (docs/spec/verifier.md, Report). */
export function verifyBundle(bundle: Bundle): Report {
  const definition = fromDefinition(bundle);
  const unsplit = { entries: bundle.entries.length, unreadableBytes: bundle.unreadableBytes };
  let board: Report["board"] = unsplit;
  let input: ReturnType<typeof anchoring> | undefined;
  let implemented: ReadonlyMap<string, Outcome>;
  let ceremony: CeremonyReport | undefined;
  let ballots: BallotsReport | undefined;
  let openings: readonly OpeningReport[] | undefined;
  let tallies: readonly TallyReport[] | undefined;
  if ("rows" in definition) implemented = definition.rows;
  else {
    input = anchoring(bundle, definition.inputs);
    let outcomes: readonly [Outcome, Outcome];
    if (input instanceof L1Error) {
      // Words that can't be read leave the board checks without anchors:
      // never a failure, since no one but L1 itself can settle them (T-53).
      outcomes = [
        NOT_REACHED,
        {
          status: "unverifiable",
          code: input.code,
          at: input.segment === undefined ? {} : { segment: input.segment },
        },
      ];
    } else ({ board, outcomes } = runBoard(bundle, definition.inputs, input.anchors, input.now));
    implemented = new Map([
      ["4.1", outcomes[0]],
      ["4.2", outcomes[1]],
      // A failing combination doesn't stop the checks: the pinned version is
      // one this verifier reads, so the report still shows what the board holds.
      ...(definition.profile !== undefined ? [["2.3", definition.profile] as const] : []),
      // Definition versions 1 and 3 list no receipt keys, so 2.9 has nothing
      // to check; version 4's keys are judged by the anchor's record, read
      // from L1 state whatever the board checks found. Formats 1 and 2 carry
      // no definition, so 2.9 stays unverifiable there, never a pass.
      ...(definition.definition === undefined
        ? []
        : [
            [
              "2.9",
              definition.definition.version !== 4
                ? PASS
                : "l1" in definition.inputs
                  ? receiptKeyRow(
                      definition.inputs.l1,
                      definition.definition.value.receipt_keys,
                      definition.definition.value.opens_at,
                    )
                  : // Never a pass without the record: every definition-bearing
                    // format carries L1 evidence today.
                    NOT_IMPLEMENTED,
            ] as const,
          ]),
      ...(carriesDestruction(definition.inputs.boardEntryVersion)
        ? []
        : [["8.5", NOT_APPLICABLE] as const]),
      // 1.3 also covers the keys inside the verifier contracts the election
      // uses, which aren't read yet: it can fail here, never pass. Only
      // ballot versions 1 and 2's key (one key: a version-2 ballot proves
      // membership of its cell's tree under it) is pinned here; a version
      // this verifier doesn't read may have a key a later release pins, so
      // releases agree (T-36).
      ...(definition.definition !== undefined &&
      provedUnderPinnedKey(definition.definition.value) &&
      !equal(definition.definition.value.membership_vk_hash, membershipVkHash())
        ? [["1.3", { status: "fail", code: "membership-key", at: {} }] as const]
        : []),
    ]);
    // The transcript's bytes are authenticated by the definition's hash of
    // them, not by the board checks, so they run whatever 4.1 and 4.2 found.
    if (
      bundle.format === "abolish-verifier-bundle/4" &&
      definition.definition !== undefined &&
      definition.hash !== undefined &&
      definition.stubHash !== undefined
    ) {
      const checked = ceremonyChecks(
        definition.definition.value,
        definition.stubHash,
        bundle.panel,
        bundle.entries,
        definition.inputs.boardEntryVersion,
      );
      implemented = new Map([...implemented, ...checked.rows]);
      ceremony = checked.report;
      // Admission is judged per entry from the record's own bytes, so, like
      // the transcript, it runs whatever 4.1 and 4.2 found: the verdict
      // rests on them anyway (docs/spec/verifier.md, Ballot admission).
      const admission = ballotChecks(
        definition.definition,
        checked.registered,
        bundle.entries,
        definition.inputs.boardEntryVersion,
      );
      implemented = new Map<string, Outcome>([...implemented, ...admission.rows]);
      ballots = admission.report;
      // Sorting and attribution need only the definition and the registered
      // signing keys, so 7.4 runs wherever 3.2 passed, under definition
      // versions 3 and 4 against their cells (docs/spec/verifier.md, Tally
      // openings).
      const opened = tallyChecks(
        definition.definition,
        definition.hash,
        checked.registered,
        bundle.entries,
        definition.inputs.boardEntryVersion,
      );
      implemented = new Map<string, Outcome>([...implemented, ["7.4", opened.row]]);
      tallies = opened.report;
      if (definition.definition.version === 1) {
        // An opening is checked against the same registered election, and
        // `opening-cast` against the ballots admission admitted, so 6.2 is
        // reached exactly where admission is.
        const spoiled = openingChecks(
          definition.definition.value,
          admission.admitted === undefined || checked.registered === undefined
            ? undefined
            : ballotElection(definition.definition.value, checked.registered),
          admission.admitted,
          bundle.entries,
          definition.inputs.boardEntryVersion,
          bundle.clock,
        );
        implemented = new Map<string, Outcome>([...implemented, ["6.2", spoiled.row]]);
        openings = spoiled.report;
      } else {
        // Under definition versions 3 and 4 an opening opens a version-2
        // core, which only spoiled-ballot opening version 2 does, and this
        // verifier doesn't read it yet (P2-14 part 5): unsupported under
        // either pin other than version 1, whether or not admission ran
        // (T-36); with both at version 1, which 2.3 fails, not reached, as
        // admission is.
        const d = definition.definition.value;
        const v1Pins =
          pinnedVersion(d, RECORD_TYPES.ballot) === 1 &&
          pinnedVersion(d, RECORD_TYPES.spoiledBallotOpening) === 1;
        implemented = new Map<string, Outcome>([
          ...implemented,
          ["6.2", v1Pins ? NOT_REACHED : UNSUPPORTED],
        ]);
      }
    }
  }
  const checks = CHECKS.map((c): CheckResult => ({
    id: c.id,
    kind: c.kind,
    ...(implemented.get(c.id) ?? { status: "unverifiable", code: "not-implemented" }),
  }));
  const verdictAgainstInputs = judge(checks);
  const sources = Object.values(bundle.sources) as InputSource[];
  return {
    format: REPORT_FORMAT,
    verdict: sources.every(authenticated) ? verdictAgainstInputs : "unverifiable",
    verdictAgainstInputs,
    inputs: { ...bundle.sources },
    ...(definition.hash !== undefined && { definition: { hash: bytesToHex(definition.hash) } }),
    ...(ceremony !== undefined && { ceremony }),
    ...(ballots !== undefined && { ballots }),
    ...(openings !== undefined && { openings }),
    ...(tallies !== undefined && { tallies }),
    board,
    ...(bundle.format !== "abolish-verifier-bundle/1" && {
      l1: {
        blockHash: bytesToHex(bundle.l1.header.hash),
        blockNumber: bundle.l1.header.number.toString(),
        timestamp: bundle.l1.header.timestamp.toString(),
        ...(input !== undefined &&
          !(input instanceof L1Error) &&
          input.read !== undefined && {
            anchors: input.read.map((a) => ({
              segment: a.anchor.checkpoint.segment,
              hash: bytesToHex(a.hash),
              source: a.source,
            })),
          }),
      },
    }),
    checks,
  };
}
