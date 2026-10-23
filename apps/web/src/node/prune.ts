// Account-side housekeeping on a timer in apps/web, the one service granted
// the account tables (T-10: the worker's roles never are): expired WebAuthn
// challenges (T-52), expired e-mail codes, sends and recipients, so an
// abandoned code's ciphertext doesn't outlive its 15 minutes by much (T-73),
// expired phone codes, sends and recipients and ended holds, the dead
// mark on Tier 0 token records whose key stopped redeeming, so a record
// keeps no period past its key's window ([[tier0-token]], Issuance, step 3),
// and the reaction counts of hours gone by.
// Where each service is configured, it also rewrites what is stored under its
// keyrings' current keys: every phone-hash chain extended, every e-mail
// address re-hashed and re-sealed, so a rotation is done within one tick of
// the deploy that makes a new key current (packages/core, rotatePhoneHashes
// and rotateEmailKeys; docs/runbooks/account-keys.md; T-73). With the e-mail
// service, it then sends the moderation notices due (packages/core,
// sendNotices), after the rotation so every box opens under the keys held.
// Every instance runs it; the deletes and rewrites are idempotent, so two at
// once only repeat each other.

import {
  type EmailKeys,
  type EmailSender,
  type Keyring,
  MAX_NOTICE_BATCH,
  markDeadTier0Tokens,
  pruneAccountEmails,
  pruneAccountPhones,
  pruneAccountVerifications,
  pruneReactionHours,
  rotateEmailKeys,
  rotatePhoneHashes,
  sendNotices,
} from "@abolishus/core";
import type { Sql } from "postgres";

/** How often the account tables are pruned. */
export const PRUNE_EVERY_MS = 10 * 60 * 1000;
/**
 * The most notice batches one run sends, so a backlog drains at up to
 * this many full batches a tick while a provider that hangs on every send
 * holds the timer for a bounded time only.
 */
export const NOTICE_BATCHES = 10;

export interface AccountPruneOptions {
  readonly sql: Sql;
  /** A failed run, by kind only; the next run tries again. */
  readonly log: (line: { readonly error: string }) => void;
  /** The phone-hash keyring, if the phone service is configured: its chains are rotated each run. */
  readonly phoneKeys?: Keyring;
  /** The e-mail keyrings, if the e-mail service is configured: its rows are rotated each run. */
  readonly emailKeys?: EmailKeys;
  /**
   * The provider's own sender, with `emailKeys`: the notices due are sent
   * each run. Never a wrapper that answers `sent` for every message, or a
   * refusal is never tried again.
   */
  readonly noticeSender?: EmailSender;
  readonly everyMs?: number;
  /** The clock; the system's by default. */
  readonly now?: () => Date;
}

/** Prunes once now and then every `everyMs`, until the returned `stop`. */
export function startAccountPrune({
  sql,
  log,
  phoneKeys,
  emailKeys,
  noticeSender,
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
        await pruneReactionHours(sql, at).catch(() => log({ error: "ReactionHourPruneFailed" }));
        if (phoneKeys !== undefined)
          await rotatePhoneHashes(sql, phoneKeys).then(
            // What the operator must settle (the account-keys runbook): a
            // key whose bytes changed, which stops the rotation; rows under a
            // key dropped from this keyring or held only by other instances;
            // two accounts holding one number.
            ({ unknownKeys, conflicts, mismatchedKeys }) => {
              if (mismatchedKeys > 0) log({ error: "PhoneHashKeyMismatch" });
              if (unknownKeys > 0) log({ error: "PhoneHashKeyMissing" });
              if (conflicts > 0) log({ error: "PhoneHashConflict" });
            },
            () => log({ error: "PhoneHashRotationFailed" }),
          );
        if (emailKeys !== undefined)
          await rotateEmailKeys(sql, emailKeys).then(
            ({ unknownKeys, skipped, mismatchedKeys }) => {
              if (mismatchedKeys > 0) log({ error: "EmailKeyMismatch" });
              if (unknownKeys > 0) log({ error: "EmailKeyMissing" });
              if (skipped > 0) log({ error: "EmailKeyRotationSkipped" });
            },
            () => log({ error: "EmailKeyRotationFailed" }),
          );
        if (emailKeys !== undefined && noticeSender !== undefined)
          await sendDueNotices(sql, emailKeys, noticeSender, now, log).catch(() =>
            log({ error: "AccountNoticeSendFailed" }),
          );
        await markDeadTier0Tokens(sql, at).catch(() => log({ error: "Tier0TokenDeadMarkFailed" }));
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

/**
 * Sends the notices due, batch after batch while each is full, up to
 * `NOTICE_BATCHES`. Each batch reads the clock afresh, so its leases run
 * from when it claims. A refusal is logged by kind only: the notice is
 * tried again after its wait.
 */
async function sendDueNotices(
  sql: Sql,
  keys: EmailKeys,
  sender: EmailSender,
  now: () => Date,
  log: AccountPruneOptions["log"],
): Promise<void> {
  for (let batch = 0; batch < NOTICE_BATCHES; batch++) {
    const { sent, retrying, dropped } = await sendNotices(sql, { sender, keys, now: now() });
    if (retrying > 0) log({ error: "AccountNoticeRefused" });
    if (sent + retrying + dropped < MAX_NOTICE_BATCH) return;
  }
}
