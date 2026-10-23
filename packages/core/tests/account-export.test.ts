import { encodeElectionDefinition } from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  ACCOUNT_EXPORT,
  ACCOUNT_EXPORT_VERSION,
  addModerator,
  type EmailKeys,
  emailKeys,
  type EmailMessage,
  exportAccount,
  makeProfile,
  newAccountId,
  parseKeyring,
  REACTIONS,
  requestEmailCode,
  setReaction,
  showOnProfile,
  storeDefinition,
  TABLE_CLASSES,
  verifyEmailCode,
} from "../src/index.ts";
import { type TestDb, testDb, typical } from "./db.ts";

// An account's own export (src/account-export.ts; P2-27 part 2a): every
// account table classified, everything the account's rows say read back in
// one document, nothing of another account's, and no secret, keyed hash or
// ciphertext in it (T-10, T-68, T-73).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

let db: TestDb;
let app: Sql;
beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());

const NOW = new Date("2026-10-22T12:34:56Z");
const ring = (id: string) => parseKeyring(`${id}:${randomBytes(32).toString("hex")}`);
const KEYS: EmailKeys = emailKeys(ring("h1"), ring("b1"));
const at = { keys: KEYS, now: NOW };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

async function newAccount(): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, '2026-10-01T09:00:00Z', now())`;
  return id;
}

/** Verifies `address` for `account` through the code, as the website does. */
async function verified(account: string, address: string): Promise<void> {
  const sent: EmailMessage[] = [];
  await requestEmailCode(app, account, address, {
    keys: KEYS,
    sender: { send: async (m) => (sent.push(m), "sent") },
    turnstile: { verify: async () => "passed" },
    token: "t",
    locale: "es-US",
    now: NOW,
  });
  const [message] = sent;
  if (message?.kind !== "email-code") throw new Error("no code sent");
  await verifyEmailCode(app, account, message.code, { keys: KEYS, locale: "es-US", now: NOW });
}

async function draft(user: string, body: unknown = {}): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at)
    VALUES (${id}, ${user}, 'drafted', ${JSON.stringify(body)}::jsonb, '2026-10-02T00:00:00Z',
      '2026-10-03T00:00:00Z')`;
  return id;
}

async function openPoll(user: string) {
  const id = newAccountId();
  const electionId = new Uint8Array(randomBytes(32));
  await app`
    INSERT INTO account_polls (id, user_id, state, draft, created_at, updated_at, submitted_at,
      creator_address, create_tx_hash, election_id, created_block, l1_origin_timestamp,
      anchors_checked_block, electorate, stub_hash, ceremony_tx_hash, register_tx_hash,
      registered_block)
    VALUES (${id}, ${user}, 'open', '{"title":"Lunch?"}', '2026-10-04T00:00:00Z',
      '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z', ${randomBytes(20)}, ${randomBytes(32)},
      ${electionId}, 1, 1, 1, '[]', ${randomBytes(32)}, ${randomBytes(32)}, ${randomBytes(32)}, 2)`;
  await storeDefinition(app, encodeElectionDefinition({ ...typical, election_id: electionId }));
  return { id, electionId };
}

describe("coverage", () => {
  test("names every account table, and no other", () => {
    expect(Object.keys(ACCOUNT_EXPORT).sort()).toEqual([...TABLE_CLASSES.account].sort());
  });

  test("leaves out as naming no account only tables with no account column", async () => {
    const left = Object.entries(ACCOUNT_EXPORT)
      .filter(([, why]) => why.startsWith("names no account"))
      .map(([table]) => table);
    const cols = await db.admin`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = ${db.schema} AND table_name = ANY(${left})
        AND column_name IN ('user_id', 'handle')`;
    // profile_handles keeps every handle ever issued, with no account beside it.
    expect(cols.map((c) => c["table_name"])).toEqual(["profile_handles"]);
  });
});

describe("exportAccount", () => {
  test("a new account's export is its ID and creation, with nothing else", async () => {
    const user = await newAccount();
    expect(await exportAccount(app, user, at)).toEqual({
      version: ACCOUNT_EXPORT_VERSION,
      exportedAt: NOW.toISOString(),
      account: { id: user, createdAt: "2026-10-01T09:00:00.000Z" },
      passkeys: [],
      sessions: [],
      signInMethods: [],
      email: null,
      phone: null,
      polls: [],
      profile: null,
      profileNamedOn: null,
      reactions: [],
      tier0Tokens: [],
      moderator: null,
    });
  });

  test("gives back everything the account's rows say, and none of its secrets", async () => {
    const user = await newAccount();
    const token = randomBytes(24).toString("hex");
    const publicKey = randomBytes(40).toString("base64");
    const credentialId = randomBytes(16).toString("base64url");
    const blinded = randomBytes(32);
    const registry = randomBytes(20);
    await app`INSERT INTO account_passkeys VALUES (${newAccountId()}, ${user}, NULL, ${publicKey},
      ${credentialId}, 3, 'multiDevice', true, 'internal', NULL, '2026-10-01T09:00:00Z')`;
    await app`INSERT INTO account_sessions VALUES (${newAccountId()}, ${user}, ${token},
      '2026-10-29T09:00:00Z', NULL, NULL, '2026-10-22T09:00:00Z', now())`;
    await verified(user, "Someone@Example.org");
    const phoneHash = randomBytes(32);
    await app`INSERT INTO account_phones VALUES (${user}, ${phoneHash}, 'p1', '2026-10-10T00:00:00Z')`;
    const drafted = await draft(user, { title: "Where to meet", options: ["Park", "Library"] });
    const open = await openPoll(user);
    const handle = await makeProfile(app, user, "Riverside Neighbours", { now: NOW });
    await showOnProfile(app, user, open.id, true);
    await app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
      VALUES (${open.electionId}, 'hide', 'illegal', 'mod', now())`;
    const [hid] = await app`SELECT max(seq) AS seq FROM moderation_actions`;
    const seq = BigInt(hid!["seq"]);
    await db.admin`INSERT INTO account_appeals VALUES (${seq.toString()}, ${open.id},
      '2026-10-22T10:00:00Z', 'rejected', 'reviewer-one', '2026-10-22T11:00:00Z')`;
    await db.admin`INSERT INTO account_profile_appeals VALUES (${(seq + 1n).toString()}, ${handle},
      '2026-10-22T10:30:00Z', NULL, NULL, NULL)`;
    const reacted = await openPoll(await newAccount());
    await setReaction(app, user, reacted.electionId, "clap", true, { now: NOW });
    await setReaction(app, user, reacted.electionId, "heart", true, { now: NOW });
    await app`INSERT INTO account_tokens VALUES (${user}, 84532, ${registry}, 7, ${randomBytes(32)},
      3, ${blinded})`;
    await addModerator(app, "moderator-one", user);

    // Another account with every kind of row, none of which may show.
    const other = await newAccount();
    await app`INSERT INTO account_phones VALUES (${other}, ${randomBytes(32)}, 'p1', '2026-10-10T00:00:00Z')`;
    const otherPoll = await openPoll(other);
    const otherHandle = await makeProfile(app, other, "Someone Else", { now: NOW });
    await showOnProfile(app, other, otherPoll.id, true);
    await app`INSERT INTO moderation_actions (election_id, action, reason, moderator, decided_at)
      VALUES (${otherPoll.electionId}, 'hide', 'illegal', 'mod', now())`;
    const [otherHid] = await app`SELECT max(seq) AS seq FROM moderation_actions`;
    await db.admin`INSERT INTO account_appeals VALUES (${otherHid!["seq"]}, ${otherPoll.id},
      '2026-10-22T10:00:00Z', NULL, NULL, NULL)`;
    await db.admin`INSERT INTO account_profile_appeals VALUES (${(seq + 1000n).toString()},
      ${otherHandle}, '2026-10-22T10:30:00Z', NULL, NULL, NULL)`;
    const otherRegistry = randomBytes(20);
    await app`INSERT INTO account_tokens VALUES (${other}, 84532, ${otherRegistry}, 8, NULL, NULL,
      ${randomBytes(32)})`;
    await addModerator(app, "moderator-two", other);

    const out = await exportAccount(app, user, at);
    expect(out).toEqual({
      version: ACCOUNT_EXPORT_VERSION,
      exportedAt: NOW.toISOString(),
      account: { id: user, createdAt: "2026-10-01T09:00:00.000Z" },
      passkeys: [
        { createdAt: "2026-10-01T09:00:00.000Z", deviceType: "multiDevice", backedUp: true },
      ],
      sessions: [{ createdAt: "2026-10-22T09:00:00.000Z", expiresAt: "2026-10-29T09:00:00.000Z" }],
      signInMethods: [],
      email: {
        address: "Someone@Example.org",
        verifiedOn: "2026-10-22T00:00:00.000Z",
        locale: "es-US",
      },
      phone: { verifiedOn: "2026-10-10T00:00:00.000Z" },
      polls: [
        {
          id: drafted,
          state: "drafted",
          draft: { title: "Where to meet", options: ["Park", "Library"] },
          createdAt: "2026-10-02T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
          submittedAt: null,
          electionId: null,
          failure: null,
          appeals: [],
        },
        {
          id: open.id,
          state: "open",
          draft: { title: "Lunch?" },
          createdAt: "2026-10-04T00:00:00.000Z",
          updatedAt: "2026-10-05T00:00:00.000Z",
          submittedAt: "2026-10-05T00:00:00.000Z",
          electionId: hex(open.electionId),
          failure: null,
          appeals: [
            {
              decisionSeq: seq.toString(),
              filedAt: "2026-10-22T10:00:00.000Z",
              outcome: "rejected",
              reviewedAt: "2026-10-22T11:00:00.000Z",
            },
          ],
        },
      ],
      profile: {
        handle,
        name: "Riverside Neighbours",
        pollIds: [open.id],
        appeals: [
          {
            decisionSeq: (seq + 1n).toString(),
            filedAt: "2026-10-22T10:30:00.000Z",
            outcome: null,
            reviewedAt: null,
          },
        ],
      },
      profileNamedOn: "2026-10-22T00:00:00.000Z",
      reactions: [
        { electionId: hex(reacted.electionId), reaction: "clap" },
        { electionId: hex(reacted.electionId), reaction: "heart" },
      ],
      tier0Tokens: [{ chainId: "84532", groupRegistry: hex(registry), region: 7, keyPeriod: 3 }],
      moderator: { handle: "moderator-one", addedAt: expect.any(String) },
    });

    const [email] = await app`SELECT address_hash, address_box FROM account_emails
      WHERE user_id = ${user}`;
    const text = JSON.stringify(out).toLowerCase();
    for (const secret of [
      token,
      publicKey,
      credentialId,
      hex(blinded),
      hex(phoneHash),
      hex(email!["address_hash"]),
      hex(email!["address_box"]),
      "reviewer-one",
    ])
      expect(text).not.toContain(secret.toLowerCase());
    for (const theirs of [
      other,
      otherPoll.id,
      hex(otherPoll.electionId),
      otherHandle,
      "someone else",
      (seq + 1000n).toString(),
      hex(otherRegistry),
      "moderator-two",
    ])
      expect(text).not.toContain(theirs.toLowerCase());
  });

  test("a deleted profile's naming day stays, as the table keeps it", async () => {
    const user = await newAccount();
    await app`INSERT INTO account_phones VALUES (${user}, ${randomBytes(32)}, 'p1', '2026-10-10T00:00:00Z')`;
    await makeProfile(app, user, "Gone soon", { now: NOW });
    await app`DELETE FROM account_profiles WHERE user_id = ${user}`;
    const out = await exportAccount(app, user, at);
    expect(out?.profile).toBeNull();
    expect(out?.profileNamedOn).toBe("2026-10-22T00:00:00.000Z");
  });

  test("without the e-mail keys the address is null and the rest still exports", async () => {
    const user = await newAccount();
    await verified(user, "keyless@example.org");
    await draft(user, { title: "Kept" });
    const withKeys = await exportAccount(app, user, at);
    const without = await exportAccount(app, user, { keys: undefined, now: NOW });
    expect(withKeys?.email?.address).toBe("keyless@example.org");
    expect(without?.email).toEqual({
      address: null,
      verifiedOn: withKeys?.email?.verifiedOn,
      locale: "es-US",
    });
    expect({ ...without, email: null }).toEqual({ ...withKeys, email: null });
  });

  test("an unknown or deleted account has none; a malformed ID is refused", async () => {
    expect(await exportAccount(app, newAccountId(), at)).toBeUndefined();
    const user = await newAccount();
    await draft(user);
    await app`DELETE FROM account_users WHERE id = ${user}`;
    expect(await exportAccount(app, user, at)).toBeUndefined();
    for (const id of ["", "x", newAccountId().toUpperCase(), `${newAccountId()} `])
      await expect(exportAccount(app, id, at)).rejects.toThrow(RangeError);
  });

  test("one account's export holds its own drafts and reactions, never another's", async () => {
    const polls = [await openPoll(await newAccount()), await openPoll(await newAccount())];
    const reactionSet = fc.uniqueArray(
      fc.record({ poll: fc.nat({ max: 1 }), reaction: fc.constantFrom(...REACTIONS) }),
      { maxLength: 6, selector: (r) => `${r.poll} ${r.reaction}` },
    );
    const side = fc.record({ drafts: fc.nat({ max: 3 }), reactions: reactionSet });
    await fc.assert(
      fc.asyncProperty(side, side, async (a, b) => {
        const made = [];
        for (const s of [a, b]) {
          const user = await newAccount();
          await app`INSERT INTO account_emails VALUES (${user}, ${randomBytes(32)}, 'h1',
            ${randomBytes(40)}, 'b1', now())`;
          const drafts = [];
          for (let i = 0; i < s.drafts; i++) drafts.push(await draft(user, { n: i }));
          for (const r of s.reactions)
            await setReaction(app, user, polls[r.poll]!.electionId, r.reaction, true, {
              now: NOW,
            });
          made.push({ user, drafts, reactions: s.reactions });
        }
        for (const [i, m] of made.entries()) {
          const out = await exportAccount(app, m.user, at);
          // The stand-in box doesn't open under KEYS: the rest still
          // exports, and a row written with no language reads English.
          expect(out?.email).toEqual({
            address: null,
            verifiedOn: expect.any(String),
            locale: "en-US",
          });
          expect(out?.polls.map((p) => p.id).sort()).toEqual([...m.drafts].sort());
          expect(out?.reactions.map((r) => `${r.electionId} ${r.reaction}`).sort()).toEqual(
            m.reactions.map((r) => `${hex(polls[r.poll]!.electionId)} ${r.reaction}`).sort(),
          );
          const other = made[1 - i]!;
          const text = JSON.stringify(out);
          expect(text).not.toContain(other.user);
          for (const d of other.drafts) expect(text).not.toContain(d);
        }
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  }, 120_000);
});
