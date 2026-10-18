import {
  ceremonyTranscriptHash,
  checkElectionRecordToShow,
  decodeBoardEntry,
  decodeDisplayTextV2,
  decodeElectionDefinitionV5,
  displayTextV2Commitment,
  electionDefinitionV5Hash,
  encodeDisplayTextV2,
  encodeElectionDefinitionV5,
  identityKey,
  type Panel,
  tierTreeRoot,
} from "@abolishus/crypto";
import { electionAdmission } from "@abolishus/verifier";
import fc from "fast-check";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  appendEntry,
  approvedCeremony,
  type BoardClock,
  createPollDraft,
  draftDisplayText,
  newAccountId,
  openCeremonyRuns,
  openPolls,
  type PollDraft,
  pollReadBack,
  pollRegistration,
  type PollStubDeployment,
  readBoard,
  readServedDisplayText,
  recordRegistration,
  type RegisteredPoll,
  type StoredTierElectorate,
  storeDefinition,
  stubPolls,
  submitPollDraft,
} from "../src/index.ts";
import { Seat } from "./ceremony-seats.ts";
import { type TestDb, testDb } from "./db.ts";

// The opening step of a poll's setup (ADR 0032, rules 12 to 14; P2-22 part
// 5c), on polls whose ceremony the coordinator ran between three honest
// seats and whose registration the registry sync recorded. A poll opens only
// once what the registry holds is, field by field, the definition its draft,
// electorate and approved stub make (T-34), with its transcript boarded as
// entry 0, where admission finds it, and its display text served.

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const address = (b: number) => new Uint8Array(20).fill(b);
// The hourly clock of the anchor every stub pins; the creations' L1 origin
// is a day before NOW.
const CLOCK: BoardClock = { anchor: address(0xb1), epoch: 1_700_000_000n, period: 3600n };
const ORIGIN = NOW_S - 86_400n;
const segmentAt = (t: bigint) => Number((t - CLOCK.epoch) / CLOCK.period);
const secret = (i: number) => {
  const d = new Uint8Array(32);
  d[0] = 0x42;
  d[31] = i;
  return d;
};
const SECRETS = [1, 2, 3].map(secret);
const PANEL: Panel = { threshold: 2, keys: SECRETS.map(identityKey) };
const ascending = (keys: Uint8Array[]) =>
  keys.sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));

const DEPLOYMENT: PollStubDeployment = {
  l2ChainId: 84532n,
  l1ChainId: 11155111n,
  electionRegistry: address(0xa1),
  board: address(0xa2),
  trusteeRegistry: address(0xa3),
  groupRegistry: address(0xa4),
  l1Anchor: address(0xb1),
  l1Relay: address(0xb2),
  panel: PANEL,
  receiptKeys: ascending([identityKey(secret(9)), identityKey(secret(8))]),
  l1InclusionBound: 3600,
  sequencingWindow: 3600n,
  maxSequencerDrift: 1800n,
};

const ELECTORATE: StoredTierElectorate[] = [
  {
    tier: 0,
    rootL2Block: "500",
    groups: [{ groupId: "1", region: 0 }],
    regions: ["3"],
    cells: [{ root: tierTreeRoot([11n, 12n, 13n]).toString(), members: "3" }],
  },
];

const DRAFT: PollDraft = {
  language: "en",
  title: "Lunch",
  description: "Where the team eats",
  questions: [
    {
      question: "Which day?",
      description: "",
      options: [
        { label: "Friday", description: "" },
        { label: "Monday", description: "" },
      ],
      minSelections: 0,
      maxSelections: 1,
    },
    {
      question: "Which places?",
      description: "Any you like",
      options: [
        { label: "Noodles", description: "" },
        { label: "Tacos", description: "" },
        { label: "Salad", description: "" },
      ],
      minSelections: 1,
      maxSelections: 3,
    },
  ],
  tiers: [0],
  closesAt: NOW_S + 7n * 24n * 3600n,
};

let db: TestDb;
let app: Sql;
let blockNumber = 1000n;

interface Registered {
  readonly id: string;
  readonly electionId: Uint8Array;
  /** What the read-back compares, as the database holds it once synced. */
  readonly poll: RegisteredPoll & { readonly definition: Uint8Array };
}

/**
 * A poll stubbed, its ceremony run and approved, and moved to `registered`
 * as part 5b leaves it; with `synced`, its registration recorded and its
 * definition stored as the registry sync does.
 */
async function registered(synced = true): Promise<Registered> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const submittedAt = new Date(NOW.getTime() - 3600_000);
  const id = await createPollDraft(app, author, DRAFT, submittedAt);
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: submittedAt,
  });
  const electionId = new Uint8Array(randomBytes(32));
  await db.admin`
    UPDATE account_polls SET state = 'rooted', creator_address = ${address(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${electionId}, created_block = 7,
      l1_origin_timestamp = ${ORIGIN.toString()}, anchors_checked_block = 9,
      electorate = ${db.admin.json(ELECTORATE as never)}
    WHERE id = ${id}`;
  expect((await stubPolls(app, DEPLOYMENT, { now: NOW })).stubbed).toBe(1);
  const [row] = await db.admin`SELECT stub_hash FROM account_polls WHERE id = ${id}`;
  const stubHash = Uint8Array.from(row!["stub_hash"]);
  expect((await openCeremonyRuns(app, DEPLOYMENT, { now: NOW })).opened).toBe(1);
  const seats = [1, 2, 3].map(
    (i) => new Seat(i, { deployment: DEPLOYMENT, secrets: SECRETS, client: () => app, now: NOW }),
  );
  for (let round = 1; round <= 5; round++) for (const s of seats) await s.act();
  const approved = (await approvedCeremony(app, stubHash))!;
  const [stub] = await db.admin`
    SELECT stub, display_text, opens_at FROM ceremony_stubs WHERE stub_hash = ${stubHash}`;
  const registration = pollRegistration(
    Uint8Array.from(stub!["stub"]),
    stubHash,
    electionId,
    PANEL,
    approved,
  );
  if (typeof registration === "string") throw new Error(registration);
  const block = ++blockNumber;
  await db.admin`
    UPDATE account_polls SET state = 'registered', ceremony_tx_hash = ${randomBytes(32)},
      register_tx_hash = ${randomBytes(32)}, registered_block = ${block.toString()}
    WHERE id = ${id}`;
  if (synced) await sync(electionId, registration.definition, registration.definitionHash, block);
  return {
    id,
    electionId,
    poll: {
      electionId,
      draft: DRAFT,
      electorate: ELECTORATE,
      stubHash,
      stub: Uint8Array.from(stub!["stub"]),
      displayText: Uint8Array.from(stub!["display_text"]),
      opensAt: BigInt(stub!["opens_at"]),
      transcript: approved.transcript,
      registeredHash: registration.definitionHash,
      definition: registration.definition,
    },
  };
}

/** The registry sync's two writes for one finalized `DefinitionRegistered`. */
async function sync(
  electionId: Uint8Array,
  definition: Uint8Array,
  hash: Uint8Array,
  block: bigint,
) {
  await storeDefinition(app, definition);
  await recordRegistration(app, { electionId, definitionHash: hash, l2Block: block, logIndex: 0 });
}

const SOON = later(60);
const CLOSES = new Date(Number(DRAFT.closesAt) * 1000);
const run = (now = SOON, client = app) => openPolls(client, CLOCK, { now });
const quiet = {
  opened: 0,
  waiting: 0,
  early: 0,
  otherAnchor: 0,
  unboarded: 0,
  errored: 0,
  failed: {},
};
const poll = async (id: string) => {
  const [r] = await db.admin`SELECT state, failure FROM account_polls WHERE id = ${id}`;
  return r!;
};
const clear = () => db.admin`DELETE FROM account_polls WHERE state = 'registered'`;

/** One registered poll's records, shared by the read-back's pure tests. */
let base: Registered;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  base = await registered(false);
  await clear();
}, 120_000);
afterAll(() => db?.close());

// Each test runs a whole key ceremony (five rounds by three seats) before it
// opens anything: about 1 to 2.5 s here, past the default 5 s on a loaded CI
// runner, and a timed-out test's seats then run into the next test's.
describe("a registered poll", { timeout: 60_000 }, () => {
  test("opens once synced: the transcript is entry 0 in the current segment, admission takes it, and its text is served", async () => {
    const r = await registered(false);
    // The registry sync hasn't recorded it: nothing moves or is written.
    expect(await run()).toEqual({ ...quiet, waiting: 1 });
    expect(await readBoard(app, r.electionId)).toEqual([]);
    await sync(r.electionId, r.poll.definition, r.poll.registeredHash, ++blockNumber);

    expect(await run()).toEqual({ ...quiet, opened: 1 });
    expect(await poll(r.id)).toMatchObject({ state: "open", failure: null });
    const board = await readBoard(app, r.electionId);
    expect(board.length).toBe(1);
    const entry = decodeBoardEntry(board[0]!, 5);
    expect(entry).toMatchObject({ index: 0n, segment: segmentAt(NOW_S + 60n) });
    expect(entry.payload).toEqual(r.poll.transcript);
    expect(ceremonyTranscriptHash(entry.payload)).toEqual(
      decodeElectionDefinitionV5(r.poll.definition).ceremony_transcript_hash,
    );
    // What admission reads: the definition and entry 0.
    expect(electionAdmission(r.poll.definition, PANEL, board)).toMatchObject({ ok: true });
    const served = await readServedDisplayText(app, r.electionId, NOW_S);
    expect(served).toEqual({ served: "text", displayText: r.poll.displayText });
    expect(
      checkElectionRecordToShow(
        r.electionId,
        r.poll.registeredHash,
        r.poll.definition,
        r.poll.displayText,
      ),
    ).toMatchObject({ ok: true });

    // A rerun writes nothing more.
    expect(await run(later(7200))).toEqual(quiet);
    expect(await readBoard(app, r.electionId)).toEqual(board);
  });

  test("finishes after a crash between its writes, appending nothing twice", async () => {
    const r = await registered();
    // As if a run stored the text and boarded the transcript, then died.
    await appendEntry(app, r.electionId, segmentAt(NOW_S), r.poll.transcript);
    expect(await run()).toEqual({ ...quiet, opened: 1 });
    const board = await readBoard(app, r.electionId);
    expect(board.length).toBe(1);
    // The entry kept its first segment.
    expect(decodeBoardEntry(board[0]!, 5).segment).toBe(segmentAt(NOW_S));
  });

  test("two runs racing on separate connections board the transcript once", async () => {
    const r = await registered();
    const other = await db.as("abolish_app");
    const reports = await Promise.all([run(SOON, app), run(SOON, other)]);
    expect(reports.reduce((n, x) => n + x.opened, 0)).toBe(1);
    expect((await readBoard(app, r.electionId)).length).toBe(1);
    expect((await poll(r.id))["state"]).toBe("open");
  });

  test("waits while the clock is before the creation's first segment", async () => {
    const r = await registered();
    const behind = new Date(Number(ORIGIN - CLOCK.period) * 1000);
    expect(await run(behind)).toEqual({ ...quiet, early: 1 });
    const beforeEpoch = new Date(Number(CLOCK.epoch - 1n) * 1000);
    expect(await run(beforeEpoch)).toEqual({ ...quiet, early: 1 });
    expect(await readBoard(app, r.electionId)).toEqual([]);
    expect(await run()).toEqual({ ...quiet, opened: 1 });
  });

  test("is left when its board starts with another entry, which admission would read instead", async () => {
    const r = await registered();
    const other = r.poll.transcript.slice();
    other[other.length - 1]! ^= 1;
    await appendEntry(app, r.electionId, segmentAt(NOW_S), other);
    expect(await run()).toEqual({ ...quiet, unboarded: 1 });
    expect((await poll(r.id))["state"]).toBe("registered");
    expect((await readBoard(app, r.electionId)).length).toBe(1);
    await clear();
  });

  test("fails as open-mismatch when its draft no longer matches what was registered, writing nothing", async () => {
    const r = await registered();
    // The author's draft as stored differs from what was registered.
    await db.admin`
      UPDATE account_polls SET draft = jsonb_set(draft, '{title}', '"Dinner"') WHERE id = ${r.id}`;
    expect(await run()).toEqual({ ...quiet, failed: { "open-mismatch": 1 } });
    expect(await poll(r.id)).toMatchObject({ state: "failed", failure: "open-mismatch" });
    expect(await readBoard(app, r.electionId)).toEqual([]);
    expect(await readServedDisplayText(app, r.electionId, NOW_S)).toEqual({ served: "none" });
  });

  test("leaves a poll another run moved, and polls in other states", async () => {
    const r = await registered();
    await db.admin`UPDATE account_polls SET election_id = ${randomBytes(32)} WHERE id = ${r.id}`;
    // Its new identifier has no registration: it waits, and nothing is written for the old one.
    expect(await run()).toEqual({ ...quiet, waiting: 1 });
    expect(await readBoard(app, r.electionId)).toEqual([]);
    await clear();
  });

  test("judges a registration the sync recorded without its definition by its hash: the draft's waits, another fails", async () => {
    const r = await registered(false);
    await recordRegistration(app, {
      electionId: r.electionId,
      definitionHash: r.poll.registeredHash,
      l2Block: ++blockNumber,
      logIndex: 0,
    });
    expect(await run()).toEqual({ ...quiet, waiting: 1 });
    // The poll left was touched, so polls behind it go first next time.
    const [row] = await db.admin`SELECT updated_at FROM account_polls WHERE id = ${r.id}`;
    expect(row!["updated_at"]).toEqual(SOON);
    await clear();

    const other = await registered(false);
    await recordRegistration(app, {
      electionId: other.electionId,
      definitionHash: new Uint8Array(32).fill(9),
      l2Block: ++blockNumber,
      logIndex: 0,
    });
    expect(await run()).toEqual({ ...quiet, failed: { "open-mismatch": 1 } });
    expect(await poll(other.id)).toMatchObject({ state: "failed", failure: "open-mismatch" });
  });

  test("fails a poll whose stub or approved run is missing, since nothing can be compared", async () => {
    const r = await registered();
    await db.admin`UPDATE account_polls SET stub_hash = ${randomBytes(32)} WHERE id = ${r.id}`;
    expect(await run()).toEqual({ ...quiet, failed: { "open-mismatch": 1 } });
    expect(await readBoard(app, r.electionId)).toEqual([]);
  });

  test("leaves a poll whose stub pins another anchor than the clock's, until its close", async () => {
    const r = await registered();
    const other = { ...CLOCK, anchor: address(0xb9) };
    const before = new Date(Number(DRAFT.closesAt) * 1000 - 1000);
    expect(await openPolls(app, other, { now: before })).toEqual({ ...quiet, otherAnchor: 1 });
    expect((await poll(r.id))["state"]).toBe("registered");
    expect(await openPolls(app, other, { now: CLOSES })).toEqual({
      ...quiet,
      failed: { "open-timeout": 1 },
    });
    expect(await poll(r.id)).toEqual({ state: "failed", failure: "open-timeout" });
    expect(await readBoard(app, r.electionId)).toEqual([]);
  });

  test("fails `open-timeout` a poll that would open at or past its close, boarding nothing", async () => {
    const r = await registered();
    expect(await run(CLOSES)).toEqual({ ...quiet, failed: { "open-timeout": 1 } });
    expect(await poll(r.id)).toEqual({ state: "failed", failure: "open-timeout" });
    expect(await readBoard(app, r.electionId)).toEqual([]);
    // Failed, it is never taken again.
    expect(await run(CLOSES)).toEqual(quiet);
  });

  test("fails `open-timeout` a poll still waiting for the registry sync at its close", async () => {
    const r = await registered(false);
    const before = new Date(CLOSES.getTime() - 1000);
    expect(await run(before)).toEqual({ ...quiet, waiting: 1 });
    expect((await poll(r.id))["state"]).toBe("registered");
    expect(await run(CLOSES)).toEqual({ ...quiet, failed: { "open-timeout": 1 } });
    expect(await poll(r.id)).toEqual({ state: "failed", failure: "open-timeout" });
  });

  test("fails a poll the read-back refuses as `open-mismatch`, even past its close", async () => {
    const r = await registered();
    await db.admin`UPDATE account_polls SET stub_hash = ${randomBytes(32)} WHERE id = ${r.id}`;
    expect(await run(CLOSES)).toEqual({ ...quiet, failed: { "open-mismatch": 1 } });
    expect(await poll(r.id)).toEqual({ state: "failed", failure: "open-mismatch" });
  });

  test("counts a poll whose step throws and opens the rest", async () => {
    const bad = await registered();
    await db.admin`
      UPDATE account_polls SET draft = jsonb_set(draft, '{closesAt}', '"soon"') WHERE id = ${bad.id}`;
    const good = await registered();
    expect(await run()).toEqual({ ...quiet, opened: 1, errored: 1 });
    expect((await poll(good.id))["state"]).toBe("open");
    expect((await poll(bad.id))["state"]).toBe("registered");
    await clear();
  });

  test("the table refuses the new failure outside `failed`, and any unknown failure", async () => {
    const r = await registered();
    await expect(
      db.admin`UPDATE account_polls SET failure = 'open-mismatch' WHERE id = ${r.id}`,
    ).rejects.toThrow();
    await expect(
      db.admin`UPDATE account_polls SET state = 'failed', failure = 'open-other' WHERE id = ${r.id}`,
    ).rejects.toThrow();
    await clear();
  });
});

describe("the read-back", () => {
  const bump = (b: Uint8Array) => {
    const c = b.slice();
    c[c.length - 1]! ^= 1;
    return c;
  };
  /** The registry holding the registered definition with `change` applied, stored and hashed. */
  const holding = (change: (d: ReturnType<typeof decodeElectionDefinitionV5>) => object) => {
    const d = decodeElectionDefinitionV5(base.poll.definition);
    const definition = encodeElectionDefinitionV5({ ...d, ...change(d) } as typeof d);
    return {
      ...base.poll,
      definition,
      registeredHash: electionDefinitionV5Hash(decodeElectionDefinitionV5(definition)),
    };
  };

  test("accepts the registered definition, stored or by its hash alone", () => {
    expect(pollReadBack(base.poll)).toBeUndefined();
    expect(pollReadBack({ ...base.poll, definition: undefined })).toBeUndefined();
  });

  test("refuses a registry holding anything else, stored or by its hash alone", () => {
    for (const held of [
      holding(() => ({ board: address(0xee) })),
      holding((d) => ({ closes_at: d.closes_at + 60n })),
      holding((d) => ({ receipt_keys: d.receipt_keys.slice(0, 1) })),
      holding(() => ({ ceremony_transcript_hash: new Uint8Array(32).fill(7) })),
      holding((d) => ({ questions: d.questions.slice(0, 1) })),
    ]) {
      expect(pollReadBack(held)).toBe("registered-hash");
      expect(pollReadBack({ ...held, definition: undefined })).toBe("registered-hash");
    }
    expect(pollReadBack({ ...base.poll, registeredHash: bump(base.poll.registeredHash) })).toBe(
      "registered-hash",
    );
    // Another transcript than the approved one: the definition binds that one.
    expect(pollReadBack({ ...base.poll, transcript: bump(base.poll.transcript) })).toBe(
      "registered-hash",
    );
    // Stored bytes other than the registered ones (the sync checks the hash,
    // but the read-back doesn't rest on it).
    expect(pollReadBack({ ...base.poll, definition: base.poll.definition.slice(0, -1) })).toBe(
      "definition",
    );
  });

  test("refuses a recorded stub or display text that isn't the poll's", () => {
    expect(pollReadBack({ ...base.poll, stubHash: bump(base.poll.stubHash) })).toBe("stub");
    expect(pollReadBack({ ...base.poll, stub: base.poll.stub.slice(0, -1) })).toBe("stub");
    expect(pollReadBack({ ...base.poll, displayText: bump(base.poll.displayText) })).toBe(
      "display-text",
    );
  });

  test("refuses every draft field the definition or its text states, changed", () => {
    const q0 = DRAFT.questions[0]!;
    const changed: PollDraft[] = [
      { ...DRAFT, title: "Dinner" },
      { ...DRAFT, language: "fr" },
      { ...DRAFT, description: "" },
      { ...DRAFT, questions: [{ ...q0, question: "Which week?" }, DRAFT.questions[1]!] },
      {
        ...DRAFT,
        questions: [
          { ...q0, options: [...q0.options, { label: "Sunday", description: "" }] },
          DRAFT.questions[1]!,
        ],
      },
      { ...DRAFT, questions: [DRAFT.questions[0]!] },
    ];
    for (const draft of changed) expect(pollReadBack({ ...base.poll, draft })).toBe("display-text");
    // Fields only the definition states: the seats' stub no longer follows.
    expect(pollReadBack({ ...base.poll, draft: { ...DRAFT, closesAt: DRAFT.closesAt + 1n } })).toBe(
      "stub",
    );
    expect(
      pollReadBack({
        ...base.poll,
        draft: { ...DRAFT, questions: [{ ...q0, maxSelections: 2 }, DRAFT.questions[1]!] },
      }),
    ).toBe("stub");
    expect(pollReadBack({ ...base.poll, opensAt: base.poll.opensAt + 1n })).toBe("stub");
    expect(pollReadBack({ ...base.poll, electionId: bump(base.poll.electionId) })).toBe("stub");
    expect(
      pollReadBack({ ...base.poll, electorate: [{ ...ELECTORATE[0]!, rootL2Block: "501" }] }),
    ).toBe("stub");
  });

  test("the recorded text is the draft's under the salt it carries, opening the commitment", () => {
    const registered = decodeElectionDefinitionV5(base.poll.definition);
    const text = decodeDisplayTextV2(base.poll.displayText, registered);
    expect(displayTextV2Commitment(text)).toEqual(registered.display_text_commitment);
    expect(encodeDisplayTextV2(draftDisplayText(DRAFT, text.salt))).toEqual(base.poll.displayText);
  });

  // A definition decoded and hashed, and the read-back run, each run: at CI's
  // 1000 runs, past the 5-second default.
  test(
    "any single changed byte of the registered definition is refused",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(
          fc.nat({ max: base.poll.definition.length - 1 }),
          fc.integer({ min: 1, max: 255 }),
          (at, x) => {
            const definition = base.poll.definition.slice();
            definition[at]! ^= x;
            let registeredHash;
            try {
              registeredHash = electionDefinitionV5Hash(decodeElectionDefinitionV5(definition));
            } catch {
              registeredHash = base.poll.registeredHash;
            }
            // Even with the registry's hash of the changed bytes.
            expect(pollReadBack({ ...base.poll, definition, registeredHash })).toBeDefined();
          },
        ),
        { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) },
      );
    },
  );
});
