import { p256 } from "@noble/curves/nist.js";
import { readFileSync } from "node:fs";
import {
  type BoardEntryVersion,
  decodeBoardEntry,
  type DestructionElection,
  destructionStatementMessage,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { dsSignature } from "../../crypto/src/domain-separation.ts";
import { decodeDefinition } from "../../verifier/src/definition.ts";
import {
  appendEntry,
  AppendError,
  boardDestructionStatements,
  DestructionBoardings,
  DestructionError,
  destructionTargets,
  openingTargets,
  readBoard,
  readBoardedDestructions,
  storeDefinition,
  takeCheckpoints,
} from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// The board path for destruction statements (src/destruction-boarding.ts;
// docs/spec/tally.md, Destruction, Boarding): a statement is boarded only if
// crypto's Boarding judge passes it, once per seat, a resend gets the entry
// already boarded, and a refusal writes nothing (T-17, T-29, T-52). The
// verdicts come from docs/spec/vectors/destruction.json, which an
// independent Python implementation wrote with its own decoder, attribution
// and report.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface Report {
  readonly id: string;
  readonly entries: readonly { readonly segment: number; readonly payload: string }[];
  readonly result: {
    readonly seats: readonly { readonly seat: number; readonly at?: number }[];
    readonly duplicates: readonly { readonly at: number; readonly seat: number }[];
    readonly unattributed: readonly { readonly at: number }[];
    readonly stray: readonly { readonly at: number }[];
    readonly rejected: readonly { readonly at: number }[];
  };
}
const vectors = read("destruction.json") as {
  readonly election: {
    readonly definitionHash: string;
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
  };
  readonly statements: readonly {
    readonly id: string;
    readonly signingSecret: string;
    readonly encoding: string;
  }[];
  readonly reports: readonly Report[];
};
const election: DestructionElection = {
  definitionHash: hex(vectors.election.definitionHash),
  registered: vectors.election.registered.map((k) => ({
    index: k.index,
    signingKey: hex(k.signingKey),
  })),
};
const statement = (id: string) => {
  const s = vectors.statements.find((x) => x.id === id);
  if (s === undefined) throw new Error(`destruction.json: no ${id} statement`);
  return s;
};
const seat1 = hex(statement("seat-1").encoding);
const seat2 = hex(statement("seat-2").encoding);

/**
 * What submitting statement `at` after the ones before it does, read off the
 * vector's report: refused with its code, boarded, or a repeat of the seat's
 * first statement, which gets that statement's entry.
 */
function expected(r: Report, at: number): { code: string } | "boarded" | { repeat: number } {
  if (r.result.rejected.some((x) => x.at === at)) return { code: "decode" };
  if (r.result.stray.some((x) => x.at === at)) return { code: "destruction-stray" };
  if (r.result.unattributed.some((x) => x.at === at)) return { code: "destruction-unattributed" };
  const duplicate = r.result.duplicates.find((x) => x.at === at);
  if (duplicate !== undefined) {
    const first = r.result.seats.find((s) => s.seat === duplicate.seat)?.at;
    if (first === undefined) throw new Error(`${r.id}: a duplicate with no first statement`);
    return { repeat: first };
  }
  if (r.result.seats.some((s) => s.at === at)) return "boarded";
  throw new Error(`statement ${at} of ${r.id} is in no report`);
}

const CLOCK = { epoch: 1_000_000n, period: 3_600n };
const NOW = CLOCK.epoch + 10n * CLOCK.period;

let db: TestDb;
let owner: Sql;
beforeAll(async () => {
  db = await testDb();
  owner = await db.as("abolish_migrator");
});
afterAll(async () => {
  await db?.close();
});

async function failsWith(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DestructionError) return e.rejection ?? e.code;
    if (e instanceof AppendError) return e.code;
    throw e;
  }
  return "boarded";
}

const boardings = (target: DestructionElection | undefined = election) =>
  new DestructionBoardings({ target: async () => target, clock: CLOCK });

describe("the Boarding rule on the board path", () => {
  for (const r of vectors.reports)
    test(`${r.id}: each statement as the vector's report decides it`, async () => {
      const app = await db.as("abolish_app");
      const id = await newElection(app);
      const boarding = boardings();
      const entries = new Map<number, bigint>();
      for (const [at, { payload }] of r.entries.entries()) {
        const want = expected(r, at);
        const before = (await readBoard(app, id)).length;
        let got;
        try {
          got = await boarding.submitDestruction(app, id, hex(payload), NOW);
        } catch (err) {
          if (!(err instanceof DestructionError)) throw err;
          expect(err.code, `statement ${at}`).toBe("rejected");
          expect({ code: err.rejection }, `statement ${at}`).toEqual(want);
          expect((await readBoard(app, id)).length).toBe(before);
          continue;
        }
        if (want === "boarded") {
          expect(got.index, `statement ${at}`).toBe(BigInt(before));
          entries.set(at, got.index);
        } else {
          expect(typeof want === "object" && "repeat" in want, `statement ${at}`).toBe(true);
          if (typeof want !== "object" || !("repeat" in want)) continue;
          expect(got.index).toBe(entries.get(want.repeat));
          expect((await readBoard(app, id)).length).toBe(before);
        }
        const encoded = (await readBoard(app, id))[Number(got.index)] as Uint8Array;
        expect(got.entry).toEqual(encoded);
      }
      // Each boarded statement is keyed by its seat, in board order.
      expect((await readBoardedDestructions(app, id)).map((s) => s.index)).toEqual([
        ...entries.values(),
      ]);
    });
});

describe("submitting statements", () => {
  test("boards each seat's statement once, and answers a resend with its entry", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    const boarding = boardings();
    const first = await boarding.submitDestruction(app, id, seat1, NOW);
    const second = await boarding.submitDestruction(app, id, seat2, NOW);
    expect([first.index, second.index]).toEqual([0n, 1n]);
    expect(await boarding.submitDestruction(app, id, seat1, NOW + 7_200n)).toEqual(first);
    expect(await readBoard(app, id)).toHaveLength(2);
    expect(decodeBoardEntry(first.entry, 5).payload).toEqual(seat1);
  });

  test("labels a statement by the clock, never below a segment already on the board", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    await appendEntry(app, id, 12, Uint8Array.of(0x00, 0x05, 1));
    const boarding = boardings();
    const at = await boarding.submitDestruction(app, id, seat1, NOW);
    expect(decodeBoardEntry(at.entry, 5).segment).toBe(12);
    const later = await boarding.submitDestruction(app, id, seat2, NOW + 5n * CLOCK.period);
    expect(decodeBoardEntry(later.entry, 5).segment).toBe(15);
  });

  test("labels a statement after the last checkpoint taken", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    await appendEntry(app, id, 20, Uint8Array.of(0x00, 0x05, 1));
    await takeCheckpoints(app, id, 20);
    const at = await boardings().submitDestruction(app, id, seat1, NOW);
    expect(decodeBoardEntry(at.entry, 5).segment).toBe(21);
  });

  test("answers not-ready before the clock's epoch, or after the segment's spoiled-ballot openings", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    const boarding = boardings();
    expect(await failsWith(boarding.submitDestruction(app, id, seat1, 0n))).toBe("not-ready");
    await appendEntry(app, id, 10, Uint8Array.of(0x00, 0x03, 1));
    expect(await failsWith(boarding.submitDestruction(app, id, seat1, NOW))).toBe("not-ready");
    expect(await readBoard(app, id)).toHaveLength(1);
    // In the next segment it is boarded.
    const at = await boarding.submitDestruction(app, id, seat1, NOW + CLOCK.period);
    expect(decodeBoardEntry(at.entry, 5).segment).toBe(11);
  });

  test("boards one entry for copies racing in on two connections", async () => {
    const id = await newElection(await db.as("abolish_app"));
    const boarding = boardings();
    const clients = await Promise.all([db.as("abolish_app"), db.as("abolish_app")]);
    const answers = await Promise.all(
      [...clients, ...clients].map((c) => boarding.submitDestruction(c, id, seat1, NOW)),
    );
    expect(new Set(answers.map((a) => a.index))).toEqual(new Set([0n]));
    expect(await readBoard(clients[0] as Sql, id)).toHaveLength(1);
  });

  test("answers the seat's statement in other bytes with the entry boarded, whenever it was boarded", async () => {
    // Seat 1's one message signed with another nonce than RFC 6979's.
    const signature = p256.sign(
      dsSignature(
        "abolish/v1/sig/destruction",
        destructionStatementMessage({ definition_hash: election.definitionHash, signer: 1 }),
      ),
      hex(statement("seat-1").signingSecret),
      { prehash: true, lowS: true, format: "compact", extraEntropy: true },
    );
    const resigned = Uint8Array.of(...seat1.subarray(0, 36), ...signature);
    expect(resigned).not.toEqual(seat1);
    const app = await db.as("abolish_app");
    // Judged against the board read before it.
    const id = await newElection(app);
    const first = await boardings().submitDestruction(app, id, seat1, NOW);
    expect(await boardings().submitDestruction(app, id, resigned, NOW)).toEqual(first);
    // Racing in on two connections, in either bytes: one entry, every answer its.
    const raced = await newElection(app);
    const clients = await Promise.all([db.as("abolish_app"), db.as("abolish_app")]);
    const answers = await Promise.all(
      [seat1, resigned, resigned, seat1].map((bytes, i) =>
        boardings().submitDestruction(clients[i % 2] as Sql, raced, bytes, NOW),
      ),
    );
    expect(new Set(answers.map((x) => x.index))).toEqual(new Set([0n]));
    expect(await readBoard(app, raced)).toHaveLength(1);
  });

  test("refuses where no target is given, keeps a target once read, and asks again for none", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    let asked = 0;
    let target: DestructionElection | undefined;
    const boarding = new DestructionBoardings({
      target: async () => {
        asked++;
        return target;
      },
      clock: CLOCK,
    });
    expect(await failsWith(boarding.submitDestruction(app, id, seat1, NOW))).toBe("not-open");
    expect(await failsWith(boarding.submitDestruction(app, id, seat1, NOW))).toBe("not-open");
    expect(asked).toBe(2);
    target = election;
    await boarding.submitDestruction(app, id, seat1, NOW);
    await boarding.submitDestruction(app, id, seat2, NOW);
    expect(asked).toBe(3);
  });

  test("refuses a statement on a board whose version doesn't allow one, writing nothing", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app, 3);
    expect(await failsWith(boardings().submitDestruction(app, id, seat1, NOW))).toBe(
      "invalid-entry",
    );
    expect(await readBoard(app, id)).toHaveLength(0);
  });

  test("refuses arguments that aren't what they say", async () => {
    const app = await db.as("abolish_app");
    const boarding = boardings();
    await expect(boarding.submitDestruction(app, new Uint8Array(31), seat1, NOW)).rejects.toThrow(
      TypeError,
    );
    await expect(
      boarding.submitDestruction(app, new Uint8Array(32), "x" as unknown as Uint8Array, NOW),
    ).rejects.toThrow(TypeError);
    await expect(boarding.submitDestruction(app, new Uint8Array(32), seat1, -1n)).rejects.toThrow(
      TypeError,
    );
    expect(
      () =>
        new DestructionBoardings({
          target: async () => election,
          clock: { epoch: 0n, period: 0n },
        }),
    ).toThrow(RangeError);
  });
});

describe("appendEntry's destruction key", () => {
  const destruction = (n: number) => Uint8Array.of(0x00, 0x0f, n);

  test("boards one statement per seat, naming the one boarded", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    const first = await appendEntry(app, id, 0, destruction(1), { destruction: { seat: 1 } });
    // The same bytes are its entry again; other bytes are refused, naming it.
    expect(await appendEntry(app, id, 0, destruction(1), { destruction: { seat: 1 } })).toEqual(
      first,
    );
    let refused: unknown;
    try {
      await appendEntry(app, id, 0, destruction(2), { destruction: { seat: 1 } });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(AppendError);
    expect((refused as AppendError).code).toBe("destruction-present");
    expect((refused as AppendError).existing).toEqual({ ...first, payload: destruction(1) });
    // Another seat is another key.
    expect(
      (await appendEntry(app, id, 0, destruction(2), { destruction: { seat: 2 } })).index,
    ).toBe(1n);
    expect(await readBoard(app, id)).toHaveLength(2);
  });

  test("refuses a statement without its key, a key on another record type, or out of range", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    // Unkeyed, the next statement's judge wouldn't see it (T-17).
    expect(await failsWith(appendEntry(app, id, 0, destruction(1)))).toBe("invalid-entry");
    for (const [payload, seat] of [
      [Uint8Array.of(0x00, 0x06, 1), 1],
      [destruction(1), 0],
      [destruction(1), 256],
      [destruction(1), 1.5],
    ] as const)
      expect(await failsWith(appendEntry(app, id, 0, payload, { destruction: { seat } }))).toBe(
        "invalid-entry",
      );
    expect(await readBoard(app, id)).toHaveLength(0);
  });
});

describe("the table", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'board_destruction_statements'
      ORDER BY ordinal_position`;
    const config = getTableConfig(boardDestructionStatements);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const indexes = await db.admin`
      SELECT i.indisprimary AS pk, array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum)) AS cols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`"${db.schema}".board_destruction_statements`}::regclass AND i.indisunique
      GROUP BY i.indexrelid, i.indisprimary ORDER BY i.indisprimary DESC`;
    expect(indexes.map((r) => [r["pk"], r["cols"]])).toEqual([
      [true, config.primaryKeys[0]!.columns.map((c) => c.name)],
      ...config.uniqueConstraints.map((u) => [false, u.columns.map((c) => c.name)]),
    ]);
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'board_destruction_statements'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });

  test("nobody can change or remove a row", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    await appendEntry(app, id, 0, Uint8Array.of(0x00, 0x0f, 1), { destruction: { seat: 1 } });
    for (const client of [app, owner]) {
      for (const query of [
        client`UPDATE board_destruction_statements SET idx = idx WHERE election_id = ${id}`,
        client`DELETE FROM board_destruction_statements WHERE election_id = ${id}`,
        client`TRUNCATE board_destruction_statements`,
      ])
        await expect(query).rejects.toMatchObject({ code: "42501" });
    }
    const [row] =
      await db.admin`SELECT count(*)::int AS n FROM board_destruction_statements WHERE election_id = ${id}`;
    expect(row?.["n"]).toBe(1);
  });

  test("a row names a destruction statement on the board", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    await appendEntry(app, id, 0, Uint8Array.of(0x00, 0x05, 1));
    await expect(
      app`INSERT INTO board_destruction_statements VALUES (${id}, 1, 0)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      app`INSERT INTO board_destruction_statements VALUES (${id}, 1, 1)`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// Each election's target over verifier-ballots.json's `admitted` case: its
// stored definition and the transcript at entry 0.
describe("the targets", () => {
  const ballots = read("verifier-ballots.json") as {
    readonly panels: Readonly<Record<string, unknown>>;
    readonly cases: readonly {
      readonly id: string;
      readonly panel: string;
      readonly definition: string;
      readonly board: string;
    }[];
  };
  const admitted = ballots.cases.find((c) => c.id === "admitted");
  if (admitted === undefined) throw new Error("no admitted case");
  const definition = hex(admitted.definition);
  const d = decodeDefinition(definition).value;
  const boardVersion = pinnedVersion(d, RECORD_TYPES.boardEntry) as BoardEntryVersion;
  const panelJson = ballots.panels[admitted.panel] as {
    readonly threshold: string;
    readonly keys: readonly string[];
  };
  const panel = { threshold: Number(panelJson.threshold), keys: panelJson.keys.map(hex) };

  test("reads each election's target as its opening target, where its board allows a statement", async () => {
    const own = await testDb();
    try {
      const app = await own.as("abolish_app");
      await storeDefinition(app, definition);
      const [first] = (await import("@abolishus/verifier")).splitEntries(
        hex(admitted.board),
      ).entries;
      if (first === undefined) throw new Error("no entry 0");
      const e = decodeBoardEntry(first, boardVersion);
      await appendEntry(app, d.election_id, e.segment, e.payload);
      const opening = await openingTargets([panel])(app, d.election_id);
      if (opening === undefined) return expect.fail("no opening target");
      expect(await destructionTargets([panel])(app, d.election_id)).toEqual({
        definitionHash: opening.definitionHash,
        registered: opening.registered,
      });
      // No transcript at entry 0 yet: no target.
      const bare = await newElection(app);
      expect(await destructionTargets([panel])(app, bare)).toBeUndefined();
      expect(await failsWith(destructionTargets([panel])(app, new Uint8Array(32)))).toBe(
        "unknown-election",
      );
    } finally {
      await own.close();
    }
  });
});
