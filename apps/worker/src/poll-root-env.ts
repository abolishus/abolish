// The roots step's configuration from the environment (P2-22 part 3b-2):
// all of it or none of it, and only beside the registry sync's, whose index,
// nodes, group registry and event version it reads with. Every value is
// public: the deployment record's published groups and the group registry's
// registrars (docs/spec/registration.md, Groups).

import type { PollRootDeployment } from "@abolishus/core";
import { type Address, getAddress, isAddress } from "viem";
import * as z from "zod";

export interface PollRootConfig {
  /** Each tier's published groups, in ascending `group_id`, each in region 0. */
  readonly groups: PollRootDeployment["groups"];
  /** The group registry's registrars, in seat order, and their threshold, as the release pins them. */
  readonly registrars: readonly Address[];
  readonly threshold: number;
}

export const POLL_ROOT_ENV = [
  "POLL_ROOT_GROUPS",
  "POLL_ROOT_REGISTRARS",
  "POLL_ROOT_THRESHOLD",
] as const;

type PollRootEnv = Partial<Record<(typeof POLL_ROOT_ENV)[number], string>>;

/** Most groups a tier lists, as a definition's `groups` allows. */
const MAX_TIER_GROUPS = 1024;

const Env = z.strictObject({
  // `<tier>:<group_id>` pairs, comma-separated: "0:1,0:2".
  POLL_ROOT_GROUPS: z
    .string()
    .regex(/^[0-2]:(?:0|[1-9][0-9]{0,19})(?:,[0-2]:(?:0|[1-9][0-9]{0,19}))*$/),
  POLL_ROOT_REGISTRARS: z
    .string()
    .transform((v) => v.split(","))
    .pipe(
      z
        .array(
          z
            .string()
            .refine((a) => isAddress(a, { strict: false }))
            .transform((a) => getAddress(a)),
        )
        .min(1)
        .max(16),
    ),
  POLL_ROOT_THRESHOLD: z
    .string()
    .regex(/^[1-9][0-9]?$/)
    .transform(Number),
});

/**
 * The roots step's configuration, or undefined if no `POLL_ROOT_` variable
 * is set. Throws if only some are, if one is malformed (naming the
 * variable), or if the groups repeat one or exceed a tier's limit.
 */
export function pollRootFromEnv(env: PollRootEnv): PollRootConfig | undefined {
  const set = POLL_ROOT_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return undefined;
  if (set.length !== POLL_ROOT_ENV.length)
    throw new Error(`the roots step needs every one of ${POLL_ROOT_ENV.join(", ")}`);
  const parsed = Env.safeParse(Object.fromEntries(POLL_ROOT_ENV.map((n) => [n, env[n]])));
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const p = parsed.data;
  if (p.POLL_ROOT_THRESHOLD > p.POLL_ROOT_REGISTRARS.length)
    throw new Error("POLL_ROOT_THRESHOLD is above the number of registrars");
  if (new Set(p.POLL_ROOT_REGISTRARS).size !== p.POLL_ROOT_REGISTRARS.length)
    throw new Error("POLL_ROOT_REGISTRARS repeats a registrar");
  const groups = new Map<number, bigint[]>();
  const seen = new Set<bigint>();
  for (const pair of p.POLL_ROOT_GROUPS.split(",")) {
    const [tier, id] = pair.split(":") as [string, string];
    const groupId = BigInt(id);
    if (groupId >= 1n << 64n) throw new Error("malformed POLL_ROOT_GROUPS");
    // A group is in one tier, once: the registry fixes its tier at creation.
    if (seen.has(groupId)) throw new Error("POLL_ROOT_GROUPS repeats a group");
    seen.add(groupId);
    groups.set(Number(tier), [...(groups.get(Number(tier)) ?? []), groupId]);
  }
  if ([...groups.values()].some((ids) => ids.length > MAX_TIER_GROUPS))
    throw new Error("POLL_ROOT_GROUPS lists too many groups for one tier");
  return {
    groups: new Map(
      [...groups].map(([tier, ids]) => [
        tier,
        // One region per tier: the registry records no region yet, so the
        // service serves region 0 only (docs/spec/registration.md, Groups).
        ids.sort((a, b) => (a < b ? -1 : 1)).map((group_id) => ({ group_id, region: 0 })),
      ]),
    ),
    registrars: p.POLL_ROOT_REGISTRARS,
    threshold: p.POLL_ROOT_THRESHOLD,
  };
}
