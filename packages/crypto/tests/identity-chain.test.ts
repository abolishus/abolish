import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  checkIdentityChain,
  cscaFingerprint,
  decodeIdentityChain,
  encodeIdentityChain,
  IDENTITY_CHAIN,
  type IdentityChainPins,
  type IdentityChainRecord,
  MAX_NULLIFIER_PROOF,
  type NullifierQueryStatement,
  RECORD_TYPES,
  TAG_REGISTRY,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/identity-chain.json comes from an independent Python
// implementation of docs/spec/identity-chain.md (scripts/identity-chain-
// vectors.py, sharing nothing with this package), so these values never come
// from the code under test. Its keys are hashes of labels and its proofs
// 96-byte stand-ins: the proofs are the circuits' to check (P3-4 part 2b-4d-2).

type Proofs = Readonly<
  Record<"dsc_proof" | "id_proof" | "integrity_proof" | "age_proof" | "nationality_proof", string>
>;

interface Vectors {
  readonly format: string;
  readonly tags: { readonly fingerprint: string };
  readonly recordType: number;
  readonly maxProofLength: number;
  readonly standInProofLength: number;
  readonly parameterCommitments: {
    readonly age: { readonly minAge: number; readonly maxAge: number; readonly commitment: string };
    readonly nationality: readonly {
      readonly countries: readonly string[];
      readonly commitment: string;
    }[];
  };
  readonly anchors: readonly {
    readonly id: string;
    readonly issuer: string;
    readonly validFrom: string;
    readonly validUntil: string;
    readonly certificates: readonly {
      readonly label: string;
      readonly der: string;
      readonly fingerprint: string;
    }[];
    readonly root: string;
  }[];
  readonly deployments: readonly {
    readonly issuer: string;
    readonly nullifierType: 2 | 4;
    readonly anchors: readonly string[];
  }[];
  readonly circuits: {
    readonly dsc: readonly string[];
    readonly id: readonly string[];
    readonly integrity: readonly string[];
    readonly age: string;
    readonly nationality: string;
  };
  readonly accepted: readonly {
    readonly id: string;
    readonly deployment: string;
    readonly now: string;
    readonly commIn: string;
    readonly fields: {
      readonly proofDate: string;
      readonly anchorRoot: string;
      readonly dscKey: string;
      readonly commDsc: string;
      readonly idKey: string;
      readonly commId: string;
      readonly integrityKey: string;
      readonly proofs: Proofs;
    };
    readonly encoded: string;
    readonly publicInputs: Readonly<
      Record<"dsc" | "id" | "integrity" | "age" | "nationality", readonly string[]>
    >;
  }[];
  readonly rejected: readonly {
    readonly id: string;
    readonly deployment: string;
    readonly now: string;
    readonly encoded: string;
    readonly code: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("identity-chain.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const DAY = 86_400n;
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function pinsFor(issuer: string): IdentityChainPins {
  const deployment = vectors.deployments.find((d) => d.issuer === issuer);
  if (deployment === undefined) throw new Error(`no deployment ${issuer}`);
  const nationality = vectors.parameterCommitments.nationality.find(
    (n) => n.countries.length === 1 && n.countries[0] === issuer,
  );
  if (nationality === undefined) throw new Error(`no P_nat for ${issuer}`);
  return {
    anchors: deployment.anchors.map((id) => {
      const set = vectors.anchors.find((a) => a.id === id);
      if (set === undefined || set.issuer !== issuer) throw new Error(`no ${issuer} set ${id}`);
      return {
        root: BigInt(set.root),
        validFrom: BigInt(set.validFrom),
        validUntil: BigInt(set.validUntil),
      };
    }),
    dscKeys: vectors.circuits.dsc.map(hex),
    idKeys: vectors.circuits.id.map(hex),
    integrityKeys: vectors.circuits.integrity.map(hex),
    ageKey: hex(vectors.circuits.age),
    nationalityKey: hex(vectors.circuits.nationality),
    ageCommitment: BigInt(vectors.parameterCommitments.age.commitment),
    nationalityCommitment: BigInt(nationality.commitment),
    nullifierType: deployment.nullifierType,
  };
}

const USA = pinsFor("USA");
const good = vectors.accepted[0];
if (good === undefined || good.deployment !== "USA") throw new Error("no USA record vector");
const GOOD_BYTES = hex(good.encoded);
const GOOD_NOW = BigInt(good.now);
const GOOD_COMM_IN = BigInt(good.commIn);
// The check reads only the checked query's comm_in.
const queryWith = (commIn: bigint) => ({ comm_in: commIn }) as unknown as NullifierQueryStatement;
const GOOD_QUERY = queryWith(GOOD_COMM_IN);
const GOOD = decodeIdentityChain(GOOD_BYTES, 1);

const arbField = fc.bigInt({ min: 0n, max: BN254_R - 1n });
const arbKey = fc.uint8Array({ minLength: 32, maxLength: 32 });
const arbProof = fc.uint8Array({ maxLength: 64 });
const arbRecord: fc.Arbitrary<IdentityChainRecord> = fc.record({
  proof_date: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
  anchor_root: arbField,
  dsc_key: arbKey,
  comm_dsc: arbField,
  dsc_proof: arbProof,
  id_key: arbKey,
  comm_id: arbField,
  id_proof: arbProof,
  integrity_key: arbKey,
  integrity_proof: arbProof,
  age_proof: arbProof,
  nationality_proof: arbProof,
});

describe("vector file", () => {
  test("names this page's tag, record type and proof bound", () => {
    expect(vectors.format).toBe("abolish-identity-chain-vectors/1");
    expect(vectors.tags.fingerprint).toBe("abolish/v1/identity-chain/csca");
    expect(TAG_REGISTRY.some((t) => t.tag === vectors.tags.fingerprint)).toBe(true);
    expect(vectors.recordType).toBe(RECORD_TYPES.identityChain);
    expect(IDENTITY_CHAIN.recordType).toBe(0x0024);
    expect(vectors.maxProofLength).toBe(MAX_NULLIFIER_PROOF);
  });
});

describe("CSCA fingerprint", () => {
  const certificates = vectors.anchors.flatMap((a) => a.certificates);

  test.each(certificates)("$label", (c) => {
    const f = cscaFingerprint(hex(c.der));
    expect(f).toBe(BigInt(c.fingerprint));
    expect(f < BN254_R).toBe(true);
  });

  test("is below r for any DER", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (der) => {
        const f = cscaFingerprint(der);
        expect(f >= 0n && f < 2n ** 248n).toBe(true);
      }),
      { numRuns },
    );
  });
});

describe("identity-chain record", () => {
  test.each(vectors.accepted)("$id: encodes, decodes and passes up to its proofs", (v) => {
    const bytes = hex(v.encoded);
    const record = decodeIdentityChain(bytes, 1);
    const f = v.fields;
    expect(record).toEqual({
      proof_date: BigInt(f.proofDate),
      anchor_root: BigInt(f.anchorRoot),
      dsc_key: hex(f.dscKey),
      comm_dsc: BigInt(f.commDsc),
      dsc_proof: hex(f.proofs.dsc_proof),
      id_key: hex(f.idKey),
      comm_id: BigInt(f.commId),
      id_proof: hex(f.proofs.id_proof),
      integrity_key: hex(f.integrityKey),
      integrity_proof: hex(f.proofs.integrity_proof),
      age_proof: hex(f.proofs.age_proof),
      nationality_proof: hex(f.proofs.nationality_proof),
    });
    expect(encodeIdentityChain(record)).toEqual(bytes);

    const pins = pinsFor(v.deployment);
    const result = checkIdentityChain(pins, BigInt(v.now), queryWith(BigInt(v.commIn)), bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).toEqual(record);
    expect(result.proofs.map((p) => p.role)).toEqual([
      "dsc",
      "id",
      "integrity",
      "age",
      "nationality",
    ]);
    const [dsc, id, integrity, age, nationality] = result.proofs;
    expect(dsc?.publicInputs).toEqual(v.publicInputs.dsc.map(BigInt));
    expect(id?.publicInputs).toEqual(v.publicInputs.id.map(BigInt));
    expect(integrity?.publicInputs).toEqual(v.publicInputs.integrity.map(BigInt));
    expect(age?.publicInputs).toEqual(v.publicInputs.age.map(BigInt));
    expect(nationality?.publicInputs).toEqual(v.publicInputs.nationality.map(BigInt));
    // The links' keys are the record's; the disclosure keys are the release's.
    expect(toHex(dsc?.key ?? new Uint8Array())).toBe(f.dscKey);
    expect(toHex(id?.key ?? new Uint8Array())).toBe(f.idKey);
    expect(toHex(integrity?.key ?? new Uint8Array())).toBe(f.integrityKey);
    expect(age?.key).toEqual(pins.ageKey);
    expect(nationality?.key).toEqual(pins.nationalityKey);
    expect(result.proofs.map((p) => toHex(p.proof))).toEqual([
      f.proofs.dsc_proof,
      f.proofs.id_proof,
      f.proofs.integrity_proof,
      f.proofs.age_proof,
      f.proofs.nationality_proof,
    ]);
  });

  test("a record with five proofs of 14,656 bytes is 73,503 bytes", () => {
    const proof = new Uint8Array(14_656);
    const record = {
      ...GOOD,
      dsc_proof: proof,
      id_proof: proof,
      integrity_proof: proof,
      age_proof: proof,
      nationality_proof: proof,
    };
    expect(encodeIdentityChain(record).length).toBe(73_503);
  });

  test("round-trips arbitrary well-formed records", () => {
    fc.assert(
      fc.property(arbRecord, (record) => {
        const bytes = encodeIdentityChain(record);
        const back = decodeIdentityChain(bytes, 1);
        expect(back).toEqual(record);
        expect(encodeIdentityChain(back)).toEqual(bytes);
      }),
      { numRuns },
    );
  });
});

describe("identity-chain check", () => {
  test.each(vectors.rejected)("$id is refused with $code", (v) => {
    const result = checkIdentityChain(
      pinsFor(v.deployment),
      BigInt(v.now),
      GOOD_QUERY,
      hex(v.encoded),
    );
    expect(result).toEqual({ ok: false, code: v.code });
  });

  test("arbitrary bytes are refused, never thrown on", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 800 }), (bytes) => {
        expect(checkIdentityChain(USA, GOOD_NOW, GOOD_QUERY, bytes).ok).toBe(false);
      }),
      { numRuns },
    );
  });

  test("every byte that still decodes reaches the public inputs or the proofs", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: GOOD_BYTES.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const bytes = Uint8Array.from(GOOD_BYTES);
          bytes[at] = (bytes[at] ?? 0) ^ flip;
          const result = checkIdentityChain(USA, GOOD_NOW, GOOD_QUERY, bytes);
          if (!result.ok) return;
          const honest = checkIdentityChain(USA, GOOD_NOW, GOOD_QUERY, GOOD_BYTES);
          if (!honest.ok) throw new Error("the honest record must pass");
          // Something the proof check is handed differs, so a changed record
          // never verifies as the honest one did.
          expect(result.proofs).not.toEqual(honest.proofs);
        },
      ),
      { numRuns },
    );
  });

  test("a proof date is accepted exactly when it is a midnight within a day of the seat's day", () => {
    const set = USA.anchors[0];
    if (set === undefined) throw new Error("no USA set");
    const pins = { ...USA, anchors: [{ ...set, validFrom: 0n, validUntil: DAY * 2n ** 30n }] };
    fc.assert(
      fc.property(
        fc.bigInt({ min: 3n * DAY, max: 2n ** 40n }),
        fc.bigInt({ min: -3n * DAY, max: 3n * DAY }),
        (now, offset) => {
          const today = now - (now % DAY);
          const date = today + offset;
          const bytes = encodeIdentityChain({ ...GOOD, proof_date: date });
          const result = checkIdentityChain(pins, now, GOOD_QUERY, bytes);
          const accepted = date % DAY === 0n && offset >= -DAY && offset <= DAY;
          expect(result.ok ? "ok" : result.code).toBe(accepted ? "ok" : "chain-date");
        },
      ),
      { numRuns },
    );
  });

  test("an anchor set covers [valid_from, valid_until) and nothing else", () => {
    const set = USA.anchors[0];
    if (set === undefined) throw new Error("no USA set");
    const pins = { ...USA, anchors: [set] };
    for (const [date, ok] of [
      [set.validFrom - DAY, false],
      [set.validFrom, true],
      [set.validUntil - DAY, true],
      [set.validUntil, false],
    ] as const) {
      const bytes = encodeIdentityChain({ ...GOOD, proof_date: date, anchor_root: set.root });
      const result = checkIdentityChain(pins, date, GOOD_QUERY, bytes);
      expect(result.ok ? "ok" : result.code).toBe(ok ? "ok" : "chain-anchor");
    }
    // Another root with the same interval is refused.
    const other = encodeIdentityChain({ ...GOOD, anchor_root: set.root ^ 1n });
    expect(checkIdentityChain(pins, GOOD_NOW, GOOD_QUERY, other)).toEqual({
      ok: false,
      code: "chain-anchor",
    });
  });

  test("each link's key must be in its own role's list", () => {
    const keys = [...USA.dscKeys, ...USA.idKeys, ...USA.integrityKeys, USA.ageKey];
    for (const field of ["dsc_key", "id_key", "integrity_key"] as const) {
      const own = { dsc_key: USA.dscKeys, id_key: USA.idKeys, integrity_key: USA.integrityKeys }[
        field
      ];
      for (const key of keys) {
        const bytes = encodeIdentityChain({ ...GOOD, [field]: key });
        const result = checkIdentityChain(USA, GOOD_NOW, GOOD_QUERY, bytes);
        const ok = own.some((k) => toHex(k) === toHex(key));
        expect(result.ok ? "ok" : result.code).toBe(ok ? "ok" : "chain-circuit");
      }
    }
  });

  test("the disclosure proofs' inputs are the pins', the query's and the record's date only", () => {
    const zkrVector = vectors.accepted.find((v) => v.deployment === "ZKR");
    if (zkrVector === undefined) throw new Error("no ZKR record vector");
    const zkr = pinsFor("ZKR");
    const result = checkIdentityChain(
      zkr,
      BigInt(zkrVector.now),
      queryWith(7n),
      hex(zkrVector.encoded),
    );
    if (!result.ok) throw new Error("the ZKR record must pass");
    const date = result.record.proof_date;
    const [, , integrity, age, nationality] = result.proofs;
    expect(age?.publicInputs).toEqual([7n, date, 0n, 0n, zkr.ageCommitment, 2n, 0n, 0n]);
    expect(nationality?.publicInputs).toEqual([
      7n,
      date,
      0n,
      0n,
      zkr.nationalityCommitment,
      2n,
      0n,
      0n,
    ]);
    expect(integrity?.publicInputs).toEqual([result.record.comm_id, 7n]);
  });

  test("refuses a comm_in or a clock it can't use", () => {
    expect(() => checkIdentityChain(USA, GOOD_NOW, queryWith(BN254_R), GOOD_BYTES)).toThrow(
      RangeError,
    );
    expect(() => checkIdentityChain(USA, GOOD_NOW, queryWith(-1n), GOOD_BYTES)).toThrow(RangeError);
    expect(() => checkIdentityChain(USA, -1n, GOOD_QUERY, GOOD_BYTES)).toThrow(RangeError);
  });

  test("refuses pins no release could mean", () => {
    const [first, second] = USA.anchors;
    if (first === undefined || second === undefined) throw new Error("two USA sets");
    const bad: readonly Partial<IdentityChainPins>[] = [
      { dscKeys: [...USA.dscKeys, new Uint8Array(31)] },
      { idKeys: [...USA.idKeys, ...USA.dscKeys.slice(0, 1)] },
      { ageKey: USA.nationalityKey },
      { dscKeys: [...USA.dscKeys, ...USA.dscKeys] },
      { anchors: [{ ...first, validFrom: first.validFrom + 1n }] },
      { anchors: [{ ...first, validUntil: first.validFrom }] },
      { anchors: [{ ...first, root: BN254_R }] },
      { anchors: [first, { ...second, validFrom: first.validUntil - DAY }] },
      { ageCommitment: BN254_R },
      { nationalityCommitment: -1n },
      { nullifierType: 3 as 2 },
    ];
    for (const change of bad)
      expect(() =>
        checkIdentityChain({ ...USA, ...change }, GOOD_NOW, GOOD_QUERY, GOOD_BYTES),
      ).toThrow(RangeError);
    // Adjacent sets, in either order, are fine.
    expect(
      checkIdentityChain({ ...USA, anchors: [second, first] }, GOOD_NOW, GOOD_QUERY, GOOD_BYTES).ok,
    ).toBe(true);
  });
});
