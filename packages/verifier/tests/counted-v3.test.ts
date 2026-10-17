import { readFileSync } from "node:fs";
import {
  aggregateCell,
  aggregateHash,
  type AnchorClock,
  ballotHashV3,
  checkContractEvent,
  type CommittedVoteV3,
  CONTRACT_EVENT_SIGNATURES,
  decode,
  decodeBallot,
  decodeBoardEntry,
  decodeContractEvent,
  decodeShareComplaint,
  deliverySegments,
  encodeBoardEntry,
  encodeCloseStatement,
  encodeContractEvent,
  encodeDestructionStatement,
  encodeShareComplaint,
  encodeShareReceipt,
  encodeTallyOpening,
  identityKey,
  KEM_PUBLIC_KEY,
  openCell,
  PARAMETERS,
  proveValidityV3,
  type QuestionRules,
  RECORD_TYPES,
  type RegisteredKeys,
  type Share,
  shareReceiptRecord,
  shareReceiptStatement,
  shareVoteV3,
  signCloseStatement,
  signDestructionStatement,
  signShareComplaint,
  signStatement,
  signTallyOpening,
  sumShares,
  tallyRules,
  type VoteSharing,
} from "@abolishus/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import type { BallotTally } from "../src/ballots.ts";
import type { CloseCandidate } from "../src/close.ts";
import { type CountedBallot, countedChecks, type CountedInputs } from "../src/counted.ts";
import { decodeDefinition, readDefinition, type VerifiedDefinition } from "../src/definition.ts";
import { decodeHeader, splitEntries } from "../src/index.ts";
import { run, type TestHeader } from "./headers.ts";

// The counted set under definition version 5, whose ballots are version 3:
// delivery (5.9) is version 1's check, over the default panel, with each
// ballot hash recomputed under version 3, over the question range proofs, so
// a receipt binds the whole ballot (docs/spec/verifier.md, Counted set and
// tally, step 3; docs/spec/ballot-validity.md, Shares and delivery (version
// 3); T-38, T-41). 6.3 rides on the same delivery, and the tally (7.1 to
// 7.4's counted-set breaks, 8.5) opens each cell under tally-opening version
// 1 with the definition's questions (docs/spec/tally.md, Context). The
// delivery ballots are verifier-ballots-v3.json's `admitted` case
// (packages/crypto/scripts/verifier-ballots-v3-vectors.py, an independent
// implementation); the tally's are cast here under its definition with
// @abolishus/crypto's client path (`shareVoteV3`, `proveValidityV3`), since
// the vectors' sharings aren't published, and the expected counts are the
// votes cast. The seats' signing keys are this test's own, and the receipts,
// complaints, openings and destruction statements are made with
// @abolishus/crypto's trustee paths (`sumShares`, `openCell`), never with the
// checks under test. delivery.json gives a KEM key and a complaint proof,
// which only has to decode here.

const numRuns = Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 200);

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const text = (s: string) => new TextEncoder().encode(s);

interface Case {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
}
const ballotsFile = read("verifier-ballots-v3.json") as { readonly cases: readonly Case[] };
const caseOf = (id: string) => {
  const c = ballotsFile.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const deliveryFile = read("delivery.json") as {
  readonly panel: readonly { readonly kemKey: string }[];
  readonly records: readonly { readonly id: string; readonly encoding: string }[];
};
const KEM = decode(
  KEM_PUBLIC_KEY,
  hex((deliveryFile.panel[0] as { readonly kemKey: string }).kemKey),
);
const recordOf = (id: string) => {
  const r = deliveryFile.records.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no record ${id}`);
  return hex(r.encoding);
};

// Seats 1 to 3 of the 3-of-4 panel are registered here, with signing keys of
// the test's own; seat 4, outside the key set, is owed no receipt.
const SEATS = [1, 2, 3];
const SECRETS = [1, 2, 3, 4].map((i) => sha256(text(`counted-v3.test seat ${i}`)));
const secret = (seat: number) => SECRETS[seat - 1] as Uint8Array;
const REGISTERED: RegisteredKeys[] = SEATS.map((index) => ({
  index,
  kemKey: KEM,
  signingKey: identityKey(secret(index)),
}));

// Hourly periods from the opening: close is 168 periods later, so s_F = 169,
// s_D = 169 + 48 = 217 and s_K = 169 + 120 = 289 (l1_inclusion_bound is an
// hour).
const OPENS = 1_767_225_600n;
const CLOCK: AnchorClock = { epoch: OPENS, period: 3600n, deadline: 600n, lastSegment: 1000 };
const S_D = 217;
const S_K = 289;

const admittedCase = caseOf("admitted");
const definition: VerifiedDefinition = decodeDefinition(hex(admittedCase.definition));
const d = definition.value as Extract<VerifiedDefinition, { version: 5 }>["value"];
const { hash } = readDefinition(definition);

test("the fixture's definition is version 5, with board-entry version 5, on the test's clock", () => {
  expect(definition.version).toBe(5);
  expect(d.panel_size).toBe(4);
  expect(d.profile.pins).toContainEqual({ record_type: RECORD_TYPES.boardEntry, version: 5 });
  expect(d.profile.pins).toContainEqual({ record_type: RECORD_TYPES.ballot, version: 3 });
  expect(d.closes_at).toBe(OPENS + 168n * 3600n);
  const segments = deliverySegments(CLOCK, d.closes_at, BigInt(d.l1_inclusion_bound));
  expect(segments).toEqual({ delivery: BigInt(S_D), complaint: BigInt(S_K) });
});

interface Cast {
  readonly entry: number;
  readonly cell: number;
  readonly nullifier: bigint;
  readonly vote: CommittedVoteV3;
  readonly hash: Uint8Array;
  /** The sharing, for a ballot cast here: the trustees' summed shares come from it. */
  readonly sharing?: VoteSharing;
}

/** The `admitted` case's ballots, in copy order, with their entries on that board. */
const CAST: readonly Cast[] = (() => {
  const { entries } = splitEntries(hex(admittedCase.board));
  return entries.flatMap((encoded, entry) => {
    const { payload } = decodeBoardEntry(encoded, 5);
    if (((payload[0] as number) << 8) + (payload[1] as number) !== RECORD_TYPES.ballot) return [];
    const b = decodeBallot(payload, 3);
    const ctx = { definitionHash: hash, cell: b.cell, nullifier: b.nullifier };
    return [
      {
        entry,
        cell: b.cell,
        nullifier: b.nullifier,
        vote: b.committed_vote,
        hash: ballotHashV3(ctx, b.committed_vote),
      },
    ];
  });
})();
const [ALICE, BOB, CAROL] = CAST as [Cast, Cast, Cast, ...Cast[]];

// The definition's questions: pick one of three or none, up to two of four,
// exactly one of two, so nine flat options; tier 0 has cells 0 and 1, tier 2
// cell 2.
const RULES = tallyRules(definition);
let nextNullifier = 1_000n;
let nextEntry = 10_000;

/** A version-3 ballot in `cell` with these flat votes, admitted and selected elsewhere in the copy (its `entry` is a stand-in). */
function cast(cell: number, votes: readonly (0 | 1)[]): Cast {
  const nullifier = nextNullifier++;
  const rules = {
    questions: RULES.questions as readonly QuestionRules[],
    threshold: RULES.threshold,
    panelSize: RULES.panelSize,
  };
  const sharing = shareVoteV3(rules, votes);
  const shareHashes = Array.from({ length: RULES.panelSize }, (_, i) =>
    sha256(text(`share ${nullifier} ${i + 1}`)),
  );
  const vote = proveValidityV3(
    { ...rules, definitionHash: hash, cell, nullifier },
    sharing,
    shareHashes,
  );
  return {
    entry: nextEntry++,
    cell,
    nullifier,
    vote,
    hash: ballotHashV3({ definitionHash: hash, cell, nullifier }, vote),
    sharing,
  };
}

/** Seat `seat`'s version-1 receipt for the ballot hash `ballotHash` and `b`'s share hash, signed by `signer`'s key. */
function receiptFor(b: Cast, seat: number, ballotHash = b.hash, signer = seat) {
  const shareHash = b.vote.share_hashes[seat - 1] as Uint8Array;
  const m = shareReceiptStatement({
    definition_hash: hash,
    ballot_hash: ballotHash,
    seat,
    share_hash: shareHash,
  });
  return encodeShareReceipt(
    shareReceiptRecord(hash, seat, {
      ballotHash,
      shareHash,
      receipt: signStatement(secret(signer), "abolish/v1/sig/share-receipt", m),
    }),
  );
}

/** One copy of the election: the board the test fills, and what `countedChecks` takes. */
function election() {
  const entries: Uint8Array[] = [];
  const board = (segment: number, payload: Uint8Array) => {
    entries.push(
      encodeBoardEntry(
        { election_id: d.election_id, index: BigInt(entries.length), segment, payload },
        5,
      ),
    );
    return entries.length - 1;
  };
  const receipt = (b: Cast, seat: number, signer = seat) => receiptFor(b, seat, b.hash, signer);
  /** Every registered seat's receipt for each ballot, boarded in `segment`. */
  const deliver = (ballots: readonly Cast[], segment: number) => {
    for (const b of ballots) for (const seat of SEATS) board(segment, receipt(b, seat));
  };
  /** Cell `cell`'s honest opening over `counted`, combined by seats 1 to k and signed by `signer`. */
  const opening = (
    cell: number,
    counted: readonly Cast[],
    signer: number,
    tamper?: (o: Share[]) => Share[],
  ) => {
    const vss = counted.map((b) => b.vote.vss);
    const summed = new Map(
      SEATS.slice(0, RULES.threshold).map((seat) => [
        seat,
        sumShares(
          RULES,
          counted.map((b) => {
            if (b.sharing === undefined) throw new Error("fixture: a ballot not cast here");
            return b.sharing.shares[seat - 1] as readonly Share[];
          }),
        ),
      ]),
    );
    const opened = openCell(RULES, vss, summed);
    if (!opened.ok) throw new Error(`fixture: cell ${cell} doesn't open (${opened.code})`);
    const shares = opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint }));
    return encodeTallyOpening(
      signTallyOpening(secret(signer), {
        definition_hash: hash,
        cell,
        aggregate_hash: aggregateHash(aggregateCell(RULES, vss)),
        signer,
        opening: tamper === undefined ? shares : tamper(shares),
      }),
    );
  };
  const destruction = (signer: number) =>
    encodeDestructionStatement(
      signDestructionStatement(secret(signer), { definition_hash: hash, signer }),
    );
  const tallyOf = (b: Cast): BallotTally => ({
    cell: b.cell,
    vss: b.vote.vss,
    delivery: { ballotVersion: 3, cell: b.cell, nullifier: b.nullifier, vote: b.vote },
  });
  const selected = (ballots: readonly Cast[]): CountedBallot[] =>
    ballots.map((b) => ({ entry: b.entry, tally: tallyOf(b) }));
  const inputs = (ballots: readonly Cast[], over: Partial<CountedInputs> = {}): CountedInputs => ({
    definition,
    definitionHash: hash,
    registered: REGISTERED,
    selected: selected(ballots),
    entries,
    boardEntryVersion: 5,
    extent: entries.length,
    eventsPass: false,
    clock: CLOCK,
    destruction: true,
    admitted: [],
    blocks: undefined,
    ...over,
  });
  /** Each ballot as admission admitted it from the board path: what 6.3 compares. */
  const admitted = (ballots: readonly Cast[]): CloseCandidate[] =>
    ballots.map((b) => ({
      entry: b.entry,
      path: "board",
      ballot: {
        tier: 0,
        nullifier: b.nullifier,
        message: sha256(b.hash),
        l1RefNumber: 1n,
        index: BigInt(b.entry),
      },
      tally: tallyOf(b),
    }));
  return { entries, board, receipt, deliver, opening, destruction, inputs, admitted };
}

const rows = (r: ReturnType<typeof countedChecks>) => Object.fromEntries(r.rows);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

describe("an honest election", () => {
  test("every registered seat's receipt delivers each ballot: 5.9 passes, and with nothing opened every cell is tally-missing", () => {
    const e = election();
    e.deliver([ALICE, BOB, CAROL], 200);
    const r = countedChecks(e.inputs([ALICE, BOB, CAROL]));
    expect(rows(r)).toEqual({
      "5.9": { status: "pass" },
      // No run of L1 headers, so L_δ isn't found (format 4).
      "6.3": { status: "unverifiable", code: "not-reached", at: {} },
      "7.1": { status: "pass" },
      "7.2": { status: "fail", code: "tally-missing", at: { cell: 0 } },
      "7.3": { status: "pass" },
      // Report-only (8.5): no seat stated destruction.
      "8.5": { status: "fail", code: "destruction-missing", at: { seat: 1 } },
    });
    expect(r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    // The vectors' ballots, by cell, each in the tier its cell is in.
    const inCell = (c: number) =>
      CAST.filter((b) => [ALICE, BOB, CAROL].includes(b) && b.cell === c);
    expect(
      r.cells?.map(({ cell, tier, counted, code }) => ({ cell, tier, counted, code })),
    ).toEqual(
      [0, 1, 2].map((cell) => ({
        cell,
        tier: cell < 2 ? 0 : 2,
        counted: inCell(cell).length,
        code: "tally-missing",
      })),
    );
    expect(r.tallyBreaks).toEqual(new Map());
  });

  test("the delivery records' order changes nothing (R3)", { timeout: 60_000 }, () => {
    const e = election();
    e.deliver([ALICE, BOB], 200);
    // Bob's seat 2 receipt, signed by seat 3: reported, delivers nothing.
    e.board(200, e.receipt(BOB, 2, 3));
    e.board(200, e.receipt(CAROL, 1));
    const records = [...e.entries];
    // Each record's verdict, without the entry it sits at.
    const verdicts = (r: ReturnType<typeof countedChecks>) =>
      (r.delivery?.records ?? [])
        .map((x) => JSON.stringify({ ...x, entry: undefined }))
        .sort(byText);
    const reference = countedChecks(e.inputs([ALICE, BOB, CAROL]));
    expect(reference.delivery?.excluded).toEqual([
      { entry: CAROL.entry, missing: [2, 3], complaints: [] },
    ]);
    fc.assert(
      fc.property(fc.shuffledSubarray(records, { minLength: records.length }), (order) => {
        const f = election();
        for (const encoded of order) f.board(200, decodeBoardEntry(encoded, 5).payload);
        const r = countedChecks(f.inputs([ALICE, BOB, CAROL]));
        expect(r.rows).toEqual(reference.rows);
        expect(r.delivery?.excluded).toEqual(reference.delivery?.excluded);
        expect(verdicts(r)).toEqual(verdicts(reference));
      }),
      { numRuns },
    );
  });
});

describe("delivery decides the counted set by the version-3 ballot hash", () => {
  test("a ballot without every registered seat's receipt is excluded, its missing seats named", () => {
    const e = election();
    e.deliver([ALICE], 200);
    for (const seat of [1, 3]) e.board(200, e.receipt(BOB, seat));
    const r = countedChecks(e.inputs([ALICE, BOB]));
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
    expect(r.delivery).toEqual({
      excluded: [{ entry: BOB.entry, missing: [2], complaints: [] }],
      records: [],
      rejected: [],
    });
  });

  test("a receipt over the ballot named in another cell, or by another nullifier, delivers nothing (T-38)", () => {
    for (const named of [
      { cell: ALICE.cell + 1, nullifier: ALICE.nullifier },
      { cell: ALICE.cell, nullifier: ALICE.nullifier + 1n },
    ]) {
      const e = election();
      for (const seat of [2, 3]) e.board(200, e.receipt(ALICE, seat));
      const other = ballotHashV3({ definitionHash: hash, ...named }, ALICE.vote);
      e.board(200, receiptFor(ALICE, 1, other));
      const r = countedChecks(e.inputs([ALICE]));
      expect(r.delivery?.excluded).toEqual([{ entry: ALICE.entry, missing: [1], complaints: [] }]);
    }
  });

  test("a board-path receipt counts up to s_D, is late after it, and above s_K's floor isn't read", () => {
    const outcome = (segment: number) => {
      const e = election();
      for (const seat of [1, 2]) e.board(200, e.receipt(ALICE, seat));
      const at = e.board(segment, e.receipt(ALICE, 3));
      return { r: countedChecks(e.inputs([ALICE])), at };
    };
    expect(outcome(S_D).r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    const late = outcome(S_D + 1);
    expect(late.r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [3], complaints: [] }],
      records: [{ entry: late.at, code: "delivery-late" }],
      rejected: [],
    });
    expect(outcome(S_K + 1).r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [3], complaints: [] }],
      records: [],
      rejected: [],
    });
  });

  test("a receipt signed by another seat is reported, attributed to no one, and delivers nothing", () => {
    const e = election();
    for (const seat of [1, 3]) e.board(200, e.receipt(ALICE, seat));
    const at = e.board(200, e.receipt(ALICE, 2, 3));
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [2], complaints: [] }],
      records: [{ entry: at, code: "share-receipt", signer: null }],
      rejected: [],
    });
  });

  test("a board-path complaint with no posting is void, and excludes nothing", () => {
    const e = election();
    e.deliver([ALICE], 200);
    const { proof } = decodeShareComplaint(recordOf("complaint"), 1);
    const at = e.board(
      200,
      encodeShareComplaint(
        signShareComplaint(secret(2), {
          definition_hash: hash,
          ballot_hash: ALICE.hash,
          seat: 2,
          proof,
        }),
      ),
    );
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery).toEqual({
      excluded: [],
      records: [{ entry: at, code: "complaint-void" }],
      rejected: [],
    });
  });

  test("a record naming another definition is stray", () => {
    const e = election();
    e.deliver([ALICE], 200);
    const at = e.board(200, recordOf("receipt"));
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery).toEqual({
      excluded: [],
      records: [{ entry: at, code: "delivery-stray" }],
      rejected: [],
    });
  });
});

describe("contract-path records under contract-event version 7, once 4.4 passes", () => {
  const T_D = d.closes_at + BigInt(d.l1_inclusion_bound) + BigInt(PARAMETERS.DELIVERY_WINDOW);
  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const topic0 = (name: string) => {
    const signature = CONTRACT_EVENT_SIGNATURES[7].board.find((x) => x.startsWith(`${name}(`));
    if (signature === undefined) throw new Error(`no board event ${name}`);
    return keccak_256(text(signature));
  };
  // `abi.encode(bytes)`, as every board event's data carries its record.
  const abiBytes = (record: Uint8Array) => {
    const out = new Uint8Array(64 + Math.ceil(record.length / 32) * 32);
    out[31] = 0x20;
    for (let i = 63, n = record.length; n > 0; i--, n = Math.floor(n / 256)) out[i] = n % 256;
    out.set(record, 64);
    return out;
  };
  /** The board's event `name` carrying `record`, emitted in an L2 block at `t`. */
  const event = (name: string, topics: readonly Uint8Array[], record: Uint8Array, t: bigint) => {
    const payload = encodeContractEvent(
      {
        contract: d.board,
        n: 0n,
        l2_block: 1n,
        l2_timestamp: t,
        topics: [topic0(name), ...topics],
        data: abiBytes(record),
      },
      7,
    );
    const checked = checkContractEvent(decodeContractEvent(payload, 7), contracts, 7);
    if (!checked.ok || checked.event.event !== name) throw new Error(`fixture: ${name} fails`);
    return payload;
  };

  test("a receipt through the contract path delivers by its submission time, up to t_D", () => {
    const outcome = (t: bigint) => {
      const e = election();
      for (const seat of [1, 2]) e.board(200, e.receipt(ALICE, seat));
      const at = e.board(
        200,
        event("ShareReceiptSubmitted", [hash, ALICE.hash], e.receipt(ALICE, 3), t),
      );
      return { r: countedChecks(e.inputs([ALICE], { eventsPass: true, destruction: false })), at };
    };
    expect(outcome(T_D).r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    const late = outcome(T_D + 1n);
    expect(late.r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [3], complaints: [] }],
      records: [{ entry: late.at, code: "delivery-late" }],
      rejected: [],
    });
  });

  test("a contract-path record still waits on 4.4", () => {
    const e = election();
    e.deliver([ALICE], 200);
    const at = e.board(
      200,
      event("ShareReceiptSubmitted", [hash, ALICE.hash], e.receipt(ALICE, 1), T_D),
    );
    const r = countedChecks(e.inputs([ALICE], { eventsPass: false, destruction: false }));
    for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3"])
      expect(r.rows.get(id)).toEqual({
        status: "unverifiable",
        code: "not-reached",
        at: { entry: at },
      });
  });
});

describe("6.3 under definition version 5", () => {
  // L_δ is the last block at or before closes_at + δ (an hour): the second.
  const blocks = run(21_000_000n, [OPENS - 3612n, d.closes_at + 3600n, d.closes_at + 3612n]);
  const lDelta = blocks[1] as TestHeader;
  // Board-entry version 5 carries close statements; s_C = 168 + 1 + 48 = 217.
  const S_C = 217;
  const close = (signer: number, claim: bigint) =>
    encodeCloseStatement(
      signCloseStatement(secret(signer), {
        definition_hash: hash,
        signer,
        l1_number: lDelta.number,
        l1_hash: lDelta.hash,
        l2_number: claim,
        l2_hash: sha256(text(`l2 ${claim}`)),
      }),
    );

  test("the close check runs over version 3's ballot hashes, and with no late ordinary ballot passes", () => {
    const e = election();
    e.deliver([ALICE, BOB], 200);
    for (const seat of SEATS) e.board(S_C, close(seat, 900n));
    const r = countedChecks(
      e.inputs([ALICE, BOB], {
        destruction: false,
        admitted: e.admitted([ALICE, BOB]),
        blocks: blocks.map((h) => decodeHeader(h.encoded)),
      }),
    );
    expect(r.rows.get("6.3")).toEqual({ status: "pass" });
    expect(r.close).toMatchObject({ head: "900", late: [] });
    expect(r.close?.seats.map((s) => s.code)).toEqual([
      "close-counted",
      "close-counted",
      "close-counted",
    ]);
  });
});

describe("the tally over the questions (7.1 to 7.4, 8.5)", () => {
  // Flat options: question 0 is 0 to 2, question 1 is 3 to 6, question 2 is 7 and 8.
  const e = election();
  const a = cast(0, [1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const b = cast(0, [0, 0, 0, 0, 1, 0, 0, 0, 1]);
  const c = cast(1, [0, 1, 0, 0, 0, 0, 1, 1, 0]);
  const g = cast(2, [0, 0, 1, 1, 0, 1, 0, 0, 1]);
  e.deliver([a, b, c, g], 200);
  e.board(300, e.opening(0, [a, b], 1));
  e.board(300, e.opening(1, [c], 2));
  e.board(300, e.opening(2, [g], 3));
  const statements = SEATS.map((seat) => e.board(301, e.destruction(seat)));
  const r = countedChecks(e.inputs([a, b, c, g]));

  test("every row passes, and each cell's counts are the votes cast in it", () => {
    expect(rows(r)).toEqual({
      "5.9": { status: "pass" },
      "6.3": { status: "unverifiable", code: "not-reached", at: {} },
      "7.1": { status: "pass" },
      "7.2": { status: "pass" },
      "7.3": { status: "pass" },
      "8.5": { status: "pass" },
    });
    expect(r.cells).toEqual([
      {
        cell: 0,
        tier: 0,
        counted: 2,
        counts: ["1", "0", "0", "1", "2", "0", "0", "1", "1"],
        signers: [1],
      },
      {
        cell: 1,
        tier: 0,
        counted: 1,
        counts: ["0", "1", "0", "0", "0", "0", "1", "1", "0"],
        signers: [2],
      },
      {
        cell: 2,
        tier: 2,
        counted: 1,
        counts: ["0", "0", "1", "1", "0", "1", "0", "0", "1"],
        signers: [3],
      },
    ]);
    // Tier 0's result is its two cells' sum, derived, never opened.
    expect(r.tiers).toEqual([
      { tier: 0, counted: 3, counts: ["1", "1", "0", "1", "2", "0", "1", "2", "1"] },
      { tier: 2, counted: 1, counts: ["0", "0", "1", "1", "0", "1", "0", "0", "1"] },
    ]);
    expect(r.tallyBreaks).toEqual(new Map());
    expect(r.destruction).toEqual({
      earliest: 301,
      latest: 301,
      seats: statements.map((entry, i) => ({ seat: i + 1, code: "destroyed", entry })),
      duplicates: [],
      unattributed: [],
      stray: [],
      rejected: [],
    });
  });

  test("an opening over a ballot delivery excluded is over another set", () => {
    const f = election();
    f.deliver([a, c, g], 200);
    // Seat 3 never receipted `b`.
    for (const seat of [1, 2]) f.board(200, f.receipt(b, seat));
    const wrong = f.board(300, f.opening(0, [a, b], 1));
    f.board(300, f.opening(1, [c], 2));
    f.board(300, f.opening(2, [g], 3));
    const got = countedChecks(f.inputs([a, b, c, g], { destruction: false }));
    expect(got.delivery?.excluded).toEqual([{ entry: b.entry, missing: [3], complaints: [] }]);
    expect(got.rows.get("7.2")).toEqual({ status: "fail", code: "tally-opening", at: { cell: 0 } });
    expect(got.cells?.[0]).toEqual({
      cell: 0,
      tier: 0,
      counted: 1,
      code: "tally-opening",
      signers: [],
    });
    // A tier with a failing cell has no derived result.
    expect(got.tiers?.[0]).toEqual({ tier: 0, counted: 2 });
    expect(got.tallyBreaks).toEqual(new Map([[wrong, { code: "tally-aggregate" }]]));
    // The opening over the counted set passes.
    f.board(301, f.opening(0, [a], 2));
    const fixed = countedChecks(f.inputs([a, b, c, g], { destruction: false }));
    expect(fixed.rows.get("7.2")).toEqual({ status: "pass" });
    expect(fixed.cells?.[0]).toMatchObject({
      counts: ["1", "0", "0", "1", "1", "0", "0", "1", "0"],
    });
  });

  test("an opening that doesn't open an option fails 7.2 at that option", () => {
    const f = election();
    f.deliver([a, c, g], 200);
    const bad = f.board(
      300,
      f.opening(0, [a], 1, (o) => o.map((x, j) => (j === 4 ? { ...x, v: x.v + 1n } : x))),
    );
    f.board(300, f.opening(1, [c], 2));
    f.board(300, f.opening(2, [g], 3));
    const got = countedChecks(f.inputs([a, c, g], { destruction: false }));
    expect(got.rows.get("7.2")).toEqual({
      status: "fail",
      code: "tally-opening",
      at: { cell: 0, option: 4 },
    });
    expect(got.tallyBreaks).toEqual(new Map([[bad, { code: "tally-opening", option: 4 }]]));
  });
});
