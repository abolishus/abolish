// apps/web's HTTP front on node:http: the built Start handler for pages and
// server functions, the account handler from @abolishus/core under /auth, and
// the client's hashed assets from disk.
//
// The account system lives here, on apps/web's origin, so its host-only
// session cookie never reaches the API or the ballot client's host (T-10,
// ADR 0017). Nothing on this server ever handles a ballot.
//
// T-10, T-11, T-67: the request log is the only thing written about a
// request, and a line never carries an address, a header (so no cookie), a
// query string, a body or a page's path (a poll page's path names the poll a
// visitor looked at): only the method, a route class from a fixed list, the
// status and the duration.

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

/** The built Start server (`dist/server/server.js`'s default export). */
export interface StartHandler {
  fetch(request: Request): Promise<Response>;
}

/** The account handler (`createAccounts(...).handler` from @abolishus/core). */
export type AccountHandler = (request: Request) => Promise<Response>;

/** What a request was, from a fixed list: never its path. */
export type RouteClass = "page" | "server-fn" | "auth" | "asset" | "refused";

/** One request-log line: nothing a person, a session or a poll can be read from. */
export interface RequestLogLine {
  readonly method: string;
  readonly route: RouteClass;
  readonly status: number;
  readonly ms: number;
}

/** An internal error, by kind only: error messages can quote the input. */
export interface ErrorLogLine {
  readonly error: string;
}

export type Log = (line: RequestLogLine | ErrorLogLine) => void;

/**
 * Largest request body read: a WebAuthn response is a few KiB (the account
 * handler bounds its own at 64 KiB too), and a server function's input is a
 * poll ID or a sequence number.
 */
export const MAX_BODY = 64 * 1024;

const METHODS = new Set(["GET", "HEAD", "POST"]);

/** TanStack Start's server-function prefix (its `TSS_SERVER_FN_BASE` default). */
const SERVER_FN_PREFIX = "/_serverFn/";

/** A built asset: a content-hashed file name directly under `assets/`. */
const ASSET = /^\/assets\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.(js|css|woff2)$/;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
};

export interface WebServerOptions {
  readonly start: StartHandler;
  readonly accounts: AccountHandler;
  /** The built client (`dist/client`); only its `assets/` are served. */
  readonly clientDir: string;
  /**
   * This site's public origin (`https://…`). Every request's URL is built on
   * it, never on the `Host` header a client sent.
   */
  readonly origin: string;
  readonly log: Log;
  /** Most requests handled at once; past it, 503 before anything is read (T-52). */
  readonly maxInFlight?: number;
  /** A connection idle this long is destroyed, freeing its slot (T-52). Default 15 s. */
  readonly idleTimeoutMs?: number;
  /** A request still holding its slot this long is destroyed (T-52). Default 60 s. */
  readonly deadlineMs?: number;
}

/** A whole request (headers and body) must arrive within this. */
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

class Refusal extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`request refused: ${status}`);
    this.status = status;
  }
}

/** The body of `req`, at most `MAX_BODY` bytes. */
async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers["content-length"];
  if (declared !== undefined && !(Number(declared) <= MAX_BODY)) throw new Refusal(413);
  return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) return void chunks.push(chunk);
      // Stop reading without destroying the socket, so the 413 still reaches
      // the client; the connection closes once it is sent.
      req.off("data", onData);
      req.pause();
      reject(new Refusal(413));
    };
    req.on("data", onData);
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", reject);
  });
}

function classify(method: string, path: string): RouteClass {
  if (path === "/auth" || path.startsWith("/auth/")) return "auth";
  if (path.startsWith(SERVER_FN_PREFIX)) return "server-fn";
  if (path.startsWith("/assets/") && (method === "GET" || method === "HEAD")) return "asset";
  return "page";
}

function refuse(res: ServerResponse, status: number) {
  res.statusCode = status;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(`${status}\n`);
}

/** Writes a fetch Response to `res`, every `Set-Cookie` kept apart. */
async function send(res: ServerResponse, response: Response, head: boolean) {
  res.statusCode = response.status;
  for (const [name, value] of response.headers)
    if (name !== "set-cookie") res.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (head || response.body === null) {
    await response.body?.cancel();
    return void res.end();
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Wait for the client to take each chunk, so a slow reader can't make
      // the server buffer a whole page (the deadline below still applies).
      if (!res.write(value))
        await new Promise((resolve) => {
          res.once("drain", resolve);
          res.once("close", resolve);
        });
      if (res.destroyed) return await reader.cancel();
    }
  } finally {
    reader.releaseLock();
  }
  res.end();
}

/** apps/web's server. The caller listens on it and closes it. */
export function createWebServer({
  start,
  accounts,
  clientDir,
  origin,
  log,
  maxInFlight = 64,
  idleTimeoutMs = 15_000,
  deadlineMs = 60_000,
}: WebServerOptions): Server {
  const base = new URL(origin);
  if ((base.protocol !== "https:" && base.protocol !== "http:") || base.origin !== origin)
    throw new RangeError("origin must be a bare http(s) origin");
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1)
    throw new RangeError("maxInFlight must be at least 1");
  const assets = join(clientDir, "assets");
  let inFlight = 0;

  async function handle(req: IncomingMessage, res: ServerResponse, route: RouteClass) {
    const method = req.method ?? "";
    // Origin-form only: an absolute-form target (`GET http://elsewhere/`)
    // would replace the origin the URL is built on.
    const target = req.url ?? "";
    if (!METHODS.has(method) || !target.startsWith("/") || target.startsWith("//"))
      throw new Refusal(400);
    const url = new URL(target, origin);

    if (route === "asset") {
      const match = ASSET.exec(url.pathname);
      if (match === null || url.search !== "") throw new Refusal(404);
      let file: Buffer;
      try {
        // The pattern admits one plain file name, so this stays in assets/.
        file = await readFile(join(assets, url.pathname.slice("/assets/".length)));
      } catch {
        throw new Refusal(404);
      }
      res.statusCode = 200;
      res.setHeader("content-type", CONTENT_TYPES[match[1]!]!);
      res.setHeader("content-length", file.length);
      // Every asset's name carries its content hash.
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      res.setHeader("cross-origin-resource-policy", "same-origin");
      return void res.end(method === "HEAD" ? undefined : file);
    }

    let body: Uint8Array<ArrayBuffer> | undefined;
    if (method === "POST") body = await readBody(req);
    else if (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"])
      throw new Refusal(400);

    // The request as the handlers see it: the client's headers on our URL,
    // with the body already bounded.
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === "host") continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    headers.set("host", base.host);
    const request = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    if (route !== "auth") return send(res, await start.fetch(request), method === "HEAD");
    // The account handler answers JSON and sets few headers of its own
    // (src/security.ts covers pages). A copy: a response's own headers can be
    // immutable.
    const answer = await accounts(request);
    const response = new Response(answer.body, answer);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("cross-origin-resource-policy", "same-origin");
    await send(res, response, method === "HEAD");
  }

  const server = createServer(
    {
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      connectionsCheckingInterval: 1_000,
    },
    async (req, res) => {
      const started = performance.now();
      const method = METHODS.has(req.method ?? "") ? (req.method as string) : "other";
      const path = (req.url ?? "").split("?", 1)[0]!;
      let route = classify(method, path);
      res.on("finish", () =>
        log({ method, route, status: res.statusCode, ms: Math.round(performance.now() - started) }),
      );
      // On every answer, refusals and assets included; pages and account
      // answers set it again.
      res.setHeader("x-content-type-options", "nosniff");
      if (inFlight >= maxInFlight) {
        route = "refused";
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
        await handle(req, res, route);
      } catch (e) {
        if (e instanceof Refusal) {
          route = "refused";
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
