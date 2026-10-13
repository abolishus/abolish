import fc from "fast-check";
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, test } from "vite-plus/test";
import {
  ceremonyRegistrationMessage,
  decode,
  EncodeError,
  identityKey,
  KEM_PUBLIC_KEY,
  kemKeyHash,
  type KeySetEntry,
  keySetEntry,
  keySetHash,
  signCeremonyRegistration,
  verifyCeremonyRegistration,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/key-set.json comes from an independent Python
// implementation (scripts/key-set-vectors.py, standard library only), so the
// expected hashes, statements and signatures never come from the code under
// test (docs/spec/ceremony.md, Key set hash; T-37, T-14).

interface Entry {
  readonly index: number;
  readonly kemKeyHash: string;
  readonly signingKey: string;
  readonly x?: string;
  readonly y?: string;
}

interface KeySetVectors {
  readonly format: string;
  readonly tags: {
    readonly kemKey: string;
    readonly keySet: string;
    readonly registration: string;
  };
  readonly kemKeys: readonly { id: string; kemKey: string; kemKeyHash: string }[];
  readonly keySets: readonly {
    id: string;
    entries: readonly Entry[];
    encoding: string;
    keySetHash: string;
  }[];
  readonly rejectedKeySets: readonly { id: string; entries: readonly Entry[]; error: string }[];
  readonly statements: readonly {
    id: string;
    panel: string;
    l2ChainId: string;
    trusteeRegistry: string;
    index: number;
    stubHash: string;
    ceremonyTranscriptHash: string;
    keySet: string;
    keySetHash: string;
    message: string;
    digest: string;
    signature: string;
  }[];
}

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;
const vectors = read<KeySetVectors>("key-set.json");
const trustee = read<{
  keys: readonly { id: string; encoding: string; secretKey?: string }[];
  panels: readonly { id: string; threshold: number; keys: readonly string[] }[];
}>("trustee.json");

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const entries = (es: readonly Entry[]): KeySetEntry[] =>
  es.map((e) => ({ index: e.index, kemKeyHash: hex(e.kemKeyHash), signingKey: hex(e.signingKey) }));
const framed = (tag: string, m: Uint8Array) => {
  const t = new TextEncoder().encode(tag);
  return new Uint8Array([t.length, ...t, ...m]);
};

describe("key-set vectors (docs/spec/vectors/key-set.json)", () => {
  test("the file has the expected format, tags and counts", () => {
    expect(vectors.format).toBe("abolish-key-set-vectors/1");
    expect(vectors.tags).toEqual({
      kemKey: "abolish/v1/kem-key",
      keySet: "abolish/v1/key-set",
      registration: "abolish/v1/sig/ceremony-registration-2",
    });
    expect([
      vectors.kemKeys.length,
      vectors.keySets.length,
      vectors.rejectedKeySets.length,
      vectors.statements.length,
    ]).toEqual([16, 6, 6, 5]);
  });

  test.each(vectors.kemKeys)("KEM key $id", (v) => {
    expect(toHex(kemKeyHash(decode(KEM_PUBLIC_KEY, hex(v.kemKey))))).toBe(v.kemKeyHash);
  });

  test.each(vectors.keySets)("key set $id", (v) => {
    expect(toHex(keySetHash(entries(v.entries)))).toBe(v.keySetHash);
    // The encoding is the one hashed, and each entry is its seat's KEM key's
    // hash and its point's compressed encoding.
    expect(toHex(sha256(framed(vectors.tags.keySet, hex(v.encoding))))).toBe(v.keySetHash);
    for (const e of v.entries) {
      expect(e.kemKeyHash).toBe(vectors.kemKeys[e.index - 1]?.kemKeyHash);
      const point = p256.Point.fromAffine({ x: BigInt(`0x${e.x}`), y: BigInt(`0x${e.y}`) });
      expect(toHex(point.toBytes(true))).toBe(e.signingKey);
    }
  });

  test.each(vectors.rejectedKeySets)("rejects key set $id", (v) => {
    const expected = v.error === "non-canonical" ? EncodeError : RangeError;
    expect(() => keySetHash(entries(v.entries))).toThrow(expected);
  });

  test.each(vectors.statements)("statement $id", (v) => {
    const p = trustee.panels.find((x) => x.id === v.panel);
    if (p === undefined) throw new Error(`no panel ${v.panel}`);
    const panel = { threshold: p.threshold, keys: p.keys.map(hex) };
    const set = vectors.keySets.find((s) => s.id === v.keySet);
    expect(set?.keySetHash).toBe(v.keySetHash);
    const reg = {
      l2ChainId: BigInt(v.l2ChainId),
      trusteeRegistry: hex(v.trusteeRegistry),
      index: v.index,
      stubHash: hex(v.stubHash),
      ceremonyTranscriptHash: hex(v.ceremonyTranscriptHash),
      keySetHash: keySetHash(entries(set?.entries ?? [])),
    };
    const m = ceremonyRegistrationMessage(panel, reg);
    expect(toHex(m)).toBe(v.message);
    expect(toHex(sha256(framed(vectors.tags.registration, m)))).toBe(v.digest);
    expect(verifyCeremonyRegistration(panel, reg, hex(v.signature))).toBe(true);
    // Another key set is another statement.
    const other = vectors.keySets.find((s) => s.id !== v.keySet);
    expect(
      verifyCeremonyRegistration(
        panel,
        { ...reg, keySetHash: hex(other?.keySetHash ?? "") },
        hex(v.signature),
      ),
    ).toBe(false);
    const seat = trustee.keys.find((k) => k.encoding === p.keys[v.index - 1]);
    expect(toHex(signCeremonyRegistration(hex(seat?.secretKey ?? ""), panel, reg))).toBe(
      v.signature,
    );
  });
});

describe("key-set hash properties", () => {
  const signingKeys = Array.from({ length: 16 }, (_, i) =>
    identityKey(hex((BigInt(i) + 7n).toString(16).padStart(64, "0"))),
  );
  const keySet = fc
    .uniqueArray(fc.integer({ min: 1, max: 16 }), { minLength: 1, maxLength: 16 })
    .chain((seats) =>
      fc.tuple(
        fc.constant([...seats].sort((a, b) => a - b)),
        fc.array(fc.uint8Array({ minLength: 32, maxLength: 32 }), {
          minLength: seats.length,
          maxLength: seats.length,
        }),
      ),
    )
    .map(([seats, hashes]) =>
      seats.map((index, i) => ({
        index,
        kemKeyHash: hashes[i] ?? new Uint8Array(32),
        signingKey: signingKeys[index - 1] ?? new Uint8Array(33),
      })),
    );

  test("changing any seat, KEM-key hash or signing key changes the hash", () => {
    fc.assert(
      fc.property(keySet, fc.nat(), fc.nat(255), (set, at, byte) => {
        const h = toHex(keySetHash(set));
        const i = at % set.length;
        const e = set[i] as KeySetEntry;
        const kem = Uint8Array.from(e.kemKeyHash);
        kem[byte % 32] = (kem[byte % 32] ?? 0) ^ 1;
        const changed = set.map((x, j) => (j === i ? { ...x, kemKeyHash: kem } : x));
        expect(toHex(keySetHash(changed))).not.toBe(h);
        const otherKey = signingKeys.find((k) => !set.some((x) => x.signingKey === k));
        if (otherKey !== undefined) {
          const rekeyed = set.map((x, j) => (j === i ? { ...x, signingKey: otherKey } : x));
          expect(toHex(keySetHash(rekeyed))).not.toBe(h);
        }
        // Dropping a seat, or renumbering one into a gap, is another set.
        if (set.length > 1) expect(toHex(keySetHash(set.filter((_, j) => j !== i)))).not.toBe(h);
        const last = set[set.length - 1] as KeySetEntry;
        if (last.index < 16) {
          const moved = set.map((x, j) => (j === set.length - 1 ? { ...x, index: 16 } : x));
          expect(toHex(keySetHash(moved))).not.toBe(h);
        }
      }),
      { numRuns },
    );
  });

  test("a set out of seat order never hashes", () => {
    fc.assert(
      fc.property(keySet, (set) => {
        fc.pre(set.length > 1);
        expect(() => keySetHash([...set].reverse())).toThrow(RangeError);
        expect(() => keySetHash([set[0] as KeySetEntry, ...set])).toThrow(RangeError);
      }),
      { numRuns },
    );
  });

  test("keySetEntry hashes the seat's KEM key and keeps its seat and signing key", () => {
    const kem = decode(KEM_PUBLIC_KEY, hex(vectors.kemKeys[0]?.kemKey ?? ""));
    const e = keySetEntry({ index: 1, kemKey: kem, signingKey: signingKeys[0] as Uint8Array });
    expect(e.index).toBe(1);
    expect(toHex(e.kemKeyHash)).toBe(vectors.kemKeys[0]?.kemKeyHash);
    expect(toHex(e.signingKey)).toBe(toHex(signingKeys[0] as Uint8Array));
  });
});
