import { cidText, objectCid } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { parseCid } from "../src/cid.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const layoutCid = fc
  .tuple(fc.constantFrom(0x55, 0x70), fc.uint8Array({ minLength: 32, maxLength: 32 }))
  .map(([codec, digest]) => Uint8Array.from([0x01, codec, 0x12, 0x20, ...digest]));

describe("parseCid", () => {
  test("reads back every layout CID in its text form", () => {
    fc.assert(
      fc.property(layoutCid, (cid) => {
        expect(parseCid(cidText(cid))).toEqual(cid);
      }),
      { numRuns },
    );
  });

  test("reads an object's CID as crypto computes it", () => {
    const cid = objectCid(new TextEncoder().encode("a board segment"));
    expect(parseCid(cidText(cid))).toEqual(cid);
  });

  test("anything it reads is the canonical spelling of a layout CID", () => {
    fc.assert(
      fc.property(
        fc.string({
          unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz234567B=Q".split("")),
          maxLength: 70,
        }),
        (s) => {
          const cid = parseCid(s);
          if (cid !== undefined) {
            expect(cidText(cid)).toBe(s);
            expect([cid[0], cid[2], cid[3], cid.length]).toEqual([0x01, 0x12, 0x20, 36]);
          }
        },
      ),
      { numRuns },
    );
  });

  test("refuses other spellings of a layout CID", () => {
    fc.assert(
      fc.property(layoutCid, (cid) => {
        const text = cidText(cid);
        expect(parseCid(text.toUpperCase())).toBeUndefined();
        expect(parseCid(`${text}=`)).toBeUndefined();
        expect(parseCid(text.slice(1))).toBeUndefined();
        expect(parseCid(`B${text.slice(1)}`)).toBeUndefined();
        // The last digit carries 3 bits of the CID and 2 spare bits, which must be zero.
        const last = "abcdefghijklmnopqrstuvwxyz234567".indexOf(text.at(-1) as string);
        const spare = "abcdefghijklmnopqrstuvwxyz234567"[last | 1] as string;
        expect(parseCid(text.slice(0, -1) + spare)).toBeUndefined();
      }),
      { numRuns },
    );
  });

  test("refuses CIDs outside the layout", () => {
    const digest = new Uint8Array(32).fill(7);
    const other = [
      [0x01, 0x71, 0x12, 0x20], // dag-cbor
      [0x01, 0x55, 0x13, 0x20], // sha2-512's code
      [0x01, 0x55, 0x12, 0x1f], // a shorter digest
      [0x00, 0x55, 0x12, 0x20],
    ];
    for (const prefix of other)
      expect(parseCid(cidText(Uint8Array.from([...prefix, ...digest])))).toBeUndefined();
    expect(parseCid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBeUndefined();
    expect(parseCid("")).toBeUndefined();
  });
});
