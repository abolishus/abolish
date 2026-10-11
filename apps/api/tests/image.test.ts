import { loadMigrations } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

// What the image runs (Dockerfile): the bundle in dist/, copied away from the
// repository so nothing resolves through node_modules, run by plain Node as
// the deployment runs it (docs/runbooks/railway.md): migrate.mjs as a login
// granted abolish_migrator, main.mjs as a login granted only abolish_app.

const pkg = fileURLToPath(new URL("..", import.meta.url));
const url = new URL(process.env["TEST_DATABASE_URL"] ?? "");

let db: TestDb;
let dir: string;
let schema: string;
let login: string;
let migrator: string;
const password = randomBytes(16).toString("hex");

beforeAll(async () => {
  // Packed straight into a directory outside the repository, so nothing
  // resolves through node_modules and a concurrent build's dist/ is untouched.
  dir = mkdtempSync(join(tmpdir(), "abolish-api-image-"));
  execFileSync("vp", ["pack", "--out-dir", dir], { cwd: pkg, stdio: "inherit" });
  db = await testDb();
  // A schema of our own, unmigrated: testDb's is migrated already.
  schema = `${db.schema}_image`;
  login = `${db.schema}_api`;
  migrator = `${db.schema}_migrate`;
  await db.admin.unsafe(`CREATE SCHEMA "${schema}" AUTHORIZATION abolish_migrator`);
  await db.admin.unsafe(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' IN ROLE abolish_app`);
  await db.admin.unsafe(`ALTER ROLE "${login}" SET search_path = "${schema}"`);
  await db.admin.unsafe(
    `CREATE ROLE "${migrator}" LOGIN PASSWORD '${password}' IN ROLE abolish_migrator`,
  );
}, 60_000);
afterAll(async () => {
  await db?.admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await db?.admin.unsafe(`DROP ROLE IF EXISTS "${login}"`);
  await db?.admin.unsafe(`DROP ROLE IF EXISTS "${migrator}"`);
  await db?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** TEST_DATABASE_URL, logged in as `user`. */
function as(user: string): string {
  const u = new URL(url.href);
  u.username = user;
  u.password = password;
  return u.href;
}

/** Runs `file` from the copied bundle with exactly `env`. */
function run(file: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [file], {
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

async function migrateOnce(): Promise<string[]> {
  const m = run("migrate.mjs", { DATABASE_URL: as(migrator), DATABASE_SCHEMA: schema });
  const [code] = (await once(m.child, "exit")) as [number];
  expect(m.err()).toBe("");
  expect(code).toBe(0);
  return (JSON.parse(m.out()) as { migrations: string[] }).migrations;
}

describe("the bundle", () => {
  test("migrate.mjs, as a login granted abolish_migrator, applies the migrations it ships, once, owned by the group role", async () => {
    expect(await migrateOnce()).toEqual(loadMigrations().map((m) => m.name));
    const owners = await db.admin<{ tableowner: string }[]>`
      SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = ${schema}`;
    expect(owners.map((r) => r.tableowner)).toEqual(["abolish_migrator"]);
    expect(await migrateOnce()).toEqual([]);
  }, 30_000);

  test("migrate.mjs refuses a schema name that isn't a plain identifier", async () => {
    const m = run("migrate.mjs", { DATABASE_URL: as(migrator), DATABASE_SCHEMA: 'x"; DROP' });
    const [code] = (await once(m.child, "exit")) as [number];
    expect(code).not.toBe(0);
    expect(m.err()).toContain("DATABASE_SCHEMA");
  }, 30_000);

  test("main.mjs serves from the migrated schema as a login granted only abolish_app", async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));
    const api = run("main.mjs", { DATABASE_URL: as(login), API_PORT: String(port) });
    try {
      // An unknown election is a 404 only if the query reached the table; a
      // missing table or grant would be a 500.
      const head = `http://127.0.0.1:${port}/board/head?electionId=${"00".repeat(32)}`;
      let status = 0;
      for (let i = 0; i < 100 && status === 0 && api.child.exitCode === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        status = await fetch(head).then(
          (r) => r.status,
          () => 0,
        );
      }
      expect(api.err()).toBe("");
      expect(status).toBe(404);
    } finally {
      if (api.child.exitCode === null) {
        const exited = once(api.child, "exit");
        api.child.kill("SIGTERM");
        await exited;
      }
    }
  }, 30_000);
});

describe("the Dockerfile", () => {
  const dockerfile = readFileSync(join(pkg, "Dockerfile"), "utf8");

  test("builds on the repository's Node, pinned by digest", () => {
    const node = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();
    const from = dockerfile.match(/^FROM (\S+)$/m)?.[1] ?? "";
    expect(from).toMatch(
      new RegExp(`:${node.replaceAll(".", "\\.")}-[a-z-]+@sha256:[0-9a-f]{64}$`),
    );
  });
});
