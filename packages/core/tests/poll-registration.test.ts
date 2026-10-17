import {
  checkCeremonyTranscript,
  decodeCeremonyRegistration,
  decodeElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionStubV5Hash,
  identityKey,
  keySetHash,
  type Panel,
  tierTreeRoot,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import { createHash, randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  advancePollCreations,
  advancePollRegistrations,
  type ApprovedCeremony,
  approvedCeremony,
  type CreationStatus,
  createPollDraft,
  newAccountId,
  openCeremonyRuns,
  pollRegistration,
  type PollCreationChain,
  type PollDraft,
  type PollRegistrationChain,
  type PollStubDeployment,
  REGISTRATION_DEADLINE_MS,
  REGISTRATION_MARGIN_SECONDS,
  type RegistrationStatus,
  SETUP_SECONDS,
  type SignedCreation,
  type StoredTierElectorate,
  stubPolls,
  submitPollDraft,
} from "../src/index.ts";
import { Seat } from "./ceremony-seats.ts";
import { type TestDb, testDb } from "./db.ts";

// The registration step of a poll's setup (ADR 0032, rules 4, 12 and 14;
// P2-22 part 5a), on a poll whose ceremony the coordinator ran between three
// honest seats, against a chain that keeps a mempool and finalizes when told.
// What the step sends is judged by crypto alone: the definition decodes to
// the stub with the approved transcript's hash and the same stub hash, and
// the ceremony record decodes to the approved key set and approvals, each
// verifying under the panel (T-34, T-37, T-14). Both are recorded before
// either is sent and never signed twice; a poll moves to `registered` only
// once its registration is final and is the poll's own.

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const OPENS_AT = NOW_S + BigInt(SETUP_SECONDS);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const address = (b: number) => new Uint8Array(20).fill(b);
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
  description: "",
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
  ],
  tiers: [0],
  closesAt: NOW_S + 7n * 24n * 3600n,
};

interface Signed {
  readonly kind: "create" | "ceremony" | "definition";
  readonly nonce: bigint;
  readonly payload: Uint8Array;
}
interface Mined {
  readonly hash: string;
  readonly block: bigint;
}

/**
 * The creation key on a chain that includes its mempool, in nonce order,
 * when `mine` says, with a registry that admits a definition when told to
 * (`registers`) or reverts it.
 */
class FakeChain implements PollRegistrationChain, PollCreationChain {
  readonly creator = address(0xc0);
  /** Every transaction signed, by its hash. */
  readonly signed = new Map<string, Signed>();
  readonly sent: string[] = [];
  readonly mempool = new Map<bigint, string>();
  readonly mined: Mined[] = [];
  block = 100n;
  finalized = 100n;
  refuse = 0;
  reverts = false;
  /** Overrides the definition hash the registry reports. */
  reportedHash: Uint8Array | undefined;
  onSend: ((hash: string) => Promise<void>) | undefined;

  async nonces() {
    const latest = BigInt(this.mined.length);
    const finalized = BigInt(this.mined.filter((m) => m.block <= this.finalized).length);
    let pending = latest;
    while (this.mempool.has(pending)) pending++;
    return { finalized, latest, pending };
  }

  #sign(kind: Signed["kind"], nonce: bigint, payload: Uint8Array): SignedCreation {
    const tx = new TextEncoder().encode(`${kind}:${nonce}:${this.signed.size}`);
    const hash = sha256(tx);
    this.signed.set(hex(hash), { kind, nonce, payload: payload.slice() });
    return { tx, hash };
  }

  async signCreation(nonce: bigint) {
    return this.#sign("create", nonce, new Uint8Array());
  }
  async signCeremony(nonce: bigint, record: Uint8Array) {
    return this.#sign("ceremony", nonce, record);
  }
  async signDefinition(nonce: bigint, definition: Uint8Array) {
    return this.#sign("definition", nonce, definition);
  }

  async broadcast(tx: Uint8Array): Promise<void> {
    const hash = hex(sha256(tx));
    await this.onSend?.(hash);
    if (this.refuse > 0) {
      this.refuse--;
      throw new Error("the node refused it");
    }
    this.sent.push(hash);
    const { nonce } = this.signed.get(hash)!;
    if (nonce >= BigInt(this.mined.length)) this.mempool.set(nonce, hash);
  }

  async creation(): Promise<CreationStatus> {
    return { state: "unknown" };
  }

  async registration(hash: Uint8Array): Promise<RegistrationStatus> {
    const m = this.mined.find((x) => x.hash === hex(hash));
    if (m === undefined) return { state: "unknown" };
    if (m.block > this.finalized) return { state: "included" };
    if (this.reverts) return { state: "reverted" };
    const d = decodeElectionDefinitionV5(this.signed.get(m.hash)!.payload);
    return {
      state: "registered",
      electionId: d.election_id,
      definitionHash: this.reportedHash ?? electionDefinitionV5Hash(d),
      block: m.block,
    };
  }

  mine() {
    for (let n = BigInt(this.mined.length); this.mempool.has(n); n++) {
      const hash = this.mempool.get(n)!;
      this.mempool.delete(n);
      this.mined.push({ hash, block: ++this.block });
    }
  }

  mineStranger() {
    const nonce = BigInt(this.mined.length);
    this.mempool.delete(nonce);
    this.mined.push({ hash: `stranger:${nonce}`, block: ++this.block });
  }

  finalize() {
    this.finalized = this.block;
  }

  of(kind: Signed["kind"]) {
    return [...this.signed.values()].filter((s) => s.kind === kind);
  }
}

let db: TestDb;
let app: Sql;
/** The poll whose ceremony ran, and its stub. */
let pollId: string;
let stubHash: Uint8Array;

/** A poll the stub step moved to `ceremony`, as part 4a leaves it. */
async function stubbed(): Promise<{ id: string; stubHash: Uint8Array }> {
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
  await db.admin`
    UPDATE account_polls SET state = 'rooted', creator_address = ${address(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${randomBytes(32)}, created_block = 7,
      l1_origin_timestamp = 1, anchors_checked_block = 9,
      electorate = ${db.admin.json(ELECTORATE as never)}
    WHERE id = ${id}`;
  expect((await stubPolls(app, DEPLOYMENT, { now: NOW })).stubbed).toBe(1);
  const [row] = await db.admin`SELECT stub_hash FROM account_polls WHERE id = ${id}`;
  return { id, stubHash: Uint8Array.from(row!["stub_hash"]) };
}

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
  // One ceremony, run once: each test starts from its approved run.
  ({ id: pollId, stubHash } = await stubbed());
  expect((await openCeremonyRuns(app, DEPLOYMENT, { now: NOW })).opened).toBe(1);
  const seats = [1, 2, 3].map(
    (i) => new Seat(i, { deployment: DEPLOYMENT, secrets: SECRETS, client: () => app, now: NOW }),
  );
  for (let round = 1; round <= 5; round++) for (const s of seats) await s.act();
  expect(await approvedCeremony(app, stubHash)).toBeDefined();
}, 120_000);
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin`
    UPDATE account_polls SET state = 'ceremony', failure = NULL, ceremony_tx_hash = NULL,
      register_tx_hash = NULL, registered_block = NULL
    WHERE id = ${pollId}`;
  await db.admin`DELETE FROM account_polls WHERE id <> ${pollId}`;
  await db.admin`DELETE FROM poll_creation_txs`;
});

const SOON = later(60);
const run = (chain: FakeChain, now = SOON, panel = PANEL, client = app) =>
  advancePollRegistrations(client, chain, panel, { now });
const poll = async (id = pollId) => {
  const [r] = await db.admin`
    SELECT state, failure, ceremony_tx_hash, register_tx_hash, registered_block
    FROM account_polls WHERE id = ${id}`;
  return r!;
};
const ledger = () =>
  db.admin`SELECT nonce, kind, tx_hash FROM poll_creation_txs ORDER BY nonce`.then((rows) =>
    rows.map((r) => ({ nonce: BigInt(r["nonce"]), kind: r["kind"], hash: hex(r["tx_hash"]) })),
  );
const quiet = {
  sent: 0,
  resent: 0,
  sendFailed: 0,
  registered: 0,
  waiting: 0,
  late: 0,
  mismatched: 0,
  failed: {},
};

describe("an approved poll", () => {
  test("registers its ceremony and definition, judged by crypto, and is registered once final", async () => {
    const chain = new FakeChain();
    expect(await run(chain)).toEqual({ ...quiet, sent: 1 });
    const [ceremony] = chain.of("ceremony");
    const [definition] = chain.of("definition");
    expect([ceremony!.nonce, definition!.nonce]).toEqual([0n, 1n]);
    expect(chain.of("ceremony").length + chain.of("definition").length).toBe(2);

    // The definition is the stub with the approved transcript's hash.
    const approved = (await approvedCeremony(app, stubHash))!;
    const [stub] = await db.admin`SELECT stub FROM ceremony_stubs WHERE stub_hash = ${stubHash}`;
    const d = decodeElectionDefinitionV5(definition!.payload);
    expect(d).toEqual({
      ...decodeElectionDefinitionV5(Uint8Array.from(stub!["stub"])),
      ceremony_transcript_hash: approved.transcriptHash,
    });
    expect(electionStubV5Hash(d)).toEqual(stubHash);
    const [row] = await db.admin`SELECT election_id FROM account_polls WHERE id = ${pollId}`;
    expect(d.election_id).toEqual(Uint8Array.from(row!["election_id"]));
    const check = checkCeremonyTranscript(
      {
        l2ChainId: d.l2_chain_id,
        trusteeRegistry: d.trustee_registry,
        electionId: d.election_id,
        stubHash,
        panel: PANEL,
      },
      approved.transcript,
      1,
    );
    expect(check.ok && check.hash).toEqual(d.ceremony_transcript_hash);

    // The record is the approved run's, and every approval verifies.
    const record = decodeCeremonyRegistration(ceremony!.payload);
    expect(record.stubHash).toEqual(stubHash);
    expect(record.panelId).toEqual(d.panel_id);
    expect(record.ceremonyTranscriptHash).toEqual(d.ceremony_transcript_hash);
    expect(keySetHash(record.keySet)).toEqual(approved.keySetHash);
    expect(record.approvals.map((a) => a.index)).toEqual([1, 2, 3]);
    for (const a of record.approvals)
      expect(
        verifyCeremonyRegistration(
          PANEL,
          {
            l2ChainId: d.l2_chain_id,
            trusteeRegistry: d.trustee_registry,
            index: a.index,
            stubHash,
            ceremonyTranscriptHash: record.ceremonyTranscriptHash,
            keySetHash: keySetHash(record.keySet),
          },
          a.signature,
        ),
      ).toBe(true);

    // Recorded, ceremony first, and sent in that order.
    const recorded = await ledger();
    expect(recorded.map((r) => [r.nonce, r.kind])).toEqual([
      [0n, "register-ceremony"],
      [1n, "register-definition"],
    ]);
    expect(chain.sent).toEqual(recorded.map((r) => r.hash));
    expect(await poll()).toMatchObject({
      state: "ceremony",
      ceremony_tx_hash: Buffer.from(recorded[0]!.hash, "hex"),
      register_tx_hash: Buffer.from(recorded[1]!.hash, "hex"),
      registered_block: null,
    });

    // Included but not final: still in `ceremony`, and not signed again.
    chain.mine();
    expect(await run(chain)).toEqual(quiet);
    expect((await poll())["state"]).toBe("ceremony");
    chain.finalize();
    expect(await run(chain)).toEqual({ ...quiet, registered: 1 });
    expect(await poll()).toMatchObject({ state: "registered", registered_block: "102" });
    expect(await run(chain)).toEqual(quiet);
    expect(chain.signed.size).toBe(2);
  });

  test("records both transactions before sending either, and sends the same bytes after a refused send", async () => {
    const chain = new FakeChain();
    chain.onSend = async () => {
      expect((await ledger()).length).toBe(2);
      expect((await poll())["register_tx_hash"]).not.toBeNull();
    };
    chain.refuse = 1;
    expect(await run(chain)).toMatchObject({ sent: 0, sendFailed: 1 });
    expect(chain.sent).toEqual([]);
    // The next run sends both recorded transactions, in nonce order, and
    // signs nothing new.
    expect(await run(chain)).toMatchObject({ resent: 2, sent: 0 });
    expect(chain.sent).toEqual((await ledger()).map((r) => r.hash));
    expect(chain.signed.size).toBe(2);
    chain.mine();
    chain.finalize();
    expect(await run(chain)).toMatchObject({ registered: 1 });
  });

  test("takes the nonces after every recorded transaction of the key, and the creation ceiling counts creations only", async () => {
    await db.admin`
      INSERT INTO poll_creation_txs (creator_address, nonce, tx, tx_hash, sent_at, kind)
      VALUES (${address(0xc0)}, 4, '\\x01', ${randomBytes(32)}, ${NOW}, 'create')`;
    const chain = new FakeChain();
    await run(chain);
    expect((await ledger()).map((r) => r.nonce)).toEqual([4n, 5n, 6n]);
    // A submitted poll, with one creation sent today and a ceiling of two:
    // the two registrations don't fill it.
    const author = newAccountId();
    await app`
      INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
        false, '', NULL, now(), now())`;
    const id = await createPollDraft(app, author, DRAFT, NOW);
    await submitPollDraft(app, author, id, {
      turnstile: { verify: async () => "passed" as const },
      token: "t",
      now: NOW,
    });
    const created = await advancePollCreations(app, chain, { now: SOON, dailyCeiling: 2 });
    expect(created).toMatchObject({ sent: 1, ceilingReached: false });
    expect(chain.of("create").map((s) => s.nonce)).toEqual([7n]);
  });

  test("two runs racing on separate connections sign one registration", async () => {
    const other = await db.as("abolish_app");
    const chain = new FakeChain();
    const reports = await Promise.all([run(chain), run(chain, SOON, PANEL, other)]);
    expect(reports.map((r) => r.sent).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(chain.signed.size).toBe(2);
    expect((await ledger()).length).toBe(2);
  });
});

describe("a poll left for later", () => {
  test("waits while its stub has no approved run", async () => {
    const { id } = await stubbed();
    const chain = new FakeChain();
    // The approved poll is sent; the other waits.
    expect(await run(chain)).toEqual({ ...quiet, sent: 1, waiting: 1 });
    expect(await poll(id)).toMatchObject({ state: "ceremony", register_tx_hash: null });
  });

  test("isn't signed within the margin of its opening, and is a second before it", async () => {
    const chain = new FakeChain();
    const edge = Number(OPENS_AT - NOW_S) - REGISTRATION_MARGIN_SECONDS;
    expect(await run(chain, later(edge))).toEqual({ ...quiet, late: 1 });
    expect(chain.signed.size).toBe(0);
    expect(await run(chain, later(edge - 1))).toMatchObject({ sent: 1, late: 0 });
  });

  test("isn't signed under another panel", async () => {
    const chain = new FakeChain();
    const other: Panel = { threshold: 2, keys: [4, 5, 6].map((i) => identityKey(secret(i))) };
    expect(await run(chain, SOON, other)).toEqual({ ...quiet, mismatched: 1 });
    expect(chain.signed.size).toBe(0);
    expect((await poll())["state"]).toBe("ceremony");
  });

  test("leaves a poll of another creation key alone", async () => {
    await db.admin`UPDATE account_polls SET creator_address = ${address(0xc1)} WHERE id = ${pollId}`;
    try {
      const chain = new FakeChain();
      expect(await run(chain)).toEqual(quiet);
      expect(chain.signed.size).toBe(0);
    } finally {
      await db.admin`UPDATE account_polls SET creator_address = ${address(0xc0)} WHERE id = ${pollId}`;
    }
  });
});

describe("pollRegistration", () => {
  test("refuses every approved run crypto's checks refuse, and only those", async () => {
    const approved = (await approvedCeremony(app, stubHash))!;
    const [row] = await db.admin`
      SELECT s.stub, p.election_id FROM ceremony_stubs s JOIN account_polls p USING (stub_hash)
      WHERE s.stub_hash = ${stubHash}`;
    const stub = Uint8Array.from(row!["stub"]);
    const electionId = Uint8Array.from(row!["election_id"]);
    const flip = (b: Uint8Array) => b.map((x, i) => (i === 0 ? x ^ 1 : x));
    interface Over {
      stub?: Uint8Array;
      stubHash?: Uint8Array;
      electionId?: Uint8Array;
      panel?: Panel;
      approved?: ApprovedCeremony;
    }
    const build = (o: Over = {}) =>
      pollRegistration(
        o.stub ?? stub,
        o.stubHash ?? stubHash,
        o.electionId ?? electionId,
        o.panel ?? PANEL,
        o.approved ?? approved,
      );
    expect(typeof build()).toBe("object");
    const [one, two, three] = approved.approvals;
    const cases: [string, Over][] = [
      ["a stub that doesn't decode", { stub: stub.subarray(0, stub.length - 1) }],
      ["another stub hash", { stubHash: flip(stubHash) }],
      ["another election", { electionId: flip(electionId) }],
      [
        "another transcript hash",
        { approved: { ...approved, transcriptHash: flip(approved.transcriptHash) } },
      ],
      [
        "a transcript that doesn't check",
        { approved: { ...approved, transcript: flip(approved.transcript) } },
      ],
      ["another key set", { approved: { ...approved, keySetHash: flip(approved.keySetHash) } }],
      ["below the quorum", { approved: { ...approved, approvals: [one!] } }],
      ["out of order", { approved: { ...approved, approvals: [two!, one!, three!] } }],
      ["a seat twice", { approved: { ...approved, approvals: [one!, one!, two!] } }],
      [
        "a seat outside the panel",
        { approved: { ...approved, approvals: [one!, two!, { ...three!, seat: 4 }] } },
      ],
      [
        "another seat's signature",
        { approved: { ...approved, approvals: [one!, { ...two!, signature: three!.signature }] } },
      ],
      [
        "a signature off its form",
        {
          approved: { ...approved, approvals: [one!, { ...two!, signature: new Uint8Array(64) }] },
        },
      ],
    ];
    for (const [name, over] of cases) expect(build(over), name).toBe("refused");
    const other: Panel = { threshold: 2, keys: [4, 5, 6].map((i) => identityKey(secret(i))) };
    expect(build({ panel: other })).toBe("other-panel");
  });
});

describe("a failed registration", () => {
  test("fails `registration-refused` for an approval that doesn't verify, sending nothing", async () => {
    const [kept] = await db.admin`
      SELECT a.run_id, a.signature FROM ceremony_approvals a
      JOIN ceremony_runs r USING (run_id) WHERE r.stub_hash = ${stubHash} AND a.seat = 1`;
    const [two] = await db.admin`
      SELECT a.signature FROM ceremony_approvals a
      JOIN ceremony_runs r USING (run_id) WHERE r.stub_hash = ${stubHash} AND a.seat = 2`;
    await db.admin`
      UPDATE ceremony_approvals SET signature = ${two!["signature"]}
      WHERE run_id = ${kept!["run_id"]} AND seat = 1`;
    try {
      const chain = new FakeChain();
      expect(await run(chain)).toEqual({ ...quiet, failed: { "registration-refused": 1 } });
      expect(chain.signed.size).toBe(0);
      expect(await poll()).toMatchObject({ state: "failed", failure: "registration-refused" });
    } finally {
      await db.admin`
        UPDATE ceremony_approvals SET signature = ${kept!["signature"]}
        WHERE run_id = ${kept!["run_id"]} AND seat = 1`;
    }
  });

  test("fails `registration-reverted` when the definition reverts in finalized history", async () => {
    const chain = new FakeChain();
    chain.reverts = true;
    await run(chain);
    chain.mine();
    chain.finalize();
    expect(await run(chain)).toEqual({ ...quiet, failed: { "registration-reverted": 1 } });
    expect(await poll()).toMatchObject({ state: "failed", registered_block: null });
  });

  test("fails `registration-replaced` when another transaction took its nonce", async () => {
    const chain = new FakeChain();
    chain.refuse = 2;
    await run(chain);
    chain.mineStranger();
    chain.mineStranger();
    chain.finalize();
    expect((await run(chain)).failed).toEqual({ "registration-replaced": 1 });
  });

  test("fails `registration-timeout` once unknown past the deadline, not a millisecond before", async () => {
    const chain = new FakeChain();
    chain.refuse = 2;
    await run(chain);
    chain.refuse = Number.POSITIVE_INFINITY;
    const sent = SOON.getTime();
    expect((await run(chain, new Date(sent + REGISTRATION_DEADLINE_MS))).failed).toEqual({});
    expect((await run(chain, new Date(sent + REGISTRATION_DEADLINE_MS + 1))).failed).toEqual({
      "registration-timeout": 1,
    });
  });

  test("never times out while the registry could still admit it, nor once it is included", async () => {
    const chain = new FakeChain();
    chain.refuse = 2;
    await run(chain);
    chain.refuse = Number.POSITIVE_INFINITY;
    // Past a short deadline but before `opens_at` and its margin: kept.
    const opened = Number(OPENS_AT - NOW_S) + REGISTRATION_MARGIN_SECONDS;
    const at = (seconds: number) =>
      advancePollRegistrations(app, chain, PANEL, { now: later(seconds), deadlineMs: 1 });
    expect((await at(opened - 1)).failed).toEqual({});
    // Included and never finalized: kept, however late.
    chain.refuse = 0;
    await at(opened - 1);
    chain.mine();
    expect((await at(opened + 24 * 3600)).failed).toEqual({});
    expect((await poll())["state"]).toBe("ceremony");
    chain.finalize();
    expect((await at(opened + 24 * 3600)).registered).toBe(1);
  });

  test("fails `registration-mismatch` when the event names another definition", async () => {
    const chain = new FakeChain();
    chain.reportedHash = new Uint8Array(32).fill(7);
    await run(chain);
    chain.mine();
    chain.finalize();
    expect(await run(chain)).toEqual({ ...quiet, failed: { "registration-mismatch": 1 } });
    expect(await poll()).toMatchObject({ state: "failed", failure: "registration-mismatch" });
  });
});

describe("the tables", () => {
  test("refuse `registered` without its registration and block, a block in `ceremony`, and half a registration", async () => {
    const tx = randomBytes(32);
    for (const sql of [
      db.admin`UPDATE account_polls SET state = 'registered' WHERE id = ${pollId}`,
      db.admin`UPDATE account_polls SET register_tx_hash = ${tx} WHERE id = ${pollId}`,
      db.admin`
        UPDATE account_polls SET ceremony_tx_hash = ${randomBytes(32)}, register_tx_hash = ${tx},
          registered_block = 5 WHERE id = ${pollId}`,
      db.admin`
        UPDATE account_polls SET state = 'registered', ceremony_tx_hash = ${randomBytes(32)},
          register_tx_hash = ${tx} WHERE id = ${pollId}`,
      db.admin`
        INSERT INTO poll_creation_txs (creator_address, nonce, tx, tx_hash, sent_at, kind)
        VALUES (${address(0xc0)}, 1, '\\x01', ${randomBytes(32)}, ${NOW}, 'transfer')`,
      db.admin`
        INSERT INTO poll_creation_txs (creator_address, nonce, tx, tx_hash, sent_at)
        VALUES (${address(0xc0)}, 1, '\\x01', ${randomBytes(32)}, ${NOW})`,
    ])
      await expect(sql).rejects.toThrow(/check|null/);
  });

  test("hold a definition-sized transaction, up to 128 KiB", async () => {
    const insert = (bytes: number) => db.admin`
      INSERT INTO poll_creation_txs (creator_address, nonce, tx, tx_hash, sent_at, kind)
      VALUES (${address(0xc0)}, ${bytes}, ${new Uint8Array(bytes)}, ${randomBytes(32)}, ${NOW},
        'register-definition')`;
    await insert(131072);
    await expect(insert(131073)).rejects.toThrow(/check/);
  });

  test("let the app role record a registration but never change one", async () => {
    const chain = new FakeChain();
    await run(chain);
    await expect(app`UPDATE poll_creation_txs SET kind = 'create'`).rejects.toThrow(/permission/);
  });
});
