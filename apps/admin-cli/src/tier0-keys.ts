// The Tier 0 token issuer's keys (docs/runbooks/tier0-token-keys.md;
// [[tier0-token]], Keys): which key period it is, and fresh keys for the
// periods ahead, each `skS` in its own owner-only file and only its public
// key and identifier printed, for the deployment record (T-74). Offline: the
// keys are made on the operator's own machine, never beside the database.

import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
  generateTier0IssuerKey,
  tier0KeyPeriodAt,
  type Tier0KeyPeriodTimes,
  tier0KeyPeriodTimes,
} from "@abolishus/core";
import type { OfflineCommand } from "./cli.ts";
import { CliError, UsageError } from "./errors.ts";

type Values = Parameters<OfflineCommand["run"]>[1];

// A deployment record lists at most 16 keys ([[deployment]], Record (version 2)).
const MAX_COUNT = 16;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const times = (t: Tier0KeyPeriodTimes) => ({
  period: t.period,
  starts: t.starts.toISOString(),
  ends: t.ends.toISOString(),
  redeemsUntil: t.redeemsUntil.toISOString(),
});

function periodTimes(period: number): Tier0KeyPeriodTimes {
  try {
    return tier0KeyPeriodTimes(period);
  } catch {
    throw new UsageError("the period is past what a date holds");
  }
}

function integerOf(values: Values, name: string, min: number, max: number): number {
  const text = String(values[name]);
  const n = Number(text);
  if (!/^(0|[1-9][0-9]*)$/.test(text) || n < min || n > max)
    throw new UsageError(`--${name} must be an integer from ${min} to ${max}`);
  return n;
}

/** The key file for `period` in `dir`: its `TIER0_ISSUER_KEYS` entry, nothing else. */
export const keyFile = (dir: string, period: number) => join(dir, `tier0-key-${period}.txt`);

export const tier0KeyCommands: Readonly<Record<string, OfflineCommand>> = {
  period: {
    usage: "[--at <ISO time>]",
    options: { at: { type: "string" } },
    positionals: 0,
    offline: true,
    async run(_, values, io) {
      let at = new Date();
      if (values["at"] !== undefined) {
        const text = String(values["at"]);
        // ISO 8601 with its zone, never a local time.
        at = ISO_TIME.test(text) ? new Date(text) : new Date(Number.NaN);
        if (Number.isNaN(at.getTime()) || at.getTime() < 0)
          throw new UsageError("--at must be an ISO time from 1970 on");
      }
      io.out(times(periodTimes(tier0KeyPeriodAt(at))));
    },
  },
  generate: {
    usage: "--from <period> --count <1..16> --dir <dir> [--first]",
    options: {
      from: { type: "string" },
      count: { type: "string" },
      dir: { type: "string" },
      first: { type: "boolean" },
    },
    positionals: 0,
    offline: true,
    async run(_, values, io) {
      if (values["from"] === undefined || values["count"] === undefined)
        throw new UsageError("--from and --count are required");
      if (typeof values["dir"] !== "string") throw new UsageError("--dir is required");
      const dir = values["dir"];
      const current = tier0KeyPeriodAt(new Date());
      const from = integerOf(values, "from", 0, 2 ** 32 - 1);
      const count = integerOf(values, "count", 1, MAX_COUNT);
      // A key first listed in or after its own period is `token-key-late`
      // ([[verifier]], Token keys across releases): only the first release
      // may list the period it is published in, so only --first makes it.
      if (from < current || (from === current && values["first"] !== true))
        throw new CliError("period-started");
      const periods = Array.from({ length: count }, (_, i) => from + i);
      for (const q of periods) periodTimes(q);
      // A period has one key for good ([[tier0-token]], Keys): never make a
      // second one beside a file that holds the first.
      if (!existsSync(dir)) throw new CliError("no-directory");
      if (periods.some((q) => existsSync(keyFile(dir, q)))) throw new CliError("key-exists");
      for (const q of periods) {
        const { entry, key } = generateTier0IssuerKey(q);
        // Encoded into its own array, not through Buffer's shared pool, and
        // synced before its public key is printed, so the signers never list
        // a key that a crash then loses.
        const bytes = new TextEncoder().encode(entry);
        key.secretKey.fill(0);
        try {
          const file = await open(keyFile(dir, q), "wx", 0o600);
          try {
            await file.writeFile(bytes);
            await file.sync();
          } finally {
            await file.close();
          }
        } catch {
          // The lines printed so far name the periods written.
          throw new CliError("key-unwritable");
        } finally {
          bytes.fill(0);
        }
        io.out({
          ...times(periodTimes(q)),
          publicKey: Buffer.from(key.publicKey).toString("hex"),
          keyId: Buffer.from(key.keyId).toString("hex"),
        });
      }
    },
  },
};
