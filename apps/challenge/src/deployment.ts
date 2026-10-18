// The deployment this build of the challenge page serves ([[registration]],
// Challenge page): the Turnstile site key its one widget renders, and the
// ballot client's entry points, the only pages that may frame it
// (`frame-ancestors`) and the only origins it hands a token to. A release
// pins its own, next to the challenge origin (P4-4); this is staging's.

export interface ChallengeDeployment {
  /**
   * The Turnstile site key, or `undefined` while none is issued for the
   * challenge origin: then the page renders nothing.
   */
  readonly siteKey: string | undefined;
  /** The ballot client's entry points, each an HTTPS origin as `URL#origin` serializes it. */
  readonly entryPoints: readonly string[];
}

/** Staging: the ballot client's staging host (P2-8, Next). */
export const STAGING: ChallengeDeployment = {
  // No site key is issued for a staging challenge origin yet: the origin is
  // proposed with the `ci:` change that deploys the page.
  siteKey: undefined,
  entryPoints: ["https://ballot-staging.up.railway.app"],
};
