import { readFileSync } from "node:fs";
import {
  aggregateCell,
  aggregateHash,
  batchShareComplaintsV2,
  batchShareReceiptsV2,
  type AnchorClock,
  ballotHashV4,
  checkContractEvent,
  type CommittedVoteV4,
  CONTRACT_EVENT_SIGNATURES,
  decode,
  decodeBallot,
  decodeBoardEntry,
  decodeContractEvent,
  decodeShareComplaint,
  deliveryDeadlines,
  deliverySegments,
  encodeBoardEntry,
  encodeCloseStatement,
  encodeContractEvent,
  encodeDestructionStatement,
  encodeElectionDefinitionV6,
  encodeShareComplaintBatchV2,
  encodeShareComplaintV2,
  encodeShareReceiptBatchV2,
  encodeShareReceipt,
  encodeShareReceiptV2,
  encodeTallyOpening,
  identityKey,
  KEM_PUBLIC_KEY,
  openCell,
  PARAMETERS,
  pinnedVersion,
  profileCombinationRule,
  proveValidityV4,
  type QuestionRules,
  RECORD_TYPES,
  type RegisteredKeys,
  type SeatPanel,
  type Share,
  shareReceiptRecord,
  shareReceiptRecordV2,
  shareReceiptStatement,
  shareReceiptStatementV4,
  shareVoteV4,
  signCloseStatement,
  signDestructionStatement,
  signShareComplaintV2,
  signStatement,
  signTallyOpening,
  sumShares,
  tallyRules,
  type VoteSharingV4,
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

// Delivery (5.9) under definition version 6 without an author panel, whose
// ballots are version 4 and whose delivery records are version 2: the check
// runs over every qualified seat of both panels, each record against its own
// panel's share hashes and key set, so a record naming the author panel of a
// poll without one delivers nothing (docs/spec/verifier.md, Counted set and
// tally, step 3; docs/spec/delivery.md, Delivery check (version 2); T-37).
// 6.3 rides on the same delivery, and the tally (7.1 to 7.4's counted-set
// breaks, 8.5) opens each cell's default halves under tally-opening version
// 1, which without an author panel are the whole sharing (docs/spec/tally.md,
// Context). The delivery ballots are verifier-ballots-v4.json's `admitted`
// case (packages/crypto/scripts/verifier-ballots-v4-vectors.py, an
// independent implementation); the tally's are cast here under its
// definition with @abolishus/crypto's client path (`shareVoteV4`,
// `proveValidityV4`), since the vectors' sharings aren't published, and the
// expected counts are the votes cast. The seats' signing keys are this
// test's own, and the receipts, complaints, openings and destruction
// statements are made with @abolishus/crypto's trustee paths (`sumShares`,
// `openCell`), never with the checks under test. delivery-v2.json gives a
// complaint proof, which only has to decode here.

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
const ballotsFile = read("verifier-ballots-v4.json") as { readonly cases: readonly Case[] };
const caseOf = (id: string) => {
  const c = ballotsFile.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const deliveryFile = read("delivery-v2.json") as {
  readonly seats: { readonly default: readonly { readonly kemKey: string }[] };
  readonly records: readonly { readonly id: string; readonly encoding: string }[];
};
const KEM = decode(
  KEM_PUBLIC_KEY,
  hex((deliveryFile.seats.default[0] as { readonly kemKey: string }).kemKey),
);
const recordOf = (id: string) => {
  const r = deliveryFile.records.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no record ${id}`);
  return hex(r.encoding);
};

const DEFAULT: SeatPanel = 1;
const AUTHOR: SeatPanel = 2;

// Seats 1 to 3 of the vectors' 3-of-4 default panel (seat 4 sent nothing at
// the ceremony, so the ballots carry zeros there), with signing keys of the
// test's own.
const SEATS = [1, 2, 3];
const SECRETS = [1, 2, 3, 4].map((i) => sha256(text(`counted-v4.test seat ${i}`)));
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
const d = definition.value as Extract<VerifiedDefinition, { version: 6 }>["value"];
const { hash } = readDefinition(definition);

test("the fixture's definition is version 6, sealed, without an author panel, on the test's clock", () => {
  expect(definition.version).toBe(6);
  expect(d.author_keys).toEqual([]);
  expect(d.panel_size).toBe(4);
  expect(d.closes_at).toBe(OPENS + 168n * 3600n);
  const segments = deliverySegments(CLOCK, d.closes_at, BigInt(d.l1_inclusion_bound));
  expect(segments).toEqual({ delivery: BigInt(S_D), complaint: BigInt(S_K) });
});

interface Cast {
  readonly entry: number;
  readonly cell: number;
  readonly nullifier: bigint;
  readonly vote: CommittedVoteV4;
  readonly hash: Uint8Array;
  /** The sharing, for a ballot cast here: the trustees' summed shares come from it. */
  readonly sharing?: VoteSharingV4;
}

/** The `admitted` case's ballots, in copy order, with their entries on that board. */
const CAST: readonly Cast[] = (() => {
  const { entries } = splitEntries(hex(admittedCase.board));
  return entries.flatMap((encoded, entry) => {
    const { payload } = decodeBoardEntry(encoded, 5);
    if (((payload[0] as number) << 8) + (payload[1] as number) !== RECORD_TYPES.ballot) return [];
    const b = decodeBallot(payload, 4);
    const ctx = { definitionHash: hash, cell: b.cell, nullifier: b.nullifier };
    return [
      {
        entry,
        cell: b.cell,
        nullifier: b.nullifier,
        vote: b.committed_vote,
        hash: ballotHashV4(ctx, b.committed_vote),
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

/** A version-4 ballot in `cell` with these flat votes, admitted and selected elsewhere in the copy (its `entry` is a stand-in). */
function cast(cell: number, votes: readonly (0 | 1)[]): Cast {
  const nullifier = nextNullifier++;
  const rules = {
    questions: RULES.questions as readonly QuestionRules[],
    threshold: RULES.threshold,
    panelSize: RULES.panelSize,
    authorThreshold: 0,
    authorPanelSize: 0,
  };
  const sharing = shareVoteV4(rules, votes);
  // A seat outside the registered key set gets 32 zero bytes (delivery.md, Notes).
  const shareHashes = Array.from({ length: RULES.panelSize }, (_, i) =>
    SEATS.includes(i + 1) ? sha256(text(`share ${nullifier} ${i + 1}`)) : new Uint8Array(32),
  );
  const ctx = { ...rules, definitionHash: hash, cell, nullifier };
  const vote = proveValidityV4(ctx, sharing, shareHashes, []);
  return {
    entry: nextEntry++,
    cell,
    nullifier,
    vote,
    hash: ballotHashV4({ definitionHash: hash, cell, nullifier }, vote),
    sharing,
  };
}

/** The definition a copy is of, and its hash. */
interface Fixture {
  readonly definition: VerifiedDefinition;
  readonly hash: Uint8Array;
}

/** One copy of the election: the board the test fills, and what `countedChecks` takes. */
function election(f: Fixture = { definition, hash }) {
  const { hash } = f;
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
  /** Seat `seat` of `panel`'s version-2 receipt for `b`, signed by `signer`'s key. */
  const receipt = (b: Cast, seat: number, panel: SeatPanel = DEFAULT, signer = seat) => {
    const hashes = panel === DEFAULT ? b.vote.share_hashes : b.vote.author_share_hashes;
    const shareHash = hashes[seat - 1] ?? sha256(text(`no share ${seat}`));
    const m = shareReceiptStatementV4({
      definition_hash: hash,
      ballot_hash: b.hash,
      panel,
      seat,
      share_hash: shareHash,
    });
    return encodeShareReceiptV2(
      shareReceiptRecordV2(hash, seat, {
        panel,
        ballotHash: b.hash,
        shareHash,
        receipt: signStatement(secret(signer), "abolish/v1/sig/share-receipt-2", m),
      }),
    );
  };
  /** Every registered default seat's receipt for each ballot, boarded in `segment`. */
  const deliver = (ballots: readonly Cast[], segment: number) => {
    for (const b of ballots) for (const seat of SEATS) board(segment, receipt(b, seat));
  };
  /** Cell `cell`'s honest opening over `counted`'s default halves, combined by seats 1 to k and signed by `signer`. */
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
    deliveryV4: { cell: b.cell, nullifier: b.nullifier, vote: b.vote },
  });
  const selected = (ballots: readonly Cast[]): CountedBallot[] =>
    ballots.map((b) => ({ entry: b.entry, tally: tallyOf(b) }));
  const inputs = (ballots: readonly Cast[], over: Partial<CountedInputs> = {}): CountedInputs => ({
    definition: f.definition,
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
  test("every default seat's receipt delivers each ballot: 5.9 passes, and with nothing opened every cell is tally-missing", () => {
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

  test("under a board-entry version without destruction statements, 8.5 is left to the caller", () => {
    const e = election();
    const r = countedChecks(e.inputs([], { destruction: false }));
    expect(r.rows.has("8.5")).toBe(false);
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
  });

  test("the delivery records' order changes nothing (R3)", { timeout: 60_000 }, () => {
    const e = election();
    e.deliver([ALICE, BOB], 200);
    // Bob's seat 2 receipt, signed by seat 3: reported, delivers nothing.
    e.board(200, e.receipt(BOB, 2, DEFAULT, 3));
    e.board(200, e.receipt(CAROL, 1, AUTHOR));
    const records = [...e.entries];
    // Each record's verdict, without the entry it sits at.
    const verdicts = (r: ReturnType<typeof countedChecks>) =>
      (r.delivery?.records ?? [])
        .map((x) => JSON.stringify({ ...x, entry: undefined }))
        .sort(byText);
    const reference = countedChecks(e.inputs([ALICE, BOB, CAROL]));
    // Carol has no default seat's receipt; Bob's forged one changes nothing.
    expect(reference.delivery?.excluded).toEqual([
      {
        entry: CAROL.entry,
        missing: SEATS.map((seat) => ({ panel: DEFAULT, seat })),
        complaints: [],
      },
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

describe("delivery decides the counted set, per panel and seat", () => {
  test("a ballot without every registered default seat's receipt is excluded, its missing seats named by panel", () => {
    const e = election();
    e.deliver([ALICE], 200);
    for (const seat of [1, 3]) e.board(200, e.receipt(BOB, seat));
    const r = countedChecks(e.inputs([ALICE, BOB]));
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
    expect(r.delivery).toEqual({
      excluded: [{ entry: BOB.entry, missing: [{ panel: DEFAULT, seat: 2 }], complaints: [] }],
      records: [],
      rejected: [],
    });
  });

  test("a seat outside the registered key set needs no receipt: seat 4 sent nothing", () => {
    const e = election();
    e.deliver([ALICE], 200);
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery?.excluded).toEqual([]);
  });

  test("a receipt naming the author panel's seat delivers nothing, in a poll without an author panel (T-37)", () => {
    const e = election();
    for (const seat of [2, 3]) e.board(200, e.receipt(ALICE, seat));
    // Author seat 1 is outside the empty author key set; default seat 1 is
    // still owed.
    const at = e.board(200, e.receipt(ALICE, 1, AUTHOR));
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [{ panel: DEFAULT, seat: 1 }], complaints: [] }],
      records: [{ entry: at, code: "delivery-seat", panel: AUTHOR, seat: 1 }],
      rejected: [],
    });
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
      excluded: [{ entry: ALICE.entry, missing: [{ panel: DEFAULT, seat: 3 }], complaints: [] }],
      records: [{ entry: late.at, code: "delivery-late", panel: DEFAULT, seat: 3 }],
      rejected: [],
    });
    expect(outcome(S_K + 1).r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [{ panel: DEFAULT, seat: 3 }], complaints: [] }],
      records: [],
      rejected: [],
    });
  });

  test("a receipt signed by another seat is reported, attributed to no one, and delivers nothing", () => {
    const e = election();
    for (const seat of [1, 3]) e.board(200, e.receipt(ALICE, seat));
    const at = e.board(200, e.receipt(ALICE, 2, DEFAULT, 3));
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [{ panel: DEFAULT, seat: 2 }], complaints: [] }],
      records: [{ entry: at, code: "share-receipt", panel: DEFAULT, seat: 2, signer: null }],
      rejected: [],
    });
  });

  test("a version-1 receipt is a rejected entry under ballot version 4, and delivers nothing", () => {
    const e = election();
    for (const seat of [1, 2]) e.board(200, e.receipt(ALICE, seat));
    const shareHash = ALICE.vote.share_hashes[2] as Uint8Array;
    const m = shareReceiptStatement({
      definition_hash: hash,
      ballot_hash: ALICE.hash,
      seat: 3,
      share_hash: shareHash,
    });
    const at = e.board(
      200,
      encodeShareReceipt(
        shareReceiptRecord(hash, 3, {
          ballotHash: ALICE.hash,
          shareHash,
          receipt: signStatement(secret(3), "abolish/v1/sig/share-receipt", m),
        }),
      ),
    );
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [{ panel: DEFAULT, seat: 3 }], complaints: [] }],
      records: [],
      rejected: [{ entry: at, decodeError: "profile-mismatch" }],
    });
  });

  test("a board-path complaint with no posting is void, reported with its panel and seat, and excludes nothing", () => {
    const e = election();
    e.deliver([ALICE], 200);
    const { proof } = decodeShareComplaint(recordOf("complaint-default"), 2);
    const at = e.board(
      200,
      encodeShareComplaintV2(
        signShareComplaintV2(secret(2), {
          definition_hash: hash,
          ballot_hash: ALICE.hash,
          panel: DEFAULT,
          seat: 2,
          proof,
        }),
      ),
    );
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery).toEqual({
      excluded: [],
      records: [{ entry: at, code: "complaint-void", panel: DEFAULT, seat: 2 }],
      rejected: [],
    });
  });

  test("a record naming another definition is stray, with the panel and seat it names", () => {
    const e = election();
    e.deliver([ALICE], 200);
    const at = e.board(200, recordOf("receipt-default"));
    const r = countedChecks(e.inputs([ALICE]));
    expect(r.delivery).toEqual({
      excluded: [],
      records: [{ entry: at, code: "delivery-stray", panel: DEFAULT, seat: 1 }],
      rejected: [],
    });
  });
});

describe("contract-path records under contract-event version 8, once 4.4 passes", () => {
  // The fixture's definition pins version 9; this one pins version 8, which
  // frames no version-2 delivery record. 2.3 fails such a profile, and 5.9
  // still reads what its board holds (docs/spec/verifier.md, 2.3; T-25, T-53).
  const pins8 = d.profile.pins.map((p) =>
    p.record_type === RECORD_TYPES.contractEvent ? { ...p, version: 8 } : p,
  );
  const definition8 = decodeDefinition(
    encodeElectionDefinitionV6({ ...d, profile: { ...d.profile, pins: pins8 } }),
  );
  const f8 = { definition: definition8, hash: readDefinition(definition8).hash };
  const alice: Cast = {
    ...ALICE,
    hash: ballotHashV4(
      { definitionHash: f8.hash, cell: ALICE.cell, nullifier: ALICE.nullifier },
      ALICE.vote,
    ),
  };
  const T_D = d.closes_at + BigInt(d.l1_inclusion_bound) + BigInt(PARAMETERS.DELIVERY_WINDOW);
  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const topic0 = (name: string) => {
    const signature = CONTRACT_EVENT_SIGNATURES[8].board.find((x) => x.startsWith(`${name}(`));
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
  const word = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
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
      8,
    );
    const checked = checkContractEvent(decodeContractEvent(payload, 8), contracts, 8);
    if (!checked.ok || checked.event.event !== name) throw new Error(`fixture: ${name} fails`);
    return payload;
  };
  const roots = read("delivery-root.json") as {
    readonly records: readonly { readonly encoding: string }[];
  };
  /** delivery-root.json's first root renamed to this definition: version 1, which ballot version 4 doesn't fix. */
  const root = (t: bigint) => {
    const record = hex((roots.records[0] as { readonly encoding: string }).encoding);
    record.set(f8.hash, 3);
    return event("ObligationRootSubmitted", [f8.hash, word(record[35] as number)], record, t);
  };

  test("an obligation root naming this definition is a rejected entry, never a hold on 5.9", () => {
    const e = election(f8);
    e.deliver([alice], 200);
    const at = e.board(200, root(T_D));
    const r = countedChecks(e.inputs([alice], { eventsPass: true, destruction: false }));
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
    expect(r.delivery).toEqual({
      excluded: [],
      records: [],
      rejected: [{ entry: at, decodeError: "profile-mismatch" }],
    });
  });

  test("one above the floor isn't read, and holds nothing open, whenever it was sent", () => {
    const e = election(f8);
    e.deliver([alice], 200);
    e.board(S_K + 1, root(T_D));
    const r = countedChecks(e.inputs([alice], { eventsPass: true, destruction: false }));
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
    expect(r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
  });

  test("a contract-path record still waits on 4.4", () => {
    const e = election(f8);
    e.deliver([alice], 200);
    const at = e.board(200, root(T_D));
    const r = countedChecks(e.inputs([alice], { eventsPass: false, destruction: false }));
    for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3"])
      expect(r.rows.get(id)).toEqual({
        status: "unverifiable",
        code: "not-reached",
        at: { entry: at },
      });
  });

  test("a version-1 receipt through the contract path is a rejected entry, and delivers nothing", () => {
    const e = election(f8);
    for (const seat of [1, 2]) e.board(200, e.receipt(alice, seat));
    const shareHash = alice.vote.share_hashes[2] as Uint8Array;
    const m = shareReceiptStatement({
      definition_hash: f8.hash,
      ballot_hash: alice.hash,
      seat: 3,
      share_hash: shareHash,
    });
    const v1 = encodeShareReceipt(
      shareReceiptRecord(f8.hash, 3, {
        ballotHash: alice.hash,
        shareHash,
        receipt: signStatement(secret(3), "abolish/v1/sig/share-receipt", m),
      }),
    );
    const at = e.board(200, event("ShareReceiptSubmitted", [f8.hash, alice.hash], v1, T_D));
    const r = countedChecks(e.inputs([alice], { eventsPass: true, destruction: false }));
    expect(r.delivery).toEqual({
      excluded: [{ entry: alice.entry, missing: [{ panel: DEFAULT, seat: 3 }], complaints: [] }],
      records: [],
      rejected: [{ entry: at, decodeError: "profile-mismatch" }],
    });
  });
});

describe.each([9, 10, 11, 12] as const)(
  "contract-path records under contract-event version %i, once 4.4 passes",
  (version) => {
    // Versions 9 to 12 frame the version-2 delivery records ballot version 4 fixes,
    // so a single one through the contract path delivers or excludes as a
    // board-path one does, judged by its L2 timestamp, and so does each pair
    // or entry of a version-2 batch, reported with its index; a version-2 root
    // may deliver or exclude any ballot of its panel by leaves 5.9 doesn't read
    // yet, so it leaves the rows undecided (docs/spec/verifier.md, Counted set
    // and tally, steps 2 and 3; P2-16 parts 5d-3c-1 and 5d-3c-2; T-25, T-53).
    const pins9 = d.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.contractEvent ? { ...p, version } : p,
    );
    const definition9 = decodeDefinition(
      encodeElectionDefinitionV6({ ...d, profile: { ...d.profile, pins: pins9 } }),
    );
    const f9 = { definition: definition9, hash: readDefinition(definition9).hash };
    const { delivery: T_D, complaint: T_K } = deliveryDeadlines(
      d.closes_at,
      BigInt(d.l1_inclusion_bound),
    );
    // The `admitted` case's ballots, hashed under this definition: delivery
    // reads their hashes, never their proofs.
    const under9 = (b: Cast): Cast => ({
      ...b,
      hash: ballotHashV4({ definitionHash: f9.hash, cell: b.cell, nullifier: b.nullifier }, b.vote),
    });
    const alice = under9(ALICE);
    const contracts = {
      electionRegistry: d.election_registry,
      trusteeRegistry: d.trustee_registry,
      groupRegistry: d.group_registry,
      board: d.board,
    };
    const topic0 = (name: string) => {
      const signature = CONTRACT_EVENT_SIGNATURES[version].board.find((x) =>
        x.startsWith(`${name}(`),
      );
      if (signature === undefined) throw new Error(`no board event ${name}`);
      return keccak_256(text(signature));
    };
    const abiBytes = (record: Uint8Array) => {
      const out = new Uint8Array(64 + Math.ceil(record.length / 32) * 32);
      out[31] = 0x20;
      for (let i = 63, n = record.length; n > 0; i--, n = Math.floor(n / 256)) out[i] = n % 256;
      out.set(record, 64);
      return out;
    };
    const word = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
    /** The board's event `name` carrying `record` under `version`, emitted in an L2 block at `t`. */
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
        version,
      );
      const checked = checkContractEvent(decodeContractEvent(payload, version), contracts, version);
      if (!checked.ok || checked.event.event !== name) throw new Error(`fixture: ${name} fails`);
      return payload;
    };
    const receiptEvent = (e: ReturnType<typeof election>, seat: number, t: bigint) =>
      event("ShareReceiptSubmitted", [f9.hash, alice.hash], e.receipt(alice, seat), t);
    const batches = read("delivery-batch-v2.json") as {
      readonly records: readonly { readonly id: string; readonly encoding: string }[];
    };
    /** delivery-batch-v2.json's record `id` renamed to this definition, under its event. */
    const batch = (id: string, name: string, t: bigint) => {
      const r = batches.records.find((x) => x.id === id);
      if (r === undefined) throw new Error(`no record ${id}`);
      const record = hex(r.encoding);
      record.set(f9.hash, 3);
      return event(name, [f9.hash, word(record[36] as number)], record, t);
    };
    const run = (e: ReturnType<typeof election>, eventsPass = true) =>
      countedChecks(e.inputs([alice], { eventsPass, destruction: false }));
    const undecided = (r: ReturnType<typeof countedChecks>, at: number) => {
      for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3"])
        expect(r.rows.get(id), id).toEqual({
          status: "unverifiable",
          code: "not-implemented",
          at: { entry: at },
        });
    };

    test("the fixture pins its contract-event version, and 2.3's combination lets it", () => {
      expect(definition9.version).toBe(6);
      expect(pinnedVersion(definition9.value, RECORD_TYPES.contractEvent)).toBe(version);
      expect(profileCombinationRule(definition9.value as typeof d)).toBeUndefined();
      // The fixture's own definition pins version 9; every other is another definition.
      expect(Buffer.from(f9.hash).equals(hash)).toBe(version === 9);
    });

    test("a version-2 receipt through the contract path delivers, in time by its L2 timestamp", () => {
      const e = election(f9);
      for (const seat of [1, 2]) e.board(200, e.receipt(alice, seat));
      e.board(200, receiptEvent(e, 3, T_D));
      const r = run(e);
      expect(r.rows.get("5.9")).toEqual({ status: "pass" });
      expect(r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    });

    test("one sent after t_D is late, whatever segment boarded it, and excludes the ballot", () => {
      const e = election(f9);
      for (const seat of [1, 2]) e.board(200, e.receipt(alice, seat));
      const at = e.board(200, receiptEvent(e, 3, T_D + 1n));
      expect(run(e).delivery).toEqual({
        excluded: [{ entry: alice.entry, missing: [{ panel: DEFAULT, seat: 3 }], complaints: [] }],
        records: [{ entry: at, code: "delivery-late", panel: DEFAULT, seat: 3 }],
        rejected: [],
      });
    });

    test("a version-2 record waits on 4.4", () => {
      const e = election(f9);
      e.deliver([alice], 200);
      const at = e.board(200, receiptEvent(e, 3, T_D));
      for (const [id, o] of run(e, false).rows)
        expect(o, id).toEqual({ status: "unverifiable", code: "not-reached", at: { entry: at } });
    });

    test("above the floor a version-2 record sent by t_K holds the rows open, one sent after it doesn't", () => {
      const held = election(f9);
      held.deliver([alice], 200);
      const at = held.board(S_K + 1, receiptEvent(held, 3, T_K));
      undecided(run(held), at);
      const late = election(f9);
      late.deliver([alice], 200);
      late.board(S_K + 1, receiptEvent(late, 3, T_K + 1n));
      expect(run(late).rows.get("5.9")).toEqual({ status: "pass" });
      expect(run(late).delivery).toEqual({ excluded: [], records: [], rejected: [] });
    });

    test("above the floor a version-1 record isn't read: it delivers nothing wherever it sits", () => {
      const e = election(f9);
      e.deliver([alice], 200);
      const shareHash = alice.vote.share_hashes[2] as Uint8Array;
      const m = shareReceiptStatement({
        definition_hash: f9.hash,
        ballot_hash: alice.hash,
        seat: 3,
        share_hash: shareHash,
      });
      const v1 = encodeShareReceipt(
        shareReceiptRecord(f9.hash, 3, {
          ballotHash: alice.hash,
          shareHash,
          receipt: signStatement(secret(3), "abolish/v1/sig/share-receipt", m),
        }),
      );
      e.board(S_K + 1, event("ShareReceiptSubmitted", [f9.hash, alice.hash], v1, T_D));
      expect(run(e).rows.get("5.9")).toEqual({ status: "pass" });
      expect(run(e).delivery).toEqual({ excluded: [], records: [], rejected: [] });
    });

    test("a version-2 root leaves the rows undecided, whichever panel it names", () => {
      for (const id of ["receipt-root-default", "receipt-root-author"] as const) {
        const e = election(f9);
        e.deliver([alice], 200);
        const at = e.board(200, batch(id, "ObligationRootSubmitted", T_D));
        undecided(run(e), at);
      }
    });

    /** Seat `seat` of `panel`'s version-2 receipt batch for `ballots`, signed by `signer`'s key, under its event at `t`. */
    const receiptBatch = (
      ballots: readonly Cast[],
      panel: SeatPanel,
      seat: number,
      t: bigint,
      signer = seat,
    ) => {
      const [b] = batchShareReceiptsV2(
        secret(signer),
        f9.hash,
        panel,
        seat,
        ballots
          .map((x) => ({
            ballot_hash: x.hash,
            share_hash:
              (panel === DEFAULT ? x.vote.share_hashes : x.vote.author_share_hashes)[seat - 1] ??
              new Uint8Array(32),
          }))
          .sort((x, y) => Buffer.compare(x.ballot_hash, y.ballot_hash)),
      );
      if (b === undefined) throw new Error("fixture: no batch");
      return event(
        "ShareReceiptBatchSubmitted",
        [f9.hash, word(seat)],
        encodeShareReceiptBatchV2(b),
        t,
      );
    };
    // A ballot hash no selected ballot has, so its pair decides nothing.
    const elsewhere: Cast = {
      ...alice,
      hash: sha256(text("counted-v4.test a ballot not selected")),
    };

    test("a version-2 receipt batch delivers its seat for every ballot it pairs, in time by its L2 timestamp", () => {
      const e = election(f9);
      for (const seat of [1, 2]) e.board(200, e.receipt(alice, seat));
      e.board(200, receiptBatch([alice, elsewhere], DEFAULT, 3, T_D));
      const r = run(e);
      expect(r.rows.get("5.9")).toEqual({ status: "pass" });
      expect(r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    });

    test("a batch's failing pair is reported with its index in the batch, its panel and seat", () => {
      const pairOf = (ballots: readonly Cast[]) =>
        [...ballots]
          .sort((x, y) => Buffer.compare(x.hash, y.hash))
          .findIndex((x) => x.hash === alice.hash);
      const both = [alice, elsewhere];
      for (const [make, code, signer] of [
        // Signed by seat 2's key: it doesn't verify under seat 3's, so no one's.
        [(t: bigint) => receiptBatch(both, DEFAULT, 3, t, 2), "share-receipt", null],
        [(t: bigint) => receiptBatch(both, DEFAULT, 3, t + 1n), "delivery-late", undefined],
      ] as const) {
        const e = election(f9);
        for (const seat of [1, 2]) e.board(200, e.receipt(alice, seat));
        const at = e.board(200, make(T_D));
        expect(run(e).delivery, code).toEqual({
          excluded: [
            { entry: alice.entry, missing: [{ panel: DEFAULT, seat: 3 }], complaints: [] },
          ],
          records: [
            {
              entry: at,
              pair: pairOf(both),
              code,
              panel: DEFAULT,
              seat: 3,
              ...(signer !== undefined && { signer }),
            },
          ],
          rejected: [],
        });
      }
    });

    test("an author seat's batch without an author panel is delivery-seat at its pair and delivers nothing", () => {
      const e = election(f9);
      e.deliver([alice], 200);
      const at = e.board(200, receiptBatch([alice], AUTHOR, 1, T_D));
      expect(run(e).delivery).toEqual({
        excluded: [],
        records: [{ entry: at, pair: 0, code: "delivery-seat", panel: AUTHOR, seat: 1 }],
        rejected: [],
      });
    });

    test("a version-2 complaint batch's entry with no posting is void at its index and excludes nothing", () => {
      const { proof } = decodeShareComplaint(recordOf("complaint-default"), 2);
      const entries = [alice, elsewhere]
        .map((x) => ({ ballot_hash: x.hash, proof }))
        .sort((x, y) => Buffer.compare(x.ballot_hash, y.ballot_hash));
      const [b] = batchShareComplaintsV2(secret(2), f9.hash, DEFAULT, 2, entries);
      if (b === undefined) throw new Error("fixture: no batch");
      const e = election(f9);
      e.deliver([alice], 200);
      const at = e.board(
        200,
        event(
          "ShareComplaintBatchSubmitted",
          [f9.hash, word(2)],
          encodeShareComplaintBatchV2(b),
          T_D,
        ),
      );
      const r = run(e);
      expect(r.rows.get("5.9")).toEqual({ status: "pass" });
      expect(r.delivery).toEqual({
        excluded: [],
        records: [
          {
            entry: at,
            pair: entries.findIndex((x) => x.ballot_hash === alice.hash),
            code: "complaint-void",
            panel: DEFAULT,
            seat: 2,
          },
        ],
        rejected: [],
      });
    });

    test("the vectors' batches, renamed to this definition, pair no selected ballot and decide nothing", () => {
      for (const [id, name] of [
        ["receipt-batch-default", "ShareReceiptBatchSubmitted"],
        ["receipt-batch-author", "ShareReceiptBatchSubmitted"],
        ["complaint-batch-default", "ShareComplaintBatchSubmitted"],
      ] as const) {
        const e = election(f9);
        e.deliver([alice], 200);
        e.board(200, batch(id, name, T_D));
        const r = run(e);
        expect(r.rows.get("5.9"), id).toEqual({ status: "pass" });
        expect(r.delivery, id).toEqual({ excluded: [], records: [], rejected: [] });
      }
    });

    test("above the floor a version-2 batch sent by t_K holds the rows open", () => {
      const e = election(f9);
      e.deliver([alice], 200);
      const at = e.board(S_K + 1, receiptBatch([alice], DEFAULT, 3, T_K));
      undecided(run(e), at);
    });

    test("one naming another definition above the floor isn't read, whenever it was sent by t_K", () => {
      const other = sha256(text("counted-v4.test another definition"));
      for (const [id, name] of [
        ["receipt-batch-default", "ShareReceiptBatchSubmitted"],
        ["receipt-root-author", "ObligationRootSubmitted"],
      ] as const) {
        const e = election(f9);
        e.deliver([alice], 200);
        const r9 = batches.records.find((x) => x.id === id);
        if (r9 === undefined) throw new Error(`no record ${id}`);
        const record = hex(r9.encoding);
        record.set(other, 3);
        e.board(S_K + 1, event(name, [other, word(record[36] as number)], record, T_K));
        const r = run(e);
        expect(r.rows.get("5.9"), id).toEqual({ status: "pass" });
        expect(r.delivery, id).toEqual({ excluded: [], records: [], rejected: [] });
      }
    });

    test("one naming another definition is stray, listed by the check, and holds nothing", () => {
      const other = sha256(text("counted-v4.test another definition"));
      for (const [id, name] of [
        ["receipt-batch-default", "ShareReceiptBatchSubmitted"],
        ["receipt-root-author", "ObligationRootSubmitted"],
      ] as const) {
        const e = election(f9);
        e.deliver([alice], 200);
        const r9 = batches.records.find((x) => x.id === id);
        if (r9 === undefined) throw new Error(`no record ${id}`);
        const record = hex(r9.encoding);
        record.set(other, 3);
        const at = e.board(200, event(name, [other, word(record[36] as number)], record, T_D));
        const r = run(e);
        expect(r.rows.get("5.9"), id).toEqual({ status: "pass" });
        expect(r.delivery?.excluded, id).toEqual([]);
        expect(r.delivery?.records, id).toEqual([
          { entry: at, code: "delivery-stray", panel: record[35], seat: record[36] },
        ]);
      }
    });

    test("under a version-8 pin, a record of this version doesn't decode and carries nothing (4.4's to report)", () => {
      const e = election();
      e.deliver([ALICE], 200);
      e.board(200, receiptEvent(election(f9), 3, T_D));
      const r = countedChecks(e.inputs([ALICE], { eventsPass: true, destruction: false }));
      expect(r.rows.get("5.9")).toEqual({ status: "pass" });
      expect(r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    });
  },
);

describe("6.3 under definition version 6", () => {
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

  test("the close check runs over version 4's ballot hashes, and with no late ordinary ballot passes", () => {
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

describe("the tally of the default halves (7.1 to 7.4, 8.5)", () => {
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
        byQuestion: [
          ["1", "0", "0"],
          ["1", "2", "0", "0"],
          ["1", "1"],
        ],
        signers: [1],
      },
      {
        cell: 1,
        tier: 0,
        counted: 1,
        counts: ["0", "1", "0", "0", "0", "0", "1", "1", "0"],
        byQuestion: [
          ["0", "1", "0"],
          ["0", "0", "0", "1"],
          ["1", "0"],
        ],
        signers: [2],
      },
      {
        cell: 2,
        tier: 2,
        counted: 1,
        counts: ["0", "0", "1", "1", "0", "1", "0", "0", "1"],
        byQuestion: [
          ["0", "0", "1"],
          ["1", "0", "1", "0"],
          ["0", "1"],
        ],
        signers: [3],
      },
    ]);
    // Tier 0's result is its two cells' sum, derived, never opened.
    expect(r.tiers).toEqual([
      {
        tier: 0,
        counted: 3,
        counts: ["1", "1", "0", "1", "2", "0", "1", "2", "1"],
        byQuestion: [
          ["1", "1", "0"],
          ["1", "2", "0", "1"],
          ["2", "1"],
        ],
      },
      {
        tier: 2,
        counted: 1,
        counts: ["0", "0", "1", "1", "0", "1", "0", "0", "1"],
        byQuestion: [
          ["0", "0", "1"],
          ["1", "0", "1", "0"],
          ["0", "1"],
        ],
      },
    ]);
    // Each question's limits and the method they give, from the definition alone.
    expect(r.questions).toEqual([
      { question: 0, options: 3, minSelections: 0, maxSelections: 1, method: "pick one" },
      { question: 1, options: 4, minSelections: 0, maxSelections: 2, method: "pick up to 2" },
      { question: 2, options: 2, minSelections: 1, maxSelections: 1, method: "pick exactly 1" },
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

  // Two delivery and tally runs with every signature checked: past the
  // default 5 seconds on a loaded runner.
  test(
    "an opening over a ballot delivery excluded is over another set",
    { timeout: 60_000 },
    () => {
      const f = election();
      f.deliver([a, c, g], 200);
      // Seat 3 never receipted `b`.
      for (const seat of [1, 2]) f.board(200, f.receipt(b, seat));
      const wrong = f.board(300, f.opening(0, [a, b], 1));
      f.board(300, f.opening(1, [c], 2));
      f.board(300, f.opening(2, [g], 3));
      const got = countedChecks(f.inputs([a, b, c, g], { destruction: false }));
      expect(got.delivery?.excluded).toEqual([
        { entry: b.entry, missing: [{ panel: DEFAULT, seat: 3 }], complaints: [] },
      ]);
      expect(got.rows.get("7.2")).toEqual({
        status: "fail",
        code: "tally-opening",
        at: { cell: 0 },
      });
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
    },
  );

  test(
    "an opening that doesn't open an option fails 7.2 at that option",
    { timeout: 60_000 },
    () => {
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
    },
  );
});

describe("the gates", () => {
  test("beside an author panel nothing is decided: its key set would be taken on trust (T-37)", () => {
    const author = decodeDefinition(hex(caseOf("author-panel").definition));
    expect(author.version === 6 && author.value.author_keys.length).toBe(3);
    const e = election();
    const r = countedChecks(
      e.inputs([], { definition: author, definitionHash: readDefinition(author).hash }),
    );
    for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3", "8.5"])
      expect(r.rows.get(id)).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
    expect(r.delivery).toBeUndefined();
  });
});
