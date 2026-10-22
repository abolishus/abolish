// The Tier 0 token issuer ([[tier0-token]], Keys and Issuance;
// [[0039-tier0-token-issuance]]; P2-30 part 3a): an account verified by
// e-mail, and by phone where the deployment turns phone verification on
// ([[0038-verified-accounts]], Owner decision (2026-10-22)), takes one token
// per deployment, for the group of one region, by
// sending a blinded element `B` under the current period's key; the issuer
// records the account's token and answers RFC 9497's `BlindEvaluate`, which
// the ballot client finalises against the key its release publishes. The
// POPRF steps are packages/crypto's (src/tier0-token.ts); this module holds
// the keys, the account's record and the checks around them.
//
// T-10: the record is on the account's side of the no-join tests and holds
// `B`, which is perfectly hiding, never `C`, the token or `blind`. T-11,
// T-13: no record keeps a time. T-01: one token per account and deployment,
// by an atomic insert-if-absent. T-74: issued tokens are counted per key and
// group, with no account, so redemptions beyond them show a stolen key.

import {
  DecodeError,
  decodeDeploymentRecord,
  decodeTier0TokenBlindedElement,
  deploymentRecordRule,
  Tier0TokenError,
  type Tier0TokenEvaluation,
  tier0TokenBlindEvaluate,
  tier0TokenInfo,
  tier0TokenKeyId,
  tier0TokenKeyIssues,
  tier0TokenKeyPeriod,
  tier0TokenKeyRedeems,
  tier0TokenPublicKey,
} from "@abolishus/crypto";
import { and, eq, lt, sql as q } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import {
  accountEmails,
  accountPhones,
  accountUsers,
  accountTokens,
  tier0TokenIssuances,
} from "./db/schema/index.ts";

const U32_MAX = 2 ** 32 - 1;
const U64_MAX = (1n << 64n) - 1n;

/** One period's issuer key, with its public key and identifier. */
export interface Tier0IssuerKey {
  readonly period: number;
  readonly secretKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly keyId: Uint8Array;
}

export interface Tier0IssuerKeys {
  /** Every key held, by period ascending. */
  readonly keys: readonly Tier0IssuerKey[];
  /** The key with this identifier, if held. */
  byKeyId(keyId: Uint8Array): Tier0IssuerKey | undefined;
}

const KEY_ENTRY = /^(0|[1-9][0-9]{0,9}):([0-9a-f]{64})$/;

/**
 * Parses the issuer's keys from their text form, `period:hex,…`, each `hex`
 * the 32-byte encoding of a period's `skS` ([[tier0-token]], Keys), held in
 * the issuer's environment apart from every other secret (T-74). Refuses
 * anything but distinct periods with non-zero canonical scalars. Errors name
 * the entry's position, never its text, since that text is the key.
 */
export function parseTier0IssuerKeys(text: string): Tier0IssuerKeys {
  const keys: Tier0IssuerKey[] = [];
  const periods = new Set<number>();
  for (const [i, entry] of text.split(",").entries()) {
    const m = KEY_ENTRY.exec(entry);
    if (m === null || Number(m[1]) > U32_MAX)
      throw new Error(`issuer key entry ${i + 1} is not period:64-hex`);
    const period = Number(m[1]);
    if (periods.has(period)) throw new Error(`issuer key entry ${i + 1} repeats a period`);
    periods.add(period);
    // Decoded straight into its own array, never through Buffer's shared
    // pool, which would keep a copy beside unrelated data.
    const secretKey = Uint8Array.from(m[2]!.match(/../g)!, (h) => parseInt(h, 16));
    let publicKey: Uint8Array;
    try {
      publicKey = tier0TokenPublicKey(secretKey);
    } catch {
      throw new Error(`issuer key entry ${i + 1} is not a non-zero scalar below l`);
    }
    const key = { period, publicKey, keyId: tier0TokenKeyId(period, publicKey) };
    // Not enumerable, so a log line, `util.inspect` or `JSON.stringify` of
    // the issuer never prints `skS` (T-74).
    Object.defineProperty(key, "secretKey", { value: secretKey, enumerable: false });
    keys.push(key as Tier0IssuerKey);
  }
  keys.sort((a, b) => a.period - b.period);
  const byId = new Map(keys.map((k) => [Buffer.from(k.keyId).toString("hex"), k]));
  return { keys, byKeyId: (keyId) => byId.get(Buffer.from(keyId).toString("hex")) };
}

/** The issuer's keys and the deployment's published Tier 0 groups. */
export interface Tier0Issuer {
  readonly keys: Tier0IssuerKeys;
  /** The L2's chain ID, from the deployment record. */
  readonly chainId: bigint;
  /** The group registry's 20-byte address, from the deployment record. */
  readonly groupRegistry: Uint8Array;
  /** Each region served and its group's `info` (Group info). */
  readonly infos: ReadonlyMap<number, Uint8Array>;
  /** Whether an account also needs a verified phone to take a token. */
  readonly phoneVerification: boolean;
}

export interface Tier0IssuerOptions {
  readonly keys: Tier0IssuerKeys;
  readonly chainId: bigint;
  readonly groupRegistry: Uint8Array;
  /** Each region code served and its one Tier 0 group's `group_id`, as the deployment record lists them. */
  readonly groups: ReadonlyMap<number, bigint>;
  /** When the issuer is loaded. */
  readonly now: Date;
  /**
   * The deployment's phone verification setting: on, an account takes a
   * token only once verified by e-mail and by phone; off, by e-mail alone
   * ([[0038-verified-accounts]], Owner decision (2026-10-22)). Required, so no
   * caller turns it off by leaving it out.
   */
  readonly phoneVerification: boolean;
}

/**
 * Checks the deployment's values and computes each region's `info`. Refuses
 * a key whose redemption window (`q + 1`) has ended: its `skS` should have
 * been destroyed then ([[tier0-token]], Keys), and an environment still
 * carrying it is one nobody rotated (T-74). A key that ends while the issuer
 * runs is refused by issuance itself.
 */
export function tier0Issuer({
  keys,
  chainId,
  groupRegistry,
  groups,
  now,
  phoneVerification,
}: Tier0IssuerOptions): Tier0Issuer {
  const current = tier0TokenKeyPeriod(Math.floor(now.getTime() / 1000));
  for (const key of keys.keys)
    if (key.period < current - 1)
      throw new RangeError(`the issuer key of period ${key.period} no longer redeems`);
  if (typeof phoneVerification !== "boolean")
    throw new TypeError("phoneVerification must be a boolean");
  if (typeof chainId !== "bigint" || chainId < 0n || chainId > U64_MAX)
    throw new RangeError("chainId must be a u64");
  if (!(groupRegistry instanceof Uint8Array) || groupRegistry.length !== 20)
    throw new RangeError("groupRegistry must be 20 bytes");
  // As the registration route (tier0-registration.ts): until the group
  // registry records a region per group (ADR 0019), region 0 only, with one
  // group, so an account can't take a token per region (T-16).
  if (groups.size !== 1 || !groups.has(0))
    throw new RangeError("groups must publish exactly one group, for region 0");
  const registry = Uint8Array.from(groupRegistry);
  const infos = new Map<number, Uint8Array>();
  for (const [region, groupId] of groups) {
    if (typeof groupId !== "bigint" || groupId < 0n || groupId > U64_MAX)
      throw new RangeError("a group_id must be a u64");
    infos.set(region, tier0TokenInfo({ chainId, groupRegistry: registry, groupId }));
  }
  return { keys, chainId, groupRegistry: registry, infos, phoneVerification };
}

/**
 * Refuses an issuer that disagrees with the deployment record its release
 * names (`encoding`, record `0x0020`; [[deployment]], Record (version 2)):
 * a record that isn't a well-formed version 2, another L2 or group registry,
 * a region whose group isn't the record's signed Tier 0 group there, or a
 * held key the record doesn't list for its period, lists under another
 * `pkS`, or lists retired. A client finalises only under the keys its
 * release lists, so an answer under any other key is one no client takes,
 * and a key retired early stops issuing at the next start with the record
 * that retires it (T-74).
 * Keys the record lists and the issuer doesn't hold are left alone: a
 * period's key may be loaded only when it is near. Errors name a period or
 * a rule, never a key, though only public keys are compared here.
 */
export function checkTier0IssuerDeployment(issuer: Tier0Issuer, encoding: Uint8Array): void {
  let record;
  try {
    record = decodeDeploymentRecord(encoding);
  } catch (e) {
    if (e instanceof DecodeError)
      throw new RangeError(`the deployment record doesn't decode: ${e.code}`);
    throw e;
  }
  if (record.version !== 2)
    throw new RangeError("the deployment record is version 1, which lists no token key");
  const fault = deploymentRecordRule(record);
  if (fault !== undefined)
    throw new RangeError(`the deployment record is ill formed: ${fault.rule}`);
  const d = record.value;
  if (d.l2_chain_id !== issuer.chainId)
    throw new RangeError("the deployment record names another L2 chain ID");
  if (!sameBytes(d.group_registry, issuer.groupRegistry))
    throw new RangeError("the deployment record names another group registry");
  for (const [region, info] of issuer.infos)
    if (
      !d.groups.some(
        (g) =>
          g.tier === 0 &&
          !g.self_paid &&
          g.region === region &&
          sameBytes(
            tier0TokenInfo({
              chainId: d.l2_chain_id,
              groupRegistry: d.group_registry,
              groupId: g.group_id,
            }),
            info,
          ),
      )
    )
      throw new RangeError(
        `region ${region}'s group isn't the deployment record's signed Tier 0 group there`,
      );
  const listed = new Map(d.tier0_token_keys.map((k) => [k.period, k]));
  for (const key of issuer.keys.keys) {
    const entry = listed.get(key.period);
    if (entry === undefined)
      throw new RangeError(`the deployment record lists no key for period ${key.period}`);
    if (!sameBytes(entry.key, key.publicKey))
      throw new RangeError(`the issuer key of period ${key.period} isn't the deployment record's`);
    if (entry.retired)
      throw new RangeError(`the deployment record lists the key of period ${key.period} retired`);
  }
}

/** The codes of [[tier0-token]], Errors, that issuance answers. */
export type Tier0IssuanceErrorCode =
  /** Step 2.1: the account may not take a token. */
  | "account"
  /** Step 2.2: the key named doesn't issue now and the request isn't a retry. */
  | "key-not-issuing"
  /** Step 2.3: the region has no published group. */
  | "region-unknown"
  /** Step 2.4: `B` isn't 32 bytes encoding an element other than the identity. */
  | "blinded-element"
  /** Step 2.5: the account has its token and this isn't a retry of it. */
  | "token-taken"
  /** Step 4: `skS + m = 0` for this group's `info`. */
  | "inverse";

export class Tier0IssuanceError extends Error {
  override readonly name = "Tier0IssuanceError";
  readonly code: Tier0IssuanceErrorCode;
  constructor(code: Tier0IssuanceErrorCode) {
    // The message never quotes the request.
    super(`token refused: ${code}`);
    this.code = code;
  }
}

/** What the client sends (Issuance, step 1), after the transport's form checks. */
export interface Tier0IssuanceRequest {
  readonly keyId: Uint8Array;
  readonly region: number;
  readonly blindedElement: Uint8Array;
}

/** An account ID as `newAccountId` makes them. */
const ACCOUNT_ID = /^[a-z0-9]{32}$/;

const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

type Tx = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

/**
 * Whether `accountId` may take a token (step 2.1): verified by e-mail, and by
 * phone when `phoneVerification` is on ([[0038-verified-accounts]]). Each row
 * read is locked for the rest of the transaction, so a number moved to
 * another account, or an address changed, can't leave between this check and
 * the record (T-01). With the setting off no phone row is read: an account
 * holding one is treated as one that doesn't, so turning the setting on later
 * makes every account hold a verified number before its next token. The
 * account's own row is locked first, in the order its deletion's cascade
 * takes them, so an account deleted mid-request is refused here rather than
 * deadlocking with the record's reference to it.
 */
async function mayTakeToken(
  tx: Tx,
  accountId: string,
  phoneVerification: boolean,
): Promise<boolean> {
  const user = await tx
    .select({ id: accountUsers.id })
    .from(accountUsers)
    .where(eq(accountUsers.id, accountId))
    .for("key share");
  if (user.length !== 1) return false;
  const email = await tx
    .select({ userId: accountEmails.userId })
    .from(accountEmails)
    .where(eq(accountEmails.userId, accountId))
    .for("share");
  if (email.length !== 1) return false;
  if (!phoneVerification) return true;
  const phone = await tx
    .select({ userId: accountPhones.userId })
    .from(accountPhones)
    .where(eq(accountPhones.userId, accountId))
    .for("share");
  return phone.length === 1;
}

/**
 * Issuance, steps 2 to 4, for the signed-in `accountId`: checks the request
 * in the spec's order, records the account's token (or recognises a retry of
 * it: the same region, key and `B`, while the key still redeems) and answers
 * `Z` and its proof under the key `keyId` names. Every check, the record and
 * the count run in one transaction with the evaluation, so the account's
 * verification holds until the record is written, and a refused or failed
 * evaluation (`inverse`) leaves neither. Throws `Tier0IssuanceError` for the
 * first failed check.
 */
export async function issueTier0Token(
  client: Sql,
  accountId: string,
  request: Tier0IssuanceRequest,
  { issuer, now }: { readonly issuer: Tier0Issuer; readonly now: Date },
): Promise<Tier0TokenEvaluation> {
  if (!ACCOUNT_ID.test(accountId)) throw new RangeError("not an account ID");
  const seconds = Math.floor(now.getTime() / 1000);
  const deployment = and(
    eq(accountTokens.userId, accountId),
    eq(accountTokens.chainId, issuer.chainId),
    eq(accountTokens.groupRegistry, issuer.groupRegistry),
  );

  return drizzle({ client }).transaction(async (tx) => {
    if (!(await mayTakeToken(tx, accountId, issuer.phoneVerification)))
      throw new Tier0IssuanceError("account");

    const key =
      request.keyId instanceof Uint8Array && request.keyId.length === 32
        ? issuer.keys.byKeyId(request.keyId)
        : undefined;
    // A key that issues now, or one that still redeems, for a retry (step 2.2).
    if (key === undefined || !tier0TokenKeyRedeems(key.period, seconds))
      throw new Tier0IssuanceError("key-not-issuing");
    const issues = tier0TokenKeyIssues(key.period, seconds);
    // A key that only redeems now serves a retry of the token recorded under
    // it, and nothing else, before the region and `B` are looked at (step
    // 2.2); step 2.5 then checks the rest of the retry.
    if (!issues) {
      const [held] = await tx
        .select({ keyId: accountTokens.keyId })
        .from(accountTokens)
        .where(deployment);
      if (held?.keyId == null || !sameBytes(held.keyId, key.keyId))
        throw new Tier0IssuanceError("key-not-issuing");
    }

    const info = Number.isSafeInteger(request.region)
      ? issuer.infos.get(request.region)
      : undefined;
    if (info === undefined) throw new Tier0IssuanceError("region-unknown");

    let blindedElement: Uint8Array;
    try {
      blindedElement = decodeTier0TokenBlindedElement(request.blindedElement);
    } catch (e) {
      if (e instanceof Tier0TokenError || e instanceof TypeError || e instanceof RangeError)
        throw new Tier0IssuanceError("blinded-element");
      throw e;
    }

    const evaluate = () => {
      try {
        return tier0TokenBlindEvaluate(key.secretKey, blindedElement, info);
      } catch (e) {
        // Thrown inside the transaction, so the record and count it wrote go
        // with it: no token under this key for this group (step 4). Only a
        // first issuance can reach this, since `inverse` depends on the key
        // and `info` alone, so no retry of a recorded token can.
        if (e instanceof Tier0TokenError && e.code === "inverse")
          throw new Tier0IssuanceError("inverse");
        throw e;
      }
    };

    if (issues) {
      // Step 3: insert-if-absent on the account and deployment, so of two
      // concurrent first requests with different `B` only one is recorded
      // (T-01).
      const inserted = await tx
        .insert(accountTokens)
        .values({
          userId: accountId,
          chainId: issuer.chainId,
          groupRegistry: issuer.groupRegistry,
          region: request.region,
          keyId: key.keyId,
          keyPeriod: key.period,
          blindedElement,
        })
        .onConflictDoNothing()
        .returning({ userId: accountTokens.userId });
      if (inserted.length === 1) {
        await tx
          .insert(tier0TokenIssuances)
          .values({ keyId: key.keyId, info, issued: 1 })
          .onConflictDoUpdate({
            target: [tier0TokenIssuances.keyId, tier0TokenIssuances.info],
            set: { issued: q`${tier0TokenIssuances.issued} + 1` },
          });
        return evaluate();
      }
    }
    // Step 2.5: anything but the recorded request again is refused, so a
    // lost or corrupted answer is retried and nothing else. A dead record
    // (no key) matches no request; another region is a move, refused until
    // P2-30 part 3 defines one.
    const [held] = await tx.select().from(accountTokens).where(deployment);
    const retry =
      held !== undefined &&
      held.region === request.region &&
      held.keyId !== null &&
      sameBytes(held.keyId, key.keyId) &&
      sameBytes(held.blindedElement, blindedElement);
    if (!retry) throw new Tier0IssuanceError(issues ? "token-taken" : "key-not-issuing");
    return evaluate();
  });
}

/**
 * Marks dead every record whose key's period `q` ended its redemption window
 * (`q + 1`) before `now`'s period, clearing `key_id` and its period together
 * so the record keeps no period ([[tier0-token]], Issuance, step 3). Keyed on
 * the stored period and the clock alone, never on which keys this instance
 * holds, so an instance missing a key can't mark a live token dead. Returns
 * how many it marked. apps/web's account prune runs it on its timer (P2-30 part 3b).
 */
export async function markDeadTier0Tokens(client: Sql, now: Date): Promise<number> {
  const current = tier0TokenKeyPeriod(Math.floor(now.getTime() / 1000));
  const marked = await drizzle({ client })
    .update(accountTokens)
    .set({ keyId: null, keyPeriod: null })
    .where(lt(accountTokens.keyPeriod, current - 1))
    .returning({ userId: accountTokens.userId });
  return marked.length;
}
