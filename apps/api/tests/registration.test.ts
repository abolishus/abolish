import { spawn } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { BN254_R } from "@abolishus/crypto";
import {
  tier0Keys,
  Tier0Registrations,
  type Turnstile,
  type TurnstileVerdict,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { createApiServer, type RequestLogLine } from "../src/index.ts";

// Tier 0 registration over HTTP (docs/spec/registration.md, Request and
// Answers), against a live Redis: each step's answer and status, the same
// empty answer for every accepted request, and a request log that never
// carries the commitment or the token (T-10, T-11, T-13). Core's own tests
// cover the queue in depth.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const NOW = 1_800_000_000;
const prefix = `test-api-tier0-${process.pid}-${Date.now()}`;
const keys = tier0Keys(prefix);

let db: TestDb;
let app: Sql;
let redis: Redis;
let verdict: TurnstileVerdict;
const tokens: (string | null)[] = [];
const turnstile: Turnstile = {
  verify(token) {
    tokens.push(token);
    return Promise.resolve(verdict);
  },
};
const servers: Server[] = [];
const logs: unknown[] = [];
let base: string;
let bare: string;

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  redis = new Redis(redisUrl);
  const tier0 = new Tier0Registrations({
    redis,
    groups: new Map([[0, 3n]]),
    turnstile,
    now: () => NOW,
    prefix,
  });
  base = await listen(createApiServer({ sql: app, tier0, log: (l) => logs.push(l) }));
  bare = await listen(createApiServer({ sql: app, log: () => {} }));
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await redis?.del(...Object.values(keys));
  await redis?.quit();
  await db?.close();
});
beforeEach(async () => {
  verdict = "passed";
  tokens.length = 0;
  await redis.del(...Object.values(keys));
  await redis.set(keys.indexed, String(NOW));
});

const hex = (v: bigint) => v.toString(16).padStart(64, "0");
const valid = (commitment = hex(0xabcn)) => ({ commitment, region: "0", turnstile: "tok.en-1_" });
const register = (body: unknown, at = base) =>
  fetch(`${at}/registrations/tier0`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function answer(r: Response) {
  const body = (await r.json()) as Record<string, unknown>;
  return { status: r.status, code: body["code"], data: body["data"] };
}

describe("registrations.tier0", () => {
  test("queues a commitment and answers 200 with an empty object", async () => {
    const r = await register(valid());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    expect(tokens).toEqual(["tok.en-1_"]);
    expect(await redis.hgetall(keys.queue)).toEqual({ [hex(0xabcn)]: "3" });
  });

  test("answers a queued, live or in-flight commitment exactly as a new one", async () => {
    await redis.sadd(keys.live, hex(1000n));
    await redis.sadd(keys.inflight, hex(1001n));
    await register(valid(hex(1002n)));
    const answers = [];
    for (const c of [1000n, 1001n, 1002n, 1003n]) {
      const r = await register(valid(hex(c)));
      answers.push({ status: r.status, body: await r.text() });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(
      new Set([JSON.stringify({ status: 200, body: "{}" })]),
    );
    expect(Object.keys(await redis.hgetall(keys.queue)).sort()).toEqual(
      [hex(1002n), hex(1003n)].sort(),
    );
  });

  test("a body outside the forms is refused as every route's input is, spending no token", async () => {
    for (const body of [
      { ...valid(), commitment: hex(0xabcn).toUpperCase() },
      { ...valid(), region: "01" },
      { ...valid(), turnstile: "" },
      { ...valid(), extra: "1" },
      { commitment: hex(5n), region: "0" },
    ])
      expect((await answer(await register(body))).status).toBe(400);
    expect(tokens).toEqual([]);
  });

  test("each later step has its own answer, and none before Turnstile spends the token", async () => {
    expect(await answer(await register(valid(hex(BN254_R))))).toEqual({
      status: 422,
      code: "REGISTRATION_MALFORMED",
      data: { code: "non-canonical" },
    });
    expect(await answer(await register(valid(hex(1n))))).toEqual({
      status: 422,
      code: "REGISTRATION_MALFORMED",
      data: { code: "forbidden-commitment" },
    });
    expect(await answer(await register({ ...valid(), region: "1" }))).toMatchObject({
      status: 422,
      code: "REGION_UNKNOWN",
    });
    await redis.hset(keys.sizes, "3", "1024");
    expect(await answer(await register(valid()))).toMatchObject({
      status: 503,
      code: "REGISTRATION_BUSY",
    });
    await redis.del(keys.sizes);
    await redis.set(keys.indexed, String(NOW - 61));
    expect(await answer(await register(valid()))).toMatchObject({
      status: 503,
      code: "REGISTRATION_UNAVAILABLE",
    });
    expect(tokens).toEqual([]);
    await redis.set(keys.indexed, String(NOW));
    verdict = "refused";
    expect(await answer(await register(valid()))).toMatchObject({
      status: 403,
      code: "CHALLENGE_REFUSED",
    });
    verdict = "unavailable";
    expect(await answer(await register(valid()))).toMatchObject({
      status: 503,
      code: "CHALLENGE_UNAVAILABLE",
    });
    expect(tokens).toHaveLength(2);
    expect(await redis.exists(keys.queue)).toBe(0);
  });

  test("a server without the service checks the request, then answers unavailable", async () => {
    expect(await answer(await register(valid(hex(BN254_R)), bare))).toMatchObject({
      status: 422,
      code: "REGISTRATION_MALFORMED",
    });
    expect(await answer(await register(valid(), bare))).toMatchObject({
      status: 503,
      code: "REGISTRATION_UNAVAILABLE",
    });
  });

  test("refuses an account credential before anything is read (T-10)", async () => {
    const r = await fetch(`${base}/registrations/tier0`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: JSON.stringify(valid()),
    });
    expect(r.status).toBe(400);
    expect(tokens).toEqual([]);
  });

  test("the request log carries the route and never the commitment, region or token (T-11)", async () => {
    logs.length = 0;
    const commitment = hex(0x5eedn);
    await register({ ...valid(commitment), turnstile: "secret-solve-1" });
    await register({ ...valid(commitment), turnstile: "secret-solve-2", region: "4000000000" });
    verdict = "refused";
    await register({ ...valid(commitment), turnstile: "secret-solve-3" });
    await new Promise((r) => setTimeout(r, 50));
    expect(logs).toHaveLength(3);
    const text = JSON.stringify(logs);
    for (const value of [commitment, "5eed", "secret-solve", "4000000000", "127.0.0.1"])
      expect(text).not.toContain(value);
    for (const line of logs as RequestLogLine[])
      expect(Object.keys(line).sort()).toEqual(["method", "ms", "route", "status"]);
    expect((logs as RequestLogLine[]).map((l) => [l.route, l.status])).toEqual([
      ["POST /registrations/tier0", 200],
      ["POST /registrations/tier0", 422],
      ["POST /registrations/tier0", 403],
    ]);
  });
});

describe("src/main.ts", () => {
  test("refuses to start with only part of the Tier 0 configuration", async () => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
      {
        env: {
          PATH: process.env["PATH"] ?? "",
          DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? "",
          API_PORT: "1",
          REDIS_URL: redisUrl,
          API_TIER0_GROUP: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const [code] = (await once(child, "exit")) as [number | null];
    expect(code).not.toBe(0);
    expect(stderr).toContain("go together");
  });
});
