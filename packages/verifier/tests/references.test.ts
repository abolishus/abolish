import { readFileSync } from "node:fs";
import { L1_REF_MARGIN } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_BLOCKS,
  BUNDLE_FORMAT_CEREMONY,
  BundleError,
  type CheckResult,
  decodeHeader,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";
import { referenceJudge } from "../src/references.ts";
import { header, run, type TestHeader, toHex } from "./headers.ts";

// Format-5 bundles: ballot admission with 5.8, each ballot's L1 reference
// judged against the bundle's run of finalized L1 headers before repeats
// (docs/spec/verifier.md, L1 references; docs/spec/revoting.md, Admission).
// Ballots: docs/spec/vectors/verifier-ballots.json (an independent Python
// implementation, with snarkjs's verdict on every membership proof). Their
// references name random hashes, so no run here holds a block one of them
// names: a run is placed around their numbers to reach every rejection and
// pending, and the admitted path is checked on the reference judge itself.
// Headers come from a reference RLP encoder (headers.ts).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly ballots?: Report["ballots"];
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
const l1 = {
  firstSegment: closed.firstSegment,
  header: closed.block.header,
  nodes: closed.nodes,
  checkpoints: closed.checkpoints,
};

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// Every case's definition opens and closes at these times; the admitted
// ballots of `admitted` name blocks 21033826 (entry 1), 21011130 (entry 2)
// and 21033260 (entry 3), and `mixed` adds a copy of entry 1's at entry 14.
const OPENS = 1_767_225_600n;
const CLOSES = 1_767_830_400n;
const START = OPENS - L1_REF_MARGIN;

const bundleJson = (c: Case, blocks: readonly unknown[] | undefined) =>
  JSON.stringify({
    format: blocks === undefined ? BUNDLE_FORMAT_CEREMONY : BUNDLE_FORMAT_BLOCKS,
    definition: c.definition,
    clock: file.clock,
    l1,
    panel: file.panels[c.panel],
    ...(blocks !== undefined && { l1Blocks: blocks }),
  });
const blocksOf = (headers: readonly TestHeader[]) => headers.map((h) => toHex(h.encoded));
const verify = (c: Case, headers: readonly TestHeader[]) =>
  verifyBundle(parseBundle(bundleJson(c, blocksOf(headers)), hex(c.board)));

const row = (r: Report, id: string) => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};

// Each test verifies a whole board, at about a second a run on CI's shared runner.
describe("5.8 over the vectors' admitted ballots", { timeout: 30_000 }, () => {
  const admitted = byId("admitted");

  test("a window starting after every named block rejects each l1-ref-before-open, by number alone", () => {
    const r = verify(admitted, run(22_000_000n, [START - 12n, START]));
    expect(row(r, "5.8")).toEqual({ status: "fail", code: "l1-ref-before-open", at: { entry: 1 } });
    expect(r.ballots).toEqual({
      admitted: 0,
      rejected: [1, 2, 3].map((entry) => ({ entry, code: "l1-ref-before-open" })),
      repeats: [],
      pending: [],
    });
    // An admission check that rejects entries never fails the election.
    expect(r.verdictAgainstInputs).not.toBe("failed");
  });

  test("a head after close rejects every reference beyond it l1-ref-after-close", () => {
    const r = verify(admitted, run(21_000_000n, [START - 12n, CLOSES + 12n]));
    expect(row(r, "5.8")).toEqual({ status: "fail", code: "l1-ref-after-close", at: { entry: 1 } });
    expect(r.ballots?.rejected).toEqual(
      [1, 2, 3].map((entry) => ({ entry, code: "l1-ref-after-close" })),
    );
    expect(r.ballots?.pending).toEqual([]);
  });

  test("a head at or before close leaves references beyond it pending, so 5.8 is unverifiable", () => {
    for (const head of [OPENS, CLOSES]) {
      const r = verify(admitted, run(21_000_000n, [START - 12n, head]));
      expect(row(r, "5.8")).toEqual({
        status: "unverifiable",
        code: "l1-ref-pending",
        at: { entry: 1 },
      });
      expect(r.ballots).toEqual({
        admitted: 0,
        rejected: [],
        repeats: [],
        pending: [{ entry: 1 }, { entry: 2 }, { entry: 3 }],
      });
      expect(r.verdictAgainstInputs).toBe("unverifiable");
    }
  });

  test("a head before the window leaves every reference pending", () => {
    const r = verify(admitted, run(22_000_000n, [START - 24n, START - 12n]));
    expect(row(r, "5.8")).toEqual({
      status: "unverifiable",
      code: "l1-ref-pending",
      at: { entry: 1 },
    });
    expect(r.ballots?.pending).toEqual([{ entry: 1 }, { entry: 2 }, { entry: 3 }]);
  });

  test("a finalized block with another hash rejects l1-ref-unknown, beside the head's verdicts", () => {
    // Block 21011130, which entry 2 names, inside the window; then a head
    // after close, and then none.
    const window = [START - 12n, OPENS];
    const r = verify(admitted, run(21_011_129n, [...window, CLOSES + 1n]));
    expect(row(r, "5.8")).toEqual({ status: "fail", code: "l1-ref-after-close", at: { entry: 1 } });
    expect(r.ballots?.rejected).toEqual([
      { entry: 1, code: "l1-ref-after-close" },
      { entry: 2, code: "l1-ref-unknown" },
      { entry: 3, code: "l1-ref-after-close" },
    ]);
    const open = verify(admitted, run(21_011_129n, window));
    expect(row(open, "5.8")).toEqual({
      status: "unverifiable",
      code: "l1-ref-pending",
      at: { entry: 1 },
    });
    expect(open.ballots?.rejected).toEqual([{ entry: 2, code: "l1-ref-unknown" }]);
    expect(open.ballots?.pending).toEqual([{ entry: 1 }, { entry: 3 }]);
  });

  test("a block after close at or below the head rejects the reference by its time, not its hash", () => {
    const r = verify(admitted, run(21_011_129n, [START - 12n, CLOSES + 1n, CLOSES + 13n]));
    expect(r.ballots?.rejected).toEqual(
      [1, 2, 3].map((entry) => ({ entry, code: "l1-ref-after-close" })),
    );
  });

  test("a run starting inside the window is too short to place l1_ref_min, unless it starts at block 0", () => {
    for (const first of [START, START + 1n, OPENS]) {
      const r = verify(admitted, run(21_000_000n, [first, CLOSES + 1n]));
      expect(row(r, "5.8")).toEqual({ status: "unverifiable", code: "l1-blocks-short", at: {} });
      // The other rows and the report are as without 5.8.
      expect(r.ballots).toEqual({ admitted: 3, rejected: [], repeats: [] });
      expect(row(r, "5.7")).toEqual({ status: "pass" });
    }
    const genesis = verify(admitted, run(0n, [OPENS, CLOSES + 1n]));
    expect(row(genesis, "5.8")).toEqual({
      status: "fail",
      code: "l1-ref-after-close",
      at: { entry: 1 },
    });
  });

  test("the block before the window's start is enough: one second earlier is", () => {
    const r = verify(admitted, run(21_000_000n, [START - 1n, CLOSES + 1n]));
    expect(row(r, "5.8")).toEqual({ status: "fail", code: "l1-ref-after-close", at: { entry: 1 } });
  });
});

describe("5.8 runs before 5.7", { timeout: 30_000 }, () => {
  const mixed = byId("mixed");

  test("a copy of a rejected reference is rejected by 5.8, never as a repeat", () => {
    const r = verify(mixed, run(22_000_000n, [START - 12n, START]));
    expect(row(r, "5.7")).toEqual({ status: "pass" });
    expect(r.ballots?.rejected.filter((x) => x.entry === 14)).toEqual([
      { entry: 14, code: "l1-ref-before-open" },
    ]);
    expect(r.ballots?.admitted).toBe(0);
  });

  test("a copy of a pending ballot is a repeat, and only the first copy waits", () => {
    const r = verify(mixed, run(21_000_000n, [START - 12n, OPENS]));
    expect(row(r, "5.7")).toEqual({ status: "fail", code: "repeat", at: { entry: 14 } });
    expect(r.ballots?.pending).toEqual([{ entry: 1 }, { entry: 2 }, { entry: 13 }]);
    expect(r.ballots?.admitted).toBe(0);
    // The rows 5.1 to 5.5 are format 4's.
    const format4 = verifyBundle(parseBundle(bundleJson(mixed, undefined), hex(mixed.board)));
    for (const id of ["5.1", "5.2", "5.3", "5.4", "5.5", "5.7"])
      expect(row(r, id)).toEqual(row(format4, id));
  });
});

describe("5.8's row where admission doesn't judge references", () => {
  const blocks = run(22_000_000n, [START - 12n, START]);

  test("no ballots: 5.8 passes on a run that places l1_ref_min, and is unverifiable on a short one", () => {
    const none = byId("no-ballots");
    expect(row(verify(none, blocks), "5.8")).toEqual({ status: "pass" });
    expect(verify(none, blocks).ballots?.pending).toEqual([]);
    expect(row(verify(none, run(22_000_000n, [START])), "5.8")).toEqual({
      status: "unverifiable",
      code: "l1-blocks-short",
      at: {},
    });
  });

  test("no registered key set: 5.8 is not reached", () => {
    expect(row(verify(byId("quorum"), blocks), "5.8")).toEqual({
      status: "unverifiable",
      code: "not-reached",
    });
  });

  test("a contract-event version this release doesn't read: 5.8 is unsupported, like 5.5 and 5.7", () => {
    const r = verify(byId("events-unread"), blocks);
    expect(row(r, "5.8")).toEqual(row(r, "5.5"));
    expect(row(r, "5.8")).toEqual({ status: "unverifiable", code: "unsupported-version", at: {} });
    expect(r.ballots?.pending).toBeUndefined();
  });

  test("format 4 leaves 5.8 not implemented and lists no pending ballots", () => {
    const c = byId("admitted");
    const r = verifyBundle(parseBundle(bundleJson(c, undefined), hex(c.board)));
    expect(row(r, "5.8")).toEqual({ status: "unverifiable", code: "not-implemented" });
    expect(r.ballots).toEqual({ admitted: 3, rejected: [], repeats: [] });
  });

  test("a definition that stops the board checks leaves 5.8 not reached", () => {
    const c = byId("admitted");
    const r = verifyBundle(
      parseBundle(bundleJson({ ...c, definition: "00" }, blocksOf(blocks)), hex(c.board)),
    );
    expect(row(r, "5.8")).toEqual({ status: "unverifiable", code: "not-reached" });
  });

  test("the run is a local input: the inputs list it, and the verdict stays unverifiable", () => {
    const r = verify(byId("admitted"), blocks);
    expect(r.inputs.l1Blocks).toBe("local-file");
    expect(Object.keys(r.inputs).at(-1)).toBe("l1Blocks");
    expect(r.verdict).toBe("unverifiable");
  });
});

describe("the reference judge", () => {
  // The spec's steps (revoting.md, Admission) over a run, by a linear scan.
  function model(
    blocks: readonly TestHeader[],
    ref: { readonly l1RefNumber: bigint; readonly l1RefHash: Uint8Array },
    opensAt: bigint,
    closesAt: bigint,
  ): string {
    const threshold = opensAt > L1_REF_MARGIN ? opensAt - L1_REF_MARGIN : 0n;
    const first = blocks[0] as TestHeader;
    const head = blocks.at(-1) as TestHeader;
    if (first.number !== 0n && first.timestamp >= threshold) return "l1-blocks-short";
    const min = blocks.find((b) => b.timestamp >= threshold);
    if (min === undefined) return "pending";
    if (ref.l1RefNumber < min.number) return "l1-ref-before-open";
    const b = blocks.find(
      (x) => x.number === (ref.l1RefNumber < head.number ? ref.l1RefNumber : head.number),
    ) as TestHeader;
    if (b.timestamp > closesAt) return "l1-ref-after-close";
    if (ref.l1RefNumber > head.number) return "pending";
    return toHex(b.hash) === toHex(ref.l1RefHash) ? "admitted" : "l1-ref-unknown";
  }

  test("admits a reference naming a block of the run, by number and hash", () => {
    const blocks = run(100n, [START - 12n, OPENS, OPENS + 12n, CLOSES + 1n]);
    const judge = referenceJudge(
      blocks.map((b) => decodeHeader(b.encoded)),
      OPENS,
      CLOSES,
    );
    if (typeof judge !== "function") throw new Error("short");
    for (const b of blocks.slice(1, 3))
      expect(judge({ l1RefNumber: b.number, l1RefHash: b.hash })).toBe("admitted");
    const second = blocks[2] as TestHeader;
    expect(judge({ l1RefNumber: second.number, l1RefHash: (blocks[1] as TestHeader).hash })).toBe(
      "l1-ref-unknown",
    );
  });

  test("agrees with the spec's steps on any run and reference", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 50n }),
        fc.array(fc.bigInt({ min: 1n, max: 30n }), { minLength: 1, maxLength: 12 }),
        fc.bigInt({ min: 0n, max: 400n }),
        fc.bigInt({ min: 1n, max: 200n }),
        fc.bigInt({ min: 0n, max: 80n }),
        fc.boolean(),
        (first, gaps, base, length, refNumber, ownHash) => {
          let t = base;
          const blocks = run(
            first,
            gaps.map((g) => (t += g)),
          );
          // Times around the margin, so the window starts inside or around the run.
          const opensAt = base + L1_REF_MARGIN + length;
          const closesAt = opensAt + length;
          const named = blocks.find((b) => b.number === refNumber);
          const ref = {
            l1RefNumber: refNumber,
            l1RefHash: ownHash && named !== undefined ? named.hash : new Uint8Array(32).fill(7),
          };
          const judge = referenceJudge(
            blocks.map((b) => decodeHeader(b.encoded)),
            opensAt,
            closesAt,
          );
          const got = typeof judge === "function" ? judge(ref) : judge;
          expect(got).toBe(model(blocks, ref, opensAt, closesAt));
        },
      ),
      { numRuns },
    );
  });
});

describe("the bundle's run of L1 headers", () => {
  const c = byId("admitted");
  const good = run(21_000_000n, [START - 12n, OPENS, CLOSES + 1n]);
  const parse = (blocks: unknown) => parseBundle(bundleJson(c, blocks as unknown[]), hex(c.board));
  const parseWith = (members: Record<string, unknown>) =>
    parseBundle(
      JSON.stringify({ ...JSON.parse(bundleJson(c, blocksOf(good))), ...members }),
      hex(c.board),
    );

  test("parses a linked run, in order, with its sources", () => {
    const b = parse(blocksOf(good));
    if (b.format !== BUNDLE_FORMAT_BLOCKS) throw new Error("format");
    expect(b.l1Blocks.map((h) => toHex(h.hash))).toEqual(good.map((h) => toHex(h.hash)));
    expect(b.l1Blocks.map((h) => h.timestamp)).toEqual(good.map((h) => h.timestamp));
    expect(b.sources.l1Blocks).toBe("local-file");
  });

  test("reads each header's parent hash, the first field", () => {
    const anvil = decodeHeader(hex(closed.block.header));
    expect(toHex(anvil.parentHash)).toBe(closed.block.header.slice(8, 72));
  });

  const reject = (blocks: unknown, message: RegExp) => expect(() => parse(blocks)).toThrow(message);

  test("rejects an empty run, a non-array and a header that isn't one", () => {
    reject([], /at least one header/);
    reject(toHex((good[0] as TestHeader).encoded), /expected an array/);
    reject(["c0"], /l1Blocks\[0\]: a header is a list/);
    reject(["0"], /l1Blocks\[0\]: expected non-empty lowercase hex/);
    reject([toHex((good[0] as TestHeader).encoded).toUpperCase()], /lowercase hex/);
  });

  test("rejects a run that isn't one chain: a gap, a broken link, a repeated or earlier time", () => {
    const [a, b] = good as [TestHeader, TestHeader];
    const skip = header(a.hash, a.number + 2n, b.timestamp);
    reject(blocksOf([a, skip]), /l1Blocks\[1\]: not the child of l1Blocks\[0\]/);
    const orphan = header(new Uint8Array(32).fill(1), b.number, b.timestamp);
    reject(blocksOf([a, orphan]), /l1Blocks\[1\]: not the child/);
    for (const t of [a.timestamp, a.timestamp - 1n])
      reject(blocksOf([a, header(a.hash, b.number, t)]), /l1Blocks\[1\]: not the child/);
    reject(blocksOf([b, a]), /not the child/);
    reject(blocksOf([a, a]), /not the child/);
  });

  test("any change to one header of a run breaks its link or its shape", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: good.length - 2 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (i, at, flip) => {
          const blocks = good.map((h) => h.encoded.slice());
          const target = blocks[i] as Uint8Array;
          const k = at % target.length;
          target[k] = (target[k] as number) ^ flip;
          expect(() => parse(blocks.map(toHex))).toThrow(BundleError);
        },
      ),
      { numRuns },
    );
  });

  test("must agree with l1.header where it holds that block's number", () => {
    const anvil = decodeHeader(hex(closed.block.header));
    // The Anvil header itself, then a child of it: accepted.
    const child = header(anvil.hash, anvil.number + 1n, anvil.timestamp + 12n);
    expect(() => parse([closed.block.header, toHex(child.encoded)])).not.toThrow();
    const other = run(anvil.number, [anvil.timestamp]);
    reject(blocksOf(other), /l1Blocks\[0\]: another block than l1.header/);
  });

  test("is a member of format 5 only", () => {
    expect(() =>
      parseBundle(
        JSON.stringify({ ...JSON.parse(bundleJson(c, undefined)), l1Blocks: blocksOf(good) }),
        hex(c.board),
      ),
    ).toThrow(/unknown member l1Blocks/);
    expect(() => parseWith({ l1Blocks: undefined })).toThrow(/missing l1Blocks/);
    expect(() => parseWith({ panel: undefined })).toThrow(/missing panel/);
  });
});
