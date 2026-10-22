import { createHmac, randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountEmailCodes,
  accountEmailHolds,
  accountEmailKeyChecks,
  accountEmailRecipients,
  accountEmails,
  accountEmailSends,
} from "../src/db/schema/index.ts";
import {
  EMAIL_CODE_SECONDS,
  EMAIL_HOLD_DAYS,
  type EmailKeys,
  emailKeys,
  type EmailMessage,
  type EmailSender,
  EmailVerificationError,
  foldEmailAddress,
  MAX_SENDS_PER_ADDRESS,
  MAX_SENDS_PER_DAY,
  MAX_SENDS_PER_HOUR,
  newAccountId,
  parseEmailAddress,
  parseKeyring,
  pruneAccountEmails,
  readAccountEmail,
  renderEmail,
  requestEmailCode,
  rotateEmailKeys,
  type Turnstile,
  type TurnstileAction,
  type TurnstileVerdict,
  verifyEmailCode,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// An account's verified e-mail address (ADR 0038, Email; P2-31 part 2): the
// address kept only as ciphertext and a keyed hash, one account per address,
// codes of 8 digits for 15 minutes and 5 tries, a held address answered like
// any other, and the limits per account (T-10, T-11, T-52, T-73).

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

let db: TestDb;
let app: Sql;
let app2: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  app2 = await db.as("abolish_app");
});
afterAll(() => db?.close());

const NOW = new Date("2026-10-22T12:00:00Z");
const later = (seconds: number, from = NOW) => new Date(from.getTime() + seconds * 1000);

const ring = (...ids: string[]) =>
  parseKeyring(ids.map((id) => `${id}:${randomBytes(32).toString("hex")}`).join(","));
const KEYS: EmailKeys = emailKeys(ring("h1"), ring("b1"));

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

const outbox = (result: "sent" | "unavailable" = "sent") => {
  const sent: EmailMessage[] = [];
  const sender: EmailSender = {
    send: async (m) => {
      sent.push(m);
      return result;
    },
  };
  return { sent, sender };
};

async function newAccount(): Promise<string> {
  const id = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${id}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  return id;
}

const failure = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof EmailVerificationError) return e;
    throw e;
  }
  throw new Error("expected an EmailVerificationError");
};
const code = async (p: Promise<unknown>) => (await failure(p)).code;

/** Asks for a code for `account` and returns what was sent. */
async function ask(
  account: string,
  address: string,
  { now = NOW, keys = KEYS, client = app }: { now?: Date; keys?: EmailKeys; client?: Sql } = {},
): Promise<EmailMessage> {
  const { sent, sender } = outbox();
  await requestEmailCode(client, account, address, {
    keys,
    sender,
    turnstile: passing().turnstile,
    token: "t",
    now,
  });
  expect(sent).toHaveLength(1);
  return sent[0]!;
}

const codeOf = (m: EmailMessage) => {
  if (m.kind !== "email-code") throw new Error(`expected a code, got ${m.kind}`);
  return m.code;
};

let addresses = 0;
/** An address no other test uses, so the per-address cap never meets another test's sends. */
const fresh = () => `user-${++addresses}-${randomBytes(4).toString("hex")}@example.org`;

/** A wrong 8-digit answer to `right`. */
const wrong = (right: string) => (right === "00000000" ? "00000001" : "00000000");

async function verified(account: string, address: string, keys = KEYS) {
  await verifyEmailCode(app, account, codeOf(await ask(account, address, { keys })), {
    keys,
    now: NOW,
  });
}

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [
      accountEmails,
      accountEmailCodes,
      accountEmailSends,
      accountEmailRecipients,
      accountEmailKeyChecks,
      accountEmailHolds,
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

  test("an address is never stored in the clear", async () => {
    const account = await newAccount();
    const address = "Clear.Text@Example.org";
    const m = await ask(account, address);
    await verifyEmailCode(app, account, codeOf(m), { keys: KEYS, now: NOW });
    await ask(account, "next.one@example.org");
    const dump = (
      await db.admin`
        SELECT row_to_json(e)::text AS j FROM account_emails e WHERE user_id = ${account}
        UNION ALL SELECT row_to_json(c)::text FROM account_email_codes c WHERE user_id = ${account}`
    )
      .map((r) => r["j"] as string)
      .join("\n");
    expect(dump).toContain(account);
    for (const needle of ["clear.text", "example.org", "next.one", "@"])
      expect(dump.toLowerCase()).not.toContain(needle);
  });

  test("the checks refuse a box or hash of the wrong length", async () => {
    const account = await newAccount();
    const owner = await db.as("abolish_migrator");
    const insert = (hash: Buffer, box: Buffer) =>
      owner`INSERT INTO account_emails VALUES (${account}, ${hash}, 'h1', ${box}, 'b1', now())`;
    await expect(insert(randomBytes(31), randomBytes(40))).rejects.toThrow(/check constraint/);
    await expect(insert(randomBytes(32), randomBytes(12 + 255 + 16))).rejects.toThrow(
      /check constraint/,
    );
    await expect(insert(randomBytes(32), randomBytes(40))).resolves.toBeDefined();
  });
});

describe("parseEmailAddress", () => {
  test("takes ordinary addresses, trimmed and in NFC", () => {
    expect(parseEmailAddress("  jane.doe+polls@example.co.uk\n")).toBe(
      "jane.doe+polls@example.co.uk",
    );
    expect(parseEmailAddress("Zé@exámple.org")).toBe("Zé@exámple.org");
    expect(parseEmailAddress("用户@例子.广告")).toBe("用户@例子.广告");
  });

  test.each([
    "",
    "plain",
    "@example.org",
    "jane@",
    "jane@localhost",
    "jane@example.123",
    "jane@-example.org",
    "jane@example-.org",
    "jane@example..org",
    "jane..doe@example.org",
    ".jane@example.org",
    "jane.@example.org",
    '"jane doe"@example.org',
    "jane doe@example.org",
    "jane@exa mple.org",
    "jane@[192.0.2.1]",
    "jane<x>@example.org",
    "jane@example.org\u0000",
    `${"a".repeat(65)}@example.org`,
    `jane@${"a".repeat(64)}.org`,
    `jane@${"abcdefgh.".repeat(31)}org`,
  ])("refuses %j", (input) => {
    expect(parseEmailAddress(input)).toBeUndefined();
  });

  test("anything it takes is within the byte limit and parses to itself", () => {
    fc.assert(
      fc.property(fc.string({ unit: "grapheme", maxLength: 300 }), (input) => {
        const address = parseEmailAddress(input);
        if (address === undefined) return;
        expect(Buffer.byteLength(address, "utf8")).toBeLessThanOrEqual(254);
        expect(parseEmailAddress(address)).toBe(address);
      }),
      runs,
    );
    fc.assert(
      fc.property(fc.emailAddress(), (input) => {
        const address = parseEmailAddress(input);
        if (address !== undefined) expect(address).toBe(input);
      }),
      runs,
    );
  });

  test("folds case, and a domain to its ASCII form, and nothing else", () => {
    expect(foldEmailAddress("Jane.Doe+X@Example.ORG")).toBe("jane.doe+x@example.org");
    expect(foldEmailAddress("j.a.n.e@gmail.com")).not.toBe(foldEmailAddress("jane@gmail.com"));
    expect(foldEmailAddress("jane+x@gmail.com")).not.toBe(foldEmailAddress("jane@gmail.com"));
    expect(foldEmailAddress("Zoë@Bücher.DE")).toBe("zoë@xn--bcher-kva.de");
    expect(foldEmailAddress("zoë@xn--bcher-kva.de")).toBe("zoë@xn--bcher-kva.de");
  });

  test("a domain written in Unicode or ASCII is one address", async () => {
    const a = await newAccount();
    await verified(a, "jane@bücher.example");
    expect((await ask(await newAccount(), "Jane@XN--BCHER-KVA.example")).kind).toBe("email-held");
  });
});

describe("renderEmail", () => {
  test("is plain text with no link or image to track (T-67)", () => {
    for (const m of [
      { kind: "email-code", to: "a@example.org", code: "01234567" },
      { kind: "email-held", to: "a@example.org" },
      { kind: "email-on-hold", to: "a@example.org" },
    ] as const) {
      const { subject, text } = renderEmail(m);
      for (const part of [subject, text]) {
        expect(part).not.toMatch(/https?:|www\.|<|abolish\.us/i);
        expect(part).not.toContain(m.to);
      }
    }
    expect(
      renderEmail({ kind: "email-code", to: "a@example.org", code: "01234567" }).text,
    ).toContain("01234567");
  });
});

describe("requesting a code", () => {
  test("sends 8 digits to the address as typed, spending a solve for email-code", async () => {
    const account = await newAccount();
    const { calls, turnstile } = passing();
    const { sent, sender } = outbox();
    await requestEmailCode(app, account, " Jane@Example.org ", {
      keys: KEYS,
      sender,
      turnstile,
      token: "tok",
      now: NOW,
    });
    expect(calls).toEqual([["tok", "email-code"]]);
    expect(sent).toEqual([
      { kind: "email-code", to: "Jane@Example.org", code: expect.any(String) },
    ]);
    expect(codeOf(sent[0]!)).toMatch(/^[0-9]{8}$/);
  });

  test("refuses a bad address before spending the solve", async () => {
    const account = await newAccount();
    const { calls, turnstile } = passing();
    const { sent, sender } = outbox();
    const r = requestEmailCode(app, account, "not an address", {
      keys: KEYS,
      sender,
      turnstile,
      token: "t",
      now: NOW,
    });
    expect(await code(r)).toBe("invalid-address");
    expect(calls).toEqual([]);
    expect(sent).toEqual([]);
  });

  test.each([
    ["refused", "challenge-refused"],
    ["unavailable", "challenge-unavailable"],
  ] as const)("a %s challenge sends nothing and counts nothing", async (verdict, expected) => {
    const account = await newAccount();
    const { sent, sender } = outbox();
    const r = requestEmailCode(app, account, fresh(), {
      keys: KEYS,
      sender,
      turnstile: passing(verdict).turnstile,
      token: "t",
      now: NOW,
    });
    expect(await code(r)).toBe(expected);
    expect(sent).toEqual([]);
    expect(
      (
        await db.admin`SELECT count(*)::int AS n FROM account_email_sends WHERE user_id = ${account}`
      )[0]!["n"],
    ).toBe(0);
  });

  test("a failed send still counts against the limits", async () => {
    const account = await newAccount();
    const { sender } = outbox("unavailable");
    const r = requestEmailCode(app, account, fresh(), {
      keys: KEYS,
      sender,
      turnstile: passing().turnstile,
      token: "t",
      now: NOW,
    });
    expect(await code(r)).toBe("send-unavailable");
    expect(
      (
        await db.admin`SELECT count(*)::int AS n FROM account_email_sends WHERE user_id = ${account}`
      )[0]!["n"],
    ).toBe(1);
  });

  test(`an account is sent at most ${MAX_SENDS_PER_HOUR} codes an hour and ${MAX_SENDS_PER_DAY} a day`, async () => {
    const account = await newAccount();
    for (let i = 0; i < MAX_SENDS_PER_HOUR; i++) await ask(account, fresh(), { now: later(i) });
    const { calls, turnstile } = passing();
    const { sender } = outbox();
    const at = (now: Date) =>
      requestEmailCode(app, account, fresh(), {
        keys: KEYS,
        sender,
        turnstile,
        token: "t",
        now,
      });
    expect(await code(at(later(60)))).toBe("too-many-this-hour");
    expect(calls).toEqual([]);
    // An hour after the first, there is room again, up to the day's limit.
    for (let i = 0; i < MAX_SENDS_PER_DAY - MAX_SENDS_PER_HOUR; i++)
      await ask(account, fresh(), { now: later(3600 + 60 * 60 * i) });
    expect(await code(at(later(23 * 3600)))).toBe("too-many-today");
    await ask(account, fresh(), { now: later(24 * 3600 + 1) });
  });

  test("two concurrent requests can't both pass the last slot", async () => {
    const account = await newAccount();
    for (let i = 0; i < MAX_SENDS_PER_HOUR - 1; i++) await ask(account, fresh(), { now: later(i) });
    const results = await Promise.allSettled(
      [app, app2].map((client) => ask(account, fresh(), { now: later(30), client })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  test("a new request replaces the waiting code", async () => {
    const account = await newAccount();
    const first = codeOf(await ask(account, fresh()));
    const address = fresh();
    const second = codeOf(await ask(account, address, { now: later(1) }));
    if (first !== second)
      expect(await code(verifyEmailCode(app, account, first, { keys: KEYS, now: later(2) }))).toBe(
        "wrong-code",
      );
    await verifyEmailCode(app, account, second, { keys: KEYS, now: later(3) });
    expect((await readAccountEmail(app, account, KEYS))?.address).toBe(address);
  });
});

describe("verifying a code", () => {
  test("makes the address the account's verified one", async () => {
    const account = await newAccount();
    expect(await readAccountEmail(app, account, KEYS)).toBeUndefined();
    const right = codeOf(await ask(account, "Jane@Example.org"));
    await verifyEmailCode(app, account, `${right.slice(0, 4)} ${right.slice(4)}`, {
      keys: KEYS,
      now: later(60),
    });
    expect(await readAccountEmail(app, account, KEYS)).toEqual({
      address: "Jane@Example.org",
      verifiedAt: later(60),
    });
    // Single use.
    expect(await code(verifyEmailCode(app, account, right, { keys: KEYS, now: later(61) }))).toBe(
      "no-code",
    );
  });

  test("a code is gone 15 minutes after it was sent", async () => {
    const account = await newAccount();
    const right = codeOf(await ask(account, fresh()));
    expect(
      await code(
        verifyEmailCode(app, account, right, { keys: KEYS, now: later(EMAIL_CODE_SECONDS) }),
      ),
    ).toBe("expired");
    expect(await code(verifyEmailCode(app, account, right, { keys: KEYS, now: NOW }))).toBe(
      "no-code",
    );
  });

  test("a code survives four wrong answers, not five", async () => {
    const account = await newAccount();
    const right = codeOf(await ask(account, fresh()));
    const answers = [wrong(right), "12", "abcdefgh", `${right}0`];
    for (const [i, answer] of answers.entries()) {
      const e = await failure(verifyEmailCode(app, account, answer, { keys: KEYS, now: NOW }));
      expect([e.code, e.triesLeft]).toEqual(["wrong-code", 4 - i]);
    }
    expect(await code(verifyEmailCode(app, account, wrong(right), { keys: KEYS, now: NOW }))).toBe(
      "too-many-tries",
    );
    expect(await code(verifyEmailCode(app, account, right, { keys: KEYS, now: NOW }))).toBe(
      "no-code",
    );
  });

  test("a code is bound to the account it was sent for", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const right = codeOf(await ask(a, fresh()));
    await ask(b, fresh());
    // b's row given a's code hash still refuses a's code.
    await db.admin`UPDATE account_email_codes SET code_hash =
      (SELECT code_hash FROM account_email_codes WHERE user_id = ${a}) WHERE user_id = ${b}`;
    expect(await code(verifyEmailCode(app, b, right, { keys: KEYS, now: NOW }))).toBe("wrong-code");
  });

  test("an address box doesn't open for another account", async () => {
    const a = await newAccount();
    const b = await newAccount();
    await verified(a, "box-a@example.org");
    await verified(b, "box-b@example.org");
    await db.admin`UPDATE account_emails SET address_box =
      (SELECT address_box FROM account_emails WHERE user_id = ${a}) WHERE user_id = ${b}`;
    await expect(readAccountEmail(app, b, KEYS)).rejects.toThrow(/failed to open/);
  });

  test("changing the address replaces it", async () => {
    const a = await newAccount();
    const [old, next] = [fresh(), fresh()];
    await verified(a, old);
    await verified(a, next);
    expect((await readAccountEmail(app, a, KEYS))?.address).toBe(next);
  });

  test("deleting the account deletes its address, code and sends", async () => {
    const account = await newAccount();
    await verified(account, "gone@example.org");
    await ask(account, "next@example.org");
    await app`DELETE FROM account_users WHERE id = ${account}`;
    for (const table of ["account_emails", "account_email_codes", "account_email_sends"])
      expect(
        (
          await db.admin.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [
            account,
          ])
        )[0]!["n"],
      ).toBe(0);
  });
});

describe("one account per address", () => {
  test("a held address, in any case, gets a notice instead of a code, and the requester can't tell", async () => {
    const a = await newAccount();
    const b = await newAccount();
    await verified(a, "taken@example.org");
    const m = await ask(b, "Taken@EXAMPLE.org");
    expect(m).toEqual({ kind: "email-held", to: "Taken@EXAMPLE.org" });
    // Every answer is wrong, as a code's would be until it's guessed.
    const e = await failure(verifyEmailCode(app, b, "00000000", { keys: KEYS, now: NOW }));
    expect([e.code, e.triesLeft]).toEqual(["wrong-code", 4]);
    expect((await readAccountEmail(app, a, KEYS))?.address).toBe("taken@example.org");
  });

  test("the account holding an address can ask for it again", async () => {
    const a = await newAccount();
    await verified(a, "mine@example.org");
    expect((await ask(a, "MINE@example.org")).kind).toBe("email-code");
  });

  test("of two accounts sent codes for one address, the first to verify keeps it", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const ca = codeOf(await ask(a, "race@example.org"));
    const cb = codeOf(await ask(b, "Race@example.org"));
    await verifyEmailCode(app, a, ca, { keys: KEYS, now: NOW });
    expect(await code(verifyEmailCode(app, b, cb, { keys: KEYS, now: NOW }))).toBe("address-taken");
    expect(await code(verifyEmailCode(app, b, cb, { keys: KEYS, now: NOW }))).toBe("no-code");
    expect(await readAccountEmail(app, b, KEYS)).toBeUndefined();
  });

  test("concurrent verifications of one address leave it with one account", async () => {
    const a = await newAccount();
    const b = await newAccount();
    const ca = codeOf(await ask(a, "both@example.org"));
    const cb = codeOf(await ask(b, "both@example.org"));
    const results = await Promise.allSettled([
      verifyEmailCode(app, a, ca, { keys: KEYS, now: NOW }),
      verifyEmailCode(app2, b, cb, { keys: KEYS, now: NOW }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as EmailVerificationError).code).toBe("address-taken");
  });

  test("an address held under an older hash key is still held", async () => {
    const hash = ring("h-old");
    const box = ring("b-old");
    const before = emailKeys(hash, box);
    const a = await newAccount();
    await verified(a, "rotated@example.org", before);
    const after = emailKeys(
      parseKeyring(
        `${hash.keys.map((k) => `${k.id}:${Buffer.from(k.key).toString("hex")}`).join(",")},h-new:${randomBytes(32).toString("hex")}`,
      ),
      parseKeyring(
        `${box.keys.map((k) => `${k.id}:${Buffer.from(k.key).toString("hex")}`).join(",")},b-new:${randomBytes(32).toString("hex")}`,
      ),
    );
    // Still readable under the old box key, and still held under the old hash key.
    expect((await readAccountEmail(app, a, after))?.address).toBe("rotated@example.org");
    const b = await newAccount();
    expect((await ask(b, "rotated@example.org", { keys: after })).kind).toBe("email-held");
    // Re-verifying stores it under the current keys.
    await verified(a, "rotated@example.org", after);
    const [row] = await db.admin`SELECT hash_key, box_key FROM account_emails WHERE user_id = ${a}`;
    expect([row!["hash_key"], row!["box_key"]]).toEqual(["h-new", "b-new"]);
  });

  test("the hash depends on the key: another deployment's keys match nothing", async () => {
    const a = await newAccount();
    await verified(a, "keyed@example.org");
    const b = await newAccount();
    const other = emailKeys(ring("h1"), ring("b1"));
    expect((await ask(b, "keyed@example.org", { keys: other })).kind).toBe("email-code");
  });
});

describe("the per-address cap", () => {
  test("an address's sends are timed to the hour, so they share no instant with an account's (T-73)", async () => {
    const account = await newAccount();
    const address = fresh();
    const at = new Date("2027-03-04T13:27:41.123Z");
    await ask(account, address, { now: at });
    const recipients = await db.admin`SELECT sent_at FROM account_email_recipients
      WHERE sent_at >= ${new Date("2027-03-04T13:00:00Z")} AND sent_at < ${new Date("2027-03-04T14:00:00Z")}`;
    expect(recipients.map((r) => (r["sent_at"] as Date).toISOString())).toEqual([
      "2027-03-04T13:00:00.000Z",
    ]);
    const [send] =
      await db.admin`SELECT sent_at FROM account_email_sends WHERE user_id = ${account}`;
    expect((send!["sent_at"] as Date).toISOString()).toBe(at.toISOString());
    const owner = await db.as("abolish_migrator");
    await expect(
      owner`INSERT INTO account_email_recipients (address_hash, sent_at) VALUES (${randomBytes(32)}, ${at})`,
    ).rejects.toThrow(/check constraint/);
  });

  test(`an address is sent at most ${MAX_SENDS_PER_ADDRESS} messages a day, and past that the requester can't tell`, async () => {
    const address = fresh();
    const holder = await newAccount();
    // A code and a notice both count.
    const right = codeOf(await ask(holder, address));
    await verifyEmailCode(app, holder, right, { keys: KEYS, now: NOW });
    for (let i = 1; i < MAX_SENDS_PER_ADDRESS; i++)
      expect((await ask(await newAccount(), address.toUpperCase(), { now: later(i) })).kind).toBe(
        "email-held",
      );
    const { calls, turnstile } = passing();
    const { sent, sender } = outbox();
    const late = await newAccount();
    await requestEmailCode(app, late, address, {
      keys: KEYS,
      sender,
      turnstile,
      token: "t",
      now: later(60),
    });
    expect(calls).toHaveLength(1);
    expect(sent).toEqual([]);
    // The account's own send still counts, and its code row answers as any other.
    const e = await failure(verifyEmailCode(app, late, "00000000", { keys: KEYS, now: later(61) }));
    expect([e.code, e.triesLeft]).toEqual(["wrong-code", 4]);
    // A day after the first message there is room again.
    expect((await ask(await newAccount(), address, { now: later(24 * 3600 + 1) })).kind).toBe(
      "email-held",
    );
  });

  test("while a new key is staged, an instance without it and one with it can't both take an address", async () => {
    const hash = ring("h-a");
    const box = ring("b-a");
    const old = emailKeys(hash, box);
    const text = (r: typeof hash) =>
      r.keys.map((k) => `${k.id}:${Buffer.from(k.key).toString("hex")}`).join(",");
    // The first deploy of a rotation: the new keys listed, the old ones still current.
    const rolled = emailKeys(
      parseKeyring(`${text(hash)}*,h-b:${randomBytes(32).toString("hex")}`),
      parseKeyring(`${text(box)}*,b-b:${randomBytes(32).toString("hex")}`),
    );
    for (let round = 0; round < 5; round++) {
      const address = fresh();
      const a = await newAccount();
      const b = await newAccount();
      const ca = codeOf(await ask(a, address, { keys: old }));
      const cb = codeOf(await ask(b, address, { keys: rolled }));
      const results = await Promise.allSettled([
        verifyEmailCode(app, a, ca, { keys: old, now: NOW }),
        verifyEmailCode(app2, b, cb, { keys: rolled, now: NOW }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    }
  });
});

describe("failing closed", () => {
  test("a sender that throws leaves the send counted and the code stored", async () => {
    const account = await newAccount();
    const sender: EmailSender = {
      send: async () => {
        throw new Error("provider down");
      },
    };
    await expect(
      requestEmailCode(app, account, fresh(), {
        keys: KEYS,
        sender,
        turnstile: passing().turnstile,
        token: "t",
        now: NOW,
      }),
    ).rejects.toThrow("provider down");
    const [row] = await db.admin`SELECT
      (SELECT count(*)::int FROM account_email_sends WHERE user_id = ${account}) AS sends,
      (SELECT count(*)::int FROM account_email_codes WHERE user_id = ${account}) AS codes`;
    expect([row!["sends"], row!["codes"]]).toEqual([1, 1]);
  });

  test("a code under a key the keyring no longer holds fails without spending a try", async () => {
    const hash = ring("h-gone");
    const box = ring("b-gone");
    const account = await newAccount();
    const right = codeOf(await ask(account, fresh(), { keys: emailKeys(hash, box) }));
    const without = emailKeys(ring("h-other"), box);
    await expect(verifyEmailCode(app, account, right, { keys: without, now: NOW })).rejects.toThrow(
      /not in the keyring/,
    );
    const withoutBox = emailKeys(hash, ring("b-other"));
    await expect(
      verifyEmailCode(app, account, right, { keys: withoutBox, now: NOW }),
    ).rejects.toThrow(/not in the keyring/);
    const [row] = await db.admin`SELECT tries FROM account_email_codes WHERE user_id = ${account}`;
    expect(row!["tries"]).toBe(0);
    await verifyEmailCode(app, account, right, { keys: emailKeys(hash, box), now: NOW });
  });

  test("refuses anything but an account ID", async () => {
    await expect(readAccountEmail(app, "short", KEYS)).rejects.toThrow(RangeError);
    await expect(
      verifyEmailCode(app, "A".repeat(32), "00000000", { keys: KEYS, now: NOW }),
    ).rejects.toThrow(RangeError);
  });
});

describe("an address an account lets go", () => {
  const DAY = 24 * 3600;
  /** Verifies `address` for `account` at `now`, through a code asked for then. */
  const verifiedAt = async (account: string, address: string, now: Date) =>
    verifyEmailCode(app, account, codeOf(await ask(account, address, { now })), {
      keys: KEYS,
      now,
    });
  /** The hash as the module makes it, recomputed here from its spec. */
  const hashOf = (key: Uint8Array, address: string) =>
    createHmac("sha256", key)
      .update("abolish/email/v1")
      .update(foldEmailAddress(address), "utf8")
      .digest();
  const holdsOf = async (address: string) =>
    await db.admin`
      SELECT row_to_json(t)::text AS j FROM account_email_holds t
      WHERE address_hash = ${hashOf(KEYS.hash.current.key, address)}`;

  test(`a changed-away address is held ${EMAIL_HOLD_DAYS} days: another account gets a notice and can't verify it`, async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const old = fresh();
    await verified(a, old);
    await verified(a, fresh());
    const m = await ask(b, old.toUpperCase());
    expect(m).toEqual({ kind: "email-on-hold", to: old.toUpperCase() });
    expect(await code(verifyEmailCode(app, b, "12345678", { keys: KEYS, now: NOW }))).toBe(
      "wrong-code",
    );
  });

  test("the hold keeps the address's hash, its key and the day, and no account or box", async () => {
    const a = await newAccount();
    const old = fresh();
    await verified(a, old);
    await verified(a, fresh());
    const rows = (await holdsOf(old)).map((r) => JSON.parse(r["j"] as string));
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]).sort()).toEqual(["address_hash", "freed_on", "hash_key", "id"]);
    expect(rows[0]).toMatchObject({ hash_key: "h1" });
    expect(new Date(rows[0].freed_on as string).toISOString()).toBe("2026-10-22T00:00:00.000Z");
  });

  test("re-verifying the account's own address holds nothing", async () => {
    const a = await newAccount();
    const address = fresh();
    await verified(a, address);
    await verified(a, address.toUpperCase());
    expect(await holdsOf(address)).toHaveLength(0);
  });

  test("the account that let it go can't take it back while it is held", async () => {
    const a = await newAccount();
    const old = fresh();
    await verified(a, old);
    await verified(a, fresh());
    expect((await ask(a, old)).kind).toBe("email-on-hold");
  });

  test("a deleted account's address is held, by whatever path it was deleted", async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const address = fresh();
    await verified(a, address);
    await db.admin`DELETE FROM account_users WHERE id = ${a}`;
    expect(await holdsOf(address)).toHaveLength(1);
    expect((await ask(b, address)).kind).toBe("email-on-hold");
  });

  test("an operator's deletion under abolish.email_unheld holds nothing", async () => {
    const a = await newAccount();
    const address = fresh();
    await verified(a, address);
    await db.admin.begin(async (tx) => {
      await tx`SET LOCAL abolish.email_unheld = 'on'`;
      await tx`DELETE FROM account_emails WHERE user_id = ${a}`;
    });
    expect(await holdsOf(address)).toHaveLength(0);
    await verified(a, address);
  });

  test("an address let go after another account was sent a code refuses that code", async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const address = fresh();
    const forA = codeOf(await ask(a, address));
    const forB = codeOf(await ask(b, address));
    await verifyEmailCode(app, a, forA, { keys: KEYS, now: NOW });
    await app`DELETE FROM account_users WHERE id = ${a}`;
    expect(await code(verifyEmailCode(app, b, forB, { keys: KEYS, now: NOW }))).toBe(
      "address-taken",
    );
  });

  test("an answer racing the deletion of the account holding the address sees its row or its hold", async () => {
    const [a, b, c] = [await newAccount(), await newAccount(), await newAccount()];
    const address = fresh();
    const forB = codeOf(await ask(b, address));
    const forC = codeOf(await ask(c, address));
    await verified(a, address);
    let release!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    let deleted!: () => void;
    const started = new Promise<void>((resolve) => (deleted = resolve));
    // The deletion, with its hold, stays uncommitted while b answers: b sees
    // a's row. c answers once it commits: c sees the hold.
    const deletion = db.admin.begin(async (tx) => {
      await tx`DELETE FROM account_users WHERE id = ${a}`;
      deleted();
      await open;
    });
    await started;
    expect(await code(verifyEmailCode(app, b, forB, { keys: KEYS, now: NOW }))).toBe(
      "address-taken",
    );
    release();
    await deletion;
    expect(await code(verifyEmailCode(app2, c, forC, { keys: KEYS, now: NOW }))).toBe(
      "address-taken",
    );
  });

  test(`the hold ends ${EMAIL_HOLD_DAYS} days after the day it was freed, not before`, async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    const address = fresh();
    await verified(a, address);
    await verified(a, fresh());
    // Freed on NOW's day: still held at its last second of the 89th day after.
    const lastHeld = new Date(Date.UTC(2026, 9, 22) + EMAIL_HOLD_DAYS * DAY * 1000 - 1000);
    expect((await ask(b, address, { now: lastHeld })).kind).toBe("email-on-hold");
    const freed = new Date(lastHeld.getTime() + 1000);
    await verifiedAt(b, address, freed);
    expect((await readAccountEmail(app, b, KEYS))?.address).toBe(address);
  });

  test("a hold under an older hash key still holds, and the rotation leaves it", async () => {
    const hex = () => randomBytes(32).toString("hex");
    const [H1, H2, B1] = [hex(), hex(), hex()];
    const before = emailKeys(parseKeyring(`q1:${H1}`), parseKeyring(`p1:${B1}`));
    const after = emailKeys(parseKeyring(`q1:${H1},q2:${H2}`), parseKeyring(`p1:${B1}`));
    const [a, b] = [await newAccount(), await newAccount()];
    const address = fresh();
    await verified(a, address, before);
    await verified(a, fresh(), before);
    await rotateEmailKeys(app, after);
    const [hold] = await db.admin`
      SELECT a.hash_key FROM account_email_holds a
      WHERE a.hash_key = 'q1' AND a.address_hash = ${hashOf(Buffer.from(H1, "hex"), address)}`;
    expect(hold).toEqual({ hash_key: "q1" });
    expect((await ask(b, address, { keys: after })).kind).toBe("email-on-hold");
    // With the key it was made under retired, the hold is lost: so a hash key
    // stays until its holds end (the account-keys runbook), and the rotation
    // counts the hold among the rows under a key it lacks.
    const retired = emailKeys(parseKeyring(`q2:${H2}`), parseKeyring(`p1:${B1}`));
    expect((await rotateEmailKeys(app, retired)).unknownKeys).toBeGreaterThanOrEqual(1);
  });
});

describe("pruneAccountEmails", () => {
  test("deletes expired codes, and sends and recipients past the day, and nothing newer", async () => {
    const account = await newAccount();
    await ask(account, "prune@example.org", { now: later(-2 * 24 * 3600) });
    const recent = await newAccount();
    await ask(recent, "recent@example.org");
    const pruned = await pruneAccountEmails(app, later(60));
    expect(pruned.codes).toBeGreaterThanOrEqual(1);
    expect(pruned.sends).toBeGreaterThanOrEqual(1);
    expect(pruned.recipients).toBeGreaterThanOrEqual(1);
    const [old] = await db.admin`SELECT count(*)::int AS n FROM account_email_recipients
      WHERE sent_at < ${later(-24 * 3600)}`;
    expect(old!["n"]).toBe(0);
    const left = async (table: string, id: string) =>
      (
        await db.admin.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE user_id = $1`, [id])
      )[0]!["n"];
    expect([
      await left("account_email_codes", account),
      await left("account_email_sends", account),
    ]).toEqual([0, 0]);
    expect([
      await left("account_email_codes", recent),
      await left("account_email_sends", recent),
    ]).toEqual([1, 1]);
  });

  test(`deletes holds ${EMAIL_HOLD_DAYS} days after they were freed, and none sooner`, async () => {
    const a = await newAccount();
    const [ended, held] = [fresh(), fresh()];
    const daysAgo = (n: number) => later(-n * 24 * 3600);
    // Each verification frees the one before: `ended` 91 days ago, `held` 89.
    for (const [address, n] of [
      [ended, 92],
      [held, 91],
      [fresh(), 89],
    ] as const)
      await verifyEmailCode(app, a, codeOf(await ask(a, address, { now: daysAgo(n) })), {
        keys: KEYS,
        now: daysAgo(n),
      });
    const pruned = await pruneAccountEmails(app, NOW);
    expect(pruned.holds).toBeGreaterThanOrEqual(1);
    const days = await db.admin`
      SELECT freed_on FROM account_email_holds WHERE freed_on <= ${later(-90 * 24 * 3600)}`;
    expect(days).toHaveLength(0);
    const b = await newAccount();
    expect((await ask(b, held)).kind).toBe("email-on-hold");
    await verified(b, ended);
  });
});

describe("emailKeys", () => {
  test("refuses a key used for both the hash and the box", () => {
    const hex = randomBytes(32).toString("hex");
    expect(() => emailKeys(parseKeyring(`h:${hex}`), parseKeyring(`b:${hex}`))).toThrow(
      /more than one keyring/,
    );
  });
});

describe("rotateEmailKeys", () => {
  const hex = () => randomBytes(32).toString("hex");
  const [H1, H2, B1, B2] = [hex(), hex(), hex(), hex()];
  const keysOf = (hash: string, box: string) => emailKeys(parseKeyring(hash), parseKeyring(box));
  const OLD = keysOf(`r1:${H1}`, `s1:${B1}`);
  const STAGED = keysOf(`r1:${H1}*,r2:${H2}`, `s1:${B1}*,s2:${B2}`);
  const NEW = keysOf(`r1:${H1},r2:${H2}`, `s1:${B1},s2:${B2}`);
  /** The new keys alone: what is left once the old ones are retired. */
  const RETIRED = keysOf(`r2:${H2}`, `s2:${B2}`);
  const rowOf = async (account: string) =>
    (await db.admin`SELECT hash_key, box_key FROM account_emails WHERE user_id = ${account}`)[0];

  test("re-hashes and re-seals a verified address, so the older keys can be retired", async () => {
    const [a, address] = [await newAccount(), fresh()];
    await verified(a, address, OLD);
    expect(await rowOf(a)).toEqual({ hash_key: "r1", box_key: "s1" });
    const result = await rotateEmailKeys(app, NEW);
    expect(result.rotated).toBeGreaterThanOrEqual(1);
    expect(result.mismatchedKeys).toBe(0);
    expect(await rowOf(a)).toEqual({ hash_key: "r2", box_key: "s2" });
    // With only the new keys, the address still reads back and is still held.
    expect(await readAccountEmail(app, a, RETIRED)).toMatchObject({ address });
    const b = await newAccount();
    expect((await ask(b, address.toUpperCase(), { keys: RETIRED })).kind).toBe("email-held");
    // And a second run has nothing left to do for it.
    await rotateEmailKeys(app, NEW);
    expect(await rowOf(a)).toEqual({ hash_key: "r2", box_key: "s2" });
  });

  test("re-seals a waiting code's address, which still verifies", async () => {
    const [a, address] = [await newAccount(), fresh()];
    const sent = await ask(a, address, { keys: OLD });
    await rotateEmailKeys(app, NEW);
    expect(
      await db.admin`SELECT box_key, code_key FROM account_email_codes WHERE user_id = ${a}`,
    ).toEqual([{ box_key: "s2", code_key: "r1" }]);
    await verifyEmailCode(app, a, codeOf(sent), { keys: NEW, now: NOW });
    expect(await readAccountEmail(app, a, RETIRED)).toMatchObject({ address });
  });

  test("leaves rows under the current keys, and never rewrites a staged key's rows back", async () => {
    const [a, b] = [await newAccount(), await newAccount()];
    await verified(a, fresh(), OLD);
    await verified(b, fresh(), NEW);
    await rotateEmailKeys(app, STAGED);
    expect(await rowOf(a)).toEqual({ hash_key: "r1", box_key: "s1" });
    expect(await rowOf(b)).toEqual({ hash_key: "r2", box_key: "s2" });
  });

  test("rotates nothing while a key's bytes differ from those its ID was first seen with", async () => {
    const [M1, M2, N1, N2] = [hex(), hex(), hex(), hex()];
    const a = await newAccount();
    await verified(a, fresh(), keysOf(`m1:${M1}`, `n1:${N1}`));
    await rotateEmailKeys(app, keysOf(`m1:${M1}*,m2:${M2}`, `n1:${N1}*,n2:${N2}`));
    const wrong = await rotateEmailKeys(app, keysOf(`m1:${M1},m2:${hex()}`, `n1:${N1},n2:${N2}`));
    expect(wrong).toMatchObject({ rotated: 0, mismatchedKeys: 1 });
    expect(await rowOf(a)).toEqual({ hash_key: "m1", box_key: "n1" });
    const right = await rotateEmailKeys(app, keysOf(`m1:${M1},m2:${M2}`, `n1:${N1},n2:${N2}`));
    expect(right.mismatchedKeys).toBe(0);
    expect(await rowOf(a)).toEqual({ hash_key: "m2", box_key: "n2" });
  });

  test("a key's check value is the HMAC of its label, as stored for good", async () => {
    const key = "00".repeat(31) + "01";
    await rotateEmailKeys(app, keysOf(`kh:${key}`, `kb:${"00".repeat(31)}02`));
    const rows = await db.admin`
      SELECT keyring, encode(key_check, 'hex') AS c FROM account_email_key_checks
      WHERE key_id IN ('kh', 'kb') ORDER BY keyring`;
    // Pinned: a change to the labels or the construction would refuse every
    // rotation under keys already in use.
    expect(rows.map((r) => [r["keyring"], r["c"]])).toEqual([
      ["box", "0d5f143722cf2cd7c50c0d612088859a30027a2e04f46c445522eb4b5502a59b"],
      ["hash", "c99dc2b86aa8d4be48017fd292357dd3773da99d987ce3e29c79bd4cb8e6499e"],
    ]);
  });

  test("leaves rows under keys the keyrings lack, and counts them", async () => {
    const a = await newAccount();
    await verified(a, fresh(), KEYS);
    const result = await rotateEmailKeys(app, NEW);
    expect(await rowOf(a)).toEqual({ hash_key: "h1", box_key: "b1" });
    expect(result.unknownKeys).toBeGreaterThanOrEqual(1);
  });

  test("skips a box that doesn't open, and an address two accounts hold, and rotates the rest", async () => {
    const [a, b, c] = [await newAccount(), await newAccount(), await newAccount()];
    const [address, other] = [fresh(), fresh()];
    await verified(a, address, OLD);
    await verified(c, other, OLD);
    // As an instance without r1 could have let happen: b holds the address under r2.
    await verified(b, address, RETIRED);
    const unreadable = await newAccount();
    await verified(unreadable, fresh(), OLD);
    await db.admin`
      UPDATE account_emails SET address_box = ${randomBytes(48)} WHERE user_id = ${unreadable}`;
    const result = await rotateEmailKeys(app, NEW);
    expect(result.skipped).toBe(2);
    expect(await rowOf(a)).toEqual({ hash_key: "r1", box_key: "s1" });
    expect(await rowOf(unreadable)).toEqual({ hash_key: "r1", box_key: "s1" });
    expect(await rowOf(c)).toEqual({ hash_key: "r2", box_key: "s2" });
    await db.admin`DELETE FROM account_users WHERE id IN (${a}, ${b}, ${unreadable})`;
  });

  test("racing another account's verification of the address, one account holds it", async () => {
    for (let i = 0; i < 20; i++) {
      const [a, b, address] = [await newAccount(), await newAccount(), fresh()];
      // Both sent real codes before either verifies; a verifies first.
      const forA = await ask(a, address, { keys: OLD });
      const forB = await ask(b, address, { keys: NEW });
      await verifyEmailCode(app, a, codeOf(forA), { keys: OLD, now: NOW });
      const [rotation, answer] = await Promise.allSettled([
        rotateEmailKeys(app2, NEW),
        verifyEmailCode(app, b, codeOf(forB), { keys: NEW, now: NOW }),
      ]);
      expect(rotation.status).toBe("fulfilled");
      expect(answer.status === "rejected" && answer.reason.code).toBe("address-taken");
      expect(await readAccountEmail(app, a, NEW)).toMatchObject({ address });
      expect(await readAccountEmail(app, b, NEW)).toBeUndefined();
    }
  });
});
