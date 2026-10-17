import { cidText, contentDag, objectCar } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli.ts";
import { blocksDir } from "./fixture.ts";

function io() {
  const out: unknown[] = [];
  const err: unknown[] = [];
  const stop = new AbortController();
  return {
    out,
    err,
    stop,
    io: { out: (v: unknown) => out.push(v), err: (v: unknown) => err.push(v), signal: stop.signal },
  };
}

describe("abolish-node", () => {
  test("refuses an unknown command, a missing --blocks and a bad port", async () => {
    for (const argv of [[], ["pin"], ["serve"], ["serve", "--blocks", "x", "--port", "65536"]]) {
      const run = io();
      expect(await cli(argv, run.io)).toBe(2);
      expect(run.err).toHaveLength(1);
    }
    const run = io();
    expect(await cli(["serve", "--blocks", "x", "--verbose"], run.io)).toBe(2);
  });

  test("refuses a directory it can't read", async () => {
    const run = io();
    expect(await cli(["serve", "--blocks", "/nonexistent/abolish-node"], run.io)).toBe(2);
    expect(run.err).toEqual([{ error: "blocks: ENOENT" }]);
  });

  test("reports each file, serves its blocks until stopped, then exits 0", async () => {
    const object = new TextEncoder().encode("a board segment");
    const dir = await blocksDir({
      "a.car": objectCar(object),
      "notes.car": new TextEncoder().encode("not a car"),
      "ignored.txt": new Uint8Array([1]),
    });
    const run = io();
    const exit = cli(["serve", "--blocks", dir, "--port", "0"], run.io);
    await expect.poll(() => run.out.length).toBe(3);
    expect(run.out.slice(0, 2)).toEqual([
      { file: "a.car", blocks: 1, unreadableBytes: 0 },
      { file: "notes.car", error: "not-a-car" },
    ]);
    const { listening } = run.out[2] as { listening: { address: string; port: number } };
    expect(listening.address).toBe("127.0.0.1");
    const res = await fetch(
      `http://127.0.0.1:${listening.port}/ipfs/${cidText(contentDag(object).root)}?format=raw`,
    );
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(object);
    run.stop.abort();
    expect(await exit).toBe(0);
  });
});
