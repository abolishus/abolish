// The voting identity this device holds ([[identity-backup]], Identity
// secret): the secret and the tier groups registration added its commitment
// to, kept in this origin's IndexedDB and nowhere else. The secret never
// leaves the device unencrypted: it goes from here only to the ballot worker,
// which zeroes its copy, and every read hands out a fresh copy for the caller
// to zero once used (T-12, T-18). The identity is kept from the moment it is
// made, whatever registration's outcome ([[registration]], Outcome), with the
// Tier 0 request it is waiting on, if any. Beside it, under a key of its
// own, the backup passkey this device uses to seal it for recovery
// ([[0017-identity-recovery-backup]], Option A): its credential ID, never
// its PRF output or a key derived from it, which exist only for the length
// of a ceremony (T-41).
//
// What is stored is checked on every read as strictly as a decoder: a record
// of another version, a value that isn't an identity secret or a membership
// list this client wouldn't write is unreadable, never guessed at.

import { isIdentitySecret } from "@abolishus/crypto";

import { withStore } from "./store.ts";

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
  /**
   * Set on an identity recovered from its backup (`restoreIdentity`), which
   * starts without this device's records of the polls it was cast in, so
   * the cast refuses it until the recovered client's checks exist
   * ([[0017-identity-recovery-backup]], Consequences; T-18). Only beside a
   * Tier 0 membership, the one a recovery keeps.
   */
  readonly recovered?: true;
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
const BACKUP_KEY = "backup";

/**
 * The stored record's version: another is unreadable, never migrated by
 * guessing. Version 1, which had no request and at least one membership,
 * and version 2, which had no recovered flag, were never written outside
 * the tests.
 */
const RECORD_VERSION = 3;

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
 * record this client writes: version 3, an identity secret, none to three
 * memberships in strictly ascending order of tier, a Tier 0 request (`null`
 * for none) only while there is no Tier 0 membership, and the recovered
 * flag, set only beside a Tier 0 membership. The secret is a copy.
 */
export function parseStoredIdentity(value: unknown): VotingIdentity | undefined {
  if (
    !isRecord(value) ||
    !hasExactly(value, ["v", "secret", "memberships", "tier0Request", "recovered"])
  )
    return undefined;
  const { v, secret, memberships, tier0Request, recovered } = value;
  if (v !== RECORD_VERSION) return undefined;
  if (typeof recovered !== "boolean") return undefined;
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
  if (tier0Request === null) {
    if (!recovered) return { secret: secret.slice(), memberships: parsed };
    // A recovery keeps only an identity a Tier 0 group counts.
    if (parsed[0]?.tier !== 0) return undefined;
    return { secret: secret.slice(), memberships: parsed, recovered: true };
  }
  const request = tier0RequestOf(tier0Request);
  // Registered at Tier 0, the client has no request left to wait on.
  if (request === undefined || parsed[0]?.tier === 0 || recovered) return undefined;
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
    recovered: identity.recovered === true,
  };
  const back = parseStoredIdentity(record);
  if (back === undefined) throw new TypeError("not a voting identity this client stores");
  back.secret.fill(0);
  return record;
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
    value = await withStore<unknown>(factory, IDENTITY_DB, STORE, "readonly", (store) => {
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
    await withStore(factory, IDENTITY_DB, STORE, "readwrite", (store) => {
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
  const added = await addIdentity({ secret, memberships: [] }, factory);
  return added === "added" ? "created" : added;
}

/**
 * Keeps an identity recovered from its backup (`secret`, counted in the
 * Tier 0 group `group`) as this device's, marked recovered, on the same
 * terms as `createIdentity`: never over an identity the device holds,
 * readable or not (`exists`), which may be another registered identity
 * whose loss can't be undone (T-18).
 */
export async function restoreIdentity(
  secret: Uint8Array,
  group: bigint,
  factory: IDBFactory = indexedDB,
): Promise<"restored" | "exists" | "unwritable"> {
  const added = await addIdentity(
    { secret, memberships: [{ tier: 0, group }], recovered: true },
    factory,
  );
  return added === "added" ? "restored" : added;
}

/** Stores `identity` only if the device holds none; throws on one `parseStoredIdentity` would refuse. */
async function addIdentity(
  identity: VotingIdentity,
  factory: IDBFactory,
): Promise<"added" | "exists" | "unwritable"> {
  const record = storedIdentity(identity);
  try {
    // `add`, not `put`: in the same transaction as the check that the key is free.
    await withStore(factory, IDENTITY_DB, STORE, "readwrite", (store) => {
      store.add(record, KEY);
      return () => undefined;
    });
    return "added";
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
  return updateHeld(secret, factory, (held) =>
    held.memberships[0]?.tier === 0 ? undefined : { ...held, tier0Request: request },
  );
}

/**
 * Records that the identity whose secret is `secret` is registered at Tier
 * 0 in `group` ([[registration]], Outcome: its counted occurrence is in a
 * published group of the region it asked for), in place of the request it
 * waited on, in one transaction with the read that finds it still there and
 * still waiting. `changed` if the device now holds another identity, an
 * unreadable one, or one no longer waiting on a request, which is left as
 * it is; `unwritable` for storage the browser refuses.
 */
export async function recordTier0Membership(
  secret: Uint8Array,
  group: bigint,
  factory: IDBFactory = indexedDB,
): Promise<"recorded" | "changed" | "unwritable"> {
  const checked = storedIdentity({ secret, memberships: [{ tier: 0, group }] });
  (checked["secret"] as Uint8Array).fill(0);
  return updateHeld(secret, factory, ({ secret: held, memberships, tier0Request }) =>
    // A waiting identity has no Tier 0 membership (`parseStoredIdentity`),
    // so the new one goes first, in ascending order of tier.
    tier0Request === undefined
      ? undefined
      : { secret: held, memberships: [{ tier: 0, group }, ...memberships] },
  );
}

/**
 * Replaces the identity whose secret is `secret` with a newly made one
 * (`replacement`, in no group and waiting on no request), for a voter
 * whose Tier 0 request was moved to another region's group, confirmed
 * against a second L2 endpoint ([[registration]], Outcome: the client
 * registers again only under a new secret, since the commitment's place
 * can't be taken back; T-16). In one transaction with the read, and only
 * while the held identity still waits on a Tier 0 request and has no
 * membership in any tier: an identity counted
 * anywhere is never discarded here, since its loss can't be undone (T-18).
 * `changed` otherwise, with the store left as it is; `unwritable` for
 * storage the browser refuses.
 */
export async function replaceMovedIdentity(
  secret: Uint8Array,
  replacement: Uint8Array,
  factory: IDBFactory = indexedDB,
): Promise<"replaced" | "changed" | "unwritable"> {
  const checked = storedIdentity({ secret: replacement, memberships: [] });
  (checked["secret"] as Uint8Array).fill(0);
  // A replacement equal to the secret it replaces would keep the moved commitment.
  if (equalBytes(secret, replacement)) throw new TypeError("not a new voting identity");
  // A recovered identity never waits on a request (`parseStoredIdentity`).
  const replaced = await updateHeld(secret, factory, ({ memberships, tier0Request }) =>
    tier0Request === undefined || memberships.length > 0
      ? undefined
      : { secret: replacement, memberships: [] },
  );
  return replaced === "recorded" ? "replaced" : replaced;
}

/**
 * Replaces the stored identity with what `change` makes of it, in one
 * transaction with the read, only while it is readable and its secret is
 * `secret`; `change` returning `undefined` leaves it as it is (`changed`).
 */
async function updateHeld(
  secret: Uint8Array,
  factory: IDBFactory,
  change: (held: VotingIdentity) => VotingIdentity | undefined,
): Promise<"recorded" | "changed" | "unwritable"> {
  try {
    return await withStore(factory, IDENTITY_DB, STORE, "readwrite", (store) => {
      let outcome: "recorded" | "changed" = "changed";
      const get = store.get(KEY);
      get.onsuccess = () => {
        const value: unknown = get.result;
        const held = parseStoredIdentity(value);
        wipeStored(value);
        if (held === undefined) return;
        const changed = equalBytes(held.secret, secret) ? change(held) : undefined;
        if (changed !== undefined) {
          const record = storedIdentity(changed);
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

/**
 * The backup passkey this device made or last used
 * ([[0017-identity-recovery-backup]], Option A, steps 2 and 6). Its ID is
 * the one credential every later ceremony allows and the one a creation
 * excludes, so a device never makes a second backup passkey.
 */
export interface BackupCredential {
  /** The credential's ID, its `rawId`: 16 to 1,023 bytes (WebAuthn Level 3, Credential ID). */
  readonly credentialId: Uint8Array;
  /** Whether its authenticator data last showed it backed up (BS), so it outlives this authenticator. */
  readonly backedUp: boolean;
  /** When an envelope was last stored with it, in milliseconds by this device's clock; none until one is. */
  readonly storedAt?: number;
}

/** The backup credential, none, or a store this device couldn't open or a record it couldn't read. */
export type BackupCredentialRead =
  | { readonly kind: "found"; readonly credential: BackupCredential }
  | { readonly kind: "none" }
  | { readonly kind: "unreadable" };

const BACKUP_RECORD_VERSION = 1;
const MIN_CREDENTIAL_ID = 16;
const MAX_CREDENTIAL_ID = 1023;

/**
 * The backup credential a stored value holds, or `undefined` if it isn't
 * exactly a record this client writes: version 1, a credential ID of 16 to
 * 1,023 bytes, a boolean and a time (`null` for none). The ID is a copy.
 */
export function parseStoredBackupCredential(value: unknown): BackupCredential | undefined {
  if (!isRecord(value) || !hasExactly(value, ["v", "credentialId", "backedUp", "storedAt"]))
    return undefined;
  const { v, credentialId, backedUp, storedAt } = value;
  if (v !== BACKUP_RECORD_VERSION || typeof backedUp !== "boolean") return undefined;
  if (
    !(credentialId instanceof Uint8Array) ||
    credentialId.length < MIN_CREDENTIAL_ID ||
    credentialId.length > MAX_CREDENTIAL_ID
  )
    return undefined;
  if (storedAt === null) return { credentialId: credentialId.slice(), backedUp };
  if (typeof storedAt !== "number" || !Number.isSafeInteger(storedAt) || storedAt < 0)
    return undefined;
  if (Object.is(storedAt, -0)) return undefined;
  return { credentialId: credentialId.slice(), backedUp, storedAt };
}

/** The record `saveBackupCredential` stores; throws on one `parseStoredBackupCredential` would refuse. */
export function storedBackupCredential(credential: BackupCredential): Record<string, unknown> {
  const record = {
    v: BACKUP_RECORD_VERSION,
    credentialId: credential.credentialId.slice(),
    backedUp: credential.backedUp,
    storedAt: credential.storedAt ?? null,
  };
  if (parseStoredBackupCredential(record) === undefined)
    throw new TypeError("not a backup credential this client stores");
  return record;
}

/** The backup credential this device keeps, read afresh; storage the browser refuses is `unreadable`. */
export async function readBackupCredential(
  factory: IDBFactory = indexedDB,
): Promise<BackupCredentialRead> {
  let value: unknown;
  try {
    value = await withStore<unknown>(factory, IDENTITY_DB, STORE, "readonly", (store) => {
      const get = store.get(BACKUP_KEY);
      return () => get.result as unknown;
    });
  } catch {
    return { kind: "unreadable" };
  }
  if (value === undefined) return { kind: "none" };
  const credential = parseStoredBackupCredential(value);
  return credential === undefined ? { kind: "unreadable" } : { kind: "found", credential };
}

/** Keeps `credential` as this device's backup credential, replacing any other; resolves once committed. */
export async function saveBackupCredential(
  credential: BackupCredential,
  factory: IDBFactory = indexedDB,
): Promise<"saved" | "unwritable"> {
  const record = storedBackupCredential(credential);
  try {
    await withStore(factory, IDENTITY_DB, STORE, "readwrite", (store) => {
      store.put(record, BACKUP_KEY);
      return () => undefined;
    });
    return "saved";
  } catch {
    return "unwritable";
  }
}
