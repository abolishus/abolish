// The fixture's L1: the board anchor (packages/contracts, BoardAnchor) on
// Anvil, the checkpoints anchored through it, and the evidence the verifier
// reads them back from (docs/spec/verifier.md, Bundle, format 4: a block
// header and `eth_getProof` nodes). The anchoring authority is a stub: an
// address holding one byte of code that Anvil lets the fixture send from,
// standing in for the Safe until P4-1 part 2 (docs/spec/contracts.md, Board
// anchor).

import { readFileSync } from "node:fs";
import { type Checkpoint, checkpointHash, encodeCheckpoint } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import type { Rpc } from "./anvil.ts";
import { encodeRlp, uintBytes } from "./rlp.ts";

export interface AnchorClock {
  readonly epoch: bigint;
  readonly period: bigint;
  readonly deadline: bigint;
}

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const unhex = (s: string) => hexToBytes(s.startsWith("0x") ? s.slice(2) : s);

/** A 32-byte ABI word holding `n`. */
export function word(n: bigint): Uint8Array {
  if (n < 0n || n >= 2n ** 256n) throw new RangeError("word: out of range");
  const w = new Uint8Array(32);
  for (let i = 31, x = n; x > 0n; i--, x >>= 8n) w[i] = Number(x & 0xffn);
  return w;
}

export function padded(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
}

/**
 * Calldata for `anchor(bytes checkpoints, bytes locator)` in the one encoding
 * the contract accepts (CanonicalCalldata): both offsets in order, each
 * length followed by its bytes zero-padded to a word, nothing after.
 */
export function anchorCalldata(checkpoints: Uint8Array, locator: Uint8Array): Uint8Array {
  const selector = keccak_256(new TextEncoder().encode("anchor(bytes,bytes)")).slice(0, 4);
  const first = concatBytes(word(BigInt(checkpoints.length)), padded(checkpoints));
  return concatBytes(
    selector,
    word(64n),
    word(64n + BigInt(first.length)),
    first,
    word(BigInt(locator.length)),
    padded(locator),
  );
}

export interface Receipt {
  readonly status: string;
  readonly contractAddress: string | null;
  readonly blockNumber: string;
}

export async function send(rpc: Rpc, tx: Record<string, string>): Promise<Receipt> {
  const hash = await rpc.call<string>("eth_sendTransaction", [tx]);
  // Anvil mines each transaction as it arrives, but may answer before the
  // receipt is stored.
  for (let attempt = 0; attempt < 50; attempt++) {
    const receipt = await rpc.call<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (receipt !== null) {
      if (receipt.status !== "0x1") throw new Error(`transaction ${hash} reverted`);
      return receipt;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`transaction ${hash} wasn't mined`);
}

/** The deployed anchor's address and the authority that may anchor through it. */
export interface DeployedAnchor {
  readonly address: Uint8Array;
  readonly authority: Uint8Array;
  readonly clock: AnchorClock;
}

/** Deploys BoardAnchor with `clock` from forge's build output, with a stub authority. */
export async function deployAnchor(
  rpc: Rpc,
  artifact: URL,
  clock: AnchorClock,
): Promise<DeployedAnchor> {
  const { bytecode } = JSON.parse(readFileSync(artifact, "utf8")) as {
    bytecode: { object: string };
  };
  const [deployer] = await rpc.call<string[]>("eth_accounts");
  if (deployer === undefined) throw new Error("anvil has no development account");
  // The constructor refuses an authority without code, since a bare key isn't
  // a multisig; one STOP byte is enough to stand in for the Safe here.
  const authority = keccak_256(
    new TextEncoder().encode("reference-election/anchor-authority"),
  ).slice(12);
  await rpc.call("anvil_setCode", [hex(authority), "0x00"]);
  await rpc.call("anvil_setBalance", [hex(authority), hex(uintBytes(10n ** 18n))]);
  await rpc.call("anvil_impersonateAccount", [hex(authority)]);
  const receipt = await send(rpc, {
    from: deployer,
    data: hex(
      concatBytes(
        unhex(bytecode.object),
        word(clock.epoch),
        word(clock.period),
        word(clock.deadline),
        word(BigInt(`0x${bytesToHex(authority)}`)),
      ),
    ),
  });
  if (receipt.contractAddress === null) throw new Error("BoardAnchor wasn't deployed");
  return { address: unhex(receipt.contractAddress), authority, clock };
}

/** Moves Anvil's clock so the next block has `timestamp`, and mines it. */
export async function mineAt(rpc: Rpc, timestamp: bigint): Promise<void> {
  await rpc.call("evm_setNextBlockTimestamp", [Number(timestamp)]);
  await rpc.call("evm_mine");
}

/** Mines a block at `timestamp` and returns its number and hash, for a ballot to name. */
export async function l1RefAt(
  rpc: Rpc,
  timestamp: bigint,
): Promise<{ readonly number: bigint; readonly hash: Uint8Array }> {
  await mineAt(rpc, timestamp);
  const block = await rpc.call<Block>("eth_getBlockByNumber", ["latest", false]);
  if (BigInt(block.timestamp) !== timestamp) throw new Error("the block isn't the one mined");
  return { number: BigInt(block.number), hash: unhex(block.hash) };
}

/** Anchors `checkpoints` in one call from the authority, in a block at `timestamp`. */
export async function anchorAt(
  rpc: Rpc,
  anchor: DeployedAnchor,
  checkpoints: readonly Checkpoint[],
  timestamp: bigint,
): Promise<void> {
  await rpc.call("evm_setNextBlockTimestamp", [Number(timestamp)]);
  await send(rpc, {
    from: hex(anchor.authority),
    to: hex(anchor.address),
    data: hex(anchorCalldata(concatBytes(...checkpoints.map(encodeCheckpoint)), new Uint8Array())),
  });
}

interface Block {
  readonly hash: string;
  readonly number: string;
  readonly timestamp: string;
  readonly [field: string]: unknown;
}

// The header's fields in order, through Prague. Later forks append fields,
// which the verifier allows; a field Anvil adds that isn't listed here makes
// the hash check below fail rather than pass a wrong header.
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
] as const;

/** The block's header as RLP, checked against the block hash the node reports. */
export function headerRlp(block: Block): Uint8Array {
  const items: Uint8Array[] = [];
  for (const [name, kind] of HEADER_FIELDS) {
    const value = block[name];
    if (value === undefined || value === null) break;
    if (typeof value !== "string") throw new Error(`header field ${name} isn't a string`);
    items.push(kind === "uint" ? uintBytes(BigInt(value)) : unhex(value));
  }
  const rlp = encodeRlp(items);
  if (hex(keccak_256(rlp)) !== block.hash)
    throw new Error(`the header rebuilt for block ${block.number} doesn't hash to its hash`);
  return rlp;
}

export interface Evidence {
  readonly header: Uint8Array;
  readonly timestamp: bigint;
  readonly nodes: readonly Uint8Array[];
}

/**
 * The finalized block's header and the anchor's account and storage proofs
 * at it, for `slots` (the lowest-segment word and each segment's word).
 */
export async function evidence(
  rpc: Rpc,
  anchor: Uint8Array,
  slots: readonly Uint8Array[],
): Promise<Evidence> {
  const block = await rpc.call<Block>("eth_getBlockByNumber", ["finalized", false]);
  const proof = await rpc.call<{
    accountProof: string[];
    storageProof: { proof: string[] }[];
  }>("eth_getProof", [hex(anchor), slots.map(hex), block.number]);
  const nodes = [...proof.accountProof, ...proof.storageProof.flatMap((p) => p.proof)];
  return { header: headerRlp(block), timestamp: BigInt(block.timestamp), nodes: nodes.map(unhex) };
}

export interface Log {
  readonly topics: readonly string[];
  readonly data: string;
}

const CHECKPOINT_ANCHORED = keccak_256(
  new TextEncoder().encode(
    "CheckpointAnchored(bytes32,uint32,bytes32,uint64,bytes32,bytes32,bytes,bytes)",
  ),
);

/**
 * The checkpoint a `CheckpointAnchored` log carries (docs/spec/contracts.md,
 * Board anchor, Events): topics `election_id`, `segment` and
 * `checkpoint_hash`, data `size`, `head`, `root` and both 36-byte CIDs in the
 * one ABI layout the contract emits. Throws on any other layout, or if the
 * checkpoint doesn't hash to its logged hash, so a log can't name a
 * checkpoint other than the one whose hash the anchor stored.
 */
export function checkpointFromLog(log: Log): Checkpoint {
  const [topic, electionId, segment, hash] = log.topics.map(unhex);
  if (log.topics.length !== 4 || topic === undefined || electionId === undefined)
    throw new Error("not a CheckpointAnchored log");
  if (bytesToHex(topic) !== bytesToHex(CHECKPOINT_ANCHORED))
    throw new Error("not a CheckpointAnchored log");
  const data = unhex(log.data);
  // Five head words, then each CID's length word and two words of bytes.
  if (data.length !== 5 * 32 + 2 * 96)
    throw new Error("a CheckpointAnchored log in another layout");
  const cid = (at: number) => data.slice(at + 32, at + 32 + 36);
  const size = BigInt(`0x${bytesToHex(data.slice(0, 32))}`);
  if (size >= 2n ** 64n) throw new Error("a CheckpointAnchored size past a u64");
  const expected = concatBytes(
    word(size),
    data.slice(32, 96),
    word(0xa0n),
    word(0x100n),
    word(36n),
    padded(cid(0xa0)),
    word(36n),
    padded(cid(0x100)),
  );
  if (bytesToHex(data) !== bytesToHex(expected))
    throw new Error("a CheckpointAnchored log in another layout");
  const s = BigInt(`0x${bytesToHex(segment as Uint8Array)}`);
  if (s > 0xffffffffn) throw new Error("a CheckpointAnchored segment past a u32");
  const checkpoint: Checkpoint = {
    election_id: electionId,
    segment: Number(s),
    size,
    head: data.slice(32, 64),
    root: data.slice(64, 96),
    object_cid: cid(0xa0),
    hashes_cid: cid(0x100),
  };
  if (bytesToHex(checkpointHash(checkpoint)) !== bytesToHex(hash as Uint8Array))
    throw new Error("a CheckpointAnchored log whose checkpoint doesn't hash to its hash");
  return checkpoint;
}

/**
 * Every checkpoint the anchor logged for `electionId`, in log order, read
 * from L1's logs as anyone rebuilding the board would, never from what the
 * fixture anchored.
 */
export async function loggedCheckpoints(
  rpc: Rpc,
  anchor: Uint8Array,
  electionId: Uint8Array,
): Promise<Checkpoint[]> {
  const logs = await rpc.call<Log[]>("eth_getLogs", [
    {
      address: hex(anchor),
      fromBlock: "earliest",
      toBlock: "finalized",
      topics: [hex(CHECKPOINT_ANCHORED), hex(electionId)],
    },
  ]);
  return logs.map(checkpointFromLog);
}
