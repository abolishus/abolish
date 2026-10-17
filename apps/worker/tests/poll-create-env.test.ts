import { describe, expect, test } from "vite-plus/test";
import { POLL_CREATE_ENV, pollCreationFromEnv } from "../src/index.ts";

// The creation step's configuration (ADR 0032, rules 1 and 18; P2-22 part
// 3a): all of it or none, the ceiling optional, and neither the key nor the
// URL ever in an error (T-65, T-72).

const KEY = "c7".repeat(32);
const SECRET_URL = "https://l2.example/v2/provider-api-key";

const full = {
  CREATE_L2_RPC_URL: SECRET_URL,
  CREATE_CHAIN_ID: "84532",
  CREATE_REGISTRY: "0x00000000000000000000000000000000000000e1",
  CREATE_KEY: KEY,
};

const refusal = (env: Record<string, string>) => {
  try {
    pollCreationFromEnv(env, 200);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("accepted");
};

describe("the creation step's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(pollCreationFromEnv({}, 200)).toBeUndefined();
    expect(pollCreationFromEnv({ CREATE_KEY: "" }, 200)).toBeUndefined();
  });

  test("reads every variable, the ceiling defaulting", () => {
    expect(pollCreationFromEnv(full, 200)).toEqual({
      l2RpcUrl: SECRET_URL,
      chainId: 84532n,
      registry: "0x00000000000000000000000000000000000000e1",
      key: Uint8Array.from(Buffer.from(KEY, "hex")),
      dailyCeiling: 200,
    });
    expect(
      pollCreationFromEnv({ ...full, CREATE_KEY: `0x${KEY}`, CREATE_DAILY_CEILING: "0" }, 200),
    ).toMatchObject({ key: Uint8Array.from(Buffer.from(KEY, "hex")), dailyCeiling: 0 });
  });

  test("refuses a partial configuration, or a ceiling alone", () => {
    for (const name of POLL_CREATE_ENV) {
      const { [name]: _, ...rest } = full;
      expect(refusal(rest)).toMatch(/needs every one of/);
    }
    expect(refusal({ CREATE_DAILY_CEILING: "10" })).toMatch(/needs the creation step/);
  });

  test("refuses a malformed value, naming it and quoting no secret", () => {
    for (const [env, name] of [
      [{ ...full, CREATE_L2_RPC_URL: "ftp://l2.example/provider-api-key" }, "CREATE_L2_RPC_URL"],
      [{ ...full, CREATE_CHAIN_ID: "0" }, "CREATE_CHAIN_ID"],
      [{ ...full, CREATE_CHAIN_ID: "9007199254740992" }, "CREATE_CHAIN_ID"],
      [{ ...full, CREATE_REGISTRY: "0x1234" }, "CREATE_REGISTRY"],
      [{ ...full, CREATE_DAILY_CEILING: "-1" }, "CREATE_DAILY_CEILING"],
      [{ ...full, CREATE_KEY: `${KEY}00` }, "CREATE_KEY"],
      [{ ...full, CREATE_KEY: KEY.replace("c7", "zz") }, "CREATE_KEY"],
    ] as const) {
      const message = refusal(env);
      expect(message).toContain(name);
      expect(message).not.toContain("provider-api-key");
      expect(message).not.toContain("c7c7");
    }
  });
});
