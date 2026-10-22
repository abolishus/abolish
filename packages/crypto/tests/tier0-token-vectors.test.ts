import { ristretto255, ristretto255_hasher, ristretto255_oprf } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { ds, TAG_REGISTRY } from "../src/index.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/tier0-token.json comes from an independent Python
// implementation of RFC 9497's POPRF mode (scripts/tier0-token-vectors.py,
// itself checked against RFC 9497 Appendix A.1.3). Until packages/crypto has
// its own token code (P2-30 part 2), these tests check the file against
// @noble/curves' RFC 9497 implementation and our `DS` framing, so the spec's
// vectors are confirmed by two implementations before anything is built on
// them (T-74).

interface Issuance {
  readonly id: string;
  readonly secretKey: string;
  readonly publicKey: string;
  readonly period: string;
  readonly keyId: string;
  readonly chainId: string;
  readonly groupRegistry: string;
  readonly groupId: string;
  readonly info: string;
  readonly commitment: string;
  readonly input: string;
  readonly blind: string;
  readonly blindedElement: string;
  readonly tweakedKey: string;
  readonly evaluationElement: string;
  readonly proof: string;
  readonly token: string;
}

interface Vectors {
  readonly format: string;
  readonly suite: { readonly name: string; readonly mode: number; readonly contextString: string };
  readonly tags: { readonly key: string; readonly info: string; readonly input: string };
  readonly inputVersion: number;
  readonly keyPeriod: string;
  readonly keys: readonly { id: string; period: string; publicKey: string; keyId: string }[];
  readonly infos: readonly {
    id: string;
    chainId: string;
    groupRegistry: string;
    groupId: string;
    info: string;
  }[];
  readonly inputs: readonly {
    id: string;
    keyId: string;
    commitment: string;
    input?: string;
    error?: string;
  }[];
  readonly issuances: readonly Issuance[];
  readonly finalizations: readonly {
    id: string;
    publicKey: string;
    info: string;
    input?: string;
    blind?: string;
    blindedElement?: string;
    evaluationElement?: string;
    proof?: string;
    token?: string;
    error?: string;
  }[];
  readonly blindedElements: readonly { id: string; encoding: string; error?: string }[];
  readonly periods: readonly {
    id: string;
    now: string;
    keyPeriod: string;
    issues: boolean;
    redeems: boolean;
  }[];
  readonly redemptionKeys: readonly string[];
  readonly redemptions: readonly {
    id: string;
    now: string;
    keyId: string;
    info: string;
    commitment: string;
    token: string;
    accepted?: boolean;
    error?: string;
  }[];
}

const V = JSON.parse(readFileSync(new URL("tier0-token.json", SPEC_VECTORS), "utf8")) as Vectors;

// BN254's scalar field order, the bound on a field<bn254> commitment.
const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const ascii = (s: string) => new TextEncoder().encode(s);
const beBytes = (n: bigint, len: number) =>
  hexToBytes(
    n
      .toString(16)
      .padStart(2 * len, "0")
      .slice(-2 * len),
  );

const keyId = (period: bigint, publicKey: Uint8Array) =>
  sha256(ds("abolish/v1/tier0-token/key", concatBytes(beBytes(period, 4), publicKey)));
const groupInfo = (chainId: bigint, registry: Uint8Array, groupId: bigint) =>
  sha256(
    ds(
      "abolish/v1/tier0-token/info",
      concatBytes(beBytes(chainId, 8), registry, beBytes(groupId, 8)),
    ),
  );
const tokenInput = (kid: Uint8Array, commitment: Uint8Array) =>
  sha256(ds("abolish/v1/tier0-token/input", concatBytes(Uint8Array.of(1), kid, commitment)));

describe("Tier 0 token vectors (docs/spec/tier0-token.md)", () => {
  test("parses every list", () => {
    expect(V.format).toBe("abolish-tier0-token-vectors/1");
    expect([
      V.keys.length,
      V.infos.length,
      V.inputs.length,
      V.issuances.length,
      V.finalizations.length,
      V.blindedElements.length,
      V.periods.length,
      V.redemptions.length,
    ]).toEqual([4, 5, 5, 4, 8, 7, 6, 12]);
  });

  test("the suite is RFC 9497's POPRF mode over ristretto255-SHA512", () => {
    expect(V.suite).toEqual({
      name: "ristretto255-SHA512",
      mode: 2,
      contextString: bytesToHex(
        concatBytes(ascii("OPRFV1-"), Uint8Array.of(2), ascii("-ristretto255-SHA512")),
      ),
    });
    expect(ristretto255_oprf.name).toBe("ristretto255-SHA512");
  });

  test("the three tags are registered as specified plain hashes", () => {
    for (const tag of Object.values(V.tags))
      expect(TAG_REGISTRY).toContainEqual({ tag, primitive: "plain", status: "specified" });
    expect(V.inputVersion).toBe(1);
    expect(V.keyPeriod).toBe("2592000");
  });

  test.each(V.keys.map((v) => [v.id, v] as const))("key identifier %s", (_id, v) => {
    expect(bytesToHex(keyId(BigInt(v.period), hexToBytes(v.publicKey)))).toBe(v.keyId);
  });

  test.each(V.infos.map((v) => [v.id, v] as const))("group info %s", (_id, v) => {
    const info = groupInfo(BigInt(v.chainId), hexToBytes(v.groupRegistry), BigInt(v.groupId));
    expect(bytesToHex(info)).toBe(v.info);
  });

  test.each(V.inputs.map((v) => [v.id, v] as const))("token input %s", (_id, v) => {
    const canonical = BigInt(`0x${v.commitment}`) < R;
    if (v.error !== undefined) {
      expect([canonical, v.error]).toEqual([false, "non-canonical"]);
      return;
    }
    expect(canonical).toBe(true);
    expect(bytesToHex(tokenInput(hexToBytes(v.keyId), hexToBytes(v.commitment)))).toBe(v.input);
  });

  test.each(V.issuances.map((v) => [v.id, v] as const))("issuance %s", (_id, v) => {
    const sk = hexToBytes(v.secretKey);
    const pk = ristretto255.Point.BASE.multiply(ristretto255.Point.Fn.fromBytes(sk));
    expect(pk.toHex()).toBe(v.publicKey);
    expect(bytesToHex(keyId(BigInt(v.period), pk.toBytes()))).toBe(v.keyId);
    const info = groupInfo(BigInt(v.chainId), hexToBytes(v.groupRegistry), BigInt(v.groupId));
    expect(bytesToHex(info)).toBe(v.info);
    const input = tokenInput(hexToBytes(v.keyId), hexToBytes(v.commitment));
    expect(bytesToHex(input)).toBe(v.input);

    // Blind: blind · HashToGroup(input), under RFC 9497's own DST.
    const dst = concatBytes(ascii("HashToGroup-"), hexToBytes(V.suite.contextString));
    const blinded = ristretto255_hasher
      .hashToCurve(input, { DST: dst })
      .multiply(ristretto255.Point.Fn.fromBytes(hexToBytes(v.blind)));
    expect(blinded.toHex()).toBe(v.blindedElement);

    const poprf = ristretto255_oprf.poprf(info);
    expect(bytesToHex(poprf.blind(input, pk.toBytes()).tweakedKey)).toBe(v.tweakedKey);
    // Finalize checks the issuer's proof against the tweaked key.
    const token = poprf.finalize(
      input,
      hexToBytes(v.blind),
      hexToBytes(v.evaluationElement),
      hexToBytes(v.blindedElement),
      hexToBytes(v.proof),
      hexToBytes(v.tweakedKey),
    );
    expect(bytesToHex(token)).toBe(v.token);
    // The issuer's evaluation without the client gives the same token.
    expect(bytesToHex(poprf.evaluate(sk, input))).toBe(v.token);
    // Its evaluation of the blinded element is the vector's (the proof's
    // randomness differs, so only the element is compared).
    expect(bytesToHex(poprf.blindEvaluate(sk, hexToBytes(v.blindedElement)).evaluated)).toBe(
      v.evaluationElement,
    );
  });

  test("every issuance's token differs", () => {
    expect(new Set(V.issuances.map((v) => v.token)).size).toBe(V.issuances.length);
  });

  test.each(V.finalizations.map((v) => [v.id, v] as const))("finalization %s", (_id, v) => {
    const poprf = ristretto255_oprf.poprf(hexToBytes(v.info));
    if (v.error === "tweaked-key-identity") {
      expect(() => poprf.blind(ascii("x"), hexToBytes(v.publicKey))).toThrow();
      return;
    }
    const input = hexToBytes(v.input ?? "");
    const run = () =>
      poprf.finalize(
        input,
        hexToBytes(v.blind ?? ""),
        hexToBytes(v.evaluationElement ?? ""),
        hexToBytes(v.blindedElement ?? ""),
        hexToBytes(v.proof ?? ""),
        poprf.blind(input, hexToBytes(v.publicKey)).tweakedKey,
      );
    if (v.error === undefined) expect(bytesToHex(run())).toBe(v.token);
    else {
      expect(v.error).toBe("proof");
      expect(run).toThrow();
    }
  });

  test.each(V.blindedElements.map((v) => [v.id, v] as const))("blinded element %s", (_id, v) => {
    const decode = () => {
      const p = ristretto255.Point.fromHex(v.encoding);
      if (p.is0()) throw new Error("identity");
      return p;
    };
    if (v.error === undefined) expect(decode().toHex()).toBe(v.encoding);
    else expect(decode).toThrow();
  });

  test.each(V.periods.map((v) => [v.id, v] as const))("key period %s", (_id, v) => {
    const now = BigInt(v.now);
    const q = BigInt(v.keyPeriod);
    const current = now / BigInt(V.keyPeriod);
    expect(current === q).toBe(v.issues);
    expect(current === q || current === q + 1n).toBe(v.redeems);
  });

  test.each(V.redemptions.map((v) => [v.id, v] as const))("redemption %s", (_id, v) => {
    // The service holds the keys of issue-launch and issue-other-key.
    const held = new Map(
      V.redemptionKeys.map((k) => {
        const issuance = V.issuances.find((i) => i.keyId === k);
        if (issuance === undefined) throw new Error(`no issuance for key ${k}`);
        return [k, issuance] as const;
      }),
    );
    const redeem = (): string => {
      const key = held.get(v.keyId);
      if (key === undefined) return "key-unknown";
      const current = BigInt(v.now) / BigInt(V.keyPeriod);
      const q = BigInt(key.period);
      if (current !== q && current !== q + 1n) return "key-period";
      const expected = ristretto255_oprf
        .poprf(hexToBytes(v.info))
        .evaluate(
          hexToBytes(key.secretKey),
          tokenInput(hexToBytes(v.keyId), hexToBytes(v.commitment)),
        );
      return bytesToHex(expected) === v.token ? "accepted" : "token";
    };
    expect(redeem()).toBe(v.accepted === true ? "accepted" : v.error);
  });
});
