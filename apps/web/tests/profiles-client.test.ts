import { PROFILE_HANDLE as CORE_PROFILE_HANDLE } from "@abolishus/core";
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { PROFILE_HANDLE, ProfilesError, profilesClient } from "../src/account/profiles.ts";
import { PROFILE_ROUTES } from "../src/node/profiles.ts";

// The account page's calls (src/account/profiles.ts), with the browser's
// fetch stubbed: what it sends to the profiles handler
// (src/node/profiles.ts), what it accepts from it, and how each refusal
// reaches the page.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

const HANDLE = "k7tq2mxa4vb3pz6r";
const POLL = "a".repeat(32);
const OWN = { handle: HANDLE, name: "Harbor Street Neighbors", pollIds: [POLL] };
const HIDE = {
  seq: "41",
  action: "hide",
  reason: "impersonation",
  decidedAt: "2026-10-20T15:10:00.000Z",
};
const HIDDEN = { handle: HANDLE, state: "hidden", latest: HIDE, appealable: true, appeals: [] };

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

async function refused(run: Promise<unknown>): Promise<ProfilesError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProfilesError);
  return error as ProfilesError;
}

const refusal = (status: number, code: string) => Response.json({ code, status }, { status });

afterEach(() => vi.unstubAllGlobals());

describe("profiles client", () => {
  test("spells core's handle", () => {
    expect(PROFILE_HANDLE.source).toBe(CORE_PROFILE_HANDLE.source);
    expect(PROFILE_HANDLE.flags).toBe(CORE_PROFILE_HANDLE.flags);
  });

  test("posts JSON to the author's own routes with the session, and never a handle", async () => {
    const calls = serve(
      Response.json(OWN),
      Response.json({ handle: HANDLE }, { status: 201 }),
      Response.json({ changed: true }),
      Response.json({ deleted: true }),
      Response.json(HIDDEN),
      Response.json({ decisionSeq: "41" }, { status: 201 }),
      Response.json({ changed: true }),
      Response.json({ changed: false }),
    );
    expect(await profilesClient.own()).toEqual({ ...OWN, renamableOn: undefined });
    expect(await profilesClient.make("Sam")).toBe(HANDLE);
    expect(await profilesClient.rename("Sam R.")).toBe(true);
    await profilesClient.remove();
    expect((await profilesClient.moderation()).state).toBe("hidden");
    await profilesClient.appeal();
    expect(await profilesClient.show(POLL, true)).toBe(true);
    expect(await profilesClient.show(POLL, false)).toBe(false);
    expect(calls.map((c) => c.url)).toEqual([
      "/profiles/own",
      "/profiles/make",
      "/profiles/rename",
      "/profiles/delete",
      "/profiles/moderation",
      "/profiles/appeal",
      "/profiles/show",
      "/profiles/show",
    ]);
    // Every one is a route the handler serves; the report, which goes without
    // the session, is never the account page's (T-10, T-11).
    for (const { url } of calls) expect(PROFILE_ROUTES).toContain(`POST ${url}`);
    const bodies = calls.map((c) => JSON.parse(c.init.body as string) as unknown);
    expect(bodies).toEqual([
      {},
      { name: "Sam" },
      { name: "Sam R." },
      {},
      {},
      {},
      { pollId: POLL, on: true },
      { pollId: POLL, on: false },
    ]);
    for (const { init } of calls) {
      expect(init.method).toBe("POST");
      expect(init.credentials).toBe("same-origin");
      expect(init.redirect).toBe("error");
      expect(init.headers).toEqual({ "content-type": "application/json" });
    }
  });

  test("answers no profile for NO_PROFILE from own, and a changed profile from the rest", async () => {
    serve(refusal(404, "NO_PROFILE"));
    expect(await profilesClient.own()).toBeUndefined();
    serve(refusal(404, "NO_PROFILE"));
    expect((await refused(profilesClient.rename("Sam"))).failure).toBe("changed");
    serve(refusal(404, "NO_PROFILE"));
    expect((await refused(profilesClient.moderation())).failure).toBe("changed");
    serve(refusal(404, "NO_PROFILE"));
    expect((await refused(profilesClient.show(POLL, true))).failure).toBe("changed");
    // A poll deleted or discarded since the page read it.
    serve(refusal(404, "NOT_FOUND"));
    expect((await refused(profilesClient.show(POLL, true))).failure).toBe("changed");
    // Nothing to delete: another tab got there first.
    serve(Response.json({ deleted: false }));
    expect((await refused(profilesClient.remove())).failure).toBe("changed");
  });

  test("takes exactly a boolean from show", async () => {
    for (const answer of [{}, { changed: "yes" }, { changed: true, extra: 1 }, [true]]) {
      serve(Response.json(answer));
      expect((await refused(profilesClient.show(POLL, true))).failure).toBe("failed");
    }
    serve(refusal(401, "SIGNED_OUT"));
    expect((await refused(profilesClient.show(POLL, true))).failure).toBe("signedOut");
  });

  test("reads the day a name can change again", async () => {
    serve(Response.json({ ...OWN, renamableOn: "2026-10-23", pollIds: [] }));
    expect(await profilesClient.own()).toEqual({ ...OWN, renamableOn: "2026-10-23", pollIds: [] });
  });

  test("refuses a profile it can't show truthfully", async () => {
    for (const answer of [
      { ...OWN, handle: "K7TQ2MXA4VB3PZ6R" },
      { ...OWN, handle: "k7tq2mxa4vb3pz61" },
      { ...OWN, name: "" },
      { ...OWN, name: 7 },
      { ...OWN, pollIds: [POLL, POLL] },
      { ...OWN, pollIds: ["A".repeat(32)] },
      { ...OWN, pollIds: POLL },
      { ...OWN, renamableOn: "2026-10-23T00:00:00.000Z" },
      { ...OWN, account: "x" },
      { handle: HANDLE, name: "Sam" },
      [],
      null,
    ]) {
      serve(Response.json(answer));
      expect((await refused(profilesClient.own())).failure).toBe("failed");
    }
    for (const answer of [{ handle: "nope" }, { handle: HANDLE, name: "Sam" }, {}]) {
      serve(Response.json(answer, { status: 201 }));
      expect((await refused(profilesClient.make("Sam"))).failure).toBe("failed");
    }
    for (const answer of [{ changed: "yes" }, {}, { changed: true, name: "Sam" }]) {
      serve(Response.json(answer));
      expect((await refused(profilesClient.rename("Sam"))).failure).toBe("failed");
    }
  });

  test("reads a moderation that holds together", async () => {
    serve(
      Response.json({
        handle: HANDLE,
        state: "visible",
        latest: { ...HIDE, seq: "44", action: "restore", reason: "appeal-upheld" },
        appealable: false,
        appeals: [
          {
            decisionSeq: "41",
            filedAt: "2026-10-21T09:30:00.000Z",
            outcome: "upheld",
            reviewedAt: "2026-10-22T11:00:00.000Z",
          },
        ],
      }),
    );
    expect(await profilesClient.moderation()).toEqual({
      state: "visible",
      latest: {
        seq: 44n,
        action: "restore",
        reason: "appeal-upheld",
        decidedAt: "2026-10-20T15:10:00.000Z",
      },
      appealable: false,
      appeals: [
        {
          decisionSeq: 41n,
          filedAt: "2026-10-21T09:30:00.000Z",
          outcome: "upheld",
          reviewedAt: "2026-10-22T11:00:00.000Z",
        },
      ],
    });
    serve(Response.json({ handle: HANDLE, state: "visible", appealable: false, appeals: [] }));
    expect(await profilesClient.moderation()).toEqual({
      state: "visible",
      latest: undefined,
      appealable: false,
      appeals: [],
    });
  });

  test("refuses a moderation that doesn't hold together", async () => {
    const appeal = { decisionSeq: "41", filedAt: "2026-10-21T09:30:00.000Z" };
    for (const answer of [
      // The state isn't the newest decision's.
      { ...HIDDEN, state: "visible" },
      { handle: HANDLE, state: "hidden", appealable: false, appeals: [] },
      // Only a hide is appealable.
      { handle: HANDLE, state: "visible", appealable: true, appeals: [] },
      // A poll's action, or a ground for the other action.
      { ...HIDDEN, latest: { ...HIDE, action: "delist" } },
      { ...HIDDEN, latest: { ...HIDE, reason: "appeal-upheld" } },
      { ...HIDDEN, latest: { ...HIDE, seq: "-1" } },
      { ...HIDDEN, latest: { ...HIDE, seq: 41 } },
      { ...HIDDEN, latest: { ...HIDE, moderator: "m" } },
      // An outcome exactly when there's a review time.
      { ...HIDDEN, appeals: [{ ...appeal, outcome: "upheld" }] },
      { ...HIDDEN, appeals: [{ ...appeal, reviewedAt: "2026-10-22T11:00:00.000Z" }] },
      {
        ...HIDDEN,
        appeals: [{ ...appeal, outcome: "won", reviewedAt: "2026-10-22T11:00:00.000Z" }],
      },
      { ...HIDDEN, appeals: [{ ...appeal, reviewer: "r" }] },
      { ...HIDDEN, handle: "nope" },
      { ...HIDDEN, appeals: {} },
      { ...HIDDEN, appealable: "yes" },
    ]) {
      serve(Response.json(answer));
      expect((await refused(profilesClient.moderation())).failure).toBe("failed");
    }
  });

  test("words each of the handler's refusals the page explains, and fails on the rest", async () => {
    const expected: [number, string, string][] = [
      [401, "SIGNED_OUT", "signedOut"],
      [403, "PHONE_UNVERIFIED", "phoneUnverified"],
      [409, "PROFILE_EXISTS", "changed"],
      [422, "INVALID_NAME", "invalidName"],
      [429, "ONE_NAME_A_DAY", "oneNameADay"],
      [409, "HIDDEN", "hidden"],
      [409, "NOT_APPEALABLE", "changed"],
      [409, "ALREADY_APPEALED", "changed"],
      [404, "NOT_FOUND", "failed"],
      [403, "FORBIDDEN_ORIGIN", "failed"],
      [400, "BAD_REQUEST", "failed"],
    ];
    for (const [status, code, failure] of expected) {
      serve(refusal(status, code));
      expect((await refused(profilesClient.make("Sam"))).failure).toBe(failure);
    }
    serve(new Response("500\n", { status: 500 }));
    expect((await refused(profilesClient.own())).failure).toBe("failed");
    serve(new Response("not json"));
    expect((await refused(profilesClient.own())).failure).toBe("failed");
    serve();
    expect((await refused(profilesClient.own())).failure).toBe("failed");
  });

  test("never takes an unknown code, or one from a prototype, as a known refusal", async () => {
    const known = [
      "SIGNED_OUT",
      "PHONE_UNVERIFIED",
      "INVALID_NAME",
      "ONE_NAME_A_DAY",
      "HIDDEN",
      "PROFILE_EXISTS",
      "NO_PROFILE",
      "NOT_APPEALABLE",
      "ALREADY_APPEALED",
    ];
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string(), fc.constantFrom("toString", "__proto__", "constructor")),
        async (code) => {
          fc.pre(!known.includes(code));
          serve(refusal(409, code));
          expect((await refused(profilesClient.rename("Sam"))).failure).toBe("failed");
        },
      ),
      runs,
    );
  });

  test("takes only a handle core would issue", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string(), fc.stringMatching(/^[a-z2-7]{16}$/)),
        async (handle) => {
          serve(Response.json({ ...OWN, handle }));
          const read = await profilesClient.own().then(
            (p) => p?.handle,
            () => undefined,
          );
          expect(read).toBe(CORE_PROFILE_HANDLE.test(handle) ? handle : undefined);
        },
      ),
      runs,
    );
  });
});
