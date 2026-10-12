// The Node front (src/node/serve.ts) over HTTP: the account handler from
// @abolishus/core against Postgres as the app role, driven through the
// page's own WebAuthn conversions (src/account/webauthn.ts) with a software
// authenticator; the assets; and what the front refuses and logs.

import { createAccounts } from "@abolishus/core";
import { SoftAuthenticator } from "@abolishus/core/test-authenticator";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { request as rawRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import {
  authenticationJSON,
  creationOptions,
  registrationJSON,
  requestOptions,
  toBase64url,
} from "../src/account/webauthn.ts";
import type { ClientError, Page } from "../src/analytics.ts";
import type { Analytics } from "../src/node/analytics.ts";
import { createWebServer, type Log, MAX_BODY } from "../src/node/serve.ts";

const ORIGIN = "https://abolish.test";
const RP_ID = "abolish.test";
const SECRET = "test-secret-test-secret-test-secret-0123456789";
const SESSION = "__Secure-abolish-account.session_token";
const SCRIPT = "export const a = 1;\n";

let db: TestDb;
let clientDir: string;
let server: Server;
let base: string;
const logged: Parameters<Log>[0][] = [];
/** Everything the front reported to analytics. */
const reported: (
  | { kind: "pageview"; page: Page; status: number }
  | { kind: "exception"; source: "client" | "server"; error: ClientError }
)[] = [];
const analytics: Analytics = {
  pageview: (page, status) => void reported.push({ kind: "pageview", page, status }),
  exception: (source, error) => void reported.push({ kind: "exception", source, error }),
  close: async () => {},
};
/** Every request the stub Start handler received. */
const started: Request[] = [];

/** The last streamed page: how many chunks it gave and whether it was cancelled. */
let stream = { pulls: 0, cancelled: false };

/** A page that streams a chunk every 20 ms, without end. */
function streamed(): Response {
  stream = { pulls: 0, cancelled: false };
  const state = stream;
  return new Response(
    new ReadableStream({
      pull: async (controller) => {
        state.pulls++;
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(new Uint8Array(1024));
      },
      cancel: () => {
        state.cancelled = true;
      },
    }),
  );
}

beforeAll(async () => {
  db = await testDb();
  const accounts = createAccounts({
    sql: await db.as("abolish_app"),
    secret: SECRET,
    origin: ORIGIN,
    rpID: RP_ID,
    // Turnstile's checks are packages/core's tests; here every start passes.
    turnstile: { verify: async () => "passed" },
    log: () => {},
  });
  clientDir = mkdtempSync(join(tmpdir(), "abolish-web-client-"));
  mkdirSync(join(clientDir, "assets"));
  writeFileSync(join(clientDir, "assets", "index-AbC_12-x.js"), SCRIPT);
  writeFileSync(join(clientDir, "secret.txt"), "not an asset");
  server = createWebServer({
    start: {
      fetch: async (request) => {
        started.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/stream") return streamed();
        if (path === "/broken")
          return new Response(
            new ReadableStream({
              pull: () => {
                throw new Error("render failed");
              },
            }),
            { headers: { "content-length": "5000", "set-cookie": "c=3; Secure" } },
          );
        const headers = new Headers({ "content-type": "text/html" });
        headers.append("set-cookie", "a=1; Secure");
        headers.append("set-cookie", "b=2; Secure");
        return new Response(`<p>${new URL(request.url).pathname}</p>`, { headers });
      },
    },
    accounts: (request) => accounts.handler(request),
    clientDir,
    origin: ORIGIN,
    log: (line) => logged.push(line),
    analytics,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await db?.close();
  if (clientDir) rmSync(clientDir, { recursive: true, force: true });
});

/** A browser on ORIGIN: its cookies, sent with each call (the front builds URLs on ORIGIN). */
class Browser {
  readonly cookies = new Map<string, string>();

  async call(method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ origin: ORIGIN });
    if (this.cookies.size)
      headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (body !== undefined) headers.set("content-type", "application/json");
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";", 1);
      const eq = pair!.indexOf("=");
      const value = pair!.slice(eq + 1);
      if (value === "" || /;\s*max-age=0/i.test(c)) this.cookies.delete(pair!.slice(0, eq));
      else this.cookies.set(pair!.slice(0, eq), value);
    }
    return res;
  }
}

const buffer = (b64url: string) => new Uint8Array(Buffer.from(b64url, "base64url")).buffer;

/**
 * What navigator.credentials would hand the page: the software
 * authenticator's answer to the options as the page converted them, so the
 * conversion is what the server's verification checks.
 */
async function register(browser: Browser, device: SoftAuthenticator, createSession: boolean) {
  const json = await (await browser.call("GET", "/auth/passkey/generate-register-options")).json();
  const options = creationOptions(json);
  const made = device.create(
    {
      challenge: toBase64url(new Uint8Array(options.challenge as ArrayBuffer)),
      rp: { id: options.rp.id ?? "" },
    },
    { origin: ORIGIN },
  );
  const credential = {
    id: made.id,
    rawId: buffer(made.rawId),
    type: "public-key",
    authenticatorAttachment: "platform",
    response: {
      clientDataJSON: buffer(made.response.clientDataJSON),
      attestationObject: buffer(made.response.attestationObject),
      getTransports: () => made.response.transports,
    },
  } as unknown as PublicKeyCredential;
  return browser.call("POST", "/auth/passkey/verify-registration", {
    response: registrationJSON(credential),
    ...(createSession ? { createSession: true } : {}),
  });
}

async function signIn(browser: Browser, device: SoftAuthenticator) {
  const json = await (
    await browser.call("GET", "/auth/passkey/generate-authenticate-options")
  ).json();
  const options = requestOptions(json);
  const made = device.get(
    {
      challenge: toBase64url(new Uint8Array(options.challenge as ArrayBuffer)),
      ...(options.rpId === undefined ? {} : { rpId: options.rpId }),
    },
    { origin: ORIGIN },
  );
  const credential = {
    id: made.id,
    rawId: buffer(made.rawId),
    type: "public-key",
    authenticatorAttachment: null,
    response: {
      clientDataJSON: buffer(made.response.clientDataJSON),
      authenticatorData: buffer(made.response.authenticatorData),
      signature: buffer(made.response.signature),
      userHandle: null,
    },
  } as unknown as PublicKeyCredential;
  return browser.call("POST", "/auth/passkey/verify-authentication", {
    response: authenticationJSON(credential),
  });
}

describe("accounts under /auth", () => {
  test("signs up, adds a passkey, signs out and back in, through the page's conversions", async () => {
    const browser = new Browser();
    const device = new SoftAuthenticator(RP_ID);
    expect(await (await browser.call("GET", "/auth/get-session")).json()).toBeNull();

    const signedUp = await register(browser, device, true);
    expect(signedUp.status).toBe(200);
    expect(browser.cookies.has(SESSION)).toBe(true);
    expect(await (await browser.call("GET", "/auth/get-session")).json()).not.toBeNull();

    expect((await register(browser, device, false)).status).toBe(200);
    const passkeys = (await (
      await browser.call("GET", "/auth/passkey/list-user-passkeys")
    ).json()) as { id: string; createdAt: string; backedUp: boolean }[];
    expect(passkeys).toHaveLength(2);
    for (const p of passkeys) {
      expect(typeof p.id).toBe("string");
      expect(Number.isNaN(Date.parse(p.createdAt))).toBe(false);
      expect(p.backedUp).toBe(true);
    }

    expect((await browser.call("POST", "/auth/sign-out", {})).status).toBe(200);
    expect(await (await browser.call("GET", "/auth/get-session")).json()).toBeNull();
    expect((await signIn(browser, device)).status).toBe(200);
    expect(await (await browser.call("GET", "/auth/get-session")).json()).not.toBeNull();

    expect((await browser.call("POST", "/auth/delete-user", {})).status).toBe(200);
    expect(await (await browser.call("GET", "/auth/get-session")).json()).toBeNull();
    expect((await signIn(browser, device)).status).not.toBe(200);
  });

  test("account answers are never cached or sniffed, and other routes stay closed", async () => {
    const browser = new Browser();
    const res = await browser.call("GET", "/auth/get-session");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect((await browser.call("POST", "/auth/sign-up/email", {})).status).toBe(404);
    expect(started).toHaveLength(0);
  });

  test("a request from another origin can't act on a session", async () => {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const res = await fetch(`${base}/auth/sign-out`, {
      method: "POST",
      headers: {
        origin: "https://elsewhere.test",
        cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await (await browser.call("GET", "/auth/get-session")).json()).not.toBeNull();
  });
});

/** A raw request, so the target and headers go out exactly as written. */
function raw(
  target: string,
  {
    method = "GET",
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const { port } = server.address() as AddressInfo;
    const req = rawRequest({ host: "127.0.0.1", port, method, path: target, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("the front", () => {
  test("serves a built asset, immutable, and nothing else from disk", async () => {
    const asset = await raw("/assets/index-AbC_12-x.js");
    expect(asset.status).toBe(200);
    expect(asset.body).toBe(SCRIPT);
    expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.headers["x-content-type-options"]).toBe("nosniff");
    // `..` segments resolve before routing: what is left is a page path,
    // which Start answers, and never a file outside assets/.
    for (const target of ["/assets/../secret.txt", "/assets/%2e%2e/secret.txt"])
      expect((await raw(target)).body).not.toContain("not an asset");
    started.length = 0;
    for (const target of [
      "/assets/..%2fsecret.txt",
      "/assets/missing-abc.js",
      "/assets/index-AbC_12-x.js?v=1",
      "/assets/secret.txt",
      "/assets/",
    ])
      expect([target, (await raw(target)).status]).toEqual([target, 404]);
    expect(started).toHaveLength(0);
  });

  test("builds every request on the configured origin, whatever Host or target says", async () => {
    started.length = 0;
    expect((await raw("/polls?id=ab", { headers: { host: "evil.test" } })).status).toBe(200);
    expect(started[0]?.url).toBe(`${ORIGIN}/polls?id=ab`);
    expect(started[0]?.headers.get("host")).toBe("abolish.test");
    expect((await raw("http://evil.test/polls")).status).toBe(400);
    expect((await raw("//evil.test/polls")).status).toBe(400);
    expect((await raw("/\\evil.test/x")).status).toBe(400);
    expect((await raw("/\\\\evil.test/")).status).toBe(400);
    expect((await raw("/", { method: "PUT" })).status).toBe(400);
    expect(started).toHaveLength(1);
  });

  test("keeps every Set-Cookie apart", async () => {
    const page = await raw("/");
    expect(page.headers["set-cookie"]).toEqual(["a=1; Secure", "b=2; Secure"]);
  });

  test("refuses a body over the bound, and a GET with a body", async () => {
    started.length = 0;
    const big = Buffer.alloc(MAX_BODY + 1, 0x61);
    expect((await raw("/_serverFn/x", { method: "POST", body: big })).status).toBe(413);
    expect(
      (
        await raw("/_serverFn/x", {
          method: "POST",
          headers: { "transfer-encoding": "chunked" },
          body: big,
        })
      ).status,
    ).toBe(413);
    expect(
      (await raw("/", { headers: { "content-length": "2" }, body: Buffer.from("{}") })).status,
    ).toBe(400);
    expect(started).toHaveLength(0);
  });

  test("logs a route class, never a path, query, address or header", async () => {
    logged.length = 0;
    const id = "ab".repeat(32);
    await raw(`/polls/${id}?secret=1`, {
      headers: { cookie: `${SESSION}=tok`, "user-agent": "UA" },
    });
    await raw("/assets/index-AbC_12-x.js");
    await raw("/auth/get-session");
    await raw("/_serverFn/abc", { method: "POST", body: Buffer.from("{}") });
    await raw("/\\evil.test/x");
    // Lines are written on "finish", after the client has its answer.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logged.map((l) => ("route" in l ? l.route : l.error))).toEqual([
      "page",
      "asset",
      "auth",
      "server-fn",
      "refused",
    ]);
    for (const line of logged) {
      expect(Object.keys(line).sort()).toEqual(["method", "ms", "route", "status"]);
      const text = JSON.stringify(line);
      for (const leak of [id, "secret", "tok", "UA", "127.0.0.1", "/"])
        expect(text).not.toContain(leak);
    }
  });
});

describe("failures", () => {
  test("pages and server functions never get the account cookie", async () => {
    started.length = 0;
    await raw("/polls", { headers: { cookie: `${SESSION}=tok; other=1` } });
    await raw("/_serverFn/x", {
      method: "POST",
      headers: { cookie: `${SESSION}=tok` },
      body: Buffer.from("{}"),
    });
    expect(started).toHaveLength(2);
    for (const request of started) expect(request.headers.get("cookie")).toBeNull();
  });

  test("a client that leaves mid-page stops the render", async () => {
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      const req = rawRequest({ host: "127.0.0.1", port, path: "/stream" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      req.once("error", reject);
      req.end();
    });
    for (let i = 0; i < 50 && !stream.cancelled; i++) await new Promise((r) => setTimeout(r, 20));
    expect(stream.cancelled).toBe(true);
    const pulls = stream.pulls;
    await new Promise((r) => setTimeout(r, 100));
    expect(stream.pulls).toBe(pulls);
  });

  test("a page that fails after its headers were staged is a clean 500", async () => {
    logged.length = 0;
    const res = await raw("/broken");
    expect(res.status).toBe(500);
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers["content-length"]).not.toBe("5000");
    expect(res.headers["connection"]).toBe("close");
    expect(res.body).toBe("500\n");
    expect(logged).toContainEqual({ error: "Error" });
  });

  test("a client that aborts its upload isn't logged as a server error", async () => {
    logged.length = 0;
    const { port } = server.address() as AddressInfo;
    const req = rawRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/_serverFn/x",
      headers: { "content-length": "100" },
    });
    req.on("error", () => {});
    req.write("{");
    await new Promise((r) => setTimeout(r, 50));
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(logged.filter((l) => "error" in l)).toEqual([]);
  });
});

describe("analytics", () => {
  const report = {
    page: "/polls/:id",
    name: "TypeError",
    frames: ["assets/index-AbC_12-x.js:1:2345"],
  };
  const post = (body: unknown, headers: Record<string, string> = {}, target = "/ingest/error") =>
    raw(target, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
      body: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)),
    });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  test("a page view is its template and status, never its path or query", async () => {
    reported.length = 0;
    const id = "cd".repeat(32);
    await raw(`/polls/${id}?q=1`, { headers: { cookie: `${SESSION}=tok` } });
    await raw("/moderation?after=7");
    await raw("/somewhere/else");
    await raw("/broken");
    // Not page views: assets, accounts, server functions, refusals, HEAD.
    await raw("/assets/index-AbC_12-x.js");
    await raw("/auth/get-session");
    await raw("/_serverFn/abc", { method: "POST", body: Buffer.from("{}") });
    await raw("//evil.test/");
    await raw("/polls", { method: "HEAD" });
    await settle();
    expect(reported).toEqual([
      { kind: "pageview", page: "/polls/:id", status: 200 },
      { kind: "pageview", page: "/moderation", status: 200 },
      { kind: "pageview", page: "other", status: 200 },
      { kind: "exception", source: "server", error: { page: "other", name: "Error", frames: [] } },
      { kind: "pageview", page: "other", status: 500 },
    ]);
    expect(JSON.stringify(reported)).not.toContain(id);
  });

  test("a report from one of our pages is passed on exactly, and never reaches Start", async () => {
    reported.length = 0;
    started.length = 0;
    const res = await post(report);
    expect(res.status).toBe(204);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(reported).toEqual([{ kind: "exception", source: "client", error: report }]);
    expect(started).toHaveLength(0);
  });

  test("refuses reports from other origins, of other shapes, or by other means", async () => {
    reported.length = 0;
    started.length = 0;
    const id = "ef".repeat(32);
    const refusals: [Promise<{ status: number }>, number][] = [
      [post(report, { origin: "https://evil.test" }), 403],
      [raw("/ingest/error", { method: "POST", body: Buffer.from(JSON.stringify(report)) }), 403],
      [post(report, { "content-type": "text/plain" }), 415],
      [post(report, { "content-type": "application/json; charset=utf-8" }), 415],
      // Well-formed, but not a bundle this server serves.
      [post({ ...report, frames: ["assets/main-Ab1.js:1:2"] }), 400],
      [post("{"), 400],
      [post({ ...report, message: "x" }), 400],
      [post({ ...report, page: `/polls/${id}` }), 400],
      [post({ ...report, name: "Type Error: x" }), 400],
      [post({ ...report, frames: [`https://abolish.test/polls/${id}:1:2`] }), 400],
      [post({ ...report, frames: Array(21).fill(report.frames[0]) }), 400],
      [post("x".repeat(MAX_BODY + 1)), 413],
      [post(report, {}, "/ingest/error?x=1"), 404],
      [post(report, {}, "/ingest/other"), 404],
      [raw("/ingest/error"), 405],
    ];
    for (const [res, status] of refusals) expect((await res).status).toBe(status);
    expect(reported).toEqual([]);
    expect(started).toHaveLength(0);
  });
});

describe("limits", () => {
  test("past maxInFlight a request is refused with 503 before it is handled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const seen: string[] = [];
    const busy = createWebServer({
      start: {
        fetch: async (request) => {
          seen.push(new URL(request.url).pathname);
          await gate;
          return new Response("ok");
        },
      },
      accounts: async () => new Response(null, { status: 404 }),
      clientDir,
      origin: ORIGIN,
      log: () => {},
      maxInFlight: 1,
    });
    await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
    const at = `http://127.0.0.1:${(busy.address() as AddressInfo).port}`;
    const first = fetch(`${at}/first`);
    while (seen.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await fetch(`${at}/second`);
    expect(second.status).toBe(503);
    expect(second.headers.get("retry-after")).toBe("1");
    release();
    expect((await first).status).toBe(200);
    expect(seen).toEqual(["/first"]);
    await new Promise((resolve) => busy.close(resolve));
  });

  test("refuses an origin that isn't a bare http(s) origin", () => {
    const options = {
      start: { fetch: async () => new Response() },
      accounts: async () => new Response(),
      clientDir,
      log: () => {},
    };
    for (const origin of ["https://abolish.test/", "https://abolish.test/x", "ftp://abolish.test"])
      expect(() => createWebServer({ ...options, origin })).toThrow(RangeError);
  });
});
