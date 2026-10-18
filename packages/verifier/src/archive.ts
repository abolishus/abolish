// The chain from a locator (4.3, docs/spec/archive.md, The chain from a
// locator): from the board anchor's latest locator, the manifest it names
// and every manifest reachable from it through links, read from Arweave
// transactions by CID, so the archive is found from L1 alone once our
// pinning stops (T-51, T-49). Nothing here is a verdict on an election:
// every object found through the archive is judged by the board checks
// against L1's checkpoints, like a copy from any other source, so a manifest
// can only send a reader to bytes that fail them or to nothing (T-53). What
// is reported says where the archive path is short, and a reader's budget
// bounds what the authority can make it read (T-52).

import {
  DecodeError,
  decodeArchiveLocator,
  decodeArchiveManifest,
  MANIFEST_BOUND,
  readArchivedObject,
  type ArchiveManifest,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * Every answer a run's sources give for an Arweave transaction's data, each
 * at most `limit` bytes, in the order to try them. An answer is never
 * trusted: it counts only if it reads as the CID asked for, so a source can
 * withhold a manifest but never change one (T-24).
 */
export type TransactionSource = (
  transaction: Uint8Array,
  limit: number,
) => Promise<readonly Uint8Array[]>;

/**
 * The most a manifest's transaction data can be: the CAR of a one-chunk raw
 * block (a 59-byte header, a 3-byte length, the 36-byte CID and the block).
 */
export const MANIFEST_DATA_LIMIT = 59 + 3 + 36 + MANIFEST_BOUND;

/**
 * How many manifest reads a walk makes when its caller sets nothing. The
 * authority chooses how many manifests there are, so the walk stops there,
 * unverifiable for this reader (T-52). Each read fetches at most
 * `MANIFEST_DATA_LIMIT` bytes per source answer.
 */
export const DEFAULT_MANIFEST_BUDGET = 4_096;

/** Which locator a finding is about: the one in the anchor's state, or an earlier one by its index. */
export type LocatorRef = "latest" | number;

/** What sent the reader to a manifest: a locator, or a link to the sequence named. */
export type ManifestOrigin = { readonly locator: LocatorRef } | { readonly link: bigint };

/** One report on the archive path (docs/spec/archive.md, The chain from a locator). None is a verdict. */
export type ArchiveFinding =
  | { readonly code: "locator-version"; readonly locator: LocatorRef; readonly version: number }
  | {
      readonly code: "locator-length" | "locator-cid" | "locator-framing";
      readonly locator: LocatorRef;
    }
  // No source served data that reads as the CID from this transaction.
  | {
      readonly code: "unavailable";
      readonly from: ManifestOrigin;
      readonly cid: Uint8Array;
      readonly transaction: Uint8Array;
    }
  // Read under its CID, so these are the bytes it names, but not a manifest
  // of the version the locator fixes.
  | { readonly code: "manifest-malformed"; readonly from: ManifestOrigin; readonly cid: Uint8Array }
  | {
      readonly code: "manifest-foreign";
      readonly from: ManifestOrigin;
      readonly cid: Uint8Array;
      readonly l1ChainId: bigint;
      readonly anchor: Uint8Array;
    }
  | {
      readonly code: "link-sequence";
      readonly sequence: bigint;
      readonly cid: Uint8Array;
      readonly found: bigint;
    }
  | {
      readonly code: "link-conflict";
      readonly sequence: bigint;
      /** The CID the first link to the sequence named. */
      readonly claimed: Uint8Array;
      readonly named: Uint8Array;
    }
  | { readonly code: "archive-gap"; readonly first: bigint; readonly last: bigint }
  // Reached only through earlier locators, not from the latest's chain alone.
  | { readonly code: "earlier-only"; readonly first: bigint; readonly last: bigint }
  | { readonly code: "over-budget"; readonly budget: number }
  | {
      readonly code: "locator-mismatch";
      readonly locator: number;
      readonly sequence: bigint;
      readonly named: Uint8Array;
      /** The CID the chain's links name at that sequence, if they name one. */
      readonly chain: Uint8Array | undefined;
    };

/** A manifest the walk reached, valid for this deployment at the sequence its link named. */
export interface ReachedManifest {
  readonly sequence: bigint;
  readonly cid: Uint8Array;
}

export interface ArchiveWalk {
  /** The latest locator's manifest's sequence, if it was read and is this deployment's. */
  readonly latest: bigint | undefined;
  /** Every manifest reached, by ascending sequence. */
  readonly manifests: readonly ReachedManifest[];
  /** For each CID the caller asked about, every transaction a reached manifest lists it under, in walk order. */
  readonly listings: ReadonlyMap<string, readonly Uint8Array[]>;
  readonly findings: readonly ArchiveFinding[];
  /** Manifest reads made, each one transaction asked of the sources. */
  readonly reads: number;
}

export interface ArchiveWalkOptions {
  /**
   * The earlier locators, from the anchor's `ArchiveLocated` logs at or
   * before `B` (a later one isn't in the state the latest was proven from),
   * in log order; a repeated locator is judged once.
   */
  readonly earlier?: readonly Uint8Array[];
  /** The objects' CIDs whose listings to keep (the counted checkpoints' CIDs, say). */
  readonly objects?: readonly Uint8Array[];
  /** How many manifest reads the walk may make; default `DEFAULT_MANIFEST_BUDGET`. */
  readonly maxManifests?: number;
}

/** The deployment a reader is verifying: its L1 and its board anchor. */
export interface ArchiveDeployment {
  readonly l1ChainId: bigint;
  readonly anchor: Uint8Array;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

type Read =
  | { readonly kind: "manifest"; readonly manifest: ArchiveManifest }
  | { readonly kind: "unavailable" | "malformed" };

// What the walk knows of a sequence: the CID the first link to it named,
// whether a manifest was reached there, and every transaction queued or
// read for it. `done` is set once the sequence can't be reached under that
// CID (its bytes aren't a manifest of this deployment at this sequence), so
// nothing retries it.
interface Slot {
  readonly cid: Uint8Array;
  reached: boolean;
  done: boolean;
  conflict: boolean;
  readonly tried: Uint8Array[];
  readonly unavailable: { readonly transaction: Uint8Array; readonly from: ManifestOrigin }[];
}

interface Pending {
  readonly sequence: bigint;
  readonly transaction: Uint8Array;
}

/**
 * Walks the archive from `locator`, the board anchor's latest locator proven
 * at `B` (`latestLocatorFromState`), and checks each earlier locator against
 * the chain (docs/spec/archive.md, The chain from a locator, steps 1 to 4).
 * The locator's manifest is read from its transaction within one chunk, and
 * must be this deployment's (`l1_chain_id` and `anchor`); each link's
 * manifest is read the same way and must be at the link's sequence.
 *
 * Links are taken breadth first, in each manifest's order, and each is
 * settled when its manifest is reached: the first link to a sequence fixes
 * its CID, a later one naming another CID is `link-conflict` (once per
 * sequence) and never read, and one naming the same CID under another
 * transaction is queued while the sequence is unreached (a manifest posted
 * again after a failed upload keeps its bytes). Every queued read counts
 * against the budget when it is queued, so the queue never holds more than
 * the reads left: a walk that would need more stops at once with
 * `over-budget` and reports no gap or unavailable link, since what it
 * didn't read is unverifiable for this reader, never missing (T-52).
 * Otherwise the sequences from 0 to the latest's that no manifest reached
 * are reported as ranges, and every link transaction no source served as
 * `unavailable`, even where another transaction reached its sequence: an
 * honest link names a confirmed upload, so a dead one is a fact about the
 * chain the latest locator gives, whoever withheld it.
 *
 * An earlier locator naming the CID the chain names at a sequence is that
 * sequence's manifest: if it is unreached and the locator's transaction is
 * new, it is read there and the walk goes on from it, repeating over the
 * earlier locators until nothing more is reached, whatever their order. The
 * rest are then judged against that chain: a manifest of this deployment at
 * a sequence the chain names, or above the latest's, is `locator-mismatch`,
 * with the CID the chain names there, if any: a locator overwritten by a
 * seized authority, while the logs that carried earlier ones last (T-69).
 * One at a sequence below the latest's that the chain doesn't name is
 * followed: a reader can't tell a link a source withheld from one the
 * authority cut off, so it is no accusation, but every sequence reached
 * only through earlier locators, not from the latest's chain alone, is
 * reported as `earlier-only` ranges, what is lost once those logs expire.
 * Earlier locators are judged only if the latest's manifest was reached,
 * since otherwise there is no chain to judge them against.
 */
export async function walkArchive(
  locator: Uint8Array,
  deployment: ArchiveDeployment,
  source: TransactionSource,
  options: ArchiveWalkOptions = {},
): Promise<ArchiveWalk> {
  const budget = options.maxManifests ?? DEFAULT_MANIFEST_BUDGET;
  if (!Number.isSafeInteger(budget) || budget < 1)
    throw new RangeError("maxManifests must be a positive integer");
  if (deployment.anchor.length !== 20) throw new RangeError("an anchor address is 20 bytes");
  const findings: ArchiveFinding[] = [];
  const wanted = new Map<string, Uint8Array[]>(
    (options.objects ?? []).map((c) => [bytesToHex(c), []]),
  );
  const slots = new Map<bigint, Slot>();
  const byCid = new Map<string, bigint>();
  const queue: Pending[] = [];
  let head = 0;
  let reads = 0;
  let overBudget = false;

  const read = async (cid: Uint8Array, transaction: Uint8Array): Promise<Read> => {
    reads++;
    for (const data of await source(transaction, MANIFEST_DATA_LIMIT)) {
      // A source past the limit is that source's failure, never parsed (T-52).
      if (data.length > MANIFEST_DATA_LIMIT) continue;
      const got = readArchivedObject(data, cid, MANIFEST_BOUND);
      // Data that doesn't read as the CID is that source's failure.
      if (!got.ok) continue;
      try {
        return { kind: "manifest", manifest: decodeArchiveManifest(got.bytes, 1) };
      } catch (e) {
        // The CID fixes the bytes, so no other source can do better.
        if (e instanceof DecodeError) return { kind: "malformed" };
        throw e;
      }
    }
    return { kind: "unavailable" };
  };

  // A manifest read for `from`, or undefined after reporting why it can't be
  // used. A manifest of another deployment is never followed.
  const fetch = async (
    from: ManifestOrigin,
    cid: Uint8Array,
    transaction: Uint8Array,
  ): Promise<ArchiveManifest | "unavailable" | undefined> => {
    const got = await read(cid, transaction);
    if (got.kind !== "manifest") {
      if (got.kind !== "malformed") return got.kind;
      findings.push({ code: "manifest-malformed", from, cid });
      return undefined;
    }
    const m = got.manifest;
    if (m.l1_chain_id !== deployment.l1ChainId || !equal(m.anchor, deployment.anchor)) {
      findings.push({
        code: "manifest-foreign",
        from,
        cid,
        l1ChainId: m.l1_chain_id,
        anchor: m.anchor,
      });
      return undefined;
    }
    return m;
  };

  const claim = (sequence: bigint, cid: Uint8Array): Slot => {
    const slot: Slot = {
      cid,
      reached: false,
      done: false,
      conflict: false,
      tried: [],
      unavailable: [],
    };
    slots.set(sequence, slot);
    byCid.set(bytesToHex(cid), sequence);
    return slot;
  };

  // Settles a reached manifest's links in order, queueing the reads they
  // need; false once the budget can't cover them.
  const reach = (slot: Slot, m: ArchiveManifest): boolean => {
    slot.reached = true;
    slot.done = true;
    for (const o of m.objects) wanted.get(bytesToHex(o.cid))?.push(o.transaction);
    for (const link of m.links) {
      const known = slots.get(link.sequence);
      if (known !== undefined && !equal(known.cid, link.cid)) {
        if (!known.conflict)
          findings.push({
            code: "link-conflict",
            sequence: link.sequence,
            claimed: known.cid,
            named: link.cid,
          });
        known.conflict = true;
        continue;
      }
      if (known?.done === true || known?.tried.some((t) => equal(t, link.transaction)) === true)
        continue;
      if (reads + queue.length - head >= budget) return false;
      (known ?? claim(link.sequence, link.cid)).tried.push(link.transaction);
      queue.push({ sequence: link.sequence, transaction: link.transaction });
    }
    return true;
  };

  // Reads `transaction` for the sequence `slot` holds, and goes on from its
  // manifest if it is reached there.
  const attempt = async (
    sequence: bigint,
    slot: Slot,
    transaction: Uint8Array,
    from: ManifestOrigin,
  ): Promise<boolean> => {
    const m = await fetch(from, slot.cid, transaction);
    if (m === "unavailable") {
      slot.unavailable.push({ transaction, from });
      return true;
    }
    if (m === undefined) slot.done = true;
    else if (m.sequence !== sequence) {
      findings.push({ code: "link-sequence", sequence, cid: slot.cid, found: m.sequence });
      slot.done = true;
    } else return reach(slot, m);
    return true;
  };

  const drain = async (): Promise<boolean> => {
    while (head < queue.length) {
      // Taken off the queue before it is read, so `reach` counts only what is still pending.
      const { sequence, transaction } = queue[head++] as Pending;
      const slot = slots.get(sequence) as Slot;
      // Reached since it was queued (from an earlier locator, or a sibling
      // upload), or its bytes refused.
      if (slot.done) continue;
      if (!(await attempt(sequence, slot, transaction, { link: sequence }))) return false;
    }
    return true;
  };

  const unknown = (ref: LocatorRef, l: ReturnType<typeof decodeArchiveLocator>) => {
    if (l.kind === "locator-version")
      findings.push({ code: "locator-version", locator: ref, version: l.version });
    else if (l.kind !== "manifest") findings.push({ code: l.kind, locator: ref });
  };

  let latest: bigint | undefined;
  // What the latest locator's chain reaches on its own: whatever only an
  // earlier locator reached is gone once the logs that carried it expire.
  const alone = new Set<bigint>();
  const named = decodeArchiveLocator(locator);
  unknown("latest", named);
  if (named.kind === "manifest") {
    const from = { locator: "latest" as const };
    const m = await fetch(from, named.manifest, named.transaction);
    if (m === "unavailable")
      findings.push({
        code: "unavailable",
        from,
        cid: named.manifest,
        transaction: named.transaction,
      });
    else if (m !== undefined) {
      latest = m.sequence;
      const slot = claim(m.sequence, named.manifest);
      slot.tried.push(named.transaction);
      overBudget = !reach(slot, m) || !(await drain());
      for (const [sequence, slot] of slots) if (slot.reached) alone.add(sequence);
    }
  }

  if (!overBudget && latest !== undefined) {
    const seen = new Set<string>();
    const earlier: { locator: number; manifest: Uint8Array; transaction: Uint8Array }[] = [];
    for (const [i, bytes] of (options.earlier ?? []).entries()) {
      const key = bytesToHex(bytes);
      if (seen.has(key)) continue;
      seen.add(key);
      const l = decodeArchiveLocator(bytes);
      unknown(i, l);
      if (l.kind === "manifest")
        earlier.push({ locator: i, manifest: l.manifest, transaction: l.transaction });
    }

    // First the chain alone: an earlier locator naming a CID the chain's
    // links name is the chain's own manifest, and a new transaction for it
    // may reach what the links' didn't, which may name more. Passes repeat
    // until one reaches nothing, so what the chain names doesn't depend on
    // the locators' order.
    const own = new Set<number>();
    for (let more = true; more && !overBudget;) {
      more = false;
      for (const e of earlier) {
        const at = byCid.get(bytesToHex(e.manifest));
        if (at === undefined) continue;
        own.add(e.locator);
        const slot = slots.get(at) as Slot;
        if (slot.done || slot.tried.some((t) => equal(t, e.transaction))) continue;
        if (reads >= budget) {
          overBudget = true;
          break;
        }
        slot.tried.push(e.transaction);
        if (!(await attempt(at, slot, e.transaction, { locator: e.locator })) || !(await drain())) {
          overBudget = true;
          break;
        }
        more = true;
      }
    }

    // Then the rest, against the chain as it now stands. One at a sequence
    // the chain names (with another CID) or above the latest's is a
    // mismatch. One at a sequence below the latest's that the chain doesn't
    // name can't be told from one below a link a source withheld, or one the
    // authority's links cut off: it is followed, and what it reaches is
    // reported as `earlier-only`, a fact either way.
    const named = new Set(slots.keys());
    for (const e of earlier) {
      if (overBudget) break;
      // The chain's own, or already followed from another earlier locator.
      if (own.has(e.locator) || byCid.has(bytesToHex(e.manifest))) continue;
      if (reads >= budget) {
        overBudget = true;
        break;
      }
      const from = { locator: e.locator };
      const m = await fetch(from, e.manifest, e.transaction);
      if (m === "unavailable")
        findings.push({ code: "unavailable", from, cid: e.manifest, transaction: e.transaction });
      if (m === "unavailable" || m === undefined) continue;
      if (named.has(m.sequence) || m.sequence > latest) {
        findings.push({
          code: "locator-mismatch",
          locator: e.locator,
          sequence: m.sequence,
          named: e.manifest,
          chain: slots.get(m.sequence)?.cid,
        });
        continue;
      }
      // Another earlier locator already followed a manifest there.
      if (slots.has(m.sequence)) continue;
      const slot = claim(m.sequence, e.manifest);
      slot.tried.push(e.transaction);
      if (!reach(slot, m) || !(await drain())) overBudget = true;
    }
  }

  const reached = [...slots]
    .filter(([, s]) => s.reached)
    .map(([sequence, s]) => ({ sequence, cid: s.cid }))
    .sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));

  if (overBudget) findings.push({ code: "over-budget", budget });
  else if (latest !== undefined) {
    // Every transaction no source served, even where another reached its
    // sequence: an honest link names a confirmed upload, so each is a fact
    // about the chain as the latest locator gives it.
    for (const s of slots.values())
      for (const { transaction, from } of s.unavailable)
        findings.push({ code: "unavailable", from, cid: s.cid, transaction });
    // `reached` is sorted and holds `latest`, so the gaps are the holes
    // between consecutive reached sequences from 0.
    let next = 0n;
    for (const r of reached) {
      if (r.sequence > next)
        findings.push({ code: "archive-gap", first: next, last: r.sequence - 1n });
      next = r.sequence + 1n;
    }
    let run: { first: bigint; last: bigint } | undefined;
    for (const r of reached) {
      if (alone.has(r.sequence)) continue;
      if (run !== undefined && r.sequence === run.last + 1n) run.last = r.sequence;
      else {
        if (run !== undefined) findings.push({ code: "earlier-only", ...run });
        run = { first: r.sequence, last: r.sequence };
      }
    }
    if (run !== undefined) findings.push({ code: "earlier-only", ...run });
  }

  return { latest, manifests: reached, listings: wanted, findings, reads };
}
