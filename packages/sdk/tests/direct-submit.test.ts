// The direct-submit client (P4-2): its calldata and revert decoding, its
// handling of a provider's answers, and a run against the real board
// contract on Anvil, built by forge from packages/contracts with the test
// suite's registry stubs set from ballot.json, so every vector ballot gets
// the board's own verdict through the client, an honest one lands with its
// event, and a repeat or a ballot outside the window sends nothing (T-25,
// T-17, T-35). Anvil's unlocked development accounts sign: no key is held
// here (AGENTS.md).

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { decodeElectionDefinition } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  BALLOT_SUBMITTED_SIGNATURE,
  type BoardBallotRefusal,
  decodeBoardBallotRevert,
  directSubmitBallot,
  DirectSubmitError,
  type DirectSubmitOptions,
  type Eip1193Provider,
  revertDataOf,
  submitBallotCalldata,
} from "../src/index.ts";

const numRuns = Number(process.env.FC_NUM_RUNS ?? 100);
const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const unhex = (s: string) => hexToBytes(s.startsWith("0x") ? s.slice(2) : s);
const selector = (signature: string) => keccak_256(new TextEncoder().encode(signature)).slice(0, 4);
const pad32 = (n: number) => Math.ceil(n / 32) * 32;

function word(v: bigint): Uint8Array {
  return hexToBytes(v.toString(16).padStart(64, "0"));
}

const BALLOT_SUBMITTED = keccak_256(new TextEncoder().encode(BALLOT_SUBMITTED_SIGNATURE));

describe("submitBallotCalldata", () => {
  it("is the selector, offset 0x20, the length and the zero-padded record, nothing after", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (record) => {
        const c = submitBallotCalldata(record);
        expect(hex(c.subarray(0, 4))).toBe(hex(selector("submitBallot(bytes)")));
        expect(hex(c.subarray(4, 36))).toBe(hex(word(32n)));
        expect(hex(c.subarray(36, 68))).toBe(hex(word(BigInt(record.length))));
        expect(hex(c.subarray(68, 68 + record.length))).toBe(hex(record));
        expect(c.length).toBe(68 + pad32(record.length));
        expect(c.subarray(68 + record.length).every((b) => b === 0)).toBe(true);
      }),
      { numRuns },
    );
  });
});

const errorData = (signature: string, ...words: bigint[]) =>
  concatBytes(selector(signature), ...words.map(word));

describe("decodeBoardBallotRevert", () => {
  it("reads each code in the contracts' enum order", () => {
    const decode = [
      "truncated",
      "trailing-bytes",
      "length-over-max",
      "unknown-record-type",
      "unexpected-record-type",
      "unknown-version",
      "invalid-enum",
      "non-canonical",
      "profile-mismatch",
    ];
    for (const [i, code] of decode.entries())
      expect(
        decodeBoardBallotRevert(errorData("BallotMalformed(uint8,uint256)", BigInt(i), 108n)),
      ).toEqual({ kind: "malformed", code, offset: 108 });
    const admission = [
      "ballot-stray",
      "ballot-tier",
      "ballot-cell",
      "validity-shape",
      "share-hash-unqualified",
      "membership-proof",
    ];
    for (const [i, code] of admission.entries())
      expect(decodeBoardBallotRevert(errorData("BallotRefused(uint8)", BigInt(i)))).toEqual({
        kind: "refused",
        code,
      });
    expect(
      decodeBoardBallotRevert(errorData("BallotWindow(uint256,uint64,uint64)", 5n, 10n, 20n)),
    ).toEqual({ kind: "window", timestamp: 5n, opensAt: 10n, closesAt: 20n });
    expect(decodeBoardBallotRevert(selector("InsufficientGas()"))).toEqual({ kind: "gas" });
    expect(decodeBoardBallotRevert(selector("PrecompileFailed()"))).toEqual({ kind: "gas" });
    expect(decodeBoardBallotRevert(selector("NonCanonicalCalldata()"))).toEqual({
      kind: "calldata",
    });
  });

  it("calls anything else unknown: codes past the enum, wrong lengths, other errors", () => {
    const unknown = [
      errorData("BallotMalformed(uint8,uint256)", 9n, 0n),
      errorData("BallotMalformed(uint8,uint256)", 0n, 1n << 53n),
      errorData("BallotRefused(uint8)", 6n),
      errorData("BallotRefused(uint8)", 1n << 255n),
      concatBytes(errorData("BallotRefused(uint8)", 0n), new Uint8Array(1)),
      errorData("BallotRefused(uint8)", 0n).subarray(0, 35),
      errorData("BallotWindow(uint256,uint64,uint64)", 1n, 2n),
      concatBytes(selector("InsufficientGas()"), new Uint8Array(32)),
      errorData("Error(string)", 32n, 0n),
      new Uint8Array(),
    ];
    for (const data of unknown)
      expect(decodeBoardBallotRevert(data), hex(data)).toEqual({ kind: "unknown", data });
  });

  it("never throws on any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 120 }), (data) => {
        expect(decodeBoardBallotRevert(data).kind).toBeTypeOf("string");
      }),
      { numRuns },
    );
  });
});

describe("revertDataOf", () => {
  it("finds the data where nodes and wallets put it, and nothing in other errors", () => {
    const data = "0x0102";
    expect(revertDataOf({ code: 3, data })).toEqual(new Uint8Array([1, 2]));
    expect(revertDataOf({ code: -32603, data: { data } })).toEqual(new Uint8Array([1, 2]));
    expect(revertDataOf({ error: { data } })).toEqual(new Uint8Array([1, 2]));
    expect(revertDataOf(new Error("x", { cause: { data } }))).toEqual(new Uint8Array([1, 2]));
    expect(revertDataOf({ code: 4001, message: "User rejected the request." })).toBeUndefined();
    expect(revertDataOf({ data: "0x123" })).toBeUndefined();
    expect(revertDataOf(new TypeError("fetch failed"))).toBeUndefined();
    const loop: { error?: unknown } = {};
    loop.error = loop;
    expect(revertDataOf(loop)).toBeUndefined();
  });
});

// A scripted provider: each method answers from `answers`, and every request
// is recorded, so a test sees what the client sent.
function scripted(answers: Record<string, (params: readonly unknown[]) => unknown>) {
  const requests: { method: string; params: readonly unknown[] }[] = [];
  const provider: Eip1193Provider = {
    async request({ method, params = [] }) {
      requests.push({ method, params });
      const answer = answers[method];
      if (answer === undefined) throw new Error(`unexpected ${method}`);
      return answer(params);
    },
  };
  return { provider, requests };
}

describe("directSubmitBallot against a scripted provider", () => {
  const board = new Uint8Array(20).fill(0xbb);
  const from = new Uint8Array(20).fill(0xaa);
  const definitionHash = new Uint8Array(32).fill(0xdd);
  const ballotHash = new Uint8Array(32).fill(0xbe);
  const record = concatBytes(new Uint8Array([0, 2, 1]), definitionHash, new Uint8Array(40));
  const options = (provider: Eip1193Provider): DirectSubmitOptions => ({
    provider,
    chainId: 84532n,
    board,
    from,
    record,
    ballotHash,
    sleep: async () => {},
  });
  const txHash = `0x${"77".repeat(32)}`;
  const log = (topic2: Uint8Array) => ({
    address: hex(board),
    topics: [hex(BALLOT_SUBMITTED), hex(definitionHash), hex(topic2)],
    data: hex(concatBytes(word(32n), word(BigInt(record.length)), record, new Uint8Array(21))),
    transactionHash: txHash,
    blockNumber: "0x10",
    blockHash: `0x${"88".repeat(32)}`,
    logIndex: "0x2",
  });

  it("refuses another chain before asking the board anything", async () => {
    const { provider, requests } = scripted({ eth_chainId: () => "0x1" });
    await expect(directSubmitBallot(options(provider))).rejects.toMatchObject({
      code: "wrong-chain",
    });
    expect(requests.map((r) => r.method)).toEqual(["eth_chainId"]);
  });

  it("waits for the receipt, then finds its event", async () => {
    let polls = 0;
    const { provider, requests } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => "0x",
      eth_getLogs: () => [],
      eth_estimateGas: () => "0x64",
      eth_sendTransaction: () => txHash,
      eth_getTransactionReceipt: () =>
        ++polls < 3 ? null : { status: "0x1", logs: [log(ballotHash)] },
    });
    expect(await directSubmitBallot(options(provider))).toEqual({
      status: "submitted",
      transactionHash: unhex(txHash),
      blockNumber: 16n,
      blockHash: new Uint8Array(32).fill(0x88),
      logIndex: 2n,
    });
    const sent = requests.find((r) => r.method === "eth_sendTransaction")?.params[0];
    // The estimate and a quarter more: the pairing needs its gas available.
    expect(sent).toEqual({
      from: hex(from),
      to: hex(board),
      data: hex(submitBallotCalldata(record)),
      gas: "0x7d",
    });
  });

  it("names a mismatched ballot hash rather than calling the ballot submitted", async () => {
    const { provider } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => "0x",
      eth_getLogs: () => [log(new Uint8Array(32))],
    });
    await expect(directSubmitBallot(options(provider))).rejects.toMatchObject({
      code: "event-mismatch",
    });
  });

  it("gives up after its polls without a receipt", async () => {
    const { provider } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => "0x",
      eth_getLogs: () => [],
      eth_estimateGas: () => "0x64",
      eth_sendTransaction: () => txHash,
      eth_getTransactionReceipt: () => null,
    });
    await expect(directSubmitBallot({ ...options(provider), maxPolls: 4 })).rejects.toEqual(
      new DirectSubmitError("receipt-timeout", `transaction ${txHash} wasn't mined after 4 polls`),
    );
  });

  it("reports a reverted transaction by the board's answer afterwards", async () => {
    let calls = 0;
    const window = errorData("BallotWindow(uint256,uint64,uint64)", 30n, 10n, 20n);
    const { provider } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => {
        if (calls++ === 0) return "0x";
        throw Object.assign(new Error("execution reverted"), { code: 3, data: hex(window) });
      },
      eth_getLogs: () => [],
      eth_estimateGas: () => "0x64",
      eth_sendTransaction: () => txHash,
      eth_getTransactionReceipt: () => ({ status: "0x0", logs: [] }),
    });
    expect(await directSubmitBallot(options(provider))).toEqual({
      status: "refused",
      refusal: { kind: "window", timestamp: 30n, opensAt: 10n, closesAt: 20n },
      transactionHash: unhex(txHash),
    });
  });

  it("passes on a provider's error that carries no revert", async () => {
    const rejected = { code: 4001, message: "User rejected the request." };
    const { provider } = scripted({
      eth_chainId: () => "0x14a34",
      eth_call: () => {
        throw rejected;
      },
    });
    await expect(directSubmitBallot(options(provider))).rejects.toBe(rejected);
  });

  it("refuses answers no node gives", async () => {
    for (const receipt of [{ status: "0x1" }, { status: "one", logs: [] }, "0x1"]) {
      const { provider } = scripted({
        eth_chainId: () => "0x14a34",
        eth_call: () => "0x",
        eth_getLogs: () => [],
        eth_estimateGas: () => "0x64",
        eth_sendTransaction: () => txHash,
        eth_getTransactionReceipt: () => receipt,
      });
      await expect(directSubmitBallot(options(provider))).rejects.toMatchObject({
        code: "bad-response",
      });
    }
  });
});

// --- the board on Anvil -------------------------------------------------------

interface BallotVector {
  readonly id: string;
  readonly election: string;
  readonly registered: readonly number[];
  readonly encoding: string;
  readonly ballotHash: string;
  readonly result: string;
}
interface DecodeVector {
  readonly id: string;
  readonly encoding: string;
  readonly error: string;
  readonly offset?: number;
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/ballot.json", import.meta.url), "utf8"),
) as {
  readonly elections: Record<
    string,
    {
      readonly definition: string;
      readonly definitionHash: string;
      readonly tiers: readonly { readonly tier: number; readonly root: string }[];
    }
  >;
  readonly ballots: readonly BallotVector[];
  readonly decode: readonly DecodeVector[];
};

const contractsRoot = fileURLToPath(new URL("../../contracts", import.meta.url));
const CHAIN_ID = 31_339n;

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

/** An EIP-1193 provider over Anvil's JSON-RPC: an error keeps its `code` and `data`, as wallets pass them on. */
function httpProvider(url: string): Eip1193Provider {
  let id = 0;
  return {
    async request({ method, params = [] }) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const body = (await response.json()) as {
        result?: unknown;
        error?: { code: number; message: string; data?: unknown };
      };
      if (body.error !== undefined)
        throw Object.assign(new Error(body.error.message), {
          code: body.error.code,
          data: body.error.data,
        });
      return body.result;
    },
  };
}

function bytecode(contract: string): Uint8Array {
  return unhex(
    execFileSync("forge", ["inspect", "--root", contractsRoot, contract, "bytecode"], {
      encoding: "utf8",
    }).trim(),
  );
}

/** A definition's parameters as `ElectionRegistry.Parameters`, and its cells, from ballot.json. */
function parametersOf(name: string) {
  const e = vectors.elections[name];
  if (e === undefined) throw new Error(`no election ${name}`);
  const d = decodeElectionDefinition(unhex(e.definition));
  return {
    hash: unhex(e.definitionHash),
    opensAt: d.opens_at,
    closesAt: d.closes_at,
    // ParametersStub.set(bytes32, Parameters, uint8[], uint256[]), with the
    // ballot version 1 the profile pins and one selection question.
    encode(registered: boolean): Uint8Array {
      const tiers = registered ? e.tiers : [];
      const fields = registered
        ? [
            1n,
            d.threshold,
            d.panel_size,
            d.option_count,
            tiers.length,
            0,
            0,
            d.opens_at,
            d.closes_at,
            0,
          ]
        : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      const questions = registered
        ? [
            word(1n),
            word(1n),
            word(BigInt(d.option_count)),
            word(BigInt(d.min_selections)),
            word(BigInt(d.max_selections)),
          ]
        : [word(0n)];
      const p = concatBytes(...fields.map((f) => word(BigInt(f))), word(11n * 32n), ...questions);
      const tierList = concatBytes(
        word(BigInt(tiers.length)),
        ...tiers.map((t) => word(BigInt(t.tier))),
      );
      const rootList = concatBytes(
        word(BigInt(tiers.length)),
        ...tiers.map((t) => word(BigInt(t.root))),
      );
      return concatBytes(
        selector(
          "set(bytes32,(uint8,uint8,uint8,uint16,uint16,uint8,uint8,uint64,uint64,uint32,(uint8,uint16,uint16,uint16)[]),uint8[],uint256[])",
        ),
        unhex(e.definitionHash),
        word(128n),
        word(BigInt(128 + p.length)),
        word(BigInt(128 + p.length + tierList.length)),
        p,
        tierList,
        rootList,
      );
    },
  };
}

let anvil: ChildProcess | undefined;
let provider: Eip1193Provider;
let deployer: string;
let voter: Uint8Array;
let board: Uint8Array;
let elections: Uint8Array;
let trustees: Uint8Array;
const plurality = parametersOf("plurality");
const approval = parametersOf("approval");
const PANEL = keccak_256(new TextEncoder().encode("panel"));
const stubOf = (election: string) => keccak_256(new TextEncoder().encode(`${election} stub`));

async function send(
  to: Uint8Array | undefined,
  data: Uint8Array,
): Promise<Record<string, unknown>> {
  const tx = await provider.request({
    method: "eth_sendTransaction",
    params: [
      {
        from: deployer,
        ...(to === undefined ? {} : { to: hex(to) }),
        data: hex(data),
        gas: "0x1c9c380",
      },
    ],
  });
  let receipt: Record<string, unknown> | null = null;
  while (receipt === null) {
    receipt = (await provider.request({
      method: "eth_getTransactionReceipt",
      params: [tx],
    })) as Record<string, unknown> | null;
    if (receipt === null) await new Promise((r) => setTimeout(r, 10));
  }
  if (receipt.status !== "0x1") throw new Error(`transaction ${String(tx)} reverted`);
  return receipt;
}

async function deploy(contract: string, args: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
  const receipt = await send(undefined, concatBytes(bytecode(contract), args));
  return unhex(String(receipt.contractAddress));
}

/** Registers only `election` (as Board.t.sol does), with the vector's key set. */
async function register(election: string, registered: readonly number[]): Promise<void> {
  for (const [name, p] of [
    ["plurality", plurality],
    ["approval", approval],
  ] as const) {
    await send(elections, p.encode(name === election));
    await send(
      elections,
      concatBytes(selector("setCeremony(bytes32,bytes32,bytes32)"), p.hash, stubOf(name), PANEL),
    );
  }
  const seats = registered.reduce((m, s) => m | (1n << BigInt(s)), 0n);
  await send(
    trustees,
    concatBytes(
      selector("setKeySet(bytes32,bytes32,uint256)"),
      stubOf(election),
      PANEL,
      word(seats),
    ),
  );
}

/** Mines the next block at `timestamp`, so `eth_call` at `latest` sees it. */
async function mineAt(timestamp: bigint): Promise<void> {
  await provider.request({ method: "evm_mine", params: [Number(timestamp)] });
}

const nonce = async () =>
  BigInt(
    String(
      await provider.request({ method: "eth_getTransactionCount", params: [hex(voter), "latest"] }),
    ),
  );

const submit = (record: Uint8Array, ballotHash: Uint8Array, fromBlock?: bigint) =>
  directSubmitBallot({
    provider,
    chainId: CHAIN_ID,
    board,
    from: voter,
    record,
    ballotHash,
    ...(fromBlock === undefined ? {} : { fromBlock }),
    pollInterval: 10,
  });

beforeAll(async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // Genesis a day before the vector elections open, so the window can be
  // reached from both sides.
  anvil = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(CHAIN_ID),
      "--timestamp",
      String(plurality.opensAt - 86_400n),
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  provider = httpProvider(url);
  const end = Date.now() + 20_000;
  let accounts: string[] | undefined;
  while (accounts === undefined) {
    if (anvil.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    try {
      accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  [deployer] = accounts as [string];
  voter = unhex(accounts[4] as string);
  elections = await deploy("test/utils/BoardFixture.sol:ElectionsStub");
  trustees = await deploy("test/utils/BoardFixture.sol:TrusteesStub");
  // The relay's address only gates the relayed call, which this doesn't use.
  const relay = new Uint8Array(20).fill(0x11);
  board = await deploy(
    "src/Board.sol:Board",
    concatBytes(...[elections, trustees, relay].map((a) => concatBytes(new Uint8Array(12), a))),
  );
}, 120_000);

afterAll(async () => {
  if (anvil === undefined || anvil.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    anvil?.once("exit", () => resolve());
    anvil?.kill("SIGTERM");
  });
});

describe("directSubmitBallot against the board on Anvil", () => {
  it("sends nothing before the window opens", async () => {
    const [v] = vectors.ballots;
    if (v === undefined) throw new Error("ballot.json has its ballots");
    await register("plurality", v.registered);
    const at = plurality.opensAt - 60n;
    await mineAt(at);
    const before = await nonce();
    expect(await submit(unhex(v.encoding), unhex(v.ballotHash))).toEqual({
      status: "refused",
      refusal: {
        kind: "window",
        timestamp: at,
        opensAt: plurality.opensAt,
        closesAt: plurality.closesAt,
      },
    });
    expect(await nonce()).toBe(before);
  }, 60_000);

  it("gets the board's verdict on every ballot.json ballot, sending nothing it refuses", async () => {
    await mineAt(plurality.opensAt);
    for (const v of vectors.ballots) {
      await register(v.election, v.registered);
      const before = await nonce();
      const accepted = ["ok", "option-proof", "sum-proof"].includes(v.result);
      // Probed by eth_call alone, so the ballots the board accepts stay
      // unsent for the tests below; the client's own path is theirs.
      let refusal: BoardBallotRefusal | undefined;
      try {
        await provider.request({
          method: "eth_call",
          params: [
            {
              from: hex(voter),
              to: hex(board),
              data: hex(submitBallotCalldata(unhex(v.encoding))),
            },
            "latest",
          ],
        });
      } catch (e) {
        const data = revertDataOf(e);
        if (data === undefined) throw e;
        refusal = decodeBoardBallotRevert(data);
      }
      if (accepted) {
        expect(refusal, v.id).toBeUndefined();
        continue;
      }
      expect(refusal, v.id).toEqual({ kind: "refused", code: v.result });
      expect(await submit(unhex(v.encoding), unhex(v.ballotHash)), v.id).toEqual({
        status: "refused",
        refusal: { kind: "refused", code: v.result },
      });
      expect(await nonce(), v.id).toBe(before);
    }
  }, 120_000);

  it("reads the board's decode errors with their offsets", async () => {
    await register("plurality", [1, 2]);
    for (const v of vectors.decode) {
      const result = await submit(unhex(v.encoding), new Uint8Array(32));
      expect(result.status, v.id).toBe("refused");
      if (result.status !== "refused") continue;
      // The board knows every type versioning.md lists, so the file's
      // share-receipt type, unknown to a ballot decoder, is one it doesn't
      // expect here (contracts.md, Board, Ballots, step 1).
      const code = v.id === "other-type" ? "unexpected-record-type" : v.error;
      expect(result.refusal, v.id).toMatchObject({ kind: "malformed", code });
      if (v.offset !== undefined) expect(result.refusal, v.id).toMatchObject({ offset: v.offset });
    }
  }, 60_000);

  it("is refused for calldata other than the canonical encoding", async () => {
    const record = unhex(vectors.ballots[0]?.encoding ?? "");
    const canonical = submitBallotCalldata(record);
    const variants = [
      concatBytes(canonical, new Uint8Array(1)),
      concatBytes(canonical, new Uint8Array(32)),
      canonical.subarray(0, canonical.length - 1),
      (() => {
        const c = canonical.slice();
        c[c.length - 1] = 1; // dirty padding: the record isn't a whole number of words
        return c;
      })(),
      concatBytes(selector("submitBallot(bytes)"), word(64n), word(0n), canonical.subarray(36)),
    ];
    expect(record.length % 32).not.toBe(0);
    for (const data of variants) {
      const error = await provider
        .request({ method: "eth_call", params: [{ to: hex(board), data: hex(data) }, "latest"] })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      const revert = revertDataOf(error);
      expect(revert && decodeBoardBallotRevert(revert), hex(data.subarray(-40))).toEqual({
        kind: "calldata",
      });
    }
  });

  it("puts an honest ballot on the board in the window, and finds it rather than resending", async () => {
    const [v, reproved] = vectors.ballots;
    if (v === undefined || reproved === undefined) throw new Error("ballot.json has its ballots");
    expect([v.id, reproved.id]).toEqual(["ok-tier-0", "ok-reproved"]);
    await register("plurality", v.registered);
    const record = unhex(v.encoding);
    const hash = unhex(v.ballotHash);
    const first = BigInt(String(await provider.request({ method: "eth_blockNumber" })));

    const before = await nonce();

    const result = await submit(record, hash, first);
    expect(result.status).toBe("submitted");
    if (result.status !== "submitted") return;
    expect(await nonce()).toBe(before + 1n);
    const logs = (await provider.request({
      method: "eth_getLogs",
      params: [
        {
          address: hex(board),
          fromBlock: "0x0",
          toBlock: "latest",
          topics: [hex(BALLOT_SUBMITTED)],
        },
      ],
    })) as { transactionHash: string; logIndex: string; topics: string[] }[];
    expect(logs.length).toBe(1);
    expect(logs[0]?.transactionHash).toBe(hex(result.transactionHash));
    expect(BigInt(logs[0]?.logIndex ?? -1)).toBe(result.logIndex);
    expect(logs[0]?.topics).toEqual([
      hex(BALLOT_SUBMITTED),
      hex(plurality.hash),
      v.ballotHash.startsWith("0x") ? v.ballotHash : `0x${v.ballotHash}`,
    ]);

    // The same bytes again: found on the board, nothing sent (Calls, Repeats).
    const { status: _submitted, ...location } = result;
    expect(await submit(record, hash, first)).toEqual({ status: "already-on-board", ...location });
    expect(await nonce()).toBe(before + 1n);

    // A caller whose ballot hash isn't the board's never hears "submitted".
    const revote = vectors.ballots.find((b) => b.id === "ok-revote");
    if (revote === undefined) throw new Error("ballot.json has ok-revote");
    await expect(submit(unhex(revote.encoding), new Uint8Array(32), first)).rejects.toMatchObject({
      code: "event-mismatch",
    });

    // After close: a new ballot is outside the window and isn't sent; the
    // one already held is still found (docs/spec/close.md, Window).
    await mineAt(plurality.closesAt + 1n);
    expect(await submit(unhex(reproved.encoding), unhex(reproved.ballotHash))).toEqual({
      status: "refused",
      refusal: {
        kind: "window",
        timestamp: plurality.closesAt + 1n,
        opensAt: plurality.opensAt,
        closesAt: plurality.closesAt,
      },
    });
    expect(await submit(record, hash, first)).toEqual({ status: "already-on-board", ...location });
    expect(await nonce()).toBe(before + 2n);
  }, 60_000);
});
