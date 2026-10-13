// The node's durable records. Every record is written once and never changed
// or removed by the node: the duties that need a record (a run seen, at most
// one round-4 message per run, at most one approval per stub) are each
// "write it once, before acting", so a store that can't overwrite can't be
// talked into breaking one by a crash, a retry or a race (docs/spec/ceremony.md,
// Soundness and Approval and re-runs; T-14, T-37).
import { constants } from "node:fs";
import { link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface PutOnce {
  /** Whether this call wrote the record; `false` when one was already there. */
  readonly created: boolean;
  /** The record the store now holds under the key: this call's, or the earlier one. */
  readonly value: Uint8Array;
}

/** Write-once durable records, keyed by `/`-separated lowercase names. */
export interface SeatStore {
  get(key: string): Promise<Uint8Array | undefined>;
  /**
   * Writes `value` under `key` unless a record is already there, and resolves
   * only once the record is durable. Of any number of calls for one key,
   * concurrent or not, exactly one writes.
   */
  putOnce(key: string, value: Uint8Array): Promise<PutOnce>;
}

const KEY = /^[a-z0-9-]{1,128}(\/[a-z0-9-]{1,128}){0,7}$/;

function checkedKey(key: string): string {
  if (typeof key !== "string" || !KEY.test(key)) throw new RangeError(`store: bad key ${key}`);
  return key;
}

/**
 * In memory, for tests only: a restart forgets every record, which breaks
 * every duty the records keep. The package entry point doesn't export it.
 */
export class MemoryStore implements SeatStore {
  readonly #records = new Map<string, Uint8Array>();

  async get(key: string): Promise<Uint8Array | undefined> {
    const value = this.#records.get(checkedKey(key));
    return value === undefined ? undefined : Uint8Array.from(value);
  }

  async putOnce(key: string, value: Uint8Array): Promise<PutOnce> {
    const held = this.#records.get(checkedKey(key));
    if (held !== undefined) return { created: false, value: Uint8Array.from(held) };
    this.#records.set(key, Uint8Array.from(value));
    return { created: true, value: Uint8Array.from(value) };
  }
}

const isCode = (e: unknown, code: string) =>
  e instanceof Error && (e as NodeJS.ErrnoException).code === code;

/** Makes a directory's entries durable; injectable so tests can see which are synced. */
export type SyncDirectory = (path: string) => Promise<void>;

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * One file per record under `root`. A record is written to a fresh temporary
 * file, synced, and then hard-linked to its name: `link` fails if the name
 * exists, so the write-once rule holds across processes sharing the
 * directory, and a crash leaves either no record or a whole one. Then every
 * directory from the record's up to the root is synced, so neither the
 * record nor a directory created for it is lost in a crash once `putOnce`
 * resolves. The root and every directory are 0700 and files 0600: the
 * records include the run's secret keys.
 *
 * The write-once rule holds only if the store is never rolled back
 * (restored from a backup or a snapshot) and a seat runs from exactly one
 * store: either would let the node act twice where it must act once.
 */
export class FileStore implements SeatStore {
  readonly #root: string;
  readonly #sync: SyncDirectory;

  private constructor(root: string, sync: SyncDirectory) {
    this.#root = root;
    this.#sync = sync;
  }

  /**
   * Opens the store at `root`, creating it 0700 if it doesn't exist. Refuses
   * a root anyone but its owner can reach, and removes the temporary files a
   * crash left behind, which may hold secrets of a record never written.
   */
  static async open(root: string, sync: SyncDirectory = fsyncDirectory): Promise<FileStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const { mode } = await stat(root);
    if ((mode & 0o077) !== 0)
      throw new Error(`store: ${root} must be reachable by its owner only (mode 0700)`);
    // Every directory is synced too, so a record a crash left linked but
    // unsynced is durable before the node reads and acts on it.
    const directories = [root];
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
      if (entry.isFile() && entry.name.startsWith(".tmp-"))
        await unlink(join(entry.parentPath, entry.name));
      else if (entry.isDirectory()) directories.push(join(entry.parentPath, entry.name));
    for (const directory of directories.reverse()) await sync(directory);
    return new FileStore(root, sync);
  }

  // A name is durable only once its directory is synced, and a directory
  // created for it only once its parent is: every level, up to the root.
  async #syncUp(parts: readonly string[]): Promise<void> {
    for (let at = parts.length - 1; at >= 0; at--)
      await this.#sync(join(this.#root, ...parts.slice(0, at)));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(join(this.#root, checkedKey(key))));
    } catch (e) {
      if (isCode(e, "ENOENT")) return undefined;
      throw e;
    }
  }

  async putOnce(key: string, value: Uint8Array): Promise<PutOnce> {
    const parts = checkedKey(key).split("/");
    const path = join(this.#root, ...parts);
    const dir = join(this.#root, ...parts.slice(0, -1));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const held = await this.get(key);
    if (held !== undefined) {
      // Another call linked it but may not have synced it yet (or crashed
      // before it could): nothing acts on a record before it is durable.
      await this.#syncUp(parts);
      return { created: false, value: held };
    }
    const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const temporary = join(dir, `.tmp-${random}`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      await file.writeFile(value);
      await file.sync();
    } finally {
      await file.close();
    }
    let created = true;
    try {
      await link(temporary, path);
    } catch (e) {
      if (!isCode(e, "EEXIST")) throw e;
      created = false;
    } finally {
      await unlink(temporary);
    }
    await this.#syncUp(parts);
    const now = await this.get(key);
    if (now === undefined) throw new Error(`store: ${key} vanished after it was written`);
    return { created, value: now };
  }
}
