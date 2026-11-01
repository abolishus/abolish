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

const OPEN = {
  ...DRAFT,
  state: "open",
  submittedAt: "2026-10-12T09:00:00.000Z",
  electionId: "0b".repeat(32),
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

  test("reads an open poll with its election, for its page's link", async () => {
    serve(Response.json({ polls: [OPEN] }));
    expect(await draftsClient.list()).toEqual([
      {
        id: ID,
        state: "open",
        title: "Sunday hours?",
        closesAt: 1793750400n,
        updatedAt: DRAFT.updatedAt,
        submittedAt: OPEN.submittedAt,
        failure: undefined,
        retryable: false,
        electionId: OPEN.electionId,
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
      // An open poll without its election, or in another spelling (T-31), and
      // an election on a poll that isn't open (T-34: setup names none).
      { ...OPEN, electionId: undefined },
      { ...OPEN, electionId: "0B".repeat(32) },
      { ...OPEN, electionId: `0x${"0b".repeat(32)}` },
      { ...OPEN, electionId: "0b".repeat(31) },
      { ...OPEN, electionId: 1 },
      { ...OPEN, state: "registered" },
      { ...FAILED, electionId: OPEN.electionId },
      { ...DRAFT, electionId: OPEN.electionId },
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
      { ...STORED, topic: 1 },
      { ...STORED, place: null },
    ];
    for (const draft of bad) {
      serve(Response.json({ ...DRAFT, draft }));
      expect(await failure(draftsClient.read(ID))).toBe("failed");
    }
    const filed = { ...STORED, topic: "transport", place: "Harbor" };
    serve(Response.json({ ...DRAFT, draft: filed }));
    expect((await draftsClient.read(ID)).draft).toEqual({ ...filed, closesAt: 1793750400n });
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

// A poll's moderation as the handler answers it (`POST /drafts/moderation`,
// P2-10 part 3b-2a): the page shows only an answer that holds together.
describe("moderation", () => {
  const DELIST = {
    seq: "41",
    action: "delist",
    reason: "spam",
    decidedAt: "2026-10-17T16:45:00.000Z",
  };
  const ANSWER = {
    state: "delisted",
    latest: DELIST,
    appealable: false,
    appeals: [
      {
        decisionSeq: "12",
        filedAt: "2026-10-14T12:00:00.000Z",
        outcome: "superseded",
        reviewedAt: "2026-10-16T08:00:00.000Z",
      },
      { decisionSeq: "41", filedAt: "2026-10-17T17:00:00.000Z" },
    ],
  };

  test("reads the state, the newest decision and the appeals as the handler answers them", async () => {
    const calls = serve(
      Response.json(ANSWER),
      Response.json({ state: "visible", appealable: false, appeals: [] }),
    );
    expect(await draftsClient.moderation(ID)).toEqual({
      state: "delisted",
      latest: { ...DELIST, seq: 41n },
      appealable: false,
      appeals: [
        {
          decisionSeq: 12n,
          filedAt: "2026-10-14T12:00:00.000Z",
          outcome: "superseded",
          reviewedAt: "2026-10-16T08:00:00.000Z",
        },
        {
          decisionSeq: 41n,
          filedAt: "2026-10-17T17:00:00.000Z",
          outcome: undefined,
          reviewedAt: undefined,
        },
      ],
    });
    // A poll nothing was decided about.
    expect(await draftsClient.moderation(ID)).toEqual({
      state: "visible",
      latest: undefined,
      appealable: false,
      appeals: [],
    });
    expect(calls.map((c) => [c.url, c.init.body])).toEqual([
      ["/drafts/moderation", JSON.stringify({ id: ID })],
      ["/drafts/moderation", JSON.stringify({ id: ID })],
    ]);
  });

  test("takes every ground under its own actions only", async () => {
    const removals = [
      "illegal",
      "personal-data",
      "threat",
      "harassment",
      "spam",
      "impersonation",
      "legal-notice",
    ];
    const restores = ["appeal-upheld", "error", "notice-withdrawn"];
    for (const [action, state] of [
      ["delist", "delisted"],
      ["hide", "hidden"],
      ["restore", "visible"],
    ] as const)
      for (const reason of [...removals, ...restores]) {
        serve(
          Response.json({
            state,
            latest: { ...DELIST, action, reason },
            appealable: false,
            appeals: [],
          }),
        );
        const fits = (action === "restore" ? restores : removals).includes(reason);
        const read = draftsClient.moderation(ID);
        if (fits) expect((await read).latest).toMatchObject({ action, reason });
        else expect(await failure(read)).toBe("failed");
      }
  });

  test("refuses an answer that doesn't hold together", async () => {
    const bad: unknown[] = [
      // A state that isn't the newest decision's.
      { ...ANSWER, state: "visible" },
      { ...ANSWER, state: "hidden" },
      { ...ANSWER, latest: undefined },
      { ...ANSWER, state: "removed" },
      // Appealable with nothing to appeal.
      { state: "visible", appealable: true, appeals: [] },
      {
        ...ANSWER,
        latest: { ...DELIST, action: "restore", reason: "error" },
        state: "visible",
        appealable: true,
      },
      { ...ANSWER, appealable: "yes" },
      // A decision or an appeal that isn't one.
      { ...ANSWER, latest: { ...DELIST, seq: 41 } },
      { ...ANSWER, latest: { ...DELIST, seq: "041" } },
      { ...ANSWER, latest: { ...DELIST, decidedAt: "2026-10-17" } },
      { ...ANSWER, latest: { ...DELIST, action: "remove" } },
      { ...ANSWER, appeals: {} },
      {
        ...ANSWER,
        appeals: [{ decisionSeq: "41", filedAt: "2026-10-17T17:00:00.000Z", outcome: "upheld" }],
      },
      {
        ...ANSWER,
        appeals: [
          {
            decisionSeq: "41",
            filedAt: "2026-10-17T17:00:00.000Z",
            reviewedAt: "2026-10-17T18:00:00.000Z",
          },
        ],
      },
      {
        ...ANSWER,
        appeals: [
          {
            decisionSeq: "41",
            filedAt: "2026-10-17T17:00:00.000Z",
            outcome: "granted",
            reviewedAt: "2026-10-17T18:00:00.000Z",
          },
        ],
      },
      [],
      null,
    ];
    for (const answer of bad) {
      serve(Response.json(answer));
      expect(await failure(draftsClient.moderation(ID))).toBe("failed");
    }
  });

  test("appeals the poll's newest decision, and words each refusal", async () => {
    const calls = serve(
      Response.json({ decisionSeq: "41" }, { status: 201 }),
      refusal(409, "NOT_APPEALABLE"),
      refusal(409, "ALREADY_APPEALED"),
      refusal(404, "NOT_FOUND"),
      refusal(401, "SIGNED_OUT"),
      refusal(500, "INTERNAL"),
    );
    await draftsClient.appeal(ID);
    expect(calls[0]).toMatchObject({
      url: "/drafts/appeal",
      init: { method: "POST", body: JSON.stringify({ id: ID }) },
    });
    for (const expected of ["changed", "changed", "gone", "signedOut", "failed"])
      expect(await failure(draftsClient.appeal(ID))).toBe(expected);
  });

  test("never throws anything but its own error reading moderation, whatever the handler answers", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.constantFrom(200, 201, 404, 409), async (j, s) => {
        serve(Response.json(j, { status: s }), Response.json(j, { status: s }));
        for (const run of [draftsClient.moderation(ID), draftsClient.appeal(ID)]) {
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
});

// How many have answered an open poll as the handler answers it
// (`POST /drafts/answered`, P2-19 part 57): the row shows only counts it can
// word, one per tier.
describe("answered", () => {
  test("reads each tier's count as the handler answers it, and words each refusal", async () => {
    const calls = serve(
      Response.json({ tiers: [{ tier: 0, answered: "38" }] }),
      Response.json({
        tiers: [
          { tier: 0, answered: "0" },
          { tier: 2, answered: "18446744073709551615" },
        ],
      }),
      Response.json({ tiers: [] }),
      refusal(409, "NOT_OPEN"),
      refusal(404, "NOT_FOUND"),
      refusal(401, "SIGNED_OUT"),
      refusal(503, "UNAVAILABLE"),
    );
    expect(await draftsClient.answered(ID)).toEqual([{ tier: 0, answered: "38" }]);
    expect(await draftsClient.answered(ID)).toEqual([
      { tier: 0, answered: "0" },
      { tier: 2, answered: "18446744073709551615" },
    ]);
    expect(await draftsClient.answered(ID)).toEqual([]);
    expect(calls[0]).toMatchObject({
      url: "/drafts/answered",
      init: { method: "POST", body: JSON.stringify({ id: ID }) },
    });
    for (const expected of ["changed", "gone", "signedOut", "failed"])
      expect(await failure(draftsClient.answered(ID))).toBe(expected);
  });

  test("refuses a tier it can't word, a count that isn't a decimal u64, and tiers out of order", async () => {
    const bad = [
      {},
      { tiers: {} },
      { tiers: [{ tier: 3, answered: "1" }] },
      { tiers: [{ tier: -1, answered: "1" }] },
      { tiers: [{ tier: "0", answered: "1" }] },
      { tiers: [{ tier: 0, answered: 1 }] },
      { tiers: [{ tier: 0, answered: "01" }] },
      { tiers: [{ tier: 0, answered: "-1" }] },
      { tiers: [{ tier: 0, answered: "1".repeat(21) }] },
      { tiers: [{ tier: 0 }] },
      { tiers: [null] },
      {
        tiers: [
          { tier: 1, answered: "1" },
          { tier: 0, answered: "1" },
        ],
      },
      {
        tiers: [
          { tier: 0, answered: "1" },
          { tier: 0, answered: "2" },
        ],
      },
      [],
      null,
    ];
    for (const answer of bad) {
      serve(Response.json(answer));
      expect(await failure(draftsClient.answered(ID))).toBe("failed");
    }
  });

  test("never throws anything but its own error, whatever the handler answers", async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.constantFrom(200, 404, 409, 503), async (j, s) => {
        serve(Response.json(j, { status: s }));
        const e = await draftsClient.answered(ID).then(
          () => undefined,
          (x: unknown) => x,
        );
        if (e !== undefined) expect(e).toBeInstanceOf(DraftsError);
      }),
      runs,
    );
  });
});

describe("submission", () => {
  test("sends the poll's ID with the token in Turnstile's header, and nothing else of the page's", async () => {
    const calls = serve(Response.json({}, { status: 202 }));
    await draftsClient.submit(ID, "tok-1.x_Y");
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[number]];
    expect([url, init.method, init.body]).toEqual([
      "/drafts/submit",
      "POST",
      JSON.stringify({ id: ID }),
    ]);
    expect(init.headers).toEqual({
      "x-turnstile-token": "tok-1.x_Y",
      "content-type": "application/json",
    });
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
  });

  test.each([
    [403, "TURNSTILE_REFUSED", "challengeRefused"],
    [503, "TURNSTILE_UNAVAILABLE", "challengeUnavailable"],
    [429, "TOO_MANY_IN_SETUP", "tooManyInSetup"],
    [429, "TOO_MANY_TODAY", "tooManyToday"],
    [422, "DRAFT_REFUSED", "refused"],
    [409, "NOT_EDITABLE", "changed"],
    [404, "NOT_FOUND", "gone"],
    [401, "SIGNED_OUT", "signedOut"],
    [500, "INTERNAL", "failed"],
  ] as const)("words a %i %s as %s", async (status, code, expected) => {
    serve(refusal(status, code));
    expect(await failure(draftsClient.submit(ID, "tok"))).toBe(expected);
  });

  test("a network failure is `failed`", async () => {
    serve();
    expect(await failure(draftsClient.submit(ID, "tok"))).toBe("failed");
  });
});
