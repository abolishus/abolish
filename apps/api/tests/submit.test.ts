import { decodeBoardEntry, decodeElectionDefinition, type Panel } from "@abolishus/crypto";
import { appendEntry, BallotAdmissions, readBoard, storeDefinition } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { splitEntries } from "@abolishus/verifier";
import { BallotQueue, type RunningWorker, startWorker } from "@abolishus/worker";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { type BallotSubmitter, createApiServer } from "../src/index.ts";

// `ballots.submit` with admission, over HTTP, through the worker's
// `{ballot-submit}` queue on a live Redis: an admitted ballot is boarded
// and answered with its entry and link, a rejected one is BALLOT_REJECTED
// with the verifier's code, a repeat of a boarded ballot (5.7) is answered
// with that ballot's entry if its bytes are the same and is BALLOT_REJECTED
// with `repeat` otherwise, and outside the window (by the worker's clock)
// ELECTION_NOT_OPEN, with nothing written but the admitted ballot (T-17,
// T-38, T-52). A ballot without an outcome in time is BALLOTS_UNAVAILABLE,
// and what the server answers is read from the board, never taken on the
// worker's word. The request log still holds only the method, route, status
// and duration (T-10, T-11). Fixtures: docs/spec/vectors/
// verifier-ballots.json (an independent implementation's verdicts).

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const file = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/verifier-ballots.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly panels: Readonly<Record<string, { threshold: string; keys: string[] }>>;
  readonly cases: readonly {
    readonly id: string;
    readonly definition: string;
    readonly board: string;
    readonly ballots?: {
      readonly rejected: readonly { entry: number; code: string }[];
      readonly repeats: readonly { entry: number }[];
    };
  }[];
};
const mixed = file.cases.find((c) => c.id === "mixed")!;
const panel: Panel = {
  threshold: Number(file.panels["panel-4"]!.threshold),
  keys: file.panels["panel-4"]!.keys.map(unhex),
};
const definition = decodeElectionDefinition(unhex(mixed.definition));
const electionId = definition.election_id;
// The fixtures pin board-entry version 5.
const entries = splitEntries(unhex(mixed.board)).entries.map((e) => decodeBoardEntry(e, 5));
// The case's one repeat (5.7) is a byte-identical copy of an earlier ballot.
const repeats = new Set(
  (mixed.ballots?.rejected ?? []).filter((r) => r.code === "repeat").map((r) => r.entry),
);
const rejected = new Map(
  (mixed.ballots?.rejected ?? [])
    .filter((r) => r.code !== "repeat")
    .map((r) => [r.entry, r.code] as const),
);

let db: TestDb;
let app: Sql;
let server: Server;
let base: string;
// The worker's clock, in UNIX seconds.
let now = definition.opens_at + 60n;
const logs: unknown[] = [];
let connection: Redis;
const workers: RunningWorker[] = [];
const queues: BallotQueue[] = [];

/** A worker judging ballots for `sql`, and the API's queue to it, under a prefix of their own. */
async function judging(sql: Sql) {
  const prefix = `abolish-test-api-${Buffer.from(randomBytes(6)).toString("hex")}`;
  workers.push(
    await startWorker({
      connection,
      sql,
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix,
      now: () => new Date(Number(now) * 1000),
      ballots: {
        admissions: new BallotAdmissions({
          panels: [panel],
          clock: { epoch: definition.opens_at, period: 3_600n },
        }),
      },
    }),
  );
  const ballots = await BallotQueue.open({ connection, prefix });
  queues.push(ballots);
  return ballots;
}

async function listen(options: Parameters<typeof createApiServer>[0]) {
  const s = createApiServer(options);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { server: s, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/ballots` };
}

beforeAll(async () => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  db = await testDb();
  app = await db.as("abolish_app");
  await storeDefinition(app, unhex(mixed.definition));
  await appendEntry(app, electionId, entries[0]!.segment, entries[0]!.payload);
  ({ server, url: base } = await listen({
    sql: app,
    log: (l) => logs.push(l),
    ballots: await judging(app),
  }));
});
afterAll(async () => {
  await new Promise((r) => server?.close(r));
  for (const q of queues) await q.close();
  for (const w of workers) await w.close();
  for (const key of await connection.keys("abolish-test-api-*")) await connection.del(key);
  connection?.disconnect();
  await db?.close();
});

const submit = (ballot: Uint8Array, id = electionId) =>
  fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ electionId: hex(id), ballot: hex(ballot) }),
  });

describe("ballots.submit with admission", () => {
  // Every entry's admission checks its proofs; a slow runner takes longer than the default 5 s.
  test(
    "boards each admitted ballot and refuses each rejected one with its code",
    { timeout: 60_000 },
    async () => {
      let size = 1;
      for (const [at, e] of entries.entries()) {
        if (at === 0) continue;
        const r = await submit(e.payload);
        const body = (await r.json()) as Record<string, unknown>;
        const code = rejected.get(at);
        if (repeats.has(at)) {
          // Its earlier copy's entry, so a client that lost the answer can retry.
          expect(r.status).toBe(201);
          const board = await readBoard(app, electionId);
          const earlier = board.findIndex(
            (b, i) => i > 0 && hex(decodeBoardEntry(b, 5).payload) === hex(e.payload),
          );
          expect(earlier).toBeGreaterThan(0);
          expect(body["entry"]).toBe(hex(board[earlier]!));
        } else if (code === undefined) {
          expect(r.status).toBe(201);
          const entry = decodeBoardEntry(unhex(body["entry"] as string), 5);
          expect(entry.payload).toEqual(e.payload);
          expect(entry.index).toBe(BigInt(size));
          expect(entry.segment).toBe(0);
          const board = await readBoard(app, electionId);
          expect(hex(board[size]!)).toBe(body["entry"]);
          size++;
        } else {
          expect(r.status).toBe(422);
          expect(body["code"]).toBe("BALLOT_REJECTED");
          expect(body["data"]).toEqual({ code });
        }
        expect(await readBoard(app, electionId)).toHaveLength(size);
      }
      expect(size).toBeGreaterThan(1);
      expect(rejected.size).toBeGreaterThan(0);
      expect(repeats.size).toBe(1);
    },
  );

  test("a copy of a boarded ballot in other bytes is BALLOT_REJECTED with repeat", async () => {
    // The repeats case: entry 2 is a voter's ballot and entry 3 the same
    // ballot with its proof negated (the same tier, ν and M).
    const c = file.cases.find((x) => x.id === "repeats")!;
    const [transcript, , original, negated] = splitEntries(unhex(c.board)).entries.map((e) =>
      decodeBoardEntry(e, 5),
    );
    const own = await testDb();
    const sql = await own.as("abolish_app");
    await storeDefinition(sql, unhex(c.definition));
    await appendEntry(sql, electionId, transcript!.segment, transcript!.payload);
    const { server: s, url } = await listen({ sql, log: () => {}, ballots: await judging(sql) });
    const post = (ballot: Uint8Array) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ electionId: hex(electionId), ballot: hex(ballot) }),
      });
    try {
      expect((await post(original!.payload)).status).toBe(201);
      const r = await post(negated!.payload);
      expect(r.status).toBe(422);
      const body = (await r.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("BALLOT_REJECTED");
      expect(body["data"]).toEqual({ code: "repeat" });
      expect(await readBoard(sql, electionId)).toHaveLength(2);
    } finally {
      await new Promise((r) => s.close(r));
      await own.close();
    }
  });

  test("outside the window is ELECTION_NOT_OPEN, and an unknown election ELECTION_NOT_FOUND", async () => {
    const ballot = entries.find((_, at) => at > 0 && !rejected.has(at))!.payload;
    const before = (await readBoard(app, electionId)).length;
    now = definition.closes_at + 1n;
    const late = await submit(ballot);
    now = definition.opens_at + 60n;
    expect(late.status).toBe(409);
    expect(((await late.json()) as Record<string, unknown>)["code"]).toBe("ELECTION_NOT_OPEN");
    expect((await submit(ballot, new Uint8Array(32).fill(7))).status).toBe(404);
    expect(await readBoard(app, electionId)).toHaveLength(before);
  });

  test("an empty ballot is BALLOT_REJECTED with decode, as the verifier judges it", async () => {
    const r = await submit(new Uint8Array(0));
    expect(r.status).toBe(422);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("BALLOT_REJECTED");
    expect(body["data"]).toEqual({ code: "decode" });
  });

  test("a ballot without an outcome in time is BALLOTS_UNAVAILABLE, and writes nothing", async () => {
    const ballot = entries.find((_, at) => at > 0 && !rejected.has(at))!.payload;
    const before = (await readBoard(app, electionId)).length;
    const unavailable: BallotSubmitter = {
      submit: async () => ({ ok: false, code: "unavailable" }),
    };
    const { server: s, url } = await listen({ sql: app, log: () => {}, ballots: unavailable });
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ electionId: hex(electionId), ballot: hex(ballot) }),
      });
      expect(r.status).toBe(503);
      expect(((await r.json()) as Record<string, unknown>)["code"]).toBe("BALLOTS_UNAVAILABLE");
      expect(await readBoard(app, electionId)).toHaveLength(before);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  test("an index whose entry doesn't carry the ballot is never answered as its entry", async () => {
    // A worker that names another ballot's position, or one past the board.
    const ballot = Uint8Array.of(0, 2, 1, 7);
    const size = BigInt((await readBoard(app, electionId)).length);
    for (const index of [1n, size]) {
      const wrong: BallotSubmitter = {
        submit: async () => ({ ok: true, index: index.toString() }),
      };
      const { server: s, url } = await listen({ sql: app, log: () => {}, ballots: wrong });
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ electionId: hex(electionId), ballot: hex(ballot) }),
        });
        expect(r.status).toBe(500);
        expect(JSON.stringify(await r.json())).not.toContain("entry");
      } finally {
        await new Promise((r) => s.close(r));
      }
    }
  });

  test("the request log names no ballot (T-10)", () => {
    const ballots = new Set(entries.map((e) => hex(e.payload)));
    for (const line of logs) {
      expect(Object.keys(line as object).sort()).toEqual(["method", "ms", "route", "status"]);
      expect([...ballots].some((b) => JSON.stringify(line).includes(b.slice(0, 64)))).toBe(false);
    }
    expect(logs.length).toBeGreaterThan(0);
  });
});
