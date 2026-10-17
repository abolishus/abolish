import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { openingFileName, trackingCodeText } from "../src/tracking.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const hex32 = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map((bytes) => Buffer.from(bytes).toString("hex"));

// QR's alphanumeric mode: digits, upper-case letters, space and $%*+-./:
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;

describe("the tracking code's QR text", () => {
  test("carries the election id and all 32 bytes of the code, in alphanumeric mode", () => {
    fc.assert(
      fc.property(hex32, hex32, (election, code) => {
        const text = trackingCodeText(election, code);
        expect(text).toMatch(ALPHANUMERIC);
        const [scheme, kind, version, id, tracking, ...rest] = text.split(":");
        expect([scheme, kind, version]).toEqual(["ABOLISH", "TRACK", "1"]);
        expect(rest).toEqual([]);
        expect(Buffer.from(id ?? "", "hex").toString("hex")).toBe(election);
        expect(Buffer.from(tracking ?? "", "hex").toString("hex")).toBe(code);
      }),
      { numRuns },
    );
  });

  test("is exactly the spec's layout", () => {
    expect(trackingCodeText("5d".repeat(32), "0a".repeat(32))).toBe(
      `ABOLISH:TRACK:1:${"5D".repeat(32)}:${"0A".repeat(32)}`,
    );
  });

  test("is never made from a short, long or upper-case code", () => {
    const id = "5d".repeat(32);
    for (const bad of ["", "0a".repeat(31), "0a".repeat(33), "0A".repeat(32), "0g".repeat(32)]) {
      expect(() => trackingCodeText(id, bad)).toThrow(RangeError);
      expect(() => trackingCodeText(bad, id)).toThrow(RangeError);
      expect(() => openingFileName(bad)).toThrow(RangeError);
    }
  });
});

describe("the opening file's name", () => {
  test("starts with the tracking code's first 16 digits", () => {
    expect(
      openingFileName("c0de5eed0123456789abcdef0123456789abcdef0123456789abcdef01234567"),
    ).toBe("abolish-opening-c0de5eed01234567.bin");
  });
});
