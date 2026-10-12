import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  authenticationJSON,
  creationOptions,
  fromBase64url,
  registrationJSON,
  requestOptions,
  toBase64url,
} from "../src/account/webauthn.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const bytes = fc.uint8Array({ maxLength: 96 });

describe("base64url", () => {
  test("round-trips every byte string, and matches Node's encoder", () => {
    fc.assert(
      fc.property(bytes, (b) => {
        const text = toBase64url(b);
        expect(text).toBe(Buffer.from(b).toString("base64url"));
        expect(fromBase64url(text)).toEqual(b);
      }),
      { numRuns },
    );
  });

  test("refuses padding, the standard alphabet, impossible lengths and non-canonical text", () => {
    for (const bad of ["AA==", "A+/B", "A", "AAAAA", "AB", "AAB", "A A", "é"])
      expect(() => fromBase64url(bad), bad).toThrow(RangeError);
  });

  test("accepts only text it would itself produce", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z0-9_-]{0,24}$/), (text) => {
        let decoded: Uint8Array | undefined;
        try {
          decoded = fromBase64url(text);
        } catch {
          return;
        }
        expect(toBase64url(decoded)).toBe(text);
      }),
      { numRuns },
    );
  });
});

const REGISTRATION = {
  challenge: "Y2hhbGxlbmdl",
  rp: { name: "Abolish", id: "abolish.test" },
  user: { id: "dXNlcg", name: "Abolish account", displayName: "" },
  pubKeyCredParams: [
    { type: "public-key", alg: -8 },
    { type: "public-key", alg: -7 },
  ],
  timeout: 60_000,
  attestation: "none",
  excludeCredentials: [{ id: "a2V5", type: "public-key", transports: ["internal", 7] }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
  extensions: { credProps: true },
};

describe("options", () => {
  test("registration options decode their byte fields and keep the rest", () => {
    const o = creationOptions(REGISTRATION);
    expect(new Uint8Array(o.challenge as ArrayBuffer)).toEqual(
      new TextEncoder().encode("challenge"),
    );
    expect(new Uint8Array(o.user.id as ArrayBuffer)).toEqual(new TextEncoder().encode("user"));
    expect(o.rp).toEqual({ name: "Abolish", id: "abolish.test" });
    expect(o.pubKeyCredParams).toEqual(REGISTRATION.pubKeyCredParams);
    expect(o.excludeCredentials?.[0]?.transports).toEqual(["internal"]);
    expect(o.authenticatorSelection).toEqual(REGISTRATION.authenticatorSelection);
    expect(o.timeout).toBe(60_000);
    expect(o.attestation).toBe("none");
    // No extension is asked for, whatever the server sends.
    expect("extensions" in o).toBe(false);
  });

  test("authentication options decode their byte fields", () => {
    const o = requestOptions({
      challenge: "AQID",
      rpId: "abolish.test",
      allowCredentials: [{ id: "BAU", type: "public-key" }],
      userVerification: "required",
    });
    expect(new Uint8Array(o.challenge as ArrayBuffer)).toEqual(Uint8Array.of(1, 2, 3));
    expect(o.rpId).toBe("abolish.test");
    expect(new Uint8Array(o.allowCredentials?.[0]?.id as ArrayBuffer)).toEqual(Uint8Array.of(4, 5));
    expect(o.userVerification).toBe("required");
  });

  test("malformed options are refused, not passed to the browser", () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      { ...REGISTRATION, challenge: 1 },
      { ...REGISTRATION, challenge: "Y2=" },
      { ...REGISTRATION, user: { ...REGISTRATION.user, id: "+" } },
      { ...REGISTRATION, rp: null },
      { ...REGISTRATION, pubKeyCredParams: [{ alg: "-7" }] },
      { ...REGISTRATION, excludeCredentials: {} },
    ];
    for (const json of bad) expect(() => creationOptions(json)).toThrow();
    expect(() => requestOptions({ challenge: "AQID", allowCredentials: [{ id: 3 }] })).toThrow();
  });
});

const buffer = (...b: number[]) => Uint8Array.from(b).buffer;

describe("credentials", () => {
  test("a new credential serialises as RegistrationResponseJSON, with no extension results", () => {
    const credential = {
      id: "AQI",
      rawId: buffer(1, 2),
      type: "public-key",
      authenticatorAttachment: "platform",
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
      response: {
        clientDataJSON: buffer(3),
        attestationObject: buffer(4, 5),
        getTransports: () => ["internal", "hybrid"],
      },
    } as unknown as PublicKeyCredential;
    expect(registrationJSON(credential)).toEqual({
      id: "AQI",
      rawId: "AQI",
      type: "public-key",
      response: {
        clientDataJSON: "Aw",
        attestationObject: "BAU",
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
    });
  });

  test("an assertion serialises as AuthenticationResponseJSON", () => {
    const credential = {
      id: "AQI",
      rawId: buffer(1, 2),
      type: "public-key",
      authenticatorAttachment: null,
      response: {
        clientDataJSON: buffer(3),
        authenticatorData: buffer(4),
        signature: buffer(5),
        userHandle: buffer(6),
      },
    } as unknown as PublicKeyCredential;
    expect(authenticationJSON(credential)).toEqual({
      id: "AQI",
      rawId: "AQI",
      type: "public-key",
      response: {
        clientDataJSON: "Aw",
        authenticatorData: "BA",
        signature: "BQ",
        userHandle: "Bg",
      },
      clientExtensionResults: {},
    });
  });
});
