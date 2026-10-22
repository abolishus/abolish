import { REACTIONS as CORE_REACTIONS } from "@abolishus/core";
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { REACTIONS, ReactionsError, reactionsClient } from "../src/account/reactions.ts";
import { ERRORS } from "../src/node/reactions.ts";

// The poll page's calls (src/account/reactions.ts), with the browser's fetch
// stubbed: what it sends to the reactions handler (src/node/reactions.ts),
// what it accepts from it, and how each refusal reaches the page.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const ID = "ab".repeat(32);
const ZERO = { heart: 0, laugh: 0, wow: 0, thinking: 0, sad: 0, clap: 0 };

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

async function refused(run: Promise<unknown>): Promise<ReactionsError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ReactionsError);
  return error as ReactionsError;
}

const refusal = (status: number, code: string) => Response.json({ code, status }, { status });

afterEach(() => vi.unstubAllGlobals());

describe("reactions client", () => {
  test("spells core's set, in core's order", () => {
    expect(REACTIONS).toEqual(CORE_REACTIONS);
  });

  test("posts the poll, and the change, as JSON to our own origin", async () => {
    const calls = serve(
      Response.json({ counts: ZERO }),
      Response.json({ counts: ZERO, own: [] }),
      Response.json({ counts: { ...ZERO, sad: 1 }, own: ["sad"] }),
    );
    expect(await reactionsClient.counts(ID)).toEqual(ZERO);
    expect(await reactionsClient.own(ID)).toEqual({ counts: ZERO, own: [] });
    expect(await reactionsClient.set(ID, "sad", true)).toEqual({
      counts: { ...ZERO, sad: 1 },
      own: ["sad"],
    });
    expect(calls.map((c) => c.url)).toEqual([
      "/reactions/counts",
      "/reactions/own",
      "/reactions/set",
    ]);
    for (const { init } of calls) {
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("same-origin");
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual({ "content-type": "application/json" });
    }
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ electionId: ID });
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ electionId: ID });
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({
      electionId: ID,
      reaction: "sad",
      on: true,
    });
  });

  test("gives its own in the set's order", async () => {
    serve(Response.json({ counts: ZERO, own: ["clap", "heart"] }));
    expect((await reactionsClient.own(ID)).own).toEqual(["heart", "clap"]);
  });

  test("refuses an answer it can't show truthfully", async () => {
    const counts = [
      { ...ZERO, heart: -1 },
      { ...ZERO, heart: 1.5 },
      { ...ZERO, heart: "1" },
      { heart: 0 },
      { ...ZERO, thumbs: 0 },
      [],
      null,
    ];
    for (const answer of [
      {},
      ...counts.map((c) => ({ counts: c })),
      { counts: ZERO, own: [] },
      [],
      null,
    ]) {
      serve(Response.json(answer));
      expect((await refused(reactionsClient.counts(ID))).failure).toBe("failed");
    }
    for (const answer of [
      { counts: ZERO },
      ...counts.map((c) => ({ counts: c, own: [] })),
      { counts: ZERO, own: ["thumbs"] },
      { counts: ZERO, own: ["heart", "heart"] },
      { counts: ZERO, own: "heart" },
      { counts: ZERO, own: [], extra: 1 },
      { own: [], extra: 1 },
    ]) {
      serve(Response.json(answer));
      expect((await refused(reactionsClient.own(ID))).failure).toBe("failed");
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
      expect((await refused(reactionsClient.set(ID, "heart", true))).failure).toBe(
        expected[code] ?? "failed",
      );
    }
    serve(refusal(401, "SIGNED_OUT"));
    expect((await refused(reactionsClient.set(ID, "heart", true))).failure).toBe("signedOut");
    serve(new Response("500\n", { status: 500 }));
    expect((await refused(reactionsClient.counts(ID))).failure).toBe("failed");
    serve();
    expect((await refused(reactionsClient.counts(ID))).failure).toBe("failed");
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
          expect((await refused(reactionsClient.counts(ID))).failure).toBe("failed");
        },
      ),
      runs,
    );
  });
});
