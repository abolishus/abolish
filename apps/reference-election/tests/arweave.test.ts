import {
  decodeArchiveLocator,
  decodeArchiveManifest,
  objectCid,
  readArchivedObject,
} from "@abolishus/crypto";
import { arweaveWallet, HttpArweaveClient } from "@abolishus/worker";
import fc from "fast-check";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { archiveObjects } from "../src/archive.ts";
import { arweaveServer, type LocalArweave, localPrice, startArweave } from "../src/arweave.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

// One wallet for every test: a 4096-bit key takes a while to make.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 4096, publicExponent: 65537 });
const wallet = arweaveWallet(privateKey.export({ format: "jwk" }));

/** Every answer the node gave, by route, so a test can see why it refused. */
interface Answer {
  readonly path: string;
  readonly status: number;
  readonly text: string;
}

/**
 * A client of `url` whose requests go through `rewrite` (a request's path
 * and JSON body, either replaced), with every answer but the raw route's
 * recorded.
 */
function clientOf(
  url: string,
  rewrite: (
    path: string,
    body: Record<string, unknown> | undefined,
  ) => {
    path?: string;
    body?: Record<string, unknown>;
    answer?: string;
  } = () => ({}),
) {
  const answers: Answer[] = [];
  const fetchVia = (async (input: string | URL | Request, init?: RequestInit) => {
    const at = new URL(input as string);
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const r = rewrite(at.pathname, body);
    if (r.answer !== undefined) return new Response(r.answer);
    const res = await fetch(`${at.origin}${r.path ?? at.pathname}`, {
      ...init,
      ...(body === undefined ? {} : { body: JSON.stringify(r.body ?? body) }),
    });
    if (at.pathname.startsWith("/raw/")) return res;
    const text = await res.text();
    answers.push({ path: at.pathname, status: res.status, text });
    return new Response(text, { status: res.status });
  }) as typeof globalThis.fetch;
  const client = new HttpArweaveClient(new URL(url), wallet, {
    maxReward: 10n ** 15n,
    retryDelayMs: 0,
    fetch: fetchVia,
  });
  return { client, answers };
}

describe("the local Arweave node", () => {
  const server = arweaveServer();
  let url = "";
  const mine = async (n: number) => {
    const res = await fetch(`${url}/mine/${n}`, { method: "POST" });
    expect(res.status).toBe(200);
  };
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("takes the worker's uploads at every chunk shape and serves them once mined, as deep as the blocks above", async () => {
    const { client, answers } = clientOf(url);
    // One chunk; exactly one full chunk (an empty last leaf); a remainder
    // under 32 KiB split with the chunk before it; and several chunks.
    const sizes = [1, 256 * 1024, 256 * 1024 + 1, 600 * 1024 + 7];
    const posted = [];
    for (const size of sizes) {
      const data = new Uint8Array(randomBytes(size));
      posted.push({ data, id: await client.post(data) });
    }
    expect(answers.filter((a) => a.status !== 200)).toEqual([]);
    for (const { id } of posted) {
      expect(await client.confirmations(id)).toBeUndefined();
      expect(await client.data(id, 1 << 20)).toBeUndefined();
    }
    await mine(3);
    for (const { data, id } of posted) {
      expect(await client.confirmations(id)).toBe(3);
      expect(hex((await client.data(id, data.length)) ?? new Uint8Array())).toBe(hex(data));
    }
    await mine(1);
    expect(await client.confirmations(posted[0]!.id)).toBe(4);
    // A transaction it never took is unknown.
    expect(await client.confirmations(new Uint8Array(32))).toBeUndefined();
  });

  test("takes any data's chunks under the root its header signed", async () => {
    const { client } = clientOf(url);
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 700 * 1024 }), async (size) => {
        const data = new Uint8Array(randomBytes(size));
        const id = await client.post(data);
        await mine(1);
        expect(hex((await client.data(id, size)) ?? new Uint8Array())).toBe(hex(data));
      }),
      { numRuns: Math.min(numRuns, 20) },
    );
  });

  test("takes a header it already holds again as 208, adding nothing", async () => {
    let header: Record<string, unknown> | undefined;
    const { client } = clientOf(url, (path, body) => {
      if (path === "/tx") header = body;
      return {};
    });
    await client.post(Uint8Array.of(1, 2, 3));
    const again = await fetch(`${url}/tx`, { method: "POST", body: JSON.stringify(header) });
    expect(again.status).toBe(208);
  });

  test("refuses a header whose signature, ID, anchor, reward or form isn't a node's to take", async () => {
    const anchor = await (await fetch(`${url}/tx_anchor`)).text();
    const refused = async (
      rewrite: Parameters<typeof clientOf>[1],
      text: RegExp,
    ): Promise<void> => {
      const { client, answers } = clientOf(url, rewrite);
      await expect(client.post(Uint8Array.of(9))).rejects.toThrow(/refused the transaction/);
      expect(answers.find((a) => a.path === "/tx")?.text).toMatch(text);
    };
    await refused(
      (path, body) =>
        path === "/tx"
          ? { body: { ...body, reward: `${BigInt(body!["reward"] as string) + 1n}` } }
          : {},
      /verification failed/,
    );
    await refused(
      (path, body) => (path === "/tx" ? { body: { ...body, id: b64(new Uint8Array(32)) } } : {}),
      /Invalid transaction ID/,
    );
    await refused((path) => (path === "/price/1" ? { answer: "1" } : {}), /Reward too low/);
    await refused(
      (path, body) => (path === "/tx" ? { body: { ...body, data: "CQ" } } : {}),
      /chunks only/,
    );
    await refused(
      (path, body) => (path === "/tx" ? { body: { ...body, format: 1 } } : {}),
      /Invalid transaction/,
    );
    // An anchor no block of the last 50 has: unknown, then lapsed.
    await refused(
      (path) => (path === "/tx_anchor" ? { answer: b64(new Uint8Array(48)) } : {}),
      /Invalid anchor/,
    );
    await mine(50);
    await refused((path) => (path === "/tx_anchor" ? { answer: anchor } : {}), /Invalid anchor/);
  });

  test("refuses a chunk its path doesn't prove, so the data is never served", async () => {
    const { client, answers } = clientOf(url, (path, body) =>
      path === "/chunk"
        ? {
            body: {
              ...body,
              chunk: b64(
                Uint8Array.of(0, ...Buffer.from(body!["chunk"] as string, "base64url").subarray(1)),
              ),
            },
          }
        : {},
    );
    const id = await client.post(Uint8Array.of(1, 2, 3, 4));
    expect(answers.filter((a) => a.path === "/chunk").map((a) => a.text)).toEqual([
      "invalid_proof",
      "invalid_proof",
      "invalid_proof",
    ]);
    await mine(1);
    // Mined, since a header is mined whether or not its data arrives.
    expect(await client.confirmations(id)).toBe(1);
    expect(await client.data(id, 4)).toBeUndefined();
  });

  test("quotes a base fee and a rate per byte", async () => {
    expect(await (await fetch(`${url}/price/0`)).text()).toBe(localPrice(0).toString());
    expect(await (await fetch(`${url}/price/1000`)).text()).toBe("2000000");
    expect((await fetch(`${url}/price/01`)).status).toBe(404);
  });
});

describe("the archive on the node in its own process", () => {
  let node: LocalArweave;
  beforeAll(async () => {
    node = await startArweave();
  }, 30_000);
  afterAll(async () => {
    await node.close();
  });

  test("lists every distinct object once in manifest 0, which the version-3 locator names, each served as its CID", async () => {
    const objects = [Uint8Array.of(1), new Uint8Array(randomBytes(300 * 1024)), Uint8Array.of(2)];
    const anchor = new Uint8Array(20).fill(0xab);
    const archived = await archiveObjects(node, [...objects, Uint8Array.of(1)], {
      l1ChainId: 31337n,
      anchor,
    });
    const named = decodeArchiveLocator(archived.locator, [3]);
    if (named.kind !== "manifest") throw new Error(`the locator is ${named.kind}`);
    expect(hex(named.manifest)).toBe(hex(archived.manifest.cid));
    expect(hex(named.transaction)).toBe(hex(archived.manifest.transaction));
    const client = clientOf(node.url).client;
    const read = async (cid: Uint8Array, transaction: Uint8Array, bound: number) => {
      const data = await client.data(transaction, bound + 1024);
      if (data === undefined) return undefined;
      const r = readArchivedObject(data, cid, bound);
      return r.ok ? r.bytes : undefined;
    };
    const bytes = await read(named.manifest, named.transaction, 1 << 20);
    if (bytes === undefined) throw new Error("the manifest isn't served");
    const manifest = decodeArchiveManifest(bytes, 3);
    expect(manifest.sequence).toBe(0n);
    expect(manifest.l1_chain_id).toBe(31337n);
    expect(hex(manifest.anchor)).toBe(hex(anchor));
    expect(manifest.links).toEqual([]);
    expect(manifest.objects.map((o) => hex(o.cid))).toEqual(
      objects.map((o) => hex(objectCid(o))).sort(),
    );
    for (const o of objects) {
      const listed = manifest.objects.find((m) => hex(m.cid) === hex(objectCid(o)));
      if (listed === undefined) throw new Error("an object isn't listed");
      expect(await client.confirmations(listed.transaction)).toBeGreaterThanOrEqual(25);
      expect(hex((await read(listed.cid, listed.transaction, o.length)) ?? new Uint8Array())).toBe(
        hex(o),
      );
    }
    // Withheld, the data is served by no route; released, it is again.
    const [first] = manifest.objects;
    if (first === undefined) throw new Error("no object listed");
    await node.withhold(first.transaction);
    expect(await client.data(first.transaction, 1 << 20)).toBeUndefined();
    await node.release(first.transaction);
    expect(await client.data(first.transaction, 1 << 20)).toBeDefined();
  }, 60_000);
});
