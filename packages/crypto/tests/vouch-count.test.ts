import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  countTier1Additions,
  type GroupRegistryEvent,
  type Tier1Count,
  type Tier1CountContext,
  type Tier1CountVerdict,
  tier1Leaves,
  VOUCH_K,
  VOUCH_ROOT_INTERVAL,
  VOUCH_ROOT_WINDOW,
  VOUCH_SLOTS,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/vouch-count.json: whole group-registry event sequences with
// real Semaphore v4.14.3 proofs and registrar-signed Tier 2 records, made
// outside the workspace by scripts/vouch-vectors.mjs, whose expected verdicts
// are written by hand from docs/spec/vouching.md (Counting across the
// deployment) and reproduced by that script's own replay (T-06, T-02, T-13,
// T-22, T-38, T-52, T-71). No expected value comes from the code under test.

interface EventVector {
  readonly kind: "group-created" | "members-added" | "tier1-addition";
  readonly block: string;
  readonly groupId?: string;
  readonly tier?: number;
  readonly record?: string;
}

interface Verdict {
  readonly at: number;
  readonly block: string;
  readonly valid: boolean;
  readonly index?: number;
  readonly error?: string;
  readonly vouch?: number;
  readonly which?: "vouchee" | "slot";
}

interface Vectors {
  readonly format: string;
  readonly parameters: {
    readonly k: number;
    readonly slots: number;
    readonly rootInterval: string;
    readonly rootWindow: string;
  };
  readonly context: {
    readonly chainId: string;
    readonly registry: string;
    readonly registrars: readonly string[];
    readonly threshold: number;
  };
  readonly cases: readonly {
    readonly id: string;
    readonly events: readonly EventVector[];
    readonly additions: readonly Verdict[];
    readonly broken: {
      readonly at: number;
      readonly block: string;
      readonly groupId: string;
      readonly reason: string;
    } | null;
    readonly leaves: readonly {
      readonly groupId: string;
      readonly block: string;
      readonly leaves?: readonly string[];
      readonly error?: "group-history";
    }[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("vouch-count.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const hex = (s: string | undefined) => {
  if (s === undefined || !/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error(`not hex: ${s}`);
  return Uint8Array.from(Buffer.from(s, "hex"));
};
const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};

const ctx: Tier1CountContext = {
  chainId: decimal(vectors.context.chainId),
  registry: hex(vectors.context.registry),
  registrars: vectors.context.registrars.map(hex),
  threshold: vectors.context.threshold,
};

function events(list: readonly EventVector[]): GroupRegistryEvent[] {
  return list.map((e) => {
    const block = decimal(e.block);
    if (e.kind === "group-created")
      return { kind: e.kind, block, groupId: decimal(e.groupId), tier: e.tier as number };
    if (e.kind === "members-added")
      return { kind: e.kind, block, groupId: decimal(e.groupId), record: hex(e.record) };
    return { kind: e.kind, block, record: hex(e.record) };
  });
}

// A verdict in the vectors' shape: the spec's code and position, nothing else.
function shape(at: number, block: bigint, v: Tier1CountVerdict): Verdict {
  const base = { at, block: String(block) };
  if (v.ok) return { ...base, valid: true, index: v.index };
  return {
    ...base,
    valid: false,
    error: v.error,
    ...("vouch" in v ? { vouch: v.vouch } : {}),
    ...("which" in v ? { which: v.which } : {}),
  };
}

const counted = new Map<string, Tier1Count>();
const countCase = (c: Vectors["cases"][number]) => {
  let got = counted.get(c.id);
  if (got === undefined) {
    got = countTier1Additions(events(c.events), ctx);
    counted.set(c.id, got);
  }
  return got;
};
const caseNamed = (id: string) => {
  const found = vectors.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

describe("Tier 1 counting vectors (docs/spec/vectors/vouch-count.json)", () => {
  test("uses the format and parameters this reader knows", () => {
    expect(vectors.format).toBe("abolish-vouch-count-vectors/1");
    expect(vectors.parameters).toEqual({
      k: VOUCH_K,
      slots: VOUCH_SLOTS,
      rootInterval: String(VOUCH_ROOT_INTERVAL),
      rootWindow: String(VOUCH_ROOT_WINDOW),
    });
  });

  test("every counting check, and every case's outcome, is covered", () => {
    const errors = new Set(vectors.cases.flatMap((c) => c.additions.map((a) => a.error)));
    for (const code of [
      "decode",
      "duplicate-voucher",
      "group",
      "root-grid",
      "root-window",
      "tier2-group",
      "root-mismatch",
      "slot-spent",
      "member",
      "proof",
    ])
      expect(errors, code).toContain(code);
    expect(new Set(vectors.cases.map((c) => c.broken?.reason ?? null))).toEqual(
      new Set([null, "position", "duplicate-group", "created"]),
    );
  });

  for (const c of vectors.cases)
    describe(c.id, () => {
      test("decides each addition as the spec does", { timeout: 120_000 }, () => {
        const got = countCase(c);
        expect(got.additions.map((a) => shape(a.at, a.block, a.verdict))).toEqual(c.additions);
      });

      test("finds the same break", { timeout: 120_000 }, () => {
        const got = countCase(c);
        expect(
          got.broken === null
            ? null
            : {
                at: got.broken.at,
                block: String(got.broken.block),
                groupId: String(got.broken.groupId),
                reason: got.broken.reason,
              },
        ).toEqual(c.broken);
      });

      test(
        "gives each Tier 1 group's leaves at a block, or group-history past the break",
        { timeout: 120_000 },
        () => {
          const got = countCase(c);
          for (const q of c.leaves) {
            const leaves = tier1Leaves(got, decimal(q.groupId), decimal(q.block));
            if (q.error !== undefined) expect(leaves.ok, `${q.groupId}@${q.block}`).toBe(false);
            else
              expect(leaves, `${q.groupId}@${q.block}`).toEqual({
                ok: true,
                leaves: (q.leaves ?? []).map(decimal),
              });
          }
        },
      );
    });
});

describe("countTier1Additions", () => {
  const deployment = caseNamed("deployment");
  const all = events(deployment.events);

  test(
    "no later event changes an earlier addition's verdict: every prefix agrees",
    { timeout: 300_000 },
    () => {
      const full = countCase(deployment);
      const cuts = [...new Set(all.map((e) => e.block))];
      // Every third block, and the last, keeps the run short and still cuts
      // between every kind of addition.
      for (const cut of cuts.filter((_, i) => i % 3 === 0 || i === cuts.length - 1)) {
        const prefix = all.filter((e) => e.block <= cut);
        const got = countTier1Additions(prefix, ctx);
        expect(got.additions.map((a) => shape(a.at, a.block, a.verdict))).toEqual(
          full.additions.filter((a) => a.block <= cut).map((a) => shape(a.at, a.block, a.verdict)),
        );
      }
    },
  );

  test("is judged under the binding's chain and registry", { timeout: 120_000 }, () => {
    // Under another chain ID every recomputed scope and message differs, so
    // every addition that reaches the proofs fails them; under another
    // registry the Tier 2 records' digests differ too, so the history breaks.
    const otherChain = countTier1Additions(all, { ...ctx, chainId: ctx.chainId + 1n });
    expect(otherChain.additions.some((a) => a.verdict.ok)).toBe(false);
    const otherRegistry = countTier1Additions(all, {
      ...ctx,
      registry: Uint8Array.from(ctx.registry, (b, i) => (i === 19 ? b ^ 1 : b)),
    });
    expect(otherRegistry.broken?.reason).toBe("signature");
  });

  test("a Tier 2 record under registrars other than the pinned ones breaks the history", () => {
    const [first, second] = ctx.registrars;
    const got = countTier1Additions(all, {
      ...ctx,
      registrars: [
        first as Uint8Array,
        Uint8Array.from(second as Uint8Array, (b, i) => (i === 19 ? b ^ 1 : b)),
      ].sort((a, b) => Buffer.compare(a, b)),
    });
    expect(got.broken).not.toBeNull();
    expect(got.additions).toEqual([]);
  });

  test("refuses events out of block order and malformed events", () => {
    const [a, b] = all;
    expect(() =>
      countTier1Additions(
        [
          { ...(b as GroupRegistryEvent), block: 5n },
          { ...(a as GroupRegistryEvent), block: 4n },
        ],
        ctx,
      ),
    ).toThrow(RangeError);
    expect(() =>
      countTier1Additions([{ kind: "group-created", block: 1n, groupId: 1n, tier: 256 }], ctx),
    ).toThrow(RangeError);
    expect(() =>
      countTier1Additions([{ kind: "group-created", block: 2n ** 64n, groupId: 1n, tier: 1 }], ctx),
    ).toThrow(RangeError);
    expect(() =>
      countTier1Additions([{ kind: "other", block: 1n } as unknown as GroupRegistryEvent], ctx),
    ).toThrow(TypeError);
    expect(() => countTier1Additions(all, { ...ctx, registry: new Uint8Array(19) })).toThrow();
  });

  test("an empty registry counts nothing", () => {
    const got = countTier1Additions([], ctx);
    expect(got).toEqual({ additions: [], broken: null, groups: new Map() });
    expect(tier1Leaves(got, 9n, 10n)).toEqual({ ok: true, leaves: [] });
  });
});
