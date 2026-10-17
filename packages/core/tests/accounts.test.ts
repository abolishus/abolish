import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  ACCOUNT_COOKIE_PREFIX,
  accountCredentials,
  accountPasskeys,
  accountSessions,
  accountUsers,
  accountVerifications,
  ACCOUNT_ROUTES,
  type AccountLogLine,
  type Accounts,
  createAccounts,
  MAX_ACCOUNT_BODY,
  newAccountId,
  pruneAccountVerifications,
  type Turnstile,
  type TurnstileAction,
  TURNSTILE_HEADER,
  type TurnstileVerdict,
} from "../src/index.ts";
import {
  type AuthenticationOptions,
  type RegistrationOptions,
  SoftAuthenticator,
} from "./authenticator.ts";
import { type TestDb, testDb } from "./db.ts";

// Accounts end to end through the handler apps/web serves, with a software
// authenticator (tests/authenticator.ts) and the app role's grants (T-10).

const ORIGIN = "https://abolish.test";
const RP_ID = "abolish.test";
const SECRET = "test-secret-test-secret-test-secret-0123456789";
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
let accounts: Accounts;
const logged: AccountLogLine[] = [];

/** A token the stand-in Turnstile passes for any action; real verification is tests/turnstile.test.ts. */
const TOKEN = "test-token";
/** Tokens the stand-in has seen, with their action, and what it answers next. */
const turnstileCalls: [string | null, TurnstileAction][] = [];
let turnstileAnswer: TurnstileVerdict | undefined;
const turnstile: Turnstile = {
  verify: async (token, action) => {
    turnstileCalls.push([token, action]);
    return turnstileAnswer ?? (token === TOKEN ? "passed" : "refused");
  },
};

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  accounts = createAccounts({
    sql: app,
    secret: SECRET,
    origin: ORIGIN,
    rpID: RP_ID,
    turnstile,
    log: (line) => logged.push(line),
  });
});
afterAll(() => db?.close());

/** A browser's cookies for ORIGIN. */
class Jar {
  readonly cookies = new Map<string, string>();
  readonly set: string[] = [];

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  take(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      this.set.push(c);
      const [pair] = c.split(";", 1);
      const eq = pair!.indexOf("=");
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === "" || /;\s*max-age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
}

async function call(
  jar: Jar,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const h = new Headers({ origin: ORIGIN, [TURNSTILE_HEADER]: TOKEN, ...headers });
  if (jar.cookies.size) h.set("cookie", jar.header());
  if (body !== undefined) h.set("content-type", "application/json");
  const res = await accounts.handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: h,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  jar.take(res);
  return res;
}

async function signUp(jar: Jar, device: SoftAuthenticator, uv = true): Promise<Response> {
  const options = await call(jar, "GET", "/auth/passkey/generate-register-options");
  expect(options.status).toBe(200);
  const response = device.create((await options.json()) as RegistrationOptions, {
    uv,
    origin: ORIGIN,
  });
  return call(jar, "POST", "/auth/passkey/verify-registration", { response, createSession: true });
}

async function signIn(
  jar: Jar,
  device: SoftAuthenticator,
  { uv = true, origin = ORIGIN, index = 0 } = {},
): Promise<Response> {
  const options = await call(jar, "GET", "/auth/passkey/generate-authenticate-options");
  expect(options.status).toBe(200);
  const response = device.get(
    (await options.json()) as AuthenticationOptions,
    { uv, origin },
    index,
  );
  return call(jar, "POST", "/auth/passkey/verify-authentication", { response });
}

const SESSION = `__Secure-${ACCOUNT_COOKIE_PREFIX}.session_token`;
const count = async (table: string) =>
  (await db.admin.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0]!["n"] as number;

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    const tables: PgTable[] = [
      accountUsers,
      accountSessions,
      accountPasskeys,
      accountCredentials,
      accountVerifications,
    ];
    for (const table of tables) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect([
        config.name,
        cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]]),
      ]).toEqual([
        config.name,
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      ]);
    }
  });

  test("the app role can't write passwords or tokens, or truncate anything", async () => {
    const privs = await db.admin`
      SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS p
      FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND grantee = 'abolish_app' AND table_name LIKE 'account_%'
      GROUP BY table_name ORDER BY table_name`;
    expect(privs.map((r) => [r["table_name"], r["p"]])).toEqual([
      // Plus UPDATE of some columns (appeals.test.ts).
      ["account_appeals", "INSERT,SELECT"],
      ["account_credentials", "DELETE,SELECT"],
      ["account_moderators", "INSERT,SELECT"],
      ["account_passkeys", "DELETE,INSERT,SELECT,UPDATE"],
      // Append-only: a submission counts for its 24 hours (poll-failures.test.ts).
      ["account_poll_submissions", "INSERT,SELECT"],
      ["account_polls", "DELETE,INSERT,SELECT,UPDATE"],
      ["account_sessions", "DELETE,INSERT,SELECT,UPDATE"],
      ["account_users", "DELETE,INSERT,SELECT,UPDATE"],
      ["account_verifications", "DELETE,INSERT,SELECT,UPDATE"],
    ]);
    const owner = await db.as("abolish_migrator");
    const [user] = await owner`
      INSERT INTO account_users VALUES (${newAccountId()}, ${`${newAccountId()}@account.invalid`},
        false, '', NULL, now(), now()) RETURNING id`;
    await expect(
      owner`INSERT INTO account_credentials (id, user_id, account_id, provider_id, password, created_at, updated_at)
        VALUES ('x', ${user!["id"]}, 'x', 'credential', 'hash', now(), now())`,
    ).rejects.toThrow(/check constraint/);
    await owner`DELETE FROM account_users WHERE id = ${user!["id"]}`;
  });
});

describe("sign-up and sign-in by passkey", () => {
  test("registering a passkey creates an account that holds nothing about the person", async () => {
    const jar = new Jar();
    const res = await signUp(jar, new SoftAuthenticator(RP_ID));
    expect(res.status).toBe(200);
    expect(jar.cookies.has(SESSION)).toBe(true);
    const id = await accounts.accountOf(new Headers({ cookie: jar.header() }));
    expect(id).toMatch(/^[a-z0-9]{32}$/);
    const [user] = await db.admin`SELECT * FROM account_users WHERE id = ${id!}`;
    expect(user!["email"]).toMatch(/^[a-z0-9]{32}@account\.invalid$/);
    expect(user!["name"]).toBe("");
    expect(user!["image"]).toBeNull();
    expect(user!["email_verified"]).toBe(false);
  });

  test("a passkey signs in again after signing out", async () => {
    const jar = new Jar();
    const device = new SoftAuthenticator(RP_ID);
    await signUp(jar, device);
    const id = await accounts.accountOf(new Headers({ cookie: jar.header() }));
    expect((await call(jar, "POST", "/auth/sign-out", {})).status).toBe(200);
    expect(await accounts.accountOf(new Headers({ cookie: jar.header() }))).toBeUndefined();
    expect((await signIn(jar, device)).status).toBe(200);
    expect(await accounts.accountOf(new Headers({ cookie: jar.header() }))).toBe(id);
  });

  test("a signed-in user's new passkey joins their account rather than making another", async () => {
    const jar = new Jar();
    const device = new SoftAuthenticator(RP_ID);
    await signUp(jar, device);
    const id = await accounts.accountOf(new Headers({ cookie: jar.header() }));
    const users = await count("account_users");
    expect((await signUp(jar, device)).status).toBe(200);
    expect(await count("account_users")).toBe(users);
    const [{ n }] = (await db.admin`
      SELECT count(*)::int AS n FROM account_passkeys WHERE user_id = ${id!}`) as unknown as [
      { n: number },
    ];
    expect(n).toBe(2);
    const other = new Jar();
    expect((await signIn(other, device, { index: 1 })).status).toBe(200);
    expect(await accounts.accountOf(new Headers({ cookie: other.header() }))).toBe(id);
  });

  test("registration without user verification creates nothing", async () => {
    const users = await count("account_users");
    const passkeys = await count("account_passkeys");
    const jar = new Jar();
    const res = await signUp(jar, new SoftAuthenticator(RP_ID), false);
    expect(res.status).toBe(401);
    expect(jar.cookies.has(SESSION)).toBe(false);
    expect(await count("account_users")).toBe(users);
    expect(await count("account_passkeys")).toBe(passkeys);
  });

  test("sign-in without user verification is refused", async () => {
    const jar = new Jar();
    const device = new SoftAuthenticator(RP_ID);
    await signUp(jar, device);
    await call(jar, "POST", "/auth/sign-out", {});
    expect((await signIn(jar, device, { uv: false })).status).toBe(401);
    expect(jar.cookies.has(SESSION)).toBe(false);
  });

  test("an assertion made for another origin is refused", async () => {
    const jar = new Jar();
    const device = new SoftAuthenticator(RP_ID);
    await signUp(jar, device);
    await call(jar, "POST", "/auth/sign-out", {});
    const res = await signIn(jar, device, { origin: "https://ballot.abolish.test" });
    expect(res.status).toBe(400);
    expect(jar.cookies.has(SESSION)).toBe(false);
  });

  test("a replayed assertion is refused", async () => {
    const jar = new Jar();
    const device = new SoftAuthenticator(RP_ID);
    await signUp(jar, device);
    await call(jar, "POST", "/auth/sign-out", {});
    const options = await call(jar, "GET", "/auth/passkey/generate-authenticate-options");
    const response = device.get((await options.json()) as AuthenticationOptions, {
      origin: ORIGIN,
    });
    const first = await call(jar, "POST", "/auth/passkey/verify-authentication", { response });
    expect(first.status).toBe(200);
    await call(jar, "POST", "/auth/sign-out", {});
    // The challenge was consumed: the same assertion can't be used twice.
    const again = await call(jar, "POST", "/auth/passkey/verify-authentication", { response });
    expect(again.status).toBe(400);
    expect(jar.cookies.has(SESSION)).toBe(false);
  });
});

describe("adding a passkey to an account", () => {
  test("a ceremony begun signed in can't attach a passkey after sign-out (shared browser)", async () => {
    const jar = new Jar();
    await signUp(jar, new SoftAuthenticator(RP_ID));
    const id = (await accounts.accountOf(new Headers({ cookie: jar.header() })))!;
    const options = await call(jar, "GET", "/auth/passkey/generate-register-options");
    await call(jar, "POST", "/auth/sign-out", {});
    const response = new SoftAuthenticator(RP_ID).create(
      (await options.json()) as RegistrationOptions,
      { origin: ORIGIN },
    );
    const res = await call(jar, "POST", "/auth/passkey/verify-registration", {
      response,
      createSession: true,
    });
    expect(res.status).toBe(401);
    expect(jar.cookies.has(SESSION)).toBe(false);
    const [{ n }] = (await db.admin`
      SELECT count(*)::int AS n FROM account_passkeys WHERE user_id = ${id}`) as unknown as [
      { n: number },
    ];
    expect(n).toBe(1);
  });

  test("a session more than a day old can't add a passkey", async () => {
    const jar = new Jar();
    await signUp(jar, new SoftAuthenticator(RP_ID));
    const id = (await accounts.accountOf(new Headers({ cookie: jar.header() })))!;
    await db.admin`
      UPDATE account_sessions SET created_at = now() - interval '25 hours' WHERE user_id = ${id}`;
    expect((await signUp(jar, new SoftAuthenticator(RP_ID))).status).toBe(401);
  });

  test("a ceremony begun signed out can't finish in someone else's session", async () => {
    const jar = new Jar();
    const options = await call(jar, "GET", "/auth/passkey/generate-register-options");
    const signedIn = new Jar();
    await signUp(signedIn, new SoftAuthenticator(RP_ID));
    for (const [k, v] of signedIn.cookies) if (k === SESSION) jar.cookies.set(k, v);
    const response = new SoftAuthenticator(RP_ID).create(
      (await options.json()) as RegistrationOptions,
      { origin: ORIGIN },
    );
    const res = await call(jar, "POST", "/auth/passkey/verify-registration", {
      response,
      createSession: true,
    });
    expect(res.status).toBe(401);
  });

  test("a registration made for another origin creates nothing", async () => {
    const users = await count("account_users");
    const jar = new Jar();
    const options = await call(jar, "GET", "/auth/passkey/generate-register-options");
    const response = new SoftAuthenticator(RP_ID).create(
      (await options.json()) as RegistrationOptions,
      { origin: "https://ballot.abolish.test" },
    );
    const res = await call(jar, "POST", "/auth/passkey/verify-registration", {
      response,
      createSession: true,
    });
    // SimpleWebAuthn throws, and the plugin answers that with 500.
    expect(res.ok).toBe(false);
    expect(await count("account_users")).toBe(users);
  });
});

describe("what is kept (T-10, T-11)", () => {
  test("sessions keep no address or user agent, whatever the request carries", async () => {
    const jar = new Jar();
    const headers = {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) TestBrowser/1.0",
      "x-forwarded-for": "203.0.113.7",
      "x-real-ip": "203.0.113.7",
      "cf-connecting-ip": "203.0.113.7",
    };
    const device = new SoftAuthenticator(RP_ID);
    const options = await call(
      jar,
      "GET",
      "/auth/passkey/generate-register-options",
      undefined,
      headers,
    );
    const response = device.create((await options.json()) as RegistrationOptions, {
      origin: ORIGIN,
    });
    await call(
      jar,
      "POST",
      "/auth/passkey/verify-registration",
      { response, createSession: true },
      headers,
    );
    await call(jar, "POST", "/auth/sign-out", {}, headers);
    await signIn(jar, device);
    const rows = await db.admin`SELECT ip_address, user_agent FROM account_sessions`;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r["ip_address"] !== null || r["user_agent"] !== null)).toEqual([]);
    const dump = JSON.stringify(
      await db.admin`
        SELECT * FROM account_users, account_sessions, account_passkeys, account_verifications`,
    );
    expect(dump).not.toContain("203.0.113.7");
    expect(dump).not.toContain("TestBrowser");
  });

  test("the database refuses an address, a user agent, an e-mail address or a name", async () => {
    const jar = new Jar();
    await signUp(jar, new SoftAuthenticator(RP_ID));
    const id = (await accounts.accountOf(new Headers({ cookie: jar.header() })))!;
    for (const change of [
      app`UPDATE account_sessions SET ip_address = '203.0.113.7' WHERE user_id = ${id}`,
      app`UPDATE account_sessions SET user_agent = 'x' WHERE user_id = ${id}`,
      app`UPDATE account_users SET email = 'someone@example.com' WHERE id = ${id}`,
      app`UPDATE account_users SET name = 'Someone' WHERE id = ${id}`,
      app`UPDATE account_users SET image = 'https://example.com/a.png' WHERE id = ${id}`,
      app`UPDATE account_users SET email_verified = true WHERE id = ${id}`,
    ])
      await expect(change).rejects.toThrow(/check constraint/);
  });

  test("a passkey name or a ceremony context is refused, not stored", async () => {
    const jar = new Jar();
    const named = await call(jar, "GET", "/auth/passkey/generate-register-options");
    const response = new SoftAuthenticator(RP_ID).create(
      (await named.json()) as RegistrationOptions,
      { origin: ORIGIN },
    );
    const res = await call(jar, "POST", "/auth/passkey/verify-registration", {
      response,
      createSession: true,
      name: "Jane's phone",
    });
    expect(res.status).toBe(400);
    const ctx = await call(
      new Jar(),
      "GET",
      "/auth/passkey/generate-register-options?context=jane%40example.com",
    );
    expect(ctx.status).toBe(400);
    const dump = JSON.stringify(
      await db.admin`SELECT * FROM account_passkeys, account_verifications`,
    );
    expect(dump).not.toContain("Jane");
    expect(dump).not.toContain("jane@example.com");
    await expect(app`UPDATE account_passkeys SET name = 'x'`).rejects.toThrow(/check constraint/);
  });

  test("expired challenges are pruned, live ones kept", async () => {
    await call(new Jar(), "GET", "/auth/passkey/generate-authenticate-options");
    const live = await count("account_verifications");
    expect(live).toBeGreaterThan(0);
    // Pruning at the earliest expiry deletes nothing: only rows expired before `now` go.
    const [{ first }] = (await db.admin`
      SELECT min(expires_at) AS first FROM account_verifications`) as unknown as [{ first: Date }];
    expect(await pruneAccountVerifications(app, first)).toBe(0);
    expect(await count("account_verifications")).toBe(live);
    const later = new Date(Date.now() + 10 * 60 * 1000);
    expect(await pruneAccountVerifications(app, later)).toBe(live);
    expect(await count("account_verifications")).toBe(0);
  });

  test("better-auth's warnings and errors are logged by level only", () => {
    for (const line of logged) expect([["auth"], ["turnstile"]]).toContainEqual(Object.keys(line));
  });
});

describe("routes", () => {
  test("only the listed routes reach better-auth", async () => {
    for (const path of [
      "/auth/sign-up/email",
      "/auth/sign-in/email",
      "/auth/sign-in/social",
      "/auth/update-user",
      "/auth/change-email",
      "/auth/list-accounts",
      "/auth/ok",
      "/auth/error",
      "/auth/reference/openapi.json",
      "/auth/passkey/generate-register-options/",
      "/auth/passkey/update-passkey",
      "/elsewhere",
    ])
      for (const method of ["GET", "POST"] as const) {
        const res = await call(new Jar(), method, path, method === "POST" ? {} : undefined);
        expect([path, method, res.status]).toEqual([path, method, 404]);
      }
  });

  test("every listed route exists in better-auth", async () => {
    for (const route of ACCOUNT_ROUTES) {
      const [method, path] = route.split(" ") as ["GET" | "POST", string];
      const res = await call(new Jar(), method, path, method === "POST" ? {} : undefined);
      expect([route, res.status]).not.toEqual([route, 404]);
    }
  });

  test("a body over the bound is refused before better-auth reads it", async () => {
    const big = { response: "x".repeat(MAX_ACCOUNT_BODY) };
    expect((await call(new Jar(), "POST", "/auth/passkey/verify-authentication", big)).status).toBe(
      413,
    );
    const chunked = new Request(`${ORIGIN}/auth/passkey/verify-authentication`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          for (let i = 0; i < 5; i++) c.enqueue(new Uint8Array(MAX_ACCOUNT_BODY / 4));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect((await accounts.handler(chunked)).status).toBe(413);
  });

  test("a request from another origin can't act on a session", async () => {
    const jar = new Jar();
    await signUp(jar, new SoftAuthenticator(RP_ID));
    const res = await call(jar, "POST", "/auth/sign-out", {}, { origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(await accounts.accountOf(new Headers({ cookie: jar.header() }))).toBeDefined();
  });
});

describe("cookies", () => {
  test("every cookie is secure, host-only, HttpOnly and SameSite=Strict, under the account prefix", async () => {
    const jar = new Jar();
    const device = new SoftAuthenticator(RP_ID);
    await signUp(jar, device);
    await call(jar, "POST", "/auth/sign-out", {});
    await signIn(jar, device);
    expect(jar.set.length).toBeGreaterThan(0);
    for (const c of jar.set) {
      expect(c.startsWith(`__Secure-${ACCOUNT_COOKIE_PREFIX}.`)).toBe(true);
      expect(c).toMatch(/;\s*Secure/i);
      expect(c).toMatch(/;\s*HttpOnly/i);
      expect(c).toMatch(/;\s*SameSite=Strict/i);
      expect(c).not.toMatch(/;\s*Domain=/i);
    }
  });
});

describe("account deletion", () => {
  test("deleting an account removes its passkeys and sessions", async () => {
    const jar = new Jar();
    const device = new SoftAuthenticator(RP_ID);
    await signUp(jar, device);
    const id = (await accounts.accountOf(new Headers({ cookie: jar.header() })))!;
    expect((await call(jar, "POST", "/auth/delete-user", {})).status).toBe(200);
    for (const table of ["account_users", "account_sessions", "account_passkeys"]) {
      const col = table === "account_users" ? "id" : "user_id";
      const [{ n }] = (await db.admin.unsafe(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = $1`,
        [id],
      )) as unknown as [{ n: number }];
      expect([table, n]).toEqual([table, 0]);
    }
    await call(jar, "POST", "/auth/sign-out", {});
    expect((await signIn(jar, device)).status).toBe(401);
  });
});

describe("Turnstile on ceremony starts (T-01, T-52)", () => {
  const STARTS = [
    ["/auth/passkey/generate-register-options", "passkey-register"],
    ["/auth/passkey/generate-authenticate-options", "passkey-authenticate"],
  ] as const;

  test("each ceremony start is checked for its own action, and refused without a pass, writing nothing", async () => {
    for (const [path, action] of STARTS) {
      turnstileCalls.length = 0;
      expect((await call(new Jar(), "GET", path)).status).toBe(200);
      expect(turnstileCalls).toEqual([[TOKEN, action]]);
      const before = await count("account_verifications");
      for (const headers of [{ [TURNSTILE_HEADER]: "wrong" }, { [TURNSTILE_HEADER]: "" }]) {
        const res = await call(new Jar(), "GET", path, undefined, headers);
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ code: "TURNSTILE_REFUSED", status: 403 });
        expect(res.headers.getSetCookie()).toEqual([]);
      }
      const bare = new Headers({ origin: ORIGIN });
      const missing = await accounts.handler(new Request(`${ORIGIN}${path}`, { headers: bare }));
      expect(missing.status).toBe(403);
      expect(turnstileCalls.at(-1)).toEqual([null, action]);
      expect(await count("account_verifications")).toBe(before);
    }
  });

  test("a signed-in session still needs a pass to add a passkey", async () => {
    const jar = new Jar();
    await signUp(jar, new SoftAuthenticator(RP_ID));
    const res = await call(jar, "GET", STARTS[0][0], undefined, { [TURNSTILE_HEADER]: "wrong" });
    expect(res.status).toBe(403);
  });

  test("Turnstile unreachable: 503, logged by kind, and nothing written", async () => {
    const before = await count("account_verifications");
    turnstileAnswer = "unavailable";
    try {
      for (const [path] of STARTS) {
        logged.length = 0;
        const res = await call(new Jar(), "GET", path);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({ code: "TURNSTILE_UNAVAILABLE", status: 503 });
        expect(logged).toEqual([{ turnstile: "unavailable" }]);
      }
    } finally {
      turnstileAnswer = undefined;
    }
    expect(await count("account_verifications")).toBe(before);
  });

  test("no other route asks for a token", async () => {
    turnstileCalls.length = 0;
    for (const route of ACCOUNT_ROUTES) {
      const [method, path] = route.split(" ") as ["GET" | "POST", string];
      if (STARTS.some(([start]) => start === path)) continue;
      await call(new Jar(), method, path, method === "POST" ? {} : undefined, {
        [TURNSTILE_HEADER]: "wrong",
      });
    }
    expect(turnstileCalls).toEqual([]);
  });
});

describe("createAccounts", () => {
  const base = () => ({
    sql: app,
    secret: SECRET,
    origin: ORIGIN,
    rpID: RP_ID,
    turnstile,
    log: () => {},
  });

  test("refuses to start when better-auth's telemetry is switched on by environment", () => {
    for (const value of ["1", "true", "yes"]) {
      process.env["BETTER_AUTH_TELEMETRY"] = value;
      try {
        expect(() => createAccounts(base())).toThrow(/BETTER_AUTH_TELEMETRY/);
      } finally {
        delete process.env["BETTER_AUTH_TELEMETRY"];
      }
    }
  });

  test("refuses an origin that isn't a bare https origin, and an RP ID it can't use", () => {
    for (const origin of ["http://abolish.test", "https://abolish.test/", "https://abolish.test/x"])
      expect(() => createAccounts({ ...base(), origin })).toThrow(/origin/);
    for (const rpID of ["evil.test", "bolish.test", "ballot.abolish.test"])
      expect(() => createAccounts({ ...base(), rpID })).toThrow(/rpID/);
    expect(() => createAccounts({ ...base(), secret: "short" })).toThrow(/secret/);
  });

  test("account IDs are 32 characters of [a-z0-9] and don't repeat", () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(fc.constant(null), () => {
        const id = newAccountId();
        expect(id).toMatch(/^[a-z0-9]{32}$/);
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }),
      { numRuns },
    );
  });
});
