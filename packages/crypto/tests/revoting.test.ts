import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type AdmittedBallot,
  BN254_R,
  checkL1Reference,
  type FinalizedL1,
  membershipMessage,
  membershipMessageField,
  selectBallots,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/revoting.json comes from an independent Python
// implementation (scripts/revoting-vectors.py), so these expected values never
// come from the code under test.

interface WireBallot {
  readonly tier: number;
  readonly nullifier: string;
  readonly message: string;
  readonly l1RefNumber: string;
  readonly index: string;
}

interface RevotingVectors {
  readonly format: string;
  readonly messages: readonly {
    readonly id: string;
    readonly definitionHash: string;
    readonly tier: number;
    readonly ballotHash: string;
    readonly l1RefNumber: string;
    readonly l1RefHash: string;
    readonly message?: string;
    readonly messageField?: string;
    readonly error?: string;
  }[];
  readonly l1Chain: readonly {
    readonly number: string;
    readonly hash: string;
    readonly timestamp: string;
  }[];
  readonly references: readonly {
    readonly id: string;
    readonly l1RefNumber: string;
    readonly l1RefHash: string;
    readonly head: string;
    readonly closesAt: string;
    readonly verdict: string;
  }[];
  readonly selections: readonly {
    readonly id: string;
    readonly ballots: readonly WireBallot[];
    readonly selected?: readonly string[];
    readonly repeats?: readonly string[];
    readonly ties?: readonly string[];
    readonly error?: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("revoting.json", SPEC_VECTORS), "utf8"),
) as RevotingVectors;

const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromWire = (b: WireBallot): AdmittedBallot => ({
  tier: b.tier,
  nullifier: decimal(b.nullifier),
  message: hex(b.message),
  l1RefNumber: decimal(b.l1RefNumber),
  index: decimal(b.index),
});
const indices = (bs: readonly AdmittedBallot[]) => bs.map((b) => String(b.index));

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const U64_MAX = (1n << 64n) - 1n;
const bytes32 = fc.uint8Array({ minLength: 32, maxLength: 32 });
const tier = fc.constantFrom(0, 1, 2);
const u64 = fc.bigInt({ min: 0n, max: U64_MAX });
const messageInput = fc.record({
  definitionHash: bytes32,
  tier,
  ballotHash: bytes32,
  l1RefNumber: u64,
  l1RefHash: bytes32,
});

// Small domains, so that groups, repeats and ties all occur often.
const ballotCore = fc.record({
  tier: fc.constantFrom(0, 1),
  nullifier: fc.constantFrom(1n, 2n, BN254_R - 1n),
  message: fc.constantFrom(0, 1, 2, 3).map((m) => new Uint8Array(32).fill(m)),
  l1RefNumber: fc.bigInt({ min: 10n, max: 13n }),
});
// A message determines its block (M binds the number), so the generated
// number is derived from it when the same message appears twice.
const ballots = fc.array(ballotCore, { maxLength: 24 }).chain((cores) =>
  fc
    .shuffledSubarray(
      Array.from({ length: cores.length }, (_, i) => BigInt(i)),
      { minLength: cores.length, maxLength: cores.length },
    )
    .map((idx) => {
      const refOf = new Map<string, bigint>();
      return cores.map((c, i): AdmittedBallot => {
        const key = `${c.tier}:${c.nullifier}:${c.message[0]}`;
        const ref = refOf.get(key) ?? c.l1RefNumber;
        refOf.set(key, ref);
        return { ...c, l1RefNumber: ref, index: idx[i] ?? 0n };
      });
    }),
);
// The vector chain, cut at `head`: asking for any other block is a test failure.
const finalized = (head: bigint): FinalizedL1 => ({
  head,
  block(n) {
    const b = vectors.l1Chain.find((x) => decimal(x.number) === n);
    if (b === undefined || n > head) throw new Error(`block ${n} isn't finalized`);
    return { hash: hex(b.hash), timestamp: decimal(b.timestamp) };
  },
});
const counted = (bs: readonly AdmittedBallot[]) =>
  bs.map((b) => `${b.tier}:${b.nullifier}:${toHex(b.message)}`).sort();

describe("revoting vectors (docs/spec/vectors/revoting.json)", () => {
  test("uses the format this reader knows", () => {
    expect(vectors.format).toBe("abolish-revoting-vectors/1");
  });

  test.each(vectors.messages)("membership message: $id", (v) => {
    const input = {
      definitionHash: hex(v.definitionHash),
      tier: v.tier,
      ballotHash: hex(v.ballotHash),
      l1RefNumber: decimal(v.l1RefNumber),
      l1RefHash: hex(v.l1RefHash),
    };
    if (v.error !== undefined) {
      expect(() => membershipMessage(input)).toThrow(RangeError);
      return;
    }
    expect(toHex(membershipMessage(input))).toBe(toHex(hex(v.message ?? "")));
    expect(membershipMessageField(input)).toBe(decimal(v.messageField));
  });

  test.each(vectors.references)("L1 reference: $id", (v) => {
    const ref = { l1RefNumber: decimal(v.l1RefNumber), l1RefHash: hex(v.l1RefHash) };
    expect(checkL1Reference(ref, finalized(decimal(v.head)), decimal(v.closesAt))).toBe(v.verdict);
  });

  test.each(vectors.selections)("selection: $id", (v) => {
    const input = v.ballots.map(fromWire);
    if (v.error !== undefined) {
      expect(() => selectBallots(input)).toThrow(RangeError);
      return;
    }
    const s = selectBallots(input);
    expect(indices(s.selected)).toEqual(v.selected);
    expect(indices(s.repeats)).toEqual(v.repeats);
    expect(indices(s.ties)).toEqual(v.ties);
  });
});

describe("membershipMessage", () => {
  test("changing any input changes M", () => {
    fc.assert(
      fc.property(messageInput, fc.integer({ min: 0, max: 4 }), fc.nat(31), (input, field, at) => {
        const flip = (b: Uint8Array) => {
          const c = new Uint8Array(b);
          c[at] = (c[at] ?? 0) ^ 1;
          return c;
        };
        const changed = [
          { ...input, definitionHash: flip(input.definitionHash) },
          { ...input, tier: (input.tier + 1) % 3 },
          { ...input, ballotHash: flip(input.ballotHash) },
          { ...input, l1RefNumber: input.l1RefNumber ^ 1n },
          { ...input, l1RefHash: flip(input.l1RefHash) },
        ][field];
        if (changed === undefined) throw new Error("unreachable");
        expect(toHex(membershipMessage(changed))).not.toBe(toHex(membershipMessage(input)));
      }),
      { numRuns },
    );
  });

  test("F(M) is below 2^248", () => {
    fc.assert(
      fc.property(messageInput, (input) => {
        expect(membershipMessageField(input) < 1n << 248n).toBe(true);
      }),
      { numRuns },
    );
  });

  test("rejects malformed inputs", () => {
    fc.assert(
      fc.property(
        messageInput,
        fc.constantFrom("definitionHash", "ballotHash", "l1RefHash"),
        fc.integer({ min: 0, max: 64 }).filter((n) => n !== 32),
        (input, field, length) => {
          expect(() => membershipMessage({ ...input, [field]: new Uint8Array(length) })).toThrow(
            TypeError,
          );
        },
      ),
      { numRuns },
    );
    const input = {
      definitionHash: new Uint8Array(32),
      tier: 0,
      ballotHash: new Uint8Array(32),
      l1RefNumber: 0n,
      l1RefHash: new Uint8Array(32),
    };
    for (const tier of [-1, 3, 0.5, Number.NaN])
      expect(() => membershipMessage({ ...input, tier })).toThrow(RangeError);
    for (const l1RefNumber of [-1n, U64_MAX + 1n])
      expect(() => membershipMessage({ ...input, l1RefNumber })).toThrow(RangeError);
  });
});

describe("checkL1Reference", () => {
  // A chain of 12-second blocks from block 0, finalized up to `head`.
  const chain = (head: bigint): FinalizedL1 => ({
    head,
    block: (n) => ({ hash: new Uint8Array(32).fill(Number(n % 256n)), timestamp: 1000n + 12n * n }),
  });

  test("once a block after close is finalized, nothing is pending (T-53)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        u64,
        bytes32,
        (head, closeBlock, refNumber, refHash) => {
          const closesAt = 1000n + 12n * closeBlock;
          const verdict = checkL1Reference(
            { l1RefNumber: refNumber, l1RefHash: refHash },
            chain(head),
            closesAt,
          );
          if (head > closeBlock) expect(verdict).not.toBe("pending");
          if (verdict === "admitted") expect(refNumber <= closeBlock).toBe(true);
          if (refNumber > head) expect(["pending", "l1-ref-after-close"]).toContain(verdict);
        },
      ),
      { numRuns },
    );
  });

  test("admits exactly the finalized block's own hash", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100n }), fc.nat(31), (n, at) => {
        const l1 = chain(100n);
        const hash = l1.block(n).hash;
        expect(checkL1Reference({ l1RefNumber: n, l1RefHash: hash }, l1, U64_MAX)).toBe("admitted");
        const other = new Uint8Array(hash);
        other[at] = (other[at] ?? 0) ^ 1;
        expect(checkL1Reference({ l1RefNumber: n, l1RefHash: other }, l1, U64_MAX)).toBe(
          "l1-ref-unknown",
        );
      }),
      { numRuns },
    );
  });

  test("rejects malformed inputs", () => {
    const l1 = chain(10n);
    const ok = { l1RefNumber: 1n, l1RefHash: l1.block(1n).hash };
    expect(() => checkL1Reference({ ...ok, l1RefNumber: -1n }, l1, 0n)).toThrow(RangeError);
    expect(() => checkL1Reference({ ...ok, l1RefNumber: U64_MAX + 1n }, l1, 0n)).toThrow(
      RangeError,
    );
    expect(() => checkL1Reference({ ...ok, l1RefHash: new Uint8Array(31) }, l1, 0n)).toThrow(
      TypeError,
    );
    expect(() => checkL1Reference(ok, { ...l1, head: -1n }, 0n)).toThrow(RangeError);
    expect(() => checkL1Reference(ok, l1, -1n)).toThrow(RangeError);
    expect(() =>
      checkL1Reference(
        ok,
        { head: 10n, block: () => ({ hash: new Uint8Array(32), timestamp: -1n }) },
        0n,
      ),
    ).toThrow(RangeError);
  });
});

describe("selectBallots", () => {
  test("partitions its input, with at most one selected ballot per tier and nullifier", () => {
    fc.assert(
      fc.property(ballots, (bs) => {
        const s = selectBallots(bs);
        const all = [...s.selected, ...s.repeats, ...s.ties].map((b) => b.index);
        expect(new Set(all).size).toBe(all.length);
        expect(all.every((i) => bs.some((b) => b.index === i))).toBe(true);
        const groups = s.selected.map((b) => `${b.tier}:${b.nullifier}`);
        expect(new Set(groups).size).toBe(groups.length);
        // Every input ballot is accounted for, except standing ballots that a
        // newer ballot of their group outranked.
        for (const b of bs)
          if (!all.includes(b.index)) {
            const newer = s.selected.find((x) => x.tier === b.tier && x.nullifier === b.nullifier);
            const tied = s.ties.find((x) => x.tier === b.tier && x.nullifier === b.nullifier);
            expect((newer ?? tied)!.l1RefNumber > b.l1RefNumber).toBe(true);
          }
      }),
      { numRuns },
    );
  });

  test("what counts doesn't depend on board positions or order (R3)", () => {
    fc.assert(
      fc.property(
        ballots.chain((bs) =>
          fc.tuple(
            fc.constant(bs),
            fc.shuffledSubarray(bs, { minLength: bs.length, maxLength: bs.length }),
          ),
        ),
        ([bs, reordered]) => {
          // The same ballots at other positions, presented in another order.
          const moved = reordered.map((b, i) => ({ ...b, index: BigInt(1000 + 7 * i) }));
          const a = selectBallots(bs);
          const b = selectBallots(moved);
          expect(counted(b.selected)).toEqual(counted(a.selected));
          expect(counted(b.ties)).toEqual(counted(a.ties));
          expect(b.repeats.length).toBe(a.repeats.length);
        },
      ),
      { numRuns },
    );
  });

  test("a ballot naming a newer block than every other of its group counts (R2)", () => {
    fc.assert(
      fc.property(ballots, ballotCore, (bs, core) => {
        const top = bs.reduce((m, b) => (b.l1RefNumber > m ? b.l1RefNumber : m), 0n);
        const fresh: AdmittedBallot = {
          ...core,
          message: new Uint8Array(32).fill(0xee),
          l1RefNumber: top + 1n,
          index: 999n,
        };
        const s = selectBallots([fresh, ...bs]);
        expect(s.selected).toContainEqual(fresh);
      }),
      { numRuns },
    );
  });

  test("a second distinct ballot on the top block voids the group, with no fallback", () => {
    fc.assert(
      fc.property(ballots, ballotCore, (bs, core) => {
        const top = bs.reduce((m, b) => (b.l1RefNumber > m ? b.l1RefNumber : m), 0n) + 1n;
        const twins = [0xe1, 0xe2].map((fill, i): AdmittedBallot => ({
          ...core,
          message: new Uint8Array(32).fill(fill),
          l1RefNumber: top,
          index: 900n + BigInt(i),
        }));
        const s = selectBallots([...bs, ...twins]);
        expect(s.selected.some((b) => b.tier === core.tier && b.nullifier === core.nullifier)).toBe(
          false,
        );
        expect(indices(s.ties)).toEqual(expect.arrayContaining(["900", "901"]));
      }),
      { numRuns },
    );
  });

  test("replaying any earlier ballot never changes what counts (R1)", () => {
    fc.assert(
      fc.property(
        ballots.filter((bs) => bs.length > 0),
        fc.nat(),
        (bs, pick) => {
          const original = bs[pick % bs.length];
          if (original === undefined) throw new Error("unreachable");
          const replay = { ...original, index: 5000n };
          const a = selectBallots(bs);
          const b = selectBallots([...bs, replay]);
          expect(counted(b.selected)).toEqual(counted(a.selected));
          expect(counted(b.ties)).toEqual(counted(a.ties));
          expect(indices(b.repeats)).toContain("5000");
        },
      ),
      { numRuns },
    );
  });

  test("rejects malformed input", () => {
    const ok: AdmittedBallot = {
      tier: 0,
      nullifier: 1n,
      message: new Uint8Array(32),
      l1RefNumber: 1n,
      index: 0n,
    };
    expect(selectBallots([ok]).selected).toHaveLength(1);
    for (const bad of [
      { ...ok, tier: 3 },
      { ...ok, nullifier: -1n },
      { ...ok, nullifier: BN254_R },
      { ...ok, l1RefNumber: -1n },
      { ...ok, l1RefNumber: U64_MAX + 1n },
      { ...ok, index: -1n },
    ])
      expect(() => selectBallots([bad])).toThrow(RangeError);
    expect(() => selectBallots([{ ...ok, message: new Uint8Array(31) }])).toThrow(TypeError);
    expect(() => selectBallots([ok, { ...ok, nullifier: 2n }])).toThrow(RangeError);
    expect(() => selectBallots([ok, { ...ok, index: 1n, l1RefNumber: 2n }])).toThrow(RangeError);
  });

  test("copies its input", () => {
    const message = new Uint8Array(32);
    const s = selectBallots([{ tier: 0, nullifier: 1n, message, l1RefNumber: 1n, index: 0n }]);
    message[0] = 1;
    expect(s.selected[0]?.message[0]).toBe(0);
  });
});
