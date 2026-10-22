import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:https";
import { DecodeError } from "@abolishus/crypto";
import { decodeDelivery, INTAKE_GROUPS, MAX_DELIVERY } from "@abolishus/trustee-node";
import { readBody } from "./body.ts";

// The operator's intake relay (docs/spec/delivery.md, Client rules 4; P2-8
// part 3c-1b-2b-2b-2a): the ballot client's first route to each seat's
// intake. The client posts the trustee node's own envelope (`Delivery`: the
// election's stub and approved transcript, the whole ballot record and the
// seat's `ct_i`) here, and the relay sends it on to that seat's endpoint,
// as the release lists it, and answers as the node did.
//
// Nothing here is trusted or judged: the node admits the ballot and signs
// the receipt, and the client checks the receipt against the ballot it
// cast (Client rules 1), so a relay that lies can only refuse, which the
// client's route that bypasses us answers (T-25). What the relay adds is
// the voter's address kept from the trustees (T-11): the node sees ours, on
// a connection of its own for each delivery with no header of the client's,
// so nothing joins two voters' deliveries or one voter's to their address.
//
// The outbound leg holds to what every intake endpoint negotiates: TLS 1.3
// with the hybrid post-quantum group only, so a recorded `ct_i` isn't
// exposed to a later quantum break of the handshake (ADR 0002; T-39).

/** The seat in the path: 1 to 99, no leading zero, as a panel has 16 seats at most. */
const SEAT = /^\/v1\/intake\/seats\/([1-9][0-9]?)$/;

/** The templates the request log names the route by: never the seat. */
const TEMPLATES = {
  POST: "POST /v1/intake/seats/{seat}",
  OPTIONS: "OPTIONS /v1/intake/seats/{seat}",
} as const;

/** The most seats a panel has, so the most endpoints the relay takes. */
export const MAX_INTAKE_SEATS = 16;

/**
 * Bound on a node's answer: a share receipt (`0x000c`) or a refusal's code
 * is a few hundred bytes, so anything near this is no answer of a node's.
 */
export const MAX_INTAKE_ANSWER = 4096;

/** A refusal's code as the node sends it: crypto's and the node's codes are all of this form. */
const CODE = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export interface IntakeRoute {
  readonly seat: number;
  /** As the request log names it: no seat, so the log stays a fixed list. */
  readonly template: string;
}

/**
 * The relay's route `req` asks for, by its exact path and method, or
 * `undefined`. A query string never matches, so nothing keyed on the URL
 * sees a request other than the one handled (T-31).
 */
export function intakeRoute(req: IncomingMessage): IntakeRoute | undefined {
  const match = SEAT.exec(req.url ?? "");
  if (match === null) return undefined;
  if (req.method !== "POST" && req.method !== "OPTIONS") return undefined;
  return { seat: Number(match[1]), template: TEMPLATES[req.method] };
}

export interface IntakeRelayOptions {
  /**
   * Each seat's intake endpoint, seat 1 first: the default panel's, as the
   * release lists them beside its keys. Each an `https:` URL; a node's
   * plain-HTTP loopback endpoint is reached through its own TLS proxy.
   */
  readonly endpoints: readonly string[];
  /**
   * Deliveries relayed at once, within the server's own bound; past it, a
   * request is refused with 503 once its body is read. A node checks one
   * delivery at a time, so each can hold a slot for as long as the node's
   * queue takes.
   */
  readonly maxInFlight?: number;
  /** A node that hasn't answered within this is given up on, with 502. Default 25 s. */
  readonly timeoutMs?: number;
  /** Certificates (PEM) the endpoints' chains may end in, beside the system's: tests only. */
  readonly ca?: string;
}

/** Checks every endpoint once, throwing `RangeError` naming the first that isn't one. */
export function intakeEndpoints(endpoints: readonly string[]): readonly URL[] {
  if (endpoints.length === 0 || endpoints.length > MAX_INTAKE_SEATS)
    throw new RangeError(`the intake relay takes 1 to ${MAX_INTAKE_SEATS} endpoints`);
  return endpoints.map((endpoint) => {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new RangeError(`intake endpoint ${JSON.stringify(endpoint)} is not a URL`);
    }
    // No credentials, query or fragment: an endpoint is where a delivery
    // goes, and carries nothing a node could tell one relay's requests by.
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      endpoint.includes("?") ||
      endpoint.includes("#")
    )
      throw new RangeError(`intake endpoint ${JSON.stringify(endpoint)} is not a plain https URL`);
    return url;
  });
}

/** What a node answered, or why there is no answer to pass on. */
export type NodeAnswer =
  | { readonly kind: "receipt"; readonly receipt: Uint8Array }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "busy" }
  | { readonly kind: "failed"; readonly failure: "unreachable" | "timeout" | "answer" };

/**
 * One delivery to a node's endpoint: `POST`, the body alone with its type
 * and length, on a connection of its own, offering only TLS 1.3 and the
 * hybrid group, so a node that can't negotiate it gets nothing (T-39).
 */
export function forward(
  url: URL,
  body: Uint8Array,
  { ca, timeoutMs }: { readonly ca?: string | undefined; readonly timeoutMs: number },
): Promise<NodeAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer: NodeAnswer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => settle({ kind: "failed", failure: "timeout" }), timeoutMs);
    const req = request(
      url,
      {
        method: "POST",
        // T-11: no kept-alive socket shared between two voters' deliveries.
        agent: false,
        minVersion: "TLSv1.3",
        ecdhCurve: INTAKE_GROUPS,
        ...(ca !== undefined && { ca }),
        headers: { "content-type": "application/octet-stream", "content-length": body.length },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_INTAKE_ANSWER) return settle({ kind: "failed", failure: "answer" });
          chunks.push(chunk);
        });
        // A connection closed before the answer's end is no answer.
        res.on("error", () => settle({ kind: "failed", failure: "unreachable" }));
        res.on("close", () => settle({ kind: "failed", failure: "unreachable" }));
        res.on("end", () => {
          const answer = new Uint8Array(Buffer.concat(chunks));
          if (status === 200 && res.headers["content-type"] === "application/octet-stream")
            return settle({ kind: "receipt", receipt: answer });
          if (status === 422) {
            let code: string | undefined;
            try {
              code = new TextDecoder("utf-8", { fatal: true }).decode(answer);
            } catch {
              code = undefined;
            }
            if (code !== undefined && CODE.test(code)) return settle({ kind: "refused", code });
          }
          if (status === 503) return settle({ kind: "busy" });
          settle({ kind: "failed", failure: "answer" });
        });
      },
    );
    req.on("error", () => settle({ kind: "failed", failure: "unreachable" }));
    req.end(body);
  });
}

const OCTET_STREAM = /^application\/octet-stream$/i;

/**
 * The relay's handler for a `POST`, with its own slots. It answers a
 * request itself and returns `undefined`, or returns the status of a
 * refusal for the server to send; a body it refuses throws the server's
 * `BodyError`. A seat with no endpoint is refused before the body is read,
 * and the slot is taken only once the body is read and decodes, so clients
 * that stall their uploads hold none (T-52).
 */
export function intakeRelay(
  options: IntakeRelayOptions,
  log: (failure: NodeAnswer & { readonly kind: "failed" }) => void,
): (req: IncomingMessage, res: ServerResponse, route: IntakeRoute) => Promise<number | undefined> {
  const endpoints = intakeEndpoints(options.endpoints);
  const maxInFlight = options.maxInFlight ?? 8;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1)
    throw new RangeError("the intake relay's maxInFlight must be at least 1");
  const timeoutMs = options.timeoutMs ?? 25_000;
  let inFlight = 0;
  const busy = (res: ServerResponse) => {
    res.setHeader("retry-after", "1");
    return 503;
  };
  return async (req, res, route) => {
    const url = endpoints[route.seat - 1];
    if (url === undefined) return 404;
    const body = await readBody(req, OCTET_STREAM, MAX_DELIVERY);
    const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    try {
      decodeDelivery(bytes);
    } catch (e) {
      if (e instanceof DecodeError) return 400;
      throw e;
    }
    if (inFlight >= maxInFlight) return busy(res);
    inFlight++;
    let answer: NodeAnswer;
    try {
      answer = await forward(url, bytes, { ca: options.ca, timeoutMs });
    } finally {
      inFlight--;
    }
    // Answered as the node's own endpoint answers, so the client reads both
    // routes the same way.
    switch (answer.kind) {
      case "receipt":
        res.statusCode = 200;
        res.setHeader("content-type", "application/octet-stream");
        res.end(answer.receipt);
        return undefined;
      case "refused":
        res.statusCode = 422;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(answer.code);
        return undefined;
      case "busy":
        return busy(res);
      case "failed":
        log(answer);
        return 502;
    }
  };
}
