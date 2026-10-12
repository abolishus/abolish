import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { FRAME, framesOf, MAX_FRAMES, pageOf, PAGES, parseClientError } from "../src/analytics.ts";
import { createAnalytics, type PostHogEvent } from "../src/node/analytics.ts";
import { MAX_REPORTS, reportErrors, reportOf, type ReportingWindow } from "../src/error-reports.ts";
import { toHex } from "../src/values.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };
const electionId = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(toHex);
const frame = fc
  .tuple(
    fc.stringMatching(/^[A-Za-z0-9_-]{1,12}$/),
    fc.integer({ min: 0, max: 9_999_999 }),
    fc.integer({ min: 0, max: 9_999_999 }),
  )
  .map(([name, line, column]) => `assets/${name}.js:${line}:${column}`);

describe("pages", () => {
  test("a poll page is its template, whatever its ID", () => {
    fc.assert(
      fc.property(fc.oneof(electionId, fc.stringMatching(/^[^/?#]+$/)), (id) => {
        expect(pageOf(`/polls/${id}`)).toBe("/polls/:id");
      }),
      runs,
    );
  });

  test("every path is one of the fixed templates, so none carries a path's text", () => {
    fc.assert(
      fc.property(fc.webPath(), (path) => {
        expect(PAGES).toContain(pageOf(path));
      }),
      runs,
    );
    expect(["/", "/polls", "/moderation", "/account"].map(pageOf)).toEqual([
      "/",
      "/polls",
      "/moderation",
      "/account",
    ]);
    for (const path of ["/polls/", "/polls/a/b", "/account/x", "/moderation/", "/x"])
      expect(pageOf(path)).toBe("other");
  });
});

describe("stack frames", () => {
  test("keeps only positions in our bundles, from Chromium and Firefox stacks", () => {
    const id = "ab".repeat(32);
    const stack = [
      `TypeError: poll ${id} failed at https://abolish.test/polls/${id}:1:2`,
      "    at render (https://abolish.test/assets/main-Ab_1.js:1:2345)",
      "    at chrome-extension://abc/content.js:3:4",
      "next@https://abolish.test/assets/route.polls-x9.js:12:34",
      "    at https://abolish.test/assets/vendor.js:5:6789012345",
    ].join("\n");
    expect(framesOf(stack)).toEqual([
      "assets/main-Ab_1.js:1:2345",
      "assets/route.polls-x9.js:12:34",
    ]);
  });

  test("whatever the stack, every kept frame matches FRAME, and at most MAX_FRAMES are kept", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            frame.map((f) => `at x (https://abolish.test/${f})`),
            fc.string(),
          ),
        ),
        (lines) => {
          const frames = framesOf(lines.join("\n"));
          expect(frames.length).toBeLessThanOrEqual(MAX_FRAMES);
          for (const f of frames) expect(f).toMatch(FRAME);
        },
      ),
      runs,
    );
  });
});

describe("client reports", () => {
  const report = { page: "/", name: "TypeError", frames: ["assets/a.js:1:2"] };

  test("accept exactly the three fields, each from its fixed form", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PAGES),
        fc.stringMatching(/^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/),
        fc.array(frame, { maxLength: MAX_FRAMES }),
        (page, name, frames) => {
          expect(parseClientError({ page, name, frames })).toEqual({ page, name, frames });
        },
      ),
      runs,
    );
  });

  test.each([
    null,
    [],
    "x",
    {},
    { ...report, extra: 1 },
    { page: "/", name: "TypeError" },
    { ...report, page: "/polls/abc" },
    { ...report, name: "" },
    { ...report, name: "Error: message" },
    { ...report, name: "x".repeat(65) },
    { ...report, frames: "assets/a.js:1:2" },
    { ...report, frames: ["/assets/a.js:1:2"] },
    { ...report, frames: ["assets/a.js:1"] },
    { ...report, frames: ["assets/../a.js:1:2"] },
    { ...report, frames: [1] },
    { ...report, frames: Array(MAX_FRAMES + 1).fill("assets/a.js:1:2") },
  ])("refuse %j", (value) => {
    expect(parseClientError(value)).toBeUndefined();
  });
});

describe("error reporting in the browser", () => {
  class FakeWindow extends EventTarget implements ReportingWindow {
    location = { pathname: "/polls/" + "ab".repeat(32) };
  }
  const thrown = (name: string, stack: string) =>
    Object.assign(new Error("secret"), { name, stack });
  const ours = "Error: secret\n    at f (https://abolish.test/assets/main-1.js:1:2)";

  test("reports our own failures by name, template and frames, never message or path", () => {
    const err = thrown("RangeError", `RangeError: ${"ab".repeat(32)}\n${ours}`);
    expect(reportOf(err, "/polls/" + "ab".repeat(32))).toEqual({
      page: "/polls/:id",
      name: "RangeError",
      frames: ["assets/main-1.js:1:2"],
    });
  });

  test("ignores what isn't an Error or has no frame of ours", () => {
    expect(reportOf("thrown text", "/")).toBeUndefined();
    expect(reportOf({ name: "Error", stack: ours }, "/")).toBeUndefined();
    expect(reportOf(thrown("Error", "at chrome-extension://x/a.js:1:2"), "/")).toBeUndefined();
  });

  test("an unusable name is reported as Error", () => {
    expect(reportOf(thrown("my error!", ours), "/")?.name).toBe("Error");
  });

  test("sends at most MAX_REPORTS per page load, until stopped, and survives a failing send", async () => {
    const target = new FakeWindow();
    const sent: unknown[] = [];
    const stop = reportErrors(target, async (r) => {
      sent.push(r);
      throw new Error("offline");
    });
    for (let i = 0; i < MAX_REPORTS + 3; i++) {
      const event = new Event("error") as Event & { error: unknown };
      event.error = thrown("TypeError", ours);
      target.dispatchEvent(event);
    }
    expect(sent).toHaveLength(MAX_REPORTS);
    stop();

    const other = new FakeWindow();
    const after: unknown[] = [];
    const stopOther = reportErrors(other, async (r) => void after.push(r));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = thrown("SyntaxError", ours);
    other.dispatchEvent(rejection);
    stopOther();
    other.dispatchEvent(rejection);
    expect(after).toEqual([
      { page: "/polls/:id", name: "SyntaxError", frames: ["assets/main-1.js:1:2"] },
    ]);
  });
});

describe("PostHog batches", () => {
  function stub(status = 200) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    }) as typeof globalThis.fetch;
    const sent = () =>
      calls.map(
        (c) => JSON.parse(c.init.body as string) as { api_key: string; batch: PostHogEvent[] },
      );
    return { calls, fetch, sent };
  }

  test("are anonymous: a fresh ID per event, no person profile, no GeoIP, no timestamp", async () => {
    const { calls, fetch, sent } = stub();
    const analytics = createAnalytics({
      host: "https://eu.i.posthog.com",
      key: "phc_test",
      fetch,
      log: () => {},
    });
    analytics.pageview("/polls/:id", 200);
    analytics.pageview("/polls/:id", 200);
    analytics.exception("client", {
      page: "/",
      name: "TypeError",
      frames: ["assets/main-1.js:12:345"],
    });
    await analytics.close();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://eu.i.posthog.com/batch/");
    expect(calls[0]!.init.redirect).toBe("error");
    const [{ api_key, batch }] = sent() as [{ api_key: string; batch: PostHogEvent[] }];
    expect(api_key).toBe("phc_test");
    expect(batch.map((e) => e.event)).toEqual(["$pageview", "$pageview", "$exception"]);
    expect(new Set(batch.map((e) => e.distinct_id)).size).toBe(3);
    for (const event of batch) {
      expect(Object.keys(event).sort()).toEqual(["distinct_id", "event", "properties"]);
      expect(event.properties).toMatchObject({
        $process_person_profile: false,
        $geoip_disable: true,
      });
    }
    expect(batch[0]!.properties).toMatchObject({ $current_url: "/polls/:id", status: 200 });
    expect(batch[2]!.properties["$exception_list"]).toEqual([
      {
        type: "TypeError",
        mechanism: { handled: false, synthetic: false },
        stacktrace: {
          type: "raw",
          frames: [
            { filename: "assets/main-1.js", lineno: 12, colno: 345, platform: "web:javascript" },
          ],
        },
      },
    ]);
  });

  test("hold at most maxQueue events between flushes, and send nothing when empty", async () => {
    const { calls, fetch, sent } = stub();
    const analytics = createAnalytics({
      host: "https://eu.i.posthog.com",
      key: "k",
      fetch,
      log: () => {},
      maxQueue: 3,
    });
    for (let i = 0; i < 10; i++) analytics.pageview("/", 200);
    await analytics.close();
    await analytics.close();
    expect(calls).toHaveLength(1);
    expect(sent()[0]!.batch).toHaveLength(3);
  });

  test("log a failure by kind only, and keep going", async () => {
    const logged: unknown[] = [];
    const { fetch } = stub(503);
    const failing = createAnalytics({
      host: "https://ph.test",
      key: "k",
      fetch,
      log: (l) => void logged.push(l),
    });
    failing.pageview("/", 200);
    await failing.close();
    const offline = createAnalytics({
      host: "https://ph.test",
      key: "k",
      fetch: async () => {
        throw new TypeError("fetch failed: https://ph.test");
      },
      log: (l) => void logged.push(l),
    });
    offline.pageview("/", 200);
    await offline.close();
    expect(logged).toEqual([{ error: "analytics: HTTP 503" }, { error: "analytics: TypeError" }]);
  });

  test("refuse a host that isn't a bare https origin", () => {
    for (const host of ["http://ph.test", "https://ph.test/", "https://ph.test/x"])
      expect(() => createAnalytics({ host, key: "k", log: () => {} })).toThrow(RangeError);
  });
});
