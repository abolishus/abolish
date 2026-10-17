import {
  checkBoard,
  decodeBallot,
  decodeBoardEntry,
  decodeElectionDefinitionV5,
  type Panel,
  pinnedVersion,
  RECORD_TYPES,
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

// BallotAdmissions (src/admission.ts) for a poll of several questions:
// definition version 5 and ballot version 3, each question's range proof
// checked by @abolishus/verifier's admission beside the per-option proofs,
// and nothing boarded that it refuses (P2-14 part 6a; T-17, T-42, T-45,
// T-52). Admission takes the version from the definition's pins, so the
// server holds no code of its own for version 3. The fixtures are
// docs/spec/vectors/verifier-ballots-v3.json, whose verdicts come from an
// independent implementation: a board holding the ceremony transcript, then
// ballots.

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
  readonly ballots?: {
    readonly admitted: number;
    readonly rejected: readonly { entry: number; code: string; question?: number }[];
  };
}

const file = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/verifier-ballots-v3.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly clock: { readonly epoch: string; readonly period: string };
  readonly panels: Readonly<Record<string, { threshold: string; keys: string[] }>>;
  readonly cases: readonly Case[];
};
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const panel: Panel = {
  threshold: Number(file.panels["panel-4"]!.threshold),
  keys: file.panels["panel-4"]!.keys.map(hex),
};
const clock = { epoch: BigInt(file.clock.epoch), period: BigInt(file.clock.period) };

const definition = decodeElectionDefinitionV5(hex(byId("mixed").definition));
const electionId = definition.election_id;
const during = definition.opens_at + 60n;
// Definition version 5's profile pins board-entry version 5 (asserted below).
const VERSION = 5;

const entriesOf = (c: Case) =>
  splitEntries(hex(c.board)).entries.map((e) => decodeBoardEntry(e, VERSION));

let dbs: TestDb[] = [];
afterEach(async () => {
  await Promise.all(dbs.map((d) => d.close()));
  dbs = [];
});

async function election(c: Case): Promise<Sql> {
  const db = await testDb();
  dbs.push(db);
  const app = await db.as("abolish_app");
  await storeDefinition(app, hex(c.definition));
  const transcript = entriesOf(c)[0]!;
  await appendEntry(app, electionId, transcript.segment, transcript.payload);
  return app;
}

async function verdict(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (e instanceof SubmitError)
      return e.admission === undefined ? e.code : `${e.code}:${e.admission}`;
    throw e;
  }
  return "boarded";
}

describe("a poll of several questions", { timeout: 120_000 }, () => {
  test("the fixtures are a version-5 definition of several questions and version-3 ballots", () => {
    expect(definition.questions.length).toBeGreaterThan(1);
    // Every admitted ballot decodes strictly as version 3.
    expect(pinnedVersion(definition, RECORD_TYPES.ballot)).toBe(3);
    expect(pinnedVersion(definition, RECORD_TYPES.boardEntry)).toBe(VERSION);
    for (const e of entriesOf(byId("admitted")).slice(1))
      expect(() => decodeBallot(e.payload, 3)).not.toThrow();
  });

  test("boards each admitted ballot and refuses each rejected one with the verifier's code", async () => {
    // Among them: a question over its maximum and another under its
    // minimum (`sum-proof`, 2.7's range proof for that question), a range
    // proof of the wrong shape and a vote of 2 on one option.
    const c = byId("mixed");
    const app = await election(c);
    const a = new BallotAdmissions({ panels: [panel], clock });
    const rejected = new Map((c.ballots?.rejected ?? []).map((r) => [r.entry, r.code] as const));
    expect(
      c.ballots?.rejected.filter((r) => r.code === "sum-proof").map((r) => r.question),
    ).toEqual([1, 2]);
    let size = 1;
    for (const [at, b] of entriesOf(c).entries()) {
      if (at === 0) continue;
      const code = rejected.get(at);
      const got = await verdict(a.submit(app, electionId, b.payload, during));
      if (code === "repeat") {
        // The case's repeat is byte-identical: it gets its entry, and isn't boarded again (5.7).
        expect(got).toBe("boarded");
      } else if (code === undefined) {
        expect(got).toBe("boarded");
        size++;
      } else expect(got).toBe(`rejected:${code}`);
      expect(await readBoard(app, electionId)).toHaveLength(size);
    }
    expect(size - 1).toBe(c.ballots?.admitted);
    const board = await readBoard(app, electionId);
    expect(() => checkBoard(electionId, board, VERSION)).not.toThrow();
  });

  test.each(["mixed", "admitted"])(
    "case %s: submitAll gives each ballot submit's verdict, and the same board",
    async (id) => {
      const c = byId(id);
      const batched = await election(c);
      const alone = await election(c);
      const ballots = entriesOf(c)
        .slice(1)
        .map((e) => e.payload);
      const outcomes = await new BallotAdmissions({ panels: [panel], clock }).submitAll(
        batched,
        electionId,
        ballots,
        during,
      );
      const a = new BallotAdmissions({ panels: [panel], clock });
      const expected: string[] = [];
      for (const b of ballots) expected.push(await verdict(a.submit(alone, electionId, b, during)));
      expect(
        outcomes.map((o) =>
          o.ok
            ? "boarded"
            : o.error.admission === undefined
              ? o.error.code
              : `${o.error.code}:${o.error.admission}`,
        ),
      ).toEqual(expected);
      expect(await readBoard(batched, electionId)).toEqual(await readBoard(alone, electionId));
    },
  );
});
