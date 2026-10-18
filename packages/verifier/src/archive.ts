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
  type ManifestLink,
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
      readonly reached: Uint8Array;
      readonly named: Uint8Array;
    }
  | { readonly code: "archive-gap"; readonly first: bigint; readonly last: bigint }
  | { readonly code: "over-budget"; readonly budget: number }
  | {
      readonly code: "locator-mismatch";
      readonly locator: number;
      readonly sequence: bigint;
      readonly named: Uint8Array;
      /** The CID the walk reached at that sequence, if it reached one. */
      readonly reached: Uint8Array | undefined;
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
  /** The earlier locators, from `ArchiveLocated` logs, in any order; each is checked against the chain. */
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
  | { readonly kind: "unavailable" | "malformed" | "budget" };

// What the walk knows of a sequence: the CID the first link to it named,
// and whether a manifest was reached there. `done` is set once the sequence
// can't be reached under that CID (its bytes aren't a manifest of this
// deployment at this sequence), so no later link retries it.
interface Slot {
  readonly cid: Uint8Array;
  reached: boolean;
  done: boolean;
  readonly unavailable: Uint8Array[];
}

/**
 * Walks the archive from `locator`, the board anchor's latest locator proven
 * at `B` (`latestLocatorFromState`), and checks each earlier locator against
 * what it reached (docs/spec/archive.md, The chain from a locator, steps 1
 * to 4). The locator's manifest is read from its transaction within one
 * chunk, and must be this deployment's (`l1_chain_id` and `anchor`); each
 * link's manifest is read the same way and must be at the link's sequence.
 * Links are followed breadth first, in each manifest's order, and each
 * sequence once: the first link to a sequence fixes its CID, a later link
 * naming another is `link-conflict`, and a later link naming the same CID
 * under another transaction is tried only while the sequence is unreached
 * (a manifest posted again after a failed upload keeps its bytes). Once the
 * walk is done, the sequences from 0 to the latest's that no manifest
 * reached are reported as ranges, and every transaction tried for an
 * unreached sequence as `unavailable`. A walk that runs out of reads stops
 * there with `over-budget` and reports no gap or unavailable link: what it
 * didn't read is unverifiable for this reader, never missing.
 *
 * An earlier locator naming a CID the walk reached matches. Any other is
 * read, and a manifest of this deployment at a sequence where the walk
 * reached another CID, or none, is `locator-mismatch`: a locator overwritten
 * by a seized authority, while the logs that carried earlier ones last
 * (T-69). Earlier locators are judged only if the latest's manifest was
 * reached, since otherwise there is no chain to judge them against.
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
  let reads = 0;
  let overBudget = false;

  const read = async (cid: Uint8Array, transaction: Uint8Array): Promise<Read> => {
    if (reads >= budget) return { kind: "budget" };
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
  ): Promise<ArchiveManifest | "unavailable" | "budget" | undefined> => {
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

  const queue: ManifestLink[] = [];
  const reach = (sequence: bigint, cid: Uint8Array, m: ArchiveManifest) => {
    const slot = slots.get(sequence);
    if (slot === undefined)
      slots.set(sequence, { cid, reached: true, done: true, unavailable: [] });
    else {
      slot.reached = true;
      slot.done = true;
    }
    for (const o of m.objects) wanted.get(bytesToHex(o.cid))?.push(o.transaction);
    queue.push(...m.links);
  };

  const unknown = (ref: LocatorRef, l: ReturnType<typeof decodeArchiveLocator>) => {
    if (l.kind === "locator-version")
      findings.push({ code: "locator-version", locator: ref, version: l.version });
    else if (l.kind !== "manifest") findings.push({ code: l.kind, locator: ref });
  };

  let latest: bigint | undefined;
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
    else if (m !== undefined && m !== "budget") {
      latest = m.sequence;
      reach(m.sequence, named.manifest, m);
    }
  }

  for (let at = 0; at < queue.length; at++) {
    const link = queue[at] as ManifestLink;
    let slot = slots.get(link.sequence);
    if (slot !== undefined && !equal(slot.cid, link.cid)) {
      findings.push({
        code: "link-conflict",
        sequence: link.sequence,
        reached: slot.cid,
        named: link.cid,
      });
      continue;
    }
    if (slot?.done === true || slot?.unavailable.some((t) => equal(t, link.transaction)) === true)
      continue;
    if (slot === undefined) {
      slot = { cid: link.cid, reached: false, done: false, unavailable: [] };
      slots.set(link.sequence, slot);
    }
    const m = await fetch({ link: link.sequence }, link.cid, link.transaction);
    if (m === "budget") {
      overBudget = true;
      break;
    }
    if (m === "unavailable") {
      slot.unavailable.push(link.transaction);
      continue;
    }
    if (m === undefined) {
      slot.done = true;
      continue;
    }
    if (m.sequence !== link.sequence) {
      findings.push({
        code: "link-sequence",
        sequence: link.sequence,
        cid: link.cid,
        found: m.sequence,
      });
      slot.done = true;
      continue;
    }
    reach(link.sequence, link.cid, m);
  }

  const reached = [...slots]
    .filter(([, s]) => s.reached)
    .map(([sequence, s]) => ({ sequence, cid: s.cid }))
    .sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));

  // The chain's own reports stand whether or not the earlier locators fit
  // in what is left of the budget.
  const walked = !overBudget;
  if (walked && latest !== undefined) {
    const byCid = new Set(reached.map((r) => bytesToHex(r.cid)));
    for (const [i, bytes] of (options.earlier ?? []).entries()) {
      const l = decodeArchiveLocator(bytes);
      unknown(i, l);
      if (l.kind !== "manifest" || byCid.has(bytesToHex(l.manifest))) continue;
      const from = { locator: i };
      const m = await fetch(from, l.manifest, l.transaction);
      if (m === "budget") {
        overBudget = true;
        break;
      }
      if (m === "unavailable")
        findings.push({ code: "unavailable", from, cid: l.manifest, transaction: l.transaction });
      else if (m !== undefined) {
        const slot = slots.get(m.sequence);
        findings.push({
          code: "locator-mismatch",
          locator: i,
          sequence: m.sequence,
          named: l.manifest,
          reached: slot?.reached === true ? slot.cid : undefined,
        });
      }
    }
  }

  if (walked) {
    for (const [sequence, s] of slots)
      if (!s.reached)
        for (const transaction of s.unavailable)
          findings.push({ code: "unavailable", from: { link: sequence }, cid: s.cid, transaction });
    if (latest !== undefined) {
      // `reached` is sorted and holds `latest`, so the gaps are the holes
      // between consecutive reached sequences from 0.
      let next = 0n;
      for (const r of reached) {
        if (r.sequence > next)
          findings.push({ code: "archive-gap", first: next, last: r.sequence - 1n });
        next = r.sequence + 1n;
      }
    }
  }
  if (overBudget) findings.push({ code: "over-budget", budget });

  return { latest, manifests: reached, listings: wanted, findings, reads };
}
