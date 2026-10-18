// The deployment this build of the client trusts: where it reads the election
// registry and where it fetches records. A release pins its own (P0-3); this
// is staging's. The API and the L2 RPC are both untrusted for what they serve:
// the records are checked against the registry's hash in the worker, and the
// registry is read at the address pinned here, never at the
// `election_registry` a served definition names, which a forged definition
// could point at a registry of its own (T-34). The origins are the CSP's
// `connect-src`, which the bundle check pins (T-43).

import type { ContractEventVersion, Panel } from "@abolishus/crypto";

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
  /**
   * The trustee panels this build pins. A poll's ceremony is checked under
   * the one its definition names, and a poll naming none of them is refused:
   * whoever serves the records never chooses the keys a ballot is sealed to
   * (T-37, T-54).
   */
  readonly panels: readonly Panel[];
  /**
   * The group registry's registrars and threshold this build pins, or
   * `undefined` while none is deployed: a voter's cell is rebuilt from the
   * board under these, never under a `RegistrarsPinned` the board logs, so
   * whoever serves the board can't sign additions of its own (T-71).
   */
  readonly registrars:
    | { readonly registrars: readonly Uint8Array[]; readonly threshold: number }
    | undefined;
  /**
   * The group registry this build reads a Tier 0 registration's outcome
   * from, or `undefined` while none is deployed: its address (`0x` and 40
   * lowercase hex digits), the block it was deployed in, before which it
   * logged nothing, and the contract-event version its logs are read under
   * (the newest this release reads; [[registration]], Outcome). The whole
   * registry is read from that block, never a filtered part of it, so the
   * RPC learns nothing of which commitment the voter looks for (T-11, T-13).
   */
  readonly groupRegistry:
    | {
        readonly address: string;
        readonly deployedAt: bigint;
        readonly eventVersion: ContractEventVersion;
      }
    | undefined;
  /**
   * The deployment's published Tier 0 groups, signed and self-paid, each
   * with its region code (a u32), in strictly ascending `group_id`, from
   * the deployment record ([[registration]], Groups): the regions a voter
   * may ask to be registered in, and later the groups the outcome is read
   * from. Never a list an API names, which could steer a registrant into a
   * group of its choosing (T-16). Empty while none is deployed.
   */
  readonly tier0Groups: readonly { readonly group_id: bigint; readonly region: number }[];
  /**
   * The backup passkey's RP ID ([[0017-identity-recovery-backup]], Option
   * A, step 1): the host that serves this client and nothing else, on a
   * registrable domain of its own, never `apps/web`'s, so no page outside
   * the signed client can evaluate the passkey's PRF (T-20). Every backup
   * ceremony names it, so a page served from any other host fails in the
   * browser rather than making a passkey bound to that host.
   */
  readonly backupRpId: string;
  /**
   * Whether this build offers voters a backup: only where the client is
   * served from `backupRpId`'s own host, so that no `/.well-known/webauthn`
   * file is needed to let it evaluate the passkey's PRF. A release offers it
   * only once its signed well-known file, the test that the file lists no
   * `apps/web` origin, and P1-19's check of the served copy exist
   * ([[0017-identity-recovery-backup]], Consequences; T-20).
   */
  readonly backups: boolean;
}

/**
 * The one region a voter is registered in at Tier 0, or `undefined` while
 * the deployment publishes none, or several: choosing among regions needs
 * their published names (P5-1), and until the group registry records a
 * region per group the service serves region 0 alone ([[registration]],
 * Groups).
 */
export function tier0Region(deployment: Pick<Deployment, "tier0Groups">): number | undefined {
  const regions = new Set(deployment.tier0Groups.map(({ region }) => region));
  return regions.size === 1 ? [...regions][0] : undefined;
}

/** Staging: Base Sepolia ([[0004-l2-choice]]) and the staging API behind Cloudflare. */
export const STAGING: Deployment = {
  api: "https://api-staging.abolish.us",
  rpc: "https://sepolia.base.org",
  chainId: 84532n,
  // No election registry is deployed yet (P1-12c's and P1-18's gates come
  // first), so a staging build refuses every election link.
  electionRegistry: undefined,
  // No release pins a panel yet: the transitional panel comes with the
  // release that deploys it (P2-16 part 6).
  panels: [],
  // No group registry is deployed on staging yet (P3-2's registry deploys
  // with the others), so a staging build finds no voter's cell.
  registrars: undefined,
  groupRegistry: undefined,
  // Nor any Tier 0 group, so a staging build registers no one.
  tier0Groups: [],
  // Where staging serves the client (P2-8, decided 2026-10-17): a Railway
  // host, `up.railway.app` being a public suffix, so the host is a
  // registrable domain of its own. A release's entry points replace it.
  backupRpId: "ballot-staging.up.railway.app",
  // Staging serves the client from the RP ID's own host.
  backups: true,
};
