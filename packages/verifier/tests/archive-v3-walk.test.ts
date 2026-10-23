import {
  type ArchiveManifest,
  type ArchiveManifestV2,
  type ArchiveManifestV3,
  encodeArchiveLocator,
  encodeArchiveManifest,
  type EvidenceRef,
  objectCar,
  objectCid,
  type RunRef,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { type ArchiveFinding, MANIFEST_DATA_LIMIT, walkArchive } from "../src/index.ts";

// Version-3 chains (docs/spec/archive.md, The chain from a locator; Layout
// (version 3)): a version-3 locator fixes manifest version 3, whose links
// may name manifests of versions 1 to 3, and the run references of the
// reached manifests, kept for the contracts asked about beside the evidence
// and under the same budget of pairs. Manifests are written through
// packages/crypto's encoder (vectored by archive-v3.json), archived as their
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
const object = (type: number, n: number) => objectCid(Uint8Array.of(0x00, type, 0x01, n & 0xff));

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
const order = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

const run = (
  contract: Uint8Array,
  first: bigint,
  count: number,
  n: number,
  t = tx(5000 + n),
): RunRef => ({
  contract,
  first,
  count,
  cid: object(0x26, n),
  transaction: t,
});
const evidence = (contract: Uint8Array, l2_block: bigint, n: number): EvidenceRef => ({
  contract,
  l2_block,
  cid: object(0x25, n),
  transaction: tx(6000 + n),
});

// A manifest of `version` at `sequence`, linking `links`; a version-2 or 3
// one lists `evidence` and a version-3 one `runs` (sorted as the codec
// needs), and one with nothing else to name lists one object.
function manifest(
  version: 1 | 2 | 3,
  sequence: bigint,
  links: readonly Stored[],
  { runs = [], refs = [] }: { runs?: readonly RunRef[]; refs?: readonly EvidenceRef[] } = {},
): Stored {
  const base: ArchiveManifest = {
    l1_chain_id: CHAIN,
    anchor: ANCHOR,
    sequence,
    objects:
      links.length === 0 && runs.length === 0 && refs.length === 0
        ? [{ cid: objectCid(Uint8Array.of(0x0b, Number(sequence))), transaction: tx(9000) }]
        : [],
    links: links
      .map((l) => ({ sequence: l.sequence, cid: l.cid, transaction: l.transaction }))
      .sort((a, b) => order(a.sequence, b.sequence)),
  };
  const ev = [...refs].sort(
    (a, b) =>
      compare(a.contract, b.contract) || order(a.l2_block, b.l2_block) || compare(a.cid, b.cid),
  );
  const sorted = [...runs].sort(
    (a, b) => compare(a.contract, b.contract) || order(a.first, b.first) || compare(a.cid, b.cid),
  );
  const bytes =
    version === 3
      ? encodeArchiveManifest(
          { ...base, evidence: ev, runs: sorted } satisfies ArchiveManifestV3,
          3,
        )
      : version === 2
        ? encodeArchiveManifest({ ...base, evidence: ev } satisfies ArchiveManifestV2, 2)
        : encodeArchiveManifest(base);
  return { sequence, cid: objectCid(bytes), transaction: tx(Number(sequence)), bytes };
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

const locator = (s: Stored, version: 1 | 2 | 3) =>
  encodeArchiveLocator(s.cid, s.transaction, version);
const codes = (f: readonly ArchiveFinding[]) => f.map((x) => x.code);

describe("walkArchive over version-3 chains", () => {
  test("a version-3 locator's chain reaches manifests of every version", async () => {
    const m0 = manifest(1, 0n, []);
    const m1 = manifest(2, 1n, [m0], { refs: [evidence(BOARD, 10n, 1)] });
    const m2 = manifest(3, 2n, [m0, m1], { runs: [run(BOARD, 0n, 4, 1)] });
    const m3 = manifest(3, 3n, [m2], { runs: [run(BOARD, 4n, 2, 2)] });
    const walk = await walkArchive(locator(m3, 3), DEPLOYMENT, arweave([m0, m1, m2, m3]).source);
    expect(walk.findings).toEqual([]);
    expect(walk.latest).toBe(3n);
    expect(walk.manifests.map((m) => m.sequence)).toEqual([0n, 1n, 2n, 3n]);
    // Nothing was asked about: no listing is kept.
    expect(walk.runs).toEqual([]);
    expect(walk.evidence).toEqual([]);
  });

  test("a version-3 manifest is malformed below a version-1 or version-2 locator", async () => {
    const m0 = manifest(3, 0n, [], { runs: [run(BOARD, 0n, 1, 1)] });
    for (const version of [1, 2] as const) {
      const top = manifest(version, 1n, [m0]);
      const walk = await walkArchive(locator(top, version), DEPLOYMENT, arweave([m0, top]).source);
      expect(walk.findings).toEqual([
        { code: "manifest-malformed", from: { link: 0n }, cid: m0.cid },
        { code: "archive-gap", first: 0n, last: 0n },
      ]);
    }
  });

  test("a locator's manifest must be the version it fixes, exactly", async () => {
    const v2 = manifest(2, 0n, [], { refs: [evidence(BOARD, 10n, 1)] });
    const v3 = manifest(3, 0n, [], { runs: [run(BOARD, 0n, 1, 1)] });
    for (const [named, version] of [
      [v2, 3],
      [v3, 2],
    ] as const) {
      const walk = await walkArchive(locator(named, version), DEPLOYMENT, arweave([named]).source);
      expect(walk.findings).toEqual([
        { code: "manifest-malformed", from: { locator: "latest" }, cid: named.cid },
      ]);
    }
  });

  test("keeps the run references to the contracts asked about, each once, in walk order", async () => {
    const shared = run(BOARD, 0n, 3, 1);
    const m0 = manifest(3, 0n, [], { runs: [shared, run(REGISTRY, 0n, 5, 2)] });
    // The same reference in a later manifest, once under the same
    // transaction and once under a new one (a lost upload posted again).
    const m1 = manifest(3, 1n, [m0], { runs: [shared, run(BOARD, 3n, 1, 3)] });
    const m2 = manifest(3, 2n, [m1], {
      runs: [{ ...shared, transaction: tx(7777) }, run(BOARD, 4n, 2, 4)],
      refs: [evidence(BOARD, 20n, 1)],
    });
    const walk = await walkArchive(locator(m2, 3), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      contracts: [BOARD],
    });
    expect(walk.findings).toEqual([]);
    // Reached from the latest down: m2's references first.
    expect(walk.runs).toEqual([
      {
        contract: BOARD,
        first: 0n,
        count: 3,
        cid: shared.cid,
        transactions: [tx(7777), shared.transaction],
      },
      { contract: BOARD, first: 4n, count: 2, cid: object(0x26, 4), transactions: [tx(5004)] },
      { contract: BOARD, first: 3n, count: 1, cid: object(0x26, 3), transactions: [tx(5003)] },
    ]);
    // The evidence beside them is kept as before.
    expect(walk.evidence.map((e) => e.l2Block)).toEqual([20n]);
    const both = await walkArchive(locator(m2, 3), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      contracts: [REGISTRY, BOARD],
    });
    expect(both.runs.map((r) => [bytesToHex(r.contract), r.first])).toEqual([
      [bytesToHex(BOARD), 0n],
      [bytesToHex(BOARD), 4n],
      [bytesToHex(BOARD), 3n],
      [bytesToHex(REGISTRY), 0n],
    ]);
  });

  test("the same CID claimed at another index or count is another listing", async () => {
    const a = run(BOARD, 0n, 2, 1);
    const m0 = manifest(3, 0n, [], { runs: [a, { ...a, first: 1n }] });
    const m1 = manifest(3, 1n, [m0], { runs: [{ ...a, count: 3 }] });
    const walk = await walkArchive(locator(m1, 3), DEPLOYMENT, arweave([m0, m1]).source, {
      contracts: [BOARD],
    });
    expect(walk.runs.map((r) => [r.first, r.count])).toEqual([
      [0n, 3],
      [0n, 2],
      [1n, 2],
    ]);
  });

  test("evidence and runs share one budget of pairs, and say when it ran out", async () => {
    const m0 = manifest(3, 0n, [], {
      refs: [evidence(BOARD, 1n, 1), evidence(BOARD, 2n, 2)],
      runs: [run(BOARD, 0n, 1, 1), run(BOARD, 1n, 1, 2)],
    });
    const walk = await walkArchive(locator(m0, 3), DEPLOYMENT, arweave([m0]).source, {
      contracts: [BOARD],
      maxEvidence: 3,
    });
    // A manifest's evidence is kept before its runs.
    expect(walk.evidence).toHaveLength(2);
    expect(walk.runs.map((r) => r.first)).toEqual([0n]);
    expect(walk.findings).toEqual([{ code: "evidence-over-budget", budget: 3 }]);
    const fits = await walkArchive(locator(m0, 3), DEPLOYMENT, arweave([m0]).source, {
      contracts: [BOARD],
      maxEvidence: 4,
    });
    expect(fits.findings).toEqual([]);
    expect(fits.runs).toHaveLength(2);
  });

  test("the budget bounds what is kept of either kind, whatever the manifests list", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            runs: fc.array(fc.tuple(fc.nat(3), fc.nat(5), fc.nat(2)), { maxLength: 5 }),
            refs: fc.array(fc.tuple(fc.nat(3), fc.nat(5)), { maxLength: 3 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.integer({ min: 1, max: 10 }),
        async (lists, maxEvidence) => {
          const chain: Stored[] = [];
          // Every distinct (reference, transaction) pair the manifests list.
          const all = new Set<string>();
          for (const [i, list] of lists.entries()) {
            // One reference per index and run (block and record) in a manifest, as the codec has it.
            const runs = [
              ...new Map(
                list.runs.map(([first, n, t]) => [
                  `${first}:${n}`,
                  run(BOARD, BigInt(first), 1 + (n % 3), n, tx(6500 + t)),
                ]),
              ).values(),
            ];
            const refs = [
              ...new Map(
                list.refs.map(([block, n]) => [`${block}:${n}`, evidence(BOARD, BigInt(block), n)]),
              ).values(),
            ];
            for (const r of runs)
              all.add(`r:${r.first}:${r.count}:${bytesToHex(r.cid)}:${bytesToHex(r.transaction)}`);
            for (const r of refs)
              all.add(`e:${r.l2_block}:${bytesToHex(r.cid)}:${bytesToHex(r.transaction)}`);
            chain.push(manifest(3, BigInt(i), chain.slice(-1), { runs, refs }));
          }
          const top = chain.at(-1) as Stored;
          const walk = await walkArchive(locator(top, 3), DEPLOYMENT, arweave(chain).source, {
            contracts: [BOARD],
            maxEvidence,
          });
          const kept =
            walk.runs.reduce((n, r) => n + r.transactions.length, 0) +
            walk.evidence.reduce((n, e) => n + e.transactions.length, 0);
          expect(kept).toBeLessThanOrEqual(maxEvidence);
          const keys = walk.runs.map((r) => `${r.first}:${r.count}:${bytesToHex(r.cid)}`);
          expect(new Set(keys).size).toBe(keys.length);
          for (const r of walk.runs)
            expect(new Set(r.transactions.map(bytesToHex)).size).toBe(r.transactions.length);
          if (all.size <= maxEvidence) {
            expect(kept).toBe(all.size);
            expect(codes(walk.findings)).toEqual([]);
          } else expect(codes(walk.findings)).toEqual(["evidence-over-budget"]);
        },
      ),
      { numRuns },
    );
  });

  test("an earlier version-3 locator is read under version 3, and its runs kept", async () => {
    const m0 = manifest(1, 0n, []);
    const m1 = manifest(3, 1n, [m0], { runs: [run(BOARD, 0n, 2, 1)] });
    // A latest at 2 that cut 1 off: the earlier locator reaches it.
    const m2 = manifest(3, 2n, [m0], { runs: [run(BOARD, 2n, 1, 2)] });
    const walk = await walkArchive(locator(m2, 3), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      earlier: [locator(m1, 3)],
      contracts: [BOARD],
    });
    expect(walk.findings).toEqual([{ code: "earlier-only", first: 1n, last: 1n }]);
    expect(walk.runs.map((r) => r.first)).toEqual([2n, 0n]);
    // Under another version, it is the bytes' fault and nothing is followed.
    const wrong = await walkArchive(locator(m2, 3), DEPLOYMENT, arweave([m0, m1, m2]).source, {
      earlier: [locator(m1, 2)],
      contracts: [BOARD],
    });
    expect(wrong.findings).toEqual([
      { code: "manifest-malformed", from: { locator: 0 }, cid: m1.cid },
      { code: "archive-gap", first: 1n, last: 1n },
    ]);
    expect(wrong.runs.map((r) => r.first)).toEqual([2n]);
  });
});
