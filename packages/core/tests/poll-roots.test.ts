import {
  type ContractEventRecord,
  encodeGroupAddition,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  type GroupRegistryPins,
  signGroupApproval,
  tierTreeRoot,
} from "@abolishus/crypto";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  createPollDraft,
  type GroupRecordSource,
  MIN_OPEN_SECONDS,
  newAccountId,
  type PollDraft,
  type PollRootDeployment,
  type ProvenGroupRecords,
  rootPolls,
  SETUP_SECONDS,
  submitPollDraft,
} from "../src/index.ts";
import { type TestDb, testDb } from "./db.ts";

// The roots step (ADR 0032, rules 9 and 14; P2-22 part 3b-2): a created,
// checked poll is rooted at the one block the run reads, each tier's
// electorate from the deployment's published groups; a poll closing too
// soon, asking for a tier nobody can count yet or with nobody in it fails in
// plain words; a history the registry can't have logged fails no poll. The
// records are signed by group-registry.json's test registrars and logged
// under contract-event-v6.json's topics, so they are the registry's, and
// every expected root is the tier tree's over the leaves the test added.

const vectors = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8"),
  ) as unknown;
const registryVectors = vectors("group-registry.json") as {
  domain: { chainId: number; verifyingContract: string };
  registrars: { threshold: number; secretKeys: string[]; addresses: string[] };
};
const eventVectors = vectors("contract-event-v6.json") as {
  events: { signature: string; topic0: string }[];
};

const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const word = (v: bigint) => bytes(v.toString(16).padStart(64, "0"));
const topic0 = (signature: string) => {
  const found = eventVectors.events.find((e) => e.signature === signature);
  if (found === undefined) throw new Error(`no event ${signature}`);
  return bytes(found.topic0);
};

const registry = bytes(registryVectors.domain.verifyingContract);
const chainId = BigInt(registryVectors.domain.chainId);
const pins: GroupRegistryPins = {
  version: 6,
  chainId,
  registry,
  registrars: registryVectors.registrars.addresses.map(bytes),
  threshold: registryVectors.registrars.threshold,
};
const domain = groupRegistryDomainSeparator(chainId, registry);

const NOW = new Date("2026-10-17T12:00:00Z");
const NOW_S = BigInt(NOW.getTime() / 1000);
const BLOCK = 500n;

/** The registry's log: `GroupCreated` and signed `MembersAdded` records, numbered from 0. */
class Registry {
  readonly records: ContractEventRecord[] = [];
  readonly #sizes = new Map<bigint, bigint>();

  #log(topics: Uint8Array[], data: Uint8Array, block: bigint) {
    this.records.push({
      contract: registry,
      n: BigInt(this.records.length),
      l2_block: block,
      l2_timestamp: 1_760_000_000n + block * 2n,
      topics,
      data,
    });
  }

  create(groupId: bigint, tier: number, block = 10n) {
    this.#log(
      [topic0("GroupCreated(uint64,uint8)"), word(groupId), word(BigInt(tier))],
      new Uint8Array(0),
      block,
    );
    this.#sizes.set(groupId, 0n);
  }

  add(groupId: bigint, commitments: readonly bigint[], block = 20n) {
    const firstIndex = this.#sizes.get(groupId) ?? 0n;
    const digest = groupAdditionDigest(domain, { groupId, tier: 0, firstIndex, commitments });
    const record = encodeGroupAddition({
      groupId,
      firstIndex,
      commitments,
      approvals: registryVectors.registrars.secretKeys
        .slice(0, pins.threshold)
        .map((k, i) => signGroupApproval(digest, i + 1, bytes(k))),
    });
    const padded = new Uint8Array(Math.ceil(record.length / 32) * 32);
    padded.set(record);
    this.#log(
      [topic0("MembersAdded(uint64,uint64,bytes)"), word(groupId), word(firstIndex)],
      Uint8Array.from([...word(32n), ...word(BigInt(record.length)), ...padded]),
      block,
    );
    this.#sizes.set(groupId, firstIndex + BigInt(commitments.length));
  }
}

/** A source that hands the run `proven`, counting reads. */
class Source implements GroupRecordSource {
  reads = 0;
  readonly #proven: ProvenGroupRecords;
  readonly #during: (() => Promise<void>) | undefined;
  constructor(proven: ProvenGroupRecords, during?: () => Promise<void>) {
    this.#proven = proven;
    this.#during = during;
  }
  async read() {
    this.reads++;
    await this.#during?.();
    return this.#proven;
  }
}

const deployment = (groups: Record<number, readonly bigint[]>): PollRootDeployment => ({
  groups: new Map(
    Object.entries(groups).map(([tier, ids]) => [
      Number(tier),
      ids.map((group_id) => ({ group_id, region: 0 })),
    ]),
  ),
  pins,
});

const draft = (over: Partial<PollDraft> = {}): PollDraft => ({
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
  ...over,
});

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

/**
 * A submitted poll moved to `created` and through the per-slot check, as the
 * earlier steps leave it, `seen` seconds before `NOW`.
 */
async function checked(over: Partial<PollDraft> = {}, seen = 60): Promise<string> {
  const author = newAccountId();
  await app`
    INSERT INTO account_users VALUES (${author}, ${`${newAccountId()}@account.invalid`},
      false, '', NULL, now(), now())`;
  const id = await createPollDraft(app, author, draft(over), NOW);
  await submitPollDraft(app, author, id, {
    turnstile: { verify: async () => "passed" as const },
    token: "t",
    now: NOW,
  });
  await db.admin`
    UPDATE account_polls SET state = 'created', creator_address = ${new Uint8Array(20).fill(0xc0)},
      create_tx_hash = ${randomBytes(32)}, election_id = ${randomBytes(32)}, created_block = 7,
      l1_origin_timestamp = 1, anchors_checked_block = 9,
      updated_at = ${new Date(NOW.getTime() - seen * 1000)}
    WHERE id = ${id}`;
  return id;
}

const row = async (id: string) => {
  const [r] = await db.admin`
    SELECT state, failure, electorate FROM account_polls WHERE id = ${id}`;
  return r!;
};

const run = (source: GroupRecordSource, d: PollRootDeployment) =>
  rootPolls(app, source, d, { now: NOW });

/** Group 1 (Tier 0) with three members, group 2 (Tier 0) empty, group 3 (Tier 1). */
function registryOf(): Registry {
  const r = new Registry();
  r.create(1n, 0);
  r.create(2n, 0);
  r.create(3n, 1);
  r.add(1n, [11n, 12n, 13n]);
  return r;
}

describe("rootPolls", () => {
  test("roots a checked poll at the run's block, stating each tier as the tier tree gives it", async () => {
    const r = registryOf();
    // Added after the block: not in the electorate.
    r.add(1n, [14n], BLOCK + 1n);
    const id = await checked();
    const source = new Source({ block: BLOCK, records: r.records });
    expect(await run(source, deployment({ 0: [1n, 2n] }))).toEqual({ rooted: 1, failed: {} });
    expect(await row(id)).toEqual({
      state: "rooted",
      failure: null,
      electorate: [
        {
          tier: 0,
          rootL2Block: "500",
          groups: [
            { groupId: "1", region: 0 },
            { groupId: "2", region: 0 },
          ],
          regions: ["3"],
          cells: [{ root: tierTreeRoot([11n, 12n, 13n]).toString(), members: "3" }],
        },
      ],
    });
    // Nothing left: the next run reads nothing.
    expect(await run(source, deployment({ 0: [1n, 2n] }))).toEqual({ rooted: 0, failed: {} });
    expect(source.reads).toBe(1);
  });

  test("leaves created polls not yet checked, and reads nothing when there are none", async () => {
    const id = await checked();
    await db.admin`UPDATE account_polls SET anchors_checked_block = NULL WHERE id = ${id}`;
    const source = new Source({ block: BLOCK, records: registryOf().records });
    expect(await run(source, deployment({ 0: [1n] }))).toEqual({ rooted: 0, failed: {} });
    expect(source.reads).toBe(0);
    expect((await row(id)).state).toBe("created");
  });

  test("roots every poll of a run at one block, oldest first, at most ROOTS_PER_RUN", async () => {
    const ids = [await checked({}, 30), await checked({}, 90)];
    const source = new Source({ block: BLOCK, records: registryOf().records });
    expect(await run(source, deployment({ 0: [1n] }))).toEqual({ rooted: 2, failed: {} });
    for (const id of ids) expect((await row(id)).electorate[0].rootL2Block).toBe("500");
    expect(source.reads).toBe(1);
  });

  test("fails a poll that now closes too soon for the setup ahead, before reading its tiers", async () => {
    const edge = NOW_S + BigInt(SETUP_SECONDS + MIN_OPEN_SECONDS);
    const soon = await checked({ closesAt: edge + 3600n });
    await db.admin`
      UPDATE account_polls SET draft = jsonb_set(draft, '{closesAt}', to_jsonb(${(edge - 1n).toString()}::text))
      WHERE id = ${soon}`;
    const ok = await checked({ closesAt: edge + 3600n });
    await db.admin`
      UPDATE account_polls SET draft = jsonb_set(draft, '{closesAt}', to_jsonb(${edge.toString()}::text))
      WHERE id = ${ok}`;
    const source = new Source({ block: BLOCK, records: registryOf().records });
    expect(await run(source, deployment({ 0: [1n] }))).toEqual({
      rooted: 1,
      failed: { "closes-too-soon": 1 },
    });
    expect(await row(soon)).toEqual({
      state: "failed",
      failure: "closes-too-soon",
      electorate: null,
    });
  });

  test("fails a poll asking for a tier with no published group, or one it can't count yet", async () => {
    const records = registryOf().records;
    const unpublished = await checked({ tiers: [0, 2] });
    const tier1 = await checked({ tiers: [1] });
    const source = new Source({ block: BLOCK, records });
    expect(await run(source, deployment({ 0: [1n], 1: [3n] }))).toEqual({
      rooted: 0,
      failed: { "tier-unavailable": 2 },
    });
    for (const id of [unpublished, tier1])
      expect(await row(id)).toEqual({
        state: "failed",
        failure: "tier-unavailable",
        electorate: null,
      });
  });

  test("fails a poll whose tier has nobody in it at the block", async () => {
    const id = await checked();
    const r = registryOf();
    const source = new Source({ block: 15n, records: r.records });
    expect(await run(source, deployment({ 0: [1n, 2n] }))).toEqual({
      rooted: 0,
      failed: { "electorate-empty": 1 },
    });
    expect((await row(id)).failure).toBe("electorate-empty");
  });

  test("fails no poll when the registry's history isn't the deployment's", async () => {
    const id = await checked();
    // Group 9 is published but never created; group 3 is Tier 1, published as Tier 0.
    for (const groups of [[1n, 9n], [3n]]) {
      const source = new Source({ block: BLOCK, records: registryOf().records });
      await expect(run(source, deployment({ 0: groups }))).rejects.toMatchObject({
        name: "TierMembershipError",
      });
    }
    const other = { ...pins, registrars: pins.registrars.slice(1) };
    const source = new Source({ block: BLOCK, records: registryOf().records });
    await expect(
      rootPolls(app, source, { ...deployment({ 0: [1n] }), pins: other }, { now: NOW }),
    ).rejects.toMatchObject({ name: "TierMembershipError", code: "group-history" });
    expect(await row(id)).toEqual({ state: "created", failure: null, electorate: null });
  });

  test("leaves a poll whose identifier another run changed while it read", async () => {
    const id = await checked();
    const source = new Source({ block: BLOCK, records: registryOf().records }, async () => {
      await db.admin`
        UPDATE account_polls SET election_id = ${randomBytes(32)} WHERE id = ${id}`;
    });
    expect(await run(source, deployment({ 0: [1n] }))).toEqual({ rooted: 0, failed: {} });
    expect((await row(id)).state).toBe("created");
  });
});

describe("account_polls' electorate", () => {
  test("is required past created and refused before the per-slot check", async () => {
    const id = await checked();
    await expect(
      db.admin`UPDATE account_polls SET state = 'rooted' WHERE id = ${id}`,
    ).rejects.toThrow(/account_polls_electorate/);
    await expect(
      db.admin`
        UPDATE account_polls SET electorate = '[]', anchors_checked_block = NULL
        WHERE id = ${id}`,
    ).rejects.toThrow(/account_polls_electorate|account_polls_anchors_checked/);
    await expect(
      db.admin`UPDATE account_polls SET electorate = '{}' WHERE id = ${id}`,
    ).rejects.toThrow(/account_polls_electorate_check/);
    await expect(
      db.admin`
        UPDATE account_polls SET state = 'failed', failure = 'electorate-empty' WHERE id = ${id}`,
    ).resolves.toBeDefined();
  });
});
