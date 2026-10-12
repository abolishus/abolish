import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_L1,
  MAX_SEGMENTS_READ,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";

// docs/spec/vectors/l1-anchor.json: block headers and trie nodes served by
// Anvil for a deployed BoardAnchor that anchored board.json's `valid` board
// (packages/verifier/scripts/l1-anchor-vectors.py). Block hashes and proofs
// come from Anvil's own implementation; the expected anchors are the
// checkpoints the script sent (docs/spec/contracts.md, Board anchor,
// Verification; T-24, T-36, T-53).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

interface Vector {
  readonly id: string;
  readonly block: {
    readonly hash?: string;
    readonly number: string;
    readonly timestamp: string;
    readonly header: string;
  };
  readonly anchor: string;
  readonly firstSegment: string;
  readonly nodes: readonly string[];
  readonly checkpoints: readonly string[];
  readonly copy: string;
  readonly copyEntries?: string;
  readonly result:
    | {
        readonly anchors: readonly {
          readonly segment: string;
          readonly hash: string;
          readonly source: string;
        }[];
      }
    | { readonly error: { readonly code: string; readonly segment?: number } };
  readonly board?: "ok" | { readonly code: string; readonly [at: string]: unknown };
}

const file = JSON.parse(readFileSync(new URL("l1-anchor.json", VECTORS), "utf8")) as {
  readonly format: string;
  readonly clock: Readonly<Record<"epoch" | "period" | "deadline" | "lastSegment", string>>;
  readonly electionId: string;
  readonly vectors: readonly Vector[];
};
const boards = JSON.parse(readFileSync(new URL("board.json", VECTORS), "utf8")) as {
  readonly boards: readonly { readonly id: string; readonly entries: readonly string[] }[];
};

function board(v: Vector): Uint8Array {
  const copy = boards.boards.find((b) => b.id === v.copy);
  if (copy === undefined) throw new Error(`no board ${v.copy}`);
  const entries = copy.entries.slice(
    0,
    v.copyEntries === undefined ? undefined : Number(v.copyEntries),
  );
  return Uint8Array.from(Buffer.from(entries.join(""), "hex"));
}

function run(v: Vector): Report {
  const bundle = parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_L1,
      electionId: file.electionId,
      boardEntryVersion: 1,
      clock: file.clock,
      l1: {
        anchor: v.anchor,
        firstSegment: v.firstSegment,
        header: v.block.header,
        nodes: v.nodes,
        checkpoints: v.checkpoints,
      },
    }),
    board(v),
  );
  return verifyBundle(bundle);
}

const row = (r: Report, id: string) => r.checks.find((c) => c.id === id) as CheckResult;

test("the file is the L1-anchor vector format", () => {
  expect(file.format).toBe("abolish-l1-anchor-vectors/1");
  expect(file.vectors.length).toBe(12);
  expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
});

describe("anchors read from L1 state", () => {
  for (const v of file.vectors)
    test(v.id, () => {
      const r = run(v);
      expect(Object.keys(r)).toEqual([
        "format",
        "verdict",
        "verdictAgainstInputs",
        "inputs",
        "board",
        "l1",
        "checks",
      ]);
      // The header's hash is Keccak-256 of its bytes, as Anvil computed it.
      if (v.block.hash !== undefined) expect(r.l1?.blockHash).toBe(v.block.hash);
      expect(r.l1?.blockNumber).toBe(v.block.number);
      expect(r.l1?.timestamp).toBe(v.block.timestamp);
      // The header, the anchor's address and f are local files, so nothing
      // read through them can verify or fail the election yet (T-53).
      expect(r.verdict).toBe("unverifiable");
      expect(r.inputs.now).toBe("l1-state-proof");
      expect(r.inputs.anchors).toBe("l1-state-proof");
      expect([r.inputs.l1Header, r.inputs.anchorAddress, r.inputs.firstSegment]).toEqual(
        Array(3).fill("local-file"),
      );
      if ("error" in v.result) {
        expect(r.l1?.anchors).toBeUndefined();
        expect(row(r, "4.1")).toMatchObject({ status: "unverifiable", code: "not-reached" });
        const { code, segment } = v.result.error;
        expect(row(r, "4.2")).toEqual({
          id: "4.2",
          kind: "election",
          status: "unverifiable",
          code,
          at: segment === undefined ? {} : { segment },
        });
        expect(r.verdictAgainstInputs).toBe("unverifiable");
        return;
      }
      expect(r.l1?.anchors).toEqual(
        v.result.anchors.map((a) => ({ ...a, segment: Number(a.segment) })),
      );
      if (v.board === "ok") {
        expect([row(r, "4.1").status, row(r, "4.2").status]).toEqual(["pass", "pass"]);
        return;
      }
      if (v.board === undefined) throw new Error("an anchors vector has a board result");
      const { code, ...at } = v.board;
      const hit = r.checks.find((c) => c.code === code);
      expect(hit?.at).toEqual(at);
    });
});

test("a node not in the pool is missing, whichever node it is", () => {
  const v = file.vectors.find((x) => x.id === "closed") as Vector;
  for (let i = 0; i < v.nodes.length; i++) {
    const r = run({ ...v, nodes: v.nodes.filter((_, j) => j !== i) });
    expect(row(r, "4.2").code).toBe("l1-proof-missing");
  }
});

test("a changed byte in any node is a node the state root doesn't commit to", () => {
  const v = file.vectors.find((x) => x.id === "closed") as Vector;
  for (let i = 0; i < v.nodes.length; i++) {
    const node = v.nodes[i] as string;
    for (const at of [0, node.length / 2 - 1, node.length - 2]) {
      const changed =
        node.slice(0, at) + (node.slice(at, at + 2) === "00" ? "01" : "00") + node.slice(at + 2);
      const nodes = v.nodes.map((n, j) => (j === i ? changed : n));
      const r = run({ ...v, nodes });
      expect(row(r, "4.2").code).toBe("l1-proof-missing");
    }
  }
});

test("extra nodes and repeated nodes change nothing", () => {
  const v = file.vectors.find((x) => x.id === "closed") as Vector;
  const other = file.vectors.find((x) => x.id === "running") as Vector;
  const r = run({ ...v, nodes: [...other.nodes, ...v.nodes, ...v.nodes] });
  expect(r).toEqual(run(v));
});

test("a clock and f that would read more than 2^20 words stop before reading them", () => {
  const v = file.vectors.find((x) => x.id === "closed") as Vector;
  const bundle = (lastSegment: number) =>
    parseBundle(
      JSON.stringify({
        format: BUNDLE_FORMAT_L1,
        electionId: file.electionId,
        boardEntryVersion: 1,
        clock: { epoch: "0", period: "1", deadline: "0", lastSegment: `${lastSegment}` },
        l1: {
          anchor: v.anchor,
          firstSegment: "0",
          header: v.block.header,
          nodes: v.nodes,
          checkpoints: [],
        },
      }),
      board(v),
    );
  // At 2^20 - 1 the walk starts: the vector's nodes prove only the slots of
  // its own clock, so it stops at a later segment's missing node. One
  // segment more is refused before any segment's word is read.
  expect(row(verifyBundle(bundle(MAX_SEGMENTS_READ - 1)), "4.2")).toMatchObject({
    status: "unverifiable",
    code: "l1-proof-missing",
  });
  expect(row(verifyBundle(bundle(MAX_SEGMENTS_READ)), "4.2")).toMatchObject({
    status: "unverifiable",
    code: "l1-range-too-long",
  });
});
