import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { ARCHIVE_ENV, ARCHIVE_EVERY_MS, archiveFromEnv } from "../src/index.ts";

// The archive's configuration (P4-3 part 4b-2b-2b-1): all of it or none, a
// wallet Arweave takes, a cap on each upload's reward, and neither the
// node's URL nor the wallet ever in an error (T-52).

const jwk = generateKeyPairSync("rsa", { modulusLength: 4096 }).privateKey.export({
  format: "jwk",
});
const WALLET = JSON.stringify(jwk);
const URL_KEY = "secret-provider-key";

const full = {
  ARCHIVE_ARWEAVE_URL: `https://arweave.example/${URL_KEY}`,
  ARCHIVE_WALLET: WALLET,
  ARCHIVE_MAX_REWARD: "5000000000",
};

const refusal = (env: Record<string, string>) => {
  try {
    archiveFromEnv(env);
  } catch (e) {
    const message = (e as Error).message;
    // Nothing secret is ever in the message.
    expect(message).not.toContain(URL_KEY);
    expect(message).not.toContain(jwk.d as string);
    expect(message).not.toContain((jwk.d as string).slice(0, 16));
    return message;
  }
  throw new Error("accepted");
};

describe("the archive's configuration", () => {
  test("is absent when no variable is set, empty ones included", () => {
    expect(archiveFromEnv({})).toBeUndefined();
    expect(archiveFromEnv({ ARCHIVE_WALLET: "" })).toBeUndefined();
  });

  test("reads every variable, with a ten-minute schedule by default", () => {
    const c = archiveFromEnv(full);
    expect(c?.node.href).toBe(`https://arweave.example/${URL_KEY}`);
    expect(c?.maxReward).toBe(5_000_000_000n);
    expect(c?.everyMs).toBe(ARCHIVE_EVERY_MS);
    expect(Buffer.from(c!.wallet.owner).toString("base64url")).toBe(jwk.n);
    expect(archiveFromEnv({ ...full, ARCHIVE_EVERY_MS: "60000" })?.everyMs).toBe(60_000);
    expect(archiveFromEnv({ ...full, ARCHIVE_EVERY_MS: "" })?.everyMs).toBe(ARCHIVE_EVERY_MS);
  });

  test("needs every variable once any is set", () => {
    for (const name of ARCHIVE_ENV) {
      const { [name]: _, ...rest } = full;
      expect(refusal(rest)).toBe(`the archive needs every one of ${ARCHIVE_ENV.join(", ")}`);
      expect(refusal({ ...full, [name]: "" })).toMatch(/needs every one/);
    }
    expect(refusal({ ARCHIVE_EVERY_MS: "60000" })).toBe(
      "ARCHIVE_EVERY_MS needs the archive configured",
    );
  });

  test("refuses a node URL the verifier wouldn't take as a gateway, without quoting it", () => {
    for (const url of [
      `ftp://arweave.example/${URL_KEY}`,
      `https://user:${URL_KEY}@arweave.example`,
      `https://arweave.example/?key=${URL_KEY}`,
      `https://arweave.example/${URL_KEY}#`,
      `arweave.example/${URL_KEY}`,
    ])
      expect(refusal({ ...full, ARCHIVE_ARWEAVE_URL: url })).toBe("malformed ARCHIVE_ARWEAVE_URL");
  });

  test("refuses a wallet Arweave wouldn't take, without quoting it", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "jwk",
    });
    const { d: _, ...publicOnly } = jwk;
    expect(refusal({ ...full, ARCHIVE_WALLET: WALLET.slice(0, -1) })).toBe(
      "ARCHIVE_WALLET is not a JWK",
    );
    for (const wallet of [
      JSON.stringify(small),
      JSON.stringify(publicOnly),
      JSON.stringify({ ...jwk, n: small.n }),
      "{}",
      "null",
      "[]",
      '"text"',
    ])
      expect(refusal({ ...full, ARCHIVE_WALLET: wallet })).toBe(
        "ARCHIVE_WALLET is not a 4096-bit RSA private key with exponent 65537",
      );
  });

  test("refuses a reward cap that isn't a positive integer", () => {
    for (const reward of ["0", "-1", "01", "1.5", "1e9", "0x10", " 1", "1".repeat(31)])
      expect(refusal({ ...full, ARCHIVE_MAX_REWARD: reward })).toBe("malformed ARCHIVE_MAX_REWARD");
    expect(archiveFromEnv({ ...full, ARCHIVE_MAX_REWARD: "1" })?.maxReward).toBe(1n);
  });

  test("refuses a schedule under a minute or malformed", () => {
    for (const every of ["59999", "0", "-60000", "60000.5", "060000", "1".repeat(11)])
      expect(refusal({ ...full, ARCHIVE_EVERY_MS: every })).toBe("malformed ARCHIVE_EVERY_MS");
  });
});
