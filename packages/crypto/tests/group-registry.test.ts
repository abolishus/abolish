import fc from "fast-check";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, test } from "vite-plus/test";
import {
  ADD_MEMBERS_TYPE,
  addMembersStructHash,
  BN254_R,
  checkGroupApprovals,
  decodeGroupAddition,
  decodeGroupRemoval,
  encodeGroupAddition,
  encodeGroupRemoval,
  EncodeError,
  type GroupAddition,
  groupAdditionDigest,
  type GroupApproval,
  GROUP_REGISTRY_DOMAIN_TYPE,
  GROUP_REGISTRY_MAX_BATCH,
  GROUP_REGISTRY_MAX_REGISTRARS,
  groupRegistryDomainSeparator,
  type GroupRemoval,
  groupRemovalDigest,
  isForbiddenCommitment,
  POSEIDON2_ZERO_ONE,
  REMOVE_MEMBERS_TYPE,
  removeMembersStructHash,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/group-registry.json comes from an independent Python
// implementation (scripts/group-registry-vectors.py, standard library only:
// its own Keccak-256, secp256k1 and RFC 6979, checked against EIP-712's Mail
// example and RFC 6979's secp256k1 vector), so these expected values never
// come from the code under test.

interface ApprovalVector {
  readonly seat: number;
  readonly r: string;
  readonly s: string;
  readonly v: number;
  readonly signer: string;
}

interface RecordVector {
  readonly id: string;
  readonly description: string;
  readonly groupId: number | bigint;
  readonly tier: number;
  readonly structHash: string;
  readonly digest: string;
  readonly record: string;
  readonly approvals: readonly ApprovalVector[];
}

interface GroupRegistryVectors {
  readonly format: string;
  readonly domain: {
    readonly name: string;
    readonly version: string;
    readonly chainId: number;
    readonly verifyingContract: string;
    readonly typeHash: string;
    readonly separator: string;
  };
  readonly types: Readonly<
    Record<"AddMembers" | "RemoveMembers", { readonly type: string; readonly typeHash: string }>
  >;
  readonly constants: {
    readonly maxBatch: number;
    readonly maxRegistrars: number;
    readonly fieldModulus: string;
    readonly poseidon2_0_1: string;
  };
  readonly registrars: {
    readonly threshold: number;
    readonly secretKeys: readonly string[];
    readonly addresses: readonly string[];
    readonly outsiderSecretKey: string;
  };
  readonly commitments: readonly { readonly value: string; readonly forbidden: boolean }[];
  readonly additions: readonly (RecordVector & {
    readonly firstIndex: number | bigint;
    readonly commitments: readonly string[];
  })[];
  readonly removals: readonly (RecordVector & {
    readonly size: number | bigint;
    readonly indices: readonly (number | bigint)[];
  })[];
  readonly rejected: readonly {
    readonly id: string;
    readonly kind: "add" | "remove";
    readonly description: string;
    readonly record: string;
    readonly error: string;
    readonly seat?: number;
  }[];
}

// Integers are JSON numbers, and `groupId` reaches 2^64 − 1, beyond a double's
// precision: unsafe integers are read from their source text instead.
const vectors = JSON.parse(
  readFileSync(new URL("group-registry.json", SPEC_VECTORS), "utf8"),
  (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && !Number.isSafeInteger(value) && context?.source !== undefined
      ? BigInt(context.source)
      : value,
) as GroupRegistryVectors;

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const big = (s: string) => BigInt(`0x${s}`);
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run recovers secp256k1 keys in pure JS (a few ms each), and CI runs 1000.
const SLOW = 300_000;
const N = secp256k1.Point.Fn.ORDER;
const HALF_N = (N - 1n) / 2n;

const DOMAIN = groupRegistryDomainSeparator(
  BigInt(vectors.domain.chainId),
  hex(vectors.domain.verifyingContract),
);
const REGISTRARS = vectors.registrars.addresses.map(hex);
const THRESHOLD = vectors.registrars.threshold;
const SECRETS = vectors.registrars.secretKeys.map(hex);
// Every vector is checked against tier-0 groups (contracts.md: only tier 0 has additions).
const TIER = 0;

const additionDigest = (a: GroupAddition) =>
  groupAdditionDigest(DOMAIN, {
    groupId: a.groupId,
    tier: TIER,
    firstIndex: a.firstIndex,
    commitments: a.commitments,
  });
const removalDigest = (rm: GroupRemoval) =>
  groupRemovalDigest(DOMAIN, {
    groupId: rm.groupId,
    tier: TIER,
    size: rm.size,
    indices: rm.indices,
  });

/** What a verifier does with an addition record: decode, then rules 7 and 8. */
function verifyAddition(record: Uint8Array): { error?: string; seat?: number } {
  const d = decodeGroupAddition(record);
  if (!d.ok) return { error: d.error };
  const c = checkGroupApprovals(additionDigest(d.value), d.value.approvals, REGISTRARS, THRESHOLD);
  return c.ok
    ? {}
    : c.error === "approvals"
      ? { error: c.error }
      : { error: c.error, seat: c.seat };
}

function verifyRemoval(record: Uint8Array): { error?: string; seat?: number } {
  const d = decodeGroupRemoval(record);
  if (!d.ok) return { error: d.error };
  const c = checkGroupApprovals(removalDigest(d.value), d.value.approvals, REGISTRARS, THRESHOLD);
  return c.ok
    ? {}
    : c.error === "approvals"
      ? { error: c.error }
      : { error: c.error, seat: c.seat };
}

/** Signs the digest itself (no prehash), RFC 6979, low-s, as an Ethereum key does. */
function sign(secretKey: Uint8Array, digest: Uint8Array, seat: number): GroupApproval {
  const sig = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, secretKey, { prehash: false, lowS: true, format: "recovered" }),
    "recovered",
  );
  // Ids 2 and 3 (x(R) ≥ N) have no v; with these keys they never occur.
  if (sig.recovery !== 0 && sig.recovery !== 1) throw new Error("unexpected recovery id");
  return { seat, r: sig.r, s: sig.s, v: 27 + sig.recovery };
}

const address = (secretKey: Uint8Array) =>
  keccak_256(secp256k1.getPublicKey(secretKey, false).subarray(1)).subarray(12);

const approvalOf = (a: ApprovalVector): GroupApproval => ({
  seat: a.seat,
  r: big(a.r),
  s: big(a.s),
  v: a.v,
});

// A record's fields with no checks at all, so the tests can show that a
// rejected vector fails only the rule it is meant to break.
function rawParse(record: Uint8Array, kind: "add" | "remove") {
  const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
  const groupId = view.getBigUint64(0);
  // `first_index` for an addition, `size` for a removal.
  const position = view.getBigUint64(8);
  let at = 16;
  const count = view.getUint16(at);
  at += 2;
  const items: bigint[] = [];
  for (let i = 0; i < count; i++) {
    if (kind === "add") {
      items.push(big(toHex(record.subarray(at, at + 32))));
      at += 32;
    } else {
      items.push(view.getBigUint64(at));
      at += 8;
    }
  }
  const approvals: GroupApproval[] = [];
  for (let n = record[at++] ?? 0; n > 0; n--, at += 66)
    approvals.push({
      seat: record[at] ?? 0,
      r: big(toHex(record.subarray(at + 1, at + 33))),
      s: big(toHex(record.subarray(at + 33, at + 65))),
      v: record[at + 65] ?? 0,
    });
  const digest =
    kind === "add"
      ? groupAdditionDigest(DOMAIN, {
          groupId,
          tier: TIER,
          firstIndex: position,
          commitments: items,
        })
      : groupRemovalDigest(DOMAIN, { groupId, tier: TIER, size: position, indices: items });
  return { digest, approvals };
}

describe("group-registry vectors", () => {
  test("are the format this reader expects", () => {
    expect(vectors.format).toBe("abolish-group-registry-vectors/1");
    expect(vectors.domain.name).toBe("Abolish group registry");
    expect(vectors.domain.version).toBe("1");
  });

  test("give the constants the module pins", () => {
    expect(GROUP_REGISTRY_MAX_BATCH).toBe(vectors.constants.maxBatch);
    expect(GROUP_REGISTRY_MAX_REGISTRARS).toBe(vectors.constants.maxRegistrars);
    expect(BN254_R).toBe(big(vectors.constants.fieldModulus));
    expect(POSEIDON2_ZERO_ONE).toBe(big(vectors.constants.poseidon2_0_1));
  });

  test("give the domain separator and type hashes", () => {
    const utf8 = new TextEncoder();
    expect(toHex(keccak_256(utf8.encode(GROUP_REGISTRY_DOMAIN_TYPE)))).toBe(
      vectors.domain.typeHash,
    );
    expect(toHex(DOMAIN)).toBe(vectors.domain.separator);
    expect(ADD_MEMBERS_TYPE).toBe(vectors.types.AddMembers.type);
    expect(REMOVE_MEMBERS_TYPE).toBe(vectors.types.RemoveMembers.type);
    expect(toHex(keccak_256(utf8.encode(ADD_MEMBERS_TYPE)))).toBe(
      vectors.types.AddMembers.typeHash,
    );
    expect(toHex(keccak_256(utf8.encode(REMOVE_MEMBERS_TYPE)))).toBe(
      vectors.types.RemoveMembers.typeHash,
    );
  });

  test("give registrar addresses in ascending order, derived from their keys", () => {
    expect(SECRETS.map((k) => toHex(address(k)))).toEqual(vectors.registrars.addresses);
    expect([...vectors.registrars.addresses].sort()).toEqual(vectors.registrars.addresses);
  });

  test.each(vectors.commitments)("classifies commitment $value (forbidden: $forbidden)", (c) => {
    expect(isForbiddenCommitment(big(c.value))).toBe(c.forbidden);
  });

  describe.each(vectors.additions)("addition $id", (v) => {
    test("decodes to the vector's fields and re-encodes to its bytes", () => {
      const d = decodeGroupAddition(hex(v.record));
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(d.value.groupId).toBe(BigInt(v.groupId));
      expect(d.value.firstIndex).toBe(BigInt(v.firstIndex));
      expect(d.value.commitments).toEqual(v.commitments.map(big));
      expect(d.value.approvals).toEqual(v.approvals.map(approvalOf));
      expect(toHex(encodeGroupAddition(d.value))).toBe(v.record);
    });

    test("gives the struct hash and digest", () => {
      const message = {
        groupId: BigInt(v.groupId),
        tier: v.tier,
        firstIndex: BigInt(v.firstIndex),
        commitments: v.commitments.map(big),
      };
      expect(toHex(addMembersStructHash(message))).toBe(v.structHash);
      expect(toHex(groupAdditionDigest(DOMAIN, message))).toBe(v.digest);
    });

    test("is authorised by its approvals, each by its seat's registrar", () => {
      const digest = hex(v.digest);
      expect(
        checkGroupApprovals(digest, v.approvals.map(approvalOf), REGISTRARS, THRESHOLD),
      ).toEqual({ ok: true });
      for (const a of v.approvals) {
        expect(a.signer).toBe(vectors.registrars.addresses[a.seat - 1]);
        // The vectors' signatures are reproduced byte for byte by RFC 6979.
        expect(sign(hex(vectors.registrars.secretKeys[a.seat - 1] ?? ""), digest, a.seat)).toEqual(
          approvalOf(a),
        );
      }
    });
  });

  describe.each(vectors.removals)("removal $id", (v) => {
    test("decodes to the vector's fields and re-encodes to its bytes", () => {
      const d = decodeGroupRemoval(hex(v.record));
      expect(d.ok).toBe(true);
      if (!d.ok) return;
      expect(d.value.groupId).toBe(BigInt(v.groupId));
      expect(d.value.size).toBe(BigInt(v.size));
      expect(d.value.indices).toEqual(v.indices.map((x) => BigInt(x)));
      expect(d.value.approvals).toEqual(v.approvals.map(approvalOf));
      expect(toHex(encodeGroupRemoval(d.value))).toBe(v.record);
    });

    test("gives the struct hash and digest", () => {
      const message = {
        groupId: BigInt(v.groupId),
        tier: v.tier,
        size: BigInt(v.size),
        indices: v.indices.map((x) => BigInt(x)),
      };
      expect(toHex(removeMembersStructHash(message))).toBe(v.structHash);
      expect(toHex(groupRemovalDigest(DOMAIN, message))).toBe(v.digest);
    });

    test("is authorised by its approvals, each by its seat's registrar", () => {
      const digest = hex(v.digest);
      expect(
        checkGroupApprovals(digest, v.approvals.map(approvalOf), REGISTRARS, THRESHOLD),
      ).toEqual({ ok: true });
      for (const a of v.approvals) {
        expect(a.signer).toBe(vectors.registrars.addresses[a.seat - 1]);
        expect(sign(hex(vectors.registrars.secretKeys[a.seat - 1] ?? ""), digest, a.seat)).toEqual(
          approvalOf(a),
        );
      }
    });
  });

  test.each(vectors.rejected)("refuses $id ($description) as $error", (v) => {
    const result = (v.kind === "add" ? verifyAddition : verifyRemoval)(hex(v.record));
    expect(result).toEqual(
      v.seat === undefined ? { error: v.error } : { error: v.error, seat: v.seat },
    );
  });
});

describe("each check is what refuses its vectors", () => {
  // Without the rule a vector breaks, the rest of the checks would accept it:
  // its approvals are genuine signatures over what it says.
  const signedElsewhereFine = vectors.rejected.filter((v) =>
    ["forbidden-commitment", "index-order", "index-range", "batch"].includes(v.error),
  );
  test.each(signedElsewhereFine)("$id carries valid approvals", (v) => {
    const { digest, approvals } = rawParse(hex(v.record), v.kind);
    expect(checkGroupApprovals(digest, approvals, REGISTRARS, THRESHOLD)).toEqual({ ok: true });
  });

  test("a high-s twin recovers the same registrar, so only the low-s rule refuses it", () => {
    const v = vectors.additions[0];
    if (v === undefined) throw new Error("no additions");
    const a = approvalOf(v.approvals[0] as ApprovalVector);
    const twin = new secp256k1.Signature(a.r, N - a.s, 1 - (a.v - 27));
    const recovered = keccak_256(twin.recoverPublicKey(hex(v.digest)).toBytes(false).subarray(1));
    expect(toHex(recovered.subarray(12))).toBe(vectors.registrars.addresses[a.seat - 1]);
    const result = checkGroupApprovals(
      hex(v.digest),
      [{ ...a, s: N - a.s, v: a.v === 27 ? 28 : 27 }, ...v.approvals.slice(1).map(approvalOf)],
      REGISTRARS,
      THRESHOLD,
    );
    expect(result).toEqual({ ok: false, error: "signature", seat: a.seat });
  });

  test("v = 29 would recover a key through x(R) = r + N, so only the v rule refuses it", () => {
    // An R whose x is at least N: ecrecover's v can't name it, but recovery
    // id 2 can, so a v outside {27, 28} passed through would recover a key.
    const P = secp256k1.Point.Fp.ORDER;
    let k = 1n;
    for (; N + k < P; k++) {
      try {
        secp256k1.Point.fromBytes(Uint8Array.of(2, ...hex((N + k).toString(16).padStart(64, "0"))));
        break;
      } catch {
        // Not an x on the curve; try the next one.
      }
    }
    const digest = keccak_256(new TextEncoder().encode("v-29"));
    const forged = { seat: 0, r: k, s: 1n, v: 29 };
    const q = new secp256k1.Signature(k, 1n, 2).recoverPublicKey(digest);
    const forgedSigner = keccak_256(q.toBytes(false).subarray(1)).subarray(12);
    const set = [forgedSigner, REGISTRARS[0] as Uint8Array].sort((a, b) =>
      toHex(a) < toHex(b) ? -1 : 1,
    );
    const forgedSeat = set[0] === forgedSigner ? 1 : 2;
    const honest = sign(SECRETS[0] as Uint8Array, digest, 3 - forgedSeat);
    const approvals = [{ ...forged, seat: forgedSeat }, honest].sort((x, y) => x.seat - y.seat);
    expect(checkGroupApprovals(digest, approvals, set, 2)).toEqual({
      ok: false,
      error: "signature",
      seat: forgedSeat,
    });
  });

  test("a repeated seat would count one registrar twice", () => {
    const v = vectors.rejected.find((x) => x.id === "seat-repeated");
    if (v === undefined) throw new Error("no seat-repeated vector");
    const { digest, approvals } = rawParse(hex(v.record), "add");
    // Each approval alone is registrar 1's signature: only the seat order refuses the pair.
    for (const a of approvals)
      expect(
        checkGroupApprovals(digest, [a, { ...a, seat: 2 }], REGISTRARS, THRESHOLD),
      ).toMatchObject({ ok: false, error: "signature", seat: 2 });
    expect(checkGroupApprovals(digest, approvals, REGISTRARS, THRESHOLD)).toEqual({
      ok: false,
      error: "seat",
      seat: 1,
    });
  });

  test("refuses a registrar set that breaks the deployment rules", () => {
    const digest = new Uint8Array(32);
    const [a1, a2, a3] = REGISTRARS as [Uint8Array, Uint8Array, Uint8Array];
    expect(() => checkGroupApprovals(digest, [], [a1, a2, a3], 1)).toThrow(RangeError);
    expect(() => checkGroupApprovals(digest, [], [a1, a2], 3)).toThrow(RangeError);
    expect(() => checkGroupApprovals(digest, [], [a1], 2)).toThrow(RangeError);
    expect(() => checkGroupApprovals(digest, [], [a2, a1], 2)).toThrow(RangeError);
    expect(() => checkGroupApprovals(digest, [], [a1, a1], 2)).toThrow(RangeError);
    expect(() => checkGroupApprovals(digest, [], [new Uint8Array(20), a1], 2)).toThrow(RangeError);
    const many = Array.from({ length: 17 }, (_, i) => Uint8Array.from({ length: 20 }, () => i + 1));
    expect(() => checkGroupApprovals(digest, [], many, 2)).toThrow(RangeError);
  });

  test("the encoders refuse what the decoders refuse", () => {
    const base: GroupAddition = { groupId: 0n, firstIndex: 0n, commitments: [2n], approvals: [] };
    expect(() => encodeGroupAddition({ ...base, commitments: [] })).toThrow(EncodeError);
    expect(() =>
      encodeGroupAddition({ ...base, commitments: Array.from({ length: 257 }, () => 2n) }),
    ).toThrow(EncodeError);
    for (const c of [0n, 1n, POSEIDON2_ZERO_ONE, BN254_R])
      expect(() => encodeGroupAddition({ ...base, commitments: [c] })).toThrow(EncodeError);
    expect(() => encodeGroupAddition({ ...base, groupId: 1n << 64n })).toThrow(EncodeError);
    const removal: GroupRemoval = { groupId: 0n, size: 3n, indices: [2n, 1n], approvals: [] };
    expect(() => encodeGroupRemoval(removal)).toThrow(EncodeError);
    expect(() => encodeGroupRemoval({ ...removal, indices: [1n, 1n] })).toThrow(EncodeError);
    expect(() => encodeGroupRemoval({ ...removal, indices: [1n, 3n] })).toThrow(EncodeError);
    expect(() => encodeGroupRemoval({ ...removal, size: 0n, indices: [0n] })).toThrow(EncodeError);
  });
});

const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
const word = fc.bigInt({ min: 0n, max: (1n << 256n) - 1n });
const approval = fc.record({
  seat: fc.integer({ min: 0, max: 255 }),
  r: word,
  s: word,
  v: fc.integer({ min: 0, max: 255 }),
});
const commitment = fc
  .bigInt({ min: 0n, max: BN254_R - 1n })
  .filter((c) => !isForbiddenCommitment(c));
const addition = fc.record({
  groupId: u64,
  firstIndex: u64,
  commitments: fc.array(commitment, { minLength: 1, maxLength: 8 }),
  approvals: fc.array(approval, { maxLength: 4 }),
});
const removal = fc
  .record({
    groupId: u64,
    indices: fc
      .uniqueArray(fc.bigInt({ min: 0n, max: (1n << 64n) - 2n }), { minLength: 1, maxLength: 8 })
      .map((xs) => xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
    approvals: fc.array(approval, { maxLength: 4 }),
  })
  .chain((rm) =>
    fc
      .bigInt({ min: (rm.indices.at(-1) ?? 0n) + 1n, max: (1n << 64n) - 1n })
      .map((size) => ({ groupId: rm.groupId, size, indices: rm.indices, approvals: rm.approvals })),
  );

describe("group-registry properties", () => {
  test("decode(encode(x)) = x for additions and removals", () => {
    fc.assert(
      fc.property(addition, (a) => {
        const d = decodeGroupAddition(encodeGroupAddition(a));
        expect(d).toEqual({ ok: true, value: a });
      }),
      { numRuns },
    );
    fc.assert(
      fc.property(removal, (rm) => {
        const d = decodeGroupRemoval(encodeGroupRemoval(rm));
        expect(d).toEqual({ ok: true, value: rm });
      }),
      { numRuns },
    );
  });

  // Byte strings shaped like records (a count and an approvals byte that
  // agree with the length) as well as arbitrary ones, so the property reaches
  // past the length check.
  const shaped = (kind: "add" | "remove") =>
    fc
      .tuple(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 3 }),
        fc.uint8Array({ minLength: 0, maxLength: 400 }),
      )
      .map(([head, count, n, fill]) => {
        const item = kind === "add" ? 32 : 8;
        const out = new Uint8Array(head.length + 3 + item * count + 66 * n);
        out.set(head);
        out[head.length + 1] = count;
        out.set(fill.subarray(0, item * count), head.length + 2);
        out[head.length + 2 + item * count] = n;
        out.set(fill.subarray(0, 66 * n), head.length + 3 + item * count);
        return out;
      });

  test("a removal naming an index at or beyond its signed size is refused as index-range", () => {
    fc.assert(
      fc.property(removal, fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (rm, size) => {
        // The record re-encoded with another size, bypassing the encoder's check.
        const b = encodeGroupRemoval(rm);
        new DataView(b.buffer).setBigUint64(8, size);
        const d = decodeGroupRemoval(b);
        const reaches = rm.indices.every((i) => i < size);
        expect(d.ok ? null : d.error).toBe(reaches ? null : "index-range");
      }),
      { numRuns },
    );
  });

  test.each(["add", "remove"] as const)(
    "%s: any bytes are refused or decode and re-encode to themselves",
    (kind) => {
      const decodeRec = kind === "add" ? decodeGroupAddition : decodeGroupRemoval;
      fc.assert(
        fc.property(fc.oneof(fc.uint8Array({ maxLength: 300 }), shaped(kind)), (b) => {
          const d = decodeRec(b);
          if (!d.ok) return;
          const again =
            kind === "add"
              ? encodeGroupAddition(d.value as GroupAddition)
              : encodeGroupRemoval(d.value as GroupRemoval);
          expect(toHex(again)).toBe(toHex(b));
        }),
        { numRuns },
      );
    },
  );

  test(
    "any single-bit flip in a signed record is refused",
    () => {
      const records: [kind: "add" | "remove", record: string][] = [
        ...vectors.additions
          .filter((v) => v.commitments.length <= 3)
          .map((v) => ["add", v.record] as ["add", string]),
        ...vectors.removals.map((v) => ["remove", v.record] as ["remove", string]),
      ];
      fc.assert(
        fc.property(
          fc.constantFrom(...records),
          fc.nat(),
          fc.integer({ min: 0, max: 7 }),
          ([kind, recordHex], at, bit) => {
            const b = hex(recordHex);
            b[at % b.length] = (b[at % b.length] ?? 0) ^ (1 << bit);
            const result = (kind === "add" ? verifyAddition : verifyRemoval)(b);
            expect(result.error).toBeDefined();
          },
        ),
        { numRuns },
      );
    },
    SLOW,
  );

  test(
    "signatures by keys outside the set are refused at their seat",
    () => {
      const v = vectors.additions[0];
      if (v === undefined) throw new Error("no additions");
      const digest = hex(v.digest);
      const honest = v.approvals.map(approvalOf);
      fc.assert(
        fc.property(
          fc
            .uint8Array({ minLength: 32, maxLength: 32 })
            .filter((k) => secp256k1.utils.isValidSecretKey(k)),
          fc.integer({ min: 1, max: 3 }),
          (key, seat) => {
            fc.pre(!SECRETS.some((s) => toHex(s) === toHex(key)));
            const forged = sign(key, digest, seat);
            const approvals = [...honest.filter((a) => a.seat !== seat), forged].sort(
              (x, y) => x.seat - y.seat,
            );
            expect(checkGroupApprovals(digest, approvals, REGISTRARS, THRESHOLD)).toEqual({
              ok: false,
              error: "signature",
              seat,
            });
          },
        ),
        { numRuns },
      );
    },
    SLOW,
  );

  test(
    "a registrar's signature is accepted and its high-s twin refused",
    () => {
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          fc.integer({ min: 0, max: SECRETS.length - 1 }),
          (digest, i) => {
            const key = SECRETS[i] as Uint8Array;
            const honest = sign(key, digest, i + 1);
            expect(honest.s <= HALF_N).toBe(true);
            // Two seats, so the threshold is met; the other is the next registrar.
            const j = (i + 1) % SECRETS.length;
            const other = sign(SECRETS[j] as Uint8Array, digest, j + 1);
            const pair = (a: GroupApproval) => [a, other].sort((x, y) => x.seat - y.seat);
            expect(checkGroupApprovals(digest, pair(honest), REGISTRARS, THRESHOLD)).toEqual({
              ok: true,
            });
            const twin = { ...honest, s: N - honest.s, v: honest.v === 27 ? 28 : 27 };
            expect(checkGroupApprovals(digest, pair(twin), REGISTRARS, THRESHOLD)).toEqual({
              ok: false,
              error: "signature",
              seat: i + 1,
            });
          },
        ),
        { numRuns },
      );
    },
    SLOW,
  );
});
