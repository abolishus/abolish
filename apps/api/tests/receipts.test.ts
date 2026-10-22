import { MAX_SHARE_RECEIPT } from "@abolishus/api-contract";
import { appendEntry, BallotAdmissions, readBoard, storeDefinition } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import {
  decodeBoardEntry,
  decodeShareReceipt,
  DELIVERY_WINDOW,
  encodeShareReceiptV2,
  SEAT_PANELS,
} from "@abolishus/crypto";
import {
  MAX_SHARE_RECEIPT as QUEUE_MAX_SHARE_RECEIPT,
  ReceiptQueue,
  type RunningWorker,
  startWorker,
} from "@abolishus/worker";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  ballots,
  definition,
  definitionBytes,
  electionId,
  panel,
  receiptFor,
  transcript,
} from "../../../packages/verifier/tests/receipt-poll.ts";
import { createApiServer, type ReceiptSubmitter } from "../src/index.ts";

// `receipts.submit`, the board path for share receipts, over HTTP through
// the worker's `{receipt-submit}` queue on a live Redis (docs/spec/delivery.md,
// Boarding): a passing receipt is boarded and answered with its entry and
// link, read from the board; the same bytes again return that entry; a
// passing receipt for a seat the board path already carries is answered with
// that earlier entry, `earlier` set, writing nothing; a refused one is
// RECEIPT_REJECTED with core's code, or ELECTION_NOT_OPEN after `s_D`, with
// nothing written (T-17, T-52). Without an outcome in time it is
// RECEIPTS_UNAVAILABLE, and without a queue nothing is boarded (T-25). The
// request log holds only the method, route, status and duration (T-10,
// T-11). The election's ceremony and receipts are packages/verifier's
// tests/receipt-poll.ts; its ballots are boarded directly with their ballot
// hashes, as packages/core's share-receipts test does, since their
// membership proofs were made for another definition.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));
const b32 = () => new Uint8Array(randomBytes(32));

const VERSION = 5;
const clock = { epoch: definition.opens_at - 7_200n, period: 3_600n };
const during = definition.opens_at + 60n;
// `s_D`, by the spec's formula (docs/spec/delivery.md, Windows).
const S_D =
  (definition.closes_at + BigInt(definition.l1_inclusion_bound) + DELIVERY_WINDOW - clock.epoch) /
  clock.period;
const [first, second] = ballots as [(typeof ballots)[number], (typeof ballots)[number]];

let connection: Redis;
const dbs: TestDb[] = [];
const servers: Server[] = [];
const workers: RunningWorker[] = [];
const queues: ReceiptQueue[] = [];
// The worker's clock, in UNIX seconds.
let now = during;

/** A schema of its own with the election stored, its transcript boarded and the ballots after it. */
async function election(): Promise<Sql> {
  const own = await testDb();
  dbs.push(own);
  const app = await own.as("abolish_app");
  await storeDefinition(app, definitionBytes);
  await appendEntry(app, electionId, 0, transcript, { first: true });
  for (const b of ballots)
    await appendEntry(app, electionId, 0, b.payload, {
      ballot: { tier: 0, nullifier: b.nullifier, message: b32(), ballotHash: b.hash },
    });
  return app;
}

const prefixed = () => `abolish-test-api-receipts-${hex(randomBytes(6))}`;

/** A worker judging receipts for `sql`, and the API's queue to it, under a prefix of their own. */
async function judging(sql: Sql): Promise<ReceiptQueue> {
  const prefix = prefixed();
  workers.push(
    await startWorker({
      connection,
      sql,
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix,
      now: () => new Date(Number(now) * 1000),
      ballots: { admissions: new BallotAdmissions({ panels: [panel], clock }) },
    }),
  );
  const receipts = await ReceiptQueue.open({ connection, prefix });
  queues.push(receipts);
  return receipts;
}

/** An API on `sql` with `receipts`, and a function submitting a record to it. */
async function api(sql: Sql, receipts?: ReceiptSubmitter, log: unknown[] = []) {
  const s = createApiServer({
    sql,
    log: (l) => log.push(l),
    ...(receipts !== undefined && { receipts }),
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/receipts`;
  return async (record: Uint8Array, id = electionId) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ electionId: hex(id), record: hex(record) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
}

beforeAll(() => {
  connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
});
afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const q of queues) await q.close();
  for (const w of workers) await w.close();
  for (const key of await connection.keys("abolish-test-api-receipts-*")) await connection.del(key);
  connection?.disconnect();
  await Promise.all(dbs.map((d) => d.close()));
});

describe("receipts.submit with the board path's rules", { timeout: 60_000 }, () => {
  test("boards each seat's receipt, answering the entry and link the board holds", async () => {
    now = during;
    const app = await election();
    const log: unknown[] = [];
    const submit = await api(app, await judging(app), log);
    let size = ballots.length + 1;
    for (const b of [first, second])
      for (const seat of [1, 2, 3, 4]) {
        const receipt = receiptFor(b, seat);
        const { status, body } = await submit(receipt);
        expect(status).toBe(201);
        expect(Object.keys(body).sort()).toEqual(["earlier", "entry", "link"]);
        expect(body["earlier"]).toBe(false);
        const entry = decodeBoardEntry(unhex(body["entry"] as string), VERSION);
        expect(entry.payload).toEqual(receipt);
        expect(entry.index).toBe(BigInt(size));
        const board = await readBoard(app, electionId);
        expect(board).toHaveLength(size + 1);
        expect(body["entry"]).toBe(hex(board[size]!));
        expect(body["link"]).toMatch(/^[0-9a-f]{64}$/);
        size++;
      }
    // T-10, T-11: the log names the route, never the receipt or election.
    expect(log).toContainEqual({
      method: "POST",
      route: "POST /receipts",
      status: 201,
      ms: expect.any(Number),
    });
    for (const line of log) expect(JSON.stringify(line)).not.toContain(hex(electionId));
  });

  test("the same bytes again return their entry and link, writing nothing", async () => {
    now = during;
    const app = await election();
    const submit = await api(app, await judging(app));
    const receipt = receiptFor(first, 2);
    const once = await submit(receipt);
    now = during + 7_200n;
    expect(await submit(receipt)).toEqual(once);
    expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 2);
  });

  test("a seat whose receipt the board path carries is answered with that entry, as earlier", async () => {
    now = during;
    const app = await election();
    // Another receipt for the same seat of the same ballot, keyed directly,
    // as packages/core's test does: what the board path carries for the
    // seat stands in for the one sent, whatever its bytes.
    const other = Uint8Array.from(receiptFor(first, 3));
    other[other.length - 1] = (other[other.length - 1] as number) ^ 1;
    const earlier = await appendEntry(app, electionId, 0, other, {
      receipt: { ballotHash: first.hash, panel: 1, seat: 3 },
    });
    const submit = await api(app, await judging(app));
    const { status, body } = await submit(receiptFor(first, 3));
    expect(status).toBe(201);
    expect(body).toEqual({ entry: hex(earlier.entry), link: hex(earlier.link), earlier: true });
    expect(decodeBoardEntry(earlier.entry, VERSION).payload).toEqual(other);
    expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 2);
  });

  test("a refused receipt is RECEIPT_REJECTED with its code, writing nothing", async () => {
    now = during;
    const app = await election();
    const submit = await api(app, await judging(app));
    const cases: [Uint8Array, string][] = [
      // Rule 1: not a receipt record at all.
      [new Uint8Array([0x00, 0x0c]), "decode"],
      [receiptFor(first, 1, { definitionHash: b32() }), "receipt-definition"],
      // Rule 2: no boarded ballot has this hash.
      [receiptFor(first, 1, { ballotHash: b32() }), "receipt-ballot"],
      // Rule 4: another seat's key signed it.
      [receiptFor(first, 1, { signer: 2 }), "share-receipt"],
    ];
    for (const [record, code] of cases) {
      const { status, body } = await submit(record);
      expect(status, code).toBe(422);
      expect(body["code"]).toBe("RECEIPT_REJECTED");
      expect((body["data"] as { code: string }).code.startsWith(code), code).toBe(true);
    }
    expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 1);
  });

  test("after s_D a receipt is ELECTION_NOT_OPEN; up to it, it is boarded, and its retry found after", async () => {
    const app = await election();
    const submit = await api(app, await judging(app));
    now = clock.epoch + (S_D + 1n) * clock.period;
    const late = await submit(receiptFor(first, 1));
    expect(late.status).toBe(409);
    expect(late.body["code"]).toBe("ELECTION_NOT_OPEN");
    expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 1);
    now = clock.epoch + (S_D + 1n) * clock.period - 1n;
    const boarded = await submit(receiptFor(first, 1));
    expect(boarded.status).toBe(201);
    // A retry of those bytes after s_D, its answer lost, still finds them.
    now += 1n;
    expect(await submit(receiptFor(first, 1))).toEqual(boarded);
  });

  test("an election this server doesn't hold is ELECTION_NOT_FOUND, never queued", async () => {
    now = during;
    const app = await election();
    const submit = await api(app, {
      submit: () => {
        throw new Error("queued an unknown election");
      },
    });
    const { status, body } = await submit(receiptFor(first, 1), b32());
    expect(status).toBe(404);
    expect(body["code"]).toBe("ELECTION_NOT_FOUND");
  });

  test("without a queue nothing is boarded: ELECTION_NOT_OPEN", async () => {
    const app = await election();
    const { status, body } = await (await api(app))(receiptFor(first, 1));
    expect(status).toBe(409);
    expect(body["code"]).toBe("ELECTION_NOT_OPEN");
    expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 1);
  });

  test("a receipt no worker judges in time is RECEIPTS_UNAVAILABLE", async () => {
    const app = await election();
    const queue = await ReceiptQueue.open({ connection, prefix: prefixed(), timeoutMs: 200 });
    queues.push(queue);
    const { status, body } = await (await api(app, queue))(receiptFor(first, 1));
    expect(status).toBe(503);
    expect(body["code"]).toBe("RECEIPTS_UNAVAILABLE");
  });

  test("an answer the board doesn't back is a 500, never the worker's word", async () => {
    now = during;
    const app = await election();
    const log: unknown[] = [];
    const submit = await api(
      app,
      { submit: async () => ({ ok: true, index: "1", earlier: false }) },
      log,
    );
    // Entry 1 is a ballot, not the receipt sent.
    expect((await submit(receiptFor(first, 1))).status).toBe(500);
    // An earlier entry the board doesn't have is refused too.
    const beyond = await api(app, {
      submit: async () => ({ ok: true, index: "999", earlier: true }),
    });
    expect((await beyond(receiptFor(first, 1))).status).toBe(500);
    // And so is an earlier entry that isn't a share receipt: entry 1 is a ballot.
    const ballot = await api(app, {
      submit: async () => ({ ok: true, index: "1", earlier: true }),
    });
    expect((await ballot(receiptFor(first, 1))).status).toBe(500);
    // Even one small enough for the answer's bound.
    const small = await appendEntry(app, electionId, 0, Uint8Array.of(0x00, 0x05, 1));
    const record = await api(app, {
      submit: async () => ({ ok: true, index: small.index.toString(), earlier: true }),
    });
    expect((await record(receiptFor(first, 1))).status).toBe(500);
  });
});

describe("the receipt bound", () => {
  test("every share receipt version fits MAX_SHARE_RECEIPT, the queue's bound too", () => {
    const v1 = receiptFor(first, 1);
    const v2 = encodeShareReceiptV2({ ...decodeShareReceipt(v1, 1), panel: SEAT_PANELS.default });
    for (const r of [v1, v2]) expect(r.length).toBeLessThanOrEqual(MAX_SHARE_RECEIPT);
    expect(QUEUE_MAX_SHARE_RECEIPT).toBe(MAX_SHARE_RECEIPT);
  });
});
