import {
  type ArchiveManifest,
  type ArchiveManifestV2,
  encodeArchiveLocator,
  encodeArchiveManifest,
  type EvidenceRef,
  objectCar,
  objectCid,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  type ArchiveFinding,
  DEFAULT_EVIDENCE_BUDGET,
  MANIFEST_DATA_LIMIT,
  walkArchive,
} from "../src/index.ts";

// Version-2 chains (docs/spec/archive.md, The chain from a locator; Layout
// (version 2)): a version-2 locator fixes manifest version 2, whose links
// may name manifests of version 1 or 2, while a version-1 chain links only
// version 1; and the evidence references of the reached manifests, kept for
// the contracts asked about. Manifests are written through packages/crypto's
// encoder (vectored by archive.json and archive-v2.json), archived as their
// CARs under made-up transaction IDs, and served by a scripted source.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CHAIN = 11_155_111n;
const ANCHOR = new Uint8Array(20).fill(0xa0);
const DEPLOYMENT = { l1ChainId: CHAIN, anchor: ANCHOR };
const BOARD = new Uint8Array(20).fill(0xb0);
const REGISTRY = new Uint8Array(20).fill(0xc0);

const tx = (n: number) => {
  const t = new Uint8Array(32);
  t[0] = 0x7a;
  t[30] = (n >>> 8) & 0xff;
  t[31] = n & 0xff;
  return t;
};
const record = (n: number) => objectCid(Uint8Array.of(0x00, 0x25, 0x01, n & 0xff, n >> 8));

interface Stored {
  readonly sequence: bigint;
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
  readonly bytes: Uint8Array;
}

const compare = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return 0;
};

const ref = (contract: Uint8Array, l2_block: bigint, n: number, t = tx(5000 + n)): EvidenceRef => ({
  contract,
  l2_block,
  cid: record(n),
  transaction: t,
});

// A manifest of `version` at `sequence`, linking `links`; a version-2 one
// lists `evidence` (sorted as the codec needs), and one with nothing else
// to name lists one object.
function manifest(
  version: 1 | 2,
  sequence: bigint,
  links: readonly Stored[],
  evidence: readonly EvidenceRef[] = [],
  transaction = tx(Number(sequence)),
): Stored {
  const base: ArchiveManifest = {
    l1_chain_id: CHAIN,
    anchor: ANCHOR,
    sequence,
    objects:
      links.length === 0 && evidence.length === 0
        ? [{ cid: objectCid(Uint8Array.of(0x0b, Number(sequence))), transaction: tx(9000) }]
        : [],
    links: links
      .map((l) => ({ sequence: l.sequence, cid: l.cid, transaction: l.transaction }))
      .sort((a, b) => (a.sequence < b.sequence ? -1 : 1)),
  };
  const sorted = [...evidence].sort(
    (a, b) =>
      compare(a.contract, b.contract) ||
      (a.l2_block < b.l2_block ? -1 : a.l2_block > b.l2_block ? 1 : 0) ||
      compare(a.cid, b.cid),
  );
  const bytes =
    version === 2
      ? encodeArchiveManifest({ ...base, evidence: sorted } satisfies ArchiveManifestV2, 2)
      : encodeArchiveManifest(base);
  return { sequence, cid: objectCid(bytes), transaction, bytes };
}

// Bytes under a CID whose header names `version`, for manifests no encoder writes.
function withVersion(s: Stored, version: number): Stored {
  const bytes = Uint8Array.from(s.bytes);
  bytes[2] = version;
  return { ...s, cid: objectCid(bytes), bytes };
}

function arweave(stored: readonly Stored[]) {
  const held = new Map<string, Uint8Array[]>();
  for (const s of stored) held.set(bytesToHex(s.transaction), [objectCar(s.bytes)]);
  const asked: string[] = [];
  const source = async (t: Uint8Array, limit: number): Promise<Uint8Array[]> => {
    expect(limit).toBe(MANIFEST_DATA_LIMIT);
    asked.push(bytesToHex(t));
    return held.get(bytesToHex(t)) ?? [];
  };
  return { source, asked };
}

const locator = (s: Stored, version: 1 | 2) => encodeArchiveLocator(s.cid, s.transaction, version);
const codes = (f: readonly ArchiveFinding[]) => f.map((x) => x.code);

describe("walkArchive over version-2 chains", () => {
  test("a version-2 locator's chain reaches manifests of both versions", async () => {
    const m0 = manifest(1, 0n, []);
    const m1 = manifest(2, 1n, [m0], [ref(BOARD, 10n, 1)]);
    const m2 = manifest(2, 2n, [m0, m1], [ref(BOARD, 20n, 2)]);
    const walk = await walkArchive(locator(m2, 2), DEPLOYMENT, arweave([m0, m1, m2]).source);
    expect(walk.findings).toEqual([]);
    expect(walk.latest).toBe(2n);
    expect(walk.manifests.map((m) => m.sequence)).toEqual([0n, 1n, 2n]);
    // Nothing was asked about: no listing is kept.
    expect(walk.evidence).toEqual([]);
  });

  test("a version-1 chain links only version 1", async () => {
    const m0 = manifest(2, 0n, [], [ref(BOARD, 10n, 1)]);
    const m1 = manifest(1, 1n, [m0]);
    const walk = await walkArchive(locator(m1, 1), DEPLOYMENT, arweave([m0, m1]).source);
    expect(walk.findings).toEqual([
      { code: "manifest-malformed", from: { link: 0n }, cid: m0.cid },
      { code: "archive-gap", first: 0n, last: 0n },
    ]);
  });

  test("a locator's manifest must be the version it fixes, exactly", async () => {
    const v1 = manifest(1, 0n, []);
    const v2 = manifest(2, 0n, [], [ref(BOARD, 10n, 1)]);
    for (const [named, version] of [
      [v1, 2],
      [v2, 1],
    ] as const) {
      const walk = await walkArchive(locator(named, version), DEPLOYMENT, arweave([named]).source);
      expect(walk.findings).toEqual([
        { code: "manifest-malformed", from: { locator: "latest" }, cid: named.cid },
      ]);
      expect(walk.latest).toBeUndefined();
    }
  });

  test("a link whose header names a version above the chain's, or none known, is malformed", async () => {
    const m0 = manifest(2, 0n, []);
    for (const version of [0, 3, 0xff]) {
      const odd = withVersion(m0, version);
      const top = manifest(2, 1n, [odd]);
      const walk = await walkArchive(locator(top, 2), DEPLOYMENT, arweave([odd, top]).source);
      expect(walk.findings).toEqual([
        { code: "manifest-malformed", from: { link: 0n }, cid: odd.cid },
        { code: "archive-gap", first: 0n, last: 0n },
      ]);
    }
  });

  test("keeps the references to the contracts asked about, each once, in walk order", async () => {
    const shared = ref(BOARD, 10n, 1);
    const m0 = manifest(2, 0n, [], [shared, ref(REGISTRY, 10n, 2)]);
    // The same reference in a later manifest, once under the same
    // transaction and once under a new one (a lost upload posted again).
    const m1 = manifest(2, 1n, [m0], [shared, ref(BOARD, 20n, 3)]);
    const m2 = manifest(2, 2n, [m1], [{ ...shared, transaction: tx(7777) }, ref(BOARD, 20n, 4)]);
    const walk = await walkArchive(locator(m2, 2), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      contracts: [BOARD],
    });
    expect(walk.findings).toEqual([]);
    // Reached from the latest down: m2's references first.
    expect(walk.evidence).toEqual([
      {
        contract: BOARD,
        l2Block: 10n,
        cid: shared.cid,
        transactions: [tx(7777), shared.transaction],
      },
      { contract: BOARD, l2Block: 20n, cid: record(4), transactions: [tx(5004)] },
      { contract: BOARD, l2Block: 20n, cid: record(3), transactions: [tx(5003)] },
    ]);
    const both = await walkArchive(locator(m2, 2), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      contracts: [REGISTRY, BOARD],
    });
    expect(both.evidence.map((e) => [bytesToHex(e.contract), e.l2Block])).toEqual([
      [bytesToHex(BOARD), 10n],
      [bytesToHex(BOARD), 20n],
      [bytesToHex(BOARD), 20n],
      [bytesToHex(REGISTRY), 10n],
    ]);
  });

  test("the same CID claimed at another block is another listing", async () => {
    const a = ref(BOARD, 10n, 1);
    const m0 = manifest(2, 0n, [], [a, { ...a, l2_block: 11n }]);
    const walk = await walkArchive(locator(m0, 2), DEPLOYMENT, arweave([m0]).source, {
      contracts: [BOARD],
    });
    expect(walk.evidence.map((e) => e.l2Block)).toEqual([10n, 11n]);
  });

  test("stops keeping listings at its budget, and says so", async () => {
    const refs = [1, 2, 3].map((n) => ref(BOARD, BigInt(n), n));
    const m0 = manifest(2, 0n, [], refs);
    const walk = await walkArchive(locator(m0, 2), DEPLOYMENT, arweave([m0]).source, {
      contracts: [BOARD],
      maxEvidence: 2,
    });
    expect(walk.evidence.map((e) => e.l2Block)).toEqual([1n, 2n]);
    expect(walk.findings).toEqual([{ code: "evidence-over-budget", budget: 2 }]);
    // A transaction already kept costs nothing again.
    const again = manifest(2, 1n, [m0], refs.slice(0, 2));
    const fits = await walkArchive(locator(again, 2), DEPLOYMENT, arweave([m0, again]).source, {
      contracts: [BOARD],
      maxEvidence: 3,
    });
    expect(fits.findings).toEqual([]);
    expect(fits.evidence).toHaveLength(3);
  });

  test("the evidence budget bounds what is kept, whatever the manifests list", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.tuple(fc.nat(3), fc.nat(5), fc.nat(2)), { maxLength: 6 }), {
          minLength: 1,
          maxLength: 4,
        }),
        fc.integer({ min: 1, max: 8 }),
        async (lists, maxEvidence) => {
          const chain: Stored[] = [];
          // Every distinct (reference, transaction) pair the manifests list.
          const all = new Set<string>();
          for (const [i, list] of lists.entries()) {
            // One reference per block and record in a manifest, as the codec has it.
            const unique = new Map(
              list.map(([block, n, t]) => [
                `${block}:${n}`,
                ref(BOARD, BigInt(block), n, tx(6000 + t)),
              ]),
            );
            for (const r of unique.values())
              all.add(`${r.l2_block}:${bytesToHex(r.cid)}:${bytesToHex(r.transaction)}`);
            chain.push(manifest(2, BigInt(i), chain.slice(-1), [...unique.values()]));
          }
          const top = chain.at(-1) as Stored;
          const walk = await walkArchive(locator(top, 2), DEPLOYMENT, arweave(chain).source, {
            contracts: [BOARD],
            maxEvidence,
          });
          const kept = walk.evidence.reduce((n, e) => n + e.transactions.length, 0);
          expect(kept).toBeLessThanOrEqual(maxEvidence);
          // Every kept listing is distinct, and its transactions too.
          const keys = walk.evidence.map((e) => `${e.l2Block}:${bytesToHex(e.cid)}`);
          expect(new Set(keys).size).toBe(keys.length);
          for (const e of walk.evidence)
            expect(new Set(e.transactions.map(bytesToHex)).size).toBe(e.transactions.length);
          // Every distinct pair is kept unless the budget says it ran out.
          if (all.size <= maxEvidence) {
            expect(kept).toBe(all.size);
            expect(codes(walk.findings)).toEqual([]);
          } else expect(codes(walk.findings)).toEqual(["evidence-over-budget"]);
        },
      ),
      { numRuns },
    );
  });

  test("an earlier locator of either version is read under the version it fixes", async () => {
    const m0 = manifest(1, 0n, []);
    const m1 = manifest(1, 1n, [m0]);
    // The authority moved to version 2 and lost manifest 1 from its links;
    // the version-1 locator logged for it still reaches it.
    const m2 = manifest(2, 2n, [m0], [ref(BOARD, 10n, 1)]);
    const walk = await walkArchive(locator(m2, 2), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      earlier: [locator(m0, 1), locator(m1, 1)],
    });
    expect(walk.findings).toEqual([{ code: "earlier-only", first: 1n, last: 1n }]);
    // Under the wrong version, it is the bytes' fault and nothing is followed.
    const wrong = await walkArchive(locator(m2, 2), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      earlier: [locator(m1, 2)],
    });
    expect(wrong.findings).toEqual([
      { code: "manifest-malformed", from: { locator: 0 }, cid: m1.cid },
      { code: "archive-gap", first: 1n, last: 1n },
    ]);
  });

  test("an earlier version-2 locator's chain may link version 1 below a version-1 latest", async () => {
    const m0 = manifest(1, 0n, []);
    const m1 = manifest(2, 1n, [m0], [ref(BOARD, 10n, 1)]);
    // A version-1 latest at 2 that cut 1 off: the earlier locator reaches it.
    const m2 = manifest(1, 2n, [m0]);
    const walk = await walkArchive(locator(m2, 1), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      earlier: [locator(m1, 2)],
      contracts: [BOARD],
    });
    expect(walk.findings).toEqual([{ code: "earlier-only", first: 1n, last: 1n }]);
    expect(walk.evidence.map((e) => e.l2Block)).toEqual([10n]);
  });

  test("a version-3 locator is reported, never guessed", async () => {
    const m0 = manifest(2, 0n, []);
    const bytes = locator(m0, 2);
    bytes[1] = 3;
    const { source, asked } = arweave([m0]);
    const walk = await walkArchive(bytes, DEPLOYMENT, source);
    expect(walk.findings).toEqual([{ code: "locator-version", locator: "latest", version: 3 }]);
    expect(asked).toEqual([]);
  });

  test("needs 20-byte contracts and a positive evidence budget", async () => {
    const m0 = manifest(2, 0n, []);
    const { source } = arweave([m0]);
    await expect(
      walkArchive(locator(m0, 2), DEPLOYMENT, source, { contracts: [BOARD.subarray(1)] }),
    ).rejects.toThrow(RangeError);
    for (const maxEvidence of [0, -1, 1.5, Number.NaN])
      await expect(
        walkArchive(locator(m0, 2), DEPLOYMENT, source, { maxEvidence }),
      ).rejects.toThrow(RangeError);
    expect(DEFAULT_EVIDENCE_BUDGET).toBe(65_536);
  });
});
