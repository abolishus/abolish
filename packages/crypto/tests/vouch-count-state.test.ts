import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  countTier1Additions,
  decodeTier1Addition,
  encodeGroupAddition,
  encodeTier1Addition,
  groupAdditionDigest,
  type GroupRegistryEvent,
  groupRegistryDomainSeparator,
  signGroupApproval,
  type Tier1CountContext,
  Tier1CountingState,
  type Tier1CountVerdict,
  type Tier1Extension,
  type Tier1Judged,
  tier1Leaves,
  tierTreeRoot,
  VOUCH_ROOT_INTERVAL,
  VOUCH_ROOT_WINDOW,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// The relay's counting state (docs/spec/tier1-relay.md, The counting state),
// held to docs/spec/vectors/vouch-count.json: whole group-registry event
// sequences with real Semaphore proofs, whose expected verdicts are written
// by hand from docs/spec/vouching.md and reproduced by
// scripts/vouch-vectors.mjs, never by the code under test. The state must
// give every verdict a full replay gives, however the sequence is cut into
// extensions, and judge a candidate at `b + 1` as the replay would judge it
// logged there (T-52, T-25, T-22, T-71).

interface EventVector {
  readonly kind: "group-created" | "members-added" | "members-removed" | "tier1-addition";
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
    if (e.kind === "members-added" || e.kind === "members-removed")
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

const brokenShape = (b: Tier1Extension["broken"]) =>
  b === null
    ? null
    : { at: b.at, block: String(b.block), groupId: String(b.groupId), reason: b.reason };

const caseNamed = (id: string) => {
  const found = vectors.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no case ${id}`);
  return found;
};

// Extends a fresh state by `list` cut before each event whose position is in
// `cuts`, each piece through the block before the next piece's first.
function extendInPieces(list: readonly GroupRegistryEvent[], cuts: ReadonlySet<number>) {
  const state = new Tier1CountingState(ctx);
  const additions: Tier1Extension["additions"][number][] = [];
  let piece: GroupRegistryEvent[] = [];
  for (const [i, e] of list.entries()) {
    if (cuts.has(i) && piece.length > 0) {
      additions.push(...state.extend(piece, e.block - 1n).additions);
      piece = [];
    }
    piece.push(e);
  }
  const last = state.extend(piece);
  additions.push(...last.additions);
  return { state, additions, broken: last.broken };
}

// Cuts only between blocks: the state's pieces are whole blocks.
const blockCuts = (list: readonly GroupRegistryEvent[]) =>
  list.flatMap((e, i) => (i > 0 && (list[i - 1] as GroupRegistryEvent).block < e.block ? [i] : []));

describe("Tier1CountingState extended block by block gives the vectors' verdicts", () => {
  for (const c of vectors.cases)
    test(c.id, { timeout: 300_000 }, () => {
      const list = events(c.events);
      const { state, additions, broken } = extendInPieces(list, new Set(blockCuts(list)));
      expect(additions.map((a) => shape(a.at, a.block, a.verdict))).toEqual(c.additions);
      expect(brokenShape(broken)).toEqual(c.broken);
      expect(brokenShape(state.broken)).toEqual(c.broken);
      expect(state.block).toBe(list.at(-1)?.block);
      // The deployment spans more than a window, so roots are pruned on the way.
      const count = { additions, broken, groups: state.groups() };
      for (const q of c.leaves) {
        const leaves = tier1Leaves(count, decimal(q.groupId), decimal(q.block));
        if (q.error !== undefined) expect(leaves.ok, `${q.groupId}@${q.block}`).toBe(false);
        else
          expect(leaves, `${q.groupId}@${q.block}`).toEqual({
            ok: true,
            leaves: (q.leaves ?? []).map(decimal),
          });
      }
    });

  for (const c of vectors.cases)
    test(`and so does any cut of ${c.id} into whole blocks`, { timeout: 600_000 }, () => {
      const list = events(c.events);
      const cuts = blockCuts(list);
      fc.assert(
        fc.property(fc.subarray(cuts), (chosen) => {
          const got = extendInPieces(list, new Set(chosen));
          expect(got.additions.map((a) => shape(a.at, a.block, a.verdict))).toEqual(c.additions);
          expect(brokenShape(got.broken)).toEqual(c.broken);
        }),
        // A run of the deployment replays its real proofs, about 1.5 s: a
        // hundredth of FC_NUM_RUNS, 10 runs under CI's 1000.
        { numRuns: Math.max(3, Number(process.env.FC_NUM_RUNS ?? 100) / 100) },
      );
    });

  // Self-paid events and breaks sharing a block with additions, which no
  // vector logs: each expected count is written by hand from
  // docs/spec/vouching.md (A broken Tier 2 history) and docs/spec/contracts.md
  // (Group registry, Self-paid additions), and the state is held to it however
  // it is cut, as is countTier1Additions (T-71).
  const junk = new Uint8Array(40);
  const handBuilt: readonly {
    readonly id: string;
    readonly events: readonly GroupRegistryEvent[];
    readonly additions: readonly Verdict[];
    readonly broken: ReturnType<typeof brokenShape>;
  }[] = [
    {
      id: "a self-paid addition naming a signed Tier 2 group",
      events: [
        { kind: "group-created", block: 10n, groupId: 5n, tier: 2 },
        { kind: "self-paid-addition", block: 11n, groupId: 5n, index: 0n, record: junk },
      ],
      additions: [],
      broken: { at: 1, block: "11", groupId: "5", reason: "group" },
    },
    {
      id: "a group created again after a self-paid group of its identifier",
      events: [
        { kind: "self-paid-group-created", block: 10n, groupId: 6n },
        { kind: "group-created", block: 12n, groupId: 6n, tier: 1 },
      ],
      additions: [],
      broken: { at: 1, block: "12", groupId: "6", reason: "duplicate-group" },
    },
    {
      id: "a self-paid addition before its group",
      events: [{ kind: "self-paid-addition", block: 10n, groupId: 9n, index: 0n, record: junk }],
      additions: [],
      broken: { at: 0, block: "10", groupId: "9", reason: "created" },
    },
    {
      id: "a self-paid group's additions",
      events: [
        { kind: "self-paid-group-created", block: 10n, groupId: 6n },
        { kind: "self-paid-addition", block: 11n, groupId: 6n, index: 0n, record: junk },
      ],
      additions: [],
      broken: null,
    },
    {
      id: "a break after an addition in its own block",
      events: [
        { kind: "group-created", block: 10n, groupId: 1n, tier: 1 },
        { kind: "tier1-addition", block: 10n, record: junk },
        { kind: "tier1-addition", block: 11n, record: junk },
        { kind: "self-paid-addition", block: 11n, groupId: 9n, index: 0n, record: junk },
        { kind: "tier1-addition", block: 12n, record: junk },
      ],
      additions: [{ at: 1, block: "10", valid: false, error: "decode" }],
      broken: { at: 3, block: "11", groupId: "9", reason: "created" },
    },
  ];
  for (const c of handBuilt)
    test(c.id, () => {
      const whole = countTier1Additions(c.events, ctx);
      expect(whole.additions.map((a) => shape(a.at, a.block, a.verdict))).toEqual(c.additions);
      expect(brokenShape(whole.broken)).toEqual(c.broken);
      const cuts = blockCuts(c.events);
      for (let mask = 0; mask < 2 ** cuts.length; mask++) {
        const got = extendInPieces(c.events, new Set(cuts.filter((_, i) => (mask >> i) & 1)));
        expect(got.additions.map((a) => shape(a.at, a.block, a.verdict))).toEqual(c.additions);
        expect(brokenShape(got.broken)).toEqual(c.broken);
      }
    });

  test(
    "judges under the registrars it was given, whatever the caller does with them later",
    {
      timeout: 120_000,
    },
    () => {
      const c = caseNamed("deployment");
      const registrars = ctx.registrars.map((r) => r.slice());
      const state = new Tier1CountingState({ ...ctx, registrars });
      for (const r of registrars) r.fill(0);
      const got = state.extend(events(c.events));
      expect(got.additions.map((a) => shape(a.at, a.block, a.verdict))).toEqual(c.additions);
      expect(
        () => new Tier1CountingState({ ...ctx, registrars: ctx.registrars.slice(0, 1) }),
      ).toThrow(RangeError);
    },
  );
});

describe("Tier1CountingState judges candidates at b + 1 as the replay judges them logged there", () => {
  // Each block of a case holding only Tier 1 additions: the state through the
  // block before it judges them, in log order, as the vectors decide them.
  for (const c of vectors.cases)
    test(c.id, { timeout: 300_000 }, () => {
      const list = events(c.events);
      const blocks = [...new Set(list.map((e) => e.block))];
      let judged = 0;
      for (const block of blocks) {
        const inBlock = list.flatMap((e, at) => (e.block === block ? [{ e, at }] : []));
        if (inBlock.some(({ e }) => e.kind !== "tier1-addition")) continue;
        if (c.broken !== null && decimal(c.broken.block) <= block) continue;
        const state = new Tier1CountingState(ctx);
        state.extend(
          list.filter((e) => e.block < block),
          block - 1n,
        );
        const records = inBlock.map(({ e }) => (e as { record: Uint8Array }).record);
        const got = state.judge(records, { limit: records.length, sendMargin: 0n });
        if (!got.ok) throw new Error("unexpected break");
        expect(got.block).toBe(block);
        const expected = inBlock.map(({ at }) => {
          const v = c.additions.find((a) => a.at === at);
          if (v === undefined) throw new Error(`no verdict for ${at}`);
          return v;
        });
        expect(
          got.candidates.map((j, i) => {
            const at = (inBlock[i] as { at: number }).at;
            if (j.status === "chosen")
              return { at, block: String(block), valid: true, index: j.index };
            if (j.status === "unreached") throw new Error("unreached under a full limit");
            return shape(at, block, j.verdict as Tier1CountVerdict);
          }),
        ).toEqual(expected);
        judged += records.length;
      }
      // Every case but the one whose only addition shares its block judges some.
      if (c.id !== "created-after-records") expect(judged).toBeGreaterThan(0);
    });
});

describe("Tier1CountingState.judge", () => {
  const c = caseNamed("deployment");
  const list = events(c.events);
  // The deployment's first counted addition, judged in its own block.
  const firstCounted = c.additions.find((a) => a.valid);
  if (firstCounted === undefined) throw new Error("no counted addition");
  const first = list[firstCounted.at] as Extract<GroupRegistryEvent, { kind: "tier1-addition" }>;
  const stateBefore = (block: bigint) => {
    const state = new Tier1CountingState(ctx);
    state.extend(
      list.filter((e) => e.block < block),
      block - 1n,
    );
    return state;
  };
  const rootBlocks = (record: Uint8Array) => {
    const d = decodeTier1Addition(record);
    if (!d.ok) throw new Error("undecodable vector record");
    return d.value.vouches.map((v) => v.rootBlock);
  };

  test("a chosen candidate's slots and commitment are taken from the ones after it, and the state is unchanged", () => {
    const state = stateBefore(first.block);
    const once = state.judge([first.record, first.record], { limit: 16, sendMargin: 0n });
    expect(once).toMatchObject({
      ok: true,
      candidates: [
        { status: "chosen", index: 0 },
        { status: "dropped", verdict: { ok: false, error: "slot-spent", vouch: 0 } },
      ],
    });
    expect(state.judge([first.record], { limit: 16, sendMargin: 0n })).toMatchObject({
      ok: true,
      candidates: [{ status: "chosen", index: 0 }],
    });
    expect(state.groups()).toEqual(new Map());
  });

  test("stops at the limit, leaving the rest unreached", () => {
    const state = stateBefore(first.block);
    const got = state.judge([first.record, first.record], { limit: 1, sendMargin: 0n });
    expect(got).toMatchObject({
      ok: true,
      candidates: [{ status: "chosen" }, { status: "unreached" }],
    });
    expect(state.judge([first.record], { limit: 0, sendMargin: 0n })).toMatchObject({
      ok: true,
      candidates: [{ status: "unreached" }],
    });
  });

  test("drops a candidate with less than the send margin left in a vouch's window", () => {
    const state = stateBefore(first.block);
    const b = first.block - 1n;
    const roots = rootBlocks(first.record);
    const oldest = roots.reduce((x, y) => (x < y ? x : y));
    // `b + margin ≤ root_block + W` holds for every vouch at exactly this margin.
    const room = oldest + VOUCH_ROOT_WINDOW - b;
    expect(room).toBeGreaterThan(0n);
    expect(state.judge([first.record], { limit: 16, sendMargin: room })).toMatchObject({
      ok: true,
      candidates: [{ status: "chosen" }],
    });
    const late: Tier1Judged = {
      status: "dropped",
      verdict: { ok: false, error: "send-margin", vouch: roots.indexOf(oldest) },
    };
    expect(state.judge([first.record], { limit: 16, sendMargin: room + 1n })).toEqual({
      ok: true,
      block: first.block,
      candidates: [late],
    });
  });

  test("refuses to judge before the state has a block, and reports a break", () => {
    expect(() =>
      new Tier1CountingState(ctx).judge([first.record], { limit: 1, sendMargin: 0n }),
    ).toThrow(RangeError);
    const broken = caseNamed("broken-tier2");
    const state = new Tier1CountingState(ctx);
    state.extend(events(broken.events));
    expect(state.judge([first.record], { limit: 1, sendMargin: 0n })).toMatchObject({
      ok: false,
      error: "group-history",
      broken: { reason: "position" },
    });
  });

  test("refuses malformed options and records", () => {
    const state = stateBefore(first.block);
    expect(() => state.judge([first.record], { limit: -1, sendMargin: 0n })).toThrow(RangeError);
    expect(() => state.judge([first.record], { limit: 1.5, sendMargin: 0n })).toThrow(RangeError);
    expect(() => state.judge([first.record], { limit: 1, sendMargin: -1n })).toThrow(RangeError);
    expect(() =>
      state.judge(["00" as unknown as Uint8Array], { limit: 1, sendMargin: 0n }),
    ).toThrow(TypeError);
  });

  test("judges arbitrary bytes as malformed, never as chosen", () => {
    const state = stateBefore(first.block);
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), (bytes) => {
        const got = state.judge([bytes], { limit: 1, sendMargin: 0n });
        expect(got.ok && got.candidates[0]?.status).toBe("dropped");
      }),
      { numRuns: Number(process.env.FC_NUM_RUNS ?? 100) },
    );
  });
});

describe("Tier1CountingState.extend", () => {
  const list = events(caseNamed("deployment").events);
  const [a, b] = list as [GroupRegistryEvent, GroupRegistryEvent];

  test("takes only events after its block, through a block at or after them", () => {
    const state = new Tier1CountingState(ctx);
    expect(state.block).toBeNull();
    state.extend([a], a.block + 5n);
    expect(state.block).toBe(a.block + 5n);
    expect(() => state.extend([{ ...b, block: a.block + 5n }])).toThrow(RangeError);
    expect(() => state.extend([{ ...b, block: a.block + 6n }], a.block + 5n)).toThrow(RangeError);
    expect(() => state.extend([], a.block + 4n)).toThrow(RangeError);
    // An empty extension moves only the block.
    expect(state.extend([], a.block + 9n)).toEqual({ additions: [], broken: null });
    expect(state.block).toBe(a.block + 9n);
    expect(state.extend([])).toEqual({ additions: [], broken: null });
    expect(state.block).toBe(a.block + 9n);
  });

  test("decides nothing once broken, and only advances its block", { timeout: 120_000 }, () => {
    const broken = caseNamed("broken-tier2");
    const brokenList = events(broken.events);
    const state = new Tier1CountingState(ctx);
    const got = state.extend(brokenList);
    expect(brokenShape(got.broken)).toEqual(broken.broken);
    const later = brokenList.at(-1)?.block ?? 0n;
    expect(state.extend([{ ...b, block: later + 1n }])).toEqual({
      additions: [],
      broken: got.broken,
    });
    expect(state.block).toBe(later + 1n);
  });

  test("refuses malformed contexts and events", () => {
    expect(() => new Tier1CountingState(null as unknown as Tier1CountContext)).toThrow(TypeError);
    expect(() => new Tier1CountingState({ ...ctx, chainId: -1n })).toThrow(RangeError);
    const state = new Tier1CountingState(ctx);
    expect(() =>
      state.extend([
        { ...b, block: 10n },
        { ...a, block: 9n },
      ]),
    ).toThrow(RangeError);
    expect(() => state.extend([a], 2n ** 64n)).toThrow(RangeError);
  });
});

describe("Tier1CountingState keeps each grid block's Tier 2 root through the window", () => {
  // A Tier 2 group of our own registrar takes a record just after each of
  // three grid blocks, so its root differs at each. A candidate built from a
  // vector's vouches, retargeted at one of those roots, reaches its proofs
  // (and fails them, its messages changed) only if the state gives the root
  // at that grid block; with any other root it fails root-mismatch. The
  // candidate's verdict so shows which root the state kept (T-52).
  // Two registrars and a threshold of two, the least the registry allows (T-62).
  const keys = [1, 2]
    .map((k) => Uint8Array.from({ length: 32 }, (_, i) => i + k))
    .map((key) => ({
      key,
      address: keccak_256(secp256k1.getPublicKey(key, false).subarray(1)).subarray(12),
    }))
    .sort((x, y) => Buffer.compare(x.address, y.address));
  const own: Tier1CountContext = { ...ctx, registrars: keys.map((k) => k.address), threshold: 2 };
  const domain = groupRegistryDomainSeparator(own.chainId, own.registry);
  const tier2 = 7n;
  const tier1 = 8n;
  const add = (block: bigint, firstIndex: bigint, commitment: bigint): GroupRegistryEvent => {
    const message = { groupId: tier2, tier: 2, firstIndex, commitments: [commitment] };
    const digest = groupAdditionDigest(domain, message);
    const approvals = keys.map((k, i) => signGroupApproval(digest, i + 1, k.key));
    const record = encodeGroupAddition({ ...message, approvals });
    return { kind: "members-added", block, groupId: tier2, record };
  };
  const I = VOUCH_ROOT_INTERVAL;
  const start = 100n * I;
  const sequence: GroupRegistryEvent[] = [
    { kind: "group-created", block: start, groupId: tier2, tier: 2 },
    { kind: "group-created", block: start, groupId: tier1, tier: 1 },
    add(start + 1n, 0n, 11n),
    add(start + I + 1n, 1n, 12n),
    add(start + 2n * I + 1n, 2n, 13n),
    add(start + 3n * I + 1n, 3n, 14n),
  ];
  // Grid block `start + n·I` precedes the record after it: n leaves.
  const rootAtGrid = (n: bigint) => tierTreeRoot([11n, 12n, 13n, 14n].slice(0, Number(n)));
  const template = decodeTier1Addition(
    hex(caseNamed("deployment").events.find((e) => e.kind === "tier1-addition")?.record),
  );
  if (!template.ok) throw new Error("undecodable vector record");
  const candidate = (rootBlock: bigint, root: bigint) =>
    encodeTier1Addition({
      groupId: tier1,
      commitment: 99n,
      vouches: template.value.vouches.map((v) => ({ ...v, tier2GroupId: tier2, rootBlock, root })),
    });
  const verdictOf = (state: Tier1CountingState, record: Uint8Array) => {
    const got = state.judge([record], { limit: 1, sendMargin: 0n });
    if (!got.ok) throw new Error("unexpected break");
    const [j] = got.candidates;
    return j?.status === "dropped" ? j.verdict.error : j?.status;
  };

  test("whether extended at once or record by record", { timeout: 120_000 }, () => {
    const whole = new Tier1CountingState(own);
    whole.extend(sequence, start + 3n * I + 10n);
    const pieces = new Tier1CountingState(own);
    for (const e of sequence.slice(2))
      pieces.extend(e === sequence[2] ? sequence.slice(0, 3) : [e]);
    pieces.extend([], start + 3n * I + 10n);
    for (const state of [whole, pieces])
      for (const n of [0n, 1n, 2n, 3n]) {
        const rootBlock = start + n * I;
        expect(verdictOf(state, candidate(rootBlock, rootAtGrid(n)))).toBe("proof");
        expect(verdictOf(state, candidate(rootBlock, rootAtGrid((n + 1n) % 4n)))).toBe(
          "root-mismatch",
        );
      }
  });

  test("until the last block a candidate can still name it", { timeout: 120_000 }, () => {
    const state = new Tier1CountingState(own);
    state.extend(sequence);
    const oldest = start;
    // Judged at b + 1 = oldest + W, the oldest root is still in the window.
    state.extend([], oldest + VOUCH_ROOT_WINDOW - 1n);
    expect(verdictOf(state, candidate(oldest, rootAtGrid(0n)))).toBe("proof");
    expect(verdictOf(state, candidate(oldest + I, rootAtGrid(1n)))).toBe("proof");
    state.extend([], oldest + VOUCH_ROOT_WINDOW);
    expect(verdictOf(state, candidate(oldest, rootAtGrid(0n)))).toBe("root-window");
    expect(verdictOf(state, candidate(oldest + I, rootAtGrid(1n)))).toBe("proof");
  });
});
