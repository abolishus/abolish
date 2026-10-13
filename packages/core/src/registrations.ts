// Registrations and short codes in Postgres (docs/design/sharing.md, Short
// links; P2-18). Each stored definition's registration on L2 is recorded with
// its definition hash, in chain order, and a short code resolves to the poll
// `assignShortCodes` gives it over the recorded hashes in that order, without
// reading them all: the same answer any mirror computes from the registry's
// events (T-49), so a later poll ground to share a prefix can't take an
// earlier poll's code (T-53).

import { decodeElectionDefinition, electionDefinitionHash } from "@abolishus/crypto";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { readDefinition } from "./definitions.ts";
import { electionRegistrations } from "./db/schema/index.ts";
import { parseShortCode, SHORT_CODE_LENGTH, shortCodeRange } from "./short-codes.ts";

/** Where a `DefinitionRegistered` event is on L2: its block, then its log's index in the block. */
export interface RegistrationPosition {
  readonly l2Block: bigint;
  readonly logIndex: number;
}

export type RegistrationErrorCode =
  /** No definition is stored for the election. */
  | "unknown-election"
  /** The election is recorded at another position, or the position names another election. */
  | "conflict"
  /** The position isn't after every registration already recorded. */
  | "out-of-order";

export class RegistrationError extends Error {
  override readonly name = "RegistrationError";
  readonly code: RegistrationErrorCode;
  constructor(code: RegistrationErrorCode) {
    super(`registration refused: ${code}`);
    this.code = code;
  }
}

const U63 = (1n << 63n) - 1n;

function checkElectionId(electionId: Uint8Array) {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
}

/**
 * Records that `electionId`'s stored definition was registered at
 * `position`. The caller (the indexer, P3-5) takes it from a finalized L2
 * block, as it does the definition, and records registrations in chain order:
 * the table refuses one that isn't after every one already recorded, so a
 * code never moves to a poll recorded late. Recording the same position again
 * is a no-op.
 */
export async function recordRegistration(
  client: Sql,
  electionId: Uint8Array,
  position: RegistrationPosition,
): Promise<void> {
  checkElectionId(electionId);
  const { l2Block, logIndex } = position;
  if (typeof l2Block !== "bigint" || l2Block < 0n || l2Block > U63)
    throw new TypeError("l2Block must be a bigint from 0 to 2^63 - 1");
  if (!Number.isInteger(logIndex) || logIndex < 0 || logIndex > 0x7fffffff)
    throw new TypeError("logIndex must be an integer from 0 to 2^31 - 1");
  const id = new Uint8Array(electionId);
  const definition = await readDefinition(client, id);
  if (definition === undefined) throw new RegistrationError("unknown-election");
  // The definition was decoded and checked when it was stored.
  const definitionHash = electionDefinitionHash(decodeElectionDefinition(definition));
  const db = drizzle({ client });
  const r = electionRegistrations;
  const [recorded] = await db
    .select({ l2Block: r.l2Block, logIndex: r.logIndex })
    .from(r)
    .where(eq(r.electionId, id));
  if (recorded !== undefined) {
    if (recorded.l2Block === l2Block && recorded.logIndex === logIndex) return;
    throw new RegistrationError("conflict");
  }
  const [latest] = await db
    .select({ l2Block: r.l2Block, logIndex: r.logIndex })
    .from(r)
    .orderBy(desc(r.l2Block), desc(r.logIndex))
    .limit(1);
  if (latest !== undefined) {
    if (latest.l2Block === l2Block && latest.logIndex === logIndex)
      throw new RegistrationError("conflict");
    if (latest.l2Block > l2Block || (latest.l2Block === l2Block && latest.logIndex > logIndex))
      throw new RegistrationError("out-of-order");
  }
  // A concurrent recorder can still get in first: the table's constraints and
  // append trigger then refuse this insert with the database's own error.
  await db.insert(r).values({ electionId: id, definitionHash, l2Block, logIndex });
}

/** A code's poll: its election ID and the code in its one canonical form. */
export interface ShortCodeMatch {
  readonly electionId: Uint8Array;
  readonly code: string;
}

/** The earliest recorded registration whose definition hash starts with `code`. */
async function earliestWithPrefix(client: Sql, code: string) {
  const { from, to } = shortCodeRange(code);
  const r = electionRegistrations;
  const [row] = await drizzle({ client })
    .select({ electionId: r.electionId, l2Block: r.l2Block, logIndex: r.logIndex })
    .from(r)
    .where(
      to === undefined
        ? gte(r.definitionHash, from)
        : and(gte(r.definitionHash, from), lt(r.definitionHash, to)),
    )
    .orderBy(asc(r.l2Block), asc(r.logIndex))
    .limit(1);
  return row;
}

/**
 * The poll that owns what someone typed, scanned or followed as a code, or
 * `undefined` for input that isn't a code (`parseShortCode`) or a code no poll
 * owns. A poll owns a code when it is the earliest recorded with that prefix
 * and the code is no longer than it needs: 7 characters, or one more than a
 * prefix some earlier poll shares. Delisted and hidden polls resolve like any
 * other, as they do by election ID (docs/moderation-policy.md).
 */
export async function lookupShortCode(
  client: Sql,
  input: string,
): Promise<ShortCodeMatch | undefined> {
  const code = parseShortCode(input);
  if (code === undefined) return undefined;
  const owner = await earliestWithPrefix(client, code);
  if (owner === undefined) return undefined;
  if (code.length > SHORT_CODE_LENGTH) {
    const earlier = await earliestWithPrefix(client, code.slice(0, -1));
    // `owner` itself has the shorter prefix, so `earlier` is never undefined.
    const before =
      earlier !== undefined &&
      (earlier.l2Block < owner.l2Block ||
        (earlier.l2Block === owner.l2Block && earlier.logIndex < owner.logIndex));
    if (!before) return undefined;
  }
  return { electionId: new Uint8Array(owner.electionId), code };
}
