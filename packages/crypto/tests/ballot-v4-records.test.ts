import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { admitForIntake, admitForIntakeV4, panelBallotElectionWith } from "../src/ballot.ts";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import {
  type BallotCheckV4,
  type BallotRecordV4,
  ballotSignalsV3,
  ballotSignalsV4,
  checkBallotV3,
  checkBallotV4,
  cellBallotCore,
  checkChallengeOpeningV2,
  DecodeError,
  decodeBallot,
  decodeElectionDefinitionV6,
  type ElectionDefinitionV6,
  electionDefinitionV6Hash,
  electionDefinitionV6Rule,
  encodeBallotV4,
  encodeElectionDefinitionV6,
  kemKeygen,
  type PanelBallotElection,
  panelBallotElection,
  questionBallotElection,
  RECORD_TYPES,
  type RegisteredKeys,
  RESULTS_MODES,
  SEAT_PANELS,
  type SeatPanel,
  selectBallots,
  statementHashV4,
  UnsupportedVersionError,
  verifyMembershipProof,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ballot-v4-records.json comes from an independent Python
// implementation of ballot record version 4, its admission checks and
// intake's admission at a seat of either panel
// (scripts/ballot-v4-records-vectors.py), over ballot-v2-vectors.py's cell
// trees and ballot-v4-vectors.py's committed votes, with membership proofs
// made by snarkjs over Semaphore's depth-32 circuit (scripts/ballot-proofs.mjs)
// and every pairing verdict snarkjs's, so the expected encodings, hashes and
// verdicts never come from the code under test.

// An outcome, under its own key in each vector so it never collides with
// the vector's inputs.
type Admission = {
  readonly code: string;
  readonly option?: number;
  readonly question?: number;
  readonly panel?: number;
  readonly seat?: number;
  readonly ballotHash?: string;
  readonly message?: string;
  readonly tier?: number;
  readonly cell?: number;
};

interface Vectors {
  readonly format: string;
  readonly recordType: string;
  readonly version: number;
  readonly panels: { readonly default: number; readonly author: number };
  readonly elections: Readonly<
    Record<
      string,
      {
        readonly definition: string;
        readonly definitionHash: string;
        readonly questions: readonly {
          readonly optionCount: number;
          readonly minSelections: number;
          readonly maxSelections: number;
          readonly offset: number;
        }[];
        readonly threshold: number;
        readonly panelSize: number;
        readonly authorThreshold: number;
        readonly authorPanelSize: number;
        readonly cells: readonly {
          readonly cell: number;
          readonly tier: number;
          readonly root: string;
          readonly scope: string;
        }[];
      }
    >
  >;
  readonly ballots: readonly {
    readonly id: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly authorRegistered: readonly number[];
    readonly encoding: string;
    readonly statementHash: string;
    readonly signals?: Readonly<Record<"root" | "nullifier" | "message" | "scope", string>>;
    readonly snarkjs?: boolean;
    readonly admission: Admission;
  }[];
  readonly intakes: readonly {
    readonly id: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly authorRegistered: readonly number[];
    readonly panel: number;
    readonly seat: number;
    readonly shareHash: string;
    readonly record: string;
    readonly snarkjs?: boolean;
    readonly admission: Admission;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset?: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("ballot-v4-records.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const kem = kemKeygen().publicKey;
const keySet = (seats: readonly number[], transcript: Uint8Array): readonly RegisteredKeys[] =>
  checkedKeySetForTests(
    seats.map((index) => ({ index, kemKey: kem, signingKey: new Uint8Array(33) })),
    transcript,
  );

const definitions = new Map<string, ElectionDefinitionV6>(
  Object.entries(vectors.elections).map(([name, e]) => [
    name,
    decodeElectionDefinitionV6(hex(e.definition)),
  ]),
);

const definitionOf = (name: string) => definitions.get(name) as ElectionDefinitionV6;

// The author panel's registered key set is P2-16 part 3's, so a context with
// an author panel comes from the internal seam that takes its seats as given.
function electionOf(
  name: string,
  seats: readonly number[],
  authorSeats: readonly number[],
): PanelBallotElection {
  const d = definitionOf(name);
  const registered = keySet(seats, d.ceremony_transcript_hash);
  return d.author_keys.length === 0 && authorSeats.length === 0
    ? panelBallotElection(d, registered)
    : panelBallotElectionWith(d, registered, authorSeats);
}

const signalsJson = (s: { root: bigint; nullifier: bigint; message: bigint; scope: bigint }) => ({
  root: String(s.root),
  nullifier: String(s.nullifier),
  message: String(s.message),
  scope: String(s.scope),
});

// A result as the vectors write it.
function admissionOf(r: BallotCheckV4 | ReturnType<typeof admitForIntakeV4>): Admission {
  if (!r.ok) {
    const out: Record<string, unknown> = { code: r.code };
    for (const key of ["option", "question", "panel", "seat"] as const)
      if (r[key] !== undefined) out[key] = r[key];
    return out as Admission;
  }
  return {
    code: "ok",
    ballotHash: toHex(r.ballotHash),
    message: toHex(r.message),
    tier: r.tier,
    cell: r.cell,
  };
}

// The membership proof's offset: the header, definition hash, cell, nullifier
// and L1 reference, at version 3's offsets (Ballot record (version 4)).
const PROOF_AT = 3 + 32 + 1 + 32 + 8 + 32;

describe("ballot-v4-records.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-ballot-vectors/1");
    expect(vectors.recordType).toBe("0x0002");
    expect(vectors.version).toBe(4);
    expect(vectors.panels).toEqual(SEAT_PANELS);
  });

  test.each(Object.entries(vectors.elections))(
    "election %s: a well-formed version-6 definition, its hash, questions, panels, cells and scopes",
    (name, e) => {
      const d = definitionOf(name);
      expect(toHex(encodeElectionDefinitionV6(d))).toBe(e.definition);
      expect(electionDefinitionV6Rule(d)).toBeUndefined();
      expect(toHex(electionDefinitionV6Hash(d))).toBe(e.definitionHash);
      const election = electionOf(name, [1, 2], e.authorPanelSize === 0 ? [] : [1, 2]);
      expect(toHex(election.definitionHash)).toBe(e.definitionHash);
      expect(election.questions).toEqual(
        e.questions.map(({ optionCount, minSelections, maxSelections }) => ({
          optionCount,
          minSelections,
          maxSelections,
        })),
      );
      expect(election.threshold).toBe(e.threshold);
      expect(election.panelSize).toBe(e.panelSize);
      expect(election.authorThreshold).toBe(e.authorThreshold);
      expect(election.authorPanelSize).toBe(e.authorPanelSize);
      expect(
        election.cells.map((c) => ({
          cell: c.cell,
          tier: c.tier,
          root: String(c.root),
          scope: String(c.scope),
        })),
      ).toEqual(e.cells.map((c) => ({ cell: c.cell, tier: c.tier, root: c.root, scope: c.scope })));
    },
  );

  test.each(vectors.ballots.map((b) => [b.id, b] as const))("%s", (_, b) => {
    const bytes = hex(b.encoding);
    const record = decodeBallot(bytes, 4);
    expect(toHex(encodeBallotV4(record))).toBe(b.encoding);
    const election = electionOf(b.election, b.registered, b.authorRegistered);
    expect(
      toHex(
        statementHashV4(
          {
            questions: election.questions,
            threshold: election.threshold,
            panelSize: election.panelSize,
            authorThreshold: election.authorThreshold,
            authorPanelSize: election.authorPanelSize,
            definitionHash: record.definition_hash,
            cell: record.cell,
            nullifier: record.nullifier,
          },
          record.committed_vote,
        ),
      ),
    ).toBe(b.statementHash);
    const signals = ballotSignalsV4(election, record);
    if (b.signals === undefined) expect(signals).toBeUndefined();
    else {
      expect(signalsJson(signals as NonNullable<typeof signals>)).toEqual(b.signals);
      // The pairing's verdict on these signals is snarkjs's.
      expect(
        verifyMembershipProof(
          bytes.subarray(PROOF_AT, PROOF_AT + 256),
          signals as NonNullable<typeof signals>,
        ),
      ).toBe(b.snarkjs);
    }
    const result = checkBallotV4(election, record);
    expect(admissionOf(result)).toEqual(b.admission);
    if (result.ok) {
      expect(result.nullifier).toBe(record.nullifier);
      expect(result.l1RefNumber).toBe(record.l1_ref_number);
      expect(toHex(result.l1RefHash)).toBe(toHex(record.l1_ref_hash));
    }
  });

  test("covers every admission code version 4 can return, beside acceptance, and both panels' unqualified seats", () => {
    const codes = new Set(vectors.ballots.map((b) => b.admission.code));
    for (const code of [
      "ok",
      "ballot-stray",
      "ballot-cell",
      "validity-shape",
      "share-hash-unqualified",
      "membership-proof",
      "option-proof",
      "sum-proof",
    ])
      expect(codes.has(code)).toBe(true);
    const panels = new Set(
      vectors.ballots
        .filter((b) => b.admission.code === "share-hash-unqualified")
        .map((b) => b.admission.panel),
    );
    expect(panels).toEqual(new Set([SEAT_PANELS.default, SEAT_PANELS.author]));
  });

  test.each(vectors.intakes.map((c) => [c.id, c] as const))("%s", (_, c) => {
    const election = electionOf(c.election, c.registered, c.authorRegistered);
    const result = admitForIntakeV4(
      election,
      hex(c.record),
      c.panel as SeatPanel,
      c.seat,
      hex(c.shareHash),
    );
    expect(admissionOf(result)).toEqual(c.admission);
    if (result.ok) {
      expect(result.panel).toBe(c.panel);
      // What the seat's decryption and receipt will run under (part 2b-3).
      expect(toHex(result.ctx.definitionHash)).toBe(toHex(election.definitionHash));
      expect(result.ctx.authorPanelSize).toBe(election.authorPanelSize);
      expect(toHex(encodeBallotV4({ ...decodeBallot(hex(c.record), 4) }))).toBe(c.record);
    }
  });

  test("intake covers both panels, a hash of the other panel's same seat, and every intake code", () => {
    const codes = new Set(vectors.intakes.map((c) => c.admission.code));
    for (const code of [
      "ok",
      "delivery-malformed",
      "ballot-stray",
      "ballot-cell",
      "validity-shape",
      "share-hash-unqualified",
      "share-hash",
      "membership-proof",
      "sum-proof",
    ])
      expect(codes.has(code)).toBe(true);
    for (const panel of [SEAT_PANELS.default, SEAT_PANELS.author])
      expect(vectors.intakes.some((c) => c.panel === panel && c.admission.code === "ok")).toBe(
        true,
      );
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("rejects %s", (_, d) => {
    let error: unknown;
    try {
      decodeBallot(hex(d.encoding), 4);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).code).toBe(d.error);
    if (d.offset !== undefined) expect((error as DecodeError).offset).toBe(d.offset);
  });
});

const byId = new Map(vectors.ballots.map((b) => [b.id, b]));
const vector = (id: string) => byId.get(id) as NonNullable<ReturnType<typeof byId.get>>;
const panels = electionOf("panels", [1, 2], [1, 2]);
const honest = hex(vector("ok-cell-0").encoding);
const everySeat = hex(vector("ok-every-seat").encoding);

describe("ballot record version 4", () => {
  test("a version-4 record never reads as version 3, and a version-3 context never checks it", () => {
    // The same bytes under version 3 read the author half where version 3's
    // option proofs are, and leave bytes over or run short (T-31).
    expect(() => decodeBallot(Uint8Array.from([0, 2, 3, ...honest.subarray(3)]), 3)).toThrow(
      DecodeError,
    );
    const record = decodeBallot(honest, 4);
    expect(() => checkBallotV3(panels as never, record as never)).toThrow(TypeError);
    expect(() => ballotSignalsV3(panels as never, record as never)).toThrow(TypeError);
    // Version 1 to 3's intake never reads a version-4 context.
    expect(() => admitForIntake(panels as never, honest, 1, new Uint8Array(32))).toThrow(TypeError);
    // Opening version 2 never opens a version-4 core, which carries an
    // author half: its cores and checks refuse a version-4 context (T-42).
    const notCell = /expected a context made by cellBallotElection or questionBallotElection/;
    expect(() => cellBallotCore(panels as never, 0, {} as never)).toThrow(notCell);
    expect(() => checkChallengeOpeningV2(panels as never, {} as never)).toThrow(notCell);
    // A version-6 definition has no question context of version 3.
    const d = definitionOf("default-only");
    expect(() =>
      questionBallotElection(d as never, keySet([1, 2], d.ceremony_transcript_hash)),
    ).toThrow(UnsupportedVersionError);
  });

  test("a re-vote is ranked by the cell's tier and nullifier, replacing every answer", () => {
    const first = checkBallotV4(panels, decodeBallot(honest, 4));
    const revote = checkBallotV4(panels, decodeBallot(hex(vector("ok-revote").encoding), 4));
    const other = checkBallotV4(panels, decodeBallot(hex(vector("ok-tier-2-least").encoding), 4));
    if (!first.ok || !revote.ok || !other.ok) throw new Error("expected admitted ballots");
    expect(revote.nullifier).toBe(first.nullifier);
    expect(revote.tier).toBe(first.tier);
    expect(other.nullifier).not.toBe(first.nullifier);
    const admitted = [first, revote, other].map((r, i) => ({
      tier: r.tier,
      nullifier: r.nullifier,
      message: r.message,
      l1RefNumber: r.l1RefNumber,
      index: BigInt(i),
    }));
    const selection = selectBallots(admitted);
    const newer = first.l1RefNumber > revote.l1RefNumber ? 0n : 1n;
    expect(new Set(selection.selected.map((r) => r.index))).toEqual(new Set([newer, 2n]));
  });

  test("every byte of an admitted ballot is bound, the author half's included: changing one is refused", () => {
    const election = electionOf("panels", [1, 2, 3], [1, 2, 3]);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: everySeat.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, delta) => {
          const bytes = Uint8Array.from(everySeat);
          bytes[at] = ((bytes[at] as number) + delta) & 0xff;
          let record: BallotRecordV4;
          try {
            record = decodeBallot(bytes, 4);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          // Every accepted encoding re-encodes to itself.
          expect(toHex(encodeBallotV4(record))).toBe(toHex(bytes));
          expect(checkBallotV4(election, record).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  }, 300_000);

  test("any cell outside the partition is ballot-cell, before any proof is read", () => {
    const record = decodeBallot(honest, 4);
    fc.assert(
      fc.property(fc.integer({ min: panels.cells.length, max: 255 }), (cell) => {
        expect(checkBallotV4(panels, { ...record, cell }).ok).toBe(false);
        expect(admissionOf(checkBallotV4(panels, { ...record, cell })).code).toBe("ballot-cell");
        expect(ballotSignalsV4(panels, { ...record, cell })).toBeUndefined();
      }),
      { numRuns },
    );
  });

  test("an unregistered seat of either panel is named with its panel, default seats first", () => {
    const record = decodeBallot(everySeat, 4);
    const all = [1, 2, 3];
    fc.assert(
      fc.property(
        fc.subarray(all, { minLength: 1 }),
        fc.subarray(all, { minLength: 1 }),
        (seats, authorSeats) => {
          const r = checkBallotV4(electionOf("panels", seats, authorSeats), record);
          const missing = all.find((s) => !seats.includes(s));
          const missingAuthor = all.find((s) => !authorSeats.includes(s));
          if (missing === undefined && missingAuthor === undefined) expect(r.ok).toBe(true);
          else
            expect(admissionOf(r)).toEqual(
              missing !== undefined
                ? { code: "share-hash-unqualified", panel: SEAT_PANELS.default, seat: missing }
                : {
                    code: "share-hash-unqualified",
                    panel: SEAT_PANELS.author,
                    seat: missingAuthor,
                  },
            );
        },
      ),
      { numRuns },
    );
  });

  test("intake at a seat takes only that seat's hash of its own panel", () => {
    const election = electionOf("panels", [1, 2, 3], [1, 2, 3]);
    const { committed_vote: vote } = decodeBallot(everySeat, 4);
    const lists = { 1: vote.share_hashes, 2: vote.author_share_hashes } as const;
    fc.assert(
      fc.property(
        fc.constantFrom<SeatPanel>(1, 2),
        fc.integer({ min: 1, max: 3 }),
        fc.constantFrom<SeatPanel>(1, 2),
        fc.integer({ min: 1, max: 3 }),
        (panel, seat, fromPanel, fromSeat) => {
          const hash = lists[fromPanel][fromSeat - 1] as Uint8Array;
          const r = admitForIntakeV4(election, everySeat, panel, seat, hash);
          expect(r.ok).toBe(panel === fromPanel && seat === fromSeat);
          if (!r.ok) expect(r.code).toBe("share-hash");
        },
      ),
      { numRuns: Math.min(numRuns, 40) },
    );
  }, 120_000);

  test("intake refuses a seat outside its panel's registered key set, and a panel that isn't 1 or 2", () => {
    const election = electionOf("panels", [1, 2], [1, 3]);
    const hash = new Uint8Array(32);
    expect(() => admitForIntakeV4(election, everySeat, 2, 2, hash)).toThrow(RangeError);
    expect(() => admitForIntakeV4(election, everySeat, 1, 3, hash)).toThrow(RangeError);
    expect(() => admitForIntakeV4(election, everySeat, 3 as SeatPanel, 1, hash)).toThrow(
      RangeError,
    );
    expect(() => admitForIntakeV4(election, everySeat, 2, 1, hash.subarray(1))).toThrow(RangeError);
    const none = electionOf("default-only", [1, 2], []);
    expect(() => admitForIntakeV4(none, everySeat, 2, 1, hash)).toThrow(RangeError);
  });
});

describe("panel ballot context", () => {
  const d = definitionOf("panels");
  const plain = definitionOf("default-only");

  const withPin = (
    def: ElectionDefinitionV6,
    type: number,
    version: number,
  ): ElectionDefinitionV6 => ({
    ...def,
    profile: {
      ...def.profile,
      pins: def.profile.pins.map((p) => (p.record_type === type ? { ...p, version } : p)),
    },
  });

  test("the entry point exposes neither the author-seat seam nor version 4's intake admission", async () => {
    // The seam takes author seats nothing has checked against
    // `author_transcript_hash`; exported, it would let any caller pass seats
    // it controls off as author seats (T-17, T-37). Part 3 replaces it.
    const api: Record<string, unknown> = await import("../src/index.ts");
    expect(api).not.toHaveProperty("panelBallotElectionWith");
    expect(api).not.toHaveProperty("admitForIntakeV4");
    expect(api).toHaveProperty("panelBallotElection");
  });

  test("refuses a definition with an author panel until that panel's key set can be checked (P2-16 part 3)", () => {
    expect(() => panelBallotElection(d, keySet([1, 2], d.ceremony_transcript_hash))).toThrow(
      RangeError,
    );
    expect(
      panelBallotElection(plain, keySet([1, 2], plain.ceremony_transcript_hash)).authorPanelSize,
    ).toBe(0);
  });

  test("refuses a definition that pins another ballot version, or names another definition version", () => {
    for (const [type, version] of [
      [RECORD_TYPES.ballot, 3],
      [RECORD_TYPES.ballot, 5],
      [RECORD_TYPES.electionDefinition, 5],
    ] as const) {
      const other = withPin(plain, type, version);
      expect(() =>
        panelBallotElection(other, keySet([1, 2], other.ceremony_transcript_hash)),
      ).toThrow(UnsupportedVersionError);
    }
  });

  test("refuses a definition that isn't well-formed", () => {
    // A question whose limits no ballot can meet, and a live poll without
    // its schedule (`results`).
    const first = plain.questions[0] as ElectionDefinitionV6["questions"][number];
    for (const bad of [
      { ...plain, questions: [{ ...first, min_selections: 3, max_selections: 2 }] },
      { ...plain, results_mode: RESULTS_MODES.live },
    ] as ElectionDefinitionV6[]) {
      expect(electionDefinitionV6Rule(bad)).toBeDefined();
      expect(() => panelBallotElection(bad, keySet([1, 2], bad.ceremony_transcript_hash))).toThrow(
        RangeError,
      );
    }
  });

  test("refuses a key set checked for another transcript, another membership key and a cell root of 0", () => {
    expect(() => panelBallotElection(plain, keySet([1, 2], new Uint8Array(32)))).toThrow(
      RangeError,
    );
    const other = { ...plain, membership_vk_hash: new Uint8Array(32) };
    expect(() =>
      panelBallotElection(other, keySet([1, 2], other.ceremony_transcript_hash)),
    ).toThrow(RangeError);
    const electorate = plain.electorate.map((t, i) =>
      i === 0 ? { ...t, cells: t.cells.map((c, j) => (j === 1 ? { ...c, root: 0n } : c)) } : t,
    );
    const zero = { ...plain, electorate };
    expect(() => panelBallotElection(zero, keySet([1, 2], zero.ceremony_transcript_hash))).toThrow(
      RangeError,
    );
  });

  test("the seam takes only distinct author seats of the author panel", () => {
    const registered = keySet([1, 2], d.ceremony_transcript_hash);
    for (const seats of [[0], [4], [1, 1], [1.5], [-1]])
      expect(() => panelBallotElectionWith(d, registered, seats)).toThrow(RangeError);
    expect(() =>
      panelBallotElectionWith(plain, keySet([1, 2], plain.ceremony_transcript_hash), [1]),
    ).toThrow(RangeError);
    expect(panelBallotElectionWith(d, registered, [3, 1]).authorQualified).toEqual([3, 1]);
  });

  test("overwriting the exposed definition hash or seat lists changes nothing checked", () => {
    const election = electionOf("panels", [1, 2], [1, 2]);
    const record = decodeBallot(honest, 4);
    const before = checkBallotV4(election, record);
    election.definitionHash.fill(0);
    expect(checkBallotV4(election, record)).toEqual(before);
    expect(before.ok).toBe(true);
    expect(Object.isFrozen(election)).toBe(true);
    expect(Object.isFrozen(election.questions)).toBe(true);
    expect(Object.isFrozen(election.qualified)).toBe(true);
    expect(Object.isFrozen(election.authorQualified)).toBe(true);
  });

  test("checkBallotV4, ballotSignalsV4 and admitForIntakeV4 refuse a context panelBallotElection didn't make", () => {
    const record = decodeBallot(honest, 4);
    const copy = { ...panels };
    expect(() => checkBallotV4(copy, record)).toThrow(TypeError);
    expect(() => ballotSignalsV4(copy, record)).toThrow(TypeError);
    expect(() => admitForIntakeV4(copy, honest, 1, 1, new Uint8Array(32))).toThrow(TypeError);
  });
});
