import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  COMPLAINT_BATCH_MAX,
  COMPLAINT_WINDOW,
  CONTRACT_EVENT_WINDOW,
  complaintScope,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV6,
  decodeElectionDefinitionV7,
  definitionMembers,
  DELIVERY_WINDOW,
  type FinalizedL1,
  FORCED_PATH,
  RECEIPT_BATCH_MAX,
  forcedPathDemand,
  type ForcedPathElection,
  forcedPathElectionOf,
  forcedPathFits,
  forcedPathMembersLimit,
  type ForcedPathWindows,
  owedReceipts,
  type ViewBallot,
} from "../src/index.ts";
import { forcedPathDemandWithRoots } from "../src/delivery.ts";
import { hex, readVectorFile, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/delivery-obligation.json comes from an independent Python
// implementation of What a node owes and Capacity
// (scripts/delivery-obligation-vectors.py, with revoting-vectors.py's selection
// by sorting and a time-ordered sweep with exact fractions), so the expected
// obligations and verdicts never come from the code under test.

interface Interval {
  readonly start: string;
  readonly end: string;
  readonly gas: string;
}

interface Vectors {
  readonly format: string;
  readonly windows: { readonly delivery: string; readonly complaint: string };
  readonly portal: {
    readonly maxResourceLimit: string;
    readonly elasticityMultiplier: number;
    readonly maxDepositData: number;
  };
  readonly forcedPath: Readonly<Record<keyof typeof FORCED_PATH, string>>;
  readonly l1: {
    readonly l1RefMin: string;
    readonly closesAt: string;
    readonly opensAt: string;
    readonly boardSegment: string;
    readonly blocks: readonly { number: string; hash: string; timestamp: string }[];
  };
  readonly obligations: readonly {
    readonly id: string;
    readonly head: string;
    readonly view: readonly {
      ballotHash: string;
      tier: number;
      nullifier: string;
      message: string;
      l1RefNumber: string;
      l1RefHash: string;
      entry?: { path: "ordinary" | "relayed" | "board"; value: string };
    }[];
    readonly receipts: readonly string[];
    readonly owedReceipts?: readonly string[];
    readonly complaintScope?: readonly string[];
    readonly error?: true;
  }[];
  readonly capacity: readonly {
    readonly id: string;
    readonly windows: Readonly<Record<keyof ForcedPathWindows, string>>;
    readonly elections: readonly (
      | {
          members: string;
          rolling?: undefined;
          seats: number;
          closesAt: string;
          l1InclusionBound: string;
          receipts: Interval;
          complaints: Interval;
        }
      // A rolling election: no `M`, so no batch figures.
      | { rolling: true; seats: number; closesAt: string; l1InclusionBound: string }
    )[];
    readonly fits: boolean;
  }[];
  readonly limits: readonly { seats: number; margin: string; members: string }[];
}

const V = JSON.parse(
  readFileSync(new URL("delivery-obligation.json", SPEC_VECTORS), "utf8"),
) as Vectors;
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const blocks = new Map(
  V.l1.blocks.map((b) => [BigInt(b.number), { hash: hex(b.hash), timestamp: BigInt(b.timestamp) }]),
);
const l1At = (head: bigint): FinalizedL1 => ({
  head,
  block: (n) => {
    const b = blocks.get(n);
    if (b === undefined || n > head) throw new Error(`block ${n} isn't final`);
    return b;
  },
});
const window = {
  l1RefMin: BigInt(V.l1.l1RefMin),
  closesAt: BigInt(V.l1.closesAt),
  opensAt: BigInt(V.l1.opensAt),
  boardSegment: BigInt(V.l1.boardSegment),
};

const windowsOf = (w: Readonly<Record<keyof ForcedPathWindows, string>>): ForcedPathWindows => ({
  contractEventWindow: BigInt(w.contractEventWindow),
  forcedInclusion: BigInt(w.forcedInclusion),
  margin: BigInt(w.margin),
});
const electionOf = (e: Vectors["capacity"][number]["elections"][number]): ForcedPathElection => {
  const common = {
    seats: e.seats,
    closesAt: BigInt(e.closesAt),
    l1InclusionBound: BigInt(e.l1InclusionBound),
  };
  return e.rolling === true
    ? { rolling: true, ...common }
    : { members: BigInt(e.members), ...common };
};

const hour = 3600n;
const deployed: ForcedPathWindows = {
  contractEventWindow: CONTRACT_EVENT_WINDOW,
  forcedInclusion: 13n * hour,
  margin: hour,
};

describe("delivery-obligation vectors", () => {
  test("file format, windows, the portal's figures and the forced path's", () => {
    expect(V.format).toBe("abolish-delivery-obligation-vectors/1");
    expect(BigInt(V.windows.delivery)).toBe(DELIVERY_WINDOW);
    expect(BigInt(V.windows.complaint)).toBe(COMPLAINT_WINDOW);
    // The root call's figure is delivery-root.json's (delivery-root-check.test.ts).
    for (const [k, v] of Object.entries(FORCED_PATH))
      if (k !== "rootCallGas") expect(BigInt(V.forcedPath[k as keyof typeof FORCED_PATH])).toBe(v);
    // The target is the portal's metered limit over its elasticity.
    expect(FORCED_PATH.depositGasTarget).toBe(
      BigInt(V.portal.maxResourceLimit) / BigInt(V.portal.elasticityMultiplier),
    );
    // A full receipt call fits one deposit: one share-receipt batch of
    // `receiptsPerCall` pairs, `104 + 64·c` bytes padded to a word, after the
    // selector, offset and length, and its gas.
    expect(FORCED_PATH.receiptsPerCall).toBe(BigInt(RECEIPT_BATCH_MAX));
    const calldata = 4n + 64n + ((104n + FORCED_PATH.receiptsPerCall * 64n + 31n) / 32n) * 32n;
    expect(calldata).toBeLessThanOrEqual(BigInt(V.portal.maxDepositData));
    expect(FORCED_PATH.receiptCallGas).toBeLessThanOrEqual(BigInt(V.portal.maxResourceLimit));
    // So does a full complaint call: one share-complaint batch of
    // `complaintsPerCall` entries, `104 + 128·c` bytes.
    expect(FORCED_PATH.complaintsPerCall).toBe(BigInt(COMPLAINT_BATCH_MAX));
    const complaints = 4n + 64n + ((104n + FORCED_PATH.complaintsPerCall * 128n + 31n) / 32n) * 32n;
    expect(complaints).toBeLessThanOrEqual(BigInt(V.portal.maxDepositData));
    expect(FORCED_PATH.complaintCallGas).toBeLessThanOrEqual(BigInt(V.portal.maxResourceLimit));
  });

  test("owed receipts and complaint scopes are the file's", () => {
    expect(V.obligations.length).toBeGreaterThanOrEqual(22);
    for (const c of V.obligations) {
      const view: ViewBallot[] = c.view.map((b) => ({
        ballotHash: hex(b.ballotHash),
        tier: b.tier,
        nullifier: BigInt(b.nullifier),
        message: hex(b.message),
        l1RefNumber: BigInt(b.l1RefNumber),
        l1RefHash: hex(b.l1RefHash),
        entry: b.entry === undefined ? null : { path: b.entry.path, value: BigInt(b.entry.value) },
      }));
      const l1 = l1At(BigInt(c.head));
      const receipts = c.receipts.map(hex);
      if (c.error) {
        expect(() => owedReceipts(view, receipts, l1, window), c.id).toThrow(RangeError);
        expect(() => complaintScope(view, l1, window), c.id).toThrow(RangeError);
        continue;
      }
      expect(owedReceipts(view, receipts, l1, window).map(toHex), c.id).toEqual(c.owedReceipts);
      expect(complaintScope(view, l1, window).map(toHex), c.id).toEqual(c.complaintScope);
    }
  });

  test("each election's intervals and each set's verdict are the file's", () => {
    expect(V.capacity.some((c) => c.fits) && V.capacity.some((c) => !c.fits)).toBe(true);
    for (const c of V.capacity) {
      const w = windowsOf(c.windows);
      for (const e of c.elections) {
        if (e.rolling === true) {
          expect(() => forcedPathDemand(electionOf(e), w), c.id).toThrow(RangeError);
          continue;
        }
        const d = forcedPathDemand(electionOf(e), w);
        for (const [got, want] of [
          [d.receipts, e.receipts],
          [d.complaints, e.complaints],
        ] as const)
          expect([got.start, got.end, got.gas].map(String), c.id).toEqual([
            want.start,
            want.end,
            want.gas,
          ]);
      }
      expect(forcedPathFits(c.elections.map(electionOf), w), c.id).toBe(c.fits);
    }
  });

  test("the file has rolling elections, alone and beside fixed ones, and none fits with batches", () => {
    const rolling = V.capacity.filter((c) => c.elections.some((e) => e.rolling === true));
    expect(rolling.some((c) => c.elections.length === 1)).toBe(true);
    expect(rolling.some((c) => c.elections.some((e) => e.rolling !== true))).toBe(true);
    expect(rolling.every((c) => !c.fits)).toBe(true);
  });

  test("a lone election's member limits are the file's", () => {
    for (const l of V.limits)
      expect(
        forcedPathMembersLimit(l.seats, { ...deployed, margin: BigInt(l.margin) }),
        `${l.seats} seats, R ${l.margin}`,
      ).toBe(BigInt(l.members));
  });
});

describe("complaintScope", () => {
  // A finalized L1 where every block of the file is final and the poll closed.
  const closed = l1At(BigInt(V.l1.blocks.length - 1));
  const refs = V.l1.blocks.map((b) => BigInt(b.number));
  const ballot = fc.record({
    core: fc.integer({ min: 0, max: 15 }),
    cast: fc.integer({ min: 0, max: 255 }),
    ref: fc.constantFrom(...refs),
    known: fc.boolean(),
    tier: fc.constantFrom(0, 1, 2),
    nullifier: fc.bigInt({ min: 1n, max: 3n }),
  });
  const viewOf = (
    bs: readonly {
      core: number;
      cast: number;
      ref: bigint;
      known: boolean;
      tier: number;
      nullifier: bigint;
    }[],
  ): ViewBallot[] =>
    bs.map((b) => ({
      ballotHash: Uint8Array.of(b.core, ...new Uint8Array(31)),
      tier: b.tier,
      nullifier: b.nullifier,
      message: Uint8Array.of(b.cast, ...new Uint8Array(31)),
      l1RefNumber: b.ref,
      l1RefHash: b.known
        ? (blocks.get(b.ref)?.hash ?? new Uint8Array(32))
        : new Uint8Array(32).fill(0xee),
      entry: null,
    }));

  test("is the receipts owed with every ballot of the view receipted, at most two per tier and nullifier, whatever the order", () => {
    fc.assert(
      fc.property(fc.uniqueArray(ballot, { selector: (b) => b.cast, maxLength: 30 }), (bs) => {
        const view = viewOf(bs);
        let scope: string[];
        try {
          scope = complaintScope(view, closed, window).map(toHex);
        } catch (e) {
          // Few cores: one message can name two of them, which every node refuses.
          expect(e).toBeInstanceOf(RangeError);
          return;
        }
        expect(
          owedReceipts(
            view,
            view.map((b) => b.ballotHash),
            closed,
            window,
          ).map(toHex),
        ).toEqual(scope);
        expect(complaintScope([...view].reverse(), closed, window).map(toHex)).toEqual(scope);
        const groups = new Set(view.map((b) => `${b.tier}:${b.nullifier}`));
        // Hashes are by core here, so a scope entry may stand for one core in
        // two groups; the bound is on distinct ballot hashes.
        expect(scope.length).toBeLessThanOrEqual(2 * groups.size);
        // Receipts owed are always some of what the node receipted.
        const receipted = view.filter((_, i) => i % 2 === 0).map((b) => b.ballotHash);
        const owed = owedReceipts(view, receipted, closed, window).map(toHex);
        for (const h of owed) expect(receipted.map(toHex)).toContain(h);
      }),
      { numRuns },
    );
  });
});

describe("the close rule in the view", () => {
  const closed = l1At(BigInt(V.l1.blocks.length - 1));
  const at = (n: number) => {
    const b = blocks.get(BigInt(n));
    if (b === undefined) throw new Error("no block");
    return b.hash;
  };
  const copy = (id: number, ref: number, entry: ViewBallot["entry"] = null): ViewBallot => ({
    ballotHash: Uint8Array.of(id, ...new Uint8Array(31)),
    tier: 0,
    nullifier: 7n,
    message: Uint8Array.of(0xaa, id, ...new Uint8Array(30)),
    l1RefNumber: BigInt(ref),
    l1RefHash: at(ref),
    entry,
  });

  test("a copy carrying its entry needs the close rule's window", () => {
    const v = [copy(1, 4, { path: "board", value: 1n })];
    const { l1RefMin, closesAt, opensAt } = window;
    expect(() => complaintScope(v, closed, { l1RefMin, closesAt })).toThrow(RangeError);
    expect(() => owedReceipts(v, [], closed, { l1RefMin, closesAt, opensAt })).toThrow(RangeError);
    // A view of intake copies alone needs only the L1 reference's window.
    expect(complaintScope([copy(1, 4)], closed, { l1RefMin, closesAt }).map(toHex)).toHaveLength(1);
  });

  test("a late copy is dropped before selection, at s_A and a second after close", () => {
    const counted = copy(1, 4, { path: "board", value: window.boardSegment });
    for (const late of [
      copy(2, 6, { path: "board", value: window.boardSegment + 1n }),
      copy(2, 6, { path: "ordinary", value: window.closesAt + 1n }),
      copy(2, 6, { path: "relayed", value: window.opensAt - 1n }),
    ])
      expect(complaintScope([counted, late], closed, window).map((h) => h[0])).toEqual([1]);
    // The same newer ballot in its window displaces the older one.
    const timely = copy(2, 6, { path: "ordinary", value: window.closesAt });
    expect(complaintScope([counted, timely], closed, window).map((h) => h[0])).toEqual([2]);
  });
});

describe("forcedPathFits", () => {
  const close = 1_800_000_000n;
  const lone = (members: bigint, seats = 3, closesAt = close): ForcedPathElection => ({
    members,
    seats,
    closesAt,
    l1InclusionBound: 600n,
  });

  test("the deployed windows' caps, receipts binding at R of one hour and complaints at 21 hours", () => {
    // With receipts batched (P1-12d): 1,152 members before, at a receipt each.
    expect(forcedPathMembersLimit(3, deployed)).toBe(20_992n);
    expect(forcedPathFits([lone(20_992n)], deployed)).toBe(true);
    expect(forcedPathFits([lone(20_993n)], deployed)).toBe(false);
    const long = { ...deployed, margin: 21n * hour };
    // 434,688 while W_C was taken as 13 hours.
    expect(forcedPathMembersLimit(3, long)).toBe(425_216n);
  });

  test("an empty set fits, and so does an election with no members", () => {
    expect(forcedPathFits([], deployed)).toBe(true);
    expect(forcedPathFits([lone(0n, 32)], deployed)).toBe(true);
  });

  test("refuses members, seats and windows out of range", () => {
    for (const e of [
      lone(-1n),
      lone(1n, 0),
      lone(1n, 33),
      lone(1n, 1.5),
      { ...lone(1n), l1InclusionBound: -1n },
    ])
      expect(() => forcedPathFits([e], deployed)).toThrow(RangeError);
    expect(() => forcedPathFits([lone(1n)], { ...deployed, margin: 0n })).toThrow(RangeError);
    expect(() => forcedPathFits([lone(1n)], { ...deployed, margin: -1n })).toThrow(RangeError);
    // An empty complaint interval: W_C + F = COMPLAINT_WINDOW − DELIVERY_WINDOW.
    expect(() =>
      forcedPathFits([lone(1n)], {
        ...deployed,
        contractEventWindow: COMPLAINT_WINDOW - DELIVERY_WINDOW - deployed.forcedInclusion,
      }),
    ).toThrow(RangeError);
    expect(() => forcedPathMembersLimit(0, deployed)).toThrow(RangeError);
  });

  const rolling = (seats = 3, closesAt = close): ForcedPathElection => ({
    rolling: true,
    seats,
    closesAt,
    l1InclusionBound: 600n,
  });

  test("never fits a set holding a rolling election, which has no batch figures", () => {
    expect(forcedPathFits([rolling()], deployed)).toBe(false);
    expect(forcedPathFits([rolling(1)], deployed)).toBe(false);
    expect(forcedPathFits([lone(0n), rolling()], deployed)).toBe(false);
    // Its intervals a week away from the fixed one's: it still doesn't fit.
    expect(forcedPathFits([lone(1n), rolling(3, close + 7n * 24n * hour)], deployed)).toBe(false);
    expect(() => forcedPathDemand(rolling(), deployed)).toThrow(/commits roots/);
    // Not even with a member count beside its flag.
    const both = { ...rolling(), members: 1n } as unknown as ForcedPathElection;
    expect(() => forcedPathDemand(both, deployed)).toThrow(/commits roots/);
    expect(forcedPathFits([both], deployed)).toBe(false);
  });

  test("reads `rolling: false` as fixed, and refuses a `rolling` that isn't a boolean", () => {
    const fixed = {
      members: 1n,
      rolling: false,
      seats: 3,
      closesAt: close,
      l1InclusionBound: 600n,
    };
    expect(forcedPathFits([fixed], deployed)).toBe(true);
    for (const r of [1, "true", null])
      expect(() =>
        forcedPathFits([{ ...lone(1n), rolling: r } as unknown as ForcedPathElection], deployed),
      ).toThrow(RangeError);
  });

  test("refuses a rolling election out of range, beside fixed ones that fit or not", () => {
    for (const e of [
      rolling(0),
      rolling(33),
      rolling(1.5),
      { ...rolling(), l1InclusionBound: -1n },
    ]) {
      expect(() => forcedPathFits([e], deployed)).toThrow(RangeError);
      expect(() => forcedPathFits([lone(1n), e], deployed)).toThrow(RangeError);
    }
    // A malformed fixed election beside a rolling one throws too.
    expect(() => forcedPathFits([lone(-1n), rolling()], deployed)).toThrow(RangeError);
    expect(() => forcedPathFits([rolling()], { ...deployed, margin: 0n })).toThrow(RangeError);
  });

  const elections = fc.array(
    fc.record({
      members: fc.bigInt({ min: 0n, max: 2_000n }),
      seats: fc.integer({ min: 1, max: 32 }),
      // Closes within a week of each other, so intervals often overlap.
      closesAt: fc.bigInt({ min: close, max: close + 7n * 24n * hour }),
      l1InclusionBound: fc.bigInt({ min: 600n, max: 3600n }),
    }),
    { maxLength: 8 },
  );

  test("is independent of order, and a fitting set stays fitting with fewer members or elections", () => {
    fc.assert(
      fc.property(elections, fc.nat(), (es, drop) => {
        const fits = forcedPathFits(es, deployed);
        expect(forcedPathFits([...es].reverse(), deployed)).toBe(fits);
        if (!fits || es.length === 0) return;
        const i = drop % es.length;
        expect(forcedPathFits([...es.slice(0, i), ...es.slice(i + 1)], deployed)).toBe(true);
        const fewer = es.map((e, j) =>
          j === i ? { ...e, members: e.members > 0n ? e.members - 1n : 0n } : e,
        );
        expect(forcedPathFits(fewer, deployed)).toBe(true);
      }),
      { numRuns },
    );
  });

  test("adding a rolling election anywhere in any set makes it not fit", () => {
    fc.assert(
      fc.property(
        elections,
        fc.nat(),
        fc.integer({ min: 1, max: 32 }),
        fc.bigInt({ min: close, max: close + 7n * 24n * hour }),
        (es, at, seats, closesAt) => {
          const i = at % (es.length + 1);
          const with_ = [...es.slice(0, i), rolling(seats, closesAt), ...es.slice(i)];
          expect(forcedPathFits(with_, deployed)).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  test("agrees with the summed rate at every second around each interval's edges", () => {
    // A direct reading: at each moment, Σ gas / length over the intervals
    // containing it, against the target per L1 block, in exact rationals
    // (numerator over the common denominator R · L_K).
    const rk =
      COMPLAINT_WINDOW - DELIVERY_WINDOW - deployed.contractEventWindow - deployed.forcedInclusion;
    fc.assert(
      fc.property(elections, (es) => {
        const ds = es.map((e) => forcedPathDemand(e, deployed));
        const moments = ds.flatMap((d) =>
          [d.receipts, d.complaints].flatMap((x) => [x.start - 1n, x.start, x.end - 1n, x.end]),
        );
        const over = moments.some((t) => {
          let sum = 0n;
          for (const d of ds) {
            if (d.receipts.start <= t && t < d.receipts.end) sum += d.receipts.gas * rk;
            if (d.complaints.start <= t && t < d.complaints.end)
              sum += d.complaints.gas * deployed.margin;
          }
          return (
            sum * FORCED_PATH.l1BlockSeconds > FORCED_PATH.depositGasTarget * deployed.margin * rk
          );
        });
        expect(forcedPathFits(es, deployed)).toBe(!over);
      }),
      { numRuns },
    );
  });
});

describe("forcedPathElectionOf", () => {
  const fixedOf = (d: Parameters<typeof forcedPathElectionOf>[0]) => {
    const e = forcedPathElectionOf(d);
    if (e.rolling === true) throw new Error("a fixed definition read as rolling");
    return e;
  };
  const definition = (file: string, id: string) => {
    const v = readVectorFile(file).vectors.find((x) => x.id === id);
    if (v?.encoding === undefined) throw new Error(`no ${id}`);
    return hex(v.encoding);
  };
  const typical = decodeElectionDefinitionV6(
    definition("election-definition-v6.json", "definition-v6-typical"),
  );

  test("counts the author panel's seats beside the default panel's", () => {
    expect(typical.author_keys.length).toBe(3);
    expect(forcedPathElectionOf(typical)).toEqual({
      members: definitionMembers(typical),
      seats: typical.panel_size + 3,
      closesAt: typical.closes_at,
      l1InclusionBound: BigInt(typical.l1_inclusion_bound),
    });
    // Both panels at MAX_TRUSTEES: the most seats the check takes.
    const full = decodeElectionDefinitionV6(
      definition("election-definition-v6.json", "definition-v6-lists-at-max"),
    );
    expect(forcedPathElectionOf(full).seats).toBe(32);
    // Its members are past the forced path's cap; with none it fits, so 32
    // seats are an input the check takes rather than refuses.
    expect(forcedPathFits([forcedPathElectionOf(full)], deployed)).toBe(false);
    expect(forcedPathFits([{ ...fixedOf(full), members: 0n }], deployed)).toBe(true);
  });

  test("counts only the default panel without an author panel, and under version 5", () => {
    const minimal = decodeElectionDefinitionV6(
      definition("election-definition-v6.json", "definition-v6-minimal"),
    );
    expect(minimal.author_keys.length).toBe(0);
    expect(forcedPathElectionOf(minimal).seats).toBe(minimal.panel_size);
    const v5 = decodeElectionDefinitionV5(
      definition("election-definition-v5.json", "definition-v5-typical"),
    );
    expect(forcedPathElectionOf(v5)).toEqual({
      members: definitionMembers(v5),
      seats: v5.panel_size,
      closesAt: v5.closes_at,
      l1InclusionBound: BigInt(v5.l1_inclusion_bound),
    });
  });

  test("refuses an election its author seats push past the forced path", () => {
    // The default panel's cap alone, which the author seats' batches overrun.
    const cap = forcedPathMembersLimit(typical.panel_size, deployed);
    const at = (members: bigint): typeof typical => ({
      ...typical,
      electorate: [
        { ...typical.electorate[0], regions: [members] } as (typeof typical.electorate)[0],
      ],
    });
    expect(
      forcedPathFits([{ ...forcedPathElectionOf(at(cap)), seats: typical.panel_size }], deployed),
    ).toBe(true);
    expect(forcedPathFits([forcedPathElectionOf(at(cap))], deployed)).toBe(false);
    const both = forcedPathMembersLimit(typical.panel_size + 3, deployed);
    expect(forcedPathFits([forcedPathElectionOf(at(both))], deployed)).toBe(true);
    expect(forcedPathFits([forcedPathElectionOf(at(both + 1n))], deployed)).toBe(false);
  });

  test("counts version 7's author seats, and reads its rolling electorate as rolling, with no M", () => {
    const fixed = decodeElectionDefinitionV7(
      definition("election-definition-v7.json", "definition-v7-fixed-typical"),
    );
    expect(forcedPathElectionOf(fixed)).toEqual({
      members: definitionMembers(fixed),
      seats: fixed.panel_size + fixed.author_keys.length,
      closesAt: fixed.closes_at,
      l1InclusionBound: BigInt(fixed.l1_inclusion_bound),
    });
    const rolling = decodeElectionDefinitionV7(
      definition("election-definition-v7.json", "definition-v7-rolling-typical"),
    );
    expect(rolling.electorate_mode).toBe(2);
    const e = forcedPathElectionOf(rolling);
    expect(e).toEqual({
      rolling: true,
      seats: rolling.panel_size + rolling.author_keys.length,
      closesAt: rolling.closes_at,
      l1InclusionBound: BigInt(rolling.l1_inclusion_bound),
    });
    expect("members" in e).toBe(false);
    // Refused with batches, the safe side while roots can't be sent; sized
    // with the root figure alone once they can.
    expect(forcedPathFits([e], deployed)).toBe(false);
    const roots = forcedPathDemandWithRoots(e, deployed);
    expect(roots.commitsRoots).toBe(true);
    expect(roots.receipts.gas).toBe(BigInt(e.seats) * FORCED_PATH.rootCallGas);
    expect(roots.complaints.gas).toBe(BigInt(e.seats) * FORCED_PATH.rootCallGas);
    // Its electorate is still uncountable by definitionMembers.
    expect(() => definitionMembers(rolling)).toThrow(RangeError);
  });
});

describe("definitionMembers", () => {
  test("sums version 1's group sizes and versions 3 to 6's regions", () => {
    expect(
      definitionMembers({ electorate: [{ group_size: 5n }, { group_size: 1_000_000n }] }),
    ).toBe(1_000_005n);
    expect(definitionMembers({ electorate: [{ regions: [1_000n, 20n] }, { regions: [3n] }] })).toBe(
      1_023n,
    );
  });

  test("refuses a rolling or empty electorate, whose members it can't count", () => {
    const tiers = [{ group_size: 5n }];
    expect(() => definitionMembers({ electorate: [] })).toThrow(RangeError);
    expect(() => definitionMembers({ electorate: tiers, electorate_mode: 2 })).toThrow(RangeError);
    expect(() => definitionMembers({ electorate: tiers, rolling_electorate: [{}] })).toThrow(
      RangeError,
    );
    expect(
      definitionMembers({ electorate: tiers, electorate_mode: 1, rolling_electorate: [] }),
    ).toBe(5n);
  });
});
