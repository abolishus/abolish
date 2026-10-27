import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type ArchivedContractLog,
  checkEventAccumulatorContinuation,
  checkEventAccumulatorProof,
  checkEventAccumulatorProofs,
  type ContractLog,
  eventAccumulatorGenesis,
  eventAccumulatorStep,
  replayEventAccumulator,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/event-accumulator-2.json, from the independent Python
// implementation in scripts/event-accumulator-2-vectors.py (docs/spec/contracts.md;
// T-71, T-25, T-17). Expected values all come from the file. The first
// layout's frozen event-accumulator.json is used by no deployment, so nothing
// reads it (docs/adr/0025-contract-event-evidence.md).

interface VectorLog {
  readonly block: string;
  readonly timestamp: string;
  readonly topics: readonly string[];
  readonly data: string;
}

interface VectorFile {
  readonly format: string;
  readonly tag: string;
  readonly genesis: readonly {
    readonly id: string;
    readonly chainId: string;
    readonly address: string;
    readonly accumulator: string;
  }[];
  readonly sequences: readonly {
    readonly id: string;
    readonly chainId: string;
    readonly address: string;
    readonly genesis: string;
    readonly events: readonly VectorLog[];
    readonly accumulators: readonly string[];
  }[];
  readonly proofs: readonly {
    readonly id: string;
    readonly chainId: string;
    readonly address: string;
    readonly events: readonly (VectorLog & { readonly n: string })[];
    readonly proof: {
      readonly count: string;
      readonly block: string;
      readonly accumulator: string;
    };
    readonly error: string | null;
  }[];
  readonly rejected: readonly (
    | {
        readonly id: string;
        readonly kind: "genesis";
        readonly chainId: string;
        readonly address: string;
      }
    | {
        readonly id: string;
        readonly kind: "step";
        readonly block: string;
        readonly timestamp: string;
        readonly topics: readonly string[];
        readonly data: string;
      }
  )[];
}

const file = JSON.parse(
  readFileSync(new URL("event-accumulator-2.json", SPEC_VECTORS), "utf8"),
) as VectorFile;

const toLog = (l: Omit<VectorLog, "n">): ContractLog => ({
  block: BigInt(l.block),
  timestamp: BigInt(l.timestamp),
  topics: l.topics.map(hex),
  data: hex(l.data),
});

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe("event-accumulator vectors", () => {
  test("the file is in the format this reader knows", () => {
    expect(file.format).toBe("abolish-event-accumulator-vectors/2");
    expect(file.tag).toBe("abolish/v1/event-accumulator-2");
    expect(file.genesis.length).toBeGreaterThan(0);
    expect(file.sequences.length).toBeGreaterThan(0);
    expect(file.rejected.length).toBeGreaterThan(0);
    expect(file.proofs.some((p) => p.error === null)).toBe(true);
    expect(file.proofs.some((p) => p.error !== null)).toBe(true);
  });

  test.each(file.genesis)("genesis $id", (v) => {
    expect(bytesToHex(eventAccumulatorGenesis(BigInt(v.chainId), hex(v.address)))).toBe(
      v.accumulator,
    );
  });

  test.each(file.sequences)("sequence $id: every step and the replay", (v) => {
    const chainId = BigInt(v.chainId);
    const address = hex(v.address);
    let acc = eventAccumulatorGenesis(chainId, address);
    expect(bytesToHex(acc)).toBe(v.genesis);
    v.events.forEach((e, n) => {
      acc = eventAccumulatorStep(acc, BigInt(n), toLog(e));
      expect(bytesToHex(acc)).toBe(v.accumulators[n]);
    });
    const replayed = replayEventAccumulator(chainId, address, v.events.map(toLog));
    expect(bytesToHex(replayed.accumulator)).toBe(v.accumulators.at(-1));
    expect(replayed.count).toBe(BigInt(v.events.length));
  });

  test.each(file.proofs)("proof check $id", (v) => {
    const archive: ArchivedContractLog[] = v.events.map((e) => ({ ...toLog(e), n: BigInt(e.n) }));
    expect(
      checkEventAccumulatorProof(BigInt(v.chainId), hex(v.address), archive, {
        count: BigInt(v.proof.count),
        block: BigInt(v.proof.block),
        accumulator: hex(v.proof.accumulator),
      }),
    ).toBe(v.error);
  });

  test("the first layout's frozen file is unchanged", () => {
    // Retired before any deployment and read by nothing, so only this pin
    // keeps it from being edited (docs/spec/versioning.md, Frozen).
    const frozen = readFileSync(new URL("event-accumulator.json", SPEC_VECTORS));
    expect(bytesToHex(sha256(frozen))).toBe(
      "785fcf0a351f168795c28778c527cc44dbec958f2b49a7fabc6a1f2ca16b61e5",
    );
  });

  test.each(file.rejected)("rejects $id", (v) => {
    if (v.kind === "genesis")
      expect(() => eventAccumulatorGenesis(BigInt(v.chainId), hex(v.address))).toThrow(RangeError);
    else expect(() => eventAccumulatorStep(new Uint8Array(32), 0n, toLog(v))).toThrow(RangeError);
  });
});

describe("event accumulator", () => {
  test("genesis is H over the tag-framed bytes the spec lists, checked by hand", () => {
    // u8(30) ‖ tag ‖ u8(0) ‖ u64(1) ‖ address: the layout, written out here
    // instead of through the encoder under test.
    const tag = new TextEncoder().encode("abolish/v1/event-accumulator-2");
    const address = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
    const input = new Uint8Array([30, ...tag, 0, 0, 0, 0, 0, 0, 0, 0, 1, ...address]);
    expect(eventAccumulatorGenesis(1n, address)).toEqual(sha256(input));
  });

  test("a step binds the block number and timestamp, checked by hand", () => {
    const tag = new TextEncoder().encode("abolish/v1/event-accumulator-2");
    const acc = new Uint8Array(32).fill(7);
    const t = new Uint8Array(32).fill(9);
    const u64be = (v: number) => [0, 0, 0, 0, 0, 0, 0, v];
    const input = new Uint8Array([
      30,
      ...tag,
      1,
      ...acc,
      ...u64be(3),
      ...u64be(5),
      ...u64be(6),
      1,
      ...t,
      0,
      0,
      0,
      1,
      0xab,
    ]);
    const log = { block: 5n, timestamp: 6n, topics: [t], data: new Uint8Array([0xab]) };
    expect(eventAccumulatorStep(acc, 3n, log)).toEqual(sha256(input));
  });

  test("rejects malformed arguments", () => {
    const acc = new Uint8Array(32);
    const log = { block: 1n, timestamp: 1n, topics: [new Uint8Array(32)], data: new Uint8Array() };
    expect(() => eventAccumulatorGenesis(-1n, new Uint8Array(20))).toThrow(RangeError);
    expect(() => eventAccumulatorGenesis(1 as never, new Uint8Array(20))).toThrow(RangeError);
    expect(() => eventAccumulatorGenesis(1n, new Uint8Array(19))).toThrow();
    expect(() => eventAccumulatorStep(new Uint8Array(31), 0n, log)).toThrow(RangeError);
    expect(() => eventAccumulatorStep(acc, -1n, log)).toThrow(RangeError);
    expect(() => eventAccumulatorStep(acc, 2n ** 64n, log)).toThrow(RangeError);
    expect(() => eventAccumulatorStep(acc, 0n, { ...log, data: [1] as never })).toThrow(TypeError);
    expect(() => eventAccumulatorStep(acc, 0n, { ...log, block: 2n ** 64n })).toThrow(RangeError);
    expect(() => eventAccumulatorStep(acc, 0n, { ...log, timestamp: -1n })).toThrow(RangeError);
    expect(() => eventAccumulatorStep(acc, 0n, { ...log, block: 1 as never })).toThrow(RangeError);
  });

  const topic = fc.uint8Array({ minLength: 32, maxLength: 32 });
  const u64 = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });
  const contractLog = fc.record({
    block: u64,
    timestamp: u64,
    topics: fc.array(topic, { minLength: 1, maxLength: 4 }),
    data: fc.uint8Array({ maxLength: 200 }),
  });
  const address = fc.uint8Array({ minLength: 20, maxLength: 20 });
  const chainId = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });

  test("leaving out, altering or reordering any log changes the accumulator", () => {
    // T-25, T-71: what the verifier's 4.4 comparison rests on.
    fc.assert(
      fc.property(
        chainId,
        address,
        fc.array(contractLog, { minLength: 2, maxLength: 6 }),
        fc.nat(),
        (c, a, logs, pick) => {
          const full = bytesToHex(replayEventAccumulator(c, a, logs).accumulator);
          const i = pick % logs.length;
          const dropped = logs.filter((_, j) => j !== i);
          expect(bytesToHex(replayEventAccumulator(c, a, dropped).accumulator)).not.toBe(full);
          const j = (i + 1) % logs.length;
          const swapped = logs.map((l, k) => (k === i ? logs[j] : k === j ? logs[i] : l));
          const key = (l: ContractLog | undefined) =>
            `${l?.topics.map(bytesToHex).join()}/${bytesToHex(l?.data ?? new Uint8Array())}`;
          if (key(logs[i]) !== key(logs[j]))
            expect(
              bytesToHex(replayEventAccumulator(c, a, swapped as ContractLog[]).accumulator),
            ).not.toBe(full);
          const altered = logs.map((l, j2) =>
            j2 === i ? { ...l, data: new Uint8Array([...l.data, 0]) } : l,
          );
          expect(bytesToHex(replayEventAccumulator(c, a, altered).accumulator)).not.toBe(full);
          // ADR 0025: a log moved to another block or time changes it too.
          const flip = (v: bigint) => v ^ 1n;
          for (const field of ["block", "timestamp"] as const) {
            const moved = logs.map((l, j2) => (j2 === i ? { ...l, [field]: flip(l[field]) } : l));
            expect(bytesToHex(replayEventAccumulator(c, a, moved).accumulator)).not.toBe(full);
          }
        },
      ),
      { numRuns },
    );
  });

  test("the same logs from another contract or chain give another accumulator", () => {
    fc.assert(
      fc.property(
        chainId,
        address,
        address,
        fc.array(contractLog, { maxLength: 3 }),
        (c, a, b, logs) => {
          fc.pre(bytesToHex(a) !== bytesToHex(b));
          expect(replayEventAccumulator(c, a, logs).accumulator).not.toEqual(
            replayEventAccumulator(c, b, logs).accumulator,
          );
          const other = c === 0n ? 1n : c - 1n;
          expect(replayEventAccumulator(c, a, logs).accumulator).not.toEqual(
            replayEventAccumulator(other, a, logs).accumulator,
          );
        },
      ),
      { numRuns },
    );
  });

  test("moving bytes between topics and data changes the accumulator", () => {
    // The topic count and the data length frame each input (T-31).
    fc.assert(
      fc.property(topic, topic, (t0, t1) => {
        const two = { block: 1n, timestamp: 1n, topics: [t0, t1], data: new Uint8Array() };
        const one = { block: 1n, timestamp: 1n, topics: [t0], data: t1 };
        const acc = new Uint8Array(32);
        expect(eventAccumulatorStep(acc, 0n, two)).not.toEqual(eventAccumulatorStep(acc, 0n, one));
      }),
      { numRuns },
    );
  });

  test("does not alias its inputs", () => {
    const acc = new Uint8Array(32);
    const t = new Uint8Array(32);
    const data = new Uint8Array([1, 2, 3]);
    const before = eventAccumulatorStep(acc, 0n, { block: 1n, timestamp: 1n, topics: [t], data });
    const out = eventAccumulatorStep(acc, 0n, { block: 1n, timestamp: 1n, topics: [t], data });
    out.fill(0xff);
    expect(eventAccumulatorStep(acc, 0n, { block: 1n, timestamp: 1n, topics: [t], data })).toEqual(
      before,
    );
  });

  test("an honest history matches its proof at every block, and a log moved across it doesn't", () => {
    // Rule 2 of Verification: a proof at block B covers exactly the logs at or before B (T-71, T-25).
    fc.assert(
      fc.property(
        chainId,
        address,
        fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 8 }),
        fc.nat(),
        (c, a, gaps, pick) => {
          let block = 10n;
          const logs: ArchivedContractLog[] = gaps.map((g, i) => {
            block += BigInt(g);
            return {
              n: BigInt(i),
              block,
              timestamp: block * 2n,
              topics: [new Uint8Array(32)],
              data: new Uint8Array([i]),
            };
          });
          const last = logs.at(-1)?.block ?? 10n;
          for (let b = 9n; b <= last + 1n; b++) {
            const covered = logs.filter((l) => l.block <= b);
            const state = replayEventAccumulator(c, a, covered);
            expect(checkEventAccumulatorProof(c, a, logs, { ...state, block: b })).toBeNull();
            // Claiming one log more or fewer than the block covers fails.
            if (covered.length < logs.length) {
              const more = replayEventAccumulator(c, a, logs.slice(0, covered.length + 1));
              expect(checkEventAccumulatorProof(c, a, logs, { ...more, block: b })).not.toBeNull();
            }
            if (covered.length > 0) {
              const fewer = replayEventAccumulator(c, a, covered.slice(0, -1));
              expect(checkEventAccumulatorProof(c, a, logs, { ...fewer, block: b })).not.toBeNull();
            }
          }
          const i = pick % logs.length;
          const shifted = logs.map((l, j) => (j === i ? { ...l, block: l.block + 1n } : l));
          const proof = { ...replayEventAccumulator(c, a, logs), block: last + 1n };
          expect(checkEventAccumulatorProof(c, a, shifted, proof)).not.toBeNull();
        },
      ),
      { numRuns },
    );
  });

  test("throws on a malformed archived log rather than reporting a rule", () => {
    const proof = { count: 0n, block: 0n, accumulator: new Uint8Array(32) };
    const log = {
      n: 0n,
      block: 1n,
      timestamp: 1n,
      topics: [new Uint8Array(32)],
      data: new Uint8Array(),
    };
    const addr = new Uint8Array(20);
    expect(() =>
      checkEventAccumulatorProof(1n, addr, [{ ...log, block: 1 as never }], proof),
    ).toThrow(RangeError);
    expect(() => checkEventAccumulatorProof(1n, addr, [{ ...log, n: -1n }], proof)).toThrow(
      RangeError,
    );
    expect(() =>
      checkEventAccumulatorProof(1n, addr, [{ ...log, timestamp: 2n ** 64n }], proof),
    ).toThrow(RangeError);
  });

  test("rejects a malformed proof", () => {
    const proof = { count: 0n, block: 0n, accumulator: new Uint8Array(32) };
    expect(() =>
      checkEventAccumulatorProof(1n, new Uint8Array(20), [], { ...proof, block: -1n }),
    ).toThrow(RangeError);
    expect(() =>
      checkEventAccumulatorProof(1n, new Uint8Array(20), [], { ...proof, count: 2n ** 64n }),
    ).toThrow(RangeError);
    expect(() =>
      checkEventAccumulatorProof(1n, new Uint8Array(20), [], {
        ...proof,
        accumulator: new Uint8Array(31),
      }),
    ).toThrow(RangeError);
  });

  describe("checkEventAccumulatorProofs", () => {
    // An archive of up to 8 logs whose blocks, numbering and topics a few
    // mutations may break, and proofs at each block over prefixes of it,
    // honest or one log off, or of any count and accumulator.
    const archive = fc
      .record({
        gaps: fc.array(fc.nat({ max: 2 }), { maxLength: 8 }),
        swap: fc.option(fc.nat(), { nil: undefined }),
        renumber: fc.option(fc.nat(), { nil: undefined }),
        anonymous: fc.option(fc.nat(), { nil: undefined }),
      })
      .map(({ gaps, swap, renumber, anonymous }) => {
        let block = 10n;
        const logs: ArchivedContractLog[] = gaps.map((g, i) => {
          block += BigInt(g);
          return {
            n: BigInt(i),
            block,
            timestamp: block * 2n,
            topics: [new Uint8Array(32).fill(i)],
            data: new Uint8Array([i]),
          };
        });
        const at = (k: number | undefined) => (k === undefined ? -1 : k % (logs.length + 1));
        const s = at(swap);
        if (s >= 1 && s < logs.length)
          [logs[s - 1], logs[s]] = [
            logs[s] as ArchivedContractLog,
            logs[s - 1] as ArchivedContractLog,
          ];
        const r = at(renumber);
        if (r >= 0 && r < logs.length) logs[r] = { ...(logs[r] as ArchivedContractLog), n: 99n };
        const z = at(anonymous);
        if (z >= 0 && z < logs.length)
          logs[z] = { ...(logs[z] as ArchivedContractLog), topics: [] };
        return logs;
      });
    const outcome = (f: () => unknown) => {
      try {
        return { value: f() };
      } catch (e) {
        return { threw: (e as Error).constructor.name };
      }
    };

    test("gives, for every proof, what checkEventAccumulatorProof gives it alone", () => {
      fc.assert(
        fc.property(
          chainId,
          address,
          archive,
          fc.array(
            fc.record({
              block: fc.bigInt({ min: 8n, max: 30n }),
              count: fc.bigInt({ min: 0n, max: 10n }),
              honest: fc.boolean(),
              accumulator: fc.uint8Array({ minLength: 32, maxLength: 32 }),
            }),
            { maxLength: 6 },
          ),
          (c, a, logs, claims) => {
            const provens = claims.map(({ block, count, honest, accumulator }) => {
              if (!honest) return { block, count, accumulator };
              const covered = logs.filter((l) => l.block <= block && l.topics.length > 0);
              return { ...replayEventAccumulator(c, a, covered), block };
            });
            const alone = outcome(() =>
              provens.map((p) => checkEventAccumulatorProof(c, a, logs, p)),
            );
            expect(outcome(() => checkEventAccumulatorProofs(c, a, logs, provens))).toEqual(alone);
          },
        ),
        { numRuns },
      );
    });

    test("checkEventAccumulatorContinuation from a proof that matched holds exactly when the archive up to the new proof matches both", () => {
      // What a writer holding only where its archive stands checks: from a
      // proof `from` that matched, the logs `proven` adds. The judge is the
      // whole archive, cut at `proven`'s count, under both proofs.
      const verdict = (f: () => unknown) => {
        const o = outcome(f);
        return "threw" in o ? "threw" : o.value === null ? "holds" : "fails";
      };
      fc.assert(
        fc.property(
          chainId,
          address,
          archive,
          fc.bigInt({ min: 8n, max: 30n }),
          fc.nat({ max: 8 }),
          fc.record({
            block: fc.bigInt({ min: 8n, max: 30n }),
            extra: fc.nat({ max: 8 }),
            honest: fc.boolean(),
            accumulator: fc.uint8Array({ minLength: 32, maxLength: 32 }),
          }),
          (c, a, logs, fromBlock, fromCount, claim) => {
            const c1 = Math.min(fromCount, logs.length);
            const c2 = Math.min(c1 + claim.extra, logs.length);
            const prefix = logs.slice(0, c1);
            // `from` counts exactly the prefix, as a proof that matched does.
            fc.pre(prefix.every((l) => l.topics.length > 0));
            const from = {
              ...replayEventAccumulator(c, a, prefix),
              block: fromBlock,
            };
            fc.pre(verdict(() => checkEventAccumulatorProof(c, a, logs, from)) === "holds");
            // An honest proof counts every log up to its count, none anonymous.
            fc.pre(!claim.honest || logs.slice(0, c2).every((l) => l.topics.length > 0));
            const proven = claim.honest
              ? {
                  ...replayEventAccumulator(c, a, logs.slice(0, c2)),
                  block: claim.block,
                }
              : { block: claim.block, count: BigInt(c2), accumulator: claim.accumulator };
            const last = prefix.at(-1);
            const continuation = verdict(() =>
              checkEventAccumulatorContinuation(
                {
                  ...from,
                  lastBlock: last?.block ?? 0n,
                  lastTimestamp: last?.timestamp ?? 0n,
                },
                logs.slice(c1, c2),
                proven,
              ),
            );
            const whole = verdict(() => {
              const r = checkEventAccumulatorProofs(c, a, logs.slice(0, c2), [from, proven]);
              return r.every((x) => x === null) ? null : r;
            });
            expect(continuation).toBe(whole);
          },
        ),
        { numRuns },
      );
    });

    test("checkEventAccumulatorContinuation refuses a log counted at or before the earlier proof's block", () => {
      const a = new Uint8Array(20).fill(7);
      const log = (n: bigint, block: bigint): ArchivedContractLog => ({
        n,
        block,
        timestamp: block,
        topics: [new Uint8Array(32)],
        data: new Uint8Array([Number(n)]),
      });
      const first = [log(0n, 11n)];
      const from = {
        ...replayEventAccumulator(5n, a, first),
        block: 20n,
        lastBlock: 11n,
        lastTimestamp: 11n,
      };
      // Event 1 at block 15 extends the accumulator, but `from`, at block
      // 20, would have counted it.
      const moved = [log(1n, 15n)];
      const proven = { ...replayEventAccumulator(5n, a, [...first, ...moved]), block: 30n };
      expect(checkEventAccumulatorContinuation(from, moved, proven)).toBe("block-range");
      const honest = [log(1n, 21n)];
      const next = { ...replayEventAccumulator(5n, a, [...first, ...honest]), block: 30n };
      expect(checkEventAccumulatorContinuation(from, honest, next)).toBeNull();
      expect(checkEventAccumulatorContinuation(from, honest, { ...next, block: 20n })).toBe(
        "block-range",
      );
      expect(checkEventAccumulatorContinuation(from, [], { ...from })).toBeNull();
      expect(() => checkEventAccumulatorContinuation(from, [], { ...from, count: 0n })).toThrow(
        RangeError,
      );
    });

    test("an honest history holds at every block in one call", () => {
      const logs: ArchivedContractLog[] = [11n, 11n, 13n, 20n].map((block, i) => ({
        n: BigInt(i),
        block,
        timestamp: block,
        topics: [new Uint8Array(32)],
        data: new Uint8Array([i]),
      }));
      const a = new Uint8Array(20).fill(7);
      const provens = [10n, 11n, 12n, 13n, 20n, 21n].map((block) => ({
        ...replayEventAccumulator(
          5n,
          a,
          logs.filter((l) => l.block <= block),
        ),
        block,
      }));
      type Proven = (typeof provens)[number];
      expect(checkEventAccumulatorProofs(5n, a, logs, provens)).toEqual(provens.map(() => null));
      expect(checkEventAccumulatorProofs(5n, a, logs, [])).toEqual([]);
      // One log more than block 12 covers, one fewer than block 13 does, and
      // a count past the archive.
      const [, eleven, , thirteen] = provens as [unknown, Proven, unknown, Proven];
      expect(
        checkEventAccumulatorProofs(5n, a, logs, [
          { ...thirteen, block: 12n },
          { ...eleven, block: 13n },
          { ...thirteen, block: 30n, count: 5n },
        ]),
      ).toEqual(["block-range", "block-range", "accumulator"]);
    });

    test("rejects a malformed proof or log as the single check does", () => {
      const proof = { count: 0n, block: 0n, accumulator: new Uint8Array(32) };
      const addr = new Uint8Array(20);
      expect(() =>
        checkEventAccumulatorProofs(1n, addr, [], [proof, { ...proof, block: -1n }]),
      ).toThrow(RangeError);
      expect(() =>
        checkEventAccumulatorProofs(1n, addr, [], [{ ...proof, accumulator: new Uint8Array(31) }]),
      ).toThrow(RangeError);
      const log = {
        n: 0n,
        block: 1n,
        timestamp: 1n,
        topics: [new Uint8Array(32)],
        data: new Uint8Array(),
      };
      expect(() => checkEventAccumulatorProofs(1n, addr, [{ ...log, n: -1n }], [proof])).toThrow(
        RangeError,
      );
      // With no proof nothing is judged, as no single call would be made.
      expect(checkEventAccumulatorProofs(1n, addr, [{ ...log, n: -1n }], [])).toEqual([]);
    });
  });
});
