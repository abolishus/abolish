import {
  type BallotRecordV2,
  ballotHash,
  cellBallotCore,
  cellBallotElection,
  checkContractEvent,
  checkEventAccumulatorProof,
  contractEventLog,
  decode,
  decodeMembershipProof,
  encodeBallotV2,
  encodeContractEvent,
  encodeSharePosting,
  encodeShareReceipt,
  encryptShares,
  eventAccumulatorGenesis,
  type EventContracts,
  identityKey,
  type IntakeKeys,
  l1RefMin,
  membershipVkEncoding,
  proveValidity,
  SHARE_CIPHERTEXT,
  shareReceiptRecord,
  shareVote,
  type ValidityContext,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { planElection, type Scenario } from "../src/index.ts";
import {
  type BoardRefusal,
  SHARE_RECEIPT_LENGTH,
  SimulatedBoardContract,
} from "../src/simulation/board-contract.ts";
import { readCountedExtent } from "../src/simulation/count.ts";
import { SIMULATED_EVENT_VERSION, simulateElection } from "../src/simulation/election.ts";
import { intakeInThread } from "../src/simulation/intake.ts";
import { SimulatedL1 } from "../src/simulation/l1.ts";
import { l2BlockAt } from "../src/simulation/l2.ts";
import { SIMULATED_CLOSES_AT, SIMULATED_OPENS_AT } from "../src/simulation/plan.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const timeout = 120_000;

const scenario: Scenario = {
  voters: 2,
  election: "approval",
  options: 3,
  trustees: { panel: 3, threshold: 2, offline: [], faulty: [], departures: [] },
  tiers: { "0": 1, "1": 0, "2": 0 },
  outage: null,
  challenges: 0,
  revotes: 0,
  publications: 0,
  postings: 0,
  reorgs: 0,
  seed: 1,
};

const REFUSALS: readonly BoardRefusal[] = [
  "decode",
  "ballot-stray",
  "profile-mismatch",
  "unknown-version",
  "ballot-cell",
  "validity-shape",
  "share-hash-unqualified",
  "ballot-window",
  "ReceiptBatchLength",
  "delivery-stray",
  "delivery-seat",
  "delivery-signature",
  "posting-length",
  "posting-ballot",
  "posting-hash",
];

// One election, and one honest ballot with every seat's receipt and a
// posting for each seat, as a voter's client and the trustees' nodes make them.
const election = simulateElection(
  scenario,
  planElection(scenario),
  identityKey(crypto.getRandomValues(new Uint8Array(32))),
);
const { definition, definitionHash, seats, registered, deployment } = election;
const contracts: EventContracts = {
  electionRegistry: deployment.electionRegistry,
  trusteeRegistry: deployment.trusteeRegistry,
  groupRegistry: deployment.groupRegistry,
  board: deployment.board,
};
const keys: IntakeKeys[] = seats.map((s) => ({
  seat: s.index,
  kemSecret: s.kem.secretKey,
  signingSecret: s.signingSecret,
}));
const vk = membershipVkEncoding();
const placeholderProof = decodeMembershipProof(
  Uint8Array.from([...vk.subarray(0, 192), ...vk.subarray(0, 64)]),
);
const l1 = new SimulatedL1();
const refNumber = l1.firstAfter(SIMULATED_OPENS_AT);

const castBallot = async (nullifier: bigint, votes: (0 | 1)[]) => {
  const ctx: ValidityContext = {
    optionCount: 3,
    minSelections: 0,
    maxSelections: 3,
    threshold: 2,
    panelSize: 3,
    definitionHash,
    ballotVersion: 2,
    cell: 0,
    nullifier,
  };
  const sharing = shareVote(ctx, votes);
  const encrypted = encryptShares(
    { definitionHash },
    sharing,
    registered.map((r) => r.kemKey),
  );
  const core = cellBallotCore(cellBallotElection(definition, registered), 0, encrypted);
  const vote = proveValidity(ctx, sharing, core.shareHashes);
  const fields: BallotRecordV2 = {
    definition_hash: definitionHash,
    cell: 0,
    nullifier,
    l1_ref_number: refNumber,
    l1_ref_hash: l1.block(refNumber).hash,
    membership_proof: placeholderProof,
    committed_vote: vote,
  };
  const results = await intakeInThread(keys).run(
    ctx,
    vote,
    [1, 2, 3].map((seat) => ({ seat, ciphertext: encrypted.ciphertexts[seat - 1] as Uint8Array })),
  );
  const receipts = results.map((r, i) => {
    if (!r.ok) throw new Error("intake refused an honest ballot");
    return encodeShareReceipt(shareReceiptRecord(definitionHash, i + 1, r));
  });
  const posting = (seat: number, sealed?: (s: Uint8Array) => Uint8Array) => {
    const ct = decode(SHARE_CIPHERTEXT, encrypted.ciphertexts[seat - 1] as Uint8Array);
    return encodeSharePosting({
      definition_hash: definitionHash,
      ballot_hash: ballotHash(ctx, vote),
      seat,
      m: (encrypted.randomness[seat - 1] as (typeof encrypted.randomness)[number]).m,
      ciphertext: sealed === undefined ? ct : { ...ct, sealed: sealed(ct.sealed) },
    });
  };
  return { fields, record: encodeBallotV2(fields), receipts, posting, hash: ballotHash(ctx, vote) };
};

const honest = await castBallot(1n, [1, 0, 1]);
const other = await castBallot(2n, [0, 1, 1]);

const concat = (...parts: readonly Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

const freshBoard = (
  trustees: Pick<typeof election.trusteeRegistry, "keySetOf"> = election.trusteeRegistry,
) =>
  new SimulatedBoardContract(
    definition.l2_chain_id,
    deployment.board,
    election.electionRegistry,
    trustees,
  );
const during = l2BlockAt(SIMULATED_OPENS_AT + 600n);
const refusal = (r: ReturnType<SimulatedBoardContract["submitBallot"]>) =>
  r.ok ? "accepted" : r.refusal;

describe("SimulatedBoardContract ballots", { timeout }, () => {
  it("accepts an honest ballot and emits BallotSubmitted, which passes crypto's event check", () => {
    const board = freshBoard();
    expect(board.submitBallot(honest.record, during)).toEqual({ ok: true, emitted: 1 });
    const [event] = board.events;
    expect(event).toMatchObject({ n: 0n, l2_block: during.number, l2_timestamp: during.timestamp });
    const checked = checkContractEvent(event as never, contracts, SIMULATED_EVENT_VERSION);
    expect(checked.ok && checked.role).toBe("board");
    if (!checked.ok || checked.event.event !== "BallotSubmitted") throw new Error("not a ballot");
    expect(checked.event.record).toEqual(honest.record);
    expect(checked.event.ballotHash).toEqual(honest.hash);
    expect(checked.event.definitionHash).toEqual(definitionHash);
  });

  it("takes a byte-identical repeat as a no-op that emits nothing, even after close", () => {
    const board = freshBoard();
    board.submitBallot(honest.record, during);
    expect(board.submitBallot(honest.record, during)).toEqual({ ok: true, emitted: 0 });
    expect(board.submitBallot(honest.record, l2BlockAt(SIMULATED_CLOSES_AT + 10n))).toEqual({
      ok: true,
      emitted: 0,
    });
    expect(board.events).toHaveLength(1);
  });

  it("accepts a ballot exactly inside the window, by its block's time", () => {
    for (const [seconds, want] of [
      [SIMULATED_OPENS_AT - 2n, "ballot-window"],
      [SIMULATED_OPENS_AT, "accepted"],
      [SIMULATED_CLOSES_AT, "accepted"],
      [SIMULATED_CLOSES_AT + 2n, "ballot-window"],
    ] as const)
      expect(refusal(freshBoard().submitBallot(honest.record, l2BlockAt(seconds)))).toBe(want);
  });

  it("never remembers a refused ballot: the same bytes are accepted inside the window", () => {
    const board = freshBoard();
    expect(refusal(board.submitBallot(honest.record, l2BlockAt(SIMULATED_OPENS_AT - 2n)))).toBe(
      "ballot-window",
    );
    expect(board.events).toHaveLength(0);
    expect(board.submitBallot(honest.record, during)).toEqual({ ok: true, emitted: 1 });
  });

  it("refuses each malformed ballot with the contract's code, in its order", () => {
    const stray = Uint8Array.from(honest.record);
    stray[3] = (stray[3] ?? 0) ^ 1;
    const version = Uint8Array.from(honest.record);
    version[2] = 1;
    const type = Uint8Array.from(honest.record);
    type[1] = 0x0c;
    const vote = honest.fields.committed_vote;
    const cases: [Uint8Array, BoardRefusal][] = [
      [new Uint8Array(0), "decode"],
      [honest.record.subarray(0, 34), "decode"],
      [type, "decode"],
      [stray, "ballot-stray"],
      [version, "profile-mismatch"],
      [honest.record.subarray(0, honest.record.length - 1), "decode"],
      [Uint8Array.from([...honest.record, 0]), "decode"],
      [encodeBallotV2({ ...honest.fields, cell: 1 }), "ballot-cell"],
      [
        encodeBallotV2({
          ...honest.fields,
          committed_vote: { ...vote, option_proofs: vote.option_proofs.slice(1) },
        }),
        "validity-shape",
      ],
    ];
    for (const [record, want] of cases)
      expect(refusal(freshBoard().submitBallot(record, during))).toBe(want);
    // Before the window: a malformed record is refused for what it is.
    expect(refusal(freshBoard().submitBallot(stray, l2BlockAt(0n)))).toBe("ballot-stray");
  });

  it("refuses a share hash for a seat outside the registered key set, read from the trustee registry", () => {
    const trustees = {
      keySetOf: (stub: Uint8Array, panel: Uint8Array) => {
        const set = election.trusteeRegistry.keySetOf(stub, panel);
        return set && { ...set, seats: set.seats.filter((s) => s.index !== 3) };
      },
    };
    expect(refusal(freshBoard(trustees).submitBallot(honest.record, during))).toBe(
      "share-hash-unqualified",
    );
  });

  it("never throws on a one-byte change to an honest ballot, and every event it emits passes the event check", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: honest.record.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const record = Uint8Array.from(honest.record);
          record[at] = (record[at] ?? 0) ^ flip;
          const board = freshBoard();
          const got = board.submitBallot(record, during);
          if (!got.ok) return REFUSALS.includes(got.refusal) && board.events.length === 0;
          const checked = checkContractEvent(
            board.events[0] as never,
            contracts,
            SIMULATED_EVENT_VERSION,
          );
          return checked.ok && checked.role === "board";
        },
      ),
      { numRuns },
    );
  });

  it("keeps an accumulator a verifier replays its events against, at every block", () => {
    const board = freshBoard();
    const genesis = eventAccumulatorGenesis(definition.l2_chain_id, deployment.board);
    expect(board.accumulatorAt(during.number)).toEqual({
      block: during.number,
      accumulator: genesis,
      count: 0n,
    });
    board.submitBallot(honest.record, during);
    const later = l2BlockAt(SIMULATED_OPENS_AT + 3600n);
    board.submitBallot(other.record, later);
    const logs = board.events.map(contractEventLog);
    for (const [block, count] of [
      [during.number - 1n, 0n],
      [during.number, 1n],
      [later.number - 1n, 1n],
      [later.number, 2n],
    ] as const) {
      const proven = board.accumulatorAt(block);
      expect(proven.count).toBe(count);
      expect(
        checkEventAccumulatorProof(definition.l2_chain_id, deployment.board, logs, proven),
      ).toBeNull();
    }
    // Leaving either event out of the archive is found.
    const proven = board.accumulatorAt(later.number);
    for (const drop of [0, 1])
      expect(
        checkEventAccumulatorProof(
          definition.l2_chain_id,
          deployment.board,
          logs.filter((_, i) => i !== drop),
          proven,
        ),
      ).not.toBeNull();
  });

  it("refuses a call before its last event's block, as L2 time never runs backwards", () => {
    const board = freshBoard();
    board.submitBallot(honest.record, during);
    expect(() => board.submitBallot(other.record, l2BlockAt(SIMULATED_OPENS_AT))).toThrow(
      /before the board's last event/,
    );
  });
});

describe("SimulatedBoardContract delivery records", { timeout }, () => {
  it("accepts every seat's receipt in one batch, each its own ShareReceiptSubmitted event", () => {
    const board = freshBoard();
    expect(board.submitReceipts(concat(...honest.receipts), during)).toEqual({
      ok: true,
      emitted: 3,
    });
    for (const [i, event] of board.events.entries()) {
      const checked = checkContractEvent(event, contracts, SIMULATED_EVENT_VERSION);
      if (!checked.ok || checked.event.event !== "ShareReceiptSubmitted")
        throw new Error("not a receipt");
      expect(checked.event.record).toEqual(honest.receipts[i]);
      expect(checked.event.ballotHash).toEqual(honest.hash);
    }
    // Repeats, alone or in a batch with a new one, emit nothing again.
    expect(board.submitReceipts(honest.receipts[0] as Uint8Array, during)).toEqual({
      ok: true,
      emitted: 0,
    });
    expect(
      board.submitReceipts(
        concat(honest.receipts[0] as Uint8Array, other.receipts[0] as Uint8Array),
        during,
      ),
    ).toEqual({ ok: true, emitted: 1 });
  });

  it("refuses a batch that isn't whole receipts, and a failing receipt reverts its whole batch", () => {
    const r = honest.receipts[0] as Uint8Array;
    expect(r.length).toBe(SHARE_RECEIPT_LENGTH);
    for (const batch of [new Uint8Array(0), r.subarray(1), concat(r, r.subarray(1))])
      expect(freshBoard().submitReceipts(batch, during)).toEqual({
        ok: false,
        refusal: "ReceiptBatchLength",
      });
    // Seat 1's receipt claiming seat 2: signed by another seat's key.
    const claimed = Uint8Array.from(r);
    claimed[67] = 2;
    const board = freshBoard();
    expect(board.submitReceipts(concat(other.receipts[0] as Uint8Array, claimed), during)).toEqual({
      ok: false,
      refusal: "delivery-signature",
      at: 1,
    });
    expect(board.events).toHaveLength(0);
  });

  it("refuses a receipt with the contract's codes: framing, election, version and seat", () => {
    const r = honest.receipts[0] as Uint8Array;
    const changed = (at: number, value: number) => {
      const c = Uint8Array.from(r);
      c[at] = value;
      return c;
    };
    const cases: [Uint8Array, BoardRefusal][] = [
      [changed(1, 0x0d), "decode"],
      [changed(3, (r[3] ?? 0) ^ 1), "delivery-stray"],
      [changed(2, 2), "profile-mismatch"],
      [changed(67, 0), "delivery-seat"],
      [changed(67, 4), "delivery-seat"],
    ];
    for (const [record, want] of cases)
      expect(freshBoard().submitReceipts(record, during)).toEqual({
        ok: false,
        refusal: want,
        at: 0,
      });
  });

  it("accepts a posting carrying its ballot, which is checked and never emitted", () => {
    const board = freshBoard();
    expect(board.submitPosting(honest.posting(2), honest.record, during)).toEqual({
      ok: true,
      emitted: 1,
    });
    expect(board.events).toHaveLength(1);
    const checked = checkContractEvent(
      board.events[0] as never,
      contracts,
      SIMULATED_EVENT_VERSION,
    );
    if (!checked.ok || checked.event.event !== "SharePosted") throw new Error("not a posting");
    expect(checked.event.record).toEqual(honest.posting(2));
    // The posting alone decides a repeat, whatever ballot carries it.
    expect(board.submitPosting(honest.posting(2), other.record, during)).toEqual({
      ok: true,
      emitted: 0,
    });
    // The ballot it carried isn't remembered: it is still accepted on its own.
    expect(board.submitBallot(honest.record, during)).toEqual({ ok: true, emitted: 1 });
  });

  it("refuses a posting with the contract's codes: length, its ballot and its hash", () => {
    const stray = Uint8Array.from(honest.record);
    stray[3] = (stray[3] ?? 0) ^ 1;
    const wrongSeat = honest.posting(2);
    wrongSeat[67] = 3;
    const cases: [Uint8Array, Uint8Array, BoardRefusal][] = [
      [honest.posting(2, (s) => s.subarray(1)), honest.record, "posting-length"],
      [honest.posting(2), stray, "ballot-stray"],
      [honest.posting(2), other.record, "posting-ballot"],
      [wrongSeat, honest.record, "posting-hash"],
      [honest.posting(2).subarray(0, 120), honest.record, "decode"],
    ];
    for (const [posting, ballot, want] of cases)
      expect(freshBoard().submitPosting(posting, ballot, during)).toEqual({
        ok: false,
        refusal: want,
      });
  });
});

describe("readCountedExtent over the board contract's events", { timeout }, () => {
  const closesAt = SIMULATED_CLOSES_AT;
  const finalized = l1.finalized(l1.firstAfter(closesAt));
  const ctx = {
    definitionHash,
    panelSize: 3,
    registered,
    tierOfCell: (cell: number) => (cell === 0 ? 0 : undefined),
    closesAt,
    inclusionBound: definition.l1_inclusion_bound,
    finalized,
    window: {
      l1RefMin: l1RefMin(finalized, 0n, SIMULATED_OPENS_AT) as bigint,
      closesAt,
    },
    contracts,
    eventVersion: SIMULATED_EVENT_VERSION,
    opensAt: SIMULATED_OPENS_AT,
    boardSegment: closesAt / 3600n + 1n,
  } as const;
  const board = freshBoard();
  board.submitBallot(honest.record, during);
  board.submitReceipts(concat(...honest.receipts), during);
  const [ballotEvent] = board.events;
  const entry = (event: typeof ballotEvent) => ({
    segment: 300,
    payload: encodeContractEvent(event as never, SIMULATED_EVENT_VERSION),
  });

  it("reads a direct ballot from its event, and its receipts as contract-path records", () => {
    const extent = readCountedExtent(ctx, board.events.map(entry));
    expect(extent.rejected).toEqual([]);
    expect(extent.events.map((e) => e.index)).toEqual([0, 1, 2, 3]);
    expect([...extent.ballots.keys()]).toEqual([0]);
    expect(extent.verdicts.get(0)).toBe("admitted");
    expect(extent.delivery.ballots[0]?.counted).toBe(true);
    expect(extent.counted).toHaveLength(1);
  });

  it("rejects a direct ballot outside the window by its event's time, and another contract's event", () => {
    const event = ballotEvent as NonNullable<typeof ballotEvent>;
    const late = { ...event, l2_timestamp: closesAt + 2n };
    const foreign = { ...event, contract: new Uint8Array(20).fill(7) };
    const extent = readCountedExtent(ctx, [entry(late), entry(foreign)]);
    expect(extent.rejected).toEqual([0, 1]);
    expect(extent.ballots.size).toBe(0);
  });

  it("rejects a ballot naming another definition, and a board-path ballot boarded after s_A", () => {
    const stray = encodeBallotV2({ ...honest.fields, definition_hash: new Uint8Array(32).fill(9) });
    const extent = readCountedExtent(ctx, [
      { segment: 300, payload: stray },
      { segment: Number(ctx.boardSegment) + 1, payload: honest.record },
      { segment: Number(ctx.boardSegment), payload: honest.record },
    ]);
    expect(extent.rejected).toEqual([0, 1]);
    expect([...extent.ballots.keys()]).toEqual([2]);
  });
});
