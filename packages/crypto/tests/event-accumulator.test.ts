import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type ContractLog,
  eventAccumulatorGenesis,
  eventAccumulatorStep,
  replayEventAccumulator,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/event-accumulator.json, from the independent Python
// implementation in scripts/event-accumulator-vectors.py (docs/spec/contracts.md;
// T-71, T-25). Expected values all come from the file.

interface VectorLog {
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
        readonly topics: readonly string[];
        readonly data: string;
      }
  )[];
}

const file = JSON.parse(
  readFileSync(new URL("event-accumulator.json", SPEC_VECTORS), "utf8"),
) as VectorFile;

const toLog = (l: VectorLog): ContractLog => ({ topics: l.topics.map(hex), data: hex(l.data) });

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe("event-accumulator vectors", () => {
  test("the file is in the format this reader knows", () => {
    expect(file.format).toBe("abolish-event-accumulator-vectors/1");
    expect(file.tag).toBe("abolish/v1/event-accumulator");
    expect(file.genesis.length).toBeGreaterThan(0);
    expect(file.sequences.length).toBeGreaterThan(0);
    expect(file.rejected.length).toBeGreaterThan(0);
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

  test.each(file.rejected)("rejects $id", (v) => {
    if (v.kind === "genesis")
      expect(() => eventAccumulatorGenesis(BigInt(v.chainId), hex(v.address))).toThrow(RangeError);
    else expect(() => eventAccumulatorStep(new Uint8Array(32), 0n, toLog(v))).toThrow(RangeError);
  });
});

describe("event accumulator", () => {
  test("genesis is H over the tag-framed bytes the spec lists, checked by hand", () => {
    // u8(28) ‖ tag ‖ u8(0) ‖ u64(1) ‖ address: the layout, written out here
    // instead of through the encoder under test.
    const tag = new TextEncoder().encode("abolish/v1/event-accumulator");
    const address = Uint8Array.from({ length: 20 }, (_, i) => i + 1);
    const input = new Uint8Array([28, ...tag, 0, 0, 0, 0, 0, 0, 0, 0, 1, ...address]);
    expect(eventAccumulatorGenesis(1n, address)).toEqual(sha256(input));
  });

  test("rejects malformed arguments", () => {
    const acc = new Uint8Array(32);
    const log = { topics: [new Uint8Array(32)], data: new Uint8Array() };
    expect(() => eventAccumulatorGenesis(-1n, new Uint8Array(20))).toThrow(RangeError);
    expect(() => eventAccumulatorGenesis(1 as never, new Uint8Array(20))).toThrow(RangeError);
    expect(() => eventAccumulatorGenesis(1n, new Uint8Array(19))).toThrow();
    expect(() => eventAccumulatorStep(new Uint8Array(31), 0n, log)).toThrow(RangeError);
    expect(() => eventAccumulatorStep(acc, -1n, log)).toThrow(RangeError);
    expect(() => eventAccumulatorStep(acc, 2n ** 64n, log)).toThrow(RangeError);
    expect(() => eventAccumulatorStep(acc, 0n, { ...log, data: [1] as never })).toThrow(TypeError);
  });

  const topic = fc.uint8Array({ minLength: 32, maxLength: 32 });
  const contractLog = fc.record({
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
        const two = { topics: [t0, t1], data: new Uint8Array() };
        const one = { topics: [t0], data: t1 };
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
    const before = eventAccumulatorStep(acc, 0n, { topics: [t], data });
    const out = eventAccumulatorStep(acc, 0n, { topics: [t], data });
    out.fill(0xff);
    expect(eventAccumulatorStep(acc, 0n, { topics: [t], data })).toEqual(before);
  });
});
