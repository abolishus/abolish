// Storing and reading election definitions (docs/spec/election-definition.md).
// A definition is decoded and checked by @abolishus/crypto before it is
// stored, so the server never serves bytes the verifier would reject on
// decoding, well-formedness or 2.3's profile combination. Its registration on L2 is what makes it the
// election's definition: the API is never a source of truth, and every caller
// compares the hash of what it is served with the registry (T-34).

import {
  DecodeError,
  decodeElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  type ElectionDefinitionRule,
  profileCombinationRule,
  type ProfileCombinationRule,
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
    options?: { cause?: DecodeError | ElectionDefinitionRule | ProfileCombinationRule },
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

/**
 * Stores an election definition under the `election_id` it carries, after
 * strict decoding, the well-formedness rules and 2.3's profile combination.
 * A profile 2.3 fails is refused: no ballot cast under it can be verified,
 * and the client refuses it, so the server never serves it as an election
 * (T-34, T-42). So is one that is only unsupported here (a board-entry,
 * ballot, opening or contract-event version this release doesn't read): the
 * board store and admission can't read its records either (T-36). Storing the same bytes again
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
  let decoded;
  try {
    decoded = decodeElectionDefinition(bytes);
  } catch (e) {
    if (e instanceof DecodeError) throw new DefinitionError("decode", { cause: e });
    throw e;
  }
  const rule = electionDefinitionRule(decoded);
  if (rule !== undefined) throw new DefinitionError("ill-formed", { cause: rule });
  const profile = profileCombinationRule(decoded);
  if (profile !== undefined) throw new DefinitionError("profile", { cause: profile });
  const electionId = new Uint8Array(decoded.election_id);
  const definitionHash = electionDefinitionHash(decoded);
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
