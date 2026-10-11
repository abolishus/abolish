// Storing and reading election definitions (docs/spec/election-definition.md).
// A definition is decoded and checked by @abolishus/crypto before it is
// stored, so the server never serves bytes the verifier would reject on
// decoding or well-formedness. Its registration on L2 is what makes it the
// election's definition: the API is never a source of truth, and every caller
// compares the hash of what it is served with the registry (T-34).

import {
  DecodeError,
  decodeElectionDefinition,
  electionDefinitionHash,
  electionDefinitionRule,
  type ElectionDefinitionRule,
} from "@abolishus/crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { electionDefinitions } from "./db/schema/index.ts";
import { isBytes } from "./bytes.ts";

export type DefinitionErrorCode =
  /** The bytes don't decode strictly (`DecodeError`'s code is the cause). */
  | "decode"
  /** The definition decodes but breaks a well-formedness rule (the rule is the cause). */
  | "ill-formed"
  /** The election already has a different definition: the registry is write-once. */
  | "conflict";

export class DefinitionError extends Error {
  override readonly name = "DefinitionError";
  constructor(
    readonly code: DefinitionErrorCode,
    options?: { cause?: DecodeError | ElectionDefinitionRule },
  ) {
    super(`election definition refused: ${code}`, options);
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
 * strict decoding and the well-formedness rules. Storing the same bytes again
 * is a no-op; different bytes for a stored election are a `conflict`. The
 * caller is responsible for having read the definition from the registry
 * (P3-5 indexes it): this checks the bytes, not their registration.
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
  const electionId = new Uint8Array(decoded.election_id);
  const definitionHash = electionDefinitionHash(decoded);
  const db = drizzle({ client });
  const inserted = await db
    .insert(electionDefinitions)
    .values({ electionId, definition: bytes, definitionHash })
    .onConflictDoNothing({ target: electionDefinitions.electionId })
    .returning({ electionId: electionDefinitions.electionId });
  if (inserted.length === 0) {
    const stored = await readDefinition(client, electionId);
    if (stored === undefined || !equal(stored, bytes)) throw new DefinitionError("conflict");
  }
  return { electionId, definitionHash };
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
