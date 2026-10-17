import type { IncomingMessage, ServerResponse } from "node:http";
import {
  type CoordinatorDeployment,
  coordinatorRequests,
  type PostOutcome,
  postCeremonyApproval,
  postCeremonyMessage,
} from "@abolishus/core";
import { DecodeError } from "@abolishus/crypto";
import {
  decodeApprovalPost,
  decodeMessagePost,
  encodeRequests,
  MAX_RECORD,
} from "@abolishus/trustee-node";
import type { Sql } from "postgres";
import { readBody } from "./body.ts";

// The seats' side of the key ceremony's coordinator ([[0032-poll-creation-operations]],
// rule 5; P2-22 part 4c-2): `HttpCoordinator`'s three routes
// (apps/trustee-node, README, Transport), under their own path prefix,
// beside the oRPC contract rather than in it, since the bodies are the
// transport's binary envelopes, not JSON. Each route parses and calls
// core's coordinator; the worker opens runs and closes rounds.
//
// Seats don't authenticate here: the coordinator keeps a message only if it
// is the seat's own, signed over the closed rounds, and an approval only if
// it verifies under the seat's pinned key, so anyone else's post changes
// nothing (T-54). What a flood can cost is bounded instead: a body is read
// up to one record's size, and core's work for it runs under slots of the
// ceremony's own, so posts that each verify up to 48 signatures never take
// the slots ballots and the board are served from (T-52).
//
// T-10: nothing here names an account or a voter; the seat's index is the
// only input besides the body, and the request log keeps only the route's
// template, never the index.

/** The seat in the path: 1 to 99, no leading zero, as a panel has 16 seats at most. */
const SEAT = /^\/v1\/ceremony\/seats\/([1-9][0-9]?)\/(requests|messages|approvals)$/;

/** Each route's method, and the template the request log names it by. */
const ROUTES = {
  requests: { method: "GET", template: "GET /v1/ceremony/seats/{seat}/requests" },
  messages: { method: "POST", template: "POST /v1/ceremony/seats/{seat}/messages" },
  approvals: { method: "POST", template: "POST /v1/ceremony/seats/{seat}/approvals" },
} as const;

type Kind = keyof typeof ROUTES;

/** A message post: a 32-byte stub hash and one transcript record with its length prefix. */
export const MAX_CEREMONY_POST = 64 + MAX_RECORD;

export interface CeremonyRoute {
  readonly kind: Kind;
  readonly seat: number;
  /** As the request log names it: no seat, so the log stays a fixed list. */
  readonly template: string;
}

/**
 * The ceremony route `req` asks for, by its exact path and method, or
 * `undefined`. A query string never matches, so nothing keyed on the URL (a
 * cache, a rate limiter) sees a request other than the one handled (T-31).
 */
export function ceremonyRoute(req: IncomingMessage): CeremonyRoute | undefined {
  const match = SEAT.exec(req.url ?? "");
  if (match === null) return undefined;
  const kind = match[2] as Kind;
  if (req.method !== ROUTES[kind].method) return undefined;
  return { kind, seat: Number(match[1]), template: ROUTES[kind].template };
}

export interface CeremonyOptions {
  /** The default panel the seats hold, and where it is pinned: the stub step's. */
  readonly deployment: CoordinatorDeployment;
  /**
   * Most ceremony requests handled at once, within the server's own bound;
   * past it, a request is refused with 503 before its body is read. A
   * panel's seats each poll every minute or so, so a few are plenty.
   */
  readonly maxInFlight?: number;
}

const OUTCOME_STATUS: Record<PostOutcome, number> = {
  // A seat's second post of what it already sent (a retry after a lost
  // response) is answered as the first was, so it stops asking.
  accepted: 204,
  "already-sent": 204,
  malformed: 400,
  refused: 403,
  "not-open": 409,
};

const OCTET_STREAM = /^application\/octet-stream$/i;

/** Decodes a post's envelope from the body; `undefined` when it has no decoding. */
async function envelope<T>(req: IncomingMessage, decode: (b: Uint8Array) => T) {
  const body = await readBody(req, OCTET_STREAM, MAX_CEREMONY_POST);
  try {
    return decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  } catch (e) {
    if (e instanceof DecodeError) return undefined;
    throw e;
  }
}

/**
 * The ceremony's handler, with its own slots. It answers a request itself
 * and returns `undefined`, or returns the status of a refusal for the
 * server to send; a body it refuses throws the server's `BodyError`.
 *
 * A post's body is read and decoded under the server's slot alone, bounded
 * by its timeouts and `MAX_CEREMONY_POST`; the ceremony's slots are taken
 * only around core's work (the fit check's signatures and the database), so
 * clients that stall their uploads can't hold them and keep the seats out
 * (T-52, T-54).
 */
export function ceremonyHandler(
  sql: Sql,
  options: CeremonyOptions,
  now: () => Date,
): (
  req: IncomingMessage,
  res: ServerResponse,
  route: CeremonyRoute,
) => Promise<number | undefined> {
  const maxInFlight = options.maxInFlight ?? 4;
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1)
    throw new RangeError("the ceremony's maxInFlight must be at least 1");
  const { deployment } = options;
  let inFlight = 0;
  // Core's work under one of the ceremony's slots, or `undefined` when they are all taken.
  const slot = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight >= maxInFlight) return undefined;
    inFlight++;
    try {
      return await work();
    } finally {
      inFlight--;
    }
  };
  const busy = (res: ServerResponse) => {
    res.setHeader("retry-after", "1");
    return 503;
  };
  return async (req, res, route) => {
    if (route.kind === "requests") {
      // A GET takes no body (T-31).
      if (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"])
        return 400;
      const requests = await slot(() => coordinatorRequests(sql, deployment, route.seat));
      if (requests === undefined) return busy(res);
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.end(encodeRequests(requests));
      return undefined;
    }
    let outcome: PostOutcome | undefined;
    if (route.kind === "messages") {
      const post = await envelope(req, decodeMessagePost);
      if (post === undefined) return 400;
      outcome = await slot(() =>
        postCeremonyMessage(
          sql,
          deployment,
          route.seat,
          { stubHash: post.stub_hash, transcript: post.transcript },
          { now: now() },
        ),
      );
    } else {
      const post = await envelope(req, decodeApprovalPost);
      if (post === undefined) return 400;
      outcome = await slot(() =>
        postCeremonyApproval(
          sql,
          deployment,
          route.seat,
          {
            stubHash: post.stub_hash,
            ceremonyTranscriptHash: post.ceremony_transcript_hash,
            keySetHash: post.key_set_hash,
            signature: post.signature,
          },
          { now: now() },
        ),
      );
    }
    if (outcome === undefined) return busy(res);
    const status = OUTCOME_STATUS[outcome];
    if (status !== 204) return status;
    res.statusCode = 204;
    res.end();
    return undefined;
  };
}
