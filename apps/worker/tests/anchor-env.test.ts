import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { ANCHOR_ENV, ANCHOR_EVERY_MS, anchorFromEnv } from "../src/index.ts";

// The anchoring runner's configuration (P4-1 part 2b-2b-1): all of it or
// none, a Safe record `checkAnchorSafeState` could pass, a schedule that
// tries every period, and no key's value ever in an error (T-49, T-69).

const OWNER_KEYS = ["aa".repeat(32), "bb".repeat(32)];
const EXECUTOR_KEY = "cc".repeat(32);
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (b: string) => `0x${b.repeat(32)}`;

const full = {
  ANCHOR_L1_RPC_URL: "http://127.0.0.1:8545",
  ANCHOR_CHAIN_ID: "11155111",
  ANCHOR_ADDRESS: address(0x10),
  ANCHOR_EPOCH: "1767225600",
  ANCHOR_PERIOD: "3600",
  ANCHOR_DEADLINE: "43200",
  ANCHOR_SAFE: address(0x20),
  ANCHOR_SAFE_BLOCK: "1234",
  ANCHOR_SAFE_PROXY_CODE_HASH: hash("1a"),
  ANCHOR_SAFE_SINGLETON: address(0x30),
  ANCHOR_SAFE_SINGLETON_CODE_HASH: hash("2B"),
  ANCHOR_SAFE_OWNERS: [address(1), address(2), address(3)].join(","),
  ANCHOR_SAFE_THRESHOLD: "2",
  ANCHOR_SAFE_FALLBACK_HANDLER: address(0),
  ANCHOR_OWNER_KEYS: OWNER_KEYS.map((k) => `0x${k}`).join(","),
  ANCHOR_EXECUTOR_KEY: EXECUTOR_KEY,
};

const refusal = (env: Record<string, string>) => {
  try {
    anchorFromEnv(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("accepted");
};

const hex = (b: Uint8Array | undefined) => Buffer.from(b ?? []).toString("hex");

describe("the anchoring runner's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(anchorFromEnv({})).toBeUndefined();
    expect(anchorFromEnv({ ANCHOR_SAFE: "" })).toBeUndefined();
  });

  test("reads every variable, with a five-minute schedule by default", () => {
    const c = anchorFromEnv(full);
    expect(c).toMatchObject({
      l1RpcUrl: "http://127.0.0.1:8545",
      chainId: 11_155_111n,
      anchor: "0x0000000000000000000000000000000000000010",
      clock: { epoch: 1_767_225_600n, period: 3600n, deadline: 43_200n },
      safe: {
        address: "0x0000000000000000000000000000000000000020",
        deploymentBlock: 1234n,
        proxyCodeHash: hash("1a"),
        singleton: "0x0000000000000000000000000000000000000030",
        singletonCodeHash: hash("2b"),
        owners: [address(1), address(2), address(3)],
        threshold: 2n,
        fallbackHandler: address(0),
      },
      everyMs: ANCHOR_EVERY_MS,
    });
    expect(c?.ownerKeys.map(hex)).toEqual(OWNER_KEYS);
    expect(hex(c?.executorKey)).toBe(EXECUTOR_KEY);
    expect(anchorFromEnv({ ...full, ANCHOR_EVERY_MS: "60000" })?.everyMs).toBe(60_000);
  });

  test("refuses a partial configuration, naming every variable", () => {
    for (const name of ANCHOR_ENV) {
      const { [name]: _, ...partial } = full;
      expect(refusal(partial)).toBe(
        `the anchoring runner needs every one of ${ANCHOR_ENV.join(", ")}`,
      );
    }
    expect(refusal({ ANCHOR_EVERY_MS: "60000" })).toBe(
      "ANCHOR_EVERY_MS needs the anchoring runner configured",
    );
  });

  test("refuses each malformed public value by name", () => {
    const cases: [Partial<typeof full> & { ANCHOR_EVERY_MS?: string }, string][] = [
      [{ ANCHOR_L1_RPC_URL: "ws://127.0.0.1:8545" }, "malformed ANCHOR_L1_RPC_URL"],
      [{ ANCHOR_CHAIN_ID: "0" }, "malformed ANCHOR_CHAIN_ID"],
      [{ ANCHOR_CHAIN_ID: "01" }, "malformed ANCHOR_CHAIN_ID"],
      [{ ANCHOR_CHAIN_ID: String(Number.MAX_SAFE_INTEGER + 1) }, "malformed ANCHOR_CHAIN_ID"],
      [{ ANCHOR_ADDRESS: "0x10" }, "malformed ANCHOR_ADDRESS"],
      [{ ANCHOR_EPOCH: (2n ** 64n).toString() }, "malformed ANCHOR_EPOCH"],
      [{ ANCHOR_PERIOD: "0" }, "malformed ANCHOR_PERIOD"],
      [{ ANCHOR_DEADLINE: "-1" }, "malformed ANCHOR_DEADLINE"],
      [{ ANCHOR_SAFE: "safe" }, "malformed ANCHOR_SAFE"],
      [{ ANCHOR_SAFE_BLOCK: "1e3" }, "malformed ANCHOR_SAFE_BLOCK"],
      [
        { ANCHOR_SAFE_PROXY_CODE_HASH: `0x${"1a".repeat(31)}` },
        "malformed ANCHOR_SAFE_PROXY_CODE_HASH",
      ],
      [{ ANCHOR_SAFE_SINGLETON: address(1).slice(0, 41) }, "malformed ANCHOR_SAFE_SINGLETON"],
      [
        { ANCHOR_SAFE_SINGLETON_CODE_HASH: "1a".repeat(32) },
        "malformed ANCHOR_SAFE_SINGLETON_CODE_HASH",
      ],
      [{ ANCHOR_SAFE_OWNERS: `${address(1)},,${address(2)}` }, "malformed ANCHOR_SAFE_OWNERS"],
      // A Safe of one owner is a single key, whatever its threshold.
      [{ ANCHOR_SAFE_OWNERS: address(1) }, "malformed ANCHOR_SAFE_OWNERS"],
      [{ ANCHOR_SAFE_THRESHOLD: "2e0" }, "malformed ANCHOR_SAFE_THRESHOLD"],
      [{ ANCHOR_SAFE_FALLBACK_HANDLER: "none" }, "malformed ANCHOR_SAFE_FALLBACK_HANDLER"],
      [{ ANCHOR_EVERY_MS: "59999" }, "malformed ANCHOR_EVERY_MS"],
      [{ ANCHOR_EVERY_MS: "1.5e5" }, "malformed ANCHOR_EVERY_MS"],
    ];
    for (const [change, message] of cases) expect(refusal({ ...full, ...change })).toBe(message);
  });

  test("refuses a Safe record no Safe could pass, and a schedule longer than the period or deadline", () => {
    expect(refusal({ ...full, ANCHOR_SAFE_OWNERS: [address(1), address(1)].join(",") })).toBe(
      "ANCHOR_SAFE_OWNERS repeats an owner",
    );
    // T-69: an owner written in another case is still the same owner.
    expect(
      refusal({
        ...full,
        ANCHOR_SAFE_OWNERS: [address(0xab), address(0xab).toUpperCase().replace("0X", "0x")].join(
          ",",
        ),
      }),
    ).toBe("ANCHOR_SAFE_OWNERS repeats an owner");
    for (const threshold of ["0", "1"])
      expect(refusal({ ...full, ANCHOR_SAFE_THRESHOLD: threshold })).toBe(
        "ANCHOR_SAFE_THRESHOLD is below 2",
      );
    expect(refusal({ ...full, ANCHOR_SAFE_THRESHOLD: "4" })).toBe(
      "ANCHOR_SAFE_THRESHOLD is above the number of owners",
    );
    expect(refusal({ ...full, ANCHOR_PERIOD: "60", ANCHOR_EVERY_MS: "60001" })).toBe(
      "ANCHOR_EVERY_MS is longer than the anchor's period",
    );
    expect(anchorFromEnv({ ...full, ANCHOR_PERIOD: "60", ANCHOR_EVERY_MS: "60000" })?.everyMs).toBe(
      60_000,
    );
    expect(refusal({ ...full, ANCHOR_DEADLINE: "60", ANCHOR_EVERY_MS: "60001" })).toBe(
      "ANCHOR_EVERY_MS is longer than the anchor's deadline",
    );
    expect(refusal({ ...full, ANCHOR_DEADLINE: "0", ANCHOR_EVERY_MS: "60000" })).toBe(
      "ANCHOR_EVERY_MS is longer than the anchor's deadline",
    );
    // The default schedule is longer than a one-minute period.
    expect(refusal({ ...full, ANCHOR_PERIOD: "60" })).toBe(
      "ANCHOR_EVERY_MS is longer than the anchor's period",
    );
  });

  test("refuses repeated owner keys", () => {
    expect(
      refusal({ ...full, ANCHOR_OWNER_KEYS: [OWNER_KEYS[0], `0x${OWNER_KEYS[0]}`].join(",") }),
    ).toBe("ANCHOR_OWNER_KEYS repeats a key");
  });

  test("never quotes a malformed key", () => {
    const [key] = OWNER_KEYS as [string];
    for (const secret of [key.slice(2), `${key}00`, `${key.slice(2)}zz`, `0x${key.slice(4)}`]) {
      for (const [name, value] of [
        ["ANCHOR_OWNER_KEYS", `${OWNER_KEYS[1]},${secret}`],
        ["ANCHOR_EXECUTOR_KEY", secret],
      ] as const) {
        const message = refusal({ ...full, [name]: value });
        expect(message).toBe(`${name} holds a malformed key`);
        expect(message).not.toContain(secret);
      }
    }
  });

  test("no refusal quotes any part of a key it was given", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^(0x)?[0-9a-fA-F]{60,68}$/), { minLength: 1, maxLength: 4 }),
        fc.stringMatching(/^(0x)?[0-9a-fA-Fz]{60,68}$/),
        (owners, executor) => {
          let message = "";
          try {
            anchorFromEnv({
              ...full,
              ANCHOR_OWNER_KEYS: owners.join(","),
              ANCHOR_EXECUTOR_KEY: executor,
            });
          } catch (e) {
            message = (e as Error).message;
          }
          // No 16 hex digits in a row: the shortest piece of a key worth
          // anything, and longer than any word a message uses.
          return !/[0-9a-fA-F]{16}/.test(message);
        },
      ),
      { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) },
    );
  });
});
