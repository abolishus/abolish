import { p256 } from "@noble/curves/nist.js";
import { webcrypto } from "node:crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  createWebPushSender,
  MAX_PUSH_ENDPOINT,
  MAX_PUSH_TIMEOUT_MS,
  newVapidKey,
  parsePushEndpoint,
  PUSH_TTL_SECONDS,
  VAPID_TOKEN_SECONDS,
  vapidAuthorization,
  vapidKeys,
  vapidPublicKey,
} from "../src/index.ts";

// Payload-less web push (src/web-push.ts; P2-27 part 4): only endpoints on
// the known push services are called (T-76), the VAPID token is RFC 8292's
// ES256 JWT with its key checked against RFC 7515's published example and its
// signature checked by an independent implementation (WebCrypto), and the
// request carries nothing but the token, a TTL, an urgency and a fixed topic
// (T-73).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

// RFC 7515, Appendix A.3 (https://www.rfc-editor.org/rfc/rfc7515.txt, sha256
// ecbf84674118e62526511c1237e1deaa86aada86d25b247623a2a7e04ae62e40): the
// ES256 example's key and its JWS, signature R || S.
const A3 = {
  d: "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI",
  x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
  y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
  input:
    "eyJhbGciOiJFUzI1NiJ9." +
    "eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ",
  signature:
    "DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q",
};

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const NOW = new Date("2026-10-23T09:00:00.700Z");
const FCM = "https://fcm.googleapis.com/fcm/send/dGVzdA:APA91bH-example_token";
const ENDPOINTS = [
  FCM,
  "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample",
  "https://web.push.apple.com/QGuQyavXutnMH8hWZb7_example",
  "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAexample%2Bv%3D",
];

describe("parsePushEndpoint", () => {
  test("takes the push services' endpoints as they are", () => {
    for (const e of ENDPOINTS) expect(parsePushEndpoint(e)).toBe(e);
  });

  test("refuses any other host, scheme, port, user, fragment or spelling", () => {
    for (const e of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:443/fcm/send/x",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user@fcm.googleapis.com/fcm/send/x",
      "https://user:pw@fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com/fcm/send/x#y",
      "https://fcm.googleapis.com/fcm/send/x#",
      "https://FCM.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com./fcm/send/x",
      "https://fcm.googleapis.com/fcm/../send/x",
      "https://fcm.googleapis.com/fcm/send/ x",
      " https://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com",
      "https://evil.fcm.googleapis.com.example/x",
      "https://googleapis.com/fcm/send/x",
      "https://notify.windows.com/w/",
      "https://a.b.notify.windows.com/w/",
      "https://notify.windows.com.example/w/",
      "https://127.0.0.1/fcm/send/x",
      "https://[::1]/fcm/send/x",
      "https://localhost/x",
      "https://169.254.169.254/latest/meta-data/",
      "https://xn--fcm-googleapis-com.example/x",
      "file:///etc/passwd",
      "mailto:a@b.c",
      "",
      "fcm.googleapis.com/fcm/send/x",
    ])
      expect(parsePushEndpoint(e), e).toBeUndefined();
  });

  test(`refuses an endpoint longer than ${MAX_PUSH_ENDPOINT} characters`, () => {
    const base = "https://fcm.googleapis.com/fcm/send/";
    const exact = base + "a".repeat(MAX_PUSH_ENDPOINT - base.length);
    expect(parsePushEndpoint(exact)).toBe(exact);
    expect(parsePushEndpoint(exact + "a")).toBeUndefined();
  });

  test("anything it takes is https on a known host, and is its own canonical URL", () => {
    const hosts = [
      "fcm.googleapis.com",
      "updates.push.services.mozilla.com",
      "web.push.apple.com",
      "wns2-bl2p.notify.windows.com",
      "example.com",
      "127.0.0.1",
      "fcm.googleapis.com.evil",
    ];
    const known = (h: string) =>
      ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"].includes(
        h,
      ) || /^[a-z0-9-]+\.notify\.windows\.com$/.test(h);
    fc.assert(
      fc.property(
        fc.constantFrom("https://", "http://", "HTTPS://", "https://u@"),
        fc.constantFrom(...hosts),
        fc.constantFrom("", ":443", ":1"),
        fc.string({ maxLength: 40 }),
        (scheme, host, port, path) => {
          const e = `${scheme}${host}${port}/${path}`;
          const got = parsePushEndpoint(e);
          if (got === undefined) return;
          const url = new URL(got);
          expect(got).toBe(e);
          expect(url.href).toBe(e);
          expect(url.protocol).toBe("https:");
          expect(url.port).toBe("");
          expect(url.username).toBe("");
          expect(known(url.hostname)).toBe(true);
        },
      ),
      { numRuns },
    );
  });
});

describe("VAPID keys", () => {
  test("derive RFC 7515 A.3's public key from its private key", () => {
    const keys = vapidKeys(A3.d);
    expect(keys.publicKey).toEqual(new Uint8Array([4, ...b64(A3.x), ...b64(A3.y)]));
    expect(vapidPublicKey(keys)).toBe(Buffer.from(keys.publicKey).toString("base64url"));
  });

  test("ES256 as RFC 7515 A.3 signs it: its published signature verifies over SHA-256, R || S", () => {
    const keys = vapidKeys(A3.d);
    const input = new TextEncoder().encode(A3.input);
    expect(p256.verify(b64(A3.signature), input, keys.publicKey, { lowS: false })).toBe(true);
  });

  test("refuse a key that is not one 32-byte scalar in canonical unpadded base64url", () => {
    const n = p256.Point.CURVE().n;
    const scalar = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
    for (const k of [
      "",
      A3.d + "=",
      A3.d.slice(0, -1),
      A3.d + "AA",
      // The last character's unused bits set: another spelling of other bytes.
      A3.d.slice(0, -1) + "J",
      A3.d.replace(/-/g, "+"),
      scalar(0n).toString("base64url"),
      scalar(n).toString("base64url"),
      scalar(n + 1n).toString("base64url"),
    ])
      expect(() => vapidKeys(k), k).toThrow("not a P-256 secret key");
    expect(vapidKeys(scalar(n - 1n).toString("base64url")).secretKey).toHaveLength(32);
  });

  test("a new key is one vapidKeys takes, and keys differ", () => {
    const a = newVapidKey();
    expect(vapidKeys(a).publicKey).toHaveLength(65);
    expect(newVapidKey()).not.toBe(a);
  });
});

/** The JWT's parts from an Authorization value, checked against RFC 8292 section 3's form. */
function parseAuthorization(value: string) {
  const m =
    /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(
      value,
    );
  if (m === null) throw new Error(`not a VAPID authorization: ${value}`);
  const [, header, claims, signature, k] = m as unknown as [string, string, string, string, string];
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()) as unknown,
    claims: JSON.parse(Buffer.from(claims, "base64url").toString()) as unknown,
    input: `${header}.${claims}`,
    signature: b64(signature),
    k: b64(k),
  };
}

/** Verifies an ES256 signature with WebCrypto, an implementation apart from ours. */
async function webcryptoVerifies(publicKey: Uint8Array, signature: Uint8Array, input: string) {
  const key = await webcrypto.subtle.importKey(
    "raw",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signature,
    new TextEncoder().encode(input),
  );
}

describe("vapidAuthorization", () => {
  test("is RFC 8292's token over the audience, signed as ES256 and checked by WebCrypto", async () => {
    const keys = vapidKeys(A3.d);
    const a = parseAuthorization(
      vapidAuthorization(keys, "https://fcm.googleapis.com", "mailto:ops@abolish.test", NOW),
    );
    expect(a.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(a.claims).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Math.floor(NOW.getTime() / 1000) + VAPID_TOKEN_SECONDS,
      sub: "mailto:ops@abolish.test",
    });
    expect(VAPID_TOKEN_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
    expect(a.k).toEqual(keys.publicKey);
    expect(a.signature).toHaveLength(64);
    expect(await webcryptoVerifies(keys.publicKey, a.signature, a.input)).toBe(true);
  });

  test("any key's token verifies under its own public key, and no changed byte does", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constant(null).map(() => vapidKeys(newVapidKey())),
        fc.date({ min: new Date(0), max: new Date(4e12), noInvalidDate: true }),
        fc.nat(),
        async (keys, now, at) => {
          const a = parseAuthorization(
            vapidAuthorization(keys, "https://web.push.apple.com", "https://abolish.test", now),
          );
          expect(await webcryptoVerifies(keys.publicKey, a.signature, a.input)).toBe(true);
          const bad = a.signature.slice();
          bad[at % 64]! ^= 1 << (at % 8);
          expect(await webcryptoVerifies(keys.publicKey, bad, a.input)).toBe(false);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  });
});

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A push service that answers `answer` (a status or a thrown error). */
function service(answer: number | Error) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: url instanceof Request ? url.url : url.toString(), init });
    if (answer instanceof Error) throw answer;
    return new Response(answer === 201 ? null : "refused", { status: answer });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const SUBJECT = "mailto:ops@abolish.test";

describe("createWebPushSender", () => {
  test("posts nothing but the token, a TTL, an urgency and a fixed topic to the endpoint", async () => {
    const { sent, fetch } = service(201);
    const sender = createWebPushSender({ secretKey: A3.d, subject: SUBJECT, fetch });
    expect(await sender.send(FCM, NOW)).toBe("sent");
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(FCM);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["authorization", "topic", "ttl", "urgency"]);
    expect(headers).toMatchObject({
      ttl: String(PUSH_TTL_SECONDS),
      urgency: "normal",
      topic: "notice",
    });
    const a = parseAuthorization(headers["authorization"]!);
    expect(a.claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: SUBJECT });
    expect(await webcryptoVerifies(vapidKeys(A3.d).publicKey, a.signature, a.input)).toBe(true);
  });

  test("each service's token names that service's origin", async () => {
    for (const e of ENDPOINTS) {
      const { sent, fetch } = service(201);
      await createWebPushSender({ secretKey: A3.d, subject: SUBJECT, fetch }).send(e, NOW);
      const headers = sent[0]?.init?.headers as Record<string, string>;
      expect(parseAuthorization(headers["authorization"]!).claims).toMatchObject({
        aud: new URL(e).origin,
      });
    }
  });

  test("a 2xx is sent, 404 and 410 are gone, anything else or a throw is unavailable", async () => {
    const cases: [number | Error, string][] = [
      [201, "sent"],
      [200, "sent"],
      [202, "sent"],
      [404, "gone"],
      [410, "gone"],
      [400, "unavailable"],
      [401, "unavailable"],
      [403, "unavailable"],
      [413, "unavailable"],
      [429, "unavailable"],
      [500, "unavailable"],
      [503, "unavailable"],
      [301, "unavailable"],
      [new TypeError("fetch failed"), "unavailable"],
    ];
    for (const [answer, outcome] of cases) {
      const { fetch } = service(answer);
      const sender = createWebPushSender({ secretKey: A3.d, subject: SUBJECT, fetch });
      expect(await sender.send(FCM, NOW), String(answer)).toBe(outcome);
    }
  });

  test("calls nothing for an endpoint it wouldn't store, or at no time", async () => {
    const { sent, fetch } = service(201);
    const sender = createWebPushSender({ secretKey: A3.d, subject: SUBJECT, fetch });
    expect(await sender.send("https://169.254.169.254/latest", NOW)).toBe("unavailable");
    expect(await sender.send("http://fcm.googleapis.com/fcm/send/x", NOW)).toBe("unavailable");
    expect(await sender.send(FCM, new Date(Number.NaN))).toBe("unavailable");
    expect(sent).toHaveLength(0);
  });

  test("gives up on a service that doesn't answer within its timeout", async () => {
    const fetch = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    const sender = createWebPushSender({ secretKey: A3.d, subject: SUBJECT, timeoutMs: 20, fetch });
    expect(await sender.send(FCM, NOW)).toBe("unavailable");
  });

  test(`refuses a timeout past ${MAX_PUSH_TIMEOUT_MS} ms, which the notices' leases aren't sized for`, () => {
    for (const timeoutMs of [0, -1, 1.5, MAX_PUSH_TIMEOUT_MS + 1, Number.NaN])
      expect(
        () => createWebPushSender({ secretKey: A3.d, subject: SUBJECT, timeoutMs }),
        String(timeoutMs),
      ).toThrow("timeoutMs");
    expect(() =>
      createWebPushSender({ secretKey: A3.d, subject: SUBJECT, timeoutMs: MAX_PUSH_TIMEOUT_MS }),
    ).not.toThrow();
  });

  test("refuses a bad key or subject when made", () => {
    expect(() => createWebPushSender({ secretKey: "nope", subject: SUBJECT })).toThrow(
      "not a P-256 secret key",
    );
    for (const subject of [
      "",
      "ops@abolish.test",
      "mailto:",
      "mailto:not an address",
      "mailto:a@b.test,c@d.test",
      "http://abolish.test/",
      "https://abolish.test",
      "javascript:alert(1)",
    ])
      expect(() => createWebPushSender({ secretKey: A3.d, subject }), subject).toThrow("subject");
    expect(() =>
      createWebPushSender({ secretKey: A3.d, subject: "https://abolish.test/" }),
    ).not.toThrow();
  });
});
