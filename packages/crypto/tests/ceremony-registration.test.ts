import fc from "fast-check";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { describe, expect, test } from "vite-plus/test";
import {
  type CeremonyRegistrationRecord,
  DecodeError,
  decodeCeremonyRegistration,
  encodeCeremonyRegistration,
  EncodeError,
  identityKey,
  type KeySetEntry,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// The record `registerCeremony(bytes)` takes (docs/spec/contracts.md,
// Trustee registry, Registration). The expected bytes are put together here
// from docs/spec/vectors/key-set.json's hex, whose points `(x, y)` come from
// an independent Python implementation, never from the encoder under test;
// the reference election submits the encoder's records to the real trustee
// registry on Anvil.

interface Entry {
  readonly index: number;
  readonly kemKeyHash: string;
  readonly signingKey: string;
  readonly x: string;
  readonly y: string;
}
interface Statement {
  readonly id: string;
  readonly index: number;
  readonly stubHash: string;
  readonly ceremonyTranscriptHash: string;
  readonly keySet: string;
  readonly message: string;
  readonly signature: string;
}
const vectors = JSON.parse(readFileSync(new URL("key-set.json", SPEC_VECTORS), "utf8")) as {
  readonly keySets: readonly { id: string; entries: readonly Entry[] }[];
  readonly statements: readonly Statement[];
};

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const byte = (n: number) => n.toString(16).padStart(2, "0");

const keySet7 = vectors.keySets.find((k) => k.id === "key-set-7")!.entries;
const signed = vectors.statements.filter(
  (s) => s.keySet === "key-set-7" && s.stubHash === vectors.statements[0]!.stubHash,
);
// The statement's panel identifier: after `l2_chain_id` (8) and `trustee_registry` (20).
const PANEL_ID = signed[0]!.message.slice(56, 120);

const fromVectors = (): CeremonyRegistrationRecord => ({
  panelId: hex(PANEL_ID),
  stubHash: hex(signed[0]!.stubHash),
  ceremonyTranscriptHash: hex(signed[0]!.ceremonyTranscriptHash),
  keySet: keySet7.map((e) => ({
    index: e.index,
    kemKeyHash: hex(e.kemKeyHash),
    signingKey: hex(e.signingKey),
  })),
  approvals: signed.map((s) => ({ index: s.index, signature: hex(s.signature) })),
});

describe("the record from the key-set vectors", () => {
  test("is the layout, with each signing key as its point", () => {
    expect(signed.length).toBeGreaterThanOrEqual(2);
    const expected = [
      PANEL_ID,
      signed[0]!.stubHash,
      signed[0]!.ceremonyTranscriptHash,
      byte(keySet7.length),
      ...keySet7.map((e) => byte(e.index) + e.kemKeyHash + e.x + e.y),
      byte(signed.length),
      ...signed.map((s) => byte(s.index) + s.signature),
    ].join("");
    const encoded = encodeCeremonyRegistration(fromVectors());
    expect(toHex(encoded)).toBe(expected);
    expect(encoded.length).toBe(98 + 97 * keySet7.length + 65 * signed.length);
  });

  test("decodes to what was encoded, each key in its compressed form", () => {
    const record = fromVectors();
    expect(decodeCeremonyRegistration(encodeCeremonyRegistration(record))).toEqual(record);
  });
});

// Signing keys that are real points, from secrets 1 to 16.
const KEYS = Array.from({ length: 16 }, (_, i) => {
  const d = new Uint8Array(32);
  d[31] = i + 1;
  d[0] = 0x17;
  return identityKey(d);
});
const N = p256.Point.Fn.ORDER;
const HALF_N = (N - 1n) / 2n;
const word = (v: bigint) => hex(v.toString(16).padStart(64, "0"));

const seatsArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 16 }), { minLength: 1, maxLength: 16 })
  .map((xs) => xs.sort((a, b) => a - b));
const recordArb = fc.record({
  panelId: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  stubHash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  ceremonyTranscriptHash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  keySet: seatsArb.chain((seats) =>
    fc.tuple(
      ...seats.map((index) =>
        fc
          .uint8Array({ minLength: 32, maxLength: 32 })
          .map((kemKeyHash): KeySetEntry => ({ index, kemKeyHash, signingKey: KEYS[index - 1]! })),
      ),
    ),
  ),
  approvals: fc
    .uniqueArray(fc.integer({ min: 1, max: 16 }), { maxLength: 16 })
    .map((xs) => xs.sort((a, b) => a - b))
    .chain((seats) =>
      fc.tuple(
        ...seats.map((index) =>
          fc
            .tuple(fc.bigInt({ min: 1n, max: N - 1n }), fc.bigInt({ min: 1n, max: HALF_N }))
            .map(([r, s]) => ({
              index,
              signature: new Uint8Array([...word(r), ...word(s)]),
            })),
        ),
      ),
    ),
});

describe("encoding and decoding", () => {
  test("round-trips every well-formed record at its exact length", () => {
    fc.assert(
      fc.property(recordArb, (record) => {
        const encoded = encodeCeremonyRegistration(record);
        expect(encoded.length).toBe(98 + 97 * record.keySet.length + 65 * record.approvals.length);
        expect(decodeCeremonyRegistration(encoded)).toEqual(record);
      }),
      { numRuns },
    );
  });

  test("re-encodes every record it accepts to the same bytes", () => {
    fc.assert(
      fc.property(
        recordArb,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), { maxLength: 4 }),
        (record, flips) => {
          const bytes = encodeCeremonyRegistration(record);
          for (const [at, value] of flips) bytes[at % bytes.length] = value;
          let decoded: CeremonyRegistrationRecord;
          try {
            decoded = decodeCeremonyRegistration(bytes);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(encodeCeremonyRegistration(decoded)).toEqual(bytes);
        },
      ),
      { numRuns },
    );
  });

  test("refuses a record no registry check 2 or 7 to 9 would pass", () => {
    const good = fromVectors();
    const [a, b] = good.keySet as KeySetEntry[];
    const high = new Uint8Array([...word(1n), ...word(N - 1n)]);
    const offCurve = new Uint8Array(33);
    offCurve[0] = 0x02;
    offCurve[32] = 7; // x = 7 has no point on P-256
    for (const bad of [
      { ...good, keySet: [] },
      { ...good, keySet: [b!, a!] },
      { ...good, keySet: [a!, a!] },
      { ...good, keySet: [{ ...a!, index: 0 }] },
      { ...good, keySet: [{ ...a!, signingKey: offCurve }] },
      { ...good, keySet: [{ ...a!, kemKeyHash: new Uint8Array(31) }] },
      { ...good, approvals: [...good.approvals].reverse() },
      { ...good, approvals: [{ index: 1, signature: high }] },
      { ...good, approvals: [{ index: 0, signature: good.approvals[0]!.signature }] },
      { ...good, panelId: new Uint8Array(31) },
      { ...good, keySet: Array.from({ length: 17 }, (_, i) => ({ ...a!, index: i + 1 })) },
    ])
      expect(() => encodeCeremonyRegistration(bad)).toThrow(EncodeError);
  });

  test("decodes strictly", () => {
    const good = encodeCeremonyRegistration(fromVectors());
    const seats = keySet7.length;
    const firstPoint = 97 + 1 + 32;
    const lastApproval = good.length - 65;
    const cases: [string, Uint8Array, string][] = [
      ["trailing byte", new Uint8Array([...good, 0]), "trailing-bytes"],
      ["truncated", good.slice(0, -1), "truncated"],
      ["no seats", new Uint8Array([...good.slice(0, 96), 0, 0]), "non-canonical"],
      ["too many seats", new Uint8Array([...good.slice(0, 96), 17]), "length-over-max"],
    ];
    const edit = (at: number, bytes: Uint8Array) => {
      const b = good.slice();
      b.set(bytes, at);
      return b;
    };
    // The second seat's index set back to the first's.
    cases.push(["seats out of order", edit(97 + 97, Uint8Array.of(1)), "non-canonical"]);
    // x = p: the registry's `P256.isValidPublicKey` refuses coordinates ≥ p.
    cases.push(["x ≥ p", edit(firstPoint, word(p256.Point.Fp.ORDER)), "non-canonical"]);
    // (x, y + 1) isn't on the curve; (0, 0) is the library's identity.
    const y = good.slice(firstPoint + 32, firstPoint + 64);
    y[31] = y[31]! ^ 1;
    cases.push(["off the curve", edit(firstPoint + 32, y), "non-canonical"]);
    cases.push(["identity", edit(firstPoint, new Uint8Array(64)), "non-canonical"]);
    cases.push(["high s", edit(lastApproval + 33, word(N - 1n)), "non-canonical"]);
    cases.push([
      "approvals out of order",
      edit(lastApproval, Uint8Array.of(signed[0]!.index)),
      "non-canonical",
    ]);
    expect(seats).toBe(7);
    for (const [name, bytes, code] of cases) {
      let error: unknown;
      try {
        decodeCeremonyRegistration(bytes);
      } catch (e) {
        error = e;
      }
      expect(error, name).toBeInstanceOf(DecodeError);
      expect((error as DecodeError).code, name).toBe(code);
    }
  });
});
