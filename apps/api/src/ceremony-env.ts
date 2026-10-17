import type { CoordinatorDeployment } from "@abolishus/core";
import { PanelError, panelId } from "@abolishus/crypto";
import * as z from "zod";

// The coordinator's configuration from the environment (P2-22 part 4c-2):
// all of it or none of it. It is the stub step's default panel and where
// that panel is pinned, as the worker's `POLL_STUB_` and registry variables
// give them; the deployment's runbook sets both from one deployment record.
// Every value is public. A value that differs from the worker's makes every
// post fail to verify, so a run ends at its deadlines and the worker logs it
// (T-54); it never makes a forged message fit.

export const CEREMONY_ENV = [
  "API_CEREMONY_PANEL_THRESHOLD",
  "API_CEREMONY_PANEL_KEYS",
  "API_CEREMONY_L2_CHAIN_ID",
  "API_CEREMONY_TRUSTEE_REGISTRY",
] as const;

type CeremonyEnv = Partial<Record<(typeof CEREMONY_ENV)[number], string>>;

const Env = z.strictObject({
  API_CEREMONY_PANEL_THRESHOLD: z
    .string()
    .regex(/^[1-9][0-9]?$/)
    .transform(Number),
  // Comma-separated compressed points, as hex, seat 1 first; sixteen at most.
  API_CEREMONY_PANEL_KEYS: z
    .string()
    .regex(/^(?:0[23][0-9a-fA-F]{64})(?:,0[23][0-9a-fA-F]{64}){0,15}$/)
    .transform((v) => v.split(",").map((k) => Uint8Array.from(Buffer.from(k, "hex")))),
  API_CEREMONY_L2_CHAIN_ID: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .transform((v) => BigInt(v))
    .refine((v) => v < 1n << 64n),
  API_CEREMONY_TRUSTEE_REGISTRY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((v) => Uint8Array.from(Buffer.from(v.slice(2), "hex"))),
});

/**
 * The coordinator's deployment, or undefined if no `API_CEREMONY_` variable
 * is set. Throws if only some are, if one is malformed, or if the panel
 * isn't one (a threshold below 2 or above its size, a repeated or invalid
 * key), naming the variable.
 */
export function ceremonyFromEnv(env: CeremonyEnv): CoordinatorDeployment | undefined {
  const set = CEREMONY_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return undefined;
  if (set.length !== CEREMONY_ENV.length)
    throw new Error(`the ceremony's coordinator needs every one of ${CEREMONY_ENV.join(", ")}`);
  const parsed = Env.safeParse(Object.fromEntries(CEREMONY_ENV.map((n) => [n, env[n]])));
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const p = parsed.data;
  const panel = { threshold: p.API_CEREMONY_PANEL_THRESHOLD, keys: p.API_CEREMONY_PANEL_KEYS };
  try {
    panelId(panel);
  } catch (e) {
    if (e instanceof PanelError)
      throw new Error("API_CEREMONY_PANEL_THRESHOLD and API_CEREMONY_PANEL_KEYS aren't a panel");
    throw e;
  }
  return {
    panel,
    l2ChainId: p.API_CEREMONY_L2_CHAIN_ID,
    trusteeRegistry: p.API_CEREMONY_TRUSTEE_REGISTRY,
  };
}
