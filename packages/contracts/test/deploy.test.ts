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
// no record. Then script/confirm.ts must confirm each record against its
// chain and forge's broadcast file, and refuse each record or broadcast
// that doesn't match what the chain holds.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  confirm,
  ConfirmError,
  createAddress,
  type DeploymentRecord,
  httpRpc,
  type Rpc,
} from "../script/confirm.ts";

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
const CLOCK = { epoch: 1767225600, period: 3600, deadline: 43200 };
/** A 1-of-1 Safe: code, but one key. */
const SOLE_OWNER = "0x00000000000000000000000000000000000000cc";
/** On L2: EntryPoint v0.8's stand-in (test/utils/MockEntryPoint.sol) and the paymaster's admin. */
const ENTRY_POINT = "0x0000000000000000000000000000000000000e01";
const TIMELOCK = "0x0000000000000000000000000000000000000e02";
const NO_DELAY = "0x0000000000000000000000000000000000000e03";
const SERVICE_OWNER = "0x0000000000000000000000000000000000000e04";
/** The L2 Safe behind the timelock, MockTimelock's `SAFE`. */
const L2_SAFE = "0x0000000000000000000000000000000000000e05";
const OPEN_TIMELOCK = "0x0000000000000000000000000000000000000e06";
const UNPROPOSED_TIMELOCK = "0x0000000000000000000000000000000000000e07";
const BARE_CODE = "0x0000000000000000000000000000000000000e08";
const DELEGATED = "0x0000000000000000000000000000000000000e09";
/** Above 2^53, which a JSON number wouldn't carry intact. */
const MAX_COST = (2n ** 60n).toString();
const REGISTRATION = {
  entryPoint: ENTRY_POINT,
  serviceOwner: SERVICE_OWNER,
  admin: TIMELOCK,
  safe: L2_SAFE,
  maxCost: MAX_COST,
};
const OVER_THRESHOLD = "0x00000000000000000000000000000000000000cd";
const REPEATED_OWNER = "0x00000000000000000000000000000000000000ce";
/** MockSafe's owners and threshold (test/utils/MockSafe.sol). */
const SAFE_OWNERS = [
  "0x00000000000000000000000000000000000005A1",
  "0x00000000000000000000000000000000000005A2",
  "0x00000000000000000000000000000000000005A3",
];

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
    registration: REGISTRATION,
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
      env: {
        ...process.env,
        DEPLOY_CONFIG: JSON.stringify(cfg),
        L1_RPC_URL: l1.url,
        // foundry.toml turns the compilation cache off, for the release
        // build (README, Release build). Here each of the test's ~30 runs
        // would otherwise recompile, competing with the other packages'
        // tests on the same runner; the cache is gitignored.
        FOUNDRY_CACHE: "true",
      },
      encoding: "utf8",
    },
  );
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

/** The runtime code of contract `name` in test/utils/`file` (.sol), from the build's `out/`. */
function deployedCode(file: string, name: string): string {
  const artifact = JSON.parse(readFileSync(`${PKG}/out/${file}.sol/${name}.json`, "utf8")) as {
    deployedBytecode: { object: string };
  };
  return artifact.deployedBytecode.object;
}

function cast(...args: string[]): string {
  const run = spawnSync("cast", args, { encoding: "utf8" });
  if (run.status !== 0) throw new Error(run.stderr);
  return run.stdout.trim();
}

/** A view call's decoded result, without cast's `[1.767e9]` gloss on large numbers. */
const call = (url: string, to: string, sig: string, ...args: string[]) =>
  cast("call", "--rpc-url", url, to, sig, ...args).replace(/ \[[^\]]*\]/g, "");

interface DeployRecord extends DeploymentRecord {
  readonly target: string;
  readonly commit: string;
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
  await rpc(l1.url, "anvil_setCode", [PORTAL, "0x00"]);
  const safes = [
    [AUTHORITY, "MockSafe"],
    [SOLE_OWNER, "MockSoleOwnerSafe"],
    [OVER_THRESHOLD, "MockOverThresholdSafe"],
    [REPEATED_OWNER, "MockRepeatedOwnerSafe"],
  ];
  for (const [at, name] of safes)
    await rpc(l1.url, "anvil_setCode", [at, deployedCode("MockSafe", name!)]);
  await rpc(l2.url, "anvil_setCode", [
    ENTRY_POINT,
    deployedCode("MockEntryPoint", "MockEntryPoint"),
  ]);
  await rpc(l2.url, "anvil_setCode", [TIMELOCK, deployedCode("MockTimelock", "MockTimelock")]);
  for (const [at, name] of [
    [NO_DELAY, "MockNoDelayTimelock"],
    [OPEN_TIMELOCK, "MockOpenTimelock"],
    [UNPROPOSED_TIMELOCK, "MockUnproposedTimelock"],
  ])
    await rpc(l2.url, "anvil_setCode", [at, deployedCode("MockTimelock", name!)]);
  await rpc(l2.url, "anvil_setCode", [L2_SAFE, deployedCode("MockSafe", "MockSafe")]);
  // Code with no timelock getters, and an EOA's EIP-7702 delegation to a timelock.
  await rpc(l2.url, "anvil_setCode", [BARE_CODE, "0x00"]);
  await rpc(l2.url, "anvil_setCode", [DELEGATED, `0xef0100${TIMELOCK.slice(2)}`]);
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
    [
      "an epoch that isn't a whole hour",
      { anchor: { ...CLOCK, epoch: CLOCK.epoch + 1, authority: AUTHORITY } },
      "ClockRefused",
    ],
    [
      "another period",
      { anchor: { ...CLOCK, period: 1800, authority: AUTHORITY } },
      "ClockRefused",
    ],
    [
      "a zero deadline",
      { anchor: { ...CLOCK, deadline: 0, authority: AUTHORITY } },
      "ClockRefused",
    ],
    [
      "another deadline",
      { anchor: { ...CLOCK, deadline: 1800, authority: AUTHORITY } },
      "ClockRefused",
    ],
    [
      "a threshold above the owner count",
      { anchor: { ...CLOCK, authority: OVER_THRESHOLD } },
      "AuthorityNotMultisig",
    ],
    [
      "an owner listed twice",
      { anchor: { ...CLOCK, authority: REPEATED_OWNER } },
      "AuthorityOwnerInvalid(1)",
    ],
    [
      "a 1-of-1 Safe as the authority",
      { anchor: { ...CLOCK, authority: SOLE_OWNER } },
      "AuthorityNotMultisig",
    ],
  ])(
    "the L1 run: %s",
    async (_, change, error) => {
      await refused("runL1()", l1.url, config(change), error);
    },
    MANY,
  );

  test.each([
    ["code with no Safe getters", PORTAL],
    ["an account with no code", "0x00000000000000000000000000000000000000dd"],
  ])(
    "the L1 run: an authority that is %s",
    async (_, authority) => {
      // The getters don't answer, so it fails before the anchor's own code check could.
      const run = forgeScript("runL1()", l1.url, config({ anchor: { ...CLOCK, authority } }));
      expect(run.status, run.output).not.toBe(0);
      expect(await nonce(l1.url)).toBe(0);
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
    for (const [change, field] of [
      [{ entryPoint: "0x00000000000000000000000000000000000000ee" }, "entryPoint"],
      [{ serviceOwner: "0x0000000000000000000000000000000000000000" }, "serviceOwner"],
      [{ maxCost: 0 }, "maxCost"],
      [{ admin: "0x00000000000000000000000000000000000000ef" }, "admin"],
      [{ admin: NO_DELAY }, "admin"],
      [{ admin: DELEGATED }, "admin"],
      [{ admin: OPEN_TIMELOCK }, "admin roles"],
      [{ admin: UNPROPOSED_TIMELOCK }, "admin roles"],
    ] as const)
      await refused(
        "runL2()",
        l2.url,
        config({ registration: { ...REGISTRATION, ...change } }),
        `RegistrationRefused("${field}")`,
      );
    // An admin whose getters don't answer fails before anything is sent.
    const bare = forgeScript(
      "runL2()",
      l2.url,
      config({ registration: { ...REGISTRATION, admin: BARE_CODE } }),
    );
    expect(bare.status, bare.output).not.toBe(0);
    expect(await nonce(l2.url)).toBe(0);
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
    // Another deployer than the L1 record's (Anvil's second account, at nonce 0).
    await refused(
      "runL2()",
      l2.url,
      config({ deployer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
      "L1RecordMismatch",
    );
    // An L2 run from another commit than the L1's.
    await refused(
      "runL2()",
      l2.url,
      config({ commit: "89abcdef0123456789abcdef0123456789abcdef" }),
      "L1RecordMismatch",
    );
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
      "RegistrationAccount",
      "RegistrationPaymaster",
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
      anchor: {
        ...CLOCK,
        authority: {
          address: AUTHORITY,
          owners: SAFE_OWNERS.map((o) => o.toLowerCase()),
          threshold: 2,
        },
      },
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
      registration: {
        entryPoint: ENTRY_POINT,
        serviceOwner: SERVICE_OWNER,
        entryPointCodehash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        admin: {
          address: TIMELOCK,
          minDelay: 2 * 24 * 60 * 60,
          safe: { address: L2_SAFE, owners: SAFE_OWNERS, threshold: 2 },
        },
        maxCost: MAX_COST,
      },
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
    const { RegistrationAccount: account, RegistrationPaymaster: paymaster } = l2Record.contracts;
    expect(call(u, account!.address, "entryPoint()(address)")).toBe(ENTRY_POINT);
    expect(call(u, account!.address, "owner()(address)")).toBe(SERVICE_OWNER);
    expect(call(u, paymaster!.address, "entryPoint()(address)")).toBe(ENTRY_POINT);
    expect(call(u, paymaster!.address, "registry()(address)")).toBe(g!.address);
    expect(call(u, paymaster!.address, "service()(address)")).toBe(account!.address);
    expect(call(u, paymaster!.address, "admin()(address)")).toBe(TIMELOCK);
    expect(call(u, paymaster!.address, "maxCost()(uint256)")).toBe(MAX_COST);
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

  describe("confirmed against the chain (script/confirm.ts)", () => {
    interface Broadcast {
      chain: number;
      transactions: {
        hash: string;
        transactionType: string;
        contractName: string | null;
        contractAddress: string | null;
        additionalContracts: {
          transactionType: string;
          contractName: string | null;
          address: string;
        }[];
      }[];
    }
    const broadcast = (chainId: number, sig: string): Broadcast =>
      JSON.parse(
        readFileSync(`${PKG}/broadcast/Deploy.s.sol/${chainId}/${sig}-latest.json`, "utf8"),
      ) as Broadcast;
    const OUT = `${PKG}/out`;
    const refusal = (p: Promise<unknown>) =>
      p.then(
        () => {
          throw new Error("confirmed");
        },
        (e: unknown) => {
          if (!(e instanceof ConfirmError)) throw e;
          return e.message;
        },
      );
    /** A deep copy, so a test's tampering stays its own. */
    const copy = <T>(x: T): T => structuredClone(x);

    test("each record gains its contracts' creating transactions and blocks", async () => {
      for (const [r, url, sig] of [
        [l1Record, l1.url, "runL1"],
        [l2Record, l2.url, "runL2"],
      ] as const) {
        const b = broadcast(r.chainId, sig);
        const confirmed = await confirm(r, b, httpRpc(url), OUT);
        expect({ ...confirmed, contracts: undefined }).toEqual({ ...r, contracts: undefined });
        expect(Object.keys(confirmed.contracts)).toEqual(Object.keys(r.contracts));
        for (const [name, c] of Object.entries(confirmed.contracts)) {
          expect(c.address).toBe(r.contracts[name]!.address);
          expect(c.codehash).toBe(r.contracts[name]!.codehash);
          const tx = b.transactions.find(
            (t) =>
              t.contractName === name || t.additionalContracts.some((a) => a.contractName === name),
          );
          expect(c.transaction, name).toBe(tx!.hash);
          const receipt = await rpc<{ blockNumber: string }>(url, "eth_getTransactionReceipt", [
            c.transaction,
          ]);
          expect(c.block, name).toBe(Number(receipt.blockNumber));
        }
        // The board's ballot check is created by the board's constructor.
        if (r.chainId === 31338)
          expect(confirmed.contracts["BallotCheck"]!.transaction).toBe(
            confirmed.contracts["Board"]!.transaction,
          );
      }
    });

    /**
     * The command, run by the Node running these tests (CI's test job has
     * no `vp node`): `script` is its path, which may be a link to it.
     */
    const command = (script: string, ...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], {
        cwd: PKG,
        env: { ...process.env, RPC_URL: l1.url },
        encoding: "utf8",
      });
    const L1_FILES = ["deployments/31337.json", "broadcast/Deploy.s.sol/31337/runL1-latest.json"];

    test("the command prints the confirmed record and keeps the URL out of its arguments", () => {
      const run = command("script/confirm.ts", ...L1_FILES, "out");
      expect(run.status, run.stderr).toBe(0);
      const printed = JSON.parse(run.stdout) as { contracts: { BoardAnchor: { block: number } } };
      expect(printed.contracts.BoardAnchor.block).toBeGreaterThan(0);
      // No artifacts directory: the build compared against is always named.
      expect(command("script/confirm.ts", ...L1_FILES).status).toBe(2);
    });

    test("the command runs through a link to it, never exiting 0 unchecked", () => {
      // A path with a space, reached through a symlink: neither may skip the
      // command, which would print nothing and exit 0.
      const dir = mkdtempSync(`${tmpdir()}/confirm link-`);
      try {
        symlinkSync(`${PKG}/script/confirm.ts`, `${dir}/confirm.ts`);
        const run = command(`${dir}/confirm.ts`, ...L1_FILES, "out");
        expect(run.status, run.stderr).toBe(0);
        expect(run.stdout).toContain('"BoardAnchor"');
        expect(command(`${dir}/confirm.ts`, ...L1_FILES).status).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("CREATE addresses: Anvil's deployer at nonces 1 and 2, and no nonce RLP can't carry in one byte", () => {
      // The addresses every Hardhat and Anvil user sees for the first
      // development account's second and third deployments.
      expect(createAddress(DEPLOYER, 1)).toBe("0xe7f1725e7734ce288f8367e1bb143e90bb3f0512");
      expect(createAddress(DEPLOYER, 2)).toBe("0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0");
      expect(() => createAddress(DEPLOYER, 0)).toThrow(RangeError);
      expect(() => createAddress(DEPLOYER, 0x80)).toThrow(RangeError);
    });

    /** The chain as `rpc` gives it, with `method`'s answers changed by `change`. */
    const altered =
      (rpc: Rpc, method: string, change: (result: unknown) => unknown): Rpc =>
      async <T>(m: string, params: readonly unknown[]) => {
        const result = await rpc<T>(m, params);
        return (m === method ? change(result) : result) as T;
      };

    test("refuses a transaction whose receipt says it reverted", async () => {
      const rpc = altered(httpRpc(l2.url), "eth_getTransactionReceipt", (r) => ({
        ...(r as object),
        status: "0x0",
      }));
      expect(await refusal(confirm(l2Record, broadcast(31338, "runL2"), rpc, OUT))).toBe(
        "TrusteeRegistry: transaction reverted",
      );
    });

    test("refuses a board whose immutable names another ballot check", async () => {
      const rpc = altered(
        httpRpc(l2.url),
        "eth_call",
        () => `0x${"00".repeat(12)}${"ab".repeat(20)}`,
      );
      expect(await refusal(confirm(l2Record, broadcast(31338, "runL2"), rpc, OUT))).toMatch(
        /^Board: pins ballot check/,
      );
    });

    test.each<
      [
        string,
        (
          r: DeploymentRecord & {
            contracts: Record<string, { address: string; codehash: string }>;
          },
          b: Broadcast,
        ) => void,
        RegExp,
      ]
    >([
      ["another chain's record", (r) => Object.assign(r, { chainId: 31337 }), /^chain/],
      [
        "an edited code hash",
        (r) => (r.contracts["Board"]!.codehash = `0x${"00".repeat(32)}`),
        /^Board: code doesn't hash/,
      ],
      [
        "an edited address",
        (r) => (r.contracts["Board"]!.address = r.contracts["GroupRegistry"]!.address),
        /not as recorded/,
      ],
      [
        "a recorded contract no transaction created",
        (_, b) => b.transactions.pop(),
        /^RegistrationPaymaster: no transaction/,
      ],
      [
        "a transaction that creates nothing recorded",
        (_, b) => b.transactions.push({ ...b.transactions[0]!, contractName: "Extra" }),
        /^Extra: creates/,
      ],
      [
        "a transaction that isn't a CREATE",
        (_, b) => (b.transactions[0]!.transactionType = "CALL"),
        /not a CREATE/,
      ],
      [
        "transactions out of the script's order",
        (_, b) => b.transactions.reverse(),
        /sent at nonce/,
      ],
      ["a start at another nonce", (r) => Object.assign(r, { deployerNonce: 1 }), /sent at nonce/],
      [
        "another deployer",
        (r) => Object.assign(r, { deployer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" }),
        /sent by/,
      ],
      [
        "a contract the board's constructor didn't create first",
        (r, b) => {
          const elsewhere = "0x00000000000000000000000000000000000000f1";
          r.contracts["BallotCheck"]!.address = elsewhere;
          b.transactions.find((t) => t.contractName === "Board")!.additionalContracts[0]!.address =
            elsewhere;
        },
        /^BallotCheck: not its creator's CREATE address/,
      ],
      [
        "a hash that was never mined",
        (_, b) => (b.transactions[0]!.hash = `0x${"11".repeat(32)}`),
        /not mined/,
      ],
      [
        "a transaction whose receipt created another address",
        (_, b) => {
          const [first, second] = b.transactions;
          [first!.hash, second!.hash] = [second!.hash, first!.hash];
        },
        /sent at nonce/,
      ],
      [
        "a receipt that created another address than the record's",
        (r, b) => {
          const elsewhere = "0x00000000000000000000000000000000000000f2";
          r.contracts["RegistrationPaymaster"]!.address = elsewhere;
          b.transactions.at(-1)!.contractAddress = elsewhere;
        },
        /^RegistrationPaymaster: receipt created/,
      ],
    ])("refuses %s", async (_, tamper, reason) => {
      const r = copy(l2Record) as DeploymentRecord & {
        contracts: Record<string, { address: string; codehash: string }>;
      };
      const b = copy(broadcast(31338, "runL2"));
      tamper(r, b);
      expect(await refusal(confirm(r, b, httpRpc(l2.url), OUT))).toMatch(reason);
    });

    test("refuses code that isn't the build's beyond its immutables", async () => {
      // Another build: the trustee registry's artifact with one byte changed
      // outside its immutables, and nothing else.
      const dir = mkdtempSync(`${tmpdir()}/confirm-`);
      try {
        for (const name of Object.keys(l2Record.contracts)) {
          mkdirSync(`${dir}/${name}.sol`);
          const artifact = JSON.parse(readFileSync(`${OUT}/${name}.sol/${name}.json`, "utf8")) as {
            deployedBytecode: { object: string };
          };
          if (name === "TrusteeRegistry") {
            const o = artifact.deployedBytecode.object;
            const last = o.slice(-2) === "00" ? "01" : "00";
            artifact.deployedBytecode.object = `${o.slice(0, -2)}${last}`;
          }
          writeFileSync(`${dir}/${name}.sol/${name}.json`, JSON.stringify(artifact));
        }
        expect(
          await refusal(confirm(l2Record, broadcast(31338, "runL2"), httpRpc(l2.url), dir)),
        ).toBe("TrusteeRegistry: code isn't the build's beyond its immutables");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("refuses a broadcast against a chain whose code was replaced", async () => {
      const board = l2Record.contracts["Board"]!.address;
      const code = await rpc<string>(l2.url, "eth_getCode", [board, "latest"]);
      await rpc(l2.url, "anvil_setCode", [board, "0x00"]);
      try {
        expect(
          await refusal(confirm(l2Record, broadcast(31338, "runL2"), httpRpc(l2.url), OUT)),
        ).toBe("Board: code doesn't hash to the record's codehash");
      } finally {
        await rpc(l2.url, "anvil_setCode", [board, code]);
      }
    });
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
