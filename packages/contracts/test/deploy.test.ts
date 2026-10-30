// The staging deploy script (script/Deploy.s.sol; P2-32 part 1b) against two
// local Anvil chains, L1 31337 and L2 31338, as the workflow will run it on
// Sepolia and Base Sepolia: forge broadcasts from Anvil's unlocked
// development account, so no key is held here (AGENTS.md, Testnets only).
// The L1 run comes first, pinning the L2 board fixed from the deployer's L2
// nonce, then the L2 run, which checks the L1 contracts before pinning them
// and reads the anchor's epoch. Every recorded address must hold the code
// its record's hash names, every pin must read back as the record gives it,
// and each chain must name the other's contracts where they landed. Each
// refusal must stop the run before it sends anything, and a dry run writes
// no record.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

const PKG = new URL("..", import.meta.url).pathname;
/** Anvil's first development account: unlocked, so forge sends with no key. */
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
/** Stand-ins with code: the anchoring Safe and Base's OptimismPortal on L1. */
const AUTHORITY = "0x00000000000000000000000000000000000000aa";
const PORTAL = "0x00000000000000000000000000000000000000bb";
const REGISTRARS = [
  "0x0000000000000000000000000000000000000011",
  "0x0000000000000000000000000000000000000022",
];
const CLOCK = { epoch: 1767225600, period: 3600, deadline: 1800 };

interface Node {
  readonly url: string;
  readonly process: ChildProcess;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function anvil(chainId: number): Promise<Node> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(chainId), "--silent"],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 100; i++) {
    if (
      await rpc(url, "eth_chainId").then(
        () => true,
        () => false,
      )
    )
      return { url, process: child };
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("anvil didn't start");
}

/** P-256's field, its `b`, and a compressed key's point. */
const P = 2n ** 256n - 2n ** 224n + 2n ** 192n + 2n ** 96n - 1n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
  }
  return result;
}

/** The point of a compressed key; the trustee registry checks it against the encoding. */
function point(key: string): [string, string] {
  const x = BigInt(`0x${key.slice(2)}`);
  let y = modPow((((x ** 3n - 3n * x + B) % P) + P) % P, (P + 1n) / 4n, P);
  if (Number(y & 1n) !== Number.parseInt(key.slice(0, 2), 16) - 2) y = P - y;
  return [x.toString(), y.toString()];
}

/** trustee.json's 4-of-7 panel, a stand-in for the launch panel. */
const PANEL = (
  JSON.parse(
    readFileSync(new URL("../../../docs/spec/vectors/trustee.json", import.meta.url), "utf8"),
  ) as { panels: { id: string; threshold: number; keys: string[] }[] }
).panels.find((p) => p.id === "panel-4-of-7")!;

function config(overrides: Record<string, unknown> = {}) {
  return {
    target: "staging",
    commit: "0123456789abcdef0123456789abcdef01234567",
    deployer: DEPLOYER,
    l1ChainId: 31337,
    l2ChainId: 31338,
    l1Nonce: 0,
    l2Nonce: 0,
    anchor: { ...CLOCK, authority: AUTHORITY },
    portal: PORTAL,
    panel: {
      threshold: PANEL.threshold,
      quorum: 6,
      kind: 2,
      keys: `0x${PANEL.keys.join("")}`,
      // Strings: JSON numbers above 2^53 don't survive a round trip.
      points: PANEL.keys.flatMap(point),
    },
    registrars: { threshold: 2, addresses: REGISTRARS },
    ...overrides,
  };
}

function forgeScript(sig: string, url: string, cfg: object, { broadcast = true } = {}) {
  const run = spawnSync(
    "forge",
    [
      "script",
      "script/Deploy.s.sol:Deploy",
      "--sig",
      sig,
      "--rpc-url",
      url,
      ...(broadcast ? ["--broadcast"] : []),
      "--unlocked",
      "--sender",
      DEPLOYER,
    ],
    {
      cwd: PKG,
      env: { ...process.env, DEPLOY_CONFIG: JSON.stringify(cfg), L1_RPC_URL: l1.url },
      encoding: "utf8",
    },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

function cast(...args: string[]): string {
  const run = spawnSync("cast", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

/** A view call's decoded result, without cast's `[1.767e9]` gloss on large numbers. */
const call = (url: string, to: string, sig: string, ...args: string[]) =>
  cast("call", "--rpc-url", url, to, sig, ...args).replace(/ \[[^\]]*\]/g, "");

interface DeployRecord {
  readonly target: string;
  readonly chainId: number;
  readonly deployer: string;
  readonly deployerNonce: number;
  readonly commit: string;
  readonly contracts: { readonly [name: string]: { address: string; codehash: string } };
  readonly pins: { readonly [name: string]: unknown };
}

const recordPath = (chainId: number) => `${PKG}/deployments/${chainId}.json`;
const record = (chainId: number): DeployRecord =>
  JSON.parse(readFileSync(recordPath(chainId), "utf8")) as DeployRecord;

const nonce = async (url: string) =>
  Number(await rpc<string>(url, "eth_getTransactionCount", [DEPLOYER, "latest"]));

function cleanUp() {
  for (const id of [31337, 31338]) {
    rmSync(recordPath(id), { force: true });
    rmSync(`${PKG}/broadcast/Deploy.s.sol/${id}`, { recursive: true, force: true });
  }
}

/** Runs `sig` and expects it refused with `error`, sending nothing from the deployer. */
async function refused(sig: string, url: string, cfg: object, error: string) {
  const before = await nonce(url);
  const run = forgeScript(sig, url, cfg);
  expect(run.status, run.output).not.toBe(0);
  expect(run.output).toContain(error);
  expect(await nonce(url)).toBe(before);
}

let l1: Node;
let l2: Node;
beforeAll(async () => {
  cleanUp();
  [l1, l2] = await Promise.all([anvil(31337), anvil(31338)]);
  for (const at of [AUTHORITY, PORTAL]) await rpc(l1.url, "anvil_setCode", [at, "0x00"]);
}, 60_000);
afterAll(() => {
  l1?.process.kill();
  l2?.process.kill();
  cleanUp();
});

const MANY = 120_000;

describe("refusals, before anything is sent", () => {
  test.each([
    ["another target", { target: "production" }, "NotStaging"],
    ["a commit that isn't 40 lower-case hex digits", { commit: "HEAD" }, "BadCommit"],
    ["a quoted commit", { commit: `${"0".repeat(39)}"` }, "BadCommit"],
    ["a mainnet pair", { l1ChainId: 1, l2ChainId: 8453 }, "ChainRefused"],
    ["a mixed pair", { l1ChainId: 11155111, l2ChainId: 31338 }, "ChainRefused"],
    [
      "a testnet record on the local chain",
      { l1ChainId: 11155111, l2ChainId: 84532 },
      "WrongChain",
    ],
    ["another starting nonce", { l1Nonce: 1 }, "WrongNonce"],
    ["a nonce past u64", { l1Nonce: "18446744073709551616" }, "OutOfRange"],
    [
      "an epoch past u64",
      { anchor: { ...CLOCK, epoch: "18446744073709551616", authority: AUTHORITY } },
      "OutOfRange",
    ],
  ])(
    "the L1 run: %s",
    async (_, change, error) => {
      await refused("runL1()", l1.url, config(change), error);
    },
    MANY,
  );

  test(
    "the L1 run on the L2's chain",
    async () => {
      await refused("runL1()", l2.url, config(), "WrongChain");
    },
    MANY,
  );

  test(
    "the L2 run before the L1's: there is no L1 record to check",
    async () => {
      await refused("runL2()", l2.url, config(), "31337.json");
    },
    MANY,
  );

  test(
    "a dry run sends nothing and writes no record",
    async () => {
      const run = forgeScript("runL1()", l1.url, config(), { broadcast: false });
      expect(run.status, run.output).toBe(0);
      expect(existsSync(recordPath(31337))).toBe(false);
      expect(await nonce(l1.url)).toBe(0);
    },
    MANY,
  );
});

describe("the staging deployment on a local Anvil pair", () => {
  let l1Record: DeployRecord;
  let l2Record: DeployRecord;
  beforeAll(async () => {
    const l1Run = forgeScript("runL1()", l1.url, config());
    expect(l1Run.output, l1Run.output).toContain("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL");
    l1Record = record(31337);

    // Refused once the L1 is deployed, sending nothing on the L2.
    await refused(
      "runL2()",
      l2.url,
      config({ panel: { ...config().panel, quorum: 5 } }),
      "BadQuorum",
    );
    await refused(
      "runL2()",
      l2.url,
      config({ registrars: { threshold: 256, addresses: REGISTRARS } }),
      "OutOfRange",
    );
    // A board the relay doesn't pin.
    await rpc(l2.url, "anvil_setNonce", [DEPLOYER, "0x1"]);
    await refused("runL2()", l2.url, config({ l2Nonce: 1 }), "L1RelayBoard");
    await rpc(l2.url, "anvil_setNonce", [DEPLOYER, "0x0"]);
    // An anchor and relay at other nonces than the L1 run used.
    await refused("runL2()", l2.url, config({ l1Nonce: 2 }), "L1NotDeployed");

    const l2Run = forgeScript("runL2()", l2.url, config());
    expect(l2Run.output, l2Run.output).toContain("ONCHAIN EXECUTION COMPLETE & SUCCESSFUL");
    l2Record = record(31338);
  }, 600_000);

  test("each record names its chain, the target, the deployer and the commit", () => {
    for (const [r, chainId] of [
      [l2Record, 31338],
      [l1Record, 31337],
    ] as const) {
      expect(r).toMatchObject({
        target: "staging",
        chainId,
        deployer: DEPLOYER,
        deployerNonce: 0,
        commit: "0123456789abcdef0123456789abcdef01234567",
      });
    }
    expect(Object.keys(l2Record.contracts)).toEqual([
      "TrusteeRegistry",
      "GroupRegistry",
      "ElectionRegistry",
      "Board",
      "BallotCheck",
    ]);
    expect(Object.keys(l1Record.contracts)).toEqual(["BoardAnchor", "BallotRelay"]);
  });

  test("every recorded address holds the code its hash names", async () => {
    for (const [r, url] of [
      [l2Record, l2.url],
      [l1Record, l1.url],
    ] as const) {
      for (const [name, c] of Object.entries(r.contracts)) {
        const code = await rpc<string>(url, "eth_getCode", [c.address, "latest"]);
        expect(code.length, name).toBeGreaterThan(2);
        expect(cast("keccak", code), name).toBe(c.codehash);
      }
    }
  });

  test("the records' pins are the configuration's, and each chain's addresses of the other", () => {
    const { BoardAnchor: anchor, BallotRelay: relay } = l1Record.contracts;
    // The record's addresses are checksummed; these two stand-ins are all digits but a and b.
    const lower = JSON.parse(
      JSON.stringify(l1Record.pins).replace(/"(0x[0-9A-Fa-f]{40})"/g, (_, a: string) =>
        a === l2Record.contracts["Board"]!.address ? `"${a}"` : `"${a.toLowerCase()}"`,
      ),
    ) as unknown;
    expect(lower).toEqual({
      l2ChainId: 31338,
      board: l2Record.contracts["Board"]!.address,
      anchor: { ...CLOCK, authority: AUTHORITY },
      portal: PORTAL,
    });
    expect(l2Record.pins).toEqual({
      l1ChainId: 31337,
      l1Anchor: anchor!.address,
      l1Relay: relay!.address,
      epoch: CLOCK.epoch,
      launchPanel: {
        id: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        threshold: 4,
        size: 7,
        quorum: 6,
        kind: 2,
        keys: `0x${PANEL.keys.join("")}`,
      },
      registrars: { threshold: 2, addresses: REGISTRARS },
    });
  });

  test("the L2 contracts hold what their record pins", () => {
    const {
      TrusteeRegistry: t,
      GroupRegistry: g,
      ElectionRegistry: e,
      Board: b,
    } = l2Record.contracts;
    const pins = l2Record.pins as {
      l1Anchor: string;
      l1Relay: string;
      launchPanel: { id: string };
    };
    const u = l2.url;
    const id = pins.launchPanel.id;
    expect(call(u, t!.address, "panelCount()(uint256)")).toBe("1");
    expect(call(u, t!.address, "panelIds(uint256)(bytes32)", "0")).toBe(id);
    expect(call(u, t!.address, "panelOf(bytes32)(uint8,uint8,uint8)", id).split("\n")).toEqual([
      "4",
      "7",
      "6",
    ]);
    expect(call(u, g!.address, "threshold()(uint8)")).toBe("2");
    expect(call(u, g!.address, "registrars()(address[])")).toBe(`[${REGISTRARS.join(", ")}]`);
    expect(call(u, g!.address, "trusteeRegistry()(address)")).toBe(t!.address);
    expect(call(u, g!.address, "initialPanelId()(bytes32)")).toBe(id);
    expect(call(u, e!.address, "board()(address)")).toBe(b!.address);
    expect(call(u, e!.address, "trusteeRegistry()(address)")).toBe(t!.address);
    expect(call(u, e!.address, "groupRegistry()(address)")).toBe(g!.address);
    expect(call(u, e!.address, "l1ChainId()(uint64)")).toBe("31337");
    expect(call(u, e!.address, "l1Anchor()(address)")).toBe(pins.l1Anchor);
    expect(call(u, e!.address, "l1Relay()(address)")).toBe(pins.l1Relay);
    expect(call(u, e!.address, "epoch()(uint64)")).toBe(String(CLOCK.epoch));
    expect(call(u, b!.address, "electionRegistry()(address)")).toBe(e!.address);
    expect(call(u, b!.address, "trusteeRegistry()(address)")).toBe(t!.address);
    expect(call(u, b!.address, "relay()(address)")).toBe(pins.l1Relay);
    expect(call(u, b!.address, "ballotCheck()(address)")).toBe(
      l2Record.contracts["BallotCheck"]!.address,
    );
  });

  test("the L1 contracts hold what their record pins", () => {
    const { BoardAnchor: anchor, BallotRelay: relay } = l1Record.contracts;
    const u = l1.url;
    expect(call(u, anchor!.address, "epoch()(uint64)")).toBe(String(CLOCK.epoch));
    expect(call(u, anchor!.address, "period()(uint64)")).toBe(String(CLOCK.period));
    expect(call(u, anchor!.address, "deadline()(uint64)")).toBe(String(CLOCK.deadline));
    expect(call(u, anchor!.address, "authority()(address)").toLowerCase()).toBe(AUTHORITY);
    expect(call(u, relay!.address, "portal()(address)").toLowerCase()).toBe(PORTAL);
    expect(call(u, relay!.address, "board()(address)")).toBe(l2Record.contracts["Board"]!.address);
  });

  test(
    "a second run on either chain is refused: the deployer's nonce has moved",
    async () => {
      await refused("runL1()", l1.url, config(), "WrongNonce");
      await refused("runL2()", l2.url, config(), "WrongNonce");
    },
    MANY,
  );
});
