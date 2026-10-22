// Submitting a kept share receipt through the operator's board path
// (`receipts.submit`) once its ballot is boarded, and judging the answer
// ([[delivery]], Client rule 3; [[receipts]], Checks at cast). A receipt is
// public, and names only the definition, the ballot hash, the seat and its
// share hash, so only its bytes go (T-12).
//
// The operator signs no receipt yet (P2-3), so a boarded answer is only the
// operator's word, as a ballot's is (send.ts): the client checks that its
// entry names this election and carries exactly the receipt sent, or, where
// the board path already carried a receipt for that seat in other bytes
// (Boarding, rule 5), a share receipt that the worker then passes for the
// voter's own ballot and seat as it passed theirs (T-38).

import {
  type BoardEntry,
  type BoardEntryVersion,
  decodeBoardEntry,
  decodeShareReceipt,
} from "@abolishus/crypto";

import { MAX_ANSWER, readJson } from "./answer.ts";
import type { Boarded } from "./casts.ts";
import type { Deployment } from "./deployment.ts";
import type { Fetch } from "./load.ts";

/** What the route answered, as the client acts on it. */
export type ReceiptAnswer =
  /**
   * Boarded: the entry and link the operator says carry it, or, `earlier`,
   * an earlier receipt for the seat in other bytes; unchecked until
   * `checkReceiptEntry`.
   */
  | {
      readonly kind: "boarded";
      readonly entry: string;
      readonly link: string;
      readonly earlier: boolean;
    }
  /** The receipt failed decoding or a boarding rule, with the operator's code. */
  | { readonly kind: "rejected"; readonly code: string }
  /** The request is outside the route's forms: a bug of this client. */
  | { readonly kind: "malformed" }
  /** This server knows no such election. */
  | { readonly kind: "not-found" }
  /** The election isn't boarding receipts, by the server's clock: after `s_D`. */
  | { readonly kind: "not-open" }
  /** Too many requests: send the same bytes again later. */
  | { readonly kind: "busy" }
  /** Not judged in time; the receipt may be boarded: send the same bytes again. */
  | { readonly kind: "unavailable" }
  /** The network failed, or the answer isn't one the route gives. */
  | { readonly kind: "unreachable" };

/** What a board entry adds around its payload (docs/spec/board.md): header, id, index, segment, length. */
const BOARD_ENTRY_OVERHEAD = 3 + 32 + 8 + 4 + 4;

/** The share receipt version ballot version 3 fixes, the one this client's casts carry. */
const RECEIPT_VERSION = 1;

// The route's error codes (`ErrorCode` in @abolishus/api-contract).
const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_CODE = 64;

const HEX = /^(?:[0-9a-f]{2})*$/;

// Each refusal the route defines without data, by its status and code: a
// code at another status isn't the route's and is read as unreachable.
const REFUSALS: Readonly<Record<string, readonly [number, ReceiptAnswer]>> = {
  BAD_REQUEST: [400, { kind: "malformed" }],
  ELECTION_NOT_FOUND: [404, { kind: "not-found" }],
  ELECTION_NOT_OPEN: [409, { kind: "not-open" }],
  RATE_LIMITED: [429, { kind: "busy" }],
  RECEIPTS_UNAVAILABLE: [503, { kind: "unavailable" }],
};

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Lowercase hex, already checked, to bytes. */
const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Submits `receipt`, a seat's share receipt this device kept for a boarded
 * cast, to the deployment's receipt route for `electionId`, and reads the
 * answer. Like every request the client makes, it carries no cookie,
 * referrer or credential (T-10), and follows no redirect. A retry sends
 * these same bytes again.
 */
export async function submitReceipt(
  deployment: Pick<Deployment, "api">,
  electionId: Uint8Array,
  receipt: Uint8Array,
  fetchFn: Fetch,
): Promise<ReceiptAnswer> {
  if (!(electionId instanceof Uint8Array) || electionId.length !== 32)
    throw new RangeError("electionId: expected 32 bytes");
  let response: Response;
  try {
    response = await fetchFn(`${deployment.api}/receipts`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ electionId: toHex(electionId), record: toHex(receipt) }),
    });
  } catch {
    return { kind: "unreachable" };
  }
  // Every receipt version is a fixed size of under 200 bytes, so its entry
  // and link fit the default bound with room to spare (T-52).
  const answer = await readJson(response, MAX_ANSWER);
  if (!isRecord(answer)) return { kind: "unreachable" };
  if (response.status === 201) {
    const { entry, link, earlier } = answer;
    if (
      Object.keys(answer).length !== 3 ||
      typeof entry !== "string" ||
      typeof link !== "string" ||
      typeof earlier !== "boolean"
    )
      return { kind: "unreachable" };
    return { kind: "boarded", entry, link, earlier };
  }
  const { code } = answer;
  if (response.status === 422 && code === "RECEIPT_REJECTED") {
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

/** A boarded answer that passed `checkReceiptEntry`, with the receipt its entry carries. */
export interface CheckedReceiptEntry extends Boarded {
  /** The share receipt the entry carries: the one sent, or the seat's earlier one. */
  readonly payload: Uint8Array;
  /** The entry's position on the election's board, a u64. */
  readonly index: bigint;
}

/**
 * The operator's answer for `receipt`, if it is what the route promises
 * (`receipts.submit`): a board entry of the election's pinned version, in
 * lowercase hex with nothing after it, naming `electionId`, and a 32-byte
 * link; the entry carrying exactly the bytes sent, or, for an `earlier`
 * answer, a share receipt of the same version for the same seat, which the
 * caller must still have the worker pass for its own ballot before keeping
 * it ([[delivery]], Client rule 3). `undefined` otherwise: an answer that
 * fails isn't evidence of anything, since nothing is signed yet (T-38).
 */
export function checkReceiptEntry(
  answer: { readonly entry: string; readonly link: string; readonly earlier: boolean },
  expected: {
    readonly electionId: Uint8Array;
    readonly receipt: Uint8Array;
    readonly boardEntryVersion: BoardEntryVersion;
  },
): CheckedReceiptEntry | undefined {
  const { entry, link, earlier } = answer;
  const { electionId, receipt, boardEntryVersion } = expected;
  // A receipt of the version sent has its size, so the entry's length is
  // fixed by it, earlier or not, and nothing longer is decoded (T-52).
  if (entry.length !== 2 * (receipt.length + BOARD_ENTRY_OVERHEAD) || !HEX.test(entry))
    return undefined;
  if (link.length !== 64 || !HEX.test(link)) return undefined;
  const bytes = fromHex(entry);
  let decoded: BoardEntry;
  try {
    decoded = decodeBoardEntry(bytes, boardEntryVersion);
  } catch {
    return undefined;
  }
  const { payload } = decoded;
  if (!equalBytes(decoded.election_id, electionId)) return undefined;
  if (earlier) {
    // Rule 5's earlier receipt is the seat's: the worker judges the rest.
    let seat: number;
    let sent: number;
    try {
      seat = decodeShareReceipt(payload, RECEIPT_VERSION).seat;
      sent = decodeShareReceipt(receipt, RECEIPT_VERSION).seat;
    } catch {
      return undefined;
    }
    if (seat !== sent) return undefined;
  } else if (!equalBytes(payload, receipt)) return undefined;
  return { entry: bytes, link: fromHex(link), payload: payload.slice(), index: decoded.index };
}
