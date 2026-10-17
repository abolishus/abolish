import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { readEnv } from "../src/env.ts";

const numRuns = Number(process.env.FC_NUM_RUNS ?? 100);

const good = {
  INDEXER_CHAIN_ID: "84532",
  INDEXER_RPC_URL: "https://sepolia.base.org",
  ELECTION_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000000Aa",
  ELECTION_REGISTRY_START_BLOCK: "10",
  TRUSTEE_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000000Ac",
  TRUSTEE_REGISTRY_START_BLOCK: "9",
  GROUP_REGISTRY_ADDRESS: "0x00000000000000000000000000000000000000Ab",
  GROUP_REGISTRY_START_BLOCK: "0",
  BOARD_ADDRESS: "0x00000000000000000000000000000000000000Ad",
  BOARD_START_BLOCK: "11",
};

const PREFIXES = ["ELECTION_REGISTRY", "TRUSTEE_REGISTRY", "GROUP_REGISTRY", "BOARD"];

describe("readEnv", () => {
  test("reads a well-formed deployment, lowercasing the addresses", () => {
    expect(readEnv(good)).toEqual({
      chainId: 84532,
      rpcUrl: "https://sepolia.base.org",
      contracts: {
        ElectionRegistry: { address: "0x00000000000000000000000000000000000000aa", startBlock: 10 },
        TrusteeRegistry: { address: "0x00000000000000000000000000000000000000ac", startBlock: 9 },
        GroupRegistry: { address: "0x00000000000000000000000000000000000000ab", startBlock: 0 },
        Board: { address: "0x00000000000000000000000000000000000000ad", startBlock: 11 },
      },
    });
  });

  test("refuses one address under two names, in any letter case", () => {
    for (const [i, a] of PREFIXES.entries())
      for (const b of PREFIXES.slice(i + 1))
        expect(() =>
          readEnv({
            ...good,
            [`${b}_ADDRESS`]: good[`${a}_ADDRESS` as keyof typeof good].toLowerCase(),
          }),
        ).toThrow("distinct");
  });

  test.each(Object.keys(good))("refuses a deployment without %s", (name) => {
    expect(() => readEnv({ ...good, [name]: undefined })).toThrow(`${name} is required`);
    expect(() => readEnv({ ...good, [name]: "" })).toThrow(`${name} is required`);
  });

  test("refuses anything but plain decimal integers for the chain ID and start block", () => {
    for (const bad of ["0x10", "1e3", " 7", "7 ", "-1", "01", "1.0", "9007199254740993"]) {
      for (const prefix of PREFIXES)
        expect(() => readEnv({ ...good, [`${prefix}_START_BLOCK`]: bad })).toThrow(
          `${prefix}_START_BLOCK`,
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
        const read = readEnv({ ...good, BOARD_START_BLOCK: String(n) });
        expect(read.contracts.Board.startBlock).toBe(n);
      }),
      { numRuns },
    );
  });

  test("accepts an address only as 0x and exactly 40 hex digits", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 50 }), (s) => {
        const ok = /^0x[0-9a-fA-F]{40}$/.test(s);
        const read = () => readEnv({ ...good, GROUP_REGISTRY_ADDRESS: s });
        if (ok) expect(read().contracts.GroupRegistry.address).toBe(s.toLowerCase());
        else expect(read).toThrow();
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 24 }), (b) => {
        const s = `0x${Buffer.from(b).toString("hex")}`;
        const read = () => readEnv({ ...good, GROUP_REGISTRY_ADDRESS: s });
        if (b.length === 20) expect(read().contracts.GroupRegistry.address).toBe(s);
        else expect(read).toThrow("GROUP_REGISTRY_ADDRESS");
      }),
      { numRuns },
    );
  });
});
