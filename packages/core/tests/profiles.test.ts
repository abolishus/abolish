import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountProfileNamings,
  accountProfilePolls,
  accountProfiles,
  askedBy,
  deleteProfile,
  makeProfile,
  MAX_PROFILE_NAME,
  newAccountId,
  newProfileHandle,
  PROFILE_HANDLE,
  ProfileError,
  type ProfileErrorCode,
  profileHandles,
  profileName,
  readOwnProfile,
  readProfile,
  renameProfile,
  showOnProfile,
  storeDefinition,
} from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// Creator profiles (migrations/0033_account_profiles.sql, src/profiles.ts;
// [[0040-creator-profiles]], P2-27 part 1b): one per account with a verified
// phone, a checked name set at most once a UTC day and a random handle never
// issued twice, showing only the polls its author chose that are registered
// and listed, all of it account-side (T-10, T-52, T-75).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

const NOW = new Date("2026-10-22T12:34:56Z");
const at = { now: NOW };
const DAY = 86_400_000;
const later = (days: number) => ({ now: new Date(NOW.getTime() + days * DAY) });

async function newAccount({ phone = true } = {}): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  // A stand-in for a verified number: its hash, as account-phones.ts stores it.
  if (phone)
    await app`INSERT INTO account_phones VALUES (${id}, ${randomBytes(32)}, 'p1', '2026-10-01T00:00:00Z')`;
  return id;
}

/** A draft of `user`'s, not yet an election. */
async function draft(user: string): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at)
    VALUES (${id}, ${user}, 'drafted', '{}', now(), now())`;
  return id;
}

const blocks = { next: 1 };

/**
 * An open poll of `user`'s: its creator record, and unless `stored` is false
 * its definition and registration as the registry sync stores them.
 */
async function openPoll(user: string, { stored = true } = {}) {
  const id = newAccountId();
  const electionId = new Uint8Array(randomBytes(32));
  await app`
    INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
      creator_address, create_tx_hash, election_id, created_block, l1_origin_timestamp,
      anchors_checked_block, electorate, stub_hash, ceremony_tx_hash, register_tx_hash,
      registered_block)
    VALUES (${id}, ${user}, 'open', '{}', now(), now(), now(), ${randomBytes(20)},
      ${randomBytes(32)}, ${electionId}, 1, 1, 1, '[]', ${randomBytes(32)}, ${randomBytes(32)},
      ${randomBytes(32)}, 2)`;
  if (stored) {
    await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: electionId }));
    await db.admin`INSERT INTO election_registrations
      VALUES (${electionId}, ${randomBytes(32)}, ${(blocks.next++).toString()}, 0)`;
  }
  return { id, electionId };
}

async function decide(electionId: Uint8Array, action: "delist" | "hide" | "restore") {
  const reason = action === "restore" ? "error" : "illegal";
  await app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
    VALUES (${electionId}, ${action}, ${reason}, 'mod', now())`;
}

/** An account with a profile named `name`, made on `NOW`'s day. */
async function profiled(name = "Riverside Neighbours") {
  const user = await newAccount();
  const handle = await makeProfile(app, user, name, at);
  return { user, handle };
}

async function refusedWith(p: Promise<unknown>): Promise<ProfileErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ProfileError) return e.code;
    throw e;
  }
  throw new Error("accepted");
}

async function failsWith(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (e) {
    return (e as { code?: string }).code ?? "no code";
  }
  throw new Error("query succeeded");
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** The polls the profile at `handle` shows, failing if it isn't shown at all. */
async function shownPolls(handle: string): Promise<readonly Uint8Array[]> {
  const p = await readProfile(app, handle);
  if (p?.state !== "visible") throw new Error(`profile ${handle} isn't shown`);
  return p.polls;
}

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [
      profileHandles,
      accountProfiles,
      accountProfileNamings,
      accountProfilePolls,
    ]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect([
        config.name,
        cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]]),
      ]).toEqual([
        config.name,
        config.columns.map((c) => [c.name, c.getSQLType(), c.notNull ? "NO" : "YES"]),
      ]);
    }
  });

  test("no profile row keeps a time but the day of a naming", async () => {
    const cols = await db.admin`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ANY(${[
        "profile_handles",
        "account_profiles",
        "account_profile_namings",
        "account_profile_polls",
      ]})
      ORDER BY table_name, ordinal_position`;
    // T-11, T-75: a handle alone; a profile's name; a choice's poll record.
    expect(cols.map((c) => [c["table_name"], c["column_name"], c["data_type"]])).toEqual([
      ["account_profile_namings", "user_id", "text"],
      ["account_profile_namings", "named_on", "timestamp with time zone"],
      ["account_profile_polls", "poll_id", "text"],
      ["account_profile_polls", "user_id", "text"],
      ["account_profiles", "user_id", "text"],
      ["account_profiles", "handle", "text"],
      ["account_profiles", "name", "text"],
      ["profile_handles", "handle", "text"],
    ]);
    const user = await newAccount();
    await expect(
      app`INSERT INTO account_profile_namings VALUES (${user}, '2026-10-22T12:00:00Z')`,
    ).rejects.toThrow(/check constraint/);
  });

  test("a handle is never removed or changed, and a profile's handle never changes", async () => {
    const { user, handle } = await profiled();
    expect(await failsWith(app`DELETE FROM profile_handles WHERE handle = ${handle}`)).toBe(
      "42501",
    );
    expect(await failsWith(app`UPDATE profile_handles SET handle = ${newProfileHandle()}`)).toBe(
      "42501",
    );
    expect(await failsWith(app`TRUNCATE profile_handles`)).toBe("42501");
    expect(
      await failsWith(app`UPDATE account_profiles SET handle = ${handle} WHERE user_id = ${user}`),
    ).toBe("42501");
    expect(await failsWith(app`INSERT INTO profile_handles VALUES (${handle})`)).toBe("23505");
    expect(await failsWith(app`INSERT INTO profile_handles VALUES ('ABCDEFGHIJKLMNOP')`)).toBe(
      "23514",
    );
  });

  test("a choice is made or taken back, never changed in place", async () => {
    const { user } = await profiled();
    const poll = await draft(user);
    await showOnProfile(app, user, poll, true);
    expect(
      await failsWith(
        app`UPDATE account_profile_polls SET user_id = user_id WHERE poll_id = ${poll}`,
      ),
    ).toBe("42501");
    expect(await failsWith(app`DELETE FROM account_profile_namings WHERE user_id = ${user}`)).toBe(
      "42501",
    );
  });

  test("the table refuses a choice of another account's poll", async () => {
    const a = await profiled();
    const b = await newAccount();
    const theirs = await draft(b);
    expect(
      await failsWith(app`INSERT INTO account_profile_polls VALUES (${theirs}, ${a.user})`),
    ).toBe("23503");
  });

  test("the table refuses a name profileName wouldn't make", async () => {
    const { user } = await profiled();
    for (const bad of [
      "",
      " lead",
      "trail ",
      "two  spaces",
      "tab\there",
      "e\u0301",
      "x".repeat(61),
    ])
      expect(
        await failsWith(app`UPDATE account_profiles SET name = ${bad} WHERE user_id = ${user}`),
      ).toBe("23514");
  });

  test("the table takes every name profileName makes", async () => {
    const { user } = await profiled();
    await fc.assert(
      fc.asyncProperty(fc.string({ unit: "grapheme", maxLength: 80 }), async (raw) => {
        const name = profileName(raw);
        if (name === undefined) return;
        await app`UPDATE account_profiles SET name = ${name} WHERE user_id = ${user}`;
        const [row] = await app`SELECT name FROM account_profiles WHERE user_id = ${user}`;
        expect(row!["name"]).toBe(name);
      }),
      { numRuns },
    );
  });
});

describe("profileName", () => {
  test("collapses spaces, trims and composes", () => {
    expect(profileName("  Riverside   Neighbours ")).toBe("Riverside Neighbours");
    expect(profileName("Cafe\u0301 club")).toBe("Caf\u00e9 club");
    expect(profileName("x".repeat(MAX_PROFILE_NAME))).toBe("x".repeat(MAX_PROFILE_NAME));
    // Code points, not UTF-16 units: 60 astral characters are 120 units.
    expect(profileName("😀".repeat(MAX_PROFILE_NAME))).toBe("😀".repeat(MAX_PROFILE_NAME));
  });

  test("refuses hidden, control and separator characters (T-75)", () => {
    for (const c of [
      "\u202e", // right-to-left override
      "\u2066", // left-to-right isolate
      "\u200b", // zero-width space
      "\u200d", // zero-width joiner
      "\u00ad", // soft hyphen
      "\ufeff", // byte-order mark
      "\t",
      "\n",
      "\u0000",
      "\u00a0", // no-break space
      "\u3000", // ideographic space
      "\u2028", // line separator
      "\ue000", // private use
      "\ud800", // lone surrogate
      "\u0378", // unassigned
      "\u3164", // Hangul filler
      "\uffa0", // halfwidth Hangul filler
      "\u115f", // Hangul choseong filler
      "\u034f", // combining grapheme joiner
      "\ufe0f", // variation selector
      "\u{e0100}", // supplementary variation selector
      "\u180b", // Mongolian free variation selector
      "\u17b4", // Khmer inherent vowel
      "\u2800", // Braille blank
    ])
      expect(profileName(`Riverside${c}Neighbours`), JSON.stringify(c)).toBeUndefined();
  });

  test("refuses an empty name, a blank one and one too long", () => {
    expect(profileName("")).toBeUndefined();
    expect(profileName("    ")).toBeUndefined();
    expect(profileName("\u0301\u0301")).toBeUndefined();
    expect(profileName(" \u0301 ")).toBeUndefined();
    expect(profileName("x".repeat(MAX_PROFILE_NAME + 1))).toBeUndefined();
    expect(profileName(42)).toBeUndefined();
  });

  test("what it makes is its own fixed point and within the table's rules", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 80 }), (raw) => {
        const name = profileName(raw);
        if (name === undefined) return;
        expect(profileName(name)).toBe(name);
        expect(name).toBe(name.normalize("NFC"));
        expect(name).not.toMatch(/^ | $| {2}/);
        const length = Array.from(name).length;
        expect(length).toBeGreaterThanOrEqual(1);
        expect(length).toBeLessThanOrEqual(MAX_PROFILE_NAME);
      }),
      { numRuns },
    );
  });
});

describe("handles", () => {
  test("a handle is 16 base32 characters, fresh each time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const h = newProfileHandle();
      expect(h).toMatch(PROFILE_HANDLE);
      seen.add(h);
    }
    expect(seen.size).toBe(1000);
  });

  test("every character position takes every base32 character", () => {
    const at = Array.from({ length: 16 }, () => new Set<string>());
    for (let i = 0; i < 2000; i++) Array.from(newProfileHandle()).forEach((c, j) => at[j]!.add(c));
    // 2000 draws miss one of 32 values with probability about 32·(31/32)^2000.
    for (const s of at) expect(s.size).toBe(32);
  });
});

describe("making, renaming and deleting", () => {
  test("an account with a verified phone makes one profile", async () => {
    const user = await newAccount();
    const handle = await makeProfile(app, user, "  Riverside  Neighbours ", at);
    expect(handle).toMatch(PROFILE_HANDLE);
    expect(await readOwnProfile(app, user, at)).toEqual({
      handle,
      name: "Riverside Neighbours",
      renamableOn: new Date("2026-10-23T00:00:00Z"),
      pollIds: [],
    });
    expect(await refusedWith(makeProfile(app, user, "Another", later(2)))).toBe("exists");
  });

  test("refuses, writing nothing: a bad name, then no phone", async () => {
    const user = await newAccount({ phone: false });
    expect(await refusedWith(makeProfile(app, user, "\u202eevil", at))).toBe("invalid-name");
    expect(await refusedWith(makeProfile(app, user, "Riverside", at))).toBe("account");
    expect(await db.admin`SELECT 1 FROM account_profiles WHERE user_id = ${user}`).toHaveLength(0);
    expect(
      await db.admin`SELECT 1 FROM account_profile_namings WHERE user_id = ${user}`,
    ).toHaveLength(0);
  });

  test("a name is set once a UTC day, making included", async () => {
    const { user } = await profiled("First");
    expect(await refusedWith(renameProfile(app, user, "Second", at))).toBe("too-soon");
    // The name it has changes nothing, and is no refusal.
    expect(await renameProfile(app, user, " First ", at)).toBe(false);
    const nextDay = { now: new Date("2026-10-23T00:00:00Z") };
    expect(await readOwnProfile(app, user, nextDay)).toMatchObject({ renamableOn: undefined });
    expect(await renameProfile(app, user, "Second", nextDay)).toBe(true);
    expect(await readOwnProfile(app, user, nextDay)).toMatchObject({
      name: "Second",
      renamableOn: new Date("2026-10-24T00:00:00Z"),
    });
    expect(await refusedWith(renameProfile(app, user, "Third", nextDay))).toBe("too-soon");
  });

  test("deleting and making again doesn't reset the day", async () => {
    const { user, handle } = await profiled("First");
    expect(await deleteProfile(app, user)).toBe(true);
    expect(await deleteProfile(app, user)).toBe(false);
    expect(await refusedWith(makeProfile(app, user, "Second", at))).toBe("too-soon");
    const again = await makeProfile(app, user, "Second", later(1));
    // A new handle: the old one is retired, still issued, never reissued.
    expect(again).not.toBe(handle);
    expect(await db.admin`SELECT 1 FROM profile_handles WHERE handle = ${handle}`).toHaveLength(1);
    expect(await readProfile(app, handle)).toBeUndefined();
  });

  test("rename refuses a bad name and an account with no profile", async () => {
    const { user } = await profiled();
    expect(await refusedWith(renameProfile(app, user, "", later(1)))).toBe("invalid-name");
    expect(await refusedWith(renameProfile(app, await newAccount(), "X", at))).toBe("no-profile");
  });

  test("two makes at once make one profile", async () => {
    const user = await newAccount();
    const results = await Promise.allSettled([
      makeProfile(app, user, "One", at),
      makeProfile(await db.as("abolish_app"), user, "Two", at),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await db.admin`SELECT 1 FROM account_profiles WHERE user_id = ${user}`).toHaveLength(1);
  });

  test("deleting the account deletes its profile and choices, and keeps the handle issued", async () => {
    const { user, handle } = await profiled();
    const { id } = await openPoll(user);
    await showOnProfile(app, user, id, true);
    await app`DELETE FROM account_users WHERE id = ${user}`;
    expect(await readProfile(app, handle)).toBeUndefined();
    expect(await db.admin`SELECT 1 FROM account_profile_polls WHERE poll_id = ${id}`).toHaveLength(
      0,
    );
    expect(await db.admin`SELECT 1 FROM profile_handles WHERE handle = ${handle}`).toHaveLength(1);
  });

  test("refuses a malformed account ID or time", async () => {
    await expect(makeProfile(app, "nope", "X", at)).rejects.toThrow(RangeError);
    await expect(
      makeProfile(app, await newAccount(), "X", { now: new Date(Number.NaN) }),
    ).rejects.toThrow(TypeError);
  });
});

describe("each poll's choice", () => {
  test("shows and stops showing an author's poll, at any state", async () => {
    const { user } = await profiled();
    const poll = await draft(user);
    expect(await showOnProfile(app, user, poll, true)).toBe(true);
    expect(await showOnProfile(app, user, poll, true)).toBe(false);
    expect((await readOwnProfile(app, user, at))?.pollIds).toEqual([poll]);
    expect(await showOnProfile(app, user, poll, false)).toBe(true);
    expect(await showOnProfile(app, user, poll, false)).toBe(false);
    expect((await readOwnProfile(app, user, at))?.pollIds).toEqual([]);
  });

  test("refuses a poll of another account's, and an account with no profile", async () => {
    const { user } = await profiled();
    const other = await newAccount();
    const theirs = await draft(other);
    expect(await refusedWith(showOnProfile(app, user, theirs, true))).toBe("not-found");
    expect(await refusedWith(showOnProfile(app, user, newAccountId(), true))).toBe("not-found");
    expect(await refusedWith(showOnProfile(app, other, theirs, true))).toBe("no-profile");
    // Stopping another's choice changes nothing.
    const mine = await draft(user);
    await showOnProfile(app, user, mine, true);
    expect(await showOnProfile(app, other, mine, false)).toBe(false);
    expect((await readOwnProfile(app, user, at))?.pollIds).toEqual([mine]);
  });

  test("deleting the profile deletes every choice; deleting the poll deletes its own", async () => {
    const { user } = await profiled();
    const [a, b] = [await draft(user), await draft(user)];
    await showOnProfile(app, user, a, true);
    await showOnProfile(app, user, b, true);
    await app`DELETE FROM account_polls WHERE id = ${a}`;
    expect((await readOwnProfile(app, user, at))?.pollIds).toEqual([b]);
    await deleteProfile(app, user);
    await makeProfile(app, user, "Again", later(1));
    expect((await readOwnProfile(app, user, later(1)))?.pollIds).toEqual([]);
  });
});

describe("what anyone sees", () => {
  test("a profile shows its name and the registered, listed polls its author chose", async () => {
    const { user, handle } = await profiled();
    const shown = await openPoll(user);
    const newer = await openPoll(user);
    const unchosen = await openPoll(user);
    const unregistered = await openPoll(user, { stored: false });
    const drafted = await draft(user);
    for (const p of [shown.id, newer.id, unregistered.id, drafted])
      await showOnProfile(app, user, p, true);
    expect(await readProfile(app, handle)).toEqual({
      handle,
      state: "visible",
      name: "Riverside Neighbours",
      // The latest registered first.
      polls: [newer.electionId, shown.electionId],
    });
    expect(await askedBy(app, shown.electionId)).toEqual({ handle, name: "Riverside Neighbours" });
    expect(await askedBy(app, unchosen.electionId)).toBeUndefined();
    expect(await askedBy(app, new Uint8Array(randomBytes(32)))).toBeUndefined();
  });

  test("a delisted or hidden poll leaves the profile; a restored one returns", async () => {
    const { user, handle } = await profiled();
    const delisted = await openPoll(user);
    const hidden = await openPoll(user);
    await showOnProfile(app, user, delisted.id, true);
    await showOnProfile(app, user, hidden.id, true);
    await decide(delisted.electionId, "delist");
    await decide(hidden.electionId, "hide");
    expect(await shownPolls(handle)).toEqual([]);
    // A delisted poll's own page still says who asked it; a hidden one's says nothing.
    expect(await askedBy(app, delisted.electionId)).toEqual({
      handle,
      name: "Riverside Neighbours",
    });
    expect(await askedBy(app, hidden.electionId)).toBeUndefined();
    await decide(hidden.electionId, "restore");
    expect((await shownPolls(handle)).map(hex)).toEqual([hex(hidden.electionId)]);
    expect(await askedBy(app, hidden.electionId)).toEqual({ handle, name: "Riverside Neighbours" });
  });

  test("unlinking takes the poll off the profile and its 'Asked by' away at once", async () => {
    const { user, handle } = await profiled();
    const poll = await openPoll(user);
    await showOnProfile(app, user, poll.id, true);
    await showOnProfile(app, user, poll.id, false);
    expect(await shownPolls(handle)).toEqual([]);
    expect(await askedBy(app, poll.electionId)).toBeUndefined();
  });

  test("a rename changes the name on every shown poll", async () => {
    const { user, handle } = await profiled("Before");
    const poll = await openPoll(user);
    await showOnProfile(app, user, poll.id, true);
    await renameProfile(app, user, "After", later(1));
    expect(await askedBy(app, poll.electionId)).toEqual({ handle, name: "After" });
    expect(await readProfile(app, handle)).toMatchObject({ state: "visible", name: "After" });
  });

  test("no profile at a handle never made, or a string that isn't one", async () => {
    expect(await readProfile(app, newProfileHandle())).toBeUndefined();
    expect(await readProfile(app, "not-a-handle")).toBeUndefined();
    expect(await readProfile(app, "ABCDEFGHIJKLMNOP")).toBeUndefined();
    await expect(askedBy(app, new Uint8Array(31))).rejects.toThrow(TypeError);
  });
});
