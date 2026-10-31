import { sha256 } from "@noble/hashes/sha2.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type Block,
  buildObligationRoot,
  checkDelivery,
  COMMITTED_VOTE,
  CHUNK_SIZE,
  COMPLAINT_PROOF,
  type ComplaintEntry,
  contentDag,
  decode,
  decodeObligationRoot,
  type DeliveryBallot,
  type DeliveryCheck,
  type DeliveryElection,
  type DeliveryEntry,
  type DeliveryRoots,
  encodeObligationRoot,
  FORCED_PATH,
  forcedPathDemand,
  type ForcedPathElection,
  forcedPathFits,
  forcedPathMembersLimit,
  H,
  inclusionProof,
  KEM_PUBLIC_KEY,
  merkleRoot,
  OBLIGATION_TREE,
  obligationInclusionProof,
  obligationRootHash,
  obligationRootStatement,
  objectCid,
  type ObligationRootKind,
  type ReceiptPair,
  signStatement,
  verifyInclusion,
  verifyObligationInclusion,
} from "../src/index.ts";
import { dagWith } from "../src/content-addressing.ts";
import { forcedPathDemandWithRoots, forcedPathFitsWithRoots } from "../src/delivery.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/delivery-root.json comes from an independent Python
// implementation of obligation roots (scripts/delivery-root-vectors.py): the
// tree, the leaf object and its CID, leaf availability, the delivery check
// reading leaves and the forced path for elections that commit roots, so no
// expected value comes from the code under test.

interface Report {
  readonly at: number;
  readonly pair?: number;
  readonly leaf?: number;
  readonly code: string;
  readonly signer?: number | null;
  readonly namedBy?: readonly number[];
  readonly attestedWithout?: readonly number[];
}

interface Decided {
  readonly ballots: readonly {
    readonly ballotHash: string;
    readonly counted: boolean;
    readonly delivered: boolean;
    readonly missing: readonly number[];
    readonly excludedBy: readonly {
      readonly at: number;
      readonly leaf?: number;
      readonly seat: number;
      readonly signer: number | null;
    }[];
  }[];
  readonly records: readonly Report[];
  readonly rejected: readonly { readonly at: number; readonly error: string }[];
}

interface ElectionVector {
  readonly id: string;
  readonly registered: readonly number[];
  readonly threshold: number;
  readonly bound: number;
  readonly segments: { readonly delivery: string; readonly complaint: string };
  readonly deadlines: { readonly delivery: string; readonly complaint: string };
  readonly ballots: readonly {
    readonly tier: number;
    readonly nullifier: string;
    readonly committedVote: string;
  }[];
  readonly entries: readonly (
    | { readonly path: "board"; readonly segment: number; readonly payload: string }
    | { readonly path: "contract"; readonly submittedAt: string; readonly payload: string }
  )[];
  readonly attestations: readonly { readonly seat: number; readonly roots: readonly string[] }[];
  readonly leafObjects: readonly { readonly cid: string; readonly object: string }[];
  readonly result: Decided | { readonly unverifiable: readonly { readonly at: number }[] };
}

interface Interval {
  readonly start: string;
  readonly end: string;
  readonly gas: string;
}

interface CapacityElection {
  /** Absent for a rolling election, which has no `M`. */
  readonly members?: string;
  readonly rolling?: true;
  readonly seats: string;
  readonly closesAt: string;
  readonly l1InclusionBound: string;
  readonly commitsRoots: boolean;
  readonly receipts: Interval;
  readonly complaints: Interval;
}

interface Windows {
  readonly contractEventWindow: string;
  readonly forcedInclusion: string;
  readonly margin: string;
}

interface Vectors {
  readonly format: string;
  readonly tag: string;
  readonly recordHashTag: string;
  readonly leafTag: string;
  readonly nodeTag: string;
  readonly rootCallGas: string;
  readonly definitionHash: string;
  readonly panel: readonly {
    readonly seat: number;
    readonly kemKey: string;
    readonly signingSecret: string;
    readonly signingKey: string;
  }[];
  readonly records: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly seat: number;
    readonly kind: ObligationRootKind;
    readonly count: number;
    readonly root: string;
    readonly leavesCid: string;
    readonly statement: string;
    readonly recordHash: string;
    readonly objectLength: number;
    readonly objectSha256: string;
    readonly leafObject?: string;
    readonly leafHashes?: readonly string[];
  }[];
  readonly proofs: readonly {
    readonly id: string;
    readonly size: number;
    readonly index: number;
    readonly leaf: string;
    readonly root: string;
    readonly path: readonly string[];
    readonly valid: boolean;
  }[];
  readonly elections: readonly ElectionVector[];
  readonly capacity: readonly {
    readonly id: string;
    readonly windows: Windows;
    readonly elections: readonly CapacityElection[];
    readonly fits: boolean;
  }[];
  readonly limits: readonly { readonly seats: number; readonly membersLimit: string }[];
}

const V = JSON.parse(readFileSync(new URL("delivery-root.json", SPEC_VECTORS), "utf8")) as Vectors;
const bytesHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const DEFINITION = hex(V.definitionHash);
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run is a whole delivery check, its P-256, ML-KEM and ristretto255
// checks in JavaScript, so these properties scale their runs down.
const slowRuns = Math.max(10, Math.ceil(numRuns / 20));
const utf8 = (s: string) => new TextEncoder().encode(s);

const secretOf = (seat: number) => {
  const s = V.panel.find((p) => p.seat === seat)?.signingSecret;
  if (s === undefined) throw new Error(`no seat ${seat}`);
  return hex(s);
};

// The leaves of a leaf object as the node's builder takes them.
function leavesOf(kind: ObligationRootKind, object: Uint8Array): ReceiptPair[] | ComplaintEntry[] {
  const size = kind === 1 ? 64 : 128;
  const out = [];
  for (let j = 0; j < object.length / size; j++)
    out.push(object.subarray(size * j, size * (j + 1)));
  return kind === 1
    ? out.map((b) => ({ ballot_hash: b.subarray(0, 32), share_hash: b.subarray(32) }))
    : out.map((b) => ({
        ballot_hash: b.subarray(0, 32),
        proof: decode(COMPLAINT_PROOF, b.subarray(32)),
      }));
}

const owedOf = (kind: ObligationRootKind, leaves: ReceiptPair[] | ComplaintEntry[]) =>
  kind === 1
    ? { kind: 1 as const, leaves: leaves as ReceiptPair[] }
    : { kind: 2 as const, leaves: leaves as ComplaintEntry[] };

function electionOf(v: ElectionVector): DeliveryElection {
  return {
    definitionHash: DEFINITION,
    panelSize: V.panel.length,
    registered: v.registered.map((seat) => {
      const p = V.panel.find((x) => x.seat === seat);
      if (p === undefined) throw new Error(`no seat ${seat}`);
      return {
        index: seat,
        kemKey: decode(KEM_PUBLIC_KEY, hex(p.kemKey)),
        signingKey: hex(p.signingKey),
      };
    }),
    segments: { delivery: BigInt(v.segments.delivery), complaint: BigInt(v.segments.complaint) },
    deadlines: { delivery: BigInt(v.deadlines.delivery), complaint: BigInt(v.deadlines.complaint) },
  };
}

const ballotsOf = (v: ElectionVector): DeliveryBallot[] =>
  v.ballots.map((b) => ({
    tier: b.tier,
    nullifier: BigInt(b.nullifier),
    vote: decode(COMMITTED_VOTE, hex(b.committedVote)),
  }));

const entriesOf = (v: ElectionVector): DeliveryEntry[] =>
  v.entries.map((e) =>
    e.path === "board"
      ? { path: "board", segment: e.segment, payload: hex(e.payload) }
      : { path: "contract", submittedAt: BigInt(e.submittedAt), payload: hex(e.payload) },
  );

// A source holding an object under a CID answers that CID with the root
// block `contentDag` makes of it, and its other blocks by their own CIDs, so
// one holding the wrong bytes answers with a block that doesn't hash to the
// CID; one holding no bytes holds nothing.
interface Held {
  readonly cid: Uint8Array;
  readonly object: Uint8Array;
}
const dags = new Map<string, readonly Block[]>();
const blocksOf = (held: readonly Held[]) => (cid: Uint8Array) =>
  held.flatMap(({ cid: named, object }) => {
    if (object.length === 0) return [];
    const key = bytesHex(sha256(object));
    const dag = dags.get(key) ?? contentDag(object).blocks;
    dags.set(key, dag);
    const [root, ...rest] = dag as [Block, ...Block[]];
    return [
      ...(bytesHex(named) === bytesHex(cid) ? [root.bytes] : []),
      ...rest.filter((b) => bytesHex(b.cid) === bytesHex(cid)).map((b) => b.bytes),
    ];
  });

const heldOf = (v: ElectionVector): Held[] =>
  v.leafObjects.map((o) => ({ cid: hex(o.cid), object: hex(o.object) }));

const rootsOf = (v: ElectionVector): DeliveryRoots => ({
  bound: BigInt(v.bound),
  threshold: v.threshold,
  attestations: v.attestations.map((a) => ({ seat: a.seat, roots: a.roots.map(hex) })),
  leafBlocks: blocksOf(heldOf(v)),
});

function asJson(r: DeliveryCheck): ElectionVector["result"] {
  if (r.unverifiable.length > 0) return { unverifiable: r.unverifiable.map((u) => ({ ...u })) };
  return {
    ballots: r.ballots.map((b) => ({
      ballotHash: bytesHex(b.ballotHash),
      counted: b.counted,
      delivered: b.delivered,
      missing: [...b.missing],
      excludedBy: b.excludedBy.map((c) => ({ ...c })),
    })),
    records: r.records.map((x) => ({ ...x })),
    rejected: r.rejected.map(({ at, error }) => ({ at, error })),
  };
}

const run = (v: ElectionVector, entries = entriesOf(v), roots: DeliveryRoots = rootsOf(v)) =>
  checkDelivery(electionOf(v), ballotsOf(v), entries, 1, roots);

const election = (id: string) => {
  const v = V.elections.find((e) => e.id === id);
  if (v === undefined) throw new Error(`no election ${id}`);
  return v;
};

describe("obligation roots' tree, leaf object and record hash (delivery-root.json)", () => {
  test("the file's tags and the root call's gas", () => {
    expect(V.tag).toBe("abolish/v1/sig/obligation-root");
    expect(V.recordHashTag).toBe("abolish/v1/obligation-root");
    expect(V.leafTag).toBe("abolish/v1/obligation/leaf");
    expect(V.nodeTag).toBe("abolish/v1/obligation/node");
    expect(BigInt(V.rootCallGas)).toBe(FORCED_PATH.rootCallGas);
  });

  test.each(V.records.filter((r) => r.leafObject !== undefined).map((r) => [r.id, r] as const))(
    "%s: its leaves hash to its root, its object to its CID, and the seat's builder re-makes it",
    (_id, r) => {
      const object = hex(r.leafObject as string);
      const size = r.kind === 1 ? 64 : 128;
      const leaves = Array.from({ length: r.count }, (_, j) =>
        object.subarray(size * j, size * (j + 1)),
      );
      expect(leaves.map((l) => bytesHex(OBLIGATION_TREE.leaf(l)))).toEqual(r.leafHashes);
      expect(bytesHex(merkleRoot(OBLIGATION_TREE, leaves))).toBe(r.root);
      expect(bytesHex(objectCid(object))).toBe(r.leavesCid);
      expect(object.length).toBe(r.objectLength);
      expect(bytesHex(sha256(object))).toBe(r.objectSha256);
      const record = decodeObligationRoot(hex(r.encoding), 1);
      expect(bytesHex(obligationRootStatement(record))).toBe(r.statement);
      expect(bytesHex(obligationRootHash(hex(r.encoding)))).toBe(r.recordHash);
      // Given its leaves in reverse, the builder sorts them and signs the
      // same record (RFC 6979).
      const made = buildObligationRoot(
        secretOf(r.seat),
        DEFINITION,
        r.seat,
        owedOf(r.kind, leavesOf(r.kind, object).reverse()),
      );
      expect(bytesHex(encodeObligationRoot(made.record))).toBe(r.encoding);
      expect(made.leafObject).toEqual(object);
      // Every leaf's audit path verifies against the record's own size and root.
      leaves.forEach((leaf, j) => {
        const proof = obligationInclusionProof(r.kind, object, j);
        expect(verifyObligationInclusion(record, j, leaf, proof)).toBe(true);
        expect(verifyObligationInclusion(record, (j + 1) % r.count, leaf, proof)).toBe(
          r.count === 1,
        );
      });
    },
  );

  // A full raw block and one leaf more, which takes a dag-pb root: the
  // builder's CID, tree and signature over 16,384 and 16,385 made-up leaves.
  test.each(V.records.filter((r) => r.leafObject === undefined).map((r) => [r.id, r] as const))(
    "%s: the builder re-makes it from its made-up leaves",
    (_id, r) => {
      const leaves = Array.from({ length: r.count }, (_, j) => ({
        ballot_hash: H(utf8(`delivery-root/full/${j}`)),
        share_hash: H(utf8(`delivery-root/full/share/${j}`)),
      }));
      const made = buildObligationRoot(secretOf(r.seat), DEFINITION, r.seat, {
        kind: 1,
        leaves,
      });
      expect(made.leafObject.length).toBe(r.objectLength);
      expect(bytesHex(sha256(made.leafObject))).toBe(r.objectSha256);
      expect(bytesHex(made.record.root)).toBe(r.root);
      expect(bytesHex(made.record.leaves_cid)).toBe(r.leavesCid);
      expect(bytesHex(encodeObligationRoot(made.record))).toBe(r.encoding);
      expect(bytesHex(obligationRootHash(hex(r.encoding)))).toBe(r.recordHash);
    },
  );

  test.each(V.proofs.map((p) => [p.id, p] as const))("inclusion proof %s", (_id, p) => {
    const path = p.path.map(hex);
    const ok = verifyInclusion(
      OBLIGATION_TREE,
      BigInt(p.index),
      BigInt(p.size),
      hex(p.leaf),
      path,
      hex(p.root),
    );
    expect(ok).toBe(p.valid);
    if (!p.valid) return;
    // A valid path is the one the tree of the file's leaves gives.
    const leaves = Array.from({ length: p.size }, (_, j) =>
      Uint8Array.from([
        ...H(utf8(`delivery-root/tree/${j}`)),
        ...H(utf8(`delivery-root/tree/share/${j}`)),
      ]),
    );
    expect(bytesHex(merkleRoot(OBLIGATION_TREE, leaves))).toBe(p.root);
    expect(inclusionProof(OBLIGATION_TREE, leaves, p.index).map(bytesHex)).toEqual(p.path);
  });

  test("the builder refuses no leaves and a repeated ballot hash", () => {
    const pair = { ballot_hash: new Uint8Array(32), share_hash: new Uint8Array(32) };
    const secret = secretOf(1);
    expect(() => buildObligationRoot(secret, DEFINITION, 1, { kind: 1, leaves: [] })).toThrow(
      RangeError,
    );
    expect(() =>
      buildObligationRoot(secret, DEFINITION, 1, { kind: 1, leaves: [pair, { ...pair }] }),
    ).toThrow(RangeError);
  });

  test("an inclusion check needs a leaf of the root's kind and an index inside it", () => {
    const r = V.records.find((x) => x.id === "receipt-root");
    if (r?.leafObject === undefined) throw new Error("no receipt-root");
    const record = decodeObligationRoot(hex(r.encoding), 1);
    const object = hex(r.leafObject);
    const leaf = object.subarray(0, 64);
    const proof = obligationInclusionProof(1, object, 0);
    expect(verifyObligationInclusion(record, 0, leaf, proof)).toBe(true);
    // The same 64 bytes read as a complaint root's leaf, or past the count.
    expect(verifyObligationInclusion({ ...record, kind: 2 }, 0, leaf, proof)).toBe(false);
    expect(verifyObligationInclusion(record, 3, leaf, proof)).toBe(false);
    expect(verifyObligationInclusion(record, -1, leaf, proof)).toBe(false);
    expect(verifyObligationInclusion({ ...record, count: 1.5 }, 0, leaf, proof)).toBe(false);
    // An object that isn't whole leaves of its kind has no tree.
    expect(() => obligationInclusionProof(1, object.subarray(1), 0)).toThrow(RangeError);
  });
});

describe("the delivery check reading obligation roots (delivery-root.json, elections)", () => {
  test.each(V.elections.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    expect(asJson(run(v))).toEqual(v.result);
  });

  test("without the roots' inputs, a root that may deliver leaves the counted set undecided", () => {
    const v = election("roots-deliver");
    const r = checkDelivery(electionOf(v), ballotsOf(v), entriesOf(v), 1);
    expect(r.unverifiable.length).toBeGreaterThan(0);
    expect(r.ballots).toEqual([]);
    expect(r.records).toEqual([]);
    // A root set aside before the bound needs no inputs: the late one is
    // late, and only the others hold the counted set open.
    const late = election("late-root");
    const l = checkDelivery(electionOf(late), ballotsOf(late), entriesOf(late), 1);
    expect(l.unverifiable.map((u) => u.at)).toEqual(
      late.entries.map((_e, at) => at).filter((at) => at !== 2),
    );
  });

  test("availability counts only the attestations given: none makes every root withheld", () => {
    const v = election("roots-deliver");
    const r = run(v, entriesOf(v), { ...rootsOf(v), attestations: [] });
    expect(r.unverifiable).toEqual([]);
    expect(r.ballots.every((b) => !b.delivered)).toBe(true);
    expect(r.records.every((x) => x.code === "root-withheld")).toBe(true);
  });

  test("one attestation short of q − k + 1 withholds a root that the threshold makes available", () => {
    const v = election("available-at-threshold");
    expect(asJson(run(v))).toEqual(v.result);
    const short = v.attestations.slice(1);
    const r = run(v, entriesOf(v), {
      ...rootsOf(v),
      attestations: rootsOf({ ...v, attestations: short }).attestations,
    });
    expect(r.records.some((x) => x.code === "root-withheld")).toBe(true);
  });

  test("a later source serving the right bytes is read after one serving wrong ones", () => {
    const v = election("wrong-bytes");
    const good = election("roots-deliver");
    const roots = rootsOf(v);
    const r = run(v, entriesOf(v), {
      ...roots,
      leafBlocks: (cid, limit) => [
        ...roots.leafBlocks(cid, limit),
        ...rootsOf(good).leafBlocks(cid, limit),
      ],
    });
    expect(asJson(r)).toEqual(good.result);
  });

  test("whatever bytes a source serves for a block, a wrong answer is a failed fetch and a later good one is read", () => {
    const v = election("wrong-bytes");
    const good = election("roots-deliver");
    const roots = rootsOf(v);
    const served = (junk: Uint8Array[]) => (cid: Uint8Array, limit: number) => [
      ...junk,
      ...rootsOf(good).leafBlocks(cid, limit),
    ];
    expect(
      asJson(run(v, entriesOf(v), { ...roots, leafBlocks: served([new Uint8Array(0)]) })),
    ).toEqual(good.result);
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 3 }), (junk) => {
        expect(asJson(run(v, entriesOf(v), { ...roots, leafBlocks: served(junk) }))).toEqual(
          good.result,
        );
        // With no good source after them, unverifiable, never an exception.
        const r = run(v, entriesOf(v), { ...roots, leafBlocks: () => junk });
        expect(r.unverifiable.length).toBeGreaterThan(0);
      }),
      { numRuns: slowRuns },
    );
  });

  test("the bound is read before availability, and a root at the bound is read", () => {
    const v = election("roots-deliver");
    const count = Math.max(...v.entries.map((e) => decodeObligationRoot(hex(e.payload), 1).count));
    expect(asJson(run(v, entriesOf(v), { ...rootsOf(v), bound: BigInt(count) }))).toEqual(v.result);
    const r = run(v, entriesOf(v), { ...rootsOf(v), bound: BigInt(count - 1), attestations: [] });
    expect(r.records.some((x) => x.code === "root-count")).toBe(true);
    expect(r.records.some((x) => x.code === "root-withheld")).toBe(false);
  });

  // One seat's receipt root over its leaves and 16,384 made-up ones that name
  // no ballot of the election, so its leaf object takes a dag-pb DAG; signed
  // over the canonical CID or over another chunking's.
  describe("a root whose leaf object takes more than one block", () => {
    const v = election("roots-deliver");
    const at = v.entries.findIndex((e) => decodeObligationRoot(hex(e.payload), 1).kind === 1);
    const original = decodeObligationRoot(hex((v.entries[at] as { payload: string }).payload), 1);
    const own = leavesOf(
      1,
      (heldOf(v).find((h) => bytesHex(h.cid) === bytesHex(original.leaves_cid)) as Held).object,
    ) as ReceiptPair[];
    const padding = Array.from({ length: 16_384 }, (_, j) => ({
      ballot_hash: H(utf8(`delivery-root/padding/${j}`)),
      share_hash: H(utf8(`delivery-root/padding/share/${j}`)),
    }));
    const built = buildObligationRoot(secretOf(original.seat), DEFINITION, original.seat, {
      kind: 1,
      leaves: [...own, ...padding],
    });
    const signed = (leavesCid: Uint8Array) => {
      const statement = { ...built.record, leaves_cid: leavesCid };
      const m = obligationRootStatement(statement);
      return encodeObligationRoot({
        ...statement,
        signature: signStatement(secretOf(original.seat), "abolish/v1/sig/obligation-root", m),
      });
    };
    // The election with this root in the original's place, named by every attester.
    const withRoot = (record: Uint8Array, blocks: readonly Block[]) => {
      const entries = entriesOf(v);
      entries[at] = { ...(entries[at] as DeliveryEntry), payload: record };
      const hash = bytesHex(obligationRootHash(record));
      const roots = rootsOf(v);
      return run(v, entries, {
        ...roots,
        bound: BigInt(built.record.count),
        attestations: roots.attestations.map((a) => ({
          seat: a.seat,
          roots: [...a.roots, hex(hash)],
        })),
        leafBlocks: (cid, limit) => [
          ...roots.leafBlocks(cid, limit),
          ...blocks.filter((b) => bytesHex(b.cid) === bytesHex(cid)).map((b) => b.bytes),
        ],
      });
    };

    test("its canonical DAG is read block by block and delivers as the original did", () => {
      expect(built.leafObject.length).toBeGreaterThan(CHUNK_SIZE);
      const dag = contentDag(built.leafObject);
      expect(bytesHex(dag.root)).toBe(bytesHex(built.record.leaves_cid));
      expect(dag.root[1]).toBe(0x70);
      const r = withRoot(signed(dag.root), dag.blocks);
      expect(asJson(r)).toEqual(v.result);
    });

    test("any block of it no source serves leaves the election unverifiable", () => {
      const dag = contentDag(built.leafObject);
      for (const missing of dag.blocks) {
        const r = withRoot(
          signed(dag.root),
          dag.blocks.filter((b) => b !== missing),
        );
        expect(r.unverifiable).toEqual([{ at }]);
        expect(r.ballots).toEqual([]);
      }
    });

    test("signed over another chunking of the same leaves, it is the seat's root-inconsistent", () => {
      const other = dagWith(built.leafObject, CHUNK_SIZE / 2, 1_024);
      const r = withRoot(signed(other.root), other.blocks);
      expect(r.unverifiable).toEqual([]);
      expect(r.records).toContainEqual({
        at,
        code: "root-inconsistent",
        signer: original.seat,
      });
      // It delivers nothing: the seat is missing for every ballot it alone receipted.
      const without = run(
        v,
        entriesOf(v).filter((_, i) => i !== at),
      );
      expect(r.ballots.map((b) => [...b.missing])).toEqual(
        without.ballots.map((b) => [...b.missing]),
      );
    });
  });

  test("refuses inputs that would make availability fail open", () => {
    const v = election("roots-deliver");
    const roots = rootsOf(v);
    const bad: Partial<DeliveryRoots>[] = [
      { threshold: 0 },
      { threshold: v.registered.length + 1 },
      { threshold: 1.5 },
      { bound: -1n },
      // An attestation from a seat outside the key set, or twice from one seat.
      { attestations: [{ seat: 9, roots: [] }] },
      {
        attestations: [
          ...roots.attestations,
          roots.attestations[0] as DeliveryRoots["attestations"][number],
        ],
      },
      { attestations: [{ seat: 1, roots: [new Uint8Array(31)] }] },
    ];
    for (const b of bad)
      expect(
        () => run(v, entriesOf(v), { ...roots, ...b }),
        JSON.stringify(b, (_k, x) => (typeof x === "bigint" ? `${x}` : x)),
      ).toThrow(RangeError);
  });

  // R3: neither verdict depends on the order of the roots, beyond which of
  // two for one slot comes first, nor on duplicates of one already read.
  test("verdicts don't depend on the roots' order or on repeats", { timeout: 120_000 }, () => {
    const v = election("three-ballots");
    const verdicts = (r: DeliveryCheck) =>
      r.ballots.map((b) => [bytesHex(b.ballotHash), b.counted, b.delivered, [...b.missing]]);
    const expected = verdicts(run(v));
    const entries = entriesOf(v);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }),
        fc.subarray(entries),
        (shuffled, extra) => {
          expect(verdicts(run(v, [...shuffled, ...extra]))).toEqual(expected);
        },
      ),
      { numRuns: slowRuns },
    );
  });

  test(
    "any change to an available root's leaf object is a failed fetch, never a verdict",
    { timeout: 120_000 },
    () => {
      const v = election("roots-deliver");
      const roots = rootsOf(v);
      const held = heldOf(v);
      fc.assert(
        fc.property(
          fc.nat({ max: held.length - 1 }),
          fc.nat({ max: 255 }),
          fc.integer({ min: 1, max: 255 }),
          (which, at, flip) => {
            const changed = held.map((h, i) => {
              if (i !== which) return h;
              const b = h.object.slice();
              b[at % b.length] = ((b[at % b.length] as number) ^ flip) & 0xff;
              return { cid: h.cid, object: b };
            });
            const r = run(v, entriesOf(v), { ...roots, leafBlocks: blocksOf(changed) });
            expect(r.unverifiable.length).toBe(1);
            expect(r.ballots).toEqual([]);
          },
        ),
        { numRuns: slowRuns },
      );
    },
  );
});

describe("the forced path for elections that commit roots (delivery-root.json, capacity)", () => {
  const windowsOf = (w: Windows) => ({
    contractEventWindow: BigInt(w.contractEventWindow),
    forcedInclusion: BigInt(w.forcedInclusion),
    margin: BigInt(w.margin),
  });
  const forcedOf = (e: CapacityElection): ForcedPathElection => {
    const common = {
      seats: Number(e.seats),
      closesAt: BigInt(e.closesAt),
      l1InclusionBound: BigInt(e.l1InclusionBound),
    };
    if (e.rolling === true) return { rolling: true, ...common };
    if (e.members === undefined) throw new Error("a fixed election without members");
    return { members: BigInt(e.members), ...common };
  };
  const interval = (i: { start: bigint; end: bigint; gas: bigint }) => ({
    start: `${i.start}`,
    end: `${i.end}`,
    gas: `${i.gas}`,
  });

  test.each(V.capacity.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const w = windowsOf(c.windows);
    for (const e of c.elections) {
      const d = forcedPathDemandWithRoots(forcedOf(e), w);
      expect({
        commitsRoots: d.commitsRoots,
        receipts: interval(d.receipts),
        complaints: interval(d.complaints),
      }).toEqual({ commitsRoots: e.commitsRoots, receipts: e.receipts, complaints: e.complaints });
    }
    expect(forcedPathFitsWithRoots(c.elections.map(forcedOf), w)).toBe(c.fits);
    // A rolling election commits roots whatever its size, with no batch figure.
    for (const e of c.elections)
      if (e.rolling === true) {
        expect(e.commitsRoots).toBe(true);
        expect(() => forcedPathDemand(forcedOf(e), w)).toThrow(RangeError);
      }
    // Until roots can deliver, the exported check counts every election with
    // batches, so any election that would commit roots is refused.
    if (c.elections.some((e) => e.commitsRoots))
      expect(forcedPathFits(c.elections.map(forcedOf), w)).toBe(false);
  });

  const firstWindows = () => {
    const c = V.capacity[0];
    if (c === undefined) throw new Error("no capacity case");
    return windowsOf(c.windows);
  };

  test("the file has rolling elections, alone and beside fixed ones, fitting and not", () => {
    const rolling = V.capacity.filter((c) => c.elections.some((e) => e.rolling === true));
    expect(rolling.some((c) => c.fits) && rolling.some((c) => !c.fits)).toBe(true);
    expect(rolling.some((c) => c.elections.some((e) => e.rolling !== true))).toBe(true);
  });

  test("a rolling election's root figure is its seats' root calls, whatever any member count would be", () => {
    const w = firstWindows();
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 32 }),
        fc.bigInt({ min: 0n, max: 10n ** 12n }),
        fc.bigInt({ min: 0n, max: 3600n }),
        (seats, members, bound) => {
          const common = { seats, closesAt: 1_800_000_000n, l1InclusionBound: bound };
          const rolling = forcedPathDemandWithRoots({ rolling: true, ...common }, w);
          const fixed = forcedPathDemandWithRoots({ members, ...common }, w);
          const gas = BigInt(seats) * FORCED_PATH.rootCallGas;
          expect(rolling.commitsRoots).toBe(true);
          expect([rolling.receipts.gas, rolling.complaints.gas]).toEqual([gas, gas]);
          // The same intervals as a fixed election's, whichever figure it takes.
          for (const k of ["receipts", "complaints"] as const)
            expect([rolling[k].start, rolling[k].end]).toEqual([fixed[k].start, fixed[k].end]);
        },
      ),
      { numRuns },
    );
  });

  test("a rolling election out of range throws, as a fixed one does", () => {
    const w = firstWindows();
    const rolling = { rolling: true, seats: 3, closesAt: 0n, l1InclusionBound: 0n } as const;
    for (const e of [
      { ...rolling, seats: 0 },
      { ...rolling, seats: 33 },
      { ...rolling, l1InclusionBound: -1n },
    ]) {
      expect(() => forcedPathDemandWithRoots(e, w)).toThrow(RangeError);
      expect(() => forcedPathFitsWithRoots([e], w)).toThrow(RangeError);
      expect(() => forcedPathFits([e], w)).toThrow(RangeError);
    }
    expect(() => forcedPathDemandWithRoots(rolling, { ...w, margin: 0n })).toThrow(RangeError);
  });

  test.each(V.limits.map((l) => [l.seats, l] as const))(
    "%i seats: the batch cap above which an election commits roots",
    (_seats, l) => {
      const c = V.capacity[0];
      if (c === undefined) throw new Error("no capacity case");
      const w = windowsOf(c.windows);
      const limit = forcedPathMembersLimit(l.seats, w);
      expect(`${limit}`).toBe(l.membersLimit);
      const at = (members: bigint) =>
        forcedPathDemandWithRoots(
          { members, seats: l.seats, closesAt: 0n, l1InclusionBound: 0n },
          w,
        ).commitsRoots;
      expect(at(limit)).toBe(false);
      expect(at(limit + 1n)).toBe(true);
    },
  );
});
