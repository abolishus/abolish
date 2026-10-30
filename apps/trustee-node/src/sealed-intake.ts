// The keys a seat opens sealed deliveries with (docs/spec/sealed-delivery.md,
// Request check): the per-election KEM secret of each election it approved
// and hasn't begun destroying, found by the `kem_key_hash` a request names,
// so a request costs one decapsulation, never one per open election (T-52).
// Only key hashes and stub hashes are kept here; each request reads its
// election's secret as one use destruction waits for, so none outlives
// destruction (T-14, T-40).
import { type DeliveryHolder, kemKeyHash } from "@abolishus/crypto";
import type { CeremonySeat } from "./ceremony.ts";

/** What the sealed route opens a request with: a seat's keys, or a stand-in in tests. */
export interface SealedKeys {
  /**
   * Runs `open` with the holder of the KEM key that hashes to `kemKeyHash`,
   * and returns its result; undefined, without running it, when the seat
   * holds no such key's secret, never having approved its election or having
   * begun destroying it.
   */
  withHolder<T>(
    kemKeyHash: Uint8Array,
    open: (holder: DeliveryHolder) => T,
  ): Promise<T | undefined>;
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * The seat's `SealedKeys`. A key hash it hasn't seen sends it over the
 * approvals it hasn't indexed yet, so an election approved since is found
 * and an unknown hash costs one listing of the approvals, no secret read.
 */
export function seatKeys(ceremony: CeremonySeat): SealedKeys {
  // `kem_key_hash` in hex → the stub hash whose approved run registered it.
  const stubs = new Map<string, Uint8Array>();
  // Every approved stub looked at, its election destroyed or not.
  const indexed = new Set<string>();
  const index = async () => {
    for (const stubHash of await ceremony.approvedStubs()) {
      const name = hex(stubHash);
      if (indexed.has(name)) continue;
      const election = await ceremony.approvedElection(stubHash);
      // The public key the approved run registered: the one a client reads
      // from the transcript it checked and seals to (Client rules, rule 2).
      if (election !== undefined) {
        stubs.set(hex(kemKeyHash(election.kemKeyPair.publicKey)), stubHash);
        // Best effort: JavaScript can't guarantee erasure (T-39).
        election.kemKeyPair.secretKey.seed.fill(0);
        election.signingSecret.fill(0);
      }
      indexed.add(name);
    }
  };
  return {
    async withHolder(keyHash, open) {
      const name = hex(keyHash);
      if (!stubs.has(name)) await index();
      const stubHash = stubs.get(name);
      if (stubHash === undefined) return undefined;
      // Undefined once destruction has begun: its secret is no longer held.
      return ceremony.withSecrets(stubHash, async (secrets) => {
        try {
          return open({ kemKeyHash: Uint8Array.from(keyHash), secretKey: secrets.kemSecret });
        } finally {
          // A copy read for this request alone; best effort (T-39).
          secrets.kemSecret.seed.fill(0);
          secrets.signingSecret.fill(0);
        }
      });
    },
  };
}
