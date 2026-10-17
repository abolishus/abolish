import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  advancePollCreations,
  type CreationStatus,
  createPollDraft,
  creationKeyRecords,
  KEY_POLLS_LISTED,
  newAccountId,
  type PollCreationChain,
  type SignedCreation,
  submitPollDraft,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The creation key's records as the worker's status command reads them
// (the poll-creation runbook, Rotation and Compromise; P2-22 part 3b-3):
// the polls the key still has to finish, and its ledger against the node's
// nonce counts, where an included nonce with no row is a transaction the
// worker never sent (T-72).

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const HOUR = 3600_000;

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

/** A key whose sends are included at once, in nonce order, and final when told. */
class InstantChain implements PollCreationChain {
  readonly creator: Uint8Array;
  readonly mined: string[] = [];
  finalized = 0;

  constructor(fill: number) {
    this.creator = new Uint8Array(20).fill(fill);
  }

  async nonces() {
    const latest = BigInt(this.mined.length);
    return { finalized: BigInt(this.finalized), latest, pending: latest };
  }

  async signCreation(nonce: bigint): Promise<SignedCreation> {
    const tx = new TextEncoder().encode(`create:${this.creator[0]}:${nonce}`);
    return { tx, hash: sha256(tx) };
  }

  async broadcast(tx: Uint8Array): Promise<void> {
    const hash = Buffer.from(sha256(tx)).toString("hex");
    if (!this.mined.includes(hash)) this.mined.push(hash);
  }

  async creation(hash: Uint8Array): Promise<CreationStatus> {
    const i = this.mined.indexOf(Buffer.from(hash).toString("hex"));
    if (i < 0) return { state: "unknown" };
    if (i >= this.finalized) return { state: "included" };
    return {
      state: "created",
      electionId: sha256(hash),
      block: BigInt(i + 1),
      l1OriginTimestamp: 1_000n,
    };
  }

  /** A transaction of the key that the worker didn't send. */
  stranger() {
    this.mined.push(`stranger:${this.mined.length}`);
  }
}

let db: TestDb;
let app: Sql;

beforeAll(async () => {
  db = await testDb();
  app = await db.as("abolish_app");
});
afterAll(() => db?.close());
beforeEach(async () => {
  await db.admin`DELETE FROM account_polls`;
  await db.admin`DELETE FROM poll_creation_txs`;
});

async function submitted(n: number, at = NOW): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const author = newAccountId();
    await app`
      INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
        false, '', NULL, now(), now())`;
    const id = await createPollDraft(
      app,
      author,
      {
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
      },
      at,
    );
    await submitPollDraft(app, author, id, {
      turnstile: { verify: async () => "passed" },
      token: "t",
      now: new Date(at.getTime() + i * 1000),
    });
    ids.push(id);
  }
  return ids;
}

const records = async (chain: InstantChain, now = NOW) =>
  creationKeyRecords(app, chain.creator, await chain.nonces(), now);

describe("creationKeyRecords", () => {
  test("lists the key's polls in setup, oldest first, with their ledger counts", async () => {
    const chain = new InstantChain(0xc1);
    const ids = await submitted(3);
    expect(await records(chain)).toEqual({
      polls: [],
      pollCount: 0,
      recorded: 0,
      unincluded: 0,
      unfinalized: 0,
      lastDay: 0,
      unrecorded: 0n,
    });
    await advancePollCreations(app, chain, { now: NOW });
    // Sent and included, none final: each still needs the key.
    expect(await records(chain)).toEqual({
      polls: ids.map((id) => ({ id, state: "submitted", electionId: null })),
      pollCount: 3,
      recorded: 3,
      unincluded: 0,
      unfinalized: 3,
      lastDay: 3,
      unrecorded: 0n,
    });
    chain.finalized = 2;
    await advancePollCreations(app, chain, { now: NOW });
    const r = await records(chain);
    expect(r.polls.map((p) => p.state)).toEqual(["created", "created", "submitted"]);
    expect(r.polls[0]!.electionId).toHaveLength(32);
    expect(r).toMatchObject({ pollCount: 3, unfinalized: 1, unrecorded: 0n });
  });

  test("counts recorded creations the node hasn't included", async () => {
    const chain = new InstantChain(0xc2);
    await submitted(2);
    await advancePollCreations(app, chain, { now: NOW });
    // The node lost both: still recorded, still to be sent.
    chain.mined.length = 0;
    expect(await records(chain)).toMatchObject({ recorded: 2, unincluded: 2, unrecorded: 0n });
  });

  test("finds included nonces with no ledger row, the runbook's sign of compromise", async () => {
    const chain = new InstantChain(0xc3);
    chain.stranger();
    await submitted(1);
    await advancePollCreations(app, chain, { now: NOW });
    chain.stranger();
    expect(await records(chain)).toMatchObject({ recorded: 1, unrecorded: 2n });
  });

  test("leaves out other keys' polls and rows, and polls past registration or failed", async () => {
    const mine = new InstantChain(0xc4);
    const other = new InstantChain(0xc5);
    const [a, b] = await submitted(2);
    await advancePollCreations(app, other, { now: NOW });
    expect(await records(mine)).toMatchObject({ polls: [], pollCount: 0, recorded: 0 });
    await db.admin`UPDATE account_polls SET state = 'failed', failure = 'creation-timeout'
      WHERE id = ${a!}`;
    expect((await records(other)).polls.map((p) => p.id)).toEqual([b]);
  });

  test("counts the last day as the daily ceiling does", async () => {
    const chain = new InstantChain(0xc6);
    await submitted(1);
    await advancePollCreations(app, chain, { now: NOW });
    expect(await records(chain, new Date(NOW.getTime() + 24 * HOUR - 1))).toMatchObject({
      lastDay: 1,
    });
    expect(await records(chain, new Date(NOW.getTime() + 24 * HOUR + 1))).toMatchObject({
      lastDay: 0,
    });
  });

  test("lists at most KEY_POLLS_LISTED polls and counts the rest", async () => {
    const chain = new InstantChain(0xc7);
    await submitted(KEY_POLLS_LISTED + 1);
    // One run signs at most CREATIONS_PER_RUN.
    for (let i = 0; i < 6; i++) await advancePollCreations(app, chain, { now: NOW });
    const r = await records(chain);
    expect(r.polls).toHaveLength(KEY_POLLS_LISTED);
    expect(r.pollCount).toBe(KEY_POLLS_LISTED + 1);
  }, 60_000);

  test("refuses a creator that isn't an address and nonce counts out of order", async () => {
    await expect(
      creationKeyRecords(app, new Uint8Array(19), { finalized: 0n, latest: 0n }, NOW),
    ).rejects.toThrow(RangeError);
    await expect(
      creationKeyRecords(app, new Uint8Array(20), { finalized: 2n, latest: 1n }, NOW),
    ).rejects.toThrow(RangeError);
  });
});
