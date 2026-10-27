import {
  boardEntryHash,
  type Checkpoint,
  type ContractEventEvidence,
  decodeContractEventRun,
  replayEventAccumulator,
  type RunEvent,
  decodeArchiveLocator,
  decodeArchiveManifest,
  encodeArchiveLocator,
  encodeArchiveManifest,
  objectCar,
  objectCid,
  readArchivedObject,
} from "@abolishus/crypto";
import { ACCUMULATOR_SLOT, replayArchive, walkArchive } from "@abolishus/verifier";
import { createHash, randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  type AnchorChain,
  anchorBoards,
  appendEntry,
  archiveBoards,
  archiveEventProgress,
  archiveEvidence,
  archiveLocator,
  archiveManifestSequence,
  archiveManifests,
  archiveObjects,
  type ArchiveOptions,
  ArchiveResumeError,
  type ArchiveRun,
  archiveRuns,
  archiveTransactions,
  type ArweaveClient,
  type ContractEventSource,
  readBoard,
  takeCheckpoints,
} from "../src/index.ts";
import { l2State, word } from "../../verifier/tests/state.ts";
import { newElection, type TestDb, testDb } from "./db.ts";

// The worker's archive run (src/archiving.ts, migrations/0046_archive.sql;
// docs/spec/archive.md, Archived objects, Who writes them, Locator; P4-3
// part 4b-1; T-49, T-51): every taken checkpoint's segment object and
// entry-hash list is posted as its CAR, listed only once its upload is deep
// enough, manifests link exactly what the chain rules say, a lost upload is
// posted again with the same bytes, and the locator never falls. The judge
// is the verifier's own walk (`walkArchive`) over what a model of Arweave
// holds: from the latest locator it must reach every manifest and find
// every object, with nothing reported. After a wipe of the archive's tables
// the run takes up the anchor's chain from Arweave (part 4b-2b-2b-2), and
// the same walk judges the chain it carries on.

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
  app = await db.as("abolish_app", { max: 2 });
});
afterAll(async () => {
  await db?.close();
});

// The archive is the deployment's, one per schema: each test starts from none,
// with no checkpoints but its own. Only a superuser can do this, with the
// triggers off (session_replication_role).
beforeEach(async () => {
  await db.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM archive_transactions`;
    await tx`DELETE FROM archive_runs`;
    await tx`DELETE FROM archive_evidence`;
    await tx`DELETE FROM archive_event_progress`;
    await tx`DELETE FROM archive_objects`;
    await tx`DELETE FROM archive_manifests`;
    await tx`DELETE FROM board_checkpoints`;
  });
});

const DEPLOYMENT = { l1ChainId: L1, anchor: ANCHOR };

/** What a wipe of Postgres loses of the archive: its tables, never the board. */
async function wipe() {
  await db.admin.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`DELETE FROM archive_transactions`;
    await tx`DELETE FROM archive_runs`;
    await tx`DELETE FROM archive_evidence`;
    await tx`DELETE FROM archive_event_progress`;
    await tx`DELETE FROM archive_objects`;
    await tx`DELETE FROM archive_manifests`;
  });
}

const count = async (table: "archive_manifests" | "archive_transactions") => {
  const [row] = await db.admin<{ n: string }[]>`SELECT count(*)::text AS n FROM ${db.admin(table)}`;
  return Number(row!.n);
};

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
    for (const table of [
      archiveManifests,
      archiveObjects,
      archiveTransactions,
      archiveEvidence,
      archiveRuns,
      archiveEventProgress,
    ]) {
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

  test("after a wipe, takes up the anchor's chain from Arweave and carries on from its sequence", async () => {
    const arweave = new ModelArweave();
    const a = await board(0);
    await drain(arweave);
    const b = await board(1);
    await drain(arweave);
    const held = await archiveLocator(app, DEPLOYMENT);
    expect(held?.sequence).toBe(1n);
    const before = arweave.txs.size;

    await wipe();
    const r = await run(arweave, { latestLocator: held!.locator });
    // Every manifest and listing is read back, every object registered again
    // from the board and marked listed, and nothing is posted or written.
    expect(r).toMatchObject({ resumed: 2, registered: 4, posted: 0, written: [], locator: 1n });
    expect(arweave.txs.size).toBe(before);
    expect(await archiveLocator(app, DEPLOYMENT)).toEqual(held);
    const listed = await app<{ n: string }[]>`
      SELECT count(*)::text AS n FROM archive_objects WHERE listed_in IS NOT NULL`;
    expect(listed[0]!.n).toBe("4");

    // A later board goes in manifest 2, which links the resumed chain, and a
    // walk judging the locator the anchor held finds nothing wrong.
    const c = await board(2);
    const final = await drain(arweave, { latestLocator: held!.locator });
    expect(final.locator).toBe(2n);
    const w = await walk(
      arweave,
      [...cidsOf(a.taken), ...cidsOf(b.taken), ...cidsOf(c.taken)],
      [held!.locator],
    );
    expect(w.findings).toEqual([]);
    expect(w.manifests.map((m) => m.sequence)).toEqual([0n, 1n, 2n]);
  });

  test("takes up a chain whose manifests confirmed out of order, through any link that serves", async () => {
    const arweave = new ModelArweave();
    await board(0);
    await run(arweave);
    arweave.mine();
    arweave.advance(DEPTH);
    expect(await run(arweave)).toMatchObject({ written: [0n] });
    const manifest0 = [...arweave.txs.keys()].at(-1);
    arweave.drop((id) => id === manifest0);
    await board(1);
    await run(arweave);
    arweave.mine();
    arweave.advance(DEPTH);
    expect(await run(arweave)).toMatchObject({ written: [1n] });
    arweave.mine();
    arweave.advance(DEPTH);
    await run(arweave);
    now += REPOST;
    await run(arweave);
    const held = (await drain(arweave)).locator;
    expect(held).toBe(2n);
    const latest = await archiveLocator(app, DEPLOYMENT);
    const manifests = await count("archive_manifests");

    await wipe();
    const r = await run(arweave, { latestLocator: latest!.locator });
    expect(r).toMatchObject({ resumed: manifests, posted: 0, written: [], locator: held });
    expect(await archiveLocator(app, DEPLOYMENT)).toEqual(latest);
  });

  test("refuses a chain it can't read whole, writes nothing, and takes it up once it reads", async () => {
    const arweave = new ModelArweave();
    await board(0);
    await drain(arweave);
    await board(1);
    await drain(arweave);
    const latest = await archiveLocator(app, DEPLOYMENT);
    const [manifest0] = await app<{ cid: Uint8Array }[]>`
      SELECT cid FROM archive_manifests WHERE sequence = 0`;
    await wipe();

    // Manifest 0's upload is withheld: the chain doesn't read whole.
    for (const t of arweave.txs.values())
      if (hex(t.data).includes(hex(manifest0!.cid))) t.withheld = true;
    const refused = run(arweave, { latestLocator: latest!.locator });
    await expect(refused).rejects.toThrow(ArchiveResumeError);
    await expect(refused).rejects.toMatchObject({ code: "unavailable" });
    expect(await count("archive_manifests")).toBe(0);
    expect(await count("archive_transactions")).toBe(0);

    for (const t of arweave.txs.values()) t.withheld = false;
    expect(await run(arweave, { latestLocator: latest!.locator })).toMatchObject({
      resumed: 2,
      posted: 0,
      locator: 1n,
    });
  });

  test("refuses a locator it doesn't write, a manifest not deep enough, and another deployment's chain", async () => {
    const arweave = new ModelArweave();
    await board(0);
    await drain(arweave);
    const latest = await archiveLocator(app, DEPLOYMENT);
    await wipe();
    const code = async (o: Partial<ArchiveOptions>, c: string) => {
      await expect(run(arweave, o)).rejects.toMatchObject({ name: "ArchiveResumeError", code: c });
      expect(await count("archive_manifests")).toBe(0);
    };
    await code({ latestLocator: new Uint8Array(70) }, "locator");
    const named = decodeArchiveLocator(latest!.locator, [3]);
    if (named.kind !== "manifest") throw new Error("not a locator");
    await code(
      { latestLocator: encodeArchiveLocator(named.manifest, named.transaction, 2) },
      "locator",
    );
    await code({ latestLocator: latest!.locator, anchor: new Uint8Array(20) }, "foreign");
    await code({ latestLocator: latest!.locator, l1ChainId: L1 + 1n }, "foreign");
    await code({ latestLocator: latest!.locator, depth: 1000 }, "unavailable");
    // Nothing was posted while it refused.
    const size = arweave.txs.size;
    await run(arweave, { latestLocator: latest!.locator });
    expect(arweave.txs.size).toBe(size);
  });

  test("refuses a chain whose links name two manifests at one sequence, or a manifest at the wrong one", async () => {
    const arweave = new ModelArweave();
    // Posted as the worker posts: each manifest's CAR, mined and deep.
    const put = (m: Uint8Array) => {
      const id = new Uint8Array(randomBytes(32));
      arweave.txs.set(hex(id), { data: objectCar(m), minedAt: arweave.height + 1 });
      return { cid: objectCid(m), transaction: id };
    };
    const object = (b: number) => ({
      cid: Uint8Array.of(0x01, 0x55, 0x12, 0x20, ...new Uint8Array(32).fill(b)),
      transaction: new Uint8Array(32).fill(b),
    });
    const manifest = (sequence: bigint, o: Partial<{ objects: unknown[]; links: unknown[] }>) =>
      encodeArchiveManifest(
        {
          l1_chain_id: L1,
          anchor: ANCHOR,
          sequence,
          objects: [],
          links: [],
          evidence: [],
          runs: [],
          ...o,
        } as Parameters<typeof encodeArchiveManifest>[0],
        3,
      );
    const a0 = put(manifest(0n, { objects: [object(1)] }));
    const b0 = put(manifest(0n, { objects: [object(2)] }));
    const m1 = put(manifest(1n, { links: [{ sequence: 0n, ...b0 }] }));
    const m2 = put(
      manifest(2n, {
        links: [
          { sequence: 0n, ...a0 },
          { sequence: 1n, ...m1 },
        ],
      }),
    );
    // Manifest 0 posted again under sequence 1's link: the wrong sequence.
    const m3 = put(manifest(3n, { links: [{ sequence: 1n, ...a0 }] }));
    arweave.advance(DEPTH + 1);
    const locator = (m: { cid: Uint8Array; transaction: Uint8Array }) =>
      encodeArchiveLocator(m.cid, m.transaction, 3);
    await expect(run(arweave, { latestLocator: locator(m2) })).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(run(arweave, { latestLocator: locator(m3) })).rejects.toMatchObject({
      code: "foreign",
    });
    expect(await count("archive_manifests")).toBe(0);
  });

  test("takes up the chain over objects a run posted before the anchor's locator was known", async () => {
    const arweave = new ModelArweave();
    const { taken } = await board(0);
    await drain(arweave);
    const latest = await archiveLocator(app, DEPLOYMENT);
    await wipe();
    // A run without the locator registers and posts the objects again.
    expect(await run(arweave)).toMatchObject({ resumed: 0, registered: 2, posted: 2 });
    const r = await run(arweave, { latestLocator: latest!.locator });
    expect(r).toMatchObject({ resumed: 1, registered: 0, posted: 0, written: [], locator: 0n });
    const settled = await drain(arweave, { latestLocator: latest!.locator });
    expect(settled.locator).toBe(0n);
    expect((await walk(arweave, cidsOf(taken), [latest!.locator])).findings).toEqual([]);
  });

  test("once its own chain exists, the anchor naming it is what is expected", async () => {
    const arweave = new ModelArweave();
    await board(0);
    await drain(arweave);
    const latest = await archiveLocator(app, DEPLOYMENT);
    expect(await run(arweave, { latestLocator: latest!.locator })).toMatchObject({
      busy: false,
      resumed: 0,
    });
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
    // The held locator is judged by our chain's own sequences.
    const named = decodeArchiveLocator(latest!.locator, [3]);
    if (named.kind !== "manifest") throw new Error("not a locator");
    expect(await archiveManifestSequence(app, named.manifest)).toBe(latest!.sequence);
    expect(await archiveManifestSequence(app, new Uint8Array(36))).toBeUndefined();
    // An anchor naming a manifest this database doesn't hold is never overwritten.
    calls.push(Uint8Array.of(...latest!.locator.slice(0, 6), ...new Uint8Array(64)));
    const foreign = await anchorBoards(app, chain, 10n * 3600n);
    expect(foreign.findings).toContainEqual({ code: "anchor-locator-foreign" });
    expect(calls).toHaveLength(2);
    // A database holding another deployment's chain gives no locator, and says so.
    const other = { ...chain, address: new Uint8Array(20) };
    const unread = await anchorBoards(app, other, 10n * 3600n);
    expect(unread.findings).toContainEqual({ code: "anchor-locator-unread" });
    expect(calls).toHaveLength(2);
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
    await other`SELECT pg_advisory_lock(hashtextextended('archive_writer:' || current_schema(), 0))`;
    try {
      expect(await run(arweave)).toEqual({
        busy: true,
        resumed: 0,
        registered: 0,
        confirmed: 0,
        written: [],
        posted: 0,
        refused: 0,
        evidence: 0,
        runs: 0,
        eventFailures: [],
        locator: undefined,
      });
      expect(arweave.txs.size).toBe(0);
    } finally {
      await other`SELECT pg_advisory_unlock(hashtextextended('archive_writer:' || current_schema(), 0))`;
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

  // Each history also replays every contract's archive, so the 30 runs take
  // about two seconds locally and more than the 5 s default on CI's shared
  // runner, where a run left going holds the lock every later test waits on.
  test("over any history of uploads, losses and reorganisations, the locator never falls and the walk from it finds everything", async () => {
    type Step =
      | { kind: "board"; segments: number[] }
      | { kind: "run" }
      | { kind: "mine"; mask: number }
      | { kind: "advance"; n: number }
      | { kind: "drop"; mask: number }
      | { kind: "withhold"; mask: number }
      | { kind: "reorg" }
      | { kind: "wait" }
      | { kind: "wipe" }
      | { kind: "emit"; contract: number }
      | { kind: "l2"; blocks: number }
      | { kind: "l2-down" };
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
      fc.constant({ kind: "wipe" as const }),
      fc.record({ kind: fc.constant("emit" as const), contract: fc.integer({ min: 0, max: 3 }) }),
      fc.record({ kind: fc.constant("l2" as const), blocks: fc.integer({ min: 1, max: 12 }) }),
      fc.constant({ kind: "l2-down" as const }),
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
            await tx`DELETE FROM archive_runs`;
            await tx`DELETE FROM archive_evidence`;
            await tx`DELETE FROM archive_event_progress`;
            await tx`DELETE FROM archive_objects`;
            await tx`DELETE FROM archive_manifests`;
            await tx`DELETE FROM board_checkpoints`;
          });
          const arweave = new ModelArweave();
          const l2 = new ModelL2();
          const cids: Uint8Array[] = [];
          const locators: Uint8Array[] = [];
          let named = -1n;
          // The anchor holds the latest locator a run gave, as the anchoring
          // job carries it, and a run after a wipe takes up its chain.
          const runOnce = async () => {
            const r = await run(arweave, {
              maxLinks,
              latestLocator: locators.at(-1),
              ...eventOptions(l2),
            });
            l2.failing = false;
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
            else if (s.kind === "wipe") await wipe();
            else if (s.kind === "emit") l2.emit(CONTRACTS[ROLES[s.contract]!]);
            else if (s.kind === "l2") l2.advance(BigInt(s.blocks));
            else if (s.kind === "l2-down") l2.failing = true;
            else now += REPOST;
          }
          // Whatever happened, wipes included, once uploads go through the archive settles:
          // the latest locator names the latest manifest, and the walk from
          // it, judging every earlier locator, reports nothing and finds
          // every object under a transaction whose data reads as it, and
          // every contract's archive replays.
          l2.advance(40n);
          for (let i = 0; i < 50; i++) {
            now += REPOST;
            arweave.mine();
            arweave.advance(DEPTH);
            const r = await runOnce();
            if (r.registered + r.confirmed + r.posted + r.written.length + r.evidence === 0) break;
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
          const { replays } = await replay(arweave, locators);
          expectReplays(replays, l2);
          // Every anchored period of every contract has been examined.
          const [progress] = await app<{ n: string }[]>`
            SELECT count(*)::text AS n FROM archive_event_progress
            WHERE segment = (SELECT max(segment) FROM board_checkpoints)`;
          expect(progress!.n).toBe("4");
        },
      ),
      { numRuns: Math.min(numRuns, 30) },
    );
  }, 60_000);
});

// The contract-event evidence and runs (src/archiving.ts, writeContractEvents;
// migrations/0048_archive_contract_events.sql; docs/spec/archive.md,
// Contract-event evidence and Contract-event run, Who writes them; P4-3 part
// 4b-3a; T-71, T-51). The judge is the verifier's own replay
// (`replayArchive`) over what the model of Arweave holds, from the walk of
// the latest locator: every record must prove its contract's accumulator,
// and the runs must replay against every one up to the last event counted.
// The records are built over states the verifier's tests' trie writer makes
// (packages/verifier/tests/state.ts), never by the code under test.

const L2 = 84_532n;
const ROLES = ["election-registry", "trustee-registry", "group-registry", "board"] as const;
const CONTRACTS = {
  "election-registry": new Uint8Array(20).fill(0xc0),
  "trustee-registry": new Uint8Array(20).fill(0xc1),
  "group-registry": new Uint8Array(20).fill(0xc2),
  board: new Uint8Array(20).fill(0xb0),
};
const { board: BOARD, "election-registry": REGISTRY } = CONTRACTS;
/** The L2's first block's timestamp, and the anchor's epoch; a block every 2 seconds. */
const T0 = 1_800_000_000n;
/** Ten L2 blocks a period: period `s` ends at block `10 · (s + 1)`. */
const CLOCK = { epoch: T0, period: 20n };
const blockTime = (b: bigint) => T0 + 2n * b;
const equalBytes = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);

/**
 * A model of the L2 and its games: each emitted event goes in a block of its
 * own after the head, and a respected game claims every fifth block up to
 * `gamesTo`. A record is the contract's accumulator and count at the first
 * claimed block at or after a time, over a state built here.
 */
class ModelL2 implements ContractEventSource {
  head = 0n;
  gamesTo = 1n << 62n;
  readonly logs = new Map<string, RunEvent[]>();
  /** Makes the next reads throw, as a node that is down. */
  failing = false;
  /** Each contract's first block with code; none before it. */
  readonly deployedAt = new Map<string, bigint>();
  /**
   * A forger's history of the board, from which its records and events are
   * both built, so each is consistent with the other.
   */
  forgeLogs: ((logs: RunEvent[]) => RunEvent[]) | undefined;
  /** A forger's accumulator and count for the board's records. */
  forgeState: { accumulator?: Uint8Array; count?: bigint } | undefined;
  /** How many times `events` was asked. */
  eventReads = 0;
  /** Rewrites the board's record or events before they are given. */
  tamper: {
    evidence?: (e: ContractEventEvidence) => ContractEventEvidence;
    events?: (e: RunEvent[]) => RunEvent[];
  } = {};

  emit(contract: Uint8Array, data = Uint8Array.of(1), topics = 1) {
    this.head++;
    const list = this.logs.get(hex(contract)) ?? [];
    list.push({
      l2_block: this.head,
      l2_timestamp: blockTime(this.head),
      topics: Array.from({ length: topics }, (_, i) => new Uint8Array(32).fill(list.length + i)),
      data,
    });
    this.logs.set(hex(contract), list);
  }

  /** Blocks with nothing of ours, so later periods end. */
  advance(blocks: bigint) {
    this.head += blocks;
  }

  history(contract: Uint8Array) {
    const logs = this.logs.get(hex(contract)) ?? [];
    return equalBytes(contract, BOARD) && this.forgeLogs ? this.forgeLogs(logs) : logs;
  }

  counted(contract: Uint8Array, block: bigint) {
    return this.history(contract).filter((e) => e.l2_block <= block);
  }

  async evidence(contract: Uint8Array, after: bigint) {
    if (this.failing) throw new Error("the L2 node is down");
    let block = (after - T0 + 1n) / 2n;
    block = ((block + 4n) / 5n) * 5n;
    if (block > this.head || block > this.gamesTo) return undefined;
    const logs = this.counted(contract, block);
    const state = replayEventAccumulator(
      L2,
      contract,
      logs.map((e) => ({
        block: e.l2_block,
        timestamp: e.l2_timestamp,
        topics: e.topics,
        data: e.data,
      })),
    );
    const forged = equalBytes(contract, BOARD) ? this.forgeState : undefined;
    const deployed = block >= (this.deployedAt.get(hex(contract)) ?? 0n);
    const { evidence } = l2State(
      deployed
        ? [
            {
              address: contract,
              storage: [
                [word(ACCUMULATOR_SLOT), forged?.accumulator ?? state.accumulator],
                [word(ACCUMULATOR_SLOT + 1n), word(forged?.count ?? state.count)],
              ],
            },
          ]
        : [{ address: new Uint8Array(20).fill(0xee), storage: [] }],
      block,
      blockTime(block),
    );
    const nodes = [...new Map(evidence.nodes.map((n) => [hex(n), n])).values()].sort((a, b) =>
      hex(a) < hex(b) ? -1 : 1,
    );
    const record: ContractEventEvidence = {
      l2_chain_id: L2,
      contract,
      game_index: block / 5n,
      game: new Uint8Array(20).fill(0x9a),
      output_root: evidence.outputRoot,
      message_passer_storage_root: evidence.messagePasserStorageRoot,
      header: evidence.header,
      nodes,
    };
    return (equalBytes(contract, BOARD) && this.tamper.evidence?.(record)) || record;
  }

  async events(contract: Uint8Array, from: bigint, to: bigint) {
    if (this.failing) throw new Error("the index is down");
    this.eventReads++;
    const list = this.history(contract).slice(Number(from), Number(to));
    return (equalBytes(contract, BOARD) && this.tamper.events?.(list)) || list;
  }
}

const eventOptions = (l2: ModelL2, o: { maxPeriods?: number } = {}) => ({
  contractEvents: {
    source: l2,
    l2ChainId: L2,
    contracts: ROLES.map((r) => CONTRACTS[r]),
    clock: CLOCK,
    ...o,
  },
});

/** The verifier's walk and replay of every contract, from the latest locator. */
async function replay(arweave: ModelArweave, earlier: Uint8Array[] = []) {
  const latest = await archiveLocator(app, DEPLOYMENT);
  if (latest === undefined) throw new Error("no locator");
  const w = await walkArchive(latest.locator, DEPLOYMENT, arweave.source, {
    earlier,
    contracts: ROLES.map((r) => CONTRACTS[r]),
  });
  expect(w.findings).toEqual([]);
  return { walk: w, replays: await replayArchive(w, CONTRACTS, L2, arweave.source) };
}

/** Every contract's archive replays whole, holding exactly the events its last record counts. */
function expectReplays(replays: Awaited<ReturnType<typeof replay>>["replays"], l2: ModelL2) {
  for (const r of replays) {
    expect(r.evidence.findings).toEqual([]);
    expect(r.runs.findings).toEqual([]);
    expect(r.runs.complete).toBe(true);
    for (const e of r.evidence.records) expect(e.replay).toBeNull();
    const last = r.evidence.records.at(-1);
    const held =
      last === undefined ? 0n : BigInt(l2.counted(r.contract, last.accumulator.block).length);
    expect(r.held).toBe(held);
    // By digest: a deep comparison of MiB-long arrays takes minutes.
    const digest = (d: Uint8Array) => createHash("sha256").update(d).digest("hex");
    expect(r.records.map((x) => digest(x.data))).toEqual(
      (l2.logs.get(hex(r.contract)) ?? []).slice(0, Number(held)).map((e) => digest(e.data)),
    );
  }
}

describe("archiveBoards with contract events", () => {
  test("lists each changed contract's record with its runs, and the verifier's replay holds every one", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    // Period 0 (blocks to 10): the registry twice and the board once; period
    // 1 (to 20): the board alone; period 2 (to 30): nothing.
    l2.emit(REGISTRY);
    l2.emit(BOARD);
    l2.emit(REGISTRY);
    l2.advance(10n);
    l2.emit(BOARD);
    l2.advance(30n);
    await board(0, 1, 2);
    const first = await run(arweave, eventOptions(l2));
    // The registry's record at period 0; the board's at periods 0 and 1.
    expect(first).toMatchObject({ evidence: 3, runs: 3, eventFailures: [] });
    const final = await drain(arweave, eventOptions(l2));
    expect(final.eventFailures).toEqual([]);
    const { walk, replays } = await replay(arweave);
    expect(walk.evidence.map((e) => [hex(e.contract), e.l2Block])).toEqual([
      [hex(BOARD), 10n],
      [hex(BOARD), 20n],
      [hex(REGISTRY), 10n],
    ]);
    expect(walk.runs.map((r) => [hex(r.contract), r.first, r.count])).toEqual([
      [hex(BOARD), 0n, 1],
      [hex(BOARD), 1n, 1],
      [hex(REGISTRY), 0n, 2],
    ]);
    expectReplays(replays, l2);
    expect(replays.find((r) => r.role === "board")?.held).toBe(2n);
    expect(replays.find((r) => r.role === "election-registry")?.held).toBe(2n);
    // Nothing more is due: the periods are examined once.
    expect(await run(arweave, eventOptions(l2))).toMatchObject({ evidence: 0, runs: 0, posted: 0 });
  });

  test("writes a record and its runs only once the period's game exists, and later periods as their boards are anchored", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(BOARD);
    l2.advance(20n);
    l2.gamesTo = 5n;
    await board(0);
    expect(await run(arweave, eventOptions(l2))).toMatchObject({ evidence: 0, runs: 0 });
    l2.gamesTo = 1n << 62n;
    expect(await run(arweave, eventOptions(l2))).toMatchObject({ evidence: 1, runs: 1 });
    await drain(arweave, eventOptions(l2));
    // Periods 1 and 2 are anchored after period 3's events (to block 40).
    l2.emit(BOARD);
    l2.emit(BOARD);
    l2.advance(20n);
    await board(3);
    expect(await run(arweave, eventOptions(l2))).toMatchObject({ evidence: 1, runs: 1 });
    await drain(arweave, eventOptions(l2));
    const { walk, replays } = await replay(arweave);
    const byFirst = [...walk.runs].sort((a, b) => (a.first < b.first ? -1 : 1));
    expect(byFirst.map((r) => [r.first, r.count])).toEqual([
      [0n, 1],
      [1n, 2],
    ]);
    expectReplays(replays, l2);
  });

  test("examines at most maxPeriods periods a run, in order", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    for (let s = 0; s < 3; s++) {
      l2.emit(BOARD);
      l2.advance(10n);
    }
    l2.advance(10n);
    await board(0, 1, 2);
    const o = eventOptions(l2, { maxPeriods: 1 });
    expect(await run(arweave, o)).toMatchObject({ evidence: 1 });
    expect(await run(arweave, o)).toMatchObject({ evidence: 1 });
    expect(await run(arweave, o)).toMatchObject({ evidence: 1 });
    expect(await run(arweave, o)).toMatchObject({ evidence: 0 });
    await drain(arweave, o);
    expectReplays((await replay(arweave)).replays, l2);
  });

  test("refuses a record or events that don't check, writes nothing of the contract, archives the board, and carries on once they check", async () => {
    const cases: [string, ModelL2["tamper"], string][] = [
      [
        "another accumulator",
        { evidence: (e) => ({ ...e, output_root: new Uint8Array(32).fill(7) }) },
        "evidence",
      ],
      ["another L2", { evidence: (e) => ({ ...e, l2_chain_id: L2 + 1n }) }, "evidence"],
      [
        "a node the proof doesn't use",
        {
          evidence: (e) => ({
            ...e,
            nodes: [...e.nodes, new Uint8Array(40).fill(0xff)].sort((a, b) =>
              hex(a) < hex(b) ? -1 : 1,
            ),
          }),
        },
        "evidence",
      ],
      [
        "nodes out of order",
        { evidence: (e) => ({ ...e, nodes: [...e.nodes].reverse() }) },
        "evidence",
      ],
      ["an event left out", { events: (e) => e.slice(1) }, "events"],
      ["an event added", { events: (e) => [...e, e[0]!] }, "events"],
      [
        "an event altered",
        { events: (e) => e.map((x, i) => (i === 0 ? { ...x, data: Uint8Array.of(9) } : x)) },
        "events",
      ],
      ["events reordered", { events: (e) => [...e].reverse() }, "events"],
      [
        "an event past the record's block",
        { events: (e) => e.map((x) => ({ ...x, l2_block: x.l2_block + 1000n })) },
        "events",
      ],
      ["an event with no topic", { events: (e) => e.map((x) => ({ ...x, topics: [] })) }, "events"],
    ];
    for (const [what, tamper, code] of cases) {
      await db.admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        for (const t of [
          "archive_transactions",
          "archive_runs",
          "archive_evidence",
          "archive_event_progress",
          "archive_objects",
          "archive_manifests",
          "board_checkpoints",
        ])
          await tx`DELETE FROM ${tx(t)}`;
      });
      const arweave = new ModelArweave();
      const l2 = new ModelL2();
      l2.emit(BOARD);
      l2.emit(BOARD);
      l2.advance(20n);
      const { taken } = await board(0);
      l2.tamper = tamper;
      const r = await run(arweave, eventOptions(l2));
      expect(r, what).toMatchObject({ evidence: 0, runs: 0, posted: 2 });
      expect(
        r.eventFailures.map((f) => [hex(f.contract), f.error.code]),
        what,
      ).toEqual([[hex(BOARD), code]]);
      expect(await count("archive_transactions"), what).toBe(2);
      // Once the source gives what checks, the period is archived.
      l2.tamper = {};
      await drain(arweave, eventOptions(l2));
      const { replays } = await replay(arweave);
      expectReplays(replays, l2);
      expect(replays.find((x) => x.role === "board")?.held, what).toBe(2n);
      expect((await walk(arweave, cidsOf(taken))).findings, what).toEqual([]);
    }
  });

  test("refuses a record dated before the period's end, or proving less than the last", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(BOARD);
    l2.advance(30n);
    await board(0, 1);
    const honest = l2.evidence.bind(l2);
    // Period 0's end, asked of a source that answers with block 5's record.
    l2.evidence = (c, after) => honest(c, equalBytes(c, BOARD) ? after - 10n : after);
    const early = await run(arweave, eventOptions(l2));
    expect(early.eventFailures.map((f) => [hex(f.contract), f.error.code])).toEqual([
      [hex(BOARD), "evidence"],
    ]);
    expect(early.eventFailures[0]!.error.message).toMatch(/before/);
    l2.evidence = honest;
    expect(await run(arweave, eventOptions(l2))).toMatchObject({ evidence: 1, eventFailures: [] });
    await board(2);
    // Period 2 answered with period 0's block: less than the last record.
    l2.emit(BOARD);
    l2.advance(10n);
    l2.evidence = (c, after) => honest(c, equalBytes(c, BOARD) ? T0 + 20n : after);
    await board(3);
    const stale = await run(arweave, eventOptions(l2));
    expect(stale.eventFailures.map((f) => [hex(f.contract), f.error.code])).toEqual([
      [hex(BOARD), "evidence"],
    ]);
    expect(stale.eventFailures[0]!.error.message).toMatch(/before/);
    // A record dated after the period's end but at a block below the last
    // record's: period 2 is answered with block 60's record, then period 3
    // with block 45's.
    l2.evidence = honest;
    l2.advance(30n);
    await board(5);
    l2.evidence = (c, after) =>
      honest(c, equalBytes(c, BOARD) && after === T0 + 60n ? T0 + 120n : after);
    expect(await run(arweave, eventOptions(l2, { maxPeriods: 1 }))).toMatchObject({
      eventFailures: [],
    });
    l2.evidence = (c, after) =>
      honest(c, equalBytes(c, BOARD) && after === T0 + 80n ? T0 + 90n : after);
    const less = await run(arweave, eventOptions(l2));
    expect(less.eventFailures.map((f) => [hex(f.contract), f.error.code])).toEqual([
      [hex(BOARD), "evidence"],
    ]);
    expect(less.eventFailures[0]!.error.message).toMatch(/less/);
  });

  test("a source that is down holds up no board object, and the contracts carry on when it is back", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(REGISTRY);
    l2.advance(20n);
    const { taken } = await board(0);
    l2.failing = true;
    const r = await run(arweave, eventOptions(l2));
    expect(r).toMatchObject({ evidence: 0, posted: 2 });
    expect(r.eventFailures.map((f) => f.error.code)).toEqual([
      "source",
      "source",
      "source",
      "source",
    ]);
    l2.failing = false;
    await drain(arweave, eventOptions(l2));
    const { replays } = await replay(arweave);
    expectReplays(replays, l2);
    expect((await walk(arweave, cidsOf(taken))).findings).toEqual([]);
  });

  test("splits a period's events into runs within MAX_CONTRACT_EVENT_RUN, each as long as it allows", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    // Seventeen events of a MiB and 60 bytes each: fifteen fit in one run, the rest in the next.
    for (let i = 0; i < 17; i++) l2.emit(BOARD, new Uint8Array(1 << 20).fill(i));
    l2.advance(20n);
    await board(1);
    expect(await run(arweave, eventOptions(l2))).toMatchObject({ evidence: 1, runs: 2 });
    const runs = await app<{ first: string; count: number; run: Uint8Array }[]>`
      SELECT first::text, count, run FROM archive_runs ORDER BY first`;
    expect(runs.map((r) => [r.first, r.count])).toEqual([
      ["0", 15],
      ["15", 2],
    ]);
    for (const r of runs) {
      expect(r.run.length).toBeLessThanOrEqual(1 << 24);
      expect(decodeContractEventRun(new Uint8Array(r.run), 1).events).toHaveLength(r.count);
    }
    await drain(arweave, eventOptions(l2));
    expectReplays((await replay(arweave)).replays, l2);
  }, 30_000);

  test("after a wipe, writes the same records and runs again and marks them listed rather than list them twice", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(BOARD);
    l2.emit(REGISTRY);
    l2.advance(20n);
    await board(0);
    await drain(arweave, eventOptions(l2));
    const held = await archiveLocator(app, DEPLOYMENT);
    const before = arweave.txs.size;
    await wipe();
    const r = await run(arweave, { latestLocator: held!.locator, ...eventOptions(l2) });
    expect(r).toMatchObject({ resumed: 1, evidence: 2, runs: 2, posted: 0, written: [] });
    expect(arweave.txs.size).toBe(before);
    const unlisted = await app<{ n: string }[]>`
      SELECT (SELECT count(*) FROM archive_evidence WHERE listed_in IS NULL)
        + (SELECT count(*) FROM archive_runs WHERE listed_in IS NULL) AS n`;
    expect(unlisted[0]!.n).toBe("0");
    l2.emit(BOARD);
    l2.advance(20n);
    await board(3);
    await drain(arweave, { latestLocator: held!.locator, ...eventOptions(l2) });
    const { walk, replays } = await replay(arweave, [held!.locator]);
    expect(walk.evidence).toHaveLength(3);
    expectReplays(replays, l2);
  });

  test("what grows stays grown: no record or run changed, relisted or deleted, and no contract's place moved back", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(BOARD);
    l2.advance(20n);
    await board(0);
    await drain(arweave, eventOptions(l2));
    const owner = await db.as("abolish_migrator");
    const refused = async (q: PromiseLike<unknown>) => {
      await expect(q).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|0A000)$/) });
    };
    for (const c of [app, owner]) {
      await refused(c`DELETE FROM archive_runs`);
      await refused(c`DELETE FROM archive_evidence`);
      await refused(c`DELETE FROM archive_event_progress`);
      await refused(c`TRUNCATE archive_runs`);
      await refused(c`TRUNCATE archive_evidence`);
      await refused(c`TRUNCATE archive_event_progress`);
      await refused(c`UPDATE archive_evidence SET listed_in = NULL`);
      await refused(c`UPDATE archive_runs SET listed_in = NULL`);
      await refused(c`UPDATE archive_event_progress SET segment = segment - 1`);
      await refused(c`UPDATE archive_event_progress SET segment = segment + 1, count = count - 1`);
      await refused(
        c`UPDATE archive_event_progress SET segment = segment + 1, accumulator = ${new Uint8Array(32)}`,
      );
      // A raw run whose CID isn't its bytes' is refused whoever writes it.
      const [e] = await c<{ cid: Uint8Array }[]>`SELECT cid FROM archive_evidence LIMIT 1`;
      await expect(
        c`INSERT INTO archive_runs (cid, contract, first, count, evidence, run)
          VALUES (${Uint8Array.from([1, 0x55, 0x12, 0x20, ...new Uint8Array(32)])}, ${BOARD}, 9, 1,
            ${e!.cid}, '\\x00')`,
      ).rejects.toMatchObject({ code: "23514" });
      // A record whose CID isn't its bytes' is refused whoever writes it.
      await expect(
        c`INSERT INTO archive_evidence (cid, contract, segment, l2_block, count, record)
          VALUES (${new Uint8Array(36)}, ${BOARD}, 9, 9, 9, '\\x00')`,
      ).rejects.toMatchObject({ code: "23514" });
    }
    await refused(app`UPDATE archive_evidence SET count = count + 1`);
    await refused(app`UPDATE archive_runs SET run = '\\x00'`);
    await refused(owner`UPDATE archive_runs SET run = '\\x00'`);
  });

  test("refuses a forger's record and events that agree with each other but not with the last record", async () => {
    // Each forgery is consistent in itself, a record over the events it is
    // given, so only the writer's continuation from the last record (or its
    // bounds) refuses it (checkEventAccumulatorContinuation).
    const cases: [string, (l2: ModelL2) => void, string][] = [
      [
        "an event moved to before the last record's block",
        (l2) => {
          l2.forgeLogs = (logs) => logs.map((e, i) => (i === 1 ? { ...e, l2_block: 5n } : e));
        },
        "events",
      ],
      [
        "an event dated before the one it follows",
        (l2) => {
          l2.forgeLogs = (logs) =>
            logs.map((e, i) => (i === 1 ? { ...e, l2_timestamp: e.l2_timestamp - 100n } : e));
        },
        "events",
      ],
      [
        "an event's data over MAX_EVENT_DATA",
        (l2) => {
          l2.forgeLogs = (logs) =>
            logs.map((e, i) => (i === 1 ? { ...e, data: new Uint8Array((1 << 20) + 1) } : e));
        },
        "events",
      ],
      [
        "a count beyond what a manifest's runs hold",
        (l2) => {
          l2.forgeState = { count: 1n << 40n };
        },
        "runs",
      ],
    ];
    for (const [what, forge, code] of cases) {
      await db.admin.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        for (const t of [
          "archive_transactions",
          "archive_runs",
          "archive_evidence",
          "archive_event_progress",
          "archive_objects",
          "archive_manifests",
          "board_checkpoints",
        ])
          await tx`DELETE FROM ${tx(t)}`;
      });
      const arweave = new ModelArweave();
      const l2 = new ModelL2();
      l2.emit(BOARD);
      l2.advance(10n);
      l2.emit(BOARD);
      l2.advance(20n);
      await board(0);
      expect(await run(arweave, eventOptions(l2)), what).toMatchObject({ evidence: 1 });
      await board(1);
      forge(l2);
      const reads = l2.eventReads;
      const r = await run(arweave, eventOptions(l2));
      expect(r.evidence, what).toBe(0);
      expect(
        r.eventFailures.map((f) => [hex(f.contract), f.error.code]),
        what,
      ).toEqual([[hex(BOARD), code]]);
      // A span past the bound is refused before the events are fetched.
      if (code === "runs") expect(l2.eventReads, what).toBe(reads);
    }
  });

  test("refuses a record proving another accumulator at the last record's count", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(BOARD);
    l2.advance(30n);
    await board(0, 1);
    expect(await run(arweave, eventOptions(l2, { maxPeriods: 1 }))).toMatchObject({ evidence: 1 });
    l2.forgeState = { accumulator: new Uint8Array(32).fill(3), count: 1n };
    const r = await run(arweave, eventOptions(l2));
    expect(r.eventFailures.map((f) => [hex(f.contract), f.error.code])).toEqual([
      [hex(BOARD), "evidence"],
    ]);
    expect(r.eventFailures[0]!.error.message).toMatch(/another accumulator/);
  });

  test("a contract deployed after the first anchored period starts from genesis at its first record", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.deployedAt.set(hex(REGISTRY), 25n);
    l2.emit(BOARD);
    l2.advance(25n);
    l2.emit(REGISTRY);
    l2.advance(10n);
    await board(0, 1, 2);
    const first = await run(arweave, eventOptions(l2));
    expect(first.eventFailures).toEqual([]);
    await drain(arweave, eventOptions(l2));
    const { walk, replays } = await replay(arweave);
    expect(
      walk.evidence.filter((e) => equalBytes(e.contract, REGISTRY)).map((e) => e.l2Block),
    ).toEqual([30n]);
    expectReplays(replays, l2);
    expect(replays.find((x) => x.role === "election-registry")?.held).toBe(1n);
  });

  test("lists a contract's records in count order, a later one waiting on an earlier one's upload", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(BOARD);
    l2.emit(REGISTRY);
    l2.advance(10n);
    l2.emit(BOARD);
    l2.advance(20n);
    await board(0, 1);
    expect(await run(arweave, eventOptions(l2))).toMatchObject({ evidence: 3, runs: 3 });
    // Every upload goes through but the first record's.
    const [row] = await app<{ cid: Uint8Array }[]>`
      SELECT cid FROM archive_evidence WHERE contract = ${BOARD} ORDER BY count LIMIT 1`;
    const first = [...arweave.txs.entries()].find(
      ([, t]) => readArchivedObject(t.data, new Uint8Array(row!.cid), 1 << 20).ok,
    )![0];
    arweave.drop((id) => id === first);
    arweave.mine();
    arweave.advance(DEPTH);
    await run(arweave, eventOptions(l2));
    const listed = await app<{ count: string; listed: boolean }[]>`
      SELECT count::text, listed_in IS NOT NULL AS listed FROM archive_evidence
      WHERE contract = ${BOARD} ORDER BY count`;
    expect(listed).toEqual([
      { count: "1", listed: false },
      { count: "2", listed: false },
    ]);
    // Another contract's record isn't held up.
    const [registry] = await app<{ listed: boolean }[]>`
      SELECT listed_in IS NOT NULL AS listed FROM archive_evidence WHERE contract = ${REGISTRY}`;
    expect(registry!.listed).toBe(true);
    now += REPOST;
    await drain(arweave, eventOptions(l2));
    const { walk, replays } = await replay(arweave);
    expect(walk.evidence).toHaveLength(3);
    expectReplays(replays, l2);
  });

  test("never posts a run whose bytes aren't its CID's, and reports it", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(BOARD);
    l2.advance(20n);
    await board(0);
    await drain(arweave, eventOptions(l2));
    const [e] = await app<{ cid: Uint8Array }[]>`SELECT cid FROM archive_evidence LIMIT 1`;
    // A dag-pb CID, which the table can't bind to its bytes (0049).
    const cid = Uint8Array.from([1, 0x70, 0x12, 0x20, ...new Uint8Array(32).fill(5)]);
    await app`INSERT INTO archive_runs (cid, contract, first, count, evidence, run)
      VALUES (${cid}, ${BOARD}, 99, 1, ${e!.cid}, '\\x00')`;
    const before = arweave.txs.size;
    expect(await run(arweave, eventOptions(l2))).toMatchObject({ refused: 1, posted: 0 });
    expect(arweave.txs.size).toBe(before);
  });

  test("refuses events that check but don't encode as runs, holding up only their contract", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    l2.emit(BOARD);
    l2.advance(20n);
    await board(0);
    // Topics an iterable but no array: the accumulator takes them, the run's codec doesn't.
    const honest = l2.events.bind(l2);
    l2.events = async (c, from, to) =>
      (await honest(c, from, to)).map((e) => ({
        ...e,
        topics: new Set(e.topics) as unknown as Uint8Array[],
      }));
    const r = await run(arweave, eventOptions(l2));
    expect(r).toMatchObject({ evidence: 0, posted: 2 });
    expect(r.eventFailures.map((f) => [hex(f.contract), f.error.code])).toEqual([
      [hex(BOARD), "events"],
    ]);
  });

  test("refuses malformed contract-event options", async () => {
    const arweave = new ModelArweave();
    const l2 = new ModelL2();
    const bad = (o: object) =>
      run(arweave, { contractEvents: { ...eventOptions(l2).contractEvents, ...o } });
    await expect(bad({ l2ChainId: -1n })).rejects.toThrow(RangeError);
    await expect(bad({ contracts: [new Uint8Array(19)] })).rejects.toThrow(TypeError);
    await expect(bad({ contracts: [BOARD, BOARD] })).rejects.toThrow(RangeError);
    await expect(bad({ clock: { epoch: 0n, period: 0n } })).rejects.toThrow(RangeError);
    await expect(bad({ maxPeriods: 0 })).rejects.toThrow(RangeError);
  });
});
