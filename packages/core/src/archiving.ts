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
  MAX_BOARD_PAYLOAD,
  MAX_MANIFEST_OBJECTS,
  objectCar,
  objectCid,
  readArchivedObject,
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
import { withSessionLock } from "./session-lock.ts";

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
  /**
   * The data a node serves for `transaction`, at most `limit` bytes, or
   * `undefined` if none serves it within the limit. A transaction's header
   * can be mined without its data ever being uploaded, so depth alone never
   * shows it is archived.
   */
  data(transaction: Uint8Array, limit: number): Promise<Uint8Array | undefined>;
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
  /**
   * The locator the board anchor holds now (`latestLocator()`), or `undefined`
   * if it holds none. A run with no chain of its own refuses to start one
   * while the anchor names a chain: after a wipe of Postgres a new chain from
   * sequence 0 would read as an overwritten locator (`locator-mismatch`,
   * T-69); resuming from the anchor's chain is part 4b-2's.
   */
  readonly latestLocator: Uint8Array | undefined;
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
  /** Objects not posted because the board no longer gives the bytes their CID names. */
  readonly refused: number;
  /** The sequence the locator names, or `undefined` while no manifest meets the locator rule. */
  readonly locator: bigint | undefined;
}

/** The latest locator (docs/spec/archive.md, Locator): version 3, naming a confirmed manifest. */
export interface ArchiveLocator {
  readonly sequence: bigint;
  readonly locator: Uint8Array;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const compareBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b);
const equal = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0;

function checkOptions(o: ArchiveOptions) {
  if (typeof o.l1ChainId !== "bigint" || o.l1ChainId < 0n || o.l1ChainId >= 1n << 64n)
    throw new RangeError("l1ChainId must be a u64");
  if (!isBytes(o.anchor) || o.anchor.length !== 20) throw new TypeError("anchor must be 20 bytes");
  if (o.latestLocator !== undefined && !isBytes(o.latestLocator))
    throw new TypeError("latestLocator must be bytes or undefined");
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

interface ObjectRow {
  readonly cid: Uint8Array;
  readonly electionId: Uint8Array;
  readonly kind: string;
  readonly first: bigint;
  readonly size: bigint;
}

/**
 * An object's bytes, read again from the board: the run's encoded entries,
 * or their entry hashes, concatenated. `undefined` unless they are the bytes
 * its CID names, so nothing but what its checkpoint names is ever posted
 * (T-23).
 */
async function objectBytes(client: Sql, o: ObjectRow): Promise<Uint8Array | undefined> {
  const entries = await readBoardRange(client, o.electionId, o.first, o.size);
  const parts = o.kind === "segment" ? entries : entries.map(boardEntryHash);
  const bytes = new Uint8Array(Buffer.concat(parts));
  return equal(objectCid(bytes), o.cid) ? bytes : undefined;
}

/** The most an object's bytes can be: an entry is 51 bytes and its payload, a hash 32 (docs/spec/archive.md, The listed objects). */
function objectBound(o: ObjectRow): number {
  const n = o.size - o.first;
  const bound = o.kind === "segment" ? n * BigInt(51 + MAX_BOARD_PAYLOAD) : n * 32n;
  return bound > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(bound);
}

/** A manifest is one raw block of at most 1 MiB (docs/spec/archive.md, Archive manifest). */
const MANIFEST_BOUND = 1 << 20;

/** The CAR of an object of `bound` bytes is at most this long (docs/spec/archive.md, The listed objects, step 2). */
const carLimit = (bound: number) =>
  Math.min(Number.MAX_SAFE_INTEGER, bound + 59 + 256 * Math.max(1, Math.ceil(bound / 2 ** 20)));

interface Chain {
  readonly manifests: ChainManifest[];
  readonly cids: Uint8Array[];
}

/** The manifest chain as written, each manifest's links read from its own bytes. */
async function readChain(
  client: Sql,
  confirmed: ReadonlyMap<string, Uint8Array>,
  o: Pick<ArchiveOptions, "l1ChainId" | "anchor">,
): Promise<Chain> {
  const rows = await drizzle({ client })
    .select()
    .from(archiveManifests)
    .orderBy(asc(archiveManifests.sequence));
  const manifests: ChainManifest[] = [];
  const cids: Uint8Array[] = [];
  for (const [k, r] of rows.entries()) {
    if (r.sequence !== BigInt(k)) throw new Error(`the manifest chain has no manifest ${k}`);
    const m = decodeArchiveManifest(new Uint8Array(r.manifest), 3);
    // A reader takes another deployment's manifest as foreign, so linking
    // one would cut the chain (`manifest-foreign`, then `archive-gap`).
    if (m.sequence !== r.sequence || m.l1_chain_id !== o.l1ChainId || !equal(m.anchor, o.anchor))
      throw new Error(`manifest ${k} isn't this deployment's at its sequence`);
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
 * Asks the client how deep each unconfirmed transaction is whose CID has no
 * confirmed one, and marks confirmed those at `depth` whose data a node
 * serves and reads as their CID (docs/spec/archive.md, Archived objects): a
 * header can be mined without its data, and a confirmed transaction may be
 * listed, linked and named for good (T-51). Returns how many it marked, and
 * the transactions in some block whose data may yet arrive, which are left
 * to deepen rather than posted again; one at depth whose data doesn't read
 * is posted again once `repostAfter` has passed.
 */
async function confirm(
  client: Sql,
  arweave: ArweaveClient,
  depth: number,
  bounds: ReadonlyMap<string, number>,
): Promise<{ confirmed: number; mined: Set<string> }> {
  const db = drizzle({ client });
  const done = await confirmedTransactions(client);
  const pending = await db
    .select({ transaction: archiveTransactions.transaction, cid: archiveTransactions.cid })
    .from(archiveTransactions)
    .where(eq(archiveTransactions.confirmed, false));
  let confirmed = 0;
  const mined = new Set<string>();
  for (const { transaction, cid } of pending) {
    if (done.has(hex(cid))) continue;
    const n = await arweave.confirmations(new Uint8Array(transaction));
    if (n === undefined) continue;
    if (!Number.isSafeInteger(n) || n < 1)
      throw new Error("the Arweave client gave a depth below 1");
    if (n < depth) {
      mined.add(hex(transaction));
      continue;
    }
    const bound = bounds.get(hex(cid));
    if (bound === undefined)
      throw new Error(`a transaction for ${cidText(cid)}, which nothing archives`);
    const data = await arweave.data(new Uint8Array(transaction), carLimit(bound));
    if (data === undefined || !readArchivedObject(data, cid, bound).ok) continue;
    await db
      .update(archiveTransactions)
      .set({ confirmed: true })
      .where(eq(archiveTransactions.transaction, transaction));
    done.set(hex(cid), new Uint8Array(transaction));
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
): Promise<{ posted: number; refused: number }> {
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
  // Manifests first, so an object that can't be posted never holds up the
  // chain the locator names.
  const manifests = await db
    .select()
    .from(archiveManifests)
    .orderBy(asc(archiveManifests.sequence));
  for (const m of manifests)
    if (!live.has(hex(m.cid))) await send(m.cid, new Uint8Array(m.manifest));
  let refused = 0;
  const objects = await db.select().from(archiveObjects).orderBy(asc(archiveObjects.cid));
  for (const o of objects) {
    if (live.has(hex(o.cid))) continue;
    const bytes = await objectBytes(client, o);
    // Reported, never posted: the stored checkpoint and the board disagree,
    // which the anchoring job's checks are the place to judge (T-23).
    if (bytes === undefined) refused++;
    else await send(o.cid, bytes);
  }
  return { posted, refused };
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
  const run = await withSessionLock(client, "archive_writer", async () => {
    const db = drizzle({ client });
    const [first] = await db
      .select({ sequence: archiveManifests.sequence })
      .from(archiveManifests)
      .limit(1);
    if (first === undefined && options.latestLocator !== undefined)
      throw new Error("the anchor names an archive chain this database doesn't hold");
    const registered = await register(client);
    const bounds = new Map<string, number>();
    for (const o of await db.select().from(archiveObjects)) bounds.set(hex(o.cid), objectBound(o));
    for (const m of await db.select({ cid: archiveManifests.cid }).from(archiveManifests))
      bounds.set(hex(m.cid), MANIFEST_BOUND);
    const { confirmed, mined } = await confirm(client, arweave, depth, bounds);
    const held = await confirmedTransactions(client);
    const chain = await readChain(client, held, options);
    const written = await writeManifests(client, chain, held, options, maxLinks);
    const { posted, refused } = await post(client, arweave, held, mined, options.now, repostAfter);
    return {
      busy: false,
      registered,
      confirmed,
      written,
      posted,
      refused,
      locator: locatorOf(chain, held)?.sequence,
    };
  });
  return (
    run ?? {
      busy: true,
      registered: 0,
      confirmed: 0,
      written: [],
      posted: 0,
      refused: 0,
      locator: undefined,
    }
  );
}

/**
 * The sequence of this database's manifest `cid`, or `undefined` if it holds
 * none by that CID: whether a locator the anchor holds names our own chain.
 */
export async function archiveManifestSequence(
  client: Sql,
  cid: Uint8Array,
): Promise<bigint | undefined> {
  if (!isBytes(cid)) throw new TypeError("cid must be bytes");
  const [row] = await drizzle({ client })
    .select({ sequence: archiveManifests.sequence })
    .from(archiveManifests)
    .where(eq(archiveManifests.cid, Uint8Array.from(cid)))
    .limit(1);
  return row?.sequence;
}

/**
 * The locator the anchoring calls carry: version 3, naming the highest
 * confirmed manifest that reaches every manifest before it and the
 * transaction that confirmed it first, or `undefined` while none does.
 */
export async function archiveLocator(
  client: Sql,
  deployment: Pick<ArchiveOptions, "l1ChainId" | "anchor">,
): Promise<ArchiveLocator | undefined> {
  const held = await confirmedTransactions(client);
  return locatorOf(await readChain(client, held, deployment), held);
}
