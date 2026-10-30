import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { createApi } from "../src/server/api.ts";
import { loadFollowedPolls } from "../src/server/load.ts";
import {
  HIDDEN_ID,
  LOST_ID,
  seen,
  STREAM_BAD_TEXT,
  STREAM_NO_TEXT,
  STREAM_V1,
  STREAM_V5,
  stub,
  stubApi,
  SWAPPED_ID,
} from "./stub-api.ts";

// The account page's list of polls with results ([[P2-25]] part 4c-2b): the
// words its server function reads for each poll, against the stub API
// (tests/stub-api.ts), checked as a stream card's (T-34, T-41).

let server: Server;
let base: string;
beforeAll(async () => {
  server = stubApi();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("loadFollowedPolls", () => {
  test("reads each poll's heading in the page's language, in the order asked", async () => {
    const api = createApi(base);
    expect(await loadFollowedPolls(api, [STREAM_V5, STREAM_V1], "en")).toEqual([
      // A title of its own, else its first question.
      { electionId: STREAM_V5, heading: "Park and library" },
      { electionId: STREAM_V1, heading: "Should the park stay open late?" },
    ]);
    expect(await loadFollowedPolls(api, [STREAM_V1, STREAM_V5], "es-us")).toEqual([
      { electionId: STREAM_V1, heading: "¿Debe el parque abrir hasta tarde?" },
      { electionId: STREAM_V5, heading: "Parque y biblioteca" },
    ]);
  });

  test("shows no words for a poll whose words can't be checked, are withheld or are gone", async () => {
    const api = createApi(base);
    const ids = [STREAM_BAD_TEXT, STREAM_NO_TEXT, SWAPPED_ID, HIDDEN_ID, LOST_ID];
    expect(await loadFollowedPolls(api, ids, "en")).toEqual(
      ids.map((electionId) => ({ electionId, heading: undefined })),
    );
  });

  test("asks the API by each poll's ID alone, with nothing of the visitor's", async () => {
    const from = seen.length;
    await loadFollowedPolls(createApi(base), [STREAM_V1], "en");
    // The earlier test's reads of a lost poll's text may land late: only this poll's are this test's.
    const asked = seen.slice(from).filter((r) => r.query.get("electionId") === STREAM_V1);
    expect(asked.map((r) => r.path).sort()).toEqual([
      "/elections/definition",
      "/elections/display-text",
    ]);
    for (const r of asked) {
      expect([...r.query.keys()]).toEqual(["electionId"]);
      expect(r.headers["cookie"]).toBeUndefined();
    }
  });

  test("fails when the API does", async () => {
    stub.down = true;
    try {
      await expect(loadFollowedPolls(createApi(base), [STREAM_V1], "en")).rejects.toThrow();
    } finally {
      stub.down = false;
    }
  });
});
