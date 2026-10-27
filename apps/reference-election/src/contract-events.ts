// Stage 8, the L2 contracts' half (P4-3 part 4b-3c; docs/spec/archive.md,
// Contract-event evidence and Contract-event run, Who writes them): for each
// of the deployment's L2 contracts and each anchored period, the record at
// the first L2 block at or after the period's end that a game claims, read
// through the worker's own source, `ChainContractEvents`, and, where its
// count is above the contract's last record's, the events between, read
// through it from the index and cut into runs. `archive.ts` posts them and
// lists them in manifest 0, and the verifier's 4.4 replays each contract's
// archive against its records (T-71, T-53).
//
// The L1 Anvil has no OP Stack: the portal, its dispute game factory and the
// games are answered by the fixture over the L1 Anvil's own blocks, one game
// for each anchored period claiming that period's first L2 block with the
// output root a proposer would post; and the index is a `contract_log` table
// the fixture fills from the L2 Anvil's logs, laid out as Ponder's is
// (STUBS, `contractEvents`).

import { testDb } from "@abolishus/core/test-db";
import {
  type ContractEventEvidence,
  encodeContractEventEvidence,
  encodeContractEventRun,
  MAX_RUN_EVENTS,
} from "@abolishus/crypto";
import { ChainContractEvents, MESSAGE_PASSER } from "@abolishus/worker";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { randomBytes } from "node:crypto";
import {
  type Address,
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeFunctionResult,
  type Hex,
  http,
  parseAbi,
  type PublicClient,
} from "viem";
import type { Anvil, Rpc } from "./anvil.ts";
import { placeholder } from "./election.ts";
import { word } from "./l1.ts";

const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`;
const unhex = (s: string) => hexToBytes(s.startsWith("0x") ? s.slice(2) : s);
const quantity = (n: bigint) => `0x${n.toString(16)}`;

/** The portal the fixture answers for: a placeholder no deployment holds. */
export const PORTAL = hex(placeholder("optimism-portal"));
const FACTORY = hex(placeholder("dispute-game-factory"));
/** The game type the portal respects. */
const RESPECTED = 0;
const gameAddress = (i: number) => hex(placeholder(`dispute-game/${i}`));

const abi = parseAbi([
  "function disputeGameFactory() view returns (address)",
  "function respectedGameType() view returns (uint32)",
  "function gameCount() view returns (uint256)",
  "function gameAtIndex(uint256 index) view returns (uint32 gameType, uint64 timestamp, address proxy)",
  "function rootClaim() view returns (bytes32)",
  "function l2SequenceNumber() view returns (uint256)",
  "function status() view returns (uint8)",
]);

export interface Game {
  readonly root: Uint8Array;
  readonly l2Block: bigint;
  /** Its L1 creation time. */
  readonly created: bigint;
}

/**
 * The L1 as the worker's source reads it: the L1 Anvil's chain and blocks,
 * with `games` behind the portal and its factory, every one in progress
 * (`status` 0), as a game is until its clock runs out.
 */
export function l1Client(l1: Rpc, games: readonly Game[]): PublicClient {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: readonly unknown[] }) {
        if (method === "eth_chainId" || method === "eth_getBlockByNumber")
          return l1.call(method, params ?? []);
        if (method !== "eth_call") throw new Error(`the fixture's L1 doesn't answer ${method}`);
        const [{ to, data }] = params as [{ to: Address; data: Hex }];
        const { functionName, args } = decodeFunctionData({ abi, data });
        const at = to.toLowerCase();
        const result = (): unknown => {
          if (at === PORTAL && functionName === "disputeGameFactory") return FACTORY;
          if (at === PORTAL && functionName === "respectedGameType") return RESPECTED;
          if (at === FACTORY && functionName === "gameCount") return BigInt(games.length);
          if (at === FACTORY && functionName === "gameAtIndex") {
            const i = Number(args?.[0]);
            const g = games[i];
            if (g === undefined) throw new Error("the factory has no such game");
            return [RESPECTED, g.created, gameAddress(i)];
          }
          const g = games.find((_, i) => gameAddress(i) === at);
          if (g === undefined) throw new Error(`the fixture's L1 has nothing at ${to}`);
          if (functionName === "rootClaim") return hex(g.root);
          if (functionName === "l2SequenceNumber") return g.l2Block;
          if (functionName === "status") return 0;
          throw new Error(`the fixture's game doesn't answer ${functionName}`);
        };
        return encodeFunctionResult({ abi, functionName, result: result() } as never);
      },
    }),
  }) as PublicClient;
}

interface RawLog {
  readonly address: string;
  readonly blockNumber: string;
  readonly logIndex: string;
  readonly transactionHash: string;
  readonly topics: readonly string[];
  readonly data: string;
}

interface RawBlock {
  readonly number: string;
  readonly timestamp: string;
  readonly hash: string;
  readonly stateRoot: string;
}

/** Each contract's logs on the L2 in chain order, with their blocks. */
async function l2Logs(
  l2: Rpc,
  contracts: readonly Uint8Array[],
): Promise<(RawLog & { readonly timestamp: bigint })[]> {
  const logs = await l2.call<RawLog[]>("eth_getLogs", [
    { fromBlock: "0x0", toBlock: "latest", address: contracts.map(hex) },
  ]);
  const times = new Map<string, bigint>();
  for (const l of logs)
    if (!times.has(l.blockNumber)) {
      const block = await l2.call<RawBlock>("eth_getBlockByNumber", [l.blockNumber, false]);
      times.set(l.blockNumber, BigInt(block.timestamp));
    }
  return logs.map((l) => ({ ...l, timestamp: times.get(l.blockNumber) as bigint }));
}

/** The first L2 block whose timestamp is at or after `t`, mined at `t` if none is. */
export async function firstBlockAt(l2: Rpc, t: bigint): Promise<RawBlock> {
  const latest = await l2.call<RawBlock>("eth_getBlockByNumber", ["latest", false]);
  if (BigInt(latest.timestamp) < t) {
    await l2.call("evm_mine", [Number(t)]);
    return l2.call<RawBlock>("eth_getBlockByNumber", ["latest", false]);
  }
  let lo = 0n;
  let hi = BigInt(latest.number);
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const block = await l2.call<RawBlock>("eth_getBlockByNumber", [quantity(mid), false]);
    if (BigInt(block.timestamp) < t) lo = mid + 1n;
    else hi = mid;
  }
  return l2.call<RawBlock>("eth_getBlockByNumber", [quantity(lo), false]);
}

/** The version-0 output root of an L2 block, as a proposer posts it. */
async function outputRoot(l2: Rpc, block: RawBlock): Promise<Uint8Array> {
  const passer = await l2.call<{ storageHash: string }>("eth_getProof", [
    MESSAGE_PASSER,
    [],
    block.number,
  ]);
  return keccak_256(
    concatBytes(word(0n), unhex(block.stateRoot), unhex(passer.storageHash), unhex(block.hash)),
  );
}

/** One record to archive, with the reference a manifest lists it under. */
export interface EvidenceObject {
  readonly contract: Uint8Array;
  readonly l2Block: bigint;
  readonly bytes: Uint8Array;
}

/** One run to archive, with the reference a manifest lists it under. */
export interface RunObject {
  readonly contract: Uint8Array;
  readonly first: bigint;
  readonly count: number;
  readonly bytes: Uint8Array;
}

export interface ContractEventObjects {
  readonly evidence: readonly EvidenceObject[];
  readonly runs: readonly RunObject[];
  /** How many events each contract's runs hold, by its address in hex. */
  readonly counts: ReadonlyMap<string, bigint>;
}

/**
 * The evidence and runs of `contracts` for the anchored periods ending at
 * `ends`, in order, written once every L2 event of the run has been emitted.
 * Each period's game is created at the period's end, claiming its first L2
 * block, and every contract's record is read through `ChainContractEvents`
 * from the contract's last record's block up, as the worker's archive run
 * reads it; a period that leaves a contract's count where it was writes
 * nothing for it.
 */
export async function contractEventObjects(
  l1: Anvil,
  l2: Anvil,
  deployment: {
    readonly l1ChainId: bigint;
    readonly l2ChainId: bigint;
    readonly contracts: readonly Uint8Array[];
  },
  ends: readonly bigint[],
): Promise<ContractEventObjects> {
  const games: Game[] = [];
  for (const end of ends) {
    const block = await firstBlockAt(l2, end);
    games.push({ root: await outputRoot(l2, block), l2Block: BigInt(block.number), created: end });
  }
  const logs = await l2Logs(l2, deployment.contracts);
  const db = await testDb();
  const schema = `ix_${randomBytes(6).toString("hex")}`;
  try {
    await db.admin.unsafe(`CREATE SCHEMA "${schema}"`);
    await db.admin.unsafe(`CREATE TABLE "${schema}".contract_log (
      id text PRIMARY KEY, contract text NOT NULL, block_number numeric(78) NOT NULL,
      block_timestamp numeric(78) NOT NULL, topics text[] NOT NULL, data text NOT NULL,
      transaction_hash text NOT NULL, log_index integer NOT NULL)`);
    // Ids that sort as the chain orders the logs, as Ponder's do.
    for (const l of logs)
      await db.admin`
        INSERT INTO ${db.admin(schema)}.contract_log VALUES (
          ${`${BigInt(l.blockNumber).toString().padStart(20, "0")}-${BigInt(l.logIndex).toString().padStart(10, "0")}`},
          ${l.address.toLowerCase()}, ${BigInt(l.blockNumber).toString()}, ${l.timestamp.toString()},
          ${l.topics.map((t) => t.toLowerCase())}, ${l.data.toLowerCase()},
          ${l.transactionHash}, ${Number(BigInt(l.logIndex))})`;
    const source = await ChainContractEvents.connect({
      l1: l1Client(l1, games),
      l1ChainId: deployment.l1ChainId,
      portal: PORTAL,
      l2: createPublicClient({ transport: http(l2.url) }) as PublicClient,
      l2ChainId: deployment.l2ChainId,
      index: db.admin,
      indexSchema: schema,
    });
    const evidence: EvidenceObject[] = [];
    const runs: RunObject[] = [];
    const counts = new Map<string, bigint>();
    for (const contract of deployment.contracts) {
      const own = logs.filter((l) => l.address.toLowerCase() === hex(contract));
      let last = { count: 0n, l2Block: 0n };
      for (const end of ends) {
        const record: ContractEventEvidence | undefined = await source.evidence(
          contract,
          end,
          last.l2Block,
        );
        // The period's own game, or an earlier one claiming the same block.
        const game = record && games[Number(record.game_index)];
        if (record === undefined || game === undefined)
          throw new Error(`no record of an L2 contract for the period ending at ${end}`);
        const count = BigInt(own.filter((l) => BigInt(l.blockNumber) <= game.l2Block).length);
        if (count === last.count) continue;
        evidence.push({
          contract,
          l2Block: game.l2Block,
          bytes: encodeContractEventEvidence(record),
        });
        for (let first = last.count; first < count; first += BigInt(MAX_RUN_EVENTS)) {
          const to =
            first + BigInt(MAX_RUN_EVENTS) < count ? first + BigInt(MAX_RUN_EVENTS) : count;
          const events = await source.events(contract, first, to);
          runs.push({
            contract,
            first,
            count: events.length,
            bytes: encodeContractEventRun({
              l2_chain_id: deployment.l2ChainId,
              contract,
              first,
              events,
            }),
          });
        }
        last = { count, l2Block: game.l2Block };
      }
      counts.set(bytesToHex(contract), last.count);
    }
    return { evidence, runs, counts };
  } finally {
    await db.admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.close();
  }
}
