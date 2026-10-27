// The archive's configuration from the environment (P4-3 part 4b-2b-2b-1):
// all of it or none of it, as the anchoring runner's. The node's URL may
// carry a provider's API key in its path, and the wallet is a secret (T-52),
// so a malformed one is named, never quoted. The wallet can only add data
// under its own address, which no reader trusts, so seizing it costs what
// the wallet holds and nothing else ([[0005-permanent-archive]], Keys).

import { parseGateway } from "@abolishus/verifier";
import type { JsonWebKey } from "node:crypto";
import { type ArweaveWallet, arweaveWallet } from "./arweave-client.ts";

export interface ArchiveConfig {
  /** The Arweave node the archive posts through and reads depth and data from. */
  readonly node: URL;
  /** The wallet that pays for every upload. */
  readonly wallet: ArweaveWallet;
  /** The most winston one upload's reward may be (T-52). */
  readonly maxReward: bigint;
  /** How often the run is scheduled. */
  readonly everyMs: number;
}

export const ARCHIVE_ENV = ["ARCHIVE_ARWEAVE_URL", "ARCHIVE_WALLET", "ARCHIVE_MAX_REWARD"] as const;

/** Optional: how often the run is scheduled, in milliseconds. */
export const ARCHIVE_EVERY_ENV = "ARCHIVE_EVERY_MS";

/**
 * Every ten minutes by default: about five Arweave blocks, so an upload is
 * seen at the depth within a run of reaching it, and a confirmed manifest's
 * locator reaches the next anchoring call within the hour.
 */
export const ARCHIVE_EVERY_MS = 10 * 60_000;

type ArchiveEnv = Partial<Record<(typeof ARCHIVE_ENV)[number] | typeof ARCHIVE_EVERY_ENV, string>>;

/**
 * The archive's configuration, or undefined if no `ARCHIVE_` variable is
 * set. Throws if only some are, or if one is malformed, never quoting the
 * URL or the wallet.
 */
export function archiveFromEnv(env: ArchiveEnv): ArchiveConfig | undefined {
  const set = ARCHIVE_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  const every = env[ARCHIVE_EVERY_ENV];
  if (set.length === 0) {
    if (every !== undefined && every !== "")
      throw new Error(`${ARCHIVE_EVERY_ENV} needs the archive configured`);
    return undefined;
  }
  if (set.length !== ARCHIVE_ENV.length)
    throw new Error(`the archive needs every one of ${ARCHIVE_ENV.join(", ")}`);
  let node: URL;
  try {
    node = parseGateway(env.ARCHIVE_ARWEAVE_URL as string);
  } catch {
    throw new Error("malformed ARCHIVE_ARWEAVE_URL");
  }
  let jwk: JsonWebKey;
  try {
    jwk = JSON.parse(env.ARCHIVE_WALLET as string) as JsonWebKey;
  } catch {
    throw new Error("ARCHIVE_WALLET is not a JWK");
  }
  let wallet: ArweaveWallet;
  try {
    wallet = arweaveWallet(jwk);
  } catch {
    throw new Error("ARCHIVE_WALLET is not a 4096-bit RSA private key with exponent 65537");
  }
  const reward = env.ARCHIVE_MAX_REWARD as string;
  if (!/^[1-9][0-9]{0,29}$/.test(reward)) throw new Error("malformed ARCHIVE_MAX_REWARD");
  // At least a minute, so a run's reads and uploads usually finish before
  // the next; the lock keeps them from overlapping when they don't.
  if (
    every !== undefined &&
    every !== "" &&
    !(/^[1-9][0-9]{0,9}$/.test(every) && Number(every) >= 60_000)
  )
    throw new Error(`malformed ${ARCHIVE_EVERY_ENV}`);
  return {
    node,
    wallet,
    maxReward: BigInt(reward),
    everyMs: every === undefined || every === "" ? ARCHIVE_EVERY_MS : Number(every),
  };
}
