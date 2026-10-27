import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { contract, MAX_BOARD_PAYLOAD } from "@abolishus/api-contract";
import {
  ACCOUNT_COOKIE_PREFIX,
  answeredWindow,
  type PostingRelay,
  type Tier0Registrations,
  type Tier1Relay,
} from "@abolishus/core";
import type { PeriodClock } from "@abolishus/crypto";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { onError, ORPCError } from "@orpc/server";
import type { Sql } from "postgres";
import { BodyError, readBody } from "./body.ts";
import { type CeremonyOptions, ceremonyHandler, ceremonyRoute } from "./ceremony.ts";
import { type IntakeRelayOptions, intakeRelay, intakeRoute } from "./intake.ts";
import { hasDuplicateKey } from "./json.ts";
import {
  type BallotSubmitter,
  type DestructionSubmitter,
  type OpeningSubmitter,
  type ReceiptSubmitter,
  router,
} from "./router.ts";

// The HTTP transport: oRPC's OpenAPI handler on node:http, behind a front
// that bounds request bodies and writes the request log.
//
// T-10, T-11: the log is the only thing this server writes about a request,
// and it never carries an address, a header (so no cookie, token or
// forwarding chain), a query string or a body. A line holds the method, the
// contract route it matched (from a fixed list, never the raw URL), the
// status and the duration, so no line can carry a session or account
// identifier next to a ballot, a nullifier or the election someone looked at.

/** One request-log line: nothing a person, a session or a ballot can be read from. */
export interface RequestLogLine {
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly ms: number;
}

/** An internal error, by kind only: error messages can quote the input. */
export interface ErrorLogLine {
  readonly error: string;
}

export type Log = (line: RequestLogLine | ErrorLogLine) => void;

/** A ballot of `MAX_BOARD_PAYLOAD` bytes as hex, its election ID and the JSON around them. */
export const MAX_REQUEST_BODY = 2 * MAX_BOARD_PAYLOAD + 1024;

/**
 * The posting route's own bound (docs/spec/posting-relay.md, Request): above
 * twice `POSTING_MAX_DATA` in hex and the JSON around it, and well below the
 * ballot route's, since every posting the relay sends fits (T-52).
 */
export const MAX_POSTING_BODY = 256 * 1024;

/** Routes whose body bound is below `MAX_REQUEST_BODY`. */
const BODY_BOUNDS: ReadonlyMap<string, number> = new Map([["POST /postings", MAX_POSTING_BODY]]);

const METHODS = new Set(["GET", "POST", "OPTIONS"]);

/** `METHOD /path` of every contract procedure; anything else is logged as unmatched. */
const ROUTES: ReadonlySet<string> = new Set(
  Object.values(contract).flatMap((group) =>
    Object.values(group).map((p) => {
      const route = p["~orpc"].route;
      return `${route.method} ${route.path}`;
    }),
  ),
);

/** Each procedure's path and its one method, for CORS preflights. */
const METHOD_OF: ReadonlyMap<string, string> = new Map(
  [...ROUTES].map((r) => {
    const [method, path] = r.split(" ") as [string, string];
    return [path, method];
  }),
);

function routeOf(req: IncomingMessage): string {
  const ceremony = ceremonyRoute(req);
  if (ceremony !== undefined) return ceremony.template;
  const intake = intakeRoute(req);
  if (intake !== undefined) return intake.template;
  const path = (req.url ?? "").split("?", 1)[0] ?? "";
  // A preflight is logged under its path, from the same fixed list.
  if (req.method === "OPTIONS") return METHOD_OF.has(path) ? `OPTIONS ${path}` : "unmatched";
  const key = `${req.method} ${path}`;
  return ROUTES.has(key) ? key : "unmatched";
}

/**
 * The origins whose pages may read this API's answers, checked once: each an
 * exact `https:` origin, or `http:` on a loopback host for a local client.
 */
function corsOriginSet(origins: readonly string[]): ReadonlySet<string> {
  for (const origin of origins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new RangeError(`CORS origin ${JSON.stringify(origin)} is not a URL`);
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.origin !== origin ||
      !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
    )
      throw new RangeError(`CORS origin ${JSON.stringify(origin)} is not an exact https origin`);
  }
  return new Set(origins);
}

/** How long a browser may cache a preflight's answer, in seconds. */
const PREFLIGHT_MAX_AGE = 600;

/**
 * Answers a CORS preflight for a route whose one method is `method`: allowed
 * only from a listed origin, for that method, with no request header but
 * `content-type`.
 * Nothing else is ever allowed: no credentials, so a browser never sends a
 * cookie here (T-10), and no other header a page could use to smuggle state.
 */
function preflight(
  req: IncomingMessage,
  res: ServerResponse,
  method: string | undefined,
  allowed: boolean,
) {
  const headers = (req.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  if (
    !allowed ||
    method === undefined ||
    req.headers["access-control-request-method"] !== method ||
    headers.some((h) => h !== "content-type")
  )
    return refuse(res, 403);
  res.statusCode = 204;
  res.setHeader("access-control-allow-methods", method);
  if (headers.length > 0) res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-max-age", String(PREFLIGHT_MAX_AGE));
  res.end();
}

/**
 * Whether a request carries an account credential: an account cookie (with or
 * without the `__Secure-` prefix) or any `Authorization` header. The account
 * system lives on apps/web's origin, so its host-only cookies never reach this
 * host from a browser; one arriving anyway means a misconfigured or hostile
 * client. It is refused rather than ignored, so no ballot or board request is
 * ever handled next to an account (T-10; ADR 0017).
 */
function carriesAccountCredential(req: IncomingMessage): boolean {
  if (req.headers.authorization !== undefined) return true;
  const cookie = req.headers.cookie;
  if (cookie === undefined) return false;
  return cookie.split(";").some((c) => {
    const name = c
      .trim()
      .split("=", 1)[0]!
      .replace(/^__(?:Secure|Host)-/i, "");
    // better-auth reads both `<prefix>.<name>` and `<prefix>-<name>`.
    return name.toLowerCase().startsWith(ACCOUNT_COOKIE_PREFIX);
  });
}

/**
 * Reads a JSON body of at most `bound` bytes. oRPC's own reader
 * accepts any size and any content type (multipart and files included), so
 * the body is read here and handed over parsed; oRPC then uses it as is.
 */
async function readJsonBody(req: IncomingMessage, bound: number): Promise<unknown> {
  const body = await readBody(req, /^application\/json(?:\s*;\s*charset=utf-8)?$/i, bound);
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new BodyError(400);
  }
  // T-31: two equal keys would let components in front read another input.
  if (hasDuplicateKey(text)) throw new BodyError(400);
  return parsed;
}

const REFUSALS: Record<number, string> = {
  400: "BAD_REQUEST",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  500: "INTERNAL_SERVER_ERROR",
  502: "BAD_GATEWAY",
  503: "SERVICE_UNAVAILABLE",
};

function refuse(res: ServerResponse, status: number) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ code: REFUSALS[status], status }));
}

export interface ApiOptions {
  readonly sql: Sql;
  readonly log: Log;
  /** The worker's ballot queue; without it the server boards no ballot (`ELECTION_NOT_OPEN`). */
  readonly ballots?: BallotSubmitter;
  /** The worker's share-receipt queue; without it the server boards no receipt (`ELECTION_NOT_OPEN`). */
  readonly receipts?: ReceiptSubmitter;
  /** The worker's tally-opening queue; without it the server boards no opening (`ELECTION_NOT_OPEN`). */
  readonly openings?: OpeningSubmitter;
  /** The worker's destruction-statement queue; without it the server boards no statement (`ELECTION_NOT_OPEN`). */
  readonly destructions?: DestructionSubmitter;
  /** UNIX time in seconds; the system clock by default. Injected so tests can set it. */
  readonly now?: () => bigint;
  /** Tier 0 registration; without it the route answers `REGISTRATION_UNAVAILABLE`. */
  readonly tier0?: Tier0Registrations;
  /** The Tier 1 relay; without it the route answers `RELAY_UNAVAILABLE`. */
  readonly tier1?: Tier1Relay;
  /** The posting relay; without it the route answers `RELAY_UNAVAILABLE`. */
  readonly postings?: Pick<PostingRelay, "relay">;
  /**
   * The anchoring clock by which the worker labels each board entry's
   * segment (docs/spec/board.md, Timing), the worker's own; without it the
   * listing's `answered` order answers `SORT_UNAVAILABLE`.
   */
  readonly boardClock?: PeriodClock;
  /**
   * Most requests handled at once, from the first byte to the last: past it,
   * a request is refused with 503 before anything is read. Each page of the
   * board can hold `MAX_PAGE_BYTES` and costs several times that in memory,
   * so this bounds the server's memory however many clients connect (T-52).
   * The timeouts below keep idle clients from holding the slots: a few
   * sockets can still take them all, but only by keeping traffic flowing,
   * and per-address limits belong to the proxy in front (P2-11).
   */
  readonly maxInFlight?: number;
  /**
   * A connection with no traffic in either direction for this long is
   * destroyed, freeing its slot: a client that stalls its upload or stops
   * reading its answer can't hold one (T-52). Default 15 s.
   */
  readonly idleTimeoutMs?: number;
  /**
   * A request still holding its slot this long after taking it is destroyed,
   * so a client that reads its answer slowly, never quite idle, can't hold a
   * slot either (T-52). Default 60 s.
   */
  readonly deadlineMs?: number;
  /**
   * Origins whose pages may read this API's answers (CORS): the ballot
   * client's, each an exact origin. Without them no CORS header is sent and
   * browsers let no other origin's page read an answer. Every route is
   * public and none takes credentials, so this only keeps other sites'
   * pages from using their visitors' browsers as clients (T-52).
   */
  readonly corsOrigins?: readonly string[];
  /**
   * The key ceremony's coordinator, serving the default panel's seats
   * (`HttpCoordinator`'s routes; ADR 0032, rule 5); without it those routes
   * answer 503.
   */
  readonly ceremony?: CeremonyOptions;
  /**
   * The operator's intake relay to the default panel's seats
   * (docs/spec/delivery.md, Client rules 4); without it the route answers
   * 503.
   */
  readonly intake?: IntakeRelayOptions;
}

/** A whole request (headers and body) must arrive within this. */
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

/** The API server. The caller listens on it and closes it. */
export function createApiServer({
  sql,
  log,
  ballots,
  receipts,
  openings,
  destructions,
  now = () => BigInt(Math.floor(Date.now() / 1000)),
  tier0,
  tier1,
  postings,
  boardClock,
  maxInFlight = 32,
  idleTimeoutMs = 15_000,
  deadlineMs = 60_000,
  corsOrigins = [],
  ceremony,
  intake,
}: ApiOptions): Server {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1)
    throw new RangeError("maxInFlight must be at least 1");
  const allowedOrigins = corsOriginSet(corsOrigins);
  // A malformed clock is refused here, at start, not on a request.
  if (boardClock !== undefined) answeredWindow(0n, boardClock);
  const coordinator =
    ceremony === undefined
      ? undefined
      : ceremonyHandler(sql, ceremony, () => new Date(Number(now()) * 1000));
  const relay =
    intake === undefined
      ? undefined
      : intakeRelay(intake, ({ failure }) => log({ error: `intake-relay-${failure}` }));
  let inFlight = 0;
  const handler = new OpenAPIHandler(router, {
    // Procedures' own errors (ELECTION_NOT_FOUND, …) are answers, not
    // failures; anything else becomes a 500 and is logged by kind.
    clientInterceptors: [
      onError((e) => {
        // An ORPCError of status 500 is a failure too: an answer that fails
        // the contract's output schema, say, which must not go unnoticed.
        if (!(e instanceof ORPCError) || e.status >= 500)
          log({ error: e instanceof Error ? e.name : typeof e });
      }),
    ],
  });
  const server = createServer(
    {
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      connectionsCheckingInterval: 1_000,
    },
    async (req, res) => {
      const started = performance.now();
      const route = routeOf(req);
      res.on("finish", () =>
        log({
          method: METHODS.has(req.method ?? "") ? (req.method as string) : "other",
          route,
          status: res.statusCode,
          ms: Math.round(performance.now() - started),
        }),
      );
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "no-store");
      // Set before any refusal, so a listed client can read why it was refused.
      const origin = req.headers.origin;
      const allowed = origin !== undefined && allowedOrigins.has(origin);
      if (allowedOrigins.size > 0) res.setHeader("vary", "origin");
      if (allowed) res.setHeader("access-control-allow-origin", origin);
      if (inFlight >= maxInFlight) {
        res.setHeader("connection", "close");
        res.setHeader("retry-after", "1");
        return refuse(res, 503);
      }
      inFlight++;
      const deadline = setTimeout(() => res.destroy(), deadlineMs);
      res.once("close", () => {
        clearTimeout(deadline);
        inFlight--;
      });
      try {
        if (carriesAccountCredential(req)) return refuse(res, 400);
        if (route === "unmatched") return refuse(res, 404);
        const seatRoute = ceremonyRoute(req);
        if (seatRoute !== undefined) {
          if (coordinator === undefined) return refuse(res, 503);
          const status = await coordinator(req, res, seatRoute);
          if (status !== undefined) refuse(res, status);
          return;
        }
        const intakeSeat = intakeRoute(req);
        if (intakeSeat !== undefined) {
          if (req.method === "OPTIONS") {
            if (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"])
              return refuse(res, 400);
            return preflight(req, res, "POST", allowed);
          }
          if (relay === undefined) return refuse(res, 503);
          const status = await relay(req, res, intakeSeat);
          if (status !== undefined) refuse(res, status);
          return;
        }
        if (req.method === "OPTIONS") {
          // A preflight carries no input, so no body either (T-31).
          if (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"])
            return refuse(res, 400);
          return preflight(req, res, METHOD_OF.get(route.slice("OPTIONS ".length)), allowed);
        }
        if (req.method === "POST") {
          // A POST takes its input from the body alone, so nothing that keys on
          // the URL (a cache, a rate limiter) sees a different request (T-31).
          if (req.url?.includes("?")) return refuse(res, 400);
          (req as IncomingMessage & { body?: unknown }).body = await readJsonBody(
            req,
            BODY_BOUNDS.get(route) ?? MAX_REQUEST_BODY,
          );
          // The posting route waits up to POSTING_WAIT for the relay's worker
          // with nothing crossing the socket, longer than the idle timeout
          // allows; once its body is in, the deadline alone bounds it.
          // Restored for whatever the connection carries next.
          if (route === "POST /postings") {
            const socket = req.socket;
            socket.setTimeout(deadlineMs);
            res.once("finish", () => socket.setTimeout(idleTimeoutMs));
          }
        } else if (
          req.headers["content-length"] !== undefined ||
          req.headers["transfer-encoding"]
        ) {
          // A GET takes its input from the query alone (T-31).
          return refuse(res, 400);
        }
        const { matched } = await handler.handle(req, res, {
          context: {
            sql,
            ballots,
            receipts,
            openings,
            destructions,
            now,
            tier0,
            tier1,
            postings,
            boardClock,
          },
        });
        if (!matched) refuse(res, 404);
      } catch (e) {
        if (e instanceof BodyError) {
          // Stop reading: the rest of an oversize body is never buffered.
          res.setHeader("connection", "close");
          return refuse(res, e.status);
        }
        log({ error: e instanceof Error ? e.name : typeof e });
        if (!res.headersSent) refuse(res, 500);
        else res.destroy();
      }
    },
  );
  // With no listener for "timeout", Node destroys the idle socket, which
  // closes its response and frees its slot.
  server.setTimeout(idleTimeoutMs);
  return server;
}
