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
  encodeCheckpoint,
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
import fc from "fast-check";
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
  readCheckpoints,
  readBoardedOpenings,
  openingTargets,
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
      readonly ok: boolean;
      readonly code?: string;
      readonly counts?: readonly string[];
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

/** A fixed tally whose cells hold `counted` ballots each, one tier a cell unless `tiers` says. */
const fixed = (
  election: TallyElection,
  aggregates: readonly CellAggregate[],
  pinned: WholeOpeningVersion,
  lastSegment = 5,
  counted: readonly number[] = aggregates.map(() => 0),
  tiers: readonly number[] = aggregates.map((_, cell) => cell),
): CountedTally => ({
  state: "fixed",
  election,
  aggregates,
  counted,
  tiers,
  pinned,
  lastSegment,
});

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

// A seat the targets below register beside the tally's own, and the tally
// doesn't: its opening starts a computation the Boarding rule then refuses,
// so a test can have the tally decided before openings no registered seat
// signed, which start none.
const WARM_SECRET = new Uint8Array(32).fill(0x99);
const WARM_SEAT = 99;

/** The `OpeningTarget` a fixed tally's openings are checked against first. */
const targetOf = (tally: CountedTally) => async () => {
  if (tally.state !== "fixed") throw new Error("a target needs a fixed tally");
  return {
    definitionHash: tally.election.definitionHash,
    pinned: tally.pinned,
    registered: [
      ...tally.election.registered,
      { index: WARM_SEAT, signingKey: identityKey(WARM_SECRET) },
    ],
  };
};

/** Has `boarding` decide `tally` for `id`, boarding nothing. */
async function warm(
  boarding: OpeningBoardings,
  app: Sql,
  id: Uint8Array,
  tally: Extract<CountedTally, { state: "fixed" }>,
) {
  const opening = encodeTallyOpening(
    signTallyOpening(WARM_SECRET, {
      definition_hash: tally.election.definitionHash,
      cell: 0,
      aggregate_hash: new Uint8Array(32),
      signer: WARM_SEAT,
      opening: Array.from({ length: tally.election.rules.optionCount }, () => ({
        v: 0n,
        r: 0n,
      })),
    }),
    tally.pinned,
  );
  const before = (await readBoard(app, id)).length;
  expect(await failsWith(boarding.submitOpening(app, id, opening, NOW))).toBe("tally-aggregate");
  expect(await readBoard(app, id)).toHaveLength(before);
}

const boardings = (tally: CountedTally) =>
  new OpeningBoardings({ tally: async () => tally, target: targetOf(tally), clock: CLOCK });

describe("the Boarding rule on the board path", () => {
  for (const [version, elections] of [
    [1, vectors.elections],
    [2, vectors.version2.elections],
  ] as const)
    for (const e of elections)
      test(`version ${version}, ${e.id}: each opening as the vector's report decides it`, async () => {
        const app = await db.as("abolish_app");
        const id = await newElection(app);
        const tally = fixed(vectorElection, aggregatesOf(e), version);
        const boarding = boardings(tally);
        if (tally.state === "fixed") await warm(boarding, app, id, tally);
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

  test("never labels an opening at or before s_S, whatever the clock says", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    // A clock lagging L1 reads segment 10; s_S is 20.
    const boarding = boardings(fixed(own, [empty, empty], 1, 20));
    const at = await boarding.submitOpening(app, id, openingOf(0, 1), NOW);
    expect(decodeBoardEntry(at.entry, 5).segment).toBe(21);
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
      target: targetOf(OWN),
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
      target: targetOf(OWN),
      clock: CLOCK,
      waitMs: 0,
    });
    const sent = [0, 1, 2].map(() =>
      failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW)),
    );
    // Released once every send has had time to reach the computation the
    // first started; with `waitMs` 0 none would share a finished one.
    for (let i = 0; i < 200 && calls === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 250));
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
      target: targetOf(OWN),
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

  test("refuses an opening that doesn't decode or names another definition before asking for the tally", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    let calls = 0;
    const boarding = new OpeningBoardings({
      tally: async () => {
        calls++;
        return OWN;
      },
      target: targetOf(OWN),
      clock: CLOCK,
    });
    const v2 = Uint8Array.from(openingOf(0, 1));
    v2[2] = 2;
    for (const [opening, code] of [
      [Uint8Array.of(0x00, 0x06, 1), "decode"],
      [v2, "decode"],
      [openingOf(0, 1).subarray(1), "decode"],
      [openingOf(0, 1, new Uint8Array(32)), "tally-stray"],
    ] as const)
      expect(await failsWith(boarding.submitOpening(app, id, opening, NOW))).toBe(code);
    expect(calls).toBe(0);
    // Nor for an election whose definition pins no whole opening.
    const none = new OpeningBoardings({
      tally: async () => {
        calls++;
        return OWN;
      },
      target: async () => undefined,
      clock: CLOCK,
    });
    expect(await failsWith(none.submitOpening(app, id, openingOf(0, 1), NOW))).toBe("not-open");
    expect(calls).toBe(0);
    expect(await readBoard(app, id)).toHaveLength(0);
  });

  test("starts no computation for an opening no registered seat signed, nor for a replay of the board", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    let calls = 0;
    const boarding = new OpeningBoardings({
      tally: async () => {
        calls++;
        return OWN;
      },
      target: targetOf(OWN),
      clock: CLOCK,
    });
    // Seat 3 isn't registered: its opening waits for a seat's.
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(1, 3), NOW))).toBe(
      "not-ready",
    );
    expect(calls).toBe(0);
    const first = await boarding.submitOpening(app, id, openingOf(0, 1), NOW);
    expect(calls).toBe(1);
    // Once decided, the unregistered seat's gets the Boarding rule's code.
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(1, 3), NOW))).toBe(
      "tally-unattributed",
    );
    // A replay of the board is answered from it, the tally never asked.
    const fresh = new OpeningBoardings({
      tally: async () => expect.unreachable("the tally was asked for"),
      target: targetOf(OWN),
      clock: CLOCK,
    });
    expect(await fresh.submitOpening(app, id, openingOf(0, 1), NOW)).toEqual(first);
  });

  test("asks again only after waitMs when computing the tally threw", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    let calls = 0;
    let ms = 0;
    let fail = true;
    const boarding = new OpeningBoardings({
      tally: async () => {
        calls++;
        if (fail) throw new Error("a node that can't be read");
        return OWN;
      },
      target: targetOf(OWN),
      clock: CLOCK,
      waitMs: 1_000,
      nowMs: () => ms,
    });
    await expect(boarding.submitOpening(app, id, openingOf(0, 1), NOW)).rejects.toThrow(
      "can't be read",
    );
    ms = 999;
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW))).toBe(
      "not-ready",
    );
    expect(calls).toBe(1);
    ms = 1_000;
    fail = false;
    expect((await boarding.submitOpening(app, id, openingOf(0, 1), NOW)).index).toBe(0n);
    expect(calls).toBe(2);
  });

  test("computes one election's tally at a time, answering another's opening not-ready meanwhile", async () => {
    const app = await db.as("abolish_app");
    const [a, b] = [await newElection(app), await newElection(app)];
    const asked: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const boarding = new OpeningBoardings({
      tally: async (_, id) => {
        asked.push(Buffer.from(id).toString("hex"));
        await gate;
        return OWN;
      },
      target: targetOf(OWN),
      clock: CLOCK,
    });
    const first = boarding.submitOpening(app, a, openingOf(0, 1), NOW);
    // The first opening reaches the tally only after its own reads.
    for (let i = 0; i < 100 && asked.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(await failsWith(boarding.submitOpening(app, b, openingOf(0, 1), NOW))).toBe("not-ready");
    release();
    expect((await first).index).toBe(0n);
    // Not kept as waiting: once the first ends, the other's is computed.
    expect((await boarding.submitOpening(app, b, openingOf(0, 1), NOW)).index).toBe(0n);
    expect(asked).toEqual([a, b].map((id) => Buffer.from(id).toString("hex")));
  });

  test("asks again after lapseMs when a refusal lapses, and keeps any other", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    let calls = 0;
    let ms = 0;
    let answer: CountedTally = { state: "refused", reason: "a test's", lapses: true };
    const boarding = new OpeningBoardings({
      tally: async () => {
        calls++;
        return answer;
      },
      target: targetOf(OWN),
      clock: CLOCK,
      lapseMs: 5_000,
      nowMs: () => ms,
    });
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW))).toBe("not-open");
    ms = 4_999;
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW))).toBe("not-open");
    expect(calls).toBe(1);
    ms = 5_000;
    answer = OWN;
    expect((await boarding.submitOpening(app, id, openingOf(0, 1), NOW)).index).toBe(0n);
    expect(calls).toBe(2);
  });

  test("answers not-ready when the segment's spoiled-ballot openings came first, writing nothing", async () => {
    const app = await db.as("abolish_app");
    const id = await newElection(app);
    await appendEntry(app, id, 12, Uint8Array.of(0x00, 0x03, 1));
    const boarding = boardings(OWN);
    expect(await failsWith(boarding.submitOpening(app, id, openingOf(0, 1), NOW))).toBe(
      "not-ready",
    );
    expect(await readBoard(app, id)).toHaveLength(1);
    // In the next segment it is boarded.
    const at = await boarding.submitOpening(app, id, openingOf(0, 1), NOW + 3n * CLOCK.period);
    expect(decodeBoardEntry(at.entry, 5).segment).toBe(13);
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
      () =>
        new OpeningBoardings({
          tally: async () => OWN,
          target: targetOf(OWN),
          clock: { epoch: 0n, period: 0n },
        }),
    ).toThrow(RangeError);
  });
});

// The results read (OpeningBoardings.readResults): packages/verifier's
// `countedResults` over the counted tally and the openings the board path
// boarded, so a cell has counts only where a registered seat's opening of it
// passed the Boarding judge, and those are the counts the vector's
// independent implementation opened (T-29, T-34).
describe("reading results", () => {
  // One connection for the block: the file's clients stay open until it ends.
  let app: Sql;
  beforeAll(async () => {
    app = await db.as("abolish_app");
  });

  for (const [version, elections] of [
    [1, vectors.elections],
    [2, vectors.version2.elections],
  ] as const)
    for (const e of elections)
      test(`version ${version}, ${e.id}: each cell as the vector opens it, once boarded`, async () => {
        const id = await newElection(app);
        const counted = e.cells.map((c) => c.length);
        const tally = fixed(vectorElection, aggregatesOf(e), version, 5, counted);
        const boarding = boardings(tally);
        if (tally.state === "fixed") await warm(boarding, app, id, tally);
        for (const opening of e.openings)
          await failsWith(boarding.submitOpening(app, id, hex(opening), NOW));
        const read = await boarding.readResults(app, id);
        const boarded = (await readBoardedOpenings(app, id)).length;
        if (boarded === 0) return expect(read).toEqual({ state: "unopened" });
        if (read.state !== "read") return expect.fail("no results read");
        expect(read.openings).toBe(boarded);
        for (const [cell, want] of e.result.cells.entries()) {
          const got = read.results.cells[cell];
          const signers = [
            ...new Set(want.passing.flatMap((p) => (p.signer === null ? [] : [p.signer]))),
          ].sort((a, b) => a - b);
          expect(got?.counted, `cell ${cell}`).toBe(counted[cell]);
          expect(got?.signers, `cell ${cell}`).toEqual(signers);
          // Only a registered seat's opening is boarded: a cell no seat
          // opened is missing, whatever the vector's unattributed or failing
          // openings say of it.
          if (signers.length === 0) expect(got?.code, `cell ${cell}`).toBe("tally-missing");
          else if (want.ok) expect(got?.counts, `cell ${cell}`).toEqual(want.counts);
          else expect(got?.code, `cell ${cell}`).toBe(want.code);
          // Each cell is its own tier here, with the cell's counts or none.
          expect(read.results.tiers[cell]?.counts).toEqual(got?.counts);
        }
        expect(read.results.ok).toBe(read.results.cells.every((c) => c.counts !== undefined));
      });

  const counting = (answer: () => CountedTally) => {
    const calls = { n: 0 };
    const boarding = new OpeningBoardings({
      tally: async () => {
        calls.n++;
        return answer();
      },
      target: targetOf(OWN),
      clock: CLOCK,
    });
    return { boarding, calls };
  };
  const ONE_TIER = fixed(own, [empty, empty], 1, 5, [0, 0], [0, 0]);

  test("says nothing is opened before an opening is boarded, without asking for the tally", async () => {
    const id = await newElection(app);
    const { boarding, calls } = counting(() => ONE_TIER);
    expect(await boarding.readResults(app, id)).toEqual({ state: "unopened" });
    expect(calls.n).toBe(0);
  });

  test("gives a tier counts only once every cell of it is opened", async () => {
    const id = await newElection(app);
    const { boarding, calls } = counting(() => ONE_TIER);
    await boarding.submitOpening(app, id, openingOf(0, 1), NOW);
    const first = await boarding.readResults(app, id);
    if (first.state !== "read") return expect.fail("no results read");
    expect(first.results).toMatchObject({
      ok: false,
      failure: { cell: 1, code: "tally-missing" },
      cells: [
        { cell: 0, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [1] },
        { cell: 1, tier: 0, counted: 0, code: "tally-missing", signers: [] },
      ],
      tiers: [{ tier: 0, counted: 0 }],
    });
    expect(first.results.tiers[0]?.counts).toBeUndefined();
    await boarding.submitOpening(app, id, openingOf(1, 2), NOW);
    const second = await boarding.readResults(app, id);
    if (second.state !== "read") return expect.fail("no results read");
    expect(second.openings).toBe(2);
    expect(second.results.ok).toBe(true);
    expect(second.results.failure).toBeUndefined();
    expect(second.results.tiers).toEqual([{ tier: 0, counted: 0, counts: ["0", "0", "0"] }]);
    // Kept until another opening is boarded: a repeat checks none again.
    expect(await boarding.readResults(app, id)).toBe(second);
    expect(calls.n).toBe(1);
  });

  test(
    "reads, after any run of boarded openings, counts exactly for the cells and tiers they open",
    { timeout: 300_000 },
    async () => {
      // Three cells, the first two one tier and the last another.
      const tally = fixed(own, [empty, empty, empty], 1, 5, [0, 0, 0], [0, 0, 1]);
      const seat = fc.record({ cell: fc.integer({ min: 0, max: 2 }), seat: fc.constantFrom(1, 2) });
      await fc.assert(
        fc.asyncProperty(fc.array(seat, { minLength: 1, maxLength: 8 }), async (sent) => {
          const id = await newElection(app);
          const boarding = boardings(tally);
          const opened = new Map<number, Set<number>>();
          for (const o of sent) {
            await boarding.submitOpening(app, id, openingOf(o.cell, o.seat), NOW);
            opened.set(o.cell, (opened.get(o.cell) ?? new Set()).add(o.seat));
            // Read after each, so a kept read is never one opening behind.
            const read = await boarding.readResults(app, id);
            if (read.state !== "read") return expect.fail("no results read");
            expect(read.openings).toBe([...opened.values()].reduce((n, x) => n + x.size, 0));
            for (const [cell, got] of read.results.cells.entries()) {
              const seats = [...(opened.get(cell) ?? [])].sort((a, b) => a - b);
              expect(got.signers).toEqual(seats);
              expect(got.counts).toEqual(seats.length > 0 ? ["0", "0", "0"] : undefined);
            }
            const tiers = read.results.tiers.map((t) => t.counts !== undefined);
            expect(tiers).toEqual([opened.has(0) && opened.has(1), opened.has(2)]);
            expect(read.results.ok).toBe(opened.size === 3);
          }
        }),
        { numRuns: Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 50) },
      );
    },
  );

  test("sums a tier's cells as the vector opens them", async () => {
    const e = vectors.elections.find((x) => x.id === "signed");
    if (e === undefined) return expect.fail("no signed election");
    const id = await newElection(app);
    const counted = e.cells.map((c) => c.length);
    const tally = fixed(vectorElection, aggregatesOf(e), 1, 5, counted, [0, 0]);
    const boarding = boardings(tally);
    if (tally.state === "fixed") await warm(boarding, app, id, tally);
    for (const opening of e.openings) await boarding.submitOpening(app, id, hex(opening), NOW);
    const read = await boarding.readResults(app, id);
    if (read.state !== "read") return expect.fail("no results read");
    // Summed here from the vector's own per-cell counts.
    const sum = e.result.cells
      .map((c) => (c.counts ?? []).map(BigInt))
      .reduce((a, b) => a.map((x, i) => x + (b[i] ?? 0n)))
      .map(String);
    expect(read.results.tiers).toEqual([
      { tier: 0, counted: counted.reduce((a, b) => a + b), counts: sum },
    ]);
  });

  test("computes a tally the board path doesn't keep no more than once per readEveryMs", async () => {
    const ids = [await newElection(app), await newElection(app)];
    for (const id of ids) await boardings(ONE_TIER).submitOpening(app, id, openingOf(0, 1), NOW);
    let ms = 0;
    let calls = 0;
    const reads = new OpeningBoardings({
      tally: async () => {
        calls++;
        return ONE_TIER;
      },
      target: targetOf(OWN),
      clock: CLOCK,
      cacheSize: 1,
      readEveryMs: 1_000,
      nowMs: () => ms,
    });
    const [a, b] = ids as [Uint8Array, Uint8Array];
    expect(await reads.readResults(app, a)).toMatchObject({ state: "read" });
    ms = 999;
    expect(await failsWith(reads.readResults(app, b))).toBe("not-ready");
    expect(calls).toBe(1);
    ms = 1_000;
    expect(await reads.readResults(app, b)).toMatchObject({ state: "read" });
    // One election kept: reading the other again waits for the budget too.
    ms = 1_500;
    expect(await failsWith(reads.readResults(app, a))).toBe("not-ready");
    expect(calls).toBe(2);
    // A seat's opening still starts one, whatever reads have spent.
    expect(await reads.submitOpening(app, a, openingOf(0, 2), NOW)).toMatchObject({ index: 1n });
    expect(calls).toBe(3);
  });

  test("checks the same openings once for reads sent at once", async () => {
    const id = await newElection(app);
    await boardings(ONE_TIER).submitOpening(app, id, openingOf(0, 1), NOW);
    const { boarding, calls } = counting(() => ONE_TIER);
    const reads = await Promise.all([0, 1, 2, 3, 4].map(() => boarding.readResults(app, id)));
    expect(calls.n).toBe(1);
    for (const r of reads) expect(r).toBe(reads[0]);
  });

  test("refuses where the counted tally waits or is refused, and an election it boards nothing of", async () => {
    const id = await newElection(app);
    await boardings(OWN).submitOpening(app, id, openingOf(0, 1), NOW);
    let answer: CountedTally = { state: "waiting" };
    const { boarding } = counting(() => answer);
    expect(await failsWith(boarding.readResults(app, id))).toBe("not-ready");
    const refused = counting(() => (answer = { state: "refused", reason: "a test's" }));
    expect(await failsWith(refused.boarding.readResults(app, id))).toBe("not-open");
    const none = new OpeningBoardings({
      tally: async () => OWN,
      target: async () => undefined,
      clock: CLOCK,
    });
    expect(await failsWith(none.readResults(app, id))).toBe("not-open");
    const unknown = new OpeningBoardings({
      tally: async () => OWN,
      target: async () => {
        throw new OpeningError("unknown-election");
      },
      clock: CLOCK,
    });
    expect(await failsWith(unknown.readResults(app, new Uint8Array(32)))).toBe("unknown-election");
    await expect(boarding.readResults(app, new Uint8Array(31))).rejects.toThrow(TypeError);
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
    /** This process's clock: the anchor's unless a test moves it. */
    local?: bigint;
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
      now: () => script.local ?? script.now,
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
      counted: want.counted,
      tiers: want.tiers,
      pinned: want.pinned,
      lastSegment: sS,
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

  test("waits until t_S has passed by this process's clock too, whatever the anchor's node says", async () => {
    const { app, script, tally } = await stored();
    script.local = extent.due + ANCHOR_FINALITY_MARGIN;
    expect(await tally(app, d.election_id)).toEqual({ state: "waiting" });
    expect(script.l1Reads).toBe(0);
    script.local += 1n;
    expect(await tally(app, d.election_id)).toMatchObject({ state: "fixed" });
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

  test("refuses a counted checkpoint the stored board doesn't give", async () => {
    const { app, script, tally } = await stored();
    const last = Math.max(...script.held.keys());
    const [taken] = await readCheckpoints(app, d.election_id, last);
    if (taken === undefined) return expect.fail("no checkpoint");
    // A row written around takeCheckpoints, which the anchor holds.
    const forged = { ...taken, segment: last + 1, root: new Uint8Array(32).fill(5) };
    await app`INSERT INTO board_checkpoints VALUES (${d.election_id}, ${forged.segment},
      ${String(forged.size)}, ${encodeCheckpoint(forged)})`;
    script.held.set(forged.segment, checkpointHash(forged));
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

  test("reads each election's target off its definition and transcript", async () => {
    const { app, tally } = await stored();
    const counted = await tally(app, d.election_id);
    if (counted.state !== "fixed") return expect.fail("not fixed");
    // The counted tally's own definition hash, pin and registered key set.
    expect(await openingTargets([panel])(app, d.election_id)).toEqual({
      definitionHash: counted.election.definitionHash,
      pinned: counted.pinned,
      registered: counted.election.registered,
    });
    // A panel the definition doesn't name is passed over.
    const other = {
      threshold: 2,
      keys: [7, 8].map((i) => identityKey(new Uint8Array(32).fill(i))),
    };
    expect(await openingTargets([other, panel])(app, d.election_id)).toEqual(
      await openingTargets([panel])(app, d.election_id),
    );
    expect(await openingTargets([other])(app, d.election_id)).toBeUndefined();
    // No transcript at entry 0 yet: no target.
    const bare = await newElection(app);
    expect(await openingTargets([panel])(app, bare)).toBeUndefined();
    expect(await failsWith(openingTargets([panel])(app, new Uint8Array(32)))).toBe(
      "unknown-election",
    );
    expect(() => openingTargets([])).toThrow(RangeError);
  });

  test("boards an opening of the empty set's cells once fixed", async () => {
    const { app, tally } = await stored();
    let asked = 0;
    const counting = (client: Sql, id: Uint8Array) => {
      asked++;
      return tally(client, id);
    };
    const counted = await tally(app, d.election_id);
    if (counted.state !== "fixed") return expect.fail("not fixed");
    const target = openingTargets([panel]);
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
    // No registered seat signed it, so it starts no computation.
    const real = new OpeningBoardings({ tally: counting, target, clock });
    expect(await failsWith(real.submitOpening(app, d.election_id, unattributed, now))).toBe(
      "not-ready",
    );
    expect(asked).toBe(0);
    // A target that takes key 9 for seat 1's lets it start one, and the
    // Boarding rule, over the registered key set, refuses it as no one's.
    const nine = async (client: Sql, id: Uint8Array) => {
      const t = await target(client, id);
      if (t === undefined) return t;
      const key = identityKey(new Uint8Array(32).fill(9));
      return { ...t, registered: [{ index: 1, signingKey: key }] };
    };
    const boarding = new OpeningBoardings({ tally: counting, target: nine, clock });
    expect(await failsWith(boarding.submitOpening(app, d.election_id, unattributed, now))).toBe(
      "tally-unattributed",
    );
    expect(asked).toBe(1);
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
