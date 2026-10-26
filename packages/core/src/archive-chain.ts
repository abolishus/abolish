// The archive manifests' chain as the worker that archives writes it
// (docs/spec/archive.md, Layout (version 3), Who writes them; Locator;
// [[0005-permanent-archive]]; P4-3 part 4a). Manifest `k` links exactly the
// confirmed manifests below `k` that no other confirmed manifest below `k`
// links, and a locator names a manifest only once it has confirmed and reaches
// every manifest before it. So a late confirmation is linked by the next
// manifest written, a failed upload (posted again with the same bytes) never
// orphans what came after it, and the manifest a locator names reaches every
// manifest before it: a reader walking from the latest locator reports no
// `archive-gap` the worker made (T-51, T-49).
//
// Reachability is through confirmed manifests only: a reader can't read an
// unconfirmed one, so nothing reached only through it counts. A manifest's
// links are fixed by its bytes, which its CID fixes, so the chain here is
// sequences alone; the caller names each sequence's CID and transactions.
// The chain is the authority's either way (T-69): these rules make an honest
// worker's chain whole, never a seized one's.

import { MAX_MANIFEST_LINKS } from "@abolishus/crypto";

/** A written manifest: its index in the chain is its `sequence`. */
export interface ChainManifest {
  /** The sequences it links, strictly ascending and below its own. */
  readonly links: readonly number[];
  /** Whether an upload of it has confirmed on Arweave; once true, never false again. */
  readonly confirmed: boolean;
}

function checkChain(chain: readonly ChainManifest[]): void {
  for (const [k, m] of chain.entries()) {
    let last = -1;
    for (const l of m.links) {
      if (!Number.isInteger(l) || l <= last || l >= k)
        throw new RangeError(`manifest ${k}'s links must be strictly ascending and below ${k}`);
      last = l;
    }
  }
}

/**
 * The sequences manifest `chain.length` links: the confirmed manifests that no
 * confirmed manifest links, ascending, at most `maxLinks` of them, the lowest
 * first (the next manifest links the rest). A confirmed manifest reached from
 * another confirmed one through links is linked by it directly at the last
 * step, so these are exactly the confirmed manifests no other confirmed one
 * reaches. Empty while none has confirmed. `maxLinks` is at least 2, since a
 * manifest linking one root is itself a root, so only two or more bring the
 * roots down to one.
 */
export function nextManifestLinks(
  chain: readonly ChainManifest[],
  maxLinks: number = MAX_MANIFEST_LINKS,
): number[] {
  checkChain(chain);
  if (!Number.isInteger(maxLinks) || maxLinks < 2 || maxLinks > MAX_MANIFEST_LINKS)
    throw new RangeError(`maxLinks must be from 2 to ${MAX_MANIFEST_LINKS}`);
  const linked = new Set<number>();
  for (const m of chain) if (m.confirmed) for (const l of m.links) linked.add(l);
  const roots: number[] = [];
  for (const [k, m] of chain.entries()) {
    if (roots.length === maxLinks) break;
    if (m.confirmed && !linked.has(k)) roots.push(k);
  }
  return roots;
}

/**
 * Whether `from` reaches every manifest below it through links. Its caller
 * asks only where every manifest below `from` is confirmed, so the walk never
 * meets an unconfirmed one.
 */
function reachesAllBelow(chain: readonly ChainManifest[], from: number): boolean {
  const seen = new Uint8Array(from);
  let reached = 0;
  const stack = [from];
  for (let k = stack.pop(); k !== undefined; k = stack.pop()) {
    for (const l of chain[k]?.links ?? []) {
      if (seen[l] === 1) continue;
      seen[l] = 1;
      reached += 1;
      stack.push(l);
    }
  }
  return reached === from;
}

/**
 * The sequence a locator may name: the highest confirmed manifest that reaches
 * every manifest below it through confirmed manifests, or `undefined` while
 * none does. Every manifest below it is then confirmed, so it is at most the
 * lowest unconfirmed sequence. Once a manifest meets the rule it always does,
 * so the answer never falls as uploads confirm and manifests are written.
 */
export function locatorManifest(chain: readonly ChainManifest[]): number | undefined {
  checkChain(chain);
  const unconfirmed = chain.findIndex((m) => !m.confirmed);
  const top = unconfirmed === -1 ? chain.length - 1 : unconfirmed;
  for (let m = top; m >= 0; m--)
    if (chain[m]?.confirmed === true && reachesAllBelow(chain, m)) return m;
  return undefined;
}

/**
 * Whether the worker should write a manifest that only links: every manifest
 * has confirmed, but none reaches all the others, so no locator names the
 * latest. The next manifest links the roots, and once it confirms a locator
 * names it (or, past `MAX_MANIFEST_LINKS` roots, the one after). After an
 * election closes this is the closing manifest that links stragglers before
 * the final locator (docs/spec/archive.md, Locator). While a manifest is
 * unconfirmed no manifest written after it can meet the locator rule, so its
 * upload is posted again instead.
 */
export function needsLinkingManifest(chain: readonly ChainManifest[]): boolean {
  return (
    chain.length > 0 &&
    chain.every((m) => m.confirmed) &&
    locatorManifest(chain) !== chain.length - 1
  );
}
