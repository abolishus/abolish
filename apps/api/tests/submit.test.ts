import { decodeBoardEntry, decodeElectionDefinition, type Panel } from "@abolishus/crypto";
import { appendEntry, BallotAdmissions, readBoard, storeDefinition } from "@abolishus/core";
import { type TestDb, testDb } from "@abolishus/core/test-db";
import { splitEntries } from "@abolishus/verifier";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { createApiServer } from "../src/index.ts";

// `ballots.submit` with admission, over HTTP: an admitted ballot is boarded
// and answered with its entry and link, a rejected one is BALLOT_REJECTED
// with the verifier's code, a repeat of a boarded ballot (5.7) is answered
// with that ballot's entry if its bytes are the same and is BALLOT_REJECTED
// with `repeat` otherwise, and outside the window ELECTION_NOT_OPEN, with
// nothing written but the admitted ballot (T-17, T-38, T-52). The request log still holds only
// the method, route, status and duration (T-10, T-11). Fixtures:
// docs/spec/vectors/verifier-ballots.json (an independent implementation's
// verdicts).

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
let now = definition.opens_at + 60n;
const logs: unknown[] = [];

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  await storeDefinition(app, unhex(mixed.definition));
  await appendEntry(app, electionId, entries[0]!.segment, entries[0]!.payload);
  server = createApiServer({
    sql: app,
    log: (l) => logs.push(l),
    admissions: new BallotAdmissions({
      panels: [panel],
      clock: { epoch: definition.opens_at, period: 3_600n },
    }),
    now: () => now,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await db?.close();
});

const submit = (ballot: Uint8Array, id = electionId) =>
  fetch(`${base}/ballots`, {
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
    const s = createApiServer({
      sql,
      log: () => {},
      admissions: new BallotAdmissions({
        panels: [panel],
        clock: { epoch: definition.opens_at, period: 3_600n },
      }),
      now: () => definition.opens_at + 60n,
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/ballots`;
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

  test("the request log names no ballot (T-10)", () => {
    const ballots = new Set(entries.map((e) => hex(e.payload)));
    for (const line of logs) {
      expect(Object.keys(line as object).sort()).toEqual(["method", "ms", "route", "status"]);
      expect([...ballots].some((b) => JSON.stringify(line).includes(b.slice(0, 64)))).toBe(false);
    }
    expect(logs.length).toBeGreaterThan(0);
  });
});
