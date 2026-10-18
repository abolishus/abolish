import { readFileSync } from "node:fs";

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { boardRows } from "../src/board.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

// The published cross-language vectors (docs/spec/vectors/board.json), never
// values computed by the code under test.
interface EntryVector {
  id: string;
  encoding: string;
  value?: { election_id: string; index: string; segment: string; payload: string };
  entryHash?: string;
}
interface BoardVector {
  id: string;
  electionId: string;
  entries: string[];
}
const file = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/board.json", import.meta.url), "utf8"),
) as { entries: EntryVector[]; boards: BoardVector[] };
const decodable = file.entries.filter((v) => v.value !== undefined);
const undecodable = file.entries.filter((v) => v.value === undefined);
const board = (id: string) => {
  const found = file.boards.find((b) => b.id === id);
  if (found === undefined) throw new Error(`no board vector ${id}`);
  return found;
};
const valid = board("valid");

const KIND_OF_TYPE: Record<string, string> = {
  "0002": "ballot",
  "0003": "spoiled-opening",
  "0005": "ceremony",
  "0006": "tally-opening",
  "0008": "contract-event",
};

describe("boardRows", () => {
  test("has vectors of both kinds", () => {
    expect(decodable.length).toBeGreaterThan(5);
    expect(undecodable.length).toBeGreaterThan(10);
  });

  test.each(decodable.map((v) => [v.id, v] as const))(
    "%s: shows the vector's position, period, kind and entry hash",
    (_, v) => {
      const value = v.value!; // `decodable` holds only vectors with a value
      const rows = boardRows(value.election_id, 1, BigInt(value.index), [v.encoding]);
      expect(rows).toEqual([
        {
          index: value.index,
          segment: Number(value.segment),
          kind: KIND_OF_TYPE[value.payload.slice(0, 4)],
          hash: v.entryHash,
        },
      ]);
    },
  );

  test.each(undecodable.map((v) => [v.id, v.encoding] as const))(
    "%s: refuses an entry that doesn't decode",
    (_, encoding) => {
      expect(boardRows(valid.electionId, 1, 0n, [encoding])).toBeUndefined();
    },
  );

  test("shows a valid board in order, and any page of it from its own start", () => {
    const rows = boardRows(valid.electionId, 1, 0n, valid.entries);
    expect(rows?.map((r) => r.index)).toEqual(valid.entries.map((_, i) => String(i)));
    const later = boardRows(valid.electionId, 1, 4n, valid.entries.slice(4));
    expect(later).toEqual(rows?.slice(4));
    expect(boardRows(valid.electionId, 1, 0n, [])).toEqual([]);
  });

  test("refuses a page that starts anywhere but where it was asked for (T-31)", () => {
    expect(boardRows(valid.electionId, 1, 3n, valid.entries.slice(4))).toBeUndefined();
    expect(boardRows(valid.electionId, 1, 1n, valid.entries)).toBeUndefined();
  });

  test.each(["wrong-election", "wrong-index", "segment-decreased", "entry-trailing-bytes"])(
    "refuses the %s board",
    (id) => {
      expect(boardRows(valid.electionId, 1, 0n, board(id).entries)).toBeUndefined();
    },
  );

  test("refuses entries served for another poll (T-31)", () => {
    expect(boardRows("ab".repeat(32), 1, 0n, valid.entries)).toBeUndefined();
  });

  test("refuses entries of a version other than the one the definition pins (T-34)", () => {
    expect(boardRows(valid.electionId, 5, 0n, valid.entries)).toBeUndefined();
  });

  test("never throws on arbitrary text, and shows nothing that isn't hex", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string(), { maxLength: 4 }),
        fc.bigInt({ min: 0n, max: 20n }),
        (entries, from) => {
          const rows = boardRows(valid.electionId, 1, from, entries);
          if (rows !== undefined) for (const e of entries) expect(e).toMatch(/^(?:[0-9a-f]{2})*$/);
        },
      ),
      runs,
    );
  });

  test("never throws on a mutated board, and shows only consecutive entries of this poll", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: valid.entries.length - 1 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (which, at, flip) => {
          const entries = [...valid.entries];
          const bytes = Buffer.from(entries[which]!, "hex");
          const i = at % bytes.length;
          bytes[i] = (bytes[i] ?? 0) ^ flip;
          entries[which] = bytes.toString("hex");
          const rows = boardRows(valid.electionId, 1, 0n, entries);
          if (rows === undefined) return;
          expect(rows.map((r) => r.index)).toEqual(entries.map((_, j) => String(j)));
          // A changed entry is a different entry: its hash is never the original's.
          const original = boardRows(valid.electionId, 1, 0n, valid.entries)!;
          expect(rows[which]?.hash).not.toBe(original[which]?.hash);
        },
      ),
      runs,
    );
  });
});
