// The voting identity this device holds ([[identity-backup]], Identity
// secret): the secret and the tier groups registration added its commitment
// to, kept in this origin's IndexedDB and nowhere else. The secret never
// leaves the device unencrypted: it goes from here only to the ballot worker,
// which zeroes its copy, and every read hands out a fresh copy for the caller
// to zero once used (T-12, T-18). Backup and recovery, which seal it for the
// voter's passkey, come with registration (P2-8 part 3b-2c-2b-2).
//
// What is stored is checked on every read as strictly as a decoder: a record
// of another version, a value that isn't an identity secret or a membership
// list this client wouldn't write is unreadable, never guessed at.

import { isIdentitySecret } from "@abolishus/crypto";

/** A tier group registration added the identity's commitment to. */
export interface Membership {
  /** 0 passkey, 1 vouched, 2 document-verified. */
  readonly tier: number;
  /** The group registry's group identifier, a u64. */
  readonly group: bigint;
}

export interface VotingIdentity {
  /** 32 bytes, `identity_secret`'s encoding: zero it once used. */
  readonly secret: Uint8Array;
  /** At most one per tier, in ascending order of tier. */
  readonly memberships: readonly Membership[];
}

/** The identity, none, or a store this device couldn't open or a record it couldn't read. */
export type IdentityRead =
  | { readonly kind: "found"; readonly identity: VotingIdentity }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

/** The IndexedDB database, object store and key the identity lives under. */
export const IDENTITY_DB = "abolish-voting-identity";
const STORE = "identity";
const KEY = "voter";

/** The stored record's version: another is unreadable, never migrated by guessing. */
const RECORD_VERSION = 1;

const TIERS = [0, 1, 2];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasExactly = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

function membershipOf(v: unknown): Membership | undefined {
  if (!isRecord(v) || !hasExactly(v, ["tier", "group"])) return undefined;
  const { tier, group } = v;
  if (typeof tier !== "number" || !TIERS.includes(tier)) return undefined;
  if (typeof group !== "bigint" || group < 0n || group >> 64n !== 0n) return undefined;
  return { tier, group };
}

/**
 * The identity a stored value holds, or `undefined` if it isn't exactly a
 * record this client writes: version 1, an identity secret, and one to three
 * memberships in strictly ascending order of tier. The secret is a copy.
 */
export function parseStoredIdentity(value: unknown): VotingIdentity | undefined {
  if (!isRecord(value) || !hasExactly(value, ["v", "secret", "memberships"])) return undefined;
  const { v, secret, memberships } = value;
  if (v !== RECORD_VERSION) return undefined;
  if (!(secret instanceof Uint8Array) || !isIdentitySecret(secret)) return undefined;
  if (!Array.isArray(memberships) || memberships.length < 1 || memberships.length > TIERS.length)
    return undefined;
  const parsed: Membership[] = [];
  // Indexed, not `every` or `map`: those skip a list's holes.
  for (let i = 0; i < memberships.length; i++) {
    const membership = membershipOf(memberships[i]);
    const last = parsed.at(-1);
    if (membership === undefined || (last !== undefined && membership.tier <= last.tier))
      return undefined;
    parsed.push(membership);
  }
  return { secret: secret.slice(), memberships: parsed };
}

/** The record `saveIdentity` stores; throws on an identity `parseStoredIdentity` would refuse. */
export function storedIdentity(identity: VotingIdentity): Record<string, unknown> {
  const record = {
    v: RECORD_VERSION,
    secret: identity.secret.slice(),
    memberships: identity.memberships.map(({ tier, group }) => ({ tier, group })),
  };
  const back = parseStoredIdentity(record);
  if (back === undefined) throw new TypeError("not a voting identity this client stores");
  back.secret.fill(0);
  return record;
}

/** Runs `use` on the identity store, in one transaction that ends before it resolves. */
async function withStore<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(IDENTITY_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("the identity store didn't open"));
    open.onblocked = () => reject(new Error("the identity store is blocked"));
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = use(transaction.objectStore(STORE));
      // Resolved on completion, so a write is durable before the caller goes on.
      transaction.oncomplete = () => resolve(request.result as T);
      transaction.onerror = () =>
        reject(transaction.error ?? new Error("the identity store failed"));
      transaction.onabort = () =>
        reject(transaction.error ?? new Error("the identity store failed"));
    });
  } finally {
    db.close();
  }
}

/**
 * The identity this device holds, read afresh. Storage the browser refuses
 * (a private window, site data blocked) is `unreadable`, as is a record
 * `parseStoredIdentity` refuses: the voter is told, not asked to register a
 * second identity over one that may still be theirs.
 */
export async function readIdentity(factory: IDBFactory = indexedDB): Promise<IdentityRead> {
  let value: unknown;
  try {
    value = await withStore<unknown>(factory, "readonly", (store) => store.get(KEY));
  } catch {
    return { kind: "unreadable" };
  }
  if (value === undefined) return { kind: "none" };
  const identity = parseStoredIdentity(value);
  // The stored copy goes with the structured clone the read made.
  if (isRecord(value) && value["secret"] instanceof Uint8Array) value["secret"].fill(0);
  return identity === undefined ? { kind: "unreadable" } : { kind: "found", identity };
}

/** Stores `identity` as this device's, replacing any other; resolves once the write is committed. */
export async function saveIdentity(
  identity: VotingIdentity,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const record = storedIdentity(identity);
  try {
    await withStore<unknown>(factory, "readwrite", (store) => store.put(record, KEY));
  } finally {
    (record["secret"] as Uint8Array).fill(0);
  }
}
