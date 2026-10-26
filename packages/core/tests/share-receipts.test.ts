import { checkBoard, decodeBoardEntry, DELIVERY_WINDOW } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
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
} from "../../verifier/tests/receipt-poll.ts";
import {
  appendEntry,
  AppendError,
  BallotAdmissions,
  boardBallotHashes,
  boardShareReceipts,
  readBallotByHash,
  readBoard,
  ReceiptError,
  storeDefinition,
} from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// The board path for share receipts (src/admission.ts, `submitReceipt`;
// docs/spec/delivery.md, Boarding): a receipt is boarded only if the
// verifier's judge passes it (rules 1 and 4) against a boarded ballot its
// ballot hash names (rule 2), in a segment no later than `s_D` (rule 3), and
// at most once per seat of a ballot hash (rule 5); a refusal writes nothing
// (T-17, T-52). The election's ceremony is run by packages/verifier's
// tests/receipt-poll.ts, which signs the receipts; its ballots are boarded
// here directly, with the ballot hash the spec gives, since their membership
// proofs were made for another definition (admission is admission-v3.test.ts's).

const b32 = () => new Uint8Array(randomBytes(32));
const VERSION = 5;
const clock = { epoch: definition.opens_at - 7_200n, period: 3_600n };
const during = definition.opens_at + 60n;
const segmentOf = (t: bigint) => (t - clock.epoch) / clock.period;
// `s_D`, by the spec's formula (docs/spec/delivery.md, Windows).
const S_D =
  (definition.closes_at + BigInt(definition.l1_inclusion_bound) + DELIVERY_WINDOW - clock.epoch) /
  clock.period;
const [first, second] = ballots as [(typeof ballots)[number], (typeof ballots)[number]];

let db: TestDb;
let owner: Sql;
const dbs: TestDb[] = [];
beforeAll(async () => {
  db = await testDb();
  owner = await db.as("abolish_migrator");
});
afterAll(async () => {
  await Promise.all([db, ...dbs].map((d) => d?.close()));
});

/** A schema of its own with the election stored, its transcript boarded and `boarded` ballots after it. */
async function election(boarded = ballots): Promise<Sql> {
  const own = await testDb();
  dbs.push(own);
  const app = await own.as("abolish_app");
  await storeDefinition(app, definitionBytes);
  await appendEntry(app, electionId, 0, transcript, { first: true });
  for (const b of boarded)
    await appendEntry(app, electionId, 0, b.payload, {
      ballot: { tier: 0, nullifier: b.nullifier, message: b32(), ballotHash: b.hash },
    });
  return app;
}

const admissions = () => new BallotAdmissions({ panels: [panel], clock });

async function verdict(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof ReceiptError)
      return e.rejection === undefined ? e.code : `${e.code}:${e.rejection}`;
    throw e;
  }
  return "boarded";
}

describe("boards a passing receipt once", { timeout: 60_000 }, () => {
  test("each seat's receipt of each boarded ballot, in the segment of its time", async () => {
    const app = await election();
    const a = admissions();
    let size = ballots.length + 1;
    for (const [i, b] of ballots.entries())
      for (const seat of [1, 2, 3, 4]) {
        const now = during + BigInt(i) * 3_600n;
        const receipt = receiptFor(b, seat);
        const r = await a.submitReceipt(app, electionId, receipt, now);
        expect(r.earlier).toBe(false);
        expect(r.boarded.index).toBe(BigInt(size++));
        const entry = decodeBoardEntry(r.boarded.entry, VERSION);
        expect(entry.payload).toEqual(receipt);
        expect(BigInt(entry.segment)).toBe(segmentOf(now));
      }
    const board = await readBoard(app, electionId);
    expect(board).toHaveLength(size);
    // The stored board is one the verifier's board check reads.
    expect(() => checkBoard(electionId, board, VERSION)).not.toThrow();
  });

  test("the same bytes again return their entry, writing nothing", async () => {
    const app = await election();
    const a = admissions();
    const receipt = receiptFor(first, 2);
    const boarded = await a.submitReceipt(app, electionId, receipt, during);
    expect(await a.submitReceipt(app, electionId, receipt, during + 7_200n)).toEqual(boarded);
    expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 2);
  });

  test("a passing receipt for a seat the board path already carries returns that entry", async () => {
    // Another receipt for the same ballot hash and seat, keyed directly
    // (a second passing encoding can't be made here: signatures are RFC
    // 6979, one per statement): whatever the board path carries for the
    // seat, the sender is handed it, and nothing more is boarded.
    const app = await election();
    const other = Uint8Array.from(receiptFor(first, 3));
    other[other.length - 1] = (other[other.length - 1] as number) ^ 1;
    const earlier = await appendEntry(app, electionId, 0, other, {
      receipt: { ballotHash: first.hash, panel: 1, seat: 3 },
    });
    const r = await admissions().submitReceipt(app, electionId, receiptFor(first, 3), during);
    expect(r).toEqual({ boarded: earlier, earlier: true });
    expect(await readBoard(app, electionId)).toHaveLength(ballots.length + 2);
    // Another seat of that ballot is boarded as usual.
    const four = await admissions().submitReceipt(app, electionId, receiptFor(first, 4), during);
    expect(four.earlier).toBe(false);
  });

  test("ballots boarded by admission are found by the hash it recomputed", async () => {
    const app = await election([first]);
    expect(await readBallotByHash(app, electionId, first.hash)).toEqual(first.payload);
    expect(await readBallotByHash(app, electionId, second.hash)).toBeUndefined();
  });
});

describe("refuses, writing nothing", { timeout: 60_000 }, () => {
  test.each([
    [
      "another definition (rule 1)",
      () => receiptFor(first, 1, { definitionHash: b32() }),
      "rejected:receipt-definition",
    ],
    [
      "a seat outside the key set (rule 1)",
      () => receiptFor(first, 1, { seat: 5 }),
      "rejected:receipt-seat",
    ],
    ["bytes that aren't a receipt (rule 1)", () => first.payload, "rejected:decode"],
    [
      "a ballot hash no boarded ballot has (rule 2)",
      () => receiptFor(second, 1),
      "rejected:receipt-ballot",
    ],
    [
      "another seat's signature (rule 4)",
      () => receiptFor(first, 1, { signer: 2 }),
      "rejected:share-receipt",
    ],
    [
      "another seat's share hash (rule 4)",
      () => receiptFor(first, 1, { shareHash: first.shareHashes[1] as Uint8Array }),
      "rejected:share-receipt",
    ],
  ])("a receipt naming %s", async (_, receipt, code) => {
    const app = await election([first]);
    expect(await verdict(admissions().submitReceipt(app, electionId, receipt(), during))).toBe(
      code,
    );
    expect(await readBoard(app, electionId)).toHaveLength(2);
  });

  test("after s_D (rule 3), and when an entry after it is already boarded", async () => {
    const app = await election([first]);
    const lastSecond = clock.epoch + (S_D + 1n) * clock.period - 1n;
    expect(
      await verdict(
        admissions().submitReceipt(app, electionId, receiptFor(first, 1), lastSecond + 1n),
      ),
    ).toBe("not-open");
    expect(await readBoard(app, electionId)).toHaveLength(2);
    expect(
      await verdict(admissions().submitReceipt(app, electionId, receiptFor(first, 1), lastSecond)),
    ).toBe("boarded");
    // A retry of the boarded bytes after s_D still returns their entry,
    // writing nothing; other bytes are still refused.
    const boarded = await admissions().submitReceipt(
      app,
      electionId,
      receiptFor(first, 1),
      lastSecond,
    );
    expect(
      await admissions().submitReceipt(app, electionId, receiptFor(first, 1), lastSecond + 1n),
    ).toEqual(boarded);
    expect(
      await verdict(
        admissions().submitReceipt(app, electionId, receiptFor(first, 2), lastSecond + 1n),
      ),
    ).toBe("not-open");
    expect(await readBoard(app, electionId)).toHaveLength(3);
    // A later-labelled entry would raise the receipt past s_D.
    const late = await election([first]);
    await appendEntry(late, electionId, Number(S_D) + 1, Uint8Array.of(0x00, 0x05, 1));
    expect(
      await verdict(admissions().submitReceipt(late, electionId, receiptFor(first, 2), during)),
    ).toBe("not-open");
    expect(await readBoard(late, electionId)).toHaveLength(3);
  });

  test("for an unknown election, or one that takes no ballots", async () => {
    const app = await election([first]);
    expect(
      await verdict(admissions().submitReceipt(app, b32(), receiptFor(first, 1), during)),
    ).toBe("unknown-election");
    const bare = await testDb();
    dbs.push(bare);
    const noTranscript = await bare.as("abolish_app");
    await storeDefinition(noTranscript, definitionBytes);
    expect(
      await verdict(
        admissions().submitReceipt(noTranscript, electionId, receiptFor(first, 1), during),
      ),
    ).toBe("not-open");
    expect(
      await verdict(
        admissions().submitReceipt(app, electionId, receiptFor(first, 1), clock.epoch - 1n),
      ),
    ).toBe("not-open");
  });

  test("inputs that aren't an election ID, bytes and a time", async () => {
    const app = await election([first]);
    const a = admissions();
    const receipt = receiptFor(first, 1);
    await expect(a.submitReceipt(app, new Uint8Array(31), receipt, during)).rejects.toThrow(
      TypeError,
    );
    await expect(
      a.submitReceipt(app, electionId, "00" as unknown as Uint8Array, during),
    ).rejects.toThrow(TypeError);
    await expect(a.submitReceipt(app, electionId, receipt, -1n)).rejects.toThrow(TypeError);
  });
});

describe("appendEntry with a receipt key", () => {
  const receipt = (...body: number[]) => Uint8Array.of(0x00, 0x0c, 1, ...body);
  const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 3, ...body);

  async function failsWith(p: Promise<unknown>) {
    try {
      await p;
    } catch (e) {
      if (e instanceof AppendError) return e.code;
      const err = e as { code?: string; cause?: { code?: string } };
      return err.cause?.code ?? err.code ?? "no code";
    }
    return "appended";
  }

  test("one per ballot hash, panel and seat; the same bytes get their entry", async () => {
    const app = await db.as("abolish_app");
    const e = await newElection(app);
    const hash = b32();
    await appendEntry(app, e, 0, ballot(1), {
      ballot: { tier: 0, nullifier: 1n, message: b32(), ballotHash: hash },
    });
    const key = { ballotHash: hash, panel: 1, seat: 2 };
    const boarded = await appendEntry(app, e, 0, receipt(1), { receipt: key });
    expect(await appendEntry(app, e, 1, receipt(1), { receipt: key })).toEqual(boarded);
    let thrown: unknown;
    await appendEntry(app, e, 0, receipt(2), { receipt: key }).catch((x: unknown) => {
      thrown = x;
    });
    expect(thrown).toBeInstanceOf(AppendError);
    expect((thrown as AppendError).code).toBe("receipt-present");
    expect((thrown as AppendError).existing).toEqual({ ...boarded, payload: receipt(1) });
    // Another seat, another panel: other receipts.
    for (const other of [
      { ...key, seat: 3 },
      { ...key, panel: 2 },
    ])
      expect(await failsWith(appendEntry(app, e, 0, receipt(3), { receipt: other }))).toBe(
        "appended",
      );
    expect(await readBoard(app, e)).toHaveLength(4);
  });

  test("a receipt key needs a ballot of its hash boarded before it", async () => {
    const app = await db.as("abolish_app");
    const e = await newElection(app);
    expect(
      await failsWith(
        appendEntry(app, e, 0, receipt(1), { receipt: { ballotHash: b32(), panel: 1, seat: 1 } }),
      ),
    ).toBe("23514");
    expect(await readBoard(app, e)).toHaveLength(0);
  });

  test.each([
    ["a payload that isn't a receipt", ballot(1), { ballotHash: b32(), panel: 1, seat: 1 }],
    ["a short ballot hash", receipt(1), { ballotHash: new Uint8Array(31), panel: 1, seat: 1 }],
    ["panel 0", receipt(1), { ballotHash: b32(), panel: 0, seat: 1 }],
    ["panel 3", receipt(1), { ballotHash: b32(), panel: 3, seat: 1 }],
    ["seat 0", receipt(1), { ballotHash: b32(), panel: 1, seat: 0 }],
    ["seat 256", receipt(1), { ballotHash: b32(), panel: 1, seat: 256 }],
  ])("refuses %s, writing nothing", async (_, payload, key) => {
    const app = await db.as("abolish_app");
    const e = await newElection(app);
    expect(await failsWith(appendEntry(app, e, 0, payload, { receipt: key }))).toBe(
      "invalid-entry",
    );
    expect(await readBoard(app, e)).toHaveLength(0);
  });

  test("a ballot key without a 32-byte ballot hash is refused", async () => {
    const app = await db.as("abolish_app");
    const e = await newElection(app);
    expect(
      await failsWith(
        appendEntry(app, e, 0, ballot(1), {
          ballot: { tier: 0, nullifier: 1n, message: b32(), ballotHash: new Uint8Array(31) },
        }),
      ),
    ).toBe("invalid-entry");
  });

  test("lastSegment refuses an entry raised past it, and a segment that isn't one", async () => {
    const app = await db.as("abolish_app");
    const e = await newElection(app);
    await appendEntry(app, e, 5, ballot(1));
    expect(
      await failsWith(appendEntry(app, e, 4, ballot(2), { raiseToPrevious: true, lastSegment: 4 })),
    ).toBe("segment-late");
    expect(await failsWith(appendEntry(app, e, 4, ballot(2), { lastSegment: -1 }))).toBe(
      "invalid-entry",
    );
    expect((await appendEntry(app, e, 5, ballot(2), { lastSegment: 5 })).index).toBe(1n);
  });
});

describe("the tables", () => {
  for (const [name, table] of [
    ["board_ballot_hashes", boardBallotHashes],
    ["board_share_receipts", boardShareReceipts],
  ] as const) {
    test(`${name}: the Drizzle table matches the migrated one`, async () => {
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${name} ORDER BY ordinal_position`;
      const config = getTableConfig(table);
      expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      );
      const indexes = await db.admin`
        SELECT i.indisprimary AS pk, array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum)) AS cols
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = ${`"${db.schema}".${name}`}::regclass AND i.indisunique
        GROUP BY i.indexrelid, i.indisprimary ORDER BY i.indisprimary DESC`;
      expect(indexes.map((r) => [r["pk"], r["cols"]])).toEqual([
        [true, config.primaryKeys[0]!.columns.map((c) => c.name)],
        ...config.uniqueConstraints.map((u) => [false, u.columns.map((c) => c.name)]),
      ]);
    });

    test(`${name}: the app role holds SELECT and INSERT and nothing else`, async () => {
      const privs = await db.admin`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = ${db.schema} AND table_name = ${name} AND grantee = 'abolish_app'
        ORDER BY privilege_type`;
      expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
    });

    test(`${name}: nobody can change or remove a row`, async () => {
      const app = await db.as("abolish_app");
      const e = await newElection(app);
      const hash = b32();
      await appendEntry(app, e, 0, Uint8Array.of(0x00, 0x02, 3), {
        ballot: { tier: 0, nullifier: 1n, message: b32(), ballotHash: hash },
      });
      await appendEntry(app, e, 0, Uint8Array.of(0x00, 0x0c, 1), {
        receipt: { ballotHash: hash, panel: 1, seat: 1 },
      });
      for (const client of [app, owner]) {
        for (const query of [
          client`UPDATE ${client(name)} SET idx = idx WHERE election_id = ${e}`,
          client`DELETE FROM ${client(name)} WHERE election_id = ${e}`,
          client`TRUNCATE ${client(name)}`,
        ])
          await expect(query).rejects.toMatchObject({ code: "42501" });
      }
      const [row] =
        await db.admin`SELECT count(*)::int AS n FROM ${db.admin(name)} WHERE election_id = ${e}`;
      expect(row?.["n"]).toBe(1);
    });
  }

  test("a row names an entry of its own kind on the board", async () => {
    const app = await db.as("abolish_app");
    const e = await newElection(app);
    await appendEntry(app, e, 0, Uint8Array.of(0x00, 0x05, 1));
    await expect(
      app`INSERT INTO board_ballot_hashes VALUES (${e}, 0, ${b32()})`,
    ).rejects.toMatchObject({ code: "23514" });
    await appendEntry(app, e, 0, Uint8Array.of(0x00, 0x02, 3));
    await expect(
      app`INSERT INTO board_share_receipts VALUES (${e}, ${b32()}, 1, 1, 1)`,
    ).rejects.toMatchObject({ code: "23514" });
  });
});
