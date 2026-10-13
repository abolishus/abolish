// The rolling tier tree of docs/spec/membership.md (Rolling tier tree, Root
// clock and steps), read from the spec for the vector tests: packages/crypto
// has no rolling tree yet (P2-17 part 3), so the leaves and the clock come
// from here and only the tier tree's root from the code under test.

import { PARAMETERS } from "../src/index.ts";

export interface RollingEvent {
  readonly block: string;
  readonly timestamp: string;
  readonly group: string;
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

/** The listed groups' additions in chain order, removals by member index. */
export function rollingLeaves(
  events: readonly RollingEvent[],
  groups: readonly string[],
  admit: (e: RollingEvent) => boolean,
): bigint[] {
  const leaves: bigint[] = [];
  const at = new Map<string, number>();
  const count = new Map<string, number>();
  for (const e of events) {
    if (!admit(e) || !groups.includes(e.group)) continue;
    for (const c of e.add ?? []) {
      const i = count.get(e.group) ?? 0;
      at.set(`${e.group}/${i}`, leaves.length);
      count.set(e.group, i + 1);
      leaves.push(BigInt(c));
    }
    for (const i of e.remove ?? []) leaves[at.get(`${e.group}/${i}`)!] = 0n;
  }
  return leaves;
}

/** Distinct live commitments: a repeat never counts twice. */
export const memberCount = (leaves: readonly bigint[]) =>
  new Set(leaves.filter((x) => x !== 0n)).size;

/** Boundary `n` of the root clock, in UNIX seconds. */
export const tau = (n: bigint) =>
  n * BigInt(PARAMETERS.ROOT_PERIOD) + BigInt(PARAMETERS.ROOT_OFFSET);
