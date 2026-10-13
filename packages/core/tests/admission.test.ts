import {
  checkBoard,
  decodeBoardEntry,
  decodeElectionDefinition,
  type Panel,
} from "@abolishus/crypto";
import { splitEntries } from "@abolishus/verifier";
import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  appendEntry,
  BallotAdmissions,
  readBoard,
  storeDefinition,
  SubmitError,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// BallotAdmissions (src/admission.ts): a ballot reaches the board only once
// @abolishus/verifier's admission admits it, in the segment the anchoring
// clock gives its time, and a refused one writes nothing (T-17, T-52). The
// fixtures are docs/spec/vectors/verifier-ballots.json, whose verdicts come
// from an independent implementation (with snarkjs's on every membership
// proof): a board holding the ceremony transcript, then ballots.

const read = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8"),
  ) as unknown;

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly ballots?: {
    readonly rejected: readonly { entry: number; code: string }[];
    readonly repeats: readonly { entry: number }[];
  };
}

const file = read("verifier-ballots.json") as {
  readonly panels: Readonly<Record<string, { threshold: string; keys: string[] }>>;
  readonly cases: readonly Case[];
};
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const panelOf = (name: string): Panel => {
  const p = file.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return { threshold: Number(p.threshold), keys: p.keys.map(hex) };
};

// Every case shares one election and one window.
const definition = decodeElectionDefinition(hex(byId("admitted").definition));
const electionId = definition.election_id;
const { opens_at: opensAt, closes_at: closesAt } = definition;
// The fixtures pin board-entry version 4.
const VERSION = 4;
const clock = { epoch: opensAt - 7_200n, period: 3_600n };

/** The vector board's entries, decoded: entry 0 is the transcript. */
const entriesOf = (c: Case) =>
  splitEntries(hex(c.board)).entries.map((e) => decodeBoardEntry(e, VERSION));

let dbs: TestDb[] = [];
afterEach(async () => {
  await Promise.all(dbs.map((d) => d.close()));
  dbs = [];
});

/** A schema of its own with the case's definition stored and, unless `bare`, its transcript boarded. */
async function election(c: Case, bare = false): Promise<Sql> {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  await storeDefinition(app, hex(c.definition));
  const transcript = entriesOf(c)[0]!;
  if (!bare) await appendEntry(app, electionId, transcript.segment, transcript.payload);
  return app;
}

const admissions = (panel = panelOf("panel-4")) => new BallotAdmissions({ panels: [panel], clock });
const during = opensAt + 60n;

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof SubmitError)
      return e.admission === undefined ? e.code : `${e.code}:${e.admission}`;
    throw e;
  }
  return "boarded";
}

describe("boards what the verifier admits, and nothing else", () => {
  test("every admitted ballot is boarded, in order, in the segment of its time", async () => {
    const c = byId("admitted");
    const app = await election(c);
    const a = admissions();
    const ballots = entriesOf(c).slice(1);
    for (const [i, b] of ballots.entries()) {
      const now = during + BigInt(i) * 3_600n;
      const r = await a.submit(app, electionId, b.payload, now);
      expect(r.index).toBe(BigInt(i + 1));
      const entry = decodeBoardEntry(r.entry, VERSION);
      expect(entry.payload).toEqual(b.payload);
      expect(BigInt(entry.segment)).toBe((now - clock.epoch) / clock.period);
    }
    const board = await readBoard(app, electionId);
    expect(board).toHaveLength(ballots.length + 1);
    // The stored board is one the verifier's board check reads.
    expect(() => checkBoard(electionId, board, VERSION)).not.toThrow();
  });

  test("each rejected ballot is refused with the verifier's code, and writes nothing", async () => {
    const c = byId("mixed");
    const app = await election(c);
    const a = admissions();
    // A repeat (5.7) is decided against the board's earlier copies, as below.
    const repeats = new Set(
      (c.ballots?.rejected ?? []).filter((r) => r.code === "repeat").map((r) => r.entry),
    );
    const rejected = new Map(
      (c.ballots?.rejected ?? [])
        .filter((r) => r.code !== "repeat")
        .map((r) => [r.entry, r.code] as const),
    );
    expect(rejected.size).toBeGreaterThan(0);
    let size = 1;
    for (const [at, b] of entriesOf(c).entries()) {
      if (at === 0) continue;
      const code = rejected.get(at);
      const got = await refusal(a.submit(app, electionId, b.payload, during));
      if (code !== undefined) expect(got).toBe(`rejected:${code}`);
      else {
        // The case's repeat is byte-identical: it gets its entry, and isn't boarded again.
        expect(got).toBe("boarded");
        if (!repeats.has(at)) size++;
      }
      expect(await readBoard(app, electionId)).toHaveLength(size);
    }
  });

  test("a repeat of a boarded ballot is never boarded again (5.7)", async () => {
    // The case's copies of one ballot: one with another voter's proof
    // (rejected, so it makes nothing a repeat, R4), the original, a copy with
    // its proof negated (other bytes, the same tier, ν and M: refused), a
    // byte-identical copy (its entry returned, nothing written) and a re-vote
    // (another M: boarded). The verdicts are the independent implementation's.
    const c = byId("repeats");
    const app = await election(c);
    const a = admissions();
    const repeats = new Set(
      (c.ballots?.rejected ?? []).filter((r) => r.code === "repeat").map((r) => r.entry),
    );
    const rejected = new Map(
      (c.ballots?.rejected ?? [])
        .filter((r) => r.code !== "repeat")
        .map((r) => [r.entry, r.code] as const),
    );
    expect(repeats.size).toBe(2);
    const ballots = entriesOf(c).map((e) => e.payload);
    const boarded = new Map<number, bigint>();
    let size = 1;
    let identical = 0;
    let other = 0;
    for (const [at, payload] of ballots.entries()) {
      if (at === 0) continue;
      const code = rejected.get(at);
      if (code !== undefined) {
        expect(await refusal(a.submit(app, electionId, payload, during))).toBe(`rejected:${code}`);
        continue;
      }
      if (!repeats.has(at)) {
        const r = await a.submit(app, electionId, payload, during);
        expect(r.index).toBe(BigInt(size++));
        boarded.set(at, r.index);
      } else {
        const same = [...boarded.keys()].find((k) => equal(ballots[k]!, payload));
        if (same === undefined) {
          other++;
          expect(await refusal(a.submit(app, electionId, payload, during))).toBe("rejected:repeat");
        } else {
          identical++;
          const r = await a.submit(app, electionId, payload, during + 3_600n);
          // The entry that carries it, as boarded, in its own segment.
          const board = await readBoard(app, electionId);
          expect(r.index).toBe(boarded.get(same));
          expect(r.entry).toEqual(board[Number(r.index)]);
        }
      }
      expect(await readBoard(app, electionId)).toHaveLength(size);
    }
    expect([identical, other]).toEqual([1, 1]);
    // One key per boarded ballot: a refused repeat wrote none.
    const keys = await app`SELECT count(*)::int AS n FROM board_ballot_keys`;
    expect(keys[0]!["n"]).toBe(size - 1);
    // A byte-identical retry after close is refused like any ballot then.
    const original = [...boarded.keys()][0]!;
    expect(await refusal(a.submit(app, electionId, ballots[original]!, closesAt + 1n))).toBe(
      "not-open",
    );
    const board = await readBoard(app, electionId);
    expect(() => checkBoard(electionId, board, VERSION)).not.toThrow();
  });

  test("copies submitted at once board one entry", async () => {
    // The key is read under the board's lock: concurrent copies can't both
    // pass the lookup.
    const c = byId("repeats");
    const app = await election(c);
    const db = dbs.at(-1)!;
    const others = await Promise.all([1, 2, 3].map(() => db.as("abolish_app")));
    const [, , original, negated] = entriesOf(c).map((e) => e.payload);
    const a = admissions();
    const results = await Promise.all(
      [app, ...others].flatMap((client) => [
        refusal(a.submit(client, electionId, original!, during)),
        refusal(a.submit(client, electionId, negated!, during)),
      ]),
    );
    const board = await readBoard(app, electionId);
    expect(board).toHaveLength(2);
    const won = decodeBoardEntry(board[1]!, VERSION).payload;
    // Whichever copy won, every submission of its bytes gets its entry and
    // every submission of the other's is refused.
    const winner = equal(won, original!) ? 0 : 1;
    expect(equal(won, winner === 0 ? original! : negated!)).toBe(true);
    results.forEach((r, i) => expect(r).toBe(i % 2 === winner ? "boarded" : "rejected:repeat"));
  });

  test("a payload that isn't a ballot record is refused as undecodable", async () => {
    const c = byId("admitted");
    const app = await election(c);
    const transcript = entriesOf(c)[0]!.payload;
    expect(await refusal(admissions().submit(app, electionId, transcript, during))).toBe(
      "rejected:decode",
    );
    expect(await refusal(admissions().submit(app, electionId, Uint8Array.of(0, 2), during))).toBe(
      "rejected:decode",
    );
    expect(await readBoard(app, electionId)).toHaveLength(1);
  });
});

test("a ballot labelled before a later-labelled one was boarded takes that segment", async () => {
  // Two submissions racing across a period boundary: the earlier-labelled
  // one lands second, and never below the board's last segment.
  const c = byId("admitted");
  const app = await election(c);
  const [, first, second] = entriesOf(c);
  const a = admissions();
  const late = await a.submit(app, electionId, first!.payload, during + 3_600n);
  const early = await a.submit(app, electionId, second!.payload, during);
  const segment = (r: { entry: Uint8Array }) => decodeBoardEntry(r.entry, VERSION).segment;
  expect(segment(early)).toBe(segment(late));
  expect(segment(late)).toBe(Number((during + 3_600n - clock.epoch) / clock.period));
});

describe("takes ballots only while the election can admit them", () => {
  const ballot = () => entriesOf(byId("admitted"))[1]!.payload;

  test("only from opens_at to closes_at, by the caller's clock", async () => {
    const app = await election(byId("admitted"));
    const a = admissions();
    expect(await refusal(a.submit(app, electionId, ballot(), opensAt - 1n))).toBe("not-open");
    expect(await refusal(a.submit(app, electionId, ballot(), closesAt + 1n))).toBe("not-open");
    expect(await readBoard(app, electionId)).toHaveLength(1);
    expect(await refusal(a.submit(app, electionId, ballot(), opensAt))).toBe("boarded");
    expect(await refusal(a.submit(app, electionId, ballot(), closesAt))).toBe("boarded");
  });

  test("not before the transcript is boarded, and from then on", async () => {
    const c = byId("admitted");
    const app = await election(c, true);
    const a = admissions();
    expect(await refusal(a.submit(app, electionId, ballot(), during))).toBe("not-open");
    const transcript = entriesOf(c)[0]!;
    await appendEntry(app, electionId, transcript.segment, transcript.payload);
    // The empty board's refusal wasn't kept.
    expect(await refusal(a.submit(app, electionId, ballot(), during))).toBe("boarded");
  });

  test("never when the board's first entry isn't the transcript", async () => {
    const c = byId("admitted");
    const app = await election(c, true);
    await appendEntry(app, electionId, 0, ballot());
    const transcript = entriesOf(c)[0]!;
    await appendEntry(app, electionId, transcript.segment, transcript.payload);
    expect(await refusal(admissions().submit(app, electionId, ballot(), during))).toBe("not-open");
  });

  test("never under a panel the release doesn't pin", async () => {
    const app = await election(byId("admitted"));
    expect(
      await refusal(admissions(panelOf("panel-4-k2")).submit(app, electionId, ballot(), during)),
    ).toBe("not-open");
    // A pinned panel among others is found by the definition's panel.
    const both = new BallotAdmissions({
      panels: [panelOf("panel-4-k2"), panelOf("panel-4")],
      clock,
    });
    expect(await refusal(both.submit(app, electionId, ballot(), during))).toBe("boarded");
  });

  test.each(["quorum", "other-key", "root-zero"])(
    "never when the verifier admits no ballot of it (%s)",
    async (id) => {
      const c = byId(id);
      const app = await election(c);
      const b = entriesOf(c)[1];
      expect(
        await refusal(admissions().submit(app, electionId, b?.payload ?? ballot(), during)),
      ).toBe("not-open");
      expect(await readBoard(app, electionId)).toHaveLength(1);
    },
  );

  test("an election without a stored definition is unknown", async () => {
    const db = await testDb();
    dbs.push(db);
    const app = await db.as("abolish_app");
    expect(await refusal(admissions().submit(app, electionId, ballot(), during))).toBe(
      "unknown-election",
    );
  });
});

test("refuses options it can't run under", () => {
  expect(() => new BallotAdmissions({ panels: [], clock })).toThrow(RangeError);
  expect(
    () => new BallotAdmissions({ panels: [panelOf("panel-4")], clock: { epoch: 0n, period: 0n } }),
  ).toThrow(RangeError);
  expect(() => new BallotAdmissions({ panels: [panelOf("panel-4")], clock, cacheSize: 0 })).toThrow(
    RangeError,
  );
});
