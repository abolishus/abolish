import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeTier1Addition, encodeTier1Addition, VOUCH_ROOT_INTERVAL } from "@abolishus/crypto";
import {
  recordKey,
  tier1IndexValue,
  tier1Keys,
  Tier1Relay,
  type Turnstile,
  type TurnstileVerdict,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { Redis } from "ioredis";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { createApiServer, type RequestLogLine } from "../src/index.ts";

// The Tier 1 relay over HTTP (docs/spec/tier1-relay.md, Request and
// Answers), against a live Redis: each step's answer and status, the same
// empty answer for every accepted request, and a request log that never
// carries the record or the token (T-10, T-11, T-13). Core's own tests cover
// the queue in depth.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const NOW = 1_800_000_000;
const ROOT = 1000n * VOUCH_ROOT_INTERVAL;
const prefix = `test-api-tier1-${process.pid}-${Date.now()}`;
const keys = tier1Keys(prefix);

// docs/spec/vectors/vouch.json's honest addition, moved onto the root grid:
// the route checks no proof, so it stands for one that passes steps 3 to 6.
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/vouch.json", import.meta.url), "utf8"),
) as { readonly additions: readonly { readonly id: string; readonly record: string }[] };
const honest = decodeTier1Addition(
  Buffer.from(vectors.additions.find((a) => a.id === "honest")?.record ?? "", "hex"),
);
if (!honest.ok) throw new Error("vouch.json's honest addition doesn't decode");
const GROUP = honest.value.groupId;
const record = (rootBlocks: readonly bigint[] = [ROOT, ROOT, ROOT], groupId = GROUP) =>
  Buffer.from(
    encodeTier1Addition({
      ...honest.value,
      groupId,
      vouches: honest.value.vouches.map((v, i) => ({ ...v, rootBlock: rootBlocks[i] ?? ROOT })),
    }),
  ).toString("hex");

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
  const tier1 = new Tier1Relay({
    redis,
    groups: new Map([[0, GROUP]]),
    turnstile,
    now: () => NOW,
    prefix,
  });
  base = await listen(createApiServer({ sql: app, tier1, log: (l) => logs.push(l) }));
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
  await redis.set(keys.index, tier1IndexValue({ at: NOW, latest: ROOT + 20n, safe: ROOT + 10n }));
});

const valid = (hex = record()) => ({ record: hex, turnstile: "tok.en-1_" });
const relay = (body: unknown, at = base) =>
  fetch(`${at}/registrations/tier1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function answer(r: Response) {
  const body = (await r.json()) as Record<string, unknown>;
  return { status: r.status, code: body["code"], data: body["data"] };
}

describe("registrations.tier1", () => {
  test("queues a record and answers 200 with an empty object", async () => {
    const hex = record();
    const r = await relay(valid(hex));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({});
    expect(tokens).toEqual(["tok.en-1_"]);
    expect(await redis.hgetall(keys.queue)).toEqual({
      [recordKey(Buffer.from(hex, "hex"))]: hex,
    });
  });

  test("answers a queued record exactly as a new one", async () => {
    const answers = [];
    for (const hex of [record(), record(), record([ROOT - VOUCH_ROOT_INTERVAL])]) {
      const r = await relay(valid(hex));
      answers.push({ status: r.status, body: await r.text() });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a)))).toEqual(
      new Set([JSON.stringify({ status: 200, body: "{}" })]),
    );
    expect(await redis.hlen(keys.queue)).toBe(2);
  });

  test("a body outside the forms is refused as every route's input is, spending no token", async () => {
    for (const body of [
      { ...valid(), record: record().toUpperCase() },
      { ...valid(), record: record().slice(2) },
      { ...valid(), turnstile: "" },
      { ...valid(), extra: "1" },
      { record: record() },
    ])
      expect((await answer(await relay(body))).status).toBe(400);
    expect(tokens).toEqual([]);
  });

  test("each later step has its own answer, and none before Turnstile spends the token", async () => {
    expect(await answer(await relay(valid(record([ROOT, ROOT + 1n, ROOT]))))).toEqual({
      status: 422,
      code: "RELAY_MALFORMED",
      data: { code: "root-grid", vouch: 1 },
    });
    expect(await answer(await relay(valid("00".repeat(1919))))).toEqual({
      status: 422,
      code: "RELAY_MALFORMED",
      data: { code: "decode" },
    });
    expect(await answer(await relay(valid(record(undefined, GROUP + 1n))))).toMatchObject({
      status: 422,
      code: "GROUP_UNKNOWN",
    });
    expect(
      await answer(await relay(valid(record([ROOT + VOUCH_ROOT_INTERVAL, ROOT, ROOT])))),
    ).toMatchObject({ status: 422, code: "VOUCH_WINDOW" });
    await redis.set(keys.index, tier1IndexValue({ at: NOW - 61, latest: ROOT, safe: ROOT }));
    expect(await answer(await relay(valid()))).toMatchObject({
      status: 503,
      code: "RELAY_UNAVAILABLE",
    });
    expect(tokens).toEqual([]);
    await redis.set(keys.index, tier1IndexValue({ at: NOW, latest: ROOT, safe: ROOT }));
    verdict = "refused";
    expect(await answer(await relay(valid()))).toMatchObject({
      status: 403,
      code: "CHALLENGE_REFUSED",
    });
    verdict = "unavailable";
    expect(await answer(await relay(valid()))).toMatchObject({
      status: 503,
      code: "CHALLENGE_UNAVAILABLE",
    });
    expect(tokens).toHaveLength(2);
    expect(await redis.exists(keys.queue)).toBe(0);
    // A full queue, only once the token is spent.
    verdict = "passed";
    const full = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`k${i}`, `v${i}`] as const),
    );
    await redis.hset(keys.queue, full);
    expect(await answer(await relay(valid()))).toMatchObject({ status: 503, code: "RELAY_BUSY" });
    expect(tokens).toHaveLength(3);
  });

  test("a server without the relay checks the record, then answers unavailable", async () => {
    expect(await answer(await relay(valid(record([ROOT + 1n])), bare))).toMatchObject({
      status: 422,
      code: "RELAY_MALFORMED",
    });
    expect(await answer(await relay(valid(), bare))).toMatchObject({
      status: 503,
      code: "RELAY_UNAVAILABLE",
    });
  });

  test("refuses an account credential before anything is read (T-10)", async () => {
    const r = await fetch(`${base}/registrations/tier1`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer x" },
      body: JSON.stringify(valid()),
    });
    expect(r.status).toBe(400);
    expect(tokens).toEqual([]);
  });

  test("the request log carries the route and never the record or token (T-11)", async () => {
    logs.length = 0;
    const hex = record();
    await relay({ ...valid(hex), turnstile: "secret-solve-1" });
    await relay({ ...valid(record([ROOT + 1n])), turnstile: "secret-solve-2" });
    verdict = "refused";
    await relay({ ...valid(hex), turnstile: "secret-solve-3" });
    await new Promise((r) => setTimeout(r, 50));
    expect(logs).toHaveLength(3);
    const text = JSON.stringify(logs);
    for (const value of [hex.slice(0, 64), hex.slice(-64), "secret-solve", "127.0.0.1"])
      expect(text).not.toContain(value);
    for (const line of logs as RequestLogLine[])
      expect(Object.keys(line).sort()).toEqual(["method", "ms", "route", "status"]);
    expect((logs as RequestLogLine[]).map((l) => [l.route, l.status])).toEqual([
      ["POST /registrations/tier1", 200],
      ["POST /registrations/tier1", 422],
      ["POST /registrations/tier1", 403],
    ]);
  });
});
