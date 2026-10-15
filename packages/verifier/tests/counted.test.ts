import { readFileSync } from "node:fs";
import {
  aggregateCell,
  type AnchorClock,
  ballotHash,
  type BallotLabel,
  type CommittedVote,
  decode,
  decodeBoardEntry,
  type BoardEntryVersion,
  encodeCloseStatement,
  signCloseStatement,
  decodeContractEvent,
  checkContractEvent,
  encodeContractEvent,
  PARAMETERS,
  encodeBoardEntry,
  encodeDestructionStatement,
  encodeShareReceipt,
  encodeTallyOpening,
  identityKey,
  KEM_PUBLIC_KEY,
  openCell,
  proveValidity,
  type RegisteredKeys,
  type Share,
  shareReceiptRecord,
  shareReceiptStatement,
  shareVote,
  signDestructionStatement,
  signStatement,
  signTallyOpening,
  sumShares,
  tallyRules,
  type VoteSharing,
  aggregateHash,
} from "@abolishus/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_BLOCKS,
  BUNDLE_FORMAT_CEREMONY,
  BUNDLE_FORMAT_DEFINITION,
  type CheckResult,
  decodeHeader,
  parseBundle,
  type Report,
  splitEntries,
  verifyBundle,
} from "../src/index.ts";
import { type CountedBallot, countedChecks, type CountedInputs } from "../src/counted.ts";
import { decodeDefinition, readDefinition, type VerifiedDefinition } from "../src/definition.ts";
import { tallyChecks } from "../src/tallies.ts";
import { run, type TestHeader, toHex } from "./headers.ts";
import type { BallotTally } from "../src/ballots.ts";
import type { CloseCandidate } from "../src/close.ts";

// The counted set and the tally (docs/spec/verifier.md, Counted set and
// tally): delivery (5.9), the counted set and the tally checks (7.1 to 7.3),
// 7.4's counted-set breaks and 8.5, decided once selection (6.1) passed.
// No vector reaches a sealed, authenticated board with ballots (P1-20), so
// `countedChecks` runs here on elections made with @abolishus/crypto's
// client and trustee paths (`shareVote`, `proveValidity`, the receipt and
// opening signatures, `openCell`), never with the checks under test; the
// expected counts are the votes cast. The definitions are the vectors'
// (verifier-tallies.json, verifier-events.json), and the whole run's gates
// on the vectors' bundles, where 6.1 never passes.

const numRuns = Math.min(Number(process.env["FC_NUM_RUNS"] ?? 100), 200);

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const text = (s: string) => new TextEncoder().encode(s);

interface DefinitionCase {
  readonly id: string;
  readonly definition: string;
  readonly board: string;
}
const tallies = read("verifier-tallies.json") as { readonly cases: readonly DefinitionCase[] };
const events = read("verifier-events.json") as { readonly cases: readonly DefinitionCase[] };
const caseOf = (file: { readonly cases: readonly DefinitionCase[] }, id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const definitionOf = (c: DefinitionCase) => decodeDefinition(hex(c.definition));

const delivery = read("delivery.json") as {
  readonly panel: readonly { readonly kemKey: string }[];
};
const KEM = decode(KEM_PUBLIC_KEY, hex((delivery.panel[0] as { readonly kemKey: string }).kemKey));

// Seats 1 to 4 of the vectors' 3-of-4 panel, with per-election signing keys
// of the test's own.
const SECRETS = [1, 2, 3, 4].map((i) => sha256(text(`counted.test seat ${i}`)));
const secret = (seat: number) => SECRETS[seat - 1] as Uint8Array;
const keysOf = (seats: readonly number[]): RegisteredKeys[] =>
  seats.map((index) => ({ index, kemKey: KEM, signingKey: identityKey(secret(index)) }));

// Hourly periods from the opening, as verifier-ballots.json's clock: close
// is 168 periods later, so s_F = 169, s_D = 169 + 48 = 217 and s_K = 169 +
// 120 = 289 (l1_inclusion_bound is an hour), and s_T is at least 289 + 1 +
// ⌊(600 + 604,800) / 3,600⌋ = 458.
const OPENS = 1_767_225_600n;
const CLOCK: AnchorClock = { epoch: OPENS, period: 3600n, deadline: 600n, lastSegment: 1000 };
const S_D = 217;
const S_K = 289;
const S_T_FLOOR = 458;

/** One election's fixture: its definition, registered seats and the trustees' signing paths. */
function election(
  definition: VerifiedDefinition,
  seats: readonly number[] = [1, 2, 3, 4],
  version: BoardEntryVersion = 4,
) {
  const { hash } = readDefinition(definition);
  const d = definition.value;
  const rules = tallyRules(definition);
  // One question's limits: definition version 5's questions are never cast here.
  const { min_selections: minSelections, max_selections: maxSelections } = d as unknown as {
    readonly min_selections: number;
    readonly max_selections: number;
  };
  const registered = keysOf(seats);
  const qualified = new Set(seats);
  const entries: Uint8Array[] = [];
  const board = (segment: number, payload: Uint8Array) => {
    entries.push(
      encodeBoardEntry(
        { election_id: d.election_id, index: BigInt(entries.length), segment, payload },
        version,
      ),
    );
    return entries.length - 1;
  };

  interface Cast {
    readonly label: BallotLabel;
    readonly cell: number;
    readonly nullifier: bigint;
    readonly sharing: VoteSharing;
    readonly vote: CommittedVote;
    readonly hash: Uint8Array;
    readonly entry: number;
  }
  let nextEntry = 10_000;
  /** A ballot, admitted and selected elsewhere in the copy (its `entry` is a stand-in). */
  const cast = (label: BallotLabel, votes: readonly (0 | 1)[], nullifier: bigint): Cast => {
    const sharing = shareVote(
      {
        optionCount: rules.optionCount,
        minSelections,
        maxSelections,
        threshold: rules.threshold,
        panelSize: rules.panelSize,
      },
      votes,
    );
    // A seat outside the registered key set gets 32 zero bytes (delivery.md, Notes).
    const shareHashes = Array.from({ length: rules.panelSize }, (_, i) =>
      qualified.has(i + 1) ? sha256(text(`share ${nullifier} ${i + 1}`)) : new Uint8Array(32),
    );
    const ctx = {
      optionCount: rules.optionCount,
      minSelections,
      maxSelections,
      threshold: rules.threshold,
      panelSize: rules.panelSize,
      definitionHash: hash,
      nullifier,
      ...label,
    };
    const vote = proveValidity(ctx, sharing, shareHashes);
    const cell =
      "cell" in label
        ? label.cell
        : (d.electorate as readonly { readonly tier: number }[]).findIndex(
            (g) => g.tier === label.tier,
          );
    return {
      label,
      cell,
      nullifier,
      sharing,
      vote,
      hash: ballotHash({ definitionHash: hash, nullifier, ...label }, vote),
      entry: nextEntry++,
    };
  };
  const selected = (ballots: readonly Cast[]): CountedBallot[] =>
    ballots.map((b) => ({
      entry: b.entry,
      tally: {
        cell: b.cell,
        vss: b.vote.vss,
        delivery: { ...b.label, nullifier: b.nullifier, vote: b.vote },
      },
    }));
  const receipt = (b: Cast, seat: number, signer = seat) => {
    const shareHash = b.vote.share_hashes[seat - 1] as Uint8Array;
    const m = shareReceiptStatement({
      definition_hash: hash,
      ballot_hash: b.hash,
      seat,
      share_hash: shareHash,
    });
    return encodeShareReceipt(
      shareReceiptRecord(hash, seat, {
        ballotHash: b.hash,
        shareHash,
        receipt: signStatement(secret(signer), "abolish/v1/sig/share-receipt", m),
      }),
    );
  };
  /** Every registered seat's receipt for each ballot, boarded in `segment`. */
  const deliver = (ballots: readonly Cast[], segment: number) => {
    for (const b of ballots) for (const seat of seats) board(segment, receipt(b, seat));
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
      seats.slice(0, rules.threshold).map((seat) => [
        seat,
        sumShares(
          rules,
          counted.map((b) => b.sharing.shares[seat - 1] as readonly Share[]),
        ),
      ]),
    );
    const opened = openCell(rules, vss, summed);
    if (!opened.ok) throw new Error(`fixture: cell ${cell} doesn't open (${opened.code})`);
    const shares = opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint }));
    return encodeTallyOpening(
      signTallyOpening(secret(signer), {
        definition_hash: hash,
        cell,
        aggregate_hash: aggregateHash(aggregateCell(rules, vss)),
        signer,
        opening: tamper === undefined ? shares : tamper(shares),
      }),
    );
  };
  const destruction = (signer: number, definitionHash = hash) =>
    encodeDestructionStatement(
      signDestructionStatement(secret(signer), { definition_hash: definitionHash, signer }),
    );
  const inputs = (ballots: readonly Cast[], over: Partial<CountedInputs> = {}): CountedInputs => ({
    definition,
    definitionHash: hash,
    registered,
    selected: selected(ballots),
    entries,
    boardEntryVersion: version,
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
        tier: "tier" in b.label ? b.label.tier : 0,
        nullifier: b.nullifier,
        message: sha256(b.hash),
        l1RefNumber: 1n,
        index: BigInt(b.entry),
      },
      tally: selected([b])[0]?.tally as BallotTally,
    }));
  /** Seat `signer`'s close statement naming `l1` as `L_δ` and claiming L2 block `claim`. */
  const close = (signer: number, l1: TestHeader, claim: bigint) =>
    encodeCloseStatement(
      signCloseStatement(secret(signer), {
        definition_hash: hash,
        signer,
        l1_number: l1.number,
        l1_hash: l1.hash,
        l2_number: claim,
        l2_hash: sha256(text(`l2 ${claim}`)),
      }),
    );
  return {
    hash,
    rules,
    entries,
    board,
    cast,
    receipt,
    deliver,
    opening,
    destruction,
    inputs,
    admitted,
    close,
  };
}

const v1 = () => definitionOf(caseOf(tallies, "honest"));
const rows = (r: ReturnType<typeof countedChecks>) => Object.fromEntries(r.rows);

describe("an honest election", () => {
  // Tiers 0 and 2 are cells 0 and 1. Plurality over three options.
  const e = election(v1());
  const a = e.cast({ tier: 0 }, [1, 0, 0], 11n);
  const b = e.cast({ tier: 0 }, [0, 1, 0], 12n);
  const c = e.cast({ tier: 2 }, [1, 0, 0], 13n);
  e.deliver([a, b, c], 200);
  e.board(300, e.opening(0, [a, b], 1));
  e.board(300, e.opening(1, [c], 2));
  const statements = [1, 2, 3, 4].map((seat) => e.board(301, e.destruction(seat)));
  const r = countedChecks(e.inputs([a, b, c]));

  test("every row passes, and each cell's counts are the votes cast in it", () => {
    expect(rows(r)).toEqual({
      "5.9": { status: "pass" },
      // No run of L1 headers is given here: see 6.3's own tests.
      "6.3": { status: "unverifiable", code: "not-reached", at: {} },
      "7.1": { status: "pass" },
      "7.2": { status: "pass" },
      "7.3": { status: "pass" },
      "8.5": { status: "pass" },
    });
    expect(r.cells).toEqual([
      { cell: 0, tier: 0, counted: 2, counts: ["1", "1", "0"], signers: [1] },
      { cell: 1, tier: 2, counted: 1, counts: ["1", "0", "0"], signers: [2] },
    ]);
    // Each tier's result is its cells' sum: under definition version 1, its one cell.
    expect(r.tiers).toEqual([
      { tier: 0, counted: 2, counts: ["1", "1", "0"] },
      { tier: 2, counted: 1, counts: ["1", "0", "0"] },
    ]);
    expect(r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    // Both openings pass: 7.4 has nothing to add to them.
    expect(r.tallyBreaks).toEqual(new Map());
  });

  test("a statement after the last cell's first passing opening is destroyed", () => {
    // s_O = 300, so the destruction segment is min(301, s_T) = 301 whatever
    // s_T is.
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

  test("the delivery records' order changes nothing (R3)", () => {
    const receipts = e.entries.slice(0, 12);
    fc.assert(
      fc.property(
        fc.shuffledSubarray(receipts, { minLength: receipts.length, maxLength: receipts.length }),
        (shuffled) => {
          const entries = [
            ...reindex(shuffled, e.entries[0] as Uint8Array),
            ...e.entries.slice(12),
          ];
          const again = countedChecks(e.inputs([a, b, c], { entries }));
          expect(again.rows).toEqual(r.rows);
          expect(again.cells).toEqual(r.cells);
        },
      ),
      { numRuns: Math.min(numRuns, 20) },
    );
  });

  test("entries past the anchored extent are no one's", () => {
    // Without the openings and statements, every cell lacks its opening and
    // every seat its statement.
    const short = countedChecks(e.inputs([a, b, c], { extent: 12 }));
    expect(short.rows.get("7.2")).toEqual({
      status: "fail",
      code: "tally-missing",
      at: { cell: 0 },
    });
    expect(short.rows.get("8.5")).toEqual({
      status: "fail",
      code: "destruction-missing",
      at: { seat: 1 },
    });
    expect(short.rows.get("5.9")).toEqual({ status: "pass" });
  });

  test("under a board-entry version without destruction statements, 8.5 is left to the caller", () => {
    const off = countedChecks(e.inputs([a, b, c], { destruction: false }));
    expect(off.rows.has("8.5")).toBe(false);
    expect(off.destruction).toBeUndefined();
    expect(off.rows.get("7.2")).toEqual({ status: "pass" });
  });
});

/** The same entries, re-encoded with their positions renumbered from the first's. */
function reindex(entries: readonly Uint8Array[], first: Uint8Array) {
  const start = decodeBoardEntry(first, 4).index;
  return entries.map((x, i) =>
    encodeBoardEntry({ ...decodeBoardEntry(x, 4), index: start + BigInt(i) }, 4),
  );
}

describe("delivery decides the counted set", () => {
  test("a ballot without every registered seat's receipt counts nothing, and an opening over it is over another set", () => {
    const e = election(v1());
    const a = e.cast({ tier: 0 }, [1, 0, 0], 21n);
    const b = e.cast({ tier: 0 }, [0, 0, 1], 22n);
    e.deliver([a], 200);
    for (const seat of [1, 2, 4]) e.board(200, e.receipt(b, seat));
    // The trustees opened both ballots, though seat 3 never receipted `b`.
    const wrong = e.board(300, e.opening(0, [a, b], 1));
    e.board(300, e.opening(1, [], 1));
    const r = countedChecks(e.inputs([a, b]));
    expect(r.delivery?.excluded).toEqual([{ entry: b.entry, missing: [3], complaints: [] }]);
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
    expect(r.cells?.[0]).toEqual({
      cell: 0,
      tier: 0,
      counted: 1,
      code: "tally-opening",
      signers: [],
    });
    // A tier with a failing cell has no derived result.
    expect(r.tiers?.[0]).toEqual({ tier: 0, counted: 1 });
    expect(r.rows.get("7.2")).toEqual({ status: "fail", code: "tally-opening", at: { cell: 0 } });
    expect(r.tallyBreaks).toEqual(new Map([[wrong, { code: "tally-aggregate" }]]));
    // The opening over the counted set passes.
    e.board(301, e.opening(0, [a], 2));
    const fixed = countedChecks(e.inputs([a, b]));
    expect(fixed.rows.get("7.2")).toEqual({ status: "pass" });
    expect(fixed.cells?.[0]).toEqual({
      cell: 0,
      tier: 0,
      counted: 1,
      counts: ["1", "0", "0"],
      signers: [2],
    });
  });

  test("a seat outside the registered key set needs no receipt", () => {
    const e = election(v1(), [1, 2, 3]);
    const a = e.cast({ tier: 2 }, [0, 1, 0], 31n);
    e.deliver([a], 200);
    e.board(300, e.opening(0, [], 1));
    e.board(300, e.opening(1, [a], 3));
    const r = countedChecks(e.inputs([a], { destruction: false }));
    expect(r.delivery?.excluded).toEqual([]);
    expect(r.cells).toEqual([
      { cell: 0, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [1] },
      { cell: 1, tier: 2, counted: 1, counts: ["0", "1", "0"], signers: [3] },
    ]);
  });

  test("a board-path receipt counts up to s_D, is late after it, and above s_K's floor isn't read", () => {
    const at = (segment: number) => {
      const e = election(v1());
      const a = e.cast({ tier: 0 }, [1, 0, 0], 41n);
      for (const seat of [1, 2, 3]) e.board(200, e.receipt(a, seat));
      const last = e.board(segment, e.receipt(a, 4));
      return { r: countedChecks(e.inputs([a], { destruction: false })), a, last };
    };
    expect(at(S_D).r.delivery).toEqual({ excluded: [], records: [], rejected: [] });
    for (const segment of [S_D + 1, S_K]) {
      const { r, a, last } = at(segment);
      expect(r.delivery).toEqual({
        excluded: [{ entry: a.entry, missing: [4], complaints: [] }],
        records: [{ entry: last, code: "delivery-late" }],
        rejected: [],
      });
    }
    // Above max(s_F, s_K) it is outside its window whatever s_S is: the same
    // ballot is excluded, and nothing is reported for the record.
    const { r, a } = at(S_K + 1);
    expect(r.delivery).toEqual({
      excluded: [{ entry: a.entry, missing: [4], complaints: [] }],
      records: [],
      rejected: [],
    });
  });

  test("s_F, not s_K, is the floor when a period is longer than the complaint window", () => {
    // Ten-day periods from a second before close: s_D = s_K = 0 and s_F = 1,
    // so a receipt in segment 1 is in the counted extent and late.
    const e = election(v1());
    const a = e.cast({ tier: 0 }, [1, 0, 0], 45n);
    for (const seat of [1, 2, 3]) e.board(0, e.receipt(a, seat));
    const last = e.board(1, e.receipt(a, 4));
    const closes = v1().value.closes_at;
    const r = countedChecks(
      e.inputs([a], {
        destruction: false,
        clock: { ...CLOCK, epoch: closes - 1n, period: 864_000n },
      }),
    );
    expect(r.delivery?.records).toEqual([{ entry: last, code: "delivery-late" }]);
  });

  test("a receipt signed by another seat is reported and delivers nothing", () => {
    const e = election(v1());
    const a = e.cast({ tier: 0 }, [1, 0, 0], 51n);
    for (const seat of [1, 2, 3]) e.board(200, e.receipt(a, seat));
    const forged = e.board(200, e.receipt(a, 4, 1));
    const junk = e.board(200, Uint8Array.from([0x00, 0x0c, 0x01, 0xff]));
    const r = countedChecks(e.inputs([a], { destruction: false }));
    expect(r.delivery).toEqual({
      excluded: [{ entry: a.entry, missing: [4], complaints: [] }],
      records: [{ entry: forged, code: "share-receipt", signer: null }],
      rejected: [{ entry: junk, decodeError: "truncated" }],
    });
  });
});

describe("the counted set over any delivery", () => {
  const e = election(v1());
  const cast = [
    e.cast({ tier: 0 }, [1, 0, 0], 91n),
    e.cast({ tier: 0 }, [0, 1, 0], 92n),
    e.cast({ tier: 2 }, [0, 0, 1], 93n),
  ];
  // Every registered seat's receipt for every ballot, each in its own entry.
  const receipts = cast.flatMap((b, ballot) =>
    [1, 2, 3, 4].map((seat) => ({ ballot, seat, payload: e.receipt(b, seat) })),
  );

  test("a ballot counts in its cell exactly when every registered seat's receipt is kept, whatever else is (delivery.md, Delivery check)", () => {
    fc.assert(
      fc.property(fc.subarray(receipts), (kept) => {
        const f = election(v1());
        for (const r of kept) f.board(200, r.payload);
        const r = countedChecks(f.inputs(cast, { destruction: false }));
        const delivered = cast.map((_, i) => kept.filter((k) => k.ballot === i).length === 4);
        expect(r.rows.get("5.9")).toEqual({ status: "pass" });
        expect(r.delivery?.excluded.map((x) => x.entry)).toEqual(
          cast.filter((_, i) => !delivered[i]).map((b) => b.entry),
        );
        for (const x of r.delivery?.excluded ?? []) {
          const i = cast.findIndex((b) => b.entry === x.entry);
          expect(x.missing).toEqual(
            [1, 2, 3, 4].filter((s) => !kept.some((k) => k.ballot === i && k.seat === s)),
          );
        }
        expect(r.cells?.map((c) => c.counted)).toEqual([
          (delivered[0] ? 1 : 0) + (delivered[1] ? 1 : 0),
          delivered[2] ? 1 : 0,
        ]);
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
  });
});

describe("7.2 and 7.4 against the counted set", () => {
  test("an opening that doesn't open an option fails 7.2 at that option, and 7.4 reports it", () => {
    const e = election(v1());
    const a = e.cast({ tier: 0 }, [0, 1, 0], 61n);
    e.deliver([a], 200);
    const bad = e.board(
      300,
      e.opening(0, [a], 2, (o) => o.map((s, j) => (j === 1 ? { ...s, v: s.v + 1n } : s))),
    );
    e.board(300, e.opening(1, [], 1));
    const r = countedChecks(e.inputs([a], { destruction: false }));
    expect(r.rows.get("7.2")).toEqual({
      status: "fail",
      code: "tally-opening",
      at: { cell: 0, option: 1 },
    });
    expect(r.cells?.[0]).toEqual({
      cell: 0,
      tier: 0,
      counted: 1,
      code: "tally-opening",
      option: 1,
      signers: [],
    });
    expect(r.tallyBreaks).toEqual(new Map([[bad, { code: "tally-opening", option: 1 }]]));
    expect(r.rows.get("7.3")).toEqual({ status: "pass" });
  });

  test("the first failing cell decides 7.2, and a cell with no opening is tally-missing", () => {
    const e = election(v1());
    e.board(300, e.opening(0, [], 1));
    const r = countedChecks(e.inputs([], { destruction: false }));
    expect(r.rows.get("7.2")).toEqual({ status: "fail", code: "tally-missing", at: { cell: 1 } });
    expect(r.cells).toEqual([
      { cell: 0, tier: 0, counted: 0, counts: ["0", "0", "0"], signers: [1] },
      { cell: 1, tier: 2, counted: 0, code: "tally-missing", signers: [] },
    ]);
  });

  test("under definition version 3 a ballot counts in the cell it names, numbered across the tiers", () => {
    // verifier-tallies.json's version-3 partition: cells 0 to 2 in tier 0, cell 3 tier 2's.
    const e = election(definitionOf(caseOf(tallies, "v3-cells")));
    const a = e.cast({ ballotVersion: 2, cell: 3 }, [0, 0, 1], 71n);
    const b = e.cast({ ballotVersion: 2, cell: 1 }, [1, 0, 0], 72n);
    e.deliver([a, b], 200);
    for (const cell of [0, 1, 2, 3])
      e.board(300, e.opening(cell, cell === 3 ? [a] : cell === 1 ? [b] : [], 1));
    const r = countedChecks(e.inputs([a, b], { destruction: false }));
    expect(r.rows.get("7.2")).toEqual({ status: "pass" });
    expect(r.cells?.map((c) => [c.counted, c.counts])).toEqual([
      [0, ["0", "0", "0"]],
      [1, ["1", "0", "0"]],
      [0, ["0", "0", "0"]],
      [1, ["0", "0", "1"]],
    ]);
  });
});

describe("7.4 once the counted set is known", () => {
  // Seats 1 to 3 registered; seat 4's signature attributes nothing.
  const e = election(v1(), [1, 2, 3]);
  const a = e.cast({ tier: 0 }, [1, 0, 0], 81n);
  e.deliver([a], 200);
  const honest = e.board(300, e.opening(0, [a], 1));
  // Over a set without `a`, and signed by no registered seat.
  const other = e.board(300, e.opening(0, [], 4));
  const empty = e.board(300, e.opening(1, [], 2));
  // Past the anchored extent: not on the board.
  e.board(300, e.opening(1, [a], 3));
  const extent = e.entries.length - 1;
  const counted = countedChecks(e.inputs([a], { extent, destruction: false }));
  const breaks = counted.tallyBreaks ?? new Map();
  const { registered } = e.inputs([]);
  const opened = (c?: { readonly extent: number; readonly breaks: typeof breaks }) =>
    tallyChecks(v1(), e.hash, registered, e.entries, 4, c);

  test("an opening's counted-set break comes before tally-unattributed, and the row is settled", () => {
    expect(breaks).toEqual(new Map([[other, { code: "tally-aggregate" }]]));
    const r = opened({ extent, breaks });
    expect(r.report).toEqual([
      { entry: honest, cell: 0, signer: 1, breaks: [] },
      {
        entry: other,
        cell: 0,
        signer: null,
        breaks: [{ code: "tally-aggregate" }, { code: "tally-unattributed" }],
      },
      { entry: empty, cell: 1, signer: 2, breaks: [] },
    ]);
    expect(r.row).toEqual({ status: "fail", code: "tally-aggregate", at: { entry: other } });
  });

  test("with every opening passing, 7.4 passes", () => {
    const r = opened({ extent, breaks: new Map() });
    expect(r.row).toEqual({ status: "fail", code: "tally-unattributed", at: { entry: other } });
    const clean = election(v1());
    clean.board(300, clean.opening(0, [], 1));
    clean.board(300, clean.opening(1, [], 2));
    expect(
      tallyChecks(v1(), clean.hash, clean.inputs([]).registered, clean.entries, 4, {
        extent: clean.entries.length,
        breaks: new Map(),
      }).row,
    ).toEqual({ status: "pass" });
  });

  test("before it is known, every opening on the copy is read and an honest one stays unsettled", () => {
    const r = opened();
    expect(r.report).toHaveLength(4);
    expect(r.row).toEqual({ status: "unverifiable", code: "not-implemented" });
  });
});

describe("8.5 between the floors of s_T", () => {
  // Each cell's first passing opening in segment `opened`: s_O + 1 is the
  // highest the destruction segment can be, and min(s_O + 1, s_T's floor)
  // the lowest.
  const decide = (opened: number, statements: readonly [number, number][], cells = 2) => {
    const e = election(v1());
    for (let cell = 0; cell < cells; cell++) e.board(opened, e.opening(cell, [], 1));
    const at = statements.map(([seat, segment]) => e.board(segment, e.destruction(seat)));
    return { r: countedChecks(e.inputs([])), at };
  };

  test("below the lowest is early, from the highest destroyed, and between them undecided", () => {
    const { r, at } = decide(500, [
      [1, S_T_FLOOR - 1],
      [2, S_T_FLOOR],
      [3, 500],
      [4, 501],
    ]);
    expect(r.destruction).toMatchObject({ earliest: S_T_FLOOR, latest: 501 });
    expect(r.destruction?.seats).toEqual([
      { seat: 1, code: "destruction-early", entry: at[0] },
      { seat: 2, entry: at[1] },
      { seat: 3, entry: at[2] },
      { seat: 4, code: "destroyed", entry: at[3] },
    ]);
    expect(r.rows.get("8.5")).toEqual({
      status: "unverifiable",
      code: "not-implemented",
      at: { seat: 2 },
    });
  });

  test("once every seat is decided, the first that isn't destroyed fails the row", () => {
    const { r } = decide(300, [
      [1, 301],
      [2, 300],
      [4, 400],
    ]);
    expect(r.destruction?.seats.map((s) => s.code)).toEqual([
      "destroyed",
      "destruction-early",
      "destruction-missing",
      "destroyed",
    ]);
    expect(r.rows.get("8.5")).toEqual({
      status: "fail",
      code: "destruction-early",
      at: { seat: 2 },
    });
  });

  test("while a cell has no passing opening, only an early statement is decided", () => {
    const { r } = decide(
      300,
      [
        [1, S_T_FLOOR - 1],
        [2, 900],
      ],
      1,
    );
    expect(r.destruction).toMatchObject({ earliest: S_T_FLOOR });
    expect(r.destruction).not.toHaveProperty("latest");
    expect(r.destruction?.seats.map((s) => s.code)).toEqual([
      "destruction-early",
      undefined,
      "destruction-missing",
      "destruction-missing",
    ]);
  });

  test("s_T's floor counts the anchor's deadline, even one longer than a period", () => {
    // With a two-hour deadline, s_T ≥ 289 + 1 + ⌊(7,200 + 604,800) / 3,600⌋ = 460.
    const e = election(v1());
    e.board(500, e.opening(0, [], 1));
    e.board(500, e.opening(1, [], 1));
    const early = e.board(459, e.destruction(1));
    const r = countedChecks(e.inputs([], { clock: { ...CLOCK, deadline: 7200n } }));
    expect(r.destruction).toMatchObject({ earliest: 460, latest: 501 });
    expect(r.destruction?.seats[0]).toEqual({
      seat: 1,
      code: "destruction-early",
      entry: early,
    });
  });

  test("another election's entries are never read, even inside the anchored extent", () => {
    const e = election(v1());
    e.board(300, e.opening(0, [], 1));
    e.board(300, e.opening(1, [], 1));
    const other = decodeBoardEntry(e.entries.at(-1) as Uint8Array, 4);
    e.entries.push(
      encodeBoardEntry(
        {
          ...other,
          election_id: new Uint8Array(32).fill(9),
          index: other.index + 1n,
          segment: 301,
          payload: e.destruction(2),
        },
        4,
      ),
    );
    const r = countedChecks(e.inputs([]));
    expect(r.destruction?.seats[1]).toEqual({ seat: 2, code: "destruction-missing" });
    expect(r.destruction?.stray).toEqual([]);
  });

  test("duplicates, unattributed, stray and undecodable statements are listed", () => {
    const e = election(v1());
    e.board(300, e.opening(0, [], 1));
    e.board(300, e.opening(1, [], 1));
    const first = e.board(301, e.destruction(1));
    const second = e.board(302, e.destruction(1));
    const forged = (() => {
      const s = signDestructionStatement(secret(2), { definition_hash: e.hash, signer: 3 });
      return e.board(301, encodeDestructionStatement(s));
    })();
    const stray = e.board(301, e.destruction(2, new Uint8Array(32)));
    const junk = e.board(301, Uint8Array.from([0x00, 0x0f, 0x01]));
    const r = countedChecks(e.inputs([]));
    expect(r.destruction).toMatchObject({
      duplicates: [{ entry: second, seat: 1 }],
      unattributed: [{ entry: forged }],
      stray: [{ entry: stray, signer: 2 }],
      rejected: [{ entry: junk, decodeError: "truncated" }],
    });
    expect(r.destruction?.seats[0]).toEqual({ seat: 1, code: "destroyed", entry: first });
  });
});

describe("6.3, the close check", () => {
  const CLOSES = v1().value.closes_at;
  // L_δ is the last block at or before closes_at + δ (an hour): the second.
  const blocks = run(21_000_000n, [OPENS - 3612n, CLOSES + 3600n, CLOSES + 3612n]);
  const lDelta = blocks[1] as TestHeader;
  // Board-entry version 5 carries close statements; s_C = 168 + 1 + 48 = 217.
  const S_C = 217;
  const setup = () => {
    const e = election(v1(), [1, 2, 3, 4], 5);
    const a = e.cast({ tier: 0 }, [1, 0, 0], 101n);
    const b = e.cast({ tier: 2 }, [0, 1, 0], 102n);
    e.deliver([a, b], 200);
    return { e, a, b };
  };
  const check = (
    e: ReturnType<typeof election>,
    ballots: Parameters<ReturnType<typeof election>["inputs"]>[0],
    over: Partial<CountedInputs> = {},
  ) =>
    countedChecks(
      e.inputs(ballots, {
        destruction: false,
        admitted: e.admitted(ballots),
        blocks: blocks.map((h) => decodeHeader(h.encoded)),
        ...over,
      }),
    );

  test("the k-th largest counted claim is the head, and with no late ordinary ballot the check passes", () => {
    const { e, a, b } = setup();
    const at = [1, 2, 3].map((seat) => e.board(S_C, e.close(seat, lDelta, 900n)));
    e.board(200, e.close(4, lDelta, 950n));
    const r = check(e, [a, b]);
    expect(r.rows.get("6.3")).toEqual({ status: "pass" });
    expect(r.close).toMatchObject({
      head: "900",
      lDelta: { number: lDelta.number.toString(), hash: toHex(lDelta.hash) },
      late: [],
    });
    expect(r.close?.seats.map((s) => [s.code, s.claim?.number])).toEqual([
      ["close-counted", "900"],
      ["close-counted", "900"],
      ["close-counted", "900"],
      ["close-counted", "950"],
    ]);
    // Two distinct claims are listed: one of them is false.
    expect(r.close?.claims.map((c) => c.number)).toEqual(["900", "950"]);
    expect(r.close?.statements.slice(0, 3)).toEqual(
      at.map((entry, i) => ({ entry, code: "valid", seat: i + 1 })),
    );
    expect(r.close).not.toHaveProperty("unchecked");
  });

  test("fewer than k counted seats leave the close unchecked, and the check passes", () => {
    const { e, a, b } = setup();
    e.board(200, e.close(1, lDelta, 900n));
    e.board(200, e.close(2, lDelta, 900n));
    // Seat 3 names another L1 block, seat 4 equivocates, and a board-path
    // statement after s_C is late, the operator's or the seat's.
    const wrong = e.board(200, e.close(3, blocks[0] as TestHeader, 900n));
    e.board(200, e.close(4, lDelta, 950n));
    e.board(200, e.close(4, lDelta, 960n));
    const late = e.board(S_C + 1, e.close(3, lDelta, 900n));
    const r = check(e, [a, b]);
    expect(r.rows.get("6.3")).toEqual({ status: "pass" });
    expect(r.close?.head).toBeNull();
    expect(r.close?.unchecked).toEqual([]);
    expect(r.close?.seats.map((s) => s.code)).toEqual([
      "close-counted",
      "close-counted",
      "close-missing",
      "close-equivocation",
    ]);
    expect(r.close?.statements.filter((s) => s.code !== "valid")).toEqual([
      { entry: wrong, code: "close-l1", seat: 3 },
      { entry: late, code: "close-late", seat: null },
    ]);
  });

  test("without a finalized block after closes_at + δ, L_δ isn't known", () => {
    const { e, a, b } = setup();
    const short = blocks.slice(0, 2).map((h) => decodeHeader(h.encoded));
    expect(check(e, [a, b], { blocks: short }).rows.get("6.3")).toEqual({
      status: "unverifiable",
      code: "l1-blocks-short",
      at: {},
    });
    // The rest of the counted set doesn't wait on it.
    expect(check(e, [a, b], { blocks: short }).rows.get("7.1")).toEqual({ status: "pass" });
  });

  test("an ordinary ballot waits on its L2 block, and a contract-path statement on 4.4", () => {
    const { e, a, b } = setup();
    const [x, y] = e.admitted([a, b]);
    const ordinary = { ...(y as CloseCandidate), path: "ordinary" as const };
    expect(check(e, [a, b], { admitted: [x as CloseCandidate, ordinary] }).rows.get("6.3")).toEqual(
      { status: "unverifiable", code: "not-implemented", at: { entry: b.entry } },
    );
    // verifier-events.json's version-3 records: the board's close statements
    // among them, alone on the copy.
    const c = caseOf(events, "events-v3-records");
    const f = election(definitionOf(c));
    const dv = definitionOf(c).value;
    const contracts = {
      electionRegistry: dv.election_registry,
      trusteeRegistry: dv.trustee_registry,
      groupRegistry: dv.group_registry,
      board: dv.board,
    };
    const statements = splitEntries(hex(c.board)).entries.filter((x) => {
      const p = decodeBoardEntry(x, 4).payload;
      if (((p[0] as number) << 8) + (p[1] as number) !== 0x0008) return false;
      const checked = checkContractEvent(decodeContractEvent(p, 3), contracts, 3);
      return checked.ok && checked.event.event === "CloseStatementSubmitted";
    });
    expect(statements.length).toBeGreaterThan(0);
    const r = countedChecks(
      f.inputs([], {
        entries: statements,
        extent: statements.length,
        destruction: false,
        blocks: blocks.map((h) => decodeHeader(h.encoded)),
      }),
    );
    expect(r.rows.get("6.3")).toEqual({
      status: "unverifiable",
      code: "not-reached",
      at: { entry: 0 },
    });
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
  });
});

describe("the gates", () => {
  test("a contract-path delivery record waits on 4.4, then on the floor of s_S", () => {
    // verifier-events.json's version-4 definition pinning contract-event
    // version 2, whose copy holds every honest record of
    // contract-event-v2.json, a share receipt, posting and complaint among
    // them, each passing the event check.
    const c = caseOf(events, "v2-records");
    const definition = definitionOf(c);
    const all = splitEntries(hex(c.board)).entries;
    const e = election(definition);
    const at = (segment: number) =>
      all.map((x) => encodeBoardEntry({ ...decodeBoardEntry(x, 4), segment }, 4));
    const base = { selected: [], destruction: false, extent: all.length };
    const first = countedChecks(e.inputs([], { ...base, entries: at(200) }));
    const firstAt = first.rows.get("5.9")?.at;
    expect(first.rows.get("5.9")).toMatchObject({ status: "unverifiable", code: "not-reached" });
    expect(firstAt).toHaveProperty("entry");
    for (const id of ["7.1", "7.2", "7.3"])
      expect(first.rows.get(id)).toEqual(first.rows.get("5.9"));
    // Once 4.4 passes, a record at or below the floor is read, and one above
    // it may or may not be in the counted extent.
    const read2 = countedChecks(e.inputs([], { ...base, entries: at(S_K), eventsPass: true }));
    expect(read2.rows.get("5.9")).toEqual({ status: "pass" });
    const above = countedChecks(e.inputs([], { ...base, entries: at(S_K + 1), eventsPass: true }));
    expect(above.rows.get("5.9")).toEqual({
      status: "unverifiable",
      code: "not-implemented",
      at: firstAt,
    });
    // Sent after the complaint window's end, a record above the floor is
    // late whatever s_S is, so it holds nothing open; one sent at its end may
    // still be in time.
    const tK =
      definition.value.closes_at +
      BigInt(definition.value.l1_inclusion_bound) +
      BigInt(PARAMETERS.COMPLAINT_WINDOW);
    const sentAt = (t: bigint) =>
      at(S_K + 1).map((x) => {
        const entry = decodeBoardEntry(x, 4);
        if (((entry.payload[0] as number) << 8) + (entry.payload[1] as number) !== 0x0008) return x;
        const record = decodeContractEvent(entry.payload, 2);
        return encodeBoardEntry(
          { ...entry, payload: encodeContractEvent({ ...record, l2_timestamp: t }, 2) },
          4,
        );
      });
    const late = countedChecks(
      e.inputs([], { ...base, entries: sentAt(tK + 1n), eventsPass: true }),
    );
    expect(late.rows.get("5.9")).toEqual({ status: "pass" });
    expect(late.delivery?.records).toEqual([]);
    const lastSecond = countedChecks(
      e.inputs([], { ...base, entries: sentAt(tK), eventsPass: true }),
    );
    expect(lastSecond.rows.get("5.9")).toEqual({
      status: "unverifiable",
      code: "not-implemented",
      at: firstAt,
    });
  });

  test("definition version 5's ballots aren't read by the delivery check yet", () => {
    const e = election(definitionOf(caseOf(tallies, "v5-questions")));
    const r = countedChecks(e.inputs([]));
    for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3", "8.5"])
      expect(r.rows.get(id)).toEqual({ status: "unverifiable", code: "not-implemented", at: {} });
  });

  test("under another tally-opening pin, delivery runs and the tally and 8.5 are unsupported", () => {
    const e = election(definitionOf(caseOf(tallies, "tally-v2")));
    const r = countedChecks(e.inputs([]));
    expect(r.rows.get("5.9")).toEqual({ status: "pass" });
    for (const id of ["7.1", "7.2", "7.3", "8.5"])
      expect(r.rows.get(id)).toEqual({
        status: "unverifiable",
        code: "unsupported-version",
        at: {},
      });
    expect(r.cells).toBeUndefined();
  });

  test("a close plus the inclusion bound before the clock's epoch leaves everything not reached", () => {
    const e = election(v1());
    const r = countedChecks(e.inputs([], { clock: { ...CLOCK, epoch: 1_767_830_400n + 3601n } }));
    for (const id of ["5.9", "6.3", "7.1", "7.2", "7.3", "8.5"])
      expect(r.rows.get(id)).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
    // At the epoch itself, the windows are on the clock.
    const at = countedChecks(e.inputs([], { clock: { ...CLOCK, epoch: 1_767_830_400n + 3600n } }));
    expect(at.rows.get("5.9")).toEqual({ status: "pass" });
  });
});

// The vectors' bundles never reach a sealed, authenticated board, so 6.1
// never passes over them, and nothing here runs.
const ballots = read("verifier-ballots.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly panels: Readonly<Record<string, unknown>>;
  readonly cases: readonly (DefinitionCase & { readonly panel: string })[];
};
const l1File = read("l1-anchor.json") as {
  readonly vectors: readonly {
    readonly id: string;
    readonly firstSegment: string;
    readonly block: { readonly header: string };
    readonly nodes: readonly string[];
    readonly checkpoints: readonly string[];
  }[];
};
const closed = l1File.vectors.find((v) => v.id === "closed");
if (closed === undefined) throw new Error("no closed L1 vector");
const admitted = caseOf(ballots, "admitted") as DefinitionCase & { readonly panel: string };
const bundle = (format: string, definition = admitted.definition) =>
  verifyBundle(
    parseBundle(
      JSON.stringify({
        format,
        definition,
        clock: ballots.clock,
        l1: {
          firstSegment: closed.firstSegment,
          header: closed.block.header,
          nodes: closed.nodes,
          checkpoints: closed.checkpoints,
        },
        ...(format !== BUNDLE_FORMAT_DEFINITION && { panel: ballots.panels[admitted.panel] }),
        ...(format === BUNDLE_FORMAT_BLOCKS && {
          l1Blocks: run(21_000_000n, [OPENS - 3600n - 12n, 1_767_830_400n + 12n]).map((h) =>
            toHex(h.encoded),
          ),
        }),
      }),
      hex(admitted.board),
    ),
  );
const row = (r: Report, id: string) => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
const COUNTED_ROWS = ["5.9", "6.3", "7.1", "7.2", "7.3", "8.5"];

describe("the whole run", { timeout: 60_000 }, () => {
  test("formats 4 and 5 leave the counted set not reached while 6.1 hasn't passed", () => {
    for (const format of [BUNDLE_FORMAT_CEREMONY, BUNDLE_FORMAT_BLOCKS]) {
      const r = bundle(format);
      expect(row(r, "6.1").status).toBe("unverifiable");
      for (const id of COUNTED_ROWS)
        expect(row(r, id)).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
      for (const member of ["delivery", "cells", "destruction"])
        expect(r).not.toHaveProperty(member);
    }
  });

  test("a definition that stops the board checks leaves them not reached; format 3 doesn't run them", () => {
    const stopped = bundle(BUNDLE_FORMAT_BLOCKS, "00");
    for (const id of COUNTED_ROWS)
      expect(row(stopped, id)).toEqual({ status: "unverifiable", code: "not-reached" });
    const format3 = bundle(BUNDLE_FORMAT_DEFINITION);
    for (const id of COUNTED_ROWS)
      expect(row(format3, id)).toEqual({ status: "unverifiable", code: "not-implemented" });
  });
});
