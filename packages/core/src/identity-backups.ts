// Storage for voting-identity recovery backups (ADR 0017, option A, step 5;
// docs/spec/identity-backup.md). The ballot client seals its identity secret
// into an envelope and stores it under a locator derived from a WebAuthn PRF
// output; this module keeps the envelope under `id = H(DS(id-tag, locator))`
// and never stores the locator, so a copy of the table can't read, replace or
// delete a row (T-20, T-66). Nothing here can open an envelope, and nothing
// here names an account: the API's ballot path carries no session (T-10).

import {
  DecodeError,
  type DecodeErrorCode,
  decodeIdentityBackup,
  identityBackupId,
} from "@abolishus/crypto";
import { eq, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { identityBackups } from "./db/schema/index.ts";

/** A locator is 32 bytes (docs/spec/identity-backup.md, Keys). */
export const IDENTITY_BACKUP_LOCATOR_LENGTH = 32;

/** A version-1 envelope is 63 bytes, the only version this release stores. */
export const IDENTITY_BACKUP_ENVELOPE_LENGTH = 63;

/**
 * Whole months a backup is kept after its last write. A row last written in
 * month M is deleted from month M + 25 on: the ballot client rewrites its
 * envelope (P2-8), so a voter who opens it at least every two years keeps
 * their backup. Reads don't count: the server keeps no access time (ADR 0017).
 */
export const IDENTITY_BACKUP_RETENTION_MONTHS = 24;

/**
 * An envelope refused before anything is written: `code` is the strict
 * decoder's (docs/spec/notation.md, Strict decoding) and `cause` its error.
 */
export class IdentityBackupStoreError extends Error {
  override readonly name = "IdentityBackupStoreError";
  readonly code: DecodeErrorCode;
  constructor(cause: DecodeError) {
    super(`identity backup envelope refused: ${cause.code}`, { cause });
    this.code = cause.code;
  }
}

function rowId(locator: unknown): Uint8Array {
  if (!isBytes(locator) || locator.length !== IDENTITY_BACKUP_LOCATOR_LENGTH)
    throw new TypeError(`locator must be ${IDENTITY_BACKUP_LOCATOR_LENGTH} bytes`);
  return identityBackupId(new Uint8Array(locator));
}

/** The first day of the database clock's current UTC month. */
const thisMonth = q`date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date`;

/**
 * Stores `envelope` under `locator`, replacing any envelope already there.
 * The envelope must decode strictly as version 1 (`IdentityBackupStoreError`
 * otherwise): the server can't open it, but it never keeps
 * bytes that no client could. A write sets the row's month, which expiry
 * counts from.
 */
export async function putIdentityBackup(
  client: Sql,
  locator: Uint8Array,
  envelope: Uint8Array,
): Promise<void> {
  const id = rowId(locator);
  if (!isBytes(envelope)) throw new TypeError("envelope must be a Uint8Array");
  const bytes = new Uint8Array(envelope);
  try {
    decodeIdentityBackup(bytes);
  } catch (e) {
    if (e instanceof DecodeError) throw new IdentityBackupStoreError(e);
    throw e;
  }
  await drizzle({ client })
    .insert(identityBackups)
    .values({ id, envelope: bytes, writtenMonth: thisMonth })
    .onConflictDoUpdate({
      target: identityBackups.id,
      set: { envelope: bytes, writtenMonth: thisMonth },
    });
}

/** The envelope stored under `locator`, or `undefined` if there is none. */
export async function readIdentityBackup(
  client: Sql,
  locator: Uint8Array,
): Promise<Uint8Array | undefined> {
  const id = rowId(locator);
  const [row] = await drizzle({ client })
    .select({ envelope: identityBackups.envelope })
    .from(identityBackups)
    .where(eq(identityBackups.id, id));
  return row === undefined ? undefined : new Uint8Array(row.envelope);
}

/** Deletes the envelope stored under `locator`. Returns whether there was one. */
export async function deleteIdentityBackup(client: Sql, locator: Uint8Array): Promise<boolean> {
  const id = rowId(locator);
  const deleted = await drizzle({ client })
    .delete(identityBackups)
    .where(eq(identityBackups.id, id))
    .returning({ id: identityBackups.id });
  return deleted.length > 0;
}

/**
 * Deletes every backup last written more than
 * `IDENTITY_BACKUP_RETENTION_MONTHS` whole months before `now`'s UTC month.
 * Returns how many were deleted. Bounds what anonymous writes leave behind
 * (T-52); a voter whose backup expires keeps the identity on their device.
 */
export async function pruneIdentityBackups(client: Sql, now: Date): Promise<number> {
  if (!(now instanceof Date) || Number.isNaN(now.getTime()))
    throw new TypeError("now must be a valid Date");
  const deleted = await client`
    DELETE FROM identity_backups
    WHERE written_month < (date_trunc('month', ${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      - make_interval(months => ${IDENTITY_BACKUP_RETENTION_MONTHS}))::date`;
  return deleted.count;
}
