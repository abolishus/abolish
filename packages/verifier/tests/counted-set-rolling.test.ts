import { readFileSync } from "node:fs";
import {
  aggregateCell,
  type AnchorClock,
  L1_REF_MARGIN,
  pinnedVersion,
  RECORD_TYPES,
  type RollingBallotChain,
  type RollingTierEvent,
  tallyRules,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { readElection } from "../src/admission.ts";
import { ALL_ROWS, ballotChecks } from "../src/ballots.ts";
import { cellTiers } from "../src/counted.ts";
import { decodeDefinition } from "../src/definition.ts";
import { countedSet, type CountedExtentInputs, countedTally, splitEntries } from "../src/index.ts";
import { decodeHeader } from "../src/l1.ts";
import { run, type TestHeader } from "./headers.ts";

// The counted set from the counted extent under a rolling definition
// (definition version 7, `electorate_mode` 2; docs/spec/verifier.md, Counted
// set from the counted extent, step 2; P2-17 part 7c-3c-2a), on
// verifier-ballots-v5.json's boards (an independent Python implementation,
// every step root rebuilt there from the listed groups' events) with the
// chain from that file's group registry events and registration time, as a
// trustee node builds it from its own proven read of both registries. Their
// ballots name random block hashes, so no run here admits one: a set with
// ballots in it is the trustee node's to test, over real blocks.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const numRuns = Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 10);

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
}
const file = read("verifier-ballots-v5.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: readonly string[] }>
  >;
  readonly events: readonly {
    readonly block: string;
    readonly timestamp: string;
    readonly group: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  }[];
  readonly registeredAt: string;
  readonly cases: readonly Case[];
};
const events: RollingTierEvent[] = file.events.map((e) => {
  const at = {
    blockNumber: BigInt(e.block),
    timestamp: BigInt(e.timestamp),
    groupId: BigInt(e.group),
  };
  return e.remove === undefined
    ? { ...at, kind: "add", commitments: (e.add ?? []).map(BigInt) }
    : { ...at, kind: "remove", indices: e.remove.map(BigInt) };
});
const chain: RollingBallotChain = { events, registeredAt: BigInt(file.registeredAt) };
const clock: AnchorClock = {
  epoch: BigInt(file.clock["epoch"] ?? ""),
  period: BigInt(file.clock["period"] ?? ""),
  deadline: BigInt(file.clock["deadline"] ?? ""),
  lastSegment: Number(file.clock["lastSegment"]),
};
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};

// Every case's definition opens and closes at the same times.
const times = decodeDefinition(hex(byId("board").definition)).value;
const START = times.opens_at - L1_REF_MARGIN;
const CLOSES = times.closes_at;
const afterClose = run(21_000_000n, [START - 12n, CLOSES + 12n]);

/** `countedSet`'s inputs over case `c`'s board, taken as the counted extent, with `headers` as the run. */
function inputsOf(
  c: Case,
  headers: readonly TestHeader[],
  rolling: RollingBallotChain | null = chain,
): CountedExtentInputs {
  const p = file.panels[c.panel];
  if (p === undefined) throw new Error(`no panel ${c.panel}`);
  return {
    definition: hex(c.definition),
    panel: { threshold: Number(p.threshold), keys: p.keys.map(hex) },
    entries: splitEntries(hex(c.board)).entries,
    clock,
    blocks: headers.map((h) => decodeHeader(h.encoded)),
    eventsAuthenticated: true,
    ...(rolling !== null && { rolling }),
  };
}
/** Admission's rows over the same inputs, with the same chain, as `ballotChecks` gives them. */
function admissionRows(inputs: CountedExtentInputs) {
  const election = readElection(
    inputs.definition,
    inputs.panel,
    inputs.entries,
    undefined,
    inputs.rolling,
  );
  if (!election.ok) throw new Error(`readElection refused: ${election.code}`);
  return ballotChecks(
    election.record,
    election.registered,
    election.authorRegistered,
    inputs.entries,
    election.boardEntryVersion,
    inputs.clock,
    inputs.blocks,
    inputs.rolling,
  );
}

// Each run admits a whole board under the chain, a few seconds on CI's shared runner.
const WHOLE_BOARDS = 180_000;

describe("the counted set under a rolling definition", { timeout: WHOLE_BOARDS }, () => {
  test("without the chain, refuses every rolling poll before any ballot is read", () => {
    for (const c of file.cases) {
      const inputs = inputsOf(c, afterClose, null);
      expect(countedSet(inputs), c.id).toEqual({ ok: false, code: "unsupported-version" });
      expect(countedTally(inputs), c.id).toEqual({ ok: false, code: "unsupported-version" });
    }
  });

  test("with it, is decided, one empty cell per rolling tier, once every ballot is rejected", () => {
    for (const id of ["board", "rolling-path", "no-ballots"]) {
      const inputs = inputsOf(byId(id), afterClose);
      const result = countedSet(inputs);
      if (!result.ok) return expect.fail(`${id} undecided: ${JSON.stringify(result)}`);
      // Tiers 0 and 2, `rolling_electorate`'s two entries.
      expect(result.cells, id).toEqual([[], []]);
      // Every admission row settled, so selection's condition 1 holds.
      const rows = admissionRows(inputs).rows;
      for (const row of ALL_ROWS)
        expect(rows.get(row)?.status, `${id} ${row}`).not.toBe("unverifiable");
    }
  });

  test("decides over rejections resting on the step roots: the chain is the caller's own", () => {
    // Unlike the archive's chain in `verifyBundle`, a chain built from a
    // proven read of the registries decides root-step-mismatch,
    // root-step-range and membership-proof rejections (T-71).
    const inputs = inputsOf(byId("rolling-path"), afterClose);
    const rejected = admissionRows(inputs).report?.rejected.map((r) => r.code) ?? [];
    expect(rejected).toEqual(
      expect.arrayContaining(["root-step-mismatch", "root-step-range", "membership-proof"]),
    );
    expect(countedSet(inputs).ok).toBe(true);
  });

  test("is undecided where admission is: a relayed rolling ballot set aside at 5.5", () => {
    const inputs = inputsOf(byId("relayed-rolling-path"), afterClose);
    const rows = admissionRows(inputs).rows;
    expect(countedSet(inputs)).toEqual({ ok: false, row: "5.5", outcome: rows.get("5.5") });
    expect(rows.get("5.5")).toEqual({
      status: "unverifiable",
      code: "not-implemented",
      at: { entry: 3 },
    });
  });

  test("is undecided exactly where 5.8 is under the chain, whatever the head's time", () => {
    const c = byId("board");
    fc.assert(
      fc.property(fc.bigInt({ min: times.opens_at, max: CLOSES + 100n }), (head) => {
        const inputs = inputsOf(c, run(21_000_000n, [START - 12n, head]));
        const result = countedSet(inputs);
        const r = admissionRows(inputs).rows.get("5.8");
        if (r?.status === "unverifiable")
          expect(result).toEqual({ ok: false, row: "5.8", outcome: r });
        else expect(result).toMatchObject({ ok: true, cells: [[], []] });
      }),
      { numRuns },
    );
  });

  test("throws on a chain whose events don't give the definition's opening state", () => {
    // `rollingChain` never gives one: its recount (2.4) passed.
    const inputs = inputsOf(byId("no-ballots"), afterClose, {
      events: [],
      registeredAt: chain.registeredAt,
    });
    expect(() => countedSet(inputs)).toThrow(RangeError);
  });
});

describe("the counted tally under a rolling definition", { timeout: WHOLE_BOARDS }, () => {
  test("sums each rolling tier's cell, with the registered key set and the pin", () => {
    const inputs = inputsOf(byId("board"), afterClose);
    const result = countedTally(inputs);
    if (!result.ok) return expect.fail(`undecided: ${JSON.stringify(result)}`);
    const record = decodeDefinition(inputs.definition);
    if (record.version !== 7) return expect.fail("not version 7");
    const rules = tallyRules(record);
    expect(result.tiers).toEqual(record.value.rolling_electorate.map((t) => t.tier));
    expect(result.tiers).toEqual(cellTiers(record));
    expect(result.counted).toEqual([0, 0]);
    expect(result.aggregates).toEqual([aggregateCell(rules, []), aggregateCell(rules, [])]);
    expect(result.election.rules).toEqual(rules);
    const read = readElection(inputs.definition, inputs.panel, inputs.entries, undefined, chain);
    if (!read.ok) return expect.fail("readElection refused");
    expect(result.election.definitionHash).toEqual(read.hash);
    expect(result.election.registered).toEqual(
      read.registered.map((k) => ({ index: k.index, signingKey: k.signingKey })),
    );
    expect(result.pinned).toBe(pinnedVersion(record.value, RECORD_TYPES.tallyOpening));
  });

  test("is undecided where the counted set is", () => {
    const inputs = inputsOf(byId("relayed-rolling-path"), afterClose);
    expect(countedTally(inputs)).toEqual(countedSet(inputs));
  });
});
