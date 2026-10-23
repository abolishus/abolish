import { describe, expect, test } from "vite-plus/test";
import { POSTING_ENV, postingFromEnv } from "../src/index.ts";

// The posting worker's configuration (P2-8 part 2b-2b-2b-2b-2): all of it or
// none, and neither the posting key's value nor a URL ever in an error
// (T-69).

const POSTING_KEY = "bb".repeat(32);
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const full = {
  POSTING_REDIS_URL: "redis://:store-password@posting-store:6379",
  POSTING_L2_RPC_URL: "https://l2.example/v2/provider-api-key",
  POSTING_CHAIN_ID: "84532",
  POSTING_BOARD: address(0xb0),
  POSTING_BOARD_BLOCK: "1234",
  POSTING_KEY: `0x${POSTING_KEY}`,
  POSTING_FEE_CAP: "1000000000",
  POSTING_ELECTION_BUDGET: "50000000000000000",
  POSTING_L1_RPC_URL: "https://l1.example/v2/provider-api-key",
  POSTING_L1_FEE_CAP: "30000000000",
};

const refusal = (env: Record<string, string>) => {
  try {
    postingFromEnv(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("the posting worker's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(postingFromEnv({})).toBeUndefined();
    expect(postingFromEnv({ POSTING_CHAIN_ID: "" })).toBeUndefined();
  });

  test("reads every variable", () => {
    const c = postingFromEnv(full);
    expect(c).toMatchObject({
      redisUrl: full.POSTING_REDIS_URL,
      l2RpcUrl: full.POSTING_L2_RPC_URL,
      chainId: 84532n,
      board: "0x00000000000000000000000000000000000000B0",
      boardBlock: 1234n,
      feeCap: 1_000_000_000n,
      budget: 50_000_000_000_000_000n,
      l1RpcUrl: full.POSTING_L1_RPC_URL,
      l1FeeCap: 30_000_000_000n,
    });
    expect(Buffer.from(c?.key ?? []).toString("hex")).toBe(POSTING_KEY);
    expect(Buffer.from(postingFromEnv({ ...full, POSTING_KEY })?.key ?? []).toString("hex")).toBe(
      POSTING_KEY,
    );
    // A budget of nothing is a relay that refuses every pair `budget`.
    expect(postingFromEnv({ ...full, POSTING_ELECTION_BUDGET: "0" })?.budget).toBe(0n);
  });

  test("refuses a partial configuration, naming every variable", () => {
    for (const name of POSTING_ENV) {
      const { [name]: _, ...partial } = full;
      expect(refusal(partial)).toBe(
        `the posting worker needs every one of ${POSTING_ENV.join(", ")}`,
      );
    }
  });

  test("refuses each malformed public value by name, quoting no URL", () => {
    const cases: [Partial<typeof full>, string][] = [
      [
        { POSTING_REDIS_URL: "https://:store-password@posting-store" },
        "malformed POSTING_REDIS_URL",
      ],
      [
        { POSTING_L2_RPC_URL: "ws://l2.example/v2/provider-api-key" },
        "malformed POSTING_L2_RPC_URL",
      ],
      [{ POSTING_CHAIN_ID: "0" }, "malformed POSTING_CHAIN_ID"],
      [{ POSTING_CHAIN_ID: "01" }, "malformed POSTING_CHAIN_ID"],
      [{ POSTING_CHAIN_ID: String(Number.MAX_SAFE_INTEGER + 1) }, "malformed POSTING_CHAIN_ID"],
      [{ POSTING_BOARD: "0xb0" }, "malformed POSTING_BOARD"],
      [{ POSTING_BOARD_BLOCK: "1e3" }, "malformed POSTING_BOARD_BLOCK"],
      [{ POSTING_BOARD_BLOCK: (2n ** 64n).toString() }, "malformed POSTING_BOARD_BLOCK"],
      [{ POSTING_FEE_CAP: "0" }, "malformed POSTING_FEE_CAP"],
      [{ POSTING_FEE_CAP: "1gwei" }, "malformed POSTING_FEE_CAP"],
      [{ POSTING_FEE_CAP: (2n ** 128n).toString() }, "malformed POSTING_FEE_CAP"],
      [{ POSTING_ELECTION_BUDGET: "-1" }, "malformed POSTING_ELECTION_BUDGET"],
      [{ POSTING_ELECTION_BUDGET: "0.05" }, "malformed POSTING_ELECTION_BUDGET"],
      [{ POSTING_ELECTION_BUDGET: (2n ** 128n).toString() }, "malformed POSTING_ELECTION_BUDGET"],
      [
        { POSTING_L1_RPC_URL: "ws://l1.example/v2/provider-api-key" },
        "malformed POSTING_L1_RPC_URL",
      ],
      [{ POSTING_L1_FEE_CAP: "0" }, "malformed POSTING_L1_FEE_CAP"],
      // A cancellation pays up to twice it, which must stay within a u128.
      [{ POSTING_L1_FEE_CAP: (2n ** 127n).toString() }, "malformed POSTING_L1_FEE_CAP"],
    ];
    for (const [change, message] of cases) {
      const got = refusal({ ...full, ...change });
      expect(got).toBe(message);
      expect(got).not.toContain("provider-api-key");
      expect(got).not.toContain("store-password");
    }
  });

  test("never quotes a malformed key", () => {
    for (const secret of [
      POSTING_KEY.slice(2),
      `${POSTING_KEY}00`,
      `${POSTING_KEY.slice(2)}zz`,
      `0x${POSTING_KEY.slice(4)}`,
    ]) {
      const message = refusal({ ...full, POSTING_KEY: secret });
      expect(message).toBe("POSTING_KEY holds a malformed key");
      expect(message).not.toContain(secret);
    }
  });
});
