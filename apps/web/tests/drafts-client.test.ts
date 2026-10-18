import { POLL_FAILURES } from "@abolishus/core/poll-failures";
import fc from "fast-check";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { DraftsError, draftsClient } from "../src/account/drafts.ts";

// The account page's drafts calls, with the browser's fetch stubbed: what
// the list accepts from the handler (src/node/drafts.ts) and how each
// refusal reaches it.

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

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

async function failure(run: Promise<unknown>) {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DraftsError);
  return (error as DraftsError).failure;
}

const ID = "a".repeat(32);

const DRAFT = {
  id: ID,
  state: "drafted",
  title: "Sunday hours?",
  closesAt: "1793750400",
  createdAt: "2026-10-11T14:00:00.000Z",
  updatedAt: "2026-10-11T14:20:00.000Z",
};

const FAILED = {
  ...DRAFT,
  state: "failed",
  submittedAt: "2026-10-12T09:00:00.000Z",
  failure: "ceremony-timeout",
  retryable: true,
};

/** A draft as the handler stores and answers it. */
const STORED = {
  language: "en",
  title: "Sunday hours?",
  description: "",
  questions: [
    {
      question: "Should the library open on Sundays?",
      description: "",
      options: [
        { label: "Yes", description: "" },
        { label: "No", description: "" },
      ],
      minSelections: 1,
      maxSelections: 1,
    },
  ],
  tiers: [0],
  closesAt: "1793750400",
};

const refusal = (status: number, code: string) => Response.json({ code, status }, { status });

afterEach(() => vi.unstubAllGlobals());

describe("drafts client", () => {
  test("lists the account's polls as the handler answers them", async () => {
    serve(Response.json({ polls: [DRAFT, FAILED] }));
    expect(await draftsClient.list()).toEqual([
      {
        id: ID,
        state: "drafted",
        title: "Sunday hours?",
        closesAt: 1793750400n,
        updatedAt: DRAFT.updatedAt,
        submittedAt: undefined,
        failure: undefined,
        retryable: false,
      },
      {
        id: ID,
        state: "failed",
        title: "Sunday hours?",
        closesAt: 1793750400n,
        updatedAt: DRAFT.updatedAt,
        submittedAt: FAILED.submittedAt,
        failure: "ceremony-timeout",
        retryable: true,
      },
    ]);
  });

  test("accepts every failure code core writes", async () => {
    for (const code of POLL_FAILURES) {
      serve(Response.json({ polls: [{ ...FAILED, failure: code, retryable: false }] }));
      expect((await draftsClient.list())[0]?.failure).toBe(code);
    }
  });

  test("refuses a summary it can't show truthfully", async () => {
    const bad = [
      { ...DRAFT, state: "approved" },
      { ...DRAFT, closesAt: "01" },
      { ...DRAFT, closesAt: 1793750400 },
      { ...DRAFT, title: 1 },
      { ...DRAFT, updatedAt: "yesterday" },
      { ...DRAFT, submittedAt: null },
      // A failure code on a poll that isn't failed, or a failed one without its code.
      { ...DRAFT, failure: "ceremony-timeout", retryable: true },
      { ...DRAFT, retryable: false },
      { ...FAILED, failure: "lost" },
      { ...FAILED, failure: undefined },
      { ...FAILED, retryable: "yes" },
    ];
    for (const poll of bad) {
      serve(Response.json({ polls: [poll] }));
      expect(await failure(draftsClient.list())).toBe("failed");
    }
    serve(Response.json({ polls: {} }), Response.json([DRAFT]));
    expect(await failure(draftsClient.list())).toBe("failed");
    expect(await failure(draftsClient.list())).toBe("failed");
  });

  test("never throws anything but its own error, whatever the handler answers", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.constantFrom(200, 400, 404, 409, 500), async (j, s) => {
        serve(new Response(JSON.stringify(j), { status: s }));
        const listed = await draftsClient.list().then(
          () => undefined,
          (e: unknown) => e,
        );
        if (listed !== undefined) expect(listed).toBeInstanceOf(DraftsError);
      }),
      runs,
    );
  });

  test("words each refusal the list can act on, and fails closed on the rest", async () => {
    serve(
      refusal(401, "SIGNED_OUT"),
      refusal(404, "NOT_FOUND"),
      refusal(409, "NOT_FAILED"),
      refusal(409, "NOT_EDITABLE"),
      refusal(409, "REGISTERED"),
      refusal(429, "TOO_MANY_DRAFTS"),
      refusal(403, "FORBIDDEN_ORIGIN"),
      new Response("not json", { status: 500 }),
      new Response("not json"),
    );
    expect(await failure(draftsClient.retry(ID))).toBe("signedOut");
    expect(await failure(draftsClient.retry(ID))).toBe("gone");
    expect(await failure(draftsClient.retry(ID))).toBe("changed");
    expect(await failure(draftsClient.remove(ID))).toBe("changed");
    expect(await failure(draftsClient.discard(ID))).toBe("registered");
    expect(await failure(draftsClient.retry(ID))).toBe("tooManyDrafts");
    expect(await failure(draftsClient.retry(ID))).toBe("failed");
    expect(await failure(draftsClient.retry(ID))).toBe("failed");
    expect(await failure(draftsClient.retry(ID))).toBe("failed");
    expect(await failure(draftsClient.retry(ID))).toBe("failed");
  });

  test("reads a draft as the handler stores it, and nothing else", async () => {
    serve(Response.json({ ...DRAFT, draft: STORED }));
    expect(await draftsClient.read(ID)).toEqual({
      summary: {
        id: ID,
        state: "drafted",
        title: "Sunday hours?",
        closesAt: 1793750400n,
        updatedAt: DRAFT.updatedAt,
        submittedAt: undefined,
        failure: undefined,
        retryable: false,
      },
      draft: { ...STORED, closesAt: 1793750400n },
    });
    const question = STORED.questions[0]!;
    const bad = [
      undefined,
      [],
      { ...STORED, closesAt: 1793750400 },
      { ...STORED, closesAt: "-1" },
      { ...STORED, title: null },
      { ...STORED, tiers: [256] },
      { ...STORED, tiers: "0" },
      { ...STORED, questions: [{ ...question, minSelections: 1.5 }] },
      { ...STORED, questions: [{ ...question, maxSelections: -1 }] },
      { ...STORED, questions: [{ ...question, options: [{ label: "Yes" }] }] },
      { ...STORED, questions: {} },
    ];
    for (const draft of bad) {
      serve(Response.json({ ...DRAFT, draft }));
      expect(await failure(draftsClient.read(ID))).toBe("failed");
    }
    // Another poll's answer isn't this page's.
    serve(Response.json({ ...DRAFT, id: "b".repeat(32), draft: STORED }));
    expect(await failure(draftsClient.read(ID))).toBe("failed");
  });

  test("saves a draft with its closing time as the handler's decimal string", async () => {
    const calls = serve(
      Response.json({ id: ID }, { status: 201 }),
      Response.json({}),
      Response.json({ id: "not an id" }, { status: 201 }),
      Response.json(
        { code: "DRAFT_REFUSED", status: 422, problem: { rule: "labels" } },
        { status: 422 },
      ),
      refusal(409, "NOT_EDITABLE"),
    );
    const draft = { ...STORED, closesAt: 1793750400n };
    expect(await draftsClient.create(draft)).toBe(ID);
    await draftsClient.update(ID, draft);
    expect(await failure(draftsClient.create(draft))).toBe("failed");
    expect(await failure(draftsClient.create(draft))).toBe("refused");
    expect(await failure(draftsClient.update(ID, draft))).toBe("changed");
    expect(calls.slice(0, 2).map((c) => [c.url, c.init.method, c.init.body])).toEqual([
      ["/drafts/create", "POST", JSON.stringify({ draft: STORED })],
      ["/drafts/update", "POST", JSON.stringify({ id: ID, draft: STORED })],
    ]);
  });

  test("never throws anything but its own error reading a draft, whatever the handler answers", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.constantFrom(200, 201, 404, 422), async (j, s) => {
        serve(
          new Response(JSON.stringify(j), { status: s }),
          new Response(JSON.stringify(j), { status: s }),
        );
        for (const run of [
          draftsClient.read(ID),
          draftsClient.create({ ...STORED, closesAt: 0n }),
        ]) {
          const e = await run.then(
            () => undefined,
            (x: unknown) => x,
          );
          if (e !== undefined) expect(e).toBeInstanceOf(DraftsError);
        }
      }),
      runs,
    );
  });

  test("calls stay on this origin, uncached, refusing redirects, as the handler wants them", async () => {
    const calls = serve(
      Response.json({ polls: [] }),
      Response.json({}),
      Response.json({}),
      Response.json({}),
    );
    await draftsClient.list();
    await draftsClient.remove(ID);
    await draftsClient.retry(ID);
    await draftsClient.discard(ID);
    expect(calls.map((c) => [c.url, c.init.method, c.init.body])).toEqual([
      ["/drafts", "GET", undefined],
      ["/drafts/delete", "POST", JSON.stringify({ id: ID })],
      ["/drafts/retry", "POST", JSON.stringify({ id: ID })],
      ["/drafts/discard", "POST", JSON.stringify({ id: ID })],
    ]);
    for (const { init } of calls) {
      expect(init.credentials).toBe("same-origin");
      expect(init.cache).toBe("no-store");
      expect(init.redirect).toBe("error");
    }
    // Exactly the type the handler takes, with no charset.
    for (const { init } of calls.slice(1))
      expect(init.headers).toEqual({ "content-type": "application/json" });
  });
});
