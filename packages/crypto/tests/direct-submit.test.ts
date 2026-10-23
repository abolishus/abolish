import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  decodeShareComplaint,
  decodeShareComplaintBatch,
  decodeSharePosting,
  decodeShareReceipt,
} from "../src/delivery.ts";
import { frameBallot, frameComplaintBatch, frameDelivery } from "../src/direct-submit.ts";
import { DecodeError } from "../src/codec.ts";
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

// Under version 8's framing, which contract-event versions 2 to 8 apply, no
// event carries a version-4 ballot: a board deployed with it frames only
// versions 1 to 3 (contracts.md, What the board frames; T-53).
test("frameBallot refuses every version-4 ballot under version 8's framing", () => {
  const v4 = load<BallotFile>("ballot-v4-records.json");
  expect(v4.ballots.length).toBeGreaterThan(0);
  for (const b of v4.ballots) expect(frameBallot(hex(b.encoding))).toBeUndefined();
});

// Version 9's framing (What the board frames (version 9)) takes every
// version-4 ballot of the file, whatever its admission verdict, since the
// board judges `validity-shape` and `share-hash-unqualified` against the
// registries, and refuses every decode rejection that needs no election.
describe("frameBallot under version 9's framing against ballot-v4-records.json", () => {
  const vectors = load<BallotFile>("ballot-v4-records.json");

  test.each(vectors.ballots.map((b) => [b.id, b] as const))(
    "%s frames with its ballot hash",
    (_id, b) => {
      const framed = frameBallot(hex(b.encoding), 9);
      expect(framed?.version).toBe(4);
      expect(framed && bytesToHex(framed.ballotHash)).toBe(b.ballotHash);
      expect(framed && bytesToHex(framed.definitionHash)).toBe(b.encoding.slice(6, 70));
    },
  );

  test.each(
    vectors.decode.filter((d) => d.error !== "profile-mismatch").map((d) => [d.id, d] as const),
  )("%s is refused", (_id, d) => {
    expect(frameBallot(hex(d.encoding), 9)).toBeUndefined();
  });

  // The earlier versions keep their hashes under the wider framing.
  test.each(["ballot.json", "ballot-v2.json"])(
    "every ballot of %s frames as under version 8",
    (file) => {
      for (const b of load<BallotFile>(file).ballots)
        expect(frameBallot(hex(b.encoding), 9)).toEqual(frameBallot(hex(b.encoding)));
    },
  );
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

// Version 2 names its seat's panel at 67: version 9's framing takes it at
// either panel and refuses every decode rejection; version 8's refuses it
// whole, and every version-1 record frames alike under both.
describe("frameDelivery against delivery-v2.json", () => {
  const vectors = load<DeliveryFile>("delivery-v2.json");

  test.each(vectors.records.map((r) => [r.id, r] as const))(
    "%s frames under its own type alone, and only under version 9's framing",
    (_id, r) => {
      const b = hex(r.encoding);
      const type = ((b[0] ?? 0) << 8) | (b[1] ?? 0);
      expect(frameDelivery(type, b, 9)).toEqual({
        definitionHash: b.slice(3, 35),
        ballotHash: b.slice(35, 67),
      });
      expect(frameDelivery(type, b)).toBeUndefined();
      for (const other of Object.values(TYPES).filter((t) => t !== type))
        expect(frameDelivery(other, b, 9)).toBeUndefined();
    },
  );

  test.each(
    vectors.decode
      // A version-1 receipt's own bytes are a version-1 record, which frames
      // whatever the election: which version an election's ballot version
      // fixes is the delivery check's (delivery.md, Versions).
      .filter((d) => d.id !== "receipt-v1-bytes")
      .map((d) => [d.id, d] as const),
  )("%s is refused", (_id, d) => {
    expect(frameDelivery(TYPES[d.type] ?? 0, hex(d.encoding), 9)).toBeUndefined();
  });

  test("every record of delivery.json frames as under version 8", () => {
    for (const r of load<DeliveryFile>("delivery.json").records) {
      const b = hex(r.encoding);
      const type = ((b[0] ?? 0) << 8) | (b[1] ?? 0);
      expect(frameDelivery(type, b, 9)).toEqual(frameDelivery(type, b));
    }
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
        frameBallot(b, 9);
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

  // The framing is never stricter than the strict decoders (T-53): every
  // version-2 record a decoder accepts, an honest one's mutations included,
  // frames under version 9 as its own type.
  test(
    "every version-2 delivery record and complaint batch that decodes frames under version 9",
    { timeout: 120_000 },
    () => {
      const seeds = [
        ...load<DeliveryFile>("delivery-v2.json").records,
        ...load<DeliveryFile>("delivery-batch-v2.json").records.filter((r) =>
          r.encoding.startsWith("0017"),
        ),
      ].map((r) => hex(r.encoding));
      const decoders: ReadonlyMap<number, (b: Uint8Array) => unknown> = new Map<
        number,
        (b: Uint8Array) => unknown
      >([
        [RECORD_TYPES.shareReceipt, (b) => decodeShareReceipt(b, 2)],
        [RECORD_TYPES.sharePosting, (b) => decodeSharePosting(b, 2)],
        [RECORD_TYPES.shareComplaint, (b) => decodeShareComplaint(b, 2)],
        [RECORD_TYPES.shareComplaintBatch, (b) => decodeShareComplaintBatch(b, 2)],
      ]);
      const mutated = fc
        .tuple(fc.nat({ max: seeds.length - 1 }), fc.nat(), fc.integer({ min: 0, max: 255 }))
        .map(([which, at, value]) => {
          const b = new Uint8Array(seeds[which] ?? []);
          b[at % b.length] = value;
          return b;
        });
      fc.assert(
        fc.property(mutated, (b) => {
          const type = ((b[0] ?? 0) << 8) | (b[1] ?? 0);
          const strict = decoders.get(type);
          if (strict === undefined) return;
          try {
            strict(b);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          if (type === RECORD_TYPES.shareComplaintBatch)
            expect(frameComplaintBatch(b, 9)).toBeDefined();
          else expect(frameDelivery(type, b, 9)).toBeDefined();
        }),
        { numRuns },
      );
    },
  );

  // Seeded with version-4 ballots: a changed byte outside the proof and the
  // L1 reference is refused or changes the hash, as for version 1.
  test(
    "a one-byte change to a version-4 ballot changes its hash or is refused under version 9",
    { timeout: 120_000 },
    () => {
      const v4 = load<BallotFile>("ballot-v4-records.json").ballots.map((b) => hex(b.encoding));
      fc.assert(
        fc.property(
          fc.nat({ max: v4.length - 1 }),
          fc.nat(),
          fc.integer({ min: 1, max: 255 }),
          (which, at, flip) => {
            const original = v4[which] ?? new Uint8Array();
            const i = at % original.length;
            if (i >= 68 && i < 364) return;
            const b = new Uint8Array(original);
            b[i] = (b[i] ?? 0) ^ flip;
            const after = frameBallot(b, 9);
            if (after !== undefined)
              expect(bytesToHex(after.ballotHash)).not.toBe(
                bytesToHex(frameBallot(original, 9)?.ballotHash ?? new Uint8Array()),
              );
          },
        ),
        { numRuns },
      );
    },
  );
});
