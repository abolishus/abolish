// A contract's event accumulator proven under an L2 output root a dispute
// game on L1 claims (docs/spec/contracts.md, Event accumulator, Output root),
// as the worker's registry sync reads it (apps/worker src/output-roots.ts),
// over this package's own JSON-RPC client. The L1 node names, at its
// finalized head, the games of the type the L2's portal respects; the L2 node
// serves the claimed block's header, the message passer's storage root and
// the contract's account and storage proofs, which the verifier's own reader
// checks against the root. So the L2 node is trusted for nothing but
// availability (T-71, T-34). The L1 node is trusted for its `eth_call`
// answers about the games, as the worker's is: they aren't proven against the
// finalized state yet (a game's root claim and block are immutables in its
// code, which an account proof reaches through the code hash). An unresolved
// game is its proposer's word until it resolves, and a game the guardian has
// blacklisted or retired is still taken (T-71).

import type { ProvenEventAccumulator } from "@abolishus/crypto";
import {
  ACCUMULATOR_SLOT,
  accumulatorAtOutputRoot,
  decodeHeader,
  type L1Header,
  RlpError,
} from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { finalizedHeader, headerRlp, proofNodes } from "./l1.ts";
import { type Rpc, RpcError } from "./rpc.ts";

/** The L2ToL1MessagePasser predeploy, whose storage root the output root commits to. */
export const MESSAGE_PASSER = hexToBytes("4200000000000000000000000000000000000016");

/**
 * The most games read back from the factory's newest for one of the
 * respected type: a factory serving other types too can't make one read
 * walk its whole list (T-52).
 */
export const MAX_GAMES_SCANNED = 64n;

/** `GameStatus.CHALLENGER_WINS`: the game's claim was shown false. */
const CHALLENGER_WINS = 1n;

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const selector = (signature: string) => keccak_256(new TextEncoder().encode(signature)).slice(0, 4);

const word = (n: bigint) => {
  const w = new Uint8Array(32);
  for (let i = 31, x = n; x > 0n; i--, x >>= 8n) w[i] = Number(x & 0xffn);
  return w;
};

const uint = (w: Uint8Array) => BigInt(hex(w));

/** An output root a dispute game claims, and the L2 block it claims it for. */
export interface ClaimedOutputRoot {
  readonly outputRoot: Uint8Array;
  readonly l2Block: bigint;
}

/** The root proves another L2 block than the one its game claims. */
export class GameBlockError extends Error {
  override readonly name = "GameBlockError";
  readonly code = "l2-block";
  constructor() {
    super("l2-block");
  }
}

// The `words` 32-byte words `signature` returns from `to` at `block`, each
// within `bits` where given, so an answer no contract of that ABI returns is
// the node's error, never read as a smaller value.
async function call(
  rpc: Rpc,
  to: Uint8Array,
  signature: string,
  args: readonly bigint[],
  block: bigint,
  bits: readonly number[],
): Promise<Uint8Array[]> {
  const data = new Uint8Array(4 + 32 * args.length);
  data.set(selector(signature));
  for (const [i, a] of args.entries()) data.set(word(a), 4 + 32 * i);
  const answer = await rpc.call("eth_call", [
    { to: hex(to), data: hex(data) },
    `0x${block.toString(16)}`,
  ]);
  const bytes = 64 * bits.length;
  if (typeof answer !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${bytes}}$`, "u").test(answer))
    throw new RpcError(`${signature}: not ${bits.length} words`);
  const out = hexToBytes(answer.slice(2));
  return bits.map((b, i) => {
    const w = out.subarray(32 * i, 32 * i + 32);
    if (b < 256 && uint(w) >> BigInt(b) !== 0n)
      throw new RpcError(`${signature}: a word past ${b} bits`);
    return w;
  });
}

const address = (w: Uint8Array) => w.slice(12);

/**
 * Of the newest `MAX_GAMES_SCANNED` games at the L1 node's finalized head,
 * those of the type the portal respects there, from the factory the portal
 * names, that haven't been shown false, highest claimed L2 block first. The
 * type is the portal's, never configured, since a type anyone can create
 * without a proof would let anyone post a root (T-71). Every read is at that
 * block, so a game created or resolved later doesn't move the answer within
 * one read. Highest block first, so honest roots of old blocks posted later
 * can't move the proof back; and a list, so a reader can pass over a claim
 * no node proves (a block far ahead, a false root) for the next, rather than
 * let whoever posts one stop it until the game is shown false. A game whose
 * own reads fail (another implementation of the type, say) or that claims a
 * block past a `u64` is passed over.
 */
export async function respectedOutputRoots(
  l1: Rpc,
  portal: Uint8Array,
): Promise<ClaimedOutputRoot[]> {
  const { number: at } = await finalizedHeader(l1);
  const [factoryWord] = await call(l1, portal, "disputeGameFactory()", [], at, [160]);
  const [respected] = await call(l1, portal, "respectedGameType()", [], at, [32]);
  const factory = address(factoryWord as Uint8Array);
  const respectedType = uint(respected as Uint8Array);
  const [countWord] = await call(l1, factory, "gameCount()", [], at, [256]);
  const count = uint(countWord as Uint8Array);
  const last = count > MAX_GAMES_SCANNED ? count - MAX_GAMES_SCANNED : 0n;
  const claims: ClaimedOutputRoot[] = [];
  for (let i = count; i > last; i--) {
    const [gameType, , proxy] = await call(
      l1,
      factory,
      "gameAtIndex(uint256)",
      [i - 1n],
      at,
      [32, 64, 160],
    );
    if (uint(gameType as Uint8Array) !== respectedType) continue;
    const game = address(proxy as Uint8Array);
    let status: Uint8Array, root: Uint8Array, block: Uint8Array;
    try {
      [status] = (await call(l1, game, "status()", [], at, [8])) as [Uint8Array];
      [root] = (await call(l1, game, "rootClaim()", [], at, [256])) as [Uint8Array];
      [block] = (await call(l1, game, "l2SequenceNumber()", [], at, [256])) as [Uint8Array];
    } catch (e) {
      if (e instanceof RpcError) continue;
      throw e;
    }
    if (uint(status) === CHALLENGER_WINS) continue;
    const l2Block = uint(block);
    // No L2 block is numbered past a `u64`, so no such claim can be proven.
    if (l2Block >= 1n << 64n) continue;
    claims.push({ outputRoot: Uint8Array.from(root), l2Block });
  }
  return claims.sort((a, b) => (a.l2Block > b.l2Block ? -1 : a.l2Block < b.l2Block ? 1 : 0));
}

/**
 * `contract`'s event accumulator and count after the L2 block `root`
 * claims, proven under it by the verifier's `accumulatorAtOutputRoot`. The
 * L2 node's block must hash to the hash its own fields give (`headerRlp`).
 * Throws the verifier's `OutputRootError` when the node's answers don't
 * prove against the root, `GameBlockError` when the root proves another
 * block than the game claims, and `RpcError` for an answer that can't be
 * read or proofs past `maxProofBytes`.
 */
export async function accumulatorUnderRoot(
  l2: Rpc,
  root: ClaimedOutputRoot,
  contract: Uint8Array,
  maxProofBytes?: number,
): Promise<ProvenEventAccumulator> {
  const number = `0x${root.l2Block.toString(16)}`;
  const rlp = headerRlp(await l2.call("eth_getBlockByNumber", [number, false]));
  let header: L1Header;
  try {
    header = decodeHeader(rlp);
  } catch (e) {
    if (e instanceof RlpError) throw new RpcError("a block that isn't a header");
    throw e;
  }
  const passer = (await l2.call("eth_getProof", [hex(MESSAGE_PASSER), [], number])) as {
    storageHash?: unknown;
  } | null;
  const storageHash = passer?.storageHash;
  if (typeof storageHash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(storageHash))
    throw new RpcError("eth_getProof: not a storage root");
  const nodes = await proofNodes(
    l2,
    contract,
    header,
    [word(ACCUMULATOR_SLOT), word(ACCUMULATOR_SLOT + 1n)],
    maxProofBytes,
  );
  const proven = accumulatorAtOutputRoot(
    {
      outputRoot: root.outputRoot,
      messagePasserStorageRoot: hexToBytes(storageHash.slice(2)),
      header: rlp,
      nodes,
    },
    contract,
  );
  if (proven.block !== root.l2Block) throw new GameBlockError();
  return { block: proven.block, accumulator: proven.accumulator, count: proven.count };
}
