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
  readonly ballots?: { readonly rejected: readonly { entry: number; code: string }[] };
}

const file = read("verifier-ballots.json") as {
  readonly panels: Readonly<Record<string, { threshold: string; keys: string[] }>>;
  readonly cases: readonly Case[];
};
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
    const rejected = new Map((c.ballots?.rejected ?? []).map((r) => [r.entry, r.code] as const));
    expect(rejected.size).toBeGreaterThan(0);
    let size = 1;
    for (const [at, b] of entriesOf(c).entries()) {
      if (at === 0) continue;
      const code = rejected.get(at);
      const got = await refusal(a.submit(app, electionId, b.payload, during));
      if (code === undefined) {
        expect(got).toBe("boarded");
        size++;
      } else expect(got).toBe(`rejected:${code}`);
      expect(await readBoard(app, electionId)).toHaveLength(size);
    }
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
