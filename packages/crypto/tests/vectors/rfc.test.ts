import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { expand_message_xmd } from "@noble/curves/abstract/hash-to-curve.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vite-plus/test";
import {
  decode,
  DecodeError,
  type Element,
  element,
  elementOrIdentity,
  encode,
  G,
  IDENTITY,
  scalar,
} from "../../src/index.ts";
import { hashToRistretto255, hashToScalarXmd } from "../../src/group.ts";
import { parseFields, parseInvalidEncodings, parseMultiples, rfcSection } from "./rfc.ts";

// Published vectors for every ristretto255 configuration the protocol relies
// on (docs/spec/group.md, Test vectors; T-39, T-31, T-30). Expected values come
// from the vendored RFC texts, never from the code under test.

const Fn = ristretto255.Point.Fn;
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function codeOf(f: () => unknown): string | undefined {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.code;
    throw e;
  }
  return undefined;
}

describe("RFC 9496 Appendix A.1: multiples of the generator", () => {
  const multiples = parseMultiples(
    rfcSection("rfc9496", "A.1.  Multiples of the Generator", "A.2.  Invalid Encodings"),
  );

  test("parses all 16 multiples", () => {
    expect(multiples.length).toBe(16);
    for (const m of multiples) expect(m).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each(multiples.map((m, k) => [k, m] as const))("B[%i] decodes to k·g and back", (k, m) => {
    const p = decode(elementOrIdentity, hexToBytes(m));
    expect(p.equals(k === 0 ? ristretto255.Point.ZERO : G.multiply(BigInt(k)))).toBe(true);
    expect(bytesToHex(encode(elementOrIdentity, p))).toBe(m);
    if (k === 0) expect(codeOf(() => decode(element, hexToBytes(m)))).toBe("non-canonical");
    else expect(bytesToHex(encode(element, decode(element, hexToBytes(m))))).toBe(m);
  });
});

describe("RFC 9496 Appendix A.2: invalid encodings", () => {
  const invalid = parseInvalidEncodings(
    rfcSection(
      "rfc9496",
      "A.2.  Invalid Encodings",
      "A.3.  Group Elements from Uniform Byte Strings",
    ),
  );

  test("parses all 29 encodings in their 5 classes", () => {
    const count = (kind: string) => invalid.filter((v) => v.kind === kind).length;
    expect(count("Non-canonical field encodings.")).toBe(4);
    expect(count("Negative field elements.")).toBe(8);
    expect(count("Non-square x^2.")).toBe(8);
    expect(count("Negative x * y value.")).toBe(8);
    expect(count("s = -1, which causes y = 0.")).toBe(1);
    expect(invalid.length).toBe(29);
    for (const v of invalid) expect(v.hex).toMatch(/^[0-9a-f]{64}$/);
  });

  test.each(invalid.map((v) => [v.kind, v.hex] as const))("%s %s is rejected", (_kind, hex) => {
    expect(codeOf(() => decode(element, hexToBytes(hex)))).toBe("non-canonical");
    expect(codeOf(() => decode(elementOrIdentity, hexToBytes(hex)))).toBe("non-canonical");
  });
});

describe("RFC 9496 Appendix A.3: group elements from uniform byte strings", () => {
  const fields = parseFields(
    rfcSection(
      "rfc9496",
      "A.3.  Group Elements from Uniform Byte Strings",
      "A.4.  Square Root of a Ratio of Field Elements",
    ),
    ":",
  );
  // Each O applies to every I since the previous O.
  const pairs: [string, string][] = [];
  let inputs: string[] = [];
  for (const f of fields) {
    if (f.name === "I") inputs.push(f.value);
    else if (f.name === "O") {
      for (const i of inputs) pairs.push([i, f.value]);
      inputs = [];
    } else throw new Error(`unexpected field ${f.name}`);
  }

  test("parses all 11 inputs", () => {
    expect(inputs).toEqual([]);
    expect(pairs.length).toBe(11);
    for (const [i, o] of pairs) {
      expect(i).toMatch(/^[0-9a-f]{128}$/);
      expect(o).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // The second half of hash_to_ristretto255, as the wrapper calls it.
  test.each(pairs)("derive(%s) = %s", (i, o) => {
    const p = ristretto255_hasher.deriveToCurve?.(hexToBytes(i));
    if (p === undefined) throw new Error("@noble/curves has no deriveToCurve");
    expect(bytesToHex(encode(element, p))).toBe(o);
  });
});

describe("RFC 9380 Appendix K.3: expand_message_xmd(SHA-512)", () => {
  const fields = parseFields(
    rfcSection(
      "rfc9380",
      "K.3.  expand_message_xmd(SHA-512)",
      "K.4.  expand_message_xof(SHAKE128)",
    ),
    "=",
  );
  const header = Object.fromEntries(fields.slice(0, 4).map((f) => [f.name, f.value]));
  const vectors: { msg: string; len: number; uniform: string }[] = [];
  for (let i = 4; i < fields.length; i += 5) {
    const names = fields.slice(i, i + 5).map((f) => f.name);
    expect(names).toEqual(["msg", "len_in_bytes", "DST_prime", "msg_prime", "uniform_bytes"]);
    vectors.push({
      msg: fields[i]?.value ?? "",
      len: Number(fields[i + 1]?.value),
      uniform: fields[i + 4]?.value ?? "",
    });
  }

  test("parses the suite header and all 10 vectors", () => {
    expect(header).toEqual({
      name: "expand_message_xmd",
      DST: "QUUX-V01-CS02-with-expander-SHA512-256",
      hash: "SHA512",
      k: "256",
    });
    expect(vectors.map((v) => v.len)).toEqual([32, 32, 32, 32, 32, 128, 128, 128, 128, 128]);
  });

  test.each(vectors.map((v) => [v.msg.slice(0, 16), v.len, v] as const))(
    "msg %s…, %i bytes",
    (_m, _l, v) => {
      expect(v.uniform).toMatch(new RegExp(`^[0-9a-f]{${2 * v.len}}$`));
      const out = expand_message_xmd(ascii(v.msg), ascii(header["DST"] ?? ""), v.len, sha512);
      expect(bytesToHex(out)).toBe(v.uniform);
    },
  );
});

// RFC 9497 Appendix A.1 (ristretto255-SHA512) exercises HashToScalar under
// three DSTs, hash_to_ristretto255, and the scalar and element codecs end to
// end. Each step below is the RFC's own (§3.2.1 DeriveKeyPair, §3.3 Blind,
// BlindEvaluate and Finalize, §2.2.1 GenerateProof), written with the
// wrappers under test and @noble/curves group operations.
describe("RFC 9497 Appendix A.1: ristretto255-SHA512", () => {
  const modes = [
    { mode: 0, name: "OPRF", from: "A.1.1.  OPRF Mode", to: "A.1.2.  VOPRF Mode" },
    { mode: 1, name: "VOPRF", from: "A.1.2.  VOPRF Mode", to: "A.1.3.  POPRF Mode" },
    { mode: 2, name: "POPRF", from: "A.1.3.  POPRF Mode", to: "A.2.  decaf448-SHAKE256" },
  ] as const;

  const i2osp = (n: number, len: number) =>
    Uint8Array.from({ length: len }, (_, i) => (n >> (8 * (len - 1 - i))) & 0xff);
  const framed = (b: Uint8Array) => concatBytes(i2osp(b.length, 2), b);
  const ser = (p: Element) => encode(element, p);

  for (const { mode, name, from, to } of modes) {
    const fields = parseFields(rfcSection("rfc9497", from, to), "=");
    const keyFields = name === "OPRF" ? 3 : 4;
    const key = Object.fromEntries(fields.slice(0, keyFields).map((f) => [f.name, f.value]));
    const perVector = name === "OPRF" ? 5 : name === "VOPRF" ? 7 : 8;
    const vectors: Record<string, string>[] = [];
    for (let i = keyFields; i < fields.length; i += perVector)
      vectors.push(
        Object.fromEntries(fields.slice(i, i + perVector).map((f) => [f.name, f.value])),
      );

    const context = concatBytes(ascii("OPRFV1-"), i2osp(mode, 1), ascii("-ristretto255-SHA512"));
    const dst = (prefix: string) => concatBytes(ascii(prefix), context);

    describe(`${name} mode`, () => {
      test(`parses the key and ${name === "OPRF" ? 2 : 3} vectors`, () => {
        expect(Object.keys(key)).toEqual(
          name === "OPRF" ? ["Seed", "KeyInfo", "skSm"] : ["Seed", "KeyInfo", "skSm", "pkSm"],
        );
        expect(vectors.length).toBe(name === "OPRF" ? 2 : 3);
      });

      // §3.2.1 DeriveKeyPair: HashToScalar under "DeriveKeyPair" ‖ contextString.
      const seed = hexToBytes(key["Seed"] ?? "");
      const info = hexToBytes(key["KeyInfo"] ?? "");
      const deriveInput = concatBytes(seed, framed(info));
      let skS = 0n;
      for (let counter = 0; skS === 0n; counter++)
        skS = hashToScalarXmd(concatBytes(deriveInput, i2osp(counter, 1)), dst("DeriveKeyPair"));

      test("DeriveKeyPair gives skSm (and pkSm)", () => {
        expect(bytesToHex(encode(scalar, skS))).toBe(key["skSm"]);
        expect(decode(scalar, hexToBytes(key["skSm"] ?? ""))).toBe(skS);
        if (name !== "OPRF") expect(bytesToHex(ser(G.multiply(skS)))).toBe(key["pkSm"]);
      });

      test.each(vectors.map((v, i) => [i + 1, v] as const))("test vector %i", (_i, v) => {
        const inputs = (v["Input"] ?? "").split(",").map(hexToBytes);
        const blinds = (v["Blind"] ?? "").split(",").map((b) => decode(scalar, hexToBytes(b)));
        const pInfo = hexToBytes(v["Info"] ?? "");
        // POPRF: the tweak m = HashToScalar("Info" ‖ len ‖ info), key t = skS + m.
        const k =
          name === "POPRF"
            ? Fn.add(
                skS,
                hashToScalarXmd(concatBytes(ascii("Info"), framed(pInfo)), dst("HashToScalar-")),
              )
            : skS;
        const blinded = inputs.map((input, j) =>
          hashToRistretto255(input, dst("HashToGroup-")).multiply(blinds[j] ?? 0n),
        );
        expect(blinded.map((b) => bytesToHex(ser(b))).join(",")).toBe(v["BlindedElement"]);
        const evaluated = blinded.map((b) => b.multiply(name === "POPRF" ? Fn.inv(k) : k));
        expect(evaluated.map((e) => bytesToHex(ser(e))).join(",")).toBe(v["EvaluationElement"]);

        const outputs = inputs.map((input, j) => {
          const unblinded = (evaluated[j] ?? G).multiply(Fn.inv(blinds[j] ?? 1n));
          return bytesToHex(
            sha512(
              concatBytes(
                framed(input),
                name === "POPRF" ? framed(pInfo) : new Uint8Array(),
                framed(ser(unblinded)),
                ascii("Finalize"),
              ),
            ),
          );
        });
        expect(outputs.join(",")).toBe(v["Output"]);

        if (name === "OPRF") return;
        // §2.2.1 GenerateProof with A = g and B = k·g, over C = blinded and
        // D = evaluated (swapped for POPRF, whose key is inverted).
        const [C, D] = name === "POPRF" ? [evaluated, blinded] : [blinded, evaluated];
        const Bm = ser(G.multiply(k));
        const seedDst = ascii("Seed-");
        const compositeSeed = sha512(
          concatBytes(framed(Bm), framed(concatBytes(seedDst, context))),
        );
        let M: Element = IDENTITY;
        C.forEach((c, j) => {
          const di = hashToScalarXmd(
            concatBytes(
              framed(compositeSeed),
              i2osp(j, 2),
              framed(ser(c)),
              framed(ser(D[j] ?? G)),
              ascii("Composite"),
            ),
            dst("HashToScalar-"),
          );
          M = M.add(c.multiply(di));
        });
        const Z = M.multiply(k);
        const r = decode(scalar, hexToBytes(v["ProofRandomScalar"] ?? ""));
        const c = hashToScalarXmd(
          concatBytes(
            framed(Bm),
            framed(ser(M)),
            framed(ser(Z)),
            framed(ser(G.multiply(r))),
            framed(ser(M.multiply(r))),
            ascii("Challenge"),
          ),
          dst("HashToScalar-"),
        );
        const s = Fn.sub(r, Fn.mul(c, k));
        expect(bytesToHex(encode(scalar, c)) + bytesToHex(encode(scalar, s))).toBe(v["Proof"]);
      });
    });
  }
});
