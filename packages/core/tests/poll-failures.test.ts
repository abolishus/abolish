import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountPollSubmissions,
  type CreationFailure,
  createPollDraft,
  discardFailedPoll,
  listAccountPolls,
  loadMigrations,
  MAX_DRAFTS,
  MAX_SUBMISSIONS_PER_DAY,
  migrate,
  newAccountId,
  type OpenFailure,
  POLL_FAILURES,
  type PollDraft,
  PollDraftError,
  type PollFailure,
  readAccountPoll,
  recordRegistration,
  REGISTERED_FAILURES,
  type RegistrationFailure,
  retryableFailure,
  retryFailedPoll,
  type RootFailure,
  type StubFailure,
  submitPollDraft,
  updatePollDraft,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The author's side of a failed poll (ADR 0032, rules 14 and 18; P2-22 part
// 5d-2): the failure is read back as its code, which apps/web words; a poll
// whose election was never registered can be retried, back to a draft with
// nothing of its setup left, or discarded; one whose election is registered
// can be neither, since its row is the election's creator record (T-68);
// and every submission counts against the daily limit for its 24 hours,
// whatever becomes of its poll (T-72).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const HOUR = 3600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const draft = (over: Partial<PollDraft> = {}): PollDraft => ({
  language: "en",
  title: "Lunch",
  description: "",
  questions: [
    {
      question: "Which day?",
      description: "",
      options: [
        { label: "Friday", description: "" },
        { label: "Monday", description: "" },
      ],
      minSelections: 0,
      maxSelections: 1,
    },
  ],
  tiers: [0],
  closesAt: NOW_S + 7n * 24n * 3600n,
  ...over,
});

// Every step's codes are listed: a code a step adds without a place here
// fails type-checking.
const everyStepFailure: readonly PollFailure[] = [] as readonly (
  | CreationFailure
  | RootFailure
  | StubFailure
  | RegistrationFailure
  | OpenFailure
)[];

let db: TestDb;
let app: Sql;
let app2: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  app2 = await db.as("abolish_app");
});
afterAll(() => db?.close());

const turnstile = { verify: async () => "passed" as const };

async function newAccount(): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  return id;
}

const submit = (account: string, id: string, now = NOW, client = app) =>
  submitPollDraft(client, account, id, { turnstile, token: "t", now });

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => {
      if (e instanceof PollDraftError) return e.code;
      throw e;
    },
  );

let block = 0;

/**
 * Moves `id` to `failed` with `failure` as far into setup as the worker
 * gets: created, checked, rooted, stubbed and with both registrations
 * recorded (`full`), or with only its creation recorded.
 */
async function fail(id: string, failure: PollFailure, full = true) {
  const creation = { creator: randomBytes(20), tx: randomBytes(32) };
  if (!full) {
    await db.admin`
      UPDATE account_polls SET state = 'failed', failure = ${failure},
        creator_address = ${creation.creator}, create_tx_hash = ${creation.tx}
      WHERE id = ${id}`;
    return undefined;
  }
  const electionId = randomBytes(32);
  await db.admin`
    UPDATE account_polls SET state = 'failed', failure = ${failure},
      creator_address = ${creation.creator}, create_tx_hash = ${creation.tx},
      election_id = ${electionId}, created_block = 5, l1_origin_timestamp = 1000,
      anchors_checked_block = 7, abandoned_ids = 2, electorate = '[]',
      stub_hash = ${randomBytes(32)}, ceremony_tx_hash = ${randomBytes(32)},
      register_tx_hash = ${randomBytes(32)}, registered_block = 9
    WHERE id = ${id}`;
  return new Uint8Array(electionId);
}

/** A submitted poll of `author`, failed with `failure`. */
async function failedPoll(author: string, failure: PollFailure = "ceremony-timeout", now = NOW) {
  const id = await createPollDraft(app, author, draft(), now);
  await submit(author, id, now);
  const electionId = await fail(id, failure);
  return { id, electionId };
}

/** Every column of `id` but its identity, its text and its times. */
const setup = async (id: string) => {
  const [r] = await db.admin`
    SELECT to_jsonb(p) - 'id' - 'user_id' - 'draft' - 'created_at' - 'updated_at' AS setup
    FROM account_polls p WHERE id = ${id}`;
  return r!["setup"];
};

const submissions = async (author: string) =>
  (
    await db.admin`SELECT count(*)::int AS n FROM account_poll_submissions WHERE user_id = ${author}`
  )[0]!["n"];

describe("the failure codes", () => {
  test("are exactly the codes the table admits", async () => {
    const [c] = await db.admin`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'account_polls_failure_check' AND connamespace = ${db.schema}::regnamespace`;
    const admitted = [...String(c!["def"]).matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1]);
    expect(admitted).toEqual([...POLL_FAILURES]);
    expect(everyStepFailure).toEqual([]);
  });

  test("only those leaving a registered election can't be retried or discarded", () => {
    expect(POLL_FAILURES.filter((f) => !retryableFailure(f))).toEqual([...REGISTERED_FAILURES]);
    expect([...REGISTERED_FAILURES].sort()).toEqual([
      "open-mismatch",
      "open-timeout",
      "registration-mismatch",
    ]);
  });

  test("a failed poll is read with its code, and no other poll has one", async () => {
    const author = await newAccount();
    const draftId = await createPollDraft(app, author, draft(), NOW);
    const { id } = await failedPoll(author, "tier-unavailable");
    expect(await readAccountPoll(app, author, id)).toMatchObject({
      state: "failed",
      failure: "tier-unavailable",
    });
    expect((await readAccountPoll(app, author, draftId))!.failure).toBeUndefined();
    expect(new Map((await listAccountPolls(app, author)).map((p) => [p.id, p.failure]))).toEqual(
      new Map([
        [draftId, undefined],
        [id, "tier-unavailable"],
      ]),
    );
  });
});

describe("account_poll_submissions", () => {
  test("the Drizzle table agrees with the migration", async () => {
    const config = getTableConfig(accountPollSubmissions);
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("is append-only for the app, and goes with its account", async () => {
    const author = await newAccount();
    const id = await createPollDraft(app, author, draft(), NOW);
    await submit(author, id);
    expect(await submissions(author)).toBe(1);
    for (const change of [
      app`UPDATE account_poll_submissions SET submitted_at = now() WHERE user_id = ${author}`,
      app`DELETE FROM account_poll_submissions WHERE user_id = ${author}`,
      app`TRUNCATE account_poll_submissions`,
    ])
      await expect(change).rejects.toThrow(/permission denied/);
    // The cascade runs as the table's owner (rule 16).
    await app`DELETE FROM account_users WHERE id = ${author}`;
    expect(await submissions(author)).toBe(0);
  });
});

describe("retryFailedPoll", () => {
  test("returns a failed poll to a draft with nothing of its setup, to submit again", async () => {
    const author = await newAccount();
    const fresh = await createPollDraft(app, author, draft(), NOW);
    const { id } = await failedPoll(author, "ceremony-timeout");
    expect(await setup(id)).not.toEqual(await setup(fresh));
    await retryFailedPoll(app, author, id, at(HOUR));
    // Every column a later migration adds is checked too: the retried row
    // must be a fresh draft's in everything setup writes.
    expect(await setup(id)).toEqual(await setup(fresh));
    expect(await readAccountPoll(app, author, id)).toEqual({
      id,
      state: "drafted",
      draft: draft(),
      createdAt: NOW,
      updatedAt: at(HOUR),
      submittedAt: undefined,
      failure: undefined,
    });
    // A draft again: edited, then submitted as a second submission.
    const later = draft({ closesAt: NOW_S + 30n * 24n * 3600n });
    await updatePollDraft(app, author, id, later, at(HOUR));
    await submit(author, id, at(HOUR));
    expect(await readAccountPoll(app, author, id)).toMatchObject({
      state: "submitted",
      submittedAt: at(HOUR),
      draft: later,
    });
    expect(await submissions(author)).toBe(2);
  });

  test("clears a poll that failed before it had an identifier", async () => {
    const author = await newAccount();
    const fresh = await createPollDraft(app, author, draft(), NOW);
    const id = await createPollDraft(app, author, draft(), NOW);
    await submit(author, id);
    await fail(id, "creation-timeout", false);
    await retryFailedPoll(app, author, id, NOW);
    expect(await setup(id)).toEqual(await setup(fresh));
  });

  test("its resubmission is judged at its own time, against the setup still ahead", async () => {
    const author = await newAccount();
    const id = await createPollDraft(app, author, draft({ closesAt: NOW_S + 2n * 3600n }), NOW);
    await submit(author, id);
    await fail(id, "ceremony-timeout");
    await retryFailedPoll(app, author, id, at(HOUR));
    expect(await code(submit(author, id, at(HOUR)))).toBe("refused");
    expect(await readAccountPoll(app, author, id)).toMatchObject({ state: "drafted" });
  });

  test("retries every failure but those that left a registered election", async () => {
    for (const failure of POLL_FAILURES) {
      // An author each, so the daily limit doesn't get in the way.
      const author = await newAccount();
      const { id } = await failedPoll(author, failure);
      const result = await code(retryFailedPoll(app, author, id, NOW));
      expect([failure, result]).toEqual([failure, retryableFailure(failure) ? "ok" : "registered"]);
      expect((await readAccountPoll(app, author, id))!.state).toBe(
        retryableFailure(failure) ? "drafted" : "failed",
      );
    }
  });

  test("refuses a poll whose identifier the registry sync saw registered, whatever its code", async () => {
    const author = await newAccount();
    const { id, electionId } = await failedPoll(author, "registration-timeout");
    await recordRegistration(app, {
      electionId: electionId!,
      definitionHash: new Uint8Array(randomBytes(32)),
      l2Block: BigInt(++block),
      logIndex: 0,
    });
    const before = await setup(id);
    expect(await code(retryFailedPoll(app, author, id, NOW))).toBe("registered");
    expect(await code(discardFailedPoll(app, author, id))).toBe("registered");
    expect(await setup(id)).toEqual(before);
  });

  test("refuses another account's poll, an unknown one and any poll not failed", async () => {
    const author = await newAccount();
    const other = await newAccount();
    const { id } = await failedPoll(author);
    expect(await code(retryFailedPoll(app, other, id, NOW))).toBe("not-found");
    expect(await code(retryFailedPoll(app, author, newAccountId(), NOW))).toBe("not-found");
    expect((await readAccountPoll(app, author, id))!.state).toBe("failed");
    const drafted = await createPollDraft(app, author, draft(), NOW);
    expect(await code(retryFailedPoll(app, author, drafted, NOW))).toBe("not-failed");
    const submitted = await createPollDraft(app, author, draft(), NOW);
    await submit(author, submitted);
    expect(await code(retryFailedPoll(app, author, submitted, NOW))).toBe("not-failed");
    const electionId = randomBytes(32);
    await db.admin`
      UPDATE account_polls SET state = 'open', creator_address = ${randomBytes(20)},
        create_tx_hash = ${randomBytes(32)}, election_id = ${electionId}, created_block = 1,
        l1_origin_timestamp = 1, anchors_checked_block = 1, electorate = '[]',
        stub_hash = ${randomBytes(32)}, ceremony_tx_hash = ${randomBytes(32)},
        register_tx_hash = ${randomBytes(32)}, registered_block = 2
      WHERE id = ${submitted}`;
    expect(await code(retryFailedPoll(app, author, submitted, NOW))).toBe("not-failed");
    // An open poll is read with its election's identifier, for its page's link.
    expect(await readAccountPoll(app, author, submitted)).toMatchObject({
      state: "open",
      electionId,
    });
  });

  test(`refuses an account already holding ${MAX_DRAFTS} drafts, however many race`, async () => {
    const author = await newAccount();
    const failed = await Promise.all([0, 1, 2].map(() => failedPoll(author)));
    for (let i = 0; i < MAX_DRAFTS - 2; i++) await createPollDraft(app, author, draft(), NOW);
    const codes = await Promise.all(
      failed.map(({ id }, i) => code(retryFailedPoll(i % 2 ? app : app2, author, id, NOW))),
    );
    expect(codes.sort()).toEqual(["ok", "ok", "too-many-drafts"]);
    const polls = await listAccountPolls(app, author);
    expect(polls.filter((p) => p.state === "drafted")).toHaveLength(MAX_DRAFTS);
    expect(polls.filter((p) => p.state === "failed")).toHaveLength(1);
  });

  test("two retries, or a retry and a discard, on separate connections: one acts", async () => {
    const author = await newAccount();
    const { id } = await failedPoll(author);
    expect(
      (
        await Promise.all([
          code(retryFailedPoll(app, author, id, NOW)),
          code(retryFailedPoll(app2, author, id, NOW)),
        ])
      ).sort(),
    ).toEqual(["not-failed", "ok"]);
    const second = await failedPoll(author);
    const raced = await Promise.all([
      code(retryFailedPoll(app, author, second.id, NOW)),
      code(discardFailedPoll(app2, author, second.id)),
    ]);
    const after = await readAccountPoll(app, author, second.id);
    // Whichever took the row first acted; the other found it moved.
    if (raced[0] === "ok") {
      expect(raced[1]).toBe("not-failed");
      expect(after!.state).toBe("drafted");
    } else {
      expect(raced).toEqual(["not-found", "ok"]);
      expect(after).toBeUndefined();
    }
  });
});

describe("discardFailedPoll", () => {
  test("deletes a failed poll of its own account only", async () => {
    const author = await newAccount();
    const other = await newAccount();
    const { id } = await failedPoll(author, "creation-reverted");
    expect(await code(discardFailedPoll(app, other, id))).toBe("not-found");
    expect(await code(discardFailedPoll(app, author, newAccountId()))).toBe("not-found");
    await discardFailedPoll(app, author, id);
    expect(await readAccountPoll(app, author, id)).toBeUndefined();
    expect(await code(discardFailedPoll(app, author, id))).toBe("not-found");
  });

  test("refuses a poll not failed, and one that left a registered election", async () => {
    const author = await newAccount();
    const drafted = await createPollDraft(app, author, draft(), NOW);
    expect(await code(discardFailedPoll(app, author, drafted))).toBe("not-failed");
    const submitted = await createPollDraft(app, author, draft(), NOW);
    await submit(author, submitted);
    expect(await code(discardFailedPoll(app, author, submitted))).toBe("not-failed");
    for (const failure of REGISTERED_FAILURES) {
      const { id } = await failedPoll(author, failure);
      const before = await setup(id);
      expect(await code(discardFailedPoll(app, author, id))).toBe("registered");
      expect(await setup(id)).toEqual(before);
    }
    expect(await listAccountPolls(app, author)).toHaveLength(2 + REGISTERED_FAILURES.length);
  });
});

describe("the daily limit", () => {
  test(`a discarded poll's submission still counts for its 24 hours`, async () => {
    const author = await newAccount();
    for (let i = 0; i < MAX_SUBMISSIONS_PER_DAY; i++) {
      const { id } = await failedPoll(author, "creation-timeout");
      await discardFailedPoll(app, author, id);
    }
    expect(await listAccountPolls(app, author)).toEqual([]);
    const next = await createPollDraft(app, author, draft(), NOW);
    // Counted while less than 24 hours old.
    expect(await code(submit(author, next, at(24 * HOUR - 1)))).toBe("too-many-today");
    expect(await code(submit(author, next, at(24 * HOUR)))).toBe("ok");
  });

  test("each retry's submission counts, so one poll can't be set up again past the limit", async () => {
    const author = await newAccount();
    const id = await createPollDraft(app, author, draft(), NOW);
    for (let i = 0; i < MAX_SUBMISSIONS_PER_DAY; i++) {
      const now = at(i * 60_000);
      expect(await code(submit(author, id, now))).toBe("ok");
      await fail(id, "tier-unavailable");
      await retryFailedPoll(app, author, id, now);
    }
    expect(await code(submit(author, id, at(23 * HOUR)))).toBe("too-many-today");
    expect(await readAccountPoll(app, author, id)).toMatchObject({ state: "drafted" });
    expect(await code(submit(author, id, at(24 * HOUR + 1)))).toBe("ok");
    expect(await submissions(author)).toBe(MAX_SUBMISSIONS_PER_DAY + 1);
  });

  test("counts the submissions made before its migration", async () => {
    // A database at 0021 with a submitted poll, then migrated on.
    const schema = `t_${randomBytes(8).toString("hex")}`;
    await db.admin.unsafe(`CREATE SCHEMA "${schema}" AUTHORIZATION abolish_migrator`);
    try {
      const migrator = await db.as("abolish_migrator");
      const all = loadMigrations();
      await migrate(
        migrator,
        schema,
        all.slice(
          0,
          all.findIndex((m) => m.name === "0022_poll_submissions.sql"),
        ),
      );
      const author = newAccountId();
      await db.admin.unsafe(
        `INSERT INTO "${schema}".account_users VALUES ($1, $2, false, '', NULL, now(), now())`,
        [author, `${author}@account.invalid`],
      );
      await db.admin.unsafe(
        `INSERT INTO "${schema}".account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at)
         VALUES ($1, $2, 'submitted', '{}', now(), now(), $3), ($4, $2, 'drafted', '{}', now(), now(), NULL)`,
        [newAccountId(), author, NOW, newAccountId()],
      );
      await migrate(migrator, schema, all);
      const rows = await db.admin.unsafe(
        `SELECT user_id, submitted_at FROM "${schema}".account_poll_submissions`,
      );
      expect(rows.map((r) => [r["user_id"], r["submitted_at"]])).toEqual([[author, NOW]]);
    } finally {
      await db.admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});

describe("a poll's life from the author's side", () => {
  type Op =
    | { kind: "submit"; poll: number; minutes: number }
    | { kind: "fail"; poll: number; failure: PollFailure }
    | { kind: "retry"; poll: number }
    | { kind: "discard"; poll: number }
    | { kind: "create" };

  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      kind: fc.constant("submit" as const),
      poll: fc.nat(3),
      minutes: fc.integer({ min: 0, max: 12 * 60 }),
    }),
    fc.record({
      kind: fc.constant("fail" as const),
      poll: fc.nat(3),
      failure: fc.constantFrom(...POLL_FAILURES),
    }),
    fc.record({ kind: fc.constant("retry" as const), poll: fc.nat(3) }),
    fc.record({ kind: fc.constant("discard" as const), poll: fc.nat(3) }),
    fc.record({ kind: fc.constant("create" as const) }),
  );

  test("only failed polls move back, each submission counts for 24 hours, and the limit holds", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 16 }), async (ops) => {
        const author = await newAccount();
        const ids: string[] = [];
        // The model: each poll's state and failure, and every submission's time.
        const model = new Map<string, { state: string; failure?: PollFailure }>();
        const sent: number[] = [];
        let clock = 0;
        const pick = (i: number) => ids[i % Math.max(ids.length, 1)];
        for (const o of ops) {
          if (o.kind === "create" || ids.length === 0) {
            const id = await createPollDraft(app, author, draft(), at(clock));
            ids.push(id);
            model.set(id, { state: "drafted" });
            if (o.kind === "create") continue;
          }
          const id = pick(o.poll)!;
          const m = model.get(id);
          if (o.kind === "submit") {
            clock += o.minutes * 60_000;
            const inSetup = [...model.values()].filter((p) => p.state === "submitted").length;
            const today = sent.filter((t) => t > clock - 24 * HOUR).length;
            const expected =
              m === undefined
                ? "not-found"
                : m.state !== "drafted"
                  ? "not-editable"
                  : inSetup >= 3
                    ? "too-many-in-setup"
                    : today >= MAX_SUBMISSIONS_PER_DAY
                      ? "too-many-today"
                      : "ok";
            expect(await code(submit(author, id, at(clock)))).toBe(expected);
            if (expected === "ok") {
              sent.push(clock);
              model.set(id, { state: "submitted" });
            }
          } else if (o.kind === "fail") {
            // The worker fails only polls in setup.
            if (m?.state !== "submitted") continue;
            await fail(id, o.failure);
            model.set(id, { state: "failed", failure: o.failure });
          } else {
            const expected =
              m === undefined
                ? "not-found"
                : m.state !== "failed"
                  ? "not-failed"
                  : !retryableFailure(m.failure!)
                    ? "registered"
                    : "ok";
            const result =
              o.kind === "retry"
                ? await code(retryFailedPoll(app, author, id, at(clock)))
                : await code(discardFailedPoll(app, author, id));
            // At most MAX_DRAFTS drafts: this model never makes that many.
            expect(result).toBe(expected);
            if (expected === "ok")
              if (o.kind === "retry") model.set(id, { state: "drafted" });
              else model.delete(id);
          }
        }
        const polls = await listAccountPolls(app, author);
        expect(new Map(polls.map((p) => [p.id, { state: p.state, failure: p.failure }]))).toEqual(
          new Map([...model].map(([id, p]) => [id, { state: p.state, failure: p.failure }])),
        );
        expect(await submissions(author)).toBe(sent.length);
        // No window of 24 hours holds more submissions than the limit.
        for (const t of sent)
          expect(sent.filter((u) => u > t - 24 * HOUR && u <= t).length).toBeLessThanOrEqual(
            MAX_SUBMISSIONS_PER_DAY,
          );
      }),
      { numRuns: Math.min(numRuns, 50), verbose: true },
    );
  });
});
