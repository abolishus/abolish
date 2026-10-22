import {
  type DisplayText,
  decodeElectionDefinitionV5,
  displayTextCommitment,
  encodeDisplayText,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  QUESTION_METHODS,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  displayTextSearch,
  fillDisplayTextSearch,
  type ListingOrder,
  listPolls,
  MAX_LISTING_PAGE,
  MAX_SEARCH_QUERY,
  MAX_SEARCH_TERMS,
  moderate,
  normalizeSearchText,
  searchTerms,
  storeDefinition,
  storeDisplayText,
} from "../src/index.ts";
import { addModerators, type TestDb, testDb, typical } from "./db.ts";

// Search over question text (src/search.ts, migrations/0026; P2-23 part 4;
// T-17, T-68): each stored display text's titles and questions, normalised,
// filter the listing's orders; the row goes with its display text, and
// delisted or hidden polls stay out of every search.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
let owner: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  owner = await db.as("abolish_migrator");
  await addModerators(app, "mod-1");
});
afterAll(() => db?.close());

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * A stored version-1 poll whose display text asks `questions` (one
 * translation each, under the tags given) and is stored, unless `store` is
 * false. The typical vector's poll was open in the first week of January
 * 2026, so the open orders are asked at its `opens_at`.
 */
async function poll(
  questions: Readonly<Record<string, string>>,
  store = true,
): Promise<Uint8Array> {
  const id = new Uint8Array(randomBytes(32));
  const text: DisplayText = {
    salt: new Uint8Array(randomBytes(32)),
    translations: Object.keys(questions)
      .sort()
      .map((language) => ({
        language: bytes(language),
        question: bytes(questions[language]!),
        description: bytes("Not searched: descriptions stay out."),
        options: ["Yes", "No", "Abstain"].map((l) => ({
          label: bytes(l),
          description: new Uint8Array(0),
        })),
      })),
  };
  await storeDefinition(
    app,
    encodeElectionDefinition({
      ...typical,
      election_id: id,
      display_text_commitment: displayTextCommitment(text),
    }),
  );
  if (store) await storeDisplayText(app, id, encodeDisplayText(text));
  return id;
}

const open: ListingOrder = { sort: "closing", now: typical.opens_at };

/** Every poll listed under `order` matching `query`, as hex, a page of `limit` at a time. */
async function search(
  query: string,
  order: ListingOrder = { sort: "id" },
  limit = MAX_LISTING_PAGE,
): Promise<string[]> {
  const all: string[] = [];
  let after: Uint8Array | undefined;
  for (;;) {
    const page = await listPolls(app, after, limit, order, searchTerms(query));
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

const searchRow = async (id: Uint8Array) =>
  (await app`SELECT search_text FROM display_text_search WHERE election_id = ${id}`).map(
    (r) => r["search_text"] as string,
  );

describe("terms", () => {
  test("normalises case and compatibility forms, and turns control characters into spaces", () => {
    expect(normalizeSearchText("ＰＡＲＫ Café")).toBe("park café");
    // The decomposed é composes under NFKC, so both spellings match.
    expect(normalizeSearchText("Café")).toBe(normalizeSearchText("Café"));
    expect(normalizeSearchText("ﬁre")).toBe("fire");
    expect(normalizeSearchText("a\u0000b\u0007c")).toBe("a b c");
  });

  test("splits a query on whitespace and drops repeats", () => {
    expect(searchTerms("  Park\tLIBRARY　park ")).toEqual(["park", "library"]);
    expect(searchTerms("公園")).toEqual(["公園"]);
  });

  test("refuses an empty query, too many terms and too many characters", () => {
    for (const q of ["", "   ", "\n\t"]) expect(() => searchTerms(q)).toThrow(TypeError);
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    expect(searchTerms(words(MAX_SEARCH_TERMS))).toHaveLength(MAX_SEARCH_TERMS);
    expect(() => searchTerms(words(MAX_SEARCH_TERMS + 1))).toThrow(TypeError);
    expect(searchTerms("a".repeat(MAX_SEARCH_QUERY))).toHaveLength(1);
    expect(() => searchTerms("a".repeat(MAX_SEARCH_QUERY + 1))).toThrow(TypeError);
    expect(() => searchTerms(7 as unknown as string)).toThrow(TypeError);
  });

  test("every term is normalised, distinct and non-empty, and as many as the query's words at most", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: MAX_SEARCH_QUERY }), (q) => {
        const words = q.split(/\s+/u).filter((w) => w !== "");
        if (words.length < 1 || words.length > MAX_SEARCH_TERMS) {
          expect(() => searchTerms(q)).toThrow(TypeError);
          return;
        }
        const terms = searchTerms(q);
        expect(terms.length).toBeLessThanOrEqual(words.length);
        expect(new Set(terms).size).toBe(terms.length);
        for (const t of terms) {
          expect(t).not.toBe("");
          expect(normalizeSearchText(t)).toBe(t);
        }
      }),
      { numRuns },
    );
  });
});

describe("schema", () => {
  test("matches its Drizzle view", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'display_text_search'
      ORDER BY ordinal_position`;
    const config = getTableConfig(displayTextSearch);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
    const [fk] = await db.admin`
      SELECT confrelid::regclass::text AS dst, confdeltype FROM pg_constraint
      WHERE contype = 'f' AND conrelid = 'display_text_search'::regclass`;
    expect(fk).toEqual({ dst: "display_texts", confdeltype: "c" });
  });

  test("the app role may only read and add rows: a row goes with its display text", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'display_text_search'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["INSERT", "SELECT"]);
    const id = await poll({ en: "Should the pool open in May?" });
    expect(await failsWith(app`UPDATE display_text_search SET search_text = 'x'`)).toBe("42501");
    expect(await failsWith(app`DELETE FROM display_text_search`)).toBe("42501");
    expect(await failsWith(app`TRUNCATE display_text_search`)).toBe("42501");
    expect(await searchRow(id)).toEqual(["should the pool open in may?"]);
    // A takedown deletes the display text, and its search row goes with it.
    await app`DELETE FROM display_texts WHERE election_id = ${id}`;
    expect(await searchRow(id)).toEqual([]);
  });

  test("refuses a row for a display text that isn't stored", async () => {
    const id = await poll({ en: "Unstored?" }, false);
    expect(
      await failsWith(
        app`INSERT INTO display_text_search (election_id, search_text) VALUES (${id}, 'x')`,
      ),
    ).toBe("23503");
  });
});

describe("storing", () => {
  test("a stored text gets its questions in every translation, once, and nothing else", async () => {
    const id = await poll({
      en: "Should the PARK stay open?",
      fr: "Le parc doit-il rester ouvert ?",
    });
    expect(await searchRow(id)).toEqual([
      "should the park stay open? le parc doit-il rester ouvert ?",
    ]);
  });

  test("a version-2 text gives each translation's title and questions, not descriptions or labels", async () => {
    const vector = (
      JSON.parse(
        readFileSync(
          new URL("../../../docs/spec/vectors/display-text-v2.json", import.meta.url),
          "utf8",
        ),
      ).vectors as {
        id: string;
        encoding: string;
        definition: { optionCounts: string[]; displayTextCommitment: string };
      }[]
    ).find((v) => v.id === "display-text-v2-two-questions")!;
    const base = decodeElectionDefinitionV5(
      fromHex(
        (
          JSON.parse(
            readFileSync(
              new URL("../../../docs/spec/vectors/verifier-ballots-v3.json", import.meta.url),
              "utf8",
            ),
          ) as { cases: { id: string; definition: string }[] }
        ).cases.find((c) => c.id === "admitted")!.definition,
      ),
    );
    const id = new Uint8Array(randomBytes(32));
    await storeDefinition(
      app,
      encodeElectionDefinitionV5({
        ...base,
        election_id: id,
        questions: vector.definition.optionCounts.map((n) => ({
          method: QUESTION_METHODS.selection,
          option_count: Number(n),
          min_selections: 0,
          max_selections: 1,
        })),
        display_text_commitment: fromHex(vector.definition.displayTextCommitment),
      }),
    );
    await storeDisplayText(app, id, fromHex(vector.encoding));
    // The vector's own words, written out here rather than decoded by the
    // code under test.
    expect(await searchRow(id)).toEqual([
      [
        "park and library",
        "should the park stay open late?",
        "should the library open on sundays?",
        "parque y biblioteca",
        "¿debe el parque abrir hasta tarde?",
        "¿debe la biblioteca abrir los domingos?",
      ].join(" "),
    ]);
    expect(await search("library")).toContain(hex(id));
    expect(await search("domingos")).toContain(hex(id));
    // A question description and an option label.
    expect(await search("spring")).not.toContain(hex(id));
    expect(await search("abstain")).not.toContain(hex(id));
  });

  test("the fill writes the rows of texts stored without one, then nothing", async () => {
    const a = await poll({ en: "Fill me first?" });
    const b = await poll({ en: "Fill me second?" });
    await owner`DELETE FROM display_text_search WHERE election_id IN (${a}, ${b})`;
    expect(await search("fill")).toEqual([]);
    expect(await fillDisplayTextSearch(owner)).toBe(2);
    expect(await fillDisplayTextSearch(owner)).toBe(0);
    expect((await search("fill")).sort()).toEqual([hex(a), hex(b)].sort());
    // Storing again writes a missing row too, and changes no present one.
    await owner`DELETE FROM display_text_search WHERE election_id = ${a}`;
    const text = (await app`SELECT display_text FROM display_texts WHERE election_id = ${a}`)[0]![
      "display_text"
    ] as Uint8Array;
    await storeDisplayText(app, a, new Uint8Array(text));
    await storeDisplayText(app, a, new Uint8Array(text));
    expect(await searchRow(a)).toEqual(["fill me first?"]);
  });
});

describe("listing", () => {
  test("lists only the polls with every term, by substring, in any translation", async () => {
    const park = await poll({ en: "Should the park open late on Fridays?" });
    const parking = await poll({ en: "More parking downtown?", es: "¿Más estacionamiento?" });
    const kanji = await poll({ ja: "公園を夜遅くまで開けるべきですか" });
    const silent = await poll({ en: "Should the park be quiet?" }, false);
    const mine = new Set([park, parking, kanji, silent].map(hex));
    const found = async (q: string) => (await search(q)).filter((id) => mine.has(id)).sort();
    expect(await found("PARK")).toEqual([hex(park), hex(parking)].sort());
    expect(await found("park fridays")).toEqual([hex(park)]);
    expect(await found("park sundays")).toEqual([]);
    expect(await found("estacionamiento")).toEqual([hex(parking)]);
    expect(await found("公園")).toEqual([hex(kanji)]);
    // Full-width letters match their plain ones.
    expect(await found("ｆｒｉｄａｙｓ")).toEqual([hex(park)]);
    // A term never spans two translations.
    expect(await found("downtown?¿más")).toEqual([]);
    // Without its display text a poll matches nothing; nor do descriptions.
    expect(await found("quiet")).toEqual([]);
    expect(await found("descriptions")).toEqual([]);
  });

  test("keeps delisted and hidden polls out, whatever matches", async () => {
    const delisted = await poll({ en: "Moderated lantern festival?" });
    const hidden = await poll({ en: "Moderated lantern parade?" });
    const shown = await poll({ en: "Moderated lantern walk?" });
    await moderate(app, delisted, { action: "delist", reason: "spam", moderator: "mod-1" });
    await moderate(app, hidden, { action: "hide", reason: "threat", moderator: "mod-1" });
    expect(await search("lantern")).toEqual([hex(shown)]);
    expect(await search("lantern", open)).toEqual([hex(shown)]);
  });

  test("filters an order without reordering it, and pages through it once", async () => {
    const ids: Uint8Array[] = [];
    for (let i = 0; i < 6; i++) ids.push(await poll({ en: `Paging question number ${i}?` }));
    const all = (await listPolls(app, undefined, MAX_LISTING_PAGE, open)).map(hex);
    const expected = all.filter((id) => ids.some((x) => hex(x) === id));
    for (const limit of [1, 2, 5]) expect(await search("paging", open, limit)).toEqual(expected);
    expect(await search("paging", { sort: "id" }, 2)).toEqual([...expected].sort());
    // The cursor need not match the query.
    const other = await poll({ en: "Unrelated question?" });
    expect(await listPolls(app, other, MAX_LISTING_PAGE, { sort: "id" }, ["paging"])).toEqual(
      (await listPolls(app, other, MAX_LISTING_PAGE, { sort: "id" })).filter((id) =>
        expected.includes(hex(id)),
      ),
    );
  });

  test("refuses terms it wasn't given by searchTerms's rules", async () => {
    for (const terms of [[""], Array(MAX_SEARCH_TERMS + 1).fill("a"), [7], "park"])
      await expect(
        listPolls(app, undefined, 10, { sort: "id" }, terms as unknown as string[]),
      ).rejects.toThrow(TypeError);
  });

  test("matches exactly the polls whose questions contain every term", async () => {
    // A model over a small vocabulary, so queries hit and miss alike. Each
    // run's polls carry a tag no other run's do.
    const vocabulary = ["oak", "Oaks", "bridge", "ferry", "LIBRARY", "lib", "pier", "dock"];
    const word = fc.constantFrom(...vocabulary);
    let run = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(word, { minLength: 1, maxLength: 5 }), { minLength: 1, maxLength: 4 }),
        fc.array(word, { minLength: 1, maxLength: 3 }),
        async (questions, query) => {
          const tag = `model${run++}x`;
          const expected: string[] = [];
          const mine = new Set<string>();
          for (const q of questions) {
            const id = await poll({ en: `${tag} ${q.join(" ")}?` });
            mine.add(hex(id));
            const lowered = `${tag} ${q.join(" ")}?`.toLowerCase();
            if (query.every((t) => lowered.includes(t.toLowerCase()))) expected.push(hex(id));
          }
          const found = await search([tag, ...query].join(" "), { sort: "id" }, 2);
          expect(found.filter((id) => mine.has(id))).toEqual(expected.sort());
          expect(found.every((id) => mine.has(id))).toBe(true);
        },
      ),
      // Each run stores polls, so the run count is capped like the other
      // database-backed properties.
      { numRuns: Math.min(numRuns, 50) },
    );
  }, 120_000);
});
