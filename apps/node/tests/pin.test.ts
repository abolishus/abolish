import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AsyncBlockSource,
  type Checkpoint,
  cidText,
  contentDag,
  objectCar,
  objectCid,
} from "@abolishus/crypto";
import { gatewaySource, type L1Header } from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli.ts";
import { gateway } from "../src/gateway.ts";
import { finalizedHeader } from "../src/l1.ts";
import { mirrorThen, type PinReport, pinElections } from "../src/pin.ts";
import { type Rpc, RpcError } from "../src/rpc.ts";
import { openMirror } from "../src/store.ts";
import { type Anchor, type Chain, forgedLog, hex, startChain, word } from "./anvil.ts";
import { blocksDir, close, listen, removeDirs } from "./fixture.ts";

// Fetch and pin (P4-5 part 2) against a real chain: Anvil runs the board
// anchor, checkpoints are anchored through it from an impersonated authority
// (standing in for the Safe; no key is held here, AGENTS.md), and the node
// pins what they name from a gateway, proving every word at the finalized
// block. A node that lies, through `hooked`, can hide checkpoints but never
// make the node pin bytes the anchor didn't name (T-24, T-36, T-49, T-51).

let chain: Chain;
let rpc: Rpc;
let rpcUrl: URL;

beforeAll(async () => {
  chain = await startChain();
  rpc = chain.rpc;
  rpcUrl = chain.url;
}, 120_000);

afterAll(async () => {
  await chain?.stop();
});

const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of servers.splice(0)) await stop();
  await removeDirs();
});

const deployAnchor = () => chain.deployAnchor();
const anchorAll = (anchor: Anchor, checkpoints: readonly Checkpoint[]) =>
  chain.anchorAll(anchor, checkpoints);

const text = (s: string) => new TextEncoder().encode(s);
// 1.5 MiB: a dag-pb root over two raw leaves, so a pin is more than one block.
const large = (seed: number) =>
  Uint8Array.from({ length: 1_572_864 }, (_, i) => (i * 31 + seed + (i >>> 20)) & 0xff);

/** A checkpoint naming `object` and `hashes`; the pinner judges nothing else about it. */
function checkpoint(
  electionId: Uint8Array,
  segment: number,
  size: bigint,
  object: Uint8Array,
  hashes: Uint8Array,
): Checkpoint {
  return {
    election_id: electionId,
    segment,
    size,
    head: keccak_256(concatBytes(electionId, word(size))),
    root: keccak_256(concatBytes(word(size), electionId)),
    object_cid: objectCid(object),
    hashes_cid: objectCid(hashes),
  };
}

/** A gateway holding `objects`, and how many requests it has answered. */
async function serving(objects: readonly Uint8Array[]): Promise<URL> {
  const files: Record<string, Uint8Array> = {};
  objects.forEach((o, i) => (files[`${i}.car`] = objectCar(o)));
  const server = gateway(await openMirror(await blocksDir(files)));
  const base = await listen(server);
  servers.push(() => close(server));
  return new URL(base);
}

type Hook = (method: string, params: readonly unknown[], forward: Rpc["call"]) => Promise<unknown>;

/** The Anvil node through `hook`, which may change any request or answer: a node not to trust. */
const hooked = (hook: Hook): Rpc => ({
  call: (method, params) => hook(method, params, rpc.call),
});

async function pin(
  anchor: Anchor,
  dir: string,
  sources: AsyncBlockSource,
  options: { through?: Rpc; maxElectionBytes?: number } = {},
): Promise<{ reports: PinReport[]; refusedLogs: number; header: L1Header }> {
  const through = options.through ?? rpc;
  const header = await finalizedHeader(through);
  const reports: PinReport[] = [];
  const run = await pinElections(header, {
    rpc: through,
    anchor: anchor.address,
    blocks: mirrorThen(await openMirror(dir), sources),
    dir,
    fromBlock: 0n,
    maxElectionBytes: options.maxElectionBytes ?? 2 ** 30,
    report: (r) => reports.push(r),
  });
  return { reports, refusedLogs: run.refusedLogs, header };
}

const id = (n: number) => keccak_256(text(`election ${n}`));
const ids = (b: Uint8Array) => bytesToHex(b);

describe("fetch and pin", () => {
  test("pins every object the anchored checkpoints name, one CAR each, and a second run fetches nothing", async () => {
    const anchor = await deployAnchor();
    const [a, b] = [id(1), id(2)];
    const objects = [large(1), text("segment 1 of a"), large(2)];
    const hashes = [
      new Uint8Array(64).fill(1),
      new Uint8Array(32).fill(2),
      new Uint8Array(96).fill(3),
    ];
    const cps = [
      checkpoint(a, 0, 2n, objects[0]!, hashes[0]!),
      checkpoint(a, 1, 3n, objects[1]!, hashes[1]!),
      checkpoint(b, 1, 3n, objects[2]!, hashes[2]!),
    ];
    await anchorAll(anchor, cps);
    const base = await serving([...objects, ...hashes]);
    const gateways = gatewaySource([base]);
    const dir = await blocksDir({});

    const run = await pin(anchor, dir, gateways.source);
    expect(run.refusedLogs).toBe(0);
    expect(run.reports.filter((r) => "checkpoints" in r)).toEqual([
      { election: ids(a), checkpoints: 2, unproven: 0 },
      { election: ids(b), checkpoints: 1, unproven: 0 },
    ]);
    const pinned = run.reports.filter((r) => "outcome" in r);
    expect(pinned.map((r) => ("outcome" in r ? r.outcome : undefined))).toEqual(
      Array(6).fill("pinned"),
    );
    const all = [...objects, ...hashes];
    expect((await readdir(dir)).sort()).toEqual(
      all.map((o) => `${cidText(objectCid(o))}.car`).sort(),
    );
    for (const o of all) {
      const car = await readFile(join(dir, `${cidText(objectCid(o))}.car`));
      expect(Buffer.from(car).equals(Buffer.from(objectCar(o)))).toBe(true);
    }
    // `serve` mirrors what was pinned: every block of every object.
    const mirror = await openMirror(dir);
    for (const o of all)
      for (const block of contentDag(o).blocks)
        expect(Buffer.from((await mirror.block(block.cid))!).equals(Buffer.from(block.bytes))).toBe(
          true,
        );

    const requests = gateways.stats().requests;
    const again = await pin(anchor, dir, gateways.source);
    expect(
      again.reports.filter((r) => "outcome" in r).map((r) => ("outcome" in r ? r.outcome : 0)),
    ).toEqual(Array(6).fill("held"));
    expect(gateways.stats().requests).toBe(requests);
  });

  test("reports what it can't fetch and goes on: withheld, altered, over its bound or past the budget", async () => {
    const anchor = await deployAnchor();
    const e = id(3);
    const withheld = text("never served");
    const altered = large(4);
    // A run of two entries has an entry-hash list of 64 bytes: 96 is no list of that run.
    const tooLong = new Uint8Array(96).fill(7);
    const fine = new Uint8Array(32).fill(8);
    const cps = [checkpoint(e, 0, 1n, withheld, fine), checkpoint(e, 1, 3n, altered, tooLong)];
    await anchorAll(anchor, cps);
    const honest = await serving([withheld, altered, tooLong, fine]);
    const gateways = gatewaySource([honest]);
    const leaf = contentDag(altered).blocks[1]!;
    const source: AsyncBlockSource = async (cid, limit) => {
      if (Buffer.from(cid).equals(Buffer.from(objectCid(withheld)))) return [];
      // An altered leaf, which the reader refuses since it doesn't hash to its CID.
      if (Buffer.from(cid).equals(Buffer.from(leaf.cid)))
        return [Uint8Array.from(leaf.bytes, (x, i) => (i === 0 ? x ^ 1 : x))];
      return gateways.source(cid, limit);
    };
    const dir = await blocksDir({});
    const run = await pin(anchor, dir, source);
    expect(run.reports.filter((r) => "outcome" in r)).toEqual([
      {
        election: ids(e),
        segment: 0,
        kind: "object",
        cid: cidText(objectCid(withheld)),
        outcome: "unavailable",
      },
      {
        election: ids(e),
        segment: 0,
        kind: "hashes",
        cid: cidText(objectCid(fine)),
        outcome: "pinned",
        bytes: 32,
      },
      {
        election: ids(e),
        segment: 1,
        kind: "object",
        cid: cidText(objectCid(altered)),
        outcome: "unavailable",
      },
      {
        election: ids(e),
        segment: 1,
        kind: "hashes",
        cid: cidText(objectCid(tooLong)),
        outcome: "inconsistent",
      },
    ]);
    expect(await readdir(dir)).toEqual([`${cidText(objectCid(fine))}.car`]);

    // A budget of 40 bytes: the 32-byte list fits, then the large object, in
    // its bound, doesn't; the list past its bound is still the authority's.
    const small = await blocksDir({});
    const budget = await pin(anchor, small, source, { maxElectionBytes: 40 });
    expect(
      budget.reports.filter((r) => "outcome" in r).map((r) => ("outcome" in r ? r.outcome : 0)),
    ).toEqual(["unavailable", "pinned", "over-budget", "inconsistent"]);
  });
});

describe("a node not to trust", () => {
  test("a log for a checkpoint the anchor doesn't hold is never pinned", async () => {
    const anchor = await deployAnchor();
    const e = id(5);
    const real = checkpoint(e, 0, 1n, text("real"), new Uint8Array(32).fill(1));
    await anchorAll(anchor, [real]);
    const forged = checkpoint(e, 2, 2n, text("forged"), new Uint8Array(32).fill(2));
    const through = hooked(async (method, params, forward) => {
      const result = await forward(method, params);
      if (method !== "eth_getLogs") return result;
      const [log] = result as { address: string; topics: string[]; data: string }[];
      // The real log repeated counts once.
      return [...(result as unknown[]), log, forgedLog(log!, forged)];
    });
    const gateways = gatewaySource([
      await serving([
        text("real"),
        text("forged"),
        new Uint8Array(32).fill(1),
        new Uint8Array(32).fill(2),
      ]),
    ]);
    const dir = await blocksDir({});
    const run = await pin(anchor, dir, gateways.source, { through });
    expect(run.reports.find((r) => "checkpoints" in r)).toEqual({
      election: ids(e),
      checkpoints: 1,
      unproven: 1,
    });
    expect((await readdir(dir)).sort()).toEqual(
      [text("real"), new Uint8Array(32).fill(1)].map((o) => `${cidText(objectCid(o))}.car`).sort(),
    );
  });

  test("a withheld or altered log leaves its election unpinned, and other elections pinned", async () => {
    const anchor = await deployAnchor();
    const [e, f] = [id(6), id(7)];
    const objects = [text("e0"), text("e1"), text("f0")];
    const list = new Uint8Array(32).fill(9);
    await anchorAll(anchor, [
      checkpoint(e, 0, 1n, objects[0]!, list),
      checkpoint(e, 1, 2n, objects[1]!, list),
      checkpoint(f, 0, 1n, objects[2]!, list),
    ]);
    const gateways = gatewaySource([await serving([...objects, list])]);
    for (const tamper of ["drop", "alter"] as const) {
      const through = hooked(async (method, params, forward) => {
        const result = (await forward(method, params)) as { topics: string[]; data: string }[];
        if (method !== "eth_getLogs") return result;
        // The log of e's segment 0, which the reader needs to match its proven word.
        const at = result.findIndex((l) => l.topics[1] === hex(e) && BigInt(l.topics[2]!) === 0n);
        if (tamper === "drop") return result.filter((_, i) => i !== at);
        const other = checkpoint(e, 0, 1n, text("other"), list);
        return result.map((l, i) => (i === at ? forgedLog(l as never, other) : l));
      });
      const dir = await blocksDir({});
      const run = await pin(anchor, dir, gateways.source, { through });
      expect(run.reports.find((r) => r.election === ids(e))).toEqual({
        election: ids(e),
        error: "l1-checkpoint-unknown at segment 0",
      });
      expect(run.reports.find((r) => r.election === ids(f) && "checkpoints" in r)).toEqual({
        election: ids(f),
        checkpoints: 1,
        unproven: 0,
      });
      expect((await readdir(dir)).sort()).toEqual(
        [objects[2]!, list].map((o) => `${cidText(objectCid(o))}.car`).sort(),
      );
    }
  });

  test("an election whose proofs can't be read is reported, and the next one still pinned", async () => {
    const anchor = await deployAnchor();
    const [e, f] = [id(12), id(13)];
    const list = new Uint8Array(32).fill(6);
    await anchorAll(anchor, [
      checkpoint(e, 0, 1n, text("e"), list),
      checkpoint(f, 0, 1n, text("f"), list),
    ]);
    const gateways = gatewaySource([await serving([text("e"), text("f"), list])]);
    let proofs = 0;
    const through = hooked(async (method, params, forward) => {
      // The first election's proof request is refused, as a rate limit would.
      if (method === "eth_getProof" && proofs++ === 0) throw new RpcError("eth_getProof: limited");
      return forward(method, params);
    });
    const dir = await blocksDir({});
    const run = await pin(anchor, dir, gateways.source, { through });
    expect(run.reports.filter((r) => !("outcome" in r))).toEqual([
      { election: ids(e), error: "eth_getProof: limited" },
      { election: ids(f), checkpoints: 1, unproven: 0 },
    ]);
    expect((await readdir(dir)).length).toBe(2);
  });

  test("a log in another layout, or from another address, is refused", async () => {
    const anchor = await deployAnchor();
    const e = id(8);
    await anchorAll(anchor, [checkpoint(e, 0, 1n, text("x"), new Uint8Array(32))]);
    const through = hooked(async (method, params, forward) => {
      const result = (await forward(method, params)) as { address: string; data: string }[];
      if (method !== "eth_getLogs") return result;
      const [log] = result;
      return [
        { ...log, address: `0x${"11".repeat(20)}` },
        { ...log, data: `${log!.data}00` },
        { ...log, topics: [] },
        null,
      ];
    });
    const run = await pin(
      anchor,
      await blocksDir({}),
      gatewaySource([new URL("http://127.0.0.1:9")]).source,
      {
        through,
      },
    );
    expect(run.refusedLogs).toBe(4);
    expect(run.reports).toEqual([]);
  });

  test("a lowest segment named too high, or none, is caught by its proof", async () => {
    const anchor = await deployAnchor();
    const e = id(11);
    const list = new Uint8Array(32).fill(5);
    await anchorAll(anchor, [
      checkpoint(e, 0, 1n, text("s0"), list),
      checkpoint(e, 2, 2n, text("s2"), list),
    ]);
    const gateways = gatewaySource([await serving([text("s0"), text("s2"), list])]);
    for (const [claim, expected] of [
      // Segment 2 as the lowest, which would hide segment 0's withheld log.
      ["0x3", [{ election: ids(e), error: "l1-proof-missing" }]],
      ["0x0", [{ election: ids(e), error: "l1-proof-missing" }]],
      // The true one, or anything lower, finds the withheld log missing.
      ["0x1", [{ election: ids(e), error: "l1-checkpoint-unknown at segment 0" }]],
    ] as const) {
      const through = hooked(async (method, params, forward) => {
        if (method === "eth_getStorageAt") return claim;
        const result = await forward(method, params);
        if (method !== "eth_getLogs") return result;
        return (result as { topics: string[] }[]).filter((l) => BigInt(l.topics[2]!) !== 0n);
      });
      const run = await pin(anchor, await blocksDir({}), gateways.source, { through });
      expect(run.reports).toEqual(expected);
    }
  });

  test("altered proof nodes leave the election unpinned", async () => {
    const anchor = await deployAnchor();
    const e = id(9);
    await anchorAll(anchor, [checkpoint(e, 0, 1n, text("y"), new Uint8Array(32))]);
    const through = hooked(async (method, params, forward) => {
      const result = (await forward(method, params)) as {
        accountProof: string[];
        storageProof: { proof: string[] }[];
      };
      if (method !== "eth_getProof") return result;
      return {
        ...result,
        storageProof: result.storageProof.map((p) => ({
          ...p,
          proof: p.proof.map((n) => `${n.slice(0, -2)}${n.endsWith("00") ? "01" : "00"}`),
        })),
      };
    });
    const run = await pin(
      anchor,
      await blocksDir({}),
      gatewaySource([new URL("http://127.0.0.1:9")]).source,
      {
        through,
      },
    );
    expect(run.reports).toEqual([{ election: ids(e), error: "l1-proof-missing" }]);
  });

  test("a block whose header doesn't hash to its hash is refused", async () => {
    const through = hooked(async (method, params, forward) => {
      const block = (await forward(method, params)) as Record<string, string>;
      return { ...block, stateRoot: `0x${"00".repeat(32)}` };
    });
    await expect(finalizedHeader(through)).rejects.toThrow(RpcError);
    await expect(finalizedHeader(through)).rejects.toThrow("doesn't hash to its hash");
    // A quantity wider than any header field is refused before it is encoded.
    const wide = hooked(async (method, params, forward) => {
      const block = (await forward(method, params)) as Record<string, string>;
      return { ...block, difficulty: `0x1${"0".repeat(64)}` };
    });
    await expect(finalizedHeader(wide)).rejects.toThrow("difficulty: not a quantity");
    // A block of one field, with its hash recomputed.
    const short = hooked(async (method, params, forward) => {
      const { parentHash } = (await forward(method, params)) as Record<string, string>;
      const rlp = concatBytes(Uint8Array.of(0xe1, 0xa0), hexToBytes(parentHash!.slice(2)));
      return { parentHash, hash: hex(keccak_256(rlp)) };
    });
    await expect(finalizedHeader(short)).rejects.toThrow("isn't an L1 header");
    const real = await finalizedHeader(rpc);
    expect(real.number).toBeTypeOf("bigint");
  });
});

describe("abolish-node fetch", () => {
  function io() {
    const out: unknown[] = [];
    const err: unknown[] = [];
    return {
      out,
      err,
      io: {
        out: (v: unknown) => out.push(v),
        err: (v: unknown) => err.push(v),
        signal: new AbortController().signal,
      },
    };
  }

  test("refuses bad usage", async () => {
    const good = [
      "--blocks",
      "x",
      "--l1",
      "http://127.0.0.1:1",
      "--anchor",
      `0x${"ab".repeat(20)}`,
      "--gateway",
      "http://127.0.0.1:2",
    ];
    for (const argv of [
      ["fetch"],
      ["fetch", ...good.slice(2)],
      ["fetch", ...good.slice(0, 6)],
      ["fetch", ...good, "--from-block", "-1"],
      ["fetch", ...good, "--max-bytes", "0"],
      ["fetch", ...good, "--max-bytes", "01"],
      ["fetch", ...good.slice(0, 4), "--anchor", "0x12", ...good.slice(6)],
      ["fetch", ...good.slice(0, 2), "--l1", "ftp://x", ...good.slice(4)],
      ["fetch", ...good.slice(0, 6), "--gateway", "http://x/?q"],
      [
        "fetch",
        ...good,
        ...Array.from({ length: 16 }, () => ["--gateway", "http://127.0.0.1:2"]).flat(),
      ],
      ["fetch", ...good, "--verbose"],
    ]) {
      const run = io();
      expect(await cli(argv, run.io)).toBe(2);
      expect(run.err).toHaveLength(1);
    }
  });

  test("pins from the command line, and exits 1 when L1 can't be read", async () => {
    const anchor = await deployAnchor();
    const e = id(10);
    const object = text("from the command line");
    const list = new Uint8Array(32).fill(4);
    await anchorAll(anchor, [checkpoint(e, 0, 1n, object, list)]);
    const base = await serving([object, list]);
    const dir = await blocksDir({});
    const argv = [
      "fetch",
      "--blocks",
      dir,
      "--anchor",
      hex(anchor.address),
      "--gateway",
      base.href,
    ];
    const run = io();
    expect(await cli([...argv, "--l1", rpcUrl.href], run.io)).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out).toContainEqual({ election: ids(e), checkpoints: 1, unproven: 0 });
    expect(run.out.at(-1)).toEqual({ refusedLogs: 0, gateways: { requests: 2, blocks: 2 } });
    expect((await readdir(dir)).length).toBe(2);

    const down = io();
    expect(await cli([...argv, "--l1", "http://127.0.0.1:9/key"], down.io)).toBe(1);
    expect(down.err).toHaveLength(1);
    // The URL may carry a key: no error names it.
    expect(JSON.stringify(down.err)).not.toContain("/key");
  });
});
