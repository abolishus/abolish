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
  placeKey,
  POLL_TOPICS,
  type PollTags,
  pollTags,
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
// stay out of every filter. The opening step's write and the fill are tested
// with the step (poll-opening.test.ts).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  await addModerators(app, "mod-1");
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
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'poll_tags'
      ORDER BY ordinal_position`;
    const config = getTableConfig(pollTags);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    // No key reaches a board table, or any other.
    expect(
      await db.admin`
        SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid = 'poll_tags'::regclass`,
    ).toEqual([]);
  });

  test("the app role may only read and add rows: a poll keeps the tags it was filed under", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'poll_tags' AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
    const id = await poll({ topic: "sport" });
    expect(await failsWith(app`UPDATE poll_tags SET topic = 'food'`)).toBe("42501");
    expect(await failsWith(app`DELETE FROM poll_tags`)).toBe("42501");
    expect(await failsWith(app`TRUNCATE poll_tags`)).toBe("42501");
    // A second write is a no-op.
    expect(await insertPollTags(app, id, { topic: "food", place: "Riverside" })).toBe(false);
    expect(await row(id)).toEqual([{ topic: "sport", place: null, place_key: null }]);
  });

  test("refuses a row with no tag, a malformed tag, or a place without its key", async () => {
    const insert = (topic: string | null, place: string | null, key: string | null) =>
      failsWith(app`INSERT INTO poll_tags VALUES (${randomBytes(32)}, ${topic}, ${place}, ${key})`);
    expect(await insert(null, null, null)).toBe("23514");
    expect(await insert("Sport", null, null)).toBe("23514");
    expect(await insert(null, "Riverside", null)).toBe("23514");
    expect(await insert(null, null, "riverside")).toBe("23514");
    expect(await insert(null, "", "")).toBe("23514");
    expect(await insert(null, "a".repeat(MAX_PLACE_LENGTH + 1), "a")).toBe("23514");
    expect(
      await failsWith(app`INSERT INTO poll_tags VALUES (${randomBytes(31)}, 'sport', NULL, NULL)`),
    ).toBe("23514");
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
