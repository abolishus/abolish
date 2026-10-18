import { readFileSync } from "node:fs";
import fc from "fast-check";
import { checkpointHash } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { expect, test } from "vite-plus/test";
import {
  anchorCalldata,
  checkpointFromLog,
  headerRlp,
  headers,
  type Log,
  word,
} from "../src/l1.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const asNumber = (b: Uint8Array) => Number(BigInt(`0x${hex(b)}`));

test("anchor calldata is the one encoding CanonicalCalldata accepts", () => {
  const selector = hex(keccak_256(new TextEncoder().encode("anchor(bytes,bytes)")).slice(0, 4));
  fc.assert(
    fc.property(
      fc.uint8Array({ maxLength: 400 }),
      fc.uint8Array({ maxLength: 200 }),
      (checkpoints, locator) => {
        const data = anchorCalldata(checkpoints, locator);
        const pad = (n: number) => Math.ceil(n / 32) * 32;
        expect(hex(data.slice(0, 4))).toBe(selector);
        const args = data.slice(4);
        expect(args.length).toBe(64 + 32 + pad(checkpoints.length) + 32 + pad(locator.length));
        const first = asNumber(args.slice(0, 32));
        const second = asNumber(args.slice(32, 64));
        expect(first).toBe(64);
        expect(second).toBe(64 + 32 + pad(checkpoints.length));
        expect(asNumber(args.slice(first, first + 32))).toBe(checkpoints.length);
        expect(args.slice(first + 32, first + 32 + checkpoints.length)).toEqual(checkpoints);
        expect(asNumber(args.slice(second, second + 32))).toBe(locator.length);
        expect(args.slice(second + 32, second + 32 + locator.length)).toEqual(locator);
        // Padding is zeros.
        expect(args.slice(first + 32 + checkpoints.length, second).every((x) => x === 0)).toBe(
          true,
        );
        expect(args.slice(second + 32 + locator.length).every((x) => x === 0)).toBe(true);
      },
    ),
    { numRuns },
  );
});

test("word is a 32-byte big-endian word and refuses what doesn't fit", () => {
  expect(hex(word(0x0102n))).toBe(`${"00".repeat(30)}0102`);
  expect(() => word(-1n)).toThrow(RangeError);
  expect(() => word(2n ** 256n)).toThrow(RangeError);
});

// A Prague block as Anvil 1.8.3 returned it, with the hash it reported.
const GENESIS = {
  hash: "0x64a89d859531ea7e9a27c3d5808669ad79b931c736cdc6d32f4387415ac47b3b",
  parentHash: `0x${"00".repeat(32)}`,
  sha3Uncles: "0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347",
  miner: `0x${"00".repeat(20)}`,
  stateRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
  transactionsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
  receiptsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
  logsBloom: `0x${"00".repeat(256)}`,
  difficulty: "0x0",
  number: "0x0",
  gasLimit: "0x1c9c380",
  gasUsed: "0x0",
  timestamp: "0x6acd3ce3",
  extraData: "0x",
  mixHash: `0x${"00".repeat(32)}`,
  nonce: "0x0000000000000000",
  baseFeePerGas: "0x3b9aca00",
  withdrawalsRoot: "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
  blobGasUsed: "0x0",
  excessBlobGas: "0x0",
  parentBeaconBlockRoot: `0x${"00".repeat(32)}`,
  requestsHash: "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  totalDifficulty: "0x0",
};

test("a header is rebuilt to the bytes its hash names", () => {
  expect(`0x${hex(keccak_256(headerRlp(GENESIS)))}`).toBe(GENESIS.hash);
});

test("a header that doesn't hash to the reported hash is refused", () => {
  expect(() => headerRlp({ ...GENESIS, timestamp: "0x6acd3ce4" })).toThrow(/doesn't hash/);
  // A field the node returns but the list doesn't know can't be dropped silently.
  const { requestsHash: _, ...pre } = GENESIS;
  expect(() => headerRlp(pre)).toThrow(/doesn't hash/);
});

test("the run of headers is every block from 0 to the head, each checked against its hash", async () => {
  const asked: unknown[] = [];
  const rpc = (block: Readonly<Record<string, unknown>>) => ({
    call: async <T>(method: string, params: readonly unknown[] = []): Promise<T> => {
      expect(method).toBe("eth_getBlockByNumber");
      asked.push(params[0]);
      return block as T;
    },
  });
  expect(await headers(rpc(GENESIS), 0n)).toEqual([headerRlp(GENESIS)]);
  expect(asked).toEqual(["0x0"]);
  asked.length = 0;
  await headers(rpc(GENESIS), 17n);
  expect(asked).toEqual(Array.from({ length: 18 }, (_, n) => `0x${n.toString(16)}`));
  await expect(headers(rpc({ ...GENESIS, timestamp: "0x6acd3ce4" }), 0n)).rejects.toThrow(
    /doesn't hash/,
  );
});

// docs/spec/vectors/board.json's checkpoints, with the hash the independent
// Python implementation published, as BoardAnchor logs them: the event's
// topics, then `size`, `head`, `root` and both CIDs, ABI-encoded.
const boardVectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/board.json", import.meta.url), "utf8"),
) as {
  readonly boards: readonly {
    readonly checkpoints: readonly Readonly<Record<string, string>>[];
  }[];
};
const topic0 = `0x${hex(
  keccak_256(
    new TextEncoder().encode(
      "CheckpointAnchored(bytes32,uint32,bytes32,uint64,bytes32,bytes32,bytes,bytes)",
    ),
  ),
)}`;
const w = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
function logOf(c: Readonly<Record<string, string>>): Log {
  const bytesArg = (h: string) => `${w(h.length / 2)}${h.padEnd(128, "0")}`;
  return {
    topics: [
      topic0,
      `0x${c["electionId"]}`,
      `0x${w(BigInt(c["segment"] as string))}`,
      `0x${c["hash"]}`,
    ],
    data: `0x${w(BigInt(c["size"] as string))}${c["head"]}${c["root"]}${w(0xa0)}${w(0x100)}${bytesArg(
      c["objectCid"] as string,
    )}${bytesArg(c["hashesCid"] as string)}`,
  };
}
const checkpoints = boardVectors.boards.flatMap((b) => b.checkpoints);

test("a CheckpointAnchored log gives the checkpoint whose hash it logs", () => {
  expect(checkpoints.length).toBeGreaterThan(0);
  for (const c of checkpoints) {
    const got = checkpointFromLog(logOf(c));
    expect(hex(checkpointHash(got))).toBe(c["hash"]);
    expect(got.segment).toBe(Number(c["segment"]));
    expect(hex(got.object_cid)).toBe(c["objectCid"]);
    expect(hex(got.hashes_cid)).toBe(c["hashesCid"]);
  }
});

test("a log in any other layout, of another event or with another hash is refused", () => {
  const c = checkpoints[0] as Readonly<Record<string, string>>;
  const log = logOf(c);
  fc.assert(
    fc.property(
      fc.nat({ max: log.data.length - 3 }),
      fc.integer({ min: 1, max: 15 }),
      (at, flip) => {
        // Any nibble changed in the data changes a field, a padding, an offset or a length.
        const i = 2 + at;
        const nibble = (parseInt(log.data[i] as string, 16) ^ flip).toString(16);
        const data = `${log.data.slice(0, i)}${nibble}${log.data.slice(i + 1)}`;
        expect(() => checkpointFromLog({ ...log, data })).toThrow();
      },
    ),
    { numRuns },
  );
  expect(() => checkpointFromLog({ ...log, data: `${log.data}00` })).toThrow();
  expect(() => checkpointFromLog({ ...log, data: log.data.slice(0, -64) })).toThrow();
  expect(() => checkpointFromLog({ ...log, topics: log.topics.slice(0, 3) })).toThrow();
  expect(() =>
    checkpointFromLog({ ...log, topics: [`0x${w(1)}`, ...log.topics.slice(1)] }),
  ).toThrow();
  expect(() =>
    checkpointFromLog({
      ...log,
      topics: [...log.topics.slice(0, 2), `0x${w(1n << 32n)}`, ...log.topics.slice(3)],
    }),
  ).toThrow();
});
