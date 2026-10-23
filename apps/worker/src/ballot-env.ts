import type { Panel } from "@abolishus/crypto";
import * as z from "zod";

// The trustee panels the release pins, as `BALLOT_PINNED_PANELS` gives them
// to ballot admission and to the posting worker: JSON, `[{"threshold": k,
// "keys": ["<hex>", …]}]`, each key a seat's identity key in seat order.

const Panels = z
  .array(
    z.strictObject({
      threshold: z.number().int().min(1),
      keys: z.array(z.string().regex(/^(?:[0-9a-f]{2})+$/)).min(1),
    }),
  )
  .min(1);

/** The pinned panels; throws, naming the variable, if the value isn't them. */
export function pinnedPanels(value: string): Panel[] {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new Error("malformed BALLOT_PINNED_PANELS");
  }
  const panels = Panels.safeParse(json);
  if (!panels.success) throw new Error("malformed BALLOT_PINNED_PANELS");
  return panels.data.map((p) => ({
    threshold: p.threshold,
    keys: p.keys.map((k) => Uint8Array.from(Buffer.from(k, "hex"))),
  }));
}
