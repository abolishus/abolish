import { readFileSync } from "node:fs";
import {
  copyCheckpoints,
  decodeBoardEntry,
  DELIVERY_WINDOW,
  encodeCheckpoint,
  encodeBoardEntry,
  encodeDestructionStatement,
  type BoardEntryVersion,
  replayEventAccumulator,
  signDestructionStatement,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_BLOCKS,
  BUNDLE_FORMAT_L2,
  BundleError,
  type CheckResult,
  PINNED_MARGIN,
  parseBundle,
  type Report,
  splitEntries,
  verifyBundle,
} from "../src/index.ts";
import { decodeDefinition } from "../src/definition.ts";
import { run, toHex } from "./headers.ts";
import { ACCUMULATOR_SLOT } from "../src/output-root.ts";
import { anchoredL1, l2State, word } from "./state.ts";

// A whole run over a sealed board that 4.1 and 4.2 accept: verifier-tallies.json's
// `honest` election (definition version 1, board-entry version 4, its
// transcript and honest openings of its two empty cells by seats 1 to 3),
// anchored in an L1 state built here (state.ts) and with a run of L1 headers
// past close. No ballot is on it, so 6.1 passes with nothing selected and the
// counted set is reached through `verifyBundle` itself: every cell is empty,
// so the openings pass, and no seat has stated destruction (T-53, T-29).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const file = read("verifier-tallies.json") as {
  readonly panels: Readonly<Record<string, unknown>>;
  readonly cases: readonly {
    readonly id: string;
    readonly panel: string;
    readonly definition: string;
    readonly board: string;
    readonly clock: Readonly<Record<string, string>>;
  }[];
};
const honest = file.cases.find((c) => c.id === "honest");
if (honest === undefined) throw new Error("no honest case");
const definition = decodeDefinition(hex(honest.definition)).value;
const VERSION: BoardEntryVersion = 5;
const OPENS = definition.opens_at;
const CLOSES = definition.closes_at;
const clock = {
  epoch: BigInt(honest.clock["epoch"] as string),
  period: BigInt(honest.clock["period"] as string),
  deadline: BigInt(honest.clock["deadline"] as string),
  lastSegment: Number(honest.clock["lastSegment"]),
};
// Well after the seal's window closes.
const NOW = clock.epoch + BigInt(clock.lastSegment + 1) * clock.period + clock.deadline + 1n;

const copy = splitEntries(hex(honest.board)).entries;

// `t_A = t_D − R` (docs/spec/availability.md, Windows).
const T_A = CLOSES + BigInt(definition.l1_inclusion_bound) + DELIVERY_WINDOW - PINNED_MARGIN;

// The board contract with no event at all, its accumulator at genesis,
// proven under an output root of a block at `timestamp`.
function emptyBoard(timestamp: bigint) {
  const { accumulator, count } = replayEventAccumulator(
    definition.l2_chain_id,
    definition.board,
    [],
  );
  const { evidence } = l2State(
    [
      {
        address: definition.board,
        storage: [
          [word(ACCUMULATOR_SLOT), accumulator],
          [word(ACCUMULATOR_SLOT + 1n), word(count)],
        ],
      },
    ],
    1_000n,
    timestamp,
  );
  return {
    events: [],
    outputRoot: toHex(evidence.outputRoot),
    messagePasserStorageRoot: toHex(evidence.messagePasserStorageRoot),
    header: toHex(evidence.header),
    nodes: evidence.nodes.map(toHex),
  };
}

function bundleJson(
  l2Board?: Readonly<Record<string, unknown>>,
  anchored: readonly Uint8Array[] = copy,
  withCheckpoints = false,
): Record<string, unknown> {
  const l1 = anchoredL1(definition.election_id, definition.l1_anchor, anchored, VERSION, clock, {
    number: 20_000_000n,
    timestamp: NOW,
  });
  // Checkpoints no copy matches come from their logs (docs/spec/verifier.md, Bundle).
  if (withCheckpoints) {
    const segments = [...new Set(anchored.map((e) => decodeBoardEntry(e, VERSION).segment))];
    const all = copyCheckpoints(definition.election_id, anchored, [...segments, clock.lastSegment]);
    l1.checkpoints = [...all.values()].map((c) => toHex(encodeCheckpoint(c)));
  }
  return {
    format: l2Board === undefined ? BUNDLE_FORMAT_BLOCKS : BUNDLE_FORMAT_L2,
    definition: honest?.definition,
    clock: honest?.clock,
    l1,
    panel: file.panels[honest?.panel ?? ""],
    l1Blocks: run(21_000_000n, [OPENS - 3600n - 12n, CLOSES + 3600n + 12n]).map((h) =>
      toHex(h.encoded),
    ),
    ...(l2Board !== undefined && { l2Board }),
  };
}

function bundle(
  entries: readonly Uint8Array[],
  l2Board?: ReturnType<typeof emptyBoard>,
  anchored = entries,
): Report {
  return verifyBundle(
    parseBundle(
      JSON.stringify(bundleJson(l2Board, anchored, anchored !== entries)),
      Uint8Array.from(entries.flatMap((e) => [...e])),
    ),
  );
}
const row = (r: Report, id: string) => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};

describe("a sealed, authenticated board with no ballot", { timeout: 60_000 }, () => {
  const r = bundle(copy);

  test("the profile pins board-entry version 5 and contract-event version 8, so 2.3 doesn't fail", () => {
    // 2.3's other parts aren't built, so it stays unverifiable (close.md, Version).
    expect(row(r, "2.3")).toEqual({ status: "unverifiable", code: "not-implemented" });
  });

  test("4.1, 4.2, 3.2 and every admission row pass, so 6.1 selects nothing", () => {
    for (const id of ["4.1", "4.2", "3.2", "5.1", "5.4", "5.5", "5.7", "5.8", "6.1"])
      expect(row(r, id)).toEqual({ status: "pass" });
    expect(r.ballots).toMatchObject({ admitted: 0, selected: [], ties: [] });
  });

  test("delivery has nothing to judge, every empty cell's opening passes, and no seat stated destruction", () => {
    for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3", "7.4"])
      expect(row(r, id)).toEqual({ status: "pass" });
    // No close statement: the close is unchecked, and passes (close.md, Close check).
    expect(r.close).toMatchObject({ head: null, unchecked: [], late: [] });
    expect(r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    expect(r.cells).toEqual([
      { cell: 0, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [1, 3] },
      { cell: 1, tier: 2, counted: 0, counts: ["0", "0", "0"], signers: [2] },
    ]);
    expect(row(r, "8.5")).toEqual({
      status: "fail",
      code: "destruction-missing",
      at: { seat: 1 },
    });
    // Seat 4 sent nothing in the ceremony: three seats are registered.
    expect(r.destruction?.seats.map((s) => s.code)).toEqual([
      "destruction-missing",
      "destruction-missing",
      "destruction-missing",
    ]);
    // 8.5 is report-only, and the inputs are local files (T-53, T-54).
    expect(r.verdictAgainstInputs).toBe("unverifiable");
    expect(r.verdict).toBe("unverifiable");
  });

  test("the report's members are in the spec's order (Report)", () => {
    const spec = readFileSync(new URL("../../../docs/spec/verifier.md", import.meta.url), "utf8");
    const table = spec.slice(spec.indexOf("### Report"), spec.indexOf("### Command line"));
    const order = [...table.matchAll(/^\| `([a-zA-Z0-9]+)` +\|/gm)].map((m) => m[1]);
    const keys = Object.keys(r);
    expect(keys).toEqual(order.filter((k) => k !== undefined && keys.includes(k)));
    for (const member of ["delivery", "cells", "tiers", "destruction", "close"])
      expect(keys).toContain(member);
  });

  test("the tally reads the anchored board: without the openings every cell is tally-missing", () => {
    const only = bundle(copy.slice(0, 1));
    expect(row(only, "7.2")).toEqual({ status: "fail", code: "tally-missing", at: { cell: 0 } });
    expect(only.verdictAgainstInputs).toBe("failed");
    expect(only.verdict).toBe("unverifiable");
  });

  test("an entry past the anchored extent is no one's", () => {
    // A statement appended past the seal, which no anchor covers.
    const last = decodeBoardEntry(copy.at(-1) as Uint8Array, VERSION);
    const extra = encodeBoardEntry(
      {
        election_id: definition.election_id,
        index: last.index + 1n,
        segment: clock.lastSegment + 1,
        payload: encodeDestructionStatement(
          signDestructionStatement(new Uint8Array(32).fill(7), {
            definition_hash: new Uint8Array(32),
            signer: 1,
          }),
        ),
      },
      VERSION,
    );
    const anchored = bundle(copy);
    const l1 = anchoredL1(definition.election_id, definition.l1_anchor, copy, VERSION, clock, {
      number: 20_000_000n,
      timestamp: NOW,
    });
    const appended = verifyBundle(
      parseBundle(
        JSON.stringify({
          format: BUNDLE_FORMAT_BLOCKS,
          definition: honest?.definition,
          clock: honest?.clock,
          l1,
          panel: file.panels[honest?.panel ?? ""],
          l1Blocks: run(21_000_000n, [OPENS - 3600n - 12n, CLOSES + 3600n + 12n]).map((h) =>
            toHex(h.encoded),
          ),
        }),
        Uint8Array.from([...copy, extra].flatMap((e) => [...e])),
      ),
    );
    expect(appended.board.unauthenticated).toBe(1);
    expect(appended.checks).toEqual(anchored.checks);
    expect(appended.destruction).toEqual(anchored.destruction);
    expect(appended.tallies).toEqual(anchored.tallies);
  });
});

describe(
  "the availability check over the board contract's events (format 6)",
  { timeout: 60_000 },
  () => {
    test("format 5 carries no events, so 4.6 isn't implemented there", () => {
      expect(row(bundle(copy), "4.6")).toEqual({ status: "unverifiable", code: "not-implemented" });
    });

    test("a board whose seats attested nothing fails 4.6, whatever its copy shows", () => {
      const r = bundle(copy, emptyBoard(T_A > NOW ? T_A : NOW));
      expect(row(r, "4.6")).toEqual({
        status: "fail",
        code: "unavailable",
        at: { point: 1, panel: 1 },
      });
      // Every registered seat is silent (seat 4 sent nothing in the ceremony).
      expect(r.availability?.ballotExtent.panels).toEqual([
        { panel: 1, holds: false, attested: [], complained: [], silent: [1, 2, 3] },
      ]);
      expect(r.availability?.records).toEqual([]);
      // The other rows are what format 5 gives.
      const before = bundle(copy);
      expect(r.checks.filter((c) => c.id !== "4.6")).toEqual(
        before.checks.filter((c) => c.id !== "4.6"),
      );
      // The output root is a local input until it is read from L1.
      expect(r.inputs.l2OutputRoot).toBe("local-file");
      expect(r.verdictAgainstInputs).toBe("failed");
      expect(r.verdict).toBe("unverifiable");
    });

    test("an accumulator proven before t_A leaves the ballot extent unverifiable", () => {
      const r = bundle(copy, emptyBoard(T_A - 1n));
      expect(row(r, "4.6")).toEqual({
        status: "unverifiable",
        code: "availability-pending",
        at: {},
      });
      expect(r.availability?.ballotExtent.panels).toBeUndefined();
    });

    test("without a copy the key set isn't known yet, so 4.6 isn't reached", () => {
      // The anchors are the whole board's, the copy is empty: 4.1 and 4.2 are
      // unverifiable, and the registered key set comes from the transcript on
      // the copy until it is read from the trustee registry's events (P1-19).
      const r = bundle([], emptyBoard(T_A > NOW ? T_A : NOW), copy);
      expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "checkpoint-missing" });
      expect(row(r, "4.6")).toEqual({ status: "unverifiable", code: "not-reached" });
    });

    test("format 6's l2Board has exactly its members, its bytes as lowercase hex", () => {
      const board = Uint8Array.from(copy.flatMap((e) => [...e]));
      const parse = (j: Record<string, unknown>) => parseBundle(JSON.stringify(j), board);
      const l2 = emptyBoard(NOW);
      expect(parse(bundleJson(l2)).format).toBe(BUNDLE_FORMAT_L2);
      const { events: _, ...noEvents } = l2;
      for (const bad of [
        { ...bundleJson(l2), l2Board: noEvents },
        { ...bundleJson(l2), l2Board: { ...l2, extra: [] } },
        { ...bundleJson(l2), l2Board: { ...l2, events: ["0A"] } },
        { ...bundleJson(l2), l2Board: { ...l2, events: [""] } },
        { ...bundleJson(l2), l2Board: { ...l2, outputRoot: "00" } },
        { ...bundleJson(l2), l2Board: { ...l2, nodes: "00" } },
        // Format 5 has no l2Board, and format 6 must have one.
        { ...bundleJson(l2), format: BUNDLE_FORMAT_BLOCKS },
        { ...bundleJson(), format: BUNDLE_FORMAT_L2 },
      ])
        expect(() => parse(bad)).toThrow(BundleError);
    });
  },
);
