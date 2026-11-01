import {
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV7,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  encodeElectionDefinitionV7,
  QUESTION_METHODS,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  DisplayTextError,
  ModerationError,
  type DisplayTextErrorCode,
  displayTexts,
  moderate,
  readServedDisplayText,
  storeDefinition,
  storeDisplayText,
} from "../src/index.ts";
import { addModerators, type TestDb, testDb, typical } from "./db.ts";

// Display text (migrations/0011_display_texts.sql, src/display-texts.ts;
// docs/spec/display-text.md, docs/moderation-policy.md; T-34, T-41, T-68):
// only text that passes the ballot client's own check against the stored
// definition is stored, and what is served follows the moderation policy.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const vectors = <T>(name: string): T[] =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/spec/vectors/${name}.json`, import.meta.url), "utf8"),
  ).vectors;
interface TextVector {
  id: string;
  encoding: string;
  error?: string;
  illFormed?: string;
  definition?: { optionCount: string; displayTextCommitment: string };
}
const textVectors = vectors<TextVector>("display-text");
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const goodText = textVectors.find((v) => v.id === "display-text-two-languages")!;

const nowSeconds = () => BigInt(Math.floor(Date.now() / 1000));

let db: TestDb;
let app: Sql;
let owner: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  await addModerators(app, "mod-1");
  owner = await db.as("abolish_migrator");
});
afterAll(() => db?.close());

/**
 * A stored election committing to `text`'s vector definition (the good
 * two-language text by default). The typical vector's poll closed in January
 * 2026; `closesAt` moves the close.
 */
async function election(
  text: TextVector = goodText,
  closesAt = typical.closes_at,
): Promise<Uint8Array> {
  const id = new Uint8Array(randomBytes(32));
  const opensAt = typical.opens_at < closesAt ? typical.opens_at : closesAt - 1n;
  const committed = text.definition ?? goodText.definition!;
  await storeDefinition(
    app,
    encodeElectionDefinition({
      ...typical,
      election_id: id,
      opens_at: opensAt,
      closes_at: closesAt,
      option_count: Number(committed.optionCount),
      display_text_commitment: hex(committed.displayTextCommitment),
    }),
  );
  return id;
}

async function refusedWith(p: Promise<unknown>): Promise<[DisplayTextErrorCode, unknown]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DisplayTextError) return [e.code, e.cause];
    throw e;
  }
  throw new Error("store succeeded");
}

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const stored = async (id: Uint8Array) =>
  (await app`SELECT display_text FROM display_texts WHERE election_id = ${id}`).map(
    (r) => new Uint8Array(r["display_text"] as Uint8Array),
  );

describe("schema", () => {
  test("the Drizzle table matches the migrated one", async () => {
    const cols = await db.admin`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = 'display_texts'
      ORDER BY ordinal_position`;
    const config = getTableConfig(displayTexts);
    expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
      config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
    );
  });

  test("the app role holds SELECT, INSERT and DELETE: it can't change a record or truncate", async () => {
    const privs = await db.admin`
      SELECT privilege_type FROM information_schema.role_table_grants
      WHERE table_schema = ${db.schema} AND table_name = 'display_texts'
        AND grantee = 'abolish_app'
      ORDER BY privilege_type`;
    expect(privs.map((p) => p["privilege_type"])).toEqual(["DELETE", "INSERT", "SELECT"]);
    const id = await election();
    await storeDisplayText(app, id, hex(goodText.encoding));
    expect(await failsWith(app`UPDATE display_texts SET display_text = ${hex("000901")}`)).toBe(
      "42501",
    );
    expect(await failsWith(app`TRUNCATE display_texts`)).toBe("42501");
    await app`DELETE FROM display_texts WHERE election_id = ${id}`;
    expect(await stored(id)).toEqual([]);
  });

  test("the table refuses ids and records of the wrong shape", async () => {
    const insert = (id: Uint8Array, text: Uint8Array) =>
      owner`INSERT INTO display_texts (election_id, display_text) VALUES (${id}, ${text})`;
    for (const q of [
      insert(new Uint8Array(31), hex("000901")),
      insert(new Uint8Array(33), hex("000901")),
      insert(new Uint8Array(randomBytes(32)), hex("0009")),
      insert(new Uint8Array(randomBytes(32)), hex("000101")),
      insert(new Uint8Array(randomBytes(32)), new Uint8Array(4_194_305).fill(9, 1, 2)),
    ])
      expect(await failsWith(q)).toBe("23514");
  });
});

describe("storing", () => {
  test("text that passes the show check is stored byte for byte, and again is a no-op", async () => {
    const id = await election();
    await storeDisplayText(app, id, hex(goodText.encoding));
    await storeDisplayText(app, id, hex(goodText.encoding));
    expect(await stored(id)).toEqual([hex(goodText.encoding)]);
  });

  test("every good text vector is stored under a definition that commits to it", async () => {
    for (const v of textVectors.filter((v) => v.error === undefined && v.illFormed === undefined)) {
      const id = await election(v);
      await storeDisplayText(app, id, hex(v.encoding));
      expect(await stored(id), v.id).toEqual([hex(v.encoding)]);
    }
  });

  test("text for an election with no stored definition is refused", async () => {
    const id = new Uint8Array(randomBytes(32));
    expect((await refusedWith(storeDisplayText(app, id, hex(goodText.encoding))))[0]).toBe(
      "unknown-election",
    );
    expect(await stored(id)).toEqual([]);
  });

  test("ill-formed and undecodable vectors are refused with the check that failed", async () => {
    for (const v of textVectors.filter((v) => v.error !== undefined || v.illFormed !== undefined)) {
      const id = await election(v);
      const [code, cause] = await refusedWith(storeDisplayText(app, id, hex(v.encoding)));
      expect(code, v.id).toBe("refused");
      expect(cause, v.id).toEqual(
        v.illFormed === undefined
          ? { ok: false, problem: "display-text-undecodable" }
          : { ok: false, problem: "display-text-ill-formed", rule: v.illFormed },
      );
      expect(await stored(id), v.id).toEqual([]);
    }
  });

  test("good text under a definition that commits to other text is refused", async () => {
    const other = textVectors.find((v) => v.id === "display-text-one-language")!;
    const id = await election(other);
    const [code, cause] = await refusedWith(storeDisplayText(app, id, hex(goodText.encoding)));
    expect(code).toBe("refused");
    expect(cause).toMatchObject({ problem: "display-text-ill-formed", rule: "commitment" });
  });

  test("arbitrary bytes are never stored", async () => {
    const id = await election();
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        const [code] = await refusedWith(storeDisplayText(app, id, bytes));
        expect(code).toBe("refused");
      }),
      { numRuns: Math.min(numRuns, 200) },
    );
    expect(await stored(id)).toEqual([]);
  });

  test("other bytes for an election that already has a row are a conflict", async () => {
    const id = await election();
    await app`INSERT INTO display_texts (election_id, display_text) VALUES (${id}, ${hex("000901")})`;
    expect((await refusedWith(storeDisplayText(app, id, hex(goodText.encoding))))[0]).toBe(
      "conflict",
    );
    expect(await stored(id)).toEqual([hex("000901")]);
  });

  test("refuses an election id that isn't 32 bytes and text that isn't bytes", async () => {
    await expect(storeDisplayText(app, new Uint8Array(31), hex(goodText.encoding))).rejects.toThrow(
      TypeError,
    );
    await expect(
      storeDisplayText(app, await election(), goodText.encoding as unknown as Uint8Array),
    ).rejects.toThrow(TypeError);
  });
});

describe("serving", () => {
  const mod = (action: "hide" | "delist" | "restore", reason: string) =>
    ({ action, reason, moderator: "mod-1" }) as Parameters<typeof moderate>[2];

  /** An election with its text stored, closing `days` from now (negative: in the past). */
  async function withText(days?: number) {
    const closesAt =
      days === undefined ? typical.closes_at : nowSeconds() + BigInt(days * 24 * 3600);
    const id = await election(goodText, closesAt);
    await storeDisplayText(app, id, hex(goodText.encoding));
    return { id, closesAt };
  }

  const served = (id: Uint8Array, now = nowSeconds()) => readServedDisplayText(app, id, now);

  test("a visible or delisted poll's text is served as stored", async () => {
    const { id } = await withText();
    expect(await served(id)).toEqual({ served: "text", displayText: hex(goodText.encoding) });
    await moderate(app, id, mod("delist", "spam"));
    expect(await served(id)).toEqual({ served: "text", displayText: hex(goodText.encoding) });
  });

  test("an unknown election is undefined, and a known one without text is none", async () => {
    expect(await served(new Uint8Array(randomBytes(32)))).toBeUndefined();
    expect(await served(await election())).toEqual({ served: "none" });
  });

  test("a closed poll hidden on any ground is withheld, and served again once restored", async () => {
    for (const reason of ["spam", "threat", "illegal", "personal-data"]) {
      const { id } = await withText();
      await moderate(app, id, mod("hide", reason));
      expect(await served(id), reason).toEqual({ served: "withheld" });
      await moderate(app, id, mod("restore", "error"));
      expect((await served(id))?.served, reason).toBe("text");
    }
  });

  test("an open poll hidden as a threat is served until the inclusion bound after its close", async () => {
    const { id, closesAt } = await withText(10);
    await moderate(app, id, mod("hide", "threat"));
    const bound = closesAt + BigInt(typical.l1_inclusion_bound);
    expect((await served(id))?.served).toBe("text");
    expect((await served(id, bound - 1n))?.served).toBe("text");
    expect(await served(id, bound)).toEqual({ served: "withheld" });
  });

  test("an open poll hidden as illegal or personal data is withheld at once", async () => {
    for (const reason of ["illegal", "personal-data"]) {
      const { id } = await withText(10);
      await moderate(app, id, mod("hide", reason));
      expect(await served(id), reason).toEqual({ served: "withheld" });
    }
  });

  test("a personal-data or illegal hide re-cited as a threat stays withheld", async () => {
    for (const reason of ["illegal", "personal-data"]) {
      const { id } = await withText(10);
      await moderate(app, id, mod("hide", reason));
      await moderate(app, id, mod("hide", "threat"));
      expect(await served(id), reason).toEqual({ served: "withheld" });
    }
  });

  test("only the grounds since the last change of state count", async () => {
    const { id } = await withText(10);
    await moderate(app, id, mod("hide", "personal-data"));
    await moderate(app, id, mod("restore", "error"));
    await moderate(app, id, mod("hide", "threat"));
    expect((await served(id))?.served).toBe("text");
  });

  test("a threat hide re-cited as personal data is withheld from then on", async () => {
    const { id } = await withText(10);
    await moderate(app, id, mod("hide", "threat"));
    expect((await served(id))?.served).toBe("text");
    await moderate(app, id, mod("hide", "personal-data"));
    expect(await served(id)).toEqual({ served: "withheld" });
  });
});

// Definition version 5 and display-text version 2 (P2-14): the same check,
// the client's `checkElectionRecordToShow`, reads every question against the
// definition's, and the served window reads the version-5 close.
describe("a poll of several questions", () => {
  interface TextV2Vector {
    id: string;
    pinned: number;
    encoding: string;
    error?: string;
    illFormed?: string;
    definition?: { optionCounts: string[]; displayTextCommitment: string };
  }
  // Pinning display-text version 2, as the client's check asks of version 5.
  const v2 = vectors<TextV2Vector>("display-text-v2").filter((v) => v.pinned === 2);
  const goodV2 = v2.find((v) => v.id === "display-text-v2-two-questions")!;
  // verifier-ballots-v3.json's definition, under a profile 2.3 passes.
  const base = decodeElectionDefinitionV5(
    hex(
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

  /** A stored version-5 election whose questions and commitment are `text`'s vector definition's. */
  async function electionV5(text: TextV2Vector = goodV2, closesAt = base.closes_at) {
    const id = new Uint8Array(randomBytes(32));
    const committed = text.definition ?? goodV2.definition!;
    await storeDefinition(
      app,
      encodeElectionDefinitionV5({
        ...base,
        election_id: id,
        opens_at: base.opens_at < closesAt ? base.opens_at : closesAt - 1n,
        closes_at: closesAt,
        questions: committed.optionCounts.map((n) => ({
          method: QUESTION_METHODS.selection,
          option_count: Number(n),
          min_selections: 0,
          max_selections: 1,
        })),
        display_text_commitment: hex(committed.displayTextCommitment),
      }),
    );
    return id;
  }

  test("every good version-2 vector is stored under a definition that commits to it", async () => {
    const good = v2.filter((v) => v.error === undefined && v.illFormed === undefined);
    expect(good.length).toBeGreaterThan(1);
    for (const v of good) {
      const id = await electionV5(v);
      await storeDisplayText(app, id, hex(v.encoding));
      await storeDisplayText(app, id, hex(v.encoding));
      expect(await stored(id), v.id).toEqual([hex(v.encoding)]);
    }
  });

  test("ill-formed and undecodable version-2 vectors are refused with the check that failed", async () => {
    const bad = v2.filter((v) => v.error !== undefined || v.illFormed !== undefined);
    expect(bad.some((v) => v.illFormed === "question-count")).toBe(true);
    for (const v of bad) {
      const id = await electionV5(v);
      const [code, cause] = await refusedWith(storeDisplayText(app, id, hex(v.encoding)));
      expect(code, v.id).toBe("refused");
      expect(cause, v.id).toEqual(
        v.illFormed === undefined
          ? { ok: false, problem: "display-text-undecodable" }
          : { ok: false, problem: "display-text-ill-formed", rule: v.illFormed },
      );
      expect(await stored(id), v.id).toEqual([]);
    }
  });

  // A rolling poll (definition version 7, P2-17) reads its questions as
  // version 5's, under its own hash and rules, so its text is stored too,
  // and another record's text is refused as before (T-34, T-41).
  test("a rolling version-7 poll's text is stored under a definition that commits to it", async () => {
    const rolling = decodeElectionDefinitionV7(
      hex(
        (
          JSON.parse(
            readFileSync(
              new URL("../../../docs/spec/vectors/verifier-ballots-v5.json", import.meta.url),
              "utf8",
            ),
          ) as { cases: { id: string; definition: string }[] }
        ).cases.find((c) => c.id === "board")!.definition,
      ),
    );
    const id = new Uint8Array(randomBytes(32));
    const committed = goodV2.definition!;
    await storeDefinition(
      app,
      encodeElectionDefinitionV7({
        ...rolling,
        election_id: id,
        questions: committed.optionCounts.map((n) => ({
          method: QUESTION_METHODS.selection,
          option_count: Number(n),
          min_selections: 0,
          max_selections: 1,
        })),
        display_text_commitment: hex(committed.displayTextCommitment),
      }),
    );
    const other = v2.find(
      (v) => v.id !== goodV2.id && v.error === undefined && v.illFormed === undefined,
    )!;
    const [code, cause] = await refusedWith(storeDisplayText(app, id, hex(other.encoding)));
    expect(code).toBe("refused");
    expect(cause).toEqual({ ok: false, problem: "display-text-ill-formed", rule: "commitment" });
    await storeDisplayText(app, id, hex(goodV2.encoding));
    expect(await stored(id)).toEqual([hex(goodV2.encoding)]);
  });

  test("version-1 text is refused for a poll of several questions", async () => {
    const id = await electionV5();
    const [code, cause] = await refusedWith(storeDisplayText(app, id, hex(goodText.encoding)));
    expect(code).toBe("refused");
    expect(cause).toEqual({ ok: false, problem: "display-text-undecodable" });
  });

  test("an open poll is hidden only as a threat, and its text served until the inclusion bound", async () => {
    const mod = (action: "hide" | "delist" | "restore", reason: string) =>
      ({ action, reason, moderator: "mod-1" }) as Parameters<typeof moderate>[2];
    const closesAt = nowSeconds() + 10n * 24n * 3600n;
    const id = await electionV5(goodV2, closesAt);
    await storeDisplayText(app, id, hex(goodV2.encoding));
    const refused = await moderate(app, id, mod("hide", "spam")).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ModerationError);
    expect((refused as ModerationError).code).toBe("open-poll");
    await moderate(app, id, mod("hide", "threat"));
    const bound = closesAt + BigInt(base.l1_inclusion_bound);
    expect((await readServedDisplayText(app, id, bound - 1n))?.served).toBe("text");
    expect(await readServedDisplayText(app, id, bound)).toEqual({ served: "withheld" });
  });
});
