// The stub step's configuration from the environment (P2-22 part 4b): all of
// it or none of it, and only beside the registry sync's, whose chain and
// contracts every stub pins. What the election registry doesn't hold is
// here: the default panel the trustee registry pins, the board operator's
// receipt keys, the release's `δ` and the chain's sequencing parameters.
// Every value is public. Only the format is judged here; whether the panel,
// the keys and the bounds make a definition the registry admits is core's
// `pollStubDeploymentRule`, at startup.

import * as z from "zod";

export interface PollStubConfig {
  /** The default panel: its threshold and the seats' `p256-key`s, seat 1 first. */
  readonly panel: { readonly threshold: number; readonly keys: readonly Uint8Array[] };
  /** The board operator's receipt keys, `p256-key`s in ascending byte order (T-26). */
  readonly receiptKeys: readonly Uint8Array[];
  /** In seconds. */
  readonly l1InclusionBound: number;
  readonly sequencingWindow: bigint;
  readonly maxSequencerDrift: bigint;
}

export const POLL_STUB_ENV = [
  "POLL_STUB_PANEL_THRESHOLD",
  "POLL_STUB_PANEL_KEYS",
  "POLL_STUB_RECEIPT_KEYS",
  "POLL_STUB_INCLUSION_BOUND",
  "POLL_STUB_SEQUENCING_WINDOW",
  "POLL_STUB_MAX_SEQUENCER_DRIFT",
] as const;

type PollStubEnv = Partial<Record<(typeof POLL_STUB_ENV)[number], string>>;

// Comma-separated compressed points, as hex: "02ab…,03cd…". Sixteen at most,
// a panel's limit and more receipt keys than a board needs.
export const P256_KEYS = z
  .string()
  .regex(/^(?:0[23][0-9a-fA-F]{64})(?:,0[23][0-9a-fA-F]{64}){0,15}$/)
  .transform((v) => v.split(",").map((k) => Uint8Array.from(Buffer.from(k, "hex"))));
// A panel's threshold, as the definition's u8 holds it; the rule judges it.
export const PANEL_THRESHOLD = z
  .string()
  .regex(/^[1-9][0-9]?$/)
  .transform(Number);
// A u64 in seconds; the rule judges the bounds.
const Seconds = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/)
  .transform((v) => BigInt(v))
  .refine((v) => v < 1n << 64n);

const Env = z.strictObject({
  POLL_STUB_PANEL_THRESHOLD: PANEL_THRESHOLD,
  POLL_STUB_PANEL_KEYS: P256_KEYS,
  POLL_STUB_RECEIPT_KEYS: P256_KEYS,
  // A u32 in the definition.
  POLL_STUB_INCLUSION_BOUND: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,9})$/)
    .transform(Number)
    .refine((v) => v < 2 ** 32),
  POLL_STUB_SEQUENCING_WINDOW: Seconds,
  POLL_STUB_MAX_SEQUENCER_DRIFT: Seconds,
});

/**
 * The stub step's configuration, or undefined if no `POLL_STUB_` variable
 * is set. Throws if only some are, or if one is malformed, naming the
 * variable.
 */
export function pollStubFromEnv(env: PollStubEnv): PollStubConfig | undefined {
  const set = POLL_STUB_ENV.filter((name) => env[name] !== undefined && env[name] !== "");
  if (set.length === 0) return undefined;
  if (set.length !== POLL_STUB_ENV.length)
    throw new Error(`the stub step needs every one of ${POLL_STUB_ENV.join(", ")}`);
  const parsed = Env.safeParse(Object.fromEntries(POLL_STUB_ENV.map((n) => [n, env[n]])));
  if (!parsed.success)
    throw new Error(
      `malformed ${[...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ")}`,
    );
  const p = parsed.data;
  return {
    panel: { threshold: p.POLL_STUB_PANEL_THRESHOLD, keys: p.POLL_STUB_PANEL_KEYS },
    receiptKeys: p.POLL_STUB_RECEIPT_KEYS,
    l1InclusionBound: p.POLL_STUB_INCLUSION_BOUND,
    sequencingWindow: p.POLL_STUB_SEQUENCING_WINDOW,
    maxSequencerDrift: p.POLL_STUB_MAX_SEQUENCER_DRIFT,
  };
}
