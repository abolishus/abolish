import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { VerifyError, verifyClient } from "../src/account/verify.ts";
import { catalogs } from "../src/messages.ts";
import { ERRORS as EMAIL_ERRORS } from "../src/node/email.ts";
import { ERRORS as PHONE_ERRORS } from "../src/node/phone.ts";

// The verification page's calls (src/account/verify.ts), with the browser's
// fetch stubbed: what it sends to the e-mail and phone handlers
// (src/node/email.ts, src/node/phone.ts), what it accepts from them, and how
// each refusal reaches the page.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

function serve(...answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = answers.shift();
    if (next === undefined) throw new TypeError("no answer");
    return next;
  });
  return calls;
}

async function refused(run: Promise<unknown>): Promise<VerifyError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(VerifyError);
  return error as VerifyError;
}

const refusal = (status: number, code: string, extra: object = {}) =>
  Response.json({ code, status, ...extra }, { status });

afterEach(() => vi.unstubAllGlobals());

describe("verify client", () => {
  test("reads the verified address and the day the phone was verified", async () => {
    serve(
      Response.json({ address: "sam@example.org", verifiedAt: "2026-10-01T12:00:00.000Z" }),
      Response.json({}),
      Response.json({ verifiedOn: "2026-10-02" }),
      Response.json({}),
    );
    expect(await verifyClient.email()).toEqual({
      address: "sam@example.org",
      verifiedAt: "2026-10-01T12:00:00.000Z",
    });
    expect(await verifyClient.email()).toBeUndefined();
    expect(await verifyClient.phone()).toEqual({ verifiedOn: "2026-10-02" });
    expect(await verifyClient.phone()).toBeUndefined();
  });

  test("refuses an answer it can't show truthfully", async () => {
    const emails = [
      { address: "" },
      { address: 1, verifiedAt: "2026-10-01T12:00:00.000Z" },
      { address: "sam@example.org" },
      { address: "sam@example.org", verifiedAt: "yesterday" },
      { address: `${"a".repeat(250)}@x.org`, verifiedAt: "2026-10-01T12:00:00.000Z" },
      [],
      null,
      "sam@example.org",
    ];
    for (const e of emails) {
      serve(Response.json(e));
      expect((await refused(verifyClient.email())).failure).toBe("failed");
    }
    // A phone's answer never carries a number, and its day is only a day.
    for (const p of [
      { verifiedOn: "2026-10-02T00:00:00.000Z" },
      { verifiedOn: 20261002 },
      { x: 1 },
    ]) {
      serve(Response.json(p));
      expect((await refused(verifyClient.phone())).failure).toBe("failed");
    }
  });

  test("sends the token in the Turnstile header and the address or number in the body", async () => {
    const calls = serve(
      Response.json({}, { status: 202 }),
      Response.json({}),
      Response.json({}, { status: 202 }),
      Response.json({}),
    );
    await verifyClient.requestEmailCode("sam@example.org", "tok-e");
    await verifyClient.verifyEmailCode("1234 5678");
    await verifyClient.requestPhoneCode("(415) 555-0100", "tok-p");
    await verifyClient.verifyPhoneCode("(415) 555-0100", "123456");
    expect(calls.map((c) => [c.url, c.init.method, c.init.body])).toEqual([
      ["/email/request", "POST", JSON.stringify({ address: "sam@example.org" })],
      ["/email/verify", "POST", JSON.stringify({ code: "1234 5678" })],
      ["/phone/request", "POST", JSON.stringify({ number: "(415) 555-0100" })],
      ["/phone/verify", "POST", JSON.stringify({ number: "(415) 555-0100", code: "123456" })],
    ]);
    expect(calls[0]?.init.headers).toEqual({
      "x-turnstile-token": "tok-e",
      "content-type": "application/json",
    });
    expect(calls[1]?.init.headers).toEqual({ "content-type": "application/json" });
    expect(calls[2]?.init.headers).toEqual({
      "x-turnstile-token": "tok-p",
      "content-type": "application/json",
    });
    for (const c of calls) {
      expect(c.init.credentials).toBe("same-origin");
      expect(c.init.cache).toBe("no-store");
      expect(c.init.redirect).toBe("error");
    }
  });

  test("words every refusal the handlers send, each in its own message", async () => {
    const codes = [
      ...new Set([
        ...Object.values(EMAIL_ERRORS).map(([, code]) => code),
        ...Object.values(PHONE_ERRORS).map(([, code]) => code),
        "SIGNED_OUT",
        "EMAIL_UNAVAILABLE",
        "PHONE_UNAVAILABLE",
      ]),
    ];
    const seen = new Set<string>();
    for (const code of codes) {
      serve(refusal(409, code));
      const { failure } = await refused(verifyClient.verifyEmailCode("1"));
      expect(failure, code).not.toBe("failed");
      seen.add(failure);
      expect(typeof catalogs["en-US"]![`verifyFailure_${failure}`]).toBe("string");
    }
    // The two services' "unavailable" are one failure to the page; every other code is its own.
    expect(seen.size).toBe(codes.length - 1);
  });

  test("keeps a wrong code's tries left, and nothing else's", async () => {
    serve(
      refusal(422, "WRONG_CODE", { triesLeft: 3 }),
      refusal(422, "WRONG_CODE"),
      refusal(422, "WRONG_CODE", { triesLeft: -1 }),
      refusal(422, "WRONG_CODE", { triesLeft: 1.5 }),
      refusal(422, "WRONG_CODE", { triesLeft: "3" }),
      refusal(409, "TOO_MANY_TRIES", { triesLeft: 0 }),
    );
    const left = async () => (await refused(verifyClient.verifyPhoneCode("1", "1"))).triesLeft;
    expect(await left()).toBe(3);
    for (let i = 0; i < 5; i++) expect(await left()).toBeUndefined();
  });

  test("fails closed on what it doesn't know", async () => {
    serve(
      refusal(403, "FORBIDDEN_ORIGIN"),
      refusal(404, "toString"),
      refusal(409, "__proto__"),
      new Response("not json", { status: 500 }),
      new Response("not json"),
    );
    for (let i = 0; i < 5; i++)
      expect((await refused(verifyClient.requestEmailCode("a@b.c", "t"))).failure).toBe("failed");
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect((await refused(verifyClient.phone())).failure).toBe("failed");
  });

  test("never throws anything but its own error, whatever the handler answers", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.jsonValue(),
        fc.constantFrom(200, 202, 400, 409, 422, 503),
        async (j, s) => {
          serve(
            new Response(JSON.stringify(j), { status: s }),
            new Response(JSON.stringify(j), { status: s }),
          );
          for (const run of [verifyClient.email(), verifyClient.phone()]) {
            const e = await run.then(
              () => undefined,
              (e: unknown) => e,
            );
            if (e !== undefined) expect(e).toBeInstanceOf(VerifyError);
          }
        },
      ),
      runs,
    );
  });
});
