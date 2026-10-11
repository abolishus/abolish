import fc from "fast-check";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, test } from "vite-plus/test";
import {
  ceremonyRegistrationMessage,
  decode,
  DecodeError,
  encode,
  EncodeError,
  identityKey,
  MAX_TRUSTEES,
  p256Key,
  p256Sig,
  panelId,
  PanelError,
  signCeremonyRegistration,
  signStatement,
  verifyCeremonyRegistration,
  verifyStatement,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/trustee.json comes from an independent Python
// implementation (scripts/trustee-vectors.py, standard library only, checked
// against RFC 6979 A.2.5 and OpenSSL), so these expected values never come
// from the code under test.

interface TrusteeVectors {
  readonly format: string;
  readonly tags: { readonly panel: string; readonly registration: string };
  readonly keys: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly secretKey?: string;
    readonly description?: string;
    readonly error?: string;
  }[];
  readonly signatures: readonly {
    readonly id: string;
    readonly key: string;
    readonly message: string;
    readonly dsMessage: string;
    readonly digest?: string;
    readonly signature: string;
    readonly valid: boolean;
  }[];
  readonly panels: readonly {
    readonly id: string;
    readonly threshold: number;
    readonly keys: readonly string[];
    readonly panelId?: string;
    readonly error?: string;
  }[];
  readonly registrations: readonly {
    readonly id: string;
    readonly panel: string;
    readonly l2ChainId: string;
    readonly trusteeRegistry: string;
    readonly index: number;
    readonly stubHash: string;
    readonly ceremonyTranscriptHash: string;
    readonly message: string;
    readonly signature: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("trustee.json", SPEC_VECTORS), "utf8"),
) as TrusteeVectors;

const TAG = "abolish/v1/sig/ceremony-registration";
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run signs and verifies with pure-JS ECDSA (a few ms), and CI runs 1000.
const SLOW = 120_000;
const N = p256.Point.Fn.ORDER;
const HALF_N = (N - 1n) / 2n;
const be32 = (v: bigint) => hex(v.toString(16).padStart(64, "0"));
const secretKey = fc.bigInt({ min: 1n, max: N - 1n }).map((d) => be32(d));
const panelById = (id: string) => {
  const p = vectors.panels.find((x) => x.id === id);
  if (p === undefined) throw new Error(`no panel ${id}`);
  return { threshold: p.threshold, keys: p.keys.map(hex) };
};

describe("trustee vectors (docs/spec/vectors/trustee.json)", () => {
  test("the file has the expected format, tags and counts", () => {
    expect(vectors.format).toBe("abolish-trustee-vectors/1");
    expect(vectors.tags).toEqual({ panel: "abolish/v1/panel", registration: TAG });
    // A consumer that dropped vectors would otherwise check fewer.
    expect([
      vectors.keys.length,
      vectors.signatures.length,
      vectors.panels.length,
      vectors.registrations.length,
    ]).toEqual([24, 24, 14, 4]);
  });

  test.each(vectors.keys)("key $id", (v) => {
    if (v.error === undefined) {
      // A valid key with no known secret (x = 0) only decodes.
      if (v.secretKey !== undefined) expect(toHex(identityKey(hex(v.secretKey)))).toBe(v.encoding);
      else expect(v.id).toMatch(/^key-x-zero-prefix-0[23]$/);
      expect(toHex(decode(p256Key, hex(v.encoding)))).toBe(v.encoding);
      expect(toHex(encode(p256Key, hex(v.encoding)))).toBe(v.encoding);
      return;
    }
    let err: unknown;
    try {
      decode(p256Key, hex(v.encoding));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeError);
    expect((err as DecodeError).code).toBe(v.error);
  });

  test("every published vector is still present and unchanged", () => {
    // tests/vectors/trustee-published.json pins each vector published on
    // main (by section and id, sha256 of its JSON with sorted keys): a
    // published vector is never edited or removed (docs/spec/versioning.md,
    // Change rules), so a regeneration can't silently drop one.
    const pinned = JSON.parse(
      readFileSync(new URL("vectors/trustee-published.json", import.meta.url), "utf8"),
    ) as Record<string, string>;
    const sections = {
      keys: vectors.keys,
      signatures: vectors.signatures,
      panels: vectors.panels,
      registrations: vectors.registrations,
    } as const;
    expect(Object.keys(pinned).length).toBe(66);
    for (const [path, digest] of Object.entries(pinned)) {
      const [section = "", id] = path.split("/");
      const found = (
        sections[section as keyof typeof sections] as readonly { id: string }[]
      ).filter((v) => v.id === id);
      expect(found, path).toHaveLength(1);
      const v = found[0] as object;
      // The replacer list applies at every depth, so the digest covers every
      // field only while vectors stay flat (scalars and arrays of strings).
      for (const field of Object.values(v))
        expect(
          ["string", "number", "boolean"].includes(typeof field) ||
            (Array.isArray(field) && field.every((x) => typeof x === "string")),
          path,
        ).toBe(true);
      const canon = JSON.stringify(v, Object.keys(v).sort());
      expect(createHash("sha256").update(canon).digest("hex"), path).toBe(digest);
    }
  });

  test("the key-encoding vectors are rejected only for the key's encoding", () => {
    // Each carries key-1's own point in a 65-byte SEC 1 form with sig-1, so a
    // verifier that accepted that form would accept the signature: these
    // catch exactly that parser differential (T-31, T-36).
    const key1 = vectors.keys.find((k) => k.id === "key-1");
    const sig1 = vectors.signatures.find((v) => v.id === "sig-1");
    const point = p256.Point.fromHex(key1?.encoding ?? "");
    const { x, y } = point.toAffine();
    for (const id of ["sig-key-uncompressed-own", "sig-key-hybrid"]) {
      const v = vectors.signatures.find((s) => s.id === id);
      const key = hex(v?.key ?? "");
      expect(key.length).toBe(65);
      expect(toHex(key.subarray(1, 33))).toBe(toHex(be32(x)));
      expect(toHex(key.subarray(33))).toBe(toHex(be32(y)));
      expect(key[0]).toBe(id === "sig-key-hybrid" ? 6 + Number(y & 1n) : 4);
      expect(v?.signature).toBe(sig1?.signature);
      expect(v?.message).toBe(sig1?.message);
      // Valid under the point itself: only the encoding rule rejects it.
      expect(
        p256.verify(hex(v?.signature ?? ""), hex(v?.dsMessage ?? ""), point.toBytes(false), {
          prehash: true,
          lowS: true,
        }),
      ).toBe(true);
      expect(verifyStatement(key, TAG, hex(v?.message ?? ""), hex(v?.signature ?? ""))).toBe(false);
    }
  });

  test.each(vectors.signatures)("signature $id", (v) => {
    const key = hex(v.key);
    const m = hex(v.message);
    const sig = hex(v.signature);
    expect(verifyStatement(key, TAG, m, sig)).toBe(v.valid);
    if (!v.valid) return;
    expect(toHex(sha256(hex(v.dsMessage)))).toBe(v.digest);
    // RFC 6979 is deterministic: the seat's own key reproduces the bytes.
    const seat = vectors.keys.find((k) => k.encoding === v.key && k.secretKey !== undefined);
    // Only the constructed x(R) ≥ n vector has a key with no known secret.
    if (seat === undefined) {
      expect(v.id).toBe("sig-x-of-r-at-least-n");
      return;
    }
    expect(toHex(signStatement(hex(seat?.secretKey ?? ""), TAG, m))).toBe(v.signature);
  });

  test.each(vectors.panels)("panel $id", (v) => {
    const panel = { threshold: v.threshold, keys: v.keys.map(hex) };
    if (v.error === undefined) expect(toHex(panelId(panel))).toBe(v.panelId);
    else {
      let err: unknown;
      try {
        panelId(panel);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(PanelError);
      expect((err as PanelError).code).toBe(v.error);
    }
  });

  test.each(vectors.registrations)("registration $id", (v) => {
    const panel = panelById(v.panel);
    const reg = {
      l2ChainId: BigInt(v.l2ChainId),
      trusteeRegistry: hex(v.trusteeRegistry),
      index: v.index,
      stubHash: hex(v.stubHash),
      ceremonyTranscriptHash: hex(v.ceremonyTranscriptHash),
    };
    expect(toHex(ceremonyRegistrationMessage(panel, reg))).toBe(v.message);
    expect(verifyCeremonyRegistration(panel, reg, hex(v.signature))).toBe(true);
    // Every other seat's key, and every other seat number, rejects it.
    for (let i = 1; i <= panel.keys.length; i++)
      if (i !== v.index)
        expect(verifyCeremonyRegistration(panel, { ...reg, index: i }, hex(v.signature))).toBe(
          false,
        );
    const seat = vectors.keys.find((k) => k.encoding === toHex(panel.keys[v.index - 1] ?? hex("")));
    expect(toHex(signCeremonyRegistration(hex(seat?.secretKey ?? ""), panel, reg))).toBe(
      v.signature,
    );
  });
});

describe("trustee signature properties", () => {
  test(
    "honest signatures verify, are low-s and re-encode to themselves",
    () => {
      fc.assert(
        fc.property(secretKey, fc.uint8Array({ maxLength: 200 }), (d, m) => {
          const sig = signStatement(d, TAG, m);
          expect(verifyStatement(identityKey(d), TAG, m, sig)).toBe(true);
          expect(BigInt(`0x${toHex(sig.subarray(32))}`) <= HALF_N).toBe(true);
          expect(toHex(encode(p256Sig, decode(p256Sig, sig)))).toBe(toHex(sig));
        }),
        { numRuns },
      );
    },
    SLOW,
  );

  test(
    "any changed bit of the signature, message or key is rejected",
    () => {
      fc.assert(
        fc.property(
          secretKey,
          fc.uint8Array({ minLength: 1, maxLength: 64 }),
          fc.nat(),
          fc.constantFrom("sig", "message", "key"),
          (d, m, bit, what) => {
            const key = identityKey(d);
            const sig = signStatement(d, TAG, m);
            const target = what === "sig" ? sig : what === "message" ? m : key;
            const flipped = new Uint8Array(target);
            const i = bit % (flipped.length * 8);
            flipped[i >> 3] = (flipped[i >> 3] ?? 0) ^ (1 << (i & 7));
            const args =
              what === "sig"
                ? ([key, m, flipped] as const)
                : what === "message"
                  ? ([key, flipped, sig] as const)
                  : ([flipped, m, sig] as const);
            expect(verifyStatement(args[0], TAG, args[1], args[2])).toBe(false);
          },
        ),
        { numRuns },
      );
    },
    SLOW,
  );

  test(
    "the high-s twin of every honest signature is rejected",
    () => {
      fc.assert(
        fc.property(secretKey, fc.uint8Array({ maxLength: 64 }), (d, m) => {
          const sig = signStatement(d, TAG, m);
          const s = BigInt(`0x${toHex(sig.subarray(32))}`);
          const twin = new Uint8Array([...sig.subarray(0, 32), ...be32(N - s)]);
          // The twin is a valid ECDSA signature: only the low-s rule stops it.
          expect(p256.verify(twin, frame(m), identityKey(d), { lowS: false, prehash: true })).toBe(
            true,
          );
          expect(verifyStatement(identityKey(d), TAG, m, twin)).toBe(false);
          expect(() => decode(p256Sig, twin)).toThrow(DecodeError);
        }),
        { numRuns },
      );
    },
    SLOW,
  );

  test(
    "p256-key: random 33-byte strings are rejected or re-encode to themselves",
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(0x02, 0x03),
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          (prefix, x) => {
            const b = new Uint8Array([prefix, ...x]);
            let k: Uint8Array;
            try {
              k = decode(p256Key, b);
            } catch (e) {
              expect(e).toBeInstanceOf(DecodeError);
              return;
            }
            expect(toHex(encode(p256Key, k))).toBe(toHex(b));
          },
        ),
        { numRuns },
      );
    },
    SLOW,
  );

  test(
    "p256-key: decode(encode(Q)) = Q for every honest key",
    () => {
      fc.assert(
        fc.property(secretKey, (d) => {
          const key = identityKey(d);
          expect(toHex(decode(p256Key, encode(p256Key, key)))).toBe(toHex(key));
        }),
        { numRuns },
      );
    },
    SLOW,
  );

  test("encoders refuse values with no encoding", () => {
    const key = identityKey(be32(1n));
    const uncompressed = p256.getPublicKey(be32(1n), false);
    expect(() => encode(p256Key, uncompressed)).toThrow(EncodeError);
    expect(() => encode(p256Key, key.subarray(1))).toThrow(EncodeError);
    expect(() => encode(p256Sig, new Uint8Array(64))).toThrow(EncodeError);
    expect(() => encode(p256Sig, new Uint8Array([...be32(1n), ...be32(HALF_N + 1n)]))).toThrow(
      EncodeError,
    );
  });

  test("a signature under one tag never verifies under another", () => {
    // Only one signature tag is registered so far, so the other tag is
    // simulated by framing with the panel tag, as trustee.json's sig-other-tag.
    const d = be32(7n);
    const m = new Uint8Array([1, 2, 3]);
    const other = p256.sign(frame(m, "abolish/v1/panel"), d, { lowS: true, prehash: true });
    expect(verifyStatement(identityKey(d), TAG, m, other)).toBe(false);
    expect(() => signStatement(d, "abolish/v1/panel" as never, m)).toThrow(RangeError);
    expect(() => verifyStatement(identityKey(d), "abolish/v1/ballot" as never, m, other)).toThrow(
      RangeError,
    );
  });

  test("malformed arguments are rejected, not repaired", () => {
    const d = be32(5n);
    const key = identityKey(d);
    const sig = signStatement(d, TAG, new Uint8Array());
    expect(verifyStatement(key, TAG, new Uint8Array(), sig.subarray(1))).toBe(false);
    expect(verifyStatement(key.subarray(1), TAG, new Uint8Array(), sig)).toBe(false);
    expect(() => verifyStatement([...key] as never, TAG, new Uint8Array(), sig)).toThrow(TypeError);
    expect(() => identityKey(be32(0n))).toThrow(RangeError);
    expect(() => identityKey(be32(N))).toThrow(RangeError);
    expect(() => identityKey(new Uint8Array(31))).toThrow(TypeError);
  });
});

describe("panel identifier properties", () => {
  const keysArb = (min: number, max: number) =>
    fc
      .uniqueArray(fc.bigInt({ min: 1n, max: N - 1n }), { minLength: min, maxLength: max })
      .map((ds) => ds.map((d) => identityKey(be32(d))));

  test(
    "binds k, every key and every seat",
    () => {
      fc.assert(
        fc.property(keysArb(3, 8), fc.nat(), (keys, pick) => {
          const k = 2 + (pick % (keys.length - 1));
          const id = toHex(panelId({ threshold: k, keys }));
          const swapped = [keys[1], keys[0], ...keys.slice(2)] as Uint8Array[];
          expect(toHex(panelId({ threshold: k, keys: swapped }))).not.toBe(id);
          const other = k === keys.length ? k - 1 : k + 1;
          expect(toHex(panelId({ threshold: other, keys }))).not.toBe(id);
          expect(toHex(panelId({ threshold: 2, keys: keys.slice(0, -1) }))).not.toBe(
            toHex(panelId({ threshold: 2, keys })),
          );
        }),
        { numRuns: Math.max(10, Math.floor(numRuns / 10)) },
      );
    },
    SLOW,
  );

  test("rejects k = 1, k > n, n > MAX_TRUSTEES, a repeated key and a bad key", () => {
    const keys = Array.from({ length: MAX_TRUSTEES + 1 }, (_, i) =>
      identityKey(be32(BigInt(i + 1))),
    );
    const three = keys.slice(0, 3);
    expect(() => panelId({ threshold: 1, keys: three })).toThrow(RangeError);
    expect(() => panelId({ threshold: 4, keys: three })).toThrow(RangeError);
    expect(() => panelId({ threshold: 2.5, keys: three })).toThrow(RangeError);
    expect(() => panelId({ threshold: 2, keys })).toThrow(RangeError);
    expect(() => panelId({ threshold: 2, keys: keys.slice(0, MAX_TRUSTEES) })).not.toThrow();
    expect(() =>
      panelId({ threshold: 2, keys: [three[0], three[1], three[0]] as Uint8Array[] }),
    ).toThrow(RangeError);
    const bad = new Uint8Array(three[0] ?? []);
    bad[0] = 0x04;
    expect(() => panelId({ threshold: 2, keys: [bad, three[1]] as Uint8Array[] })).toThrow(
      RangeError,
    );
  });

  test("MAX_TRUSTEES matches docs/spec/parameters.md", () => {
    const params = readFileSync(
      new URL("parameters.md", SPEC_VECTORS.href.replace("vectors/", "")),
      "utf8",
    );
    expect(params).toContain(`| \`MAX_TRUSTEES\`          | ${MAX_TRUSTEES}        |`);
  });
});

describe("ceremony registration", () => {
  const keys = Array.from({ length: 4 }, (_, i) => identityKey(be32(BigInt(100 + i))));
  const panel = { threshold: 3, keys };
  const reg = {
    l2ChainId: 84532n,
    trusteeRegistry: new Uint8Array(20).fill(0xaa),
    index: 2,
    stubHash: new Uint8Array(32).fill(1),
    ceremonyTranscriptHash: new Uint8Array(32).fill(2),
  };

  test("binds every field: changing any one fails verification", () => {
    const sig = signCeremonyRegistration(be32(101n), panel, reg);
    expect(verifyCeremonyRegistration(panel, reg, sig)).toBe(true);
    for (const changed of [
      { ...reg, l2ChainId: 84533n },
      { ...reg, trusteeRegistry: new Uint8Array(20).fill(0xab) },
      { ...reg, index: 3 },
      { ...reg, stubHash: new Uint8Array(32).fill(3) },
      { ...reg, ceremonyTranscriptHash: new Uint8Array(32).fill(3) },
    ])
      expect(verifyCeremonyRegistration(panel, changed, sig)).toBe(false);
    // Another panel (here: another threshold) changes panel_id.
    expect(verifyCeremonyRegistration({ ...panel, threshold: 2 }, reg, sig)).toBe(false);
  });

  test("verification rejects, never throws on, a registration no seat could sign", () => {
    const sig = signCeremonyRegistration(be32(101n), panel, reg);
    for (const index of [0, 5, 1.5, -1, Number.NaN])
      expect(verifyCeremonyRegistration(panel, { ...reg, index }, sig)).toBe(false);
    expect(verifyCeremonyRegistration(panel, { ...reg, l2ChainId: 2n ** 64n }, sig)).toBe(false);
    expect(verifyCeremonyRegistration(panel, { ...reg, stubHash: new Uint8Array(31) }, sig)).toBe(
      false,
    );
    // The panel is pinned configuration: a bad one is the caller's bug.
    expect(() => verifyCeremonyRegistration({ ...panel, threshold: 1 }, reg, sig)).toThrow(
      PanelError,
    );
  });

  test("only the seat's own key can sign, and only for a seat of the panel", () => {
    expect(() => signCeremonyRegistration(be32(100n), panel, reg)).toThrow(RangeError);
    for (const index of [0, 5, 1.5, -1])
      expect(() => ceremonyRegistrationMessage(panel, { ...reg, index })).toThrow(RangeError);
    expect(() => ceremonyRegistrationMessage(panel, { ...reg, l2ChainId: 2n ** 64n })).toThrow(
      EncodeError,
    );
    expect(() =>
      ceremonyRegistrationMessage(panel, { ...reg, trusteeRegistry: new Uint8Array(19) }),
    ).toThrow(EncodeError);
  });

  test("the message is 125 bytes in the spec's field order", () => {
    const m = ceremonyRegistrationMessage(panel, reg);
    expect(m.length).toBe(125);
    expect(toHex(m.subarray(0, 8))).toBe("0000000000014a34");
    expect(toHex(m.subarray(28, 60))).toBe(toHex(panelId(panel)));
    expect(m[60]).toBe(2);
  });
});

function frame(m: Uint8Array, tag = TAG): Uint8Array {
  const t = new TextEncoder().encode(tag);
  return new Uint8Array([t.length, ...t, ...m]);
}
