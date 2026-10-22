import {
  displayTextCommitment,
  encodeDisplayText,
  encodeElectionDefinition,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  insertPollTags,
  type ListingOrder,
  type ListingTags,
  listPolls,
  MAX_LISTING_PAGE,
  MAX_PLACE_LENGTH,
  moderate,
  placeIsWellFormed,
  ModerationError,
  type ModerationErrorCode,
  moderationStatus,
  newAccountId,
  placeKey,
  POLL_TOPICS,
  type PollTags,
  pollTagActions,
  pollTags,
  readModerationLog,
  readPollTags,
  readProfileModerationLog,
  readPublicModerationLog,
  MAX_MODERATION_PAGE,
  type RefileDecision,
  REFILE_REASONS,
  refilePoll,
  storedPollTags,
  searchTerms,
  storeDefinition,
  storeDisplayText,
} from "../src/index.ts";
import { addModerators, type TestDb, testDb, typical } from "./db.ts";

// A poll's listing tags (src/poll-tags.ts, migrations/0035;
// [[0041-poll-topics-and-places]]; P2-26 part 1c; T-10, T-67, T-68): the
// topic and place its author chose, kept beside the definition, filter the
// listing's orders without ranking anything, and delisted or hidden polls
// stay out of every filter. Only moderation refiles a poll once it is filed,
// in the moderation log (migrations/0036). The opening step's write and the
// fill are tested with the step (poll-opening.test.ts).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
let moderators: Map<string, string>;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  moderators = await addModerators(app, "mod-1", "mod-2");
});
afterAll(() => db?.close());

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * A stored version-1 poll asking `question`, with its display text and the
 * tags given. The typical vector's poll was open in the first week of
 * January 2026, so the open orders are asked at its `opens_at`.
 */
async function poll(tags: PollTags, question = "Should the pool open in May?") {
  const id = new Uint8Array(randomBytes(32));
  const text = {
    salt: new Uint8Array(randomBytes(32)),
    translations: [
      {
        language: bytes("en"),
        question: bytes(question),
        description: new Uint8Array(0),
        options: ["Yes", "No", "Abstain"].map((l) => ({
          label: bytes(l),
          description: new Uint8Array(0),
        })),
      },
    ],
  };
  await storeDefinition(
    app,
    encodeElectionDefinition({
      ...typical,
      election_id: id,
      display_text_commitment: displayTextCommitment(text),
    }),
  );
  await storeDisplayText(app, id, encodeDisplayText(text));
  await insertPollTags(app, id, tags);
  return id;
}

const open: ListingOrder = { sort: "closing", now: typical.opens_at };

/** Every poll listed under `order` with `tags`, as hex, a page of `limit` at a time. */
async function listed(
  tags: ListingTags,
  order: ListingOrder = { sort: "id" },
  limit = MAX_LISTING_PAGE,
  terms: string[] = [],
): Promise<string[]> {
  const all: string[] = [];
  let after: Uint8Array | undefined;
  for (;;) {
    const page = await listPolls(app, after, limit, order, terms, tags);
    all.push(...page.map(hex));
    if (page.length < limit) return all;
    after = page.at(-1);
  }
}

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const row = async (id: Uint8Array) =>
  (await app`SELECT topic, place, place_key FROM poll_tags WHERE election_id = ${id}`).map((r) => ({
    ...r,
  }));

describe("a place's key", () => {
  test("is the place in NFKC, lower case and single-spaced", () => {
    expect(placeKey("Riverside")).toBe("riverside");
    expect(placeKey("  RIVERSIDE\t Park ")).toBe("riverside park");
    expect(placeKey("Ｒｉｖｅｒｓｉｄｅ")).toBe("riverside");
    // Composed and decomposed spellings of one name are one key.
    expect(placeKey("Café")).toBe(placeKey("Café"));
    expect(placeKey("東京")).toBe("東京");
  });

  test("is none for a blank place, or one longer than any stored place once single-spaced", () => {
    for (const p of ["", "   ", "\u0085"]) expect(placeKey(p)).toBeUndefined();
    expect(placeKey("a".repeat(MAX_PLACE_LENGTH))).toBe("a".repeat(MAX_PLACE_LENGTH));
    expect(placeKey(`${"a ".repeat(MAX_PLACE_LENGTH / 2)}   `)).toBeDefined();
    expect(placeKey("a".repeat(MAX_PLACE_LENGTH + 1))).toBeUndefined();
    // Code points, as the draft's rule counts them.
    expect(placeKey("\u{10000}".repeat(MAX_PLACE_LENGTH))).toBeDefined();
    expect(placeKey("\u{10000}".repeat(MAX_PLACE_LENGTH + 1))).toBeUndefined();
    expect(() => placeKey(7 as unknown as string)).toThrow(TypeError);
  });

  test("is its own key, single-spaced, and the same for the place however it is spaced or cased", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: MAX_PLACE_LENGTH }), (p) => {
        const key = placeKey(p);
        if (key === undefined) return;
        expect(key).toBe(key.replace(/\s+/gu, " ").trim());
        expect(key).not.toBe("");
        expect(placeKey(key)).toBe(key);
        expect(placeKey(` ${p.toUpperCase()}  `)).toBe(placeKey(p.toUpperCase()));
      }),
      { numRuns },
    );
  });

  test("exists for every well-formed place", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "grapheme", minLength: 1, maxLength: MAX_PLACE_LENGTH }),
        (p) => {
          const place = p.normalize("NFC").replace(/\s+/gu, " ").trim();
          if (!placeIsWellFormed(place)) return;
          expect(placeKey(place)).toBeDefined();
        },
      ),
      { numRuns },
    );
  });
});

describe("schema", () => {
  test("matches its Drizzle view", async () => {
    for (const table of [pollTags, pollTagActions]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name}
        ORDER BY ordinal_position`;
      expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      );
      // No key reaches a board table, or any other.
      expect(
        await db.admin`
          SELECT conname FROM pg_constraint
          WHERE contype = 'f' AND conrelid = ${config.name}::regclass`,
      ).toEqual([]);
    }
  });

  test("the app role may add rows and change their tags, never remove one", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'poll_tags' AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
    const columns = await db.admin`
      SELECT column_name FROM information_schema.column_privileges
      WHERE table_schema = ${db.schema} AND table_name = 'poll_tags' AND grantee = 'abolish_app'
        AND privilege_type = 'UPDATE'
      ORDER BY column_name`;
    expect(columns.map((c) => c["column_name"])).toEqual(["place", "place_key", "topic"]);
    const id = await poll({ topic: "sport" });
    expect(await failsWith(app`UPDATE poll_tags SET election_id = ${randomBytes(32)}`)).toBe(
      "42501",
    );
    expect(await failsWith(app`DELETE FROM poll_tags`)).toBe("42501");
    expect(await failsWith(app`TRUNCATE poll_tags`)).toBe("42501");
    // A second write is a no-op: only a refiling changes a poll's tags.
    expect(await insertPollTags(app, id, { topic: "food", place: "Riverside" })).toBe(false);
    expect(await row(id)).toEqual([{ topic: "sport", place: null, place_key: null }]);
  });

  test("refuses a malformed tag, or a place without its key, and keeps an empty row", async () => {
    const insert = (topic: string | null, place: string | null, key: string | null) =>
      failsWith(app`INSERT INTO poll_tags VALUES (${randomBytes(32)}, ${topic}, ${place}, ${key})`);
    expect(await insert("Sport", null, null)).toBe("23514");
    expect(await insert(null, "Riverside", null)).toBe("23514");
    expect(await insert(null, null, "riverside")).toBe("23514");
    expect(await insert(null, "", "")).toBe("23514");
    expect(await insert(null, "a".repeat(MAX_PLACE_LENGTH + 1), "a")).toBe("23514");
    expect(
      await failsWith(app`INSERT INTO poll_tags VALUES (${randomBytes(31)}, 'sport', NULL, NULL)`),
    ).toBe("23514");
    // A poll refiled under neither tag.
    const empty = new Uint8Array(randomBytes(32));
    await app`INSERT INTO poll_tags VALUES (${empty}, NULL, NULL, NULL)`;
    expect(await row(empty)).toEqual([{ topic: null, place: null, place_key: null }]);
  });

  test("the refiling log is append-only, numbered from the poll log's sequence", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'poll_tag_actions'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
    const id = await poll({ topic: "sport" });
    await refilePoll(app, id, { tags: { topic: "food" }, reason: "misfiled", moderator: "mod-1" });
    for (const sql of [app, db.admin]) {
      expect(await failsWith(sql`UPDATE poll_tag_actions SET reason = 'spam'`)).toBe("42501");
      expect(await failsWith(sql`DELETE FROM poll_tag_actions`)).toBe("42501");
      expect(await failsWith(sql`TRUNCATE poll_tag_actions`)).toBe("42501");
    }
    // Whatever number an insert names, the trigger draws the next one.
    const [written] = await app`
      INSERT INTO poll_tag_actions
        (seq, election_id, topic_set, topic, place_set, place, reason, moderator, decided_at)
      VALUES (1, ${id}, true, 'food', false, NULL, 'misfiled', 'mod-1', now()) RETURNING seq`;
    const [last] = await app`SELECT max(seq) AS seq FROM moderation_actions`;
    expect(BigInt(written!["seq"])).toBeGreaterThan(1n);
    expect(BigInt(written!["seq"])).toBeGreaterThan(BigInt(last!["seq"] ?? 0));
    const insert = (
      topicSet: boolean,
      topic: string | null,
      placeSet: boolean,
      place: string | null,
      reason = "misfiled",
      moderator = "mod-1",
    ) =>
      failsWith(app`
        INSERT INTO poll_tag_actions
          (seq, election_id, topic_set, topic, place_set, place, reason, moderator, decided_at)
        VALUES (0, ${id}, ${topicSet}, ${topic}, ${placeSet}, ${place}, ${reason}, ${moderator},
          now())`);
    expect(await insert(true, "food", false, null, "error")).toBe("23514");
    expect(await insert(true, "food", false, null, "misfiled", "Mod-1")).toBe("23514");
    expect(await insert(true, "Food", false, null)).toBe("23514");
    expect(await insert(false, null, true, "")).toBe("23514");
    // A row sets at least one tag, and holds a value only for a tag it set.
    expect(await insert(false, null, false, null)).toBe("23514");
    expect(await insert(false, "food", true, null)).toBe("23514");
    expect(await insert(true, null, false, "Mill Lane")).toBe("23514");
  });
});

describe("writing", () => {
  test("keeps the author's place as written beside its key, and writes nothing for an untagged poll", async () => {
    const tagged = await poll({ topic: "transport", place: "Riverside Park" });
    expect(await row(tagged)).toEqual([
      { topic: "transport", place: "Riverside Park", place_key: "riverside park" },
    ]);
    expect(await row(await poll({}))).toEqual([]);
  });

  test("refuses tags no draft could hold", async () => {
    const id = new Uint8Array(randomBytes(32));
    for (const tags of [
      { topic: "weather" },
      { place: "" },
      { place: " Riverside" },
      { place: "River‮side" },
      { place: "a".repeat(MAX_PLACE_LENGTH + 1) },
    ])
      await expect(insertPollTags(app, id, tags as PollTags)).rejects.toThrow(TypeError);
    await expect(insertPollTags(app, id.subarray(1), { topic: "sport" })).rejects.toThrow(
      TypeError,
    );
    expect(await row(id)).toEqual([]);
  });
});

describe("a stored draft's tags", () => {
  test("keep only what a draft can hold", () => {
    expect(storedPollTags({ topic: "food", place: "Mill Lane", title: "x" })).toEqual({
      topic: "food",
      place: "Mill Lane",
    });
    for (const draft of [
      {},
      null,
      "food",
      { topic: "weather", place: " Mill Lane" },
      { topic: 7, place: ["Mill Lane"] },
      { place: "a".repeat(MAX_PLACE_LENGTH + 1) },
    ])
      expect(storedPollTags(draft)).toEqual({});
    expect(storedPollTags({ topic: "weather", place: "Mill Lane" })).toEqual({
      place: "Mill Lane",
    });
  });
});

describe("the listing's filters", () => {
  test("list the polls under a topic, at a place, or both, in every order", async () => {
    const t = `${hex(randomBytes(4))}`;
    const both = await poll({ topic: "housing", place: `Ward ${t}` });
    const topicOnly = await poll({ topic: "housing" });
    const placeOnly = await poll({ place: `ward ${t}` });
    const elsewhere = await poll({ topic: "housing", place: `Ward ${t} North` });
    await poll({});
    const ids = (...xs: Uint8Array[]) => xs.map(hex).sort();
    const key = placeKey(`WARD  ${t}`)!;

    for (const order of [{ sort: "id" } as const, open]) {
      const sorted = async (tags: ListingTags) => (await listed(tags, order)).sort();
      expect(await sorted({ placeKey: key })).toEqual(ids(both, placeOnly));
      expect(await sorted({ topic: "housing", placeKey: key })).toEqual(ids(both));
      // A place is matched whole: "Ward t North" is another place.
      expect(await sorted({ placeKey: `${key} north` })).toEqual(ids(elsewhere));
      const housing = await sorted({ topic: "housing" });
      for (const id of [both, topicOnly, elsewhere]) expect(housing).toContain(hex(id));
      expect(housing).not.toContain(hex(placeOnly));
    }
  });

  test("filter an order without reordering it, a page at a time", async () => {
    const place = `Hamlet ${hex(randomBytes(4))}`;
    const tagged = new Set<string>();
    for (let i = 0; i < 5; i++) tagged.add(hex(await poll({ place })));
    for (let i = 0; i < 3; i++) await poll({ topic: "food" });
    for (const order of [{ sort: "id" } as const, open]) {
      const all = await listed({}, order);
      const want = all.filter((id) => tagged.has(id));
      for (const limit of [1, 2, 5])
        expect(await listed({ placeKey: placeKey(place)! }, order, limit)).toEqual(want);
    }
  });

  test("join search, both filtering one order", async () => {
    const place = `Glen ${hex(randomBytes(4))}`;
    const word = `lantern${hex(randomBytes(4))}`;
    const hit = await poll({ place }, `Should the ${word} stay lit?`);
    await poll({ place }, "Should the bridge open?");
    await poll({}, `Should the ${word} go?`);
    expect(await listed({ placeKey: placeKey(place)! }, open, 10, searchTerms(word))).toEqual([
      hex(hit),
    ]);
  });

  test("leave out delisted and hidden polls", async () => {
    const place = `Moor ${hex(randomBytes(4))}`;
    const shown = await poll({ place });
    const delisted = await poll({ place });
    const hidden = await poll({ place });
    await moderate(app, delisted, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, hidden, { action: "hide", reason: "threat", moderator: "mod-1" });
    expect(await listed({ placeKey: placeKey(place)! })).toEqual([hex(shown)]);
    expect(await listed({ placeKey: placeKey(place)! }, open)).toEqual([hex(shown)]);
  });

  test("place a cursor as without them, so it need not match", async () => {
    const place = `Vale ${hex(randomBytes(4))}`;
    const untagged = await poll({});
    const tagged = await poll({ place });
    const all = await listed({}, open);
    const rest = all.slice(all.indexOf(hex(untagged)) + 1);
    expect(
      await listPolls(app, untagged, MAX_LISTING_PAGE, open, [], { placeKey: placeKey(place)! }),
    ).toEqual(rest.includes(hex(tagged)) ? [tagged] : []);
  });

  test("are every topic POLL_TOPICS names, and a non-empty key", async () => {
    for (const topic of POLL_TOPICS)
      await listPolls(app, undefined, 1, { sort: "id" }, [], { topic });
    for (const tags of [{ topic: "weather" }, { placeKey: "" }, { placeKey: 7 }, null])
      await expect(
        listPolls(app, undefined, 1, { sort: "id" }, [], tags as unknown as ListingTags),
      ).rejects.toThrow(TypeError);
  });
});

const refused = async (
  id: Uint8Array,
  decision: RefileDecision,
  code: ModerationErrorCode,
): Promise<void> => {
  const before = await row(id);
  const [count] = await app`SELECT count(*)::int AS n FROM poll_tag_actions`;
  const error = await refilePoll(app, id, decision).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ModerationError);
  expect((error as ModerationError).code).toBe(code);
  expect(await row(id)).toEqual(before);
  expect(await app`SELECT count(*)::int AS n FROM poll_tag_actions`).toEqual([count]);
};

const logged = async (id: Uint8Array) =>
  (
    await app`
      SELECT topic_set, topic, place_set, place, reason, moderator
      FROM poll_tag_actions WHERE election_id = ${id} ORDER BY seq`
  ).map((r) => ({ ...r }));

describe("refiling", () => {
  test("changes a poll's tags, and the listing's filters follow", async () => {
    const t = hex(randomBytes(4));
    const id = await poll({ topic: "housing", place: `Elm Street ${t}` });
    const { seq } = await refilePoll(app, id, {
      tags: { topic: "transport", place: `Ward ${t}` },
      reason: "personal-data",
      moderator: "mod-1",
    });
    expect(await row(id)).toEqual([
      { topic: "transport", place: `Ward ${t}`, place_key: `ward ${t}` },
    ]);
    expect(await listed({ placeKey: placeKey(`Elm Street ${t}`)! })).toEqual([]);
    expect(await listed({ placeKey: placeKey(`Ward ${t}`)! })).toEqual([hex(id)]);
    expect(await listed({ topic: "housing" })).not.toContain(hex(id));
    expect(await listed({ topic: "transport" })).toContain(hex(id));
    // The log keeps the new tags, never the place it replaced.
    expect(
      await app`SELECT election_id FROM poll_tag_actions WHERE seq = ${seq.toString()}`,
    ).toEqual([{ election_id: Buffer.from(id) }]);
    expect(await logged(id)).toEqual([
      {
        topic_set: true,
        topic: "transport",
        place_set: true,
        place: `Ward ${t}`,
        reason: "personal-data",
        moderator: "mod-1",
      },
    ]);
  });

  test("logs only what it changed, so a place it kept and then cleared survives in no row", async () => {
    const place = `14 Elm Street ${hex(randomBytes(4))}`;
    const id = await poll({ topic: "food", place });
    // A topic-only refiling passes the place back, and doesn't log it.
    await refilePoll(app, id, {
      tags: { topic: "housing", place },
      reason: "misfiled",
      moderator: "mod-1",
    });
    await refilePoll(app, id, {
      tags: { topic: "housing" },
      reason: "personal-data",
      moderator: "mod-2",
    });
    expect(await logged(id)).toEqual([
      {
        topic_set: true,
        topic: "housing",
        place_set: false,
        place: null,
        reason: "misfiled",
        moderator: "mod-1",
      },
      {
        topic_set: false,
        topic: null,
        place_set: true,
        place: null,
        reason: "personal-data",
        moderator: "mod-2",
      },
    ]);
    expect(await app`SELECT 1 FROM poll_tag_actions WHERE place = ${place}`).toEqual([]);
    expect(await row(id)).toEqual([{ topic: "housing", place: null, place_key: null }]);
  });

  test("files an untagged poll, clears both tags, and keeps only the two tags of the decision", async () => {
    const id = await poll({});
    await refilePoll(app, id, {
      tags: { place: "Mill Lane", title: "x" } as PollTags,
      reason: "misfiled",
      moderator: "mod-1",
    });
    expect(await row(id)).toEqual([{ topic: null, place: "Mill Lane", place_key: "mill lane" }]);
    await refilePoll(app, id, { tags: {}, reason: "spam", moderator: "mod-1" });
    expect(await row(id)).toEqual([{ topic: null, place: null, place_key: null }]);
    // An opening after the refiling leaves it alone.
    expect(await insertPollTags(app, id, { topic: "food" })).toBe(false);
    expect(await row(id)).toEqual([{ topic: null, place: null, place_key: null }]);
    expect(await listed({ placeKey: "mill lane" })).not.toContain(hex(id));
    // A poll with no row is filed under nothing yet: even no tags file it.
    const unfiled = await poll({});
    await refilePoll(app, unfiled, { tags: {}, reason: "personal-data", moderator: "mod-1" });
    expect(await row(unfiled)).toEqual([{ topic: null, place: null, place_key: null }]);
    expect(await insertPollTags(app, unfiled, { place: "Mill Lane" })).toBe(false);
    expect(await logged(unfiled)).toEqual([
      {
        topic_set: true,
        topic: null,
        place_set: true,
        place: null,
        reason: "personal-data",
        moderator: "mod-1",
      },
    ]);
  });

  test("against an opening step writing the author's tags at once, either one files the poll and nothing is logged twice", async () => {
    for (let i = 0; i < 5; i++) {
      const id = await poll({});
      const other = await db.as("abolish_app");
      const [refiled, inserted] = await Promise.all([
        refilePoll(app, id, {
          tags: { topic: "sport" },
          reason: "misfiled",
          moderator: "mod-1",
        }).then(
          () => "ok",
          (e: unknown) => (e as ModerationError).code,
        ),
        insertPollTags(other, id, { topic: "sport" }),
      ]);
      await other.end();
      expect(await row(id)).toEqual([{ topic: "sport", place: null, place_key: null }]);
      // The refiling waited for the step's row and found nothing to change,
      // or the step found the refiling's row and wrote nothing.
      expect(inserted).toBe(refiled !== "ok");
      expect((await logged(id)).length).toBe(refiled === "ok" ? 1 : 0);
    }
  });

  test("takes its number from the poll log's sequence, between decisions about polls and profiles", async () => {
    const id = await poll({ topic: "food" });
    const a = await moderate(app, id, { action: "delist", reason: "spam", moderator: "mod-1" });
    const b = await refilePoll(app, id, {
      tags: { topic: "sport" },
      reason: "misfiled",
      moderator: "mod-1",
    });
    const c = await moderate(app, id, { action: "restore", reason: "error", moderator: "mod-1" });
    expect(a.seq < b.seq && b.seq < c.seq).toBe(true);
    // Neither the poll log nor the profile log has the refiling's number.
    const polls = await readModerationLog(app, a.seq - 1n, 10);
    expect(polls.map((e) => e.seq)).toEqual([a.seq, c.seq]);
    expect((await readProfileModerationLog(app, a.seq - 1n, 10)).map((e) => e.seq)).toEqual([]);
    // Refiling is not a change of state.
    expect((await moderationStatus(app, id)).state).toBe("visible");
  });

  test("is refused, writing nothing: malformed, unknown poll or moderator, own poll, or no change", async () => {
    const id = await poll({ topic: "food", place: "Mill Lane" });
    const ok = { tags: { topic: "sport" }, reason: "misfiled", moderator: "mod-1" } as const;
    for (const decision of [
      { ...ok, reason: "error" },
      { ...ok, reason: "appeal-upheld" },
      { ...ok, moderator: "Mod 1" },
      { ...ok, moderator: 7 },
      { ...ok, tags: { topic: "weather" } },
      { ...ok, tags: { place: " Mill Lane" } },
      { ...ok, tags: { place: "Mill\u202eLane" } },
      { ...ok, tags: { place: "a".repeat(MAX_PLACE_LENGTH + 1) } },
      { ...ok, tags: null },
      { ...ok, tags: "sport" },
    ])
      await refused(id, decision as unknown as RefileDecision, "invalid");
    await refused(id, null as unknown as RefileDecision, "invalid");
    await refused(new Uint8Array(randomBytes(32)), ok, "unknown-election");
    await refused(id, { ...ok, moderator: "mod-9" }, "unknown-moderator");
    await refused(id, { ...ok, tags: { topic: "food", place: "Mill Lane" } }, "no-change");
    await expect(refilePoll(app, id.subarray(1), ok)).rejects.toThrow(TypeError);

    // A moderator's own poll: mod-2's account created it.
    await app`
      INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
        creator_address, create_tx_hash, election_id, created_block, l1_origin_timestamp,
        anchors_checked_block, electorate, stub_hash, ceremony_tx_hash, register_tx_hash,
        registered_block)
      VALUES (${newAccountId()}, ${moderators.get("mod-2")!}, 'open', '{}', now(), now(), now(),
        ${randomBytes(20)}, ${randomBytes(32)}, ${id}, 1, 1, 1, '[]', ${randomBytes(32)},
        ${randomBytes(32)}, ${randomBytes(32)}, 2)`;
    await refused(id, { ...ok, moderator: "mod-2" }, "own-poll");
    await refilePoll(app, id, ok);
  });

  test("ends with the poll filed under its last refiling, refusing only refilings that change nothing", async () => {
    const tagsArb: fc.Arbitrary<PollTags> = fc.record(
      {
        topic: fc.constantFrom(...POLL_TOPICS.slice(0, 3)),
        place: fc.constantFrom("Mill Lane", "Old Town", "東京"),
      },
      { requiredKeys: [] },
    );
    await fc.assert(
      fc.asyncProperty(
        tagsArb,
        fc.array(fc.tuple(tagsArb, fc.constantFrom(...REFILE_REASONS)), {
          minLength: 1,
          maxLength: 6,
        }),
        async (author, refilings) => {
          const id = await poll(author);
          // A poll filed under nothing has no row, so its first refiling
          // sets both tags whatever they are.
          let model: PollTags | undefined =
            author.topic === undefined && author.place === undefined ? undefined : author;
          const want: Record<string, unknown>[] = [];
          const published: Record<string, unknown>[] = [];
          for (const [tags, reason] of refilings) {
            const topicSet = model === undefined || tags.topic !== model.topic;
            const placeSet = model === undefined || tags.place !== model.place;
            const result = await refilePoll(app, id, { tags, reason, moderator: "mod-1" }).then(
              ({ seq }) => seq,
              (e: unknown) => (e as ModerationError).code,
            );
            expect(typeof result === "bigint" ? "ok" : result).toBe(
              topicSet || placeSet ? "ok" : "no-change",
            );
            if (typeof result !== "bigint") continue;
            model = tags;
            want.push({
              topic_set: topicSet,
              topic: topicSet ? (tags.topic ?? null) : null,
              place_set: placeSet,
              place: placeSet ? (tags.place ?? null) : null,
              reason,
              moderator: "mod-1",
            });
            published.push({
              target: "refiling",
              seq: result,
              electionId: id,
              reason,
              decidedAt: expect.any(Date),
              ...(topicSet ? { topic: tags.topic ?? null } : {}),
              ...(placeSet ? { place: tags.place === undefined ? "cleared" : "changed" } : {}),
            });
          }
          expect(await logged(id)).toEqual(want);
          // The public log says what each refiling changed, never a place.
          const first = published[0]?.["seq"] as bigint | undefined;
          if (first !== undefined) {
            const log = await readPublicModerationLog(app, first - 1n, MAX_MODERATION_PAGE);
            expect(
              log.filter((e) => e.target === "refiling" && hex(e.electionId) === hex(id)),
            ).toEqual(published);
          }
          const view = await readPollTags(app, id);
          expect(view).toEqual({ state: "visible", tags: model ?? {} });
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
    // Fifty runs of up to seven database writes each can outlast the default
    // timeout on a CI runner shared with the other test files.
  }, 60_000);
});

describe("the public log", () => {
  test("shows each refiling in its place among decisions, with its topic and what it did to the place, never the place or the moderator", async () => {
    const place = `14 Elm Street ${hex(randomBytes(4))}`;
    const id = await poll({ topic: "food", place });
    const a = await moderate(app, id, { action: "delist", reason: "spam", moderator: "mod-1" });
    const b = await refilePoll(app, id, {
      tags: { topic: "housing", place: `Ward ${hex(randomBytes(4))}` },
      reason: "misfiled",
      moderator: "mod-1",
    });
    const c = await refilePoll(app, id, {
      tags: { topic: "housing" },
      reason: "personal-data",
      moderator: "mod-2",
    });
    const d = await refilePoll(app, id, { tags: {}, reason: "misfiled", moderator: "mod-2" });
    const e = await moderate(app, id, { action: "restore", reason: "error", moderator: "mod-1" });
    const log = await readPublicModerationLog(app, a.seq - 1n, MAX_MODERATION_PAGE);
    const at = (seq: bigint) => log.find((x) => x.seq === seq)?.decidedAt;
    expect(log.map((x) => x.seq)).toEqual([a.seq, b.seq, c.seq, d.seq, e.seq]);
    expect(log.slice(1, 4)).toEqual([
      {
        target: "refiling",
        seq: b.seq,
        electionId: id,
        reason: "misfiled",
        decidedAt: at(b.seq),
        topic: "housing",
        place: "changed",
      },
      {
        target: "refiling",
        seq: c.seq,
        electionId: id,
        reason: "personal-data",
        decidedAt: at(c.seq),
        place: "cleared",
      },
      {
        target: "refiling",
        seq: d.seq,
        electionId: id,
        reason: "misfiled",
        decidedAt: at(d.seq),
        topic: null,
      },
    ]);
    expect(log[0]?.target).toBe("poll");
    const served = JSON.stringify(log, (_, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(served).not.toContain("Elm Street");
    expect(served).not.toContain("Ward");
    expect(served).not.toContain("mod-");
    // A page holds `limit` entries of every kind.
    expect((await readPublicModerationLog(app, a.seq, 2)).map((x) => x.seq)).toEqual([
      b.seq,
      c.seq,
    ]);
    expect((await readPublicModerationLog(app, c.seq, 1)).map((x) => x.seq)).toEqual([d.seq]);
  });
});

describe("a poll's tags, as its page reads them", () => {
  test("are the tags it is filed under, none for an untagged poll, and nothing for an unknown one", async () => {
    const tagged = await poll({ topic: "food", place: "Mill Lane" });
    expect(await readPollTags(app, tagged)).toEqual({
      state: "visible",
      tags: { topic: "food", place: "Mill Lane" },
    });
    expect(await readPollTags(app, await poll({}))).toEqual({ state: "visible", tags: {} });
    expect(await readPollTags(app, new Uint8Array(randomBytes(32)))).toBeUndefined();
    await expect(readPollTags(app, tagged.subarray(1))).rejects.toThrow(TypeError);
  });

  test("are shown while it is delisted and withheld while it is hidden", async () => {
    const id = await poll({ place: "Mill Lane" });
    await moderate(app, id, { action: "delist", reason: "spam", moderator: "mod-1" });
    expect(await readPollTags(app, id)).toEqual({
      state: "delisted",
      tags: { place: "Mill Lane" },
    });
    await moderate(app, id, { action: "hide", reason: "threat", moderator: "mod-1" });
    expect(await readPollTags(app, id)).toEqual({ state: "hidden" });
    // A hidden poll can still be refiled, as its place may be why.
    await refilePoll(app, id, { tags: {}, reason: "threat", moderator: "mod-1" });
    await moderate(app, id, { action: "restore", reason: "error", moderator: "mod-1" });
    expect(await readPollTags(app, id)).toEqual({ state: "visible", tags: {} });
  });
});
