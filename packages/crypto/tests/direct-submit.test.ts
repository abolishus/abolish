import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { frameBallot, frameDelivery } from "../src/direct-submit.ts";
import { RECORD_TYPES } from "../src/record.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// The board's framing against the ballot and delivery files' own verdicts,
// which their independent generators wrote: every cast ballot frames with
// the file's ballot hash, and every decode rejection the board makes whatever
// the election pins is refused. A pin's rejection (`profile-mismatch`) is
// the board's to make against the election, never the frame's (T-31, T-53).

interface BallotFile {
  readonly ballots: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly ballotHash: string;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
  }[];
}

const load = <T>(file: string) =>
  JSON.parse(readFileSync(new URL(file, SPEC_VECTORS), "utf8")) as T;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe.each(["ballot.json", "ballot-v2.json"])("frameBallot against %s", (file) => {
  const vectors = load<BallotFile>(file);

  test.each(vectors.ballots.map((b) => [b.id, b] as const))(
    "%s frames with its ballot hash",
    (_id, b) => {
      const framed = frameBallot(hex(b.encoding));
      expect(framed && bytesToHex(framed.ballotHash)).toBe(b.ballotHash);
      expect(framed && bytesToHex(framed.definitionHash)).toBe(b.encoding.slice(6, 70));
    },
  );

  test.each(
    vectors.decode.filter((d) => d.error !== "profile-mismatch").map((d) => [d.id, d] as const),
  )("%s is refused", (_id, d) => {
    expect(frameBallot(hex(d.encoding))).toBeUndefined();
  });
});

interface DeliveryFile {
  readonly records: readonly { readonly id: string; readonly encoding: string }[];
  readonly decode: readonly {
    readonly id: string;
    readonly type: string;
    readonly encoding: string;
  }[];
}

const TYPES: Readonly<Record<string, number>> = {
  "share-receipt": RECORD_TYPES.shareReceipt,
  "share-posting": RECORD_TYPES.sharePosting,
  "share-complaint": RECORD_TYPES.shareComplaint,
};

describe("frameDelivery against delivery.json", () => {
  const vectors = load<DeliveryFile>("delivery.json");

  test.each(vectors.records.map((r) => [r.id, r] as const))(
    "%s frames under its own type alone",
    (_id, r) => {
      const b = hex(r.encoding);
      const type = ((b[0] ?? 0) << 8) | (b[1] ?? 0);
      expect(frameDelivery(type, b)).toEqual({
        definitionHash: b.slice(3, 35),
        ballotHash: b.slice(35, 67),
      });
      for (const other of Object.values(TYPES).filter((t) => t !== type))
        expect(frameDelivery(other, b)).toBeUndefined();
    },
  );

  test.each(vectors.decode.map((d) => [d.id, d] as const))("%s is refused", (_id, d) => {
    expect(frameDelivery(TYPES[d.type] ?? 0, hex(d.encoding))).toBeUndefined();
  });
});

describe("framing properties", () => {
  const honest = load<BallotFile>("ballot.json").ballots.map((b) => hex(b.encoding));

  // Any bytes, an honest record's mutations included, frame or are refused:
  // nothing throws, so a malformed event is `event-data`, never an exception.
  test("arbitrary and mutated records are framed or refused, never thrown on", () => {
    const mutated = fc
      .tuple(fc.nat({ max: honest.length - 1 }), fc.nat(), fc.integer({ min: 0, max: 255 }))
      .map(([which, at, value]) => {
        const b = new Uint8Array(honest[which] ?? []);
        b[at % b.length] = value;
        return b;
      });
    fc.assert(
      fc.property(fc.oneof(mutated, fc.uint8Array({ maxLength: 600 })), fc.nat(3), (b, t) => {
        frameBallot(b);
        frameDelivery(
          [RECORD_TYPES.shareReceipt, RECORD_TYPES.sharePosting, RECORD_TYPES.shareComplaint, 2][
            t
          ] ?? 0,
          b,
        );
      }),
      { numRuns },
    );
  });

  // A changed byte in an honest ballot either is refused or changes its
  // ballot hash, unless it is in the membership proof or the L1 reference,
  // which the hash leaves out ([[ballot-validity]], Ballot hash).
  test("a one-byte change outside the proof and the L1 reference changes the ballot hash or is refused", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: honest.length - 1 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (which, at, flip) => {
          const original = honest[which] ?? new Uint8Array();
          const i = at % original.length;
          if (i >= 68 && i < 364) return;
          const b = new Uint8Array(original);
          b[i] = (b[i] ?? 0) ^ flip;
          const before = frameBallot(original);
          const after = frameBallot(b);
          if (after !== undefined)
            expect(bytesToHex(after.ballotHash)).not.toBe(
              bytesToHex(before?.ballotHash ?? new Uint8Array()),
            );
        },
      ),
      { numRuns },
    );
  });
});
