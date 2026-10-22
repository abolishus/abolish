// Search over question text (P2-23 part 4). Each stored display text gets one
// row of normalised text, its titles and questions in every translation, in
// display_text_search (migrations/0028_display_text_search.sql), which a
// foreign key deletes with the display text: a takedown that deletes the text
// leaves nothing of it to be found by search (T-17, T-68). The row is written
// from the record @abolishus/crypto checked and decoded when it was stored, so
// search matches only words a voter would be shown.
//
// Matching is by substring, every term in the text: languages without spaces
// between words match as well as those with them, and nothing ranks one poll
// over another, so search filters the listing's own orders rather than adding
// one (no engagement or relevance ranking; P2-23, Never).

import type { ShowRecordCheck } from "@abolishus/crypto";
import { checkElectionRecordToShow } from "@abolishus/crypto";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { displayTexts, displayTextSearch } from "./db/schema/index.ts";
import { decodeStoredDefinition, readDefinition, storedDefinitionHash } from "./definitions.ts";

/** The longest search query, in UTF-16 code units, as the API contract bounds it. */
export const MAX_SEARCH_QUERY = 200;

/** The most whitespace-separated terms in one search query. */
export const MAX_SEARCH_TERMS = 8;

/**
 * Text as search compares it: NFKC, so compatibility forms (full-width
 * letters, ligatures) match their plain ones, then lower case, with control
 * characters as spaces (Postgres text can't hold U+0000). Locale-free, so a
 * query and the text it should match normalise alike on every server.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\p{Cc}/gu, " ");
}

/**
 * A query no term of which is left once normalised: each was control
 * characters alone (U+0085, which `\s` doesn't match), which normalise to
 * spaces and would match nearly every poll.
 */
export class SearchQueryError extends Error {
  override readonly name = "SearchQueryError";
  readonly code = "blank";
  constructor() {
    super("search refused: blank");
  }
}

/**
 * A query's terms: split on whitespace, each normalised and cut to its first
 * `MAX_SEARCH_QUERY` code points, blank ones and duplicates dropped. Refuses
 * a query longer than `MAX_SEARCH_QUERY`, one with no term, and one with more
 * than `MAX_SEARCH_TERMS`, counted before normalising, as the contract's
 * pattern counts them (a `TypeError`); and one whose terms are all blank once
 * normalised, which the pattern can't see (a `SearchQueryError`). The cut
 * bounds what each `strpos` searches for, which NFKC can otherwise grow
 * eighteenfold (U+FDFA), and only widens a match (T-52).
 */
export function searchTerms(query: string): string[] {
  if (typeof query !== "string" || query.length > MAX_SEARCH_QUERY)
    throw new TypeError(`query must be a string of at most ${MAX_SEARCH_QUERY} characters`);
  const raw = query.split(/\s+/u).filter((t) => t !== "");
  if (raw.length < 1 || raw.length > MAX_SEARCH_TERMS)
    throw new TypeError(`query must have 1 to ${MAX_SEARCH_TERMS} terms`);
  const terms = new Set(
    raw
      .map((t) => Array.from(normalizeSearchText(t)).slice(0, MAX_SEARCH_QUERY).join(""))
      .filter((t) => !/^\s*$/u.test(t)),
  );
  if (terms.size === 0) throw new SearchQueryError();
  return [...terms];
}

/**
 * The searchable text of a checked record: each translation's title (version
 * 5) and every question, each normalised, then joined by newlines. A
 * normalised term holds no control character, so none matches across two of
 * them, even one NFKC gave a space (U+00A8). Descriptions and option labels
 * are left out: search is over the questions (P2-23, Scope).
 */
export function searchTextOf(checked: ShowRecordCheck & { readonly ok: true }): string {
  const lines =
    checked.version === 1
      ? checked.displayText.translations.map((t) => t.question)
      : checked.displayText.translations.flatMap((t) => [
          t.title,
          ...t.questions.map((q) => q.question),
        ]);
  return lines
    .filter((l) => l.length > 0)
    .map((l) => normalizeSearchText(utf8.decode(l)))
    .join("\n");
}

// The codec admits only well-formed UTF-8, so `fatal` never fires on a
// checked record.
const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Writes the search row of a stored display text, unless it has one. A text
 * deleted in between makes the foreign key refuse the row, which throws:
 * there is then nothing to index.
 */
export async function insertSearchText(
  client: Sql,
  electionId: Uint8Array,
  checked: ShowRecordCheck & { readonly ok: true },
): Promise<void> {
  await drizzle({ client })
    .insert(displayTextSearch)
    .values({ electionId, searchText: searchTextOf(checked) })
    .onConflictDoNothing({ target: displayTextSearch.electionId });
}

/** How many display texts `fillDisplayTextSearch` reads at a time. */
const FILL_BATCH = 100;

/**
 * Writes the search row of every stored display text that has none: those
 * stored before migration 0028 added the table, or by a `storeDisplayText`
 * call interrupted between its two writes. Returns how many it wrote. Every
 * stored text passed the show check against its stored definition when it was
 * stored, so one that doesn't now is an error.
 */
export async function fillDisplayTextSearch(client: Sql): Promise<number> {
  const db = drizzle({ client });
  let written = 0;
  let after = new Uint8Array(0);
  for (;;) {
    const rows = await db
      .select({ electionId: displayTexts.electionId, displayText: displayTexts.displayText })
      .from(displayTexts)
      .leftJoin(displayTextSearch, eq(displayTextSearch.electionId, displayTexts.electionId))
      .where(and(isNull(displayTextSearch.electionId), gt(displayTexts.electionId, after)))
      .orderBy(asc(displayTexts.electionId))
      .limit(FILL_BATCH);
    for (const row of rows) {
      const electionId = new Uint8Array(row.electionId);
      const definition = await readDefinition(client, electionId);
      if (definition === undefined)
        throw new Error("a stored display text has no stored definition");
      const checked = checkElectionRecordToShow(
        electionId,
        storedDefinitionHash(decodeStoredDefinition(definition)),
        definition,
        new Uint8Array(row.displayText),
      );
      if (!checked.ok) throw new Error(`a stored display text fails its check: ${checked.problem}`);
      await insertSearchText(client, electionId, checked);
      written++;
      after = electionId;
    }
    if (rows.length < FILL_BATCH) return written;
  }
}
