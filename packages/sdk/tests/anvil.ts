// Shared by the direct-submit and relay tests: an Anvil chain with its
// unlocked development accounts (no key is held here, AGENTS.md), contracts
// built by forge from packages/contracts, and the board's registry stubs set
// from ballot.json.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { decodeElectionDefinition } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import type { Eip1193Provider } from "../src/index.ts";

export const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
export const unhex = (s: string) => hexToBytes(s.startsWith("0x") ? s.slice(2) : s);
export const selector = (signature: string) =>
  keccak_256(new TextEncoder().encode(signature)).slice(0, 4);
export const pad32 = (n: number) => Math.ceil(n / 32) * 32;

export function word(v: bigint): Uint8Array {
  return hexToBytes(v.toString(16).padStart(64, "0"));
}

export interface BallotVector {
  readonly id: string;
  readonly election: string;
  readonly registered: readonly number[];
  readonly encoding: string;
  readonly ballotHash: string;
  readonly result: string;
}
export interface DecodeVector {
  readonly id: string;
  readonly encoding: string;
  readonly error: string;
  readonly offset?: number;
}
export const vectors = JSON.parse(
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
export function httpProvider(url: string): Eip1193Provider {
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

export function bytecode(contract: string): Uint8Array {
  return unhex(
    execFileSync("forge", ["inspect", "--root", contractsRoot, contract, "bytecode"], {
      encoding: "utf8",
    }).trim(),
  );
}

/** A definition's parameters as `ElectionRegistry.Parameters`, and its cells, from ballot.json. */
export function parametersOf(name: string) {
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

export interface Anvil {
  readonly provider: Eip1193Provider;
  readonly accounts: readonly string[];
  /** Sends from `from` (the first account by default) and waits for a successful receipt. */
  send(
    to: Uint8Array | undefined,
    data: Uint8Array,
    from?: string,
  ): Promise<Record<string, unknown>>;
  deploy(contract: string, args?: Uint8Array): Promise<Uint8Array>;
  /** Mines the next block at `timestamp`, so `eth_call` at `latest` sees it. */
  mineAt(timestamp: bigint): Promise<void>;
  nonce(account: Uint8Array): Promise<bigint>;
  stop(): Promise<void>;
}

/** Starts Anvil on a free port with `chainId`, its genesis at `timestamp`. */
export async function startAnvil(chainId: bigint, timestamp: bigint): Promise<Anvil> {
  const port = await freePort();
  const child: ChildProcess = spawn(
    "anvil",
    [
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--chain-id",
      String(chainId),
      "--timestamp",
      String(timestamp),
      "--silent",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const provider = httpProvider(`http://127.0.0.1:${port}`);
  const end = Date.now() + 20_000;
  let accounts: string[] | undefined;
  while (accounts === undefined) {
    if (child.exitCode !== null) throw new Error("anvil exited (is the toolchain installed?)");
    try {
      accounts = (await provider.request({ method: "eth_accounts" })) as string[];
    } catch (e) {
      if (Date.now() > end) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const [deployer] = accounts as [string];
  const send: Anvil["send"] = async (to, data, from = deployer) => {
    const tx = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from,
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
  };
  return {
    provider,
    accounts,
    send,
    async deploy(contract, args = new Uint8Array()) {
      const receipt = await send(undefined, concatBytes(bytecode(contract), args));
      return unhex(String(receipt.contractAddress));
    },
    async mineAt(at) {
      await provider.request({ method: "evm_mine", params: [Number(at)] });
    },
    async nonce(account) {
      return BigInt(
        String(
          await provider.request({
            method: "eth_getTransactionCount",
            params: [hex(account), "latest"],
          }),
        ),
      );
    },
    async stop() {
      if (child.exitCode !== null) return;
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
}

/** The board's registry stubs: `register(election, seats)` registers only that election, as Board.t.sol does. */
export function boardRegistries(
  chain: Anvil,
  elections: Uint8Array,
  trustees: Uint8Array,
  names: readonly string[],
) {
  const PANEL = keccak_256(new TextEncoder().encode("panel"));
  const stubOf = (election: string) => keccak_256(new TextEncoder().encode(`${election} stub`));
  return async (election: string, registered: readonly number[]): Promise<void> => {
    for (const name of names) {
      const p = parametersOf(name);
      await chain.send(elections, p.encode(name === election));
      await chain.send(
        elections,
        concatBytes(selector("setCeremony(bytes32,bytes32,bytes32)"), p.hash, stubOf(name), PANEL),
      );
    }
    const seats = registered.reduce((m, s) => m | (1n << BigInt(s)), 0n);
    await chain.send(
      trustees,
      concatBytes(
        selector("setKeySet(bytes32,bytes32,uint256)"),
        stubOf(election),
        PANEL,
        word(seats),
      ),
    );
  };
}
