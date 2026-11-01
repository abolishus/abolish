// The Node front (src/node/serve.ts) over HTTP: the account handler from
// @abolishus/core against Postgres as the app role, driven through the
// page's own WebAuthn conversions (src/account/webauthn.ts) with a software
// authenticator; the assets; and what the front refuses and logs.

import {
  ACCOUNT_EXPORT_VERSION,
  type AccountExport,
  createAccounts,
  decideAppeal,
  decideProfileAppeal,
  emailKeys,
  type EmailMessage,
  exportAccount,
  landResults,
  MAX_FOLLOW_CHANGES_PER_HOUR,
  MAX_REACTION_CHANGES_PER_HOUR,
  parseKeyring,
  type PhoneChannel,
  type PhoneVerifier,
  TURNSTILE_HEADER,
  type TurnstileVerdict,
  makeProfile,
  moderate,
  moderateProfile,
  newAccountId,
  newVapidKey,
  PROFILE_HANDLE,
  parseTier0IssuerKeys,
  readProfileReportQueue,
  tier0Issuer,
  type TurnstileAction,
  vapidKeys,
  vapidPublicKey,
} from "@abolishus/core";
import {
  generateTier0TokenKeyPair,
  tier0TokenBlind,
  tier0TokenEvaluate,
  tier0TokenFinalize,
  tier0TokenInfo,
  tier0TokenInput,
  tier0TokenKeyId,
  tier0TokenKeyPeriod,
} from "@abolishus/crypto";
import { SoftAuthenticator } from "@abolishus/core/test-authenticator";
import { addModerators, newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { request as rawRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
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
import { createDraftsHandler } from "../src/node/drafts.ts";
import { createEmailHandler } from "../src/node/email.ts";
import { createExportHandler } from "../src/node/export.ts";
import { createFollowsHandler } from "../src/node/follows.ts";
import { createPhoneHandler } from "../src/node/phone.ts";
import { createProfilesHandler } from "../src/node/profiles.ts";
import { createPushHandler } from "../src/node/push.ts";
import { createReactionsHandler } from "../src/node/reactions.ts";
import { createWebServer, type Log, MAX_BODY } from "../src/node/serve.ts";
import { createTokenHandler } from "../src/node/token.ts";
import { fromHex } from "../src/values.ts";

const ORIGIN = "https://abolish.test";
const RP_ID = "abolish.test";
const SECRET = "test-secret-test-secret-test-secret-0123456789";
const SESSION = "__Secure-abolish-account.session_token";
const SCRIPT = "export const a = 1;\n";
const MANIFEST = '{"name":"Abolish"}\n';

let db: TestDb;
let sql: Awaited<ReturnType<TestDb["as"]>>;
let accounts: ReturnType<typeof createAccounts>;
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
/** Every token a poll submission's Turnstile check saw. */
const submitted: [string | null, TurnstileAction][] = [];
/** What the drafts handler's API answers for each election's answered counts, by hex ID; one asked with none rejects. */
const answeredServed = new Map<string, { tier: number; answered: string }[]>();
/** Each read of the drafts handler's API, with the elections it asked about. */
const answeredAsked: (readonly string[])[] = [];
/** An election the API is to say it doesn't know: left out of its answer. */
const answeredUnknown = new Set<string>();
/** The drafts handler's clock. */
const NOW = new Date("2026-10-17T12:00:00Z");
/** The push handler's VAPID public key. */
const PUSH_KEY = vapidPublicKey(vapidKeys(newVapidKey()));

/** Every message the e-mail handler's sender was asked to send. */
const mailed: EmailMessage[] = [];
/** What the e-mail handler's sender answers, and its Turnstile check. */
const provider: { send: "sent" | "unavailable" | "hang"; verdict: TurnstileVerdict } = {
  send: "sent",
  verdict: "passed",
};
/** Every token a request for an e-mail code's Turnstile check saw. */
const emailChecks: [string | null, TurnstileAction][] = [];
const ring = (id: string) => parseKeyring(`${id}:${randomBytes(32).toString("hex")}`);
const EMAIL_KEYS = emailKeys(ring("h1"), ring("b1"));

/** The token handler's issuer: the key of NOW's period, and its deployment. */
const PERIOD = tier0TokenKeyPeriod(NOW.getTime() / 1000);
const ISSUER_KEY = generateTier0TokenKeyPair();
const DEPLOYMENT = {
  chainId: 421_614n,
  groupRegistry: Uint8Array.from(randomBytes(20)),
  groupId: 7n,
};
const ISSUER = tier0Issuer({
  keys: parseTier0IssuerKeys(`${PERIOD}:${Buffer.from(ISSUER_KEY.secretKey).toString("hex")}`),
  chainId: DEPLOYMENT.chainId,
  groupRegistry: DEPLOYMENT.groupRegistry,
  groups: new Map([[0, DEPLOYMENT.groupId]]),
  now: NOW,
  phoneVerification: true,
});

/** The one code the phone handler's stand-in provider sends and approves. */
const PHONE_CODE = "246810";
/** What the stand-in provider was asked, and how it answers. */
const phones = {
  started: [] as [string, PhoneChannel][],
  checked: [] as [string, string][],
  pending: new Map<string, number>(),
  lines: new Map<string, { country: string; lineType: string } | "invalid" | "unavailable">(),
  start: "sent" as "sent" | "unavailable" | "throw" | "hang",
  check: undefined as "unavailable" | undefined,
  verdict: "passed" as TurnstileVerdict,
};
/** Every token a request for a phone code's Turnstile check saw. */
const phoneChecks: [string | null, TurnstileAction][] = [];
const phoneVerifier: PhoneVerifier = {
  lookup: async (number) => {
    const line = phones.lines.get(number) ?? { country: "US", lineType: "mobile" };
    return typeof line === "string" ? line : { number, ...line };
  },
  start: async (number, channel) => {
    phones.started.push([number, channel]);
    if (phones.start === "hang") return new Promise<never>(() => {});
    if (phones.start === "throw") throw new Error(`send to ${number} failed`);
    if (phones.start === "sent") phones.pending.set(number, 1);
    return phones.start;
  },
  check: async (number, code) => {
    phones.checked.push([number, code]);
    if (phones.check !== undefined) return phones.check;
    if (code !== PHONE_CODE || phones.pending.get(number) !== 1) return "wrong";
    phones.pending.delete(number);
    return "approved";
  },
};

/** Every request the stub Start handler received. */
const started: Request[] = [];
/** The request context the front handed Start with each request, in order. */
const contexts: unknown[] = [];
/** The profiles' reader the front hands every page (src/start.ts). */
const READ_PROFILE = async () => undefined;

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
  sql = await db.as("abolish_app");
  accounts = createAccounts({
    sql,
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
  mkdirSync(join(clientDir, "icons"));
  writeFileSync(join(clientDir, "manifest.webmanifest"), MANIFEST);
  writeFileSync(join(clientDir, "icons", "icon-192.png"), "png");
  writeFileSync(join(clientDir, "icons", "other.png"), "not served");
  server = createWebServer({
    start: {
      fetch: async (request, options) => {
        started.push(request);
        contexts.push(options?.context);
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
    drafts: createDraftsHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      turnstile: {
        verify: async (token, action) => {
          submitted.push([token, action]);
          return "passed";
        },
      },
      origin: ORIGIN,
      now: () => NOW,
      answered: async (electionIds) => {
        answeredAsked.push(electionIds);
        return electionIds.flatMap((electionId) => {
          if (answeredUnknown.has(electionId)) return [];
          const tiers = answeredServed.get(electionId);
          if (tiers === undefined) throw new Error("the API didn't answer");
          return [{ electionId, tiers }];
        });
      },
    }),
    email: createEmailHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      service: {
        keys: EMAIL_KEYS,
        sender: {
          send: async (message) => {
            mailed.push(message);
            if (provider.send === "hang") return new Promise<never>(() => {});
            return provider.send;
          },
        },
      },
      turnstile: {
        verify: async (token, action) => {
          emailChecks.push([token, action]);
          return provider.verdict;
        },
      },
      origin: ORIGIN,
      log: (line) => logged.push(line),
      now: () => NOW,
    }),
    phone: createPhoneHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      service: { keys: ring("p1"), verifier: phoneVerifier, dailyCeiling: 10_000 },
      turnstile: {
        verify: async (token, action) => {
          phoneChecks.push([token, action]);
          return phones.verdict;
        },
      },
      origin: ORIGIN,
      log: (line) => logged.push(line),
      now: () => NOW,
    }),
    token: createTokenHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      issuer: ISSUER,
      origin: ORIGIN,
      now: () => NOW,
    }),
    reactions: createReactionsHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      origin: ORIGIN,
      now: () => NOW,
    }),
    follows: createFollowsHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      origin: ORIGIN,
      now: () => NOW,
    }),
    profiles: createProfilesHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      origin: ORIGIN,
      now: () => NOW,
    }),
    accountExport: createExportHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      emailKeys: EMAIL_KEYS,
      origin: ORIGIN,
      now: () => NOW,
    }),
    push: createPushHandler({
      sql,
      accountOf: (headers) => accounts.accountOf(headers),
      publicKey: PUSH_KEY,
      origin: ORIGIN,
      now: () => NOW,
    }),
    context: { readProfile: READ_PROFILE },
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

  async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> {
    const headers = new Headers({ origin: ORIGIN, ...extra });
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

const closesAt = String(NOW.getTime() / 1000 + 7 * 24 * 3600);
const draft = {
  language: "en",
  title: "Lunch",
  description: "",
  questions: [
    {
      question: "Which day?",
      description: "",
      options: [
        { label: "Thursday", description: "" },
        { label: "Friday", description: "" },
      ],
      minSelections: 0,
      maxSelections: 1,
    },
  ],
  tiers: [0],
  closesAt,
};

describe("poll drafts under /drafts", () => {
  test("an author saves, lists, edits and submits a draft, and only they see it", async () => {
    const author = new Browser();
    await register(author, new SoftAuthenticator(RP_ID), true);
    const created = await author.call("POST", "/drafts/create", { draft });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const { id } = (await created.json()) as { id: string };
    const edited = { ...draft, title: "Dinner" };
    expect((await author.call("POST", "/drafts/update", { id, draft: edited })).status).toBe(200);
    expect(await (await author.call("GET", "/drafts")).json()).toEqual({
      polls: [
        {
          id,
          state: "drafted",
          title: "Dinner",
          closesAt,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
        },
      ],
    });
    expect(await (await author.call("POST", "/drafts/read", { id })).json()).toMatchObject({
      id,
      draft: edited,
    });
    const filed = { ...edited, topic: "food", place: "Riverside" };
    expect((await author.call("POST", "/drafts/update", { id, draft: filed })).status).toBe(200);
    expect(await (await author.call("POST", "/drafts/read", { id })).json()).toMatchObject({
      id,
      draft: filed,
    });
    expect((await author.call("POST", "/drafts/update", { id, draft: edited })).status).toBe(200);

    const other = new Browser();
    await register(other, new SoftAuthenticator(RP_ID), true);
    expect(await (await other.call("GET", "/drafts")).json()).toEqual({ polls: [] });
    for (const path of ["/drafts/read", "/drafts/delete", "/drafts/submit"])
      expect((await other.call("POST", path, { id })).status).toBe(404);

    submitted.length = 0;
    const submit = await author.call(
      "POST",
      "/drafts/submit",
      { id },
      { "x-turnstile-token": "tok" },
    );
    expect(submit.status).toBe(202);
    expect(submitted).toEqual([["tok", "poll-create"]]);
    expect(await (await author.call("POST", "/drafts/read", { id })).json()).toMatchObject({
      state: "submitted",
      submittedAt: NOW.toISOString(),
    });
    expect(await (await author.call("POST", "/drafts/update", { id, draft })).json()).toEqual({
      code: "NOT_EDITABLE",
      status: 409,
    });
  });

  test("a draft that breaks a rule is refused with the rule and the question", async () => {
    const author = new Browser();
    await register(author, new SoftAuthenticator(RP_ID), true);
    const [q] = draft.questions;
    const res = await author.call("POST", "/drafts/create", {
      draft: { ...draft, questions: [q, { ...q!, question: "Where?", maxSelections: 3 }] },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      code: "DRAFT_REFUSED",
      status: 422,
      problem: { rule: "selections", question: 1 },
    });
    for (const [filed, rule] of [
      [{ topic: "sports" }, "topic"],
      [{ place: "Alder  County" }, "place"],
    ] as const) {
      const refused = await author.call("POST", "/drafts/create", {
        draft: { ...draft, ...filed },
      });
      expect(refused.status).toBe(422);
      expect(await refused.json()).toEqual({
        code: "DRAFT_REFUSED",
        status: 422,
        problem: { rule },
      });
    }
    // Outside the transport bounds, or not the contract's shape: 400.
    for (const bad of [
      { draft: { ...draft, extra: 1 } },
      { draft: { ...draft, closesAt: "01" } },
      { draft: { ...draft, title: "x".repeat(1025) } },
      { draft: { ...draft, topic: "x".repeat(17) } },
      { draft: { ...draft, place: "x".repeat(161) } },
      { draft: { ...draft, place: 1 } },
      {},
    ])
      expect((await author.call("POST", "/drafts/create", bad)).status).toBe(400);
    expect(await (await author.call("GET", "/drafts")).json()).toEqual({ polls: [] });
  });

  test("an author reads a failed poll's failure, retries it, and discards it", async () => {
    const author = new Browser();
    await register(author, new SoftAuthenticator(RP_ID), true);
    const { id } = (await (await author.call("POST", "/drafts/create", { draft })).json()) as {
      id: string;
    };
    const fail = async (failure: string) => {
      expect((await author.call("POST", "/drafts/submit", { id })).status).toBe(202);
      await db.admin`UPDATE account_polls SET state = 'failed', failure = ${failure},
        creator_address = ${randomBytes(20)}, create_tx_hash = ${randomBytes(32)}
        WHERE id = ${id}`;
    };
    // Only a failed poll can be retried or discarded.
    for (const path of ["/drafts/retry", "/drafts/discard"])
      expect(await (await author.call("POST", path, { id })).json()).toEqual({
        code: "NOT_FAILED",
        status: 409,
      });
    await fail("ceremony-timeout");
    expect(await (await author.call("GET", "/drafts")).json()).toEqual({
      polls: [
        {
          id,
          state: "failed",
          title: "Lunch",
          closesAt,
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          submittedAt: NOW.toISOString(),
          failure: "ceremony-timeout",
          retryable: true,
        },
      ],
    });
    const other = new Browser();
    await register(other, new SoftAuthenticator(RP_ID), true);
    for (const path of ["/drafts/retry", "/drafts/discard"]) {
      expect((await other.call("POST", path, { id })).status).toBe(404);
      for (const bad of [{}, { id, extra: 1 }, { id: id.toUpperCase() }])
        expect((await author.call("POST", path, bad)).status).toBe(400);
      expect((await new Browser().call("POST", path, { id })).status).toBe(401);
    }

    const retried = await author.call("POST", "/drafts/retry", { id });
    expect(retried.status).toBe(200);
    expect(retried.headers.get("cache-control")).toBe("no-store");
    const read = await (await author.call("POST", "/drafts/read", { id })).json();
    expect(read).toMatchObject({ id, state: "drafted", draft });
    expect(read).not.toHaveProperty("failure");
    expect(read).not.toHaveProperty("submittedAt");

    await fail("creation-reverted");
    expect((await author.call("POST", "/drafts/discard", { id })).status).toBe(200);
    expect((await author.call("POST", "/drafts/read", { id })).status).toBe(404);
    expect(logged.at(-1)).toMatchObject({ route: "drafts" });
  });

  test("a poll whose election was registered stays, neither retried nor discarded", async () => {
    const author = new Browser();
    await register(author, new SoftAuthenticator(RP_ID), true);
    const { id } = (await (await author.call("POST", "/drafts/create", { draft })).json()) as {
      id: string;
    };
    expect((await author.call("POST", "/drafts/submit", { id })).status).toBe(202);
    await db.admin`
      UPDATE account_polls SET state = 'failed', failure = 'open-mismatch',
        creator_address = ${randomBytes(20)}, create_tx_hash = ${randomBytes(32)},
        election_id = ${randomBytes(32)}, created_block = 1, l1_origin_timestamp = 1,
        anchors_checked_block = 1, electorate = '[]', stub_hash = ${randomBytes(32)},
        ceremony_tx_hash = ${randomBytes(32)}, register_tx_hash = ${randomBytes(32)},
        registered_block = 2
      WHERE id = ${id}`;
    expect(await (await author.call("POST", "/drafts/read", { id })).json()).toMatchObject({
      state: "failed",
      failure: "open-mismatch",
      retryable: false,
    });
    for (const path of ["/drafts/retry", "/drafts/discard"])
      expect(await (await author.call("POST", path, { id })).json()).toEqual({
        code: "REGISTERED",
        status: 409,
      });
    expect(await (await author.call("POST", "/drafts/read", { id })).json()).toMatchObject({
      state: "failed",
    });
  });

  test("an open poll names its election, for its page's link; a poll in setup or failed doesn't", async () => {
    const author = new Browser();
    await register(author, new SoftAuthenticator(RP_ID), true);
    const { id } = (await (await author.call("POST", "/drafts/create", { draft })).json()) as {
      id: string;
    };
    expect((await author.call("POST", "/drafts/submit", { id })).status).toBe(202);
    const electionId = randomBytes(32);
    const set = (state: string, failure: string | null) => db.admin`
      UPDATE account_polls SET state = ${state}, failure = ${failure},
        creator_address = ${randomBytes(20)}, create_tx_hash = ${randomBytes(32)},
        election_id = ${electionId}, created_block = 1, l1_origin_timestamp = 1,
        anchors_checked_block = 1, electorate = '[]', stub_hash = ${randomBytes(32)},
        ceremony_tx_hash = ${randomBytes(32)}, register_tx_hash = ${randomBytes(32)},
        registered_block = 2
      WHERE id = ${id}`;
    // T-34: setup names no identifier, even once it has one.
    for (const [state, failure] of [
      ["registered", null],
      ["failed", "open-mismatch"],
    ] as const) {
      await set(state, failure);
      const read = await (await author.call("POST", "/drafts/read", { id })).json();
      expect(read).toMatchObject({ id, state });
      expect(read).not.toHaveProperty("electionId");
    }
    await set("open", null);
    const hex = electionId.toString("hex");
    expect(await (await author.call("POST", "/drafts/read", { id })).json()).toMatchObject({
      id,
      state: "open",
      electionId: hex,
    });
    expect(await (await author.call("GET", "/drafts")).json()).toEqual({
      polls: [expect.objectContaining({ id, state: "open", electionId: hex })],
    });
  });

  test("says how many have answered each open poll on the tiers its draft opened it to, in one read, and nothing of any other poll", async () => {
    const author = new Browser();
    await register(author, new SoftAuthenticator(RP_ID), true);
    const create = async () =>
      ((await (await author.call("POST", "/drafts/create", { draft })).json()) as { id: string })
        .id;
    const [id, second, drafted] = [await create(), await create(), await create()];
    const answered = () => author.call("POST", "/drafts/answered", {});
    // Drafts and polls in setup have no election to count (T-34), and the API isn't asked.
    expect(await (await answered()).json()).toEqual({ polls: [] });
    expect((await author.call("POST", "/drafts/submit", { id })).status).toBe(202);
    expect(await (await answered()).json()).toEqual({ polls: [] });
    expect(answeredAsked).toHaveLength(0);

    const open = async (pollId: string) => {
      const electionId = randomBytes(32);
      await db.admin`
        UPDATE account_polls SET state = 'open',
          creator_address = ${randomBytes(20)}, create_tx_hash = ${randomBytes(32)},
          election_id = ${electionId}, created_block = 1, l1_origin_timestamp = 1,
          anchors_checked_block = 1, electorate = '[]', stub_hash = ${randomBytes(32)},
          ceremony_tx_hash = ${randomBytes(32)}, register_tx_hash = ${randomBytes(32)},
          registered_block = 2, submitted_at = COALESCE(submitted_at, now())
        WHERE id = ${pollId}`;
      return electionId.toString("hex");
    };
    const hex = await open(id);
    const secondHex = await open(second);
    // The API is down: unavailable, never a zero.
    const down = await answered();
    expect([down.status, await down.json()]).toEqual([503, { code: "UNAVAILABLE", status: 503 }]);
    // Both open polls in one read, and never the draft.
    expect(answeredAsked).toHaveLength(1);
    expect(new Set(answeredAsked[0])).toEqual(new Set([hex, secondHex]));
    // A count for a tier the poll isn't open to is left out; Tier 0 is its only tier.
    answeredServed.set(hex, [
      { tier: 0, answered: "38" },
      { tier: 2, answered: "5" },
    ]);
    // A tier with none served is at 0.
    answeredServed.set(secondHex, [{ tier: 1, answered: "7" }]);
    const counted = await answered();
    expect(counted.headers.get("cache-control")).toBe("no-store");
    const polls = ((await counted.json()) as { polls: { id: string }[] }).polls;
    expect(polls.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [
        { id, tiers: [{ tier: 0, answered: "38" }] },
        { id: second, tiers: [{ tier: 0, answered: "0" }] },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    // A poll the API doesn't know is left out, never shown at 0.
    answeredUnknown.add(secondHex);
    expect(await (await answered()).json()).toEqual({
      polls: [{ id, tiers: [{ tier: 0, answered: "38" }] }],
    });
    expect(answeredAsked).toHaveLength(3);
    // Another account's polls are none of this one's.
    const other = new Browser();
    await register(other, new SoftAuthenticator(RP_ID), true);
    expect(await (await other.call("POST", "/drafts/answered", {})).json()).toEqual({ polls: [] });
    expect(answeredAsked).toHaveLength(3);
    // The route takes nothing: not even a poll to choose.
    expect((await author.call("POST", "/drafts/answered", { id: drafted })).status).toBe(400);
    expect((await new Browser().call("POST", "/drafts/answered", {})).status).toBe(401);
    expect(answeredAsked).toHaveLength(3);
    expect(logged.at(-1)).toMatchObject({ route: "drafts" });
  });

  test("needs a session, our origin and JSON, and serves only its routes", async () => {
    const signedOut = new Browser();
    expect((await signedOut.call("GET", "/drafts")).status).toBe(401);
    expect((await signedOut.call("POST", "/drafts/create", { draft })).status).toBe(401);

    const author = new Browser();
    await register(author, new SoftAuthenticator(RP_ID), true);
    const cookie = [...author.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/drafts/create`, {
        method: "POST",
        headers: { cookie, ...headers },
        body: JSON.stringify({ draft }),
      });
    expect(
      (await post({ origin: "https://elsewhere.test", "content-type": "application/json" })).status,
    ).toBe(403);
    expect((await post({ "content-type": "application/json" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
    expect((await author.call("GET", "/drafts?x=1")).status).toBe(404);
    expect((await author.call("POST", "/drafts", {})).status).toBe(404);
    expect((await author.call("GET", "/drafts/read")).status).toBe(404);
    expect(await (await author.call("GET", "/drafts")).json()).toEqual({ polls: [] });
    expect(started).toHaveLength(0);
  });
});

describe("a creator's appeals under /drafts", () => {
  const cookieOf = (b: Browser) => [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  /**
   * A signed-in creator with a poll set up as the worker leaves it: a stored
   * definition and the creator record naming its election.
   */
  async function setUpPoll() {
    const creator = new Browser();
    await register(creator, new SoftAuthenticator(RP_ID), true);
    const account = (await accounts.accountOf(new Headers({ cookie: cookieOf(creator) })))!;
    const electionId = await newElection(sql);
    const id = newAccountId();
    await sql`
      INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
        creator_address, create_tx_hash, election_id, created_block, l1_origin_timestamp,
        anchors_checked_block, electorate, stub_hash, ceremony_tx_hash, register_tx_hash,
        registered_block)
      VALUES (${id}, ${account}, 'open', '{}', now(), now(), now(), ${randomBytes(20)},
        ${randomBytes(32)}, ${electionId}, 1, 1, 1, '[]', ${randomBytes(32)}, ${randomBytes(32)},
        ${randomBytes(32)}, 2)`;
    return { creator, id, electionId };
  }

  let handles: string[];
  beforeAll(async () => {
    const prefix = newAccountId().slice(0, 8);
    handles = [`${prefix}-a`, `${prefix}-b`];
    await addModerators(sql, ...handles);
  });

  test("a creator sees a removal, appeals it once and sees the outcome, without a moderator", async () => {
    const { creator, id, electionId } = await setUpPoll();
    const view = async () => {
      const res = await creator.call("POST", "/drafts/moderation", { id });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.json();
    };
    expect(await view()).toEqual({ state: "visible", appealable: false, appeals: [] });
    expect(await (await creator.call("POST", "/drafts/appeal", { id })).json()).toEqual({
      code: "NOT_APPEALABLE",
      status: 409,
    });
    // A draft has no election yet, so nothing has decided about it.
    const draft = newAccountId();
    await sql`
      INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at)
      VALUES (${draft}, ${(await accounts.accountOf(new Headers({ cookie: cookieOf(creator) })))!},
        'drafted', '{}', now(), now())`;
    expect(await (await creator.call("POST", "/drafts/moderation", { id: draft })).json()).toEqual({
      state: "visible",
      appealable: false,
      appeals: [],
    });
    expect((await creator.call("POST", "/drafts/appeal", { id: draft })).status).toBe(409);

    const { seq } = await moderate(sql, electionId, {
      action: "delist",
      reason: "spam",
      moderator: handles[0]!,
    });
    const latest = {
      seq: `${seq}`,
      action: "delist",
      reason: "spam",
      decidedAt: expect.any(String),
    };
    expect(await view()).toEqual({ state: "delisted", latest, appealable: true, appeals: [] });

    const filed = await creator.call("POST", "/drafts/appeal", { id });
    expect(filed.status).toBe(201);
    expect(await filed.json()).toEqual({ decisionSeq: `${seq}` });
    expect((await creator.call("POST", "/drafts/appeal", { id })).status).toBe(409);
    const pending = await view();
    expect(pending).toEqual({
      state: "delisted",
      latest,
      appealable: false,
      appeals: [{ decisionSeq: `${seq}`, filedAt: expect.any(String) }],
    });
    expect(JSON.stringify(pending)).not.toContain(handles[0]);

    const { restoreSeq } = await decideAppeal(sql, seq, "upheld", handles[1]!);
    const decided = await view();
    expect(decided).toEqual({
      state: "visible",
      latest: {
        seq: `${restoreSeq}`,
        action: "restore",
        reason: "appeal-upheld",
        decidedAt: expect.any(String),
      },
      appealable: false,
      appeals: [
        {
          decisionSeq: `${seq}`,
          filedAt: expect.any(String),
          outcome: "upheld",
          reviewedAt: expect.any(String),
        },
      ],
    });
    expect(JSON.stringify(decided)).not.toMatch(new RegExp(handles.join("|")));
  });

  test("only the creator sees or appeals a poll, and malformed or cross-site calls are refused", async () => {
    const { creator, id, electionId } = await setUpPoll();
    const { seq } = await moderate(sql, electionId, {
      action: "hide",
      reason: "threat",
      moderator: handles[0]!,
    });
    const other = new Browser();
    await register(other, new SoftAuthenticator(RP_ID), true);
    for (const path of ["/drafts/moderation", "/drafts/appeal"]) {
      expect(await (await other.call("POST", path, { id })).json()).toEqual({
        code: "NOT_FOUND",
        status: 404,
      });
      expect((await creator.call("POST", path, { id: newAccountId() })).status).toBe(404);
      expect((await new Browser().call("POST", path, { id })).status).toBe(401);
      for (const bad of [{}, { id: id.toUpperCase() }, { id, extra: 1 }, { id: 1 }])
        expect((await creator.call("POST", path, bad)).status).toBe(400);
      expect((await creator.call("GET", path)).status).toBe(404);
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          origin: "https://elsewhere.test",
          cookie: [...creator.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          "content-type": "application/json",
        },
        body: JSON.stringify({ id }),
      });
      expect(res.status).toBe(403);
    }
    // None of those filed anything.
    expect(await (await creator.call("POST", "/drafts/moderation", { id })).json()).toMatchObject({
      state: "hidden",
      appealable: true,
      appeals: [],
    });
    expect(await (await creator.call("POST", "/drafts/appeal", { id })).json()).toEqual({
      decisionSeq: `${seq}`,
    });
    expect(logged.at(-1)).toMatchObject({ route: "drafts" });
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

  test("hands Start the profiles' reader with every page and server function, and nothing else", async () => {
    started.length = 0;
    contexts.length = 0;
    await raw("/by/k7qa2mzr5xw3bn4d", { headers: { cookie: "session=secret" } });
    await raw("/_serverFn/abc", { method: "POST" });
    expect(started).toHaveLength(2);
    // The same reader for everyone, by handle only: no session reaches a page (T-10).
    expect(contexts).toEqual([{ readProfile: READ_PROFILE }, { readProfile: READ_PROFILE }]);
    expect(started.map((r) => r.headers.get("cookie"))).toEqual([null, null]);
  });

  test("hands a page the footer's language and no other cookie (P2-28 part 4a; T-10)", async () => {
    started.length = 0;
    await raw("/how-it-works", { headers: { cookie: "session=secret; lang=es-US; other=1" } });
    await raw("/_serverFn/abc", { method: "POST", headers: { cookie: "lang=en-US; session=s" } });
    // A cookie that names none of ours, or names one twice, is no choice: none is passed.
    for (const cookie of ["session=secret; lang=fr-FR", "lang=es-US; lang=en-US", "session=x"])
      await raw("/polls", { headers: { cookie } });
    expect(started.map((r) => r.headers.get("cookie"))).toEqual([
      "lang=es-US",
      "lang=en-US",
      null,
      null,
      null,
    ]);
  });

  test("serves the manifest and its icons from the fixed list, and nothing beside them", async () => {
    started.length = 0;
    const manifest = await raw("/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.body).toBe(MANIFEST);
    expect(manifest.headers["content-type"]).toBe("application/manifest+json");
    expect(manifest.headers["cache-control"]).toBe("public, max-age=86400");
    expect(manifest.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
    expect(manifest.headers["x-content-type-options"]).toBe("nosniff");
    expect(manifest.headers["cross-origin-resource-policy"]).toBe("same-origin");
    const icon = await raw("/icons/icon-192.png", { method: "HEAD" });
    expect([icon.status, icon.headers["content-type"], icon.body]).toEqual([200, "image/png", ""]);
    expect(icon.headers["content-length"]).toBe("3");
    // Listed but not built: a 404, never Start's page.
    expect((await raw("/icons/icon-512.png")).status).toBe(404);
    expect((await raw("/manifest.webmanifest?v=1")).status).toBe(404);
    expect(started).toHaveLength(0);
    // Any other name under /icons is a page path, which Start answers, never a file.
    expect((await raw("/icons/other.png")).body).not.toContain("not served");
    expect((await raw("/icons/../secret.txt")).body).not.toContain("not an asset");
    expect((await raw("/manifest.webmanifest", { method: "POST" })).body).not.toBe(MANIFEST);
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
    await raw("/drafts");
    await raw("/_serverFn/abc", { method: "POST", body: Buffer.from("{}") });
    await raw("/\\evil.test/x");
    // Lines are written on "finish", after the client has its answer.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logged.map((l) => ("route" in l ? l.route : l.error))).toEqual([
      "page",
      "asset",
      "auth",
      "drafts",
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

  test("the offline shell's page and worker reach Start without the cookie, logged as the shell's (P2-28 part 1b)", async () => {
    started.length = 0;
    logged.length = 0;
    await raw("/offline", { headers: { cookie: `${SESSION}=tok` } });
    await raw("/sw.js", { method: "HEAD", headers: { cookie: `${SESSION}=tok` } });
    expect(started.map((r) => [new URL(r.url).pathname, r.headers.get("cookie")])).toEqual([
      ["/offline", null],
      ["/sw.js", null],
    ]);
    expect(logged.map((l) => ("route" in l ? l.route : l.error))).toEqual(["offline", "offline"]);
    // Anything else is a page as before.
    await raw("/offline/x");
    await raw("/sw.js", { method: "POST", body: Buffer.from("{}") });
    expect(logged.slice(2).map((l) => ("route" in l ? l.route : l.error))).toEqual([
      "page",
      "page",
    ]);
  });

  test("the reaction counts, a profile's report and the push key never get the account cookie; the rest do", async () => {
    const seen: [string, string | null][] = [];
    const record = async (request: Request) => {
      seen.push([new URL(request.url).pathname, request.headers.get("cookie")]);
      return Response.json({});
    };
    const front = createWebServer({
      start: { fetch: async () => new Response() },
      accounts: async () => new Response(),
      drafts: async () => new Response(),
      email: async () => new Response(),
      phone: async () => new Response(),
      token: async () => new Response(),
      reactions: record,
      follows: record,
      profiles: record,
      accountExport: record,
      push: record,
      clientDir,
      origin: ORIGIN,
      log: () => {},
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = front.address() as AddressInfo;
      for (const path of [
        "/reactions/counts",
        "/reactions/own",
        "/reactions/set",
        "/follows/set",
        "/follows/results",
        "/follows/results/drop",
        "/follows/notices",
        "/follows/notices/set",
        "/profiles/report",
        "/profiles/moderation",
        "/profiles/appeal",
        "/profiles/own",
        "/profiles/make",
        "/profiles/rename",
        "/profiles/delete",
        "/profiles/show",
        "/export",
        "/push/key",
        "/push/status",
        "/push/subscribe",
        "/push/unsubscribe",
      ])
        await fetch(`http://127.0.0.1:${port}${path}`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            cookie: `${SESSION}=tok`,
          },
          body: "{}",
        });
      expect(seen).toEqual([
        ["/reactions/counts", null],
        ["/reactions/own", `${SESSION}=tok`],
        ["/reactions/set", `${SESSION}=tok`],
        ["/follows/set", `${SESSION}=tok`],
        ["/follows/results", `${SESSION}=tok`],
        ["/follows/results/drop", `${SESSION}=tok`],
        ["/follows/notices", `${SESSION}=tok`],
        ["/follows/notices/set", `${SESSION}=tok`],
        ["/profiles/report", null],
        ["/profiles/moderation", `${SESSION}=tok`],
        ["/profiles/appeal", `${SESSION}=tok`],
        ["/profiles/own", `${SESSION}=tok`],
        ["/profiles/make", `${SESSION}=tok`],
        ["/profiles/rename", `${SESSION}=tok`],
        ["/profiles/delete", `${SESSION}=tok`],
        ["/profiles/show", `${SESSION}=tok`],
        ["/export", `${SESSION}=tok`],
        ["/push/key", null],
        ["/push/status", `${SESSION}=tok`],
        ["/push/subscribe", `${SESSION}=tok`],
        ["/push/unsubscribe", `${SESSION}=tok`],
      ]);
    } finally {
      await new Promise((resolve) => front.close(resolve));
    }
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
    await raw("/moderation?before=7");
    await raw("/P/3J55DW1");
    await raw("/p/3j55dw1/flyer?paper=a4&ink=mono");
    await raw("/embed/p/3j55dw1?theme=dark");
    await raw("/somewhere/else");
    await raw("/broken");
    // Not page views: assets (the install's files too), accounts, server
    // functions, refusals, HEAD.
    await raw("/assets/index-AbC_12-x.js");
    await raw("/manifest.webmanifest");
    await raw("/icons/icon-192.png");
    // The offline shell's worker fetches these as it installs (P2-28 part 1b).
    await raw("/offline");
    await raw("/sw.js");
    await raw("/auth/get-session");
    await raw("/_serverFn/abc", { method: "POST", body: Buffer.from("{}") });
    await raw("//evil.test/");
    await raw("/polls", { method: "HEAD" });
    await settle();
    expect(reported).toEqual([
      { kind: "pageview", page: "/polls/:id", status: 200 },
      { kind: "pageview", page: "/moderation", status: 200 },
      { kind: "pageview", page: "/p/:code", status: 200 },
      { kind: "pageview", page: "/p/:code/flyer", status: 200 },
      { kind: "pageview", page: "/embed/p/:code", status: 200 },
      { kind: "pageview", page: "other", status: 200 },
      { kind: "exception", source: "server", error: { page: "other", name: "Error", frames: [] } },
      { kind: "pageview", page: "other", status: 500 },
    ]);
    expect(JSON.stringify(reported)).not.toContain(id);
    expect(JSON.stringify(reported).toLowerCase()).not.toContain("3j55dw1");
    expect(JSON.stringify(reported)).not.toContain("mono");
    expect(JSON.stringify(reported)).not.toContain("dark");
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

describe("an account's e-mail address under /email", () => {
  /** A signed-in browser that has just asked for a code to `address`. */
  async function asked(address: string) {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const res = await browser.call(
      "POST",
      "/email/request",
      { address },
      { [TURNSTILE_HEADER]: "solved" },
    );
    return { browser, res };
  }

  test("an account asks for a code, enters it, and reads its verified address", async () => {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    expect(await (await browser.call("GET", "/email")).json()).toEqual({});
    const before = emailChecks.length;
    const res = await browser.call(
      "POST",
      "/email/request",
      { address: " Ana@Example.org " },
      { [TURNSTILE_HEADER]: "solved" },
    );
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({});
    expect(emailChecks.slice(before)).toEqual([["solved", "email-code"]]);
    const message = mailed.at(-1);
    expect(message).toMatchObject({ kind: "email-code", to: "Ana@Example.org" });
    const code = (message as { code: string }).code;

    const wrong = code === "00000000" ? "11111111" : "00000000";
    const refused = await browser.call("POST", "/email/verify", { code: wrong });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ code: "WRONG_CODE", status: 422, triesLeft: 4 });
    expect(
      (
        await browser.call("POST", "/email/verify", {
          code: `${code.slice(0, 4)} ${code.slice(4)}`,
        })
      ).status,
    ).toBe(200);
    expect(await (await browser.call("GET", "/email")).json()).toEqual({
      address: "Ana@Example.org",
      verifiedAt: NOW.toISOString(),
    });
    const spent = await browser.call("POST", "/email/verify", { code });
    expect(await spent.json()).toEqual({ code: "NO_CODE", status: 409 });

    // T-11, T-67: the log has the route class, never the address or the code.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "email", status: 409 });
    const log = JSON.stringify(logged).toLowerCase();
    expect(log).not.toContain("example.org");
    expect(log).not.toContain(code);
  });

  test("writes in the request's language, and keeps the verifying one for notices", async () => {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const account = await accounts.accountOf(
      new Headers({ cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ") }),
    );
    const localeOf = async () =>
      (await sql`SELECT locale FROM account_emails WHERE user_id = ${account!}`)[0]?.["locale"];
    // A Spanish browser with no choice made: Accept-Language.
    await browser.call(
      "POST",
      "/email/request",
      { address: "lucia@example.org" },
      { [TURNSTILE_HEADER]: "solved", "accept-language": "es-MX,es;q=0.9,en;q=0.5" },
    );
    expect(mailed.at(-1)).toMatchObject({ kind: "email-code", locale: "es-US" });
    const { code } = mailed.at(-1) as { code: string };
    // The footer's choice wins over the browser's languages.
    browser.cookies.set("lang", "es-US");
    expect(
      (await browser.call("POST", "/email/verify", { code }, { "accept-language": "en-US" }))
        .status,
    ).toBe(200);
    expect(await localeOf()).toBe("es-US");
    // Anything unparsed or not ours reads English.
    browser.cookies.delete("lang");
    await browser.call(
      "POST",
      "/email/request",
      { address: "lucia2@example.org" },
      { [TURNSTILE_HEADER]: "solved", "accept-language": "fr-FR, *" },
    );
    expect(mailed.at(-1)).toMatchObject({ kind: "email-code", locale: "en-US" });
    const again = (mailed.at(-1) as { code: string }).code;
    expect((await browser.call("POST", "/email/verify", { code: again })).status).toBe(200);
    expect(await localeOf()).toBe("en-US");
  });

  test("a request for another account's address is answered as any other (T-11)", async () => {
    const first = await asked("held@example.org");
    const code = (mailed.at(-1) as { code: string }).code;
    expect((await first.browser.call("POST", "/email/verify", { code })).status).toBe(200);

    const second = await asked("HELD@example.org");
    expect(second.res.status).toBe(first.res.status);
    expect(await second.res.json()).toEqual({});
    expect(mailed.at(-1)).toEqual({ kind: "email-held", to: "HELD@example.org", locale: "en-US" });
    // No code was sent, and any answer is just a wrong one.
    expect(await (await second.browser.call("POST", "/email/verify", { code })).json()).toEqual({
      code: "WRONG_CODE",
      status: 422,
      triesLeft: 4,
    });
  });

  test("a send the provider didn't take is answered as a sent one, and logged by kind", async () => {
    provider.send = "unavailable";
    try {
      const { res } = await asked("outage@example.org");
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({});
    } finally {
      provider.send = "sent";
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(logged.filter((l) => "error" in l)).toContainEqual({ error: "EmailSendUnavailable" });
  });

  test("answers before the provider does, so a capped address can't be told apart by time (T-11)", async () => {
    provider.send = "hang";
    try {
      // A provider that never answers: the request is answered anyway.
      const { res } = await asked("slow@example.org");
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({});
    } finally {
      provider.send = "sent";
    }
  });

  test("a capped address is answered as any other, and sent nothing (T-11, T-52)", async () => {
    const asker = new Browser();
    await register(asker, new SoftAuthenticator(RP_ID), true);
    for (let i = 0; i < 5; i++)
      expect(
        (
          await asker.call(
            "POST",
            "/email/request",
            { address: "capped@example.org" },
            { [TURNSTILE_HEADER]: "solved" },
          )
        ).status,
      ).toBe(202);
    const before = mailed.length;
    const { res } = await asked("capped@example.org");
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({});
    expect(mailed.length).toBe(before);
  });

  test("refuses what core refuses, with its code", async () => {
    const invalid = await asked("not an address");
    expect(await invalid.res.json()).toEqual({ code: "INVALID_ADDRESS", status: 422 });
    provider.verdict = "refused";
    try {
      const refused = await asked("refused@example.org");
      expect(await refused.res.json()).toEqual({ code: "TURNSTILE_REFUSED", status: 403 });
    } finally {
      provider.verdict = "passed";
    }
    const { browser } = await asked("limits@example.org");
    expect(await (await browser.call("POST", "/email/verify", { code: "1" })).json()).toMatchObject(
      {
        code: "WRONG_CODE",
      },
    );
    for (let i = 0; i < 4; i++)
      await browser.call(
        "POST",
        "/email/request",
        { address: `limits${i}@example.net` },
        { [TURNSTILE_HEADER]: "solved" },
      );
    const limited = await browser.call(
      "POST",
      "/email/request",
      { address: "limits@example.org" },
      { [TURNSTILE_HEADER]: "solved" },
    );
    expect(await limited.json()).toEqual({ code: "TOO_MANY_THIS_HOUR", status: 429 });
  });

  test("needs a session, our origin and JSON, and serves only its routes", async () => {
    const pages = started.length;
    const signedOut = new Browser();
    expect((await signedOut.call("GET", "/email")).status).toBe(401);
    expect(
      (await signedOut.call("POST", "/email/request", { address: "a@example.org" })).status,
    ).toBe(401);

    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/email/verify`, {
        method: "POST",
        headers: { cookie, ...headers },
        body: JSON.stringify({ code: "12345678" }),
      });
    expect(
      (await post({ origin: "https://elsewhere.test", "content-type": "application/json" })).status,
    ).toBe(403);
    expect((await post({ "content-type": "application/json" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
    expect((await browser.call("GET", "/email?x=1")).status).toBe(404);
    expect((await browser.call("POST", "/email", {})).status).toBe(404);
    expect((await browser.call("GET", "/email/request")).status).toBe(404);
    expect((await browser.call("POST", "/email/verify", { code: "1", extra: 1 })).status).toBe(400);
    expect(
      (await browser.call("POST", "/email/request", { address: "a".repeat(1025) })).status,
    ).toBe(400);
    expect(started).toHaveLength(pages);
  });

  test("answers 503 on every route where the deployment has no e-mail service", async () => {
    const handler = createEmailHandler({
      sql,
      accountOf: async () => newAccountId(),
      service: undefined,
      turnstile: { verify: async () => "passed" },
      origin: ORIGIN,
      log: () => {},
    });
    const headers = { origin: ORIGIN, "content-type": "application/json" };
    for (const [method, path, body] of [
      ["GET", "/email", undefined],
      ["POST", "/email/request", '{"address":"a@example.org"}'],
      ["POST", "/email/verify", '{"code":"12345678"}'],
    ] as const) {
      const res = await handler(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
      expect(await res.json()).toEqual({ code: "EMAIL_UNAVAILABLE", status: 503 });
    }
  });
});

describe("an account's phone number under /phone", () => {
  let numbers = 0;
  /** A North American number no other test uses. */
  const fresh = () => `+1415${4_000_000 + ++numbers}`;

  /** A signed-in browser. */
  async function signedIn() {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    return browser;
  }

  const ask = (browser: Browser, number: string) =>
    browser.call("POST", "/phone/request", { number }, { [TURNSTILE_HEADER]: "solved" });

  test("an account asks for a code, enters it with the number, and reads the day it verified", async () => {
    const browser = await signedIn();
    const number = fresh();
    expect(await (await browser.call("GET", "/phone")).json()).toEqual({});
    const before = phoneChecks.length;
    // As typed: separators, no country code.
    const typed = `(${number.slice(2, 5)}) ${number.slice(5, 8)}-${number.slice(8)}`;
    const res = await ask(browser, typed);
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({});
    expect(phoneChecks.slice(before)).toEqual([["solved", "phone-code"]]);
    expect(phones.started.at(-1)).toEqual([number, "sms"]);

    const refused = await browser.call("POST", "/phone/verify", { number: typed, code: "135791" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ code: "WRONG_CODE", status: 422, triesLeft: 4 });
    const verified = await browser.call("POST", "/phone/verify", {
      number: typed,
      code: `${PHONE_CODE.slice(0, 3)} ${PHONE_CODE.slice(3)}`,
    });
    expect(verified.status).toBe(200);
    expect(phones.checked.at(-1)).toEqual([number, PHONE_CODE]);
    // The day only: the number is gone.
    expect(await (await browser.call("GET", "/phone")).json()).toEqual({
      verifiedOn: NOW.toISOString().slice(0, 10),
    });
    const spent = await browser.call("POST", "/phone/verify", { number, code: PHONE_CODE });
    expect(await spent.json()).toEqual({ code: "NO_CODE", status: 409 });

    // T-11, T-67, T-73: the log has the route class, never the number or the code.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "phone", status: 409 });
    const log = JSON.stringify(logged);
    expect(log).not.toContain(number.slice(2));
    expect(log).not.toContain(PHONE_CODE);
  });

  test("a landline or fixed VoIP line is called, not texted", async () => {
    const browser = await signedIn();
    for (const lineType of ["landline", "fixedVoip"]) {
      const number = fresh();
      phones.lines.set(number, { country: "US", lineType });
      expect((await ask(browser, number)).status).toBe(202);
      expect(phones.started.at(-1)).toEqual([number, "call"]);
    }
  });

  test("a number another account holds is asked for as any other, and refused only with its code (T-11)", async () => {
    const number = fresh();
    const first = await signedIn();
    expect((await ask(first, number)).status).toBe(202);
    expect((await first.call("POST", "/phone/verify", { number, code: PHONE_CODE })).status).toBe(
      200,
    );

    const second = await signedIn();
    const res = await ask(second, number);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({});
    const held = await second.call("POST", "/phone/verify", { number, code: PHONE_CODE });
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ code: "NUMBER_HELD", status: 409 });
    expect(await (await second.call("GET", "/phone")).json()).toEqual({});
  });

  test.each(["unavailable", "throw"] as const)(
    "a send the provider didn't take (%s) is answered as a sent one, and logged by kind",
    async (outcome) => {
      const errors = logged.filter((l) => "error" in l).length;
      phones.start = outcome;
      const number = fresh();
      try {
        const res = await ask(await signedIn(), number);
        expect(res.status).toBe(202);
        expect(await res.json()).toEqual({});
      } finally {
        phones.start = "sent";
      }
      await new Promise((r) => setTimeout(r, 20));
      expect(logged.filter((l) => "error" in l).slice(errors)).toEqual([
        { error: "PhoneSendUnavailable" },
      ]);
      expect(JSON.stringify(logged)).not.toContain(number.slice(2));
    },
  );

  test("answers before the provider's send does, so a capped number can't be told apart by time (T-11)", async () => {
    phones.start = "hang";
    try {
      const res = await ask(await signedIn(), fresh());
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({});
    } finally {
      phones.start = "sent";
    }
  });

  test("a capped number is answered as any other, and sent nothing (T-11, T-52)", async () => {
    const number = fresh();
    // Five accounts, one request each, so no account's own limit is reached.
    for (let i = 0; i < 5; i++) expect((await ask(await signedIn(), number)).status).toBe(202);
    const before = phones.started.length;
    const res = await ask(await signedIn(), number);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({});
    expect(phones.started.length).toBe(before);
  });

  test("refuses what core refuses, with its code", async () => {
    const browser = await signedIn();
    const refusal = async (number: string) => (await ask(browser, number)).json();
    expect(await refusal("12345")).toEqual({ code: "INVALID_NUMBER", status: 422 });
    const lines = [
      [{ country: "GB", lineType: "mobile" }, "UNSUPPORTED_COUNTRY", 422],
      [{ country: "US", lineType: "nonFixedVoip" }, "VIRTUAL_NUMBER", 422],
      ["invalid", "INVALID_NUMBER", 422],
      ["unavailable", "LOOKUP_UNAVAILABLE", 503],
    ] as const;
    for (const [line, code, status] of lines) {
      const number = fresh();
      phones.lines.set(number, line);
      expect(await refusal(number)).toEqual({ code, status });
    }
    // Those four and one more spend the account's five an hour; the malformed one cost none.
    expect((await ask(browser, fresh())).status).toBe(202);
    expect(await refusal(fresh())).toEqual({ code: "TOO_MANY_THIS_HOUR", status: 429 });

    phones.verdict = "refused";
    try {
      expect(await (await ask(await signedIn(), fresh())).json()).toEqual({
        code: "TURNSTILE_REFUSED",
        status: 403,
      });
    } finally {
      phones.verdict = "passed";
    }
  });

  test("a check the provider doesn't answer spends no try, and says so", async () => {
    const browser = await signedIn();
    const number = fresh();
    await ask(browser, number);
    phones.check = "unavailable";
    try {
      const res = await browser.call("POST", "/phone/verify", { number, code: PHONE_CODE });
      expect(await res.json()).toEqual({ code: "CHECK_UNAVAILABLE", status: 503 });
    } finally {
      phones.check = undefined;
    }
    const wrong = await browser.call("POST", "/phone/verify", { number, code: "135791" });
    expect(await wrong.json()).toEqual({ code: "WRONG_CODE", status: 422, triesLeft: 4 });
  });

  test("needs a session, our origin and JSON, and serves only its routes", async () => {
    const pages = started.length;
    const signedOut = new Browser();
    expect((await signedOut.call("GET", "/phone")).status).toBe(401);
    expect((await signedOut.call("POST", "/phone/request", { number: fresh() })).status).toBe(401);

    const browser = await signedIn();
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/phone/verify`, {
        method: "POST",
        headers: { cookie, ...headers },
        body: JSON.stringify({ number: fresh(), code: PHONE_CODE }),
      });
    expect(
      (await post({ origin: "https://elsewhere.test", "content-type": "application/json" })).status,
    ).toBe(403);
    expect((await post({ "content-type": "application/json" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
    expect((await browser.call("GET", "/phone?x=1")).status).toBe(404);
    expect((await browser.call("POST", "/phone", {})).status).toBe(404);
    expect((await browser.call("GET", "/phone/request")).status).toBe(404);
    expect((await browser.call("POST", "/phone/verify", { code: PHONE_CODE })).status).toBe(400);
    expect(
      (await browser.call("POST", "/phone/verify", { number: fresh(), code: "1", extra: 1 }))
        .status,
    ).toBe(400);
    expect((await browser.call("POST", "/phone/request", { number: "1".repeat(257) })).status).toBe(
      400,
    );
    expect(started).toHaveLength(pages);
  });

  test("answers 503 on every route where the deployment has no phone service", async () => {
    const handler = createPhoneHandler({
      sql,
      accountOf: async () => newAccountId(),
      service: undefined,
      turnstile: { verify: async () => "passed" },
      origin: ORIGIN,
      log: () => {},
    });
    const headers = { origin: ORIGIN, "content-type": "application/json" };
    for (const [method, path, body] of [
      ["GET", "/phone", undefined],
      ["POST", "/phone/request", '{"number":"+14155552671"}'],
      ["POST", "/phone/verify", '{"number":"+14155552671","code":"123456"}'],
    ] as const) {
      const res = await handler(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        }),
      );
      expect(await res.json()).toEqual({ code: "PHONE_UNAVAILABLE", status: 503 });
    }
  });
});

describe("an account's Tier 0 token under /token", () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const KEY_ID = tier0TokenKeyId(PERIOD, ISSUER_KEY.publicKey);
  const INFO = tier0TokenInfo(DEPLOYMENT);

  /** A signed-in browser and its account, verified by e-mail and phone unless told otherwise. */
  async function signedIn({ verified = true } = {}) {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const account = (await accounts.accountOf(new Headers({ cookie })))!;
    if (verified) {
      await sql`
        INSERT INTO account_emails VALUES (${account}, ${randomBytes(32)}, 'h1', ${randomBytes(40)}, 'b1', now())`;
      await sql`
        INSERT INTO account_phones VALUES (${account}, ${randomBytes(32)}, 'p1',
          date_trunc('day', now(), 'UTC'))`;
    }
    return { browser, account };
  }

  /** The ballot client's side of Issuance, step 1, for a fresh commitment. */
  function blind() {
    const c = Uint8Array.from(randomBytes(32));
    c[0] = c[0]! & 0x0f;
    const input = tier0TokenInput(KEY_ID, c);
    const b = tier0TokenBlind(input, ISSUER_KEY.publicKey, INFO);
    return {
      input,
      ...b,
      body: { keyId: hex(KEY_ID), region: 0, blindedElement: hex(b.blindedElement) },
    };
  }

  test("a verified account takes its token, retries it, and takes no second one", async () => {
    const { browser } = await signedIn();
    const c = blind();
    const res = await browser.call("POST", "/token", c.body);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const answer = (await res.json()) as { evaluationElement: string; proof: string };
    expect(Object.keys(answer).sort()).toEqual(["evaluationElement", "proof"]);
    const token = tier0TokenFinalize({
      input: c.input,
      info: INFO,
      publicKey: ISSUER_KEY.publicKey,
      blind: c.blind,
      blindedElement: c.blindedElement,
      evaluationElement: Buffer.from(answer.evaluationElement, "hex"),
      proof: Buffer.from(answer.proof, "hex"),
    });
    expect(hex(token)).toBe(hex(tier0TokenEvaluate(ISSUER_KEY.secretKey, c.input, INFO)));

    // A lost answer is retried with the same B; any other B is a second token.
    const again = await browser.call("POST", "/token", c.body);
    expect(((await again.json()) as typeof answer).evaluationElement).toBe(
      answer.evaluationElement,
    );
    const second = await browser.call("POST", "/token", blind().body);
    expect(await second.json()).toEqual({ code: "TOKEN_TAKEN", status: 409 });

    // T-10, T-11, T-67: the log has the route class, never B, the key or the answer.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "token", status: 409 });
    const log = JSON.stringify(logged);
    for (const value of [c.body.blindedElement, c.body.keyId, answer.evaluationElement])
      expect(log).not.toContain(value);
  });

  test("refuses what core refuses, with its code", async () => {
    const { browser } = await signedIn();
    const refusal = async (body: object) => (await browser.call("POST", "/token", body)).json();
    const { body } = blind();
    expect(await refusal({ ...body, keyId: "00".repeat(32) })).toEqual({
      code: "KEY_NOT_ISSUING",
      status: 409,
    });
    expect(await refusal({ ...body, region: 1 })).toEqual({ code: "REGION_UNKNOWN", status: 422 });
    expect(await refusal({ ...body, blindedElement: "00".repeat(32) })).toEqual({
      code: "BLINDED_ELEMENT",
      status: 422,
    });
    const unverified = await signedIn({ verified: false });
    expect(await (await unverified.browser.call("POST", "/token", body)).json()).toEqual({
      code: "ACCOUNT_UNVERIFIED",
      status: 403,
    });
  });

  test("refuses a malformed request before core sees it", async () => {
    const { browser } = await signedIn();
    const { body } = blind();
    for (const bad of [
      { ...body, keyId: body.keyId.toUpperCase() },
      { ...body, keyId: body.keyId.slice(2) },
      { ...body, blindedElement: `${body.blindedElement}00` },
      { ...body, region: -1 },
      { ...body, region: 0.5 },
      { ...body, region: "0" },
      { ...body, extra: 1 },
      { keyId: body.keyId, region: 0 },
    ])
      expect(await (await browser.call("POST", "/token", bad)).json()).toEqual({
        code: "BAD_REQUEST",
        status: 400,
      });
    // Nothing was recorded, so the account can still take its token.
    expect((await browser.call("POST", "/token", body)).status).toBe(200);
  });

  test("refuses a request signed out, from another origin, or of another type or path", async () => {
    const { body } = blind();
    const signedOut = await new Browser().call("POST", "/token", body);
    expect(await signedOut.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
    const { browser } = await signedIn();
    const elsewhere = await browser.call("POST", "/token", body, { origin: "https://evil.test" });
    expect(await elsewhere.json()).toEqual({ code: "FORBIDDEN_ORIGIN", status: 403 });
    const text = await fetch(`${base}/token`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "text/plain",
        cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: JSON.stringify(body),
    });
    expect(await text.json()).toEqual({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
    expect((await browser.call("GET", "/token")).status).toBe(404);
    expect((await browser.call("POST", "/token/x", body)).status).toBe(404);
    expect((await browser.call("POST", "/token?x=1", body)).status).toBe(404);
  });

  test("answers 503 where the deployment has no issuer", async () => {
    const handler = createTokenHandler({
      sql,
      accountOf: async () => newAccountId(),
      issuer: undefined,
      origin: ORIGIN,
    });
    const res = await handler(
      new Request(`${ORIGIN}/token`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(blind().body),
      }),
    );
    expect(await res.json()).toEqual({ code: "TOKEN_UNAVAILABLE", status: 503 });
  });

  test("leaves a database error to the front's generic 500, logged by kind only", async () => {
    // A database that refuses every query: here, none of the tables.
    const broken = postgres(process.env["TEST_DATABASE_URL"] ?? "", {
      max: 1,
      onnotice: () => {},
      connection: { search_path: "no_such_schema" },
    });
    const lines: Parameters<Log>[0][] = [];
    const front = createWebServer({
      start: { fetch: async () => new Response() },
      accounts: async () => new Response(),
      drafts: async () => new Response(),
      email: async () => new Response(),
      phone: async () => new Response(),
      token: createTokenHandler({
        sql: broken,
        accountOf: async () => newAccountId(),
        issuer: ISSUER,
        origin: ORIGIN,
        now: () => NOW,
      }),
      reactions: async () => new Response(),
      follows: async () => new Response(),
      profiles: async () => new Response(),
      accountExport: async () => new Response(),
      push: async () => new Response(),
      clientDir,
      origin: ORIGIN,
      log: (line) => lines.push(line),
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    try {
      const { body } = blind();
      const res = await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/token`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("500\n");
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Drizzle's wrapper, by name only: its message quotes the query.
      expect(lines).toEqual([
        { error: "Error" },
        { method: "POST", route: "token", status: 500, ms: expect.any(Number) },
      ]);
    } finally {
      await new Promise((resolve) => front.close(resolve));
      await broken.end();
    }
  });
});

describe("reactions on a poll under /reactions", () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
  const ZERO = { heart: 0, laugh: 0, wow: 0, thinking: 0, sad: 0, clap: 0 };

  /** A signed-in browser, its account verified by e-mail unless told otherwise. */
  async function signedIn({ verified = true } = {}) {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const account = (await accounts.accountOf(new Headers({ cookie })))!;
    if (verified)
      await sql`
        INSERT INTO account_emails VALUES (${account}, ${randomBytes(32)}, 'h1', ${randomBytes(40)}, 'b1', now())`;
    return browser;
  }

  let moderator: string;
  beforeAll(async () => {
    moderator = `${newAccountId().slice(0, 8)}-r`;
    await addModerators(sql, moderator);
  });

  test("anyone reads the counts; an account sets, sees and takes back its own", async () => {
    const electionId = hex(await newElection(sql));
    const anyone = new Browser();
    const read = await anyone.call("POST", "/reactions/counts", { electionId });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual({ counts: ZERO });
    expect(await (await anyone.call("POST", "/reactions/own", { electionId })).json()).toEqual({
      code: "SIGNED_OUT",
      status: 401,
    });

    const a = await signedIn();
    const b = await signedIn();
    // The counts are the same signed in: no `own`.
    expect(await (await a.call("POST", "/reactions/counts", { electionId })).json()).toEqual({
      counts: ZERO,
    });
    expect(await (await a.call("POST", "/reactions/own", { electionId })).json()).toEqual({
      counts: ZERO,
      own: [],
    });
    const set = await a.call("POST", "/reactions/set", { electionId, reaction: "clap", on: true });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ counts: { ...ZERO, clap: 1 }, own: ["clap"] });
    await a.call("POST", "/reactions/set", { electionId, reaction: "heart", on: true });
    // Setting one already set changes nothing.
    expect(
      await (
        await b.call("POST", "/reactions/set", { electionId, reaction: "clap", on: true })
      ).json(),
    ).toEqual({ counts: { ...ZERO, heart: 1, clap: 2 }, own: ["clap"] });
    expect(
      await (
        await b.call("POST", "/reactions/set", { electionId, reaction: "clap", on: true })
      ).json(),
    ).toEqual({ counts: { ...ZERO, heart: 1, clap: 2 }, own: ["clap"] });
    // Each account sees only its own, in the set's order.
    expect(await (await a.call("POST", "/reactions/own", { electionId })).json()).toEqual({
      counts: { ...ZERO, heart: 1, clap: 2 },
      own: ["heart", "clap"],
    });
    expect(await (await anyone.call("POST", "/reactions/counts", { electionId })).json()).toEqual({
      counts: { ...ZERO, heart: 1, clap: 2 },
    });
    const back = await a.call("POST", "/reactions/set", {
      electionId,
      reaction: "clap",
      on: false,
    });
    expect(await back.json()).toEqual({ counts: { ...ZERO, heart: 1, clap: 1 }, own: ["heart"] });

    // T-10, T-11, T-67: the log has the route class, never the poll, the
    // reaction or the account.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "reactions", status: 200 });
    const log = JSON.stringify(logged);
    expect(log).not.toContain(electionId);
    expect(log).not.toContain("clap");
  });

  test("refuses what core refuses, with its code", async () => {
    const electionId = hex(await newElection(sql));
    const set = async (browser: Browser, body: object) =>
      (
        await browser.call("POST", "/reactions/set", {
          electionId,
          reaction: "wow",
          on: true,
          ...body,
        })
      ).json();
    const unverified = await signedIn({ verified: false });
    expect(await set(unverified, {})).toEqual({ code: "ACCOUNT_UNVERIFIED", status: 403 });
    // Taking one back is always allowed, and changes nothing here.
    expect(await set(unverified, { on: false })).toEqual({ counts: ZERO, own: [] });
    const browser = await signedIn();
    expect(await set(browser, { electionId: "00".repeat(32) })).toEqual({
      code: "UNKNOWN_ELECTION",
      status: 404,
    });
    // A poll with no stored definition counts zero throughout.
    expect(
      await (await browser.call("POST", "/reactions/own", { electionId: "00".repeat(32) })).json(),
    ).toEqual({ counts: ZERO, own: [] });

    await set(browser, {});
    await moderate(sql, fromHex(electionId), {
      action: "hide",
      reason: "illegal",
      moderator,
    });
    // A hidden poll takes no reaction and shows no counts (T-68)…
    expect(await set(browser, { reaction: "sad" })).toEqual({ code: "HIDDEN", status: 409 });
    expect(
      await (await new Browser().call("POST", "/reactions/counts", { electionId })).json(),
    ).toEqual({ code: "HIDDEN", status: 409 });
    expect(await (await browser.call("POST", "/reactions/own", { electionId })).json()).toEqual({
      code: "HIDDEN",
      status: 409,
    });
    // …but its reactions can still be taken back, though the answer names no counts.
    expect(await set(browser, { on: false })).toEqual({ code: "HIDDEN", status: 409 });
    expect(
      (
        await sql`SELECT count(*)::int AS n FROM account_reactions
        WHERE election_id = ${fromHex(electionId)}`
      )[0]!["n"],
    ).toBe(0);
  });

  test("refuses changes past the hour's limit", async () => {
    const electionId = hex(await newElection(sql));
    const browser = await signedIn();
    for (let i = 0; i < MAX_REACTION_CHANGES_PER_HOUR; i++)
      expect(
        (
          await browser.call("POST", "/reactions/set", {
            electionId,
            reaction: "laugh",
            on: i % 2 === 0,
          })
        ).status,
      ).toBe(200);
    expect(
      await (
        await browser.call("POST", "/reactions/set", { electionId, reaction: "laugh", on: true })
      ).json(),
    ).toEqual({ code: "TOO_MANY_THIS_HOUR", status: 429 });
  });

  test("refuses a malformed request before core sees it", async () => {
    const browser = await signedIn();
    const electionId = hex(await newElection(sql));
    const body = { electionId, reaction: "heart", on: true };
    for (const bad of [
      { ...body, electionId: electionId.toUpperCase() },
      { ...body, electionId: electionId.slice(2) },
      { ...body, reaction: "thumbs-up" },
      { ...body, reaction: "Heart" },
      { ...body, on: "true" },
      { ...body, extra: 1 },
      { electionId, reaction: "heart" },
    ])
      expect(await (await browser.call("POST", "/reactions/set", bad)).json()).toEqual({
        code: "BAD_REQUEST",
        status: 400,
      });
    for (const path of ["/reactions/counts", "/reactions/own"])
      for (const bad of [{}, { electionId, reaction: "heart" }, { electionId: 1 }])
        expect(await (await browser.call("POST", path, bad)).json()).toEqual({
          code: "BAD_REQUEST",
          status: 400,
        });
    const text = await fetch(`${base}/reactions/counts`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{",
    });
    expect(await text.json()).toEqual({ code: "BAD_REQUEST", status: 400 });
    // Nothing was recorded.
    expect(await (await browser.call("POST", "/reactions/own", { electionId })).json()).toEqual({
      counts: ZERO,
      own: [],
    });
  });

  test("refuses a change signed out, and any request from another origin, of another type or path", async () => {
    const electionId = hex(await newElection(sql));
    const body = { electionId, reaction: "heart", on: true };
    const signedOut = await new Browser().call("POST", "/reactions/set", body);
    expect(await signedOut.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
    const browser = await signedIn();
    for (const path of ["/reactions/counts", "/reactions/own", "/reactions/set"]) {
      const elsewhere = await browser.call("POST", path, body, { origin: "https://evil.test" });
      expect(await elsewhere.json()).toEqual({ code: "FORBIDDEN_ORIGIN", status: 403 });
      const text = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "text/plain" },
        body: JSON.stringify(body),
      });
      expect(await text.json()).toEqual({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
      expect((await browser.call("POST", `${path}?x=1`, body)).status).toBe(404);
    }
    expect((await browser.call("GET", "/reactions/counts")).status).toBe(404);
    expect((await browser.call("POST", "/reactions", body)).status).toBe(404);
    expect((await browser.call("POST", `/reactions/${electionId}`, body)).status).toBe(404);
    // None of it was recorded.
    expect(await (await browser.call("POST", "/reactions/own", { electionId })).json()).toEqual({
      counts: ZERO,
      own: [],
    });
  });

  test("never reads the session for the counts (T-11)", async () => {
    const electionId = hex(await newElection(sql));
    const asked: string[] = [];
    const handler = createReactionsHandler({
      sql,
      accountOf: async () => {
        asked.push("accountOf");
        return newAccountId();
      },
      origin: ORIGIN,
      now: () => NOW,
    });
    const post = (path: string) =>
      handler(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "content-type": "application/json",
            cookie: `${SESSION}=x.y`,
          },
          body: JSON.stringify({ electionId }),
        }),
      );
    expect(await (await post("/reactions/counts")).json()).toEqual({ counts: ZERO });
    expect(asked).toEqual([]);
    expect((await post("/reactions/own")).status).toBe(200);
    expect(asked).toEqual(["accountOf"]);
  });
});

describe("following a poll under /follows", () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

  /** A signed-in browser, its account verified by e-mail unless told otherwise. */
  async function signedIn({ verified = true } = {}) {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const cookie = [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const account = (await accounts.accountOf(new Headers({ cookie })))!;
    if (verified)
      await sql`
        INSERT INTO account_emails VALUES (${account}, ${randomBytes(32)}, 'h1', ${randomBytes(40)}, 'b1', now())`;
    return { browser, account };
  }

  const followers = async (electionId: string) =>
    (await sql`SELECT user_id FROM account_follows WHERE election_id = ${fromHex(electionId)}`).map(
      (r) => r["user_id"] as string,
    );

  let moderator: string;
  beforeAll(async () => {
    moderator = `${newAccountId().slice(0, 8)}-f`;
    await addModerators(sql, moderator);
  });

  test("an account follows a poll and stops, each answered with its own state", async () => {
    const electionId = hex(await newElection(sql));
    const a = await signedIn();
    const b = await signedIn();
    const follow = await a.browser.call("POST", "/follows/set", { electionId, on: true });
    expect(follow.status).toBe(200);
    expect(follow.headers.get("cache-control")).toBe("no-store");
    expect(await follow.json()).toEqual({ following: true });
    // Following one already followed changes nothing, and says the same.
    expect(
      await (await a.browser.call("POST", "/follows/set", { electionId, on: true })).json(),
    ).toEqual({ following: true });
    // Stopping one not followed changes nothing either.
    expect(
      await (await b.browser.call("POST", "/follows/set", { electionId, on: false })).json(),
    ).toEqual({ following: false });
    expect(await followers(electionId)).toEqual([a.account]);
    expect(
      await (await a.browser.call("POST", "/follows/set", { electionId, on: false })).json(),
    ).toEqual({ following: false });
    expect(await followers(electionId)).toEqual([]);

    // T-10, T-11, T-67: the log has the route class, never the poll or the account.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "follows", status: 200 });
    const log = JSON.stringify(logged);
    expect(log).not.toContain(electionId);
    expect(log).not.toContain(a.account);
  });

  test("refuses what core refuses, with its code", async () => {
    const electionId = hex(await newElection(sql));
    const set = async (browser: Browser, body: object) =>
      (await browser.call("POST", "/follows/set", { electionId, on: true, ...body })).json();
    const unverified = await signedIn({ verified: false });
    expect(await set(unverified.browser, {})).toEqual({ code: "ACCOUNT_UNVERIFIED", status: 403 });
    // Stopping is always allowed.
    expect(await set(unverified.browser, { on: false })).toEqual({ following: false });
    const { browser, account } = await signedIn();
    expect(await set(browser, { electionId: "00".repeat(32) })).toEqual({
      code: "UNKNOWN_ELECTION",
      status: 404,
    });

    expect(await set(browser, {})).toEqual({ following: true });
    await moderate(sql, fromHex(electionId), { action: "hide", reason: "illegal", moderator });
    // A hidden poll takes no new followers (T-68)…
    const other = await signedIn();
    expect(await set(other.browser, {})).toEqual({ code: "HIDDEN", status: 409 });
    expect(await followers(electionId)).toEqual([account]);
    // …but one following it can still stop.
    expect(await set(browser, { on: false })).toEqual({ following: false });
    expect(await followers(electionId)).toEqual([]);
  });

  test("refuses changes past the hour's limit", async () => {
    const electionId = hex(await newElection(sql));
    const { browser } = await signedIn();
    for (let i = 0; i < MAX_FOLLOW_CHANGES_PER_HOUR; i++)
      expect(
        (await browser.call("POST", "/follows/set", { electionId, on: i % 2 === 0 })).status,
      ).toBe(200);
    expect(
      await (await browser.call("POST", "/follows/set", { electionId, on: true })).json(),
    ).toEqual({ code: "TOO_MANY_THIS_HOUR", status: 429 });
  });

  test("refuses a malformed request before core sees it", async () => {
    const { browser } = await signedIn();
    const electionId = hex(await newElection(sql));
    const body = { electionId, on: true };
    for (const bad of [
      { ...body, electionId: electionId.toUpperCase() },
      { ...body, electionId: electionId.slice(2) },
      { ...body, on: "true" },
      { ...body, extra: 1 },
      { electionId },
      {},
    ])
      expect(await (await browser.call("POST", "/follows/set", bad)).json()).toEqual({
        code: "BAD_REQUEST",
        status: 400,
      });
    const text = await fetch(`${base}/follows/set`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{",
    });
    expect(await text.json()).toEqual({ code: "BAD_REQUEST", status: 400 });
    expect(await followers(electionId)).toEqual([]);
  });

  test("refuses a change signed out, and any request from another origin, of another type or path", async () => {
    const electionId = hex(await newElection(sql));
    const body = { electionId, on: true };
    const signedOut = await new Browser().call("POST", "/follows/set", body);
    expect(await signedOut.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
    const { browser } = await signedIn();
    const elsewhere = await browser.call("POST", "/follows/set", body, {
      origin: "https://evil.test",
    });
    expect(await elsewhere.json()).toEqual({ code: "FORBIDDEN_ORIGIN", status: 403 });
    const text = await fetch(`${base}/follows/set`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify(body),
    });
    expect(await text.json()).toEqual({ code: "UNSUPPORTED_MEDIA_TYPE", status: 415 });
    expect((await browser.call("POST", "/follows/set?x=1", body)).status).toBe(404);
    expect((await browser.call("GET", "/follows/set")).status).toBe(404);
    expect((await browser.call("POST", "/follows", body)).status).toBe(404);
    expect((await browser.call("POST", "/follows/own", body)).status).toBe(404);
    expect((await browser.call("POST", `/follows/${electionId}`, body)).status).toBe(404);
    // None of it was recorded.
    expect(await followers(electionId)).toEqual([]);
  });

  test("an account reads its own polls with results and takes them off, and no one else's", async () => {
    const [p1, p2] = [await newElection(sql), await newElection(sql)].sort(Buffer.compare);
    const a = await signedIn();
    const b = await signedIn();
    for (const p of [p2!, p1!])
      await a.browser.call("POST", "/follows/set", { electionId: hex(p), on: true });
    await b.browser.call("POST", "/follows/set", { electionId: hex(p2!), on: true });
    const results = async (browser: Browser) => {
      const res = await browser.call("POST", "/follows/results", {});
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.json();
    };
    // Following isn't on the list until the poll's results land.
    expect(await results(a.browser)).toEqual({ polls: [] });
    await landResults(sql, p1!, { now: new Date() });
    await landResults(sql, p2!, { now: new Date() });
    // In byte order, each account its own.
    expect(await results(a.browser)).toEqual({ polls: [hex(p1!), hex(p2!)] });
    expect(await results(b.browser)).toEqual({ polls: [hex(p2!)] });

    const drop = async (browser: Browser, electionId: string) =>
      (await browser.call("POST", "/follows/results/drop", { electionId })).json();
    expect(await drop(a.browser, hex(p2!))).toEqual({ dropped: true });
    // Taking off one already gone, or one never there, is no refusal.
    expect(await drop(a.browser, hex(p2!))).toEqual({ dropped: false });
    expect(await drop(a.browser, "00".repeat(32))).toEqual({ dropped: false });
    expect(await results(a.browser)).toEqual({ polls: [hex(p1!)] });
    // Another account's list is untouched.
    expect(await results(b.browser)).toEqual({ polls: [hex(p2!)] });

    // T-10, T-11, T-67: the log has the route class, never the poll or the account.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "follows", status: 200 });
    const log = JSON.stringify(logged);
    for (const p of [p1!, p2!]) expect(log).not.toContain(hex(p));
    expect(log).not.toContain(a.account);
  });

  test("refuses reading or changing the list signed out, malformed, or from another origin", async () => {
    const electionId = hex(await newElection(sql));
    const { browser } = await signedIn();
    await browser.call("POST", "/follows/set", { electionId, on: true });
    await landResults(sql, fromHex(electionId), { now: new Date() });
    const anyone = new Browser();
    expect(await (await anyone.call("POST", "/follows/results", {})).json()).toEqual({
      code: "SIGNED_OUT",
      status: 401,
    });
    expect(
      await (await anyone.call("POST", "/follows/results/drop", { electionId })).json(),
    ).toEqual({ code: "SIGNED_OUT", status: 401 });
    for (const [path, bad] of [
      ["/follows/results", { electionId }],
      ["/follows/results/drop", {}],
      ["/follows/results/drop", { electionId: electionId.toUpperCase() }],
      ["/follows/results/drop", { electionId, on: false }],
    ] as const)
      expect(await (await browser.call("POST", path, bad)).json()).toEqual({
        code: "BAD_REQUEST",
        status: 400,
      });
    expect(
      await (
        await browser.call(
          "POST",
          "/follows/results/drop",
          { electionId },
          {
            origin: "https://evil.test",
          },
        )
      ).json(),
    ).toEqual({ code: "FORBIDDEN_ORIGIN", status: 403 });
    expect((await browser.call("GET", "/follows/results")).status).toBe(404);
    expect((await browser.call("POST", "/follows/results?x=1", {})).status).toBe(404);
    // None of it changed the list.
    expect(await (await browser.call("POST", "/follows/results", {})).json()).toEqual({
      polls: [electionId],
    });
  });

  test("an account reads and sets its own results choice, and results off leaves the list", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const choice = async (browser: Browser) => {
      const res = await browser.call("POST", "/follows/notices", {});
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.json();
    };
    // On until the account turns it off.
    expect(await choice(a.browser)).toEqual({ results: true });
    expect(
      await (await a.browser.call("POST", "/follows/notices/set", { results: false })).json(),
    ).toEqual({ results: false });
    expect(await choice(a.browser)).toEqual({ results: false });
    // Another account's choice is its own.
    expect(await choice(b.browser)).toEqual({ results: true });

    // Off, a landing still lists the poll but queues no notice for it.
    const p = await newElection(sql);
    for (const { browser } of [a, b])
      await browser.call("POST", "/follows/set", { electionId: hex(p), on: true });
    expect(await landResults(sql, p, { now: new Date() })).toBe(1);
    expect(await (await a.browser.call("POST", "/follows/results", {})).json()).toEqual({
      polls: [hex(p)],
    });
    expect(await sql`SELECT 1 FROM account_notices WHERE user_id = ${a.account}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM account_notices WHERE user_id = ${b.account}`).toHaveLength(1);

    // Back on, and the choice is read as set.
    expect(
      await (await a.browser.call("POST", "/follows/notices/set", { results: true })).json(),
    ).toEqual({ results: true });
    expect(await choice(a.browser)).toEqual({ results: true });

    // T-10, T-11, T-67: the log has the route class, never the account.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "follows", status: 200 });
    expect(JSON.stringify(logged)).not.toContain(a.account);
  });

  test("refuses reading or setting the choice signed out, malformed, or from another origin", async () => {
    const { browser } = await signedIn();
    const anyone = new Browser();
    for (const [path, body] of [
      ["/follows/notices", {}],
      ["/follows/notices/set", { results: false }],
    ] as const)
      expect(await (await anyone.call("POST", path, body)).json()).toEqual({
        code: "SIGNED_OUT",
        status: 401,
      });
    for (const [path, bad] of [
      ["/follows/notices", { results: false }],
      ["/follows/notices/set", {}],
      ["/follows/notices/set", { results: "false" }],
      ["/follows/notices/set", { results: false, moderation: false }],
    ] as const)
      expect(await (await browser.call("POST", path, bad)).json()).toEqual({
        code: "BAD_REQUEST",
        status: 400,
      });
    expect(
      await (
        await browser.call(
          "POST",
          "/follows/notices/set",
          { results: false },
          { origin: "https://evil.test" },
        )
      ).json(),
    ).toEqual({ code: "FORBIDDEN_ORIGIN", status: 403 });
    expect((await browser.call("GET", "/follows/notices")).status).toBe(404);
    expect(
      (await browser.call("POST", "/follows/notices/set?x=1", { results: false })).status,
    ).toBe(404);
    // None of it changed the choice.
    expect(await (await browser.call("POST", "/follows/notices", {})).json()).toEqual({
      results: true,
    });
  });
});

describe("a profile's reports and its author's appeals under /profiles", () => {
  const cookieOf = (b: Browser) => [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  /** A signed-in author with a verified phone, and their profile's handle unless told otherwise. */
  async function author({ profile = true } = {}) {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const account = (await accounts.accountOf(new Headers({ cookie: cookieOf(browser) })))!;
    await sql`
      INSERT INTO account_phones VALUES (${account}, ${randomBytes(32)}, 'p1',
        date_trunc('day', now(), 'UTC'))`;
    const handle = profile
      ? await makeProfile(sql, account, "Riverside Neighbours", { now: NOW })
      : undefined;
    return { browser, handle };
  }

  /** The handle's pending reports, by ground, as the moderators' queue shows them. */
  const pendingOf = async (handle: string) =>
    Object.fromEntries(
      (await readProfileReportQueue(sql, 1000))
        .filter((r) => r.handle === handle)
        .map((r) => [r.reason, r.pending]),
    );

  let moderators: string[];
  beforeAll(async () => {
    const prefix = newAccountId().slice(0, 8);
    moderators = [`${prefix}-a`, `${prefix}-b`];
    await addModerators(sql, ...moderators);
  });

  test("anyone reports a profile by its handle, signed in or not, and nothing names who", async () => {
    const { browser, handle } = await author();
    const report = async (b: Browser, reason: string) => {
      const res = await b.call("POST", "/profiles/report", { handle, reason });
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res;
    };
    const anyone = new Browser();
    const sent = await report(anyone, "spam");
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({});
    await report(anyone, "spam");
    // Its own author's report counts the same: the front never hands the
    // handler the session, so it can't tell (T-10, T-11).
    expect((await report(browser, "impersonation")).status).toBe(200);
    expect(await pendingOf(handle!)).toEqual({ spam: 2n, impersonation: 1n });

    // A hidden profile is still reportable, under another ground.
    await moderateProfile(sql, handle!, {
      action: "hide",
      reason: "spam",
      moderator: moderators[0]!,
    });
    expect((await report(anyone, "harassment")).status).toBe(200);
    expect(await pendingOf(handle!)).toEqual({ spam: 2n, impersonation: 1n, harassment: 1n });

    // T-10, T-11, T-67: the log has the route class, never the handle.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "profiles", status: 200 });
    expect(JSON.stringify(logged)).not.toContain(handle);
  });

  test("refuses a report of a handle no profile has, or a malformed one, recording nothing", async () => {
    const { handle } = await author();
    const anyone = new Browser();
    expect(
      await (
        await anyone.call("POST", "/profiles/report", { handle: "a".repeat(16), reason: "spam" })
      ).json(),
    ).toEqual({ code: "UNKNOWN_PROFILE", status: 404 });
    for (const bad of [
      { handle: handle!.toUpperCase(), reason: "spam" },
      { handle: handle!.slice(1), reason: "spam" },
      { handle: `${handle!.slice(1)}1`, reason: "spam" },
      // A restore ground isn't a report's.
      { handle, reason: "appeal-upheld" },
      { handle, reason: "Spam" },
      { handle },
      { handle, reason: "spam", extra: 1 },
    ])
      expect(await (await anyone.call("POST", "/profiles/report", bad)).json()).toEqual({
        code: "BAD_REQUEST",
        status: 400,
      });
    const text = await fetch(`${base}/profiles/report`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: "{",
    });
    expect(await text.json()).toEqual({ code: "BAD_REQUEST", status: 400 });
    expect(await pendingOf(handle!)).toEqual({});
  });

  test("an author sees their profile's hide, appeals it once and sees the outcome, without a moderator", async () => {
    const { browser, handle } = await author();
    const view = async () => {
      const res = await browser.call("POST", "/profiles/moderation", {});
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.json();
    };
    expect(await view()).toEqual({ handle, state: "visible", appealable: false, appeals: [] });
    expect(await (await browser.call("POST", "/profiles/appeal", {})).json()).toEqual({
      code: "NOT_APPEALABLE",
      status: 409,
    });

    const { seq } = await moderateProfile(sql, handle!, {
      action: "hide",
      reason: "impersonation",
      moderator: moderators[0]!,
    });
    const latest = {
      seq: `${seq}`,
      action: "hide",
      reason: "impersonation",
      decidedAt: expect.any(String),
    };
    expect(await view()).toEqual({
      handle,
      state: "hidden",
      latest,
      appealable: true,
      appeals: [],
    });

    const filed = await browser.call("POST", "/profiles/appeal", {});
    expect(filed.status).toBe(201);
    expect(await filed.json()).toEqual({ decisionSeq: `${seq}` });
    expect(await (await browser.call("POST", "/profiles/appeal", {})).json()).toEqual({
      code: "ALREADY_APPEALED",
      status: 409,
    });
    const pending = await view();
    expect(pending).toEqual({
      handle,
      state: "hidden",
      latest,
      appealable: false,
      appeals: [{ decisionSeq: `${seq}`, filedAt: expect.any(String) }],
    });
    expect(JSON.stringify(pending)).not.toContain(moderators[0]);

    const { restoreSeq } = await decideProfileAppeal(sql, seq, "upheld", moderators[1]!);
    const decided = await view();
    expect(decided).toEqual({
      handle,
      state: "visible",
      latest: {
        seq: `${restoreSeq}`,
        action: "restore",
        reason: "appeal-upheld",
        decidedAt: expect.any(String),
      },
      appealable: false,
      appeals: [
        {
          decisionSeq: `${seq}`,
          filedAt: expect.any(String),
          outcome: "upheld",
          reviewedAt: expect.any(String),
        },
      ],
    });
    expect(JSON.stringify(decided)).not.toMatch(new RegExp(moderators.join("|")));
    expect(JSON.stringify(logged)).not.toContain(handle);
  });

  test("each author sees only their own profile; signed out, malformed or cross-site calls are refused", async () => {
    const { browser, handle } = await author();
    await moderateProfile(sql, handle!, {
      action: "hide",
      reason: "spam",
      moderator: moderators[0]!,
    });
    // Another account sees its own profile, never this one's, and can't appeal it.
    const other = await author();
    expect(await (await other.browser.call("POST", "/profiles/moderation", {})).json()).toEqual({
      handle: other.handle,
      state: "visible",
      appealable: false,
      appeals: [],
    });
    expect((await other.browser.call("POST", "/profiles/appeal", {})).status).toBe(409);
    const none = await author({ profile: false });
    for (const path of ["/profiles/moderation", "/profiles/appeal"]) {
      expect(await (await none.browser.call("POST", path, {})).json()).toEqual({
        code: "NO_PROFILE",
        status: 404,
      });
      expect(await (await new Browser().call("POST", path, {})).json()).toEqual({
        code: "SIGNED_OUT",
        status: 401,
      });
      // The profile is the session's: a handle in the body is refused, not read.
      for (const bad of [{ handle }, []])
        expect(await (await browser.call("POST", path, bad)).json()).toEqual({
          code: "BAD_REQUEST",
          status: 400,
        });
      const post = (headers: Record<string, string>) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { cookie: cookieOf(browser), ...headers },
          body: "{}",
        });
      expect(
        (await post({ origin: "https://elsewhere.test", "content-type": "application/json" }))
          .status,
      ).toBe(403);
      expect((await post({ "content-type": "application/json" })).status).toBe(403);
      expect((await post({ origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
      expect((await browser.call("POST", `${path}?x=1`, {})).status).toBe(404);
      expect((await browser.call("GET", path)).status).toBe(404);
    }
    expect((await browser.call("POST", "/profiles", {})).status).toBe(404);
    expect((await browser.call("POST", "/profiles/read", {})).status).toBe(404);
    // Nothing was appealed by any of it.
    expect(await (await browser.call("POST", "/profiles/moderation", {})).json()).toMatchObject({
      appealable: true,
      appeals: [],
    });
  });
  test("an author makes, reads, renames and deletes their profile, one name a UTC day", async () => {
    const { browser } = await author({ profile: false });
    const own = async () => {
      const res = await browser.call("POST", "/profiles/own", {});
      expect(res.headers.get("cache-control")).toBe("no-store");
      return res.json();
    };
    expect(await own()).toEqual({ code: "NO_PROFILE", status: 404 });
    expect(await (await browser.call("POST", "/profiles/rename", { name: "A" })).json()).toEqual({
      code: "NO_PROFILE",
      status: 404,
    });

    const made = await browser.call("POST", "/profiles/make", { name: "  Riverside   Walkers " });
    expect(made.status).toBe(201);
    const { handle } = (await made.json()) as { handle: string };
    expect(handle).toMatch(PROFILE_HANDLE);
    // Core's rules shape the name; the day it can change again is tomorrow's.
    expect(await own()).toEqual({
      handle,
      name: "Riverside Walkers",
      renamableOn: "2026-10-18",
      pollIds: [],
    });
    expect(await (await browser.call("POST", "/profiles/make", { name: "Other" })).json()).toEqual({
      code: "PROFILE_EXISTS",
      status: 409,
    });
    // The name it has changes nothing; another waits a day.
    expect(
      await (await browser.call("POST", "/profiles/rename", { name: "Riverside Walkers" })).json(),
    ).toEqual({ changed: false });
    expect(await (await browser.call("POST", "/profiles/rename", { name: "Hill" })).json()).toEqual(
      {
        code: "ONE_NAME_A_DAY",
        status: 429,
      },
    );
    const account = (await accounts.accountOf(new Headers({ cookie: cookieOf(browser) })))!;
    await sql`UPDATE account_profile_namings SET named_on = named_on - interval '1 day'
      WHERE user_id = ${account}`;
    expect(await own()).toEqual({ handle, name: "Riverside Walkers", pollIds: [] });
    for (const name of ["\u202eHill", "", " ", "x".repeat(61), "Hill\nTop"])
      expect(await (await browser.call("POST", "/profiles/rename", { name })).json()).toEqual({
        code: "INVALID_NAME",
        status: 422,
      });
    expect(await (await browser.call("POST", "/profiles/rename", { name: "Hill" })).json()).toEqual(
      {
        changed: true,
      },
    );
    expect(await own()).toEqual({ handle, name: "Hill", renamableOn: "2026-10-18", pollIds: [] });

    expect(await (await browser.call("POST", "/profiles/delete", {})).json()).toEqual({
      deleted: true,
    });
    expect(await own()).toEqual({ code: "NO_PROFILE", status: 404 });
    expect(await (await browser.call("POST", "/profiles/delete", {})).json()).toEqual({
      deleted: false,
    });
    // The day's naming outlives the profile, so a new one waits too.
    expect(await (await browser.call("POST", "/profiles/make", { name: "Hill" })).json()).toEqual({
      code: "ONE_NAME_A_DAY",
      status: 429,
    });
    // T-10, T-11, T-67: the log has the route class, never the handle or the name.
    expect(JSON.stringify(logged)).not.toMatch(new RegExp(`${handle}|Riverside|Hill`));
  });

  test("a profile needs a verified phone, and a hidden one keeps the name a moderator judged", async () => {
    const phoneless = new Browser();
    await register(phoneless, new SoftAuthenticator(RP_ID), true);
    expect(await (await phoneless.call("POST", "/profiles/make", { name: "Hill" })).json()).toEqual(
      { code: "PHONE_UNVERIFIED", status: 403 },
    );
    expect(await (await phoneless.call("POST", "/profiles/own", {})).json()).toEqual({
      code: "NO_PROFILE",
      status: 404,
    });

    const { browser, handle } = await author();
    await moderateProfile(sql, handle!, {
      action: "hide",
      reason: "impersonation",
      moderator: moderators[0]!,
    });
    const account = (await accounts.accountOf(new Headers({ cookie: cookieOf(browser) })))!;
    await sql`UPDATE account_profile_namings SET named_on = named_on - interval '1 day'
      WHERE user_id = ${account}`;
    expect(await (await browser.call("POST", "/profiles/rename", { name: "Hill" })).json()).toEqual(
      {
        code: "HIDDEN",
        status: 409,
      },
    );
    expect(await (await browser.call("POST", "/profiles/own", {})).json()).toMatchObject({
      name: "Riverside Neighbours",
    });
  });

  test("an author shows and stops showing their own polls, and no one else's", async () => {
    const { browser } = await author();
    const { id } = (await (await browser.call("POST", "/drafts/create", { draft })).json()) as {
      id: string;
    };
    const show = async (b: Browser, body: unknown) =>
      (await b.call("POST", "/profiles/show", body)).json();
    expect(await show(browser, { pollId: id, on: true })).toEqual({ changed: true });
    expect(await show(browser, { pollId: id, on: true })).toEqual({ changed: false });
    expect(await (await browser.call("POST", "/profiles/own", {})).json()).toMatchObject({
      pollIds: [id],
    });

    // Another author can't show it, and one with no profile shows nothing.
    const other = await author();
    expect(await show(other.browser, { pollId: id, on: true })).toEqual({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(await show(other.browser, { pollId: id, on: false })).toEqual({ changed: false });
    const none = await author({ profile: false });
    expect(await show(none.browser, { pollId: id, on: true })).toEqual({
      code: "NO_PROFILE",
      status: 404,
    });
    expect(await (await browser.call("POST", "/profiles/own", {})).json()).toMatchObject({
      pollIds: [id],
    });

    for (const bad of [
      { pollId: id.toUpperCase(), on: true },
      { pollId: id, on: "true" },
      { pollId: id },
      { pollId: id, on: true, handle: "a".repeat(16) },
    ])
      expect(await show(browser, bad)).toEqual({ code: "BAD_REQUEST", status: 400 });

    expect(await show(browser, { pollId: id, on: false })).toEqual({ changed: true });
    expect(await (await browser.call("POST", "/profiles/own", {})).json()).toMatchObject({
      pollIds: [],
    });
    expect(JSON.stringify(logged)).not.toContain(id);
  });

  test("the author's profile routes refuse signed-out, malformed and cross-site calls", async () => {
    const { browser } = await author();
    const pollId = "a".repeat(32);
    for (const [path, body, bad] of [
      ["/profiles/own", {}, { name: "Hill" }],
      ["/profiles/make", { name: "Hill" }, { name: 1 }],
      ["/profiles/rename", { name: "Hill" }, {}],
      ["/profiles/delete", {}, { handle: "a".repeat(16) }],
      ["/profiles/show", { pollId, on: true }, { pollId, on: true, extra: 1 }],
    ] as const) {
      expect(await (await new Browser().call("POST", path, body)).json()).toEqual({
        code: "SIGNED_OUT",
        status: 401,
      });
      for (const wrong of [bad, []])
        expect(await (await browser.call("POST", path, wrong)).json()).toEqual({
          code: "BAD_REQUEST",
          status: 400,
        });
      const post = (headers: Record<string, string>) =>
        fetch(`${base}${path}`, {
          method: "POST",
          headers: { cookie: cookieOf(browser), ...headers },
          body: JSON.stringify(body),
        });
      expect(
        (await post({ origin: "https://elsewhere.test", "content-type": "application/json" }))
          .status,
      ).toBe(403);
      expect((await post({ origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
      expect((await browser.call("POST", `${path}?x=1`, body)).status).toBe(404);
      expect((await browser.call("GET", path)).status).toBe(404);
    }
    // None of it touched the profile.
    expect(await (await browser.call("POST", "/profiles/own", {})).json()).toMatchObject({
      name: "Riverside Neighbours",
      pollIds: [],
    });
  });
});

describe("an account's own data under /export", () => {
  const cookieOf = (b: Browser) => [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  async function signedIn() {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const account = (await accounts.accountOf(new Headers({ cookie: cookieOf(browser) })))!;
    return { browser, account };
  }

  test("a signed-in account takes its own export, and no one else's", async () => {
    const { browser, account } = await signedIn();
    await browser.call(
      "POST",
      "/email/request",
      { address: "own@example.org" },
      {
        [TURNSTILE_HEADER]: "solved",
      },
    );
    const { code } = mailed.at(-1) as { code: string };
    expect((await browser.call("POST", "/email/verify", { code })).status).toBe(200);
    const { id } = (await (await browser.call("POST", "/drafts/create", { draft })).json()) as {
      id: string;
    };
    const other = await signedIn();
    await other.browser.call("POST", "/drafts/create", { draft });

    const res = await browser.call("POST", "/export", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const out = (await res.json()) as AccountExport;
    expect(out).toMatchObject({
      version: ACCOUNT_EXPORT_VERSION,
      exportedAt: NOW.toISOString(),
      account: { id: account },
      email: { address: "own@example.org" },
    });
    expect(out.polls.map((p) => p.id)).toEqual([id]);
    expect(out.passkeys).toHaveLength(1);
    expect(out.sessions).toHaveLength(1);
    // Exactly what core gives the account: the route adds and drops nothing.
    expect(out).toEqual(
      JSON.parse(JSON.stringify(await exportAccount(sql, account, { keys: EMAIL_KEYS, now: NOW }))),
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain(other.account);
    // The session's own token is never in it (T-10).
    for (const value of browser.cookies.values()) expect(text).not.toContain(value.split(".")[0]);

    // T-10, T-11, T-67: the log has the route class, never a byte of the export.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "export", status: 200 });
    const lines = JSON.stringify(logged);
    for (const secret of [account, id, "own@example.org"]) expect(lines).not.toContain(secret);
  });

  test("a deleted account's session, and an account gone after its session was read, are signed out", async () => {
    const { browser, account } = await signedIn();
    // The session goes with the account, so the front reads it as signed out.
    await sql`DELETE FROM account_users WHERE id = ${account}`;
    expect(await (await browser.call("POST", "/export", {})).json()).toEqual({
      code: "SIGNED_OUT",
      status: 401,
    });
    // Gone between the session's read and the export's: core finds no account.
    const raced = createExportHandler({
      sql,
      accountOf: async () => account,
      emailKeys: EMAIL_KEYS,
      origin: ORIGIN,
      now: () => NOW,
    });
    const res = await raced(
      new Request(`${ORIGIN}/export`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(await res.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
  });

  test("refuses signed-out, malformed and cross-site calls", async () => {
    const { browser } = await signedIn();
    expect(await (await new Browser().call("POST", "/export", {})).json()).toEqual({
      code: "SIGNED_OUT",
      status: 401,
    });
    // No account ID is read from the body: the session names the account (T-10).
    for (const wrong of [{ account: "a".repeat(32) }, [], null, 1])
      expect(await (await browser.call("POST", "/export", wrong)).json()).toEqual({
        code: "BAD_REQUEST",
        status: 400,
      });
    const post = (headers: Record<string, string>, body = "{}") =>
      fetch(`${base}/export`, {
        method: "POST",
        headers: { cookie: cookieOf(browser), ...headers },
        body,
      });
    expect(
      (await post({ origin: "https://elsewhere.test", "content-type": "application/json" })).status,
    ).toBe(403);
    expect((await post({ "content-type": "application/json" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
    expect((await post({ origin: ORIGIN, "content-type": "application/json" }, "{")).status).toBe(
      400,
    );
    expect((await browser.call("POST", "/export?x=1", {})).status).toBe(404);
    expect((await browser.call("POST", "/export/all", {})).status).toBe(404);
    expect((await browser.call("GET", "/export")).status).toBe(404);
  });
});

describe("an account's web push subscriptions under /push", () => {
  const cookieOf = (b: Browser) => [...b.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  let n = 0;
  const endpoint = () => `https://fcm.googleapis.com/fcm/send/web${++n}:APA91b`;

  async function signedIn() {
    const browser = new Browser();
    await register(browser, new SoftAuthenticator(RP_ID), true);
    const account = (await accounts.accountOf(new Headers({ cookie: cookieOf(browser) })))!;
    return { browser, account };
  }

  const endpointsOf = async (account: string) =>
    (
      await sql`SELECT endpoint FROM account_push_subscriptions WHERE user_id = ${account}
        ORDER BY endpoint`
    ).map((r) => r["endpoint"] as string);

  test("the key is the same for anyone, signed in or not", async () => {
    const res = await new Browser().call("GET", "/push/key");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ key: PUSH_KEY });
    expect(logged.at(-1)).toMatchObject({ method: "GET", route: "push", status: 200 });
  });

  test("a signed-in account subscribes this browser, reads it back and unsubscribes it", async () => {
    const { browser, account } = await signedIn();
    const e = endpoint();
    const status = async () => (await browser.call("POST", "/push/status", { endpoint: e })).json();
    expect(await status()).toEqual({ subscribed: false });
    const res = await browser.call("POST", "/push/subscribe", { endpoint: e });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await endpointsOf(account)).toEqual([e]);
    expect(await status()).toEqual({ subscribed: true });
    expect((await browser.call("POST", "/push/unsubscribe", { endpoint: e })).status).toBe(200);
    expect(await endpointsOf(account)).toEqual([]);
    expect(await status()).toEqual({ subscribed: false });
    // Taking away what isn't there answers alike.
    expect((await browser.call("POST", "/push/unsubscribe", { endpoint: e })).status).toBe(200);

    // T-10, T-11, T-67, T-76: the log has the route class, never the endpoint or the account.
    expect(logged.at(-1)).toMatchObject({ method: "POST", route: "push", status: 200 });
    const lines = JSON.stringify(logged);
    for (const secret of [account, e]) expect(lines).not.toContain(secret);
  });

  test("an endpoint is one account's: another's status is false, and it can't unsubscribe it", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const e = endpoint();
    await a.browser.call("POST", "/push/subscribe", { endpoint: e });
    expect(await (await b.browser.call("POST", "/push/status", { endpoint: e })).json()).toEqual({
      subscribed: false,
    });
    await b.browser.call("POST", "/push/unsubscribe", { endpoint: e });
    expect(await endpointsOf(a.account)).toEqual([e]);
    // The same browser subscribed by another account on a shared device moves to it.
    await b.browser.call("POST", "/push/subscribe", { endpoint: e });
    expect(await endpointsOf(a.account)).toEqual([]);
    expect(await endpointsOf(b.account)).toEqual([e]);
  });

  test("T-76: refuses an endpoint off the known push services, keeping nothing", async () => {
    const { browser, account } = await signedIn();
    for (const wrong of [
      "http://169.254.169.254/latest/meta-data",
      "https://fcm.googleapis.com.evil.test/x",
      "https://fcm.googleapis.com:8443/x",
      `https://fcm.googleapis.com/${"a".repeat(1100)}`,
    ])
      expect(
        await (await browser.call("POST", "/push/subscribe", { endpoint: wrong })).json(),
      ).toEqual({ code: "INVALID_ENDPOINT", status: 400 });
    expect(await endpointsOf(account)).toEqual([]);
  });

  test("refuses signed-out, malformed and cross-site calls", async () => {
    const { browser } = await signedIn();
    const e = endpoint();
    for (const path of ["/push/status", "/push/subscribe", "/push/unsubscribe"])
      expect(await (await new Browser().call("POST", path, { endpoint: e })).json()).toEqual({
        code: "SIGNED_OUT",
        status: 401,
      });
    // No account ID is read from the body: the session names the account (T-10).
    for (const wrong of [{}, { endpoint: e, account: "a".repeat(32) }, { endpoint: 1 }, [], null])
      expect(await (await browser.call("POST", "/push/subscribe", wrong)).json()).toEqual({
        code: "BAD_REQUEST",
        status: 400,
      });
    const post = (headers: Record<string, string>, body = JSON.stringify({ endpoint: e })) =>
      fetch(`${base}/push/subscribe`, {
        method: "POST",
        headers: { cookie: cookieOf(browser), ...headers },
        body,
      });
    expect(
      (await post({ origin: "https://elsewhere.test", "content-type": "application/json" })).status,
    ).toBe(403);
    expect((await post({ "content-type": "application/json" })).status).toBe(403);
    expect((await post({ origin: ORIGIN, "content-type": "text/plain" })).status).toBe(415);
    expect(
      (await post({ origin: ORIGIN, "content-type": "application/json; charset=utf-8" })).status,
    ).toBe(415);
    expect((await post({ origin: ORIGIN, "content-type": "application/json" }, "{")).status).toBe(
      400,
    );
    expect((await browser.call("POST", "/push/subscribe?x=1", { endpoint: e })).status).toBe(404);
    expect((await browser.call("GET", "/push/subscribe")).status).toBe(404);
    expect((await browser.call("POST", "/push/key", {})).status).toBe(404);
    expect((await browser.call("GET", "/push/key?x=1")).status).toBe(404);
    expect((await browser.call("GET", "/push")).status).toBe(404);
  });

  test("a deployment that doesn't push answers 503 on every route, keeping nothing", async () => {
    const off = createPushHandler({
      sql,
      accountOf: async () => newAccountId(),
      publicKey: undefined,
      origin: ORIGIN,
    });
    const post = (path: string) =>
      off(
        new Request(`${ORIGIN}${path}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ endpoint: endpoint() }),
        }),
      );
    for (const res of [
      await off(new Request(`${ORIGIN}/push/key`)),
      await post("/push/status"),
      await post("/push/subscribe"),
      await post("/push/unsubscribe"),
    ])
      expect(await res.json()).toEqual({ code: "UNAVAILABLE", status: 503 });
  });

  test("an account gone after its session was read is signed out", async () => {
    const raced = createPushHandler({
      sql,
      accountOf: async () => newAccountId(),
      publicKey: PUSH_KEY,
      origin: ORIGIN,
      now: () => NOW,
    });
    const res = await raced(
      new Request(`${ORIGIN}/push/subscribe`, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: JSON.stringify({ endpoint: endpoint() }),
      }),
    );
    expect(await res.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
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
      drafts: async () => new Response(null, { status: 404 }),
      email: async () => new Response(null, { status: 404 }),
      phone: async () => new Response(null, { status: 404 }),
      token: async () => new Response(null, { status: 404 }),
      reactions: async () => new Response(null, { status: 404 }),
      follows: async () => new Response(null, { status: 404 }),
      profiles: async () => new Response(null, { status: 404 }),
      accountExport: async () => new Response(null, { status: 404 }),
      push: async () => new Response(null, { status: 404 }),
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
      drafts: async () => new Response(),
      email: async () => new Response(),
      phone: async () => new Response(),
      token: async () => new Response(),
      reactions: async () => new Response(),
      follows: async () => new Response(),
      profiles: async () => new Response(),
      accountExport: async () => new Response(),
      push: async () => new Response(),
      clientDir,
      log: () => {},
    };
    for (const origin of ["https://abolish.test/", "https://abolish.test/x", "ftp://abolish.test"])
      expect(() => createWebServer({ ...options, origin })).toThrow(RangeError);
  });
});
