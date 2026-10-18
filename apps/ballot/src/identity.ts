// The voting identity this device holds ([[identity-backup]], Identity
// secret): the secret and the tier groups registration added its commitment
// to, kept in this origin's IndexedDB and nowhere else. The secret never
// leaves the device unencrypted: it goes from here only to the ballot worker,
// which zeroes its copy, and every read hands out a fresh copy for the caller
// to zero once used (T-12, T-18). The identity is kept from the moment it is
// made, whatever registration's outcome ([[registration]], Outcome), with the
// Tier 0 request it is waiting on, if any. Backup and recovery, which seal it
// for the voter's passkey, come later (P2-8 part 3b-2c-2b-2c).
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

/**
 * The Tier 0 request the identity waits on ([[registration]], Outcome): the
 * region it asked for, which every repeat and the direct path keep (T-16),
 * and when the route last accepted it, for the retry heuristic.
 */
export interface Tier0Request {
  /** The region code, a u32. */
  readonly region: number;
  /** Milliseconds since the UNIX epoch, by this device's clock. */
  readonly acceptedAt: number;
}

export interface VotingIdentity {
  /** 32 bytes, `identity_secret`'s encoding: zero it once used. */
  readonly secret: Uint8Array;
  /** None to three, at most one per tier, in ascending order of tier. */
  readonly memberships: readonly Membership[];
  /** The Tier 0 request waiting on the board, never beside a Tier 0 membership. */
  readonly tier0Request?: Tier0Request;
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

/**
 * The stored record's version: another is unreadable, never migrated by
 * guessing. Version 1, which had no request and at least one membership,
 * was never written outside the tests.
 */
const RECORD_VERSION = 2;

const TIERS = [0, 1, 2];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasExactly = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

function membershipOf(v: unknown): Membership | undefined {
  if (!isRecord(v) || !hasExactly(v, ["tier", "group"])) return undefined;
  const { tier, group } = v;
  // `Object.is`, not `includes`: -0 would pass as 0, a second encoding of it.
  if (typeof tier !== "number" || !TIERS.some((t) => Object.is(t, tier))) return undefined;
  if (typeof group !== "bigint" || group < 0n || group >> 64n !== 0n) return undefined;
  return { tier, group };
}

const MAX_U32 = 0xffff_ffff;

function tier0RequestOf(v: unknown): Tier0Request | undefined {
  if (!isRecord(v) || !hasExactly(v, ["region", "acceptedAt"])) return undefined;
  const { region, acceptedAt } = v;
  if (typeof region !== "number" || !Number.isInteger(region) || region < 0 || region > MAX_U32)
    return undefined;
  if (Object.is(region, -0)) return undefined;
  if (typeof acceptedAt !== "number" || !Number.isSafeInteger(acceptedAt) || acceptedAt < 0)
    return undefined;
  if (Object.is(acceptedAt, -0)) return undefined;
  return { region, acceptedAt };
}

/**
 * The identity a stored value holds, or `undefined` if it isn't exactly a
 * record this client writes: version 2, an identity secret, none to three
 * memberships in strictly ascending order of tier, and a Tier 0 request
 * (`null` for none) only while there is no Tier 0 membership. The secret is
 * a copy.
 */
export function parseStoredIdentity(value: unknown): VotingIdentity | undefined {
  if (!isRecord(value) || !hasExactly(value, ["v", "secret", "memberships", "tier0Request"]))
    return undefined;
  const { v, secret, memberships, tier0Request } = value;
  if (v !== RECORD_VERSION) return undefined;
  if (!(secret instanceof Uint8Array) || !isIdentitySecret(secret)) return undefined;
  if (
    !Array.isArray(memberships) ||
    memberships.length > TIERS.length ||
    // A cloned array keeps any extra own properties: only the indices are a record's.
    Object.keys(memberships).length !== memberships.length
  )
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
  if (tier0Request === null) return { secret: secret.slice(), memberships: parsed };
  const request = tier0RequestOf(tier0Request);
  // Registered at Tier 0, the client has no request left to wait on.
  if (request === undefined || parsed[0]?.tier === 0) return undefined;
  return { secret: secret.slice(), memberships: parsed, tier0Request: request };
}

/** The record `saveIdentity` stores; throws on an identity `parseStoredIdentity` would refuse. */
export function storedIdentity(identity: VotingIdentity): Record<string, unknown> {
  const record = {
    v: RECORD_VERSION,
    secret: identity.secret.slice(),
    memberships: identity.memberships.map(({ tier, group }) => ({ tier, group })),
    tier0Request:
      identity.tier0Request === undefined
        ? null
        : { region: identity.tier0Request.region, acceptedAt: identity.tier0Request.acceptedAt },
  };
  const back = parseStoredIdentity(record);
  if (back === undefined) throw new TypeError("not a voting identity this client stores");
  back.secret.fill(0);
  return record;
}

/**
 * Runs `use` on the identity store, in one transaction that ends before it
 * resolves, with what the function `use` returned gives once it has.
 */
async function withStore<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => () => T,
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
      // Strict durability for writes: completion then means on disk, not
      // only in the browser's cache, so an identity a request was sent for
      // survives a crash right after (T-18).
      const transaction = db.transaction(
        STORE,
        mode,
        mode === "readwrite" ? { durability: "strict" } : undefined,
      );
      const result = use(transaction.objectStore(STORE));
      // Resolved on completion, so a write is durable before the caller goes on.
      transaction.oncomplete = () => resolve(result());
      // The failed request's own error (a ConstraintError, say), which bubbles
      // here before the transaction's is set.
      transaction.onerror = ({ target }) =>
        reject(
          (target instanceof IDBRequest ? target.error : null) ??
            transaction.error ??
            new Error("the identity store failed"),
        );
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
    value = await withStore<unknown>(factory, "readonly", (store) => {
      const get = store.get(KEY);
      return () => get.result as unknown;
    });
  } catch {
    return { kind: "unreadable" };
  }
  if (value === undefined) return { kind: "none" };
  const identity = parseStoredIdentity(value);
  wipeStored(value);
  return identity === undefined ? { kind: "unreadable" } : { kind: "found", identity };
}

/** Zeroes the secret in a structured clone a read made of the stored record. */
function wipeStored(value: unknown): void {
  // The whole buffer: a view's bytes may be only part of what was cloned.
  if (isRecord(value) && value["secret"] instanceof Uint8Array)
    new Uint8Array(value["secret"].buffer).fill(0);
}

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Stores `identity` as this device's, replacing any other; resolves once the write is committed. */
export async function saveIdentity(
  identity: VotingIdentity,
  factory: IDBFactory = indexedDB,
): Promise<void> {
  const record = storedIdentity(identity);
  try {
    await withStore(factory, "readwrite", (store) => {
      store.put(record, KEY);
      return () => undefined;
    });
  } finally {
    (record["secret"] as Uint8Array).fill(0);
  }
}

/**
 * Keeps a newly made identity (`secret`, in no group and waiting on no
 * request) as this device's, but only if the device holds none: an
 * identity already there, readable or not, is never replaced, since it may
 * be registered and its loss can't be undone (T-18). `exists` then, and
 * `unwritable` for storage the browser refuses. Kept before anything is
 * sent, so a registration is never made for an identity the device lost
 * ([[registration]], Outcome).
 */
export async function createIdentity(
  secret: Uint8Array,
  factory: IDBFactory = indexedDB,
): Promise<"created" | "exists" | "unwritable"> {
  const record = storedIdentity({ secret, memberships: [] });
  try {
    // `add`, not `put`: in the same transaction as the check that the key is free.
    await withStore(factory, "readwrite", (store) => {
      store.add(record, KEY);
      return () => undefined;
    });
    return "created";
  } catch (error) {
    return error instanceof DOMException && error.name === "ConstraintError"
      ? "exists"
      : "unwritable";
  } finally {
    (record["secret"] as Uint8Array).fill(0);
  }
}

/**
 * Records that the registration route accepted a Tier 0 request for the
 * identity whose secret is `secret` ([[registration]], Outcome), in one
 * transaction with the read that finds it still there. `changed` if the
 * device now holds another identity, an unreadable one or one already in a
 * Tier 0 group, which is left as it is; `unwritable` for storage the
 * browser refuses.
 */
export async function recordTier0Request(
  secret: Uint8Array,
  request: Tier0Request,
  factory: IDBFactory = indexedDB,
): Promise<"recorded" | "changed" | "unwritable"> {
  // Checked before the transaction, so a bad request throws rather than reads as a refusal.
  const checked = storedIdentity({ secret, memberships: [], tier0Request: request });
  (checked["secret"] as Uint8Array).fill(0);
  try {
    return await withStore(factory, "readwrite", (store) => {
      let outcome: "recorded" | "changed" = "changed";
      const get = store.get(KEY);
      get.onsuccess = () => {
        const value: unknown = get.result;
        const held = parseStoredIdentity(value);
        wipeStored(value);
        if (held === undefined) return;
        const same = equalBytes(held.secret, secret) && held.memberships[0]?.tier !== 0;
        if (same) {
          const record = storedIdentity({ ...held, tier0Request: request });
          store.put(record, KEY);
          (record["secret"] as Uint8Array).fill(0);
          outcome = "recorded";
        }
        held.secret.fill(0);
      };
      return () => outcome;
    });
  } catch {
    return "unwritable";
  }
}
