/**
 * Runs `run` while this origin holds the election's lock, in every tab and
 * window, and answers what it answers; the lock goes once `run` settles,
 * or with the tab.
 */
export type ElectionLock = <T>(electionId: Uint8Array, run: () => Promise<T>) => Promise<T>;

/** The Web Locks name of one election's lock: one per election, whatever the tier. */
export function electionLockName(electionId: Uint8Array): string {
  const hex = Array.from(electionId, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `abolish/ballot/election/${hex}`;
}

/**
 * One exclusive lock per election over the browser's Web Locks
 * (`navigator.locks`), held from a posting's check through its posting and
 * by every delivery and decline of the election's casts, so no tab keeps a
 * receipt for, or erases, a seat another tab is posting ([[delivery]],
 * Client rule 2; T-15, T-18). `undefined` where the browser has none: such a
 * build offers no posting, and delivery and a decline race only each other,
 * which leaves every seat receipted or erased as it would one at a time.
 */
export function electionLock(
  locks: Pick<LockManager, "request"> | undefined,
): ElectionLock | undefined {
  if (locks === undefined) return undefined;
  return (electionId, run) =>
    locks.request(electionLockName(electionId), { mode: "exclusive" }, () => run());
}
