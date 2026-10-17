import { createHash, randomBytes } from "node:crypto";
import fc from "fast-check";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  ANCHOR_CHECK_DELAY,
  anchorCheckSegments,
  checkCreationAnchors,
  createPollDraft,
  type CreationAnchors,
  type L1Block,
  MAX_ABANDONED_IDS,
  newAccountId,
  type PollDraft,
  submitPollDraft,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The creator's per-slot check of a created poll's identifier
// (docs/spec/contracts.md, Board anchor, Verification, Pre-creation anchors;
// P2-22 part 3b-1): an identifier is checked only at a finalized L1 block
// later than its origin by more than the drift, over exactly the segments
// from `f` to the last period ended; one with an anchor there is abandoned
// and the poll created again, and the third such fails the poll (T-69).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const CLOCK = { epoch: 1_700_000_000n, period: 3600n };
/** When the creation step saw a test's poll created: before every block the tests prove at. */
const SEEN = new Date(Number(CLOCK.epoch) * 1000);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const draft = (): PollDraft => ({
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
});

/** The anchor's words on an L1 that finalizes when told, recording every segment read. */
class FakeAnchors implements CreationAnchors {
  readonly clock = CLOCK;
  block: L1Block = { number: 100n, hash: new Uint8Array(32).fill(1), timestamp: 0n };
  /** Set words, by `electionId:segment`. */
  readonly set = new Map<string, Uint8Array>();
  readonly reads: { election: string; segments: readonly number[]; at: bigint }[] = [];
  /** Replaces the answer of the next `words` call. */
  answer: ((w: Uint8Array[]) => Uint8Array[]) | undefined;

  at(timestamp: bigint) {
    this.block = {
      number: this.block.number + 1n,
      hash: createHash("sha256").update(String(timestamp)).digest(),
      timestamp,
    };
  }

  async finalized() {
    return this.block;
  }

  async words(block: L1Block, electionId: Uint8Array, segments: readonly number[]) {
    expect(block).toBe(this.block);
    this.reads.push({ election: hex(electionId), segments, at: block.number });
    const out = segments.map((s) => this.set.get(`${hex(electionId)}:${s}`) ?? new Uint8Array(32));
    const answer = this.answer;
    this.answer = undefined;
    return answer === undefined ? out : answer(out);
  }

  anchor(electionId: string, segment: number) {
    this.set.set(`${electionId}:${segment}`, new Uint8Array(32).fill(0xaa));
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
});

/** A submitted poll moved to `created` as the creation step moves it, its origin at `origin`. */
async function created(origin: bigint): Promise<{ id: string; election: string }> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const id = await createPollDraft(app, author, draft(), NOW);
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: NOW,
  });
  const election = randomBytes(32);
  await db.admin`
    UPDATE account_polls SET state = 'created', creator_address = ${new Uint8Array(20).fill(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${election}, created_block = 7,
      l1_origin_timestamp = ${origin.toString()}, updated_at = ${SEEN}
    WHERE id = ${id}`;
  return { id, election: hex(election) };
}

const row = async (id: string) => {
  const [r] = await db.admin`
    SELECT state, failure, anchors_checked_block, abandoned_ids,
      encode(election_id, 'hex') AS election, creator_address, create_tx_hash, created_block,
      l1_origin_timestamp
    FROM account_polls WHERE id = ${id}`;
  return r!;
};

const run = (anchors: FakeAnchors) => checkCreationAnchors(app, anchors, { now: NOW });

/** An origin `k` periods and `into` seconds after the epoch. */
const originAt = (k: bigint, into = 600n) => CLOCK.epoch + k * CLOCK.period + into;

describe("anchorCheckSegments", () => {
  test("reads from the origin's period to the last ended, and nothing until the drift has passed", () => {
    const origin = originAt(10n);
    expect(anchorCheckSegments(CLOCK, origin, origin + ANCHOR_CHECK_DELAY)).toBeUndefined();
    // Period 10 ends 3,000 seconds after the origin, after the drift of 1,800.
    expect(anchorCheckSegments(CLOCK, origin, origin + ANCHOR_CHECK_DELAY + 1n)).toEqual([]);
    expect(anchorCheckSegments(CLOCK, origin, CLOCK.epoch + 11n * CLOCK.period)).toEqual([10]);
    expect(anchorCheckSegments(CLOCK, origin, CLOCK.epoch + 13n * CLOCK.period - 1n)).toEqual([
      10, 11,
    ]);
    // An origin before the epoch is in segment 0's past: everything from 0.
    expect(
      anchorCheckSegments(CLOCK, CLOCK.epoch - 5000n, CLOCK.epoch + 2n * CLOCK.period),
    ).toEqual([0, 1]);
    expect(() => anchorCheckSegments(CLOCK, CLOCK.epoch, CLOCK.epoch + 20_000n * 3600n)).toThrow(
      RangeError,
    );
  });

  test("is exactly the segments from `f` whose periods ended by the block's time", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2_000_000_000n }),
        fc.bigInt({ min: 1n, max: 7200n }),
        fc.bigInt({ min: 0n, max: 2_100_000_000n }),
        fc.bigInt({ min: 0n, max: 200_000n }),
        (epoch, period, origin, after) => {
          const clock = { epoch, period };
          const at = origin + after;
          let segments: number[] | undefined;
          try {
            segments = anchorCheckSegments(clock, origin, at);
          } catch (e) {
            expect(e).toBeInstanceOf(RangeError);
            return;
          }
          if (at <= origin + ANCHOR_CHECK_DELAY) {
            expect(segments).toBeUndefined();
            return;
          }
          const f = origin < epoch ? 0n : (origin - epoch) / period;
          const ended = (s: bigint) => epoch + (s + 1n) * period <= at;
          const want: number[] = [];
          for (let s = f; ended(s); s++) want.push(Number(s));
          expect(segments).toEqual(want);
          // `f` holds the origin, or the origin is before every segment.
          if (origin >= epoch) {
            expect(epoch + f * period <= origin).toBe(true);
            expect(origin < epoch + (f + 1n) * period).toBe(true);
          }
        },
      ),
      { numRuns },
    );
  });
});

describe("checkCreationAnchors", () => {
  test("marks an identifier checked at a late enough block once every word in range is zero", async () => {
    const anchors = new FakeAnchors();
    const origin = originAt(10n);
    const { id, election } = await created(origin);
    anchors.at(origin + ANCHOR_CHECK_DELAY);
    expect(await run(anchors)).toEqual({
      checked: 0,
      waiting: 1,
      abandoned: 0,
      overdue: 0,
      failed: 0,
    });
    expect(anchors.reads).toEqual([]);
    expect((await row(id))["anchors_checked_block"]).toBeNull();

    anchors.at(CLOCK.epoch + 13n * CLOCK.period);
    // An anchor before `f`, and one in a period not yet ended, don't count.
    anchors.anchor(election, 9);
    anchors.anchor(election, 13);
    expect(await run(anchors)).toEqual({
      checked: 1,
      waiting: 0,
      abandoned: 0,
      overdue: 0,
      failed: 0,
    });
    expect(anchors.reads).toEqual([{ election, segments: [10, 11, 12], at: anchors.block.number }]);
    expect(await row(id)).toMatchObject({
      state: "created",
      anchors_checked_block: String(anchors.block.number),
      abandoned_ids: 0,
      election,
    });
    // Checked once: a later run reads nothing.
    expect(await run(anchors)).toEqual({
      checked: 0,
      waiting: 0,
      abandoned: 0,
      overdue: 0,
      failed: 0,
    });
    expect(anchors.reads).toHaveLength(1);
  });

  test("passes an identifier with no period ended since its origin without reading", async () => {
    const anchors = new FakeAnchors();
    const origin = originAt(10n);
    const { id } = await created(origin);
    anchors.at(origin + ANCHOR_CHECK_DELAY + 1n);
    expect(await run(anchors)).toMatchObject({ checked: 1 });
    expect(anchors.reads).toEqual([]);
    expect((await row(id))["anchors_checked_block"]).toBe(String(anchors.block.number));
  });

  test("abandons an identifier anchored ahead of its check, and the poll goes back to be created again", async () => {
    const anchors = new FakeAnchors();
    const origin = originAt(10n);
    const { id, election } = await created(origin);
    anchors.at(CLOCK.epoch + 12n * CLOCK.period);
    anchors.anchor(election, 10);
    expect(await run(anchors)).toEqual({
      checked: 0,
      waiting: 0,
      abandoned: 1,
      overdue: 0,
      failed: 0,
    });
    expect(await row(id)).toMatchObject({
      state: "submitted",
      failure: null,
      anchors_checked_block: null,
      abandoned_ids: 1,
      election: null,
      creator_address: null,
      create_tx_hash: null,
      created_block: null,
      l1_origin_timestamp: null,
    });
    // Nothing to check now; the creation step owns it again.
    expect(await run(anchors)).toEqual({
      checked: 0,
      waiting: 0,
      abandoned: 0,
      overdue: 0,
      failed: 0,
    });
  });

  test(`fails a poll on its ${MAX_ABANDONED_IDS}rd anchored identifier, keeping the identifier`, async () => {
    const anchors = new FakeAnchors();
    const origin = originAt(10n);
    const { id } = await created(origin);
    anchors.at(CLOCK.epoch + 12n * CLOCK.period);
    for (let i = 1; i <= MAX_ABANDONED_IDS; i++) {
      const election = randomBytes(32);
      await db.admin`
        UPDATE account_polls SET state = 'created', creator_address = ${new Uint8Array(20).fill(0xc0)},
          create_tx_hash = ${randomBytes(32)}, election_id = ${election}, created_block = 7,
          l1_origin_timestamp = ${origin.toString()}, updated_at = ${SEEN}
        WHERE id = ${id}`;
      anchors.anchor(hex(election), 11);
      const report = await run(anchors);
      if (i < MAX_ABANDONED_IDS) {
        expect(report).toMatchObject({ abandoned: 1, failed: 0 });
        expect(await row(id)).toMatchObject({ state: "submitted", abandoned_ids: i });
      } else {
        expect(report).toMatchObject({ abandoned: 0, failed: 1 });
        expect(await row(id)).toMatchObject({
          state: "failed",
          failure: "creation-anchored",
          abandoned_ids: MAX_ABANDONED_IDS,
          election: hex(election),
          anchors_checked_block: null,
        });
      }
    }
  });

  test("judges every poll of a run at one block, each over its own range", async () => {
    const anchors = new FakeAnchors();
    const a = await created(originAt(10n));
    const b = await created(originAt(11n, 3000n));
    anchors.at(CLOCK.epoch + 13n * CLOCK.period);
    anchors.anchor(b.election, 12);
    expect(await run(anchors)).toEqual({
      checked: 1,
      waiting: 0,
      abandoned: 1,
      overdue: 0,
      failed: 0,
    });
    // In whichever order the run took them.
    const reads = new Map(anchors.reads.map((r) => [r.election, r.segments]));
    expect(reads).toEqual(
      new Map([
        [a.election, [10, 11, 12]],
        [b.election, [11, 12]],
      ]),
    );
    expect(new Set(anchors.reads.map((r) => r.at)).size).toBe(1);
  });

  test("moves nothing on a reader's malformed answer", async () => {
    const anchors = new FakeAnchors();
    const { id } = await created(originAt(10n));
    anchors.at(CLOCK.epoch + 13n * CLOCK.period);
    anchors.answer = (w) => w.slice(1);
    await expect(run(anchors)).rejects.toThrow("the wrong words");
    anchors.answer = (w) => w.map(() => new Uint8Array(31));
    await expect(run(anchors)).rejects.toThrow("the wrong words");
    expect(await row(id)).toMatchObject({ state: "created", anchors_checked_block: null });
  });

  test("leaves a poll whose identifier changed while it was read", async () => {
    const anchors = new FakeAnchors();
    const origin = originAt(10n);
    const { id, election } = await created(origin);
    anchors.at(CLOCK.epoch + 13n * CLOCK.period);
    // Between this run's read and its write, another run abandoned the
    // identifier and the creation step created the poll again, under an
    // identifier this run never read.
    const fresh = randomBytes(32);
    const words = anchors.words.bind(anchors);
    anchors.words = async (...args) => {
      const out = await words(...args);
      await db.admin`UPDATE account_polls SET election_id = ${fresh}, abandoned_ids = 1 WHERE id = ${id}`;
      return out;
    };
    expect(await run(anchors)).toMatchObject({ checked: 0, abandoned: 0, failed: 0 });
    expect(await row(id)).toMatchObject({
      state: "created",
      anchors_checked_block: null,
      election: hex(fresh),
    });
    // The same holds when the old identifier's words would abandon or fail it.
    anchors.words = words;
    await db.admin`UPDATE account_polls SET election_id = ${Buffer.from(election, "hex")} WHERE id = ${id}`;
    anchors.anchor(election, 11);
    anchors.words = async (...args) => {
      const out = await words(...args);
      await db.admin`UPDATE account_polls SET election_id = ${fresh} WHERE id = ${id}`;
      return out;
    };
    expect(await run(anchors)).toMatchObject({ checked: 0, abandoned: 0, failed: 0 });
    expect(await row(id)).toMatchObject({ state: "created", election: hex(fresh) });
  });

  test("waits for a block no earlier than when the poll was seen created", async () => {
    const anchors = new FakeAnchors();
    const origin = originAt(10n);
    const { id } = await created(origin);
    const seen = CLOCK.epoch + 20n * CLOCK.period;
    await db.admin`UPDATE account_polls SET updated_at = ${new Date(Number(seen) * 1000)} WHERE id = ${id}`;
    anchors.at(seen - 1n);
    expect(await run(anchors)).toMatchObject({ checked: 0, waiting: 1 });
    expect(anchors.reads).toEqual([]);
    anchors.at(seen);
    expect(await run(anchors)).toMatchObject({ checked: 1, waiting: 0 });
    expect(anchors.reads[0]!.segments).toEqual(Array.from({ length: 10 }, (_, i) => 10 + i));
  });

  test("abandons an identifier too long unchecked to read, uncounted, and goes on to the next", async () => {
    const anchors = new FakeAnchors();
    const old = await created(originAt(0n));
    const next = await created(originAt(20_000n));
    anchors.at(CLOCK.epoch + 20_002n * CLOCK.period);
    expect(await run(anchors)).toEqual({
      checked: 1,
      waiting: 0,
      abandoned: 1,
      overdue: 1,
      failed: 0,
    });
    expect(await row(old.id)).toMatchObject({ state: "submitted", abandoned_ids: 0 });
    expect(await row(next.id)).toMatchObject({ state: "created" });
    expect(anchors.reads.map((r) => r.election)).toEqual([next.election]);
  });
});

describe("the table", () => {
  test("refuses a state past `created` unchecked, a check without an identifier, and an identifier without its origin", async () => {
    const { id } = await created(originAt(10n));
    for (const state of ["rooted", "ceremony", "registered", "open"])
      await expect(app`UPDATE account_polls SET state = ${state} WHERE id = ${id}`).rejects.toThrow(
        /check/,
      );
    await expect(
      app`UPDATE account_polls SET l1_origin_timestamp = NULL WHERE id = ${id}`,
    ).rejects.toThrow(/check/);
    await app`UPDATE account_polls SET anchors_checked_block = 5 WHERE id = ${id}`;
    await app`UPDATE account_polls SET state = 'rooted' WHERE id = ${id}`;
    await expect(
      app`UPDATE account_polls SET state = 'submitted', creator_address = NULL,
        create_tx_hash = NULL, election_id = NULL, created_block = NULL,
        l1_origin_timestamp = NULL WHERE id = ${id}`,
    ).rejects.toThrow(/check/);
    await expect(
      app`UPDATE account_polls SET abandoned_ids = ${MAX_ABANDONED_IDS + 1} WHERE id = ${id}`,
    ).rejects.toThrow(/check/);
  });
});
