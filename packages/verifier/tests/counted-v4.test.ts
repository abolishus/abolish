import { readFileSync } from "node:fs";
import {
  type AnchorClock,
  ballotHashV4,
  CONTRACT_EVENT_SIGNATURES,
  type CommittedVoteV4,
  checkContractEvent,
  decode,
  decodeBallot,
  decodeBoardEntry,
  decodeContractEvent,
  decodeShareComplaint,
  deliverySegments,
  encodeBoardEntry,
  encodeCloseStatement,
  encodeContractEvent,
  encodeShareComplaintV2,
  encodeShareReceipt,
  encodeShareReceiptV2,
  identityKey,
  KEM_PUBLIC_KEY,
  PARAMETERS,
  RECORD_TYPES,
  type RegisteredKeys,
  type SeatPanel,
  shareReceiptRecord,
  shareReceiptRecordV2,
  shareReceiptStatement,
  shareReceiptStatementV4,
  signCloseStatement,
  signShareComplaintV2,
  signStatement,
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
// 6.3 rides on the same delivery; the tally (7.1 to 7.3) and 8.5 under
// version 6 are P2-16 part 4c's. The ballots are verifier-ballots-v4.json's
// `admitted` case (packages/crypto/scripts/verifier-ballots-v4-vectors.py,
// an independent implementation); the seats' signing keys are this test's
// own, and the receipts and complaints are made with @abolishus/crypto's
// trustee paths, never with the checks under test. delivery-v2.json gives a
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
  const tallyOf = (b: Cast): BallotTally => ({
    cell: b.cell,
    vss: b.vote.vss,
    deliveryV4: { cell: b.cell, nullifier: b.nullifier, vote: b.vote },
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
  return { entries, board, receipt, deliver, inputs, admitted };
}

const rows = (r: ReturnType<typeof countedChecks>) => Object.fromEntries(r.rows);
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const LATER = { status: "unverifiable", code: "not-implemented", at: {} };

describe("an honest election", () => {
  test("every default seat's receipt delivers each ballot: 5.9 passes, and the tally waits on part 4c", () => {
    const e = election();
    e.deliver([ALICE, BOB, CAROL], 200);
    const r = countedChecks(e.inputs([ALICE, BOB, CAROL]));
    expect(rows(r)).toEqual({
      "5.9": { status: "pass" },
      // No run of L1 headers, so L_δ isn't found (format 4).
      "6.3": { status: "unverifiable", code: "not-reached", at: {} },
      "7.1": LATER,
      "7.2": LATER,
      "7.3": LATER,
      "8.5": LATER,
    });
    expect(r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    expect(r.cells).toBeUndefined();
    expect(r.destruction).toBeUndefined();
    expect(r.tallyBreaks).toBeUndefined();
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
      { numRuns: Math.min(numRuns, 50) },
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

describe("contract-path records under contract-event version 6, once 4.4 passes", () => {
  const T_D = d.closes_at + BigInt(d.l1_inclusion_bound) + BigInt(PARAMETERS.DELIVERY_WINDOW);
  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const topic0 = (name: string) => {
    const signature = CONTRACT_EVENT_SIGNATURES[6].board.find((x) => x.startsWith(`${name}(`));
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
      6,
    );
    const checked = checkContractEvent(decodeContractEvent(payload, 6), contracts, 6);
    if (!checked.ok || checked.event.event !== name) throw new Error(`fixture: ${name} fails`);
    return payload;
  };
  const roots = read("delivery-root.json") as {
    readonly records: readonly { readonly encoding: string }[];
  };
  /** delivery-root.json's first root renamed to this definition: version 1, which ballot version 4 doesn't fix. */
  const root = (t: bigint) => {
    const record = hex((roots.records[0] as { readonly encoding: string }).encoding);
    record.set(hash, 3);
    return event("ObligationRootSubmitted", [hash, word(record[35] as number)], record, t);
  };

  test("an obligation root naming this definition is a rejected entry, never a hold on 5.9", () => {
    const e = election();
    e.deliver([ALICE], 200);
    const at = e.board(200, root(T_D));
    const r = countedChecks(e.inputs([ALICE], { eventsPass: true, destruction: false }));
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
    expect(r.delivery).toEqual({
      excluded: [],
      records: [],
      rejected: [{ entry: at, decodeError: "profile-mismatch" }],
    });
  });

  test("a contract-path record still waits on 4.4", () => {
    const e = election();
    e.deliver([ALICE], 200);
    const at = e.board(200, root(T_D));
    const r = countedChecks(e.inputs([ALICE], { eventsPass: false, destruction: false }));
    for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3"])
      expect(r.rows.get(id)).toEqual({
        status: "unverifiable",
        code: "not-reached",
        at: { entry: at },
      });
  });

  test("a version-1 receipt through the contract path is a rejected entry, and delivers nothing", () => {
    const e = election();
    for (const seat of [1, 2]) e.board(200, e.receipt(ALICE, seat));
    const shareHash = ALICE.vote.share_hashes[2] as Uint8Array;
    const m = shareReceiptStatement({
      definition_hash: hash,
      ballot_hash: ALICE.hash,
      seat: 3,
      share_hash: shareHash,
    });
    const v1 = encodeShareReceipt(
      shareReceiptRecord(hash, 3, {
        ballotHash: ALICE.hash,
        shareHash,
        receipt: signStatement(secret(3), "abolish/v1/sig/share-receipt", m),
      }),
    );
    const at = e.board(200, event("ShareReceiptSubmitted", [hash, ALICE.hash], v1, T_D));
    const r = countedChecks(e.inputs([ALICE], { eventsPass: true, destruction: false }));
    expect(r.delivery).toEqual({
      excluded: [{ entry: ALICE.entry, missing: [{ panel: DEFAULT, seat: 3 }], complaints: [] }],
      records: [],
      rejected: [{ entry: at, decodeError: "profile-mismatch" }],
    });
  });
});

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
