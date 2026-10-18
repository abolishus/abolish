import { BN254_R } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import {
  challengeFrameSrc,
  challengeToken,
  RETRY_AFTER,
  retryDue,
  sendTier0Request,
  type Tier0Answer,
  tier0RequestBody,
} from "../src/registration.ts";

// Tier 0 registration's client side (docs/spec/registration.md, Challenge
// page, Request, Answers and Outcome): what the client accepts from the
// challenge frame, the body it sends, and how it reads the route's answers.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CHALLENGE = "https://challenge-staging.up.railway.app";
const CLIENT = "https://ballot-staging.up.railway.app";
const frame = { name: "the client's challenge frame" };

const tokenChars = fc.integer({ min: 0x21, max: 0x7e }).map((c) => String.fromCharCode(c));
const token = fc.string({ unit: tokenChars, minLength: 1, maxLength: 2048 });
const commitment = fc.bigInt({ min: 2n, max: BN254_R - 1n });
const region = fc.nat({ max: 0xffff_ffff });

describe("challengeFrameSrc", () => {
  test("puts the client's origin and the action in the fragment, each value encoded", () => {
    const src = challengeFrameSrc(CHALLENGE, CLIENT);
    expect(src).toBe(
      `${CHALLENGE}/#origin=https%3A%2F%2Fballot-staging.up.railway.app&action=tier0-register`,
    );
    const url = new URL(src);
    expect(url.origin).toBe(CHALLENGE);
    expect(url.pathname).toBe("/");
    expect(url.search).toBe("");
    expect([...new URLSearchParams(url.hash.slice(1))]).toEqual([
      ["origin", CLIENT],
      ["action", "tier0-register"],
    ]);
    expect(challengeFrameSrc(CHALLENGE, "https://localhost:4173")).toContain(
      "origin=https%3A%2F%2Flocalhost%3A4173&",
    );
  });

  test.each([
    "http://challenge.example",
    "https://challenge.example/",
    "https://challenge.example/path",
    "https://challenge.example#x",
    "https://Challenge.example",
    "challenge.example",
    "",
  ])("refuses %j as either origin", (bad) => {
    expect(() => challengeFrameSrc(bad, CLIENT)).toThrow(RangeError);
    expect(() => challengeFrameSrc(CHALLENGE, bad)).toThrow(RangeError);
  });
});

describe("challengeToken", () => {
  const message = (data: unknown, over: Partial<{ origin: string; source: unknown }> = {}) => ({
    origin: CHALLENGE,
    source: frame,
    data,
    ...over,
  });

  test("accepts exactly { v: 1, token } from the challenge origin and the client's own frame", () => {
    fc.assert(
      fc.property(token, (t) => {
        expect(challengeToken(message({ v: 1, token: t }), CHALLENGE, frame)).toBe(t);
        expect(challengeToken(message({ token: t, v: 1 }), CHALLENGE, frame)).toBe(t);
      }),
      { numRuns },
    );
  });

  test.each<[string, ReturnType<typeof message>]>([
    ["another origin", message({ v: 1, token: "t" }, { origin: CLIENT })],
    ["the origin with a path", message({ v: 1, token: "t" }, { origin: `${CHALLENGE}/` })],
    ["another frame of the challenge origin", message({ v: 1, token: "t" }, { source: {} })],
    ["no source", message({ v: 1, token: "t" }, { source: null })],
    ["a string", message("t")],
    ["null", message(null)],
    ["an array", message([1, "t"])],
    ["another version", message({ v: 2, token: "t" })],
    ["a version as a string", message({ v: "1", token: "t" })],
    ["an extra key", message({ v: 1, token: "t", commitment: "00" })],
    ["a missing token", message({ v: 1 })],
    ["an empty token", message({ v: 1, token: "" })],
    ["a token too long", message({ v: 1, token: "a".repeat(2049) })],
    ["a token with a space", message({ v: 1, token: "a b" })],
    ["a token with a newline", message({ v: 1, token: "a\n" })],
    ["a token past ASCII", message({ v: 1, token: "aé" })],
    ["a token that isn't a string", message({ v: 1, token: ["t"] })],
    ["an object of another prototype", message(Object.assign(new Map(), { v: 1, token: "t" }))],
    [
      "an object with no prototype",
      message(Object.assign(Object.create(null), { v: 1, token: "t" })),
    ],
  ])("ignores %s", (_, event) => {
    expect(challengeToken(event, CHALLENGE, frame)).toBeUndefined();
  });

  test("ignores everything while the client has no frame", () => {
    expect(challengeToken(message({ v: 1, token: "t" }, { source: null }), CHALLENGE, null)).toBe(
      undefined,
    );
  });

  test("ignores any token outside Turnstile's form", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 2100 }).filter((t) => !/^[\x21-\x7e]{1,2048}$/.test(t)),
        (t) => {
          expect(challengeToken(message({ v: 1, token: t }), CHALLENGE, frame)).toBeUndefined();
        },
      ),
      { numRuns },
    );
  });
});

describe("tier0RequestBody", () => {
  test("is exactly the route's three fields in their forms", () => {
    fc.assert(
      fc.property(commitment, region, token, (c, r, t) => {
        const body = JSON.parse(tier0RequestBody(c, r, t)) as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["commitment", "region", "turnstile"]);
        expect(body["commitment"]).toMatch(/^[0-9a-f]{64}$/);
        expect(BigInt(`0x${body["commitment"] as string}`)).toBe(c);
        expect(body["region"]).toMatch(/^(?:0|[1-9][0-9]*)$/);
        expect(Number(body["region"])).toBe(r);
        expect(body["turnstile"]).toBe(t);
      }),
      { numRuns },
    );
  });

  test("refuses a value the route would refuse before Turnstile", () => {
    for (const c of [0n, 1n, BN254_R, BN254_R + 1n, -1n])
      expect(() => tier0RequestBody(c, 0, "t"), `commitment ${c}`).toThrow(RangeError);
    for (const r of [-1, 2 ** 32, 0.5, -0, Number.NaN])
      expect(() => tier0RequestBody(5n, r, "t"), `region ${r}`).toThrow(RangeError);
    for (const t of ["", "a b", "a".repeat(2049)])
      expect(() => tier0RequestBody(5n, 0, t)).toThrow(RangeError);
  });
});

describe("sendTier0Request", () => {
  const body = tier0RequestBody(5n, 0, "tok.en-1_");
  const answering =
    (status: number, json: unknown, seen: { url: string; init: RequestInit }[] = []) =>
    (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return Promise.resolve(
        new Response(
          json === null ? null : typeof json === "string" ? json : JSON.stringify(json),
          { status },
        ),
      );
    };
  const send = (status: number, json: unknown) =>
    sendTier0Request({ api: "https://api.example" }, body, answering(status, json));

  test("posts the body to the route with no credential, referrer, cache or redirect", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    await sendTier0Request({ api: "https://api.example" }, body, answering(200, {}, seen));
    expect(seen).toEqual([
      {
        url: "https://api.example/registrations/tier0",
        init: {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "error",
          mode: "cors",
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
      },
    ]);
  });

  test.each<[number, unknown, Tier0Answer]>([
    [200, {}, "accepted"],
    [400, { code: "BAD_REQUEST" }, "malformed"],
    [422, { code: "REGISTRATION_MALFORMED", data: { code: "non-canonical" } }, "malformed"],
    [422, { code: "REGION_UNKNOWN" }, "region-unknown"],
    [503, { code: "REGISTRATION_BUSY" }, "busy"],
    [503, { code: "REGISTRATION_UNAVAILABLE" }, "unavailable"],
    [403, { code: "CHALLENGE_REFUSED" }, "challenge-refused"],
    [503, { code: "CHALLENGE_UNAVAILABLE" }, "challenge-unavailable"],
  ])("reads %i %j as %s", async (status, json, expected) => {
    expect(await send(status, json)).toBe(expected);
  });

  test.each<[number, unknown]>([
    [200, { queued: true }],
    [200, []],
    [200, "not json"],
    [200, ""],
    [201, {}],
    [204, null],
    [503, { code: "REGION_UNKNOWN" }],
    [422, { code: "REGISTRATION_BUSY" }],
    [403, { code: "CHALLENGE_UNAVAILABLE" }],
    [503, "<html>a proxy's page</html>"],
    [502, {}],
    [500, { code: "INTERNAL_SERVER_ERROR" }],
    [404, { code: "NOT_FOUND" }],
    [503, { code: "toString" }],
    [400, "not json"],
    [400, {}],
    [400, { code: "REGISTRATION_MALFORMED" }],
    [503, { code: "__proto__" }],
  ])("reads %i %j as unreachable", async (status, json) => {
    expect(await send(status, json)).toBe("unreachable");
  });

  test("reads an answer too long to be the route's as unreachable, unread", async () => {
    expect(await send(503, { code: "REGISTRATION_BUSY", pad: "x".repeat(5000) })).toBe(
      "unreachable",
    );
  });

  test("a failed network is unreachable", async () => {
    const failing = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await sendTier0Request({ api: "https://api.example" }, body, failing)).toBe(
      "unreachable",
    );
  });
});

describe("retryDue", () => {
  test("only once RETRY_AFTER seconds of finalized chain time have passed since the acceptance", () => {
    expect(RETRY_AFTER).toBe(4800);
    fc.assert(
      fc.property(
        fc.nat({ max: 2 ** 45 }),
        fc.bigInt({ min: 0n, max: 2n ** 40n }),
        (acceptedAt, finalized) => {
          expect(retryDue(acceptedAt, finalized)).toBe(
            Number(finalized) * 1000 >= acceptedAt + RETRY_AFTER * 1000,
          );
        },
      ),
      { numRuns },
    );
    expect(retryDue(1_760_000_000_000, 1_760_004_800n)).toBe(true);
    expect(retryDue(1_760_000_000_001, 1_760_004_800n)).toBe(false);
  });
});
