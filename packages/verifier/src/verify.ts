// Runs the checks of docs/spec/verifier.md over one bundle and builds the
// report (Procedure, Verdicts, Report). Only the board checks (4.1, 4.2) and
// the definition's decoding and well-formedness (part of 2.1) are
// implemented; every other check is reported unverifiable, so no run can
// report an election verified yet. A run on unauthenticated inputs reports
// what the checks found against them, but its verdict stays unverifiable, so
// a crafted bundle can neither verify nor fail an election (T-53, T-24).

import {
  type Anchor,
  BoardError,
  type BoardErrorAt,
  type BoardErrorCode,
  DecodeError,
  type DecodeErrorCode,
  decodeElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  type ElectionDefinitionRule,
  pinnedVersion,
  RECORD_TYPES,
  verifyBoard,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Bundle, InputSource, InputSources } from "./bundle.ts";
import { CHECKS, type CheckKind } from "./checks.ts";
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
  | ElectionDefinitionRule
  | "unsupported-version"
  | "not-reached"
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
  /** A format-3 bundle's definition hash, once the definition decodes. */
  readonly definition?: { readonly hash: string };
  readonly board: {
    readonly entries: number;
    readonly unreadableBytes: number;
    readonly unauthenticated?: number;
  };
  /** The L1 block a format-2 bundle was proven at, and the anchors read from its state. */
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
      readonly boardEntryVersion: 1;
      readonly now: bigint;
      readonly anchors: readonly Anchor[];
    }
  | {
      readonly electionId: Uint8Array;
      readonly boardEntryVersion: 1;
      readonly l1: L1Evidence;
    };

/**
 * A format-3 bundle's definition (docs/spec/verifier.md, Definition): its
 * decoding and well-formedness, which are part of 2.1, the board-entry
 * version its profile pins, and the board checks' inputs taken from it. Any
 * other format gives them as they are.
 */
function fromDefinition(bundle: Bundle):
  | { readonly inputs: BoardInputs; readonly hash?: Uint8Array }
  | {
      readonly rows: ReadonlyMap<string, Outcome>;
      readonly hash?: Uint8Array;
    } {
  if (bundle.format === "abolish-verifier-bundle/1") return { inputs: bundle };
  if (bundle.format === "abolish-verifier-bundle/2") return { inputs: bundle };
  // The board checks need the election and the version: without them they
  // can't run, so 4.1 and 4.2 are not reached.
  const stopped = (row: string, outcome: Outcome, hash?: Uint8Array) => ({
    rows: new Map([
      [row, outcome],
      ["4.1", NOT_REACHED],
      ["4.2", NOT_REACHED],
    ]),
    ...(hash !== undefined && { hash }),
  });
  let definition;
  try {
    definition = decodeElectionDefinition(bundle.definition);
  } catch (e) {
    if (!(e instanceof DecodeError)) throw e;
    return stopped("2.1", { status: "fail", code: "decode", at: { decodeError: e.code } });
  }
  const hash = electionDefinitionHash(definition);
  const rule = electionDefinitionRule(definition);
  if (rule !== undefined) return stopped("2.1", { status: "fail", code: rule, at: {} }, hash);
  // A version this verifier can't read may be one a later release supports,
  // so it leaves the election unverifiable here, never failed (2.3).
  const version = pinnedVersion(definition, RECORD_TYPES.boardEntry);
  if (version !== 1)
    return stopped("2.3", { status: "unverifiable", code: "unsupported-version", at: {} }, hash);
  return {
    hash,
    inputs: {
      electionId: definition.election_id,
      boardEntryVersion: version,
      l1: { ...bundle.l1, anchor: definition.l1_anchor },
    },
  };
}

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
    ]);
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
