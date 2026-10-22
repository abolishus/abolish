import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BN254_R,
  decodeTier0TokenBlindedElement,
  encode,
  fieldBn254,
  generateTier0TokenKeyPair,
  GROUP_ORDER,
  POSEIDON2_ZERO_ONE,
  scalar,
  tier0TokenBlind,
  tier0TokenBlindedFrom,
  tier0TokenBlindEvaluate,
  Tier0TokenError,
  tier0TokenEvaluate,
  tier0TokenFinalize,
  type Tier0TokenFinalization,
  tier0TokenInfo,
  tier0TokenInput,
  tier0TokenKeyId,
  tier0TokenKeyIssues,
  tier0TokenKeyPeriod,
  tier0TokenKeyRedeems,
  tier0TokenMatches,
  tier0TokenPublicKey,
  TOKEN_KEY_PERIOD,
} from "../src/index.ts";
import { hashToScalarXmd } from "../src/group.ts";
import { tier0TokenBlindEvaluateWith, tier0TokenBlindWith } from "../src/tier0-token.ts";
import { parseFields, rfcSection } from "./vectors/rfc.ts";

// The token code's own properties: completeness (an honest issuance gives the
// token the service computes), soundness of the client's checks (a tampered
// answer, another key or another group fails Finalize), strict decoding, and
// RFC 9497 Appendix A.1.3's vectors through the same functions (T-74, T-16).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const code = (run: () => unknown): string => {
  try {
    run();
    return "ok";
  } catch (e) {
    if (e instanceof Tier0TokenError) return e.code;
    throw e;
  }
};

const KEY = generateTier0TokenKeyPair();
const OTHER_KEY = generateTier0TokenKeyPair();
const KEY_ID = tier0TokenKeyId(700, KEY.publicKey);
const INFO = tier0TokenInfo({
  chainId: 84532n,
  groupRegistry: new Uint8Array(20).fill(0x11),
  groupId: 3n,
});
const OTHER_INFO = tier0TokenInfo({
  chainId: 84532n,
  groupRegistry: new Uint8Array(20).fill(0x11),
  groupId: 4n,
});

const commitmentArb = fc
  .bigInt({ min: 2n, max: BN254_R - 1n })
  .filter((c) => c !== POSEIDON2_ZERO_ONE)
  .map((c) => encode(fieldBn254, c));

function issue(commitment: Uint8Array, info = INFO): Tier0TokenFinalization {
  const input = tier0TokenInput(KEY_ID, commitment);
  const b = tier0TokenBlind(input, KEY.publicKey, info);
  const answer = tier0TokenBlindEvaluate(KEY.secretKey, b.blindedElement, info);
  return {
    input,
    info,
    publicKey: KEY.publicKey,
    blind: b.blind,
    blindedElement: b.blindedElement,
    ...answer,
  };
}

describe("Tier 0 token issuance (docs/spec/tier0-token.md, Issuance)", () => {
  test("an honest issuance finalizes to the token the service evaluates", () => {
    fc.assert(
      fc.property(commitmentArb, (c) => {
        const f = issue(c);
        const token = tier0TokenFinalize(f);
        expect(token.length).toBe(64);
        expect(token).toEqual(tier0TokenEvaluate(KEY.secretKey, f.input, INFO));
        expect(tier0TokenMatches(KEY.secretKey, f.input, INFO, token)).toBe(true);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("a fresh blind each time, so B joins nothing, and the token is the same", () => {
    const c = encode(fieldBn254, 12345n);
    const [a, b] = [issue(c), issue(c)];
    expect(a.blindedElement).not.toEqual(b.blindedElement);
    expect(a.proof).not.toEqual(b.proof);
    expect(tier0TokenFinalize(a)).toEqual(tier0TokenFinalize(b));
  });

  test("any flipped bit of the answer fails Finalize", () => {
    const f = issue(encode(fieldBn254, 777n));
    fc.assert(
      fc.property(
        fc.constantFrom("evaluationElement", "proof"),
        fc.nat(),
        fc.integer({ min: 0, max: 7 }),
        (field, at, bit) => {
          const bytes = Uint8Array.from(f[field]);
          const i = at % bytes.length;
          bytes[i] = (bytes[i] ?? 0) ^ (1 << bit);
          const got = code(() => tier0TokenFinalize({ ...f, [field]: bytes }));
          expect(["evaluation-element", "proof"]).toContain(got);
          if (field === "proof") expect(got).toBe("proof");
        },
      ),
      { numRuns },
    );
  });

  test("an answer under another key or for another group fails Finalize", () => {
    const f = issue(encode(fieldBn254, 4242n));
    expect(code(() => tier0TokenFinalize({ ...f, publicKey: OTHER_KEY.publicKey }))).toBe("proof");
    expect(code(() => tier0TokenFinalize({ ...f, info: OTHER_INFO }))).toBe("proof");
    // The issuer evaluating under another group's info: the proof is honest
    // for that group, so the client checking its own group refuses it.
    const other = tier0TokenBlindEvaluate(KEY.secretKey, f.blindedElement, OTHER_INFO);
    expect(code(() => tier0TokenFinalize({ ...f, ...other }))).toBe("proof");
  });

  test("a token for one group doesn't redeem for another (T-16)", () => {
    const f = issue(encode(fieldBn254, 99n));
    const token = tier0TokenFinalize(f);
    expect(tier0TokenMatches(KEY.secretKey, f.input, OTHER_INFO, token)).toBe(false);
    expect(tier0TokenMatches(OTHER_KEY.secretKey, f.input, INFO, token)).toBe(false);
  });

  test("a proof whose scalars aren't below ℓ, or of another length, is `proof`", () => {
    const f = issue(encode(fieldBn254, 5n));
    const unreduced = Uint8Array.from(f.proof);
    unreduced.set(encode(scalar, 0n).fill(0xff), 32);
    expect(code(() => tier0TokenFinalize({ ...f, proof: unreduced }))).toBe("proof");
    expect(code(() => tier0TokenFinalize({ ...f, proof: f.proof.subarray(0, 63) }))).toBe("proof");
    expect(code(() => tier0TokenFinalize({ ...f, proof: new Uint8Array(65) }))).toBe("proof");
    expect(code(() => tier0TokenFinalize({ ...f, proof: new Uint8Array(64) }))).toBe("proof");
  });

  test("the identity as Z is `evaluation-element`", () => {
    const f = issue(encode(fieldBn254, 6n));
    expect(code(() => tier0TokenFinalize({ ...f, evaluationElement: new Uint8Array(32) }))).toBe(
      "evaluation-element",
    );
  });

  test("the issuer refuses the identity and non-canonical B as `blinded-element`", () => {
    for (const b of [new Uint8Array(32), new Uint8Array(31), new Uint8Array(32).fill(0xff)]) {
      expect(code(() => decodeTier0TokenBlindedElement(b))).toBe("blinded-element");
      expect(code(() => tier0TokenBlindEvaluate(KEY.secretKey, b, INFO))).toBe("blinded-element");
    }
  });

  test("blinds and proof nonces are never 0 and keys are scalars", () => {
    const input = tier0TokenInput(KEY_ID, encode(fieldBn254, 8n));
    expect(() => tier0TokenBlindWith(input, KEY.publicKey, INFO, new Uint8Array(32))).toThrow(
      RangeError,
    );
    const b = tier0TokenBlind(input, KEY.publicKey, INFO);
    for (const r of [0n, GROUP_ORDER])
      expect(() => tier0TokenBlindEvaluateWith(KEY.secretKey, b.blindedElement, INFO, r)).toThrow(
        RangeError,
      );
    expect(() => tier0TokenPublicKey(encode(scalar, 0n))).toThrow(RangeError);
    expect(() => tier0TokenPublicKey(new Uint8Array(32).fill(0xff))).toThrow(RangeError);
  });

  test("a key whose tweak cancels it is `tweaked-key-identity` and `inverse`", () => {
    // skS = −m for this info: T is the identity, and t = skS + m = 0.
    const f = issue(encode(fieldBn254, 10n));
    const sk = findCancellingKey(f);
    const pk = tier0TokenPublicKey(sk);
    expect(code(() => tier0TokenBlind(f.input, pk, INFO))).toBe("tweaked-key-identity");
    expect(code(() => tier0TokenBlindEvaluate(sk, f.blindedElement, INFO))).toBe("inverse");
    expect(code(() => tier0TokenEvaluate(sk, f.input, INFO))).toBe("inverse");
    expect(code(() => tier0TokenFinalize({ ...f, publicKey: pk }))).toBe("tweaked-key-identity");
  });
});

// skS = −m, with the tweak m = HashToScalar("Info" ‖ I2OSP(len(info), 2) ‖
// info) computed independently of the module, as tests/vectors/rfc.test.ts does.
function findCancellingKey(f: Tier0TokenFinalization): Uint8Array {
  const ascii = (s: string) => new TextEncoder().encode(s);
  const context = concatBytes(ascii("OPRFV1-"), Uint8Array.of(2), ascii("-ristretto255-SHA512"));
  const m = hashToScalarXmd(
    concatBytes(ascii("Info"), Uint8Array.of(f.info.length >> 8, f.info.length & 0xff), f.info),
    concatBytes(ascii("HashToScalar-"), context),
  );
  return encode(scalar, (GROUP_ORDER - m) % GROUP_ORDER);
}

describe("Tier 0 token inputs and keys (Token input, Keys)", () => {
  test("forbidden commitments are refused before anything is blinded", () => {
    for (const c of [0n, 1n, POSEIDON2_ZERO_ONE])
      expect(code(() => tier0TokenInput(KEY_ID, encode(fieldBn254, c)))).toBe(
        "forbidden-commitment",
      );
    const r = new Uint8Array(32);
    r.set(hexToBytes(BN254_R.toString(16).padStart(64, "0")));
    expect(code(() => tier0TokenInput(KEY_ID, r))).toBe("non-canonical");
    expect(() => tier0TokenInput(KEY_ID, new Uint8Array(31))).toThrow(RangeError);
    expect(() => tier0TokenInput(new Uint8Array(31), encode(fieldBn254, 2n))).toThrow(RangeError);
  });

  test("distinct commitments give distinct inputs", () => {
    fc.assert(
      fc.property(commitmentArb, commitmentArb, (a, b) => {
        fc.pre(bytesToHex(a) !== bytesToHex(b));
        expect(tier0TokenInput(KEY_ID, a)).not.toEqual(tier0TokenInput(KEY_ID, b));
      }),
      { numRuns },
    );
  });

  test("a key identifier names a valid public key only", () => {
    expect(() => tier0TokenKeyId(0, new Uint8Array(32))).toThrow(RangeError);
    expect(() => tier0TokenBlind(new Uint8Array(32), new Uint8Array(32), INFO)).toThrow(RangeError);
    expect(tier0TokenKeyId(1, KEY.publicKey)).not.toEqual(tier0TokenKeyId(2, KEY.publicKey));
  });

  test("a key issues in its period and redeems in it and the next", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2 ** 31 }),
        fc.nat({ max: TOKEN_KEY_PERIOD - 1 }),
        (q, s) => {
          const at = (p: number) => p * TOKEN_KEY_PERIOD + s;
          expect(tier0TokenKeyPeriod(at(q))).toBe(q);
          expect([tier0TokenKeyIssues(q, at(q - 1)), tier0TokenKeyIssues(q, at(q))]).toEqual([
            false,
            true,
          ]);
          expect([q - 1, q, q + 1, q + 2].map((p) => tier0TokenKeyRedeems(q, at(p)))).toEqual([
            false,
            true,
            true,
            false,
          ]);
        },
      ),
      { numRuns },
    );
    expect(() => tier0TokenKeyPeriod(-1)).toThrow(RangeError);
    expect(() => tier0TokenKeyPeriod(1.5)).toThrow(RangeError);
  });

  test("a token differing in any one byte doesn't redeem", () => {
    const f = issue(encode(fieldBn254, 32n));
    const token = tier0TokenFinalize(f);
    fc.assert(
      fc.property(fc.nat({ max: 63 }), fc.integer({ min: 1, max: 255 }), (i, x) => {
        const t = Uint8Array.from(token);
        t[i] = (t[i] ?? 0) ^ x;
        expect(tier0TokenMatches(KEY.secretKey, f.input, INFO, t)).toBe(false);
      }),
      { numRuns },
    );
  });

  test("a token is compared whole: truncated or longer tokens don't redeem", () => {
    const f = issue(encode(fieldBn254, 31n));
    const token = tier0TokenFinalize(f);
    for (const t of [token.subarray(0, 63), Uint8Array.of(...token, 0), new Uint8Array(0)])
      expect(tier0TokenMatches(KEY.secretKey, f.input, INFO, t)).toBe(false);
  });
});

describe("Tier 0 token re-issuance (Keys, item 3)", () => {
  test("only the blind and commitment that made B show it", () => {
    fc.assert(
      fc.property(commitmentArb, commitmentArb, (c, other) => {
        fc.pre(bytesToHex(c) !== bytesToHex(other));
        const f = issue(c);
        expect(tier0TokenBlindedFrom(KEY_ID, c, f.blind, f.blindedElement)).toBe(true);
        // Another account's dead token: its own blind and C, not this B.
        const g = issue(other);
        expect(tier0TokenBlindedFrom(KEY_ID, other, g.blind, f.blindedElement)).toBe(false);
        expect(tier0TokenBlindedFrom(KEY_ID, other, f.blind, f.blindedElement)).toBe(false);
        expect(tier0TokenBlindedFrom(KEY_ID, c, g.blind, f.blindedElement)).toBe(false);
        const otherKeyId = tier0TokenKeyId(701, KEY.publicKey);
        expect(tier0TokenBlindedFrom(otherKeyId, c, f.blind, f.blindedElement)).toBe(false);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("encodings the spec refuses show nothing", () => {
    const c = encode(fieldBn254, 2024n);
    const f = issue(c);
    const unreduced = new Uint8Array(32).fill(0xff);
    for (const [kid, cm, blind, b] of [
      [KEY_ID, c, encode(scalar, 0n), f.blindedElement],
      [KEY_ID, c, unreduced, f.blindedElement],
      [KEY_ID, encode(fieldBn254, 1n), f.blind, f.blindedElement],
      [KEY_ID, unreduced, f.blind, f.blindedElement],
      [KEY_ID, c, f.blind, new Uint8Array(32)],
      [KEY_ID, c, f.blind, unreduced],
    ] as const)
      expect(tier0TokenBlindedFrom(kid, cm, blind, b)).toBe(false);
  });
});

// RFC 9497 Appendix A.1.3 (POPRF, ristretto255-SHA512), test vectors 1 and 2
// (batch size 1; vector 3 is a batch of two, which tokens never use), through
// the package's own Blind, BlindEvaluate, Finalize and Evaluate.
describe("RFC 9497 Appendix A.1.3 through the token code", () => {
  const fields = parseFields(
    rfcSection("rfc9497", "A.1.3.  POPRF Mode", "A.2.  decaf448-SHAKE256"),
    "=",
  );
  const key = Object.fromEntries(fields.slice(0, 4).map((f) => [f.name, f.value]));
  const vectors: Record<string, string>[] = [];
  for (let i = 4; i + 8 <= fields.length; i += 8)
    vectors.push(Object.fromEntries(fields.slice(i, i + 8).map((f) => [f.name, f.value])));
  const le = (hex: string) => {
    let v = 0n;
    for (const x of hexToBytes(hex).reverse()) v = (v << 8n) | BigInt(x);
    return v;
  };

  test("the key's public half is pkSm", () => {
    expect(bytesToHex(tier0TokenPublicKey(hexToBytes(key["skSm"] ?? "")))).toBe(key["pkSm"]);
  });

  test.each(vectors.slice(0, 2).map((v, i) => [i + 1, v] as const))("test vector %i", (_i, v) => {
    const sk = hexToBytes(key["skSm"] ?? "");
    const pk = hexToBytes(key["pkSm"] ?? "");
    const input = hexToBytes(v["Input"] ?? "");
    const info = hexToBytes(v["Info"] ?? "");
    const b = tier0TokenBlindWith(input, pk, info, hexToBytes(v["Blind"] ?? ""));
    expect(bytesToHex(b.blindedElement)).toBe(v["BlindedElement"]);
    const answer = tier0TokenBlindEvaluateWith(
      sk,
      b.blindedElement,
      info,
      le(v["ProofRandomScalar"] ?? ""),
    );
    expect(bytesToHex(answer.evaluationElement)).toBe(v["EvaluationElement"]);
    expect(bytesToHex(answer.proof)).toBe(v["Proof"]);
    const out = tier0TokenFinalize({
      input,
      info,
      publicKey: pk,
      blind: b.blind,
      blindedElement: b.blindedElement,
      ...answer,
    });
    expect(bytesToHex(out)).toBe(v["Output"]);
    expect(bytesToHex(tier0TokenEvaluate(sk, input, info))).toBe(v["Output"]);
  });
});
