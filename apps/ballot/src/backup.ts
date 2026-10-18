// The voting identity's backup ([[0017-identity-recovery-backup]], Option
// A; [[identity-backup]]): the WebAuthn ceremonies that make the backup
// passkey and evaluate its PRF, what the client checks of their answers, the
// request that stores the envelope, and a backup's steps in order. The PRF
// output exists on the page only between a ceremony and the worker's seal,
// and the secret only while it is copied to the worker; the page zeroes both
// once they are sent (T-41). Nothing here names the voter: the passkey's
// user handle is random, its name a fixed label, and the request carries no
// cookie, referrer or credential (T-10, T-20).

import { identityBackupPrfSalt } from "@abolishus/crypto";

import { readJson } from "./answer.ts";
import type { Deployment } from "./deployment.ts";
import type { BackupCredential, BackupCredentialRead, IdentityRead } from "./identity.ts";
import type { Fetch } from "./load.ts";
import type { BackupSealResult } from "./worker/protocol.ts";

/**
 * The backup passkey's user name and display name: one fixed label for every
 * voter, never an account identifier or anything the voter types, so the
 * credential names no one, in the passkey provider's vault or anywhere else
 * (Option A, step 2).
 */
export const BACKUP_USER_NAME = "Abolish voting identity backup";

/** The relying party's name, which the browser's prompt may show beside the RP ID. */
const RP_NAME = "Abolish ballot";

// Bytes in a ceremony's challenge and in the passkey's user handle. No
// server checks a signature from this passkey, only its PRF is used, so the
// challenge only needs to be fresh.
const CHALLENGE_LEN = 32;
const USER_HANDLE_LEN = 32;
const PRF_LEN = 32;

/**
 * How long a ceremony may take: WebAuthn Level 3's recommended range for one
 * that requires user verification tops out at 10 minutes, and five gives a
 * voter time to unlock a phone or find a security key.
 */
const TIMEOUT_MS = 300_000;

// ES256, EdDSA and RS256 (COSE algorithm identifiers), so any authenticator
// can make the passkey; its signatures are never checked, so the choice
// carries no security weight.
const ALGORITHMS: PublicKeyCredentialParameters[] = [
  { type: "public-key", alg: -7 },
  { type: "public-key", alg: -8 },
  { type: "public-key", alg: -257 },
];

// A copy whose buffer is an ArrayBuffer, as WebAuthn's dictionaries take.
const prfSalt = () => new Uint8Array(identityBackupPrfSalt());

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/**
 * The options of the ceremony that makes the backup passkey (Option A, step
 * 2): a discoverable credential of `rpId`, so a new device finds it with
 * nothing but the synced passkey; user verification required, so backup and
 * recovery evaluate the same PRF secret; no attestation; and the PRF
 * evaluated with the fixed salt, which some authenticators answer at
 * creation ([[identity-backup]], PRF salt).
 */
export function backupCreationOptions(
  rpId: string,
  userHandle: Uint8Array,
  challenge: Uint8Array,
): CredentialCreationOptions {
  return {
    publicKey: {
      rp: { id: rpId, name: RP_NAME },
      user: {
        id: new Uint8Array(userHandle),
        name: BACKUP_USER_NAME,
        displayName: BACKUP_USER_NAME,
      },
      challenge: new Uint8Array(challenge),
      pubKeyCredParams: ALGORITHMS,
      timeout: TIMEOUT_MS,
      authenticatorSelection: {
        residentKey: "required",
        requireResidentKey: true,
        userVerification: "required",
      },
      attestation: "none",
      extensions: { prf: { eval: { first: prfSalt() } } },
    },
  };
}

/**
 * The options of a ceremony that evaluates the backup passkey's PRF with
 * the fixed salt and user verification: for `allow`, the one credential this
 * device keeps, or, with none, any discoverable credential of `rpId`, as a
 * recovery asks (Option A, step 6).
 */
export function backupRequestOptions(
  rpId: string,
  challenge: Uint8Array,
  allow: Uint8Array | undefined,
): CredentialRequestOptions {
  return {
    publicKey: {
      rpId,
      challenge: new Uint8Array(challenge),
      timeout: TIMEOUT_MS,
      userVerification: "required",
      allowCredentials:
        allow === undefined ? [] : [{ type: "public-key", id: new Uint8Array(allow) }],
      extensions: { prf: { eval: { first: prfSalt() } } },
    },
  };
}

/** The flags of a ceremony's authenticator data the client acts on. */
export interface AuthenticatorFlags {
  /** User verified (UV): without it the PRF came from the other secret, and is refused. */
  readonly uv: boolean;
  /** Backup eligible (BE): the credential can sync. */
  readonly be: boolean;
  /** Backed up (BS): the credential is synced now, so it outlives this authenticator. */
  readonly bs: boolean;
}

// The flags byte follows the 32-byte RP ID hash, and the 4-byte signature
// counter follows it (WebAuthn Level 3, Authenticator Data).
const FLAGS_AT = 32;
const MIN_AUTHENTICATOR_DATA = 37;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;

/**
 * The flags of authenticator data `data`, or `undefined` if it is too short
 * to hold them or sets BS without BE, which WebAuthn Level 3 calls invalid.
 */
export function authenticatorFlags(data: Uint8Array): AuthenticatorFlags | undefined {
  if (data.length < MIN_AUTHENTICATOR_DATA) return undefined;
  const flags = data[FLAGS_AT] as number;
  const be = (flags & BE) !== 0;
  const bs = (flags & BS) !== 0;
  if (bs && !be) return undefined;
  return { uv: (flags & UV) !== 0, be, bs };
}

/**
 * Why a ceremony gave no PRF output: the voter cancelled it or let it time
 * out, which the browser reports alike (`cancelled`); the authenticator
 * doesn't support the PRF (`no-prf`); it didn't verify the voter (`no-uv`);
 * or anything else, including an answer outside WebAuthn's forms (`failed`).
 */
export type PasskeyProblem = "cancelled" | "no-prf" | "no-uv" | "failed";

/** A ceremony's answer as the client keeps it. */
export interface Passkey {
  /** The credential's `rawId`. */
  readonly credentialId: Uint8Array;
  readonly flags: AuthenticatorFlags;
}

/**
 * A new backup passkey, with its PRF output if the authenticator answered
 * it at creation (zero it once used), or why there is none.
 */
export type CreatedPasskey =
  | (Passkey & { readonly ok: true; readonly prf: Uint8Array | undefined })
  | { readonly ok: false; readonly problem: PasskeyProblem };

/** The backup passkey's PRF output (zero it once used), or why there is none. */
export type EvaluatedPasskey =
  | (Passkey & { readonly ok: true; readonly prf: Uint8Array })
  | { readonly ok: false; readonly problem: PasskeyProblem };

/** The ceremonies, as the browser's `navigator.credentials` offers them; injected so tests need no authenticator. */
export type Credentials = Pick<CredentialsContainer, "create" | "get">;

/** The problem a ceremony that threw reports. */
function thrown(error: unknown): PasskeyProblem {
  return error instanceof DOMException && error.name === "NotAllowedError" ? "cancelled" : "failed";
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** A copy of `x` if it is an `ArrayBuffer` or a view of one, else `undefined`. */
function bytesOf(x: unknown): Uint8Array | undefined {
  if (x instanceof ArrayBuffer) return new Uint8Array(x).slice();
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength).slice();
  return undefined;
}

/** Zeroes the bytes `x` holds, if it is an `ArrayBuffer` or a view of one. */
function wipe(x: unknown): void {
  if (x instanceof ArrayBuffer) new Uint8Array(x).fill(0);
  else if (ArrayBuffer.isView(x)) new Uint8Array(x.buffer, x.byteOffset, x.byteLength).fill(0);
}

/**
 * What a ceremony's credential gives, read structurally so a stand-in can
 * play it: its ID, its flags, and the PRF's `results.first` if any, copied,
 * with the browser's copy zeroed whatever else is wrong. `undefined` for an
 * answer outside WebAuthn's forms, or a PRF result that isn't exactly 32
 * bytes, which the client never uses ([[identity-backup]], PRF salt).
 */
function readCredential(
  credential: unknown,
  authenticatorData: (response: Record<string, unknown>) => unknown,
):
  | {
      readonly credentialId: Uint8Array;
      readonly flags: AuthenticatorFlags;
      readonly prfEnabled: boolean;
      readonly prf: Uint8Array | undefined;
    }
  | undefined {
  if (!isRecord(credential) || credential["type"] !== "public-key") return undefined;
  const { rawId, response, getClientExtensionResults } = credential;
  if (typeof getClientExtensionResults !== "function") return undefined;
  let results: unknown;
  try {
    results = (getClientExtensionResults as () => unknown).call(credential);
  } catch {
    return undefined;
  }
  const prfResults = isRecord(results) && isRecord(results["prf"]) ? results["prf"] : undefined;
  const first =
    prfResults !== undefined && isRecord(prfResults["results"])
      ? prfResults["results"]["first"]
      : undefined;
  const prf = bytesOf(first);
  wipe(first);
  const credentialId = bytesOf(rawId);
  let data: Uint8Array | undefined;
  try {
    data = isRecord(response) ? bytesOf(authenticatorData(response)) : undefined;
  } catch {
    data = undefined;
  }
  const flags = data === undefined ? undefined : authenticatorFlags(data);
  if (
    credentialId === undefined ||
    flags === undefined ||
    (first !== undefined && prf?.length !== PRF_LEN)
  ) {
    prf?.fill(0);
    return undefined;
  }
  return { credentialId, flags, prfEnabled: prfResults?.["enabled"] === true, prf };
}

/**
 * Makes the backup passkey (Option A, step 2). The caller keeps its ID at
 * once (`saveBackupCredential`), before anything else can fail, so this
 * device never makes a second one. A passkey that can't serve as a backup
 * (no PRF, no user verification) is reported, not kept.
 */
export async function createBackupPasskey(
  credentials: Credentials,
  rpId: string,
): Promise<CreatedPasskey> {
  let credential: unknown;
  try {
    credential = await credentials.create(
      backupCreationOptions(rpId, random(USER_HANDLE_LEN), random(CHALLENGE_LEN)),
    );
  } catch (error) {
    return { ok: false, problem: thrown(error) };
  }
  const read = readCredential(credential, (response) =>
    typeof response["getAuthenticatorData"] === "function"
      ? (response["getAuthenticatorData"] as () => unknown).call(response)
      : undefined,
  );
  if (read === undefined) return { ok: false, problem: "failed" };
  const { credentialId, flags, prf } = read;
  // An authenticator that answers no PRF at creation may still support it
  // (`enabled`), and is asked again by an evaluation.
  if (prf === undefined && !read.prfEnabled) return { ok: false, problem: "no-prf" };
  if (!flags.uv) {
    prf?.fill(0);
    return { ok: false, problem: "no-uv" };
  }
  return { ok: true, credentialId, flags, prf };
}

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Evaluates the backup passkey's PRF with the fixed salt and user
 * verification ([[identity-backup]], PRF salt): `allow`'s credential, which
 * the answer must be, or any discoverable one of `rpId` with none.
 */
export async function evaluateBackupPasskey(
  credentials: Credentials,
  rpId: string,
  allow: Uint8Array | undefined,
): Promise<EvaluatedPasskey> {
  let credential: unknown;
  try {
    credential = await credentials.get(backupRequestOptions(rpId, random(CHALLENGE_LEN), allow));
  } catch (error) {
    return { ok: false, problem: thrown(error) };
  }
  const read = readCredential(credential, (response) => response["authenticatorData"]);
  if (read === undefined) return { ok: false, problem: "failed" };
  const { credentialId, flags, prf } = read;
  if (allow !== undefined && !equalBytes(credentialId, allow)) {
    prf?.fill(0);
    return { ok: false, problem: "failed" };
  }
  if (prf === undefined) return { ok: false, problem: "no-prf" };
  if (!flags.uv) {
    prf.fill(0);
    return { ok: false, problem: "no-uv" };
  }
  return { ok: true, credentialId, flags, prf };
}

/**
 * What the backup route answered: stored; refused, which this client's
 * envelopes never are (`rejected`); or not reached, or an answer that isn't
 * the route's (`unreachable`).
 */
export type BackupPutAnswer = "stored" | "rejected" | "unreachable";

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Stores `envelope` under `locator` through the API's backup route
 * (`backups.put`): both in the body as lowercase hex, so the locator, which
 * lets its holder replace or delete the envelope, sits in no URL. Like every
 * request the client makes, it carries no cookie, referrer or credential,
 * which the route would refuse (T-10), and follows no redirect.
 */
export async function putIdentityBackup(
  deployment: Pick<Deployment, "api">,
  locator: Uint8Array,
  envelope: Uint8Array,
  fetchFn: Fetch,
): Promise<BackupPutAnswer> {
  let response: Response;
  try {
    response = await fetchFn(`${deployment.api}/backups`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locator: toHex(locator), envelope: toHex(envelope) }),
    });
  } catch {
    return "unreachable";
  }
  const answer = await readJson(response);
  const code = isRecord(answer) && !Array.isArray(answer) ? answer["code"] : undefined;
  if (response.status === 200)
    return isRecord(answer) && !Array.isArray(answer) && Object.keys(answer).length === 0
      ? "stored"
      : "unreachable";
  // The route's own refusals, in its own shape only: anything else is an
  // edge's or a proxy's page, and is read as unreachable.
  if (response.status === 422 && code === "BACKUP_REJECTED") return "rejected";
  if (response.status === 400 && code === "BAD_REQUEST") return "rejected";
  return "unreachable";
}

/** What a backup needs; injected so tests and stories need no authenticator, store, worker or network. */
export interface BackupSteps {
  /** The ceremonies (`navigator.credentials`). */
  readonly credentials: Credentials;
  /** The deployment's backup RP ID (`Deployment.backupRpId`). */
  readonly rpId: string;
  /** The voting identity this device holds (`readIdentity`), read afresh. */
  identity(): Promise<IdentityRead>;
  /** The backup credential this device keeps (`readBackupCredential`). */
  credential(): Promise<BackupCredentialRead>;
  /** Keeps `credential` as this device's (`saveBackupCredential`). */
  keep(credential: BackupCredential): Promise<"saved" | "unwritable">;
  /**
   * The worker's seal of `secret` for the PRF output `prf`
   * (`BallotWorker.backupSeal`); rejects if the worker fails. Both are
   * copied to the worker before this returns, so the caller zeroes its own.
   */
  seal(prf: Uint8Array, secret: Uint8Array): Promise<BackupSealResult>;
  /** The envelope stored under `locator` (`putIdentityBackup`). */
  put(locator: Uint8Array, envelope: Uint8Array): Promise<BackupPutAnswer>;
  /** This device's clock, in milliseconds since the UNIX epoch. */
  now(): number;
}

/**
 * Why a backup stopped: no identity to back up, or one or a backup
 * credential that couldn't be read (`unreadable`); a new passkey's ID the
 * browser refused to keep (`unwritable`); a ceremony's problem; the worker
 * failed; or the route's answer.
 */
export type BackupProblem =
  | "no-identity"
  | "unreadable"
  | "unwritable"
  | PasskeyProblem
  | "worker-failed"
  | Exclude<BackupPutAnswer, "stored">;

/**
 * A backup's outcome: stored, and whether the passkey is backed up by its
 * provider, so it outlives this authenticator (if not, the voter is told;
 * Option A, step 2); or why it stopped.
 */
export type BackupOutcome =
  | { readonly kind: "stored"; readonly survives: boolean }
  | { readonly kind: "stopped"; readonly problem: BackupProblem };

const stopped = (problem: BackupProblem): BackupOutcome => ({ kind: "stopped", problem });

/** The identity's absence or unreadability as a backup's problem. */
const missing = (read: Exclude<IdentityRead, { kind: "found" }>): BackupProblem =>
  read.kind === "none" ? "no-identity" : "unreadable";

/**
 * Backs up the identity this device holds ([[identity-backup]], Sealing):
 * the PRF from the backup passkey this device keeps, or from a new one,
 * kept first; the identity read afresh and sealed in the worker; the
 * envelope stored under its locator; and the passkey's record updated with
 * whether its provider has backed it up, checked anew on every use, and when
 * the envelope was stored. Run again, it replaces the stored envelope with a
 * new seal, which is how a backup is kept past the route's retention.
 */
export async function backUp(steps: BackupSteps): Promise<BackupOutcome> {
  const held = await steps.credential();
  if (held.kind === "unreadable") return stopped("unreadable");
  // Checked before any ceremony, so no passkey is made for nothing to back up.
  const first = await steps.identity();
  if (first.kind !== "found") return stopped(missing(first));
  first.identity.secret.fill(0);
  let passkey: EvaluatedPasskey;
  if (held.kind === "found") {
    passkey = await evaluateBackupPasskey(
      steps.credentials,
      steps.rpId,
      held.credential.credentialId,
    );
  } else {
    const created = await createBackupPasskey(steps.credentials, steps.rpId);
    if (!created.ok) return stopped(created.problem);
    const kept = await steps.keep({
      credentialId: created.credentialId,
      backedUp: created.flags.bs,
    });
    if (kept === "unwritable") {
      created.prf?.fill(0);
      return stopped("unwritable");
    }
    passkey =
      created.prf === undefined
        ? await evaluateBackupPasskey(steps.credentials, steps.rpId, created.credentialId)
        : { ...created, prf: created.prf };
  }
  if (!passkey.ok) return stopped(passkey.problem);
  const { credentialId, flags, prf } = passkey;
  let sealed: BackupSealResult;
  try {
    const read = await steps.identity();
    if (read.kind !== "found") return stopped(missing(read));
    const { secret } = read.identity;
    try {
      sealed = await steps.seal(prf, secret);
    } catch {
      return stopped("worker-failed");
    } finally {
      secret.fill(0);
    }
  } finally {
    prf.fill(0);
  }
  // The store checks the secret on every read, so the worker never refuses it.
  if (!sealed.ok) return stopped("unreadable");
  const answer = await steps.put(sealed.locator, sealed.envelope);
  sealed.locator.fill(0);
  if (answer !== "stored") return stopped(answer);
  // The envelope is stored whether or not this is kept: a record that
  // couldn't be updated only shows an older time and flag.
  await steps.keep({ credentialId, backedUp: flags.bs, storedAt: steps.now() });
  return { kind: "stored", survives: flags.bs };
}
