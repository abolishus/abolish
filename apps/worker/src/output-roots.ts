// The registry's accumulator proven under an L2 output root posted on L1
// (P3-5 part 3b; docs/spec/contracts.md, Event accumulator, Output root).
// The L1 node names the newest dispute game of the type the L2's portal
// respects at its finalized head, and with it an output root and the L2 block it
// claims; the L2 node serves that block's header, the message passer's
// storage root and the registry's account and storage proofs, which
// packages/verifier checks against the root. So the L2 node is trusted for
// nothing but availability: a node that lies about the registry's storage,
// or about the block, fails the proof (T-71, T-34). What remains trusted is
// the L1 node, as for ballot admission's L1 reference (P2-3 part 2e-2), and
// the game: an unresolved game is its proposer's word until it resolves.
// Every read is of public chain data, and nothing here logs or throws what
// it read or either node's URL (T-10).

import type { ProvenEventAccumulator } from "@abolishus/crypto";
import {
  ACCUMULATOR_SLOT,
  accumulatorAtOutputRoot,
  OutputRootError,
  type OutputRootEvidence,
} from "@abolishus/verifier";
import {
  type Address,
  type Hex,
  hexToBytes,
  numberToBytes,
  parseAbi,
  type PublicClient,
  toHex,
  toRlp,
} from "viem";

/** The L2ToL1MessagePasser predeploy, whose storage root the output root commits to. */
export const MESSAGE_PASSER: Address = "0x4200000000000000000000000000000000000016";

/**
 * The most games read back from the factory's newest for one of the pinned
 * type: a factory serving other types too can't make one run read its
 * whole list.
 */
export const MAX_GAMES_SCANNED = 64n;

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

/** An output root a dispute game claims, and the L2 block it claims it for. */
export interface ClaimedOutputRoot {
  readonly outputRoot: Uint8Array;
  readonly l2Block: bigint;
}

/** Where the newest output root comes from. */
export interface OutputRootSource {
  latest(): Promise<ClaimedOutputRoot>;
}

/**
 * The dispute games one L1 node holds at its finalized head, of the type the
 * L2's portal respects. Made by `connect`.
 */
export class DisputeGameRoots implements OutputRootSource {
  readonly #client: PublicClient;
  readonly #portal: Address;

  private constructor(client: PublicClient, portal: Address) {
    this.#client = client;
    this.#portal = portal;
  }

  /** Refuses a node on any chain but `chainId`, the deployment's L1. */
  static async connect(
    client: PublicClient,
    chainId: bigint,
    portal: Address,
  ): Promise<DisputeGameRoots> {
    if (BigInt(await client.getChainId()) !== chainId)
      throw new Error("the L1 node is on another chain");
    return new DisputeGameRoots(client, portal);
  }

  /**
   * The newest game at the node's finalized head of the type the portal
   * respects there, from the factory the portal names, that hasn't been
   * shown false. The type is the portal's, never configured, since a type
   * anyone can create without a proof would let anyone post a root (T-71).
   * Every read is at that block, so a game created or resolved later
   * doesn't move the answer within one run.
   */
  async latest(): Promise<ClaimedOutputRoot> {
    const head = await this.#client.getBlock({ blockTag: "finalized" });
    if (head.number === null) throw new Error("the L1 node has no finalized block");
    const blockNumber = head.number;
    const [factory, respected] = await Promise.all([
      this.#client.readContract({
        address: this.#portal,
        abi: portalAbi,
        functionName: "disputeGameFactory",
        blockNumber,
      }),
      this.#client.readContract({
        address: this.#portal,
        abi: portalAbi,
        functionName: "respectedGameType",
        blockNumber,
      }),
    ]);
    const count = await this.#client.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "gameCount",
      blockNumber,
    });
    const last = count > MAX_GAMES_SCANNED ? count - MAX_GAMES_SCANNED : 0n;
    for (let i = count; i > last; i--) {
      const [gameType, , proxy] = await this.#client.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "gameAtIndex",
        args: [i - 1n],
        blockNumber,
      });
      if (gameType !== respected) continue;
      const read = <F extends "rootClaim" | "l2SequenceNumber" | "status">(functionName: F) =>
        this.#client.readContract({ address: proxy, abi: gameAbi, functionName, blockNumber });
      const [rootClaim, l2Block, status] = await Promise.all([
        read("rootClaim"),
        read("l2SequenceNumber"),
        read("status"),
      ]);
      if (status === CHALLENGER_WINS) continue;
      return { outputRoot: hexToBytes(rootClaim), l2Block };
    }
    throw new Error("no output root of the respected game type among the newest games");
  }
}

/** Why a proven read was refused though the proof checked: the game and the header disagree. */
export class GameBlockError extends Error {
  override readonly name = "GameBlockError";
  readonly code = "l2-block";
  constructor() {
    super("l2-block");
  }
}

type RawBlock = Record<string, unknown>;

// The header's fields in order, through Prague; a block ends at the last
// field its fork has. Its hash checks the encoding, so a field this list
// gets wrong fails the proof, never passes it.
const HEADER_FIELDS: readonly (readonly [string, "data" | "quantity"])[] = [
  ["parentHash", "data"],
  ["sha3Uncles", "data"],
  ["miner", "data"],
  ["stateRoot", "data"],
  ["transactionsRoot", "data"],
  ["receiptsRoot", "data"],
  ["logsBloom", "data"],
  ["difficulty", "quantity"],
  ["number", "quantity"],
  ["gasLimit", "quantity"],
  ["gasUsed", "quantity"],
  ["timestamp", "quantity"],
  ["extraData", "data"],
  ["mixHash", "data"],
  ["nonce", "data"],
  ["baseFeePerGas", "quantity"],
  ["withdrawalsRoot", "data"],
  ["blobGasUsed", "quantity"],
  ["excessBlobGas", "quantity"],
  ["parentBeaconBlockRoot", "data"],
  ["requestsHash", "data"],
];

const isHex = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);

class MalformedAnswer extends Error {
  readonly code: "l2-header" | "l2-proof-malformed";
  constructor(code: "l2-header" | "l2-proof-malformed") {
    super(code);
    this.code = code;
  }
}

/** An even-length hex string from the node, as bytes. */
function bytesOf(v: unknown): Uint8Array {
  if (!isHex(v) || v.length % 2 !== 0) throw new MalformedAnswer("l2-proof-malformed");
  return hexToBytes(v);
}

/** The RLP header of a block as `eth_getBlockByNumber` returns it. */
export function encodeHeader(block: RawBlock): Uint8Array {
  const fields: Hex[] = [];
  for (const [name, kind] of HEADER_FIELDS) {
    const v = block[name];
    if (v === undefined || v === null) break;
    if (!isHex(v) || (kind === "data" ? v.length % 2 !== 0 : v === "0x"))
      throw new MalformedAnswer("l2-header");
    if (kind === "data") {
      fields.push(v);
    } else {
      const n = BigInt(v);
      fields.push(n === 0n ? "0x" : toHex(numberToBytes(n)));
    }
  }
  return toRlp(fields, "bytes");
}

/** One L2 node, read only under output roots from `roots`. Made by `connect`. */
export class ProvenRegistryAccumulator {
  readonly #client: PublicClient;
  readonly #roots: OutputRootSource;

  private constructor(client: PublicClient, roots: OutputRootSource) {
    this.#client = client;
    this.#roots = roots;
  }

  /** Refuses a node on any chain but `chainId`, the deployment's L2. */
  static async connect(
    client: PublicClient,
    chainId: bigint,
    roots: OutputRootSource,
  ): Promise<ProvenRegistryAccumulator> {
    if (BigInt(await client.getChainId()) !== chainId)
      throw new Error("the L2 node is on another chain");
    return new ProvenRegistryAccumulator(client, roots);
  }

  /**
   * `contract`'s accumulator and count after the L2 block of the newest
   * output root, proven under it. Throws `OutputRootError` when the node's
   * answers don't prove against the root, and `GameBlockError` when the root
   * proves a block other than the one the game claims.
   */
  async proven(contract: Address): Promise<ProvenEventAccumulator> {
    const { outputRoot, l2Block } = await this.#roots.latest();
    const blockNumber = toHex(l2Block);
    const [block, passer, account] = await Promise.all([
      this.#client.request({ method: "eth_getBlockByNumber", params: [blockNumber, false] }),
      this.#client.getProof({ address: MESSAGE_PASSER, storageKeys: [], blockNumber: l2Block }),
      this.#client.getProof({
        address: contract,
        storageKeys: [
          toHex(ACCUMULATOR_SLOT, { size: 32 }),
          toHex(ACCUMULATOR_SLOT + 1n, { size: 32 }),
        ],
        blockNumber: l2Block,
      }),
    ]);
    if (block === null || typeof block !== "object")
      throw new Error("the L2 node has no block at the output root's number");
    let evidence: OutputRootEvidence;
    try {
      evidence = {
        outputRoot,
        messagePasserStorageRoot: bytesOf(passer.storageHash),
        header: encodeHeader(block as RawBlock),
        nodes: [account.accountProof, ...account.storageProof.map((p) => p.proof)]
          .flat()
          .map(bytesOf),
      };
    } catch (e) {
      // An answer that isn't even hex is the node's, refused as a header or
      // proof the root can't commit to rather than failing as internal.
      if (e instanceof MalformedAnswer) throw new OutputRootError(e.code);
      throw e;
    }
    const proven = accumulatorAtOutputRoot(evidence, hexToBytes(contract));
    if (proven.block !== l2Block) throw new GameBlockError();
    return { block: proven.block, accumulator: proven.accumulator, count: proven.count };
  }
}
