// Account-side housekeeping on a timer in apps/web, the one service granted
// the account tables (T-10: the worker's roles never are): expired WebAuthn
// challenges (T-52), expired e-mail codes, sends and recipients, so an
// abandoned code's ciphertext doesn't outlive its 15 minutes by much (T-73),
// and expired phone codes, sends and recipients and ended holds. Where the
// phone service is configured, it also extends every stored phone-hash chain
// to the keyring's current key, so a rotation is done within one tick of the
// deploy that makes a new key current (packages/core, rotatePhoneHashes;
// docs/runbooks/account-keys.md; T-73).
// Every instance runs it; the deletes and rewrites are idempotent, so two at
// once only repeat each other.

import {
  type Keyring,
  pruneAccountEmails,
  pruneAccountPhones,
  pruneAccountVerifications,
  rotatePhoneHashes,
} from "@abolishus/core";
import type { Sql } from "postgres";

/** How often the account tables are pruned. */
export const PRUNE_EVERY_MS = 10 * 60 * 1000;

export interface AccountPruneOptions {
  readonly sql: Sql;
  /** A failed run, by kind only; the next run tries again. */
  readonly log: (line: { readonly error: string }) => void;
  /** The phone-hash keyring, if the phone service is configured: its chains are rotated each run. */
  readonly phoneKeys?: Keyring;
  readonly everyMs?: number;
  /** The clock; the system's by default. */
  readonly now?: () => Date;
}

/** Prunes once now and then every `everyMs`, until the returned `stop`. */
export function startAccountPrune({
  sql,
  log,
  phoneKeys,
  everyMs = PRUNE_EVERY_MS,
  now = () => new Date(),
}: AccountPruneOptions): { stop(): Promise<void> } {
  let busy = false;
  let running: Promise<void> = Promise.resolve();
  const run = () => {
    // A run still going when the next is due: the next is skipped.
    if (busy) return;
    busy = true;
    running = (async () => {
      try {
        const at = now();
        // Apart, so one failing never keeps another's rows past their time.
        await pruneAccountVerifications(sql, at).catch(() =>
          log({ error: "AccountVerificationPruneFailed" }),
        );
        await pruneAccountEmails(sql, at).catch(() => log({ error: "AccountEmailPruneFailed" }));
        await pruneAccountPhones(sql, at).catch(() => log({ error: "AccountPhonePruneFailed" }));
        if (phoneKeys !== undefined)
          await rotatePhoneHashes(sql, phoneKeys).then(
            // Rows this instance can't rotate or match: a key dropped from
            // its keyring, or one only other instances hold (the runbook).
            ({ unknownKeys }) => {
              if (unknownKeys > 0) log({ error: "PhoneHashKeyMissing" });
            },
            () => log({ error: "PhoneHashRotationFailed" }),
          );
      } catch {
        log({ error: "AccountPruneFailed" });
      } finally {
        busy = false;
      }
    })();
  };
  run();
  const timer = setInterval(run, everyMs);
  // A pending run never holds the process open on shutdown.
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await running;
    },
  };
}
