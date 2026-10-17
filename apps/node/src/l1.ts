// What the node pins, read from L1 (docs/spec/contracts.md, Board anchor,
// Verification): the checkpoints the board anchor holds. The L1 node is
// trusted only for which block is finalized. Every word is proven against
// that block's state root with the verifier's own reader (`anchorsFromState`),
// and a logged checkpoint counts only if its hash is the proven word for its
// election and segment. So a node that lies can hide checkpoints from the
// pinner but never make it pin bytes the anchor didn't name (T-24, T-36,
// T-51). Logs only find what to prove: an RPC node may shorten them, and
// nothing here treats a log as evidence.

import { type Checkpoint, checkpointHash } from "@abolishus/crypto";
import {
  anchorsFromState,
  checkpointSlot,
  decodeHeader,
  L1Error,
  type L1Header,
  lowestSegmentSlot,
  MAX_SEGMENTS_READ,
  NodePool,
  RlpError,
} from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { type Rpc, RpcError } from "./rpc.ts";

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;

function unhex(value: unknown, what: string): Uint8Array {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(value))
    throw new RpcError(`${what}: not hex`);
  return hexToBytes(value.slice(2));
}

// At most 32 bytes: no header field is wider, and a longer one would cost
// time quadratic in its length to encode (T-52).
function quantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/u.test(value))
    throw new RpcError(`${what}: not a quantity`);
  return BigInt(value);
}

/** An L1 address from text: `0x` and 40 hex digits. Throws `RangeError` otherwise. */
export function parseAddress(text: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(text))
    throw new RangeError("an address is 0x and 40 hex digits");
  return hexToBytes(text.slice(2));
}

// Recursive-length prefix (Ethereum Yellow Paper, Appendix B), only as far as
// a header needs: a list of byte strings.
function rlpString(b: Uint8Array): Uint8Array {
  if (b.length === 1 && (b[0] as number) < 0x80) return b;
  return concatBytes(lengthPrefix(b.length, 0x80), b);
}

function lengthPrefix(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Uint8Array.of(offset + 55 + bytes.length, ...bytes);
}

function uintBytes(n: bigint): Uint8Array {
  const bytes: number[] = [];
  for (let x = n; x > 0n; x >>= 8n) bytes.unshift(Number(x & 0xffn));
  return Uint8Array.from(bytes);
}

// The header's fields in order, through Prague. Later forks append fields;
// one this list lacks makes the rebuilt header's hash differ from the
// block's, which refuses the block rather than reading a wrong state root.
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

/**
 * The header of the block an `eth_getBlockByNumber` answer describes, as
 * RLP, rebuilt from its fields and refused unless it hashes to the block's
 * own hash.
 */
export function headerRlp(block: unknown): Uint8Array {
  if (typeof block !== "object" || block === null) throw new RpcError("no such block");
  const fields = block as Record<string, unknown>;
  const items: Uint8Array[] = [];
  for (const [name, kind] of HEADER_FIELDS) {
    const value = fields[name];
    if (value === undefined || value === null) break;
    items.push(rlpString(kind === "uint" ? uintBytes(quantity(value, name)) : unhex(value, name)));
  }
  const body = concatBytes(...items);
  const rlp = concatBytes(lengthPrefix(body.length, 0xc0), body);
  if (bytesToHex(keccak_256(rlp)) !== bytesToHex(unhex(fields["hash"], "hash")))
    throw new RpcError("a block whose header doesn't hash to its hash");
  return rlp;
}

/**
 * The finalized L1 block's header, decoded and as RLP: the one block
 * everything is proven at.
 */
export async function finalizedBlock(
  rpc: Rpc,
): Promise<{ readonly header: L1Header; readonly rlp: Uint8Array }> {
  const rlp = headerRlp(await rpc.call("eth_getBlockByNumber", ["finalized", false]));
  try {
    return { header: decodeHeader(rlp), rlp };
  } catch (e) {
    // Fewer fields than every fork has, or a number or time past 8 bytes.
    if (e instanceof RlpError) throw new RpcError("a block that isn't an L1 header");
    throw e;
  }
}

/** The finalized L1 block's header. */
export async function finalizedHeader(rpc: Rpc): Promise<L1Header> {
  return (await finalizedBlock(rpc)).header;
}

/** `CheckpointAnchored`'s topic (docs/spec/contracts.md, Board anchor, Events). */
export const CHECKPOINT_ANCHORED = keccak_256(
  new TextEncoder().encode(
    "CheckpointAnchored(bytes32,uint32,bytes32,uint64,bytes32,bytes32,bytes,bytes)",
  ),
);

const word = (n: bigint) => {
  const w = new Uint8Array(32);
  for (let i = 31, x = n; x > 0n; i--, x >>= 8n) w[i] = Number(x & 0xffn);
  return w;
};

const padded = (b: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
};

/**
 * The checkpoint a `CheckpointAnchored` log carries: topics `election_id`,
 * `segment` and `checkpoint_hash`, data `size`, `head`, `root` and both
 * 36-byte CIDs in the one ABI layout the contract emits; undefined for
 * anything else, or a checkpoint that doesn't hash to the logged hash. Still
 * only a candidate: it counts once its hash is proven in state.
 */
export function checkpointFromLog(log: unknown): Checkpoint | undefined {
  if (typeof log !== "object" || log === null) return undefined;
  const { topics, data: dataHex } = log as { topics?: unknown; data?: unknown };
  try {
    if (!Array.isArray(topics) || topics.length !== 4) return undefined;
    const [topic, electionId, segment, hash] = topics.map((t) => unhex(t, "topic"));
    if (topic === undefined || bytesToHex(topic) !== bytesToHex(CHECKPOINT_ANCHORED))
      return undefined;
    if (electionId?.length !== 32 || segment?.length !== 32 || hash?.length !== 32)
      return undefined;
    const data = unhex(dataHex, "data");
    // Five head words, then each CID's length word and two words of bytes.
    if (data.length !== 5 * 32 + 2 * 96) return undefined;
    const cid = (at: number) => data.slice(at + 32, at + 32 + 36);
    const size = BigInt(hex(data.slice(0, 32)));
    const s = BigInt(hex(segment));
    if (size >= 2n ** 64n || s > 0xffffffffn) return undefined;
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
    if (bytesToHex(data) !== bytesToHex(expected)) return undefined;
    const checkpoint: Checkpoint = {
      election_id: electionId,
      segment: Number(s),
      size,
      head: data.slice(32, 64),
      root: data.slice(64, 96),
      object_cid: cid(0xa0),
      hashes_cid: cid(0x100),
    };
    return bytesToHex(checkpointHash(checkpoint)) === bytesToHex(hash) ? checkpoint : undefined;
  } catch (e) {
    if (e instanceof RpcError) return undefined;
    throw e;
  }
}

/** The logged checkpoints, by election in order of first appearance, and how many logs were refused. */
export interface Logged {
  readonly elections: ReadonlyMap<string, readonly Checkpoint[]>;
  readonly refused: number;
}

/** Every `CheckpointAnchored` log the anchor emitted from `fromBlock` up to the header's block. */
export async function loggedCheckpoints(
  rpc: Rpc,
  anchor: Uint8Array,
  header: L1Header,
  fromBlock: bigint,
): Promise<Logged> {
  const logs = await rpc.call("eth_getLogs", [
    {
      address: hex(anchor),
      fromBlock: `0x${fromBlock.toString(16)}`,
      toBlock: `0x${header.number.toString(16)}`,
      topics: [hex(CHECKPOINT_ANCHORED)],
    },
  ]);
  if (!Array.isArray(logs)) throw new RpcError("eth_getLogs: not a list");
  const elections = new Map<string, Checkpoint[]>();
  let refused = 0;
  for (const log of logs) {
    const address = (log as { address?: unknown } | null)?.address;
    const checkpoint =
      typeof address === "string" && address.toLowerCase() === hex(anchor)
        ? checkpointFromLog(log)
        : undefined;
    if (checkpoint === undefined) {
      refused++;
      continue;
    }
    const id = bytesToHex(checkpoint.election_id);
    const list = elections.get(id);
    if (list === undefined) elections.set(id, [checkpoint]);
    else list.push(checkpoint);
  }
  return { elections, refused };
}

/** Slots per `eth_getProof` request: hosted nodes limit how many one request may name. */
export const PROOF_SLOTS_PER_REQUEST = 256;

/**
 * Most bytes of proof nodes held for one election: a few thousand slots'
 * proofs are a few MiB, so this leaves room for years of hourly segments
 * while a node can't make the pinner hold its answers without bound (T-52).
 */
export const MAX_PROOF_BYTES = 256 * 1024 * 1024;

/**
 * What each node costs against a proof budget beyond its bytes: what holding
 * one more array takes, so a node can't make the reader hold millions of
 * tiny nodes within the budget (T-52).
 */
export const PROOF_NODE_OVERHEAD = 64;

/**
 * The account and storage proof nodes of `slots` of the anchor at the
 * header's block, `PROOF_SLOTS_PER_REQUEST` slots a request. Nothing here is
 * trusted: the verifier's reader walks them from the header's state root, so
 * a changed or missing node is its `l1-proof-missing`. An answer that can't
 * be read, an empty node (no trie holds one), or proofs past `maxBytes`,
 * each node counted with `PROOF_NODE_OVERHEAD`, throw `RpcError`.
 */
export async function proofNodes(
  rpc: Rpc,
  anchor: Uint8Array,
  header: L1Header,
  slots: readonly Uint8Array[],
  maxBytes: number = MAX_PROOF_BYTES,
): Promise<Uint8Array[]> {
  const nodes: Uint8Array[] = [];
  let held = 0;
  const keep = (n: unknown, what: string) => {
    const node = unhex(n, what);
    if (node.length === 0) throw new RpcError(`${what}: an empty node`);
    held += node.length + PROOF_NODE_OVERHEAD;
    if (held > maxBytes) throw new RpcError("eth_getProof: proofs past the size limit");
    nodes.push(node);
  };
  for (let at = 0; at < slots.length; at += PROOF_SLOTS_PER_REQUEST) {
    const proof = (await rpc.call("eth_getProof", [
      hex(anchor),
      slots.slice(at, at + PROOF_SLOTS_PER_REQUEST).map(hex),
      `0x${header.number.toString(16)}`,
    ])) as { accountProof?: unknown; storageProof?: unknown } | null;
    if (!Array.isArray(proof?.accountProof) || !Array.isArray(proof?.storageProof))
      throw new RpcError("eth_getProof: not a proof");
    for (const n of proof.accountProof) keep(n, "accountProof");
    for (const p of proof.storageProof) {
      const list = (p as { proof?: unknown } | null)?.proof;
      if (!Array.isArray(list)) throw new RpcError("eth_getProof: not a proof");
      for (const n of list) keep(n, "storageProof");
    }
  }
  return nodes;
}

/** An election's proven checkpoints, and the proof nodes they were proven from. */
export interface Proven {
  readonly checkpoints: Checkpoint[];
  readonly nodes: Uint8Array[];
}

/**
 * The election's checkpoints the anchor holds at the header's block, of
 * those `logged` names: the verifier's reader proves the lowest-segment word
 * and the word of every segment from the lowest anchored one to the highest
 * logged, and each non-zero word takes the logged checkpoint whose hash it
 * is. A word no logged checkpoint matches, below the lowest logged segment
 * as much as between, throws the verifier's `L1Error`
 * (`l1-checkpoint-unknown`): the node withheld its log, so this election's
 * pins wait for a node that doesn't. So does a range of more than
 * `MAX_SEGMENTS_READ` segments (`l1-range-too-long`), checked before any
 * proof is asked for. An answer that can't be read, or proofs past
 * `maxProofBytes` (`MAX_PROOF_BYTES` by default), throw `RpcError`. The
 * proofs of `extraSlots` (a definition's receipt keys) are fetched with the
 * others, unread here.
 */
export async function provenCheckpoints(
  rpc: Rpc,
  anchor: Uint8Array,
  header: L1Header,
  logged: readonly Checkpoint[],
  options: { readonly extraSlots?: readonly Uint8Array[]; readonly maxProofBytes?: number } = {},
): Promise<Proven> {
  const [first] = logged;
  if (first === undefined) return { checkpoints: [], nodes: [] };
  const electionId = first.election_id;
  const segments = logged.map((c) => c.segment);
  const high = Math.max(...segments);
  // Where the range starts is the node's answer, used only to choose which
  // slots to ask proofs for: the reader proves the lowest-segment word itself
  // and starts there, so a node that names a higher one leaves a needed
  // proof out (`l1-proof-missing`), and one that names a lower one costs
  // proofs of empty slots.
  const claimed = await rpc.call("eth_getStorageAt", [
    hex(anchor),
    hex(lowestSegmentSlot(electionId)),
    `0x${header.number.toString(16)}`,
  ]);
  if (typeof claimed !== "string" || !/^0x[0-9a-fA-F]{0,64}$/u.test(claimed))
    throw new RpcError("eth_getStorageAt: not a word");
  const lowestPlusOne = claimed === "0x" ? 0n : BigInt(claimed);
  let low = Math.min(...segments);
  if (lowestPlusOne > 0n && lowestPlusOne - 1n < BigInt(low)) low = Number(lowestPlusOne - 1n);
  if (high - low + 1 > MAX_SEGMENTS_READ) throw new L1Error("l1-range-too-long");
  const slots = [lowestSegmentSlot(electionId)];
  for (let s = low; s <= high; s++) slots.push(checkpointSlot(electionId, s));
  const nodes = await proofNodes(
    rpc,
    anchor,
    header,
    [...slots, ...(options.extraSlots ?? [])],
    options.maxProofBytes,
  );
  // Pinning judges no timing: a word proven at the header's block is held by
  // the anchor, whenever it was written, and the board checks' windows are
  // the verifier's. A clock of period 1 from time 0 makes every segment up to
  // the highest logged one ended, and a first segment of 0 starts the range
  // at the proven lowest one, so the reader proves exactly that range.
  const anchors = anchorsFromState(
    { header, anchor, firstSegment: 0, nodes: new NodePool(nodes), checkpoints: logged },
    electionId,
    [],
    { epoch: 0n, period: 1n, deadline: 0n, lastSegment: high },
  );
  return { checkpoints: anchors.map((a) => a.anchor.checkpoint), nodes };
}

/** The anchoring clock the board anchor's deployment fixed (docs/spec/board.md, Timing). */
export interface AnchorTiming {
  readonly epoch: bigint;
  readonly period: bigint;
  readonly deadline: bigint;
}

/**
 * The anchor's `epoch()`, `period()` and `deadline()` at the header's block.
 * They are immutables in its code, which no storage proof reaches, so these
 * are the node's answers: the verifier reports the clock as a local input
 * until a release pins the deployment's clock ([[verifier]], Bundle).
 */
export async function anchorTiming(
  rpc: Rpc,
  anchor: Uint8Array,
  header: L1Header,
): Promise<AnchorTiming> {
  const read = async (getter: string) => {
    const data = keccak_256(new TextEncoder().encode(`${getter}()`)).slice(0, 4);
    const answer = await rpc.call("eth_call", [
      { to: hex(anchor), data: hex(data) },
      `0x${header.number.toString(16)}`,
    ]);
    if (typeof answer !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(answer))
      throw new RpcError(`${getter}: not a word`);
    const value = BigInt(answer);
    if (value >= 2n ** 64n) throw new RpcError(`${getter}: not a u64`);
    return value;
  };
  const timing = {
    epoch: await read("epoch"),
    period: await read("period"),
    deadline: await read("deadline"),
  };
  if (timing.period === 0n) throw new RpcError("period: zero");
  return timing;
}
