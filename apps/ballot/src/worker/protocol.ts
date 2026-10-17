// The messages between the page and the ballot worker. Versioned, so a page
// and a worker from different builds (a stale cache) refuse each other rather
// than misread a message. Each request carries an id its response repeats.
//
// The worker holds what must never leave the device (the identity secret
// while it builds a membership proof's witness, and from P2-8 part 3 the
// plaintext choice and its randomness), and the page does all I/O. A worker
// takes no CSP from the page's <meta>, so on a host that sends no CSP header
// nothing in the browser restricts it: only the absence of network APIs from
// its bytes keeps it off the network (T-43).

import type { MembershipProverErrorCode } from "@abolishus/crypto";

import type { ElectionCheck } from "../election.ts";

export const PROTOCOL_VERSION = 1;

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

export type WorkerRequest = CheckElectionRequest | ProveMembershipRequest;

/**
 * Why no proof came back: one of `MembershipProverError`'s codes, or
 * `prover` when the prover worker failed, answered out of turn or not in
 * time. Each is a reason the client shows, never a retry.
 */
export type MembershipProofProblem = MembershipProverErrorCode | "prover";

export type MembershipProofResult =
  | { readonly ok: true; readonly proof: Uint8Array }
  | { readonly ok: false; readonly problem: MembershipProofProblem };

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

const CHECK_KEYS = ["definition", "displayText", "electionId", "id", "kind", "registeredHash", "v"];
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
    const { electionId, registeredHash, definition, displayText } = data;
    if (
      !isBytes(electionId, 32) ||
      !isBytes(registeredHash, 32) ||
      !isBytes(definition) ||
      !isBytes(displayText)
    )
      return undefined;
    return { v, id, kind: "check-election", electionId, registeredHash, definition, displayText };
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

/** The request id a response answers, if it is one of this version's responses. */
export function responseId(data: unknown): number | undefined {
  if (!isRecord(data) || data["v"] !== PROTOCOL_VERSION || !isId(data["id"])) return undefined;
  return data["kind"] === "check-election" ||
    data["kind"] === "prove-membership" ||
    data["kind"] === "error"
    ? data["id"]
    : undefined;
}
