import { describe, expect, test } from "vite-plus/test";
import { createTwilioVerifier, TWILIO_LOOKUP, TWILIO_VERIFY } from "../src/index.ts";

// The Twilio adapter against a stand-in for Lookup and Verify: what is sent
// (a number, a channel, a code and nothing about the account), and that
// anything but Twilio's clear answer is `unavailable`, never a pass (ADR
// 0038; T-01, T-73).

const KEY = `SK${"0123456789abcdef".repeat(2)}`;
const SECRET = "s3cr3tS3CR3Ts3cr3tS3CR3Ts3cr3tAB";
const SERVICE = `VA${"fedcba9876543210".repeat(2)}`;
const NUMBER = "+14155552671";

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A status and a body (JSON unless a string), or a thrown error. */
type Answer = { readonly status: number; readonly body: unknown } | Error;

function twilio(answer: Answer) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: url instanceof Request ? url.url : url.toString(), init });
    if (answer instanceof Error) throw answer;
    return new Response(
      typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body),
      { status: answer.status },
    );
  }) as typeof globalThis.fetch;
  const verifier = createTwilioVerifier({
    keySid: KEY,
    keySecret: SECRET,
    verifyServiceSid: SERVICE,
    fetch,
  });
  return { sent, verifier };
}

const form = (init: RequestInit | undefined) =>
  Object.fromEntries(new URLSearchParams(init?.body as string));

const LINE = (type: unknown) => ({
  status: 200,
  body: {
    phone_number: NUMBER,
    country_code: "US",
    valid: true,
    line_type_intelligence: { type, carrier_name: "Carrier", error_code: null },
  },
});

describe("lookup", () => {
  test("asks Lookup for the number's line type, with the key's credentials", async () => {
    const { sent, verifier } = twilio(LINE("mobile"));
    expect(await verifier.lookup(NUMBER)).toEqual({
      number: NUMBER,
      country: "US",
      lineType: "mobile",
    });
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(`${TWILIO_LOOKUP}%2B14155552671?Fields=line_type_intelligence`);
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}`,
    });
  });

  test("gives back the number and country as Lookup writes them", async () => {
    const { verifier } = twilio({
      status: 200,
      body: { ...LINE("landline").body, phone_number: "+16135550123", country_code: "CA" },
    });
    expect(await verifier.lookup(NUMBER)).toEqual({
      number: "+16135550123",
      country: "CA",
      lineType: "landline",
    });
  });

  test.each([
    ["a null type, with Lookup's error code", null],
    ["a type that isn't text", 7],
  ])("reads %s as unknown, which core refuses", async (_, type) => {
    const { verifier } = twilio(LINE(type));
    expect(await verifier.lookup(NUMBER)).toMatchObject({ lineType: "unknown" });
  });

  test("reads a missing line-type block as unknown", async () => {
    const { line_type_intelligence: _, ...body } = LINE("mobile").body;
    const { verifier } = twilio({ status: 200, body });
    expect(await verifier.lookup(NUMBER)).toMatchObject({ lineType: "unknown" });
  });

  test("answers invalid on a number Lookup calls invalid", async () => {
    const answer = { status: 200, body: { ...LINE(null).body, valid: false } };
    expect(await twilio(answer).verifier.lookup(NUMBER)).toBe("invalid");
  });

  test("asks nothing about a number that isn't E.164", async () => {
    const { sent, verifier } = twilio(LINE("mobile"));
    expect(await verifier.lookup("4155552671")).toBe("invalid");
    expect(await verifier.lookup("+1415555267/../x")).toBe("invalid");
    expect(sent).toHaveLength(0);
  });

  test.each<[string, Answer]>([
    ["an HTTP error", { status: 500, body: {} }],
    ["refused credentials", { status: 401, body: { code: 20003 } }],
    // Lookup answers 200 with `valid: false` for a bad number: a 404 is a setup fault.
    ["a 404", { status: 404, body: { code: 20404 } }],
    ["a rate limit", { status: 429, body: { code: 20429 } }],
    ["a body that isn't JSON", { status: 200, body: "OK" }],
    ["a body that isn't an object", { status: 200, body: [LINE("mobile").body] }],
    ["no validity", { status: 200, body: { ...LINE("mobile").body, valid: "yes" } }],
    ["no number", { status: 200, body: { ...LINE("mobile").body, phone_number: null } }],
    ["no country", { status: 200, body: { ...LINE("mobile").body, country_code: 1 } }],
    ["a network failure", new TypeError("fetch failed")],
  ])("answers unavailable on %s", async (_, answer) => {
    expect(await twilio(answer).verifier.lookup(NUMBER)).toBe("unavailable");
  });
});

describe("start", () => {
  test.each(["sms", "call"] as const)("asks Verify to send a code by %s", async (channel) => {
    const { sent, verifier } = twilio({ status: 201, body: { status: "pending", to: NUMBER } });
    expect(await verifier.start(NUMBER, channel)).toBe("sent");
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(`${TWILIO_VERIFY}${SERVICE}/Verifications`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({
      "content-type": "application/x-www-form-urlencoded",
    });
    // Exactly these fields: no custom code, friendly name, locale or other data.
    expect(form(init)).toEqual({ To: NUMBER, Channel: channel });
  });

  test.each<[string, Answer]>([
    ["an HTTP error", { status: 500, body: {} }],
    ["a send cap", { status: 429, body: { code: 60203 } }],
    ["a 200 rather than a 201", { status: 200, body: { status: "pending" } }],
    ["a status other than pending", { status: 201, body: { status: "canceled" } }],
    ["a body that isn't JSON", { status: 201, body: "OK" }],
    ["a network failure", new TypeError("fetch failed")],
  ])("answers unavailable on %s", async (_, answer) => {
    expect(await twilio(answer).verifier.start(NUMBER, "sms")).toBe("unavailable");
  });

  test("sends nothing to a number that isn't E.164", async () => {
    const { sent, verifier } = twilio({ status: 201, body: { status: "pending" } });
    expect(await verifier.start("+1 415 555 2671", "sms")).toBe("unavailable");
    expect(sent).toHaveLength(0);
  });
});

describe("check", () => {
  test("asks Verify whether the code is right, and approves only its clear yes", async () => {
    const { sent, verifier } = twilio({ status: 200, body: { status: "approved", valid: true } });
    expect(await verifier.check(NUMBER, "123456")).toBe("approved");
    const [{ url, init }] = sent as [Sent];
    expect(url).toBe(`${TWILIO_VERIFY}${SERVICE}/VerificationCheck`);
    expect(init?.method).toBe("POST");
    expect(form(init)).toEqual({ To: NUMBER, Code: "123456" });
  });

  test.each<[string, Answer]>([
    ["a wrong code", { status: 200, body: { status: "pending", valid: false } }],
    ["a code that expired", { status: 200, body: { status: "expired", valid: false } }],
    ["approved without valid", { status: 200, body: { status: "approved", valid: "true" } }],
    ["no verification waiting", { status: 404, body: { code: 20404 } }],
    // T-01: Verify's own cap on checks bounds the guesses at one number.
    ["Verify's cap on checks", { status: 429, body: { code: 60202 } }],
  ])("answers wrong on %s", async (_, answer) => {
    expect(await twilio(answer).verifier.check(NUMBER, "123456")).toBe("wrong");
  });

  test.each<[string, Answer]>([
    ["an HTTP error", { status: 503, body: {} }],
    ["a rate limit that isn't the cap on checks", { status: 429, body: { code: 20429 } }],
    ["a 404 that isn't Twilio's not-found", { status: 404, body: "Not Found" }],
    ["refused credentials", { status: 401, body: { code: 20003 } }],
    ["a 200 without a status", { status: 200, body: { valid: true } }],
    ["a body that isn't JSON", { status: 200, body: "approved" }],
    ["a network failure", new TypeError("fetch failed")],
  ])("answers unavailable on %s, never approved", async (_, answer) => {
    expect(await twilio(answer).verifier.check(NUMBER, "123456")).toBe("unavailable");
  });

  test("asks nothing about a code that isn't 6 to 10 digits, so none shorter is ever approved", async () => {
    const { sent, verifier } = twilio({ status: 200, body: { status: "approved", valid: true } });
    for (const code of ["1234", "12345", "12345678901", "123 456", "abcdef"])
      expect(await verifier.check(NUMBER, code)).toBe("wrong");
    expect(sent).toHaveLength(0);
  });

  test("gives up on a check after its own short timeout", async () => {
    const verifier = hanging({ timeoutMs: 60_000, checkTimeoutMs: 20 });
    expect(await verifier.check(NUMBER, "123456")).toBe("unavailable");
  });
});

/** A verifier over a Twilio that never answers, until the request's signal aborts it. */
function hanging(timeouts: { readonly timeoutMs: number; readonly checkTimeoutMs: number }) {
  const fetch = (async (_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) =>
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
    )) as typeof globalThis.fetch;
  return createTwilioVerifier({
    keySid: KEY,
    keySecret: SECRET,
    verifyServiceSid: SERVICE,
    ...timeouts,
    fetch,
  });
}

test("gives up on a lookup or a send after its timeout", async () => {
  const verifier = hanging({ timeoutMs: 20, checkTimeoutMs: 60_000 });
  expect(await verifier.lookup(NUMBER)).toBe("unavailable");
  expect(await verifier.start(NUMBER, "sms")).toBe("unavailable");
});

describe("createTwilioVerifier", () => {
  test.each([
    [{ keySid: "SK123" }, "keySid"],
    [{ keySid: `PN${"0".repeat(32)}` }, "keySid"],
    [{ keySecret: "" }, "keySecret"],
    [{ keySecret: `${SECRET.slice(1)}/` }, "keySecret"],
    [{ verifyServiceSid: `SK${"0".repeat(32)}` }, "verifyServiceSid"],
  ])("refuses %j, naming the option and never the value", (change, field) => {
    const options = { keySid: KEY, keySecret: SECRET, verifyServiceSid: SERVICE, ...change };
    expect(() => createTwilioVerifier(options)).toThrow(field);
    for (const value of Object.values(change))
      if (value.length > 0) expect(() => createTwilioVerifier(options)).not.toThrow(value);
  });

  test("takes the account's own SID and auth token", () => {
    expect(() =>
      createTwilioVerifier({
        keySid: `AC${"0".repeat(32)}`,
        keySecret: "0123456789abcdef0123456789abcdef",
        verifyServiceSid: SERVICE,
      }),
    ).not.toThrow();
  });
});
