import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  createTurnstile,
  MAX_TURNSTILE_TOKEN,
  type TurnstileAction,
  TURNSTILE_SITEVERIFY,
} from "../src/index.ts";

// Server-side Turnstile verification against a stand-in for Cloudflare's
// siteverify: what is sent, and that anything but a clear pass for this site
// and action fails closed.

const SECRET_KEY = "0x4AAAAAAAtestsecret";
const HOST = "abolish.test";
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A siteverify that answers `answer` (a JSON body, a status and body, or a thrown error). */
function siteverify(answer: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: url instanceof Request ? url.url : url.toString(), init });
    if (answer instanceof Error) throw answer;
    if (typeof answer === "object" && answer !== null && "status" in answer && "body" in answer)
      return new Response(String(answer.body), { status: Number(answer.status) });
    return Response.json(answer);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const pass = (action: TurnstileAction, hostname = HOST) => ({
  success: true,
  challenge_ts: "2026-10-12T08:00:00.000Z",
  hostname,
  action,
  "error-codes": [],
});

describe("createTurnstile", () => {
  test("posts only the secret and the token to siteverify, never an address", async () => {
    const { sent, fetch } = siteverify(pass("passkey-register"));
    const turnstile = createTurnstile({ secretKey: SECRET_KEY, hostname: HOST, fetch });
    expect(await turnstile.verify("tok.en-1_", "passkey-register")).toBe("passed");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(TURNSTILE_SITEVERIFY);
    expect(sent[0]!.init?.method).toBe("POST");
    const body = sent[0]!.init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect([...(body as URLSearchParams)]).toEqual([
      ["secret", SECRET_KEY],
      ["response", "tok.en-1_"],
    ]);
  });

  test("a pass for another site or another action is refused", async () => {
    for (const answer of [
      pass("passkey-register", "evil.test"),
      pass("passkey-authenticate"),
      { ...pass("passkey-register"), action: undefined },
      { ...pass("passkey-register"), hostname: undefined },
      { ...pass("passkey-register"), success: "true" },
    ]) {
      const turnstile = createTurnstile({
        secretKey: SECRET_KEY,
        hostname: HOST,
        fetch: siteverify(answer).fetch,
      });
      expect(await turnstile.verify("token", "passkey-register")).toBe("refused");
    }
  });

  test("Cloudflare's refusals of the token are refusals", async () => {
    for (const codes of [
      ["invalid-input-response"],
      ["timeout-or-duplicate"],
      ["missing-input-response"],
      ["bad-request"],
      [],
    ]) {
      const turnstile = createTurnstile({
        secretKey: SECRET_KEY,
        hostname: HOST,
        fetch: siteverify({ success: false, "error-codes": codes }).fetch,
      });
      expect(await turnstile.verify("token", "passkey-authenticate")).toBe("refused");
    }
  });

  test("Cloudflare's own failures and a wrong secret key are unavailable, never a pass", async () => {
    for (const answer of [
      { success: false, "error-codes": ["internal-error"] },
      { success: false, "error-codes": ["invalid-input-secret"] },
      { success: false, "error-codes": ["missing-input-secret"] },
      { status: 500, body: "{}" },
      { status: 429, body: JSON.stringify(pass("passkey-register")) },
      { status: 200, body: "not json" },
      { status: 200, body: "null" },
      new TypeError("fetch failed"),
    ]) {
      const turnstile = createTurnstile({
        secretKey: SECRET_KEY,
        hostname: HOST,
        fetch: siteverify(answer).fetch,
      });
      expect(await turnstile.verify("token", "passkey-register")).toBe("unavailable");
    }
  });

  test("a siteverify that doesn't answer in time is unavailable", async () => {
    const fetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    const turnstile = createTurnstile({
      secretKey: SECRET_KEY,
      hostname: HOST,
      fetch,
      timeoutMs: 20,
    });
    expect(await turnstile.verify("token", "passkey-register")).toBe("unavailable");
  });

  test("a missing, empty, oversize or non-printable token is refused without asking Cloudflare", async () => {
    const { sent, fetch } = siteverify(pass("passkey-register"));
    const turnstile = createTurnstile({ secretKey: SECRET_KEY, hostname: HOST, fetch });
    for (const token of [null, "", "a".repeat(MAX_TURNSTILE_TOKEN + 1), "a b", "a\nb", "é"])
      expect(await turnstile.verify(token, "passkey-register")).toBe("refused");
    expect(sent).toEqual([]);
    expect(await turnstile.verify("a".repeat(MAX_TURNSTILE_TOKEN), "passkey-register")).toBe(
      "passed",
    );
  });

  test("whatever siteverify answers, only success with this host and action passes", async () => {
    const actions = ["passkey-register", "passkey-authenticate"] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.record(
          {
            success: fc.oneof(fc.boolean(), fc.constant("true"), fc.constant(1)),
            hostname: fc.oneof(fc.constant(HOST), fc.domain()),
            action: fc.oneof(fc.constantFrom(...actions), fc.string()),
            "error-codes": fc.array(fc.string()),
          },
          { requiredKeys: [] },
        ),
        fc.constantFrom(...actions),
        async (answer, action) => {
          const turnstile = createTurnstile({
            secretKey: SECRET_KEY,
            hostname: HOST,
            fetch: siteverify(answer).fetch,
          });
          const verdict = await turnstile.verify("token", action);
          const clear =
            answer.success === true && answer.hostname === HOST && answer.action === action;
          expect(verdict === "passed").toBe(clear);
        },
      ),
      { numRuns },
    );
  });

  test("refuses an empty secret key and a host that isn't bare", () => {
    expect(() => createTurnstile({ secretKey: "", hostname: HOST })).toThrow(/secretKey/);
    for (const hostname of ["", "https://abolish.test", "abolish.test:443", "abolish.test/x"])
      expect(() => createTurnstile({ secretKey: SECRET_KEY, hostname })).toThrow(/hostname/);
  });
});
