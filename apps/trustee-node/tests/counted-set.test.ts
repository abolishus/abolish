// The counted set a seat sums over, from the counted extent through
// packages/verifier's `countedSet` (docs/spec/verifier.md, Counted set from
// the counted extent): an electorate of three whose ballots carry real
// membership proofs and name real blocks of an Anvil L1, taken in by every
// seat's intake, with the receipts intake gave boarded beside them. The set
// must be exactly docs/spec/tally.md's `S_c`, the re-vote rule's ballot of
// each voter that every qualified seat receipted in time, never one a
// later input could change, and the seats' tally duties must open it to the
// votes cast (T-14, T-16, T-29, T-45).
import {
  type AnchorClock,
  countedExtent,
  decodeTallyOpening,
  deliverySegments,
  encodeBoardEntry,
  encodeElectionDefinition,
  checkOpening,
  decodeBallot,
  pinnedVersion,
  RECORD_TYPES,
  tallyRules,
} from "@abolishus/crypto";
import { finalizedBlock, headerRun } from "@abolishus/node";
import { countedSet, type CountedExtentInputs, decodeHeader } from "@abolishus/verifier";
import { hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { ApprovedElection, IntakeSecrets } from "../src/ceremony.ts";
import type { SeatStore } from "../src/store.ts";
import { type CountedSet, type SummedSharePeers, TallyDuty } from "../src/tally.ts";
import { anvil, type Node } from "./anvil.ts";
import { type Cast, cast, castAgain, type L1Ref, seatsOf, type Setup, setup } from "./ballots.ts";
import { AVAILABLE, L2_CHAIN_ID, TRUSTEE_REGISTRY } from "./fixture.ts";

// The local stub opens at 1,000,000 and closes a day later. Anvil starts two
// hours before opening and mines a block every 600 seconds to past the
// close, so the run holds every block a ballot may name (5.8).
const GENESIS = 1_000_000n - 7_200n;
const INTERVAL = 600n;
// Hourly segments from Anvil's genesis: the close falls in segment 26, so
// the board path's last segment `s_A` is 27.
const CLOCK: AnchorClock = { epoch: GENESIS, period: 3600n, deadline: 600n, lastSegment: 10_000 };

let s: Setup;
let l1: Node;
let blocks: CountedExtentInputs["blocks"];
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
  // Blocks 20 and 40 are after the opening and before the close. Voter 0
  // chose option 1, then re-voted for option 0 naming a later block.
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
  const head = await finalizedBlock(l1.rpc);
  const run = await headerRun(l1.rpc, head, {
    before: s.e.stub.opens_at - 3_600n,
    after: s.e.stub.closes_at,
  });
  blocks = run.map(decodeHeader);
  const bound = BigInt(s.e.stub.l1_inclusion_bound);
  sS = Number(countedExtent(CLOCK, s.e.stub.closes_at, bound).segment);
  sD = Number(deliverySegments(CLOCK, s.e.stub.closes_at, bound).delivery);
}, 300_000);

afterAll(() => {
  l1?.process.kill();
});

/** The counted extent: the transcript at segment 0, then each payload at its segment, in order. */
function extent(payloads: readonly { readonly segment: number; readonly payload: Uint8Array }[]) {
  const version = pinnedVersion(s.definition, RECORD_TYPES.boardEntry) as 5;
  return [{ segment: 0, payload: s.transcript }, ...payloads].map(({ segment, payload }, index) =>
    encodeBoardEntry(
      { election_id: s.definition.election_id, index: BigInt(index), segment, payload },
      version,
    ),
  );
}

/** The ballots at segments 3, 4, …, then every seat's receipt of each at `s_D`, but those `skip` leaves out. */
function board(ballots: readonly Cast[], skip: (b: Cast, seat: number) => boolean = () => false) {
  return extent([
    ...ballots.map((b, i) => ({ segment: 3 + i, payload: b.bytes })),
    ...ballots.flatMap((b) =>
      (receipts.get(b) as Uint8Array[]).flatMap((payload, i) =>
        skip(b, i + 1) ? [] : [{ segment: sD, payload }],
      ),
    ),
  ]);
}

const inputs = (entries: readonly Uint8Array[], change: Partial<CountedExtentInputs> = {}) => ({
  definition: encodeElectionDefinition(s.definition),
  panel: s.e.panelists.panel,
  entries,
  clock: CLOCK,
  blocks,
  eventsAuthenticated: false,
  ...change,
});

describe("the counted set from the counted extent", () => {
  test("is each voter's last ballot that every seat receipted in time, in copy order", () => {
    // Seat 3 never receipted voter 2's ballot: it counts nothing, with no
    // fallback (docs/spec/revoting.md, Selection, step 4).
    const entries = board([older, second, newer, third], (b, seat) => b === third && seat === 3);
    const result = countedSet(inputs(entries));
    expect(result).toEqual({
      ok: true,
      definitionHash: s.election.definitionHash,
      cells: [[second.bytes, newer.bytes]],
    });
  });

  test("leaves out a ballot whose receipt was boarded after the delivery window", () => {
    const entries = extent([
      { segment: 3, payload: second.bytes },
      ...(receipts.get(second) as Uint8Array[])
        .map((payload, i) => ({
          // Seat 2's receipt is one segment late, boarded after the others.
          segment: i === 1 ? sD + 1 : sD,
          payload,
        }))
        .sort((a, b) => a.segment - b.segment),
    ]);
    expect(countedSet(inputs(entries))).toEqual({
      ok: true,
      definitionHash: s.election.definitionHash,
      cells: [[]],
    });
  });

  test("is undecided while a ballot's L1 reference lies past the run's head", () => {
    // A run that stops before block 40, the block voter 0's newer ballot
    // names, can't yet judge it: it may still be admitted (5.8).
    const short = blocks.filter((h) => h.number < 35n);
    const result = countedSet(inputs(board([older, newer]), { blocks: short }));
    expect(result.ok).toBe(false);
    if (result.ok || !("row" in result)) return expect.fail("a decided set");
    expect(result.row).toBe("5.8");
    expect(result.outcome.status).toBe("unverifiable");
  });

  test("refuses entries that aren't the counted extent", () => {
    const past = extent([{ segment: sS + 1, payload: second.bytes }]);
    expect(() => countedSet(inputs(past))).toThrow(RangeError);
    const other = encodeBoardEntry(
      {
        election_id: new Uint8Array(32).fill(9),
        index: 1n,
        segment: 3,
        payload: second.bytes,
      },
      pinnedVersion(s.definition, RECORD_TYPES.boardEntry) as 5,
    );
    expect(() => countedSet(inputs([...extent([]), other]))).toThrow(RangeError);
    expect(() => countedSet(inputs([...extent([]), Uint8Array.of(1, 2, 3)]))).toThrow(RangeError);
  });

  test("names the check that stops every ballot when the transcript isn't on the board", () => {
    const entries = board([second]).slice(1);
    expect(countedSet(inputs(entries))).toEqual({
      ok: false,
      code: "ceremony-transcript-missing",
    });
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

describe("the seats' tally over it", () => {
  test("opens the counted set to the votes it holds", async () => {
    const entries = board([older, second, newer, third], (b, seat) => b === third && seat === 3);
    const result = countedSet(inputs(entries));
    if (!result.ok) return expect.fail("an undecided set");
    const counted: CountedSet = { state: "fixed", cells: result.cells };
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
          store: s.stores[i] as SeatStore,
          summing: AVAILABLE,
          counted: async () => counted,
          peers: wire,
        }),
    );
    // Every duty fixes its counted set first: a message reaching a seat
    // before that is dropped, and resent on a later step.
    for (const duty of wire.duties) await duty.step();
    wire.deliver = true;
    // Seat 1 sends first, so seats 2 and 3 each hold `k` sums and open the
    // cell; a seat that has opened sends nothing more (tally.ts).
    for (const duty of wire.duties) await duty.step();
    const rules = tallyRules({ version: 1, value: s.definition });
    const vss = (result.cells[0] as Uint8Array[]).map((b) => decodeBallot(b, 1).committed_vote.vss);
    const opened = [];
    for (const duty of wire.duties) opened.push((await duty.openings()).get(0));
    expect(opened[0]).toBeUndefined();
    for (const opening of opened.slice(1)) {
      if (opening === undefined) return expect.fail("a seat holding k sums signed no opening");
      const checked = checkOpening(rules, vss, decodeTallyOpening(opening, 1).opening);
      if (!checked.ok) return expect.fail(`the opening fails ${checked.code}`);
      // Voter 1 chose option 1, voter 0's newer ballot option 0; voter 0's
      // older ballot and voter 2's undelivered one count nothing.
      expect(checked.counts).toEqual([1n, 1n]);
    }
  });
});
