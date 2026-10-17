import { readFileSync } from "node:fs";

import {
  decodeElectionDefinitionV5,
  displayTextV2Commitment,
  electionDefinitionV5Rule,
  displayTextV2Rule,
  encodeDisplayTextV2,
  QUESTION_METHODS,
} from "@abolishus/crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountPolls,
  createPollDraft,
  deletePollDraft,
  type DraftQuestion,
  listAccountPolls,
  MAX_CLOSE_SECONDS,
  MAX_DRAFT_TEXT,
  MAX_DRAFTS,
  MAX_POLLS_IN_SETUP,
  MAX_SUBMISSIONS_PER_DAY,
  MIN_OPEN_SECONDS,
  newAccountId,
  type PollDraft,
  PollDraftError,
  pollDraftProblem,
  readAccountPoll,
  SETUP_SECONDS,
  submitPollDraft,
  type Turnstile,
  type TurnstileAction,
  type TurnstileVerdict,
  updatePollDraft,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// An author's drafts and the creator record (ADR 0032, rules 12, 15 and 18;
// P2-22 part 2): a draft is refused by the rules the registry's checks
// mirror, only its account can see or change it, only a draft can be edited
// or submitted, the limits hold under concurrent submissions, and a refused
// submission never spends the author's Turnstile solve (T-10, T-28, T-52,
// T-72).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);

const question = (n = 2, text = "Which day?"): DraftQuestion => ({
  question: text,
  description: "",
  options: Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}`, description: "" })),
  minSelections: 0,
  maxSelections: 1,
});

const draft = (over: Partial<PollDraft> = {}): PollDraft => ({
  language: "en",
  title: "Lunch",
  description: "Where the team eats on Friday.",
  questions: [question()],
  tiers: [0],
  closesAt: NOW_S + 7n * 24n * 3600n,
  ...over,
});

const rule = (d: PollDraft, now?: bigint) => pollDraftProblem(d, now);

describe("pollDraftProblem", () => {
  test("accepts a plain one-question poll, at any time and at submission", () => {
    expect(rule(draft())).toBeUndefined();
    expect(rule(draft(), NOW_S)).toBeUndefined();
  });

  test("refuses each rule in order, naming the first failing question", () => {
    expect(rule(draft({ title: "\ud800" }))).toEqual({ rule: "text" });
    // A pair is one code point, and fine.
    expect(rule(draft({ title: "Lunch 🍕" }))).toBeUndefined();
    expect(rule(draft({ questions: [] }))).toEqual({ rule: "questions" });
    expect(rule(draft({ questions: Array.from({ length: 33 }, () => question()) }))).toEqual({
      rule: "questions",
    });
    expect(rule(draft({ questions: [question(), question(1, "Where?")] }))).toEqual({
      rule: "option-count",
      question: 1,
    });
    expect(rule(draft({ questions: [question(40), question(25, "Where?")] }))).toEqual({
      rule: "option-count",
      question: 1,
    });
    expect(
      rule(draft({ questions: [question(), { ...question(3, "Where?"), minSelections: 2 }] })),
    ).toEqual({ rule: "selections", question: 1 });
    expect(rule(draft({ questions: [{ ...question(), maxSelections: 0 }] }))).toEqual({
      rule: "selections",
      question: 0,
    });
    expect(rule(draft({ questions: [{ ...question(), maxSelections: 3 }] }))).toEqual({
      rule: "selections",
      question: 0,
    });
    expect(rule(draft({ title: "x".repeat(1025) }))).toEqual({ rule: "too-long" });
    expect(rule(draft({ language: "EN" }))).toEqual({ rule: "language-tag" });
    expect(rule(draft({ title: "" }))).toEqual({ rule: "question" });
    expect(rule(draft({ questions: [question(2, "")] }))).toEqual({ rule: "question" });
    const same = { ...question(), options: [0, 1].map(() => ({ label: "Yes", description: "" })) };
    expect(rule(draft({ questions: [same] }))).toEqual({ rule: "labels" });
    expect(rule(draft({ questions: [question(), question()] }))).toEqual({
      rule: "question-texts",
    });
    for (const tiers of [[], [1, 0], [0, 0], [3], [0.5]])
      expect(rule(draft({ tiers }))).toEqual({ rule: "tiers" });
    expect(rule(draft({ tiers: [0, 1, 2] }))).toBeUndefined();
    expect(rule(draft({ closesAt: -1n }))).toEqual({ rule: "closes-at" });
    expect(rule(draft({ closesAt: 1n << 64n }))).toEqual({ rule: "closes-at" });
  });

  test("refuses text that encodes to more than MAX_DRAFT_TEXT", () => {
    const long = (q: number) => ({
      ...question(2, `Question ${q}`),
      description: "x".repeat(8000),
    });
    const fits = Math.floor(MAX_DRAFT_TEXT / 8000);
    const at = (n: number) => draft({ questions: Array.from({ length: n }, (_, q) => long(q)) });
    expect(rule(at(fits))).toBeUndefined();
    expect(rule(at(fits + 1))).toEqual({ rule: "too-long" });
  });

  test("at submission, the poll must close after setup and an hour open, and within the limit", () => {
    const earliest = NOW_S + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS);
    const latest = NOW_S + BigInt(MAX_CLOSE_SECONDS);
    expect(rule(draft({ closesAt: earliest }), NOW_S)).toBeUndefined();
    expect(rule(draft({ closesAt: earliest - 1n }), NOW_S)).toEqual({ rule: "closes-at" });
    expect(rule(draft({ closesAt: latest }), NOW_S)).toBeUndefined();
    expect(rule(draft({ closesAt: latest + 1n }), NOW_S)).toEqual({ rule: "closes-at" });
    // A draft may be saved with any time; only submission judges it.
    expect(rule(draft({ closesAt: 0n }))).toBeUndefined();
  });

  const typical = decodeElectionDefinitionV5(
    Buffer.from(
      (
        JSON.parse(
          readFileSync(
            new URL("../../../docs/spec/vectors/election-definition-v5.json", import.meta.url),
            "utf8",
          ),
        ).vectors as { id: string; encoding: string }[]
      ).find((v) => v.id === "definition-v5-typical")!.encoding,
      "hex",
    ),
  );

  const text = fc.string({ maxLength: 12, unit: "binary" });
  const arbitraryDraft: fc.Arbitrary<PollDraft> = fc.record({
    language: fc.constantFrom("en", "fr", "EN", "", "pt-br"),
    title: text,
    description: text,
    questions: fc.array(
      fc.record({
        question: text,
        description: text,
        options: fc.array(fc.record({ label: text, description: text }), { maxLength: 6 }),
        minSelections: fc.integer({ min: 0, max: 7 }),
        maxSelections: fc.integer({ min: 0, max: 7 }),
      }),
      { maxLength: 4 },
    ),
    tiers: fc.constant([0]),
    closesAt: fc.constant(0n),
  });

  test("a draft it accepts makes display text and questions that definition version 5 accepts", () => {
    fc.assert(
      fc.property(arbitraryDraft, (d) => {
        if (rule(d) !== undefined) return;
        const enc = (s: string) => new TextEncoder().encode(s);
        const t = {
          salt: new Uint8Array(32),
          translations: [
            {
              language: enc(d.language),
              title: enc(d.title),
              description: enc(d.description),
              questions: d.questions.map((q) => ({
                question: enc(q.question),
                description: enc(q.description),
                options: q.options.map((o) => ({
                  label: enc(o.label),
                  description: enc(o.description),
                })),
              })),
            },
          ],
        };
        encodeDisplayTextV2(t);
        const definition = {
          ...typical,
          questions: d.questions.map((q) => ({
            method: QUESTION_METHODS.selection,
            option_count: q.options.length,
            min_selections: q.minSelections,
            max_selections: q.maxSelections,
          })),
          display_text_commitment: displayTextV2Commitment(t),
        };
        expect(electionDefinitionV5Rule(definition)).toBeUndefined();
        expect(displayTextV2Rule(t, definition)).toBeUndefined();
      }),
      { numRuns, verbose: true },
    );
  });
});

let db: TestDb;
let app: Sql;

const passing = (verdict: TurnstileVerdict = "passed") => {
  const calls: [string | null, TurnstileAction][] = [];
  const turnstile: Turnstile = {
    verify: async (token, action) => {
      calls.push([token, action]);
      return verdict;
    },
  };
  return { calls, turnstile };
};

async function newAccount(): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  return id;
}

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => {
      if (e instanceof PollDraftError) return e.code;
      throw e;
    },
  );

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

describe("account_polls", () => {
  test("the Drizzle table agrees with the migration", async () => {
    const config = getTableConfig(accountPolls);
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("saves, reads, lists, edits and deletes a draft, for its own account only", async () => {
    const author = await newAccount();
    const other = await newAccount();
    const id = await createPollDraft(app, author, draft(), NOW);
    expect(await readAccountPoll(app, author, id)).toEqual({
      id,
      state: "drafted",
      draft: draft(),
      createdAt: NOW,
      updatedAt: NOW,
      submittedAt: undefined,
    });
    expect(await readAccountPoll(app, other, id)).toBeUndefined();
    expect(await listAccountPolls(app, other)).toEqual([]);
    const later = new Date(NOW.getTime() + 1000);
    const edited = draft({ title: "Dinner" });
    expect(await code(updatePollDraft(app, other, id, edited, later))).toBe("not-found");
    await updatePollDraft(app, author, id, edited, later);
    const [listed] = await listAccountPolls(app, author);
    expect(listed).toMatchObject({ id, draft: edited, createdAt: NOW, updatedAt: later });
    expect(await code(deletePollDraft(app, other, id))).toBe("not-found");
    await deletePollDraft(app, author, id);
    expect(await readAccountPoll(app, author, id)).toBeUndefined();
  });

  test("refuses a draft that breaks a rule, writing nothing", async () => {
    const author = await newAccount();
    const refused = createPollDraft(app, author, draft({ questions: [] }), NOW);
    await expect(refused).rejects.toMatchObject({
      code: "refused",
      problem: { rule: "questions" },
    });
    expect(await listAccountPolls(app, author)).toEqual([]);
  });

  test(`keeps at most ${MAX_DRAFTS} drafts per account`, async () => {
    const author = await newAccount();
    await Promise.all(
      Array.from({ length: MAX_DRAFTS + 3 }, () =>
        code(createPollDraft(app, author, draft(), NOW)),
      ),
    ).then((codes) => {
      expect(codes.filter((c) => c === "ok")).toHaveLength(MAX_DRAFTS);
      expect(codes.filter((c) => c === "too-many-drafts")).toHaveLength(3);
    });
  });

  test("submits a draft once its token passes, and then it can't be edited, deleted or resubmitted", async () => {
    const author = await newAccount();
    const id = await createPollDraft(app, author, draft(), NOW);
    const { calls, turnstile } = passing();
    await submitPollDraft(app, author, id, { turnstile, token: "t", now: NOW });
    expect(calls).toEqual([["t", "poll-create"]]);
    expect(await readAccountPoll(app, author, id)).toMatchObject({
      state: "submitted",
      submittedAt: NOW,
    });
    expect(await code(updatePollDraft(app, author, id, draft(), NOW))).toBe("not-editable");
    expect(await code(deletePollDraft(app, author, id))).toBe("not-editable");
    expect(await code(submitPollDraft(app, author, id, { turnstile, token: "t", now: NOW }))).toBe(
      "not-editable",
    );
    expect(calls).toHaveLength(1);
  });

  test("a refused or unavailable challenge leaves the draft as it was", async () => {
    const author = await newAccount();
    const id = await createPollDraft(app, author, draft(), NOW);
    for (const [verdict, expected] of [
      ["refused", "challenge-refused"],
      ["unavailable", "challenge-unavailable"],
    ] as const) {
      const { turnstile } = passing(verdict);
      expect(
        await code(submitPollDraft(app, author, id, { turnstile, token: "t", now: NOW })),
      ).toBe(expected);
    }
    expect(await readAccountPoll(app, author, id)).toMatchObject({ state: "drafted" });
  });

  test("a submission refused before the challenge never spends the token", async () => {
    const author = await newAccount();
    const other = await newAccount();
    const id = await createPollDraft(app, author, draft({ closesAt: NOW_S + 60n }), NOW);
    const { calls, turnstile } = passing();
    const submit = (account: string, poll: string) =>
      code(submitPollDraft(app, account, poll, { turnstile, token: "t", now: NOW }));
    expect(await submit(author, id)).toBe("refused");
    expect(await submit(other, id)).toBe("not-found");
    expect(await submit(author, newAccountId())).toBe("not-found");
    expect(calls).toEqual([]);
  });

  test(`allows ${MAX_POLLS_IN_SETUP} polls in setup at once, however many submit together`, async () => {
    const author = await newAccount();
    const ids = await Promise.all(
      Array.from({ length: MAX_POLLS_IN_SETUP + 3 }, () =>
        createPollDraft(app, author, draft(), NOW),
      ),
    );
    const { turnstile } = passing();
    const codes = await Promise.all(
      ids.map((id) => code(submitPollDraft(app, author, id, { turnstile, token: "t", now: NOW }))),
    );
    expect(codes.filter((c) => c === "ok")).toHaveLength(MAX_POLLS_IN_SETUP);
    expect(codes.filter((c) => c === "too-many-in-setup")).toHaveLength(3);
    // An open poll no longer holds setup capacity.
    const submitted = (await listAccountPolls(app, author)).filter((p) => p.state === "submitted");
    await db.admin`UPDATE account_polls SET state = 'open' WHERE id = ${submitted[0]!.id}`;
    const next = (await listAccountPolls(app, author)).find((p) => p.state === "drafted")!;
    expect(
      await code(submitPollDraft(app, author, next.id, { turnstile, token: "t", now: NOW })),
    ).toBe("ok");
  });

  test(`allows ${MAX_SUBMISSIONS_PER_DAY} submissions in any 24 hours`, async () => {
    const author = await newAccount();
    const { calls, turnstile } = passing();
    const submitAt = async (now: Date) => {
      const id = await createPollDraft(app, author, draft(), now);
      const result = await code(submitPollDraft(app, author, id, { turnstile, token: "t", now }));
      // Opened at once, so only the daily limit applies.
      await db.admin`UPDATE account_polls SET state = 'open' WHERE user_id = ${author} AND state = 'submitted'`;
      return result;
    };
    for (let i = 0; i < MAX_SUBMISSIONS_PER_DAY; i++)
      expect(await submitAt(new Date(NOW.getTime() + i * 60_000))).toBe("ok");
    const spent = calls.length;
    expect(await submitAt(new Date(NOW.getTime() + 23 * 3600_000))).toBe("too-many-today");
    expect(calls).toHaveLength(spent);
    expect(await submitAt(new Date(NOW.getTime() + 24 * 3600_000 + 1000))).toBe("ok");
  });

  test("deleting an account deletes its polls", async () => {
    const author = await newAccount();
    const id = await createPollDraft(app, author, draft(), NOW);
    await app`DELETE FROM account_users WHERE id = ${author}`;
    expect(await db.admin`SELECT 1 FROM account_polls WHERE id = ${id}`).toEqual([]);
  });

  test("the table refuses a state outside the machine, and a submitted poll without a time", async () => {
    const author = await newAccount();
    const id = await createPollDraft(app, author, draft(), NOW);
    await expect(app`UPDATE account_polls SET state = 'voted' WHERE id = ${id}`).rejects.toThrow(
      /check/,
    );
    await expect(
      app`UPDATE account_polls SET state = 'submitted' WHERE id = ${id}`,
    ).rejects.toThrow(/check/);
  });
});
