// The worker's archive run (docs/spec/archive.md, Archived objects, Who
// writes them, Locator; [[0005-permanent-archive]]; P4-3 part 4b-1). Each
// segment object and entry-hash list a taken checkpoint names is posted to
// Arweave as one transaction whose data is its CAR, and counts as archived
// only once that transaction is `depth` blocks deep, a depth Arweave doesn't
// reorganise, so "once confirmed, always confirmed" holds for the chain rules
// in archive-chain.ts. Confirmed objects are listed in the next version-3
// manifest, which links the confirmed manifests no confirmed manifest
// reaches; a manifest is itself posted and confirmed the same way, and the
// locator names the highest confirmed manifest that reaches every one before
// it. An upload that isn't mined within `repostAfter` is posted again with the
// same bytes, so a dropped transaction never strands an object or a manifest
// (T-51, T-49).
//
// Arweave is behind `ArweaveClient`, which the deployment supplies with its
// wallet; nothing here holds a key. Everything posted is bytes the board
// already holds, each checked against the CID its checkpoint names before it
// is posted, so the archive carries no display text and nothing the board's
// validity checks didn't pass (T-17, T-52). The manifest's evidence and runs
// are a later part's: until then the manifests list objects and links only.

import {
  boardEntryHash,
  cidText,
  decodeArchiveManifest,
  decodeCheckpoint,
  encodeArchiveLocator,
  encodeArchiveManifest,
  MAX_MANIFEST_LINKS,
  MAX_MANIFEST_OBJECTS,
  objectCar,
  objectCid,
} from "@abolishus/crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  type ChainManifest,
  locatorManifest,
  needsLinkingManifest,
  nextManifestLinks,
} from "./archive-chain.ts";
import { readBoardRange } from "./board.ts";
import { isBytes } from "./bytes.ts";
import { archiveManifests, archiveObjects, archiveTransactions } from "./db/schema/index.ts";

/**
 * The deployment's Arweave access: a node or gateway to post through, with
 * the wallet that pays, and the chain it reads confirmations from.
 */
export interface ArweaveClient {
  /**
   * Posts `data` as the data of one base-layer transaction from the
   * deployment's wallet. Resolves to its 32-byte ID once a node accepted it
   * for mining; throws if none did.
   */
  post(data: Uint8Array): Promise<Uint8Array>;
  /**
   * How deep `transaction` is: 1 in the tip block, more below it, or
   * `undefined` while it is in no block (not yet mined, dropped, or
   * reorganised away).
   */
  confirmations(transaction: Uint8Array): Promise<number | undefined>;
}

/**
 * The depth at which the worker counts a transaction confirmed by default:
 * about fifty minutes of Arweave blocks, well past the forks Arweave sees,
 * since a confirmed manifest may be linked and named by a locator for good.
 */
export const ARCHIVE_DEPTH = 25;

/**
 * How long, in seconds, an upload in no block waits before it is posted again
 * by default: a transaction's anchor lapses after 50 blocks, about 100
 * minutes, after which it can never be mined.
 */
export const ARCHIVE_REPOST_AFTER = 7200n;

export interface ArchiveOptions {
  /** The L1 the deployment's board anchor is on, which every manifest names. */
  readonly l1ChainId: bigint;
  /** The board anchor's 20-byte address, which every manifest names. */
  readonly anchor: Uint8Array;
  /** The worker's clock, in seconds since the epoch. */
  readonly now: bigint;
  /** Confirmations at which a transaction counts as confirmed; `ARCHIVE_DEPTH` by default. */
  readonly depth?: number;
  /** Seconds before an upload in no block is posted again; `ARCHIVE_REPOST_AFTER` by default. */
  readonly repostAfter?: bigint;
  /** The most links a manifest carries, from 2 to `MAX_MANIFEST_LINKS` (the default). */
  readonly maxLinks?: number;
}

/** What one run did. */
export interface ArchiveRun {
  /** Another run held the archive's lock, so this one did nothing. */
  readonly busy: boolean;
  /** Objects first seen in a taken checkpoint. */
  readonly registered: number;
  /** Transactions that reached the depth. */
  readonly confirmed: number;
  /** The sequences of the manifests written. */
  readonly written: readonly bigint[];
  /** Transactions posted, first uploads and reposts alike. */
  readonly posted: number;
  /** The sequence the locator names, or `undefined` while no manifest meets the locator rule. */
  readonly locator: bigint | undefined;
}

/** The latest locator (docs/spec/archive.md, Locator): version 3, naming a confirmed manifest. */
export interface ArchiveLocator {
  readonly sequence: bigint;
  readonly locator: Uint8Array;
}

const LOCK = "archive_writer";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const compareBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b);
const equal = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;

function checkOptions(o: ArchiveOptions) {
  if (typeof o.l1ChainId !== "bigint" || o.l1ChainId < 0n || o.l1ChainId >= 1n << 64n)
    throw new RangeError("l1ChainId must be a u64");
  if (!isBytes(o.anchor) || o.anchor.length !== 20) throw new TypeError("anchor must be 20 bytes");
  if (typeof o.now !== "bigint" || o.now < 0n)
    throw new RangeError("now must be a non-negative bigint");
  const depth = o.depth ?? ARCHIVE_DEPTH;
  if (!Number.isSafeInteger(depth) || depth < 1) throw new RangeError("depth must be at least 1");
  const repostAfter = o.repostAfter ?? ARCHIVE_REPOST_AFTER;
  if (typeof repostAfter !== "bigint" || repostAfter < 1n)
    throw new RangeError("repostAfter must be at least 1 second");
  return { depth, repostAfter, maxLinks: o.maxLinks ?? MAX_MANIFEST_LINKS };
}

/**
 * Runs `work` while one reserved connection holds the archive's session
 * lock, or returns `undefined` if another run holds it: two runs at once
 * would post the same objects twice and race for the next manifest's
 * sequence. The work goes through the pool's other connections, so the
 * pool needs at least two.
 */
async function exclusively<T>(client: Sql, work: () => Promise<T>): Promise<T | undefined> {
  if (!(client.options.max >= 2))
    throw new RangeError("the archive run needs a pool of at least two connections");
  const conn = await client.reserve();
  try {
    const [row] = await conn`SELECT pg_try_advisory_lock(hashtextextended(${LOCK}, 0)) AS held`;
    if (row?.["held"] !== true) return undefined;
    try {
      return await work();
    } finally {
      await conn`SELECT pg_advisory_unlock(hashtextextended(${LOCK}, 0))`;
    }
  } finally {
    conn.release();
  }
}

/**
 * Records the objects of every taken checkpoint not yet recorded: its
 * segment object and entry-hash list, each the bytes of the board's run
 * from the election's previous checkpoint's size to its own (docs/spec/
 * board.md, Segments and checkpoints). Returns how many were new.
 */
async function register(client: Sql): Promise<number> {
  const rows = await client<
    { election_id: Uint8Array; size: string; first: string; checkpoint: Uint8Array }[]
  >`
    SELECT c.election_id, c.size::text, c.first::text, c.checkpoint FROM (
      SELECT election_id, size, checkpoint,
        lag(size, 1, 0::bigint) OVER (PARTITION BY election_id ORDER BY segment) AS first
      FROM board_checkpoints) c
    WHERE NOT EXISTS (
      SELECT 1 FROM archive_objects o
      WHERE o.election_id = c.election_id AND o.size = c.size AND o.kind = 'segment')
    ORDER BY c.election_id, c.size`;
  const values = rows.flatMap((r) => {
    const first = BigInt(r.first);
    const size = BigInt(r.size);
    // Checkpoints are taken only for periods that added entries, so each one
    // is longer than the last; one that isn't names the last one's objects.
    if (size <= first) return [];
    const c = decodeCheckpoint(new Uint8Array(r.checkpoint));
    const electionId = new Uint8Array(r.election_id);
    return [
      { cid: c.object_cid, electionId, kind: "segment", first, size },
      { cid: c.hashes_cid, electionId, kind: "hashes", first, size },
    ];
  });
  if (values.length === 0) return 0;
  const inserted = await drizzle({ client })
    .insert(archiveObjects)
    .values(values)
    .onConflictDoNothing()
    .returning({ cid: archiveObjects.cid });
  return inserted.length;
}

/**
 * An object's bytes, read again from the board: the run's encoded entries,
 * or their entry hashes, concatenated. Throws unless they are the bytes its
 * CID names, so nothing but what its checkpoint names is ever posted (T-23).
 */
async function objectBytes(
  client: Sql,
  o: { cid: Uint8Array; electionId: Uint8Array; kind: string; first: bigint; size: bigint },
): Promise<Uint8Array> {
  const entries = await readBoardRange(client, o.electionId, o.first, o.size);
  const parts = o.kind === "segment" ? entries : entries.map(boardEntryHash);
  const bytes = Buffer.concat(parts);
  if (!equal(objectCid(bytes), o.cid))
    throw new Error(`the board no longer gives archived object ${cidText(o.cid)}`);
  return new Uint8Array(bytes);
}

interface Chain {
  readonly manifests: ChainManifest[];
  readonly cids: Uint8Array[];
}

/** The manifest chain as written, each manifest's links read from its own bytes. */
async function readChain(client: Sql, confirmed: ReadonlyMap<string, Uint8Array>): Promise<Chain> {
  const rows = await drizzle({ client })
    .select()
    .from(archiveManifests)
    .orderBy(asc(archiveManifests.sequence));
  const manifests: ChainManifest[] = [];
  const cids: Uint8Array[] = [];
  for (const [k, r] of rows.entries()) {
    if (r.sequence !== BigInt(k)) throw new Error(`the manifest chain has no manifest ${k}`);
    const m = decodeArchiveManifest(new Uint8Array(r.manifest), 3);
    manifests.push({
      links: m.links.map((l) => Number(l.sequence)),
      confirmed: confirmed.has(hex(r.cid)),
    });
    cids.push(new Uint8Array(r.cid));
  }
  return { manifests, cids };
}

/** Each confirmed CID's transaction: the first posted of those that confirmed. */
async function confirmedTransactions(client: Sql): Promise<Map<string, Uint8Array>> {
  const rows = await drizzle({ client })
    .select({ cid: archiveTransactions.cid, transaction: archiveTransactions.transaction })
    .from(archiveTransactions)
    .where(eq(archiveTransactions.confirmed, true))
    .orderBy(asc(archiveTransactions.postedAt), asc(archiveTransactions.transaction));
  const out = new Map<string, Uint8Array>();
  for (const r of rows)
    if (!out.has(hex(r.cid))) out.set(hex(r.cid), new Uint8Array(r.transaction));
  return out;
}

/**
 * Asks the client how deep each unconfirmed transaction is, and marks those
 * at `depth` confirmed. Returns how many it marked, and the transactions in
 * some block, which are left to deepen rather than posted again.
 */
async function confirm(
  client: Sql,
  arweave: ArweaveClient,
  depth: number,
): Promise<{ confirmed: number; mined: Set<string> }> {
  const db = drizzle({ client });
  const pending = await db
    .select({ transaction: archiveTransactions.transaction })
    .from(archiveTransactions)
    .where(eq(archiveTransactions.confirmed, false));
  let confirmed = 0;
  const mined = new Set<string>();
  for (const { transaction } of pending) {
    const n = await arweave.confirmations(new Uint8Array(transaction));
    if (n === undefined) continue;
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error("the Arweave client gave a depth below 1");
    mined.add(hex(transaction));
    if (n < depth) continue;
    await db
      .update(archiveTransactions)
      .set({ confirmed: true })
      .where(eq(archiveTransactions.transaction, transaction));
    confirmed++;
  }
  return { confirmed, mined };
}

/**
 * Writes manifests while confirmed objects wait to be listed, or every
 * manifest has confirmed but no locator names the latest, each linking the
 * roots `nextManifestLinks` gives (docs/spec/archive.md, Who writes them).
 * Objects are listed by the transaction that confirmed first, at most
 * `MAX_MANIFEST_OBJECTS` a manifest, in CID order as the layout requires.
 */
async function writeManifests(
  client: Sql,
  chain: Chain,
  confirmed: ReadonlyMap<string, Uint8Array>,
  o: ArchiveOptions,
  maxLinks: number,
): Promise<bigint[]> {
  const db = drizzle({ client });
  const unlisted = await db
    .select({ cid: archiveObjects.cid })
    .from(archiveObjects)
    .where(isNull(archiveObjects.listedIn));
  const waiting = unlisted
    .map((r) => new Uint8Array(r.cid))
    .filter((cid) => confirmed.has(hex(cid)))
    .sort(compareBytes);
  const written: bigint[] = [];
  const txOf = (cid: Uint8Array) => {
    const t = confirmed.get(hex(cid));
    // Only confirmed manifests are linked and only confirmed objects listed.
    if (t === undefined) throw new Error(`no confirmed transaction for ${cidText(cid)}`);
    return t;
  };
  let at = 0;
  while (at < waiting.length || needsLinkingManifest(chain.manifests)) {
    const objects = waiting.slice(at, at + MAX_MANIFEST_OBJECTS);
    at += objects.length;
    const links = nextManifestLinks(chain.manifests, maxLinks);
    const sequence = BigInt(chain.manifests.length);
    const manifest = encodeArchiveManifest(
      {
        l1_chain_id: o.l1ChainId,
        anchor: o.anchor,
        sequence,
        objects: objects.map((cid) => ({ cid, transaction: txOf(cid) })),
        links: links.map((s) => {
          const cid = chain.cids[s] as Uint8Array;
          return { sequence: BigInt(s), cid, transaction: txOf(cid) };
        }),
        evidence: [],
        runs: [],
      },
      3,
    );
    const cid = objectCid(manifest);
    await db.transaction(async (tx) => {
      await tx.insert(archiveManifests).values({ sequence, cid, manifest });
      if (objects.length === 0) return;
      const listed = await tx
        .update(archiveObjects)
        .set({ listedIn: sequence })
        .where(and(inArray(archiveObjects.cid, objects), isNull(archiveObjects.listedIn)))
        .returning({ cid: archiveObjects.cid });
      // The lock keeps every other run out, so nothing else lists them.
      if (listed.length !== objects.length)
        throw new Error("objects were listed under another manifest");
    });
    chain.manifests.push({ links, confirmed: false });
    chain.cids.push(cid);
    written.push(sequence);
  }
  return written;
}

/**
 * Posts every object and manifest with no confirmed transaction and none
 * still live: in a block, or posted less than `repostAfter` ago. A repost
 * carries the same bytes, so the CID a manifest lists or links never changes
 * (docs/spec/archive.md, Who writes them). Returns how many it posted.
 */
async function post(
  client: Sql,
  arweave: ArweaveClient,
  confirmed: ReadonlyMap<string, Uint8Array>,
  mined: ReadonlySet<string>,
  now: bigint,
  repostAfter: bigint,
): Promise<number> {
  const db = drizzle({ client });
  const unconfirmed = await db
    .select({
      cid: archiveTransactions.cid,
      transaction: archiveTransactions.transaction,
      postedAt: archiveTransactions.postedAt,
    })
    .from(archiveTransactions)
    .where(eq(archiveTransactions.confirmed, false));
  const live = new Set(confirmed.keys());
  for (const t of unconfirmed)
    if (mined.has(hex(t.transaction)) || now - t.postedAt < repostAfter) live.add(hex(t.cid));

  let posted = 0;
  const send = async (cid: Uint8Array, bytes: Uint8Array) => {
    const transaction = await arweave.post(objectCar(bytes));
    if (!isBytes(transaction) || transaction.length !== 32)
      throw new Error("the Arweave client gave a transaction ID that isn't 32 bytes");
    await db.insert(archiveTransactions).values({ transaction, cid, postedAt: now });
    posted++;
  };
  const objects = await db.select().from(archiveObjects).orderBy(asc(archiveObjects.cid));
  for (const o of objects) {
    if (live.has(hex(o.cid))) continue;
    await send(o.cid, await objectBytes(client, o));
  }
  const manifests = await db
    .select()
    .from(archiveManifests)
    .orderBy(asc(archiveManifests.sequence));
  for (const m of manifests)
    if (!live.has(hex(m.cid))) await send(m.cid, new Uint8Array(m.manifest));
  return posted;
}

function locatorOf(
  chain: Chain,
  confirmed: ReadonlyMap<string, Uint8Array>,
): ArchiveLocator | undefined {
  const m = locatorManifest(chain.manifests);
  if (m === undefined) return undefined;
  const cid = chain.cids[m] as Uint8Array;
  return {
    sequence: BigInt(m),
    locator: encodeArchiveLocator(cid, confirmed.get(hex(cid)) as Uint8Array, 3),
  };
}

/**
 * One archive run: records the objects of new checkpoints, confirms the
 * transactions that reached `depth`, writes the manifests that are due,
 * posts what has no live upload, and reports the sequence the locator names.
 * Throws if Arweave or the database fails; what was done before stays done,
 * and the next run takes up from there.
 */
export async function archiveBoards(
  client: Sql,
  arweave: ArweaveClient,
  options: ArchiveOptions,
): Promise<ArchiveRun> {
  const { depth, repostAfter, maxLinks } = checkOptions(options);
  const run = await exclusively(client, async () => {
    const registered = await register(client);
    const { confirmed, mined } = await confirm(client, arweave, depth);
    const held = await confirmedTransactions(client);
    const chain = await readChain(client, held);
    const written = await writeManifests(client, chain, held, options, maxLinks);
    const posted = await post(client, arweave, held, mined, options.now, repostAfter);
    return {
      busy: false,
      registered,
      confirmed,
      written,
      posted,
      locator: locatorOf(chain, held)?.sequence,
    };
  });
  return (
    run ?? { busy: true, registered: 0, confirmed: 0, written: [], posted: 0, locator: undefined }
  );
}

/**
 * The locator the anchoring calls carry: version 3, naming the highest
 * confirmed manifest that reaches every manifest before it and the
 * transaction that confirmed it first, or `undefined` while none does.
 */
export async function archiveLocator(client: Sql): Promise<ArchiveLocator | undefined> {
  const held = await confirmedTransactions(client);
  return locatorOf(await readChain(client, held), held);
}
