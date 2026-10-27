import { describe, expect, test } from "vite-plus/test";
import { REGISTRY_SYNC_ENV, registrySyncFromEnv } from "../src/index.ts";

// The registry sync's configuration (P3-5 parts 3a and 3b): all of it or
// none, and no URL quoted in an error, since each can carry a secret.

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const SECRET = "s3cret-password";

const full = {
  REGISTRY_SYNC_INDEX_URL: `postgres://reader:${SECRET}@127.0.0.1:5432/abolish`,
  REGISTRY_SYNC_INDEX_SCHEMA: "indexer",
  REGISTRY_SYNC_L2_RPC_URL: "https://l2.example/rpc/key",
  REGISTRY_SYNC_CHAIN_ID: "84532",
  REGISTRY_SYNC_L1_RPC_URL: "https://l1.example/rpc/key",
  REGISTRY_SYNC_L1_CHAIN_ID: "11155111",
  REGISTRY_SYNC_PORTAL: address(0x20),
  REGISTRY_SYNC_ELECTION_REGISTRY: address(0x10),
  REGISTRY_SYNC_TRUSTEE_REGISTRY: address(0x11),
  REGISTRY_SYNC_GROUP_REGISTRY: address(0x12),
  REGISTRY_SYNC_BOARD: address(0x13),
  REGISTRY_SYNC_EVENT_VERSION: "12",
};

const refusal = (env: Record<string, string>) => {
  try {
    registrySyncFromEnv(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("the registry sync's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(registrySyncFromEnv({})).toBeUndefined();
    expect(registrySyncFromEnv({ REGISTRY_SYNC_BOARD: "" })).toBeUndefined();
  });

  test("reads every variable", () => {
    expect(registrySyncFromEnv(full)).toEqual({
      indexUrl: full.REGISTRY_SYNC_INDEX_URL,
      indexSchema: "indexer",
      l2RpcUrl: "https://l2.example/rpc/key",
      chainId: 84532n,
      l1RpcUrl: "https://l1.example/rpc/key",
      l1ChainId: 11155111n,
      portal: "0x0000000000000000000000000000000000000020",
      electionRegistry: "0x0000000000000000000000000000000000000010",
      trusteeRegistry: "0x0000000000000000000000000000000000000011",
      groupRegistry: "0x0000000000000000000000000000000000000012",
      board: "0x0000000000000000000000000000000000000013",
      eventVersion: 12,
    });
  });

  test("refuses some without the rest", () => {
    for (const name of REGISTRY_SYNC_ENV) {
      const { [name]: _, ...rest } = full;
      expect(refusal(rest)).toContain("needs every one of");
    }
  });

  test("names a malformed variable without quoting it", () => {
    const cases: [Partial<typeof full>, string][] = [
      [
        { REGISTRY_SYNC_INDEX_URL: `mysql://reader:${SECRET}@db/abolish` },
        "REGISTRY_SYNC_INDEX_URL",
      ],
      [{ REGISTRY_SYNC_L2_RPC_URL: `ws://l2.example/${SECRET}` }, "REGISTRY_SYNC_L2_RPC_URL"],
      [{ REGISTRY_SYNC_INDEX_SCHEMA: `x"; drop schema public; --` }, "REGISTRY_SYNC_INDEX_SCHEMA"],
      [{ REGISTRY_SYNC_CHAIN_ID: "0" }, "REGISTRY_SYNC_CHAIN_ID"],
      [{ REGISTRY_SYNC_CHAIN_ID: (1n << 64n).toString() }, "REGISTRY_SYNC_CHAIN_ID"],
      [{ REGISTRY_SYNC_L1_RPC_URL: `ws://l1.example/${SECRET}` }, "REGISTRY_SYNC_L1_RPC_URL"],
      [{ REGISTRY_SYNC_L1_CHAIN_ID: "01" }, "REGISTRY_SYNC_L1_CHAIN_ID"],
      [{ REGISTRY_SYNC_PORTAL: "0x1234" }, "REGISTRY_SYNC_PORTAL"],
      [{ REGISTRY_SYNC_BOARD: "0x1234" }, "REGISTRY_SYNC_BOARD"],
      [{ REGISTRY_SYNC_EVENT_VERSION: "13" }, "REGISTRY_SYNC_EVENT_VERSION"],
    ];
    for (const [change, name] of cases) {
      const message = refusal({ ...full, ...change });
      expect(message).toBe(`malformed ${name}`);
      expect(message).not.toContain(SECRET);
    }
  });

  test("refuses two contracts at one address", () => {
    expect(refusal({ ...full, REGISTRY_SYNC_BOARD: address(0x10) })).toContain("distinct");
  });
});
