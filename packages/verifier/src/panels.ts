// The trustee panels this release pins, with each one's kind
// (docs/spec/verifier.md, Pinned trust roots; 0027-trustee-panels-and-live-
// results, Part 3): `independent`, a panel meeting every rule of
// 0006-trustees and named by the owner, or `transitional`, held by us during
// launch. 2.5's `panel-kind` reads them, so no poll on the civic record runs
// under the transitional panel (T-14). Changing them is a new release (T-64).
//
// No release pins a panel yet: the transitional panel is pinned with its
// seats' holders by the release that deploys it (P2-16 part 6), and the
// independent one at the handover (part 8). Until then a bundle's panel is a
// local input, and a panel no release pins has no kind to read.

/** A panel's kind, as a release pins it. */
export type PanelKind = "independent" | "transitional";

/** One pinned seat: its holder's name and whether the seat is ours. */
export interface PinnedSeat {
  readonly holder: string;
  readonly ours: boolean;
}

/**
 * One pinned panel: its identifier (`abolish/v1/panel`, lowercase hex), its
 * kind and its seats in panel order.
 */
export interface PinnedPanel {
  readonly panelId: string;
  readonly kind: PanelKind;
  readonly seats: readonly PinnedSeat[];
}

/** The panels this release pins, each once. */
export const PINNED_PANELS: readonly PinnedPanel[] = Object.freeze([]);

/** The kind `pins` gives the panel `id`, or `undefined` if it isn't pinned. */
export function pinnedKind(id: string, pins: readonly PinnedPanel[]): PanelKind | undefined {
  return pins.find((p) => p.panelId === id)?.kind;
}

/**
 * How many of the panel `id`'s seats `pins` mark ours, whatever its kind: 0
 * for a panel `pins` don't pin, or pin with another number of seats than the
 * definition's `size`, so a malformed pin can't count seats the panel
 * doesn't have (T-64). 2.3's live restriction reads it: a live poll
 * runs only under a default panel of which the release pins at least `k`
 * seats as ours, until the nodes' withholding check exists (docs/spec/
 * tally.md, Live results, What a node does; T-16, T-45). A panel no release
 * pins has no seat marked ours, so it fails the restriction: the safe side,
 * since the restriction guards ballot secrecy against withholding.
 */
export function pinnedOurs(id: string, size: number, pins: readonly PinnedPanel[]): number {
  const seats = pins.find((p) => p.panelId === id)?.seats;
  return seats?.length === size ? seats.filter((s) => s.ours).length : 0;
}
