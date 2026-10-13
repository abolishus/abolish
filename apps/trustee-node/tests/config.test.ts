import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelId } from "@abolishus/crypto";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { ConfigError, parseConfig, readIdentityKey } from "../src/config.ts";
import { panelOf } from "./fixture.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function config(change: Record<string, unknown> = {}) {
  const { panel } = panelOf(4, 3);
  return {
    panel: { threshold: panel.threshold, keys: panel.keys.map(hex) },
    panelId: hex(panelId(panel)),
    l2ChainId: "84532",
    trusteeRegistry: `0x${"a3".repeat(20)}`,
    seat: 2,
    identityKeyFile: "/etc/trustee-node/identity",
    store: "/var/lib/trustee-node",
    coordinator: "https://coordinator.example/",
    ...change,
  };
}

describe("the configuration", () => {
  test("pins the panel, the chain, the registry and the seat", () => {
    const c = config();
    const parsed = parseConfig(JSON.stringify(c));
    expect(parsed.panel.keys.map(hex)).toEqual(c.panel.keys);
    expect(parsed.l2ChainId).toBe(84532n);
    expect(hex(parsed.trusteeRegistry)).toBe("a3".repeat(20));
    expect(parsed.seat).toBe(2);
    expect(parsed.pollSeconds).toBe(5);
  });

  test.each([
    ["an unknown field", { extra: 1 }],
    ["a panel whose keys hash to another identifier", { panelId: "00".repeat(32) }],
    ["a seat outside the panel", { seat: 5 }],
    ["seat zero", { seat: 0 }],
    ["a coordinator over plain HTTP", { coordinator: "http://coordinator.example/" }],
    ["a chain id past u64", { l2ChainId: "18446744073709551616" }],
    ["a chain id with a leading zero", { l2ChainId: "084532" }],
    ["a short registry", { trusteeRegistry: "a3".repeat(19) }],
    ["a panel threshold above its size", { panel: { threshold: 5, keys: config().panel.keys } }],
  ])("refuses %s", (_, change) => {
    const c = config(change);
    // A panel changed on its own is checked against its own identifier, so
    // only the threshold is wrong there.
    if ("panel" in change) c.panelId = "00".repeat(32);
    expect(() => parseConfig(JSON.stringify(c))).toThrow(ConfigError);
  });

  test("refuses a file that isn't JSON", () => {
    expect(() => parseConfig("{")).toThrow(ConfigError);
  });
});

describe("the identity key file", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "trustee-node-key-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("is read only from a file its owner alone can reach", async () => {
    const key = "11".repeat(32);
    const path = join(dir, "identity");
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    expect(hex(await readIdentityKey(path))).toBe(key);
    await chmod(path, 0o400);
    expect(hex(await readIdentityKey(path))).toBe(key);
    for (const mode of [0o640, 0o604, 0o644]) {
      await chmod(path, mode);
      await expect(readIdentityKey(path), mode.toString(8)).rejects.toThrow(ConfigError);
    }
  });

  test("is never read through a symbolic link", async () => {
    const target = join(dir, "target");
    await writeFile(target, "11".repeat(32), { mode: 0o600 });
    const link = join(dir, "link");
    await symlink(target, link);
    await expect(readIdentityKey(link)).rejects.toThrow(ConfigError);
  });

  test("refuses anything but 64 hex digits", async () => {
    for (const [name, text] of [
      ["short", "11".repeat(31)],
      ["upper", "AB".repeat(32)],
      ["spaced", ` ${"11".repeat(32)}`],
    ]) {
      const path = join(dir, name as string);
      await writeFile(path, text as string, { mode: 0o600 });
      await expect(readIdentityKey(path)).rejects.toThrow(ConfigError);
    }
  });
});
