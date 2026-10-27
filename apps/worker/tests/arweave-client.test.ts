import { constants, createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  arweaveWallet,
  chunkEnds,
  chunkTree,
  dataTree,
  HttpArweaveClient,
  MAX_CHUNK_SIZE,
  MIN_CHUNK_SIZE,
  signatureData,
  type TransactionHeader,
  transactionId,
} from "../src/arweave-client.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const bytes = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// Verifies as an Arweave node does: RSA-PSS over SHA-256, the salt length
// read from the signature, under the owner's modulus with exponent 65537.
function verifies(owner: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({ key: { kty: "RSA", n: b64(owner), e: "AQAB" }, format: "jwk" });
  return verify(
    "sha256",
    message,
    {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_AUTO,
    },
    signature,
  );
}

// arweave-js's `validatePath`, written again here from its source, as a
// check on `chunkTree`'s proofs independent of how they were built: the
// chunk's bounds the path proves for byte `dest`, or undefined.
function validatePath(
  id: Uint8Array,
  dest: number,
  left: number,
  right: number,
  path: Uint8Array,
): { left: number; right: number; hash: Uint8Array } | undefined {
  const h = (...parts: Uint8Array[]) =>
    sha256(Uint8Array.from(Buffer.concat(parts.map((p) => sha256(p)))));
  if (right <= 0) return undefined;
  if (dest >= right) return validatePath(id, 0, right - 1, right, path);
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

interface Vector {
  id: string;
  owner: string;
  target: string;
  quantity: string;
  reward: string;
  last_tx: string;
  tags: { name: string; value: string }[];
  data_size: string;
  data_root: string;
  signature: string;
  chunks: { size: number; sha256: string; data_path: string }[];
  data?: string;
}

const vectors = (
  JSON.parse(
    readFileSync(new URL("./vectors/arweave-transactions.json", import.meta.url), "utf8"),
  ) as { transactions: Vector[] }
).transactions;

const headerOf = (v: Vector): TransactionHeader => ({
  owner: bytes(v.owner),
  target: bytes(v.target),
  quantity: BigInt(v.quantity),
  reward: BigInt(v.reward),
  lastTx: bytes(v.last_tx),
  tags: v.tags.map((t) => [bytes(t.name), bytes(t.value)] as const),
  dataSize: Number(v.data_size),
  dataRoot: bytes(v.data_root),
});

describe("mainnet transactions", () => {
  test("the vectors cover one chunk, a split last pair, an odd count and an odd layer", () => {
    expect(vectors.map((v) => v.chunks.length)).toEqual([1, 2, 3, 6]);
    expect(vectors.some((v) => v.target !== "" && v.quantity !== "0")).toBe(true);
    expect(vectors.some((v) => v.tags.length === 0)).toBe(true);
  });

  test.each(vectors.map((v) => [v.id, v] as const))(
    "%s: its signature signs our signature data",
    (_, v) => {
      const header = headerOf(v);
      const signature = bytes(v.signature);
      expect(verifies(header.owner, signatureData(header), signature)).toBe(true);
      expect(b64(transactionId(signature))).toBe(v.id);
      // Each field is signed: a changed reward, anchor or data size, or a tag
      // dropped, no longer verifies.
      for (const changed of [
        { ...header, reward: header.reward + 1n },
        { ...header, lastTx: header.lastTx.map((b, i) => (i === 0 ? b ^ 1 : b)) },
        { ...header, dataSize: header.dataSize + 1 },
        ...(header.tags.length > 0 ? [{ ...header, tags: header.tags.slice(1) }] : []),
      ]) {
        expect(verifies(header.owner, signatureData(changed), signature)).toBe(false);
      }
    },
  );

  test.each(vectors.map((v) => [v.id, v] as const))(
    "%s: our chunks, data root and data paths are the network's",
    (_, v) => {
      let end = 0;
      const leaves = v.chunks.map((c) => {
        end += c.size;
        return { hash: Uint8Array.from(Buffer.from(c.sha256, "hex")), end };
      });
      expect(chunkEnds(Number(v.data_size))).toEqual(leaves.map((l) => l.end));
      const tree = chunkTree(leaves);
      expect(b64(tree.root)).toBe(v.data_root);
      expect(tree.chunks.map((c) => b64(c.path))).toEqual(v.chunks.map((c) => c.data_path));
      if (v.data !== undefined) {
        const data = Uint8Array.from(Buffer.from(v.data, "hex"));
        expect(b64(dataTree(data).root)).toBe(v.data_root);
      }
    },
  );
});

describe("chunks and the data tree", () => {
  test("chunkEnds: 256 KiB chunks, a short remainder shared with the chunk before it", () => {
    const K = 1024;
    expect(chunkEnds(1)).toEqual([1]);
    expect(chunkEnds(256 * K)).toEqual([256 * K]);
    expect(chunkEnds(256 * K + 1)).toEqual([128 * K + 1, 256 * K + 1]);
    expect(chunkEnds(288 * K)).toEqual([256 * K, 288 * K]);
    expect(chunkEnds(288 * K - 1)).toEqual([144 * K, 288 * K - 1]);
    expect(() => chunkEnds(0)).toThrow(RangeError);
    expect(() => chunkEnds(1.5)).toThrow(RangeError);
    expect(() => chunkTree([])).toThrow(RangeError);
  });

  test("property: chunks tile the data, each within Arweave's bounds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 * MAX_CHUNK_SIZE }), (size) => {
        const ends = chunkEnds(size);
        expect(ends.at(-1)).toBe(size);
        let start = 0;
        for (const end of ends) {
          const length = end - start;
          expect(length).toBeLessThanOrEqual(MAX_CHUNK_SIZE);
          if (ends.length > 1) expect(length).toBeGreaterThanOrEqual(MIN_CHUNK_SIZE);
          start = end;
        }
      }),
      { numRuns },
    );
  });

  test("property: every chunk's path proves exactly its bounds and hash, and nothing else", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.uint8Array({ minLength: 32, maxLength: 32 }),
            fc.integer({ min: 1, max: 1000 }),
          ),
          {
            minLength: 1,
            maxLength: 40,
          },
        ),
        fc.nat(),
        (spec, flip) => {
          let end = 0;
          const leaves = spec.map(([hash, length]) => ({ hash, end: (end += length) }));
          const tree = chunkTree(leaves);
          tree.chunks.forEach((c, i) => {
            expect(c.end).toBe(leaves[i]!.end);
            for (const dest of [c.start, c.end - 1]) {
              const proved = validatePath(tree.root, dest, 0, end, c.path);
              expect(proved).toEqual({ left: c.start, right: c.end, hash: leaves[i]!.hash });
            }
          });
          const c = tree.chunks[flip % tree.chunks.length]!;
          const bad = c.path.slice();
          bad[flip % bad.length]! ^= 1;
          expect(validatePath(tree.root, c.start, 0, end, bad)).toBeUndefined();
        },
      ),
      { numRuns },
    );
  });
});

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096 });
const jwk = privateKey.export({ format: "jwk" });
const wallet = arweaveWallet(jwk);

describe("arweaveWallet", () => {
  test("the owner is the modulus, the address its hash, and signatures verify as Arweave's", () => {
    expect(wallet.owner.length).toBe(512);
    expect(b64(wallet.owner)).toBe(jwk.n);
    expect(wallet.address).toBe(b64(sha256(wallet.owner)));
    const message = new TextEncoder().encode("message");
    const signature = wallet.sign(message);
    expect(signature.length).toBe(512);
    expect(verifies(wallet.owner, message, signature)).toBe(true);
    expect(
      verify(
        "sha256",
        message,
        {
          key: createPublicKey(privateKey),
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32,
        },
        signature,
      ),
    ).toBe(true);
  });

  test("anything but a 4096-bit RSA private key with exponent 65537 is refused, never quoted", () => {
    const small = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      format: "jwk",
    });
    const three = generateKeyPairSync("rsa", {
      modulusLength: 4096,
      publicExponent: 3,
    }).privateKey.export({
      format: "jwk",
    });
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
      format: "jwk",
    });
    const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicOnly } = jwk;
    for (const bad of [small, three, ec, publicOnly, { ...jwk, n: three.n! }, {}]) {
      let message = "";
      try {
        arweaveWallet(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(RangeError);
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(jwk.d!.slice(0, 12));
    }
  });
});

// One Arweave node's HTTP API, as much of it as the client uses: it checks a
// posted transaction's ID and signature and every chunk's path against the
// data root it signed, so the client's uploads are judged as a node would.
class FakeNode {
  readonly txs = new Map<
    string,
    { header: Record<string, unknown>; chunks: Map<number, Uint8Array> }
  >();
  readonly requests: { path: string; redirect: RequestInit["redirect"] }[] = [];
  anchor = b64(new Uint8Array(48).fill(7));
  price = "1000";
  status: Record<string, Response | (() => Response)> = {};
  refuse = new Set<string>();

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input as string);
    const path = url.pathname.replace(/^\/secret-key/u, "");
    this.requests.push({ path, redirect: init?.redirect });
    const route = path.split("/")[1]!;
    if (this.refuse.has(route)) return new Response("no", { status: 400 });
    if (path === "/tx_anchor") return new Response(this.anchor);
    if (path.startsWith("/price/")) return new Response(this.price);
    if (path === "/tx") return this.#tx(JSON.parse(init?.body as string) as Record<string, string>);
    if (path === "/chunk")
      return this.#chunk(JSON.parse(init?.body as string) as Record<string, string>);
    const status = /^\/tx\/([^/]+)\/status$/u.exec(path);
    if (status) {
      const r = this.status[status[1]!];
      return r === undefined
        ? new Response("Not Found", { status: 404 })
        : typeof r === "function"
          ? r()
          : r;
    }
    const raw = /^\/raw\/([^/]+)$/u.exec(path);
    if (raw) {
      const data = this.data(raw[1]!);
      return data === undefined ? new Response("Not Found", { status: 404 }) : new Response(data);
    }
    return new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;

  #tx(body: Record<string, string>): Response {
    const header: TransactionHeader = {
      owner: bytes(body["owner"]!),
      target: bytes(body["target"]!),
      quantity: BigInt(body["quantity"]!),
      reward: BigInt(body["reward"]!),
      lastTx: bytes(body["last_tx"]!),
      tags: [],
      dataSize: Number(body["data_size"]),
      dataRoot: bytes(body["data_root"]!),
    };
    const signature = bytes(body["signature"]!);
    if (
      body["format"] !== (2 as unknown as string) ||
      b64(transactionId(signature)) !== body["id"] ||
      !verifies(header.owner, signatureData(header), signature)
    )
      return new Response("Transaction verification failed.", { status: 400 });
    this.txs.set(body["id"]!, { header: body, chunks: new Map() });
    return new Response("OK");
  }

  #chunk(body: Record<string, string>): Response {
    const tx = [...this.txs.values()].find((t) => t.header["data_root"] === body["data_root"]);
    if (tx === undefined) return new Response("data_root_not_found", { status: 400 });
    const size = Number(body["data_size"]);
    const offset = Number(body["offset"]);
    const chunk = bytes(body["chunk"]!);
    const proved = validatePath(
      bytes(body["data_root"]!),
      offset,
      0,
      size,
      bytes(body["data_path"]!),
    );
    if (
      proved === undefined ||
      proved.right - proved.left !== chunk.length ||
      hex(proved.hash) !== hex(sha256(chunk))
    )
      return new Response("invalid_proof", { status: 400 });
    tx.chunks.set(proved.left, chunk);
    return new Response("OK");
  }

  /** The data uploaded for `id`, once every chunk is. */
  data(id: string): Uint8Array | undefined {
    const tx = this.txs.get(id);
    if (tx === undefined) return undefined;
    const size = Number(tx.header["data_size"]);
    const out = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const chunk = tx.chunks.get(at);
      if (chunk === undefined) return undefined;
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

const NODE = new URL("https://arweave.example/secret-key");

function client(node: FakeNode, maxReward = 10_000n) {
  return new HttpArweaveClient(NODE, wallet, { maxReward, fetch: node.fetch });
}

async function thrown(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a rejection");
}

describe("HttpArweaveClient", () => {
  test.each([1, 1000, MAX_CHUNK_SIZE, MAX_CHUNK_SIZE + 1, 3 * MAX_CHUNK_SIZE - 5])(
    "posts %i bytes as one signed transaction the node reassembles exactly",
    async (size) => {
      const node = new FakeNode();
      const data = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 0xff);
      const id = await client(node).post(data);
      const tx = node.txs.get(b64(id))!;
      expect(tx.header).toMatchObject({
        format: 2,
        tags: [],
        target: "",
        quantity: "0",
        data: "",
        reward: "1000",
        last_tx: node.anchor,
        owner: b64(wallet.owner),
        data_size: String(size),
      });
      // Compared by digest: a deep comparison of a megabyte is slow.
      expect(hex(sha256(node.data(b64(id))!))).toBe(hex(sha256(data)));
      expect(hex(sha256((await client(node).data(id, size))!))).toBe(hex(sha256(data)));
      // Every request refuses redirects, so the upload can't be sent elsewhere.
      expect(node.requests.every((r) => r.redirect === "error")).toBe(true);
    },
  );

  test("a quote over maxReward is refused before anything is signed or sent", async () => {
    const node = new FakeNode();
    node.price = "10001";
    expect(await thrown(client(node).post(new Uint8Array(10)))).toContain("over maxReward");
    expect(node.txs.size).toBe(0);
    node.price = "10000";
    await client(node).post(new Uint8Array(10));
    expect(node.txs.size).toBe(1);
  });

  test("a malformed anchor or price is refused, and nothing is sent", async () => {
    for (const [anchor, price] of [
      [b64(new Uint8Array(31)), "1"],
      [`${b64(new Uint8Array(48))}=`, "1"],
      ["", "1"],
      [b64(new Uint8Array(32)), "-1"],
      [b64(new Uint8Array(32)), "1e3"],
      [b64(new Uint8Array(32)), ""],
      [b64(new Uint8Array(32)), "1".repeat(31)],
    ] as const) {
      const node = new FakeNode();
      node.anchor = anchor;
      node.price = price;
      expect(await thrown(client(node).post(new Uint8Array(10)))).toMatch(/malformed/u);
      expect(node.txs.size).toBe(0);
    }
    const node = new FakeNode();
    node.anchor = b64(new Uint8Array(32).fill(1));
    await client(node).post(new Uint8Array(10));
    expect(node.txs.size).toBe(1);
  });

  test("a refused transaction, chunk, anchor or price throws, naming neither the node's URL nor its key", async () => {
    for (const route of ["tx", "chunk", "tx_anchor", "price"]) {
      const node = new FakeNode();
      node.refuse.add(route);
      const message = await thrown(client(node).post(new Uint8Array(10)));
      expect(message).toMatch(/refused/u);
      expect(message).not.toContain("secret-key");
      expect(message).not.toContain("arweave.example");
    }
    const down = new HttpArweaveClient(NODE, wallet, {
      maxReward: 1n,
      fetch: (() =>
        Promise.reject(new Error("https://arweave.example/secret-key"))) as typeof fetch,
    });
    const message = await thrown(down.post(new Uint8Array(10)));
    expect(message).toBe("the Arweave node didn't answer /tx_anchor");
  });

  test("confirmations: the node's count, none while pending or unknown, and a malformed answer throws", async () => {
    const node = new FakeNode();
    const tx = new Uint8Array(32).fill(3);
    const id = b64(tx);
    const c = client(node);
    expect(await c.confirmations(tx)).toBeUndefined();
    node.status[id] = () => new Response("Pending", { status: 202 });
    expect(await c.confirmations(tx)).toBeUndefined();
    for (const [count, depth] of [
      [0, 1],
      [1, 1],
      [25, 25],
    ]) {
      node.status[id] = () =>
        Response.json({ block_height: 5, block_indep_hash: "x", number_of_confirmations: count });
      expect(await c.confirmations(tx)).toBe(depth);
    }
    for (const bad of [
      () => new Response("oops", { status: 500 }),
      () => new Response("not json"),
      () => Response.json({ number_of_confirmations: -1 }),
      () => Response.json({ number_of_confirmations: 1.5 }),
      () => Response.json({ number_of_confirmations: "3" }),
      () => Response.json({}),
    ]) {
      node.status[id] = bad;
      await expect(c.confirmations(tx)).rejects.toThrow();
    }
  });

  test("data: the raw route's bytes within the limit, none past it or when the node has none", async () => {
    const node = new FakeNode();
    const data = new Uint8Array(500).fill(9);
    const id = await client(node).post(data);
    expect(await client(node).data(id, 500)).toEqual(data);
    expect(await client(node).data(id, 499)).toBeUndefined();
    expect(await client(node).data(new Uint8Array(32), 500)).toBeUndefined();
    expect(node.requests.filter((r) => r.path.startsWith("/raw/")).map((r) => r.path)).toContain(
      `/raw/${b64(id)}`,
    );
  });

  test("a node URL with credentials, a query or a fragment, and a bad maxReward or timeout, are refused", () => {
    for (const url of [
      "https://u:p@arweave.example",
      "https://arweave.example/?k=1",
      "https://arweave.example/#x",
      "ftp://arweave.example",
    ])
      expect(() => new HttpArweaveClient(new URL(url), wallet, { maxReward: 1n })).toThrow(
        RangeError,
      );
    for (const maxReward of [0n, -1n, 1 as unknown as bigint])
      expect(() => new HttpArweaveClient(NODE, wallet, { maxReward })).toThrow(RangeError);
    for (const timeoutMs of [0, 1.5])
      expect(() => new HttpArweaveClient(NODE, wallet, { maxReward: 1n, timeoutMs })).toThrow(
        RangeError,
      );
  });
});
