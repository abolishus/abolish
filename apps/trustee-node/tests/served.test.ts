// What the seat serves (docs/spec/availability.md, What a seat does, 4): the
// blocks directory as read at start, and every object pinned since, at once
// and after a restart, over the trustless gateway.
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHUNK_SIZE,
  cidText,
  contentDag,
  objectCar,
  objectCid,
  readObjectAsync,
} from "@abolishus/crypto";
import { gateway } from "@abolishus/node";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { servedBlocks } from "../src/served.ts";

const key = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (length: number, seed: number) =>
  Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "trustee-node-served-"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const fresh = async (name: string) => {
  const d = join(dir, name);
  await mkdir(d);
  return d;
};

describe("servedBlocks", () => {
  test("serves the directory's files and every block of what it pins, at once and after a restart", async () => {
    const d = await fresh("pin");
    const held = bytes(100, 1);
    await writeFile(join(d, `${cidText(objectCid(held))}.car`), objectCar(held));
    const served = await servedBlocks(d);
    expect(served.files).toMatchObject([{ blocks: 1, unreadableBytes: 0 }]);
    expect(key((await served.block(objectCid(held))) as Uint8Array)).toBe(
      key(contentDag(held).blocks[0]?.bytes as Uint8Array),
    );
    // More than one chunk, so the object is a root and its leaves.
    const object = bytes(2 * CHUNK_SIZE + 5, 2);
    const cid = objectCid(object);
    expect(await served.block(cid)).toBeUndefined();
    expect(await served.pin(cid, object)).toBe("pinned");
    const read = await readObjectAsync(cid, object.length, async (c) => {
      const b = await served.block(c);
      return b === undefined ? [] : [b];
    });
    expect(read.ok && key(read.bytes)).toBe(key(object));
    expect(await served.pin(cid, object)).toBe("held");
    expect(await served.pin(objectCid(held), held)).toBe("held");
    // The file is the object's own CAR, so a restart serves it from disk.
    expect(key(await readFile(join(d, `${cidText(cid)}.car`)))).toBe(key(objectCar(object)));
    const restarted = await servedBlocks(d);
    for (const block of contentDag(object).blocks)
      expect(key((await restarted.block(block.cid)) as Uint8Array)).toBe(key(block.bytes));
  });

  test("refuses an object under another CID, writing nothing", async () => {
    const d = await fresh("wrong");
    const served = await servedBlocks(d);
    const cid = objectCid(bytes(10, 3));
    await expect(served.pin(cid, bytes(10, 4))).rejects.toThrow("an object whose CID");
    expect(await readdir(d)).toEqual([]);
    expect(await served.block(cid)).toBeUndefined();
  });

  test("fails a pin it can't write, serving nothing for it", async () => {
    const d = await fresh("gone");
    const served = await servedBlocks(d);
    await rm(d, { recursive: true });
    const object = bytes(10, 5);
    await expect(served.pin(objectCid(object), object)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await served.block(objectCid(object))).toBeUndefined();
  });

  test("the gateway over it answers for an object as soon as it is pinned", async () => {
    const d = await fresh("gateway");
    const served = await servedBlocks(d);
    const server = gateway(served);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const object = bytes(64, 6);
      const cid = objectCid(object);
      const get = () => fetch(`${base}/ipfs/${cidText(cid)}?format=raw`);
      expect((await get()).status).toBe(404);
      await served.pin(cid, object);
      const res = await get();
      expect(res.status).toBe(200);
      expect(key(new Uint8Array(await res.arrayBuffer()))).toBe(
        key(contentDag(object).blocks[0]?.bytes as Uint8Array),
      );
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
