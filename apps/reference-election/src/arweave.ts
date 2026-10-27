// The fixture's Arweave (P4-3 part 4b-2b-2b-3b; [[0005-permanent-archive]],
// Reference election): a node of its own on loopback answering the part of
// Arweave's HTTP API the archive's client posts through and the verifier
// reads from (docs/spec/archive.md, Archived objects, Reading from
// gateways): `GET /tx_anchor`, `GET /price/{bytes}`, `POST /tx`,
// `POST /chunk`, `GET /tx/{id}/status` and `GET /raw/{id}`. It takes a
// transaction only as a node does: a format-2 header whose ID is the
// SHA-256 of its signature and whose RSA-PSS signature verifies over the
// deep hash of its fields, anchored to a recent block, paying at least the
// price quoted; and a chunk only with a path that proves it under the data
// root the header signed (arweave-js 1.15 `lib/deepHash.ts` and
// `lib/merkle.ts`'s `validatePath`, written again here from their source,
// so the worker's client is judged by code other than its own). Blocks are
// mined only when the fixture says so, every pending transaction in the
// first, and data is served once its transaction is mined and every chunk
// has arrived, so the archive's confirmation rule (depth, then data that
// reads as its CID) is met here as on Arweave (T-49, T-51).
//
// What it leaves out: wallets and balances (every reward is taken, from
// any owner), forks, gossip, data inline in the header (refused) and every
// route the archive doesn't use. Nothing it holds is trusted by a reader:
// the verifier reads an object only if it reads as its CID (T-24, T-53).
//
// It runs in a process of its own (`arweave-node.ts`), as the community
// node does: the verifier runs while the fixture waits on it, so a node in
// the fixture's own process couldn't answer it. The fixture drives it by
// three routes of its own, which no Arweave node has: `POST /mine/{n}`,
// `POST /withhold/{id}` and `POST /release/{id}`.

import { constants, createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

/** Blocks a transaction's anchor stays valid for, as Arweave counts them. */
const ANCHOR_BLOCKS = 50;
/** The longest body `POST /tx` reads: a header with no data and no tags is about 2 KiB. */
const TX_BODY_LIMIT = 16 * 1024;
/** The longest body `POST /chunk` reads: a 256 KiB chunk in base64url, its path and the fields. */
const CHUNK_BODY_LIMIT = 512 * 1024;
/** The largest chunk Arweave takes. */
const MAX_CHUNK = 256 * 1024;

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
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Unpadded base64url of `length` bytes (any length if undefined), or undefined. */
function unb64(value: unknown, length?: number): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/u.test(value)) return undefined;
  const bytes = new Uint8Array(Buffer.from(value, "base64url"));
  // Only the one encoding of the bytes, so an ID has one spelling.
  if (b64(bytes) !== value) return undefined;
  return length === undefined || bytes.length === length ? bytes : undefined;
}

/** A canonical decimal string's value, or undefined. */
function decimal(value: unknown): bigint | undefined {
  return typeof value === "string" && /^(?:0|[1-9][0-9]{0,29})$/u.test(value)
    ? BigInt(value)
    : undefined;
}

type DeepHashItem = Uint8Array | readonly DeepHashItem[];

// arweave-js `deepHash`: a blob is SHA-384 of its tag and of its bytes; a
// list folds its children into the hash of its tag.
function deepHash(item: DeepHashItem): Uint8Array {
  if (item instanceof Uint8Array) return sha384(sha384(utf8(`blob${item.length}`)), sha384(item));
  return item.reduce<Uint8Array>(
    (acc, child) => sha384(acc, deepHash(child)),
    sha384(utf8(`list${item.length}`)),
  );
}

// arweave-js `validatePath`: the bounds and leaf hash a path proves for
// byte `dest` under `id`, or undefined. Its rewrite of an offset past the
// data's end is left out: `POST /chunk` refuses one first. Each step's hash is SHA-256 over the
// SHA-256 of each part; a branch is `left ‖ right ‖ note(split)`, a leaf
// `hash ‖ note(end)`.
function validatePath(
  id: Uint8Array,
  dest: number,
  left: number,
  right: number,
  path: Uint8Array,
): { left: number; right: number; hash: Uint8Array } | undefined {
  const h = (...parts: Uint8Array[]) => sha256(...parts.map((p) => sha256(p)));
  if (right <= 0) return undefined;
  if (path.length === 64) {
    const leaf = path.subarray(0, 32);
    const end = path.subarray(32, 64);
    return hex(h(leaf, end)) === hex(id) ? { left, right, hash: leaf } : undefined;
  }
  if (path.length < 96) return undefined;
  const l = path.subarray(0, 32);
  const r = path.subarray(32, 64);
  const note = path.subarray(64, 96);
  const split = Number(Buffer.from(note).readBigUInt64BE(24));
  if (hex(h(l, r, note)) !== hex(id)) return undefined;
  return dest < split
    ? validatePath(l, dest, left, Math.min(right, split), path.subarray(96))
    : validatePath(r, dest, Math.max(left, split), right, path.subarray(96));
}

// RSA-PSS over SHA-256 under the owner's modulus with exponent 65537, the
// salt length read from the signature, as Arweave's nodes verify.
function signatureVerifies(owner: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({ key: { kty: "RSA", n: b64(owner), e: "AQAB" }, format: "jwk" });
    return verify(
      "sha256",
      message,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_AUTO },
      signature,
    );
  } catch {
    return false;
  }
}

/** The price this node quotes for `bytes` of data, in winston: a base fee and a rate per byte. */
export function localPrice(bytes: number): bigint {
  return 1_000_000n + 1_000n * BigInt(bytes);
}

interface Transaction {
  readonly dataSize: number;
  readonly dataRoot: Uint8Array;
  /** Each chunk taken, by its first byte's offset. */
  readonly chunks: Map<number, Uint8Array>;
  /** The height of the block that mined it, once one did. */
  minedAt?: number;
}

export interface LocalArweave {
  /** The node's base URL, on loopback. */
  readonly url: string;
  /** Mines `blocks` blocks, the first holding every pending transaction. */
  mine(blocks: number): Promise<void>;
  /** Stops serving `transaction`'s data, as a gateway withholding it would; `release` serves it again. */
  withhold(transaction: Uint8Array): Promise<void>;
  release(transaction: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function body(req: IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > limit) throw new Refusal(413, "Payload Too Large");
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Refusal(400, "Invalid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Refusal(400, "Invalid JSON");
  return value as Record<string, unknown>;
}

/** A node at height 0, not yet listening. */
export function arweaveServer(): Server {
  // Each block's independent hash is 48 bytes, as Arweave's are; the first is
  // random, so no run's transactions can be replayed into another's.
  const blocks: Uint8Array[] = [new Uint8Array(randomBytes(48))];
  const tip = () => blocks.length - 1;
  const txs = new Map<string, Transaction>();
  const pending: Transaction[] = [];
  const withheld = new Set<string>();

  const whole = (tx: Transaction): Uint8Array | undefined => {
    const out = new Uint8Array(tx.dataSize);
    for (let at = 0; at < tx.dataSize;) {
      const chunk = tx.chunks.get(at);
      if (chunk === undefined) return undefined;
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };

  const postTx = (b: Record<string, unknown>): number => {
    const id = unb64(b["id"], 32);
    const owner = unb64(b["owner"], 512);
    const target = unb64(b["target"]);
    const lastTx = unb64(b["last_tx"]);
    const dataRoot = unb64(b["data_root"], 32);
    const signature = unb64(b["signature"], 512);
    const quantity = decimal(b["quantity"]);
    const reward = decimal(b["reward"]);
    const dataSize = decimal(b["data_size"]);
    const tags = b["tags"];
    if (
      b["format"] !== 2 ||
      id === undefined ||
      owner === undefined ||
      target === undefined ||
      (target.length !== 0 && target.length !== 32) ||
      lastTx === undefined ||
      dataRoot === undefined ||
      signature === undefined ||
      quantity === undefined ||
      reward === undefined ||
      dataSize === undefined ||
      !Array.isArray(tags)
    )
      throw new Refusal(400, "Invalid transaction");
    if (b["data"] !== "") throw new Refusal(400, "This node takes data as chunks only");
    if (dataSize < 1n || dataSize > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Refusal(400, "Invalid data size");
    if (quantity !== 0n || target.length !== 0)
      throw new Refusal(400, "This node holds no wallets to transfer between");
    const tagPairs = tags.map((t: unknown) => {
      const tag = t as { name?: unknown; value?: unknown } | null;
      const name = unb64(tag?.name);
      const value = unb64(tag?.value);
      if (name === undefined || value === undefined) throw new Refusal(400, "Invalid tag");
      return [name, value] as const;
    });
    // A recent block's hash: Arweave also takes the wallet's last
    // transaction, which a node without wallets has no record of.
    const anchors = blocks.slice(-ANCHOR_BLOCKS).map(b64);
    if (lastTx.length !== 48 || !anchors.includes(b64(lastTx)))
      throw new Refusal(400, "Invalid anchor (last_tx)");
    if (reward < localPrice(Number(dataSize))) throw new Refusal(400, "Reward too low");
    if (b64(sha256(signature)) !== b64(id)) throw new Refusal(400, "Invalid transaction ID");
    const message = deepHash([
      utf8("2"),
      owner,
      target,
      utf8(quantity.toString()),
      utf8(reward.toString()),
      lastTx,
      tagPairs,
      utf8(dataSize.toString()),
      dataRoot,
    ]);
    if (!signatureVerifies(owner, message, signature))
      throw new Refusal(400, "Transaction verification failed");
    if (txs.has(b64(id))) return 208;
    const tx: Transaction = { dataSize: Number(dataSize), dataRoot, chunks: new Map() };
    txs.set(b64(id), tx);
    pending.push(tx);
    return 200;
  };

  const postChunk = (b: Record<string, unknown>): void => {
    const dataRoot = unb64(b["data_root"], 32);
    const dataSize = decimal(b["data_size"]);
    const offset = decimal(b["offset"]);
    const path = unb64(b["data_path"]);
    const chunk = unb64(b["chunk"]);
    if (
      dataRoot === undefined ||
      dataSize === undefined ||
      offset === undefined ||
      path === undefined ||
      chunk === undefined ||
      chunk.length === 0 ||
      chunk.length > MAX_CHUNK
    )
      throw new Refusal(400, "Invalid chunk");
    const owners = [...txs.values()].filter(
      (t) => hex(t.dataRoot) === hex(dataRoot) && BigInt(t.dataSize) === dataSize,
    );
    if (owners.length === 0) throw new Refusal(400, "data_root_not_found");
    if (offset >= dataSize) throw new Refusal(400, "invalid_offset");
    const proved = validatePath(dataRoot, Number(offset), 0, Number(dataSize), path);
    if (
      proved === undefined ||
      proved.right - proved.left !== chunk.length ||
      hex(proved.hash) !== hex(sha256(chunk))
    )
      throw new Refusal(400, "invalid_proof");
    for (const t of owners) t.chunks.set(proved.left, chunk);
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://node").pathname;
    const send = (status: number, text: string, type = "text/plain") => {
      res.writeHead(status, { "content-type": type });
      res.end(text);
    };
    try {
      if (req.method === "GET" && path === "/tx_anchor") return send(200, b64(blocks[tip()]!));
      const price = /^\/price\/(0|[1-9][0-9]{0,9})$/u.exec(path);
      if (req.method === "GET" && price) return send(200, localPrice(Number(price[1])).toString());
      if (req.method === "POST" && path === "/tx") {
        const status = postTx(await body(req, TX_BODY_LIMIT));
        return send(status, "OK");
      }
      if (req.method === "POST" && path === "/chunk") {
        postChunk(await body(req, CHUNK_BODY_LIMIT));
        return send(200, "OK");
      }
      const status = /^\/tx\/([A-Za-z0-9_-]{43})\/status$/u.exec(path);
      if (req.method === "GET" && status) {
        const tx = txs.get(status[1]!);
        if (tx === undefined) return send(404, "Not Found");
        if (tx.minedAt === undefined) return send(202, "Pending");
        return send(
          200,
          JSON.stringify({
            block_height: tx.minedAt,
            block_indep_hash: b64(blocks[tx.minedAt]!),
            // The tip block counts as 1, as nodes count it.
            number_of_confirmations: tip() - tx.minedAt + 1,
          }),
          "application/json",
        );
      }
      const mine = /^\/mine\/([1-9][0-9]{0,3})$/u.exec(path);
      if (req.method === "POST" && mine) {
        for (let i = 0; i < Number(mine[1]); i++) {
          blocks.push(sha384(blocks[tip()]!, utf8(String(blocks.length))));
          if (i === 0) for (const tx of pending.splice(0)) tx.minedAt = tip();
        }
        return send(200, String(tip()));
      }
      const control = /^\/(withhold|release)\/([A-Za-z0-9_-]{43})$/u.exec(path);
      if (req.method === "POST" && control) {
        if (control[1] === "withhold") withheld.add(control[2]!);
        else withheld.delete(control[2]!);
        return send(200, "OK");
      }
      const raw = /^\/raw\/([A-Za-z0-9_-]{43})$/u.exec(path);
      if (req.method === "GET" && raw) {
        const tx = txs.get(raw[1]!);
        const data = tx?.minedAt === undefined || withheld.has(raw[1]!) ? undefined : whole(tx);
        if (data === undefined) return send(404, "Not Found");
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return res.end(data);
      }
      return send(404, "Not Found");
    } catch (e) {
      if (e instanceof Refusal) return send(e.status, e.message);
      throw e;
    }
  };

  return createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

const NODE = fileURLToPath(new URL("arweave-node.ts", import.meta.url));
/** How long the node may take to listen. */
const STARTUP_MS = 30_000;

/** Starts the node in a process of its own on a free loopback port, at height 0. */
export async function startArweave(): Promise<LocalArweave> {
  const child = spawn(process.execPath, [NODE], { stdio: ["ignore", "pipe", "inherit"] });
  const exited = once(child, "exit");
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  };
  const listening = async (): Promise<number> => {
    for await (const line of createInterface({ input: child.stdout })) {
      const { port } = JSON.parse(line) as { port?: unknown };
      if (typeof port === "number") return port;
    }
    throw new Error("the Arweave node stopped before listening");
  };
  let timer: NodeJS.Timeout | undefined;
  let port: number;
  try {
    port = await Promise.race([
      listening(),
      once(child, "error").then(([e]) => {
        throw e;
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`the Arweave node didn't listen within ${STARTUP_MS} ms`)),
          STARTUP_MS,
        );
      }),
    ]);
  } catch (e) {
    await close();
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const url = `http://127.0.0.1:${port}`;
  const ask = async (path: string) => {
    const res = await fetch(`${url}${path}`, { method: "POST" });
    await res.body?.cancel();
    if (res.status !== 200) throw new Error(`the Arweave node refused ${path} (${res.status})`);
  };
  return {
    url,
    mine: (n) => ask(`/mine/${n}`),
    withhold: (transaction) => ask(`/withhold/${b64(transaction)}`),
    release: (transaction) => ask(`/release/${b64(transaction)}`),
    close,
  };
}
