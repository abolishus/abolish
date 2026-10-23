import { ACCOUNT_EXPORT_VERSION as CORE_VERSION } from "@abolishus/core";
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { ACCOUNT_EXPORT_VERSION, ExportError, fetchAccountExport } from "../src/account/export.ts";
import { EXPORT_ROUTES } from "../src/node/export.ts";

// The account page's call (src/account/export.ts), with the browser's fetch
// stubbed: what it sends to the export handler (src/node/export.ts), what it
// accepts from it, and how each refusal reaches the page.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const ACCOUNT = "a".repeat(32);
const EXPORT = {
  version: 1,
  exportedAt: "2026-10-23T09:15:00.000Z",
  account: { id: ACCOUNT, createdAt: "2026-10-01T09:00:00.000Z" },
  email: { address: "ana@example.org", verifiedOn: "2026-10-02T00:00:00.000Z" },
  polls: [],
};

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

async function refused(run: Promise<unknown>): Promise<ExportError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExportError);
  return error as ExportError;
}

afterEach(() => vi.unstubAllGlobals());

describe("export client", () => {
  test("knows core's version of the export", () => {
    expect(ACCOUNT_EXPORT_VERSION).toBe(CORE_VERSION);
  });

  test("posts an empty JSON body to the handler's one route, with the session", async () => {
    const calls = serve(Response.json(EXPORT));
    await fetchAccountExport();
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[number]];
    expect(`POST ${url}`).toBe(EXPORT_ROUTES[0]);
    expect(init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  });

  test("names the file by the export's UTC day and keeps every field as served", async () => {
    serve(Response.json(EXPORT));
    const file = await fetchAccountExport();
    expect(file.name).toBe("abolish-account-2026-10-23.json");
    expect(JSON.parse(file.text)).toEqual(EXPORT);
    expect(file.text.endsWith("}\n")).toBe(true);
  });

  test("a signed-out session is signedOut; every other refusal is failed", async () => {
    serve(Response.json({ code: "SIGNED_OUT", status: 401 }, { status: 401 }));
    expect((await refused(fetchAccountExport())).failure).toBe("signedOut");
    for (const answer of [
      Response.json({ code: "FORBIDDEN_ORIGIN", status: 403 }, { status: 403 }),
      new Response("oops", { status: 500 }),
      new Response("not json", { status: 401 }),
    ]) {
      serve(answer);
      expect((await refused(fetchAccountExport())).failure).toBe("failed");
    }
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("offline");
    });
    expect((await refused(fetchAccountExport())).failure).toBe("failed");
  });

  test("refuses an answer that isn't this version's export of one account", async () => {
    for (const answer of [
      [],
      null,
      "text",
      { ...EXPORT, version: 2 },
      { ...EXPORT, version: "1" },
      { ...EXPORT, exportedAt: "2026-10-23" },
      { ...EXPORT, exportedAt: undefined },
      { ...EXPORT, account: { id: ACCOUNT.toUpperCase() } },
      { ...EXPORT, account: null },
    ]) {
      serve(Response.json(answer));
      expect((await refused(fetchAccountExport())).failure).toBe("failed");
    }
  });

  test("any refusal code but SIGNED_OUT is failed, whatever the status", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string().filter((c) => c !== "SIGNED_OUT"),
        fc.integer({ min: 400, max: 599 }),
        async (code, status) => {
          serve(Response.json({ code, status }, { status }));
          expect((await refused(fetchAccountExport())).failure).toBe("failed");
        },
      ),
      runs,
    );
  });
});
