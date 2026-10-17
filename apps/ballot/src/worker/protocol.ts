// The messages between the page and the ballot worker. Versioned, so a page
// and a worker from different builds (a stale cache) refuse each other rather
// than misread a message. Each request carries an id its response repeats.
//
// The worker holds what must never leave the device (the identity secret
// while it builds a membership proof's witness, and the plaintext choice
// and its randomness in a seal), and the page does all I/O. A worker
// takes no CSP from the page's <meta>, so on a host that sends no CSP header
// nothing in the browser restricts it: only the absence of network APIs from
// its bytes keeps it off the network (T-43).

import type { MembershipProverErrorCode, Panel } from "@abolishus/crypto";

import type { ElectionCheck } from "../election.ts";

export const PROTOCOL_VERSION = 2;

/**
 * How long the prover may take. Generous: a proof took 24 s in Chromium at
 * 6× CPU throttling (P2-21 part 1), and a slow phone may take longer.
 */
export const PROVER_TIMEOUT_MS = 180_000;

export interface CheckElectionRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "check-election";
  readonly electionId: Uint8Array;
  /** The definition hash the L2 election registry holds for `electionId`. */
  readonly registeredHash: Uint8Array;
  readonly definition: Uint8Array;
  readonly displayText: Uint8Array;
  /**
   * Board entries that may carry the election's ceremony transcript (the
   * board's first, where the operator boards it), and the panels this build
   * pins: a version-5 poll is shown only once its transcript checks under
   * the panel it names (`sealingElectionV5`; T-37, T-54).
   */
  readonly entries: readonly Uint8Array[];
  readonly panels: readonly Panel[];
}

/**
 * Seals `votes` (0 or 1 per option, every question's options in order) in
 * `cell` of the version-5 poll the worker last checked, which
 * `definitionHash` must name: the worker keeps the seal and answers with its
 * tracking code (docs/spec/challenge.md, Client rules; T-42).
 */
export interface SealRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "seal";
  readonly definitionHash: Uint8Array;
  readonly cell: number;
  readonly votes: readonly (0 | 1)[];
}

/** The voter challenged seal `seal`: its opening, and the seal is spent (T-42, T-45). */
export interface ChallengeRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "challenge";
  readonly seal: number;
}

/**
 * A membership proof for `secret` in the tier (or cell) whose leaves these
 * are, under the statement's values (`MembershipStatement`, which the page
 * took from a definition the worker checked). The worker builds the witness,
 * sends it to the prover worker over `prover` (a port the page made and
 * handed the prover worker's other end), and finishes what comes back: the
 * page never sees the witness, and the prover never sees what leaves the
 * device (docs/spec/membership.md, Security notes; T-12, T-55).
 */
export interface ProveMembershipRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "prove-membership";
  /** 32 bytes; the worker zeroes its copy once the witness is built. */
  readonly secret: Uint8Array;
  readonly leaves: readonly bigint[];
  readonly definitionHash: Uint8Array;
  readonly tier: number;
  readonly root: bigint;
  /** `M`, 32 bytes (docs/spec/revoting.md). */
  readonly message: Uint8Array;
  readonly prover: MessagePort;
}

export type WorkerRequest =
  | CheckElectionRequest
  | ProveMembershipRequest
  | SealRequest
  | ChallengeRequest;

/**
 * Why no proof came back: one of `MembershipProverError`'s codes, or
 * `prover` when the prover worker failed, answered out of turn or not in
 * time. Each is a reason the client shows, never a retry.
 */
export type MembershipProofProblem = MembershipProverErrorCode | "prover";

export type MembershipProofResult =
  | { readonly ok: true; readonly proof: Uint8Array }
  | { readonly ok: false; readonly problem: MembershipProofProblem };

/**
 * A seal, or why none was made: no version-5 poll checked under that
 * definition hash in this worker, or votes or a cell the poll doesn't allow,
 * which the question screens never send.
 */
export type SealResult =
  | { readonly ok: true; readonly seal: number; readonly trackingCode: Uint8Array }
  | { readonly ok: false; readonly problem: "no-election" | "refused" };

/** The opening (`0x0003` version 2) of a seal, or `unknown` for one this worker doesn't hold. */
export type ChallengeResult =
  | { readonly ok: true; readonly opening: Uint8Array; readonly trackingCode: Uint8Array }
  | { readonly ok: false; readonly problem: "unknown" };

export type WorkerResponse =
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "check-election";
      readonly result: ElectionCheck;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "prove-membership";
      readonly result: MembershipProofResult;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "seal";
      readonly result: SealResult;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "challenge";
      readonly result: ChallengeResult;
    }
  /** The request was malformed or the worker failed; it names no detail, which could quote a secret. */
  | { readonly v: typeof PROTOCOL_VERSION; readonly id: number; readonly kind: "error" };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

const isBytes = (x: unknown, length?: number): x is Uint8Array =>
  x instanceof Uint8Array && (length === undefined || x.length === length);

const hasKeys = (data: Record<string, unknown>, expected: readonly string[]) => {
  const keys = Object.keys(data).sort();
  return keys.length === expected.length && keys.every((k, i) => k === expected[i]);
};

const CHECK_KEYS = [
  "definition",
  "displayText",
  "electionId",
  "entries",
  "id",
  "kind",
  "panels",
  "registeredHash",
  "v",
];
const SEAL_KEYS = ["cell", "definitionHash", "id", "kind", "v", "votes"];
const CHALLENGE_KEYS = ["id", "kind", "seal", "v"];

const isPanel = (x: unknown): x is Panel =>
  isRecord(x) &&
  hasKeys(x, ["keys", "threshold"]) &&
  Number.isSafeInteger(x["threshold"]) &&
  Array.isArray(x["keys"]) &&
  x["keys"].every((k) => isBytes(k));
const PROVE_KEYS = [
  "definitionHash",
  "id",
  "kind",
  "leaves",
  "message",
  "prover",
  "root",
  "secret",
  "tier",
  "v",
];

/**
 * A request the worker accepts, or `undefined`: exact keys and exact types.
 * Only the shapes are checked here; the values (the secret's range, the
 * tier, the leaves and root) are `membershipProverInput`'s to refuse.
 */
export function parseRequest(data: unknown): WorkerRequest | undefined {
  if (!isRecord(data) || data["v"] !== PROTOCOL_VERSION || !isId(data["id"])) return undefined;
  const v = PROTOCOL_VERSION;
  const id = data["id"];
  if (data["kind"] === "check-election") {
    if (!hasKeys(data, CHECK_KEYS)) return undefined;
    const { electionId, registeredHash, definition, displayText, entries, panels } = data;
    if (
      !isBytes(electionId, 32) ||
      !isBytes(registeredHash, 32) ||
      !isBytes(definition) ||
      !isBytes(displayText) ||
      !Array.isArray(entries) ||
      !entries.every((e) => isBytes(e)) ||
      !Array.isArray(panels) ||
      !panels.every(isPanel)
    )
      return undefined;
    return {
      v,
      id,
      kind: "check-election",
      electionId,
      registeredHash,
      definition,
      displayText,
      entries: entries as Uint8Array[],
      panels: panels as Panel[],
    };
  }
  if (data["kind"] === "seal") {
    if (!hasKeys(data, SEAL_KEYS)) return undefined;
    const { definitionHash, cell, votes } = data;
    if (
      !isBytes(definitionHash, 32) ||
      !Number.isSafeInteger(cell) ||
      !Array.isArray(votes) ||
      !votes.every((x) => x === 0 || x === 1)
    )
      return undefined;
    return {
      v,
      id,
      kind: "seal",
      definitionHash,
      cell: cell as number,
      votes: votes as (0 | 1)[],
    };
  }
  if (data["kind"] === "challenge") {
    if (!hasKeys(data, CHALLENGE_KEYS) || !isId(data["seal"])) return undefined;
    return { v, id, kind: "challenge", seal: data["seal"] };
  }
  if (data["kind"] === "prove-membership") {
    if (!hasKeys(data, PROVE_KEYS)) return undefined;
    const { secret, leaves, definitionHash, tier, root, message, prover } = data;
    if (
      !isBytes(secret, 32) ||
      !Array.isArray(leaves) ||
      !leaves.every((leaf) => typeof leaf === "bigint") ||
      !isBytes(definitionHash, 32) ||
      !Number.isSafeInteger(tier) ||
      typeof root !== "bigint" ||
      !isBytes(message, 32) ||
      !(prover instanceof MessagePort)
    )
      return undefined;
    return {
      v,
      id,
      kind: "prove-membership",
      secret,
      leaves: leaves as bigint[],
      definitionHash,
      tier: tier as number,
      root,
      message,
      prover,
    };
  }
  return undefined;
}

/** The id of a request the worker refuses, so its error can be matched; `undefined` if it has none. */
export function requestId(data: unknown): number | undefined {
  return isRecord(data) && isId(data["id"]) ? data["id"] : undefined;
}

const RESPONSE_KINDS: ReadonlySet<unknown> = new Set([
  "check-election",
  "prove-membership",
  "seal",
  "challenge",
  "error",
]);

/** The request id a response answers, if it is one of this version's responses. */
export function responseId(data: unknown): number | undefined {
  if (!isRecord(data) || data["v"] !== PROTOCOL_VERSION || !isId(data["id"])) return undefined;
  return RESPONSE_KINDS.has(data["kind"]) ? data["id"] : undefined;
}
