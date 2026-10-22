import { REMOVAL_REASONS } from "@abolishus/core";
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { REMOVAL_GROUNDS } from "../src/components/moderation-log.tsx";
import { reportProfile } from "../src/profile-report.ts";

// The profile page's report (src/profile-report.ts), with fetch stubbed: what
// it sends to the profiles handler (src/node/profiles.ts) and how each answer
// reaches the page.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const HANDLE = "k7qa2mzr5xw3bn4d";

function serve(answer: () => Promise<Response>) {
  const calls: { url: unknown; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: unknown, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  });
  return { calls, report: reportProfile };
}

afterEach(() => vi.unstubAllGlobals());

describe("profile report", () => {
  test("offers exactly the removal grounds core counts a report under", () => {
    expect([...REMOVAL_GROUNDS].sort()).toEqual([...REMOVAL_REASONS].sort());
  });

  test("posts the handle and the ground alone, as JSON to our own origin, with no credentials (T-10)", async () => {
    const { calls, report } = serve(async () => Response.json({}));
    expect(await report(HANDLE, "impersonation")).toBe("reported");
    expect(calls).toEqual([
      {
        url: "/profiles/report",
        init: {
          method: "POST",
          credentials: "omit",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ handle: HANDLE, reason: "impersonation" }),
        },
      },
    ]);
  });

  test("a handle no profile has now is gone", async () => {
    const { report } = serve(async () =>
      Response.json({ code: "UNKNOWN_PROFILE", status: 404 }, { status: 404 }),
    );
    expect(await report(HANDLE, "spam")).toBe("gone");
  });

  test("anything else failed, and never throws", async () => {
    const answers: (() => Promise<Response>)[] = [
      async () => Response.json({ code: "NOT_FOUND", status: 404 }, { status: 404 }),
      async () => new Response("not json", { status: 404 }),
      async () => Response.json({ code: "BAD_REQUEST", status: 400 }, { status: 400 }),
      async () => new Response(null, { status: 500 }),
      async () => new Response(null, { status: 503 }),
      async () => {
        throw new TypeError("offline");
      },
    ];
    for (const answer of answers) expect(await serve(answer).report(HANDLE, "spam")).toBe("failed");
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 300, max: 599 }), fc.json(), async (status, body) => {
        const outcome = await serve(async () => new Response(body, { status })).report(
          HANDLE,
          "threat",
        );
        const gone =
          status === 404 &&
          (JSON.parse(body) as { code?: unknown } | null)?.code === "UNKNOWN_PROFILE";
        expect(outcome).toBe(gone ? "gone" : "failed");
      }),
      runs,
    );
  });
});
