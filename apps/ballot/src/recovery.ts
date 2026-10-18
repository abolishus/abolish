// Recovering the voting identity on a new device
// ([[0017-identity-recovery-backup]], Option A, step 6; [[identity-backup]],
// Opening): any discoverable backup passkey of the deployment's RP ID,
// evaluated with the fixed salt and user verification; the envelope fetched
// under the locator the worker derives; and the worker's open, which gives
// the secret back only once its commitment is counted in a published Tier 0
// group, read from the group registry's whole log rather than asked of a
// server (T-11, T-18). The PRF output exists on the page only between the
// ceremony and the worker's locator, and the secret only between the open
// and the store (T-41). An identity the device already holds is never
// replaced.

import {
  type BackupFetchAnswer,
  type Credentials,
  evaluateBackupPasskey,
  type PasskeyProblem,
} from "./backup.ts";
import type { BackupCredential, IdentityRead } from "./identity.ts";
import type { LoadedRegistry, LoadProblem } from "./load.ts";
import type { ReadRegistry } from "./register.tsx";
import type { BackupLocatorResult, BackupOpenResult } from "./worker/protocol.ts";

/** What a recovery needs; injected so tests and stories need no authenticator, store, worker or network. */
export interface RecoverySteps {
  /** The ceremonies (`navigator.credentials`). */
  readonly credentials: Credentials;
  /** The deployment's backup RP ID (`Deployment.backupRpId`). */
  readonly rpId: string;
  /** The voting identity this device holds (`readIdentity`), read afresh. */
  identity(): Promise<IdentityRead>;
  /**
   * The worker's locator for the PRF output `prf` (`BallotWorker.backupLocator`);
   * rejects if the worker fails. `prf` is copied to the worker, which keeps
   * it for `open`, before this returns, so the caller zeroes its own.
   */
  locate(prf: Uint8Array): Promise<BackupLocatorResult>;
  /** The envelope stored under `locator` (`fetchIdentityBackup`). */
  fetch(locator: Uint8Array): Promise<BackupFetchAnswer>;
  /** The group registry's whole log up to the L2's finalized head (`loadGroupRegistry`). */
  registry(): Promise<LoadedRegistry>;
  /**
   * The same worker's open of `envelope` and its search of `registry`
   * (`BallotWorker.backupOpen`, over the deployment's published Tier 0
   * groups); rejects if the worker fails.
   */
  open(envelope: Uint8Array, registry: ReadRegistry): Promise<BackupOpenResult>;
  /** Keeps `secret`, counted in Tier 0 group `group`, as this device's identity (`restoreIdentity`). */
  restore(secret: Uint8Array, group: bigint): Promise<"restored" | "exists" | "unwritable">;
  /** Keeps `credential` as this device's backup passkey (`saveBackupCredential`). */
  keep(credential: BackupCredential): Promise<"saved" | "unwritable">;
}

/**
 * Why a recovery stopped: the device holds an identity already (`exists`),
 * or one it can't read (`unreadable`); a ceremony's problem; the worker
 * failed; the backup route not reached (`unreachable`) or holding nothing
 * for this passkey (`no-backup`, so the voter may pick another); an
 * envelope that doesn't open to an identity secret (`damaged`); the group
 * registry not read (`registry`, with its load problem) or its history
 * refused (`registry-refused`); a secret counted in no published group
 * (`not-registered`); or a store the browser refused (`unwritable`).
 */
export type RecoveryProblem =
  | "exists"
  | "unreadable"
  | PasskeyProblem
  | "worker-failed"
  | "unreachable"
  | "no-backup"
  | "damaged"
  | "registry-refused"
  | "not-registered"
  | "unwritable";

/**
 * A recovery's outcome: the identity kept, counted in `group` of `region`,
 * with the passkey's flags, as a backup reports them; or why it stopped.
 */
export type RecoveryOutcome =
  | {
      readonly kind: "restored";
      readonly group: bigint;
      readonly region: number;
      readonly syncable: boolean;
      readonly backedUp: boolean;
    }
  | { readonly kind: "stopped"; readonly problem: RecoveryProblem }
  | { readonly kind: "stopped"; readonly problem: "registry"; readonly load: LoadProblem };

const stopped = (problem: RecoveryProblem): RecoveryOutcome => ({ kind: "stopped", problem });

/**
 * Recovers the identity a backup passkey sealed: checked first that the
 * device holds none, so no ceremony runs for nothing; then any discoverable
 * passkey of the RP ID, its locator, the envelope, the registry, the open
 * and the search in the worker, the identity kept, and the passkey kept as
 * this device's, so a later backup evaluates it rather than making a second
 * (Option A, step 6). Its record notes no stored time: the device didn't
 * store the envelope, so the backup offer asks to renew it under the same
 * passkey.
 */
export async function recover(steps: RecoverySteps): Promise<RecoveryOutcome> {
  const held = await steps.identity();
  if (held.kind === "found") {
    held.identity.secret.fill(0);
    return stopped("exists");
  }
  if (held.kind === "unreadable") return stopped("unreadable");
  const passkey = await evaluateBackupPasskey(steps.credentials, steps.rpId, undefined);
  if (!passkey.ok) return stopped(passkey.problem);
  const { credentialId, flags, prf } = passkey;
  let locator: Uint8Array;
  try {
    ({ locator } = await steps.locate(prf));
  } catch {
    return stopped("worker-failed");
  } finally {
    prf.fill(0);
  }
  let fetched: BackupFetchAnswer;
  try {
    fetched = await steps.fetch(locator);
  } finally {
    locator.fill(0);
  }
  if (fetched.kind === "unreachable") return stopped("unreachable");
  if (fetched.kind === "not-found") return stopped("no-backup");
  const registry = await steps.registry();
  if (!registry.ok) return { kind: "stopped", problem: "registry", load: registry.problem };
  let opened: BackupOpenResult;
  try {
    opened = await steps.open(fetched.envelope, registry);
  } catch {
    return stopped("worker-failed");
  }
  if (!opened.ok) {
    switch (opened.problem) {
      case "no-passkey":
        // `locate` went to another worker than `open`: the steps' bug, not the voter's.
        return stopped("worker-failed");
      case "envelope":
      case "open":
      case "secret":
        return stopped("damaged");
      case "record":
      case "registry":
        return stopped("registry-refused");
      case "not-registered":
        return stopped("not-registered");
    }
  }
  const { secret, group, region } = opened;
  let restored: "restored" | "exists" | "unwritable";
  try {
    restored = await steps.restore(secret, group);
  } finally {
    secret.fill(0);
  }
  if (restored !== "restored") return stopped(restored);
  // The identity is kept whether or not this is: a device without the
  // record makes a new passkey at its next backup, which still works.
  await steps.keep({ credentialId, backedUp: flags.bs });
  return { kind: "restored", group, region, syncable: flags.be, backedUp: flags.bs };
}
