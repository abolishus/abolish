// Delivering a cast's share to one seat's intake through the operator's
// relay (`POST /v1/intake/seats/{seat}` on the API's origin; [[delivery]],
// Client rule 4), before the ballot is sent ([[0002-everlasting-privacy]],
// Synchronous intake). The body is the trustee node's own envelope: the
// election's stub and approved transcript, the whole ballot record (so the
// node checks the voter's membership before it receipts, [[P1-12c]]) and
// the seat's `ct_i`. Everything in it is public on the board but `ct_i`,
// which is sealed to the seat's keys; `m_i` never leaves the device here.
//
// Nothing the relay answers is trusted: a receipt comes back as bytes for
// the worker to check against the ballot cast (Client rule 1), and only a
// passing one ever erases `m_i` (casts.ts, `CheckedReceipt`; T-25).

import { bytesVar, encode, struct } from "@abolishus/crypto";

import { MAX_ANSWER, readBytes } from "./answer.ts";
import type { Deployment } from "./deployment.ts";
import type { Fetch } from "./load.ts";

/** The node's bound on each of the envelope's fields (`MAX_RECORD`, apps/trustee-node). */
const MAX_RECORD = 1 << 20;

// The trustee node's `Delivery` (apps/trustee-node, src/endpoint.ts): four
// `bytes<2^20>` in this order. A transport envelope, not protocol bytes.
const DELIVERY = struct([
  ["stub", bytesVar(MAX_RECORD)],
  ["transcript", bytesVar(MAX_RECORD)],
  ["record", bytesVar(MAX_RECORD)],
  ["ciphertext", bytesVar(MAX_RECORD)],
] as const);

/** One seat's delivery: the election, the ballot record and that seat's `ct_i`. */
export interface Delivery {
  /** The election's stub (`encodeElectionStubV5`). */
  readonly stub: Uint8Array;
  /** The ceremony transcript the poll's keys came from. */
  readonly transcript: Uint8Array;
  /** The whole ballot record, exactly as the cast recorded it. */
  readonly record: Uint8Array;
  /** The seat's share ciphertext. */
  readonly ciphertext: Uint8Array;
}

/** Throws `EncodeError` on a field over the node's bound. */
export const encodeDelivery = (delivery: Delivery): Uint8Array => encode(DELIVERY, delivery);

/** What the seat's intake answered, as the client acts on it. */
export type IntakeAnswer =
  /** An answer to check: the bytes the node sent as a receipt, unchecked until the worker passes them. */
  | { readonly kind: "receipt"; readonly receipt: Uint8Array }
  /** The node refused the delivery, with its code: the same bytes won't pass there. */
  | { readonly kind: "refused"; readonly code: string }
  /** The relay or the node is busy: send the same delivery again later. */
  | { readonly kind: "busy" }
  /** The relay couldn't reach the node, or the node failed: send the same delivery again. */
  | { readonly kind: "unavailable" }
  /** The relay names no endpoint for this seat, or refused the request's form: not this route's to deliver. */
  | { readonly kind: "not-relayed" }
  /** The network failed, or the answer isn't one the route gives. */
  | { readonly kind: "unreachable" };

// A refusal's code as the relay passes it on (apps/api, src/intake.ts).
const CODE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/**
 * Delivers `delivery` to seat `seat`'s intake through the deployment's
 * relay. Like every request the client makes, it carries no cookie,
 * referrer or credential, so the operator can't tie the delivery to an
 * account (T-10), and follows no redirect. A retry sends the same delivery
 * again: a seat answers a delivery it already receipted with a receipt for
 * the same ballot (T-25).
 */
export async function deliverShare(
  deployment: Pick<Deployment, "api">,
  seat: number,
  delivery: Delivery,
  fetchFn: Fetch,
): Promise<IntakeAnswer> {
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > 16)
    throw new RangeError("seat: expected 1 to 16");
  // Typed for `fetch` as a view of a plain ArrayBuffer.
  const body = new Uint8Array(encodeDelivery(delivery));
  let response: Response;
  try {
    response = await fetchFn(`${deployment.api}/v1/intake/seats/${seat}`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
  } catch {
    return { kind: "unreachable" };
  }
  switch (response.status) {
    case 200: {
      if (response.headers.get("content-type") !== "application/octet-stream") break;
      // A receipt is a few hundred bytes (T-52).
      const receipt = await readBytes(response, MAX_ANSWER);
      return receipt === undefined ? { kind: "unreachable" } : { kind: "receipt", receipt };
    }
    case 422: {
      const bytes = await readBytes(response, MAX_ANSWER);
      let code: string | undefined;
      try {
        code =
          bytes === undefined ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        code = undefined;
      }
      return code !== undefined && CODE.test(code)
        ? { kind: "refused", code }
        : { kind: "unreachable" };
    }
    case 503:
      return { kind: "busy" };
    case 502:
      return { kind: "unavailable" };
    // No endpoint for the seat (404), or a body the relay refused (400, 413,
    // 415): this client's request, or the relay's list, not the network.
    case 400:
    case 404:
    case 413:
    case 415:
      return { kind: "not-relayed" };
  }
  await response.body?.cancel().catch(() => undefined);
  return { kind: "unreachable" };
}
