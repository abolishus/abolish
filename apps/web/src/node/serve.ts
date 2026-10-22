// apps/web's HTTP front on node:http: the built Start handler for pages and
// server functions, the account handler from @abolishus/core under /auth, an
// author's poll drafts under /drafts (src/node/drafts.ts), an account's
// e-mail address under /email (src/node/email.ts), its phone number under
// /phone (src/node/phone.ts), its Tier 0 token under /token
// (src/node/token.ts), reactions on a poll under /reactions
// (src/node/reactions.ts), and the client's hashed assets from disk, with
// the web app manifest and its icons (src/app/install.ts), and the offline
// shell's page and worker, which Start renders (src/app/offline.ts).
//
// The account system lives here, on apps/web's origin, so its host-only
// session cookie never reaches the API or the ballot client's host (T-10,
// ADR 0017). Nothing on this server ever handles a ballot.
//
// T-10, T-11, T-67: the request log is the only thing written about a
// request, and a line never carries an address, a header (so no cookie), a
// query string, a body or a page's path (a poll page's path names the poll a
// visitor looked at): only the method, a route class from a fixed list, the
// status and the duration. What PostHog gets is as narrow: a page's
// template, never its path, and our own code's failures by name and bundle
// position (src/analytics.ts, src/node/analytics.ts).

import { once } from "node:events";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

import { type ClientError, ERROR_NAME, pageOf, parseClientError } from "../analytics.ts";
import { APP_FILES } from "../app/install.ts";
import { OFFLINE_PATH, WORKER_PATH } from "../app/offline.ts";
import { appFileHeaders } from "../security.ts";
import { type Analytics, noAnalytics } from "./analytics.ts";

/** The built Start server (`dist/server/server.js`'s default export). */
export interface StartHandler {
  fetch(request: Request): Promise<Response>;
}

/** The account handler (`createAccounts(...).handler` from @abolishus/core). */
export type AccountHandler = (request: Request) => Promise<Response>;

/** The drafts handler (`createDraftsHandler(...)` from src/node/drafts.ts). */
export type DraftsHandler = (request: Request) => Promise<Response>;

/** The e-mail handler (`createEmailHandler(...)` from src/node/email.ts). */
export type EmailHandler = (request: Request) => Promise<Response>;

/** The phone handler (`createPhoneHandler(...)` from src/node/phone.ts). */
export type PhoneHandler = (request: Request) => Promise<Response>;

/** The token handler (`createTokenHandler(...)` from src/node/token.ts). */
export type TokenHandler = (request: Request) => Promise<Response>;

/** The reactions handler (`createReactionsHandler(...)` from src/node/reactions.ts). */
export type ReactionsHandler = (request: Request) => Promise<Response>;

/** What a request was, from a fixed list: never its path. */
export type RouteClass =
  | "page"
  | "server-fn"
  | "auth"
  | "drafts"
  | "email"
  | "phone"
  | "token"
  | "reactions"
  | "asset"
  | "offline"
  | "ingest"
  | "refused";

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
  readonly drafts: DraftsHandler;
  readonly email: EmailHandler;
  readonly phone: PhoneHandler;
  readonly token: TokenHandler;
  readonly reactions: ReactionsHandler;
  /** The built client (`dist/client`); only its `assets/` are served. */
  readonly clientDir: string;
  /**
   * This site's public origin (`https://…`). Every request's URL is built on
   * it, never on the `Host` header a client sent.
   */
  readonly origin: string;
  readonly log: Log;
  /** Where page views and failures are reported; nowhere by default. */
  readonly analytics?: Analytics;
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

/** The route classes whose handlers get the account cookie. */
const ACCOUNT_ROUTES: ReadonlySet<RouteClass> = new Set([
  "auth",
  "drafts",
  "email",
  "phone",
  "token",
  "reactions",
]);

/**
 * Paths under an account route class that answer anyone alike and never get
 * the cookie: the poll page asks a poll's reaction counts for every visitor,
 * so the session and the poll it names never arrive together (T-11).
 */
const SESSION_FREE_PATHS: ReadonlySet<string> = new Set(["/reactions/counts"]);

function classify(method: string, path: string): RouteClass {
  if (path === "/auth" || path.startsWith("/auth/")) return "auth";
  if (path === "/drafts" || path.startsWith("/drafts/")) return "drafts";
  if (path === "/email" || path.startsWith("/email/")) return "email";
  if (path === "/phone" || path.startsWith("/phone/")) return "phone";
  if (path === "/token" || path.startsWith("/token/")) return "token";
  if (path === "/reactions" || path.startsWith("/reactions/")) return "reactions";
  if (path.startsWith(SERVER_FN_PREFIX)) return "server-fn";
  if (path === "/ingest" || path.startsWith("/ingest/")) return "ingest";
  if (
    (path.startsWith("/assets/") || Object.hasOwn(APP_FILES, path)) &&
    (method === "GET" || method === "HEAD")
  )
    return "asset";
  // Fetched by the offline shell's worker as it installs and updates, not by
  // a visitor opening a page, so never a page view (T-67).
  if ((path === OFFLINE_PATH || path === WORKER_PATH) && (method === "GET" || method === "HEAD"))
    return "offline";
  return "page";
}

/**
 * Answers `status` with a fixed body. Anything staged for another answer
 * (its length, cookies, caching) is dropped first: a failure can come after
 * a response's headers were set but before they were sent.
 */
function refuse(res: ServerResponse, status: number, extra: Record<string, string> = {}) {
  for (const name of res.getHeaderNames()) res.removeHeader(name);
  for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("connection", "close");
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
  // A client that goes away (or the deadline) stops the render: the stream
  // is cancelled rather than left pending with nobody to read it (T-52).
  const gone = new AbortController();
  const onClose = () => gone.abort();
  res.once("close", onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.destroyed) return await reader.cancel();
      // Wait for the client to take each chunk, so a slow reader can't make
      // the server buffer a whole page (the deadline still applies).
      if (!res.write(value)) {
        try {
          await once(res, "drain", { signal: gone.signal });
        } catch {
          return await reader.cancel();
        }
      }
    }
  } finally {
    res.off("close", onClose);
    reader.releaseLock();
  }
  res.end();
}

/** apps/web's server. The caller listens on it and closes it. */
export function createWebServer({
  start,
  accounts,
  drafts,
  email,
  phone,
  token,
  reactions,
  clientDir,
  origin,
  log,
  analytics = noAnalytics,
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
  // The bundles a report's frames may name: the ones this server serves.
  const bundles = new Set(readdirSync(assets).filter((name) => name.endsWith(".js")));
  let inFlight = 0;

  /**
   * The request's URL on our origin, or undefined for any target that would
   * leave it: an absolute form (`GET http://elsewhere/`), `//host` or `/\\host`
   * (which the URL parser reads as another host).
   */
  function urlOf(req: IncomingMessage): URL | undefined {
    const target = req.url ?? "";
    if (!target.startsWith("/")) return undefined;
    let url: URL;
    try {
      url = new URL(target, origin);
    } catch {
      return undefined;
    }
    return url.origin === base.origin ? url : undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse, route: RouteClass) {
    const method = req.method ?? "";
    // Origin-form only: an absolute-form target (`GET http://elsewhere/`)
    // would replace the origin the URL is built on.
    const url = urlOf(req);
    if (!METHODS.has(method) || url === undefined) throw new Refusal(400);

    if (route === "asset" && Object.hasOwn(APP_FILES, url.pathname)) {
      if (url.search !== "") throw new Refusal(404);
      let file: Buffer;
      try {
        // A name from the fixed list, so this stays in the client's own files.
        file = await readFile(join(clientDir, url.pathname));
      } catch {
        throw new Refusal(404);
      }
      res.statusCode = 200;
      for (const [name, value] of Object.entries(appFileHeaders())) res.setHeader(name, value);
      res.setHeader("content-type", APP_FILES[url.pathname]!);
      res.setHeader("content-length", file.length);
      return void res.end(method === "HEAD" ? undefined : file);
    }

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

    if (route === "ingest") return ingest(req, res, url);

    let body: Uint8Array<ArrayBuffer> | undefined;
    if (method === "POST") body = await readBody(req);
    else if (req.headers["content-length"] !== undefined || req.headers["transfer-encoding"])
      throw new Refusal(400);

    // The request as the handlers see it: the client's headers on our URL,
    // with the body already bounded.
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || name === "host") continue;
      // Pages and server functions never get the account cookie: nothing
      // they render can join a session to the poll it shows (T-10, T-67).
      if (name === "cookie" && (!ACCOUNT_ROUTES.has(route) || SESSION_FREE_PATHS.has(url.pathname)))
        continue;
      for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
    }
    headers.set("host", base.host);
    const request = new Request(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    if (!ACCOUNT_ROUTES.has(route)) return send(res, await start.fetch(request), method === "HEAD");
    // The account, drafts, e-mail, phone, token and reactions handlers answer
    // JSON and set few headers of their own (src/security.ts covers pages). A
    // copy: a response's own headers can be immutable.
    const handler =
      route === "auth"
        ? accounts
        : route === "drafts"
          ? drafts
          : route === "email"
            ? email
            : route === "phone"
              ? phone
              : route === "token"
                ? token
                : reactions;
    const answer = await handler(request);
    const response = new Response(answer.body, answer);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.headers.set("cross-origin-resource-policy", "same-origin");
    await send(res, response, method === "HEAD");
  }

  /**
   * `/ingest/error`: a failure in one of our pages, reported by the page's
   * own code (src/error-reports.ts) and passed to PostHog only if it is
   * exactly a `ClientError` whose frames name bundles we serve, so a report
   * can carry nothing else (T-67).
   */
  async function ingest(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (url.pathname !== "/ingest/error" || url.search !== "") throw new Refusal(404);
    if (req.method !== "POST") throw new Refusal(405);
    // Only our own pages report: a browser always sends Origin on a POST.
    if (req.headers.origin !== base.origin) throw new Refusal(403);
    if (req.headers["content-type"] !== "application/json") throw new Refusal(415);
    const body = new TextDecoder().decode(await readBody(req));
    let report: ClientError | undefined;
    try {
      report = parseClientError(JSON.parse(body));
    } catch {
      throw new Refusal(400);
    }
    if (report === undefined) throw new Refusal(400);
    // FRAME (src/analytics.ts) holds, so each is `assets/<file>:<line>:<column>`.
    for (const frame of report.frames)
      if (!bundles.has(frame.slice("assets/".length, frame.indexOf(":")))) throw new Refusal(400);
    analytics.exception("client", report);
    res.statusCode = 204;
    res.setHeader("cache-control", "no-store");
    res.end();
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
      // Classed on the path the handlers will see, `..` segments resolved.
      const url = urlOf(req);
      let route: RouteClass = url === undefined ? "refused" : classify(method, url.pathname);
      res.on("finish", () => {
        log({ method, route, status: res.statusCode, ms: Math.round(performance.now() - started) });
        if (route === "page" && method === "GET" && url !== undefined)
          analytics.pageview(pageOf(url.pathname), res.statusCode);
      });
      // On every answer, refusals and assets included; pages and account
      // answers set it again.
      res.setHeader("x-content-type-options", "nosniff");
      if (inFlight >= maxInFlight) {
        route = "refused";
        return refuse(res, 503, { "retry-after": "1" });
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
          return refuse(res, e.status);
        }
        // A client that went away mid-request isn't a server failure. Its
        // socket says so, not the request: a request whose body was read
        // is destroyed once it ends, and a failure after that still gets
        // its 500.
        if (req.socket.destroyed || res.destroyed) return void res.destroy();
        const name = e instanceof Error ? e.name : typeof e;
        log({ error: name });
        analytics.exception("server", {
          page: route === "page" && url !== undefined ? pageOf(url.pathname) : "other",
          name: ERROR_NAME.test(name) ? name : "Error",
          frames: [],
        });
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
