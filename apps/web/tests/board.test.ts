import { readFileSync } from "node:fs";

import { encodeCheckpoint } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { anchorRows, boardRows } from "../src/board.ts";
import { fromHex, toHex } from "../src/values.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

// The published cross-language vectors (docs/spec/vectors/board.json), never
// values computed by the code under test.
interface EntryVector {
  id: string;
  encoding: string;
  value?: { election_id: string; index: string; segment: string; payload: string };
  entryHash?: string;
}
interface CheckpointVector {
  electionId: string;
  segment: string;
  size: string;
  head: string;
  root: string;
  objectCid: string;
  hashesCid: string;
  hash: string;
}
interface BoardVector {
  id: string;
  electionId: string;
  entries: string[];
  checkpoints: CheckpointVector[];
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

// The checkpoint's bytes are encoded here from the vector's fields; the hash
// each row shows is checked against the vector's own.
const encoded = (c: CheckpointVector, change: Partial<CheckpointVector> = {}) => {
  const v = { ...c, ...change };
  return toHex(
    encodeCheckpoint({
      election_id: fromHex(v.electionId),
      segment: Number(v.segment),
      size: BigInt(v.size),
      head: fromHex(v.head),
      root: fromHex(v.root),
      object_cid: fromHex(v.objectCid),
      hashes_cid: fromHex(v.hashesCid),
    }),
  );
};
const latestFirst = valid.checkpoints.toReversed();

describe("anchorRows (P2-19)", () => {
  test("shows each checkpoint's period, size, head and root, and the vector's hash", () => {
    expect(latestFirst.length).toBeGreaterThan(2);
    expect(
      anchorRows(
        valid.electionId,
        latestFirst.map((c) => encoded(c)),
      ),
    ).toEqual(
      latestFirst.map((c) => ({
        segment: Number(c.segment),
        size: c.size,
        head: c.head,
        root: c.root,
        hash: c.hash,
      })),
    );
    expect(anchorRows(valid.electionId, [])).toEqual([]);
  });

  test("refuses checkpoints served for another poll (T-31)", () => {
    expect(
      anchorRows(
        "00".repeat(32),
        latestFirst.map((c) => encoded(c)),
      ),
    ).toBeUndefined();
  });

  test("refuses checkpoints that aren't the latest first, or that shrink going forward (T-24)", () => {
    const [last, before] = latestFirst;
    expect(
      anchorRows(
        valid.electionId,
        valid.checkpoints.map((c) => encoded(c)),
      ),
    ).toBeUndefined();
    expect(anchorRows(valid.electionId, [encoded(last!), encoded(last!)])).toBeUndefined();
    // An earlier period holding more entries than a later one.
    expect(
      anchorRows(valid.electionId, [encoded(last!), encoded(before!, { size: "1000" })]),
    ).toBeUndefined();
    // As many is a re-anchor of a period that added nothing, and stands.
    expect(
      anchorRows(valid.electionId, [encoded(last!), encoded(before!, { size: last!.size })]),
    ).toHaveLength(2);
    expect(anchorRows(valid.electionId, [encoded(last!, { size: "0" })])).toBeUndefined();
  });

  test("refuses bytes that aren't a checkpoint", () => {
    const one = encoded(latestFirst[0]!);
    for (const bad of [one.slice(0, -2), `${one}00`, one.toUpperCase(), "zz", ""])
      expect(anchorRows(valid.electionId, [bad])).toBeUndefined();
  });

  test("never throws on a mutated checkpoint, and never shows one under the original's hash", () => {
    const list = latestFirst.map((c) => encoded(c));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: list.length - 1 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (which, at, flip) => {
          const bytes = fromHex(list[which]!);
          const i = at % bytes.length;
          bytes[i] = bytes[i]! ^ flip;
          const mutated = list.with(which, toHex(bytes));
          const rows = anchorRows(valid.electionId, mutated);
          if (rows !== undefined) expect(rows[which]!.hash).not.toBe(latestFirst[which]!.hash);
        },
      ),
      runs,
    );
  });
});
