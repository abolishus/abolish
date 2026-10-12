// What the image will run (P2-11): dist/ copied away from the repository, so
// nothing resolves through node_modules, run by plain Node as a login granted
// only abolish_app. dist/node/main.mjs serves the built pages, the hashed
// assets and the account handler.

import { type TestDb, testDb } from "@abolishus/core/test-db";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBuilder } from "vite-plus";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

const pkg = fileURLToPath(new URL("..", import.meta.url));
const url = new URL(process.env["TEST_DATABASE_URL"] ?? "");
const password = randomBytes(16).toString("hex");
const SECRET = randomBytes(32).toString("hex");

let db: TestDb;
let dir: string;
let login: string;

beforeAll(async () => {
  const builder = await createBuilder({ root: pkg, logLevel: "warn" });
  await builder.buildApp();
  dir = mkdtempSync(join(tmpdir(), "abolish-web-image-"));
  cpSync(join(pkg, "dist", "server"), join(dir, "server"), { recursive: true });
  cpSync(join(pkg, "dist", "client"), join(dir, "client"), { recursive: true });
  execFileSync("vp", ["pack", "--out-dir", join(dir, "node")], { cwd: pkg, stdio: "inherit" });
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

describe("dist/node/main.mjs", () => {
  test("serves pages, their assets and the account handler, from the bundle alone", async () => {
    const port = await freePort();
    const web = run({
      DATABASE_URL: database(),
      // Nothing here calls the API: the home page and the account page don't.
      API_URL: "http://127.0.0.1:9",
      WEB_ORIGIN: "https://abolish.test",
      ACCOUNT_SECRET: SECRET,
      WEB_PORT: String(port),
    });
    try {
      const at = `http://127.0.0.1:${port}`;
      let home: Response | undefined;
      for (let i = 0; i < 100 && home === undefined && web.child.exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        home = await fetch(`${at}/`).catch(() => undefined);
      }
      expect(web.err()).toBe("");
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
      const account = await fetch(`${at}/account`);
      expect(account.status).toBe(200);
      expect(await account.text()).toContain('<meta name="robots" content="noindex"');
      // A query that reached the session table as abolish_app: a missing
      // table or grant would be a 500.
      const session = await fetch(`${at}/auth/get-session`, {
        headers: { cookie: "__Secure-abolish-account.session_token=x.y" },
      });
      expect(session.status).toBe(200);
      expect(await session.json()).toBeNull();
      // Its log: one line per request, by route class, written once each
      // answer is sent.
      await new Promise((r) => setTimeout(r, 100));
      const lines = web
        .out()
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { route?: string });
      expect(lines.map((l) => l.route)).toContain("auth");
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
    });
    const [code] = (await once(web.child, "exit")) as [number];
    expect(code).not.toBe(0);
    expect(web.err()).toContain("ACCOUNT_SECRET");
    expect(web.err()).not.toContain(password);
  }, 30_000);
});

describe("the client bundle", () => {
  test("carries none of the account system's server code", () => {
    const assets = join(pkg, "dist", "client", "assets");
    for (const file of readdirSync(assets).filter((f) => f.endsWith(".js"))) {
      const code = readFileSync(join(assets, file), "utf8");
      for (const server of ["BETTER_AUTH_TELEMETRY", "account_passkeys", "drizzle", "DATABASE_URL"])
        expect([file, code.includes(server)]).toEqual([file, false]);
    }
  });
});
