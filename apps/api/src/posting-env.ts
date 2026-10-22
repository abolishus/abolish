import { type Panel, PanelError, panelId } from "@abolishus/crypto";
import * as z from "zod";

// The posting relay's configuration from the environment (P2-8 part
// 3c-1b-2b-2b-2d-2b-2b-2a-2): both or neither. The relay judges each pair
// under the trustee panels this release pins, the worker's own
// `BALLOT_PINNED_PANELS`, and keeps its queue and outcomes in a store of its
// own, which must not evict, persist, snapshot or back up anything, since a
// queued pair holds `m_i` for a posting that may be refused
// (docs/spec/posting-relay.md, Queue; T-18). The worker's Redis keeps its
// BullMQ queues across restarts, so the relay never shares it.

export const POSTING_ENV = ["API_POSTING_REDIS_URL", "BALLOT_PINNED_PANELS"] as const;

type PostingEnv = Partial<Record<(typeof POSTING_ENV)[number], string>>;

const Env = z.strictObject({
  API_POSTING_REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // As the worker reads it: `[{"threshold": k, "keys": ["<hex>", …]}]`, each
  // key a seat's identity key in seat order.
  BALLOT_PINNED_PANELS: z.string().transform((v, ctx) => {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: "not JSON" });
      return z.NEVER;
    }
  }),
});

const Panels = z
  .array(
    z.strictObject({
      threshold: z.number().int().min(1),
      keys: z.array(z.string().regex(/^(?:[0-9a-f]{2})+$/)).min(1),
    }),
  )
  .min(1);

export interface PostingConfig {
  /** The relay's own store; never logged, since it can carry a password. */
  readonly redisUrl: string;
  readonly panels: readonly Panel[];
}

/**
 * The relay's configuration, or undefined if neither variable is set. Throws
 * if only one is, if one is malformed, or if a pinned panel isn't one,
 * naming the variable and never quoting its value.
 */
export function postingFromEnv(env: PostingEnv): PostingConfig | undefined {
  const set = POSTING_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return undefined;
  if (set.length !== POSTING_ENV.length)
    // BALLOT_PINNED_PANELS is the worker's too, so a variable group shared
    // with it must leave it out of the API's unless the relay runs here.
    throw new Error(
      `the posting relay needs every one of ${POSTING_ENV.join(", ")}; set both or neither on the API`,
    );
  const parsed = Env.safeParse(Object.fromEntries(POSTING_ENV.map((n) => [n, env[n]])));
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const panels = Panels.safeParse(parsed.data.BALLOT_PINNED_PANELS);
  if (!panels.success) throw new Error("malformed BALLOT_PINNED_PANELS");
  const pinned = panels.data.map((p) => ({
    threshold: p.threshold,
    keys: p.keys.map((k) => Uint8Array.from(Buffer.from(k, "hex"))),
  }));
  for (const panel of pinned)
    try {
      panelId(panel);
    } catch (e) {
      if (e instanceof PanelError)
        throw new Error("BALLOT_PINNED_PANELS names a panel that isn't one");
      throw e;
    }
  return { redisUrl: parsed.data.API_POSTING_REDIS_URL, panels: pinned };
}
