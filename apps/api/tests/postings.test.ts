import { POSTING_MAX_DATA } from "@abolishus/api-contract";
import {
  appendEntry,
  BallotAdmissions,
  POSTING_MAX_DATA as CORE_POSTING_MAX_DATA,
  type PostingOutcome,
  POSTING_MAX_CONCURRENT,
  type PostingRedis,
  postingIndexValue,
  postingKey,
  postingKeys,
  postingOutcomeValue,
  PostingRelay,
  recordRegistration,
  storeDefinition,
} from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { DELIVERY_WINDOW } from "@abolishus/crypto";
import { PINNED_FORCED_INCLUSION } from "@abolishus/verifier";
import { Redis } from "ioredis";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  ballots,
  definition,
  definitionBytes,
  definitionHash,
  electionId,
  panel,
  postedBallot,
  postingFor,
  transcript,
} from "../../../packages/verifier/tests/receipt-poll.ts";
import {
  createApiServer,
  MAX_POSTING_BODY,
  POSTING_ENV,
  postingFromEnv,
  type RequestLogLine,
} from "../src/index.ts";

// `postings.submit`, the posting relay's route, over HTTP against a live
// Redis and Postgres (docs/spec/posting-relay.md, Request and Answers): each
// step's answer and status, the route's own body bound, the worker's outcome
// passed through as `sent` or a refusal, busy while there is none, and a
// request log that never carries a record (T-10, T-11, T-13, T-18, T-52).
// Core's own tests cover each step in depth; the worker that sends is a
// later part, so its outcomes are written here while the route waits. The
// election's ceremony is packages/verifier's tests/receipt-poll.ts, whose
// ballots are encrypted to its seats, so honest postings pass.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const NOW = 1_800_000_000;
const clock = { epoch: definition.opens_at - 7_200n, period: 3_600n };
// The relay's last L2 time, `c_D − POSTING_SEND_MARGIN`, by the spec's formulas.
const LAST =
  definition.closes_at +
  BigInt(definition.l1_inclusion_bound) +
  DELIVERY_WINDOW -
  PINNED_FORCED_INCLUSION -
  6_600n;
const TX = new Uint8Array(32).fill(0xab);
const first = postedBallot(ballots[0] as (typeof ballots)[number]);
const honest = (seat = 1) => ({
  posting: hex(postingFor(first, seat)),
  ballot: hex(first.payload),
});

let db: TestDb;
let app: Sql;
let redis: Redis;
const prefix = `test-api-postings-${process.pid}-${Date.now()}`;
const keys = postingKeys(prefix);
const servers: Server[] = [];

beforeAll(async () => {
  redis = new Redis(redisUrl);
  db = await testDb();
  app = await db.as("abolish_app");
  await storeDefinition(app, definitionBytes);
  await appendEntry(app, electionId, 0, transcript, { first: true });
  await recordRegistration(app, { electionId, definitionHash, l2Block: 1n, logIndex: 0 });
});
afterEach(async () => {
  const left = await redis.keys(`${prefix}:*`);
  if (left.length > 0) await redis.del(...left);
});
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  await redis?.quit();
  await db?.close();
});

/**
 * An API with the relay, or without it, and a function posting a body to
 * it. `meanwhile` runs on each of the route's waits, as the worker would.
 */
async function api(
  o: {
    relay?: boolean;
    meanwhile?: () => Promise<unknown>;
    corsOrigins?: string[];
    sql?: Sql;
    redis?: PostingRedis;
    /** The route's real wait, in milliseconds, with real sleeps; 0 and `meanwhile` by default. */
    waitMs?: number;
    idleTimeoutMs?: number;
  } = {},
) {
  const log: unknown[] = [];
  const postings =
    o.relay === false
      ? undefined
      : new PostingRelay({
          sql: o.sql ?? app,
          redis: o.redis ?? redis,
          admissions: new BallotAdmissions({ panels: [panel], clock }),
          now: () => NOW,
          waitMs: o.waitMs ?? 0,
          ...(o.waitMs === undefined && {
            sleep: async () => {
              await o.meanwhile?.();
            },
          }),
          prefix,
        });
  const s = createApiServer({
    sql: o.sql ?? app,
    log: (l) => log.push(l),
    ...(o.idleTimeoutMs !== undefined && { idleTimeoutMs: o.idleTimeoutMs }),
    ...(postings !== undefined && { postings }),
    ...(o.corsOrigins !== undefined && { corsOrigins: o.corsOrigins }),
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}/postings`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    const answer = (await r.json()) as Record<string, unknown>;
    return { status: r.status, code: answer["code"], data: answer["data"], body: answer };
  };
  return { post, log, base };
}

const setIndex = (l2Time = LAST) => redis.set(keys.index, postingIndexValue({ at: NOW, l2Time }));
const writeOutcome = (posting: string, outcome: PostingOutcome) =>
  redis.set(keys.outcome(postingKey(Buffer.from(posting, "hex"))), postingOutcomeValue(outcome));

describe("postings.submit", { timeout: 60_000 }, () => {
  test("a sent posting answers 200 with its transaction and layer, and the log holds no record", async () => {
    await setIndex();
    const input = honest();
    for (const layer of ["l2", "l1"] as const) {
      await redis.del(keys.queue, keys.outcome(postingKey(Buffer.from(input.posting, "hex"))));
      const { post, log } = await api({
        meanwhile: () => writeOutcome(input.posting, { sent: true, transaction: TX, layer }),
      });
      const { status, body } = await post(input);
      expect(status).toBe(200);
      expect(body).toEqual({ transaction: hex(TX), layer });
      // T-10, T-11: the method, the route, the status and the time, nothing else.
      expect(log).toHaveLength(1);
      const line = log[0] as RequestLogLine;
      expect(Object.keys(line).sort()).toEqual(["method", "ms", "route", "status"]);
      expect(line).toMatchObject({ method: "POST", route: "POST /postings", status: 200 });
    }
  });

  test("the worker's refusal is POSTING_REFUSED with its code", async () => {
    await setIndex();
    const input = honest(2);
    const { post } = await api({
      meanwhile: () => writeOutcome(input.posting, { sent: false, code: "ballot-cap" }),
    });
    expect(await post(input)).toMatchObject({
      status: 422,
      code: "POSTING_REFUSED",
      data: { code: "ballot-cap" },
    });
  });

  test("no outcome in time is RELAY_BUSY, the pair queued once", async () => {
    await setIndex();
    const { post } = await api();
    for (let i = 0; i < 2; i++)
      expect(await post(honest(3))).toMatchObject({ status: 503, code: "RELAY_BUSY" });
    expect(await redis.hlen(keys.queue)).toBe(1);
  });

  test("records that fail their own checks are POSTING_REFUSED, malformed, with the check", async () => {
    const { post } = await api();
    for (const [input, check] of [
      [{ ...honest(), ballot: "0002" }, "ballot-decode"],
      [{ ...honest(), posting: "000d01" }, "decode"],
      [
        { ...honest(), posting: hex(postingFor(first, 1, { ballotHash: new Uint8Array(32) })) },
        "posting-ballot",
      ],
    ] as const)
      expect(await post(input)).toMatchObject({
        status: 422,
        code: "POSTING_REFUSED",
        data: { code: "malformed", check },
      });
    expect(await redis.exists(keys.queue)).toBe(0);
  });

  test("forms the contract refuses, and calldata over POSTING_MAX_DATA, are 400", async () => {
    const { post } = await api();
    const p = postingFor(first, 1).length;
    // The first ballot length whose calldata beside the posting passes the bound.
    const over = Math.floor((POSTING_MAX_DATA - 132 - Math.ceil(p / 32) * 32) / 32) * 32 + 1;
    for (const input of [
      { ...honest(), posting: honest().posting.toUpperCase() },
      { ...honest(), ballot: `0x${honest().ballot}` },
      { ...honest(), posting: `${honest().posting}0` },
      { ...honest(), electionId: hex(electionId) },
      { posting: honest().posting },
      { ...honest(), ballot: "00".repeat(over) },
    ])
      expect((await post(input)).status).toBe(400);
  });

  test("a body over the route's own bound is 413, though the ballot route's would take it", async () => {
    const { post } = await api();
    const body = JSON.stringify({ posting: "00".repeat(60_000), ballot: "00".repeat(71_100) });
    expect(body.length).toBeGreaterThan(MAX_POSTING_BODY);
    expect((await post(body)).status).toBe(413);
  });

  test("an unregistered election, a late index and a missing one answer by step 4", async () => {
    await setIndex();
    // A schema where the definition is stored but no registration recorded.
    const own = await testDb();
    try {
      const unregistered = await own.as("abolish_app");
      await storeDefinition(unregistered, definitionBytes);
      const { post } = await api({ sql: unregistered });
      expect(await post(honest())).toMatchObject({
        status: 422,
        code: "POSTING_REFUSED",
        data: { code: "unknown-election" },
      });
    } finally {
      await own.close();
    }
    const { post } = await api();
    await setIndex(LAST + 1n);
    expect(await post(honest())).toMatchObject({
      status: 422,
      code: "POSTING_REFUSED",
      data: { code: "too-late" },
    });
    await redis.del(keys.index);
    expect(await post(honest())).toMatchObject({ status: 503, code: "RELAY_UNAVAILABLE" });
  });

  test("Redis failing is RELAY_UNAVAILABLE", async () => {
    const { post } = await api({ redis: { eval: () => Promise.reject(new Error("down")) } });
    expect(await post(honest())).toMatchObject({ status: 503, code: "RELAY_UNAVAILABLE" });
  });

  test("the worker's malformed refusal names no check", async () => {
    await setIndex();
    const input = honest(4);
    const { post } = await api({
      meanwhile: () => writeOutcome(input.posting, { sent: false, code: "malformed" }),
    });
    const { status, data } = await post(input);
    expect(status).toBe(422);
    expect(data).toEqual({ code: "malformed" });
  });

  test("past POSTING_MAX_CONCURRENT waiting requests, the next is RELAY_BUSY at once", async () => {
    await setIndex();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let waiting = 0;
    const { post } = await api({
      meanwhile: async () => {
        waiting++;
        await held;
      },
    });
    const pending = Array.from({ length: POSTING_MAX_CONCURRENT }, (_, i) =>
      post(honest(1 + (i % definition.panel_size))),
    );
    while (waiting < POSTING_MAX_CONCURRENT) await new Promise((r) => setTimeout(r, 20));
    expect(await post(honest())).toMatchObject({ status: 503, code: "RELAY_BUSY" });
    release();
    for (const r of await Promise.all(pending)) expect(r.code).toBe("RELAY_BUSY");
  });

  test("a wait longer than the idle timeout still gets its answer", async () => {
    await setIndex();
    const { post } = await api({ waitMs: 600, idleTimeoutMs: 200 });
    expect(await post(honest())).toMatchObject({ status: 503, code: "RELAY_BUSY" });
  });

  test("an account credential is refused before the body is read", async () => {
    const { post } = await api();
    for (const headers of [
      { authorization: "Bearer x" },
      { cookie: "abolish-account.session_token=x" },
    ])
      expect((await post(honest(), headers)).status).toBe(400);
  });

  test("a posting failing the public check is POSTING_REFUSED with the check's code", async () => {
    await setIndex();
    const { post } = await api();
    const input = { ...honest(), posting: hex(postingFor(first, 1, { ciphertextOf: 2 })) };
    expect(await post(input)).toMatchObject({
      status: 422,
      code: "POSTING_REFUSED",
      data: { code: "posting-hash" },
    });
    expect(await redis.hlen(keys.queue)).toBe(0);
  });

  test("without the relay, a pair is RELAY_UNAVAILABLE once its records pass their own checks", async () => {
    const { post } = await api({ relay: false });
    expect(await post(honest())).toMatchObject({ status: 503, code: "RELAY_UNAVAILABLE" });
    expect((await post({ ...honest(), ballot: "0002" })).data).toEqual({
      code: "malformed",
      check: "ballot-decode",
    });
  });

  test("the ballot client's origin may send it, with no credentials", async () => {
    const origin = "https://ballot.example";
    const { base } = await api({ corsOrigins: [origin] });
    const r = await fetch(`${base}/postings`, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(origin);
    expect(r.headers.get("access-control-allow-credentials")).toBeNull();
  });
});

describe("the posting bound and configuration", () => {
  test("the contract's POSTING_MAX_DATA is core's", () => {
    expect(POSTING_MAX_DATA).toBe(CORE_POSTING_MAX_DATA);
  });

  test("the route's body bound holds the largest pair the relay takes", () => {
    const json = JSON.stringify({ posting: "", ballot: "" }).length;
    expect(2 * POSTING_MAX_DATA + json).toBeLessThanOrEqual(MAX_POSTING_BODY);
  });

  const panels = JSON.stringify([{ threshold: panel.threshold, keys: panel.keys.map(hex) }]);
  const full = { API_POSTING_REDIS_URL: "redis://127.0.0.1:6380", BALLOT_PINNED_PANELS: panels };

  test("reads both variables, or neither", () => {
    expect(postingFromEnv({})).toBeUndefined();
    expect(postingFromEnv({ API_POSTING_REDIS_URL: "", BALLOT_PINNED_PANELS: "" })).toBeUndefined();
    const config = postingFromEnv(full);
    expect(config?.redisUrl).toBe(full.API_POSTING_REDIS_URL);
    expect(config?.panels).toEqual([panel]);
    for (const name of POSTING_ENV)
      expect(() => postingFromEnv({ ...full, [name]: undefined })).toThrow(/needs every one/);
  });

  test("refuses a malformed value by name, never quoting it", () => {
    for (const [env, name] of [
      [{ ...full, API_POSTING_REDIS_URL: "https://secret@host" }, "API_POSTING_REDIS_URL"],
      [{ ...full, BALLOT_PINNED_PANELS: "{secret" }, "BALLOT_PINNED_PANELS"],
      [{ ...full, BALLOT_PINNED_PANELS: "[]" }, "BALLOT_PINNED_PANELS"],
      [
        { ...full, BALLOT_PINNED_PANELS: '[{"threshold":1,"keys":["AB"]}]' },
        "BALLOT_PINNED_PANELS",
      ],
    ] as const) {
      let message = "";
      try {
        postingFromEnv(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain("secret");
    }
    const notAPanel = JSON.stringify([{ threshold: 9, keys: panel.keys.map(hex) }]);
    expect(() => postingFromEnv({ ...full, BALLOT_PINNED_PANELS: notAPanel })).toThrow(/isn't one/);
  });
});
