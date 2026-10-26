import { readFileSync } from "node:fs";
import {
  aggregateCell,
  aggregateHash,
  type CellAggregate,
  checkpointHash,
  type CommittedVote,
  countedExtent,
  decode,
  type BoardEntryVersion,
  decodeBoardEntry,
  element,
  encodeTallyOpening,
  identityKey,
  list,
  pinnedVersion,
  RECORD_TYPES,
  signTallyOpening,
  type TallyElection,
  type WholeOpeningVersion,
} from "@abolishus/crypto";
import { countedTally, decodeHeader, type L1Header, splitEntries } from "@abolishus/verifier";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { decodeDefinition } from "../../verifier/src/definition.ts";
import { run } from "../../verifier/tests/headers.ts";
import {
  ANCHOR_FINALITY_MARGIN,
  anchoredCountedTally,
  type AnchoredCountedTallyOptions,
  appendEntry,
  AppendError,
  boardTallyOpenings,
  type CountedTally,
  OpeningBoardings,
  OpeningError,
  readBoard,
  readBoardedOpenings,
  storeDefinition,
  takeCheckpoints,
} from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// The board path for tally openings (src/tally-boarding.ts;
// docs/spec/tally.md, Opening record, Boarding): an opening is boarded only
// if crypto's Boarding judge passes it against the counted tally, once per
// cell and seat, a resend gets the entry already boarded, and a refusal
// writes nothing (T-17, T-29, T-52). The verdicts come from docs/spec/
// vectors/tally-opening.json, which an independent Python implementation
// wrote with its own sorting, attribution and per-opening codes; the counted
// tally they are judged against is given to the boarding directly. The
// operator's source of that tally, `anchoredCountedTally`, runs over
// verifier-ballots.json's `admitted` board, stored here and anchored by a
// scripted anchor.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface Report {
  readonly at: number;
  readonly signer: number | null;
}
interface VectorElection {
  readonly id: string;
  readonly cells: readonly (readonly string[])[];
  readonly openings: readonly string[];
  readonly result: {
    readonly cells: readonly {
      readonly passing: readonly Report[];
      readonly failing: readonly (Report & { readonly code: string })[];
    }[];
    readonly stray: readonly Report[];
    readonly rejected: readonly { readonly at: number }[];
  };
}
const vectors = read("tally-opening.json") as {
  readonly election: {
    readonly definitionHash: string;
    readonly rules: TallyElection["rules"];
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
  };
  readonly elections: readonly VectorElection[];
  readonly version2: { readonly elections: readonly VectorElection[] };
};
const vectorElection: TallyElection = {
  definitionHash: hex(vectors.election.definitionHash),
  rules: vectors.election.rules,
  registered: vectors.election.registered.map((k) => ({
    index: k.index,
    signingKey: hex(k.signingKey),
  })),
};
const VSS = list(list(element, 16), 64);
const aggregatesOf = (e: VectorElection) =>
  e.cells.map((c) =>
    aggregateCell(
      vectorElection.rules,
      c.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]),
    ),
  );

/**
 * What submitting opening `at` after the ones before it does, read off the
 * vector's report: refused with its code, boarded, or a repeat of the
 * earlier passing opening of its cell attributed to the same seat, which
 * gets that opening's entry.
 */
function expected(
  e: VectorElection,
  at: number,
): { code: string } | "boarded" | { repeat: number } {
  if (e.result.rejected.some((r) => r.at === at)) return { code: "decode" };
  if (e.result.stray.some((r) => r.at === at)) return { code: "tally-stray" };
  for (const c of e.result.cells) {
    const failing = c.failing.find((f) => f.at === at);
    if (failing !== undefined) return { code: failing.code };
    const passing = c.passing.find((p) => p.at === at);
    if (passing === undefined) continue;
    if (passing.signer === null) return { code: "tally-unattributed" };
    const first = c.passing.find((p) => p.signer === passing.signer);
    return first !== undefined && first.at < at ? { repeat: first.at } : "boarded";
  }
  throw new Error(`opening ${at} of ${e.id} is in no report`);
}

const fixed = (
  election: TallyElection,
  aggregates: readonly CellAggregate[],
  pinned: WholeOpeningVersion,
): CountedTally => ({ state: "fixed", election, aggregates, pinned });

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
    if (e instanceof OpeningError) return e.rejection ?? e.code;
    if (e instanceof AppendError) return e.code;
    throw e;
  }
  return "boarded";
}

const boardings = (tally: CountedTally) =>
  new OpeningBoardings({ tally: async () => tally, clock: CLOCK });

describe("the Boarding rule on the board path", () => {
  for (const [version, elections] of [
    [1, vectors.elections],
    [2, vectors.version2.elections],
  ] as const)
    for (const e of elections)
      test(`version ${version}, ${e.id}: each opening as the vector's report decides it`, async () => {
        const app = await db.as("abolish_app");
        const id = await newElection(app);
        const boarding = boardings(fixed(vectorElection, aggregatesOf(e), version));
        const entries = new Map<number, bigint>();
        for (const [at, opening] of e.openings.entries()) {
          const want = expected(e, at);
          const before = (await readBoard(app, id)).length;
          let got;
          try {
            got = await boarding.submitOpening(app, id, hex(opening), NOW);
          } catch (err) {
            if (!(err instanceof OpeningError)) throw err;
            expect(err.code, `opening ${at}`).toBe("rejected");
            expect({ code: err.rejection }, `opening ${at}`).toEqual(want);
            expect((await readBoard(app, id)).length).toBe(before);
            continue;
          }
          if (want === "boarded") {
            expect(got.index, `opening ${at}`).toBe(BigInt(before));
            entries.set(at, got.index);
          } else {
            expect(typeof want === "object" && "repeat" in want, `opening ${at}`).toBe(true);
            if (typeof want !== "object" || !("repeat" in want)) continue;
            expect(got.index).toBe(entries.get(want.repeat));
            expect((await readBoard(app, id)).length).toBe(before);
          }
          const encoded = (await readBoard(app, id))[Number(got.index)] as Uint8Array;
          expect(got.entry).toEqual(encoded);
          expect(decodeBoardEntry(encoded, 5).payload).toEqual(hex(opening));
        }
        // Each boarded opening is keyed by its cell and seat, in board order.
        expect((await readBoardedOpenings(app, id)).map((o) => o.index)).toEqual([
          ...entries.values(),
        ]);
      });
});

// Seats of a panel of three, two registered, each signing whole openings of
// two empty cells: every option opens as (0, 0), so a seat's passing
// opening of a cell is the only one it can sign (binding; RFC 6979, low s).
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
const OWN = fixed(own, [empty, empty], 1);
const openingOf = (cell: number, signer: number, definitionHash = own.definitionHash) =>
  encodeTallyOpening(
    signTallyOpening(SECRETS[signer - 1] as Uint8Array, {
      definition_hash: definitionHash,
      cell,
      aggregate_hash: aggregateHash(empty),
      signer,
      opening: [0n, 0n, 0n].map(() => ({ v: 0n, r: 0n })),
    }),
    1,
  );

describe("submitting openings", () => {
  test("boards each seat's opening of each cell once, and answers a resend with its entry", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    const boarding = boardings(OWN);
    const first = await boarding.submitOpening(app, id, openingOf(0, 1), NOW);
    const second = await boarding.submitOpening(app, id, openingOf(0, 2), NOW);
    const third = await boarding.submitOpening(app, id, openingOf(1, 1), NOW);
    expect([first.index, second.index, third.index]).toEqual([0n, 1n, 2n]);
    expect(await boarding.submitOpening(app, id, openingOf(0, 2), NOW + 7_200n)).toEqual(second);
    expect(await readBoard(app, id)).toHaveLength(3);
    // Seat 3 isn't registered: its opening passes but is no one's.
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(1, 3), NOW))).toBe(
      "tally-unattributed",
    );
    // Another definition's opening is stray, whoever signed it.
    expect(
      await failsWith(boarding.submitOpening(app, id, openingOf(1, 2, new Uint8Array(32)), NOW)),
    ).toBe("tally-stray");
    expect(await readBoard(app, id)).toHaveLength(3);
  });

  test("labels an opening by the clock, never below a segment already on the board", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    await appendEntry(app, id, 12, Uint8Array.of(0x00, 0x05, 1));
    const boarding = boardings(OWN);
    const at = await boarding.submitOpening(app, id, openingOf(0, 1), NOW);
    expect(decodeBoardEntry(at.entry, 5).segment).toBe(12);
    const later = await boarding.submitOpening(app, id, openingOf(0, 2), NOW + 5n * 3_600n);
    expect(decodeBoardEntry(later.entry, 5).segment).toBe(15);
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(1, 1), 0n))).toBe("not-ready");
  });

  test("boards one entry for copies racing in on two connections", async () => {
    const id = await newElection(await db.as("abolish_app"));
    const boarding = boardings(OWN);
    const clients = await Promise.all([db.as("abolish_app"), db.as("abolish_app")]);
    const answers = await Promise.all(
      [...clients, ...clients].map((c) => boarding.submitOpening(c, id, openingOf(0, 1), NOW)),
    );
    expect(new Set(answers.map((a) => a.index))).toEqual(new Set([0n]));
    expect(await readBoard(clients[0] as Sql, id)).toHaveLength(1);
  });

  test("waits while the counted tally waits, and refuses where it is refused", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    let calls = 0;
    let ms = 0;
    let answer: CountedTally = { state: "waiting" };
    const boarding = new OpeningBoardings({
      tally: async () => {
        calls++;
        return answer;
      },
      clock: CLOCK,
      waitMs: 1_000,
      nowMs: () => ms,
    });
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW))).toBe(
      "not-ready",
    );
    // A waiting answer is kept for `waitMs`, then asked again.
    ms = 999;
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW))).toBe(
      "not-ready",
    );
    expect(calls).toBe(1);
    ms = 1_000;
    answer = { state: "refused", reason: "a test's" };
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW))).toBe("not-open");
    // A decided answer is kept for good.
    answer = OWN;
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW))).toBe("not-open");
    expect(calls).toBe(2);
    expect(await readBoard(app, id)).toHaveLength(0);
  });

  test("shares one computation among openings of an election sent at once", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const boarding = new OpeningBoardings({
      tally: async () => {
        calls++;
        await gate;
        return { state: "waiting" };
      },
      clock: CLOCK,
      waitMs: 0,
    });
    const sent = [0, 1, 2].map(() =>
      failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW)),
    );
    release();
    expect(await Promise.all(sent)).toEqual(["not-ready", "not-ready", "not-ready"]);
    expect(calls).toBe(1);
  });

  test("asks for a fixed counted tally once per election", async () => {
    const app = await db.as("abolish_app");
    const ids = [await newElection(app), await newElection(app)];
    let calls = 0;
    const boarding = new OpeningBoardings({
      tally: async () => {
        calls++;
        return OWN;
      },
      clock: CLOCK,
    });
    for (const id of ids)
      for (const [cell, seat] of [
        [0, 1],
        [0, 2],
        [1, 1],
      ] as const)
        await boarding.submitOpening(app, id, openingOf(cell, seat), NOW);
    expect(calls).toBe(2);
  });

  test("refuses arguments that aren't what they say", async () => {
    const app = await db.as("abolish_app");
    const boarding = boardings(OWN);
    const opening = openingOf(0, 1);
    await expect(boarding.submitOpening(app, new Uint8Array(31), opening, NOW)).rejects.toThrow(
      TypeError,
    );
    await expect(
      boarding.submitOpening(app, new Uint8Array(32), "x" as unknown as Uint8Array, NOW),
    ).rejects.toThrow(TypeError);
    await expect(boarding.submitOpening(app, new Uint8Array(32), opening, -1n)).rejects.toThrow(
      TypeError,
    );
    expect(
      () => new OpeningBoardings({ tally: async () => OWN, clock: { epoch: 0n, period: 0n } }),
    ).toThrow(RangeError);
  });
});

describe("appendEntry's opening key", () => {
  const opening = (n: number) => Uint8Array.of(0x00, 0x06, n);

  test("boards one opening per cell and seat, naming the one boarded", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    const first = await appendEntry(app, id, 0, opening(1), { opening: { cell: 0, seat: 1 } });
    // The same bytes are its entry again; other bytes are refused, naming it.
    expect(await appendEntry(app, id, 0, opening(1), { opening: { cell: 0, seat: 1 } })).toEqual(
      first,
    );
    let refused: unknown;
    try {
      await appendEntry(app, id, 0, opening(2), { opening: { cell: 0, seat: 1 } });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeInstanceOf(AppendError);
    expect((refused as AppendError).code).toBe("opening-present");
    expect((refused as AppendError).existing).toEqual({ ...first, payload: opening(1) });
    // Another seat, or another cell, is another key.
    expect(
      (await appendEntry(app, id, 0, opening(2), { opening: { cell: 0, seat: 2 } })).index,
    ).toBe(1n);
    expect(
      (await appendEntry(app, id, 0, opening(3), { opening: { cell: 1, seat: 1 } })).index,
    ).toBe(2n);
    expect(await readBoard(app, id)).toHaveLength(3);
  });

  test("refuses a key on another record type, or out of range", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    for (const [payload, key] of [
      [Uint8Array.of(0x00, 0x05, 1), { cell: 0, seat: 1 }],
      [opening(1), { cell: -1, seat: 1 }],
      [opening(1), { cell: 256, seat: 1 }],
      [opening(1), { cell: 0, seat: 0 }],
      [opening(1), { cell: 0, seat: 256 }],
      [opening(1), { cell: 0.5, seat: 1 }],
    ] as const)
      expect(await failsWith(appendEntry(app, id, 0, payload, { opening: key }))).toBe(
        "invalid-entry",
      );
    expect(await readBoard(app, id)).toHaveLength(0);
  });
});

describe("the table", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'board_tally_openings'
      ORDER BY ordinal_position`;
    const config = getTableConfig(boardTallyOpenings);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const indexes = await db.admin`
      SELECT i.indisprimary AS pk, array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum)) AS cols
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ${`"${db.schema}".board_tally_openings`}::regclass AND i.indisunique
      GROUP BY i.indexrelid, i.indisprimary ORDER BY i.indisprimary DESC`;
    expect(indexes.map((r) => [r["pk"], r["cols"]])).toEqual([
      [true, config.primaryKeys[0]!.columns.map((c) => c.name)],
      ...config.uniqueConstraints.map((u) => [false, u.columns.map((c) => c.name)]),
    ]);
  });

  test("the app role holds SELECT and INSERT and nothing else", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'board_tally_openings'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
  });

  test("nobody can change or remove a row", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    await appendEntry(app, id, 0, Uint8Array.of(0x00, 0x06, 1), { opening: { cell: 0, seat: 1 } });
    for (const client of [app, owner]) {
      for (const query of [
        client`UPDATE board_tally_openings SET idx = idx WHERE election_id = ${id}`,
        client`DELETE FROM board_tally_openings WHERE election_id = ${id}`,
        client`TRUNCATE board_tally_openings`,
      ])
        await expect(query).rejects.toMatchObject({ code: "42501" });
    }
    const [row] =
      await db.admin`SELECT count(*)::int AS n FROM board_tally_openings WHERE election_id = ${id}`;
    expect(row?.["n"]).toBe(1);
  });

  test("a row names a tally opening on the board", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    await appendEntry(app, id, 0, Uint8Array.of(0x00, 0x05, 1));
    await expect(
      app`INSERT INTO board_tally_openings VALUES (${id}, 0, 1, 0)`,
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      app`INSERT INTO board_tally_openings VALUES (${id}, 0, 1, 1)`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});

// The operator's counted tally over verifier-ballots.json's `admitted`
// board: every ballot names a block the run places after close, so the set
// is decided and empty once L1 has passed close (as packages/verifier's
// tests/counted-set.test.ts reads the same board).
describe("the anchored counted tally", { timeout: 60_000 }, () => {
  const ballots = read("verifier-ballots.json") as {
    readonly clock: Readonly<Record<string, string>>;
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
  const clock = {
    epoch: BigInt(ballots.clock["epoch"] as string),
    period: BigInt(ballots.clock["period"] as string),
    deadline: BigInt(ballots.clock["deadline"] as string),
  };
  const extent = countedExtent(clock, d.closes_at, BigInt(d.l1_inclusion_bound));
  const sS = Number(extent.segment);
  const START = d.opens_at - 7_200n;
  const headersAt = (head: bigint): L1Header[] =>
    run(21_000_000n, [START - 12n, head]).map((h) => decodeHeader(h.encoded));
  const afterClose = headersAt(d.closes_at + 12n);
  const { entries } = splitEntries(hex(admitted.board));

  interface Scripted {
    now: bigint;
    held: Map<number, Uint8Array>;
    headers: readonly L1Header[];
    l1Reads: number;
  }
  async function stored(): Promise<{
    app: Sql;
    script: Scripted;
    tally: ReturnType<typeof anchoredCountedTally>;
  }> {
    const own = await testDb();
    const app = await own.as("abolish_app");
    afterAllClose.push(own);
    await storeDefinition(app, definition);
    for (const encoded of entries) {
      const e = decodeBoardEntry(encoded, boardVersion);
      await appendEntry(app, d.election_id, e.segment, e.payload);
    }
    const script: Scripted = {
      now: extent.due + ANCHOR_FINALITY_MARGIN + 1n,
      held: new Map(),
      headers: afterClose,
      l1Reads: 0,
    };
    for (const checkpoint of await takeCheckpoints(app, d.election_id, sS))
      script.held.set(checkpoint.segment, checkpointHash(checkpoint));
    const options: AnchoredCountedTallyOptions = {
      panels: [panel],
      anchor: {
        chainId: d.l1_chain_id,
        address: d.l1_anchor,
        clock,
        now: async () => script.now,
        anchored: async (_, segment) => script.held.get(segment),
      },
      l1: {
        chainId: d.l1_chain_id,
        run: async () => {
          script.l1Reads++;
          return script.headers;
        },
      },
    };
    return { app, script, tally: anchoredCountedTally(options) };
  }
  const afterAllClose: TestDb[] = [];
  afterAll(async () => {
    await Promise.all(afterAllClose.map((x) => x.close()));
  });

  test("is the verifier's counted tally over the board through the anchored checkpoint", async () => {
    const { app, tally } = await stored();
    const got = await tally(app, d.election_id);
    const want = countedTally({
      definition,
      panel,
      entries,
      clock: { ...clock, lastSegment: sS },
      blocks: afterClose,
      eventsAuthenticated: false,
    });
    if (!want.ok) return expect.fail("the verifier's set is undecided");
    expect(got).toEqual({
      state: "fixed",
      election: want.election,
      aggregates: want.aggregates,
      pinned: want.pinned,
    });
    // Every ballot is rejected by its reference, so each cell sums nothing.
    if (got.state !== "fixed") return;
    expect(got.aggregates).toEqual(got.aggregates.map(() => aggregateCell(got.election.rules, [])));
  });

  test("waits until t_S has passed by the anchor's time, before reading L1", async () => {
    const { app, script, tally } = await stored();
    script.now = extent.due + ANCHOR_FINALITY_MARGIN;
    expect(await tally(app, d.election_id)).toEqual({ state: "waiting" });
    expect(script.l1Reads).toBe(0);
  });

  test("waits while finalized L1 hasn't reached every ballot's reference", async () => {
    const { app, script, tally } = await stored();
    script.headers = headersAt(d.closes_at);
    expect(await tally(app, d.election_id)).toEqual({ state: "waiting" });
  });

  test("refuses a counted checkpoint the anchor doesn't hold, or holds otherwise", async () => {
    const { app, script, tally } = await stored();
    const last = Math.max(...script.held.keys());
    script.held.set(last, new Uint8Array(32));
    expect(await tally(app, d.election_id)).toMatchObject({ state: "refused" });
    script.held.delete(last);
    expect(await tally(app, d.election_id)).toMatchObject({ state: "refused" });
    expect(script.l1Reads).toBe(0);
  });

  test("refuses a board with an entry at or before s_S past the counted checkpoint", async () => {
    const { app, script, tally } = await stored();
    const last = Math.max(...script.held.keys());
    expect(last).toBeLessThan(sS);
    await appendEntry(app, d.election_id, sS, Uint8Array.of(0x00, 0x05, 1));
    expect(await tally(app, d.election_id)).toMatchObject({ state: "refused" });
    expect(script.l1Reads).toBe(0);
  });

  test("refuses a board with no checkpoint taken, and names no unknown election", async () => {
    const own = await testDb();
    afterAllClose.push(own);
    const app = await own.as("abolish_app");
    await storeDefinition(app, definition);
    const transcript = decodeBoardEntry(entries[0] as Uint8Array, boardVersion);
    await appendEntry(app, d.election_id, transcript.segment, transcript.payload);
    const tally = anchoredCountedTally({
      panels: [panel],
      anchor: {
        chainId: d.l1_chain_id,
        address: d.l1_anchor,
        clock,
        now: async () => extent.due + ANCHOR_FINALITY_MARGIN + 1n,
        anchored: async () => undefined,
      },
      l1: { chainId: d.l1_chain_id, run: async () => afterClose },
    });
    expect(await tally(app, d.election_id)).toMatchObject({ state: "refused" });
    await expect(tally(app, new Uint8Array(32).fill(7))).rejects.toMatchObject({
      code: "unknown-election",
    });
  });

  test("refuses an election whose definition names another anchor", async () => {
    const { app, script } = await stored();
    const tally = anchoredCountedTally({
      panels: [panel],
      anchor: {
        chainId: d.l1_chain_id,
        address: new Uint8Array(20).fill(0xaa),
        clock,
        now: async () => script.now,
        anchored: async (_, segment) => script.held.get(segment),
      },
      l1: { chainId: d.l1_chain_id, run: async () => afterClose },
    });
    expect(await tally(app, d.election_id)).toMatchObject({ state: "refused" });
  });

  test("refuses an L1 node on another chain than the anchor's", () => {
    expect(() =>
      anchoredCountedTally({
        panels: [panel],
        anchor: {
          chainId: d.l1_chain_id,
          address: d.l1_anchor,
          clock,
          now: async () => 0n,
          anchored: async () => undefined,
        },
        l1: { chainId: d.l1_chain_id + 1n, run: async () => [] },
      }),
    ).toThrow(RangeError);
  });

  test("boards an opening of the empty set's cells once fixed", async () => {
    const { app, tally } = await stored();
    const boarding = new OpeningBoardings({ tally, clock });
    const counted = await tally(app, d.election_id);
    if (counted.state !== "fixed") return expect.fail("not fixed");
    // No registered seat's key is held here, so an honest opening is no one's,
    // and one that doesn't open the aggregate fails before attribution.
    const statement = {
      definition_hash: counted.election.definitionHash,
      cell: 0,
      aggregate_hash: aggregateHash(counted.aggregates[0] as CellAggregate),
      signer: 1,
      opening: Array.from({ length: counted.election.rules.optionCount }, () => ({
        v: 0n,
        r: 0n,
      })),
    };
    // Signed with a key that isn't seat 1's registered one.
    const unattributed = encodeTallyOpening(
      signTallyOpening(new Uint8Array(32).fill(9), statement),
      1,
    );
    const now = extent.due + ANCHOR_FINALITY_MARGIN + 1n;
    expect(await failsWith(boarding.submitOpening(app, d.election_id, unattributed, now))).toBe(
      "tally-unattributed",
    );
    const wrong = encodeTallyOpening(
      signTallyOpening(new Uint8Array(32).fill(9), {
        ...statement,
        opening: [{ v: 1n, r: 0n }, ...statement.opening.slice(1)],
      }),
      1,
    );
    expect(await failsWith(boarding.submitOpening(app, d.election_id, wrong, now))).toBe(
      "tally-opening",
    );
    expect(await readBoard(app, d.election_id)).toHaveLength(entries.length);
  });
});
