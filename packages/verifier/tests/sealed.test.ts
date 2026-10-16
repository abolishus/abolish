import { readFileSync } from "node:fs";
import {
  decodeBoardEntry,
  encodeBoardEntry,
  encodeDestructionStatement,
  type BoardEntryVersion,
  signDestructionStatement,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_BLOCKS,
  type CheckResult,
  parseBundle,
  type Report,
  splitEntries,
  verifyBundle,
} from "../src/index.ts";
import { decodeDefinition } from "../src/definition.ts";
import { run, toHex } from "./headers.ts";
import { anchoredL1 } from "./state.ts";

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

function bundle(entries: readonly Uint8Array[]): Report {
  const l1 = anchoredL1(definition.election_id, definition.l1_anchor, entries, VERSION, clock, {
    number: 20_000_000n,
    timestamp: NOW,
  });
  return verifyBundle(
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

  test("the profile pins board-entry version 5 and contract-event version 5, so 2.3 doesn't fail", () => {
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
