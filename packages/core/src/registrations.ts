// Registrations and short codes in Postgres (docs/design/sharing.md, Short
// links; P2-18). Every DefinitionRegistered event is recorded with the
// definition hash it carries, in chain order, and a short code resolves to the
// poll `assignShortCodes` gives it over the recorded hashes in that order,
// without reading them all: the same answer any mirror computes from the
// registry's events (T-49), so a later poll ground to share a prefix can't
// take an earlier poll's code (T-53).

import { decodeElectionDefinition, electionDefinitionHash } from "@abolishus/crypto";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { isBytes } from "./bytes.ts";
import { readDefinition } from "./definitions.ts";
import { electionRegistrations } from "./db/schema/index.ts";
import {
  MAX_SHORT_CODE_LENGTH,
  parseShortCode,
  SHORT_CODE_LENGTH,
  shortCode,
  shortCodeRange,
} from "./short-codes.ts";

/** A `DefinitionRegistered` event: its election, its definition hash and where it is on L2. */
export interface Registration {
  readonly electionId: Uint8Array;
  readonly definitionHash: Uint8Array;
  readonly l2Block: bigint;
  /** The log's index within its block. */
  readonly logIndex: number;
}

export type RegistrationErrorCode =
  /** The election is recorded differently, or the position or hash names another election. */
  | "conflict"
  /** The definition stored for the election doesn't have this hash. */
  | "hash-mismatch"
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

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Records a `DefinitionRegistered` event, whether or not its definition is
 * stored here: a definition `storeDefinition` refuses still owns its codes
 * (verifier 2.1 fails it; the registry accepted it), or our codes would differ
 * from a mirror's. If the definition is stored, its hash must match. The
 * caller (the indexer, P3-5) takes events from finalized L2 blocks and
 * records them in chain order, outside any REPEATABLE READ or SERIALIZABLE
 * transaction: the table refuses one that isn't after every one already
 * recorded, so a code never moves to a poll recorded late. Recording the same
 * event again is a no-op.
 */
export async function recordRegistration(client: Sql, registration: Registration): Promise<void> {
  const { electionId, definitionHash, l2Block, logIndex } = registration;
  for (const [name, bytes] of [
    ["electionId", electionId],
    ["definitionHash", definitionHash],
  ] as const)
    if (!isBytes(bytes) || bytes.length !== 32) throw new TypeError(`${name} must be 32 bytes`);
  if (typeof l2Block !== "bigint" || l2Block < 0n || l2Block > U63)
    throw new TypeError("l2Block must be a bigint from 0 to 2^63 - 1");
  if (!Number.isInteger(logIndex) || logIndex < 0 || logIndex > 0x7fffffff)
    throw new TypeError("logIndex must be an integer from 0 to 2^31 - 1");
  const id = new Uint8Array(electionId);
  const hash = new Uint8Array(definitionHash);
  const definition = await readDefinition(client, id);
  // A stored definition was decoded and checked when it was stored.
  if (
    definition !== undefined &&
    !equal(electionDefinitionHash(decodeElectionDefinition(definition)), hash)
  )
    throw new RegistrationError("hash-mismatch");
  const db = drizzle({ client });
  const r = electionRegistrations;
  const [recorded] = await db
    .select({ definitionHash: r.definitionHash, l2Block: r.l2Block, logIndex: r.logIndex })
    .from(r)
    .where(eq(r.electionId, id));
  if (recorded !== undefined) {
    if (
      equal(recorded.definitionHash, hash) &&
      recorded.l2Block === l2Block &&
      recorded.logIndex === logIndex
    )
      return;
    throw new RegistrationError("conflict");
  }
  const [taken] = await db
    .select({ one: r.logIndex })
    .from(r)
    .where(eq(r.definitionHash, hash))
    .limit(1);
  if (taken !== undefined) throw new RegistrationError("conflict");
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
  await db.insert(r).values({ electionId: id, definitionHash: hash, l2Block, logIndex });
}

/** A code's poll: its election ID and the code in its one canonical form. */
export interface ShortCodeMatch {
  readonly electionId: Uint8Array;
  readonly code: string;
}

/** The earliest recorded registration whose definition hash starts with `code`. */
async function earliestWithPrefix(client: Sql, code: string) {
  const { from, to } = shortCodeRange(code);
  // Materialized, so the hash range is always read first through its index:
  // walking the position index instead would scan every row for a code no
  // poll has, on a public route (T-52).
  const [row] = await client<{ election_id: Uint8Array; l2_block: string; log_index: number }[]>`
    WITH matches AS MATERIALIZED (
      SELECT election_id, l2_block, log_index FROM election_registrations
      WHERE definition_hash >= ${from}
        ${to === undefined ? client`` : client`AND definition_hash < ${to}`}
    )
    SELECT election_id, l2_block, log_index FROM matches
    ORDER BY l2_block, log_index LIMIT 1`;
  return row === undefined
    ? undefined
    : {
        electionId: new Uint8Array(row.election_id),
        l2Block: BigInt(row.l2_block),
        logIndex: row.log_index,
      };
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
    // `owner` has the shorter prefix too, so this finds `owner` or an earlier
    // poll, and `owner` owns the code only if it finds an earlier one.
    const earlier = await earliestWithPrefix(client, code.slice(0, -1));
    if (earlier === undefined || equal(earlier.electionId, owner.electionId)) return undefined;
  }
  return { electionId: owner.electionId, code };
}

/** Whether a registration recorded before position (`l2Block`, `logIndex`) has `code`'s prefix. */
async function sharedByEarlier(client: Sql, code: string, l2Block: bigint, logIndex: number) {
  const { from, to } = shortCodeRange(code);
  // Materialized, as in `earliestWithPrefix`, so only the prefix's range is read.
  const [row] = await client<{ one: number }[]>`
    WITH matches AS MATERIALIZED (
      SELECT l2_block, log_index FROM election_registrations
      WHERE definition_hash >= ${from}
        ${to === undefined ? client`` : client`AND definition_hash < ${to}`}
    )
    SELECT 1 AS one FROM matches
    WHERE (l2_block, log_index) < (${l2Block.toString()}::bigint, ${logIndex}::integer)
    LIMIT 1`;
  return row !== undefined;
}

/**
 * The canonical short code of the poll registered as `electionId`, the one
 * `lookupShortCode` resolves to it: the shortest prefix of its definition hash,
 * at least 7 characters, that no poll recorded before it shares. `undefined`
 * if no registration is recorded for the election, since a code resolves only
 * through one. Delisted and hidden polls keep theirs, as they resolve by it.
 */
export async function shortCodeOf(
  client: Sql,
  electionId: Uint8Array,
): Promise<string | undefined> {
  if (!isBytes(electionId) || electionId.length !== 32)
    throw new TypeError("electionId must be 32 bytes");
  const db = drizzle({ client });
  const r = electionRegistrations;
  const [recorded] = await db
    .select({ definitionHash: r.definitionHash, l2Block: r.l2Block, logIndex: r.logIndex })
    .from(r)
    .where(eq(r.electionId, new Uint8Array(electionId)));
  if (recorded === undefined) return undefined;
  const { definitionHash, l2Block, logIndex } = recorded;
  // Sharing a prefix implies sharing every shorter one, so the first length
  // no earlier poll shares is the code. Each longer one costs a grinder 32
  // times the work, so the loop is short whoever registered before.
  for (let length = SHORT_CODE_LENGTH; length <= MAX_SHORT_CODE_LENGTH; length++) {
    const code = shortCode(definitionHash, length);
    if (!(await sharedByEarlier(client, code, l2Block, logIndex))) return code;
  }
  // Definition hashes are unique, and 52 characters spell all 256 bits.
  throw new Error("shortCodeOf: an earlier registration has the same definition hash");
}
