import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  checkTier1Addition,
  decodeTier1Addition,
  encodeTier1Addition,
  semaphoreField,
  tierTreeRoot,
  type VouchContext,
  VOUCH_K,
  VOUCH_LENGTH,
  VOUCH_SLOTS,
  vouchMessage,
  vouchScope,
  vouchSlotScope,
} from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/vouch.json holds real Semaphore v4.14.3 proofs, made
// outside the workspace by scripts/vouch-vectors.mjs with snarkjs's verdicts,
// and each addition's expected result written from docs/spec/vouching.md
// (T-02, T-06, T-32). No expected value comes from the code under test.

interface Context {
  readonly chainId: string;
  readonly registry: string;
}

interface Vectors {
  readonly format: string;
  readonly parameters: { readonly k: number; readonly slots: number };
  readonly context: Context;
  readonly tier2: { readonly leaves: readonly string[]; readonly root: string };
  readonly scopes: readonly {
    readonly id: string;
    readonly kind: "vouchee" | "slot";
    readonly chainId: string;
    readonly registry: string;
    readonly groupId?: string;
    readonly commitment?: string;
    readonly slot?: number;
    readonly scope: string;
    readonly scopeField: string;
  }[];
  readonly messages: readonly {
    readonly id: string;
    readonly role: 0 | 1;
    readonly chainId: string;
    readonly registry: string;
    readonly groupId: string;
    readonly commitment: string;
    readonly tier2GroupId: string;
    readonly rootBlock: string;
    readonly otherNullifier: string;
    readonly message: string;
    readonly messageField: string;
  }[];
  readonly additions: readonly {
    readonly id: string;
    readonly context: Context;
    readonly groupId: string;
    readonly commitment: string;
    readonly record: string;
    readonly valid: boolean;
    readonly snarkjs: boolean;
    readonly error?: string;
    readonly vouch?: number;
    readonly which?: "vouchee" | "slot";
  }[];
  readonly decode: readonly {
    readonly name: string;
    readonly record: string;
    readonly error: "length" | "non-canonical";
    readonly offset?: number;
  }[];
}

const vectors = JSON.parse(readFileSync(new URL("vouch.json", SPEC_VECTORS), "utf8")) as Vectors;

const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const ctxOf = (c: Context): VouchContext => ({
  chainId: BigInt(c.chainId),
  registry: hex(c.registry),
});
const CTX = ctxOf(vectors.context);
const honest = vectors.additions.find((a) => a.id === "honest");
if (honest === undefined) throw new Error("vouch.json has no honest addition");
const HONEST = hex(honest.record);
// Each check costs six pairings, so properties that check run fewer times.
const runs = Number(process.env.FC_NUM_RUNS ?? 100);

describe("vouch vectors", () => {
  test("the file has the expected format and the spec's parameters", () => {
    expect(vectors.format).toBe("abolish-vouch-vectors/1");
    expect(vectors.parameters).toEqual({ k: VOUCH_K, slots: VOUCH_SLOTS });
    expect(VOUCH_LENGTH).toBe(626);
  });

  test("the Tier 2 root is the tier tree of its leaves", () => {
    expect(tierTreeRoot(vectors.tier2.leaves.map(BigInt))).toBe(BigInt(vectors.tier2.root));
  });

  test.each(vectors.scopes)("scope $id", (s) => {
    const ctx = { chainId: BigInt(s.chainId), registry: hex(s.registry) };
    const bytes =
      s.kind === "vouchee"
        ? vouchScope(ctx, BigInt(s.groupId ?? ""), BigInt(s.commitment ?? ""))
        : vouchSlotScope(ctx, s.slot ?? -1);
    expect(toHex(bytes)).toBe(s.scope);
    expect(semaphoreField(bytes)).toBe(BigInt(s.scopeField));
  });

  test.each(vectors.messages)("message $id", (m) => {
    const bytes = vouchMessage(
      { chainId: BigInt(m.chainId), registry: hex(m.registry) },
      m.role,
      BigInt(m.groupId),
      BigInt(m.commitment),
      BigInt(m.tier2GroupId),
      BigInt(m.rootBlock),
      BigInt(m.otherNullifier),
    );
    expect(toHex(bytes)).toBe(m.message);
    expect(semaphoreField(bytes)).toBe(BigInt(m.messageField));
  });

  test.each(vectors.additions)("addition $id", (a) => {
    const result = checkTier1Addition(hex(a.record), ctxOf(a.context));
    if (a.valid) {
      expect(result.ok).toBe(true);
      return;
    }
    expect(result).toEqual({
      ok: false,
      error: a.error,
      ...(a.vouch === undefined ? {} : { vouch: a.vouch }),
      ...(a.which === undefined ? {} : { which: a.which }),
    });
  });

  test.each(vectors.decode)("decode refuses $name", (d) => {
    const want =
      d.offset === undefined
        ? { ok: false, error: d.error }
        : { ok: false, error: d.error, offset: d.offset };
    expect(decodeTier1Addition(hex(d.record))).toEqual(want);
    expect(checkTier1Addition(hex(d.record), CTX)).toEqual({
      ok: false,
      error: "decode",
      decode: want,
    });
  });
});

describe("each check is needed", () => {
  // The vectors refused by a cheap check carry proofs that snarkjs accepts
  // with the recomputed signals (root-zero's are forged for root 0), so
  // without that check the addition would pass.
  test.each(vectors.additions.filter((a) => !a.valid && a.error !== "proof"))(
    "$id carries proofs snarkjs accepts",
    (a) => {
      expect(a.snarkjs).toBe(true);
    },
  );

  test("every check appears among the vectors", () => {
    const errors = new Set(vectors.additions.map((a) => a.error));
    for (const e of [
      "forbidden-commitment",
      "slot",
      "root",
      "duplicate-voucher",
      "duplicate-slot",
      "proof",
    ])
      expect(errors.has(e)).toBe(true);
  });
});

describe("the record", () => {
  test("every accepted record re-encodes to itself", () => {
    for (const a of vectors.additions) {
      const decoded = decodeTier1Addition(hex(a.record));
      if (decoded.ok) expect(toHex(encodeTier1Addition(decoded.value))).toBe(a.record);
    }
  });

  test("an honest addition is exactly 41 + 626·k bytes", () => {
    expect(HONEST.length).toBe(41 + VOUCH_LENGTH * VOUCH_K);
  });

  test("only exactly k vouches decode", () => {
    for (let n = 0; n <= 5; n++) {
      const bytes = new Uint8Array(41 + VOUCH_LENGTH * n);
      bytes[40] = n;
      if (n !== VOUCH_K) expect(decodeTier1Addition(bytes)).toEqual({ ok: false, error: "length" });
    }
    const wrongCount = new Uint8Array(HONEST);
    wrongCount[40] = VOUCH_K + 1;
    expect(decodeTier1Addition(wrongCount)).toEqual({ ok: false, error: "length" });
  });

  test("the encoder refuses a proof that isn't 256 bytes", () => {
    const decoded = decodeTier1Addition(HONEST);
    if (!decoded.ok) throw new Error("honest doesn't decode");
    const [v, ...rest] = decoded.value.vouches;
    if (v === undefined) throw new Error("no vouch");
    for (const proof of [new Uint8Array([...v.voucheeProof, 0]), v.voucheeProof.subarray(1)])
      expect(() =>
        encodeTier1Addition({
          ...decoded.value,
          vouches: [{ ...v, voucheeProof: proof }, ...rest],
        }),
      ).toThrow();
  });

  test("arbitrary bytes decode or are refused, never throw", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2000 }), (bytes) => {
        const r = decodeTier1Addition(bytes);
        if (r.ok) expect(encodeTier1Addition(r.value)).toEqual(bytes);
      }),
      { numRuns: runs },
    );
  });

  test("a well-framed record with arbitrary contents never throws", () => {
    // The one length and count that decode, so decoding reaches the values.
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 }), (seed) => {
        const n = VOUCH_K;
        const bytes = new Uint8Array(41 + VOUCH_LENGTH * n);
        let x = seed;
        for (let i = 0; i < bytes.length; i++) {
          x = (x * 1103515245 + 12345) % 2 ** 31;
          bytes[i] = x & 0xff;
        }
        bytes[40] = n;
        const r = decodeTier1Addition(bytes);
        if (r.ok) expect(encodeTier1Addition(r.value)).toEqual(bytes);
        else expect(r.error).toBe("non-canonical");
      }),
      { numRuns: runs },
    );
  });

  test("any changed byte of an honest addition fails it", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: HONEST.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, delta) => {
          const bytes = new Uint8Array(HONEST);
          bytes[at] = ((bytes[at] as number) + delta) % 256;
          expect(checkTier1Addition(bytes, CTX).ok).toBe(false);
        },
      ),
      // Each run verifies up to six proofs.
      { numRuns: Math.min(runs, 40) },
    );
  });

  test("a changed byte in every field of every vouch fails the honest addition", () => {
    // Field offsets within a vouch: group, block, root, slot, both
    // nullifiers, and each point of both proofs (A, B, C).
    const fields = [0, 8, 16, 48, 50, 82, 114, 178, 306, 370, 434, 562];
    const offsets = [0, 8];
    for (let i = 0; i < VOUCH_K; i++)
      for (const f of fields) offsets.push(41 + VOUCH_LENGTH * i + f);
    for (const at of offsets) {
      const bytes = new Uint8Array(HONEST);
      bytes[at + 1] = ((bytes[at + 1] as number) + 1) % 256;
      expect(checkTier1Addition(bytes, CTX).ok, `byte ${at + 1}`).toBe(false);
    }
    // 38 changed records, each verifying up to six Groth16 proofs: about 5 s
    // on a shared CI runner, so the default timeout failed it there.
  }, 60_000);

  test("the honest addition fails under any other chain or registry", () => {
    expect(checkTier1Addition(HONEST, CTX).ok).toBe(true);
    const registry = new Uint8Array(CTX.registry);
    registry[19] = (registry[19] as number) ^ 1;
    expect(checkTier1Addition(HONEST, { ...CTX, registry }).ok).toBe(false);
    expect(checkTier1Addition(HONEST, { ...CTX, chainId: CTX.chainId + 1n }).ok).toBe(false);
  });
});

describe("inputs", () => {
  test("a context must be a u64 chain ID and a 20-byte registry", () => {
    expect(() => vouchSlotScope({ ...CTX, chainId: 2n ** 64n }, 0)).toThrow(RangeError);
    expect(() => vouchSlotScope({ ...CTX, chainId: -1n }, 0)).toThrow(RangeError);
    expect(() => vouchSlotScope({ ...CTX, registry: new Uint8Array(19) }, 0)).toThrow(TypeError);
    expect(() => vouchSlotScope({ ...CTX, registry: new Uint8Array(21) }, 0)).toThrow(TypeError);
    expect(() => checkTier1Addition(HONEST, { ...CTX, registry: new Uint8Array(32) })).toThrow(
      TypeError,
    );
  });

  test("scopes and messages refuse values without an encoding", () => {
    expect(() => vouchSlotScope(CTX, 0x10000)).toThrow();
    expect(() => vouchScope(CTX, 2n ** 64n, 5n)).toThrow();
    expect(() => vouchScope(CTX, 0n, 2n ** 254n)).toThrow();
    expect(() => vouchMessage(CTX, 2 as 0, 0n, 5n, 0n, 0n, 0n)).toThrow(RangeError);
  });

  test("the two roles give different messages over the same inputs", () => {
    const m = (role: 0 | 1) => toHex(vouchMessage(CTX, role, 1n, 5n, 2n, 3n, 4n));
    expect(m(0)).not.toBe(m(1));
  });
});
