import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDag, encodeCheckpoint } from "@abolishus/crypto";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_L1,
  BundleError,
  type CheckResult,
  EXIT_CODES,
  loadBundle,
  parseBundle,
  readBlockStore,
  readBoardByCid,
  readBundle,
  type Report,
  runCli,
  verifyBundle,
} from "../src/index.ts";

// docs/spec/verifier.md, Board by CID: the boards of docs/spec/vectors/board.json
// and l1-anchor.json (from the independent Python implementation and Anvil,
// never from the code under test), read by CID from a blocks.car holding the
// segment objects of each vector's own entries, against the same boards read
// from board.bin.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

interface BoardVector {
  readonly id: string;
  readonly electionId: string;
  readonly now: string;
  readonly entries: readonly string[];
  readonly checkpoints: readonly Readonly<Record<string, string>>[];
  readonly result: "ok" | { readonly code: string };
}
const boards = JSON.parse(readFileSync(new URL("board.json", VECTORS), "utf8")) as {
  readonly clock: Readonly<Record<string, string>>;
  readonly boards: readonly BoardVector[];
};
const l1File = JSON.parse(readFileSync(new URL("l1-anchor.json", VECTORS), "utf8")) as {
  readonly clock: Readonly<Record<string, string>>;
  readonly electionId: string;
  readonly vectors: readonly {
    readonly id: string;
    readonly block: { readonly header: string };
    readonly anchor: string;
    readonly firstSegment: string;
    readonly nodes: readonly string[];
    readonly copy: string;
  }[];
};

const root = mkdtempSync(join(tmpdir(), "abolish-verify-cid-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let dirs = 0;

function varint(n: number): Uint8Array {
  const out: number[] = [];
  do {
    out.push((n & 0x7f) | (n >= 0x80 ? 0x80 : 0));
    n = Math.floor(n / 0x80);
  } while (n > 0);
  return Uint8Array.from(out);
}

// A CARv1 of every block of every segment object of `entries`, as a mirror
// holding them would export it: a header with a placeholder root (the
// verifier reads roots from L1, never from the store), then each block.
function blocksCar(entries: readonly Uint8Array[]): Uint8Array {
  const bySegment = new Map<number, Uint8Array[]>();
  // An entry too short for a segment field is no segment's: the mirror holds it nowhere.
  for (const e of entries.filter((e) => e.length >= 47)) {
    const s = new DataView(e.buffer, e.byteOffset + 43, 4).getUint32(0);
    bySegment.set(s, [...(bySegment.get(s) ?? []), e]);
  }
  const ascii = (s: string) => new TextEncoder().encode(s);
  const header = concatBytes(
    Uint8Array.of(0xa2, 0x65),
    ascii("roots"),
    Uint8Array.of(0x81, 0xd8, 0x2a, 0x58, 37, 0x00),
    new Uint8Array(36),
    Uint8Array.of(0x67),
    ascii("version"),
    Uint8Array.of(0x01),
  );
  const parts = [varint(header.length), header];
  for (const run of bySegment.values())
    for (const b of contentDag(concatBytes(...run)).blocks)
      parts.push(varint(b.cid.length + b.bytes.length), b.cid, b.bytes);
  return concatBytes(...parts);
}

function dir(files: Readonly<Record<string, string | Uint8Array>>): string {
  const d = join(root, String(dirs++));
  mkdirSync(d);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(d, name), content);
  return d;
}

function localJson(v: BoardVector): string {
  return JSON.stringify({
    format: "abolish-verifier-bundle/1",
    electionId: v.electionId,
    boardEntryVersion: 1,
    clock: boards.clock,
    now: v.now,
    anchors: v.checkpoints.map((c) => ({
      electionId: c["electionId"],
      segment: c["segment"],
      size: c["size"],
      head: c["head"],
      root: c["root"],
      objectCid: c["objectCid"],
      hashesCid: c["hashesCid"],
      anchoredAt: c["anchoredAt"],
    })),
  });
}

const entriesOf = (v: BoardVector) => v.entries.map((e) => hexToBytes(e));
const row = (r: Report, id: string) => r.checks.find((c) => c.id === id) as CheckResult;
const board = (v: BoardVector) => concatBytes(...entriesOf(v));

// As in packages/crypto's board-vectors test: the boards whose copy by CID
// stops short of the anchored extent, because the mirror holds the vector's
// altered copy, whose objects no anchored CID names, or the anchored CIDs
// don't name the runs the checkpoints' sizes bound (docs/spec/board.md,
// Residuals).
const shortByCid = new Set([
  "forged-trailing-same-segment",
  "segment-decreased",
  "entry-trailing-bytes",
  "copy-altered-inside-extent",
  "reordered-copy",
  "dropped",
  "checkpoint-mid-segment",
  "checkpoint-segment-too-early",
  "checkpoint-contradicted-by-larger",
  "checkpoint-errors-in-order",
  "checkpoint-wrong-object-cid",
  "checkpoint-cid-before-next-boundary",
  "checkpoint-cid-of-prefix",
  "checkpoint-cid-non-canonical",
  "checkpoint-reanchor-fresh-cid",
  "checkpoint-forked",
  "late-only-is-unanchored",
  "early-anchor-ignored",
  "unanchored-skipped-segment",
  "running-unanchored",
]);

describe("a format-1 bundle read by CID from blocks.car (board.json)", () => {
  for (const v of boards.boards)
    test(v.id, async () => {
      const json = localJson(v);
      const byCid = verifyBundle(
        await loadBundle(dir({ "bundle.json": json, "blocks.car": blocksCar(entriesOf(v)) })),
      );
      const whole = verifyBundle(readBundle(dir({ "bundle.json": json, "board.bin": board(v) })));
      expect(byCid.board.byCid?.storeUnreadableBytes).toBe(0);
      expect(byCid.board.unreadableBytes).toBe(0);
      if (!shortByCid.has(v.id)) {
        // Every check as from board.bin.
        expect(byCid.checks).toEqual(whole.checks);
        // Where the board checks pass, the copy is exactly the anchored
        // extent: nothing past it is named by any CID.
        if (whole.board.unauthenticated !== undefined)
          expect(byCid.board).toMatchObject({
            entries: whole.board.entries - whole.board.unauthenticated,
            unauthenticated: 0,
          });
        return;
      }
      // Short: unverifiable from this store, never the election's failure (T-53).
      expect(byCid.board.byCid?.stopped).toMatchObject({ checkpoint: expect.any(Number) });
      expect(row(byCid, "4.2")).toMatchObject({
        status: "unverifiable",
        code: "checkpoint-missing",
      });
      expect(byCid.checks.filter((c) => c.status === "fail")).toEqual([]);
    });
});

describe("a format-1 bundle read by CID", () => {
  const valid = boards.boards.find((b) => b.id === "valid") as BoardVector;

  test("an empty store leaves the copy short at the first run, unavailable", async () => {
    const r = verifyBundle(
      await loadBundle(dir({ "bundle.json": localJson(valid), "blocks.car": blocksCar([]) })),
    );
    expect(r.board).toMatchObject({
      entries: 0,
      byCid: { storeBlocks: 0, stopped: { checkpoint: 0, reason: "unavailable" } },
    });
    expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "checkpoint-missing" });
  });

  test("a budget under the board's objects stops the copy over-budget, after a whole-run prefix", async () => {
    const d = dir({ "bundle.json": localJson(valid), "blocks.car": blocksCar(entriesOf(valid)) });
    const full = verifyBundle(await loadBundle(d));
    expect(full.board.byCid?.stopped).toBeUndefined();
    const bytes = board(valid).length;
    for (const budget of [1, bytes - 1]) {
      const r = verifyBundle(await loadBundle(d, budget));
      expect(r.board.byCid?.stopped).toMatchObject({ reason: "over-budget" });
      expect(r.board.entries).toBeLessThan(full.board.entries);
      expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "checkpoint-missing" });
    }
    expect(verifyBundle(await loadBundle(d, bytes)).checks).toEqual(full.checks);
  });

  test("a store cut short keeps the runs before the cut", async () => {
    const car = blocksCar(entriesOf(valid));
    const r = verifyBundle(
      await loadBundle(
        dir({ "bundle.json": localJson(valid), "blocks.car": car.subarray(0, car.length - 1) }),
      ),
    );
    expect(r.board.byCid?.storeUnreadableBytes).toBeGreaterThan(0);
    expect(r.board.byCid?.stopped).toMatchObject({ reason: "unavailable" });
    expect(r.board.entries).toBeGreaterThan(0);
  });

  test("checks the budget and an already-held copy", async () => {
    const parsed = parseBundle(localJson(valid), new Uint8Array());
    const store = readBlockStore(blocksCar(entriesOf(valid)));
    for (const budget of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(readBoardByCid(parsed, store, budget)).rejects.toThrow(RangeError);
    const held = parseBundle(localJson(valid), board(valid));
    await expect(readBoardByCid(held, store, 1 << 20)).rejects.toThrow(TypeError);
    const read = await readBoardByCid(parsed, store, 1 << 20);
    await expect(readBoardByCid(read, store, 1 << 20)).rejects.toThrow(TypeError);
  });

  test("never runs the read where the board checks stop from L1 alone", async () => {
    const equivocation = boards.boards.find(
      (b) => b.result !== "ok" && b.result.code === "checkpoint-equivocation",
    ) as BoardVector;
    const r = verifyBundle(
      await loadBundle(
        dir({
          "bundle.json": localJson(equivocation),
          "blocks.car": blocksCar(entriesOf(equivocation)),
        }),
      ),
    );
    expect(r.board.byCid?.stopped).toEqual({ reason: "not-reached" });
    expect(row(r, "4.2")).toMatchObject({ status: "fail", code: "checkpoint-equivocation" });
  });
});

describe("a bundle directory", () => {
  const valid = boards.boards.find((b) => b.id === "valid") as BoardVector;

  test("holding both board.bin and blocks.car is rejected, whichever reader opens it", async () => {
    const d = dir({
      "bundle.json": localJson(valid),
      "board.bin": board(valid),
      "blocks.car": blocksCar(entriesOf(valid)),
    });
    await expect(loadBundle(d)).rejects.toThrow(BundleError);
    expect(() => readBundle(d)).toThrow(BundleError);
  });

  test("whose blocks.car isn't a CAR is rejected", async () => {
    await expect(
      loadBundle(dir({ "bundle.json": localJson(valid), "blocks.car": board(valid) })),
    ).rejects.toThrow("blocks.car: not a CARv1 file");
  });

  test("holding neither is rejected", async () => {
    await expect(loadBundle(dir({ "bundle.json": localJson(valid) }))).rejects.toThrow(
      "board.bin: can't be read",
    );
  });
});

describe("a format-2 bundle read by CID (l1-anchor.json)", () => {
  const closed = l1File.vectors.find((v) => v.id === "closed");
  const copy = boards.boards.find((b) => b.id === closed?.copy) as BoardVector;
  const json = (checkpoints: readonly string[]) =>
    JSON.stringify({
      format: BUNDLE_FORMAT_L1,
      electionId: l1File.electionId,
      boardEntryVersion: 1,
      clock: l1File.clock,
      l1: {
        anchor: closed?.anchor,
        firstSegment: closed?.firstSegment,
        header: closed?.block.header,
        nodes: closed?.nodes,
        checkpoints,
      },
    });
  // Each anchored checkpoint, as its CheckpointAnchored log carries it.
  const logged = copy.checkpoints.map((c) =>
    bytesToHex(
      encodeCheckpoint({
        election_id: hexToBytes(c["electionId"] as string),
        segment: Number(c["segment"]),
        size: BigInt(c["size"] as string),
        head: hexToBytes(c["head"] as string),
        root: hexToBytes(c["root"] as string),
        object_cid: hexToBytes(c["objectCid"] as string),
        hashes_cid: hexToBytes(c["hashesCid"] as string),
      }),
    ),
  );
  const car = blocksCar(entriesOf(copy));

  test("reads the anchors from their logged checkpoints and the copy by their CIDs", async () => {
    const r = verifyBundle(
      await loadBundle(dir({ "bundle.json": json(logged), "blocks.car": car })),
    );
    const whole = verifyBundle(
      readBundle(dir({ "bundle.json": json([]), "board.bin": board(copy) })),
    );
    expect(r.board.byCid).toEqual({ storeBlocks: expect.any(Number), storeUnreadableBytes: 0 });
    expect([row(r, "4.1").status, row(r, "4.2").status]).toEqual(["pass", "pass"]);
    expect(r.checks).toEqual(whole.checks);
    expect(r.l1?.anchors?.map((a) => a.hash)).toEqual(whole.l1?.anchors?.map((a) => a.hash));
  });

  test("without the logged checkpoints stops before the read, l1-checkpoint-unknown", async () => {
    const r = verifyBundle(await loadBundle(dir({ "bundle.json": json([]), "blocks.car": car })));
    expect(r.board.byCid?.stopped).toEqual({ reason: "not-reached" });
    expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "l1-checkpoint-unknown" });
  });
});

describe("the command line", () => {
  const valid = boards.boards.find((b) => b.id === "valid") as BoardVector;
  const d = dir({ "bundle.json": localJson(valid), "blocks.car": blocksCar(entriesOf(valid)) });
  async function run(...args: string[]) {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      stdout: (t) => (stdout += t),
      stderr: (t) => (stderr += t),
    });
    return { code, stdout, stderr };
  }

  test("reads blocks.car and reports how the read came out", async () => {
    const r = await run(d);
    expect(r.code).toBe(EXIT_CODES.unverifiable);
    expect((JSON.parse(r.stdout) as Report).board.byCid).toEqual({
      storeBlocks: expect.any(Number),
      storeUnreadableBytes: 0,
    });
  });

  test("takes a budget in canonical decimal only", async () => {
    const r = await run("--max-board-bytes", "1", d);
    expect((JSON.parse(r.stdout) as Report).board.byCid?.stopped).toMatchObject({
      reason: "over-budget",
    });
    for (const bad of ["0", "01", "-1", "1e3", "", " 1", String(2 ** 53)]) {
      const u = await run("--max-board-bytes", bad, d);
      expect(u.code).toBe(EXIT_CODES.usage);
      expect(u.stdout).toBe("");
    }
  });
});
