import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { REMOVAL_GROUNDS } from "../src/components/moderation-log.tsx";
import { createApi } from "../src/server/api.ts";
import { reportPoll } from "../src/server/load.ts";

// A poll page's report on the server's side (src/server/load.ts's
// `reportPoll`, which `sendPollReport` in src/data.ts runs), through the
// contract's own client against a stubbed API: what reaches the API and how
// each answer comes back.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const ID = "ab".repeat(32);

function stub(answer: () => Response) {
  const seen: { method: string; url: string; headers: Headers; body: string }[] = [];
  const api = createApi("http://api.test", async (input, init) => {
    const request = new Request(input, init);
    seen.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: await request.text(),
    });
    return answer();
  });
  return { api, seen };
}

describe("poll report", () => {
  test("posts the poll and the ground alone to the API's report route (T-10, T-11)", async () => {
    const { api, seen } = stub(() => Response.json({}, { status: 202 }));
    expect(await reportPoll(api, ID, "personal-data")).toBe("reported");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe("POST");
    expect(seen[0]!.url).toBe("http://api.test/moderation/reports");
    expect(JSON.parse(seen[0]!.body)).toEqual({ electionId: ID, reason: "personal-data" });
    expect(seen[0]!.headers.get("cookie")).toBeNull();
    expect(seen[0]!.headers.get("authorization")).toBeNull();
  });

  test("a poll the API keeps no definition for is gone", async () => {
    const { api } = stub(() =>
      Response.json(
        {
          defined: true,
          code: "ELECTION_NOT_FOUND",
          status: 404,
          message: "No election definition is stored for this ID.",
        },
        { status: 404 },
      ),
    );
    expect(await reportPoll(api, ID, "spam")).toBe("gone");
  });

  test("any other answer is an error for the server function to make opaque", async () => {
    const answers = [
      () => Response.json({ defined: false, code: "BAD_REQUEST", status: 400 }, { status: 400 }),
      () => new Response(null, { status: 500 }),
      () => new Response("not json", { status: 202 }),
      () => Response.json({ extra: true }, { status: 202 }),
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...answers),
        fc.constantFrom(...REMOVAL_GROUNDS),
        async (answer, reason) => {
          const { api } = stub(answer);
          await expect(reportPoll(api, ID, reason)).rejects.toThrow();
        },
      ),
      runs,
    );
  });
});
