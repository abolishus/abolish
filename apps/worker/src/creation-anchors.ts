// The creator's per-slot check's L1 reader (packages/core's
// `CreationAnchors`; docs/spec/contracts.md, Board anchor, Verification,
// Pre-creation anchors; P2-22 part 3b-1): the board anchor's checkpoint
// words, read from one L1 node at its finalized block and proven with
// `eth_getProof` against that block's state root by the verifier's own
// trie walk, never taken from an `eth_call`. Core decides which words to
// read and what they mean; this file only reads and proves.
//
// The header is rebuilt from the node's fields and must hash to the block
// hash the node names, so the state root the proofs are checked against is
// that block's. The node is still trusted for which block is finalized, as
// the creation step trusts its L2 node (T-25); a node that hid an anchor
// there would cost the election's verification, never another's. Every read
// is of public chain data, and nothing here logs or throws what it read
// (T-10).

import { boardAnchorAbi } from "@abolishus/contracts/abi";
import type { CreationAnchors, L1Block } from "@abolishus/core";
import { checkpointSlot, checkpointWords, decodeHeader, NodePool } from "@abolishus/verifier";
import {
  type Address,
  bytesToHex,
  getAddress,
  type Hex,
  hexToBytes,
  keccak256,
  numberToHex,
  type PublicClient,
  toRlp,
} from "viem";

// The header's fields in order, through Amsterdam's block access list
// (EIP-7928), which Sepolia's nodes already return. A later fork's field the
// list lacks makes the rebuilt header miss the block's hash, and the read
// fails rather than prove against a wrong root.
const HEADER_FIELDS = [
  ["parentHash", "bytes"],
  ["sha3Uncles", "bytes"],
  ["miner", "bytes"],
  ["stateRoot", "bytes"],
  ["transactionsRoot", "bytes"],
  ["receiptsRoot", "bytes"],
  ["logsBloom", "bytes"],
  ["difficulty", "uint"],
  ["number", "uint"],
  ["gasLimit", "uint"],
  ["gasUsed", "uint"],
  ["timestamp", "uint"],
  ["extraData", "bytes"],
  ["mixHash", "bytes"],
  ["nonce", "bytes"],
  ["baseFeePerGas", "uint"],
  ["withdrawalsRoot", "bytes"],
  ["blobGasUsed", "uint"],
  ["excessBlobGas", "uint"],
  ["parentBeaconBlockRoot", "bytes"],
  ["requestsHash", "bytes"],
  ["blockAccessListHash", "bytes"],
] as const;

/** Slots asked for in one `eth_getProof`; a check reads a handful. */
const SLOTS_PER_PROOF = 100;

type RawBlock = { readonly hash: Hex; readonly [field: string]: unknown };

/** An unsigned integer as RLP's byte string: big-endian, no leading zero, empty for zero. */
function uintHex(value: Hex): Hex {
  const n = BigInt(value);
  if (n === 0n) return "0x";
  const digits = n.toString(16);
  return `0x${digits.length % 2 === 0 ? digits : `0${digits}`}`;
}

/** The block's header as RLP, refused unless it hashes to the block's hash. */
export function headerRlp(block: RawBlock): Uint8Array {
  const items: Hex[] = [];
  for (const [name, kind] of HEADER_FIELDS) {
    const value = block[name];
    if (value === undefined || value === null) break;
    if (typeof value !== "string" || !value.startsWith("0x"))
      throw new Error("the L1 node gave a malformed header");
    items.push(kind === "uint" ? uintHex(value as Hex) : (value as Hex));
  }
  const rlp = toRlp(items);
  if (keccak256(rlp) !== block.hash.toLowerCase())
    throw new Error("the L1 node's header doesn't hash to its block");
  return hexToBytes(rlp);
}

export interface CreationAnchorsOptions {
  /** One L1 node. */
  readonly client: PublicClient;
  readonly anchor: Address;
  /** The anchor's clock, as `checkCreationAnchorsDeployment` read it. */
  readonly clock: { readonly epoch: bigint; readonly period: bigint };
}

/** The board anchor's words on L1, proven, as the per-slot check reads them. */
export class ViemCreationAnchors implements CreationAnchors {
  readonly clock: { readonly epoch: bigint; readonly period: bigint };
  readonly #client: PublicClient;
  readonly #anchor: Address;
  // The headers `finalized()` returned, by hash, so `words` proves against
  // the block it was given, not one the node names later.
  readonly #headers = new Map<string, Uint8Array>();

  constructor(options: CreationAnchorsOptions) {
    const { epoch, period } = options.clock;
    if (period < 1n || epoch < 0n) throw new RangeError("the anchor's clock is malformed");
    this.clock = { epoch, period };
    this.#client = options.client;
    this.#anchor = getAddress(options.anchor);
  }

  async finalized(): Promise<L1Block> {
    const block = await this.#client.request({
      method: "eth_getBlockByNumber",
      params: ["finalized", false],
    });
    if (block === null) throw new Error("the L1 node has no finalized block");
    const rlp = headerRlp(block as unknown as RawBlock);
    const header = decodeHeader(rlp);
    // One run reads one block; keep only the latest.
    this.#headers.clear();
    this.#headers.set(bytesToHex(header.hash), rlp);
    return { number: header.number, hash: header.hash, timestamp: header.timestamp };
  }

  async words(
    block: L1Block,
    electionId: Uint8Array,
    segments: readonly number[],
  ): Promise<Uint8Array[]> {
    const rlp = this.#headers.get(bytesToHex(block.hash));
    if (rlp === undefined) throw new Error("the block wasn't read from this node");
    const header = decodeHeader(rlp);
    const out: Uint8Array[] = [];
    for (let i = 0; i < segments.length; i += SLOTS_PER_PROOF) {
      const chunk = segments.slice(i, i + SLOTS_PER_PROOF);
      // By number: the block is finalized, so the number names it for good,
      // and a proof of any other block's state misses its root and fails.
      const proof = (await this.#client.request({
        method: "eth_getProof",
        params: [
          this.#anchor,
          chunk.map((s) => bytesToHex(checkpointSlot(electionId, s))),
          numberToHex(header.number),
        ],
      })) as { accountProof: readonly Hex[]; storageProof: readonly { proof: readonly Hex[] }[] };
      const nodes = new NodePool(
        [...proof.accountProof, ...proof.storageProof.flatMap((p) => p.proof)].map((n) =>
          hexToBytes(n),
        ),
      );
      out.push(
        ...checkpointWords({ header, anchor: hexToBytes(this.#anchor), nodes }, electionId, chunk),
      );
    }
    return out;
  }
}

export interface CreationAnchorsDeployment {
  readonly chainId: bigint;
  readonly anchor: Address;
}

/**
 * The startup check: the node is on the configured L1, and the address
 * holds, in finalized state, a board anchor whose clock the check then reads
 * by (its epoch and period are fixed in its code). Returns that clock; throws
 * naming the mismatch, never the URL.
 */
export async function checkCreationAnchorsDeployment(
  client: PublicClient,
  deployment: CreationAnchorsDeployment,
): Promise<{ epoch: bigint; period: bigint }> {
  const chainId = BigInt(await client.getChainId());
  if (chainId !== deployment.chainId) throw new Error("the L1 node is on another chain");
  const blockNumber = (await client.getBlock({ blockTag: "finalized" })).number;
  const code = await client.getCode({ address: deployment.anchor, blockNumber });
  if (code === undefined || code === "0x") throw new Error("no anchor at the address");
  const at = { address: deployment.anchor, abi: boardAnchorAbi, blockNumber } as const;
  const [epoch, period] = await Promise.all([
    client.readContract({ ...at, functionName: "epoch" }),
    client.readContract({ ...at, functionName: "period" }),
  ]);
  if (period < 1n) throw new Error("the anchor's clock is malformed");
  return { epoch, period };
}
