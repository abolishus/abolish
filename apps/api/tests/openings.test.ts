import { MAX_TALLY_OPENING } from "@abolishus/api-contract";
import {
  appendEntry,
  BallotAdmissions,
  type CountedTally,
  OpeningBoardings,
  readBoard,
} from "@abolishus/core";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import {
  aggregateCell,
  aggregateHash,
  decodeBoardEntry,
  encodeTallyOpening,
  identityKey,
  PARAMETERS,
  signTallyOpening,
  type TallyElection,
} from "@abolishus/crypto";
import {
  MAX_TALLY_OPENING as QUEUE_MAX_TALLY_OPENING,
  OpeningQueue,
  type RunningWorker,
  startWorker,
} from "@abolishus/worker";
import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { panel } from "../../../packages/verifier/tests/receipt-poll.ts";
import { createApiServer, type OpeningSubmitter } from "../src/index.ts";

// `openings.submit`, the board path for tally openings, over HTTP through
// the worker's `{opening-submit}` queue on a live Redis (docs/spec/tally.md,
// Opening record, Boarding): a passing opening is boarded and answered with
// its entry and link, read from the board; the same bytes again return that
// entry; a refused one is OPENING_REJECTED with core's code, with nothing
// written; before the counted set is fixed it is OPENING_NOT_READY, and
// where it never is, ELECTION_NOT_OPEN (T-17, T-29, T-52). Without an
// outcome in time it is OPENINGS_UNAVAILABLE, and without a queue nothing
// is boarded. The request log holds only the method, route, status and
// duration (T-10, T-11). The counted tally is given to the worker's
// boarding directly, as in core's tally-boarding test, over two empty cells
// whose openings seats of a made-up panel sign.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

const VERSION = 5;
const CLOCK = { epoch: 1_000_000n, period: 3_600n };
const NOW = CLOCK.epoch + 10n * CLOCK.period;
const SECRETS = [1, 2, 3].map((i) => new Uint8Array(32).fill(i));
const own: TallyElection = {
  definitionHash: new Uint8Array(32).fill(0xd1),
  rules: { optionCount: 3, threshold: 2, panelSize: 3 },
  registered: [1, 2].map((index) => ({
    index,
    signingKey: identityKey(SECRETS[index - 1] as Uint8Array),
  })),
};
const empty = aggregateCell(own.rules, []);
const FIXED: CountedTally = {
  state: "fixed",
  election: own,
  aggregates: [empty, empty],
  counted: [0, 0],
  tiers: [0, 0],
  pinned: 1,
  lastSegment: 5,
};
const openingOf = (cell: number, signer: number, options = 3) =>
  encodeTallyOpening(
    signTallyOpening(SECRETS[signer - 1] as Uint8Array, {
      definition_hash: own.definitionHash,
      cell,
      aggregate_hash: aggregateHash(empty),
      signer,
      opening: Array.from({ length: options }, () => ({ v: 0n, r: 0n })),
    }),
    1,
  );

let connection: Redis;
const dbs: TestDb[] = [];
const servers: Server[] = [];
const workers: RunningWorker[] = [];
const queues: OpeningQueue[] = [];
const prefixes: string[] = [];

/** A schema of its own with an election stored. */
async function election(): Promise<{ app: Sql; id: Uint8Array }> {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  return { app, id: await newElection(app) };
}

const prefixed = () => {
  const prefix = `abolish-test-api-openings-${hex(randomBytes(6))}`;
  prefixes.push(prefix);
  return prefix;
};

/** A worker boarding openings for `sql` against `tally`, and the API's queue to it, under a prefix of their own. */
async function judging(sql: Sql, tally: CountedTally = FIXED): Promise<OpeningQueue> {
  const prefix = prefixed();
  workers.push(
    await startWorker({
      connection,
      sql,
      log: () => {},
      auditEveryMs: 3_600_000,
      prefix,
      now: () => new Date(Number(NOW) * 1000),
      ballots: { admissions: new BallotAdmissions({ panels: [panel], clock: CLOCK }) },
      openings: {
        boardings: new OpeningBoardings({
          tally: async () => tally,
          target: async () => ({
            definitionHash: own.definitionHash,
            pinned: 1,
            registered: own.registered,
          }),
          clock: CLOCK,
        }),
      },
    }),
  );
  const openings = await OpeningQueue.open({ connection, prefix });
  queues.push(openings);
  return openings;
}

/** An API on `sql` with `openings`, and a function submitting an opening to it. */
async function api(sql: Sql, id: Uint8Array, openings?: OpeningSubmitter, log: unknown[] = []) {
  const s = createApiServer({
    sql,
    log: (l) => log.push(l),
    ...(openings !== undefined && { openings }),
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/openings`;
  return async (opening: Uint8Array, electionId = id) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ electionId: hex(electionId), opening: hex(opening) }),
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
  for (const prefix of prefixes)
    for (const key of await connection.keys(`${prefix}:*`)) await connection.del(key);
  connection?.disconnect();
  await Promise.all(dbs.map((d) => d.close()));
});

describe("openings.submit with the Boarding rule", { timeout: 60_000 }, () => {
  test("boards each seat's opening of each cell, answering the entry and link the board holds", async () => {
    const { app, id } = await election();
    const log: unknown[] = [];
    const submit = await api(app, id, await judging(app), log);
    for (const [size, [cell, seat]] of [
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
    ].entries()) {
      const opening = openingOf(cell as number, seat as number);
      const { status, body } = await submit(opening);
      expect(status).toBe(201);
      expect(Object.keys(body).sort()).toEqual(["earlier", "entry", "link"]);
      expect(body["earlier"]).toBe(false);
      const entry = decodeBoardEntry(unhex(body["entry"] as string), VERSION);
      expect(entry.payload).toEqual(opening);
      expect(entry.index).toBe(BigInt(size));
      const board = await readBoard(app, id);
      expect(board).toHaveLength(size + 1);
      expect(body["entry"]).toBe(hex(board[size]!));
      expect(body["link"]).toMatch(/^[0-9a-f]{64}$/);
    }
    // T-10, T-11: the log names the route, never the opening or election.
    expect(log).toContainEqual({
      method: "POST",
      route: "POST /openings",
      status: 201,
      ms: expect.any(Number),
    });
    for (const line of log) expect(JSON.stringify(line)).not.toContain(hex(id));
  });

  test("the same bytes again return their entry and link, writing nothing", async () => {
    const { app, id } = await election();
    const submit = await api(app, id, await judging(app));
    const once = await submit(openingOf(0, 1));
    expect(await submit(openingOf(0, 1))).toEqual(once);
    expect(await readBoard(app, id)).toHaveLength(1);
  });

  test("a refused opening is OPENING_REJECTED with its code, writing nothing", async () => {
    const { app, id } = await election();
    const submit = await api(app, id, await judging(app));
    await submit(openingOf(0, 1));
    const cases: [Uint8Array, string][] = [
      [Uint8Array.of(0x00, 0x06, 1), "decode"],
      [openingOf(0, 3), "tally-unattributed"],
      [openingOf(5, 1), "tally-stray"],
      [openingOf(0, 2, 2), "tally-missing"],
    ];
    for (const [opening, code] of cases) {
      const { status, body } = await submit(opening);
      expect(status, code).toBe(422);
      expect(body["code"]).toBe("OPENING_REJECTED");
      expect((body["data"] as { code: string }).code, code).toBe(code);
    }
    expect(await readBoard(app, id)).toHaveLength(1);
  });

  test("before the counted set is fixed it is OPENING_NOT_READY; where it never is, ELECTION_NOT_OPEN", async () => {
    const { app, id } = await election();
    const early = await api(app, id, await judging(app, { state: "waiting" }));
    const { status, body } = await early(openingOf(0, 1));
    expect(status).toBe(503);
    expect(body["code"]).toBe("OPENING_NOT_READY");
    const never = await api(app, id, await judging(app, { state: "refused", reason: "a test's" }));
    const refused = await never(openingOf(0, 1));
    expect(refused.status).toBe(409);
    expect(refused.body["code"]).toBe("ELECTION_NOT_OPEN");
    expect(await readBoard(app, id)).toHaveLength(0);
  });

  test("an election this server doesn't hold is ELECTION_NOT_FOUND, never queued", async () => {
    const { app, id } = await election();
    const submit = await api(app, id, {
      submit: () => {
        throw new Error("queued an unknown election");
      },
    });
    const { status, body } = await submit(openingOf(0, 1), new Uint8Array(randomBytes(32)));
    expect(status).toBe(404);
    expect(body["code"]).toBe("ELECTION_NOT_FOUND");
  });

  test("without a queue nothing is boarded: ELECTION_NOT_OPEN", async () => {
    const { app, id } = await election();
    const { status, body } = await (await api(app, id))(openingOf(0, 1));
    expect(status).toBe(409);
    expect(body["code"]).toBe("ELECTION_NOT_OPEN");
    expect(await readBoard(app, id)).toHaveLength(0);
  });

  test("an opening no worker judges in time is OPENINGS_UNAVAILABLE", async () => {
    const { app, id } = await election();
    const queue = await OpeningQueue.open({ connection, prefix: prefixed(), timeoutMs: 200 });
    queues.push(queue);
    const { status, body } = await (await api(app, id, queue))(openingOf(0, 1));
    expect(status).toBe(503);
    expect(body["code"]).toBe("OPENINGS_UNAVAILABLE");
  });

  test("an earlier entry is answered only when it is a tally opening of the version sent", async () => {
    const { app, id } = await election();
    // A resend of a signed message boarded in other bytes, as the worker
    // answers it: the entry carries the earlier opening.
    const earlier = await appendEntry(app, id, 6, openingOf(0, 2), {
      opening: { cell: 0, seat: 2 },
    });
    const ballot = await appendEntry(app, id, 6, Uint8Array.of(0x00, 0x02, 1));
    const at = (index: bigint) =>
      api(app, id, { submit: async () => ({ ok: true, index: index.toString() }) });
    const { status, body } = await (await at(earlier.index))(openingOf(0, 1));
    expect(status).toBe(201);
    expect(body).toEqual({ entry: hex(earlier.entry), link: hex(earlier.link), earlier: true });
    // Never the worker's word: a ballot, or no entry at all, is a 500.
    expect((await (await at(ballot.index))(openingOf(0, 1))).status).toBe(500);
    expect((await (await at(999n))(openingOf(0, 1))).status).toBe(500);
  });
});

describe("the opening bound", () => {
  test("a whole opening of MAX_OPTIONS options fits MAX_TALLY_OPENING, the queue's bound too", () => {
    const largest = openingOf(255, 2, PARAMETERS.MAX_OPTIONS);
    expect(largest.length).toBeLessThanOrEqual(MAX_TALLY_OPENING);
    // Version 2 is version 1's layout byte for byte.
    expect(largest.length * 2).toBeGreaterThan(MAX_TALLY_OPENING);
    expect(QUEUE_MAX_TALLY_OPENING).toBe(MAX_TALLY_OPENING);
  });
});
