// Storing and reading election definitions (docs/spec/election-definition.md).
// A definition is decoded and checked by @abolishus/crypto before it is
// stored, under version 1 (one question) or version 5 (several questions,
// P2-14), the versions a client checks before showing a poll
// (`checkElectionRecordToShow`; T-34, T-41), so the server never serves bytes the verifier would reject on
// decoding, well-formedness or 2.3's profile combination. Its registration on L2 is what makes it the
// election's definition: the API is never a source of truth, and every caller
// compares the hash of what it is served with the registry (T-34).

import {
  DecodeError,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  type ElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  type ElectionDefinitionRule,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  type ElectionDefinitionV5Rule,
  profileCombinationRule,
  type ProfileCombinationRule,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { eq, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { electionDefinitions } from "./db/schema/index.ts";
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
  | { readonly version: 5; readonly value: ElectionDefinitionV5 };

/**
 * Strictly decodes a definition of version 1 or 5, each under its own layout
 * and self-pin. Any other version, versions 3 and 4 among them, is
 * `unknown-version` at its version byte: no client shows those yet, so the
 * server stores none (T-34). Only the version byte routes the record, as in
 * the verifier's reader, and each decoder checks the self-pin again.
 */
export function decodeStoredDefinition(bytes: Uint8Array): StoredDefinitionRecord {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0 &&
    bytes[1] === RECORD_TYPES.electionDefinition &&
    bytes[2] === 5
  )
    return { version: 5, value: decodeElectionDefinitionV5(bytes) };
  return { version: 1, value: decodeElectionDefinition(bytes) };
}

/** The definition's hash under its own version, the one the election registry holds. */
export function storedDefinitionHash(record: StoredDefinitionRecord): Uint8Array {
  return record.version === 5
    ? electionDefinitionV5Hash(record.value)
    : electionDefinitionHash(record.value);
}

/**
 * Stores an election definition of version 1 or 5 under the `election_id` it
 * carries, after strict decoding, its version's well-formedness rules and
 * 2.3's profile combination.
 * A profile 2.3 fails is refused: no ballot cast under it can be verified,
 * and the client refuses it, so the server never serves it as an election
 * (T-34, T-42). So is one 2.3 finds only unsupported here
 * (`unsupported-version`): the board store and admission can't read its
 * records either (T-36). Storing the same bytes again
 * is a no-op; different bytes for a stored election are a `conflict`. The
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
  const rule =
    record.version === 5
      ? electionDefinitionV5Rule(record.value)?.rule
      : electionDefinitionRule(record.value);
  if (rule !== undefined) throw new DefinitionError("ill-formed", { cause: rule });
  const profile = profileCombinationRule(record.value);
  if (profile !== undefined) throw new DefinitionError("profile", { cause: profile });
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
  return { electionId, definitionHash };
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
