import { describe, expect, test } from "vite-plus/test";
import { TIER0_ENV, tier0FromEnv } from "../src/index.ts";

// The Tier 0 job's configuration (P3-2 part 4d-2b-2b): all of it or none, and
// a key's value never in an error (T-69).

const KEY_1 = "11".repeat(32);
const KEY_3 = `0x${"33".repeat(32)}`;
const ACCOUNT_KEY = "aa".repeat(32);
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const full = {
  TIER0_L2_RPC_URL: "http://127.0.0.1:8545",
  TIER0_BUNDLER_URL: "https://bundler.example/rpc",
  TIER0_CHAIN_ID: "421614",
  TIER0_GROUP: "0",
  TIER0_REGISTRY: address(0x10),
  TIER0_REGISTRY_BLOCK: "1234",
  TIER0_REGISTRARS: [address(1), address(2), address(3)].join(","),
  TIER0_THRESHOLD: "2",
  TIER0_SIGNER_KEYS: `1:${KEY_1},3:${KEY_3}`,
  TIER0_ENTRY_POINT: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108",
  TIER0_ACCOUNT: address(0x20),
  TIER0_ACCOUNT_KEY: ACCOUNT_KEY,
  TIER0_PAYMASTER: address(0x30),
};

const refusal = (env: Record<string, string>) => {
  try {
    tier0FromEnv(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("the Tier 0 job's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(tier0FromEnv({})).toBeUndefined();
    expect(tier0FromEnv({ TIER0_GROUP: "" })).toBeUndefined();
  });

  test("reads every variable", () => {
    const c = tier0FromEnv(full);
    expect(c).toMatchObject({
      l2RpcUrl: "http://127.0.0.1:8545",
      bundlerUrl: "https://bundler.example/rpc",
      chainId: 421614n,
      group: 0n,
      registry: "0x0000000000000000000000000000000000000010",
      registryBlock: 1234n,
      registrars: [address(1), address(2), address(3)],
      threshold: 2,
      entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
      account: "0x0000000000000000000000000000000000000020",
      paymaster: "0x0000000000000000000000000000000000000030",
    });
    expect(c?.signers.map((s) => [s.seat, Buffer.from(s.secretKey).toString("hex")])).toEqual([
      [1, KEY_1],
      [3, KEY_3.slice(2)],
    ]);
    expect(Buffer.from(c?.accountKey ?? []).toString("hex")).toBe(ACCOUNT_KEY);
  });

  test("refuses a partial configuration, naming every variable", () => {
    for (const name of TIER0_ENV) {
      const { [name]: _, ...partial } = full;
      expect(refusal(partial)).toBe(`the Tier 0 job needs every one of ${TIER0_ENV.join(", ")}`);
    }
  });

  test("refuses each malformed public value by name", () => {
    const cases: [Partial<typeof full>, string][] = [
      [{ TIER0_L2_RPC_URL: "ws://127.0.0.1:8545" }, "malformed TIER0_L2_RPC_URL"],
      [{ TIER0_BUNDLER_URL: "not a url" }, "malformed TIER0_BUNDLER_URL"],
      [{ TIER0_CHAIN_ID: "0" }, "malformed TIER0_CHAIN_ID"],
      [{ TIER0_CHAIN_ID: "01" }, "malformed TIER0_CHAIN_ID"],
      [{ TIER0_CHAIN_ID: String(Number.MAX_SAFE_INTEGER + 1) }, "malformed TIER0_CHAIN_ID"],
      [{ TIER0_GROUP: (2n ** 64n).toString() }, "malformed TIER0_GROUP"],
      [{ TIER0_GROUP: "-1" }, "malformed TIER0_GROUP"],
      [{ TIER0_REGISTRY: "0x10" }, "malformed TIER0_REGISTRY"],
      [{ TIER0_REGISTRY_BLOCK: "1e3" }, "malformed TIER0_REGISTRY_BLOCK"],
      [{ TIER0_REGISTRARS: `${address(1)},,${address(2)}` }, "malformed TIER0_REGISTRARS"],
      [{ TIER0_THRESHOLD: "0" }, "malformed TIER0_THRESHOLD"],
      [{ TIER0_THRESHOLD: "1.5" }, "malformed TIER0_THRESHOLD"],
      [{ TIER0_THRESHOLD: "0x2" }, "malformed TIER0_THRESHOLD"],
      [{ TIER0_THRESHOLD: "2e0" }, "malformed TIER0_THRESHOLD"],
      [{ TIER0_THRESHOLD: " 2" }, "malformed TIER0_THRESHOLD"],
      [{ TIER0_ENTRY_POINT: "entrypoint" }, "malformed TIER0_ENTRY_POINT"],
      [{ TIER0_ACCOUNT: address(1).slice(0, 41) }, "malformed TIER0_ACCOUNT"],
      [{ TIER0_PAYMASTER: "" }, "the Tier 0 job needs every one of " + TIER0_ENV.join(", ")],
    ];
    for (const [change, message] of cases) expect(refusal({ ...full, ...change })).toBe(message);
  });

  test("refuses signer keys that don't fit the registrars and threshold", () => {
    const cases: [string, string][] = [
      [`1:${KEY_1}`, "TIER0_SIGNER_KEYS must hold exactly TIER0_THRESHOLD keys"],
      [`3:${KEY_3},1:${KEY_1}`, "TIER0_SIGNER_KEYS must list seats in ascending order"],
      [`1:${KEY_1},1:${KEY_1}`, "TIER0_SIGNER_KEYS must list seats in ascending order"],
      [`0:${KEY_1},3:${KEY_3}`, "TIER0_SIGNER_KEYS names a seat outside the registrars"],
      [`1:${KEY_1},4:${KEY_3}`, "TIER0_SIGNER_KEYS names a seat outside the registrars"],
      [`${KEY_1},3:${KEY_3}`, "TIER0_SIGNER_KEYS names a seat outside the registrars"],
    ];
    for (const [keys, message] of cases)
      expect(refusal({ ...full, TIER0_SIGNER_KEYS: keys })).toBe(message);
    expect(refusal({ ...full, TIER0_THRESHOLD: "4", TIER0_SIGNER_KEYS: `1:${KEY_1}` })).toBe(
      "TIER0_THRESHOLD is above the number of registrars",
    );
  });

  test("never quotes a malformed key", () => {
    const secrets = [KEY_1.slice(2), `${KEY_1}00`, `${KEY_1.slice(2)}zz`, `0x${KEY_1.slice(4)}`];
    for (const secret of secrets) {
      for (const env of [
        { ...full, TIER0_SIGNER_KEYS: `1:${secret},3:${KEY_3}` },
        { ...full, TIER0_ACCOUNT_KEY: secret },
      ]) {
        const message = refusal(env);
        expect(message).toMatch(/^TIER0_(SIGNER|ACCOUNT)_KEYS? holds a malformed key$/);
        expect(message).not.toContain(secret);
      }
    }
  });
});
