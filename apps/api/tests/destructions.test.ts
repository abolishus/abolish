import { MAX_DESTRUCTION_STATEMENT } from "@abolishus/api-contract";
import { appendEntry, BallotAdmissions, DestructionBoardings, readBoard } from "@abolishus/core";
import { newElection, type TestDb, testDb } from "@abolishus/core/test-db";
import {
  decodeBoardEntry,
  type DestructionElection,
  encodeDestructionStatement,
  encodePanelDestructionStatement,
  identityKey,
  signDestructionStatement,
  signPanelDestructionStatement,
} from "@abolishus/crypto";
import {
  DestructionQueue,
  MAX_DESTRUCTION_STATEMENT as QUEUE_MAX_DESTRUCTION_STATEMENT,
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
import { createApiServer, type DestructionSubmitter } from "../src/index.ts";

// `destructions.submit`, the board path for destruction statements, over
// HTTP through the worker's `{destruction-submit}` queue on a live Redis
// (docs/spec/tally.md, Destruction, Boarding): a passing statement is
// boarded and answered with its entry and link, read from the board; the
// same bytes again return that entry; a refused one is DESTRUCTION_REJECTED
// with core's code, with nothing written; where the election takes none it
// is ELECTION_NOT_OPEN (T-17, T-52). Without an outcome in time it is
// DESTRUCTIONS_UNAVAILABLE, and without a queue nothing is boarded. The
// request log holds only the method, route, status and duration (T-10,
// T-11). The target is given to the worker's boarding directly, as in core's
// destruction-boarding test, with seats of a made-up panel signing.

const redisUrl = process.env["REDIS_URL"];
if (!redisUrl) throw new Error("REDIS_URL is not set");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

const VERSION = 5;
const CLOCK = { epoch: 1_000_000n, period: 3_600n };
const NOW = CLOCK.epoch + 10n * CLOCK.period;
const SECRETS = [1, 2, 3].map((i) => new Uint8Array(32).fill(i));
const own: DestructionElection = {
  definitionHash: new Uint8Array(32).fill(0xd1),
  registered: [1, 2].map((index) => ({
    index,
    signingKey: identityKey(SECRETS[index - 1] as Uint8Array),
  })),
};
const statementOf = (signer: number, definitionHash = own.definitionHash) =>
  encodeDestructionStatement(
    signDestructionStatement(SECRETS[signer - 1] as Uint8Array, {
      definition_hash: definitionHash,
      signer,
    }),
  );

let connection: Redis;
const dbs: TestDb[] = [];
const servers: Server[] = [];
const workers: RunningWorker[] = [];
const queues: DestructionQueue[] = [];
const prefixes: string[] = [];

/** A schema of its own with an election stored. */
async function election(): Promise<{ app: Sql; id: Uint8Array }> {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  return { app, id: await newElection(app) };
}

const prefixed = () => {
  const prefix = `abolish-test-api-destructions-${hex(randomBytes(6))}`;
  prefixes.push(prefix);
  return prefix;
};

/** A worker boarding statements for `sql` against `target`, and the API's queue to it, under a prefix of their own. */
async function judging(
  sql: Sql,
  target: DestructionElection | "none" = own,
): Promise<DestructionQueue> {
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
      destructions: {
        boardings: new DestructionBoardings({
          target: async () => (target === "none" ? undefined : target),
          clock: CLOCK,
        }),
      },
    }),
  );
  const destructions = await DestructionQueue.open({ connection, prefix });
  queues.push(destructions);
  return destructions;
}

/** An API on `sql` with `destructions`, and a function submitting a statement to it. */
async function api(
  sql: Sql,
  id: Uint8Array,
  destructions?: DestructionSubmitter,
  log: unknown[] = [],
) {
  const s = createApiServer({
    sql,
    log: (l) => log.push(l),
    ...(destructions !== undefined && { destructions }),
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/destructions`;
  return async (statement: Uint8Array, electionId = id) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ electionId: hex(electionId), statement: hex(statement) }),
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

describe("destructions.submit with the Boarding rule", { timeout: 60_000 }, () => {
  test("boards each seat's statement, answering the entry and link the board holds", async () => {
    const { app, id } = await election();
    const log: unknown[] = [];
    const submit = await api(app, id, await judging(app), log);
    for (const [size, seat] of [1, 2].entries()) {
      const statement = statementOf(seat);
      const { status, body } = await submit(statement);
      expect(status).toBe(201);
      expect(Object.keys(body).sort()).toEqual(["earlier", "entry", "link"]);
      expect(body["earlier"]).toBe(false);
      const entry = decodeBoardEntry(unhex(body["entry"] as string), VERSION);
      expect(entry.payload).toEqual(statement);
      expect(entry.index).toBe(BigInt(size));
      const board = await readBoard(app, id);
      expect(board).toHaveLength(size + 1);
      expect(body["entry"]).toBe(hex(board[size]!));
      expect(body["link"]).toMatch(/^[0-9a-f]{64}$/);
    }
    // T-10, T-11: the log names the route, never the statement or election.
    expect(log).toContainEqual({
      method: "POST",
      route: "POST /destructions",
      status: 201,
      ms: expect.any(Number),
    });
    for (const line of log) expect(JSON.stringify(line)).not.toContain(hex(id));
  });

  test("the same bytes again return their entry and link, writing nothing", async () => {
    const { app, id } = await election();
    const submit = await api(app, id, await judging(app));
    const once = await submit(statementOf(1));
    expect(await submit(statementOf(1))).toEqual(once);
    expect(await readBoard(app, id)).toHaveLength(1);
  });

  test("a refused statement is DESTRUCTION_REJECTED with its code, writing nothing", async () => {
    const { app, id } = await election();
    const submit = await api(app, id, await judging(app));
    await submit(statementOf(1));
    const cases: [Uint8Array, string][] = [
      [Uint8Array.of(0x00, 0x0f, 1), "decode"],
      [statementOf(3), "destruction-unattributed"],
      [statementOf(2, new Uint8Array(32).fill(0xd2)), "destruction-stray"],
    ];
    for (const [statement, code] of cases) {
      const { status, body } = await submit(statement);
      expect(status, code).toBe(422);
      expect(body["code"]).toBe("DESTRUCTION_REJECTED");
      expect((body["data"] as { code: string }).code, code).toBe(code);
    }
    expect(await readBoard(app, id)).toHaveLength(1);
  });

  test("where the election takes no statement, ELECTION_NOT_OPEN", async () => {
    const { app, id } = await election();
    const never = await api(app, id, await judging(app, "none"));
    const { status, body } = await never(statementOf(1));
    expect(status).toBe(409);
    expect(body["code"]).toBe("ELECTION_NOT_OPEN");
    expect(await readBoard(app, id)).toHaveLength(0);
  });

  test("an election this server doesn't hold is ELECTION_NOT_FOUND, never queued", async () => {
    const { app, id } = await election();
    const submit = await api(app, id, {
      submit: () => {
        throw new Error("queued an unknown election");
      },
    });
    const { status, body } = await submit(statementOf(1), new Uint8Array(randomBytes(32)));
    expect(status).toBe(404);
    expect(body["code"]).toBe("ELECTION_NOT_FOUND");
  });

  test("without a queue nothing is boarded: ELECTION_NOT_OPEN", async () => {
    const { app, id } = await election();
    const { status, body } = await (await api(app, id))(statementOf(1));
    expect(status).toBe(409);
    expect(body["code"]).toBe("ELECTION_NOT_OPEN");
    expect(await readBoard(app, id)).toHaveLength(0);
  });

  test("a statement no worker judges in time is DESTRUCTIONS_UNAVAILABLE", async () => {
    const { app, id } = await election();
    const queue = await DestructionQueue.open({ connection, prefix: prefixed(), timeoutMs: 200 });
    queues.push(queue);
    const { status, body } = await (await api(app, id, queue))(statementOf(1));
    expect(status).toBe(503);
    expect(body["code"]).toBe("DESTRUCTIONS_UNAVAILABLE");
  });

  test("a segment that can't take it yet is DESTRUCTION_NOT_READY", async () => {
    const { app, id } = await election();
    const submit = await api(app, id, {
      submit: async () => ({ ok: false, code: "not-ready" }),
    });
    const { status, body } = await submit(statementOf(1));
    expect(status).toBe(503);
    expect(body["code"]).toBe("DESTRUCTION_NOT_READY");
  });

  test("an earlier entry is answered only when it is a destruction statement of the version sent", async () => {
    const { app, id } = await election();
    // A resend of the seat's message boarded in other bytes, as the worker
    // answers it: the entry carries the earlier statement.
    const earlier = await appendEntry(app, id, 6, statementOf(1), { destruction: { seat: 1 } });
    const ballot = await appendEntry(app, id, 6, Uint8Array.of(0x00, 0x02, 1));
    const at = (index: bigint) =>
      api(app, id, { submit: async () => ({ ok: true, index: index.toString() }) });
    const other = statementOf(2);
    const { status, body } = await (await at(earlier.index))(other);
    expect(status).toBe(201);
    expect(body).toEqual({ entry: hex(earlier.entry), link: hex(earlier.link), earlier: true });
    // Never the worker's word: a ballot, or no entry at all, is a 500.
    expect((await (await at(ballot.index))(other)).status).toBe(500);
    expect((await (await at(999n))(other)).status).toBe(500);
  });
});

describe("the statement bound", () => {
  test("a statement of either version fits MAX_DESTRUCTION_STATEMENT, the queue's bound too", () => {
    const v2 = encodePanelDestructionStatement(
      signPanelDestructionStatement(SECRETS[0] as Uint8Array, {
        definition_hash: own.definitionHash,
        panel: 2,
        signer: 1,
      }),
    );
    expect(statementOf(1)).toHaveLength(100);
    expect(v2).toHaveLength(101);
    expect(v2.length).toBeLessThanOrEqual(MAX_DESTRUCTION_STATEMENT);
    expect(QUEUE_MAX_DESTRUCTION_STATEMENT).toBe(MAX_DESTRUCTION_STATEMENT);
  });
});
