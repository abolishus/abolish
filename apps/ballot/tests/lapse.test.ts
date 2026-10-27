import { DELIVERY_WINDOW, PARAMETERS } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  passedOnDevice,
  POSTING_BALLOT_MARGIN,
  postingCutoff,
  postingCutoffs,
  postingLapsed,
} from "../src/lapse.ts";

// The posting cutoff `c_D = t_D − F` ([[delivery]], Client rule 4), and when
// the client judges it passed: by the L2's finalized head and this device's
// clock both, so neither alone erases what a posting in time would need.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const u64 = fc.bigInt({ min: 0n, max: 2n ** 63n });

describe("the posting cutoff", () => {
  test("is closes_at + l1_inclusion_bound + DELIVERY_WINDOW − F (fast-check)", () => {
    fc.assert(
      fc.property(u64, fc.bigInt({ min: 0n, max: 2n ** 32n - 1n }), u64, (closes, bound, f) => {
        expect(postingCutoff(closes, bound, f)).toBe(closes + bound + DELIVERY_WINDOW - f);
      }),
      { numRuns },
    );
    expect(postingCutoff(1_792_000_000n, 3_600n, 46_800n)).toBe(1_792_129_600n);
  });

  test("refuses an F that isn't a bigint ≥ 0, and a negative bound", () => {
    expect(() => postingCutoff(0n, 0n, -1n)).toThrow(RangeError);
    expect(() => postingCutoff(0n, 0n, 1 as unknown as bigint)).toThrow(RangeError);
    expect(() => postingCutoff(0n, -1n, 0n)).toThrow(RangeError);
  });
});

describe("a lapsed posting", () => {
  test("is past the cutoff by both the chain and the device, never at it (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 40n }),
        fc.bigInt({ min: -2n, max: 2n }),
        fc.integer({ min: -2_000, max: 2_000 }),
        (cutoff, chainOffset, deviceOffsetMs) => {
          const nowMs = Number(cutoff) * 1000 + deviceOffsetMs;
          const device = Math.floor(nowMs / 1000) > Number(cutoff);
          expect(passedOnDevice(cutoff, nowMs)).toBe(device);
          expect(postingLapsed(cutoff, cutoff + chainOffset, nowMs)).toBe(
            chainOffset > 0n && device,
          );
        },
      ),
      { numRuns },
    );
  });

  test("is judged by whole seconds: the cutoff's own second hasn't passed", () => {
    expect(passedOnDevice(10n, 10_999)).toBe(false);
    expect(passedOnDevice(10n, 11_000)).toBe(true);
    expect(postingLapsed(10n, 11n, 10_999)).toBe(false);
    expect(postingLapsed(10n, 10n, 11_000)).toBe(false);
    expect(postingLapsed(10n, 11n, 11_000)).toBe(true);
  });

  test("refuses a clock that isn't a finite number", () => {
    for (const now of [Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => passedOnDevice(0n, now)).toThrow(RangeError);
  });
});

describe("the client's own posting cutoffs", () => {
  test("c_B is min(c_D, closes_at − POSTING_BALLOT_MARGIN), c_L is c_B − MAX_SEQUENCER_DRIFT, c_E is closes_at − 1,800 (fast-check)", () => {
    fc.assert(
      fc.property(u64, fc.bigInt({ min: 0n, max: 2n ** 32n - 1n }), u64, (closes, bound, f) => {
        const cD = postingCutoff(closes, bound, f);
        const margin = closes - POSTING_BALLOT_MARGIN;
        const { ballot, force } = postingCutoffs(closes, bound, f);
        expect(ballot).toBe(cD < margin ? cD : margin);
        expect(force).toBe(ballot - BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT));
        expect(postingCutoffs(closes, bound, f).lastOffer).toBe(closes - 1_800n);
        // Never past the close, nor past `c_D`.
        expect(ballot).toBeLessThan(closes);
        expect(ballot).toBeLessThanOrEqual(cD);
      }),
      { numRuns },
    );
  });

  test("are read from the close with the deployed values, never from c_D", () => {
    const closes = 1_792_000_000n;
    expect(postingCutoffs(closes, 3_600n, 46_800n)).toEqual({
      ballot: closes - 3_600n,
      force: closes - 5_400n,
      lastOffer: closes - 1_800n,
    });
    // An `F` past the delivery window brings `c_D` before the margin.
    const cD = postingCutoff(closes, 0n, DELIVERY_WINDOW + 7_200n);
    expect(cD).toBe(closes - 7_200n);
    expect(postingCutoffs(closes, 0n, DELIVERY_WINDOW + 7_200n).ballot).toBe(cD);
  });
});
