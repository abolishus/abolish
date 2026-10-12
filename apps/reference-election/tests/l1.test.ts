import fc from "fast-check";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { expect, test } from "vite-plus/test";
import { anchorCalldata, headerRlp, word } from "../src/l1.ts";

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
