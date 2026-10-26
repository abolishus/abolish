import {
  boardEntryHash,
  type Checkpoint,
  decodeArchiveLocator,
  decodeArchiveManifest,
  objectCar,
  readArchivedObject,
} from "@abolishus/crypto";
import { walkArchive } from "@abolishus/verifier";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  type AnchorChain,
  anchorBoards,
  appendEntry,
  archiveBoards,
  archiveLocator,
  archiveManifests,
  archiveObjects,
  type ArchiveOptions,
  type ArchiveRun,
  archiveTransactions,
  type ArweaveClient,
  readBoard,
  takeCheckpoints,
} from "../src/index.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// The worker's archive run (src/archiving.ts, migrations/0046_archive.sql;
// docs/spec/archive.md, Archived objects, Who writes them, Locator; P4-3
// part 4b-1; T-49, T-51): every taken checkpoint's segment object and
// entry-hash list is posted as its CAR, listed only once its upload is deep
// enough, manifests link exactly what the chain rules say, a lost upload is
// posted again with the same bytes, and the locator never falls. The judge
// is the verifier's own walk (`walkArchive`) over what a model of Arweave
// holds: from the latest locator it must reach every manifest and find
// every object, with nothing reported.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const DEPTH = 3;
const REPOST = 100n;
const ANCHOR = new Uint8Array(randomBytes(20));
const L1 = 11_155_111n;

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ballot = (...body: number[]) => Uint8Array.of(0x00, 0x02, 1, ...body);

/**
 * A model of Arweave: a transaction is in a block from the height it was
 * mined at, and is as deep as the blocks on top of it plus one. A dropped
 * transaction is never mined; a reorganisation takes a shallow one out of
 * its block.
 */
class ModelArweave implements ArweaveClient {
  height = 0;
  readonly txs = new Map<
    string,
    { data: Uint8Array; minedAt?: number; dropped?: boolean; withheld?: boolean }
  >();
  /** Makes the next posts throw. */
  failing = false;

  async post(data: Uint8Array) {
    if (this.failing) throw new Error("no node took it");
    const id = new Uint8Array(randomBytes(32));
    this.txs.set(hex(id), { data: Uint8Array.from(data) });
    return id;
  }

  async confirmations(transaction: Uint8Array) {
    const t = this.txs.get(hex(transaction));
    return t?.minedAt === undefined ? undefined : this.height - t.minedAt + 1;
  }

  /** Every pending transaction `pick` chooses into a new block. */
  mine(pick: (id: string) => boolean = () => true) {
    this.height++;
    for (const [id, t] of this.txs)
      if (t.minedAt === undefined && !t.dropped && pick(id)) t.minedAt = this.height;
  }

  /** `n` blocks with nothing of ours. */
  advance(n: number) {
    this.height += n;
  }

  /** Mines the headers of the pending transactions `pick` chooses, their data never uploaded. */
  withhold(pick: (id: string) => boolean) {
    for (const [id, t] of this.txs) if (t.minedAt === undefined && pick(id)) t.withheld = true;
  }

  async data(transaction: Uint8Array, limit: number) {
    const t = this.txs.get(hex(transaction));
    if (t?.minedAt === undefined || t.withheld || t.data.length > limit) return undefined;
    return t.data;
  }

  /** Never mines the pending transactions `pick` chooses. */
  drop(pick: (id: string) => boolean) {
    for (const [id, t] of this.txs) if (t.minedAt === undefined && pick(id)) t.dropped = true;
  }

  /** Takes the transactions shallower than the worker's depth out of their blocks. */
  reorg() {
    for (const t of this.txs.values())
      if (t.minedAt !== undefined && this.height - t.minedAt + 1 < DEPTH) delete t.minedAt;
  }

  /** What a reader is served: the data of a mined transaction, if it was uploaded. */
  readonly source = async (transaction: Uint8Array) => {
    const t = this.txs.get(hex(transaction));
    return t?.minedAt === undefined || t.withheld ? [] : [t.data];
  };
}

let db: TestDb;
let app: Sql;
let now = 1_000_000n;

// The run holds its lock on one connection and works through another.
beforeAll(async () => {
  db = await testDb();
  app = postgres(process.env["TEST_DATABASE_URL"]!, {
    max: 2,
    onnotice: () => {},
    connection: { search_path: db.schema, role: "abolish_app" },
  });
});
afterAll(async () => {
  await app?.end();
  await db?.close();
});

// The archive is the deployment's, one per schema: each test starts from none,
// with no checkpoints but its own. Only a superuser can do this, with the
// triggers off (session_replication_role).
beforeEach(async () => {
  await db.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM archive_transactions`;
    await tx`DELETE FROM archive_objects`;
    await tx`DELETE FROM archive_manifests`;
    await tx`DELETE FROM board_checkpoints`;
  });
});

const DEPLOYMENT = { l1ChainId: L1, anchor: ANCHOR };

const options = (o: Partial<ArchiveOptions> = {}): ArchiveOptions => ({
  latestLocator: undefined,
  l1ChainId: L1,
  anchor: ANCHOR,
  now,
  depth: DEPTH,
  repostAfter: REPOST,
  ...o,
});

const run = (arweave: ArweaveClient, o: Partial<ArchiveOptions> = {}) =>
  archiveBoards(app, arweave, options(o));

/** A board with one entry in each of `segments`, checkpoints taken through the last. */
async function board(...segments: number[]): Promise<{ id: Uint8Array; taken: Checkpoint[] }> {
  const id = await newElection(app);
  for (const [i, s] of segments.entries()) await appendEntry(app, id, s, ballot(i));
  return { id, taken: await takeCheckpoints(app, id, Math.max(...segments)) };
}

/** Mines everything and runs until a run changes nothing. */
async function drain(arweave: ModelArweave, o: Partial<ArchiveOptions> = {}): Promise<ArchiveRun> {
  for (let i = 0; i < 50; i++) {
    arweave.mine();
    arweave.advance(DEPTH);
    now += 1n;
    const r = await run(arweave, o);
    if (r.registered + r.confirmed + r.posted + r.written.length === 0) return r;
  }
  throw new Error("the archive never settled");
}

/** The CIDs every taken checkpoint names. */
const cidsOf = (taken: readonly Checkpoint[]) => taken.flatMap((c) => [c.object_cid, c.hashes_cid]);

/** The verifier's walk from the latest locator, with the earlier ones, finding `objects`. */
async function walk(
  arweave: ModelArweave,
  objects: readonly Uint8Array[],
  earlier: Uint8Array[] = [],
) {
  const latest = await archiveLocator(app, DEPLOYMENT);
  if (latest === undefined) throw new Error("no locator");
  return walkArchive(latest.locator, { l1ChainId: L1, anchor: ANCHOR }, arweave.source, {
    objects,
    earlier,
  });
}

describe("archive tables", () => {
  test("the Drizzle tables are the migrated ones", async () => {
    for (const table of [archiveManifests, archiveObjects, archiveTransactions]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      );
    }
  });

  test("what grows stays grown: no deletes, no relisting, no unconfirming, no changed manifest", async () => {
    const arweave = new ModelArweave();
    await board(0, 1);
    await run(arweave);
    await drain(arweave);
    const owner = await db.as("abolish_migrator");
    // Refused by a trigger or a grant (42501), or, for a table a foreign
    // key names, before its trigger (0A000).
    const refused = async (q: PromiseLike<unknown>) => {
      await expect(q).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|0A000)$/) });
    };
    for (const c of [app, owner]) {
      await refused(c`DELETE FROM archive_transactions`);
      await refused(c`DELETE FROM archive_objects`);
      await refused(c`DELETE FROM archive_manifests`);
      await refused(c`TRUNCATE archive_transactions`);
      await refused(c`TRUNCATE archive_objects`);
      await refused(c`TRUNCATE archive_manifests`);
      await refused(c`UPDATE archive_transactions SET confirmed = false`);
      await refused(c`UPDATE archive_objects SET listed_in = NULL`);
      await refused(c`UPDATE archive_manifests SET manifest = '\\x00'`);
      // A row whose CID isn't its bytes' is refused whoever writes it.
      await expect(
        c`INSERT INTO archive_manifests (sequence, cid, manifest)
          VALUES (99, ${new Uint8Array(36)}, '\\x00')`,
      ).rejects.toMatchObject({ code: "23514" });
    }
    // The app role may set only these columns, and only forward.
    await refused(app`UPDATE archive_objects SET size = size + 1`);
    await refused(app`UPDATE archive_transactions SET posted_at = 0`);
    await refused(owner`UPDATE archive_objects SET size = size + 1`);
  });
});

describe("archiveBoards", () => {
  test("posts each checkpoint's objects as their CARs, the board's own bytes", async () => {
    const arweave = new ModelArweave();
    const { id, taken } = await board(0, 0, 2);
    const r = await run(arweave);
    expect(r).toMatchObject({ busy: false, registered: 4, confirmed: 0, written: [], posted: 4 });
    const entries = await readBoard(app, id);
    const runs = [entries.slice(0, 2), entries.slice(2, 3)];
    const expected = runs.flatMap((e) => [
      objectCar(Buffer.concat(e)),
      objectCar(Buffer.concat(e.map(boardEntryHash))),
    ]);
    const posted = [...arweave.txs.values()].map((t) => hex(t.data)).sort();
    expect(posted).toEqual(expected.map(hex).sort());
    expect(cidsOf(taken)).toHaveLength(4);
    // Nothing is due again while the uploads are live.
    expect(await run(arweave)).toMatchObject({ registered: 0, posted: 0, written: [] });
  });

  test("lists an object only once its upload is deep enough, and names a manifest only once it is", async () => {
    const arweave = new ModelArweave();
    const { taken } = await board(0, 1);
    await run(arweave);
    arweave.mine();
    expect(await run(arweave)).toMatchObject({ confirmed: 0, written: [], locator: undefined });
    arweave.advance(DEPTH - 1);
    expect(await run(arweave)).toMatchObject({ confirmed: 4, written: [0n], posted: 1 });
    expect(await archiveLocator(app, DEPLOYMENT)).toBeUndefined();
    const [row] = await app<{ manifest: Uint8Array }[]>`SELECT manifest FROM archive_manifests`;
    const manifest = decodeArchiveManifest(new Uint8Array(row!.manifest), 3);
    expect(manifest).toMatchObject({
      l1_chain_id: L1,
      sequence: 0n,
      links: [],
      evidence: [],
      runs: [],
    });
    expect(manifest.objects.map((o) => hex(o.cid))).toEqual(cidsOf(taken).map(hex).sort());
    for (const o of manifest.objects)
      expect(await arweave.confirmations(o.transaction)).toBeGreaterThanOrEqual(DEPTH);

    arweave.mine();
    arweave.advance(DEPTH - 1);
    expect(await run(arweave)).toMatchObject({ confirmed: 1, written: [], posted: 0, locator: 0n });
    const latest = await archiveLocator(app, DEPLOYMENT);
    const read = decodeArchiveLocator(latest!.locator, [3]);
    expect(read).toMatchObject({ kind: "manifest", version: 3 });
    const w = await walk(arweave, cidsOf(taken));
    expect(w.findings).toEqual([]);
    expect(w.latest).toBe(0n);
    for (const c of cidsOf(taken)) expect(w.listings.get(hex(c))).toHaveLength(1);
  });

  test("posts again with the same bytes an upload never mined, and leaves a mined one to deepen", async () => {
    const arweave = new ModelArweave();
    await board(0);
    await run(arweave);
    const [first, second] = [...arweave.txs.keys()];
    arweave.drop((id) => id === first);
    arweave.mine((id) => id === second);
    now += REPOST - 1n;
    expect(await run(arweave)).toMatchObject({ posted: 0 });
    now += 1n;
    expect(await run(arweave)).toMatchObject({ posted: 1 });
    const data = [...arweave.txs.values()].map((t) => hex(t.data));
    expect(data).toHaveLength(3);
    expect(data[2]).toBe(data[0]);
  });

  test("posts again an upload a reorganisation took out of its block before it was deep enough", async () => {
    const arweave = new ModelArweave();
    const { taken } = await board(0);
    await run(arweave);
    arweave.mine();
    expect(await run(arweave)).toMatchObject({ confirmed: 0 });
    arweave.reorg();
    arweave.drop(() => true);
    now += REPOST;
    expect(await run(arweave)).toMatchObject({ posted: 2 });
    await drain(arweave);
    const w = await walk(arweave, cidsOf(taken));
    expect(w.findings).toEqual([]);
  });

  test("links a manifest that confirmed late, and names a later one only once one reaches it", async () => {
    const arweave = new ModelArweave();
    const a = await board(0);
    await run(arweave);
    arweave.mine();
    arweave.advance(DEPTH);
    expect(await run(arweave)).toMatchObject({ written: [0n] });
    const manifest0 = [...arweave.txs.keys()].at(-1);
    arweave.drop((id) => id === manifest0);

    const b = await board(1);
    await run(arweave);
    arweave.mine();
    arweave.advance(DEPTH);
    expect(await run(arweave)).toMatchObject({ written: [1n] });
    arweave.mine();
    arweave.advance(DEPTH);
    // Manifest 1 confirmed, but 0 hasn't: no manifest reaches all before it.
    expect(await run(arweave)).toMatchObject({ confirmed: 1, written: [], locator: undefined });
    now += REPOST;
    expect(await run(arweave)).toMatchObject({ posted: 1 });
    arweave.mine();
    arweave.advance(DEPTH);
    // Manifest 0 confirms and meets the rule alone; 0 and 1 are both roots,
    // so a linking manifest is due.
    expect(await run(arweave)).toMatchObject({ confirmed: 1, written: [2n], locator: 0n });
    const final = await drain(arweave);
    expect(final.locator).toBe(2n);
    const w = await walk(arweave, [...cidsOf(a.taken), ...cidsOf(b.taken)]);
    expect(w.findings).toEqual([]);
    expect(w.manifests.map((m) => m.sequence)).toEqual([0n, 1n, 2n]);
  });

  test("refuses to post an object the board no longer gives, and posts the rest", async () => {
    const arweave = new ModelArweave();
    const { id } = await board(0);
    await app`INSERT INTO archive_objects (cid, election_id, kind, first, size)
      VALUES (${new Uint8Array(36).fill(1)}, ${id}, 'hashes', 0, 1)`;
    expect(await run(arweave)).toMatchObject({ registered: 2, posted: 2, refused: 1 });
    expect(arweave.txs.size).toBe(2);
  });

  test("never counts confirmed a transaction mined without its data, and posts it again", async () => {
    const arweave = new ModelArweave();
    const { taken } = await board(0);
    await run(arweave);
    arweave.withhold(() => true);
    arweave.mine();
    arweave.advance(DEPTH);
    expect(await run(arweave)).toMatchObject({ confirmed: 0, written: [], posted: 0 });
    now += REPOST;
    expect(await run(arweave)).toMatchObject({ confirmed: 0, posted: 2 });
    await drain(arweave);
    const w = await walk(arweave, cidsOf(taken));
    expect(w.findings).toEqual([]);
  });

  test("starts no chain of its own while the anchor names one", async () => {
    const arweave = new ModelArweave();
    await board(0);
    const named = new Uint8Array(70);
    await expect(run(arweave, { latestLocator: named })).rejects.toThrow(/doesn't hold/);
    expect(arweave.txs.size).toBe(0);
    // Once its own chain exists, the anchor naming it is what is expected.
    await drain(arweave);
    const latest = await archiveLocator(app, DEPLOYMENT);
    expect(await run(arweave, { latestLocator: latest!.locator })).toMatchObject({ busy: false });
  });

  test("the anchoring run carries the locator the archive names, once it names one", async () => {
    const arweave = new ModelArweave();
    await board(0, 1);
    const calls: (Uint8Array | undefined)[] = [];
    // This deployment's anchor, which serves none of the boards here (each
    // names another), so a run only has the locator to send.
    const chain: AnchorChain = {
      chainId: L1,
      address: ANCHOR,
      clock: { epoch: 0n, period: 3600n, deadline: 43_200n },
      now: async () => 10n * 3600n,
      anchored: async () => undefined,
      latestLocator: async () => calls.at(-1),
      anchor: async (_checkpoints, locator) => void calls.push(locator),
    };
    await run(arweave);
    expect((await anchorBoards(app, chain, 10n * 3600n)).locator).toBeUndefined();
    expect(calls).toEqual([]);
    await drain(arweave);
    const latest = await archiveLocator(app, DEPLOYMENT);
    const sent = await anchorBoards(app, chain, 10n * 3600n);
    expect(sent.locator).toBe("sent");
    expect(calls).toEqual([latest!.locator]);
    expect((await anchorBoards(app, chain, 10n * 3600n)).locator).toBe("held");
    // A database holding another deployment's chain gives no locator, and says so.
    const other = { ...chain, address: new Uint8Array(20) };
    const unread = await anchorBoards(app, other, 10n * 3600n);
    expect(unread.findings).toContainEqual({ code: "anchor-locator-unread" });
    expect(calls).toHaveLength(1);
  });

  test("refuses a stored manifest of another deployment", async () => {
    const arweave = new ModelArweave();
    await board(0);
    await drain(arweave);
    await expect(run(arweave, { anchor: new Uint8Array(20) })).rejects.toThrow(/deployment/);
  });

  test("a run that meets another's lock does nothing", async () => {
    const arweave = new ModelArweave();
    await board(0);
    const other = await db.as("abolish_app");
    await other`SELECT pg_advisory_lock(hashtextextended('archive_writer', 0))`;
    try {
      expect(await run(arweave)).toEqual({
        busy: true,
        registered: 0,
        confirmed: 0,
        written: [],
        posted: 0,
        refused: 0,
        locator: undefined,
      });
      expect(arweave.txs.size).toBe(0);
    } finally {
      await other`SELECT pg_advisory_unlock(hashtextextended('archive_writer', 0))`;
    }
    expect(await run(arweave)).toMatchObject({ busy: false, posted: 2 });
  });

  test("a failed post leaves what was done, and the next run takes up from there", async () => {
    const arweave = new ModelArweave();
    const { taken } = await board(0);
    arweave.failing = true;
    await expect(run(arweave)).rejects.toThrow(/no node took it/);
    arweave.failing = false;
    expect(await run(arweave)).toMatchObject({ registered: 0, posted: 2 });
    await drain(arweave);
    expect((await walk(arweave, cidsOf(taken))).findings).toEqual([]);
  });

  test("refuses malformed options", async () => {
    const arweave = new ModelArweave();
    await expect(run(arweave, { anchor: new Uint8Array(19) })).rejects.toThrow(TypeError);
    await expect(run(arweave, { depth: 0 })).rejects.toThrow(RangeError);
    await expect(run(arweave, { repostAfter: 0n })).rejects.toThrow(RangeError);
    await expect(run(arweave, { l1ChainId: 1n << 64n })).rejects.toThrow(RangeError);
  });

  test("over any history of uploads, losses and reorganisations, the locator never falls and the walk from it finds everything", async () => {
    type Step =
      | { kind: "board"; segments: number[] }
      | { kind: "run" }
      | { kind: "mine"; mask: number }
      | { kind: "advance"; n: number }
      | { kind: "drop"; mask: number }
      | { kind: "withhold"; mask: number }
      | { kind: "reorg" }
      | { kind: "wait" };
    const step: fc.Arbitrary<Step> = fc.oneof(
      fc.record({
        kind: fc.constant("board" as const),
        segments: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 1, maxLength: 3 }),
      }),
      fc.constant({ kind: "run" as const }),
      fc.record({ kind: fc.constant("mine" as const), mask: fc.nat() }),
      fc.record({ kind: fc.constant("advance" as const), n: fc.integer({ min: 1, max: DEPTH }) }),
      fc.record({ kind: fc.constant("drop" as const), mask: fc.nat() }),
      fc.record({ kind: fc.constant("withhold" as const), mask: fc.nat() }),
      fc.constant({ kind: "reorg" as const }),
      fc.constant({ kind: "wait" as const }),
    );
    // A choice of transactions by the bits of `mask`, in posting order.
    const picker = (arweave: ModelArweave, mask: number) => {
      const ids = [...arweave.txs.keys()];
      return (id: string) => ((mask >>> (ids.indexOf(id) % 31)) & 1) === 1;
    };
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { maxLength: 25 }),
        fc.integer({ min: 2, max: 3 }),
        async (steps, maxLinks) => {
          await db.admin.begin(async (tx) => {
            await tx`SET LOCAL session_replication_role = replica`;
            await tx`DELETE FROM archive_transactions`;
            await tx`DELETE FROM archive_objects`;
            await tx`DELETE FROM archive_manifests`;
            await tx`DELETE FROM board_checkpoints`;
          });
          const arweave = new ModelArweave();
          const cids: Uint8Array[] = [];
          const locators: Uint8Array[] = [];
          let named = -1n;
          const runOnce = async () => {
            const r = await run(arweave, { maxLinks });
            // The locator never falls (archive-chain.ts, locatorManifest).
            const at = r.locator ?? -1n;
            expect(at).toBeGreaterThanOrEqual(named);
            named = at;
            const l = await archiveLocator(app, DEPLOYMENT);
            expect(l?.sequence).toBe(r.locator);
            if (l !== undefined) locators.push(l.locator);
            return r;
          };
          for (const s of steps) {
            if (s.kind === "board")
              cids.push(...cidsOf((await board(...s.segments.sort((a, b) => a - b))).taken));
            else if (s.kind === "run") await runOnce();
            else if (s.kind === "mine") arweave.mine(picker(arweave, s.mask));
            else if (s.kind === "advance") arweave.advance(s.n);
            else if (s.kind === "drop") arweave.drop(picker(arweave, s.mask));
            else if (s.kind === "withhold") arweave.withhold(picker(arweave, s.mask));
            else if (s.kind === "reorg") arweave.reorg();
            else now += REPOST;
          }
          // Whatever happened, once uploads go through the archive settles:
          // the latest locator names the latest manifest, and the walk from
          // it, judging every earlier locator, reports nothing and finds
          // every object under a transaction whose data reads as it.
          for (let i = 0; i < 50; i++) {
            now += REPOST;
            arweave.mine();
            arweave.advance(DEPTH);
            const r = await runOnce();
            if (r.registered + r.confirmed + r.posted + r.written.length === 0) break;
          }
          if (cids.length === 0) {
            expect(await archiveLocator(app, DEPLOYMENT)).toBeUndefined();
            return;
          }
          const [row] = await app<
            { count: string }[]
          >`SELECT count(*)::text FROM archive_manifests`;
          const latest = await archiveLocator(app, DEPLOYMENT);
          expect(latest?.sequence).toBe(BigInt(row!.count) - 1n);
          const w = await walk(arweave, cids, locators);
          expect(w.findings).toEqual([]);
          for (const c of cids) {
            const listed = w.listings.get(hex(c)) ?? [];
            expect(listed.length).toBeGreaterThan(0);
            for (const t of listed) {
              const [data] = await arweave.source(t);
              expect(readArchivedObject(data!, c, 1 << 20).ok).toBe(true);
            }
          }
        },
      ),
      { numRuns: Math.min(numRuns, 30) },
    );
  });
});
