// The bodies the node and a coordinator exchange (README, Transport). They
// are this transport's own envelopes, not protocol bytes: nothing in them is
// signed, hashed or archived as a whole. What the node signs and checks is
// inside them in its spec encoding, the stub as an election-definition
// record and the rounds as a ceremony transcript record
// (docs/spec/ceremony.md, Transcript), so the node decodes them with the
// codecs it checks with, never with a schema of its own.
import {
  bytesFixed,
  bytesVar,
  type CeremonyTranscript,
  decode,
  decodeCeremonyTranscript,
  DecodeError,
  encode,
  list,
  p256Sig,
  struct,
} from "@abolishus/crypto";
import { decodeStub, stubHash } from "./stub.ts";

const HASH = bytesFixed(32);
/** Bound on an encoded stub or transcript; a 16-seat transcript is about 300 KiB. */
export const MAX_RECORD = 1 << 20;
/** Bound on the requests one poll returns. */
export const MAX_REQUESTS = 16;
/** Bound on any body either side reads, so a peer can't exhaust the other's memory. */
export const MAX_BODY = 4 + MAX_REQUESTS * (8 + 2 * MAX_RECORD);

const REQUEST = struct([
  ["stub", bytesVar(MAX_RECORD)],
  ["transcript", bytesVar(MAX_RECORD)],
] as const);
const REQUESTS = list(REQUEST, MAX_REQUESTS);
const MESSAGE = struct([
  ["stub_hash", HASH],
  ["transcript", bytesVar(MAX_RECORD)],
] as const);
const APPROVAL = struct([
  ["stub_hash", HASH],
  ["ceremony_transcript_hash", HASH],
  ["key_set_hash", HASH],
  ["signature", p256Sig],
] as const);

/**
 * What the coordinator asks of a seat: the stub, and a transcript holding the
 * rounds it has closed so far. The round asked for is the first empty one;
 * a transcript with all four rounds is one to approve.
 */
export interface CeremonyRequest {
  readonly stub: Uint8Array;
  readonly transcript: Uint8Array;
}

/** A seat's message for one round: a transcript holding only that message, in its round. */
export interface MessagePost {
  readonly stub_hash: Uint8Array;
  readonly transcript: Uint8Array;
}

/** A seat's ceremony registration signature, with the fields the coordinator can't rebuild. */
export interface ApprovalPost {
  readonly stub_hash: Uint8Array;
  readonly ceremony_transcript_hash: Uint8Array;
  readonly key_set_hash: Uint8Array;
  readonly signature: Uint8Array;
}

export const encodeRequests = (requests: readonly CeremonyRequest[]) => encode(REQUESTS, requests);
/** Throws `DecodeError` on a body with no decoding. */
export const decodeRequests = (bytes: Uint8Array): readonly CeremonyRequest[] =>
  decode(REQUESTS, bytes);
export const encodeMessagePost = (post: MessagePost) => encode(MESSAGE, post);
export const decodeMessagePost = (bytes: Uint8Array): MessagePost => decode(MESSAGE, bytes);
export const encodeApprovalPost = (post: ApprovalPost) => encode(APPROVAL, post);
export const decodeApprovalPost = (bytes: Uint8Array): ApprovalPost => decode(APPROVAL, bytes);

export type Asked = 1 | 2 | 3 | 4 | "approve";

const ROUNDS = ["keys", "challenges", "answers", "reveals"] as const;

/**
 * The round a transcript asks for: its first empty round, or `approve` when
 * all four hold messages; `undefined` when a later round holds messages
 * after an empty one, which no coordinator closes.
 */
export function asked(t: CeremonyTranscript): Asked | undefined {
  const first = ROUNDS.findIndex((r) => t[r].length === 0);
  if (first === -1) return "approve";
  if (ROUNDS.slice(first).some((r) => t[r].length > 0)) return undefined;
  return (first + 1) as 1 | 2 | 3 | 4;
}

/** The transcript of a request under version 1, the only one this release reads. */
export const requestTranscript = (bytes: Uint8Array) => decodeCeremonyTranscript(bytes, 1);

/**
 * `stub_hash` recomputed from the stub's bytes, never taken from the
 * coordinator (docs/spec/ceremony.md, Stub checks 1). Only the seat's stub
 * checks decide whether the node takes part; this hash only names a run.
 */
export function stubHashOf(stub: Uint8Array): Uint8Array | undefined {
  // The versions the stub checks read (stub.ts).
  try {
    return stubHash(decodeStub(stub));
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
}
