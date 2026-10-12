// The messages between the page and the ballot worker. Versioned, so a page
// and a worker from different builds (a stale cache) refuse each other rather
// than misread a message. Each request carries an id its response repeats.
//
// The worker holds what must never leave the device (from part 3, the
// plaintext choice and its randomness), and the page does all I/O; a worker
// takes no CSP from the page, so it has no network of its own (T-43).

import type { ElectionCheck } from "../election.ts";

export const PROTOCOL_VERSION = 1;

export interface CheckElectionRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "check-election";
  readonly electionId: Uint8Array;
  readonly definition: Uint8Array;
  readonly displayText: Uint8Array;
}

export type WorkerRequest = CheckElectionRequest;

export type WorkerResponse =
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "check-election";
      readonly result: ElectionCheck;
    }
  /** The request was malformed or the worker failed; it names no detail, which could quote a secret. */
  | { readonly v: typeof PROTOCOL_VERSION; readonly id: number; readonly kind: "error" };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

const REQUEST_KEYS = ["definition", "displayText", "electionId", "id", "kind", "v"];

/** A request the worker accepts, or `undefined`: exact keys, exact types, a 32-byte election id. */
export function parseRequest(data: unknown): WorkerRequest | undefined {
  if (!isRecord(data)) return undefined;
  const keys = Object.keys(data).sort();
  if (keys.length !== REQUEST_KEYS.length || !keys.every((k, i) => k === REQUEST_KEYS[i]))
    return undefined;
  const { v, id, kind, electionId, definition, displayText } = data;
  if (v !== PROTOCOL_VERSION || !isId(id) || kind !== "check-election") return undefined;
  if (
    !(electionId instanceof Uint8Array) ||
    electionId.length !== 32 ||
    !(definition instanceof Uint8Array) ||
    !(displayText instanceof Uint8Array)
  )
    return undefined;
  return { v, id, kind, electionId, definition, displayText };
}

/** The id of a request the worker refuses, so its error can be matched; `undefined` if it has none. */
export function requestId(data: unknown): number | undefined {
  return isRecord(data) && isId(data["id"]) ? data["id"] : undefined;
}

/** The request id a response answers, if it is one of this version's responses. */
export function responseId(data: unknown): number | undefined {
  if (!isRecord(data) || data["v"] !== PROTOCOL_VERSION || !isId(data["id"])) return undefined;
  return data["kind"] === "check-election" || data["kind"] === "error" ? data["id"] : undefined;
}
