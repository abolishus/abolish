// Storing and reading election definitions (docs/spec/election-definition.md).
// A definition is decoded and checked by @abolishus/crypto before it is
// stored, under version 1 (one question), version 5 (several questions,
// P2-14) or version 7 (an electorate mode, so a rolling one, P2-17), so the
// server never serves bytes the verifier would reject on decoding,
// well-formedness or 2.3's profile combination (T-34, T-41). Its registration on L2 is what makes it the
// election's definition: the API is never a source of truth, and every caller
// compares the hash of what it is served with the registry (T-34).

import {
  DecodeError,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV7,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  type ElectionDefinitionRule,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  type ElectionDefinitionV5Rule,
  type ElectionDefinitionV7,
  electionDefinitionV7Hash,
  electionDefinitionV7Rule,
  type ElectionDefinitionV7Rule,
  ELECTORATE_MODES,
  profileCombinationRule,
  type ProfileCombinationRule,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { and, asc, eq, gt, isNull, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { electionDefinitions, electionSchedules } from "./db/schema/index.ts";
import { isBytes } from "./bytes.ts";

export type DefinitionErrorCode =
  /** The bytes don't decode strictly (`DecodeError`'s code is the cause). */
  | "decode"
  /** The definition decodes but breaks a well-formedness rule (the rule is the cause). */
  | "ill-formed"
  /**
   * The definition is well formed but its pins fail 2.3's profile
   * combination, or name versions this release can't read (the rule is the
   * cause).
   */
  | "profile"
  /**
   * The definition is well formed and 2.3 passes it, but it names an author
   * panel, which this server's openings and tally don't carry yet.
   */
  | "unsupported"
  /** The election already has a different definition: the registry is write-once. */
  | "conflict";

export class DefinitionError extends Error {
  override readonly name = "DefinitionError";
  readonly code: DefinitionErrorCode;
  constructor(
    code: DefinitionErrorCode,
    options?: {
      cause?:
        | DecodeError
        | ElectionDefinitionRule
        | ElectionDefinitionV5Rule
        | ElectionDefinitionV7Rule
        | ProfileCombinationRule;
    },
  ) {
    super(`election definition refused: ${code}`, options);
    this.code = code;
  }
}

export interface StoredDefinition {
  readonly electionId: Uint8Array;
  readonly definitionHash: Uint8Array;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** A definition of a version `storeDefinition` takes, decoded. */
export type StoredDefinitionRecord =
  | { readonly version: 1; readonly value: ElectionDefinition }
  | { readonly version: 5; readonly value: ElectionDefinitionV5 }
  | { readonly version: 7; readonly value: ElectionDefinitionV7 };

/**
 * Strictly decodes a definition of version 1, 5 or 7, each under its own
 * layout and self-pin. Any other version, versions 3, 4 and 6 among them, is
 * `unknown-version` at its version byte: nothing the operator creates or
 * reads uses them, so the server stores none (T-34). Only the version byte
 * routes the record, as in the verifier's reader, and each decoder checks
 * the self-pin again.
 */
export function decodeStoredDefinition(bytes: Uint8Array): StoredDefinitionRecord {
  const version =
    bytes.length >= 3 && bytes[0] === 0 && bytes[1] === RECORD_TYPES.electionDefinition
      ? bytes[2]
      : undefined;
  if (version === 5) return { version, value: decodeElectionDefinitionV5(bytes) };
  if (version === 7) return { version, value: decodeElectionDefinitionV7(bytes) };
  return { version: 1, value: decodeElectionDefinition(bytes) };
}

/** The definition's hash under its own version, the one the election registry holds. */
export function storedDefinitionHash(record: StoredDefinitionRecord): Uint8Array {
  switch (record.version) {
    case 7:
      return electionDefinitionV7Hash(record.value);
    case 5:
      return electionDefinitionV5Hash(record.value);
    case 1:
      return electionDefinitionHash(record.value);
  }
}

/** Whether a stored definition's electorate is rolling (version 7 under `electorate_mode` 2). */
export const isRollingDefinition = (record: StoredDefinitionRecord): boolean =>
  record.version === 7 && record.value.electorate_mode === ELECTORATE_MODES.rolling;

function wellFormedRule(record: StoredDefinitionRecord) {
  switch (record.version) {
    case 7:
      return electionDefinitionV7Rule(record.value)?.rule;
    case 5:
      return electionDefinitionV5Rule(record.value)?.rule;
    case 1:
      return electionDefinitionRule(record.value);
  }
}

/**
 * Stores an election definition of version 1, 5 or 7 under the
 * `election_id` it carries, after strict decoding, its version's
 * well-formedness rules and 2.3's profile combination.
 * A profile 2.3 fails is refused: no ballot cast under it can be verified,
 * and the client refuses it, so the server never serves it as an election
 * (T-34, T-42). So is one 2.3 finds only unsupported here
 * (`unsupported-version`): the board store and admission can't read its
 * records either (T-36). 2.3 is read with no seats pinned as ours, so a live
 * poll is refused (the live restriction, which this server's releases don't
 * carry yet; T-16, T-45), and as reading a rolling electorate, which
 * admission judges against the registries' step roots (P2-17 part 7a; T-08).
 * A version-7 definition naming an author panel is `unsupported`: no
 * opening or tally here sums its half, so its poll could never be counted
 * (P2-16; T-17). Its `opens_at` and `closes_at` go beside it, for
 * discovery's sorts (src/listing.ts). Storing the same bytes again
 * is a no-op, but for writing those times if they are missing; different
 * bytes for a stored election are a `conflict`. The
 * caller is responsible for having read the definition from the registry in
 * a finalized L2 block (P3-5 indexes it): the row is permanent, and this
 * checks the bytes, not their registration.
 */
export async function storeDefinition(
  client: Sql,
  definition: Uint8Array,
): Promise<StoredDefinition> {
  if (!isBytes(definition)) throw new TypeError("definition must be a Uint8Array");
  const bytes = new Uint8Array(definition);
  let record;
  try {
    record = decodeStoredDefinition(bytes);
  } catch (e) {
    if (e instanceof DecodeError) throw new DefinitionError("decode", { cause: e });
    throw e;
  }
  const rule = wellFormedRule(record);
  if (rule !== undefined) throw new DefinitionError("ill-formed", { cause: rule });
  const profile = profileCombinationRule(record.value, 0, isRollingDefinition(record));
  if (profile !== undefined) throw new DefinitionError("profile", { cause: profile });
  if (record.version === 7 && record.value.author_keys.length > 0)
    throw new DefinitionError("unsupported");
  const electionId = new Uint8Array(record.value.election_id);
  const definitionHash = storedDefinitionHash(record);
  const db = drizzle({ client });
  const inserted = await db
    .insert(electionDefinitions)
    .values({ electionId, definition: bytes })
    .onConflictDoNothing({ target: electionDefinitions.electionId })
    .returning({ electionId: electionDefinitions.electionId });
  if (inserted.length === 0) {
    const stored = await readDefinition(client, electionId);
    if (stored === undefined || !equal(stored, bytes)) throw new DefinitionError("conflict");
  }
  // After the definition, so a schedule never names one that isn't stored.
  // Not in one transaction with it: storing again, or fillElectionSchedules,
  // writes a schedule an interrupted call left out.
  await insertSchedule(client, electionId, record);
  return { electionId, definitionHash };
}

async function insertSchedule(
  client: Sql,
  electionId: Uint8Array,
  record: StoredDefinitionRecord,
): Promise<void> {
  await drizzle({ client })
    .insert(electionSchedules)
    .values({ electionId, opensAt: record.value.opens_at, closesAt: record.value.closes_at })
    .onConflictDoNothing({ target: electionSchedules.electionId });
}

/** How many definitions `fillElectionSchedules` reads at a time. */
const FILL_BATCH = 500;

/**
 * Writes the schedule of every stored definition that has none: those stored
 * before migration 0023 added the table, or by a `storeDefinition` call
 * interrupted between its two writes. Returns how many it wrote. Every stored
 * definition decoded when it was stored, so one that doesn't now is an error.
 */
export async function fillElectionSchedules(client: Sql): Promise<number> {
  const db = drizzle({ client });
  let written = 0;
  let after = new Uint8Array(0);
  for (;;) {
    const rows = await db
      .select({
        electionId: electionDefinitions.electionId,
        definition: electionDefinitions.definition,
      })
      .from(electionDefinitions)
      .leftJoin(electionSchedules, eq(electionSchedules.electionId, electionDefinitions.electionId))
      .where(and(isNull(electionSchedules.electionId), gt(electionDefinitions.electionId, after)))
      .orderBy(asc(electionDefinitions.electionId))
      .limit(FILL_BATCH);
    for (const row of rows) {
      const electionId = new Uint8Array(row.electionId);
      await insertSchedule(
        client,
        electionId,
        decodeStoredDefinition(new Uint8Array(row.definition)),
      );
      written++;
      after = electionId;
    }
    if (rows.length < FILL_BATCH) return written;
  }
}

/** Whether a definition is stored for `electionId`, without reading it. */
export async function hasDefinition(client: Sql, electionId: Uint8Array): Promise<boolean> {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  const [row] = await drizzle({ client })
    .select({ one: q<number>`1` })
    .from(electionDefinitions)
    .where(eq(electionDefinitions.electionId, new Uint8Array(electionId)))
    .limit(1);
  return row !== undefined;
}

/** The stored definition of `electionId`, as its encoded bytes, or `undefined`. */
export async function readDefinition(
  client: Sql,
  electionId: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  const [row] = await drizzle({ client })
    .select({ definition: electionDefinitions.definition })
    .from(electionDefinitions)
    .where(eq(electionDefinitions.electionId, new Uint8Array(electionId)));
  return row === undefined ? undefined : new Uint8Array(row.definition);
}
