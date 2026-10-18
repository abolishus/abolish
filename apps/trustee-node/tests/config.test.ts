import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { panelId } from "@abolishus/crypto";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { DEFAULT_MAX_BOARD_BYTES } from "@abolishus/verifier";
import { ConfigError, parseConfig, readAccountKey, readIdentityKey } from "../src/config.ts";
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

function availability(change: Record<string, unknown> = {}) {
  return {
    l1: "https://user:key@l1.example/v1/secret",
    l1ChainId: "11155111",
    l2: "http://127.0.0.1:8545",
    anchor: `0x${"a1".repeat(20)}`,
    anchorFromBlock: "100",
    anchorClock: { epoch: "1760000000", period: "3600", deadline: "43200" },
    registry: "e1".repeat(20),
    registryFromBlock: "200",
    board: "b0".repeat(20),
    boardFromBlock: "201",
    portal: "90".repeat(20),
    accountKeyFile: "/etc/trustee-node/account",
    l1MaxFeePerGas: "300000000000",
    l2MaxFeePerGas: "10000000000",
    forceAfterSeconds: 1800,
    forceLeadSeconds: 3600,
    sendMarginSeconds: 1800,
    gateways: ["https://ipfs.example/", "https://archive.example/gateway"],
    blocks: "/srv/blocks",
    serve: { port: 8080 },
    ...change,
  };
}

describe("the availability configuration", () => {
  test("is optional: a node without it runs only the ceremony", () => {
    expect(parseConfig(JSON.stringify(config())).availability).toBeUndefined();
  });

  test("pins the chains' nodes, the deployment's contracts and clock, the fee caps, the margins and the sources", () => {
    const a = parseConfig(JSON.stringify(config({ availability: availability() }))).availability;
    if (a === undefined) return expect.fail("no availability");
    expect(a.l1.href).toBe("https://user:key@l1.example/v1/secret");
    expect(a.l1ChainId).toBe(11155111n);
    expect(hex(a.anchor)).toBe("a1".repeat(20));
    expect(a.anchorFromBlock).toBe(100n);
    expect(a.anchorClock).toEqual({ epoch: 1760000000n, period: 3600n, deadline: 43200n });
    expect([hex(a.registry), hex(a.board), hex(a.portal)]).toEqual([
      "e1".repeat(20),
      "b0".repeat(20),
      "90".repeat(20),
    ]);
    expect([a.registryFromBlock, a.boardFromBlock]).toEqual([200n, 201n]);
    expect([a.l1MaxFeePerGas, a.l2MaxFeePerGas]).toEqual([300000000000n, 10000000000n]);
    expect([a.forceAfter, a.forceLead, a.sendMargin]).toEqual([1800n, 3600n, 1800n]);
    expect(a.maxBoardBytes).toBe(DEFAULT_MAX_BOARD_BYTES);
    expect(a.gateways.map((g) => g.href)).toEqual([
      "https://ipfs.example/",
      "https://archive.example/gateway",
    ]);
    expect(a.blocks).toBe("/srv/blocks");
    // Loopback unless the operator publishes it.
    expect(a.serve).toEqual({ port: 8080, host: "127.0.0.1" });
  });

  test("takes the address the seat serves on", () => {
    const c = config({ availability: availability({ serve: { port: 0, host: "0.0.0.0" } }) });
    expect(parseConfig(JSON.stringify(c)).availability?.serve).toEqual({
      port: 0,
      host: "0.0.0.0",
    });
  });

  test("takes the operator's board budget", () => {
    const c = config({ availability: availability({ maxBoardBytes: 4096 }) });
    expect(parseConfig(JSON.stringify(c)).availability?.maxBoardBytes).toBe(4096);
  });

  test("takes the directory of CAR files alone, with no gateway", () => {
    const a = parseConfig(
      JSON.stringify(config({ availability: availability({ gateways: [] }) })),
    ).availability;
    expect(a?.gateways).toEqual([]);
    expect(a?.blocks).toBe("/srv/blocks");
  });

  test.each([
    ["an unknown field", { extra: 1 }],
    ["no blocks directory, where what is attested is pinned", { blocks: undefined }],
    ["nowhere to serve it", { serve: undefined }],
    ["a port past 65535", { serve: { port: 65_536 } }],
    ["a port as text", { serve: { port: "8080" } }],
    ["an unknown serve field", { serve: { port: 1, path: "/" } }],
    [
      "seventeen gateways",
      { gateways: Array.from({ length: 17 }, (_, i) => `https://g${i}.example/`) },
    ],
    ["a gateway with a query", { gateways: ["https://ipfs.example/?key=1"] }],
    ["an L1 node that isn't HTTP", { l1: "ws://l1.example/" }],
    ["an L2 node that isn't a URL", { l2: "localhost:8545" }],
    ["a short board", { board: "b0".repeat(19) }],
    ["a missing portal", { portal: undefined }],
    ["a zero period", { anchorClock: { epoch: "0", period: "0", deadline: "0" } }],
    ["a clock as numbers", { anchorClock: { epoch: 1, period: 3600, deadline: 43200 } }],
    ["a block past u64", { boardFromBlock: "18446744073709551616" }],
    ["a zero fee cap", { l1MaxFeePerGas: "0" }],
    ["a negative margin", { sendMarginSeconds: -1 }],
    ["a margin past a week", { forceLeadSeconds: 7 * 86_400 + 1 }],
    ["a fractional margin", { forceAfterSeconds: 1.5 }],
    ["a zero board budget", { maxBoardBytes: 0 }],
  ])("refuses %s", (_, change) => {
    const c = config({ availability: availability(change) });
    expect(() => parseConfig(JSON.stringify(c))).toThrow(ConfigError);
  });

  test("never quotes a node's URL, which may hold a provider's key", () => {
    for (const change of [
      { l1: "ftp://user:key@l1.example/" },
      { l2: "ftp://user:key@l2.example/" },
      { gateways: ["https://user:key@ipfs.example/"] },
    ]) {
      const c = config({ availability: availability(change) });
      expect(() => parseConfig(JSON.stringify(c))).toThrow(
        /^config: availability\.(l1|l2|gateways\.0): /,
      );
      expect(() => parseConfig(JSON.stringify(c))).not.toThrow("key@");
    }
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

describe("the account key file", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "trustee-node-account-"));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("is held as the identity key is, and named as the account key", async () => {
    const path = join(dir, "account");
    await writeFile(path, "22".repeat(32), { mode: 0o600 });
    expect(hex(await readAccountKey(path))).toBe("22".repeat(32));
    await chmod(path, 0o644);
    await expect(readAccountKey(path)).rejects.toThrow("account key:");
    await expect(readAccountKey(join(dir, "missing"))).rejects.toThrow("account key: ENOENT");
  });
});
