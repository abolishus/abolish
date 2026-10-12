import {
  identityBackupId,
  identityBackupLocator,
  newIdentitySecret,
  openIdentityBackup,
  sealIdentityBackup,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  deleteIdentityBackup,
  IDENTITY_BACKUP_ENVELOPE_LENGTH,
  IDENTITY_BACKUP_RETENTION_MONTHS,
  identityBackups,
  IdentityBackupStoreError,
  pruneIdentityBackups,
  putIdentityBackup,
  readIdentityBackup,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// Identity-backup storage (migrations/0005_identity_backups.sql,
// src/identity-backups.ts; ADR 0017, option A, step 5): rows are keyed by a
// hash of the locator, hold a strictly decoded envelope and a month, nothing
// that names a person (T-10, T-20), and expire by the month of their last
// write, never by an access time (T-11, T-52).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

const b32 = () => new Uint8Array(randomBytes(32));

/** A backup as the ballot client makes one: a PRF output, its locator and a sealed secret. */
function backup() {
  const prf = b32();
  const secret = newIdentitySecret();
  return {
    prf,
    secret,
    locator: identityBackupLocator(prf),
    envelope: sealIdentityBackup(prf, Uint8Array.from(secret)).envelope,
  };
}

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const months = async (locator: Uint8Array) =>
  (
    await db.admin`SELECT written_month::text AS m FROM identity_backups WHERE id = ${identityBackupId(locator)}`
  ).map((r) => r["m"] as string);

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'identity_backups'
      ORDER BY ordinal_position`;
    const config = getTableConfig(identityBackups);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("keeps a hashed id, the envelope and a month: no account, address or time of day", async () => {
    // T-10, T-11: nothing that names a person or dates a request.
    const cols = await db.admin`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'identity_backups'
      ORDER BY ordinal_position`;
    expect(cols.map((c) => c["column_name"])).toEqual(["id", "envelope", "written_month"]);
  });

  test("the app role holds SELECT, INSERT, UPDATE and DELETE, and can't truncate", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'identity_backups'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(await failsWith(app`TRUNCATE identity_backups`)).toBe("42501");
  });

  test("the table refuses ids, envelopes and months of the wrong shape", async () => {
    const { envelope } = backup();
    const insert = (id: Uint8Array, env: Uint8Array, month = "2026-10-01") =>
      app`INSERT INTO identity_backups (id, envelope, written_month) VALUES (${id}, ${env}, ${month})`;
    const other = Uint8Array.from(envelope);
    other[1] = 0x0b;
    const v2 = Uint8Array.from(envelope);
    v2[2] = 2;
    for (const q of [
      insert(new Uint8Array(31), envelope),
      insert(new Uint8Array(33), envelope),
      insert(b32(), envelope.subarray(0, 62)),
      insert(b32(), Uint8Array.of(...envelope, 0)),
      insert(b32(), other),
      insert(b32(), v2),
      insert(b32(), envelope, "2026-10-02"),
    ])
      expect(await failsWith(q)).toBe("23514");
    await insert(b32(), envelope);
  });
});

describe("put, read and delete", () => {
  test("an envelope stored under a locator reads back and opens to the secret", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 32, maxLength: 32 }), async (prf) => {
        const secret = newIdentitySecret();
        const locator = identityBackupLocator(prf);
        const envelope = sealIdentityBackup(prf, Uint8Array.from(secret)).envelope;
        await putIdentityBackup(app, locator, envelope);
        const read = await readIdentityBackup(app, locator);
        expect(read).toEqual(envelope);
        expect(openIdentityBackup(prf, read!)).toEqual(secret);
      }),
      { numRuns: Math.min(numRuns, 100) },
    );
  });

  test("the row is keyed by H(locator); the locator itself is stored nowhere", async () => {
    const b = backup();
    await putIdentityBackup(app, b.locator, b.envelope);
    const rows =
      await db.admin`SELECT id, envelope FROM identity_backups WHERE id = ${identityBackupId(b.locator)}`;
    expect(rows).toHaveLength(1);
    const dump = await db.admin`
      SELECT string_agg(encode(id, 'hex') || encode(envelope, 'hex') || written_month::text, '') AS all
      FROM identity_backups`;
    expect(dump[0]!["all"]).not.toContain(Buffer.from(b.locator).toString("hex"));
    // A table copy gives only ids, which no request can present (T-66).
    expect(await readIdentityBackup(app, new Uint8Array(rows[0]!["id"]))).toBeUndefined();
  });

  test("a second put replaces the envelope; the old one is gone", async () => {
    const b = backup();
    await putIdentityBackup(app, b.locator, b.envelope);
    const next = sealIdentityBackup(b.prf, newIdentitySecret()).envelope;
    await putIdentityBackup(app, b.locator, next);
    expect(await readIdentityBackup(app, b.locator)).toEqual(next);
    expect(
      await db.admin`SELECT 1 FROM identity_backups WHERE id = ${identityBackupId(b.locator)}`,
    ).toHaveLength(1);
  });

  test("an unknown locator reads nothing and deletes nothing", async () => {
    expect(await readIdentityBackup(app, b32())).toBeUndefined();
    expect(await deleteIdentityBackup(app, b32())).toBe(false);
  });

  test("delete removes the row; another locator's row stays", async () => {
    const a = backup();
    const b = backup();
    await putIdentityBackup(app, a.locator, a.envelope);
    await putIdentityBackup(app, b.locator, b.envelope);
    expect(await deleteIdentityBackup(app, a.locator)).toBe(true);
    expect(await readIdentityBackup(app, a.locator)).toBeUndefined();
    expect(await readIdentityBackup(app, b.locator)).toEqual(b.envelope);
    expect(await deleteIdentityBackup(app, a.locator)).toBe(false);
  });

  test("refuses an envelope that doesn't decode strictly, writing nothing", async () => {
    const b = backup();
    const header = (t: number, v: number) => {
      const e = Uint8Array.from(b.envelope);
      e[0] = t >> 8;
      e[1] = t & 0xff;
      e[2] = v;
      return e;
    };
    for (const [envelope, code] of [
      [b.envelope.subarray(0, 62), "truncated"],
      [Uint8Array.of(...b.envelope, 0), "trailing-bytes"],
      [new Uint8Array(0), "truncated"],
      [header(0x000b, 1), "unknown-record-type"],
      [header(0x000a, 2), "unknown-version"],
    ] as const) {
      const e = await putIdentityBackup(app, b.locator, envelope).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(IdentityBackupStoreError);
      expect((e as IdentityBackupStoreError).code).toBe(code);
    }
    expect(await readIdentityBackup(app, b.locator)).toBeUndefined();
  });

  test("refuses locators of any length but 32 and non-byte inputs", async () => {
    const b = backup();
    for (const locator of [new Uint8Array(31), new Uint8Array(33), new Uint8Array(0)]) {
      await expect(putIdentityBackup(app, locator, b.envelope)).rejects.toThrow(TypeError);
      await expect(readIdentityBackup(app, locator)).rejects.toThrow(TypeError);
      await expect(deleteIdentityBackup(app, locator)).rejects.toThrow(TypeError);
    }
    const bad = Array.from(b.locator) as unknown as Uint8Array;
    await expect(readIdentityBackup(app, bad)).rejects.toThrow(TypeError);
    await expect(
      putIdentityBackup(app, b.locator, Array.from(b.envelope) as unknown as Uint8Array),
    ).rejects.toThrow(TypeError);
    expect(IDENTITY_BACKUP_ENVELOPE_LENGTH).toBe(b.envelope.length);
  });

  test("the caller's buffers aren't kept or changed", async () => {
    const b = backup();
    const locator = Uint8Array.from(b.locator);
    const envelope = Uint8Array.from(b.envelope);
    await putIdentityBackup(app, locator, envelope);
    expect(locator).toEqual(b.locator);
    expect(envelope).toEqual(b.envelope);
    envelope.fill(0);
    expect(await readIdentityBackup(app, b.locator)).toEqual(b.envelope);
  });
});

describe("expiry (T-52)", () => {
  /** Sets a row's month directly, as if its last write was then. */
  const writtenIn = (locator: Uint8Array, month: string) =>
    db.admin`UPDATE identity_backups SET written_month = ${month} WHERE id = ${identityBackupId(locator)}`;

  test("a write records the current UTC month and nothing finer", async () => {
    const b = backup();
    await putIdentityBackup(app, b.locator, b.envelope);
    const [now] =
      await db.admin`SELECT date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date::text AS m`;
    expect(await months(b.locator)).toEqual([now!["m"]]);
  });

  test(`a backup lives ${IDENTITY_BACKUP_RETENTION_MONTHS} whole months after the month of its last write`, async () => {
    const kept = backup();
    const expired = backup();
    for (const b of [kept, expired]) await putIdentityBackup(app, b.locator, b.envelope);
    await writtenIn(kept.locator, "2024-10-01");
    await writtenIn(expired.locator, "2024-09-01");
    // October 2026, any day and hour: September 2024 is 25 months back.
    for (const now of ["2026-10-01T00:00:00Z", "2026-10-31T23:59:59.999Z"]) {
      await pruneIdentityBackups(app, new Date(now));
      expect(await readIdentityBackup(app, kept.locator)).toEqual(kept.envelope);
      expect(await readIdentityBackup(app, expired.locator)).toBeUndefined();
    }
    // In November 2026 the October 2024 backup expires too.
    expect(
      await pruneIdentityBackups(app, new Date("2026-11-01T00:00:00Z")),
    ).toBeGreaterThanOrEqual(1);
    expect(await readIdentityBackup(app, kept.locator)).toBeUndefined();
  });

  test("reading doesn't extend a backup; rewriting it does", async () => {
    const read = backup();
    const rewritten = backup();
    for (const b of [read, rewritten]) {
      await putIdentityBackup(app, b.locator, b.envelope);
      await writtenIn(b.locator, "2000-01-01");
    }
    expect(await readIdentityBackup(app, read.locator)).toEqual(read.envelope);
    await putIdentityBackup(app, rewritten.locator, rewritten.envelope);
    await pruneIdentityBackups(app, new Date("2002-02-01T00:00:00Z"));
    expect(await readIdentityBackup(app, read.locator)).toBeUndefined();
    expect(await readIdentityBackup(app, rewritten.locator)).toEqual(rewritten.envelope);
  });

  test("refuses an invalid clock", async () => {
    await expect(pruneIdentityBackups(app, new Date(Number.NaN))).rejects.toThrow(TypeError);
  });
});
