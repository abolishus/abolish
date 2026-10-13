import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { readEnv } from "../src/env.ts";

const numRuns = Number(process.env.FC_NUM_RUNS ?? 100);

const good = {
  INDEXER_CHAIN_ID: "84532",
  INDEXER_RPC_URL: "https://sepolia.base.org",
  GROUP_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000000Ab",
  GROUP_REGISTRY_START_BLOCK: "0",
};

describe("readEnv", () => {
  test("reads a well-formed deployment, lowercasing the address", () => {
    expect(readEnv(good)).toEqual({
      chainId: 84532,
      rpcUrl: "https://sepolia.base.org",
      groupRegistry: "0x00000000000000000000000000000000000000ab",
      startBlock: 0,
    });
  });

  test.each(Object.keys(good))("refuses a deployment without %s", (name) => {
    expect(() => readEnv({ ...good, [name]: undefined })).toThrow(`${name} is required`);
    expect(() => readEnv({ ...good, [name]: "" })).toThrow(`${name} is required`);
  });

  test("refuses anything but plain decimal integers for the chain ID and start block", () => {
    for (const bad of ["0x10", "1e3", " 7", "7 ", "-1", "01", "1.0", "9007199254740993"]) {
      expect(() => readEnv({ ...good, GROUP_REGISTRY_START_BLOCK: bad })).toThrow(
        "GROUP_REGISTRY_START_BLOCK",
      );
      expect(() => readEnv({ ...good, INDEXER_CHAIN_ID: bad })).toThrow("INDEXER_CHAIN_ID");
    }
    expect(() => readEnv({ ...good, INDEXER_CHAIN_ID: "0" })).toThrow("at least 1");
  });

  test("refuses an RPC endpoint that isn't an http or https URL", () => {
    for (const bad of ["sepolia.base.org", "ws://127.0.0.1:8545", "file:///etc/passwd"])
      expect(() => readEnv({ ...good, INDEXER_RPC_URL: bad })).toThrow("INDEXER_RPC_URL");
  });

  test("accepts every safe decimal start block and reads it back exactly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (n) => {
        expect(readEnv({ ...good, GROUP_REGISTRY_START_BLOCK: String(n) }).startBlock).toBe(n);
      }),
      { numRuns },
    );
  });

  test("accepts an address only as 0x and exactly 40 hex digits", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (s) => {
        const ok = /^0x[0-9a-fA-F]{40}$/.test(s);
        const read = () => readEnv({ ...good, GROUP_REGISTRY_ADDRESS: s });
        if (ok) expect(read().groupRegistry).toBe(s.toLowerCase());
        else expect(read).toThrow();
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 24 }), (b) => {
        const s = `0x${Buffer.from(b).toString("hex")}`;
        const read = () => readEnv({ ...good, GROUP_REGISTRY_ADDRESS: s });
        if (b.length === 20) expect(read().groupRegistry).toBe(s);
        else expect(read).toThrow("GROUP_REGISTRY_ADDRESS");
      }),
      { numRuns },
    );
  });
});
