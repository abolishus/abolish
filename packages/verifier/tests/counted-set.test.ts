import { readFileSync } from "node:fs";
import {
  aggregateCell,
  countedExtent,
  decodeBoardEntry,
  encodeBoardEntry,
  type BoardEntryVersion,
  L1_REF_MARGIN,
  pinnedVersion,
  RECORD_TYPES,
  tallyRules,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_BLOCKS,
  type CheckResult,
  countedSet,
  type CountedExtentInputs,
  countedTally,
  parseBundle,
  verifyBundle,
} from "../src/index.ts";
import { readElection } from "../src/admission.ts";
import { cellTiers } from "../src/counted.ts";
import { wholeOpeningPin } from "../src/counted-set.ts";
import { decodeDefinition } from "../src/definition.ts";
import { run, type TestHeader, toHex } from "./headers.ts";

// The counted set from the counted extent (docs/spec/verifier.md, Counted
// set from the counted extent) on the vectors' boards
// (verifier-ballots.json: an independent Python implementation, with
// snarkjs's verdict on every membership proof). Their ballots name random
// block hashes, so no run here admits one: the runs are placed to reject or
// leave pending every reference, which reaches each undecided row and the
// decided empty set. A set with ballots in it, over real blocks and real
// receipts, is apps/trustee-node's tests/counted-set.test.ts.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const numRuns = Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 50);

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
}
const file = read("verifier-ballots.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly panels: Readonly<Record<string, unknown>>;
  readonly cases: readonly Case[];
};
const l1File = read("l1-anchor.json") as {
  readonly vectors: readonly {
    readonly id: string;
    readonly firstSegment: string;
    readonly block: { readonly header: string };
    readonly nodes: readonly string[];
    readonly checkpoints: readonly string[];
  }[];
};
const closed = l1File.vectors.find((v) => v.id === "closed");
if (closed === undefined) throw new Error("no closed L1 vector");
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};

// Every case's definition opens and closes at these times; `admitted`'s
// ballots name blocks 21011130 to 21033826.
const OPENS = 1_767_225_600n;
const CLOSES = 1_767_830_400n;
const START = OPENS - L1_REF_MARGIN;

const versionOf = (c: Case) =>
  pinnedVersion(
    decodeDefinition(hex(c.definition)).value,
    RECORD_TYPES.boardEntry,
  ) as BoardEntryVersion;

/** A format-5 bundle of case `c` with `headers` as its run, as `verifyBundle` reads it. */
const bundleOf = (c: Case, headers: readonly TestHeader[]) =>
  parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_BLOCKS,
      definition: c.definition,
      clock: file.clock,
      l1: {
        firstSegment: closed.firstSegment,
        header: closed.block.header,
        nodes: closed.nodes,
        checkpoints: closed.checkpoints,
      },
      panel: file.panels[c.panel],
      l1Blocks: headers.map((h) => toHex(h.encoded)),
    }),
    hex(c.board),
  );

/** `countedSet`'s inputs over the same bundle: its copy taken as the counted extent. */
function inputsOf(c: Case, headers: readonly TestHeader[]): CountedExtentInputs {
  const b = bundleOf(c, headers);
  if (!("l1Blocks" in b) || !("panel" in b)) throw new Error("not a format-5 bundle");
  return {
    definition: hex(c.definition),
    panel: b.panel,
    entries: b.entries,
    clock: b.clock,
    blocks: b.l1Blocks,
    eventsAuthenticated: false,
  };
}

const row = (c: Case, headers: readonly TestHeader[], id: string) => {
  const r = verifyBundle(bundleOf(c, headers));
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};

// Each test admits whole boards, at about a second a run on CI's shared runner,
// so a property's 50 runs take about 50 s there, and twice that on a busy
// one: three minutes leaves room for both.
const WHOLE_BOARDS = 180_000;

describe("the counted set from the counted extent", { timeout: WHOLE_BOARDS }, () => {
  const admitted = byId("admitted");
  const afterClose = run(21_000_000n, [START - 12n, CLOSES + 12n]);

  test("is decided, and empty, once every ballot is rejected", () => {
    // Every reference lies beyond a head after close: l1-ref-after-close.
    const result = countedSet(inputsOf(admitted, afterClose));
    if (!result.ok) return expect.fail(`undecided: ${JSON.stringify(result)}`);
    // One cell per tier of the two-tier electorate.
    expect(result.cells).toEqual([[], []]);
    // A fixed definition never reads a rolling chain, whatever it holds.
    const rolling = { events: [], registeredAt: 0n };
    expect(countedSet({ ...inputsOf(admitted, afterClose), rolling })).toEqual(result);
  });

  test("is undecided while a reference is pending, with 5.8's own outcome", () => {
    const atClose = run(21_000_000n, [START - 12n, CLOSES]);
    expect(countedSet(inputsOf(admitted, atClose))).toEqual({
      ok: false,
      row: "5.8",
      outcome: row(admitted, atClose, "5.8"),
    });
    expect(row(admitted, atClose, "5.8")).toEqual({
      status: "unverifiable",
      code: "l1-ref-pending",
      at: { entry: 1 },
    });
  });

  test("is undecided on a run too short to place l1_ref_min", () => {
    const short = run(21_000_000n, [START + 1n, CLOSES + 1n]);
    expect(countedSet(inputsOf(admitted, short))).toEqual({
      ok: false,
      row: "5.8",
      outcome: { status: "unverifiable", code: "l1-blocks-short", at: {} },
    });
  });

  test("is undecided exactly where 5.8 is, whatever the head's time", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: OPENS, max: CLOSES + 100n }), (head) => {
        const headers = run(21_000_000n, [START - 12n, head]);
        const result = countedSet(inputsOf(admitted, headers));
        const r = row(admitted, headers, "5.8");
        if (r.status === "unverifiable")
          expect(result).toEqual({ ok: false, row: "5.8", outcome: r });
        else expect(result).toMatchObject({ ok: true, cells: [[], []] });
      }),
      { numRuns },
    );
  });

  test("waits on authenticated events wherever an ordinary ballot is in the extent", () => {
    const events = byId("events-v8");
    const result = countedSet(inputsOf(events, afterClose));
    expect(result).toMatchObject({
      ok: false,
      row: "6.1",
      outcome: { status: "unverifiable", code: "not-reached" },
    });
    if (result.ok || !("row" in result)) return;
    // The entry named carries the board's BallotSubmitted.
    const at = (result.outcome.at as { readonly entry: number }).entry;
    const entry = decodeBoardEntry(
      inputsOf(events, afterClose).entries[at] as Uint8Array,
      versionOf(events),
    );
    expect(((entry.payload[0] as number) << 8) | (entry.payload[1] as number)).toBe(
      RECORD_TYPES.contractEvent,
    );
    // Authenticated, the ordinary ballot is judged as the others: rejected
    // by its reference here. The extent's obligation root naming the
    // definition still leaves delivery undecided (its leaves aren't read).
    expect(
      countedSet({ ...inputsOf(events, afterClose), eventsAuthenticated: true }),
    ).toMatchObject({
      ok: false,
      row: "5.9",
      outcome: { status: "unverifiable", code: "not-implemented" },
    });
  });

  test("names the check that stops every ballot", () => {
    const base = inputsOf(admitted, afterClose);
    expect(countedSet({ ...base, definition: base.definition.slice(0, -1) })).toEqual({
      ok: false,
      code: "definition-decode",
    });
    // The transcript is the copy's first entry.
    expect(countedSet({ ...base, entries: base.entries.slice(1) })).toEqual({
      ok: false,
      code: "ceremony-transcript-missing",
    });
  });

  test("refuses entries that aren't the counted extent", () => {
    const base = inputsOf(admitted, afterClose);
    const d = decodeDefinition(base.definition).value;
    const version = versionOf(admitted);
    const sS = Number(countedExtent(base.clock, d.closes_at, BigInt(d.l1_inclusion_bound)).segment);
    const last = decodeBoardEntry(base.entries.at(-1) as Uint8Array, version);
    const past = encodeBoardEntry({ ...last, index: last.index + 1n, segment: sS + 1 }, version);
    expect(() => countedSet({ ...base, entries: [...base.entries, past] })).toThrow(RangeError);
    const atS = encodeBoardEntry({ ...last, index: last.index + 1n, segment: sS }, version);
    expect(countedSet({ ...base, entries: [...base.entries, atS] }).ok).toBe(true);
    const other = encodeBoardEntry(
      { ...last, index: last.index + 1n, election_id: new Uint8Array(32).fill(1) },
      version,
    );
    expect(() => countedSet({ ...base, entries: [...base.entries, other] })).toThrow(RangeError);
    // Out of the board's order: a skipped index, or a segment going back.
    const skipped = encodeBoardEntry({ ...last, index: last.index + 2n }, version);
    expect(() => countedSet({ ...base, entries: [...base.entries, skipped] })).toThrow(RangeError);
    const later = encodeBoardEntry({ ...last, index: last.index + 1n, segment: 2 }, version);
    const back = encodeBoardEntry({ ...last, index: last.index + 2n, segment: 1 }, version);
    expect(countedSet({ ...base, entries: [...base.entries, later] }).ok).toBe(true);
    expect(() => countedSet({ ...base, entries: [...base.entries, later, back] })).toThrow(
      RangeError,
    );
    expect(() => countedSet({ ...base, entries: [...base.entries, Uint8Array.of(0)] })).toThrow(
      RangeError,
    );
  });
});

// What the board operator judges a tally opening against (`countedTally`):
// `countedSet`'s cells summed, the registered key set and the pinned
// whole-opening version, undecided exactly where the set is.
describe("the counted tally from the counted extent", { timeout: WHOLE_BOARDS }, () => {
  const admitted = byId("admitted");
  const afterClose = run(21_000_000n, [START - 12n, CLOSES + 12n]);

  test("sums the decided set's cells, with the registered key set and the pin", () => {
    const inputs = inputsOf(admitted, afterClose);
    const result = countedTally(inputs);
    if (!result.ok) return expect.fail(`undecided: ${JSON.stringify(result)}`);
    const record = decodeDefinition(inputs.definition);
    const set = countedSet(inputs);
    if (!set.ok) return expect.fail("countedSet undecided");
    const rules = tallyRules(record);
    // Every ballot is rejected, so each cell sums nothing.
    expect(result.aggregates).toEqual(set.cells.map(() => aggregateCell(rules, [])));
    expect(result.counted).toEqual(set.cells.map((c) => c.length));
    expect(result.tiers).toEqual(cellTiers(record));
    expect(result.election.definitionHash).toEqual(set.definitionHash);
    expect(result.election.rules).toEqual(rules);
    const read = readElection(inputs.definition, inputs.panel, inputs.entries);
    if (!read.ok) return expect.fail("readElection refused");
    expect(result.election.registered).toEqual(
      read.registered.map((k) => ({ index: k.index, signingKey: k.signingKey })),
    );
    expect(result.pinned).toBe(pinnedVersion(record.value, RECORD_TYPES.tallyOpening));
  });

  test("is undecided exactly where the counted set is", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: OPENS, max: CLOSES + 100n }), (head) => {
        const inputs = inputsOf(admitted, run(21_000_000n, [START - 12n, head]));
        const set = countedSet(inputs);
        const tally = countedTally(inputs);
        if (set.ok) expect(tally.ok).toBe(true);
        else expect(tally).toEqual(set);
      }),
      { numRuns },
    );
    const base = inputsOf(admitted, afterClose);
    expect(countedTally({ ...base, entries: base.entries.slice(1) })).toEqual({
      ok: false,
      code: "ceremony-transcript-missing",
    });
  });
});

// The pin read off each definition vector's JSON value, not the decoder.
describe("the whole-opening pin", () => {
  interface DefinitionVector {
    readonly id: string;
    readonly value?: {
      readonly author_keys?: readonly unknown[];
      readonly profile: { readonly pins: readonly { record_type: string; version: string }[] };
    };
    readonly encoding?: string;
  }
  const vectors = ["election-definition.json", "election-definition-v6.json"].flatMap(
    (name) => (read(name) as { readonly vectors: readonly DefinitionVector[] }).vectors,
  );

  test("is 1 or 2 as pinned, and none beside an author panel or for another pin", () => {
    let read = 0;
    const seen = new Set<string>();
    for (const v of vectors) {
      if (v.value === undefined || v.encoding === undefined) continue;
      let record;
      try {
        record = decodeDefinition(hex(v.encoding));
      } catch {
        continue;
      }
      read++;
      const pin = v.value.profile.pins.find((p) => Number(p.record_type) === 6);
      const expected =
        (v.value.author_keys?.length ?? 0) !== 0 || pin === undefined
          ? undefined
          : Number(pin.version) === 1 || Number(pin.version) === 2
            ? Number(pin.version)
            : undefined;
      expect(wholeOpeningPin(record), v.id).toBe(expected);
      seen.add(String(expected));
    }
    expect(read).toBeGreaterThan(10);
    // Both a pin and its absence are among the vectors.
    expect(seen).toEqual(new Set(["1", "undefined"]));
  });
});
