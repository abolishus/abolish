import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  decodeTier0TokenBlindedElement,
  TAG_REGISTRY,
  Tier0TokenError,
  tier0TokenEvaluate,
  tier0TokenFinalize,
  tier0TokenInfo,
  tier0TokenInput,
  tier0TokenKeyId,
  tier0TokenKeyIssues,
  tier0TokenKeyRedeems,
  tier0TokenMatches,
  tier0TokenPublicKey,
  TOKEN_KEY_PERIOD,
  TOKEN_REDEEM_DELAY,
  TOKEN_VERSION,
} from "../src/index.ts";
import { tier0TokenBlindEvaluateWith, tier0TokenBlindWith } from "../src/tier0-token.ts";
import { SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/tier0-token.json comes from an independent Python
// implementation of RFC 9497's POPRF mode (scripts/tier0-token-vectors.py,
// itself checked against RFC 9497 Appendix A.1.3), so these tests check the
// package's own token code against an implementation that shares none of it
// (T-74). tier0-token.test.ts runs the same code on RFC 9497's own vectors.

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
  readonly proofRandomScalar: string;
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
  readonly redeemDelay: string;
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

const ascii = (s: string) => new TextEncoder().encode(s);
const scalarLe = (hex: string) => {
  let v = 0n;
  for (const x of hexToBytes(hex).reverse()) v = (v << 8n) | BigInt(x);
  return v;
};
const code = (run: () => unknown): string => {
  try {
    run();
    return "ok";
  } catch (e) {
    if (e instanceof Tier0TokenError) return e.code;
    throw e;
  }
};
const group = (v: { chainId: string; groupRegistry: string; groupId: string }) => ({
  chainId: BigInt(v.chainId),
  groupRegistry: hexToBytes(v.groupRegistry),
  groupId: BigInt(v.groupId),
});

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
    ]).toEqual([4, 5, 5, 4, 10, 7, 6, 12]);
  });

  test("the suite is RFC 9497's POPRF mode over ristretto255-SHA512", () => {
    expect(V.suite).toEqual({
      name: "ristretto255-SHA512",
      mode: 2,
      contextString: bytesToHex(
        concatBytes(ascii("OPRFV1-"), Uint8Array.of(2), ascii("-ristretto255-SHA512")),
      ),
    });
  });

  test("the three tags are registered and the values are the package's", () => {
    for (const tag of Object.values(V.tags))
      expect(TAG_REGISTRY).toContainEqual({ tag, primitive: "plain", status: "specified" });
    expect(V.inputVersion).toBe(TOKEN_VERSION);
    expect(V.keyPeriod).toBe(String(TOKEN_KEY_PERIOD));
    expect(V.redeemDelay).toBe(String(TOKEN_REDEEM_DELAY));
  });

  test.each(V.keys.map((v) => [v.id, v] as const))("key identifier %s", (_id, v) => {
    expect(bytesToHex(tier0TokenKeyId(Number(v.period), hexToBytes(v.publicKey)))).toBe(v.keyId);
  });

  test.each(V.infos.map((v) => [v.id, v] as const))("group info %s", (_id, v) => {
    expect(bytesToHex(tier0TokenInfo(group(v)))).toBe(v.info);
  });

  test.each(V.inputs.map((v) => [v.id, v] as const))("token input %s", (_id, v) => {
    const run = () => tier0TokenInput(hexToBytes(v.keyId), hexToBytes(v.commitment));
    if (v.error !== undefined) expect(code(run)).toBe(v.error);
    else expect(bytesToHex(run())).toBe(v.input);
  });

  test.each(V.issuances.map((v) => [v.id, v] as const))("issuance %s", (_id, v) => {
    const sk = hexToBytes(v.secretKey);
    const pk = tier0TokenPublicKey(sk);
    expect(bytesToHex(pk)).toBe(v.publicKey);
    expect(bytesToHex(tier0TokenKeyId(Number(v.period), pk))).toBe(v.keyId);
    const info = tier0TokenInfo(group(v));
    expect(bytesToHex(info)).toBe(v.info);
    const input = tier0TokenInput(hexToBytes(v.keyId), hexToBytes(v.commitment));
    expect(bytesToHex(input)).toBe(v.input);

    const blinding = tier0TokenBlindWith(input, pk, info, hexToBytes(v.blind));
    expect(bytesToHex(blinding.blindedElement)).toBe(v.blindedElement);
    expect(bytesToHex(blinding.tweakedKey)).toBe(v.tweakedKey);
    // The issuer's answer, proof included, under the vector's proof randomness.
    const answer = tier0TokenBlindEvaluateWith(
      sk,
      blinding.blindedElement,
      info,
      scalarLe(v.proofRandomScalar),
    );
    expect(bytesToHex(answer.evaluationElement)).toBe(v.evaluationElement);
    expect(bytesToHex(answer.proof)).toBe(v.proof);
    const token = tier0TokenFinalize({
      input,
      info,
      publicKey: pk,
      blind: blinding.blind,
      blindedElement: blinding.blindedElement,
      ...answer,
    });
    expect(bytesToHex(token)).toBe(v.token);
    // The issuer's evaluation without the client gives the same token.
    expect(bytesToHex(tier0TokenEvaluate(sk, input, info))).toBe(v.token);
  });

  test("every issuance's token differs", () => {
    expect(new Set(V.issuances.map((v) => v.token)).size).toBe(V.issuances.length);
  });

  test.each(V.finalizations.map((v) => [v.id, v] as const))("finalization %s", (_id, v) => {
    const run = () =>
      tier0TokenFinalize({
        input: hexToBytes(v.input ?? ""),
        info: hexToBytes(v.info),
        publicKey: hexToBytes(v.publicKey),
        blind: hexToBytes(v.blind ?? ""),
        blindedElement: hexToBytes(v.blindedElement ?? ""),
        evaluationElement: hexToBytes(v.evaluationElement ?? ""),
        proof: hexToBytes(v.proof ?? ""),
      });
    if (v.error === undefined) expect(bytesToHex(run())).toBe(v.token);
    else expect(code(run)).toBe(v.error);
  });

  test.each(V.blindedElements.map((v) => [v.id, v] as const))("blinded element %s", (_id, v) => {
    const run = () => decodeTier0TokenBlindedElement(hexToBytes(v.encoding));
    if (v.error === undefined) expect(bytesToHex(run())).toBe(v.encoding);
    else expect(code(run)).toBe(v.error);
  });

  test.each(V.periods.map((v) => [v.id, v] as const))("key period %s", (_id, v) => {
    const [now, q] = [Number(v.now), Number(v.keyPeriod)];
    expect(tier0TokenKeyIssues(q, now)).toBe(v.issues);
    expect(tier0TokenKeyRedeems(q, now)).toBe(v.redeems);
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
      if (!tier0TokenKeyRedeems(Number(key.period), Number(v.now))) return "key-period";
      const input = tier0TokenInput(hexToBytes(v.keyId), hexToBytes(v.commitment));
      return tier0TokenMatches(
        hexToBytes(key.secretKey),
        input,
        hexToBytes(v.info),
        hexToBytes(v.token),
      )
        ? "accepted"
        : "token";
    };
    expect(redeem()).toBe(v.accepted === true ? "accepted" : v.error);
  });
});
