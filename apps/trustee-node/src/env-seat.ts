// A seat set up from its host's environment and one persistent volume, for a
// host that gives a service secrets only as variables (staging's seats on
// Railway, docs/runbooks/trustee-node.md, Staging on Railway). The volume
// holds what `run` needs on disk: the identity key file and the store, at
// fixed names, so no variable can point the seat at another store (T-14,
// T-37). The key is written once, never replaced: a variable that names
// another key stops the seat rather than changing which seat it is.
import { timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { identityKey } from "@abolishus/crypto";
import { ConfigError, parseConfig, readIdentityKey } from "./config.ts";

/** The identity key file's name on the volume. */
export const IDENTITY_KEY_FILE = "identity.key";
/** The store's directory on the volume. */
export const STORE_DIR = "store";

const PENDING_KEY = `.${IDENTITY_KEY_FILE}.tmp`;

export interface SeatEnv {
  /** `TRUSTEE_CONFIG`: `run`'s JSON configuration, without `identityKeyFile` or `store`. */
  readonly config: string | undefined;
  /** `TRUSTEE_IDENTITY_KEY`: the key file's contents as `keygen` writes them. */
  readonly identityKey: string | undefined;
}

/**
 * The configuration `run` takes for the seat on the volume at `data`, after
 * putting the identity key there if it isn't yet. The store's directory is
 * made before the key is, so a key without a store means the store was lost:
 * refused, since starting it again from empty would let the seat act twice.
 * Refuses too a `data` that doesn't exist (a seat with no volume would start
 * each deployment from an empty store), a configuration that names its own
 * key file or store, a key that isn't the configured seat's (checked before
 * it is written, since it is never replaced), a key other than the one
 * already on the volume, and no key at all. Neither the key nor the
 * configuration is ever quoted.
 */
export async function seatFromEnv(env: SeatEnv, data: string): Promise<string> {
  try {
    if (!(await stat(data)).isDirectory()) throw new ConfigError("data: not a directory");
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`data: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  if (env.config === undefined || env.config === "")
    throw new ConfigError("TRUSTEE_CONFIG: not set");
  let raw: unknown;
  try {
    raw = JSON.parse(env.config);
  } catch {
    throw new ConfigError("TRUSTEE_CONFIG: not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ConfigError("TRUSTEE_CONFIG: not a JSON object");
  if ("identityKeyFile" in raw || "store" in raw)
    throw new ConfigError("TRUSTEE_CONFIG: identityKeyFile and store are the volume's");
  const keyFile = join(data, IDENTITY_KEY_FILE);
  const store = join(data, STORE_DIR);
  const text = JSON.stringify({ ...raw, identityKeyFile: keyFile, store });
  const config = parseConfig(text);

  // A crash between writing the key and linking it leaves the pending file.
  await unlink(join(data, PENDING_KEY)).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw new ConfigError(`identity key: ${e.code ?? "unwritable"}`);
  });
  const held = await present(keyFile);
  if (held && !(await present(store)))
    throw new ConfigError("store: missing beside the key on the volume; it is never started again");
  if (env.identityKey === undefined || env.identityKey === "") {
    if (!held) throw new ConfigError("TRUSTEE_IDENTITY_KEY: not set, and no key on the volume");
    return text;
  }
  if (!/^[0-9a-f]{64}\n?$/.test(env.identityKey))
    throw new ConfigError("TRUSTEE_IDENTITY_KEY: expected 64 hex digits");
  const hex = env.identityKey.slice(0, 64);
  const secret = Uint8Array.from(Buffer.from(hex, "hex"));
  let own: Uint8Array;
  try {
    own = identityKey(secret);
  } catch {
    throw new ConfigError("TRUSTEE_IDENTITY_KEY: not a P-256 secret key");
  }
  if (!Buffer.from(own).equals(Buffer.from(config.panel.keys[config.seat - 1] as Uint8Array)))
    throw new ConfigError("TRUSTEE_IDENTITY_KEY: not the key of the configured seat");
  if (!held) {
    try {
      await mkdir(store, { mode: 0o700 });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw new ConfigError(`store: ${code ?? "unwritable"}`);
    }
    // Durable before the key is, so a crash can't keep the key and lose it.
    await syncDirectory(data, "store");
  }
  if (held || !(await writeKeyOnce(data, keyFile, `${hex}\n`))) {
    if (!timingSafeEqual(await readIdentityKey(keyFile), secret))
      throw new ConfigError(
        "TRUSTEE_IDENTITY_KEY: not the key already on the volume, which is never replaced",
      );
  }
  return text;
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    throw new ConfigError(`data: ${code ?? "unreadable"}`);
  }
}

/**
 * Writes the key file owner-only through a synced pending file linked to its
 * name, so a crash leaves no key or a whole one; false if a key was there.
 */
async function writeKeyOnce(data: string, keyFile: string, contents: string): Promise<boolean> {
  const pending = join(data, PENDING_KEY);
  try {
    const file = await open(
      pending,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(pending, keyFile);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    } finally {
      await unlink(pending);
    }
  } catch (e) {
    throw new ConfigError(`identity key: ${(e as NodeJS.ErrnoException).code ?? "unwritable"}`);
  }
  await syncDirectory(data, "identity key");
  return true;
}

async function syncDirectory(path: string, what: string): Promise<void> {
  try {
    const dir = await open(path, constants.O_RDONLY);
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (e) {
    throw new ConfigError(`${what}: ${(e as NodeJS.ErrnoException).code ?? "unwritable"}`);
  }
}
