// The deployment this build of the client trusts: where it reads the election
// registry and where it fetches records. A release pins its own (P0-3); this
// is staging's. The API and the L2 RPC are both untrusted for what they serve:
// the records are checked against the registry's hash in the worker, and the
// registry is read at the address pinned here, never at the
// `election_registry` a served definition names, which a forged definition
// could point at a registry of its own (T-34). The origins are the CSP's
// `connect-src`, which the bundle check pins (T-43).

export interface Deployment {
  /** The API's origin: definitions and display text (`packages/api-contract`). */
  readonly api: string;
  /** The L2's JSON-RPC endpoint. */
  readonly rpc: string;
  /** The L2's chain ID, which the RPC must report before it is read. */
  readonly chainId: bigint;
  /**
   * The election registry's address, as `0x` and 40 lowercase hex digits, or
   * `undefined` while none is deployed: then the client checks no election
   * and shows none (T-34).
   */
  readonly electionRegistry: string | undefined;
}

/** Staging: Base Sepolia ([[0004-l2-choice]]) and the staging API behind Cloudflare. */
export const STAGING: Deployment = {
  api: "https://api-staging.abolish.us",
  rpc: "https://sepolia.base.org",
  chainId: 84532n,
  // No election registry is deployed yet (P1-12c's and P1-18's gates come
  // first), so a staging build refuses every election link.
  electionRegistry: undefined,
};
