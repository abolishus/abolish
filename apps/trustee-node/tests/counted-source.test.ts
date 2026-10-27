// The deployment's source of the counted set (`countedSource`): the counted
// extent the seat attested, the registered definition from an L2 node
// scripted here, finalized L1 from an Anvil node whose blocks the ballots
// name, and every contract-event record of the extent authenticated against
// that L2 node before packages/verifier's `countedSet` runs. The source must
// give exactly the set the verifier computes over the authenticated extent,
// a contract-path ballot among it, and refuse, never sum over, an extent
// carrying an event the contract never emitted (T-14, T-16, T-29, T-35).
import { readFile } from "node:fs/promises";
import {
  type AnchorClock,
  availabilityWindows,
  ballotHash,
  type BoardEntryVersion,
  countedExtent,
  type ContractEventVersion,
  decodeTallyOpening,
  deliverySegments,
  checkOpening,
  decode,
  decodeBallot,
  electionDefinitionHash,
  encodeBoardEntry,
  encodeContractEvent,
  encodeElectionDefinition,
  encodeSharePosting,
  frameBallot,
  type L1Origin,
  pinnedVersion,
  RECORD_TYPES,
  SHARE_CIPHERTEXT,
  tallyRules,
} from "@abolishus/crypto";
import { DEFINITION_REGISTERED, ELECTION_CREATED, type Rpc } from "@abolishus/node";
import { countedSet, decodeHeader } from "@abolishus/verifier";
import { finalizedBlock, headerRun } from "@abolishus/node";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { HeldExtent } from "../src/availability.ts";
import type { ApprovedElection, IntakeSecrets } from "../src/ceremony.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import type { SeatStore } from "../src/store.ts";
import { type SummedSharePeers, type TallyDefinition, TallyDuty } from "../src/tally.ts";
import {
  countedSource,
  type CountedSourceOptions,
  tallyDefinition,
  ViewError,
} from "../src/view.ts";
import { anvil, type Node } from "./anvil.ts";
import { type Cast, cast, castAgain, type L1Ref, seatsOf, type Setup, setup } from "./ballots.ts";
import { AVAILABLE, L2_CHAIN_ID, TRUSTEE_REGISTRY } from "./fixture.ts";

const vector = async (file: string) =>
  JSON.parse(
    await readFile(new URL(`../../../docs/spec/vectors/${file}`, import.meta.url), "utf8"),
  );
// The board's topic from contract-event-v8.json's tables, not the node's constants.
const events = (await vector("contract-event-v8.json")) as {
  events: { signature: string; topic0: string }[];
};
const BALLOT_SUBMITTED = `0x${events.events.find((e) => e.signature.startsWith("BallotSubmitted("))?.topic0}`;
const SHARE_POSTED = `0x${events.events.find((e) => e.signature.startsWith("SharePosted("))?.topic0}`;

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const word = (n: bigint) => {
  const w = new Uint8Array(32);
  for (let i = 31, x = n; x > 0n; i--, x >>= 8n) w[i] = Number(x & 0xffn);
  return w;
};
const padded = (b: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
};

// The local stub opens at 1,000,000 and closes a day later. Anvil starts two
// hours before opening and mines a block every 600 seconds to past the
// close, so the run holds every block a ballot may name (5.8).
const GENESIS = 1_000_000n - 7_200n;
const INTERVAL = 600n;
const TIMING = { epoch: GENESIS, period: 3600n, deadline: 600n };
const L2_FINALIZED = 100n;
// The block of the contract-path ballot's log.
const LOG_BLOCK = 50n;

interface Log {
  readonly address: Uint8Array;
  readonly topics: readonly string[];
  readonly data: Uint8Array;
  readonly block: bigint;
}

let s: Setup;
let l1: Node;
/** Voter 0's older and newer ballots, voter 1's and voter 2's, each naming a real block. */
let older: Cast;
let newer: Cast;
let second: Cast;
let third: Cast;
/** Each ballot's share receipts from seats 1 to 3, as each seat's intake gave them. */
const receipts = new Map<Cast, Uint8Array[]>();
let approved: ApprovedElection[];
let secrets: IntakeSecrets[];
let sS: number;
let sD: number;
/** `t_A'`: the L2 node's finalized history must be past it. */
let countedDeadline: bigint;

beforeAll(async () => {
  s = await setup();
  l1 = await anvil(s.e.stub.l1_chain_id, true, ["--timestamp", GENESIS.toString()]);
  await l1.rpc.call("anvil_mine", ["0xc8", `0x${INTERVAL.toString(16)}`]);
  const refOf = async (n: bigint): Promise<L1Ref> => {
    const b = (await l1.rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])) as {
      hash: string;
    };
    return { number: n, hash: hexToBytes(b.hash.slice(2)) };
  };
  const [a, b, c, d] = await Promise.all([
    cast(s, 0, 1),
    cast(s, 0, 0),
    cast(s, 1, 1),
    cast(s, 2, 0),
  ]);
  older = await castAgain(s, 0, a, await refOf(20n));
  newer = await castAgain(s, 0, b, await refOf(40n));
  second = await castAgain(s, 1, c, await refOf(20n));
  third = await castAgain(s, 2, d, await refOf(30n));
  const seats = seatsOf(s);
  for (const ballot of [older, newer, second, third]) {
    const given: Uint8Array[] = [];
    for (const [i, seat] of seats.intake.entries()) {
      const out = await seat.intake(
        s.e.stubBytes,
        s.transcript,
        ballot.bytes,
        ballot.ciphertexts[i] as Uint8Array,
      );
      if (!out.ok) throw new Error(`intake refused an honest ballot: ${out.code}`);
      given.push(out.receipt);
    }
    receipts.set(ballot, given);
  }
  approved = [];
  secrets = [];
  for (const seat of s.e.seats) {
    const a = await seat.approvedElection(s.e.stubHash);
    const k = await seat.intakeSecrets(s.e.stubHash);
    if (a === undefined || k === undefined) throw new Error("a seat holds no approval");
    approved.push(a);
    secrets.push(k);
  }
  const bound = BigInt(s.e.stub.l1_inclusion_bound);
  const extent = countedExtent(TIMING, s.e.stub.closes_at, bound);
  sS = Number(extent.segment);
  sD = Number(deliverySegments(TIMING, s.e.stub.closes_at, bound).delivery);
  countedDeadline = availabilityWindows(
    s.e.stub.closes_at,
    bound,
    extent.due,
    RELEASE_WINDOWS,
  ).countedDeadline;
}, 300_000);

afterAll(() => {
  l1?.process.kill();
});

const ORIGIN: L1Origin = { number: 1n, timestamp: GENESIS + INTERVAL, hash: new Uint8Array(32) };
const originWords = (o: L1Origin) => concatBytes(word(o.number), word(o.timestamp), o.hash);

/** The election's creation and the registration of `definition`, as the registry logs them. */
function registrationLogs(definition = s.definition): Log[] {
  const registry = s.definition.election_registry;
  const id = hex(s.definition.election_id);
  const encoding = encodeElectionDefinition(definition);
  return [
    {
      address: registry,
      topics: [hex(ELECTION_CREATED), id, hex(word(0xc4ea70n))],
      data: concatBytes(word(3n), originWords(ORIGIN)),
      block: 10n,
    },
    {
      address: registry,
      topics: [hex(DEFINITION_REGISTERED), id, hex(electionDefinitionHash(definition))],
      data: concatBytes(
        originWords(ORIGIN),
        word(128n),
        word(BigInt(encoding.length)),
        padded(encoding),
      ),
      block: 10n,
    },
  ];
}

/** The board's `BallotSubmitted` for `c` in L2 block `block`. */
function submitted(c: Cast, block = LOG_BLOCK): Log {
  const framed = frameBallot(c.bytes);
  if (framed === undefined) throw new Error("an honest ballot the board can't frame");
  return {
    address: s.definition.board,
    topics: [BALLOT_SUBMITTED, hex(s.election.definitionHash), hex(framed.ballotHash)],
    data: concatBytes(word(32n), word(BigInt(c.bytes.length)), padded(c.bytes)),
    block,
  };
}

/** L2 block `n`'s timestamp: a minute a block from the opening. */
const timeOf = (n: bigint) => s.e.stub.opens_at + n * 60n;

/**
 * An L2 node answering from `logs` as a real one filters them, up to its
 * finalized block, timestamped `finalizedAt` (just past `t_A'` by default).
 */
function l2Node(logs: readonly Log[], finalizedAt = countedDeadline + 1n): Rpc {
  return {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${L2_CHAIN_ID.toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        const tag = params[0] as string;
        const n = tag === "finalized" ? L2_FINALIZED : BigInt(tag);
        const t = n === L2_FINALIZED ? finalizedAt : timeOf(n);
        return { number: `0x${n.toString(16)}`, timestamp: `0x${t.toString(16)}` };
      }
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const filter = params[0] as {
        address: string;
        fromBlock: string;
        toBlock: string;
        topics: (string | string[] | null)[];
      };
      return logs
        .filter(
          (l) =>
            hex(l.address) === filter.address &&
            l.block >= BigInt(filter.fromBlock) &&
            l.block <= BigInt(filter.toBlock) &&
            filter.topics.every(
              (t, i) =>
                t === null ||
                (Array.isArray(t) ? t.includes(l.topics[i] ?? "") : t === l.topics[i]),
            ),
        )
        .map((l) => ({
          address: hex(l.address),
          topics: l.topics,
          data: hex(l.data),
          blockNumber: `0x${l.block.toString(16)}`,
        }));
    },
  };
}

/** A board log as the anchored board archives it: a contract-event record under the pinned version. */
function archived(log: Log, timestamp = timeOf(log.block)): Uint8Array {
  const version = pinnedVersion(s.definition, RECORD_TYPES.contractEvent) as ContractEventVersion;
  return encodeContractEvent(
    {
      contract: log.address,
      n: 1n,
      l2_block: log.block,
      l2_timestamp: timestamp,
      topics: log.topics.map((t) => hexToBytes(t.slice(2))),
      data: log.data,
    },
    version,
  );
}

/** The counted extent's entries: the transcript at segment 0, then each payload at its segment, in order. */
function entriesOf(
  payloads: readonly { readonly segment: number; readonly payload: Uint8Array }[],
) {
  const version = pinnedVersion(s.definition, RECORD_TYPES.boardEntry) as BoardEntryVersion;
  return [{ segment: 0, payload: s.transcript }, ...payloads].map(({ segment, payload }, index) =>
    encodeBoardEntry(
      { election_id: s.definition.election_id, index: BigInt(index), segment, payload },
      version,
    ),
  );
}

/**
 * Voter 0's older ballot at segment 3, voter 1's through the contract (its
 * archived log at segment 4, or `contract`'s records), voter 0's newer one
 * and voter 2's at 5 and 6, then every seat's receipt of each at `s_D` but
 * seat 3's of voter 2's.
 */
function board(contract: readonly Uint8Array[] = [archived(submitted(second))]) {
  return entriesOf([
    { segment: 3, payload: older.bytes },
    ...contract.map((payload) => ({ segment: 4, payload })),
    { segment: 5, payload: newer.bytes },
    { segment: 6, payload: third.bytes },
    ...[older, second, newer, third].flatMap((b) =>
      (receipts.get(b) as Uint8Array[]).flatMap((payload, i) =>
        b === third && i === 2 ? [] : [{ segment: sD, payload }],
      ),
    ),
  ]);
}

function options(
  change: {
    logs?: readonly Log[];
    entries?: readonly Uint8Array[];
    held?: HeldExtent | undefined;
    l2?: Rpc;
  } = {},
): CountedSourceOptions {
  const { logs = [...registrationLogs(), submitted(second)], entries = board() } = change;
  const held = "held" in change ? change.held : { entries, boardSegment: BigInt(sS) };
  return {
    panel: s.e.panelists.panel,
    l1: l1.rpc,
    l1ChainId: s.e.stub.l1_chain_id,
    l2: change.l2 ?? l2Node(logs),
    l2ChainId: L2_CHAIN_ID,
    registry: s.definition.election_registry,
    registryFromBlock: 0n,
    board: s.definition.board,
    boardFromBlock: 0n,
    extent: () => Promise.resolve(held),
    counted: TIMING,
  };
}

const read = (o: CountedSourceOptions) => countedSource(o)(approved[0] as ApprovedElection);

describe("the counted set from the attested counted extent", () => {
  test("is the verifier's set over the extent once its contract events are shown, a contract-path ballot among it", async () => {
    // Voter 1's ballot came through the contract: it counts once its log is
    // authenticated. Seat 3 never receipted voter 2's ballot, and voter 0's
    // older ballot is superseded.
    expect(await read(options())).toEqual({
      state: "fixed",
      cells: [[second.bytes, newer.bytes]],
      postings: [],
    });
    // Exactly what packages/verifier gives over the same inputs.
    const head = await finalizedBlock(l1.rpc);
    const run = await headerRun(l1.rpc, head, {
      before: s.e.stub.opens_at - 3_600n,
      after: s.e.stub.closes_at,
    });
    const clock: AnchorClock = { ...TIMING, lastSegment: sS };
    const direct = countedSet({
      definition: encodeElectionDefinition(s.definition),
      panel: s.e.panelists.panel,
      entries: board(),
      clock,
      blocks: run.map(decodeHeader),
      eventsAuthenticated: true,
    });
    expect(direct).toEqual({
      ok: true,
      definitionHash: s.election.definitionHash,
      cells: [[second.bytes, newer.bytes]],
    });
  });

  test("refuses an extent carrying a contract event the L2 node doesn't show", async () => {
    // The operator archived a ballot log the contract never emitted.
    expect(await read(options({ logs: registrationLogs() }))).toEqual({
      state: "refused",
      reason: "a contract event the seat's L2 node doesn't show",
    });
    // A log in another block, or with other data, isn't the record's.
    const moved = { ...submitted(second), block: LOG_BLOCK + 1n };
    expect((await read(options({ logs: [...registrationLogs(), moved] }))).state).toBe("refused");
    const other = submitted(third);
    const forged = { ...other, topics: submitted(second).topics };
    expect((await read(options({ logs: [...registrationLogs(), forged] }))).state).toBe("refused");
  });

  test("refuses a contract event under another block's timestamp", async () => {
    // Its window rests on `l2_timestamp` (T-35): moved into the window, it
    // could count a ballot the contract recorded late.
    const entries = board([archived(submitted(second), timeOf(LOG_BLOCK) - 1n)]);
    expect(await read(options({ entries }))).toEqual({
      state: "refused",
      reason: "a contract event under another block's timestamp",
    });
  });

  test("refuses two records of one log", async () => {
    const record = archived(submitted(second));
    expect(await read(options({ entries: board([record, record]) }))).toEqual({
      state: "refused",
      reason: "a contract event the seat's L2 node doesn't show",
    });
    // Two logs the contract did emit authenticate two records.
    const logs = [...registrationLogs(), submitted(second), submitted(second)];
    expect((await read(options({ logs, entries: board([record, record]) }))).state).toBe("fixed");
  });

  test("refuses a contract event past the L2 node's finalized block", async () => {
    const late = submitted(second, L2_FINALIZED + 1n);
    const entries = board([archived(late, timeOf(LOG_BLOCK))]);
    expect(await read(options({ entries, logs: [...registrationLogs(), late] }))).toEqual({
      state: "refused",
      reason: "a contract event past the L2 node's finalized history",
    });
  });

  test("waits while the L2 node's finalized history isn't past t_A'", async () => {
    const logs = [...registrationLogs(), submitted(second)];
    expect(await read(options({ l2: l2Node(logs, countedDeadline) }))).toEqual({
      state: "waiting",
    });
  });

  test("waits while finalized L1 doesn't reach a ballot's reference", async () => {
    // An L1 node whose finalized head is block 35, before the block 40 that
    // voter 0's newer ballot names: 5.8 is pending, never a refusal.
    const lagging: Rpc = {
      call: (method, params) =>
        l1.rpc.call(method, params[0] === "finalized" ? ["0x23", ...params.slice(1)] : params),
    };
    expect(await read({ ...options(), l1: lagging })).toEqual({ state: "waiting" });
  });

  test("passes over a contract-event record that doesn't decode, as the verifier does", async () => {
    const entries = board([archived(submitted(second)), Uint8Array.of(0x00, 0x08, 0xff)]);
    expect(await read(options({ entries }))).toEqual({
      state: "fixed",
      cells: [[second.bytes, newer.bytes]],
      postings: [],
    });
  });

  test("gives the share postings the extent's contract events carry for the definition, the ballot one delivers counted", async () => {
    // Voter 2's ballot lacks seat 3's receipt: its posting for seat 3
    // delivers it. Another definition's posting, a posting the L2 node shows
    // but the extent doesn't carry, and a ballot event are no postings here.
    const own = posted(third, 3);
    const other = posted(third, 2, new Uint8Array(32).fill(9));
    const unarchived = posted(second, 1);
    const logs = [...registrationLogs(), submitted(second), own.log, other.log, unarchived.log];
    const entries = board([archived(submitted(second)), archived(own.log), archived(other.log)]);
    expect(await read(options({ logs, entries }))).toEqual({
      state: "fixed",
      cells: [[second.bytes, newer.bytes, third.bytes]],
      postings: [own.record],
    });
  });

  test("refuses without the seat's own counted extent", async () => {
    expect(await read(options({ held: undefined }))).toEqual({
      state: "refused",
      reason: "the seat holds no counted extent",
    });
    // The ballot extent the seat attested at point 1 isn't it.
    const ballotExtent = { entries: board(), boardSegment: BigInt(sS - 1) };
    expect(await read(options({ held: ballotExtent }))).toEqual({
      state: "refused",
      reason: "an extent other than the counted extent",
    });
  });

  test("refuses entries the board checks wouldn't pass, and an extent without the transcript", async () => {
    const past = entriesOf([{ segment: sS + 1, payload: older.bytes }]);
    expect(await read(options({ entries: past }))).toEqual({
      state: "refused",
      reason: "countedSet: an entry past s_S",
    });
    expect(await read(options({ entries: board().slice(1) }))).toEqual({
      state: "refused",
      reason: "no ballot can be admitted: ceremony-transcript-missing",
    });
  });

  test("throws when the registered definition isn't the approved one", async () => {
    const logs = registrationLogs({ ...s.definition, closes_at: s.definition.closes_at + 1n });
    await expect(read(options({ logs }))).rejects.toThrow(ViewError);
  });

  test("gives the tally duty the registered definition the seat approved, under its version, and throws for another", async () => {
    const election = approved[0] as ApprovedElection;
    expect(await tallyDefinition(options(), election)).toEqual({
      version: 1,
      value: s.definition,
    });
    const logs = registrationLogs({ ...s.definition, closes_at: s.definition.closes_at + 1n });
    await expect(tallyDefinition(options({ logs }), election)).rejects.toThrow(ViewError);
  });
});

/** A channel handing each message to the recipient's duty once `deliver` is set. */
class Wire implements SummedSharePeers {
  duties: TallyDuty[] = [];
  deliver = false;
  async send(recipient: number, message: Uint8Array): Promise<void> {
    if (this.deliver) await (this.duties[recipient - 1] as TallyDuty).receive(message);
  }
}

/** `c`'s ballot hash. */
const hashOf = (c: Cast) =>
  ballotHash(
    {
      definitionHash: s.election.definitionHash,
      tier: c.record.tier,
      nullifier: c.record.nullifier,
    },
    c.record.committed_vote,
  );

/** Seat `seat`'s posting of `c`, as the voter posts it through the board, under `definitionHash`. */
function posted(
  c: Cast,
  seat: number,
  definitionHash = s.election.definitionHash,
  block = LOG_BLOCK,
) {
  const record = encodeSharePosting({
    definition_hash: definitionHash,
    ballot_hash: hashOf(c),
    seat,
    m: c.ms[seat - 1] as Uint8Array,
    ciphertext: decode(SHARE_CIPHERTEXT, c.ciphertexts[seat - 1] as Uint8Array),
  });
  const log: Log = {
    address: s.definition.board,
    topics: [SHARE_POSTED, hex(record.slice(3, 35)), hex(record.slice(35, 67))],
    data: concatBytes(word(32n), word(BigInt(record.length)), padded(record)),
    block,
  };
  return { record, log };
}

/**
 * `store` with the tally's records kept apart, so each test fixes its own
 * counted set, and without its intake record of `hidden`, if given.
 */
function scratch(store: SeatStore, hidden?: Cast): SeatStore {
  const own = new Map<string, Uint8Array>();
  const name = hidden === undefined ? undefined : hex(hashOf(hidden)).slice(2);
  return {
    ...store,
    get: async (key) => {
      if (key.startsWith("tally/")) return own.get(key);
      if (name !== undefined && key.endsWith(name)) return undefined;
      return store.get(key);
    },
    putOnce: async (key, value) => {
      if (!key.startsWith("tally/")) return store.putOnce(key, value);
      const held = own.get(key);
      if (held !== undefined) return { created: false, value: held };
      own.set(key, value);
      return { created: true, value };
    },
    list: async (prefix) => {
      if (!prefix.startsWith("tally/")) return store.list(prefix);
      const under = `${prefix}/`;
      return [...own.keys()]
        .filter((k) => k.startsWith(under) && !k.slice(under.length).includes("/"))
        .map((k) => k.slice(under.length))
        .sort();
    },
  };
}

describe("the seats' tally over the source", () => {
  test("opens the counted set to the votes it holds", async () => {
    const wire = new Wire();
    const definitions = await Promise.all(approved.map((e) => tallyDefinition(options(), e)));
    wire.duties = approved.map(
      (election, i) =>
        new TallyDuty({
          panel: s.e.panelists.panel,
          l2ChainId: L2_CHAIN_ID,
          trusteeRegistry: TRUSTEE_REGISTRY,
          election,
          secrets: secrets[i] as IntakeSecrets,
          // As `run` builds it: the definition read from the L2 node.
          definition: definitions[i] as TallyDefinition,
          transcript: s.transcript,
          store: s.stores[i] as SeatStore,
          summing: AVAILABLE,
          counted: countedSource(options()),
          board: async () => ({ state: "unread" }),
          peers: wire,
        }),
    );
    for (const duty of wire.duties) await duty.step();
    wire.deliver = true;
    for (const duty of wire.duties) await duty.step();
    const rules = tallyRules({ version: 1, value: s.definition });
    const vss = [second, newer].map((c) => decodeBallot(c.bytes, 1).committed_vote.vss);
    const opening = (await (wire.duties[1] as TallyDuty).openings()).get(0);
    if (opening === undefined) return expect.fail("a seat holding k sums signed no opening");
    const checked = checkOpening(rules, vss, decodeTallyOpening(opening, 1).opening);
    if (!checked.ok) return expect.fail(`the opening fails ${checked.code}`);
    // Voter 1 chose option 1 through the contract, voter 0's newer ballot option 0.
    expect(checked.counts).toEqual([1n, 1n]);
  });

  test("a seat that never took a counted ballot in sums its shares from the ballot's posting on the extent", async () => {
    const own = posted(third, 3);
    const counted = countedSource(
      options({
        logs: [...registrationLogs(), submitted(second), own.log],
        entries: board([archived(submitted(second)), archived(own.log)]),
      }),
    );
    const wire = new Wire();
    wire.duties = approved.map(
      (election, i) =>
        new TallyDuty({
          panel: s.e.panelists.panel,
          l2ChainId: L2_CHAIN_ID,
          trusteeRegistry: TRUSTEE_REGISTRY,
          election,
          secrets: secrets[i] as IntakeSecrets,
          definition: s.definition,
          transcript: s.transcript,
          // Seat 3's store without voter 2's ballot, as if its delivery never came.
          store: scratch(s.stores[i] as SeatStore, i === 2 ? third : undefined),
          summing: AVAILABLE,
          counted,
          board: async () => ({ state: "unread" }),
          peers: wire,
        }),
    );
    for (const duty of wire.duties) await duty.step();
    wire.deliver = true;
    // Seat 3 sends its sums; seat 1 combines them with its own.
    expect(await (wire.duties[2] as TallyDuty).step()).toEqual({
      state: "tallying",
      cells: [{ state: "combining", held: 1, sent: 2 }],
      board: "unread",
    });
    expect(await (wire.duties[0] as TallyDuty).step()).toEqual({
      state: "tallying",
      cells: [{ state: "opened" }],
      board: "unread",
    });
    const rules = tallyRules({ version: 1, value: s.definition });
    const vss = [second, newer, third].map((c) => decodeBallot(c.bytes, 1).committed_vote.vss);
    const opening = (await (wire.duties[0] as TallyDuty).openings()).get(0);
    if (opening === undefined) return expect.fail("a seat holding k sums signed no opening");
    const checked = checkOpening(rules, vss, decodeTallyOpening(opening, 1).opening);
    if (!checked.ok) return expect.fail(`the opening fails ${checked.code}`);
    // Voter 1 chose option 1, voter 0's newer ballot and voter 2's option 0.
    expect(checked.counts).toEqual([2n, 1n]);
  });

  test("refuses, and sends nothing, over an extent the L2 node contradicts", async () => {
    const sent: number[] = [];
    const duty = new TallyDuty({
      panel: s.e.panelists.panel,
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      election: approved[0] as ApprovedElection,
      secrets: secrets[0] as IntakeSecrets,
      definition: s.definition,
      transcript: s.transcript,
      store: s.stores[0] as SeatStore,
      summing: AVAILABLE,
      counted: countedSource(options({ logs: registrationLogs() })),
      board: async () => ({ state: "unread" }),
      peers: { send: async (r) => void sent.push(r) },
    });
    expect(await duty.step()).toEqual({
      state: "refused",
      reason: "a contract event the seat's L2 node doesn't show",
    });
    expect(sent).toEqual([]);
  });
});
