// The archive's Arweave client (P4-3 part 4b-2b-2a; docs/spec/archive.md,
// Archived objects): `ArweaveClient` over one Arweave node's HTTP API, with
// the deployment's wallet. Each post is one format-2 base-layer transaction
// carrying the data and nothing else (no tags, no transfer), signed here and
// uploaded as its header and then its chunks (Arweave's own client sends
// data of one chunk inline instead; nodes take either). The transaction format, its signature data (the
// SHA-384 "deep hash"), the chunking and the data root's Merkle tree are
// Arweave's, written from its reference client (arweave-js 1.15,
// `lib/transaction.ts`, `lib/deepHash.ts`, `lib/merkle.ts`) and checked
// against mainnet transactions (tests/vectors/arweave-transactions.json),
// over node:crypto's SHA-256, SHA-384 and RSA-PSS.
//
// Nothing the node says is trusted for integrity: the archive confirms a
// transaction only once data a node serves for it reads as its CID, and every
// reader checks objects against the anchored checkpoints (T-24, T-49). The
// node is trusted for money: it quotes the reward the wallet pays, so a quote
// above `maxReward` is refused, and the wallet holds only what an operator
// tops it up with (0005-permanent-archive, Keys; T-52). The wallet can only
// add data under its own address, which no reader trusts. Nothing here logs
// or throws the node's URL (it may carry a provider's key) or the key (T-10).

import type { ArweaveClient } from "@abolishus/core";
import { arweaveId } from "@abolishus/crypto";
import { arweaveSource, DEFAULT_GATEWAY_TIMEOUT_MS, parseGateway } from "@abolishus/verifier";
import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  type JsonWebKey,
  type KeyObject,
  sign,
  verify,
} from "node:crypto";

/** The largest chunk Arweave's data tree takes. */
export const MAX_CHUNK_SIZE = 256 * 1024;
/** The smallest chunk but the last: a shorter remainder is split with the chunk before it. */
export const MIN_CHUNK_SIZE = 32 * 1024;

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const sha384 = (...parts: Uint8Array[]) => {
  const h = createHash("sha384");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

/** A 32-byte big-endian note, as the data tree writes offsets. */
function note(n: number): Uint8Array {
  const out = new Uint8Array(32);
  new DataView(out.buffer).setBigUint64(24, BigInt(n));
  return out;
}

/**
 * Where each chunk of `size` bytes ends: 256 KiB chunks, except that a
 * remainder past the last full chunk shorter than 32 KiB is shared with that
 * chunk, which is split in two, the first half rounded up. Data of a whole
 * number of full chunks ends with an empty one, as arweave-js's `chunkData`
 * cuts it: its leaf is in the data root, but nothing is uploaded for it.
 */
export function chunkEnds(size: number): number[] {
  if (!Number.isSafeInteger(size) || size < 1)
    throw new RangeError("chunkEnds: size must be positive");
  const ends: number[] = [];
  let start = 0;
  while (size - start >= MAX_CHUNK_SIZE) {
    const rest = size - start;
    const next = rest - MAX_CHUNK_SIZE;
    start += next > 0 && next < MIN_CHUNK_SIZE ? Math.ceil(rest / 2) : MAX_CHUNK_SIZE;
    ends.push(start);
  }
  ends.push(size);
  return ends;
}

interface TreeNode {
  readonly id: Uint8Array;
  readonly end: number;
  /** A branch's children; a leaf's chunk hash. */
  readonly left?: TreeNode;
  readonly right?: TreeNode;
  readonly chunkHash?: Uint8Array;
}

export interface DataTree {
  /** The transaction's `data_root`. */
  readonly root: Uint8Array;
  /** Each chunk, in order: its bytes' range and its proof (`data_path`). */
  readonly chunks: readonly { start: number; end: number; path: Uint8Array }[];
}

/**
 * The data tree over chunks with these hashes and ends: each leaf is
 * `H(H(chunk hash) ‖ H(end))`, each branch `H(H(left) ‖ H(right) ‖
 * H(left's end))` over SHA-256 with 32-byte notes, paired left to right
 * layer by layer, an odd node out carried up as it is. A chunk's proof is
 * each branch's `left ‖ right ‖ split` from the root down, then its hash and
 * end.
 */
export function chunkTree(leaves: readonly { hash: Uint8Array; end: number }[]): DataTree {
  if (leaves.length === 0) throw new RangeError("chunkTree: no chunks");
  let layer: TreeNode[] = leaves.map(({ hash, end }) => ({
    id: sha256(sha256(hash), sha256(note(end))),
    end,
    chunkHash: hash,
  }));
  while (layer.length > 1) {
    const up: TreeNode[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i]!;
      const right = layer[i + 1];
      up.push(
        right === undefined
          ? left
          : {
              id: sha256(sha256(left.id), sha256(right.id), sha256(note(left.end))),
              end: right.end,
              left,
              right,
            },
      );
    }
    layer = up;
  }
  const root = layer[0]!;
  const chunks: { start: number; end: number; path: Uint8Array }[] = [];
  const walk = (node: TreeNode, path: Uint8Array[]) => {
    if (node.left === undefined || node.right === undefined) {
      const start = chunks.length === 0 ? 0 : chunks[chunks.length - 1]!.end;
      chunks.push({
        start,
        end: node.end,
        path: concat([...path, node.chunkHash!, note(node.end)]),
      });
      return;
    }
    const step = [...path, node.left.id, node.right.id, note(node.left.end)];
    walk(node.left, step);
    walk(node.right, step);
  };
  walk(root, []);
  return { root: root.id, chunks };
}

/** The data tree of `data`, chunked as `chunkEnds` cuts it. */
export function dataTree(data: Uint8Array): DataTree {
  let start = 0;
  return chunkTree(
    chunkEnds(data.length).map((end) => {
      const hash = sha256(data.subarray(start, end));
      start = end;
      return { hash, end };
    }),
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

type DeepHashItem = Uint8Array | readonly DeepHashItem[];

/** Arweave's deep hash: SHA-384 over a tagged tree of byte strings. */
function deepHash(item: DeepHashItem): Uint8Array {
  if (item instanceof Uint8Array) return sha384(sha384(utf8(`blob${item.length}`)), sha384(item));
  let acc = sha384(utf8(`list${item.length}`));
  for (const child of item) acc = sha384(acc, deepHash(child));
  return acc;
}

/** A format-2 transaction's signed fields, as bytes and decimal strings. */
export interface TransactionHeader {
  /** The wallet's RSA modulus, 512 bytes. */
  readonly owner: Uint8Array;
  /** The recipient of `quantity`, or empty. */
  readonly target: Uint8Array;
  /** Winston sent to `target`. */
  readonly quantity: bigint;
  /** Winston paid to the miners. */
  readonly reward: bigint;
  /** The anchor: a recent block's hash or the wallet's last transaction. */
  readonly lastTx: Uint8Array;
  readonly tags: readonly (readonly [name: Uint8Array, value: Uint8Array])[];
  readonly dataSize: number;
  readonly dataRoot: Uint8Array;
}

/** What a format-2 transaction's signature signs. */
export function signatureData(tx: TransactionHeader): Uint8Array {
  return deepHash([
    utf8("2"),
    tx.owner,
    tx.target,
    utf8(tx.quantity.toString()),
    utf8(tx.reward.toString()),
    tx.lastTx,
    tx.tags,
    utf8(tx.dataSize.toString()),
    tx.dataRoot,
  ]);
}

/** A transaction's ID: the SHA-256 of its signature. */
export const transactionId = (signature: Uint8Array) => sha256(signature);

/** The deployment's Arweave wallet: a 4096-bit RSA key, as Arweave's JWK. */
export interface ArweaveWallet {
  /** The public modulus, the transactions' `owner`. */
  readonly owner: Uint8Array;
  /** The address to fund: unpadded base64url of the owner's SHA-256. */
  readonly address: string;
  /** RSA-PSS over SHA-256 with a 32-byte salt, as Arweave verifies it. */
  sign(message: Uint8Array): Uint8Array;
}

/**
 * The wallet from its JWK (the file Arweave's wallets export). Refuses
 * anything but a 4096-bit RSA private key with exponent 65537, the only
 * keys Arweave takes, without quoting it.
 */
export function arweaveWallet(jwk: JsonWebKey): ArweaveWallet {
  let key: KeyObject;
  try {
    if (jwk.kty !== "RSA" || typeof jwk.d !== "string") throw new Error();
    key = createPrivateKey({ key: jwk, format: "jwk" });
  } catch {
    throw new RangeError("the Arweave wallet is not an RSA private key");
  }
  const details = key.asymmetricKeyDetails;
  if (details?.modulusLength !== 4096 || details.publicExponent !== 65537n)
    throw new RangeError("the Arweave wallet is not a 4096-bit RSA key with exponent 65537");
  const publicKey = createPublicKey(key);
  const owner = new Uint8Array(Buffer.from(publicKey.export({ format: "jwk" }).n!, "base64url"));
  const pss = { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 };
  const signWith = (message: Uint8Array) =>
    new Uint8Array(sign("sha256", message, { key, ...pss }));
  // A JWK's private fields aren't checked against its modulus on import, and
  // a wallet whose signatures fail would pay for nothing but refusals.
  const probe = utf8("arweave wallet probe");
  if (!verify("sha256", probe, { key: publicKey, ...pss }, signWith(probe)))
    throw new RangeError("the Arweave wallet's private key doesn't match its modulus");
  return { owner, address: b64url(sha256(owner)), sign: signWith };
}

export interface HttpArweaveOptions {
  /** The most winston one transaction's reward may be; a higher quote is refused (T-52). */
  readonly maxReward: bigint;
  /** How long one request may take; default 30 s. */
  readonly timeoutMs?: number;
  /** How long the first retry of a chunk waits, growing with each; default 1 s. */
  readonly retryDelayMs?: number;
  /** Where requests go: the platform's `fetch` unless a test supplies one. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The most bytes read from an answer but the raw route's: an anchor, a price or a status. */
const ANSWER_LIMIT = 4096;

/** How many times a chunk is sent before the post gives up on it. */
const CHUNK_ATTEMPTS = 3;

// An answer's text if it is at most `ANSWER_LIMIT` bytes, counted as the
// stream arrives and cancelled past it, as the verifier's `bodyWithin` reads.
async function answerText(res: Response): Promise<string | undefined> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > ANSWER_LIMIT) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(concat(chunks));
}

/** One Arweave node's HTTP API with the deployment's wallet. */
export class HttpArweaveClient implements ArweaveClient {
  readonly #base: string;
  readonly #wallet: ArweaveWallet;
  readonly #maxReward: bigint;
  readonly #timeoutMs: number;
  readonly #retryDelayMs: number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #raw: ReturnType<typeof arweaveSource>["source"];

  /** `node` is parsed as the verifier parses a gateway: http(s), no credentials, query or fragment. */
  constructor(node: URL, wallet: ArweaveWallet, options: HttpArweaveOptions) {
    const url = parseGateway(node.href);
    // `parseGateway` leaves a root URL's path as "/", which would double it.
    this.#base = `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    this.#wallet = wallet;
    if (typeof options.maxReward !== "bigint" || options.maxReward < 1n)
      throw new RangeError("maxReward must be a positive bigint");
    this.#maxReward = options.maxReward;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1)
      throw new RangeError("timeoutMs must be a positive integer");
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
    if (!Number.isSafeInteger(this.#retryDelayMs) || this.#retryDelayMs < 0)
      throw new RangeError("retryDelayMs must be a non-negative integer");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#raw = arweaveSource([url], { timeoutMs: this.#timeoutMs, fetch: this.#fetch }).source;
  }

  // One request and its answer's body, at most `ANSWER_LIMIT` bytes, so a
  // node can't stream the worker out of memory (T-52). Every failure is one
  // of our messages, never the platform's, which may name the host.
  async #ask(path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const route = path.split("/", 2).join("/");
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${path}`, {
        ...(body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
        // A redirect could send the wallet's upload to a host never configured.
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new Error(`the Arweave node didn't answer ${route}`);
    }
    let text: string | undefined;
    try {
      text = await answerText(res);
    } catch {
      throw new Error(`the Arweave node didn't answer ${route}`);
    }
    if (text === undefined) throw new Error(`the Arweave node's answer to ${route} is too long`);
    return { status: res.status, text };
  }

  async #text(path: string): Promise<string> {
    const { status, text } = await this.#ask(path);
    if (status !== 200) throw new Error(`the Arweave node refused ${path} (${status})`);
    return text;
  }

  async post(data: Uint8Array): Promise<Uint8Array> {
    const tree = dataTree(data);
    const anchorText = await this.#text("/tx_anchor");
    const lastTx = new Uint8Array(Buffer.from(anchorText, "base64url"));
    // A block's hash (48 bytes) or a transaction's ID (32), as Arweave takes.
    if ((lastTx.length !== 48 && lastTx.length !== 32) || b64url(lastTx) !== anchorText)
      throw new Error("the Arweave node's anchor is malformed");
    const price = await this.#text(`/price/${data.length}`);
    if (!/^[1-9][0-9]{0,29}$/u.test(price))
      throw new Error("the Arweave node's price is malformed");
    const reward = BigInt(price);
    if (reward > this.#maxReward)
      throw new Error(`the Arweave node's price, ${reward} winston, is over maxReward`);
    const header: TransactionHeader = {
      owner: this.#wallet.owner,
      target: new Uint8Array(),
      quantity: 0n,
      reward,
      lastTx,
      tags: [],
      dataSize: data.length,
      dataRoot: tree.root,
    };
    const signature = this.#wallet.sign(signatureData(header));
    const id = transactionId(signature);
    const accepted = await this.#ask("/tx", {
      format: 2,
      id: b64url(id),
      last_tx: anchorText,
      owner: b64url(header.owner),
      tags: [],
      target: "",
      quantity: "0",
      data: "",
      data_size: String(data.length),
      data_root: b64url(tree.root),
      reward: reward.toString(),
      signature: b64url(signature),
    });
    // 208: the node already holds this very transaction.
    if (accepted.status !== 200 && accepted.status !== 208)
      throw new Error(`the Arweave node refused the transaction (${accepted.status})`);
    // From here the header is taken and will be mined and paid for whether or
    // not its chunks arrive, so a chunk the node won't take is tried again,
    // and then the ID is still given: the archive then waits out the depth
    // and `repostAfter` before paying for the object again, where a throw
    // would have it pay on the next run. Data that never arrived is never
    // confirmed, since the archive confirms only data that reads as its CID.
    for (const chunk of tree.chunks) {
      if (chunk.end === chunk.start) continue;
      const upload = {
        data_root: b64url(tree.root),
        data_size: String(data.length),
        data_path: b64url(chunk.path),
        offset: String(chunk.end - 1),
        chunk: b64url(data.subarray(chunk.start, chunk.end)),
      };
      for (let attempt = 1; attempt <= CHUNK_ATTEMPTS; attempt++) {
        const taken = await this.#ask("/chunk", upload).then(
          (r) => r.status === 200,
          () => false,
        );
        if (taken) break;
        if (attempt === CHUNK_ATTEMPTS) return id;
        await new Promise((r) => setTimeout(r, this.#retryDelayMs * attempt));
      }
    }
    return id;
  }

  async confirmations(transaction: Uint8Array): Promise<number | undefined> {
    const { status, text } = await this.#ask(`/tx/${arweaveId(transaction)}/status`);
    // 202: pending in the mempool; 404: unknown, dropped or reorganised away
    // (or a node that hasn't caught up: the object is then paid for again).
    if (status === 202 || status === 404) return undefined;
    if (status !== 200) throw new Error(`the Arweave node refused a status read (${status})`);
    let count: unknown;
    try {
      count = (JSON.parse(text) as { number_of_confirmations?: unknown }).number_of_confirmations;
    } catch {
      count = undefined;
    }
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("the Arweave node's status is malformed");
    // Nodes count the tip block as 1; a 0 from a gateway that counts it as 0
    // is read as 1, so the depth is never more than the node's.
    return Math.max(count, 1);
  }

  async data(transaction: Uint8Array, limit: number): Promise<Uint8Array | undefined> {
    for await (const data of await this.#raw(transaction, limit)) return data;
    return undefined;
  }
}
