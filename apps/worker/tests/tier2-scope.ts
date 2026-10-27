// The group registry's Tier 2 scope for tests that don't record nullifier
// keys: its deployment requires a trustee registry pinning its initial panel
// (docs/spec/contracts.md, Group registry, Nullifier keys), so these tests
// pin the `initial-5` panel of docs/spec/vectors/nullifier-key-registry.json.

import { readFileSync } from "node:fs";
import type { Hex } from "viem";

interface Vectors {
  readonly panels: Record<
    string,
    {
      readonly threshold: number;
      readonly keys: readonly string[];
      readonly points: readonly { readonly x: string; readonly y: string }[];
      readonly panelId: string;
    }
  >;
}

const vectors = JSON.parse(
  readFileSync(
    new URL("../../../docs/spec/vectors/nullifier-key-registry.json", import.meta.url),
    "utf8",
  ),
) as Vectors;
const panel = vectors.panels["initial-5"];
if (panel === undefined) throw new Error("nullifier-key-registry.json: no initial-5 panel");

/** The trustee registry's constructor argument: the one panel. */
export const TIER2_PANELS = [
  {
    threshold: panel.threshold,
    quorum: panel.threshold,
    kind: 2,
    keys: `0x${panel.keys.join("")}` as Hex,
    points: panel.points.map(({ x, y }) => [BigInt(`0x${x}`), BigInt(`0x${y}`)] as const),
  },
] as const;

/** Its `panel_id`, the group registry's initial panel. */
export const TIER2_INITIAL_PANEL = `0x${panel.panelId}` as Hex;
