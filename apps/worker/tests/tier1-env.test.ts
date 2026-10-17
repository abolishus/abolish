import { describe, expect, test } from "vite-plus/test";
import { TIER1_ENV, tier1FromEnv } from "../src/index.ts";

// The Tier 1 relay's configuration (P3-3 part 3c-2b-2b): all of it or none,
// and the relay key's value never in an error (T-69).

const RELAY_KEY = "aa".repeat(32);
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const full = {
  TIER1_L2_RPC_URL: "http://127.0.0.1:8545",
  TIER1_CHAIN_ID: "84532",
  TIER1_GROUP: "1",
  TIER1_REGISTRY: address(0x10),
  TIER1_REGISTRY_BLOCK: "1234",
  TIER1_REGISTRARS: [address(1), address(2), address(3)].join(","),
  TIER1_THRESHOLD: "2",
  TIER1_EVENT_VERSION: "7",
  TIER1_RELAY_KEY: `0x${RELAY_KEY}`,
  TIER1_MAX_FEE_PER_GAS: "1000000000",
};

const refusal = (env: Record<string, string>) => {
  try {
    tier1FromEnv(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("the Tier 1 relay's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(tier1FromEnv({})).toBeUndefined();
    expect(tier1FromEnv({ TIER1_GROUP: "" })).toBeUndefined();
  });

  test("reads every variable", () => {
    const c = tier1FromEnv(full);
    expect(c).toMatchObject({
      l2RpcUrl: "http://127.0.0.1:8545",
      chainId: 84532n,
      group: 1n,
      registry: "0x0000000000000000000000000000000000000010",
      registryBlock: 1234n,
      registrars: [address(1), address(2), address(3)],
      threshold: 2,
      eventVersion: 7,
      maxFeePerGas: 1_000_000_000n,
    });
    expect(Buffer.from(c?.relayKey ?? []).toString("hex")).toBe(RELAY_KEY);
    expect(
      Buffer.from(tier1FromEnv({ ...full, TIER1_RELAY_KEY: RELAY_KEY })?.relayKey ?? []).toString(
        "hex",
      ),
    ).toBe(RELAY_KEY);
  });

  test("refuses a partial configuration, naming every variable", () => {
    for (const name of TIER1_ENV) {
      const { [name]: _, ...partial } = full;
      expect(refusal(partial)).toBe(`the Tier 1 relay needs every one of ${TIER1_ENV.join(", ")}`);
    }
  });

  test("refuses each malformed public value by name", () => {
    const cases: [Partial<typeof full>, string][] = [
      [{ TIER1_L2_RPC_URL: "ws://127.0.0.1:8545" }, "malformed TIER1_L2_RPC_URL"],
      [{ TIER1_CHAIN_ID: "0" }, "malformed TIER1_CHAIN_ID"],
      [{ TIER1_CHAIN_ID: "01" }, "malformed TIER1_CHAIN_ID"],
      [{ TIER1_CHAIN_ID: String(Number.MAX_SAFE_INTEGER + 1) }, "malformed TIER1_CHAIN_ID"],
      [{ TIER1_GROUP: (2n ** 64n).toString() }, "malformed TIER1_GROUP"],
      [{ TIER1_GROUP: "-1" }, "malformed TIER1_GROUP"],
      [{ TIER1_REGISTRY: "0x10" }, "malformed TIER1_REGISTRY"],
      [{ TIER1_REGISTRY_BLOCK: "1e3" }, "malformed TIER1_REGISTRY_BLOCK"],
      [{ TIER1_REGISTRARS: `${address(1)},,${address(2)}` }, "malformed TIER1_REGISTRARS"],
      [{ TIER1_THRESHOLD: "0" }, "malformed TIER1_THRESHOLD"],
      [{ TIER1_THRESHOLD: "2e0" }, "malformed TIER1_THRESHOLD"],
      // `Tier1MemberAdded` is named from version 6.
      [{ TIER1_EVENT_VERSION: "5" }, "malformed TIER1_EVENT_VERSION"],
      [{ TIER1_EVENT_VERSION: "9" }, "malformed TIER1_EVENT_VERSION"],
      [{ TIER1_MAX_FEE_PER_GAS: "0" }, "malformed TIER1_MAX_FEE_PER_GAS"],
      [{ TIER1_MAX_FEE_PER_GAS: "1gwei" }, "malformed TIER1_MAX_FEE_PER_GAS"],
      [{ TIER1_MAX_FEE_PER_GAS: (2n ** 128n).toString() }, "malformed TIER1_MAX_FEE_PER_GAS"],
    ];
    for (const [change, message] of cases) expect(refusal({ ...full, ...change })).toBe(message);
    expect(refusal({ ...full, TIER1_THRESHOLD: "4" })).toBe(
      "TIER1_THRESHOLD is above the number of registrars",
    );
  });

  test("never quotes a malformed key", () => {
    for (const secret of [
      RELAY_KEY.slice(2),
      `${RELAY_KEY}00`,
      `${RELAY_KEY.slice(2)}zz`,
      `0x${RELAY_KEY.slice(4)}`,
    ]) {
      const message = refusal({ ...full, TIER1_RELAY_KEY: secret });
      expect(message).toBe("TIER1_RELAY_KEY holds a malformed key");
      expect(message).not.toContain(secret);
    }
  });
});
