// What the image will run (P2-11): dist/ copied away from the repository, so
// nothing resolves through node_modules, run by plain Node as a login granted
// only abolish_app. dist/node/main.mjs serves the built pages, the hashed
// assets and the account handler.

import { newVapidKey, vapidKeys, vapidPublicKey } from "@abolishus/core";
import { shortCode } from "@abolishus/core/short-codes";
import {
  decodeDeploymentRecord,
  encodeDeploymentRecord,
  generateTier0TokenKeyPair,
  tier0TokenKeyPeriod,
} from "@abolishus/crypto";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { APP_FILES } from "../src/app/install.ts";
import { fromHex } from "../src/values.ts";
import { pollPreview } from "../src/og/poll.ts";
import { definitionView } from "../src/server/definition.ts";
import { renderPreview } from "../src/og/render.ts";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const url = new URL(process.env["TEST_DATABASE_URL"] ?? "");
const password = randomBytes(16).toString("hex");
const SECRET = randomBytes(32).toString("hex");

let db: TestDb;
let dir: string;
let login: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "abolish-web-image-"));
  // Packed first, as the build script does: loading the config regenerates
  // the route tree, which the app build then formats (vite.config.ts).
  execFileSync("vp", ["pack", "--out-dir", join(dir, "node")], { cwd: pkg, stdio: "inherit" });
  const builder = await createBuilder({ root: pkg, logLevel: "warn" });
  await builder.buildApp();
  cpSync(join(pkg, "dist", "server"), join(dir, "server"), { recursive: true });
  cpSync(join(pkg, "dist", "client"), join(dir, "client"), { recursive: true });
  db = await testDb();
  login = `${db.schema}_web`;
  await db.admin.unsafe(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' IN ROLE abolish_app`);
  await db.admin.unsafe(`ALTER ROLE "${login}" SET search_path = "${db.schema}"`);
}, 180_000);

afterAll(async () => {
  await db?.admin.unsafe(`DROP ROLE IF EXISTS "${login}"`);
  await db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  return port;
}

/** main.mjs from the copied bundle with exactly `env`. */
function run(env: Record<string, string>) {
  const child = spawn(process.execPath, [join(dir, "node", "main.mjs")], {
    cwd: dir,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  return { child, out: () => stdout, err: () => stderr };
}

function database(): string {
  const u = new URL(url.href);
  u.username = login;
  u.password = password;
  return u.href;
}

// Cloudflare's published test key, which always passes.
const SITE_KEY = "1x00000000000000000000AA";

/** A whole e-mail configuration, with Postmark's test token. */
const EMAIL = {
  EMAIL_HASH_KEYS: `h1:${randomBytes(32).toString("hex")}`,
  EMAIL_BOX_KEYS: `b1:${randomBytes(32).toString("hex")}`,
  POSTMARK_SERVER_TOKEN: "POSTMARK_API_TEST",
  EMAIL_FROM: "codes@abolish.test",
};

/** A whole phone configuration, with made-up Twilio credentials nothing calls. */
const PHONE = {
  PHONE_HASH_KEYS: `p1:${randomBytes(32).toString("hex")}`,
  TWILIO_KEY_SID: `SK${randomBytes(16).toString("hex")}`,
  TWILIO_KEY_SECRET: randomBytes(16).toString("hex"),
  TWILIO_VERIFY_SERVICE_SID: `VA${randomBytes(16).toString("hex")}`,
  PHONE_DAILY_CEILING: "1000",
};

const PERIOD = tier0TokenKeyPeriod(Math.floor(Date.now() / 1000));
/** A key pair for each period from the last to six ahead. */
const PAIRS = new Map(
  Array.from({ length: 8 }, (_, i) => [PERIOD - 1 + i, generateTier0TokenKeyPair()] as const),
);
/** A period's issuer key as TIER0_ISSUER_KEYS lists it. */
const issuerKey = (period: number) =>
  `${period}:${Buffer.from((PAIRS.get(period) ?? generateTier0TokenKeyPair()).secretKey).toString("hex")}`;
const REGISTRY = randomBytes(20);

/**
 * The spec's typical version-2 deployment record, made this deployment's:
 * its L2, registry and region 0's groups, with `PAIRS`' public keys.
 */
function deploymentRecord(retired = -1): string {
  const typical = decodeDeploymentRecord(
    Buffer.from(
      (
        JSON.parse(
          readFileSync(
            new URL("../../../docs/spec/vectors/deployment-record-v2.json", import.meta.url),
            "utf8",
          ),
        ) as { vectors: { id: string; encoding: string }[] }
      ).vectors.find((v) => v.id === "typical")!.encoding,
      "hex",
    ),
  );
  if (typical.version !== 2) throw new Error("the typical vector isn't version 2");
  return Buffer.from(
    encodeDeploymentRecord({
      version: 2,
      value: {
        ...typical.value,
        l2_chain_id: 421_614n,
        group_registry: Uint8Array.from(REGISTRY),
        groups: [
          { group_id: 7n, tier: 0, self_paid: false, region: 0 },
          { group_id: 8n, tier: 0, self_paid: true, region: 0 },
        ],
        tier0_token_keys: [...PAIRS].map(([period, p]) => ({
          period,
          key: p.publicKey,
          retired: period === retired,
        })),
      },
    }),
  ).toString("hex");
}

/** A whole Tier 0 issuer configuration: this period's key and the next. */
const TIER0 = {
  TIER0_ISSUER_KEYS: `${issuerKey(PERIOD)},${issuerKey(PERIOD + 1)}`,
  TIER0_CHAIN_ID: "421614",
  TIER0_GROUP_REGISTRY: `0x${REGISTRY.toString("hex")}`,
  TIER0_GROUP: "7",
  TIER0_DEPLOYMENT_RECORD: deploymentRecord(),
};

describe("dist/node/main.mjs", () => {
  test("serves pages, their assets and the account handler, from the bundle alone", async () => {
    const port = await freePort();
    const web = run({
      DATABASE_URL: database(),
      // No API answers: the account page doesn't call it, and the home page
      // leaves its list of polls out when the API is unreachable.
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: SITE_KEY,
      ...EMAIL,
      ...PHONE,
      PHONE_VERIFICATION: "on",
      ...TIER0,
      WEB_PORT: String(port),
    });
    try {
      const at = `http://127.0.0.1:${port}`;
      let home: Response | undefined;
      for (let i = 0; i < 100 && home === undefined && web.child.exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        home = await fetch(`${at}/`).catch(() => undefined);
      }
      // The one log line is the home page's failed listing, by error name only.
      expect(
        web
          .err()
          .split("\n")
          .filter((line) => line !== "" && line !== "{ error: 'TypeError' }"),
      ).toEqual([]);
      expect(home?.status).toBe(200);
      expect(home?.headers.get("content-security-policy")).toContain("default-src 'none'");
      const html = (await home?.text()) ?? "";
      const scripts = [...html.matchAll(/\bsrc="(\/assets\/[\w-]+\.js)"/g)].map((m) => m[1]!);
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        const asset = await fetch(`${at}${script}`);
        expect(asset.status).toBe(200);
        expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      }
      // The install's files ship in the bundle, each as the type the server names (P2-28).
      for (const [path, type] of Object.entries(APP_FILES)) {
        const file = await fetch(`${at}${path}`);
        expect([path, file.status, file.headers.get("content-type")]).toEqual([path, 200, type]);
      }
      const account = await fetch(`${at}/account`);
      expect(account.status).toBe(200);
      expect(await account.text()).toContain('<meta name="robots" content="noindex"');
      // The poll editor gets Turnstile's origin in its policy and the site key in its page.
      const editor = await fetch(`${at}/account/polls/new`);
      expect(editor.status).toBe(200);
      expect(editor.headers.get("content-security-policy")).toContain(
        "frame-src https://challenges.cloudflare.com",
      );
      expect(account.headers.get("content-security-policy")).not.toContain("challenges");
      expect(await editor.text()).toContain(SITE_KEY);
      // With phone verification on, the verification page asks for a number.
      const verify = await (await fetch(`${at}/account/verify`)).text();
      expect(verify).toContain("Verify your e-mail and phone");
      expect(verify).toContain("Your phone number");
      // A query that reached the session table as abolish_app: a missing
      // table or grant would be a 500.
      const session = await fetch(`${at}/auth/get-session`, {
        headers: { cookie: "__Secure-abolish-account.session_token=x.y" },
      });
      expect(session.status).toBe(200);
      expect(await session.json()).toBeNull();
      // The e-mail routes are served, and need a session.
      const email = await fetch(`${at}/email`);
      expect(await email.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
      // So are the phone routes.
      const phone = await fetch(`${at}/phone`);
      expect(await phone.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
      // And the token route.
      const token = await fetch(`${at}/token`, {
        method: "POST",
        headers: { origin: "https://abolish.test", "content-type": "application/json" },
        body: "{}",
      });
      expect(await token.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
      // And the reactions routes, whose counts reached account_reactions as
      // abolish_app: a missing table or grant would be a 500.
      const reactions = await fetch(`${at}/reactions/counts`, {
        method: "POST",
        headers: { origin: "https://abolish.test", "content-type": "application/json" },
        body: JSON.stringify({ electionId: "00".repeat(32) }),
      });
      expect(await reactions.json()).toEqual({
        counts: { heart: 0, laugh: 0, wow: 0, thinking: 0, sad: 0, clap: 0 },
      });
      // And the profiles routes, whose report read account_profiles as
      // abolish_app: a missing table or grant would be a 500.
      const report = await fetch(`${at}/profiles/report`, {
        method: "POST",
        headers: { origin: "https://abolish.test", "content-type": "application/json" },
        body: JSON.stringify({ handle: "a".repeat(16), reason: "spam" }),
      });
      expect(await report.json()).toEqual({ code: "UNKNOWN_PROFILE", status: 404 });
      // And the export route, which needs a session (core's tests read every
      // account table through `exportAccount` as abolish_app).
      const exported = await fetch(`${at}/export`, {
        method: "POST",
        headers: { origin: "https://abolish.test", "content-type": "application/json" },
        body: "{}",
      });
      expect(await exported.json()).toEqual({ code: "SIGNED_OUT", status: 401 });
      // And a profile's page, read through the front's reader in Start's
      // request context as abolish_app: no reader, table or grant would be a 500.
      const profile = await fetch(`${at}/by/${"a".repeat(16)}`);
      expect(profile.status).toBe(404);
      // Its log: one line per request, by route class, written once each
      // answer is sent.
      await new Promise((r) => setTimeout(r, 100));
      const lines = web
        .out()
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { route?: string });
      expect(lines.map((l) => l.route)).toContain("auth");
      expect(lines.map((l) => l.route)).toContain("email");
      expect(lines.map((l) => l.route)).toContain("phone");
      expect(lines.map((l) => l.route)).toContain("token");
      expect(lines.map((l) => l.route)).toContain("reactions");
      expect(lines.map((l) => l.route)).toContain("profiles");
      expect(lines.map((l) => l.route)).toContain("export");
      // No start-up prune of the account tables failed as abolish_app.
      expect(web.out()).not.toContain("AccountPruneFailed");
      expect(web.out()).not.toContain("Tier0TokenDeadMarkFailed");
      expect(web.out()).not.toContain("abolish.test");
    } finally {
      if (web.child.exitCode === null) {
        const exited = once(web.child, "exit");
        web.child.kill("SIGTERM");
        await exited;
      }
    }
  }, 30_000);

  test("refuses to start without its configuration, quoting none of it", async () => {
    const web = run({
      DATABASE_URL: database(),
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: "short",
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: SITE_KEY,
    });
    const [code] = (await once(web.child, "exit")) as [number];
    expect(code).not.toBe(0);
    expect(web.err()).toContain("ACCOUNT_SECRET");
    expect(web.err()).not.toContain(password);
  }, 30_000);

  test("refuses to start without a Turnstile secret key", async () => {
    const web = run({
      DATABASE_URL: database(),
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      TURNSTILE_SITE_KEY: SITE_KEY,
    });
    const [code] = (await once(web.child, "exit")) as [number];
    expect(code).not.toBe(0);
    expect(web.err()).toContain("TURNSTILE_SECRET_KEY");
    expect(web.err()).not.toContain(SECRET);
  }, 30_000);

  test.each(["not a key", "0x4AAA/AAA", "k".repeat(101)])(
    "refuses to start with %j as its Turnstile site key",
    async (siteKey) => {
      const web = run({
        DATABASE_URL: database(),
        API_URL: "http://127.0.0.1:9",
        WEB_ORIGIN: "https://abolish.test",
        ACCOUNT_SECRET: SECRET,
        TURNSTILE_SECRET_KEY: "turnstile-secret",
        TURNSTILE_SITE_KEY: siteKey,
      });
      const [code] = (await once(web.child, "exit")) as [number];
      expect(code).not.toBe(0);
      expect(web.err()).toContain("TURNSTILE_SITE_KEY");
      expect(web.err()).not.toContain(SECRET);
    },
    30_000,
  );

  test.each(["http://ballot.test", "https://ballot.test/?from=web", "https://ballot.test/#x"])(
    "refuses to start with %j as the ballot client's address",
    async (ballotUrl) => {
      const web = run({
        DATABASE_URL: database(),
        API_URL: "http://127.0.0.1:9",
        WEB_ORIGIN: "https://abolish.test",
        ACCOUNT_SECRET: SECRET,
        TURNSTILE_SECRET_KEY: "turnstile-secret",
        TURNSTILE_SITE_KEY: SITE_KEY,
        BALLOT_URL: ballotUrl,
      });
      const [code] = (await once(web.child, "exit")) as [number];
      expect(code).not.toBe(0);
      expect(web.err()).toContain("BALLOT_URL");
      expect(web.err()).not.toContain("ballot.test");
    },
    30_000,
  );

  test("refuses half a PostHog configuration, quoting none of it", async () => {
    const web = run({
      DATABASE_URL: database(),
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: SITE_KEY,
      POSTHOG_KEY: "phc_unpaired",
    });
    const [code] = (await once(web.child, "exit")) as [number];
    expect(code).not.toBe(0);
    expect(web.err()).toContain("POSTHOG_HOST and POSTHOG_KEY go together");
    expect(web.err()).not.toContain("phc_unpaired");
  }, 30_000);

  test("refuses part of an e-mail configuration, quoting none of it", async () => {
    const { EMAIL_FROM: _, ...partial } = EMAIL;
    const web = run({
      DATABASE_URL: database(),
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      ...partial,
    });
    const [code] = (await once(web.child, "exit")) as [number];
    expect(code).not.toBe(0);
    expect(web.err()).toContain("EMAIL_FROM go together");
    for (const value of Object.values(partial)) expect(web.err()).not.toContain(value);
  }, 30_000);

  test.each([
    ["a malformed keyring", { EMAIL_HASH_KEYS: "h1:0123" }, "EMAIL_HASH_KEYS"],
    [
      "one key in both keyrings",
      { EMAIL_BOX_KEYS: `b1:${EMAIL.EMAIL_HASH_KEYS.slice(3)}` },
      "EMAIL_BOX_KEYS",
    ],
    ["a sender with a display name", { EMAIL_FROM: "Abolish <codes@abolish.test>" }, "EMAIL_FROM"],
  ])(
    "refuses %s, naming the variable and quoting none of it",
    async (_, change, name) => {
      const configured = { ...EMAIL, ...change };
      const web = run({
        DATABASE_URL: database(),
        API_URL: "http://127.0.0.1:9",
        WEB_ORIGIN: "https://abolish.test",
        ACCOUNT_SECRET: SECRET,
        TURNSTILE_SECRET_KEY: "turnstile-secret",
        ...configured,
      });
      const [code] = (await once(web.child, "exit")) as [number];
      expect(code).not.toBe(0);
      expect(web.err()).toContain(name);
      for (const value of Object.values(configured))
        if (value !== EMAIL.EMAIL_FROM) expect(web.err()).not.toContain(value.slice(3));
    },
    30_000,
  );

  test("leaves phone verification off unless told otherwise, asking for no number", async () => {
    const port = await freePort();
    const web = run({
      DATABASE_URL: database(),
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: SITE_KEY,
      ...EMAIL,
      // A provider configured, but the setting not on: still off.
      ...PHONE,
      ...TIER0,
      WEB_PORT: String(port),
    });
    try {
      const at = `http://127.0.0.1:${port}`;
      let verify: Response | undefined;
      for (let i = 0; i < 100 && verify === undefined && web.child.exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        verify = await fetch(`${at}/account/verify`).catch(() => undefined);
      }
      expect(verify?.status).toBe(200);
      const html = (await verify?.text()) ?? "";
      expect(html).toContain("Verify your e-mail");
      expect(html).toContain("Your e-mail address");
      expect(html).not.toContain("Verify your e-mail and phone");
      expect(html).not.toContain("Your phone number");
    } finally {
      if (web.child.exitCode === null) {
        const exited = once(web.child, "exit");
        web.child.kill("SIGTERM");
        await exited;
      }
    }
  }, 30_000);

  test.each([
    ["on without a phone provider", { PHONE_VERIFICATION: "on" }, "PHONE_VERIFICATION=on needs"],
    ["a value that is neither on nor off", { PHONE_VERIFICATION: "yes" }, "PHONE_VERIFICATION"],
  ])(
    "refuses phone verification %s",
    async (_, change, message) => {
      const web = run({
        DATABASE_URL: database(),
        API_URL: "http://127.0.0.1:9",
        WEB_ORIGIN: "https://abolish.test",
        ACCOUNT_SECRET: SECRET,
        TURNSTILE_SECRET_KEY: "turnstile-secret",
        ...EMAIL,
        ...change,
      });
      const [code] = (await once(web.child, "exit")) as [number];
      expect(code).not.toBe(0);
      expect(web.err()).toContain(message);
    },
    30_000,
  );

  test("with web push configured, serves its key to anyone, from the bundle alone", async () => {
    const port = await freePort();
    const secret = newVapidKey();
    const web = run({
      DATABASE_URL: database(),
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      ...EMAIL,
      VAPID_SECRET_KEY: secret,
      VAPID_SUBJECT: "mailto:push@abolish.test",
      WEB_PORT: String(port),
    });
    try {
      const at = `http://127.0.0.1:${port}`;
      let key: Response | undefined;
      for (let i = 0; i < 100 && key === undefined && web.child.exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        key = await fetch(`${at}/push/key`).catch(() => undefined);
      }
      expect(key?.status).toBe(200);
      expect(await key?.json()).toEqual({ key: vapidPublicKey(vapidKeys(secret)) });
      expect(web.err()).not.toContain(secret);
    } finally {
      if (web.child.exitCode === null) {
        const exited = once(web.child, "exit");
        web.child.kill("SIGTERM");
        await exited;
      }
    }
  }, 30_000);

  test.each([
    ["half a configuration", { VAPID_SECRET_KEY: "unpaired" }, false, "go together"],
    [
      "web push without the e-mail service",
      { VAPID_SECRET_KEY: "unpaired", VAPID_SUBJECT: "mailto:push@abolish.test" },
      false,
      "VAPID_SECRET_KEY needs the e-mail service",
    ],
    [
      "a key that isn't a P-256 secret key",
      { VAPID_SECRET_KEY: "unpaired", VAPID_SUBJECT: "mailto:push@abolish.test" },
      true,
      "VAPID_SECRET_KEY",
    ],
    [
      "a subject that is neither an address nor an https URL",
      { VAPID_SECRET_KEY: newVapidKey(), VAPID_SUBJECT: "http://abolish.test" },
      true,
      "VAPID_SUBJECT",
    ],
  ])(
    "refuses web push with %s, quoting none of it",
    async (_, change, email, message) => {
      const web = run({
        DATABASE_URL: database(),
        API_URL: "http://127.0.0.1:9",
        WEB_ORIGIN: "https://abolish.test",
        ACCOUNT_SECRET: SECRET,
        TURNSTILE_SECRET_KEY: "turnstile-secret",
        ...(email ? EMAIL : {}),
        ...change,
      });
      const [code] = (await once(web.child, "exit")) as [number];
      expect(code).not.toBe(0);
      expect(web.err()).toContain(message);
      expect(web.err()).not.toContain(change.VAPID_SECRET_KEY);
    },
    30_000,
  );

  test("refuses part of a phone configuration, quoting none of it", async () => {
    const { PHONE_DAILY_CEILING: _, ...partial } = PHONE;
    const web = run({
      DATABASE_URL: database(),
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      ...partial,
    });
    const [code] = (await once(web.child, "exit")) as [number];
    expect(code).not.toBe(0);
    expect(web.err()).toContain("PHONE_DAILY_CEILING go together");
    for (const value of Object.values(partial)) expect(web.err()).not.toContain(value.slice(3));
  }, 30_000);

  test("refuses a key whose bytes differ from those its ID was first seen with, quoting none of it", async () => {
    const start = (keys: string) =>
      run({
        DATABASE_URL: database(),
        API_URL: "http://127.0.0.1:9",
        WEB_ORIGIN: "https://abolish.test",
        ACCOUNT_SECRET: SECRET,
        TURNSTILE_SECRET_KEY: "turnstile-secret",
        ...EMAIL,
        ...PHONE,
        PHONE_HASH_KEYS: keys,
      });
    // As if the first instance to hold `pz` had other bytes for it.
    await db.admin`INSERT INTO account_phone_key_checks VALUES ('pz', ${randomBytes(32)})`;
    const wrong = `pz:${randomBytes(32).toString("hex")}`;
    const web = start(wrong);
    const [code] = (await once(web.child, "exit")) as [number];
    expect(code).not.toBe(0);
    expect(web.err()).toContain("PHONE_HASH_KEYS: a key differs");
    expect(web.err()).not.toContain(wrong.slice(3));
  }, 60_000);

  test.each([
    // Values no line or column of the bundle's stack trace can contain.
    ["a malformed keyring", { PHONE_HASH_KEYS: "p1:notakeyatall" }, "PHONE_HASH_KEYS"],
    [
      "a key also in an e-mail keyring",
      { PHONE_HASH_KEYS: `p1:${EMAIL.EMAIL_HASH_KEYS.slice(3)}` },
      "PHONE_HASH_KEYS and the e-mail keyrings",
    ],
    ["a key SID that isn't one", { TWILIO_KEY_SID: `XX${"0".repeat(32)}` }, "keySid"],
    [
      "a service SID that isn't one",
      { TWILIO_VERIFY_SERVICE_SID: "VAnotaserviceid" },
      "verifyServiceSid",
    ],
  ])(
    "refuses %s, naming the variable and quoting none of it",
    async (_, change, name) => {
      const configured = { ...EMAIL, ...PHONE, ...change };
      const web = run({
        DATABASE_URL: database(),
        API_URL: "http://127.0.0.1:9",
        WEB_ORIGIN: "https://abolish.test",
        ACCOUNT_SECRET: SECRET,
        TURNSTILE_SECRET_KEY: "turnstile-secret",
        ...configured,
      });
      const [code] = (await once(web.child, "exit")) as [number];
      expect(code).not.toBe(0);
      expect(web.err()).toContain(name);
      for (const [variable, value] of Object.entries(configured))
        if (variable !== "EMAIL_FROM" && variable !== "PHONE_DAILY_CEILING")
          expect(web.err()).not.toContain(value.slice(3));
    },
    30_000,
  );

  test.each([
    [
      "part of a Tier 0 issuer configuration",
      { TIER0_GROUP: undefined },
      "TIER0_DEPLOYMENT_RECORD go together",
    ],
    ["a malformed issuer key", { TIER0_ISSUER_KEYS: `${PERIOD}:0123` }, "TIER0_ISSUER_KEYS"],
    [
      "an issuer key past its redemption window",
      { TIER0_ISSUER_KEYS: `${issuerKey(PERIOD - 2)},${issuerKey(PERIOD)}` },
      `period ${PERIOD - 2} no longer redeems`,
    ],
    [
      "an issuer key the deployment record lists otherwise",
      {
        TIER0_ISSUER_KEYS: `${issuerKey(PERIOD)},${issuerKey(PERIOD + 1)},${issuerKey(PERIOD + 9)}`,
      },
      `TIER0_DEPLOYMENT_RECORD: the deployment record lists no key for period ${PERIOD + 9}`,
    ],
    [
      "an issuer key the deployment record lists retired",
      { TIER0_DEPLOYMENT_RECORD: deploymentRecord(PERIOD + 1) },
      `TIER0_DEPLOYMENT_RECORD: the deployment record lists the key of period ${PERIOD + 1} retired`,
    ],
    [
      "another deployment's record",
      { TIER0_GROUP_REGISTRY: `0x${randomBytes(20).toString("hex")}` },
      "TIER0_DEPLOYMENT_RECORD: the deployment record names another group registry",
    ],
    [
      "a deployment record that isn't hex",
      { TIER0_DEPLOYMENT_RECORD: "0x0020" },
      "TIER0_DEPLOYMENT_RECORD",
    ],
    [
      "a registry that isn't an address",
      { TIER0_GROUP_REGISTRY: "0x0123" },
      "TIER0_GROUP_REGISTRY",
    ],
  ])(
    "refuses %s, naming the variable and quoting no key",
    async (_, change, name) => {
      const configured = { ...TIER0, ...change };
      const web = run({
        DATABASE_URL: database(),
        API_URL: "http://127.0.0.1:9",
        WEB_ORIGIN: "https://abolish.test",
        ACCOUNT_SECRET: SECRET,
        TURNSTILE_SECRET_KEY: "turnstile-secret",
        ...Object.fromEntries(
          Object.entries(configured).filter((e): e is [string, string] => e[1] !== undefined),
        ),
      });
      const [code] = (await once(web.child, "exit")) as [number];
      expect(code).not.toBe(0);
      expect(web.err()).toContain(name);
      for (const entry of (configured.TIER0_ISSUER_KEYS ?? "").split(","))
        expect(web.err()).not.toContain(entry.split(":")[1]!.slice(0, 8));
    },
    30_000,
  );
});

describe("link previews from the bundle", () => {
  const typical = (
    JSON.parse(
      readFileSync(
        new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
        "utf8",
      ),
    ) as { vectors: { id: string; value?: { election_id: string }; encoding: string }[] }
  ).vectors.find((v) => v.id === "definition-typical");
  if (typical?.value === undefined) throw new Error("vector missing");
  const id = typical.value.election_id;

  const view = definitionView(id, typical.encoding);
  if (!view.ok) throw new Error("vector doesn't decode");
  const code = shortCode(fromHex(view.poll.definitionHash));

  /** Just enough of the API for a poll page and its preview. */
  const api = createHttpServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const body: Record<string, unknown> = {
      "/elections/definition": { definition: typical.encoding },
      "/elections/code": { code },
      "/board/head": { treeSize: "1", chainHead: "1f".repeat(32), root: "2e".repeat(32) },
      "/moderation/status": { state: "visible" },
    };
    const known = url.searchParams.get("electionId") === id && url.pathname in body;
    res.writeHead(known ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(known ? body[url.pathname] : {}));
  });

  beforeAll(() => new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve)));
  afterAll(() => new Promise((resolve) => api.close(resolve)));

  test("renders the same PNG as the sources, with nothing from node_modules", async () => {
    const port = await freePort();
    const web = run({
      DATABASE_URL: database(),
      API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      TURNSTILE_SECRET_KEY: "turnstile-secret",
      TURNSTILE_SITE_KEY: SITE_KEY,
      WEB_PORT: String(port),
    });
    try {
      const at = `http://127.0.0.1:${port}`;
      let page: Response | undefined;
      for (let i = 0; i < 100 && page === undefined && web.child.exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        page = await fetch(`${at}/polls/${id}`).catch(() => undefined);
      }
      expect(page?.status).toBe(200);
      const image = /<meta property="og:image" content="([^"]+)"/.exec((await page?.text()) ?? "");
      const url = new URL(image?.[1]?.replaceAll("&amp;", "&") ?? "");
      expect(url.origin).toBe("https://abolish.test");
      const preview = await fetch(`${at}${url.pathname}${url.search}`);
      expect(web.err()).toBe("");
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("image/png");
      expect(preview.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(preview.headers.get("set-cookie")).toBeNull();
      const expected = await renderPreview(
        pollPreview(view.poll, code, "abolish.test", Date.now(), "en-US"),
        "landscape",
      );
      expect(new Uint8Array(await preview.arrayBuffer())).toEqual(expected);
    } finally {
      if (web.child.exitCode === null) {
        const exited = once(web.child, "exit");
        web.child.kill("SIGTERM");
        await exited;
      }
    }
  }, 60_000);
});

describe("the client bundle", () => {
  test("carries no analytics SDK, and reports errors only to our own origin", () => {
    const assets = join(pkg, "dist", "client", "assets");
    const code = readdirSync(assets)
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(assets, f), "utf8"))
      .join("\n");
    for (const sdk of ["posthog", "PostHog", "i.posthog.com", "phc_"])
      expect([sdk, code.includes(sdk)]).toEqual([sdk, false]);
    expect(code).toMatch(/[`"']\/ingest\/error[`"']/);
  });

  test("carries none of the link-preview renderer", () => {
    const assets = join(pkg, "dist", "client", "assets");
    for (const file of readdirSync(assets)) {
      expect([file, /\.(wasm|woff)$/.test(file)]).toEqual([file, false]);
      if (!file.endsWith(".js")) continue;
      const code = readFileSync(join(assets, file), "utf8");
      for (const marker of ["AGFzbQ", "d09GRg", "initWasm", "satori"])
        expect([file, marker, code.includes(marker)]).toEqual([file, marker, false]);
    }
  });

  test("carries none of the account system's server code", () => {
    const assets = join(pkg, "dist", "client", "assets");
    for (const file of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
      const code = readFileSync(join(assets, file), "utf8");
      for (const server of ["BETTER_AUTH_TELEMETRY", "account_passkeys", "drizzle", "DATABASE_URL"])
        expect([file, code.includes(server)]).toEqual([file, false]);
    }
  });
});
