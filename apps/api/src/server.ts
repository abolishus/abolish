import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { contract, MAX_BOARD_PAYLOAD } from "@abolishus/api-contract";
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

class BodyError extends Error {
  constructor(readonly status: number) {
    super(`request body refused: ${status}`);
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
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY) throw new BodyError(413);
    chunks.push(chunk);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text) as unknown;
  } catch {
    throw new BodyError(400);
  }
}

function refuse(res: ServerResponse, status: number) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ code: status === 404 ? "NOT_FOUND" : "BAD_REQUEST", status }));
}

export interface ApiOptions {
  readonly sql: Sql;
  readonly log: Log;
}

/** The API server. The caller listens on it and closes it. */
export function createApiServer({ sql, log }: ApiOptions): Server {
  const handler = new OpenAPIHandler(router, {
    // Procedures' own errors (ELECTION_NOT_FOUND, …) are answers, not
    // failures; anything else becomes a 500 and is logged by kind.
    clientInterceptors: [
      onError((e) => {
        if (!(e instanceof ORPCError)) log({ error: e instanceof Error ? e.name : typeof e });
      }),
    ],
  });
  return createServer(async (req, res) => {
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
    try {
      if (route === "unmatched") return refuse(res, 404);
      if (req.method === "POST") {
        (req as IncomingMessage & { body?: unknown }).body = await readJsonBody(req);
      } else if (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"]) {
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
  });
}
