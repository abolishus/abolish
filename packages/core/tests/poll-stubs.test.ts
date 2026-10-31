import {
  decodeDisplayTextV2,
  decodeElectionDefinitionV5,
  displayTextV2Rule,
  electionDefinitionV5Rule,
  electionStubV5Hash,
  identityKey,
  membershipVkHash,
  panelId,
  profileCombinationRule,
  QUESTION_METHODS,
  tierTreeRoot,
} from "@abolishus/crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  ceremonyStubs,
  createPollDraft,
  MIN_OPEN_SECONDS,
  newAccountId,
  POLL_DEFINITION_PROFILE,
  type PollDraft,
  pollDraftProblem,
  type PollStubDeployment,
  pollStubDeploymentRule,
  REGISTRATION_MARGIN_SECONDS,
  SETUP_SECONDS,
  type StoredTierElectorate,
  stubPolls,
  STUBS_PER_POLL,
  STUBS_PER_RUN,
  submitPollDraft,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The stub step (ADR 0032, rules 7, 8, 10 and 11; P2-22 part 4a): a rooted
// poll gets a version-5 stub of its draft, its electorate and the
// deployment's pins, opening SETUP_SECONDS from the run, with display text
// that opens its commitment; the stub and the text are recorded for the
// coordinator and the poll moves to `ceremony`. Every stub is checked here
// by crypto's own decoders and rules, the ones the registry's checks and the
// verifier's 2.1 to 2.3 mirror, never by comparing with this module's
// output alone.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const OPENS_AT = NOW_S + BigInt(SETUP_SECONDS);

const address = (b: number) => new Uint8Array(20).fill(b);
const key = (b: number) => identityKey(new Uint8Array(32).fill(b));
const ascending = (keys: Uint8Array[]) =>
  keys.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));

/** A compressed key with x = 1, below p: 1 − 3 + b is a non-residue mod p, so no point has it. */
const OFF_CURVE = Uint8Array.of(2, ...new Uint8Array(31), 1);

const DEPLOYMENT: PollStubDeployment = {
  l2ChainId: 84532n,
  l1ChainId: 11155111n,
  electionRegistry: address(0xa1),
  board: address(0xa2),
  trusteeRegistry: address(0xa3),
  groupRegistry: address(0xa4),
  l1Anchor: address(0xb1),
  l1Relay: address(0xb2),
  panel: { threshold: 2, keys: [key(1), key(2), key(3)] },
  receiptKeys: ascending([key(9), key(8)]),
  l1InclusionBound: 3600,
  sequencingWindow: 3600n,
  maxSequencerDrift: 1800n,
};

const ELECTORATE: StoredTierElectorate[] = [
  {
    tier: 0,
    rootL2Block: "500",
    groups: [
      { groupId: "1", region: 0 },
      { groupId: "2", region: 0 },
    ],
    regions: ["3"],
    cells: [{ root: tierTreeRoot([11n, 12n, 13n]).toString(), members: "3" }],
  },
];

const draft = (over: Partial<PollDraft> = {}): PollDraft => ({
  language: "en",
  title: "Lunch",
  description: "For the office.",
  questions: [
    {
      question: "Which day?",
      description: "",
      options: [
        { label: "Friday", description: "" },
        { label: "Monday", description: "The start of the week." },
      ],
      minSelections: 0,
      maxSelections: 1,
    },
    {
      question: "Which food?",
      description: "Any you'd eat.",
      options: [
        { label: "Soup", description: "" },
        { label: "Salad", description: "" },
        { label: "Bread", description: "" },
      ],
      minSelections: 1,
      maxSelections: 3,
    },
  ],
  tiers: [0],
  closesAt: NOW_S + 7n * 24n * 3600n,
  ...over,
});

let db: TestDb;
let app: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin`DELETE FROM account_polls`;
  await db.admin`DELETE FROM ceremony_stubs`;
});

/** A submitted poll moved through creation, the per-slot check and the roots, as the earlier steps leave it. */
async function rooted(
  over: Partial<PollDraft> = {},
  electorate: StoredTierElectorate[] = ELECTORATE,
  seen = 60,
): Promise<{ id: string; electionId: Uint8Array }> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  // Submitted an hour before the run, so a draft can close as soon as the
  // stub's opening allows without being refused at submission.
  const submittedAt = new Date(NOW.getTime() - 3600_000);
  const id = await createPollDraft(app, author, draft(over), submittedAt);
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: submittedAt,
  });
  const electionId = randomBytes(32);
  await db.admin`
    UPDATE account_polls SET state = 'rooted', creator_address = ${new Uint8Array(20).fill(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${electionId}, created_block = 7,
      l1_origin_timestamp = 1, anchors_checked_block = 9, electorate = ${db.admin.json(electorate as never)},
      updated_at = ${new Date(NOW.getTime() - seen * 1000)}
    WHERE id = ${id}`;
  return { id, electionId };
}

const row = async (id: string) => {
  const [r] = await db.admin`SELECT state, failure, stub_hash FROM account_polls WHERE id = ${id}`;
  return r!;
};

const stubs = () =>
  db.admin`SELECT stub_hash, election_id, stub, display_text, opens_at, created_at
    FROM ceremony_stubs ORDER BY created_at, stub_hash`;

const run = (d: PollStubDeployment = DEPLOYMENT, now = NOW) => stubPolls(app, d, { now });

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("stubPolls", () => {
  test("records a stub of the draft, the electorate and the pins, and moves the poll to `ceremony`", async () => {
    const { id, electionId } = await rooted();
    expect(await run()).toEqual({ stubbed: 1, restubbed: 0, failed: {} });
    const [s, ...rest] = await stubs();
    expect(rest).toEqual([]);
    const stub = decodeElectionDefinitionV5(s!["stub"]);
    // The registry's rules and 2.3's, from crypto.
    expect(electionDefinitionV5Rule(stub)).toBeUndefined();
    expect(profileCombinationRule(stub)).toBeUndefined();
    expect(Buffer.from(s!["stub_hash"])).toEqual(Buffer.from(electionStubV5Hash(stub)));
    expect(await row(id)).toEqual({ state: "ceremony", failure: null, stub_hash: s!["stub_hash"] });
    expect(Buffer.from(s!["election_id"])).toEqual(electionId);
    expect(s!["opens_at"]).toBe(OPENS_AT.toString());
    expect(s!["created_at"]).toEqual(NOW);
    const { display_text_commitment, ...fields } = stub;
    expect(display_text_commitment).toHaveLength(32);
    expect(fields).toEqual({
      profile: {
        protocol_major: 1,
        pins: [
          [1, 5],
          [2, 3],
          [3, 2],
          [4, 1],
          [5, 1],
          [6, 1],
          [7, 5],
          [8, 13],
          [9, 2],
        ].map(([record_type, version]) => ({ record_type, version })),
      },
      election_id: Uint8Array.from(electionId),
      l2_chain_id: 84532n,
      l1_chain_id: 11155111n,
      election_registry: address(0xa1),
      board: address(0xa2),
      trustee_registry: address(0xa3),
      group_registry: address(0xa4),
      l1_anchor: address(0xb1),
      l1_relay: address(0xb2),
      questions: [
        {
          method: QUESTION_METHODS.selection,
          option_count: 2,
          min_selections: 0,
          max_selections: 1,
        },
        {
          method: QUESTION_METHODS.selection,
          option_count: 3,
          min_selections: 1,
          max_selections: 3,
        },
      ],
      tally_scheme: 1,
      electorate: [
        {
          tier: 0,
          root_l2_block: 500n,
          groups: [
            { group_id: 1n, region: 0 },
            { group_id: 2n, region: 0 },
          ],
          regions: [3n],
          cells: [{ root: tierTreeRoot([11n, 12n, 13n]), members: 3n }],
        },
      ],
      membership_vk_hash: membershipVkHash(),
      panel_id: panelId(DEPLOYMENT.panel),
      threshold: 2,
      panel_size: 3,
      ceremony_transcript_hash: new Uint8Array(32),
      opens_at: OPENS_AT,
      closes_at: draft().closesAt,
      l1_inclusion_bound: 3600,
      sequencing_window: 3600n,
      max_sequencer_drift: 1800n,
      receipt_keys: DEPLOYMENT.receiptKeys,
    });
    // The display text opens the commitment and is the draft, field for field.
    const text = decodeDisplayTextV2(s!["display_text"], stub);
    expect(displayTextV2Rule(text, stub)).toBeUndefined();
    expect(text.translations).toEqual([
      {
        language: utf8("en"),
        title: utf8("Lunch"),
        description: utf8("For the office."),
        questions: draft().questions.map((q) => ({
          question: utf8(q.question),
          description: utf8(q.description),
          options: q.options.map((o) => ({
            label: utf8(o.label),
            description: utf8(o.description),
          })),
        })),
      },
    ]);
    // Nothing left: the next run records nothing.
    expect(await run()).toEqual({ stubbed: 0, restubbed: 0, failed: {} });
    expect(await stubs()).toHaveLength(1);
  });

  test("salts every stub's display text afresh", async () => {
    await rooted();
    await rooted();
    expect(await run()).toEqual({ stubbed: 2, restubbed: 0, failed: {} });
    const [a, b] = await stubs();
    const commitment = (s: typeof a) =>
      Buffer.from(decodeElectionDefinitionV5(s!["stub"]).display_text_commitment);
    expect(commitment(a)).not.toEqual(commitment(b));
    const salt = (s: typeof a) =>
      Buffer.from(
        decodeDisplayTextV2(s!["display_text"], decodeElectionDefinitionV5(s!["stub"])).salt,
      );
    expect(salt(a)).not.toEqual(salt(b));
  });

  test("fails `closes-too-soon` a poll that would be open under MIN_OPEN_SECONDS, at its edge", async () => {
    const edge = OPENS_AT + BigInt(MIN_OPEN_SECONDS);
    const ok = await rooted({ closesAt: edge });
    const late = await rooted({ closesAt: edge - 1n });
    expect(await run()).toEqual({ stubbed: 1, restubbed: 0, failed: { "closes-too-soon": 1 } });
    expect((await row(ok.id)).state).toBe("ceremony");
    expect(await row(late.id)).toEqual({
      state: "failed",
      failure: "closes-too-soon",
      stub_hash: null,
    });
    expect(await stubs()).toHaveLength(1);
  });

  test("fails `stub-refused` a poll whose stub breaks a definition rule, recording nothing", async () => {
    // A cell count the regions don't fold to: the registry would refuse it (`cells`).
    const { id } = await rooted({}, [
      { ...ELECTORATE[0]!, cells: [{ root: ELECTORATE[0]!.cells[0]!.root, members: "4" }] },
    ]);
    expect(await run()).toEqual({ stubbed: 0, restubbed: 0, failed: { "stub-refused": 1 } });
    expect(await row(id)).toEqual({ state: "failed", failure: "stub-refused", stub_hash: null });
    expect(await stubs()).toEqual([]);
  });

  test("fails `stub-refused` a poll holding a value with no encoding, and stubs the rest", async () => {
    // A member count past u64: no codec writes it.
    const bad = await rooted({}, [
      {
        ...ELECTORATE[0]!,
        regions: [(1n << 64n).toString()],
        cells: [{ root: ELECTORATE[0]!.cells[0]!.root, members: (1n << 64n).toString() }],
      },
    ]);
    const good = await rooted({}, ELECTORATE, 30);
    expect(await run()).toEqual({ stubbed: 1, restubbed: 0, failed: { "stub-refused": 1 } });
    expect((await row(bad.id)).failure).toBe("stub-refused");
    expect((await row(good.id)).state).toBe("ceremony");
  });

  test("leaves every poll not yet rooted, and takes the oldest STUBS_PER_RUN first", async () => {
    const waiting = await rooted();
    await db.admin`UPDATE account_polls SET state = 'created', electorate = NULL WHERE id = ${waiting.id}`;
    expect(await run()).toEqual({ stubbed: 0, restubbed: 0, failed: {} });
    expect((await row(waiting.id)).state).toBe("created");
    const polls = [];
    for (let i = 0; i <= STUBS_PER_RUN; i++) polls.push(await rooted({}, ELECTORATE, 600 - i));
    expect(await run()).toEqual({ stubbed: STUBS_PER_RUN, restubbed: 0, failed: {} });
    // The newest waits for the next run.
    expect((await row(polls.at(-1)!.id)).state).toBe("rooted");
    expect((await row(polls[0]!.id)).state).toBe("ceremony");
    expect(await run()).toEqual({ stubbed: 1, restubbed: 0, failed: {} });
  });

  test("records one stub per poll when runs race on separate connections", async () => {
    const polls = [await rooted(), await rooted(), await rooted()];
    const other = await db.as("abolish_app");
    const reports = await Promise.all([
      stubPolls(app, DEPLOYMENT, { now: NOW }),
      stubPolls(other, DEPLOYMENT, { now: NOW }),
    ]);
    expect(reports.reduce((n, r) => n + r.stubbed, 0)).toBe(3);
    const recorded = await stubs();
    expect(recorded).toHaveLength(3);
    for (const p of polls) {
      const r = await row(p.id);
      expect(r["state"]).toBe("ceremony");
      const mine = recorded.filter((s) => Buffer.from(s["stub_hash"]).equals(r["stub_hash"]));
      expect(mine).toHaveLength(1);
      expect(Buffer.from(mine[0]!["election_id"])).toEqual(p.electionId);
    }
  });

  test("any draft submission accepts gets a stub crypto's rules accept, its text the draft's", async () => {
    const text = fc.string({ maxLength: 12, unit: "grapheme" });
    const arbitraryDraft = fc.record({
      language: fc.constantFrom("en", "fr", "pt-br"),
      title: text.filter((t) => t.length > 0),
      description: text,
      questions: fc.array(
        fc.record({
          question: text.filter((t) => t.length > 0),
          description: text,
          options: fc.array(
            fc.record({ label: text.filter((t) => t.length > 0), description: text }),
            { minLength: 2, maxLength: 6 },
          ),
          minSelections: fc.integer({ min: 0, max: 6 }),
          maxSelections: fc.integer({ min: 1, max: 6 }),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      closesAt: fc.bigInt({
        min: OPENS_AT + BigInt(MIN_OPEN_SECONDS),
        max: NOW_S + 300n * 24n * 3600n,
      }),
    });
    await fc.assert(
      fc.asyncProperty(arbitraryDraft, async (over) => {
        if (pollDraftProblem(draft(over), NOW_S - 3600n) !== undefined) return;
        await db.admin`DELETE FROM account_polls`;
        await db.admin`DELETE FROM ceremony_stubs`;
        await rooted(over);
        expect(await run()).toEqual({ stubbed: 1, restubbed: 0, failed: {} });
        const [s] = await stubs();
        const stub = decodeElectionDefinitionV5(s!["stub"]);
        expect(electionDefinitionV5Rule(stub)).toBeUndefined();
        expect(profileCombinationRule(stub)).toBeUndefined();
        expect(stub.closes_at).toBe(over.closesAt);
        expect(
          stub.questions.map((q) => [q.option_count, q.min_selections, q.max_selections]),
        ).toEqual(over.questions.map((q) => [q.options.length, q.minSelections, q.maxSelections]));
        const shown = decodeDisplayTextV2(s!["display_text"], stub);
        expect(displayTextV2Rule(shown, stub)).toBeUndefined();
        const decode = (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b);
        const [t] = shown.translations;
        expect({
          language: decode(t!.language),
          title: decode(t!.title),
          description: decode(t!.description),
          questions: t!.questions.map((q) => ({
            question: decode(q.question),
            description: decode(q.description),
            options: q.options.map((o) => ({
              label: decode(o.label),
              description: decode(o.description),
            })),
          })),
        }).toEqual({
          language: over.language,
          title: over.title,
          description: over.description,
          questions: over.questions.map((q) => ({
            question: q.question,
            description: q.description,
            options: q.options,
          })),
        });
      }),
      { numRuns: Math.min(numRuns, 40) },
    );
  });
});

describe("rule 10's retry", () => {
  /** The run's time at which a stub opening at `opensAt` is within REGISTRATION_MARGIN_SECONDS. */
  const marginOf = (opensAt: bigint) =>
    new Date(Number(opensAt - BigInt(REGISTRATION_MARGIN_SECONDS)) * 1000);
  const stubOf = (id: string) => db.admin`
    SELECT s.stub_hash, s.stub, s.display_text, s.opens_at FROM ceremony_stubs s
      JOIN account_polls p ON p.stub_hash = s.stub_hash WHERE p.id = ${id}`;

  test("gives a poll a new stub for its identifier once its registration can't be signed, at the margin's edge", async () => {
    const { id, electionId } = await rooted();
    await run();
    const [first] = await stubOf(id);
    const edge = marginOf(OPENS_AT);
    // A second before the edge, the registration step may still sign.
    expect(await run(DEPLOYMENT, new Date(edge.getTime() - 1000))).toEqual({
      stubbed: 0,
      restubbed: 0,
      failed: {},
    });
    expect(await stubs()).toHaveLength(1);
    expect(await run(DEPLOYMENT, edge)).toEqual({ stubbed: 0, restubbed: 1, failed: {} });
    const [second] = await stubOf(id);
    expect(Buffer.from(second!["stub_hash"])).not.toEqual(Buffer.from(first!["stub_hash"]));
    expect(await row(id)).toEqual({
      state: "ceremony",
      failure: null,
      stub_hash: second!["stub_hash"],
    });
    // Both kept, for the same identifier: the first may already be in a seat's hands.
    const recorded = await stubs();
    expect(recorded).toHaveLength(2);
    for (const s of recorded) expect(Buffer.from(s["election_id"])).toEqual(electionId);
    // The new stub is the first with a later opening and a fresh salt, and
    // passes the same rules.
    const reopened = BigInt(edge.getTime() / 1000) + BigInt(SETUP_SECONDS);
    expect(second!["opens_at"]).toBe(reopened.toString());
    const a = decodeElectionDefinitionV5(first!["stub"]);
    const b = decodeElectionDefinitionV5(second!["stub"]);
    expect(electionDefinitionV5Rule(b)).toBeUndefined();
    expect(profileCombinationRule(b)).toBeUndefined();
    expect(Buffer.from(second!["stub_hash"])).toEqual(Buffer.from(electionStubV5Hash(b)));
    expect(b.opens_at).toBe(reopened);
    expect(Buffer.from(b.display_text_commitment)).not.toEqual(
      Buffer.from(a.display_text_commitment),
    );
    const { opens_at: _a, display_text_commitment: _ac, ...restA } = a;
    const { opens_at: _b, display_text_commitment: _bc, ...restB } = b;
    expect(restB).toEqual(restA);
    const text = decodeDisplayTextV2(second!["display_text"], b);
    expect(displayTextV2Rule(text, b)).toBeUndefined();
    expect(text.translations).toEqual(decodeDisplayTextV2(first!["display_text"], a).translations);
    // The new stub isn't late: the next run at the same time leaves it.
    expect(await run(DEPLOYMENT, edge)).toEqual({ stubbed: 0, restubbed: 0, failed: {} });
  });

  test("leaves a poll whose registration is recorded, however late", async () => {
    const { id } = await rooted();
    await run();
    await db.admin`
      UPDATE account_polls SET ceremony_tx_hash = ${randomBytes(32)},
        register_tx_hash = ${randomBytes(32)} WHERE id = ${id}`;
    const [before] = await stubOf(id);
    expect(await run(DEPLOYMENT, marginOf(OPENS_AT + 3600n))).toEqual({
      stubbed: 0,
      restubbed: 0,
      failed: {},
    });
    expect((await row(id)).stub_hash).toEqual(before!["stub_hash"]);
    expect(await stubs()).toHaveLength(1);
  });

  test("fails `ceremony-timeout` after STUBS_PER_POLL stubs, keeping the last", async () => {
    const { id } = await rooted({ closesAt: NOW_S + 30n * 24n * 3600n });
    await run();
    let opensAt = OPENS_AT;
    for (let i = 1; i < STUBS_PER_POLL; i++) {
      const at = marginOf(opensAt);
      expect(await run(DEPLOYMENT, at)).toEqual({ stubbed: 0, restubbed: 1, failed: {} });
      opensAt = BigInt(at.getTime() / 1000) + BigInt(SETUP_SECONDS);
    }
    expect(await stubs()).toHaveLength(STUBS_PER_POLL);
    const [last] = await stubOf(id);
    expect(await run(DEPLOYMENT, marginOf(opensAt))).toEqual({
      stubbed: 0,
      restubbed: 0,
      failed: { "ceremony-timeout": 1 },
    });
    expect(await row(id)).toEqual({
      state: "failed",
      failure: "ceremony-timeout",
      stub_hash: last!["stub_hash"],
    });
    expect(await stubs()).toHaveLength(STUBS_PER_POLL);
    // Failed, it is never taken again.
    expect(await run(DEPLOYMENT, marginOf(opensAt + 3600n))).toEqual({
      stubbed: 0,
      restubbed: 0,
      failed: {},
    });
  });

  test("fails `closes-too-soon` a poll the new stub would leave open under MIN_OPEN_SECONDS, at its edge", async () => {
    const at = marginOf(OPENS_AT);
    const reopened = BigInt(at.getTime() / 1000) + BigInt(SETUP_SECONDS);
    const edge = reopened + BigInt(MIN_OPEN_SECONDS);
    const ok = await rooted({ closesAt: edge });
    const late = await rooted({ closesAt: edge - 1n });
    expect(await run()).toEqual({ stubbed: 2, restubbed: 0, failed: {} });
    const [kept] = await stubOf(late.id);
    expect(await run(DEPLOYMENT, at)).toEqual({
      stubbed: 0,
      restubbed: 1,
      failed: { "closes-too-soon": 1 },
    });
    expect((await row(ok.id)).state).toBe("ceremony");
    expect(await row(late.id)).toEqual({
      state: "failed",
      failure: "closes-too-soon",
      stub_hash: kept!["stub_hash"],
    });
    expect(await stubs()).toHaveLength(3);
  });

  test("takes the earliest opening first, STUBS_PER_RUN a run", async () => {
    for (let i = 0; i < STUBS_PER_RUN; i++) await rooted({}, ELECTORATE, 600 - i);
    expect(await run()).toEqual({ stubbed: STUBS_PER_RUN, restubbed: 0, failed: {} });
    const later = new Date(NOW.getTime() + 600_000);
    const last = await rooted();
    expect(await run(DEPLOYMENT, later)).toEqual({ stubbed: 1, restubbed: 0, failed: {} });
    const [before] = await stubOf(last.id);
    // Every stub is late at the margin of the last one's opening; it opens
    // last, so it waits for the next run.
    const at = marginOf(BigInt(later.getTime() / 1000) + BigInt(SETUP_SECONDS));
    expect(await run(DEPLOYMENT, at)).toEqual({
      stubbed: 0,
      restubbed: STUBS_PER_RUN,
      failed: {},
    });
    expect((await stubOf(last.id))[0]!["stub_hash"]).toEqual(before!["stub_hash"]);
    expect(await run(DEPLOYMENT, at)).toEqual({ stubbed: 0, restubbed: 1, failed: {} });
    expect(await run(DEPLOYMENT, at)).toEqual({ stubbed: 0, restubbed: 0, failed: {} });
  });

  test("gives one new stub when runs race on separate connections", async () => {
    const polls = [await rooted(), await rooted(), await rooted()];
    await run();
    const other = await db.as("abolish_app");
    const at = marginOf(OPENS_AT);
    const reports = await Promise.all([
      stubPolls(app, DEPLOYMENT, { now: at }),
      stubPolls(other, DEPLOYMENT, { now: at }),
    ]);
    expect(reports.reduce((n, r) => n + r.restubbed, 0)).toBe(3);
    const recorded = await stubs();
    expect(recorded).toHaveLength(6);
    for (const p of polls) {
      const mine = recorded.filter((s) => Buffer.from(s["election_id"]).equals(p.electionId));
      expect(mine).toHaveLength(2);
      const [current] = await stubOf(p.id);
      expect(BigInt(current!["opens_at"])).toBe(
        BigInt(at.getTime() / 1000) + BigInt(SETUP_SECONDS),
      );
    }
  });
});

describe("pollStubDeploymentRule", () => {
  test("accepts the deployment every stub above was built under, and the profile is 2.3's", () => {
    expect(pollStubDeploymentRule(DEPLOYMENT)).toBeUndefined();
    expect(POLL_DEFINITION_PROFILE.pins.map((p) => p.record_type)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });

  test("refuses each setting the registry would refuse, naming the rule", () => {
    const refused = (over: Partial<PollStubDeployment>) =>
      pollStubDeploymentRule({ ...DEPLOYMENT, ...over });
    expect(refused({ panel: { threshold: 1, keys: [key(1), key(2)] } })).toBe("panel");
    expect(refused({ panel: { threshold: 2, keys: [key(1), key(1)] } })).toBe("panel");
    expect(refused({ l1ChainId: DEPLOYMENT.l2ChainId })).toBe("chain");
    expect(refused({ l2ChainId: 0n })).toBe("chain");
    expect(refused({ l1Relay: address(0) })).toBe("chain");
    expect(refused({ board: address(0xa1) })).toBe("chain");
    expect(refused({ receiptKeys: [] })).toBe("receipt-keys");
    expect(refused({ receiptKeys: [...DEPLOYMENT.receiptKeys].reverse() })).toBe("receipt-keys");
    // Registration rule 6's bounds, at each edge.
    expect(refused({ l1InclusionBound: 600 })).toBeUndefined();
    expect(refused({ l1InclusionBound: 599 })).toBe("sequencing");
    expect(refused({ l1InclusionBound: 3601 })).toBe("sequencing");
    expect(refused({ sequencingWindow: 3601n })).toBe("sequencing");
    expect(refused({ maxSequencerDrift: 1801n })).toBe("sequencing");
    expect(refused({ board: new Uint8Array(19).fill(0xa2) })).toBe("encoding");
    // Off the curve, then x ≥ p: no canonical point either way.
    expect(refused({ receiptKeys: [OFF_CURVE] })).toBe("encoding");
    expect(refused({ receiptKeys: [Uint8Array.of(2, ...new Uint8Array(32).fill(0xff))] })).toBe(
      "encoding",
    );
  });
});

describe("ceremony_stubs and account_polls' stub", () => {
  test("ceremony_stubs' Drizzle table agrees with the migration", async () => {
    const config = getTableConfig(ceremonyStubs);
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("keep stubs append-only and whole", async () => {
    await rooted();
    await run();
    await expect(app`UPDATE ceremony_stubs SET opens_at = 0`).rejects.toThrow(/permission/);
    await expect(app`DELETE FROM ceremony_stubs`).rejects.toThrow(/permission/);
    const [s] = await stubs();
    const insert = (stub: Uint8Array, text: Uint8Array) =>
      app`INSERT INTO ceremony_stubs VALUES (${randomBytes(32)}, ${randomBytes(32)}, ${stub},
        ${text}, 1, now())`;
    // Another record type, or definition version, as a stub; display text version 1 as the text.
    await expect(insert(Uint8Array.of(0, 9, 2, 0), s!["display_text"])).rejects.toThrow(/check/);
    await expect(insert(Uint8Array.of(0, 1, 4, 0), s!["display_text"])).rejects.toThrow(/check/);
    await expect(insert(s!["stub"], Uint8Array.of(0, 9, 1, 0))).rejects.toThrow(/check/);
  });

  test("refuse `ceremony` without a stub, and a stub before `ceremony` or without an electorate", async () => {
    const { id } = await rooted();
    await expect(app`UPDATE account_polls SET state = 'ceremony' WHERE id = ${id}`).rejects.toThrow(
      /check/,
    );
    await expect(
      app`UPDATE account_polls SET stub_hash = ${randomBytes(32)} WHERE id = ${id}`,
    ).rejects.toThrow(/check/);
    await run();
    await expect(app`UPDATE account_polls SET electorate = NULL WHERE id = ${id}`).rejects.toThrow(
      /check/,
    );
    await expect(app`UPDATE account_polls SET stub_hash = NULL WHERE id = ${id}`).rejects.toThrow(
      /check/,
    );
    // A failed poll keeps the stub it failed with, but never without its electorate.
    await app`UPDATE account_polls SET state = 'failed', failure = 'stub-refused' WHERE id = ${id}`;
    expect((await row(id)).stub_hash).not.toBeNull();
    await expect(app`UPDATE account_polls SET electorate = NULL WHERE id = ${id}`).rejects.toThrow(
      /account_polls_stub/,
    );
  });
});
