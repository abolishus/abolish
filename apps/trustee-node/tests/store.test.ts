import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { FileStore, type SeatStore } from "../src/index.ts";
import { MemoryStore } from "../src/store.ts";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "trustee-node-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let fresh = 0;
const stores: Record<string, () => Promise<SeatStore>> = {
  memory: () => Promise.resolve(new MemoryStore()),
  file: () => FileStore.open(join(root, `store-${fresh++}`)),
};

const key = fc
  .array(fc.stringMatching(/^[a-z0-9-]{1,12}$/), { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));
const bytes = fc.uint8Array({ maxLength: 64 });

describe.each(Object.keys(stores))("%s store", (kind) => {
  const make = stores[kind] as () => Promise<SeatStore>;

  test("a record is written once and never replaced", async () => {
    await fc.assert(
      fc.asyncProperty(key, bytes, bytes, async (k, first, second) => {
        const store = await make();
        expect(await store.get(k)).toBeUndefined();
        expect(await store.putOnce(k, first)).toEqual({ created: true, value: first });
        expect(await store.putOnce(k, second)).toEqual({ created: false, value: first });
        expect(await store.get(k)).toEqual(first);
      }),
      { numRuns: kind === "file" ? Math.max(10, Math.ceil(NUM_RUNS / 10)) : NUM_RUNS },
    );
  });

  test("of concurrent writes to one key, exactly one is created and all see it", async () => {
    const store = await make();
    const values = Array.from({ length: 8 }, (_, i) => new Uint8Array([i]));
    const results = await Promise.all(values.map((v) => store.putOnce("a/b", v)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    const kept = results.find((r) => r.created)?.value;
    for (const r of results) expect(r.value).toEqual(kept);
  });

  test("refuses keys outside the naming rule", async () => {
    const store = await make();
    for (const bad of ["", "A", "../x", "a//b", "a/", "/a", "a/.tmp", "a b"])
      await expect(store.putOnce(bad, new Uint8Array(1))).rejects.toThrow(RangeError);
  });

  test("a copy returned can't change the record", async () => {
    const store = await make();
    const value = new Uint8Array([1, 2, 3]);
    const { value: returned } = await store.putOnce("k", value);
    value[0] = 9;
    returned[1] = 9;
    expect(await store.get("k")).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("file store", () => {
  test("records are readable only by their owner and leave no temporary files", async () => {
    const dir = join(root, "modes");
    const store = await FileStore.open(dir);
    await store.putOnce("runs/x/secrets", new Uint8Array([1]));
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "runs/x/secrets"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "runs/x"))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(dir, "runs/x"))).toEqual(["secrets"]);
  });

  test("syncs every directory from the record's up to the root", async () => {
    const dir = join(root, "synced");
    const synced: string[] = [];
    const store = await FileStore.open(dir, (path) => {
      synced.push(path);
      return Promise.resolve();
    });
    await store.putOnce("approvals/ab", new Uint8Array([1]));
    expect(synced).toEqual([join(dir, "approvals"), dir]);
    synced.length = 0;
    await store.putOnce("runs/s/r/begun", new Uint8Array([1]));
    expect(synced).toEqual([join(dir, "runs/s/r"), join(dir, "runs/s"), join(dir, "runs"), dir]);
  });

  test("refuses a root others can reach", async () => {
    const dir = join(root, "open-root");
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    await expect(FileStore.open(dir)).rejects.toThrow(/0700/);
  });

  test("removes the temporary files a crash left behind, and nothing else", async () => {
    const dir = join(root, "crashed");
    const first = await FileStore.open(dir);
    await first.putOnce("runs/x/secrets", new Uint8Array([1]));
    await writeFile(join(dir, "runs/x/.tmp-0123"), new Uint8Array([7]));
    const reopened = await FileStore.open(dir);
    expect(await readdir(join(dir, "runs/x"))).toEqual(["secrets"]);
    expect(await reopened.get("runs/x/secrets")).toEqual(new Uint8Array([1]));
  });

  test("two stores over one directory share the write-once rule", async () => {
    const dir = join(root, "shared");
    const a = await FileStore.open(dir);
    const b = await FileStore.open(dir);
    const [x, y] = await Promise.all([
      a.putOnce("k", new Uint8Array([1])),
      b.putOnce("k", new Uint8Array([2])),
    ]);
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1);
    expect(x.value).toEqual(y.value);
  });
});
