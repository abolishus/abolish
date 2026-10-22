import { createHmac, randomBytes } from "node:crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  accountPhoneCodes,
  accountPhoneHolds,
  accountPhoneKeyChecks,
  accountPhoneRecipients,
  accountPhones,
  accountPhoneSends,
} from "../src/db/schema/index.ts";
import {
  type Keyring,
  MAX_PHONE_SENDS_PER_DAY,
  MAX_PHONE_SENDS_PER_HOUR,
  MAX_SENDS_PER_NUMBER,
  newAccountId,
  parseKeyring,
  parsePhoneNumber,
  PHONE_CODE_SECONDS,
  PHONE_CODE_TRIES,
  PHONE_HOLD_DAYS,
  type PhoneChannel,
  PhoneVerificationError,
  type PhoneVerifier,
  pruneAccountPhones,
  readAccountPhone,
  requestPhoneCode,
  rotatePhoneHashes,
  type Turnstile,
  type TurnstileAction,
  type TurnstileVerdict,
  verifyPhoneCode,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// An account's verified phone number (ADR 0038; P2-31 part 3): the number
// kept only as a nested HMAC chain, one account per number, the provider's
// line types and countries, a held number refused only once its code is
// entered, moves after 90 days, holds after deletion or a change of number,
// and the limits per account, per number and overall (T-01, T-10, T-11,
// T-52, T-73).

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
const days = (n: number, from = NOW) => later(n * 24 * 60 * 60, from);
const DAY_OF_NOW = new Date("2026-10-22T00:00:00Z");

const hexKey = () => randomBytes(32).toString("hex");
const K1 = hexKey();
const K2 = hexKey();
const KEYS: Keyring = parseKeyring(`p1:${K1}`);
/** The same first key, with a second one staged after it. */
const STAGED: Keyring = parseKeyring(`p1:${K1}*,p2:${K2}`);
/** The second key current. */
const ROTATED: Keyring = parseKeyring(`p1:${K1},p2:${K2}`);
/** A big enough ceiling that only its own test meets it. */
const CEILING = 1_000_000;

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

interface Line {
  readonly number?: string;
  readonly country: string;
  readonly lineType: string;
}

/**
 * A stand-in for Twilio Verify: every number a US mobile unless `lines`
 * says otherwise, each code `CODE`, good for one right check per send.
 */
const CODE = "135790";
function provider({
  lines = new Map<string, Line | "invalid" | "unavailable">(),
  start = "sent" as "sent" | "unavailable",
  check = undefined as "unavailable" | undefined,
} = {}) {
  const lookups: string[] = [];
  const started: [string, PhoneChannel][] = [];
  const checked: [string, string][] = [];
  const pending = new Map<string, number>();
  const verifier: PhoneVerifier = {
    lookup: async (n) => {
      lookups.push(n);
      const line = lines.get(n) ?? { country: "US", lineType: "mobile" };
      return typeof line === "string" ? line : { number: n, ...line };
    },
    start: async (n, channel) => {
      started.push([n, channel]);
      if (start === "sent") pending.set(n, (pending.get(n) ?? 0) + 1);
      return start;
    },
    check: async (n, code) => {
      checked.push([n, code]);
      if (check !== undefined) return check;
      const left = pending.get(n) ?? 0;
      if (code !== CODE || left === 0) return "wrong";
      pending.set(n, left - 1);
      return "approved";
    },
  };
  return { lookups, started, checked, verifier };
}

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
    if (e instanceof PhoneVerificationError) return e;
    throw e;
  }
  throw new Error("expected a PhoneVerificationError");
};
const code = async (p: Promise<unknown>) => (await failure(p)).code;

let numbers = 0;
/** A North American number no other test uses, so no cap or hold meets another test's. */
const fresh = () => `+1415${2_000_000 + ++numbers}`;

interface Ask {
  now?: Date;
  keys?: Keyring;
  client?: Sql;
  p?: ReturnType<typeof provider>;
  dailyCeiling?: number;
  turnstile?: Turnstile;
}

function ask(
  account: string,
  number: string,
  {
    now = NOW,
    keys = KEYS,
    client = app,
    p = provider(),
    dailyCeiling = CEILING,
    turnstile,
  }: Ask = {},
) {
  return requestPhoneCode(client, account, number, {
    keys,
    verifier: p.verifier,
    turnstile: turnstile ?? passing().turnstile,
    token: "t",
    dailyCeiling,
    now,
  });
}

function enter(
  account: string,
  number: string,
  answer: string,
  { now = NOW, keys = KEYS, client = app, p }: Ask & { p: ReturnType<typeof provider> },
) {
  return verifyPhoneCode(client, account, number, answer, { keys, verifier: p.verifier, now });
}

/** Asks for and enters a code for `number`, as `account`, on `now`. */
async function verified(account: string, number: string, opts: Ask = {}) {
  const p = opts.p ?? provider();
  await ask(account, number, { ...opts, p });
  await enter(account, number, CODE, { ...opts, p });
}

const phoneOf = async (account: string) =>
  (await db.admin`SELECT phone_hash, hash_key FROM account_phones WHERE user_id = ${account}`)[0];

describe("schema", () => {
  test("the Drizzle tables match the migrated ones", async () => {
    for (const table of [
      accountPhones,
      accountPhoneHolds,
      accountPhoneCodes,
      accountPhoneSends,
      accountPhoneRecipients,
      accountPhoneKeyChecks,
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

  test("a number is never stored, in any form but its hash", async () => {
    const account = await newAccount();
    const number = "+14152380123";
    await verified(account, number);
    await ask(account, "+16042380199");
    await db.admin`DELETE FROM account_users WHERE id = ${account}`;
    const dump = (
      await db.admin`
        SELECT row_to_json(t)::text AS j FROM account_phone_holds t
        UNION ALL SELECT row_to_json(t)::text FROM account_phone_recipients t
        UNION ALL SELECT row_to_json(t)::text FROM account_phone_sends t`
    )
      .map((r) => r["j"] as string)
      .join("\n");
    for (const needle of ["4152380123", "6042380199", "238-0123", "2380123", "2380199"])
      expect(dump).not.toContain(needle);
    const hex = dump.replace(/[^0-9a-f]/g, "");
    expect(hex).not.toContain(Buffer.from(number).toString("hex"));
  });

  test("the checks refuse a hash of the wrong length, and times finer than the ADR keeps", async () => {
    const account = await newAccount();
    const owner = await db.as("abolish_migrator");
    await expect(
      owner`INSERT INTO account_phones VALUES (${account}, ${randomBytes(31)}, 'p1', ${DAY_OF_NOW})`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      owner`INSERT INTO account_phones VALUES (${account}, ${randomBytes(32)}, 'p1', ${NOW})`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      owner`INSERT INTO account_phone_holds (phone_hash, hash_key, freed_on)
        VALUES (${randomBytes(32)}, 'p1', ${NOW})`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      owner`INSERT INTO account_phone_recipients (phone_hash, sent_at)
        VALUES (${randomBytes(32)}, ${later(60)})`,
    ).rejects.toThrow(/check constraint/);
    await expect(
      owner`INSERT INTO account_phones VALUES (${account}, ${randomBytes(32)}, 'p1', ${DAY_OF_NOW})`,
    ).resolves.toBeDefined();
  });
});

describe("parsePhoneNumber", () => {
  test("takes E.164 and North American numbers, as typed", () => {
    expect(parsePhoneNumber("+1 (415) 238-0123")).toBe("+14152380123");
    expect(parsePhoneNumber("415.238.0123")).toBe("+14152380123");
    expect(parsePhoneNumber("1 415 238 0123")).toBe("+14152380123");
    expect(parsePhoneNumber(" +44 20 7946 0958 ")).toBe("+442079460958");
  });

  test.each([
    "",
    "+",
    "4152380123x",
    "+0 415 238 0123",
    "+1 115 238 0123",
    "+1 415 138 0123",
    "+1 415 238 012",
    "+1 415 238 01234",
    "415 238 012",
    "238 0123",
    "+123456",
    "+1234567890123456",
    "++14152380123",
    "+1-415-238-0123/2",
    "+٤١٥٢٣٨٠١٢٣",
    `+1${" ".repeat(64)}4152380123`,
  ])("refuses %j", (input) => {
    expect(parsePhoneNumber(input)).toBeUndefined();
  });

  test("anything it takes is E.164 and parses to itself", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string({ maxLength: 40 }), fc.stringMatching(/^\+?[0-9 ().-]{6,24}$/)),
        (input) => {
          const number = parsePhoneNumber(input);
          if (number === undefined) return;
          expect(number).toMatch(/^\+[1-9][0-9]{6,14}$/);
          expect(parsePhoneNumber(number)).toBe(number);
        },
      ),
      runs,
    );
  });
});

describe("the number's keyed hash", () => {
  test("is the nested HMAC chain the ADR fixes, under the keys up to the current one", async () => {
    const number = fresh();
    const h1 = createHmac("sha256", Buffer.from(K1, "hex"))
      .update("abolish/phone/v1")
      .update(number)
      .digest();
    const h2 = createHmac("sha256", Buffer.from(K2, "hex")).update(h1).digest();
    const a = await newAccount();
    await verified(a, number, { keys: STAGED });
    expect(await phoneOf(a)).toEqual({ phone_hash: h1, hash_key: "p1" });
    await verified(a, number, { keys: ROTATED });
    expect(await phoneOf(a)).toEqual({ phone_hash: h2, hash_key: "p2" });
  });

  test("a number stored under an older chain is still one number, and rotation needs only the hash", async () => {
    const number = fresh();
    const a = await newAccount();
    await verified(a, number, { keys: KEYS, now: days(-PHONE_HOLD_DAYS + 1) });
    const b = await newAccount();
    // Before rotation: the new key current, the value still under p1 alone.
    expect(await code(verified(b, number, { keys: ROTATED }))).toBe("number-held");
    // The rotation job's step: extend the stored chain by HMAC under p2.
    const { phone_hash } = (await phoneOf(a))!;
    const extended = createHmac("sha256", Buffer.from(K2, "hex"))
      .update(phone_hash as Buffer)
      .digest();
    await db.admin`UPDATE account_phones SET phone_hash = ${extended}, hash_key = 'p2' WHERE user_id = ${a}`;
    expect(await code(verified(b, number, { keys: ROTATED }))).toBe("number-held");
    expect(await code(verified(b, number, { keys: STAGED }))).toBe("number-held");
  });
});

describe("requestPhoneCode", () => {
  test("sends a mobile an SMS and a landline or fixed VoIP line a call", async () => {
    const [m, l, v] = [fresh(), fresh(), fresh()];
    const p = provider({
      lines: new Map([
        [l, { country: "US", lineType: "landline" }],
        [v, { country: "CA", lineType: "fixedVoip" }],
      ]),
    });
    const a = await newAccount();
    for (const n of [m, l, v]) await ask(a, n, { p });
    expect(p.started).toEqual([
      [m, "sms"],
      [l, "call"],
      [v, "call"],
    ]);
  });

  test.each([
    "nonFixedVoip",
    "tollFree",
    "premium",
    "sharedCost",
    "uan",
    "voicemail",
    "pager",
    "personal",
    "unknown",
    "constructor",
    "",
  ])("refuses a %j line as virtual, sending nothing", async (lineType) => {
    const n = fresh();
    const p = provider({ lines: new Map([[n, { country: "US", lineType }]]) });
    expect(await code(ask(await newAccount(), n, { p }))).toBe("virtual-number");
    expect(p.started).toEqual([]);
  });

  test("refuses a country not served, matched on the lookup's country and not on +1", async () => {
    const n = "+18762380111";
    const p = provider({ lines: new Map([[n, { country: "JM", lineType: "mobile" }]]) });
    expect(await code(ask(await newAccount(), n, { p }))).toBe("unsupported-country");
    expect(p.started).toEqual([]);
  });

  test("refuses a number the provider writes differently, so one line has one hash", async () => {
    const n = "+442079460958";
    const p = provider({
      lines: new Map([[n, { number: "+4402079460958", country: "US", lineType: "mobile" }]]),
    });
    expect(await code(ask(await newAccount(), n, { p }))).toBe("invalid-number");
    expect(p.started).toEqual([]);
  });

  test("a failed lookup refuses for now, and the request still counts", async () => {
    const n = fresh();
    const a = await newAccount();
    const p = provider({ lines: new Map([[n, "unavailable"]]) });
    expect(await code(ask(a, n, { p }))).toBe("lookup-unavailable");
    expect(await db.admin`SELECT 1 FROM account_phone_sends WHERE user_id = ${a}`).toHaveLength(1);
    expect(await db.admin`SELECT 1 FROM account_phone_codes WHERE user_id = ${a}`).toHaveLength(0);
  });

  test("refuses a number the lookup knows of no line for, and the request still counts", async () => {
    const n = fresh();
    const a = await newAccount();
    const p = provider({ lines: new Map([[n, "invalid"]]) });
    expect(await code(ask(a, n, { p }))).toBe("invalid-number");
    expect(p.started).toEqual([]);
    expect(await db.admin`SELECT 1 FROM account_phone_sends WHERE user_id = ${a}`).toHaveLength(1);
    expect(await db.admin`SELECT 1 FROM account_phone_codes WHERE user_id = ${a}`).toHaveLength(0);
  });

  test("refuses a malformed number before any check that costs", async () => {
    const t = passing();
    const p = provider();
    expect(await code(ask(await newAccount(), "12345", { p, turnstile: t.turnstile }))).toBe(
      "invalid-number",
    );
    expect([t.calls, p.lookups]).toEqual([[], []]);
  });

  test("costs a Turnstile solve for phone-code, before the lookup", async () => {
    const a = await newAccount();
    const t = passing();
    await ask(a, fresh(), { turnstile: t.turnstile });
    expect(t.calls).toEqual([["t", "phone-code"]]);
    for (const [verdict, expected] of [
      ["refused", "challenge-refused"],
      ["unavailable", "challenge-unavailable"],
    ] as const) {
      const p = provider();
      expect(await code(ask(a, fresh(), { p, turnstile: passing(verdict).turnstile }))).toBe(
        expected,
      );
      expect(p.lookups).toEqual([]);
    }
  });

  test("an account is held to its hourly and daily limits", async () => {
    const a = await newAccount();
    for (let i = 0; i < MAX_PHONE_SENDS_PER_HOUR; i++) await ask(a, fresh());
    const t = passing();
    expect(await code(ask(a, fresh(), { turnstile: t.turnstile }))).toBe("too-many-this-hour");
    expect(t.calls).toEqual([]);
    for (let i = MAX_PHONE_SENDS_PER_HOUR; i < MAX_PHONE_SENDS_PER_DAY; i++)
      await ask(a, fresh(), { now: later(3600 + 60) });
    expect(await code(ask(a, fresh(), { now: later(3600 * 3) }))).toBe("too-many-today");
    await ask(a, fresh(), { now: later(24 * 3600 + 1) });
  });

  test("the limits hold against requests that race", async () => {
    const a = await newAccount();
    const results = await Promise.allSettled(
      Array.from({ length: MAX_PHONE_SENDS_PER_HOUR + 3 }, (_, i) =>
        ask(a, fresh(), { client: i % 2 === 0 ? app : app2 }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_PHONE_SENDS_PER_HOUR);
  });

  test("every account together is held to the daily ceiling, before the lookup", async () => {
    const before = Number(
      (
        await db.admin`SELECT count(*)::int AS n FROM account_phone_sends
          WHERE sent_at > ${later(-24 * 3600, later(30))}`
      )[0]!["n"],
    );
    const at = later(30);
    await ask(await newAccount(), fresh(), { now: at, dailyCeiling: before + 1 });
    const p = provider();
    expect(
      await code(ask(await newAccount(), fresh(), { now: at, p, dailyCeiling: before + 1 })),
    ).toBe("service-busy");
    expect(p.lookups).toEqual([]);
  });

  test("a number is sent at most its daily cap, whoever asks, and the requester can't tell", async () => {
    const n = fresh();
    const p = provider();
    for (let i = 0; i < MAX_SENDS_PER_NUMBER; i++) await ask(await newAccount(), n, { p });
    const a = await newAccount();
    await ask(a, n, { p });
    expect(p.started).toHaveLength(MAX_SENDS_PER_NUMBER);
    // The code row is stored all the same; whatever is entered is wrong.
    expect(await code(enter(a, n, CODE, { p: provider() }))).toBe("wrong-code");
    const next = later(24 * 3600 + 3600);
    await ask(a, n, { p, now: next });
    expect(p.started).toHaveLength(MAX_SENDS_PER_NUMBER + 1);
  });

  test("a send the provider didn't take is refused, and still counts", async () => {
    const a = await newAccount();
    expect(await code(ask(a, fresh(), { p: provider({ start: "unavailable" }) }))).toBe(
      "send-unavailable",
    );
    expect(await db.admin`SELECT 1 FROM account_phone_sends WHERE user_id = ${a}`).toHaveLength(1);
  });

  test("asking for a number another account holds sends a code all the same", async () => {
    const n = fresh();
    await verified(await newAccount(), n);
    const p = provider();
    await ask(await newAccount(), n, { p });
    expect(p.started).toEqual([[n, "sms"]]);
  });
});

describe("verifyPhoneCode", () => {
  test("the right code verifies the number, to the day", async () => {
    const a = await newAccount();
    expect(await readAccountPhone(app, a)).toBeUndefined();
    await verified(a, fresh());
    expect(await readAccountPhone(app, a)).toEqual({ verifiedOn: DAY_OF_NOW });
    expect(await db.admin`SELECT 1 FROM account_phone_codes WHERE user_id = ${a}`).toHaveLength(0);
  });

  test("the number may be typed differently the second time", async () => {
    const a = await newAccount();
    const p = provider();
    await ask(a, "+1 415 238 4471", { p });
    await enter(a, "(415) 238-4471", CODE, { p });
    expect(await readAccountPhone(app, a)).toBeDefined();
  });

  test("wrong answers cost a try each, and the last one the code", async () => {
    const a = await newAccount();
    const n = fresh();
    const p = provider();
    await ask(a, n, { p });
    for (let i = 1; i < PHONE_CODE_TRIES; i++) {
      const e = await failure(enter(a, n, "000000", { p }));
      expect([e.code, e.triesLeft]).toEqual(["wrong-code", PHONE_CODE_TRIES - i]);
    }
    expect(await code(enter(a, n, CODE, { p: provider() }))).toBe("too-many-tries");
    expect(await code(enter(a, n, CODE, { p }))).toBe("no-code");
  });

  test("an answer that isn't 4 to 10 digits is wrong, and never reaches the provider", async () => {
    const a = await newAccount();
    const n = fresh();
    const p = provider();
    await ask(a, n, { p });
    for (const answer of ["123", "12345678901", "12a456", ""])
      expect(await code(enter(a, n, answer, { p }))).toBe("wrong-code");
    expect(p.checked).toEqual([]);
    await enter(a, n, ` ${CODE.slice(0, 3)}-${CODE.slice(3)} `, { p });
    expect(p.checked).toEqual([[n, CODE]]);
  });

  test("a code for one number doesn't verify another, or another account", async () => {
    const a = await newAccount();
    const n = fresh();
    const p = provider();
    await ask(a, n, { p });
    expect(await code(enter(a, fresh(), CODE, { p }))).toBe("no-code");
    expect(await code(enter(await newAccount(), n, CODE, { p }))).toBe("no-code");
    expect(p.checked).toEqual([]);
    await enter(a, n, CODE, { p });
  });

  test("a code is gone after its time", async () => {
    const a = await newAccount();
    const n = fresh();
    const p = provider();
    await ask(a, n, { p });
    expect(await code(enter(a, n, CODE, { p, now: later(PHONE_CODE_SECONDS) }))).toBe("expired");
    expect(await code(enter(a, n, CODE, { p }))).toBe("no-code");
  });

  test("a check the provider didn't answer spends no try", async () => {
    const a = await newAccount();
    const n = fresh();
    const p = provider();
    await ask(a, n, { p });
    for (let i = 0; i < PHONE_CODE_TRIES + 1; i++)
      expect(await code(enter(a, n, CODE, { p: provider({ check: "unavailable" }) }))).toBe(
        "check-unavailable",
      );
    await enter(a, n, CODE, { p });
  });

  test("a number another account verified in the last 90 days is refused once its code is right", async () => {
    const n = fresh();
    const a = await newAccount();
    await verified(a, n, { now: days(-PHONE_HOLD_DAYS + 1) });
    const b = await newAccount();
    const p = provider();
    await ask(b, n, { p });
    expect(await code(enter(b, n, "000000", { p }))).toBe("wrong-code");
    expect(await code(enter(b, n, CODE, { p }))).toBe("number-held");
    expect(await code(enter(b, n, CODE, { p }))).toBe("no-code");
    expect(await readAccountPhone(app, b)).toBeUndefined();
    expect(await readAccountPhone(app, a)).toBeDefined();
  });

  test("a number verified 90 days ago or more moves, and its old account loses it", async () => {
    const n = fresh();
    const a = await newAccount();
    await verified(a, n, { now: days(-PHONE_HOLD_DAYS) });
    const b = await newAccount();
    await verified(b, n);
    expect(await readAccountPhone(app, a)).toBeUndefined();
    expect(await readAccountPhone(app, b)).toEqual({ verifiedOn: DAY_OF_NOW });
    // A move is no release: nothing is held.
    expect(
      await db.admin`SELECT 1 FROM account_phone_holds WHERE phone_hash = ${(await phoneOf(b))!["phone_hash"]}`,
    ).toHaveLength(0);
    // And the move starts a new 90 days.
    expect(await code(verified(await newAccount(), n, { now: days(PHONE_HOLD_DAYS - 1) }))).toBe(
      "number-held",
    );
    await verified(await newAccount(), n, { now: days(PHONE_HOLD_DAYS) });
  });

  test("re-verifying its own number restarts an account's 90 days", async () => {
    const n = fresh();
    const a = await newAccount();
    await verified(a, n, { now: days(-PHONE_HOLD_DAYS) });
    await verified(a, n);
    expect(await code(verified(await newAccount(), n))).toBe("number-held");
  });

  test("a changed number is held for 90 days, and then free", async () => {
    const [n, m] = [fresh(), fresh()];
    const a = await newAccount();
    await verified(a, n);
    await verified(a, m, { now: days(10) });
    expect(
      await code(verified(await newAccount(), n, { now: days(10 + PHONE_HOLD_DAYS - 1) })),
    ).toBe("number-held");
    const b = await newAccount();
    await verified(b, n, { now: days(10 + PHONE_HOLD_DAYS) });
    expect(await readAccountPhone(app, b)).toBeDefined();
  });

  test("a deleted account's number is held, by whichever path deletes it", async () => {
    const n = fresh();
    const a = await newAccount();
    await verified(a, n, { now: days(-PHONE_HOLD_DAYS * 2) });
    const { phone_hash } = (await phoneOf(a))!;
    await app`DELETE FROM account_users WHERE id = ${a}`;
    const holds = await db.admin`
      SELECT freed_on FROM account_phone_holds WHERE phone_hash = ${phone_hash as Buffer}`;
    expect(holds).toHaveLength(1);
    const freed = holds[0]!["freed_on"] as Date;
    expect(await code(verified(await newAccount(), n, { now: freed }))).toBe("number-held");
    const b = await newAccount();
    await verified(b, n, { now: days(PHONE_HOLD_DAYS, freed) });
    expect(
      await db.admin`SELECT 1 FROM account_phone_holds WHERE phone_hash = ${phone_hash as Buffer}`,
    ).toHaveLength(0);
  });

  test("two accounts entering codes for one number at once: one takes it", async () => {
    const n = fresh();
    const [a, b] = [await newAccount(), await newAccount()];
    const p = provider();
    await ask(a, n, { p });
    await ask(b, n, { p });
    const results = await Promise.allSettled([
      enter(a, n, CODE, { p, client: app }),
      enter(b, n, CODE, { p, client: app2 }),
    ]);
    const outcomes = results.map((r) =>
      r.status === "fulfilled"
        ? "ok"
        : r.reason instanceof PhoneVerificationError
          ? r.reason.code
          : String(r.reason),
    );
    expect(outcomes.toSorted()).toEqual(["number-held", "ok"]);
  });

  test("two accounts racing for one number through instances on different keyrings: one takes it", async () => {
    const n = fresh();
    const [a, b] = [await newAccount(), await newAccount()];
    const p = provider();
    await ask(a, n, { p, keys: STAGED });
    await ask(b, n, { p, keys: ROTATED });
    const results = await Promise.allSettled([
      enter(a, n, CODE, { p, keys: STAGED, client: app }),
      enter(b, n, CODE, { p, keys: ROTATED, client: app2 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  test("a hold made under an older key still holds once a new key is current", async () => {
    const n = fresh();
    const a = await newAccount();
    await verified(a, n, { keys: KEYS });
    await verified(a, fresh(), { keys: KEYS });
    expect(await code(verified(await newAccount(), n, { keys: ROTATED }))).toBe("number-held");
  });

  test("a move racing its old account's change of number never frees the new number unheld", async () => {
    for (let i = 0; i < 30; i++) {
      const [n, m] = [fresh(), fresh()];
      const a = await newAccount();
      await verified(a, n, { now: days(-PHONE_HOLD_DAYS) });
      const b = await newAccount();
      const p = provider();
      await ask(a, m, { p });
      await ask(b, n, { p });
      await Promise.allSettled([
        enter(a, m, CODE, { p, client: app }),
        enter(b, n, CODE, { p, client: app2 }),
      ]);
      // Whichever went first, `a` keeps `m`, and `m` is no one's to take.
      expect(await readAccountPhone(app, a)).toBeDefined();
      expect(await code(verified(await newAccount(), m))).toBe("number-held");
    }
  });

  test("refuses a malformed number", async () => {
    expect(await code(enter(await newAccount(), "12345", CODE, { p: provider() }))).toBe(
      "invalid-number",
    );
  });
});

describe("pruneAccountPhones", () => {
  test("drops expired codes, requests and recipients past a day, and ended holds", async () => {
    const a = await newAccount();
    await verified(a, fresh(), { now: days(-200) });
    // A change of number on day -95: the old one's hold ends on day -5.
    await verified(a, fresh(), { now: days(-95) });
    await ask(a, fresh(), { now: days(-3) });
    const pruned = await pruneAccountPhones(app, days(-1));
    expect(pruned.codes).toBeGreaterThanOrEqual(1);
    expect(pruned.sends).toBeGreaterThanOrEqual(3);
    expect(pruned.recipients).toBeGreaterThanOrEqual(3);
    expect(pruned.holds).toBeGreaterThanOrEqual(1);
    expect(
      await db.admin`SELECT 1 FROM account_phone_codes WHERE expires_at < ${days(-1)}`,
    ).toHaveLength(0);
    expect(
      await db.admin`SELECT 1 FROM account_phone_holds
        WHERE freed_on <= ${days(-1 - PHONE_HOLD_DAYS)}`,
    ).toHaveLength(0);
  });
});

describe("rotatePhoneHashes", () => {
  // Keys of their own, so the rows other tests made under p1 and p2 are
  // only ever rows under a key these keyrings don't hold.
  const [R1, R2, R3] = [hexKey(), hexKey(), hexKey()];
  const ONE = parseKeyring(`r1:${R1}`);
  const ONE_STAGED = parseKeyring(`r1:${R1}*,r2:${R2}`);
  const TWO = parseKeyring(`r1:${R1},r2:${R2}`);
  const THREE = parseKeyring(`r1:${R1},r2:${R2},r3:${R3}`);
  const mac = (key: string, hash: Uint8Array) =>
    createHmac("sha256", Buffer.from(key, "hex")).update(hash).digest();
  const first = (number: string) =>
    createHmac("sha256", Buffer.from(R1, "hex")).update("abolish/phone/v1").update(number).digest();
  /** Every stored chain of the four tables, as `table:hex` → key ID. */
  const stored = async () =>
    new Map(
      (
        await db.admin`
          SELECT 'account_phones' AS t, phone_hash, hash_key FROM account_phones
          UNION ALL SELECT 'account_phone_holds', phone_hash, hash_key FROM account_phone_holds
          UNION ALL SELECT 'account_phone_codes', phone_hash, hash_key FROM account_phone_codes
          UNION ALL SELECT 'account_phone_recipients', phone_hash, hash_key
            FROM account_phone_recipients`
      ).map((r) => [
        `${r["t"] as string}:${(r["phone_hash"] as Buffer).toString("hex")}`,
        r["hash_key"] as string | null,
      ]),
    );
  const unknownTo = async (ids: readonly string[]) =>
    Number(
      (
        await db.admin`
          SELECT count(*) AS n FROM (
            SELECT hash_key FROM account_phones UNION ALL SELECT hash_key FROM account_phone_holds
            UNION ALL SELECT hash_key FROM account_phone_codes
            UNION ALL SELECT hash_key FROM account_phone_recipients) t
          WHERE hash_key IS NOT NULL AND NOT hash_key = ANY(${ids as string[]})`
      )[0]!["n"],
    );

  test("extends every table's chains to the current key, as the number's own chain would be", async () => {
    // A verified number, a hold from a change of number, a code waiting and
    // the per-number counts, all under r1.
    const [n, m, w] = [fresh(), fresh(), fresh()];
    const a = await newAccount();
    await verified(a, n, { keys: ONE, now: days(-1) });
    await verified(a, m, { keys: ONE });
    const b = await newAccount();
    const p = provider();
    await ask(b, w, { keys: ONE, p });
    const before = await stored();

    const result = await rotatePhoneHashes(app, TWO);
    const after = await stored();
    for (const [number, tables] of [
      [n, ["account_phone_holds", "account_phone_recipients"]],
      [m, ["account_phones", "account_phone_recipients"]],
      [w, ["account_phone_codes", "account_phone_recipients"]],
    ] as const) {
      const h1 = first(number);
      const h2 = mac(R2, h1);
      for (const table of tables) {
        expect(before.get(`${table}:${h1.toString("hex")}`)).toBe("r1");
        expect(after.has(`${table}:${h1.toString("hex")}`)).toBe(false);
        expect(after.get(`${table}:${h2.toString("hex")}`)).toBe("r2");
      }
    }
    expect(result.rotated).toBe([...before.values()].filter((k) => k === "r1").length);
    expect([...after.values()]).not.toContain("r1");
    expect(result.unknownKeys).toBe(await unknownTo(["r1", "r2"]));

    // And every row still does its work under the rotated chain.
    expect(await readAccountPhone(app, a)).toEqual({ verifiedOn: DAY_OF_NOW });
    expect(await code(verified(await newAccount(), m, { keys: TWO }))).toBe("number-held");
    expect(await code(verified(await newAccount(), n, { keys: TWO }))).toBe("number-held");
    await enter(b, w, CODE, { keys: TWO, p });
    expect(await readAccountPhone(app, b)).toEqual({ verifiedOn: DAY_OF_NOW });
  });

  test("a waiting code's tries and a number's daily cap carry over", async () => {
    const [n, c] = [fresh(), fresh()];
    const a = await newAccount();
    const p = provider();
    await ask(a, n, { keys: ONE, p });
    expect(await code(enter(a, n, "000000", { keys: ONE, p }))).toBe("wrong-code");
    for (let i = 1; i < MAX_SENDS_PER_NUMBER; i++) await ask(await newAccount(), c, { keys: ONE });
    await rotatePhoneHashes(app, TWO);
    expect(await failure(enter(a, n, "000000", { keys: TWO, p }))).toMatchObject({
      code: "wrong-code",
      triesLeft: PHONE_CODE_TRIES - 2,
    });
    const q = provider();
    await ask(await newAccount(), c, { keys: TWO, p: q });
    await ask(await newAccount(), c, { keys: TWO, p: q });
    // The cap's last code went, and then no more.
    expect(q.started).toHaveLength(1);
  });

  test("goes through every later key at once, from wherever a chain stands", async () => {
    const [n, m] = [fresh(), fresh()];
    const [a, b] = [await newAccount(), await newAccount()];
    await verified(a, n, { keys: ONE });
    await verified(b, m, { keys: TWO });
    await rotatePhoneHashes(app, THREE);
    const h1 = first(n);
    expect(await phoneOf(a)).toEqual({ phone_hash: mac(R3, mac(R2, h1)), hash_key: "r3" });
    expect(await phoneOf(b)).toEqual({ phone_hash: mac(R3, mac(R2, first(m))), hash_key: "r3" });
  });

  test("leaves chains under the current key or a staged one, and a second run does nothing", async () => {
    const n = fresh();
    const a = await newAccount();
    await verified(a, n, { keys: ONE });
    expect((await rotatePhoneHashes(app, ONE_STAGED)).rotated).toBe(0);
    expect((await rotatePhoneHashes(app, ONE)).rotated).toBe(0);
    expect(await phoneOf(a)).toEqual({ phone_hash: first(n), hash_key: "r1" });
    expect((await rotatePhoneHashes(app, TWO)).rotated).toBeGreaterThanOrEqual(1);
    expect((await rotatePhoneHashes(app, TWO)).rotated).toBe(0);
    // Under r2 now, a keyring with r2 staged after a current r1 leaves it be.
    expect((await rotatePhoneHashes(app, ONE_STAGED)).rotated).toBe(0);
    expect(await phoneOf(a)).toEqual({ phone_hash: mac(R2, first(n)), hash_key: "r2" });
  });

  test("leaves rows under a key the keyring doesn't hold, and counts them", async () => {
    const a = await newAccount();
    await verified(a, fresh(), { keys: KEYS });
    const { phone_hash } = (await phoneOf(a))!;
    const result = await rotatePhoneHashes(app, TWO);
    expect(await phoneOf(a)).toEqual({ phone_hash, hash_key: "p1" });
    expect(result.unknownKeys).toBeGreaterThanOrEqual(1);
    expect(result.unknownKeys).toBe(await unknownTo(["r1", "r2"]));
  });

  test("a count from before the per-number key was kept is left alone, and still counts", async () => {
    const n = fresh();
    const h1 = first(n);
    for (let i = 0; i < MAX_SENDS_PER_NUMBER; i++)
      await db.admin`
        INSERT INTO account_phone_recipients (phone_hash, sent_at)
        VALUES (${h1}, ${new Date("2026-10-22T11:00:00Z")})`;
    await rotatePhoneHashes(app, TWO);
    expect(
      await db.admin`SELECT hash_key FROM account_phone_recipients WHERE phone_hash = ${h1}`,
    ).toHaveLength(MAX_SENDS_PER_NUMBER);
    const p = provider();
    await ask(await newAccount(), n, { keys: TWO, p });
    expect(p.started).toHaveLength(0);
  });

  test("racing answers never fails a move, frees a number unheld or lets one verify twice", async () => {
    for (let i = 0; i < 20; i++) {
      const [n, m] = [fresh(), fresh()];
      const a = await newAccount();
      await verified(a, n, { keys: ONE, now: days(-PHONE_HOLD_DAYS) });
      const b = await newAccount();
      const c = await newAccount();
      const p = provider();
      await ask(b, n, { keys: TWO, p });
      await ask(a, m, { keys: TWO, p });
      const [rotation, move, change] = await Promise.allSettled([
        rotatePhoneHashes(app2, TWO),
        enter(b, n, CODE, { keys: TWO, p, client: app }),
        enter(a, m, CODE, { keys: TWO, p, client: app }),
      ]);
      expect(rotation.status).toBe("fulfilled");
      expect(move.status).toBe("fulfilled");
      expect(change.status).toBe("fulfilled");
      expect(await readAccountPhone(app, b)).toBeDefined();
      expect(await code(verified(c, n, { keys: TWO }))).toBe("number-held");
      expect(await code(verified(c, m, { keys: TWO }))).toBe("number-held");
    }
  });

  test("rotates nothing while a key's bytes differ from those its ID was first seen with", async () => {
    const [M1, M2] = [hexKey(), hexKey()];
    const n = fresh();
    const a = await newAccount();
    await verified(a, n, { keys: parseKeyring(`m1:${M1}`) });
    // The first instance holding m2 stores its check; one with m2 retyped is refused.
    expect((await rotatePhoneHashes(app, parseKeyring(`m1:${M1}*,m2:${M2}`))).mismatchedKeys).toBe(
      0,
    );
    const wrong = await rotatePhoneHashes(app, parseKeyring(`m1:${M1},m2:${hexKey()}`));
    expect(wrong).toMatchObject({ rotated: 0, mismatchedKeys: 1 });
    expect((await phoneOf(a))!["hash_key"]).toBe("m1");
    const right = await rotatePhoneHashes(app, parseKeyring(`m1:${M1},m2:${M2}`));
    expect(right.mismatchedKeys).toBe(0);
    expect((await phoneOf(a))!["hash_key"]).toBe("m2");
    const owner = await db.as("abolish_migrator");
    await expect(
      owner`INSERT INTO account_phone_key_checks VALUES ('m3', ${randomBytes(31)})`,
    ).rejects.toThrow(/check constraint/);
  });

  test("leaves a number two accounts hold unrotated, counted, and rotates the rest", async () => {
    const [n, m] = [fresh(), fresh()];
    const [a, b, c] = [await newAccount(), await newAccount(), await newAccount()];
    await verified(a, n, { keys: ONE });
    await verified(c, m, { keys: ONE });
    // As an instance missing r1 could have let happen: b holds n under r2.
    await db.admin`
      INSERT INTO account_phones VALUES (${b}, ${mac(R2, first(n))}, 'r2', ${DAY_OF_NOW})`;
    const result = await rotatePhoneHashes(app, TWO);
    expect(result.conflicts).toBe(1);
    expect(await phoneOf(a)).toEqual({ phone_hash: first(n), hash_key: "r1" });
    expect(await phoneOf(c)).toEqual({ phone_hash: mac(R2, first(m)), hash_key: "r2" });
    await db.admin`DELETE FROM account_users WHERE id IN (${a}, ${b})`;
  });

  test("a key's check value is the HMAC of its label, as stored for good", async () => {
    await rotatePhoneHashes(app, parseKeyring(`kp:${"00".repeat(31)}03`));
    const [row] = await db.admin`
      SELECT encode(key_check, 'hex') AS c FROM account_phone_key_checks WHERE key_id = 'kp'`;
    // Pinned: a change to the label or the construction would refuse every
    // rotation under keys already in use.
    expect(row!["c"]).toBe("cca577666eed0346d8ea86858d996d05ec691e36d2131f2fa39ab8f1d38b2cc8");
  });

  test("an instance with the new key only staged keeps holding and capping numbers through a rotation", async () => {
    for (let i = 0; i < 10; i++) {
      const [n, c] = [fresh(), fresh()];
      const a = await newAccount();
      await verified(a, n, { keys: ONE });
      for (let j = 1; j < MAX_SENDS_PER_NUMBER; j++)
        await ask(await newAccount(), c, { keys: ONE });
      const p = provider();
      const b = await newAccount();
      await ask(b, n, { keys: ONE_STAGED, p });
      const q = provider();
      // Made before the race, so every promise below is handled from the start.
      const d = await newAccount();
      const [rotation, answer, last] = await Promise.allSettled([
        rotatePhoneHashes(app2, TWO),
        enter(b, n, CODE, { keys: ONE_STAGED, p, client: app }),
        ask(d, c, { keys: ONE_STAGED, p: q }),
      ]);
      expect(rotation.status).toBe("fulfilled");
      expect(answer.status === "rejected" && answer.reason.code).toBe("number-held");
      expect(last.status).toBe("fulfilled");
      // The cap's last code went; the next is held back, whichever chain the rows are under.
      expect(q.started).toHaveLength(1);
      const r = provider();
      await ask(await newAccount(), c, { keys: ONE_STAGED, p: r });
      expect(r.started).toHaveLength(0);
    }
  });
});
