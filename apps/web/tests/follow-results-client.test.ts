import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { FollowResultsError, followResultsClient } from "../src/account/follow-results.ts";

// The account page's list of polls with results (src/account/follow-results.ts),
// with the browser's fetch and the server function stubbed: what it sends to
// the follows handler (src/node/follows.ts), what it accepts from it and from
// the server function, and how each refusal reaches the page.

const fetchFollowedPolls = vi.hoisted(() => vi.fn());
vi.mock("../src/data.ts", () => ({ fetchFollowedPolls }));

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const A = "0a".repeat(32);
const B = "ab".repeat(32);

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

async function refused(run: Promise<unknown>): Promise<FollowResultsError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(FollowResultsError);
  return error as FollowResultsError;
}

const refusal = (status: number, code: string) => Response.json({ code, status }, { status });

afterEach(() => {
  vi.unstubAllGlobals();
  fetchFollowedPolls.mockReset();
});

describe("follow results client", () => {
  test("posts to our own origin with the session, and reads the list and a drop", async () => {
    const calls = serve(Response.json({ polls: [A, B] }), Response.json({ dropped: false }));
    expect(await followResultsClient.list()).toEqual([A, B]);
    await followResultsClient.drop(B);
    expect(calls.map((c) => c.url)).toEqual(["/follows/results", "/follows/results/drop"]);
    for (const { init } of calls) {
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual({ "content-type": "application/json" });
    }
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({});
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ electionId: B });
  });

  test("refuses a list that isn't exactly distinct election IDs in byte order", async () => {
    for (const answer of [
      { polls: [B, A] },
      { polls: [A, A] },
      { polls: [A.toUpperCase()] },
      { polls: [A.slice(2)] },
      { polls: A },
      { polls: [A], more: 1 },
      {},
      [A],
      null,
    ]) {
      serve(Response.json(answer));
      expect((await refused(followResultsClient.list())).failure).toBe("failed");
    }
  });

  test("refuses a drop's answer that isn't exactly whether it was there", async () => {
    for (const answer of [{ dropped: "true" }, { dropped: true, polls: [] }, {}, null]) {
      serve(Response.json(answer));
      expect((await refused(followResultsClient.drop(A))).failure).toBe("failed");
    }
  });

  test("a signed-out refusal is signedOut, and any other refusal or failure is failed", async () => {
    serve(refusal(401, "SIGNED_OUT"));
    expect((await refused(followResultsClient.list())).failure).toBe("signedOut");
    serve(refusal(401, "SIGNED_OUT"));
    expect((await refused(followResultsClient.drop(A))).failure).toBe("signedOut");
    serve(new Response("<html>", { status: 502 }));
    expect((await refused(followResultsClient.list())).failure).toBe("failed");
    serve();
    expect((await refused(followResultsClient.drop(A))).failure).toBe("failed");
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((c) => c !== "SIGNED_OUT"),
        fc.integer({ min: 400, max: 599 }),
        async (code, status) => {
          serve(refusal(status, code));
          expect((await refused(followResultsClient.list())).failure).toBe("failed");
        },
      ),
      runs,
    );
  });

  test("asks the server function for the polls' headings in the page's language, in order", async () => {
    fetchFollowedPolls.mockResolvedValue([
      { electionId: A, heading: "Which day?" },
      { electionId: B, heading: undefined },
    ]);
    expect(await followResultsClient.headings([A, B], "es-us")).toEqual([
      { electionId: A, heading: "Which day?" },
      { electionId: B, heading: undefined },
    ]);
    expect(fetchFollowedPolls).toHaveBeenCalledWith({
      data: { electionIds: [A, B], locale: "es-us" },
    });
  });

  test("refuses headings that aren't the polls asked for, and a failed read", async () => {
    for (const answer of [
      [
        { electionId: B, heading: "x" },
        { electionId: A, heading: "y" },
      ],
      [{ electionId: A, heading: "x" }],
      [],
    ]) {
      fetchFollowedPolls.mockResolvedValueOnce(answer);
      expect((await refused(followResultsClient.headings([A, B], "en"))).failure).toBe("failed");
    }
    fetchFollowedPolls.mockRejectedValueOnce(new Error("unavailable"));
    expect((await refused(followResultsClient.headings([A], "en"))).failure).toBe("failed");
  });
});
