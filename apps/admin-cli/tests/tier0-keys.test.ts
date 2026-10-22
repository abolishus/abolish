import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTier0IssuerKeys } from "@abolishus/core";
import { TOKEN_KEY_PERIOD, tier0TokenKeyId } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { run } from "../src/index.ts";
import { keyFile } from "../src/tier0-keys.ts";

// The issuer's keys are made offline: this connection throws if a command opens the database.
const noDatabase = () => {
  throw new Error("a tier0-keys command opened the database");
};

async function cli(...argv: string[]) {
  const out: Record<string, unknown>[] = [];
  const err: Record<string, unknown>[] = [];
  const code = await run(argv, noDatabase, {
    out: (v) => out.push(JSON.parse(JSON.stringify(v))),
    err: (v) => err.push(JSON.parse(JSON.stringify(v))),
  });
  return { code, out, err };
}

const iso = (s: number) => new Date(s * 1000).toISOString();
const Q = Math.floor(Date.now() / 1000 / TOKEN_KEY_PERIOD);

describe("tier0-keys period", () => {
  test("prints the current period's times", async () => {
    const r = await cli("tier0-keys", "period");
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      {
        period: Q,
        starts: iso(Q * TOKEN_KEY_PERIOD),
        ends: iso((Q + 1) * TOKEN_KEY_PERIOD),
        redeemsUntil: iso((Q + 2) * TOKEN_KEY_PERIOD),
      },
    ]);
  });

  test("prints the period of --at, its first and last second included", async () => {
    for (const [at, q] of [
      [iso(0), 0],
      [iso(TOKEN_KEY_PERIOD - 1), 0],
      [iso(TOKEN_KEY_PERIOD), 1],
      ["2026-10-22T16:00:00Z", 691],
    ] as const) {
      const r = await cli("tier0-keys", "period", "--at", at);
      expect(r.out[0]?.["period"], at).toBe(q);
    }
  });

  test("refuses an --at that isn't a time from 1970 on", async () => {
    for (const at of ["soon", "1969-12-31T23:59:59Z"]) {
      const r = await cli("tier0-keys", "period", "--at", at);
      expect(r.code).toBe(2);
      expect(r.err[0]?.["error"]).toBe("usage");
    }
  });
});

describe("tier0-keys generate", () => {
  test("writes each period's entry to its own owner-only file and prints only public values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tier0-keys-"));
    const r = await cli(
      "tier0-keys",
      "generate",
      "--from",
      `${Q + 1}`,
      "--count",
      "3",
      "--dir",
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(
      [Q + 1, Q + 2, Q + 3].map((q) => `tier0-key-${q}.txt`).sort(),
    );
    const entries = [Q + 1, Q + 2, Q + 3].map((q) => readFileSync(keyFile(dir, q), "utf8"));
    for (const q of [Q + 1, Q + 2, Q + 3])
      expect(statSync(keyFile(dir, q)).mode & 0o777).toBe(0o600);
    // Joined with commas, the files are TIER0_ISSUER_KEYS as apps/web reads it.
    const keys = parseTier0IssuerKeys(entries.join(","));
    expect(r.out).toEqual(
      keys.keys.map((k) => ({
        period: k.period,
        starts: iso(k.period * TOKEN_KEY_PERIOD),
        ends: iso((k.period + 1) * TOKEN_KEY_PERIOD),
        redeemsUntil: iso((k.period + 2) * TOKEN_KEY_PERIOD),
        publicKey: Buffer.from(k.publicKey).toString("hex"),
        keyId: Buffer.from(tier0TokenKeyId(k.period, k.publicKey)).toString("hex"),
      })),
    );
    const printed = JSON.stringify(r.out);
    for (const e of entries) expect(printed).not.toContain(e.split(":")[1]);
  });

  test("makes the current period's key, for the first release", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tier0-keys-"));
    const r = await cli("tier0-keys", "generate", "--from", `${Q}`, "--count", "1", "--dir", dir);
    expect(r.code).toBe(0);
    expect(r.out[0]?.["period"]).toBe(Q);
  });

  test("never makes a second key for a period, nor any key of the run (T-74)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tier0-keys-"));
    writeFileSync(keyFile(dir, Q + 3), "kept");
    const r = await cli(
      "tier0-keys",
      "generate",
      "--from",
      `${Q + 1}`,
      "--count",
      "3",
      "--dir",
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.err).toEqual([{ error: "key-exists" }]);
    expect(r.out).toEqual([]);
    expect(readdirSync(dir)).toEqual([`tier0-key-${Q + 3}.txt`]);
    expect(readFileSync(keyFile(dir, Q + 3), "utf8")).toBe("kept");
  });

  test("refuses a period that has begun, which a release could list only late", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tier0-keys-"));
    const r = await cli(
      "tier0-keys",
      "generate",
      "--from",
      `${Q - 1}`,
      "--count",
      "2",
      "--dir",
      dir,
    );
    expect(r).toMatchObject({ code: 1, err: [{ error: "period-started" }] });
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses a directory that doesn't exist", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "tier0-keys-")), "absent");
    const r = await cli("tier0-keys", "generate", "--from", `${Q}`, "--count", "1", "--dir", dir);
    expect(r).toMatchObject({ code: 1, err: [{ error: "no-directory" }] });
  });

  test("refuses malformed arguments before writing anything", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tier0-keys-"));
    for (const args of [
      ["--count", "1", "--dir", dir],
      ["--from", `${Q}`, "--dir", dir],
      ["--from", `${Q}`, "--count", "1"],
      ["--from", `${Q}`, "--count", "0", "--dir", dir],
      ["--from", `${Q}`, "--count", "17", "--dir", dir],
      ["--from", `0${Q}`, "--count", "1", "--dir", dir],
      ["--from", `${Q}.5`, "--count", "1", "--dir", dir],
      ["--from", "4294967296", "--count", "1", "--dir", dir],
      ["--from", "4294967295", "--count", "1", "--dir", dir],
    ]) {
      const r = await cli("tier0-keys", "generate", ...args);
      expect(r.code, args.join(" ")).toBe(2);
    }
    expect(readdirSync(dir)).toEqual([]);
  });
});
