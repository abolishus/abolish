import {
  type ArchiveManifest,
  encodeArchiveLocator,
  encodeArchiveManifest,
  MANIFEST_BOUND,
  objectCar,
  objectCid,
} from "@abolishus/crypto";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  type ArchiveFinding,
  decodeHeader,
  latestLocatorFromState,
  MANIFEST_DATA_LIMIT,
  NodePool,
  type TransactionSource,
  walkArchive,
} from "../src/index.ts";
import { anchorState, stored, word } from "./state.ts";

// The chain from a locator (docs/spec/archive.md, The chain from a locator;
// verifier 4.3): manifests written here through packages/crypto's encoder
// (vectored by archive.json), archived as their CARs under made-up
// transaction IDs, and served by a scripted Arweave source.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CHAIN = 11_155_111n;
const ANCHOR = new Uint8Array(20).fill(0xa0);
const DEPLOYMENT = { l1ChainId: CHAIN, anchor: ANCHOR };

const tx = (n: number) => {
  const t = new Uint8Array(32);
  t[0] = 0x7a;
  t[28] = n >>> 24;
  t[29] = (n >>> 16) & 0xff;
  t[30] = (n >>> 8) & 0xff;
  t[31] = n & 0xff;
  return t;
};

const object = (n: number) => objectCid(Uint8Array.of(0x0b, n & 0xff, n >> 8));

interface Stored {
  readonly manifest: ArchiveManifest;
  readonly cid: Uint8Array;
  readonly transaction: Uint8Array;
  readonly bytes: Uint8Array;
}

function manifest(
  sequence: bigint,
  links: readonly Stored[],
  extra: Partial<ArchiveManifest> = {},
  transaction = tx(Number(sequence)),
): Stored {
  const m: ArchiveManifest = {
    l1_chain_id: CHAIN,
    anchor: ANCHOR,
    sequence,
    objects: links.length === 0 ? [{ cid: object(Number(sequence)), transaction: tx(9000) }] : [],
    links: links
      .map((l) => ({ sequence: l.manifest.sequence, cid: l.cid, transaction: l.transaction }))
      .sort((a, b) => (a.sequence < b.sequence ? -1 : 1)),
    ...extra,
  };
  const bytes = encodeArchiveManifest(m);
  return { manifest: m, cid: objectCid(bytes), transaction, bytes };
}

// A source holding each stored object's CAR under its transaction, and any
// extra answers given for a transaction (tried first).
function arweave(
  stored: readonly Stored[],
  extra: ReadonlyMap<string, readonly Uint8Array[]> = new Map(),
) {
  const held = new Map<string, Uint8Array[]>();
  for (const s of stored) held.set(bytesToHex(s.transaction), [objectCar(s.bytes)]);
  const asked: string[] = [];
  const source: TransactionSource = async (t, limit) => {
    expect(limit).toBe(MANIFEST_DATA_LIMIT);
    asked.push(bytesToHex(t));
    return [...(extra.get(bytesToHex(t)) ?? []), ...(held.get(bytesToHex(t)) ?? [])];
  };
  return { source, asked };
}

const locatorOf = (s: Stored) => encodeArchiveLocator(s.cid, s.transaction);
const codes = (f: readonly ArchiveFinding[]) => f.map((x) => x.code);

describe("walkArchive", () => {
  test("reaches every manifest of a chain from the latest locator", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    const m2 = manifest(2n, [m1]);
    const m3 = manifest(3n, [m2]);
    const { source } = arweave([m0, m1, m2, m3]);
    const walk = await walkArchive(locatorOf(m3), DEPLOYMENT, source);
    expect(walk.findings).toEqual([]);
    expect(walk.latest).toBe(3n);
    expect(walk.reads).toBe(4);
    expect(walk.manifests.map((m) => [m.sequence, bytesToHex(m.cid)])).toEqual(
      [m0, m1, m2, m3].map((m) => [m.manifest.sequence, bytesToHex(m.cid)]),
    );
  });

  test("the manifest data limit is a one-chunk object's CAR", () => {
    expect(objectCar(new Uint8Array(MANIFEST_BOUND)).length).toBe(MANIFEST_DATA_LIMIT);
  });

  test("reports unreached sequences as ranges, and the links it couldn't read", async () => {
    const m1 = manifest(1n, []);
    const m4 = manifest(4n, []);
    const m5 = manifest(5n, [m1, m4]);
    const lost = manifest(6n, []);
    const m7 = manifest(7n, [m5, lost]);
    const { source } = arweave([m1, m4, m5, m7]);
    const walk = await walkArchive(locatorOf(m7), DEPLOYMENT, source);
    expect(walk.findings).toEqual([
      { code: "unavailable", from: { link: 6n }, cid: lost.cid, transaction: lost.transaction },
      { code: "archive-gap", first: 0n, last: 0n },
      { code: "archive-gap", first: 2n, last: 3n },
      { code: "archive-gap", first: 6n, last: 6n },
    ]);
    expect(walk.manifests.map((m) => m.sequence)).toEqual([1n, 4n, 5n, 7n]);
  });

  test("a manifest posted again under a new transaction is read from either", async () => {
    const m0 = manifest(0n, []);
    const again = { ...m0, transaction: tx(500) };
    const m1 = manifest(1n, [m0]);
    const m2 = manifest(2n, [again, m1]);
    // Only the second upload is served; the first link to 0 is m2's.
    const { source, asked } = arweave([again, m1, m2]);
    const walk = await walkArchive(locatorOf(m2), DEPLOYMENT, source);
    expect(walk.findings).toEqual([]);
    expect(walk.manifests.map((m) => m.sequence)).toEqual([0n, 1n, 2n]);
    // Once 0 is reached, m1's link to it isn't read again.
    expect(asked).toEqual([m2, again, m1].map((m) => bytesToHex(m.transaction)));

    // Both uploads lost: each transaction tried is reported.
    const lost = await walkArchive(locatorOf(m2), DEPLOYMENT, arweave([m1, m2]).source);
    expect(lost.findings).toEqual([
      { code: "unavailable", from: { link: 0n }, cid: m0.cid, transaction: again.transaction },
      { code: "unavailable", from: { link: 0n }, cid: m0.cid, transaction: m0.transaction },
      { code: "archive-gap", first: 0n, last: 0n },
    ]);
  });

  test("a second link naming another CID for a sequence is a conflict, and never read", async () => {
    const m0 = manifest(0n, []);
    const other = manifest(0n, [], { objects: [{ cid: object(77), transaction: tx(1) }] }, tx(600));
    const m1 = manifest(1n, [other]);
    const m2 = manifest(2n, [m0, m1]);
    const { source, asked } = arweave([m0, other, m1, m2]);
    const walk = await walkArchive(locatorOf(m2), DEPLOYMENT, source);
    expect(walk.findings).toEqual([
      { code: "link-conflict", sequence: 0n, claimed: m0.cid, named: other.cid },
    ]);
    expect(asked).not.toContain(bytesToHex(other.transaction));
    expect(walk.manifests.map((m) => bytesToHex(m.cid))).toEqual(
      [m0, m1, m2].map((m) => bytesToHex(m.cid)),
    );
  });

  test("a linked manifest at another sequence than its link's is refused and not followed", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    // m2 claims m1 is at sequence 0.
    const m2 = manifest(2n, [], {
      objects: [],
      links: [{ sequence: 0n, cid: m1.cid, transaction: m1.transaction }],
    });
    const walk = await walkArchive(locatorOf(m2), DEPLOYMENT, arweave([m0, m1, m2]).source);
    expect(walk.findings).toEqual([
      { code: "link-sequence", sequence: 0n, cid: m1.cid, found: 1n },
      { code: "archive-gap", first: 0n, last: 1n },
    ]);
    expect(walk.reads).toBe(2);
  });

  test("a manifest of another deployment is reported and never followed", async () => {
    const m0 = manifest(0n, []);
    for (const extra of [{ l1_chain_id: 1n }, { anchor: new Uint8Array(20).fill(0xa1) }]) {
      const foreign = manifest(1n, [m0], extra);
      const m2 = manifest(2n, [foreign]);
      const walk = await walkArchive(locatorOf(m2), DEPLOYMENT, arweave([m0, foreign, m2]).source);
      expect(walk.findings).toEqual([
        {
          code: "manifest-foreign",
          from: { link: 1n },
          cid: foreign.cid,
          l1ChainId: foreign.manifest.l1_chain_id,
          anchor: foreign.manifest.anchor,
        },
        { code: "archive-gap", first: 0n, last: 1n },
      ]);
      // The latest itself: nothing is reached, so no gap can be told.
      const top = await walkArchive(locatorOf(foreign), DEPLOYMENT, arweave([m0, foreign]).source);
      expect(codes(top.findings)).toEqual(["manifest-foreign"]);
      expect(top.latest).toBeUndefined();
      expect(top.manifests).toEqual([]);
    }
  });

  test("an archived object that isn't a manifest is malformed, whatever else is served", async () => {
    const bytes = Uint8Array.of(1, 2, 3);
    const junk: Stored = {
      manifest: manifest(0n, []).manifest,
      cid: objectCid(bytes),
      transaction: tx(700),
      bytes,
    };
    const m1 = manifest(1n, [junk]);
    const walk = await walkArchive(locatorOf(m1), DEPLOYMENT, arweave([junk, m1]).source);
    expect(walk.findings).toEqual([
      { code: "manifest-malformed", from: { link: 0n }, cid: junk.cid },
      { code: "archive-gap", first: 0n, last: 0n },
    ]);
  });

  test("a source's data that doesn't read as the CID is skipped for the next answer", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    const car = objectCar(m0.bytes);
    const flipped = Uint8Array.from(car);
    flipped[flipped.length - 1] = (flipped.at(-1) as number) ^ 1;
    const extra = new Map([
      [
        bytesToHex(m0.transaction),
        [
          objectCar(m1.bytes),
          flipped,
          Uint8Array.from([...car, 0]),
          new Uint8Array(MANIFEST_DATA_LIMIT + 1),
        ],
      ],
    ]);
    const walk = await walkArchive(locatorOf(m1), DEPLOYMENT, arweave([m0, m1], extra).source);
    expect(walk.findings).toEqual([]);
    expect(walk.reads).toBe(2);
    // With only the bad answers, the link is unavailable.
    const bad = arweave([m1], extra);
    const lost = await walkArchive(locatorOf(m1), DEPLOYMENT, bad.source);
    expect(codes(lost.findings)).toEqual(["unavailable", "archive-gap"]);
  });

  test("a locator it can't follow is reported and nothing is read", async () => {
    const m0 = manifest(0n, []);
    const good = locatorOf(m0);
    const dagPb = Uint8Array.from(good);
    dagPb[3] = 0x70;
    const cases: [Uint8Array, ArchiveFinding][] = [
      [
        Uint8Array.of(0, 2, ...good.subarray(2)),
        { code: "locator-version", locator: "latest", version: 2 },
      ],
      [good.subarray(0, 69), { code: "locator-length", locator: "latest" }],
      [dagPb, { code: "locator-cid", locator: "latest" }],
      [Uint8Array.of(0, 0, 1), { code: "locator-framing", locator: "latest" }],
      [new Uint8Array(129).fill(1), { code: "locator-framing", locator: "latest" }],
    ];
    for (const [locator, finding] of cases) {
      const { source, asked } = arweave([m0]);
      const walk = await walkArchive(locator, DEPLOYMENT, source);
      expect(walk.findings).toEqual([finding]);
      expect(asked).toEqual([]);
      expect(walk.latest).toBeUndefined();
    }
    const missing = await walkArchive(good, DEPLOYMENT, arweave([]).source);
    expect(missing.findings).toEqual([
      {
        code: "unavailable",
        from: { locator: "latest" },
        cid: m0.cid,
        transaction: m0.transaction,
      },
    ]);
  });

  test("stops at its budget, unverifiable, with no gap or unavailable link reported", async () => {
    const chain: Stored[] = [manifest(0n, [])];
    for (let s = 1n; s < 6n; s++) chain.push(manifest(s, [chain.at(-1) as Stored]));
    const lost = manifest(9n, []);
    const top = manifest(10n, [chain.at(-1) as Stored, lost]);
    const { source } = arweave([...chain, top]);
    const walk = await walkArchive(locatorOf(top), DEPLOYMENT, source, { maxManifests: 3 });
    expect(walk.findings).toEqual([{ code: "over-budget", budget: 3 }]);
    // It stops once the reads queued can't fit, before making them.
    expect(walk.reads).toBe(2);
    const whole = await walkArchive(locatorOf(top), DEPLOYMENT, source, { maxManifests: 8 });
    expect(whole.findings).toEqual([
      { code: "unavailable", from: { link: 9n }, cid: lost.cid, transaction: lost.transaction },
      { code: "archive-gap", first: 6n, last: 9n },
    ]);
    for (const maxManifests of [0, -1, 1.5, Number.NaN])
      await expect(
        walkArchive(locatorOf(top), DEPLOYMENT, source, { maxManifests }),
      ).rejects.toThrow(RangeError);
    await expect(
      walkArchive(locatorOf(top), { l1ChainId: CHAIN, anchor: ANCHOR.subarray(1) }, source),
    ).rejects.toThrow(RangeError);
  });

  test("checks earlier locators against the chain it reached", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    const m2 = manifest(2n, [m1]);
    // A manifest 1 the chain doesn't hold, one past the latest (the locator
    // was rolled back), one never served, and one of another deployment.
    const fork = manifest(1n, [m0], { objects: [{ cid: object(5), transaction: tx(5) }] }, tx(801));
    const ahead = manifest(3n, [m2], {}, tx(803));
    const gone = manifest(1n, [], {}, tx(804));
    const foreign = manifest(1n, [m0], { l1_chain_id: 1n }, tx(805));
    const { source } = arweave([m0, m1, m2, fork, ahead, foreign]);
    const earlier = [
      locatorOf(m0),
      locatorOf(fork),
      Uint8Array.of(0, 9, 9),
      locatorOf(ahead),
      locatorOf(gone),
      locatorOf(foreign),
      locatorOf(m2),
    ];
    const walk = await walkArchive(locatorOf(m2), DEPLOYMENT, source, { earlier });
    expect(walk.findings).toEqual([
      { code: "locator-version", locator: 2, version: 9 },
      { code: "locator-mismatch", locator: 1, sequence: 1n, named: fork.cid, chain: m1.cid },
      { code: "locator-mismatch", locator: 3, sequence: 3n, named: ahead.cid, chain: undefined },
      { code: "unavailable", from: { locator: 4 }, cid: gone.cid, transaction: gone.transaction },
      {
        code: "manifest-foreign",
        from: { locator: 5 },
        cid: foreign.cid,
        l1ChainId: 1n,
        anchor: ANCHOR,
      },
    ]);
    // Matching locators cost no read.
    expect(walk.reads).toBe(3 + 4);

    // Out of budget among the earlier locators: the chain's own reports stand.
    const short = await walkArchive(locatorOf(m2), DEPLOYMENT, source, {
      earlier,
      maxManifests: 4,
    });
    expect(codes(short.findings)).toEqual(["locator-version", "locator-mismatch", "over-budget"]);

    // No chain reached: earlier locators aren't judged.
    const none = await walkArchive(locatorOf(gone), DEPLOYMENT, source, { earlier });
    expect(codes(none.findings)).toEqual(["unavailable"]);
  });

  test("keeps every listing of the objects asked about", async () => {
    const a = object(1000);
    const b = object(1001);
    const m0 = manifest(0n, [], {
      objects: [
        { cid: a, transaction: tx(1) },
        { cid: b, transaction: tx(2) },
      ].sort((x, y) => (bytesToHex(x.cid) < bytesToHex(y.cid) ? -1 : 1)),
    });
    const m1 = manifest(1n, [m0], { objects: [{ cid: a, transaction: tx(3) }] });
    const walk = await walkArchive(locatorOf(m1), DEPLOYMENT, arweave([m0, m1]).source, {
      objects: [a, object(1002)],
    });
    expect([...walk.listings].map(([k, v]) => [k, v.map(bytesToHex)])).toEqual([
      [bytesToHex(a), [tx(3), tx(1)].map(bytesToHex)],
      [bytesToHex(object(1002)), []],
    ]);
  });

  test("a sequence whose bytes were refused is never read again under another transaction", async () => {
    const bytes = Uint8Array.of(4, 5, 6);
    const junk: Stored = {
      manifest: manifest(0n, []).manifest,
      cid: objectCid(bytes),
      transaction: tx(710),
      bytes,
    };
    const again = { ...junk, transaction: tx(711) };
    const m1 = manifest(1n, [junk]);
    const m2 = manifest(2n, [again, m1]);
    const { source, asked } = arweave([junk, again, m1, m2]);
    const walk = await walkArchive(locatorOf(m2), DEPLOYMENT, source);
    expect(codes(walk.findings)).toEqual(["manifest-malformed", "archive-gap"]);
    expect(asked).not.toContain(bytesToHex(junk.transaction));
  });

  test("a link a source lapsed on, then reached through an earlier locator, is the chain's", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    const m2 = manifest(2n, [m1]);
    // m1 is served only on its second request, and under a second upload.
    const reupload = { ...m1, transaction: tx(901) };
    for (const second of [m1, reupload]) {
      let first = true;
      const held = arweave([m0, second, m2]);
      const source: TransactionSource = async (t, limit) => {
        if (first && bytesToHex(t) === bytesToHex(m1.transaction)) {
          first = false;
          return [];
        }
        return held.source(t, limit);
      };
      const walk = await walkArchive(locatorOf(m2), DEPLOYMENT, source, {
        earlier: [locatorOf(second)],
      });
      // Never a mismatch: the locator names the chain's own manifest 1. Read
      // under a new transaction it reaches 1 and 0, which the latest's chain
      // alone doesn't, with the link's transaction still unserved; under the
      // link's, already read, it is still unavailable.
      if (second === m1) expect(codes(walk.findings)).toEqual(["unavailable", "archive-gap"]);
      else {
        expect(walk.findings).toEqual([
          { code: "unavailable", from: { link: 1n }, cid: m1.cid, transaction: m1.transaction },
          { code: "earlier-only", first: 0n, last: 1n },
        ]);
        expect(walk.manifests.map((m) => m.sequence)).toEqual([0n, 1n, 2n]);
      }
    }
  });

  test("earlier locators below a withheld link are followed, never mismatched", async () => {
    const chain: Stored[] = [manifest(0n, [])];
    for (let k = 1n; k <= 10n; k++) chain.push(manifest(k, [chain.at(-1) as Stored]));
    const nine = chain[9] as Stored;
    const { source } = arweave(chain.filter((m) => m !== nine));
    const walk = await walkArchive(locatorOf(chain[10] as Stored), DEPLOYMENT, source, {
      earlier: chain.slice(0, 10).map(locatorOf),
    });
    // Only 9 is missing: 8 down to 0 are reached from the earlier locators,
    // and reported as such.
    expect(walk.findings).toEqual([
      { code: "unavailable", from: { link: 9n }, cid: nine.cid, transaction: nine.transaction },
      { code: "archive-gap", first: 9n, last: 9n },
      { code: "earlier-only", first: 0n, last: 8n },
    ]);
    expect(walk.manifests.map((m) => m.sequence)).toEqual([
      0n,
      1n,
      2n,
      3n,
      4n,
      5n,
      6n,
      7n,
      8n,
      10n,
    ]);
  });

  test("an earlier locator is judged against the whole chain, whatever the locators' order", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    const m2 = manifest(2n, [m1]);
    const reupload = { ...m1, transaction: tx(901) };
    // m1's first upload is withheld; its second is named only by the later locator.
    const { source } = arweave([m0, reupload, m2]);
    for (const earlier of [
      [locatorOf(m0), locatorOf(reupload)],
      [locatorOf(reupload), locatorOf(m0)],
    ]) {
      const walk = await walkArchive(locatorOf(m2), DEPLOYMENT, source, { earlier });
      expect(walk.findings).toEqual([
        { code: "unavailable", from: { link: 1n }, cid: m1.cid, transaction: m1.transaction },
        { code: "earlier-only", first: 0n, last: 1n },
      ]);
      expect(walk.manifests.map((m) => m.sequence)).toEqual([0n, 1n, 2n]);
    }
  });

  test("a read an earlier locator made for the chain's manifest is reported as the locator's", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    const reupload = { ...m0, transaction: tx(902) };
    const walk = await walkArchive(locatorOf(m1), DEPLOYMENT, arweave([m1]).source, {
      earlier: [locatorOf(reupload)],
    });
    expect(walk.findings).toEqual([
      { code: "unavailable", from: { link: 0n }, cid: m0.cid, transaction: m0.transaction },
      { code: "unavailable", from: { locator: 0 }, cid: m0.cid, transaction: reupload.transaction },
      { code: "archive-gap", first: 0n, last: 0n },
    ]);
  });

  test("an honest archive is never reported overwritten, whatever a source withholds", async () => {
    // A linear honest chain, each manifest also uploaded a second time; a
    // source withholding any uploads; and every manifest's locator, under
    // either upload, given in any order.
    const arb = fc.integer({ min: 2, max: 10 }).chain((n) =>
      fc.record({
        n: fc.constant(n),
        withheld: fc.array(fc.integer({ min: 0, max: 2 * n - 1 }), { maxLength: 2 * n }),
        earlier: fc.shuffledSubarray(
          Array.from({ length: 2 * n }, (_, k) => k),
          { minLength: 0 },
        ),
      }),
    );
    await fc.assert(
      fc.asyncProperty(arb, async ({ n, withheld, earlier }) => {
        const chain: Stored[] = [manifest(0n, [])];
        for (let k = 1; k < n; k++) chain.push(manifest(BigInt(k), [chain.at(-1) as Stored]));
        const second = chain.map((m, k) => ({ ...m, transaction: tx(50_000 + k) }));
        const uploads = [...chain, ...second];
        const top = chain.at(-1) as Stored;
        const served = uploads.filter((u, k) => u === top || !withheld.includes(k));
        const walk = await walkArchive(locatorOf(top), DEPLOYMENT, arweave(served).source, {
          earlier: earlier.map((k) => locatorOf(uploads[k] as Stored)),
        });
        expect(codes(walk.findings)).not.toContain("locator-mismatch");
        expect(codes(walk.findings)).not.toContain("link-conflict");
      }),
      { numRuns },
    );
  });

  test("a manifest the latest's chain omits is reported as reached only from an earlier locator", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    // 3 skips 2, which an earlier locator named, and every link was read.
    const m2 = manifest(2n, [m1]);
    const m3 = manifest(3n, [m1]);
    const walk = await walkArchive(locatorOf(m3), DEPLOYMENT, arweave([m0, m1, m2, m3]).source, {
      earlier: [locatorOf(m1), locatorOf(m2)],
    });
    expect(walk.findings).toEqual([{ code: "earlier-only", first: 2n, last: 2n }]);
  });

  test("an authority's dead link to the chain is reported, though earlier locators reach past it", async () => {
    // The authority posts X at 4, linking the genuine 3 under a transaction
    // nothing holds, and points the anchor's locator at it.
    const chain: Stored[] = [manifest(0n, [])];
    for (let k = 1n; k <= 3n; k++) chain.push(manifest(k, [chain.at(-1) as Stored]));
    const three = chain[3] as Stored;
    const x = manifest(4n, [{ ...three, transaction: tx(66_666) }]);
    const walk = await walkArchive(locatorOf(x), DEPLOYMENT, arweave([...chain, x]).source, {
      earlier: chain.map(locatorOf),
    });
    expect(walk.findings).toEqual([
      { code: "unavailable", from: { link: 3n }, cid: three.cid, transaction: tx(66_666) },
      { code: "earlier-only", first: 0n, last: 3n },
    ]);
  });

  test("a repeated earlier locator is judged once", async () => {
    const m0 = manifest(0n, []);
    const m1 = manifest(1n, [m0]);
    const fork = manifest(1n, [m0], { objects: [{ cid: object(6), transaction: tx(6) }] }, tx(811));
    const { source } = arweave([m0, m1, fork]);
    const walk = await walkArchive(locatorOf(m1), DEPLOYMENT, source, {
      earlier: [locatorOf(fork), locatorOf(m0), locatorOf(fork)],
    });
    expect(codes(walk.findings)).toEqual(["locator-mismatch"]);
    expect(walk.reads).toBe(3);
  });

  test("a wide tree stops at once, its queue no longer than the reads left", async () => {
    const leaves = Array.from({ length: 1024 }, (_, i) =>
      manifest(BigInt(i), [], {}, tx(20_000 + i)),
    );
    const root = manifest(5000n, leaves);
    const { source, asked } = arweave([root, ...leaves]);
    const walk = await walkArchive(locatorOf(root), DEPLOYMENT, source, { maxManifests: 10 });
    expect(walk.findings).toEqual([{ code: "over-budget", budget: 10 }]);
    expect(walk.reads).toBe(1);
    expect(asked.length).toBe(1);
    // A conflict is reported once per sequence however many links name it.
    const others = Array.from({ length: 3 }, (_, i) =>
      manifest(0n, [], { objects: [{ cid: object(300 + i), transaction: tx(1) }] }, tx(30_000 + i)),
    );
    const m0 = leaves[0] as Stored;
    // Four manifests each link sequence 0, three of them to another CID.
    const mids = [m0, ...others].map((o, k) => manifest(BigInt(1 + k), [o]));
    const top = manifest(10n, mids);
    const conflicts = await walkArchive(
      locatorOf(top),
      DEPLOYMENT,
      arweave([m0, ...mids, top]).source,
    );
    expect(codes(conflicts.findings).filter((c) => c === "link-conflict")).toEqual([
      "link-conflict",
    ]);
  });

  test("reports exactly the sequences no available path reaches", async () => {
    // A random archive: manifest k links a random subset of the manifests
    // below it, some uploads are lost, and the expected reach is a plain
    // search over the links of the manifests served.
    const arb = fc.integer({ min: 1, max: 12 }).chain((n) =>
      fc.record({
        links: fc.array(fc.array(fc.boolean(), { minLength: n, maxLength: n }), {
          minLength: n,
          maxLength: n,
        }),
        lost: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(arb, async ({ links, lost }) => {
        const n = links.length;
        const all: Stored[] = [];
        for (let k = 0; k < n; k++)
          all.push(
            manifest(
              BigInt(k),
              all.filter((_, j) => j < k && (links[k] as boolean[])[j] === true),
            ),
          );
        const top = n - 1;
        const served = all.filter((_, k) => k === top || lost[k] !== true);
        const reach = new Set<number>([top]);
        for (let k = top; k >= 0; k--)
          if (reach.has(k) && (k === top || lost[k] !== true))
            for (let j = 0; j < k; j++) if ((links[k] as boolean[])[j] === true) reach.add(j);
        const ok = [...reach].filter((k) => k === top || lost[k] !== true);
        const walk = await walkArchive(
          locatorOf(all[top] as Stored),
          DEPLOYMENT,
          arweave(served).source,
        );
        expect(walk.manifests.map((m) => Number(m.sequence))).toEqual(ok.sort((a, b) => a - b));
        const gaps = new Set<number>();
        for (const f of walk.findings)
          if (f.code === "archive-gap")
            for (let s = Number(f.first); s <= Number(f.last); s++) gaps.add(s);
        expect([...gaps].sort((a, b) => a - b)).toEqual(
          [...Array(n).keys()].filter((k) => !ok.includes(k)),
        );
        const unavailable = walk.findings.filter((f) => f.code === "unavailable");
        expect(unavailable.length).toBe([...reach].filter((k) => !ok.includes(k)).length);
        expect(walk.reads).toBe(reach.size);
      }),
      { numRuns },
    );
  });
});

describe("latestLocatorFromState", () => {
  const A = 0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00n;
  // keccak256(abi.encode(A + 2)), by `cast keccak` (Foundry 1.8.5).
  const DATA = 0x98e4c54e8fbc2d40e1a48de253a98da3caaf11e620b9ccfdfa738212a2915a9an;
  const state = (entries: readonly (readonly [Uint8Array, Uint8Array])[]) => {
    const { header, nodes } = anchorState(ANCHOR, entries, { number: 9n, timestamp: 1000n });
    return { header: decodeHeader(header), anchor: ANCHOR, nodes: new NodePool(nodes) };
  };
  const words = (bytes: Uint8Array) => {
    const out: [Uint8Array, Uint8Array][] = [];
    for (let i = 0; i * 32 < bytes.length; i++) {
      const w = new Uint8Array(32);
      w.set(bytes.subarray(i * 32, i * 32 + 32));
      if (w.some((x) => x !== 0)) out.push([word(DATA + BigInt(i)), stored(w)]);
    }
    return out;
  };
  // Solidity's layout for a `bytes` value at A + 2.
  const layout = (bytes: Uint8Array, count: bigint) => {
    const entries: [Uint8Array, Uint8Array][] = [];
    if (count > 0n) entries.push([word(A + 3n), stored(word(count))]);
    if (bytes.length <= 31) {
      const w = new Uint8Array(32);
      w.set(bytes);
      w[31] = 2 * bytes.length;
      if (bytes.length > 0) entries.push([word(A + 2n), stored(w)]);
    } else
      entries.push([word(A + 2n), stored(word(2n * BigInt(bytes.length) + 1n))], ...words(bytes));
    return entries;
  };

  test("reads the latest locator, short or long, and the count", () => {
    // The helper's trie needs a leaf: an unrelated slot.
    const other: [Uint8Array, Uint8Array] = [word(A), stored(word(1n))];
    expect(latestLocatorFromState(state([other]))).toEqual({ kind: "none", count: 0n });
    const m0 = manifest(0n, []);
    for (const bytes of [
      Uint8Array.of(0, 7, 1),
      new Uint8Array(31).fill(0x31),
      new Uint8Array(32).fill(0x32),
      locatorOf(m0),
      Uint8Array.from({ length: 128 }, (_, i) => i + 1),
    ]) {
      expect(latestLocatorFromState(state(layout(bytes, 3n)))).toEqual({
        kind: "locator",
        locator: bytes,
        count: 3n,
      });
    }
  });

  test("any locator length round-trips through Solidity's layout", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 128 }),
        fc.bigInt({ min: 1n, max: (1n << 256n) - 1n }),
        (bytes, count) => {
          expect(latestLocatorFromState(state(layout(bytes, count)))).toEqual({
            kind: "locator",
            locator: bytes,
            count,
          });
        },
      ),
      { numRuns },
    );
  });

  test("a length no locator has is framing, and never reads past 128 bytes", () => {
    const head = (w: Uint8Array) => state([[word(A + 2n), stored(w)]]);
    const empty = new Uint8Array(32);
    empty[0] = 1; // bytes beside a zero length
    expect(latestLocatorFromState(head(empty)).kind).toBe("locator-framing");
    const short = new Uint8Array(32);
    short[31] = 64; // 32 bytes claimed in the short form
    expect(latestLocatorFromState(head(short)).kind).toBe("locator-framing");
    expect(latestLocatorFromState(head(word(2n * 31n + 1n))).kind).toBe("locator-framing");
    // 129 bytes claimed: refused before any data slot is read.
    expect(latestLocatorFromState(head(word(2n * 129n + 1n))).kind).toBe("locator-framing");
    expect(latestLocatorFromState(head(word((1n << 255n) + 1n))).kind).toBe("locator-framing");
    // Nodes the reads need and the proof lacks, and an anchor with no account.
    const proof = state(layout(new Uint8Array(70).fill(9), 1n));
    const pruned = new NodePool([]);
    expect(() => latestLocatorFromState({ ...proof, nodes: pruned })).toThrow(
      expect.objectContaining({ code: "l1-proof-missing" }),
    );
    expect(() =>
      latestLocatorFromState({ ...proof, anchor: new Uint8Array(20).fill(0xa1) }),
    ).toThrow(expect.objectContaining({ code: "l1-anchor-absent" }));
  });
});
