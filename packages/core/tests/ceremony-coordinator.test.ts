import {
  answersMessage,
  type CeremonyParams,
  type CeremonyTranscript,
  ceremonyKeygen,
  challengesMessage,
  checkCeremonyTranscript,
  decodeCeremonyTranscript,
  decodeElectionDefinitionV5,
  electionStubV5Hash,
  encodeCeremonyTranscript,
  identityKey,
  keySetEntry,
  keySetHash,
  keysMessage,
  type Panel,
  revealsMessage,
  type SeatSecrets,
  signCeremonyRegistration,
  tierTreeRoot,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";
import { getTableConfig } from "drizzle-orm/pg-core";
import { randomBytes } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  approvedCeremony,
  ceremonyApprovals,
  ceremonyMessages,
  ceremonyRuns,
  closeCeremonyRounds,
  coordinatorRequests,
  createPollDraft,
  newAccountId,
  openCeremonyRuns,
  type PollDraft,
  type PollStubDeployment,
  postCeremonyApproval,
  postCeremonyMessage,
  SETUP_SECONDS,
  type StoredTierElectorate,
  stubPolls,
  submitPollDraft,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The coordinator (ADR 0032, rules 5 to 7; P2-22 part 4c): whole ceremonies
// between seats built from crypto's own round functions, as
// apps/trustee-node's seat calls them, through the coordinator's Postgres
// state. Every transcript it ends with is judged by crypto's
// `checkCeremonyTranscript` and every approval by
// `verifyCeremonyRegistration`, never by this module's own record of them.

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const ROUND_SECONDS = 120;
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

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

let db: TestDb;
let app: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin`DELETE FROM ceremony_approvals`;
  await db.admin`DELETE FROM ceremony_messages`;
  await db.admin`DELETE FROM ceremony_runs`;
  await db.admin`DELETE FROM account_polls`;
  await db.admin`DELETE FROM ceremony_stubs`;
});

/** A poll the stub step moved to `ceremony`, as part 4a leaves it; returns its stub's hash. */
async function stubbed(
  deployment: PollStubDeployment = DEPLOYMENT,
  now = NOW,
): Promise<Uint8Array> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const submittedAt = new Date(now.getTime() - 3600_000);
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
  expect((await stubPolls(app, deployment, { now })).stubbed).toBe(1);
  const [row] = await db.admin`SELECT stub_hash FROM account_polls WHERE id = ${id}`;
  return Uint8Array.from(row!["stub_hash"]);
}

const FIELDS = ["keys", "challenges", "answers", "reveals"] as const;
const EMPTY = { keys: [], challenges: [], answers: [], reveals: [] };

/**
 * One honest seat, as apps/trustee-node's runs it but without its store:
 * fresh keys per run, one message per round over the rounds it is shown,
 * and an approval of a transcript that checks with rule 7's quorum.
 */
class Seat {
  readonly index: number;
  readonly #runs = new Map<
    string,
    { secrets: SeatSecrets; mus?: readonly Uint8Array[]; approved?: boolean }
  >();

  constructor(index: number) {
    this.index = index;
  }

  /** Fetches the seat's requests and answers each; returns what each post got. */
  async act(client: Sql = app, now = NOW): Promise<string[]> {
    const outcomes = [];
    for (const r of await coordinatorRequests(client, DEPLOYMENT, this.index)) {
      const stub = decodeElectionDefinitionV5(r.stub);
      const stubHash = electionStubV5Hash(stub);
      const t = decodeCeremonyTranscript(r.transcript, 1);
      const params: CeremonyParams = {
        l2ChainId: stub.l2_chain_id,
        trusteeRegistry: stub.trustee_registry,
        electionId: stub.election_id,
        stubHash,
        panel: PANEL,
        runId: t.run_id,
      };
      const key = Buffer.from(t.run_id).toString("hex");
      let run = this.#runs.get(key);
      if (run === undefined) {
        run = { secrets: ceremonyKeygen(this.index, SECRETS[this.index - 1]!) };
        this.#runs.set(key, run);
      }
      const open = FIELDS.findIndex((f) => t[f].length === 0);
      if (open === -1) {
        const { runId: _, ...election } = params;
        const check = checkCeremonyTranscript(election, r.transcript, 1);
        if (!check.ok) throw new Error("seat: the transcript doesn't check");
        const registration = {
          l2ChainId: params.l2ChainId,
          trusteeRegistry: params.trusteeRegistry,
          index: this.index,
          stubHash,
          ceremonyTranscriptHash: check.hash,
          keySetHash: keySetHash(check.registered.map(keySetEntry)),
        };
        outcomes.push(
          await postCeremonyApproval(
            client,
            DEPLOYMENT,
            this.index,
            {
              stubHash,
              ceremonyTranscriptHash: registration.ceremonyTranscriptHash,
              keySetHash: registration.keySetHash,
              signature: signCeremonyRegistration(SECRETS[this.index - 1]!, PANEL, registration),
            },
            { now },
          ),
        );
        continue;
      }
      const message = this.#message(open, params, run, t);
      const post: CeremonyTranscript = { run_id: t.run_id, ...EMPTY, [FIELDS[open]!]: [message] };
      outcomes.push(
        await postCeremonyMessage(
          client,
          DEPLOYMENT,
          this.index,
          { stubHash, transcript: encodeCeremonyTranscript(post) },
          { now },
        ),
      );
    }
    return outcomes;
  }

  #message(
    open: number,
    params: CeremonyParams,
    run: { secrets: SeatSecrets; mus?: readonly Uint8Array[] },
    t: CeremonyTranscript,
  ) {
    if (open === 0) return keysMessage(params, run.secrets);
    if (open === 1) {
      const c = challengesMessage(params, run.secrets, t.keys);
      run.mus = c.secrets;
      return c.message;
    }
    if (open === 2) return answersMessage(params, run.secrets, t.keys, t.challenges);
    return revealsMessage(params, run.secrets, t, run.mus ?? []);
  }
}

const seats = () => [new Seat(1), new Seat(2), new Seat(3)];

const runRow = async (stubHash: Uint8Array) => {
  const [r] = await db.admin`
    SELECT run_id, round, outcome, qualified, transcript FROM ceremony_runs WHERE stub_hash = ${stubHash}`;
  return r!;
};

const close = (seconds: number) =>
  closeCeremonyRounds(app, DEPLOYMENT, { now: later(seconds), roundSeconds: ROUND_SECONDS });

/** The approved run, judged by crypto alone. */
async function expectApproved(stubHash: Uint8Array, qualified: number[]) {
  const approved = await approvedCeremony(app, stubHash);
  expect(approved).toBeDefined();
  const { transcript, transcriptHash, keySetHash: setHash, approvals } = approved!;
  const [stub] =
    await db.admin`SELECT election_id FROM ceremony_stubs WHERE stub_hash = ${stubHash}`;
  const check = checkCeremonyTranscript(
    {
      l2ChainId: DEPLOYMENT.l2ChainId,
      trusteeRegistry: DEPLOYMENT.trusteeRegistry,
      electionId: Uint8Array.from(stub!["election_id"]),
      stubHash,
      panel: PANEL,
    },
    transcript,
    1,
  );
  expect(check.ok).toBe(true);
  if (!check.ok) return;
  expect(check.registered.map((k) => k.index)).toEqual(qualified);
  expect(check.seats.filter((s) => s.reasons.length === 0).map((s) => s.index)).toEqual(qualified);
  expect(transcriptHash).toEqual(check.hash);
  expect(setHash).toEqual(keySetHash(check.registered.map(keySetEntry)));
  expect(approvals.length).toBeGreaterThanOrEqual(Math.max(PANEL.threshold, PANEL.keys.length - 1));
  for (const a of approvals)
    expect(
      verifyCeremonyRegistration(
        PANEL,
        {
          l2ChainId: DEPLOYMENT.l2ChainId,
          trusteeRegistry: DEPLOYMENT.trusteeRegistry,
          index: a.seat,
          stubHash,
          ceremonyTranscriptHash: check.hash,
          keySetHash: setHash,
        },
        a.signature,
      ),
    ).toBe(true);
}

describe("a whole ceremony", () => {
  test("relays every round between the seats and ends approved by all three", async () => {
    const stubHash = await stubbed();
    expect(await openCeremonyRuns(app, DEPLOYMENT, { now: NOW })).toEqual({
      opened: 1,
      mismatched: 0,
      expired: 0,
    });
    const panel = seats();
    // Each round closes once the third seat sends, with no deadline needed.
    for (let round = 1; round <= 5; round++) {
      for (const s of panel) expect(await s.act()).toEqual(["accepted"]);
      expect((await runRow(stubHash))["round"]).toBe(round + 1);
    }
    expect(await runRow(stubHash)).toMatchObject({ outcome: "approved", qualified: [1, 2, 3] });
    await expectApproved(stubHash, [1, 2, 3]);
    // A closed run asks nothing more; the poll is left for registration.
    for (const s of panel) expect(await s.act()).toEqual([]);
    const [poll] = await db.admin`SELECT state FROM account_polls`;
    expect(poll!["state"]).toBe("ceremony");
  }, 120_000);

  test("closes rounds at their deadline without a withheld seat, and approves with rule 7's n − 1", async () => {
    const stubHash = await stubbed();
    await openCeremonyRuns(app, DEPLOYMENT, { now: NOW });
    const [one, two] = seats();
    let at = 0;
    for (let round = 1; round <= 4; round++) {
      expect(await one!.act()).toEqual(["accepted"]);
      expect(await two!.act()).toEqual(["accepted"]);
      // Not yet due: the round stays open for seat 3.
      expect(await close(at + ROUND_SECONDS - 1)).toEqual({ closed: 0, ended: {} });
      at += ROUND_SECONDS;
      expect(await close(at)).toEqual({ closed: 1, ended: {} });
    }
    expect(await runRow(stubHash)).toMatchObject({ round: 5, qualified: [1, 2] });
    // Seat 3 didn't qualify, so it isn't asked to approve; both qualified
    // seats' approvals end the run at once.
    expect(await new Seat(3).act()).toEqual([]);
    expect(await one!.act()).toEqual(["accepted"]);
    expect(await two!.act()).toEqual(["accepted"]);
    expect((await runRow(stubHash))["outcome"]).toBe("approved");
    await expectApproved(stubHash, [1, 2]);
  }, 120_000);

  test("ends a run whose round closes below rule 7's quorum", async () => {
    const stubHash = await stubbed();
    await openCeremonyRuns(app, DEPLOYMENT, { now: NOW });
    expect(await new Seat(1).act()).toEqual(["accepted"]);
    expect(await close(ROUND_SECONDS)).toEqual({ closed: 1, ended: { "too-few-messages": 1 } });
    expect(await runRow(stubHash)).toMatchObject({ round: 6, outcome: "too-few-messages" });
    expect(await approvedCeremony(app, stubHash)).toBeUndefined();
    for (const s of seats()) expect(await s.act()).toEqual([]);
  }, 60_000);

  test("ends approvals at their deadline by count", async () => {
    const quorumMet = await stubbed();
    await openCeremonyRuns(app, DEPLOYMENT, { now: NOW });
    const panel = seats();
    for (let round = 1; round <= 4; round++) for (const s of panel) await s.act();
    await panel[0]!.act();
    await panel[1]!.act();
    // Two of three qualified seats approved: rule 7's quorum, once the deadline passes.
    expect((await runRow(quorumMet))["round"]).toBe(5);
    expect(await close(ROUND_SECONDS)).toEqual({ closed: 0, ended: { approved: 1 } });
    await expectApproved(quorumMet, [1, 2, 3]);

    await db.admin`DELETE FROM ceremony_approvals`;
    await db.admin`DELETE FROM ceremony_messages`;
    await db.admin`DELETE FROM ceremony_runs`;
    await db.admin`DELETE FROM account_polls`;
    const short = await stubbed();
    await openCeremonyRuns(app, DEPLOYMENT, { now: NOW });
    const again = seats();
    for (let round = 1; round <= 4; round++) for (const s of again) await s.act();
    await again[0]!.act();
    expect(await close(ROUND_SECONDS)).toEqual({ closed: 0, ended: { "too-few-approvals": 1 } });
    expect(await approvedCeremony(app, short)).toBeUndefined();
  }, 120_000);
});

describe("openCeremonyRuns", () => {
  test("opens one run per stub, with a fresh run id and an empty transcript, however often it runs", async () => {
    const a = await stubbed();
    const b = await stubbed();
    const other = await db.as("abolish_app");
    const reports = await Promise.all([
      openCeremonyRuns(app, DEPLOYMENT, { now: NOW }),
      openCeremonyRuns(other, DEPLOYMENT, { now: NOW }),
    ]);
    expect(reports.reduce((n, r) => n + r.opened, 0)).toBe(2);
    expect(await openCeremonyRuns(app, DEPLOYMENT, { now: NOW })).toEqual({
      opened: 0,
      mismatched: 0,
      expired: 0,
    });
    const ra = await runRow(a);
    const rb = await runRow(b);
    expect(Buffer.from(ra["run_id"]).equals(Buffer.from(rb["run_id"]))).toBe(false);
    for (const r of [ra, rb]) {
      expect(r["round"]).toBe(1);
      expect(decodeCeremonyTranscript(r["transcript"], 1)).toEqual({
        run_id: Uint8Array.from(r["run_id"]),
        ...EMPTY,
      });
    }
  });

  test("leaves a stub of another panel, chain or trustee registry, and one past its opening", async () => {
    await stubbed({ ...DEPLOYMENT, panel: { ...PANEL, threshold: 3 } });
    await stubbed({ ...DEPLOYMENT, l2ChainId: 8453n });
    await stubbed({ ...DEPLOYMENT, trusteeRegistry: address(0xa9) });
    expect(await openCeremonyRuns(app, DEPLOYMENT, { now: NOW })).toEqual({
      opened: 0,
      mismatched: 3,
      expired: 0,
    });
    await db.admin`DELETE FROM account_polls`;
    await stubbed();
    expect(await openCeremonyRuns(app, DEPLOYMENT, { now: later(SETUP_SECONDS) })).toEqual({
      opened: 0,
      mismatched: 0,
      expired: 1,
    });
  });

  test("opens no run for a poll that has left `ceremony`", async () => {
    await stubbed();
    await db.admin`UPDATE account_polls SET state = 'failed', failure = 'stub-refused'`;
    expect((await openCeremonyRuns(app, DEPLOYMENT, { now: NOW })).opened).toBe(0);
  });
});

describe("posts", () => {
  /** A run with round 1 open, and seat 1's honest round-1 post for it. */
  async function opened() {
    const stubHash = await stubbed();
    await openCeremonyRuns(app, DEPLOYMENT, { now: NOW });
    const [r] = await coordinatorRequests(app, DEPLOYMENT, 1);
    const stub = decodeElectionDefinitionV5(r!.stub);
    const t = decodeCeremonyTranscript(r!.transcript, 1);
    const params: CeremonyParams = {
      l2ChainId: stub.l2_chain_id,
      trusteeRegistry: stub.trustee_registry,
      electionId: stub.election_id,
      stubHash,
      panel: PANEL,
      runId: t.run_id,
    };
    const keys = (seat: number) => keysMessage(params, ceremonyKeygen(seat, SECRETS[seat - 1]!));
    const body = (m: ReturnType<typeof keysMessage>, runId = t.run_id) =>
      encodeCeremonyTranscript({ run_id: runId, ...EMPTY, keys: [m] });
    return { stubHash, t, keys, body };
  }

  const post = (seat: number, stubHash: Uint8Array, transcript: Uint8Array, client = app) =>
    postCeremonyMessage(client, DEPLOYMENT, seat, { stubHash, transcript }, { now: NOW });

  test("keeps only a message its seat signed, for the open round of this run", async () => {
    const { stubHash, keys, body } = await opened();
    const m = keys(1);
    expect(await post(1, randomBytes(32), body(m))).toBe("not-open");
    expect(await post(1, stubHash, Uint8Array.of(0, 5, 1, 0))).toBe("malformed");
    expect(await post(1, stubHash, Uint8Array.of(0, 5, 2))).toBe("malformed");
    // Seat 1's message, posted for seat 2; claimed as seat 2's; for another run.
    expect(await post(2, stubHash, body(m))).toBe("refused");
    expect(await post(2, stubHash, body({ ...m, index: 2 }))).toBe("refused");
    expect(await post(1, stubHash, body(m, new Uint8Array(32)))).toBe("refused");
    const forged = Uint8Array.from(m.signature);
    forged[40] = forged[40]! ^ 1;
    expect(await post(1, stubHash, body({ ...m, signature: forged }))).toBe("refused");
    // Seats outside the panel, and a round-2 message while round 1 is open.
    expect(await post(0, stubHash, body(m))).toBe("refused");
    expect(await post(4, stubHash, body(m))).toBe("refused");
    expect(await db.admin`SELECT 1 FROM ceremony_messages`).toHaveLength(0);
    expect(await post(1, stubHash, body(m))).toBe("accepted");
  });

  test("keeps a seat's first message per round and refuses its second, even raced", async () => {
    const { stubHash, keys, body } = await opened();
    const other = await db.as("abolish_app");
    // Two honest messages of seat 2 (fresh keys each): equivocation.
    const outcomes = await Promise.all([
      post(2, stubHash, body(keys(2))),
      post(2, stubHash, body(keys(2)), other),
    ]);
    expect(outcomes.sort()).toEqual(["accepted", "already-sent"]);
    expect(await db.admin`SELECT seat FROM ceremony_messages`).toEqual([{ seat: 2 }]);
    expect(await coordinatorRequests(app, DEPLOYMENT, 2)).toEqual([]);
    expect(await coordinatorRequests(app, DEPLOYMENT, 1)).toHaveLength(1);
  });

  test("asks nothing of a seat outside the panel", async () => {
    await opened();
    for (const seat of [0, 4, 1.5, -1, Number.NaN])
      expect(await coordinatorRequests(app, DEPLOYMENT, seat)).toEqual([]);
  });

  test("refuses an approval before the transcript checks, from an unqualified seat, or not over the run's hashes", async () => {
    const stubHash = await stubbed();
    await openCeremonyRuns(app, DEPLOYMENT, { now: NOW });
    const [one, two] = seats();
    const [row] = await db.admin`SELECT election_id FROM ceremony_stubs`;
    const registration = (index: number, transcriptHash: Uint8Array, setHash: Uint8Array) => ({
      l2ChainId: DEPLOYMENT.l2ChainId,
      trusteeRegistry: DEPLOYMENT.trusteeRegistry,
      index,
      stubHash,
      ceremonyTranscriptHash: transcriptHash,
      keySetHash: setHash,
    });
    const approve = (
      index: number,
      signer: number,
      transcriptHash: Uint8Array,
      setHash: Uint8Array,
    ) =>
      postCeremonyApproval(
        app,
        DEPLOYMENT,
        index,
        {
          stubHash,
          ceremonyTranscriptHash: transcriptHash,
          keySetHash: setHash,
          signature: signCeremonyRegistration(
            SECRETS[signer - 1]!,
            PANEL,
            registration(signer, transcriptHash, setHash),
          ),
        },
        { now: NOW },
      );
    expect(await approve(1, 1, new Uint8Array(32), new Uint8Array(32))).toBe("not-open");
    for (let round = 1; round <= 4; round++) {
      await one!.act();
      await two!.act();
      await close(ROUND_SECONDS * round);
    }
    const { transcript } = await runRow(stubHash);
    const check = checkCeremonyTranscript(
      {
        l2ChainId: DEPLOYMENT.l2ChainId,
        trusteeRegistry: DEPLOYMENT.trusteeRegistry,
        electionId: Uint8Array.from(row!["election_id"]),
        stubHash,
        panel: PANEL,
      },
      transcript,
      1,
    );
    if (!check.ok) throw new Error("expected a checked transcript");
    const setHash = keySetHash(check.registered.map(keySetEntry));
    // Seat 3 didn't qualify, though its signature verifies.
    expect(await approve(3, 3, check.hash, setHash)).toBe("refused");
    // Another transcript or key set; seat 2's signature posted as seat 1's.
    expect(await approve(1, 1, new Uint8Array(32).fill(1), setHash)).toBe("refused");
    expect(await approve(1, 1, check.hash, new Uint8Array(32).fill(1))).toBe("refused");
    expect(await approve(1, 2, check.hash, setHash)).toBe("refused");
    expect(await db.admin`SELECT 1 FROM ceremony_approvals`).toHaveLength(0);
    expect(await approve(1, 1, check.hash, setHash)).toBe("accepted");
    expect(await approve(1, 1, check.hash, setHash)).toBe("already-sent");
    expect(await approve(2, 2, check.hash, setHash)).toBe("accepted");
    expect(await approve(2, 2, check.hash, setHash)).toBe("not-open");
  }, 120_000);
});

describe("the coordinator's tables", () => {
  test("agree with the migration", async () => {
    for (const table of [ceremonyRuns, ceremonyMessages, ceremonyApprovals]) {
      const config = getTableConfig(table);
      const cols = await db.admin`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = ${db.schema} AND table_name = ${config.name} ORDER BY ordinal_position`;
      expect(cols.map((c) => [c["column_name"], c["data_type"], c["is_nullable"]])).toEqual(
        config.columns.map((c) => [
          c.name,
          c.getSQLType().endsWith("[]") ? "ARRAY" : c.getSQLType(),
          c.notNull ? "NO" : "YES",
        ]),
      );
    }
  });

  test("keep what seats sent append-only, and a run's checked fields together", async () => {
    const stubHash = await stubbed();
    await openCeremonyRuns(app, DEPLOYMENT, { now: NOW });
    await new Seat(1).act();
    await expect(app`UPDATE ceremony_messages SET seat = 2`).rejects.toThrow(/permission/);
    await expect(app`DELETE FROM ceremony_messages`).rejects.toThrow(/permission/);
    await expect(app`DELETE FROM ceremony_runs`).rejects.toThrow(/permission/);
    await expect(app`UPDATE ceremony_approvals SET seat = 2`).rejects.toThrow(/permission/);
    const set = (values: string) =>
      app.unsafe(`UPDATE ceremony_runs SET ${values}`).then(
        () => "ok",
        (e: Error) => e.message,
      );
    // Approvals open only with a checked transcript; a closed run has an outcome.
    expect(await set("round = 5")).toMatch(/check/);
    expect(await set("round = 6")).toMatch(/check/);
    expect(await set("outcome = 'approved', round = 6")).toMatch(/check/);
    expect(await set("transcript_hash = '\\x00'")).toMatch(/check/);
    expect(await set("transcript = '\\x000502'")).toMatch(/check/);
    expect(await set("outcome = 'too-few-messages', round = 6")).toBe("ok");
    expect((await runRow(stubHash))["outcome"]).toBe("too-few-messages");
    await expect(
      app`INSERT INTO ceremony_runs (run_id, stub_hash, round, round_opened_at, transcript, created_at)
        VALUES (${randomBytes(32)}, ${stubHash}, 1, now(), ${encodeCeremonyTranscript({ run_id: new Uint8Array(32), ...EMPTY })}, now())`,
    ).rejects.toThrow(/unique|duplicate/);
  });
});
