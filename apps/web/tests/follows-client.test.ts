import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { FollowsError, followsClient } from "../src/account/follows.ts";
import { ERRORS } from "../src/node/follows.ts";

// The poll page's call (src/account/follows.ts), with the browser's fetch
// stubbed: what it sends to the follows handler (src/node/follows.ts), what
// it accepts from it, and how each refusal reaches the page.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const ID = "ab".repeat(32);

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

async function refused(run: Promise<unknown>): Promise<FollowsError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FollowsError);
  return error as FollowsError;
}

const refusal = (status: number, code: string) => Response.json({ code, status }, { status });

afterEach(() => vi.unstubAllGlobals());

describe("follows client", () => {
  test("posts the poll and the change as JSON to our own origin, with the session", async () => {
    const calls = serve(Response.json({ following: true }), Response.json({ following: false }));
    expect(await followsClient.set(ID, true)).toBe(true);
    expect(await followsClient.set(ID, false)).toBe(false);
    expect(calls.map((c) => c.url)).toEqual(["/follows/set", "/follows/set"]);
    for (const { init } of calls) {
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual({ "content-type": "application/json" });
    }
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ electionId: ID, on: true });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ electionId: ID, on: false });
  });

  test("refuses an answer that isn't exactly the state asked for", async () => {
    for (const answer of [
      { following: false },
      { following: "true" },
      { following: 1 },
      { following: true, extra: 1 },
      {},
      [],
      null,
    ]) {
      serve(Response.json(answer));
      expect((await refused(followsClient.set(ID, true))).failure).toBe("failed");
    }
  });

  test("words each of the handler's refusals the page explains, and fails on the rest", async () => {
    const expected: Record<string, string> = {
      ACCOUNT_UNVERIFIED: "unverified",
      HIDDEN: "hidden",
      TOO_MANY_THIS_HOUR: "tooManyThisHour",
    };
    for (const [status, code] of Object.values(ERRORS)) {
      serve(refusal(status, code));
      expect((await refused(followsClient.set(ID, true))).failure).toBe(expected[code] ?? "failed");
    }
    serve(refusal(401, "SIGNED_OUT"));
    expect((await refused(followsClient.set(ID, false))).failure).toBe("signedOut");
    serve(new Response("500\n", { status: 500 }));
    expect((await refused(followsClient.set(ID, true))).failure).toBe("failed");
    serve();
    expect((await refused(followsClient.set(ID, true))).failure).toBe("failed");
  });

  test("never takes an unknown code, or one from a prototype, as a known refusal", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string(), fc.constantFrom("toString", "__proto__", "constructor")),
        async (code) => {
          fc.pre(
            !["SIGNED_OUT", "ACCOUNT_UNVERIFIED", "HIDDEN", "TOO_MANY_THIS_HOUR"].includes(code),
          );
          serve(refusal(409, code));
          expect((await refused(followsClient.set(ID, true))).failure).toBe("failed");
        },
      ),
      runs,
    );
  });
});
