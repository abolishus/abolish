import { ristretto255 } from "@noble/curves/ed25519.js";
import { expand_message_xmd } from "@noble/curves/abstract/hash-to-curve.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  challenge,
  decode,
  DecodeError,
  element,
  elementOrIdentity,
  encode,
  EncodeError,
  G,
  GENERATOR_H,
  GROUP_ORDER,
  H,
  hashToGroup,
  IDENTITY,
  scalar,
  TAG_REGISTRY,
} from "../src/index.ts";
import { hashToRistretto255, hashToScalarXmd } from "../src/group.ts";
import { ELL, pollardRho, trialDivide } from "../scripts/static-dh-factors.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/group.md: the scalar and element codecs, H, HashToScalar,
// hash_to_ristretto255 and h (T-39, T-31, T-30, T-15).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const run = <T>(p: fc.IProperty<T>) => fc.assert(p, { numRuns });
const le = (n: bigint) => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return b;
};
const readLe = (b: Uint8Array) => b.reduceRight((v, x) => (v << 8n) | BigInt(x), 0n);

function codeOf(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

const anyScalar = fc.bigInt({ min: 0n, max: GROUP_ORDER - 1n });
const anyPoint = fc.bigInt({ min: 1n, max: GROUP_ORDER - 1n }).map((k) => G.multiply(k));

describe("scalar codec", () => {
  test("the order is RFC 9496's ℓ", () => {
    expect(GROUP_ORDER).toBe(2n ** 252n + 27742317777372353535851937790883648493n);
  });

  test("round-trips every scalar, little-endian", () => {
    run(
      fc.property(anyScalar, (s) => {
        const b = encode(scalar, s);
        expect(b).toEqual(le(s));
        expect(decode(scalar, b)).toBe(s);
      }),
    );
  });

  test("accepts exactly the 32-byte strings below ℓ, and re-encodes each to itself", () => {
    run(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (b) => {
        if (readLe(b) >= GROUP_ORDER) expect(codeOf(() => decode(scalar, b))).toBe("non-canonical");
        else expect(encode(scalar, decode(scalar, b))).toEqual(b);
      }),
    );
  });

  test("rejects ℓ and above, never reducing them", () => {
    for (const v of [GROUP_ORDER, GROUP_ORDER + 1n, 2n ** 253n, 2n ** 255n, 2n ** 256n - 1n])
      expect(
        codeOf(() => decode(scalar, le(v))),
        v.toString(),
      ).toBe("non-canonical");
    run(
      fc.property(fc.bigInt({ min: GROUP_ORDER, max: 2n ** 256n - 1n }), (v) => {
        expect(codeOf(() => decode(scalar, le(v)))).toBe("non-canonical");
      }),
    );
  });

  test("reads little-endian, not big-endian", () => {
    const one = new Uint8Array(32);
    one[31] = 1; // 1 big-endian, 2^248 little-endian
    expect(decode(scalar, one)).toBe(2n ** 248n);
    expect(encode(scalar, 1n)[0]).toBe(1);
  });

  test("rejects the wrong length", () => {
    expect(codeOf(() => decode(scalar, new Uint8Array(31)))).toBe("truncated");
    expect(codeOf(() => decode(scalar, new Uint8Array(33)))).toBe("trailing-bytes");
  });

  test("has no encoding for values outside 0 to ℓ - 1", () => {
    for (const v of [-1n, GROUP_ORDER, 2n ** 256n, 1, "1", null])
      expect(() => encode(scalar, v as bigint)).toThrow(EncodeError);
  });
});

describe("element codecs", () => {
  test("round-trip every non-identity element", () => {
    run(
      fc.property(anyPoint, (p) => {
        const b = encode(element, p);
        expect(b.length).toBe(32);
        expect(decode(element, b).equals(p)).toBe(true);
        expect(encode(elementOrIdentity, p)).toEqual(b);
      }),
    );
  });

  test("every accepted 32-byte string re-encodes to itself", () => {
    run(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (b) => {
        let p;
        try {
          p = decode(elementOrIdentity, b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          expect((e as DecodeError).code).toBe("non-canonical");
          return;
        }
        expect(encode(elementOrIdentity, p)).toEqual(b);
      }),
    );
  });

  test("an encoding with the top bit set or an odd s is never accepted", () => {
    // Half of all strings fail one of these two RFC 9496 Decode checks.
    run(
      fc.property(anyPoint, fc.integer({ min: 0, max: 1 }), (p, which) => {
        const b = encode(element, p);
        if (which === 0) b[31] = (b[31] ?? 0) | 0x80;
        else b[0] = (b[0] ?? 0) ^ 1;
        expect(codeOf(() => decode(elementOrIdentity, b))).toBe("non-canonical");
      }),
    );
  });

  test("the identity is rejected unless the field allows it", () => {
    const zero = new Uint8Array(32);
    expect(codeOf(() => decode(element, zero))).toBe("non-canonical");
    expect(decode(elementOrIdentity, zero).equals(IDENTITY)).toBe(true);
    expect(() => encode(element, IDENTITY)).toThrow(EncodeError);
    expect(() => encode(element, G.multiply(GROUP_ORDER - 1n).add(G))).toThrow(EncodeError);
    expect(encode(elementOrIdentity, IDENTITY)).toEqual(zero);
  });

  test("the encoder takes only points built by @noble/curves", () => {
    const ep: unknown = Reflect.get(G, "ep");
    class Lying extends ristretto255.Point {
      override toBytes() {
        return new Uint8Array(32).fill(0xff);
      }
    }
    for (const v of [new Lying(ep as never), { toBytes: () => G.toBytes() }, G.toBytes(), null])
      expect(() => encode(element, v as typeof G)).toThrow(EncodeError);
  });

  test("a Proxy can't make the encoder write anything but a valid encoding", () => {
    const junk = new Uint8Array(32).fill(0xff);
    const lyingMethod = new Proxy(G, {
      get: (t, k) => (k === "toBytes" ? () => junk : Reflect.get(t, k)),
    });
    expect(encode(element, lyingMethod)).toEqual(encode(element, G));
    // Coordinates off the curve, as a Proxy could supply them.
    const offCurve = new Proxy(G, {
      get: (t, k) => (k === "ep" ? { X: 1n, Y: 2n, Z: 1n, T: 2n } : Reflect.get(t, k)),
    });
    let out: Uint8Array | undefined;
    try {
      out = encode(elementOrIdentity, offCurve);
    } catch (e) {
      expect(e).toBeInstanceOf(EncodeError);
    }
    if (out !== undefined)
      expect(encode(elementOrIdentity, decode(elementOrIdentity, out))).toEqual(out);
  });

  test("decoded elements don't alias the input", () => {
    const b = encode(element, G);
    const p = decode(element, b);
    b.fill(0);
    expect(p.equals(G)).toBe(true);
  });
});

describe("hash layer", () => {
  test("H is SHA-256 and copies its input first", () => {
    expect(bytesToHex(H(new Uint8Array()))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(() => H([1] as never)).toThrow(TypeError);
  });

  test("h is the hash_to_ristretto255 output of hash.json, and not 1, g or g⁻¹", () => {
    for (const p of [IDENTITY, G, G.negate()]) expect(GENERATOR_H.equals(p)).toBe(false);
    expect(bytesToHex(encode(element, GENERATOR_H))).toBe(
      "2ac338de551824e59d1a2563c133a8ec81b4007edb867d4e4411a416cc98fa34",
    );
  });

  test("an explicit DST of 16 to 255 bytes is required", () => {
    const m = new Uint8Array();
    for (const f of [hashToScalarXmd, hashToRistretto255]) {
      expect(() => f(m, undefined as never)).toThrow(TypeError);
      expect(() => f(m, "abolish/v1/generator-h" as never)).toThrow(TypeError);
      expect(() => f(m, new Uint8Array(15))).toThrow(RangeError);
      expect(() => f(m, new Uint8Array(256))).toThrow(RangeError);
      expect(() => f([] as never, new Uint8Array(16))).toThrow(TypeError);
      f(m, new Uint8Array(16));
      f(m, new Uint8Array(255));
    }
  });

  test("a different DST gives an unrelated output", () => {
    const m = new Uint8Array([1, 2, 3]);
    const a = new Uint8Array(16).fill(0x61);
    const b = a.slice();
    b[15] = 0x62;
    expect(hashToScalarXmd(m, a)).not.toBe(hashToScalarXmd(m, b));
    expect(hashToRistretto255(m, a).equals(hashToRistretto255(m, b))).toBe(false);
  });

  test("protocol entry points take only specified tags of their own primitive", () => {
    const m = new Uint8Array();
    for (const { tag, primitive, status } of TAG_REGISTRY) {
      const ok = status === "specified";
      if (primitive === "fiat-shamir" && ok) challenge(tag as never, m);
      else expect(() => challenge(tag as never, m), tag).toThrow(RangeError);
      if (primitive === "hash-to-curve" && ok) hashToGroup(tag as never, m);
      else expect(() => hashToGroup(tag as never, m), tag).toThrow(RangeError);
    }
    expect(() => hashToGroup("abolish/v1/unregistered" as never, m)).toThrow(RangeError);
  });

  test("every specified tag used as a DST is at least 16 bytes", () => {
    for (const { tag, primitive } of TAG_REGISTRY)
      if (primitive === "fiat-shamir" || primitive === "hash-to-curve")
        expect(tag.length, tag).toBeGreaterThanOrEqual(16);
  });

  // ADR 0007: @noble/curves substitutes its own DST when none is given, so
  // every call into its hash-to-curve layer from src/ must pass one.
  test("every @noble/curves hash-to-curve call in src/ passes an explicit DST", () => {
    const dir = new URL("../src/", import.meta.url);
    let calls = 0;
    for (const name of readdirSync(dir)) {
      const source = readFileSync(new URL(name, dir), "utf8");
      // The generic layer (expand_message_xmd, hash_to_field) takes a DST too,
      // but src/ has no reason to reach it except through ristretto255_hasher.
      if (/@noble\/curves\/abstract\//.test(source))
        throw new Error(`${name}: imports the generic hash-to-curve layer`);
      // Only these two names, so no OPRF or other bundle with its own default
      // DSTs, and the hasher only in the call form checked below (no
      // destructuring, aliasing or bracket access).
      for (const m of source.matchAll(/import \{([^}]*)\} from "@noble\/curves\/ed25519\.js"/g))
        expect(m[1]?.trim(), name).toBe("ristretto255, ristretto255_hasher");
      expect(source.match(/ristretto255_hasher/g)?.length ?? 0, name).toBe(
        (source.match(/ristretto255_hasher\.(?:hashToScalar|hashToCurve)\(/g)?.length ?? 0) +
          (source.includes("ristretto255_hasher }") ? 1 : 0),
      );
      expect(source, name).not.toMatch(/@noble\/curves\/(?!ed25519\.js")/);
      for (const m of source.matchAll(/ristretto255_hasher\.(\w+)\(([^;]*?)\);/gs)) {
        calls++;
        expect(m[2], `${name}: ${m[0]}`).toMatch(/, \{ DST: checkDst\(dst\) \}$/);
      }
      expect(source.match(/ristretto255_hasher\.\w+\(/g)?.length ?? 0).toBe(
        [...source.matchAll(/ristretto255_hasher\.(\w+)\(([^;]*?)\);/gs)].length,
      );
    }
    expect(calls).toBe(2);
  });
});

describe("docs/spec/vectors/hash.json", () => {
  interface HashVector {
    readonly id: string;
    readonly function: "H" | "hash-to-group" | "hash-to-scalar";
    readonly dst?: string;
    readonly message: string;
    readonly uniformBytes?: string;
    readonly output: string;
    readonly notEqual?: Readonly<Record<string, string>>;
  }
  const file = JSON.parse(readFileSync(new URL("hash.json", SPEC_VECTORS), "utf8")) as {
    format: string;
    vectors: HashVector[];
  };
  const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

  test("is an abolish-hash-vectors/1 file with all 15 vectors", () => {
    expect(file.format).toBe("abolish-hash-vectors/1");
    expect(file.vectors.map((v) => v.function)).toEqual([
      "H",
      "H",
      "hash-to-group",
      ...Array<string>(12).fill("hash-to-scalar"),
    ]);
    expect(new Set(file.vectors.map((v) => v.id)).size).toBe(file.vectors.length);
  });

  test.each(file.vectors.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const m = hex(v.message);
    if (v.function === "H") {
      expect(bytesToHex(H(m))).toBe(v.output);
      return;
    }
    const dst = ascii(v.dst ?? "");
    // The intermediate expand_message_xmd output, for verifiers that build it
    // themselves (libsodium has none).
    expect(bytesToHex(expand_message_xmd(m, dst, 64, sha512))).toBe(v.uniformBytes);
    if (v.function === "hash-to-group") {
      expect(v.dst).toBe("abolish/v1/generator-h");
      expect(v.message).toBe("");
      const h = hashToGroup("abolish/v1/generator-h", m);
      expect(bytesToHex(encode(element, h))).toBe(v.output);
      expect(h.equals(GENERATOR_H)).toBe(true);
      const ne = v.notEqual ?? {};
      expect(Object.keys(ne)).toEqual(["identity", "g", "minusG"]);
      expect(ne["identity"]).toBe("00".repeat(32));
      expect(ne["g"]).toBe(bytesToHex(encode(element, G)));
      expect(ne["minusG"]).toBe(bytesToHex(encode(element, G.negate())));
      for (const other of Object.values(ne)) expect(other).not.toBe(v.output);
    } else {
      const tag = TAG_REGISTRY.find((e) => e.tag === v.dst);
      expect(tag?.primitive).toBe("fiat-shamir");
      expect(bytesToHex(encode(scalar, hashToScalarXmd(m, dst)))).toBe(v.output);
    }
  });
});

describe("static-DH factor table (ADR 0007)", () => {
  test("ℓ − 1 and ℓ + 1 have exactly the small factors the table lists", () => {
    expect(ELL).toBe(GROUP_ORDER);
    const minus = trialDivide(ELL - 1n, 2_000_000);
    const plus = trialDivide(ELL + 1n, 2_000_000);
    expect([...minus.factors]).toEqual([
      [2n, 2],
      [3n, 1],
      [11n, 1],
    ]);
    expect([...plus.factors]).toEqual([
      [2n, 1],
      [5n, 1],
      [7n, 1],
      [103n, 1],
    ]);
  });

  test("the rho search finds a planted factor", () => {
    const p = 1_000_003n;
    const q = 2n ** 61n - 1n;
    const f = pollardRho(p * q, 2 ** 16);
    expect(f === p || f === q).toBe(true);
  });
});
