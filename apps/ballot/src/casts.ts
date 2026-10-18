// This device's records of the ballots it cast ([[revoting]], Client rule
// 3): for each election and tier, every ballot it let leave, in the order of
// the L1 blocks they name, with the board entry the operator answered for it
// once that answer passed `checkBoarded` (send.ts). A cast is recorded before
// its ballot leaves the device, so each later one names a strictly newer
// block and never ties it (T-45, T-38), and a retry after a failure or a
// crash resends the identical bytes from here, never a new ballot on the same
// block (T-25). Kept in this origin's IndexedDB and nowhere else: the records
// say this device voted in these polls, as the identity says it can (T-18).
//
// What is stored is checked on every read as strictly as a decoder: a record
// of another version, a ballot that doesn't decode or blocks out of order is
// unreadable, never guessed at, and the client then casts nothing more in
// that election and tier until the voter decides.

import { decodeBallot, MAX_BOARD_PAYLOAD } from "@abolishus/crypto";

import { withStore } from "./store.ts";

/** The operator's answer for a ballot, as `checkBoarded` passed it. */
export interface Boarded {
  /** The board entry carrying exactly the ballot's bytes. */
  readonly entry: Uint8Array;
  /** The chain link after it, 32 bytes. */
  readonly link: Uint8Array;
}

/** One ballot this device cast, a version-3 ballot record ([[ballot-validity]]). */
export interface CastRecord {
  /** The record's bytes, exactly as sent and as any retry sends them again. */
  readonly ballot: Uint8Array;
  /** Its `l1_ref_number`, read from the bytes. */
  readonly l1Number: bigint;
  /** The operator's checked answer, once one passed. */
  readonly boarded?: Boarded;
}

/** The casts of one election and tier, oldest block first, or a store this device couldn't read. */
export type CastsRead =
  | { readonly kind: "read"; readonly casts: readonly CastRecord[] }
  | { readonly kind: "unreadable" };

/** The IndexedDB database and object store the casts live under. */
export const CASTS_DB = "abolish-ballot-casts";
const STORE = "casts";

/** The stored record's version: another is unreadable, never migrated by guessing. */
const RECORD_VERSION = 1;

/** The ballot record version these casts are of: the one definition version 5 pins. */
const BALLOT_VERSION = 3;

/** What a board entry adds around its payload (docs/spec/board.md): header, id, index, segment, length. */
const BOARD_ENTRY_OVERHEAD = 3 + 32 + 8 + 4 + 4;

const TIERS = [0, 1, 2];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasExactly = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The store's key for one election and tier: each tier's casts are its own (Client rule 7). */
function keyOf(electionId: Uint8Array, tier: number): string {
  if (!(electionId instanceof Uint8Array) || electionId.length !== 32)
    throw new RangeError("electionId: expected 32 bytes");
  if (!TIERS.some((t) => Object.is(t, tier))) throw new RangeError("tier: expected 0, 1 or 2");
  return `${toHex(electionId)}/${tier}`;
}

/** The ballot's `l1_ref_number`, or `undefined` for bytes that aren't a version-3 ballot record. */
function l1NumberOf(ballot: Uint8Array): bigint | undefined {
  try {
    return decodeBallot(ballot, BALLOT_VERSION).l1_ref_number;
  } catch {
    return undefined;
  }
}

function boardedOf(v: unknown, ballot: Uint8Array): Boarded | undefined {
  if (!isRecord(v) || !hasExactly(v, ["entry", "link"])) return undefined;
  const { entry, link } = v;
  if (!(link instanceof Uint8Array) || link.length !== 32) return undefined;
  // The entry carries exactly the ballot, so its length is fixed by it.
  if (!(entry instanceof Uint8Array) || entry.length !== ballot.length + BOARD_ENTRY_OVERHEAD)
    return undefined;
  return { entry: entry.slice(), link: link.slice() };
}

function castOf(v: unknown): CastRecord | undefined {
  if (!isRecord(v) || !hasExactly(v, ["ballot", "boarded"])) return undefined;
  const { ballot, boarded } = v;
  if (!(ballot instanceof Uint8Array) || ballot.length > MAX_BOARD_PAYLOAD) return undefined;
  const l1Number = l1NumberOf(ballot);
  if (l1Number === undefined) return undefined;
  if (boarded === null) return { ballot: ballot.slice(), l1Number };
  const answer = boardedOf(boarded, ballot);
  return answer === undefined ? undefined : { ballot: ballot.slice(), l1Number, boarded: answer };
}

/**
 * The casts a stored value holds, or `undefined` if it isn't exactly a
 * record this client writes: version 1 and a list of version-3 ballot
 * records naming strictly ascending L1 blocks, each with its checked board
 * entry or `null`. Every byte array is a copy.
 */
export function parseStoredCasts(value: unknown): CastRecord[] | undefined {
  if (!isRecord(value) || !hasExactly(value, ["v", "casts"])) return undefined;
  const { v, casts } = value;
  if (v !== RECORD_VERSION) return undefined;
  // A cloned array keeps any extra own properties: only the indices are a record's.
  if (!Array.isArray(casts) || Object.keys(casts).length !== casts.length) return undefined;
  const parsed: CastRecord[] = [];
  // Indexed, not `map`: that skips a list's holes.
  for (let i = 0; i < casts.length; i++) {
    const cast = castOf(casts[i]);
    const last = parsed.at(-1);
    if (cast === undefined || (last !== undefined && cast.l1Number <= last.l1Number))
      return undefined;
    parsed.push(cast);
  }
  return parsed;
}

/** The record `parseStoredCasts` reads back as `casts`; throws on casts it would refuse. */
export function storedCasts(casts: readonly CastRecord[]): Record<string, unknown> {
  const record = {
    v: RECORD_VERSION,
    casts: casts.map(({ ballot, boarded }) => ({
      ballot: ballot.slice(),
      boarded:
        boarded === undefined ? null : { entry: boarded.entry.slice(), link: boarded.link.slice() },
    })),
  };
  const back = parseStoredCasts(record);
  if (
    back === undefined ||
    back.length !== casts.length ||
    back.some((cast, i) => cast.l1Number !== casts[i]?.l1Number)
  )
    throw new TypeError("not casts this client stores");
  return record;
}

/** The newest L1 block any of `casts` names, or `undefined` for none. */
export function newestBlock(casts: readonly CastRecord[]): bigint | undefined {
  return casts.at(-1)?.l1Number;
}

/**
 * This device's casts in `electionId` at `tier`, read afresh: none is an
 * empty list. Storage the browser refuses, or a record `parseStoredCasts`
 * refuses, is `unreadable`: the voter is told, never cast for as if this
 * device had cast nothing, which could tie an earlier ballot (T-45).
 */
export async function readCasts(
  electionId: Uint8Array,
  tier: number,
  factory: IDBFactory = indexedDB,
): Promise<CastsRead> {
  const key = keyOf(electionId, tier);
  let value: unknown;
  try {
    value = await withStore<unknown>(factory, CASTS_DB, STORE, "readonly", (store) => {
      const get = store.get(key);
      return () => get.result as unknown;
    });
  } catch {
    return { kind: "unreadable" };
  }
  if (value === undefined) return { kind: "read", casts: [] };
  const casts = parseStoredCasts(value);
  return casts === undefined ? { kind: "unreadable" } : { kind: "read", casts };
}

/**
 * Replaces the casts of `key` with what `change` makes of them, in one
 * transaction with the read, only while they are readable; `change`
 * returning a string leaves them as they are and is the outcome.
 */
async function updateCasts<T extends string>(
  key: string,
  factory: IDBFactory,
  change: (casts: CastRecord[]) => CastRecord[] | T,
): Promise<"recorded" | "unreadable" | "unwritable" | T> {
  try {
    return await withStore(factory, CASTS_DB, STORE, "readwrite", (store) => {
      let outcome: "recorded" | "unreadable" | T = "unreadable";
      const get = store.get(key);
      get.onsuccess = () => {
        const value: unknown = get.result;
        const held = value === undefined ? [] : parseStoredCasts(value);
        if (held === undefined) return;
        const changed = change(held);
        if (typeof changed === "string") {
          outcome = changed;
          return;
        }
        store.put(storedCasts(changed), key);
        outcome = "recorded";
      };
      return () => outcome;
    });
  } catch {
    return "unwritable";
  }
}

/**
 * Records `ballot`, a version-3 ballot record about to be sent, as cast in
 * `electionId` at `tier`, before it leaves the device ([[revoting]], Client
 * rule 3). Only a ballot naming a block strictly newer than every one
 * recorded there is kept, in the same transaction as the read, so two tabs
 * can't both record a cast on one block: `not-newer` otherwise, and the
 * ballot must not be sent (T-45). `unreadable` for casts this device can't
 * read, which are never replaced; `unwritable` for storage the browser
 * refuses. Throws on bytes that aren't a version-3 ballot record.
 */
export async function recordCast(
  electionId: Uint8Array,
  tier: number,
  ballot: Uint8Array,
  factory: IDBFactory = indexedDB,
): Promise<"recorded" | "not-newer" | "unreadable" | "unwritable"> {
  const key = keyOf(electionId, tier);
  const l1Number = ballot instanceof Uint8Array ? l1NumberOf(ballot) : undefined;
  if (l1Number === undefined || ballot.length > MAX_BOARD_PAYLOAD)
    throw new TypeError("not a version-3 ballot record");
  const cast: CastRecord = { ballot: ballot.slice(), l1Number };
  return updateCasts(key, factory, (casts) => {
    const newest = newestBlock(casts);
    return newest !== undefined && l1Number <= newest ? "not-newer" : [...casts, cast];
  });
}

/**
 * Records the operator's checked answer (`checkBoarded`) for the recorded
 * cast whose bytes are exactly `ballot`. The first answer kept stays: a
 * resend of the same bytes is answered with the same entry, so another one
 * is `conflict` and changes nothing. `missing` if no recorded cast has these
 * bytes.
 */
export async function recordBoarded(
  electionId: Uint8Array,
  tier: number,
  ballot: Uint8Array,
  boarded: Boarded,
  factory: IDBFactory = indexedDB,
): Promise<"recorded" | "missing" | "conflict" | "unreadable" | "unwritable"> {
  const key = keyOf(electionId, tier);
  const answer = boardedOf(boarded, ballot);
  if (answer === undefined) throw new TypeError("not a board entry for this ballot");
  return updateCasts(key, factory, (casts) => {
    const at = casts.findIndex((cast) => equalBytes(cast.ballot, ballot));
    const cast = casts[at];
    if (cast === undefined) return "missing";
    if (cast.boarded !== undefined)
      return equalBytes(cast.boarded.entry, answer.entry) &&
        equalBytes(cast.boarded.link, answer.link)
        ? "recorded"
        : "conflict";
    return casts.with(at, { ...cast, boarded: answer });
  });
}
