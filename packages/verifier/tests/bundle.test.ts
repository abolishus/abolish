import { MAX_BOARD_PAYLOAD } from "@abolishus/crypto";
import fc from "fast-check";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT,
  BUNDLE_FORMAT_DEFINITION,
  BUNDLE_FORMAT_L1,
  BundleError,
  type LocalBundle,
  parseBundle,
  readBundle,
  splitEntries,
} from "../src/index.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IPropertyWithHooks<T> | fc.IProperty<T>) => fc.assert(p, { numRuns });

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const u32be = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const concat = (parts: readonly Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// An entry-shaped chunk: 47 fixed bytes, a u32 length, then that many bytes.
// The splitter reads lengths only, so the fixed bytes are arbitrary.
const chunk = fc
  .tuple(fc.uint8Array({ minLength: 47, maxLength: 47 }), fc.uint8Array({ maxLength: 300 }))
  .map(([fixed, payload]) => concat([fixed, u32be(payload.length), payload]));

describe("splitEntries", () => {
  test("splits a concatenation of entries back into exactly those entries", () => {
    run(
      fc.property(fc.array(chunk, { maxLength: 20 }), (entries) => {
        const split = splitEntries(concat(entries));
        expect(split.unreadableBytes).toBe(0);
        expect(split.entries.map(toHex)).toEqual(entries.map(toHex));
      }),
    );
  });

  test("leaves a tail too short for an entry unread, and counts it", () => {
    run(
      fc.property(
        fc.array(chunk, { maxLength: 10 }),
        fc.uint8Array({ maxLength: 50 }),
        (entries, tail) => {
          const split = splitEntries(concat([...entries, tail]));
          expect(split.entries.map(toHex)).toEqual(entries.map(toHex));
          expect(split.unreadableBytes).toBe(tail.length);
        },
      ),
    );
  });

  test("stops at a payload shorter than its length field", () => {
    run(
      fc.property(fc.array(chunk, { maxLength: 10 }), chunk, (entries, last) => {
        const cut = last.subarray(0, last.length - 1);
        const split = splitEntries(concat([...entries, cut]));
        expect(split.entries.map(toHex)).toEqual(entries.map(toHex));
        expect(split.unreadableBytes).toBe(cut.length);
      }),
    );
  });

  test("splits an entry whose length is over MAX_BOARD_PAYLOAD, leaving 4.1 to reject it", () => {
    const fixed = new Uint8Array(47);
    const over = concat([
      fixed,
      u32be(MAX_BOARD_PAYLOAD + 1),
      new Uint8Array(MAX_BOARD_PAYLOAD + 1),
    ]);
    const split = splitEntries(over);
    expect(split.unreadableBytes).toBe(0);
    expect(split.entries.map((e) => e.length)).toEqual([over.length]);
  });

  test("returns entries that don't alias the input", () => {
    const board = concat([new Uint8Array(47), u32be(1), Uint8Array.of(9)]);
    const [entry] = splitEntries(board).entries;
    board[0] = 1;
    expect(entry?.[0]).toBe(0);
  });
});

const ID = "ab".repeat(32);
const valid = () => ({
  format: "abolish-verifier-bundle/1",
  electionId: ID,
  boardEntryVersion: 1,
  clock: { epoch: "1800000000", period: "3600", deadline: "7200", lastSegment: "6" },
  now: "1800032401",
  anchors: [
    {
      electionId: ID,
      segment: "0",
      size: "2",
      head: "cd".repeat(32),
      root: "ef".repeat(32),
      anchoredAt: "1800003660",
    },
  ],
});
type Mutable = Record<string, unknown> & {
  clock: Record<string, unknown>;
  anchors: Record<string, unknown>[];
};
const parse = (o: unknown): LocalBundle => {
  const b = parseBundle(JSON.stringify(o), new Uint8Array());
  if (b.format !== BUNDLE_FORMAT) throw new Error("expected a format-1 bundle");
  return b;
};

describe("parseBundle", () => {
  test("reads a valid bundle", () => {
    const b = parse(valid());
    expect(b.electionId).toEqual(Uint8Array.from(Buffer.from(ID, "hex")));
    expect(b.clock).toEqual({ epoch: 1800000000n, period: 3600n, deadline: 7200n, lastSegment: 6 });
    expect(b.now).toBe(1800032401n);
    expect(b.anchors).toEqual([
      {
        checkpoint: {
          election_id: Uint8Array.from(Buffer.from(ID, "hex")),
          segment: 0,
          size: 2n,
          head: Uint8Array.from(Buffer.from("cd".repeat(32), "hex")),
          root: Uint8Array.from(Buffer.from("ef".repeat(32), "hex")),
        },
        anchoredAt: 1800003660n,
      },
    ]);
    expect(Object.values(b.sources)).toEqual(Array(5).fill("local-file"));
  });

  test("round-trips every in-range value", () => {
    const u64 = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });
    const u32 = fc.integer({ min: 0, max: 2 ** 32 - 1 });
    const b32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
    run(
      fc.property(
        b32,
        u64,
        u64.filter((n) => n > 0n),
        u64,
        u32,
        u64,
        fc.array(fc.tuple(b32, u32, u64, b32, b32, u64), { maxLength: 4 }),
        (id, epoch, period, deadline, lastSegment, now, anchors) => {
          const b = parse({
            format: "abolish-verifier-bundle/1",
            electionId: toHex(id),
            boardEntryVersion: 1,
            clock: {
              epoch: `${epoch}`,
              period: `${period}`,
              deadline: `${deadline}`,
              lastSegment: `${lastSegment}`,
            },
            now: `${now}`,
            anchors: anchors.map(([e, segment, size, head, root, at]) => ({
              electionId: toHex(e),
              segment: `${segment}`,
              size: `${size}`,
              head: toHex(head),
              root: toHex(root),
              anchoredAt: `${at}`,
            })),
          });
          expect(b.electionId).toEqual(id);
          expect(b.clock).toEqual({ epoch, period, deadline, lastSegment });
          expect(b.now).toBe(now);
          expect(
            b.anchors.map((a) => [
              a.checkpoint.election_id,
              a.checkpoint.segment,
              a.checkpoint.size,
              a.checkpoint.head,
              a.checkpoint.root,
              a.anchoredAt,
            ]),
          ).toEqual(anchors);
        },
      ),
    );
  });

  // Each mutation makes the bundle malformed; none may be read as a value.
  const rejected: [string, (o: Mutable) => unknown][] = [
    ["an unknown member", (o) => ({ ...o, extra: 1 })],
    ["a missing member", ({ now: _now, ...o }) => o],
    ["an unknown format", (o) => ({ ...o, format: "abolish-verifier-bundle/3" })],
    [
      "format 2's members under format 1",
      ({ now: _now, anchors: _anchors, ...o }) => ({ ...o, l1: {} }),
    ],
    ["format 1's members under format 2", (o) => ({ ...o, format: "abolish-verifier-bundle/2" })],
    ["a board-entry version as a string", (o) => ({ ...o, boardEntryVersion: "1" })],
    ["a board-entry version other than 1", (o) => ({ ...o, boardEntryVersion: 2 })],
    ["uppercase hex", (o) => ({ ...o, electionId: ID.toUpperCase() })],
    ["short hex", (o) => ({ ...o, electionId: ID.slice(2) })],
    ["a 0x prefix", (o) => ({ ...o, electionId: `0x${ID.slice(2)}` })],
    ["a leading zero", (o) => ({ ...o, now: "01800032401" })],
    ["a sign", (o) => ({ ...o, now: "+1800032401" })],
    ["a number for an integer", (o) => ({ ...o, now: 1800032401 })],
    ["an empty integer", (o) => ({ ...o, now: "" })],
    ["a u64 over 2^64 - 1", (o) => ({ ...o, now: `${2n ** 64n}` })],
    ["a period of 0", (o) => ({ ...o, clock: { ...o.clock, period: "0" } })],
    [
      "a u32 lastSegment over 2^32 - 1",
      (o) => ({ ...o, clock: { ...o.clock, lastSegment: `${2 ** 32}` } }),
    ],
    ["an unknown clock member", (o) => ({ ...o, clock: { ...o.clock, offset: "0" } })],
    ["anchors that aren't an array", (o) => ({ ...o, anchors: {} })],
    ["an anchor that isn't an object", (o) => ({ ...o, anchors: [[]] })],
    [
      "an anchor segment over 2^32 - 1",
      (o) => ({ ...o, anchors: [{ ...o.anchors[0], segment: `${2 ** 32}` }] }),
    ],
    [
      "an anchor with an unknown member",
      (o) => ({ ...o, anchors: [{ ...o.anchors[0], hash: ID }] }),
    ],
    [
      "an anchor missing its time",
      (o) => ({ ...o, anchors: [{ ...o.anchors[0], anchoredAt: undefined }] }),
    ],
    ["a __proto__ member", (o) => JSON.parse(`{"__proto__":{},${JSON.stringify(o).slice(1)}`)],
    ["an array", () => []],
    ["null", () => null],
  ];
  for (const [what, mutate] of rejected)
    test(`rejects ${what}`, () => {
      expect(() => parse(mutate(valid() as Mutable))).toThrow(BundleError);
    });

  test("accepts the same member name in different objects", () => {
    const o = valid();
    const b = parse({ ...o, anchors: [o.anchors[0], { ...o.anchors[0], segment: "1" }] });
    expect(b.anchors.length).toBe(2);
  });

  const text = JSON.stringify(valid());
  const duplicated: [string, string][] = [
    ["at the top level", text.replace('"now":', '"now":"1","now":')],
    ["in the clock", text.replace('"epoch":', '"epoch":"1","epoch":')],
    ["in an anchor", text.replace('"size":', '"size":"9","size":')],
    ["spelt with an escape", text.replace('"now":', '"n\\u006fw":"1","now":')],
  ];
  for (const [where, json] of duplicated)
    test(`rejects a duplicate member ${where}`, () => {
      expect(json).not.toBe(text);
      expect(() => parseBundle(json, new Uint8Array())).toThrow(/duplicate member/);
    });

  test("rejects text that isn't JSON", () => {
    expect(() => parseBundle("{", new Uint8Array())).toThrow(BundleError);
  });
});

describe("readBundle", () => {
  const withDir = (files: Record<string, Uint8Array | string>, f: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "verifier-bundle-"));
    try {
      for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      f(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("reads bundle.json and board.bin", () => {
    const board = concat([new Uint8Array(47), u32be(1), Uint8Array.of(9), Uint8Array.of(1, 2)]);
    withDir({ "bundle.json": JSON.stringify(valid()), "board.bin": board }, (dir) => {
      const b = readBundle(dir);
      expect(b.entries.length).toBe(1);
      expect(b.unreadableBytes).toBe(2);
    });
  });

  test("rejects a bundle.json that isn't UTF-8 instead of replacing bytes", () => {
    // Replaced with U+FFFD, the stray byte would surface as a JSON error instead.
    const json = Buffer.concat([Buffer.from(JSON.stringify(valid())), Buffer.of(0xff)]);
    withDir({ "bundle.json": json, "board.bin": new Uint8Array() }, (dir) => {
      expect(() => readBundle(dir)).toThrow(/not UTF-8/);
    });
  });

  test("rejects a byte-order mark", () => {
    const json = Buffer.concat([Buffer.of(0xef, 0xbb, 0xbf), Buffer.from(JSON.stringify(valid()))]);
    withDir({ "bundle.json": json, "board.bin": new Uint8Array() }, (dir) => {
      expect(() => readBundle(dir)).toThrow(BundleError);
    });
  });

  test("rejects a bundle with a file missing, rather than reading it as an empty copy", () => {
    withDir({ "bundle.json": JSON.stringify(valid()) }, (dir) => {
      expect(() => readBundle(dir)).toThrow(/board\.bin: can't be read/);
    });
    withDir({ "board.bin": new Uint8Array() }, (dir) => {
      expect(() => readBundle(dir)).toThrow(/bundle\.json: can't be read/);
    });
  });
});

// Format 2, from the `closed` vector of docs/spec/vectors/l1-anchor.json.
const l1File = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/l1-anchor.json", import.meta.url), "utf8"),
) as {
  readonly clock: Record<string, string>;
  readonly electionId: string;
  readonly vectors: readonly {
    readonly id: string;
    readonly anchor: string;
    readonly block: { readonly header: string };
    readonly nodes: readonly string[];
  }[];
};
const closed = l1File.vectors.find((v) => v.id === "closed");
if (closed === undefined) throw new Error("no closed vector");
const CHECKPOINT = `${l1File.electionId}${"00".repeat(76)}`;
const validL1 = () => ({
  format: "abolish-verifier-bundle/2",
  electionId: l1File.electionId,
  boardEntryVersion: 1,
  clock: l1File.clock,
  l1: {
    anchor: closed.anchor,
    firstSegment: "0",
    header: closed.block.header,
    nodes: [...closed.nodes],
    checkpoints: [CHECKPOINT],
  },
});
type L1Shape = ReturnType<typeof validL1>["l1"];
const withL1 = (l1: unknown) => ({ ...validL1(), l1 });
const parseL1 = (o: unknown) => parseBundle(JSON.stringify(o), new Uint8Array());

describe("parseBundle, format 2", () => {
  test("reads a valid bundle and its L1 evidence", () => {
    const b = parseL1(validL1());
    if (b.format !== BUNDLE_FORMAT_L1) throw new Error("expected format 2");
    expect(b.l1.header.timestamp).toBe(1800032401n);
    expect(toHex(b.l1.anchor)).toBe(closed.anchor);
    expect(b.l1.firstSegment).toBe(0);
    expect(b.l1.checkpoints.length).toBe(1);
    expect(b.sources).toEqual({
      electionId: "local-file",
      boardEntryVersion: "local-file",
      clock: "local-file",
      now: "l1-state-proof",
      anchors: "l1-state-proof",
      l1Header: "local-file",
      anchorAddress: "local-file",
      firstSegment: "local-file",
    });
  });

  const header = closed.block.header;
  const rejected: [string, (l: L1Shape) => unknown][] = [
    ["an unknown l1 member", (l) => ({ ...l, extra: [] })],
    ["a missing l1 member", ({ checkpoints: _c, ...l }) => l],
    ["an anchor of 19 bytes", (l) => ({ ...l, anchor: l.anchor.slice(2) })],
    ["an anchor of 21 bytes", (l) => ({ ...l, anchor: `${l.anchor}00` })],
    ["an uppercase anchor", (l) => ({ ...l, anchor: l.anchor.toUpperCase() })],
    ["a first segment with a leading zero", (l) => ({ ...l, firstSegment: "01" })],
    ["a first segment of 2^32", (l) => ({ ...l, firstSegment: `${2 ** 32}` })],
    ["a first segment as a number", (l) => ({ ...l, firstSegment: 0 })],
    ["an empty header", (l) => ({ ...l, header: "" })],
    ["a header of odd length", (l) => ({ ...l, header: header.slice(1) })],
    ["a header that isn't RLP", (l) => ({ ...l, header: `${header}00` })],
    ["a header that is RLP but not a header", (l) => ({ ...l, header: "c0" })],
    ["nodes that aren't an array", (l) => ({ ...l, nodes: {} })],
    ["an empty node", (l) => ({ ...l, nodes: [...l.nodes, ""] })],
    ["an uppercase node", (l) => ({ ...l, nodes: [(l.nodes[0] as string).toUpperCase()] })],
    ["a node that isn't a string", (l) => ({ ...l, nodes: [1] })],
    ["checkpoints that aren't an array", (l) => ({ ...l, checkpoints: "" })],
    ["a checkpoint of 107 bytes", (l) => ({ ...l, checkpoints: [CHECKPOINT.slice(2)] })],
    ["a checkpoint of 109 bytes", (l) => ({ ...l, checkpoints: [`${CHECKPOINT}00`] })],
    ["l1 that isn't an object", () => []],
  ];
  for (const [what, mutate] of rejected)
    test(`rejects ${what}`, () => {
      expect(() => parseL1(withL1(mutate(validL1().l1)))).toThrow(BundleError);
    });

  test("rejects a bundle with any l1 member replaced by a value of another shape", () => {
    const keys = Object.keys(validL1().l1);
    run(
      fc.property(
        fc.constantFrom(...keys),
        fc.oneof(fc.integer(), fc.boolean(), fc.constant(null), fc.object(), fc.string()),
        (key, value) => {
          const l = { ...validL1().l1, [key]: value };
          fc.pre(JSON.stringify(l) !== JSON.stringify(validL1().l1));
          // A string that happens to be valid for its member is no mutation.
          let ok = true;
          try {
            parseL1(withL1(l));
          } catch (e) {
            if (!(e instanceof BundleError)) throw e;
            ok = false;
          }
          if (ok) expect(typeof value).toBe("string");
        },
      ),
    );
  });
});

// Format 3: format 2 with the election identifier, version and anchor
// address replaced by the definition. Its bytes are held, not decoded, here.
const validDefinition = () => {
  const { electionId: _e, boardEntryVersion: _v, ...rest } = validL1();
  const { anchor: _a, ...l1 } = rest.l1;
  return { ...rest, format: "abolish-verifier-bundle/3", definition: "0001", l1 };
};

describe("parseBundle, format 3", () => {
  test("reads a valid bundle, holding the definition as bytes", () => {
    const b = parseL1(validDefinition());
    if (b.format !== BUNDLE_FORMAT_DEFINITION) throw new Error("expected format 3");
    expect(toHex(b.definition)).toBe("0001");
    expect("anchor" in b.l1).toBe(false);
    expect(b.l1.firstSegment).toBe(0);
    expect(b.sources).toEqual({
      electionId: "definition",
      boardEntryVersion: "definition",
      clock: "local-file",
      now: "l1-state-proof",
      anchors: "l1-state-proof",
      l1Header: "local-file",
      anchorAddress: "definition",
      firstSegment: "local-file",
      definition: "local-file",
    });
  });

  type Shape = ReturnType<typeof validDefinition>;
  const rejected: [string, (o: Shape) => unknown][] = [
    // The definition is the only source of these: a second one could disagree.
    ["an election identifier", (o) => ({ ...o, electionId: l1File.electionId })],
    ["a board-entry version", (o) => ({ ...o, boardEntryVersion: 1 })],
    ["an anchor address", (o) => ({ ...o, l1: { ...o.l1, anchor: closed.anchor } })],
    ["now and anchors", (o) => ({ ...o, now: "0", anchors: [] })],
    ["a missing definition", ({ definition: _d, ...o }) => o],
    ["an empty definition", (o) => ({ ...o, definition: "" })],
    ["a definition of odd length", (o) => ({ ...o, definition: "000" })],
    ["an uppercase definition", (o) => ({ ...o, definition: "0A" })],
    ["a definition that isn't a string", (o) => ({ ...o, definition: [0, 1] })],
    ["a missing l1", ({ l1: _l, ...o }) => o],
    ["a malformed header", (o) => ({ ...o, l1: { ...o.l1, header: "c0" } })],
    ["a missing clock", ({ clock: _c, ...o }) => o],
  ];
  for (const [what, mutate] of rejected)
    test(`rejects ${what}`, () => {
      expect(() => parseL1(mutate(validDefinition()))).toThrow(BundleError);
    });
});
