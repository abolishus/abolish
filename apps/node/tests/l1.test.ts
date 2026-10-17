import { type Checkpoint, checkpointHash } from "@abolishus/crypto";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  CHECKPOINT_ANCHORED,
  checkpointFromLog,
  parseAddress,
  PROOF_NODE_OVERHEAD,
  PROOF_SLOTS_PER_REQUEST,
  proofNodes,
} from "../src/l1.ts";
import { MAX_RPC_ANSWER, parseRpcUrl, rpcClient, RpcError } from "../src/rpc.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const word = (n: bigint) => {
  const w = new Uint8Array(32);
  for (let i = 31, x = n; x > 0n; i--, x >>= 8n) w[i] = Number(x & 0xffn);
  return w;
};
const padded = (b: Uint8Array) => concatBytes(b, new Uint8Array(28));

const cid = fc
  .tuple(fc.constantFrom(0x55, 0x70), fc.uint8Array({ minLength: 32, maxLength: 32 }))
  .map(([codec, digest]) => concatBytes(Uint8Array.of(0x01, codec, 0x12, 0x20), digest));
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const checkpoint: fc.Arbitrary<Checkpoint> = fc.record({
  election_id: bytes32,
  segment: fc.nat({ max: 0xffffffff }),
  size: fc.bigInt({ min: 1n, max: 2n ** 64n - 1n }),
  head: bytes32,
  root: bytes32,
  object_cid: cid,
  hashes_cid: cid,
});

// The contract's layout, written independently of the decoder.
function log(cp: Checkpoint) {
  return {
    topics: [
      hex(CHECKPOINT_ANCHORED),
      hex(cp.election_id),
      hex(word(BigInt(cp.segment))),
      hex(checkpointHash(cp)),
    ],
    data: hex(
      concatBytes(
        word(cp.size),
        cp.head,
        cp.root,
        word(0xa0n),
        word(0x100n),
        word(36n),
        padded(cp.object_cid),
        word(36n),
        padded(cp.hashes_cid),
      ),
    ),
  };
}

const flip = (s: string, at: number) =>
  `${s.slice(0, at)}${((Number.parseInt(s[at] as string, 16) + 1) % 16).toString(16)}${s.slice(at + 1)}`;

describe("checkpointFromLog", () => {
  test("reads back every checkpoint from its log", () => {
    fc.assert(
      fc.property(checkpoint, (cp) => {
        expect(checkpointFromLog(log(cp))).toEqual(cp);
      }),
      { numRuns },
    );
  });

  test("refuses a log with any nibble of its topics or data changed", () => {
    fc.assert(
      fc.property(checkpoint, fc.nat(), fc.nat(), (cp, which, at) => {
        const l = log(cp);
        const fields = [...l.topics, l.data];
        const i = which % fields.length;
        const field = fields[i] as string;
        // Past the `0x`.
        fields[i] = flip(field, 2 + (at % (field.length - 2)));
        const changed = { topics: fields.slice(0, 4), data: fields[4] };
        expect(checkpointFromLog(changed)).toBeUndefined();
      }),
      { numRuns },
    );
  });

  test("refuses other shapes", () => {
    const l = log({
      election_id: new Uint8Array(32),
      segment: 1,
      size: 1n,
      head: new Uint8Array(32),
      root: new Uint8Array(32),
      object_cid: concatBytes(Uint8Array.of(1, 0x55, 0x12, 0x20), new Uint8Array(32)),
      hashes_cid: concatBytes(Uint8Array.of(1, 0x55, 0x12, 0x20), new Uint8Array(32)),
    });
    for (const bad of [
      null,
      "log",
      {},
      { ...l, topics: l.topics.slice(0, 3) },
      { ...l, topics: [...l.topics, l.topics[0]] },
      { ...l, topics: [l.topics[0], "0x01", l.topics[2], l.topics[3]] },
      { ...l, data: `${l.data}00` },
      { ...l, data: l.data.slice(0, -64) },
      { ...l, data: "0xzz" },
      { ...l, data: 7 },
    ])
      expect(checkpointFromLog(bad)).toBeUndefined();
  });
});

describe("parsing the command line's L1 inputs", () => {
  test("an address is 0x and 40 hex digits", () => {
    expect(parseAddress(`0x${"aB".repeat(20)}`)).toHaveLength(20);
    for (const bad of [
      "",
      "0x",
      `${"ab".repeat(20)}`,
      `0x${"ab".repeat(19)}`,
      `0x${"gg".repeat(20)}`,
    ])
      expect(() => parseAddress(bad)).toThrow(RangeError);
  });

  test("an L1 node is an http: or https: URL", () => {
    expect(parseRpcUrl("https://node.example/v1/key").href).toBe("https://node.example/v1/key");
    for (const bad of ["", "node.example", "ftp://node.example", "file:///etc/passwd"])
      expect(() => parseRpcUrl(bad)).toThrow(RangeError);
  });
});

describe("the JSON-RPC client", () => {
  const url = new URL("http://node.example/secret-key");
  const answering = (body: string | ReadableStream<Uint8Array> | null, status = 200) =>
    rpcClient(url, { fetch: async () => new Response(body, { status }) });

  test("returns the result of an answer to its own request", async () => {
    const seen: unknown[] = [];
    const rpc = rpcClient(url, {
      fetch: async (_, init) => {
        const request = JSON.parse(init?.body as string) as { id: number };
        seen.push(request);
        return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x1" });
      },
    });
    expect(await rpc.call("eth_chainId", [])).toBe("0x1");
    expect(seen).toEqual([{ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }]);
  });

  test("refuses errors, other statuses, other ids and answers that aren't JSON-RPC, naming no URL", async () => {
    for (const rpc of [
      answering(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "nope" } })),
      answering(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "0x1" })),
      answering(JSON.stringify({ jsonrpc: "2.0", id: 1 })),
      answering("not json"),
      answering(null),
      answering(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), 500),
      rpcClient(url, {
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ]) {
      const call = rpc.call("eth_chainId", []);
      await expect(call).rejects.toThrow(RpcError);
      await expect(call).rejects.not.toThrow("secret-key");
    }
  });

  test("stops reading an answer past the size limit", async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1 << 20;
        controller.enqueue(new Uint8Array(1 << 20));
      },
    });
    await expect(answering(endless).call("eth_getProof", [])).rejects.toThrow(
      "past the size limit",
    );
    expect(sent).toBeLessThanOrEqual(MAX_RPC_ANSWER + 2 * (1 << 20));
  });
});

describe("proofNodes", () => {
  const header = {
    hash: new Uint8Array(32),
    parentHash: new Uint8Array(32),
    stateRoot: new Uint8Array(32),
    number: 7n,
    timestamp: 0n,
  };
  const anchor = new Uint8Array(20).fill(1);
  const answering = (accountProof: unknown[]) => ({
    call: async () => ({ accountProof, storageProof: [{ proof: ["0xc0"] }] }),
  });

  test("keeps every node of every request, 256 slots a request", async () => {
    const requests: unknown[][] = [];
    const rpc = {
      call: async (_: string, params: readonly unknown[]) => {
        requests.push(params[1] as unknown[]);
        return { accountProof: ["0x80"], storageProof: [{ proof: ["0xc0"] }] };
      },
    };
    const slots = Array.from({ length: PROOF_SLOTS_PER_REQUEST + 1 }, () => new Uint8Array(32));
    const nodes = await proofNodes(rpc, anchor, header, slots);
    expect(requests.map((r) => r.length)).toEqual([PROOF_SLOTS_PER_REQUEST, 1]);
    expect(nodes.map(hex)).toEqual(["0x80", "0xc0", "0x80", "0xc0"]);
  });

  test("refuses an empty node, which no trie holds", async () => {
    await expect(
      proofNodes(answering(["0x"]), anchor, header, [new Uint8Array(32)]),
    ).rejects.toThrow(RpcError);
  });

  test("counts each node's overhead against the budget, so tiny nodes can't flood it", async () => {
    const many = Array.from({ length: 100 }, () => "0x80");
    const budget = 100 * (1 + PROOF_NODE_OVERHEAD);
    await expect(
      proofNodes(answering(many), anchor, header, [new Uint8Array(32)], budget),
    ).rejects.toThrow("proofs past the size limit");
    expect(
      await proofNodes(answering(many.slice(1)), anchor, header, [new Uint8Array(32)], budget),
    ).toHaveLength(100);
  });
});
