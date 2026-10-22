// Reading the L1 release registry from state (docs/spec/contracts.md, Release
// registry, State and Verification; docs/spec/verifier.md, Served client,
// steps 2 and 3): the registry's account at the pinned address, its code
// hash against the pin, and the words of `count` and each release, every one
// proven against the state root of one L1 header, never read from a log or a
// call (T-41, T-69, T-36).

import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import {
  contractAccount,
  L1Error,
  type L1ErrorCode,
  type L1Header,
  type NodePool,
  storageWord,
  word,
} from "./l1.ts";

/** What a verifier release pins of its release registry (docs/spec/verifier.md, Pinned trust roots). */
export interface ReleaseRegistryPin {
  readonly l1ChainId: bigint;
  /** The registry's address, 20 bytes. */
  readonly address: Uint8Array;
  /** Keccak-256 of the registry's runtime code with the pinned authority written in. */
  readonly codeHash: Uint8Array;
}

/**
 * The registry this release pins: none, since none is deployed yet
 * (docs/spec/contracts.md, Release registry, Known-weak), so every run that
 * reads it is unverifiable with `release-registry-unpinned`.
 */
export const PINNED_RELEASE_REGISTRY: ReleaseRegistryPin | undefined = undefined;

/** The ERC-7201 namespace `abolish.release-registry`. */
export const RELEASE_REGISTRY_NAMESPACE =
  0x70e6df55cd9db89509d405697815053719fd2c44a78b3358c3b14b5923208800n;

/** How long before the run's clock a header may be (`MAX_L1_STALENESS`, seconds). */
export const MAX_L1_STALENESS = 3600n;

/** `keccak256(abi.encode(uint256(s), R + 1))`: release `s`'s hash; its times word is the next slot. */
export function releaseHashSlot(sequence: bigint): Uint8Array {
  if (sequence < 0n || sequence >= 2n ** 64n) throw new RangeError("a sequence is a u64");
  return keccak_256(concatBytes(word(sequence), word(RELEASE_REGISTRY_NAMESPACE + 1n)));
}

/** Release `s`'s times word's slot: its hash slot plus one. */
export function releaseTimesSlot(sequence: bigint): Uint8Array {
  return word(wordValue(releaseHashSlot(sequence)) + 1n);
}

export const wordValue = (w: Uint8Array) => w.reduce((n, x) => (n << 8n) | BigInt(x), 0n);

export type RegistryCode =
  | Exclude<L1ErrorCode, "l1-anchor-absent" | "l1-range-too-long" | "l1-checkpoint-unknown">
  | "l1-stale"
  | "release-registry-unpinned"
  | "release-registry-absent"
  | "release-registry-code"
  | "release-registry-state"
  | "release-none";

export type RegistryAt =
  | { readonly slot: "count" }
  | { readonly sequence: bigint }
  | Record<string, never>;

/** Why steps 1 to 3 stopped. */
export class RegistryError extends Error {
  override readonly name = "RegistryError";
  readonly code: RegistryCode;
  readonly at: RegistryAt;
  constructor(code: RegistryCode, at: RegistryAt = {}) {
    super(code);
    this.code = code;
    this.at = at;
  }
}

/** Whether a step-1-to-3 code fails the run, rather than leaving it unverifiable. */
export function registryCodeFails(code: RegistryCode): boolean {
  return code === "release-registry-code" || code === "release-registry-state";
}

/**
 * Step 1: `B` is fresh if it is at or before `runAt` and at most
 * `MAX_L1_STALENESS` before it. Releases and revocations only grow, so an
 * older header could hide one made since (T-36).
 */
export function checkFresh(header: L1Header, runAt: bigint): void {
  const now = header.timestamp;
  if (now > runAt || runAt - now > MAX_L1_STALENESS) throw new RegistryError("l1-stale");
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Step 2: the registry's words at `header`, as a reader of slots. An account
 * whose code isn't the pinned code isn't the registry the release pins,
 * whatever its words say (`release-registry-code`). Every word read later
 * may still throw an `l1-proof-*` code, as a `RegistryError`.
 */
export function registryWords(
  header: L1Header,
  nodes: NodePool,
  pin: ReleaseRegistryPin | undefined,
): (slot: Uint8Array) => Uint8Array {
  if (pin === undefined) throw new RegistryError("release-registry-unpinned");
  const account = proven(() => contractAccount(nodes, header.stateRoot, pin.address));
  if (account === undefined) throw new RegistryError("release-registry-absent");
  if (!equal(account.codeHash, pin.codeHash)) throw new RegistryError("release-registry-code");
  return (slot) => proven(() => storageWord(nodes.get(account.storageRoot, keccak_256(slot))));
}

function proven<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof L1Error && (e.code === "l1-proof-missing" || e.code === "l1-proof-malformed"))
      throw new RegistryError(e.code);
    throw e;
  }
}

/** One published release, as its words hold it. */
export interface PublishedRelease {
  readonly sequence: bigint;
  readonly hash: Uint8Array;
  readonly publishedAt: bigint;
  /** Zero for a release never revoked. */
  readonly revokedAt: bigint;
}

const MASK64 = 2n ** 64n - 1n;

/**
 * `count`, the number of releases published: a word with a bit above 64 is
 * no word the release code writes (`release-registry-state`, at the count).
 * Zero is `release-none`.
 */
export function releaseCount(read: (slot: Uint8Array) => Uint8Array): bigint {
  const count = wordValue(read(word(RELEASE_REGISTRY_NAMESPACE)));
  if (count > MASK64) throw new RegistryError("release-registry-state", { slot: "count" });
  if (count === 0n) throw new RegistryError("release-none");
  return count;
}

/**
 * Release `s` read at a block whose time is `now`, its hash word first:
 * a zero hash, or a times word with a bit above 128, no publication, a
 * publication after `now`, or a revocation before its publication or after
 * `now`, is no word the release code writes (`release-registry-state`, at
 * `s`).
 */
export function releaseAt(
  read: (slot: Uint8Array) => Uint8Array,
  sequence: bigint,
  now: bigint,
): PublishedRelease {
  const hash = read(releaseHashSlot(sequence));
  if (hash.every((x) => x === 0)) throw new RegistryError("release-registry-state", { sequence });
  const times = wordValue(read(releaseTimesSlot(sequence)));
  const publishedAt = times & MASK64;
  const revokedAt = (times >> 64n) & MASK64;
  if (
    times >> 128n !== 0n ||
    publishedAt === 0n ||
    publishedAt > now ||
    (revokedAt !== 0n && (revokedAt < publishedAt || revokedAt > now))
  )
    throw new RegistryError("release-registry-state", { sequence });
  return { sequence, hash, publishedAt, revokedAt };
}
