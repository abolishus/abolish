// The archive's source of contract-event evidence and runs (P4-3 part 4b-3b;
// docs/spec/archive.md, Contract-event evidence and Contract-event run, Who
// writes them): the dispute games on L1 for the output roots, an L2 node for
// the blocks and proofs under them, and the index (P3-5) for the events.
// None of them is trusted for what it says: core's archive run checks every
// record as a reader checks it and replays every event against it before
// anything is posted (T-71). What they decide is only which record is
// written and when, so a node or index that lies can stall a contract's
// archive or move its record to a later game's block, never archive
// something that doesn't replay. Every read is of public chain data, and
// nothing here throws what it read or either node's or the index's URL,
// since core reports a source's message (T-10).

import type { ContractEventSource } from "@abolishus/core";
import type { ContractEventEvidence, RunEvent } from "@abolishus/crypto";
import { readContractEventRange } from "@abolishus/indexer";
import { ACCUMULATOR_SLOT, outputRootV0 } from "@abolishus/verifier";
import type { Sql } from "postgres";
import {
  type Address,
  BaseError,
  bytesToHex,
  type Hex,
  hexToBytes,
  parseAbi,
  type PublicClient,
  toHex,
} from "viem";
import { encodeHeader, MESSAGE_PASSER } from "./output-roots.ts";

/**
 * The most games read from the first one created at or after a period's end
 * less `GAME_LEAD`: about two and a half days of hourly proposals. A factory
 * that anyone can fill with games can push the first honest one past it,
 * which stalls the contract's records until it is answered (liveness only).
 */
export const MAX_EVIDENCE_GAMES = 64n;

/**
 * How far before a period's end, in seconds, the games read start: an L2
 * block can carry a timestamp ahead of L1's clock by up to the sequencer's
 * drift (1,800 seconds in the OP Stack), so a game created that much before
 * the end may already claim a block at or after it.
 */
export const GAME_LEAD = 3_600n;

const portalAbi = parseAbi([
  "function disputeGameFactory() view returns (address)",
  "function respectedGameType() view returns (uint32)",
]);

const factoryAbi = parseAbi([
  "function gameCount() view returns (uint256)",
  "function gameAtIndex(uint256 index) view returns (uint32 gameType, uint64 timestamp, address proxy)",
]);

const gameAbi = parseAbi([
  "function rootClaim() view returns (bytes32)",
  "function l2SequenceNumber() view returns (uint256)",
  "function status() view returns (uint8)",
]);

/** `GameStatus.CHALLENGER_WINS`: the game's claim was shown false. */
const CHALLENGER_WINS = 1;

/** A game the period's record may be read under. */
interface Claim {
  readonly index: bigint;
  readonly game: Address;
  readonly root: Uint8Array;
  readonly l2Block: bigint;
}

/** The block a period's records are proven at, with what proves it. */
interface Pick {
  readonly claim: Claim;
  readonly header: Uint8Array;
  readonly passerRoot: Uint8Array;
}

type RawBlock = Record<string, unknown>;

/** Thrown for what the source itself refuses, so its message is ours to report. */
class SourceError extends Error {}

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);
const isQuantity = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v);

function bytesOf(v: unknown, what: string): Uint8Array {
  if (!isHex(v)) throw new SourceError(`the L2 node's ${what} isn't hex`);
  return hexToBytes(v);
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export interface ChainContractEventsOptions {
  /** The L1 node, read at its finalized head only. */
  readonly l1: PublicClient;
  readonly l1ChainId: bigint;
  /** The L2's OptimismPortal on L1, which names the factory and the respected game type. */
  readonly portal: Address;
  /** The L2 node, whose answers the output roots prove. */
  readonly l2: PublicClient;
  readonly l2ChainId: bigint;
  /** The indexer's database, read only, and its schema. */
  readonly index: Sql;
  readonly indexSchema: string;
}

/**
 * The deployment's `ContractEventSource` over its L1 and L2 nodes and its
 * index. Made by `connect`.
 */
export class ChainContractEvents implements ContractEventSource {
  readonly #o: ChainContractEventsOptions;
  // Every contract's record for one period is read at one block, so a run
  // picks each period's block once; the picks are kept only while the L1
  // node's finalized head is the one they were read at, so a game shown
  // false since is never picked again.
  #picks = new Map<bigint, Pick | undefined>();
  #pickedAt: bigint | undefined;

  private constructor(options: ChainContractEventsOptions) {
    this.#o = options;
  }

  /** Refuses nodes on any chains but the deployment's. */
  static async connect(options: ChainContractEventsOptions): Promise<ChainContractEvents> {
    return quietly(NODES, async () => {
      if (BigInt(await options.l1.getChainId()) !== options.l1ChainId)
        throw new SourceError("the L1 node is on another chain");
      if (BigInt(await options.l2.getChainId()) !== options.l2ChainId)
        throw new SourceError("the L2 node is on another chain");
      return new ChainContractEvents(options);
    });
  }

  evidence(contract: Uint8Array, after: bigint): Promise<ContractEventEvidence | undefined> {
    return quietly(NODES, async () => {
      const pick = await this.#pick(after);
      if (pick === undefined) return undefined;
      const proof = await this.#o.l2.getProof({
        address: bytesToHex(contract),
        storageKeys: [
          toHex(ACCUMULATOR_SLOT, { size: 32 }),
          toHex(ACCUMULATOR_SLOT + 1n, { size: 32 }),
        ],
        blockNumber: pick.claim.l2Block,
      });
      // The account proof and both storage proofs share their upper nodes;
      // a record carries each once, in ascending byte order. Lowercase hex
      // of whole bytes sorts as the bytes do, a prefix first.
      const nodes = [
        ...new Set(
          [proof.accountProof, ...proof.storageProof.map((p) => p.proof)].flat().map((n) => {
            if (!isHex(n) || n === "0x") throw new SourceError("the L2 node's proof isn't hex");
            return n.toLowerCase();
          }),
        ),
      ]
        .sort()
        .map((n) => hexToBytes(n as Hex));
      return {
        l2_chain_id: this.#o.l2ChainId,
        contract: Uint8Array.from(contract),
        game_index: pick.claim.index,
        game: hexToBytes(pick.claim.game),
        output_root: pick.claim.root,
        message_passer_storage_root: pick.passerRoot,
        header: pick.header,
        nodes,
      };
    });
  }

  events(contract: Uint8Array, from: bigint, to: bigint): Promise<readonly RunEvent[]> {
    return quietly("the index couldn't be read", async () => {
      const records = await readContractEventRange(
        this.#o.index,
        this.#o.indexSchema,
        bytesToHex(contract),
        from,
        to,
      );
      // The index behind the proof is a wait, not a false history.
      if (BigInt(records.length) !== to - from)
        throw new SourceError("the index hasn't caught up with the record");
      return records.map((r) => ({
        l2_block: r.l2_block,
        l2_timestamp: r.l2_timestamp,
        topics: r.topics,
        data: r.data,
      }));
    });
  }

  /**
   * The lowest L2 block at or after `after` that a game claims, among
   * `MAX_EVIDENCE_GAMES` games from the first created at or after
   * `after − GAME_LEAD`, at the L1 node's finalized head: of the type the
   * portal respects there (never configured, T-71), not shown false, and
   * whose claim the L2 node's block and message passer reproduce. A game
   * whose root the node doesn't reproduce is passed over rather than stall
   * every contract until it is shown false; a node that lies to pass over an
   * honest one only moves the record to a later block, which core checks as
   * it checks any.
   */
  async #pick(after: bigint): Promise<Pick | undefined> {
    const { l1, l2, portal } = this.#o;
    const head = await l1.getBlock({ blockTag: "finalized" });
    if (head.number === null) throw new SourceError("the L1 node has no finalized block");
    const blockNumber = head.number;
    if (this.#pickedAt !== blockNumber) {
      this.#picks = new Map();
      this.#pickedAt = blockNumber;
    }
    if (this.#picks.has(after)) return this.#picks.get(after);
    const [factory, respected] = await Promise.all([
      l1.readContract({
        address: portal,
        abi: portalAbi,
        functionName: "disputeGameFactory",
        blockNumber,
      }),
      l1.readContract({
        address: portal,
        abi: portalAbi,
        functionName: "respectedGameType",
        blockNumber,
      }),
    ]);
    const gameAt = (i: bigint) =>
      l1.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "gameAtIndex",
        args: [i],
        blockNumber,
      });
    const count = await l1.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "gameCount",
      blockNumber,
    });
    // Games are appended with their L1 creation time, so the first created
    // at or after a time is found by bisection.
    const since = after > GAME_LEAD ? after - GAME_LEAD : 0n;
    let lo = 0n;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) / 2n;
      const [, created] = await gameAt(mid);
      if (created < since) lo = mid + 1n;
      else hi = mid;
    }
    const end = lo + MAX_EVIDENCE_GAMES < count ? lo + MAX_EVIDENCE_GAMES : count;
    const claims: Claim[] = [];
    for (let i = lo; i < end; i++) {
      const [gameType, , proxy] = await gameAt(i);
      if (gameType !== respected) continue;
      const read = <F extends "rootClaim" | "l2SequenceNumber" | "status">(functionName: F) =>
        l1.readContract({ address: proxy, abi: gameAbi, functionName, blockNumber });
      const [rootClaim, l2Block, status] = await Promise.all([
        read("rootClaim"),
        read("l2SequenceNumber"),
        read("status"),
      ]);
      if (status === CHALLENGER_WINS) continue;
      claims.push({ index: i, game: proxy, root: hexToBytes(rootClaim), l2Block });
    }
    claims.sort((a, b) => (a.l2Block < b.l2Block ? -1 : a.l2Block > b.l2Block ? 1 : 0));
    let pick: Pick | undefined;
    for (const claim of claims) {
      const block = (await l2.request({
        method: "eth_getBlockByNumber",
        params: [toHex(claim.l2Block), false],
      })) as RawBlock | null;
      // A block the node doesn't hold yet: a game claiming a future block,
      // or a node behind; either way not one to prove at now.
      if (block === null || typeof block !== "object") continue;
      if (!isQuantity(block.number) || !isQuantity(block.timestamp))
        throw new SourceError("the L2 node's block has no number or timestamp");
      if (BigInt(block.number) !== claim.l2Block)
        throw new SourceError("the L2 node answered with another block");
      if (BigInt(block.timestamp) < after) continue;
      const passer = await l2.getProof({
        address: MESSAGE_PASSER,
        storageKeys: [],
        blockNumber: claim.l2Block,
      });
      const passerRoot = bytesOf(passer.storageHash, "message passer's storage root");
      const stateRoot = bytesOf(block.stateRoot, "state root");
      const hash = bytesOf(block.hash, "block hash");
      if (stateRoot.length !== 32 || passerRoot.length !== 32 || hash.length !== 32)
        throw new SourceError("the L2 node's block isn't one of 32-byte roots");
      if (!equal(outputRootV0(stateRoot, passerRoot, hash), claim.root)) continue;
      let header: Uint8Array;
      try {
        header = encodeHeader(block);
      } catch {
        throw new SourceError("the L2 node's block header isn't well-formed");
      }
      pick = { claim, header, passerRoot };
      break;
    }
    this.#picks.set(after, pick);
    return pick;
  }
}

const NODES = "an L1 or L2 node failed";

/**
 * Runs `read`, passing on only the source's own refusals: viem's errors
 * quote the node's URL and postgres' can quote the index's, so any other
 * failure is reported as `failed` (T-10).
 */
async function quietly<T>(failed: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (e) {
    if (e instanceof SourceError) throw new Error(e.message);
    throw new Error(e instanceof BaseError ? NODES : failed);
  }
}
