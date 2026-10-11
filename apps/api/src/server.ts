import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { contract, MAX_BOARD_PAYLOAD } from "@abolishus/api-contract";
import { ACCOUNT_COOKIE_PREFIX } from "@abolishus/core";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { onError, ORPCError } from "@orpc/server";
import type { Sql } from "postgres";
import { router } from "./router.ts";

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

const METHODS = new Set(["GET", "POST"]);

/** `METHOD /path` of every contract procedure; anything else is logged as unmatched. */
const ROUTES: ReadonlySet<string> = new Set(
  Object.values(contract).flatMap((group) =>
    Object.values(group).map((p) => {
      const route = p["~orpc"].route;
      return `${route.method} ${route.path}`;
    }),
  ),
);

function routeOf(req: IncomingMessage): string {
  const path = (req.url ?? "").split("?", 1)[0];
  const key = `${req.method} ${path}`;
  return ROUTES.has(key) ? key : "unmatched";
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
    return name.toLowerCase().startsWith(`${ACCOUNT_COOKIE_PREFIX}.`);
  });
}

class BodyError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`request body refused: ${status}`);
    this.status = status;
  }
}

/**
 * Reads a JSON body of at most `MAX_REQUEST_BODY` bytes. oRPC's own reader
 * accepts any size and any content type (multipart and files included), so
 * the body is read here and handed over parsed; oRPC then uses it as is.
 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const type = req.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)) throw new BodyError(415);
  const declared = req.headers["content-length"];
  if (declared !== undefined && !(Number(declared) <= MAX_REQUEST_BODY)) throw new BodyError(413);
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_REQUEST_BODY) return void chunks.push(chunk);
      // Stop reading without destroying the socket, so the 413 still reaches
      // the client; the connection closes once it is sent.
      req.off("data", onData);
      req.pause();
      reject(new BodyError(413));
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as unknown;
  } catch {
    throw new BodyError(400);
  }
}

const REFUSALS: Record<number, string> = {
  400: "BAD_REQUEST",
  404: "NOT_FOUND",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  500: "INTERNAL_SERVER_ERROR",
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
}

/** A whole request (headers and body) must arrive within this. */
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

/** The API server. The caller listens on it and closes it. */
export function createApiServer({
  sql,
  log,
  maxInFlight = 32,
  idleTimeoutMs = 15_000,
  deadlineMs = 60_000,
}: ApiOptions): Server {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1)
    throw new RangeError("maxInFlight must be at least 1");
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
        if (req.method === "POST") {
          // A POST takes its input from the body alone, so nothing that keys on
          // the URL (a cache, a rate limiter) sees a different request (T-31).
          if (req.url?.includes("?")) return refuse(res, 400);
          (req as IncomingMessage & { body?: unknown }).body = await readJsonBody(req);
        } else if (
          req.headers["content-length"] !== undefined ||
          req.headers["transfer-encoding"]
        ) {
          // A GET takes its input from the query alone (T-31).
          return refuse(res, 400);
        }
        const { matched } = await handler.handle(req, res, { context: { sql } });
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
