import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  checkTier1Addition,
  encodeTier1Addition,
  finishVouch,
  MembershipProverError,
  type MembershipProverErrorCode,
  pickVouchSlot,
  poseidon2,
  semaphoreField,
  type Vouch,
  VOUCH_K,
  VOUCH_ROOT_INTERVAL,
  VOUCH_SLOTS,
  VouchProverError,
  type VouchProverErrorCode,
  vouchProverInput,
  type VouchStatement,
  vouchMessage,
} from "../src/index.ts";
import { finishVouchWith, pickVouchSlotWith } from "../src/vouch-prover.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/vouch-prover.json holds Semaphore v4.14.3's own voucher
// identities (secret scalars and commitments), both proofs' circuit inputs
// for each vouch as its generateProof builds them for snarkjs (rebuilt from
// the same secret, path, scope and message), and real proofs for them, made outside the workspace by scripts/vouch-prover-vectors.mjs
// (docs/spec/vouching.md, Prover rules; P3-3 part 3c-3a; T-02, T-06, T-32).
// No expected value comes from the code under test.

interface Proof {
  readonly input: {
    readonly secret: string;
    readonly merkleProofLength: string;
    readonly merkleProofIndex: string;
    readonly merkleProofSiblings: readonly string[];
    readonly scope: string;
    readonly message: string;
  };
  readonly signals: {
    readonly root: string;
    readonly nullifier: string;
    readonly message: string;
    readonly scope: string;
  };
  readonly proof: string;
}

interface Vectors {
  readonly format: string;
  readonly context: { readonly chainId: string; readonly registry: string };
  readonly groupId: string;
  readonly tier2: {
    readonly groupId: string;
    readonly rootBlock: string;
    readonly leaves: readonly string[];
    readonly root: string;
  };
  readonly vouchers: readonly {
    readonly seed: string;
    readonly secret: string;
    readonly commitment: string;
  }[];
  readonly vouchees: readonly string[];
  readonly cases: readonly {
    readonly name: string;
    readonly voucher: number;
    readonly vouchee: number;
    readonly slot: number;
    readonly vouchee_proof: Proof;
    readonly slot_proof: Proof;
    readonly vouch: string;
  }[];
  readonly addition: {
    readonly vouchee: number;
    readonly cases: readonly string[];
    readonly record: string;
  };
}

const vectors = JSON.parse(
  readFileSync(new URL("vouch-prover.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const decimal = (s: string | undefined) => {
  if (s === undefined || !/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal: ${s}`);
  return BigInt(s);
};
const bytes = (hex: string) => {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error(`not hex: ${hex}`);
  return Uint8Array.from(Buffer.from(hex, "hex"));
};
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run finishes two real proofs; the bound keeps a 1,000-run CI campaign in minutes.
const proofRuns = Math.min(numRuns, 25);

const context = {
  chainId: decimal(vectors.context.chainId),
  registry: bytes(vectors.context.registry),
};
const leaves = vectors.tier2.leaves.map(decimal);
type Case = Vectors["cases"][number];
const secretOf = (c: Case) => {
  const v = vectors.vouchers[c.voucher];
  if (v === undefined) throw new Error(`no voucher ${c.voucher}`);
  return bytes(v.secret);
};
const statementOf = (c: Case): VouchStatement => ({
  context,
  groupId: decimal(vectors.groupId),
  commitment: decimal(vectors.vouchees[c.vouchee]),
  tier2GroupId: decimal(vectors.tier2.groupId),
  rootBlock: decimal(vectors.tier2.rootBlock),
  root: decimal(vectors.tier2.root),
  slot: c.slot,
});
const inputOf = (c: Case) => vouchProverInput(secretOf(c), leaves, statementOf(c));
const proofsOf = (c: Case) => [bytes(c.vouchee_proof.proof), bytes(c.slot_proof.proof)] as const;
const caseNamed = (name: string) => {
  const found = vectors.cases.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no case ${name}`);
  return found;
};
const first = caseNamed("leaf-zero");
const signalsOf = (p: Proof) => ({
  root: decimal(p.signals.root),
  nullifier: decimal(p.signals.nullifier),
  message: decimal(p.signals.message),
  scope: decimal(p.signals.scope),
});

function refusal(f: () => unknown): VouchProverErrorCode | MembershipProverErrorCode {
  try {
    f();
  } catch (e) {
    if (e instanceof VouchProverError || e instanceof MembershipProverError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

// The vouch's fields in the spec's byte layout (docs/spec/vouching.md, The
// vouch), read from the vector's bytes, never through the code under test.
function fieldsOf(hex: string) {
  const b = bytes(hex);
  if (b.length !== 626) throw new Error("vouch length");
  const at = (from: number, n: number) =>
    BigInt(`0x${Buffer.from(b.subarray(from, from + n)).toString("hex")}`);
  return {
    tier2GroupId: at(0, 8),
    rootBlock: at(8, 8),
    root: at(16, 32),
    slot: Number(at(48, 2)),
    voucheeNullifier: at(50, 32),
    slotNullifier: at(82, 32),
  };
}

describe("vouch-prover.json", () => {
  test("is the format this test reads, with vouch.json's k and an addition of k", () => {
    expect(vectors.format).toBe("abolish-vouch-prover-vectors/1");
    expect(vectors.addition.cases).toHaveLength(VOUCH_K);
    expect(decimal(vectors.tier2.rootBlock) % VOUCH_ROOT_INTERVAL).toBe(0n);
  });

  test("its binding, Tier 2 leaves and vouchees are vouch.json's", () => {
    const vouch = JSON.parse(readFileSync(new URL("vouch.json", SPEC_VECTORS), "utf8")) as {
      context: unknown;
      tier2: { groupId: string; leaves: readonly string[]; root: string };
      additions: readonly { id: string; groupId: string; commitment: string }[];
    };
    expect(vectors.context).toEqual(vouch.context);
    expect(vectors.tier2.groupId).toBe(vouch.tier2.groupId);
    expect(vectors.tier2.leaves).toEqual(vouch.tier2.leaves);
    expect(vectors.tier2.root).toBe(vouch.tier2.root);
    const honest = vouch.additions.find((a) => a.id === "honest");
    expect(honest?.groupId).toBe(vectors.groupId);
    expect(honest?.commitment).toBe(vectors.vouchees[0]);
  });

  test("its addition passes every check of one addition", () => {
    expect(checkTier1Addition(bytes(vectors.addition.record), context)).toMatchObject({
      ok: true,
    });
  });
});

describe("vouchProverInput", () => {
  test.each(vectors.cases.map((c) => [c.name, c] as const))(
    "%s: both requests are the circuit inputs and signals Semaphore built",
    (_, c) => {
      const input = inputOf(c);
      for (const [built, want] of [
        [input.vouchee, c.vouchee_proof],
        [input.slot, c.slot_proof],
      ] as const) {
        expect(built.witness).toEqual(want.input);
        expect(built.signals).toEqual(signalsOf(want));
      }
    },
  );

  test("the vouchee proof's message names the slot nullifier, and the slot proof's the vouchee nullifier", () => {
    // vouchMessage is held to vouch.json's messages in vouch.test.ts.
    const input = inputOf(first);
    const s = statementOf(first);
    const message = (role: 0 | 1, other: bigint) =>
      semaphoreField(
        vouchMessage(context, role, s.groupId, s.commitment, s.tier2GroupId, s.rootBlock, other),
      );
    expect(input.vouchee.signals.message).toBe(message(0, input.slot.signals.nullifier));
    expect(input.slot.signals.message).toBe(message(1, input.vouchee.signals.nullifier));
  });

  test("refuses each statement the prover rules forbid, before any proof", () => {
    const secret = secretOf(first);
    const at = (change: Partial<VouchStatement>) => () =>
      vouchProverInput(secret, leaves, { ...statementOf(first), ...change });
    for (const commitment of [0n, 1n, poseidon2(0n, 1n), 2n ** 254n])
      expect(refusal(at({ commitment }))).toBe("forbidden-commitment");
    // Every Tier 2 leaf, the voucher's own among them, is not fresh.
    for (const leaf of leaves) expect(refusal(at({ commitment: leaf }))).toBe("not-fresh");
    for (const slot of [-1, VOUCH_SLOTS, 1.5, Number.NaN])
      expect(refusal(at({ slot }))).toBe("slot");
    for (const rootBlock of [1n, decimal(vectors.tier2.rootBlock) + 1n, VOUCH_ROOT_INTERVAL - 1n])
      expect(refusal(at({ rootBlock }))).toBe("root-grid");
    expect(refusal(at({ root: decimal(vectors.tier2.root) + 1n }))).toBe("root");
    expect(() => at({ rootBlock: 2n ** 64n * VOUCH_ROOT_INTERVAL })()).toThrow(RangeError);
    expect(() => at({ tier2GroupId: -1n })()).toThrow(RangeError);
  });

  test("refuses a secret outside the Tier 2 group, and one that isn't a secret", () => {
    const outsider = vectors.vouchers[5];
    if (outsider === undefined) throw new Error("no outsider");
    expect(
      refusal(() => vouchProverInput(bytes(outsider.secret), leaves, statementOf(first))),
    ).toBe("not-a-member");
    expect(refusal(() => vouchProverInput(new Uint8Array(32), leaves, statementOf(first)))).toBe(
      "secret",
    );
  });

  test("refuses the vouchee among the leaves wherever it sits, past the voucher's own leaf", () => {
    const vouchee = decimal(vectors.vouchees[first.vouchee]);
    expect(
      refusal(() => vouchProverInput(secretOf(first), [...leaves, vouchee], statementOf(first))),
    ).toBe("not-fresh");
    // After removed leaves (0), which a tier tree keeps in place.
    expect(
      refusal(() =>
        vouchProverInput(secretOf(first), [...leaves, 0n, 0n, vouchee], statementOf(first)),
      ),
    ).toBe("not-fresh");
  });
});

describe("finishVouch", () => {
  test.each(vectors.cases.map((c) => [c.name, c] as const))(
    "%s: the vouch's fields are the vector's, its proofs re-randomised",
    (_, c) => {
      const [vp, sp] = proofsOf(c);
      const vouch = finishVouch(inputOf(c), vp, sp);
      expect({ ...vouch, voucheeProof: undefined, slotProof: undefined }).toEqual({
        ...fieldsOf(c.vouch),
        voucheeProof: undefined,
        slotProof: undefined,
      });
      expect(vouch.voucheeProof).not.toEqual(vp);
      expect(vouch.slotProof).not.toEqual(sp);
    },
  );

  test("k finished vouches for one vouchee make an addition every check passes", () => {
    const vouches: Vouch[] = vectors.addition.cases.map((name) => {
      const c = caseNamed(name);
      const [vp, sp] = proofsOf(c);
      return finishVouch(inputOf(c), vp, sp);
    });
    const record = encodeTier1Addition({
      groupId: decimal(vectors.groupId),
      commitment: decimal(vectors.vouchees[vectors.addition.vouchee]),
      vouches,
    });
    expect(record).not.toEqual(bytes(vectors.addition.record));
    expect(checkTier1Addition(record, context)).toMatchObject({ ok: true });
  });

  test("refuses swapped proofs, another vouch's proofs and a proof for another vouchee", () => {
    const input = inputOf(first);
    const [vp, sp] = proofsOf(first);
    expect(refusal(() => finishVouch(input, sp, vp))).toBe("proof");
    const [ovp, osp] = proofsOf(caseNamed("middle"));
    expect(refusal(() => finishVouch(input, ovp, sp))).toBe("proof");
    expect(refusal(() => finishVouch(input, vp, osp))).toBe("proof");
    // Same voucher and slot, another vouchee: the slot proof's message names
    // the other vouchee nullifier, so neither proof moves (T-32).
    const [xvp, xsp] = proofsOf(caseNamed("other-vouchee"));
    expect(refusal(() => finishVouch(input, xvp, sp))).toBe("proof");
    expect(refusal(() => finishVouch(input, vp, xsp))).toBe("proof");
  });

  test("draws no randomness when either proof fails", () => {
    const [vp, sp] = proofsOf(first);
    const draw = () => {
      throw new Error("drew");
    };
    expect(refusal(() => finishVouchWith(inputOf(first), vp, vp, draw))).toBe("proof");
    expect(refusal(() => finishVouchWith(inputOf(first), sp, sp, draw))).toBe("proof");
  });

  test("refuses an input it didn't build", () => {
    const input = inputOf(first);
    const [vp, sp] = proofsOf(first);
    expect(() => finishVouch({ ...input }, vp, sp)).toThrow(TypeError);
  });

  test("property: any other statement's inputs refuse the vector's proofs", () => {
    const [vp, sp] = proofsOf(first);
    const base = statementOf(first);
    const u64 = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });
    const change = fc.oneof(
      u64.filter((g) => g !== base.groupId).map((groupId) => ({ groupId })),
      u64.filter((g) => g !== base.tier2GroupId).map((tier2GroupId) => ({ tier2GroupId })),
      fc
        .bigInt({ min: 0n, max: (2n ** 64n - 1n) / VOUCH_ROOT_INTERVAL })
        .map((n) => n * VOUCH_ROOT_INTERVAL)
        .filter((b) => b !== base.rootBlock)
        .map((rootBlock) => ({ rootBlock })),
      fc
        .integer({ min: 0, max: VOUCH_SLOTS - 1 })
        .filter((s) => s !== base.slot)
        .map((slot) => ({ slot })),
      fc
        .constantFrom(...vectors.vouchees.map(decimal))
        .filter((v) => v !== base.commitment)
        .map((commitment) => ({ commitment })),
      fc
        .bigInt({ min: 0n, max: 2n ** 64n - 1n })
        .filter((c) => c !== base.context.chainId)
        .map((chainId) => ({ context: { ...context, chainId } })),
      fc
        .uint8Array({ minLength: 20, maxLength: 20 })
        .filter((r) => !r.every((b, i) => b === context.registry[i]))
        .map((registry) => ({ context: { ...context, registry } })),
    );
    fc.assert(
      fc.property(change, (c) => {
        const input = vouchProverInput(secretOf(first), leaves, { ...base, ...c });
        expect(refusal(() => finishVouch(input, vp, sp))).toBe("proof");
      }),
      { numRuns: proofRuns },
    );
  });
});

describe("pickVouchSlot", () => {
  test("property: picks a slot in [0, L) outside the unavailable ones", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: VOUCH_SLOTS - 1 }), {
          maxLength: VOUCH_SLOTS - 1,
        }),
        (taken) => {
          const j = pickVouchSlot(taken);
          expect(Number.isInteger(j) && j >= 0 && j < VOUCH_SLOTS).toBe(true);
          expect(taken).not.toContain(j);
        },
      ),
      { numRuns },
    );
  });

  test("property: every free slot takes exactly as many accepted bytes as any other", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: VOUCH_SLOTS - 1 }), {
          maxLength: VOUCH_SLOTS - 1,
        }),
        (taken) => {
          const counts = new Map<number, number>();
          let rejected = 0;
          for (let v = 0; v < 256; v++) {
            // A byte the rejection refuses asks for another; answer with an
            // out-of-band marker that ends the pick.
            let calls = 0;
            const draw = () => {
              calls++;
              if (calls > 1) throw new Error("rejected");
              return Uint8Array.of(v);
            };
            try {
              const j = pickVouchSlotWith(taken, draw);
              counts.set(j, (counts.get(j) ?? 0) + 1);
            } catch (e) {
              if (!(e instanceof Error) || e.message !== "rejected") throw e;
              rejected++;
            }
          }
          const free = VOUCH_SLOTS - taken.length;
          expect(counts.size).toBe(free);
          expect(new Set(counts.values()).size).toBe(1);
          expect(rejected).toBe(256 % free);
        },
      ),
      { numRuns },
    );
  });

  test("refuses when every slot is unavailable, and slots outside [0, L)", () => {
    const all = Array.from({ length: VOUCH_SLOTS }, (_, j) => j);
    expect(refusal(() => pickVouchSlot(all))).toBe("no-slot");
    expect(refusal(() => pickVouchSlot([...all, ...all]))).toBe("no-slot");
    for (const bad of [-1, VOUCH_SLOTS, 0.5])
      expect(() => pickVouchSlot([bad])).toThrow(RangeError);
  });
});
