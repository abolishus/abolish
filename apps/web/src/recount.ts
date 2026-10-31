/**
 * The verifier alone on one poll the community node gathered, as the verify
 * page's last command runs it. A module of its own, so the results page can
 * offer it for its poll without carrying the verify page's script, and the
 * two pages can't run the verifier differently (T-53).
 */
export const ONE_POLL = "vp node packages/verifier/src/bin.ts --gateway $GATEWAY reports/$POLL_ID";

/** {@link ONE_POLL} for one poll, its ID in place of `$POLL_ID`. */
export function recountOne(electionId: string): string {
  return ONE_POLL.replace("$POLL_ID", electionId);
}
