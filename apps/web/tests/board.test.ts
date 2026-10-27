import { readFileSync } from "node:fs";

import { encodeCheckpoint } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { activityBars, type AnchorRow, anchorRows, boardRows, oneHistory } from "../src/board.ts";
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
interface ConsistencyVector {
  size1: string;
  size2: string;
  path: string[];
}
interface RejectedVector {
  id: string;
  kind: string;
  size1?: string;
  size2?: string;
  root1?: string;
  root2?: string;
  path: string[];
}
const file = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/board.json", import.meta.url), "utf8"),
) as {
  entries: EntryVector[];
  boards: BoardVector[];
  tree: { roots: string[]; consistency: ConsistencyVector[]; rejected: RejectedVector[] };
};
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

describe("activityBars", () => {
  const anchor = (segment: number, size: bigint): AnchorRow => ({
    segment,
    size: size.toString(),
    head: "00".repeat(32),
    root: "00".repeat(32),
    hash: "00".repeat(32),
  });

  test("counts each period's entries from the checkpoint before it, earliest first", () => {
    const anchors = [anchor(9, 12n), anchor(7, 12n), anchor(4, 10n), anchor(1, 3n)];
    expect(activityBars(anchors, 6)).toEqual([
      { segment: 1, added: "3" },
      { segment: 4, added: "7" },
      { segment: 7, added: "2" },
      { segment: 9, added: "0" },
    ]);
  });

  test("leaves out the earliest when as many came back as were asked for", () => {
    const anchors = [anchor(9, 12n), anchor(4, 10n), anchor(1, 3n)];
    expect(activityBars(anchors, 3)).toEqual([
      { segment: 4, added: "7" },
      { segment: 9, added: "2" },
    ]);
    expect(activityBars([anchor(1, 3n)], 1)).toEqual([]);
    expect(activityBars([], 6)).toEqual([]);
  });

  test("the counts add up to the latest size less the earliest one kept out", () => {
    const sizes = fc.array(fc.bigInt({ min: 1n, max: 2n ** 64n - 1n }), {
      minLength: 1,
      maxLength: 30,
    });
    fc.assert(
      fc.property(sizes, fc.integer({ min: 1, max: 32 }), (raw, asked) => {
        // Latest first: segments falling, sizes never growing back in time.
        const desc = [...raw].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
        const anchors = desc.map((size, i) => anchor(1000 - i, size));
        const bars = activityBars(anchors, asked);
        const whole = anchors.length < asked;
        expect(bars.length).toBe(whole ? anchors.length : anchors.length - 1);
        const total = bars.reduce((sum, bar) => sum + BigInt(bar.added), 0n);
        const floor = whole ? 0n : BigInt(anchors.at(-1)?.size ?? "0");
        expect(total).toBe(BigInt(anchors[0]?.size ?? "0") - floor);
        for (const [i, bar] of bars.entries()) {
          expect(BigInt(bar.added) >= 0n).toBe(true);
          if (i > 0) expect(bar.segment > (bars[i - 1]?.segment ?? -1)).toBe(true);
        }
      }),
      runs,
    );
  });
});

describe("oneHistory", () => {
  const { roots, consistency, rejected } = file.tree;
  // `roots[n - 1]` is the root of the vectors' tree of its first n leaves.
  const tree = (size: string) => ({ size, root: roots[Number(size) - 1]! });

  test("holds for every published consistency proof", () => {
    expect(consistency.length).toBeGreaterThan(50);
    for (const v of consistency)
      expect(oneHistory(tree(v.size1), tree(v.size2), v.path)).toBe(true);
  });

  test("fails every published rejected consistency proof", () => {
    const refused = rejected.filter((v) => v.kind === "consistency");
    expect(refused.length).toBeGreaterThan(5);
    for (const v of refused)
      expect(
        oneHistory({ size: v.size1!, root: v.root1! }, { size: v.size2!, root: v.root2! }, v.path),
        v.id,
      ).toBe(false);
  });

  test("fails a proof read the wrong way round, or a malformed claim", () => {
    const v = consistency.find((c) => c.size1 === "3" && c.size2 === "7")!;
    expect(oneHistory(tree("7"), tree("3"), v.path)).toBe(false);
    expect(oneHistory({ size: "3", root: "zz" }, tree("7"), v.path)).toBe(false);
    expect(oneHistory(tree("3"), tree("7"), [...v.path.slice(1), "0g".repeat(32)])).toBe(false);
  });

  test("fails a proof with any byte of a root or hash changed", () => {
    const proper = consistency.filter((c) => c.size1 !== c.size2);
    fc.assert(
      fc.property(
        fc.constantFrom(...proper),
        fc.nat(),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 1, max: 255 }),
        (v, which, at, flip) => {
          const earlier = tree(v.size1);
          const later = tree(v.size2);
          const parts = [earlier.root, later.root, ...v.path];
          const i = which % parts.length;
          const bytes = fromHex(parts[i]!);
          bytes[at % 32]! ^= flip;
          parts[i] = toHex(bytes);
          const [root1, root2, ...path] = parts;
          expect(oneHistory({ ...earlier, root: root1! }, { ...later, root: root2! }, path)).toBe(
            false,
          );
        },
      ),
      runs,
    );
  });

  test("equal sizes are one history only with equal roots and no path", () => {
    expect(oneHistory(tree("5"), tree("5"), [])).toBe(true);
    expect(oneHistory(tree("5"), { size: "5", root: roots[5]! }, [])).toBe(false);
    expect(oneHistory(tree("5"), tree("5"), [roots[0]!])).toBe(false);
  });
});
