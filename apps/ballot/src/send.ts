// Sending a cast ballot to the board operator (`ballots.submit`) and judging
// its answer ([[receipts]], Checks at cast). The ballot record is public, so
// only its bytes go, from the record this device kept before sending
// (casts.ts; [[revoting]], Client rule 3): the plaintext, the randomness and
// the identity secret never reach the page, let alone the request (T-12).
//
// The operator signs no receipt yet (P2-3), so a boarded answer is only the
// operator's word: the client checks that its entry names this election and
// carries exactly the bytes sent, and says no more than that (T-26, T-38).

import { type BoardEntry, type BoardEntryVersion, decodeBoardEntry } from "@abolishus/crypto";

import { MAX_ANSWER, readJson } from "./answer.ts";
import type { Boarded } from "./casts.ts";
import type { Deployment } from "./deployment.ts";
import type { Fetch } from "./load.ts";

/** What the route answered, as the client acts on it. */
export type SendAnswer =
  /** Boarded: the entry and link the operator says carry it, unchecked until `checkBoarded`. */
  | { readonly kind: "boarded"; readonly entry: string; readonly link: string }
  /** The ballot failed decoding or an admission check, with the verifier's code (`repeat`: a copy in other bytes is on the board). */
  | { readonly kind: "rejected"; readonly code: string }
  /** The request is outside the route's forms: a bug of this client, not the voter's. */
  | { readonly kind: "malformed" }
  /** This server knows no such election. */
  | { readonly kind: "not-found" }
  /** The election isn't accepting ballots, by the server's clock. */
  | { readonly kind: "not-open" }
  /** Too many requests: send the same bytes again later. */
  | { readonly kind: "busy" }
  /** Not judged in time; the ballot may be boarded: send the same bytes again. */
  | { readonly kind: "unavailable" }
  /** The network failed, or the answer isn't one the route gives. */
  | { readonly kind: "unreachable" };

/** What a board entry adds around its payload (docs/spec/board.md): header, id, index, segment, length. */
const BOARD_ENTRY_OVERHEAD = 3 + 32 + 8 + 4 + 4;

// The route's error codes (`ErrorCode` in @abolishus/api-contract).
const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_CODE = 64;

const HEX = /^(?:[0-9a-f]{2})*$/;

// Each refusal the route defines without data, by its status and code: a
// code at another status isn't the route's (a proxy's page, say) and is
// read as unreachable.
const REFUSALS: Readonly<Record<string, readonly [number, SendAnswer]>> = {
  BAD_REQUEST: [400, { kind: "malformed" }],
  ELECTION_NOT_FOUND: [404, { kind: "not-found" }],
  ELECTION_NOT_OPEN: [409, { kind: "not-open" }],
  RATE_LIMITED: [429, { kind: "busy" }],
  BALLOTS_UNAVAILABLE: [503, { kind: "unavailable" }],
};

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Lowercase hex, already checked, to bytes. */
const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

/**
 * The largest answer to sending `ballot`: its entry, which is the ballot
 * and the entry's fixed fields, and the link, both as hex, in the route's
 * JSON object (T-52).
 */
const maxAnswer = (ballot: Uint8Array) =>
  Math.max(MAX_ANSWER, 2 * (ballot.length + BOARD_ENTRY_OVERHEAD) + 2 * 32 + 64);

/**
 * Sends `ballot`, the bytes of a recorded cast, to the deployment's ballot
 * route for `electionId`, and reads the answer. Like every request the
 * client makes, it carries no cookie, referrer or credential, so the server
 * can't tie the ballot to an account (T-10), and follows no redirect. A
 * retry sends these same bytes again, never a new ballot ([[revoting]],
 * Client rule 3; T-25).
 */
export async function sendBallot(
  deployment: Pick<Deployment, "api">,
  electionId: Uint8Array,
  ballot: Uint8Array,
  fetchFn: Fetch,
): Promise<SendAnswer> {
  if (!(electionId instanceof Uint8Array) || electionId.length !== 32)
    throw new RangeError("electionId: expected 32 bytes");
  let response: Response;
  try {
    response = await fetchFn(`${deployment.api}/ballots`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ electionId: toHex(electionId), ballot: toHex(ballot) }),
    });
  } catch {
    return { kind: "unreachable" };
  }
  const answer = await readJson(response, maxAnswer(ballot));
  if (!isRecord(answer)) return { kind: "unreachable" };
  if (response.status === 201) {
    const { entry, link } = answer;
    if (Object.keys(answer).length !== 2 || typeof entry !== "string" || typeof link !== "string")
      return { kind: "unreachable" };
    return { kind: "boarded", entry, link };
  }
  const { code } = answer;
  if (response.status === 422 && code === "BALLOT_REJECTED") {
    const data = answer["data"];
    const reason = isRecord(data) && Object.keys(data).length === 1 ? data["code"] : undefined;
    return typeof reason === "string" && reason.length <= MAX_CODE && CODE.test(reason)
      ? { kind: "rejected", code: reason }
      : { kind: "unreachable" };
  }
  const refusal =
    typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
  return refusal !== undefined && refusal[0] === response.status
    ? refusal[1]
    : { kind: "unreachable" };
}

/** A boarded answer that passed `checkBoarded`: what the client keeps, and where the entry says it is. */
export interface CheckedBoarded extends Boarded {
  /** The entry's position on the election's board, a u64. */
  readonly index: bigint;
  /** The anchoring period it was boarded in, a u32. */
  readonly segment: number;
}

/**
 * The operator's answer for `ballot`, if it is exactly what the route
 * promises ([[receipts]], Checks at cast; `ballots.submit`): a board entry
 * of the election's pinned version, in lowercase hex with nothing after it,
 * naming `electionId` and carrying exactly the bytes sent, and a 32-byte
 * link. `undefined` otherwise: an answer that fails isn't evidence of
 * anything, since nothing is signed yet, so the voter is told the ballot
 * isn't confirmed and offered to send the same bytes again (T-25, T-38).
 */
export function checkBoarded(
  answer: { readonly entry: string; readonly link: string },
  expected: {
    readonly electionId: Uint8Array;
    readonly ballot: Uint8Array;
    readonly boardEntryVersion: BoardEntryVersion;
  },
): CheckedBoarded | undefined {
  const { entry, link } = answer;
  const { electionId, ballot, boardEntryVersion } = expected;
  // Its length is fixed by the ballot, so nothing longer is decoded (T-52).
  if (entry.length !== 2 * (ballot.length + BOARD_ENTRY_OVERHEAD) || !HEX.test(entry))
    return undefined;
  if (link.length !== 64 || !HEX.test(link)) return undefined;
  const bytes = fromHex(entry);
  let decoded: BoardEntry;
  try {
    decoded = decodeBoardEntry(bytes, boardEntryVersion);
  } catch {
    return undefined;
  }
  const same = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
  if (!same(decoded.election_id, electionId) || !same(decoded.payload, ballot)) return undefined;
  return { entry: bytes, link: fromHex(link), index: decoded.index, segment: decoded.segment };
}
