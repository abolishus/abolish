import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import {
  type BallotCheckV3,
  type BallotRecordV3,
  ballotSignalsV2,
  ballotSignalsV3,
  cellBallotElection,
  checkBallotV2,
  checkBallotV3,
  DecodeError,
  decodeBallot,
  decodeElectionDefinitionV5,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  encodeBallotV3,
  encodeElectionDefinitionV5,
  kemKeygen,
  profileCombinationRule,
  type QuestionBallotElection,
  questionBallotElection,
  RECORD_TYPES,
  type RegisteredKeys,
  selectBallots,
  statementHashV3,
  UnsupportedVersionError,
  verifyMembershipProof,
  finishBallotSteps,
  stepBallotV3,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ballot-v3-records.json comes from an independent Python
// implementation of ballot record version 3 and its admission checks
// (scripts/ballot-v3-records-vectors.py), over ballot-v2-vectors.py's cell
// trees, with membership proofs made by snarkjs over Semaphore's depth-32
// circuit (scripts/ballot-proofs.mjs) and every pairing verdict snarkjs's, so
// the expected encodings, hashes and verdicts never come from the code under
// test.

interface Vectors {
  readonly format: string;
  readonly recordType: string;
  readonly version: number;
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
    readonly encoding: string;
    readonly statementHash: string;
    readonly ballotHash: string;
    readonly message?: string;
    readonly signals?: Readonly<Record<"root" | "nullifier" | "message" | "scope", string>>;
    readonly snarkjs?: boolean;
    readonly result: string;
    readonly option?: number;
    readonly question?: number;
    readonly tier?: number;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset?: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("ballot-v3-records.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const kem = kemKeygen().publicKey;
const keySet = (seats: readonly number[], transcript: Uint8Array): readonly RegisteredKeys[] =>
  checkedKeySetForTests(
    seats.map((index) => ({ index, kemKey: kem, signingKey: new Uint8Array(33) })),
    transcript,
  );

const definitions = new Map<string, ElectionDefinitionV5>(
  Object.entries(vectors.elections).map(([name, e]) => [
    name,
    decodeElectionDefinitionV5(hex(e.definition)),
  ]),
);

const definitionOf = (name: string) => definitions.get(name) as ElectionDefinitionV5;

function electionOf(name: string, seats: readonly number[]): QuestionBallotElection {
  const d = definitionOf(name);
  return questionBallotElection(d, keySet(seats, d.ceremony_transcript_hash));
}

const signalsJson = (s: { root: bigint; nullifier: bigint; message: bigint; scope: bigint }) => ({
  root: String(s.root),
  nullifier: String(s.nullifier),
  message: String(s.message),
  scope: String(s.scope),
});

const codeOf = (r: BallotCheckV3) => (r.ok ? "ok" : r.code);

// The membership proof's offset: the header, definition hash, cell, nullifier
// and L1 reference, at version 2's offsets (Ballot record (version 3)).
const PROOF_AT = 3 + 32 + 1 + 32 + 8 + 32;

describe("ballot-v3-records.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-ballot-vectors/1");
    expect(vectors.recordType).toBe("0x0002");
    expect(vectors.version).toBe(3);
  });

  test.each(Object.entries(vectors.elections))(
    "election %s: a well-formed version-5 definition, its hash, questions, cells and scopes",
    (name, e) => {
      const d = definitionOf(name);
      expect(toHex(encodeElectionDefinitionV5(d))).toBe(e.definition);
      expect(electionDefinitionV5Rule(d)).toBeUndefined();
      // Ballot version 3 with opening version 2, which opens its cores, fits;
      // the vectors' profiles predate the close rule (board-entry version 4,
      // contract-event version 1), which 2.3 now refuses, and fit once they
      // pin board-entry version 5 and contract-event version 6 ([[close]],
      // Version).
      expect(profileCombinationRule(d)).toBe("profile-combination");
      const closing = {
        ...d,
        profile: {
          ...d.profile,
          pins: d.profile.pins.map((p) =>
            p.record_type === RECORD_TYPES.boardEntry
              ? { ...p, version: 5 }
              : p.record_type === RECORD_TYPES.contractEvent
                ? { ...p, version: 6 }
                : p,
          ),
        },
      };
      expect(profileCombinationRule(closing)).toBeUndefined();
      expect(toHex(electionDefinitionV5Hash(d))).toBe(e.definitionHash);
      const election = electionOf(name, [1, 2]);
      expect(toHex(election.definitionHash)).toBe(e.definitionHash);
      expect(election.questions).toEqual(
        e.questions.map(({ optionCount, minSelections, maxSelections }) => ({
          optionCount,
          minSelections,
          maxSelections,
        })),
      );
      expect(election.threshold).toBe(d.threshold);
      expect(election.panelSize).toBe(d.panel_size);
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
    const record = decodeBallot(bytes, 3);
    expect(toHex(encodeBallotV3(record))).toBe(b.encoding);
    const election = electionOf(b.election, b.registered);
    expect(
      toHex(
        statementHashV3(
          {
            questions: election.questions,
            threshold: election.threshold,
            panelSize: election.panelSize,
            definitionHash: record.definition_hash,
            cell: record.cell,
            nullifier: record.nullifier,
          },
          record.committed_vote.vss,
          record.committed_vote.share_hashes,
        ),
      ),
    ).toBe(b.statementHash);
    const signals = ballotSignalsV3(election, record);
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
    const result = checkBallotV3(election, record);
    expect(codeOf(result)).toBe(b.result);
    if (!result.ok) {
      expect(result.option).toBe(b.option);
      expect(result.question).toBe(b.question);
    } else {
      expect(toHex(result.ballotHash)).toBe(b.ballotHash);
      expect(toHex(result.message)).toBe(b.message);
      expect(result.cell).toBe(record.cell);
      expect(result.tier).toBe(b.tier);
      expect(result.nullifier).toBe(record.nullifier);
      expect(result.l1RefNumber).toBe(record.l1_ref_number);
      expect(toHex(result.l1RefHash)).toBe(toHex(record.l1_ref_hash));
    }
  });

  test("batched together, each ballot's result is the one checking it alone gives", () => {
    const pairs = vectors.ballots.map(
      (b) => [electionOf(b.election, b.registered), decodeBallot(hex(b.encoding), 3)] as const,
    );
    const batched = finishBallotSteps(pairs.map(([e, r]) => stepBallotV3(e, r)));
    for (const [i, b] of vectors.ballots.entries()) {
      const [election, record] = pairs[i] as (typeof pairs)[number];
      expect(codeOf(batched[i] as NonNullable<(typeof batched)[number]>)).toBe(b.result);
      expect(batched[i]).toEqual(checkBallotV3(election, record));
    }
  });

  test("covers every admission code version 3 can return, beside acceptance", () => {
    const codes = new Set(vectors.ballots.map((b) => b.result));
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
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("rejects %s", (_, d) => {
    let error: unknown;
    try {
      decodeBallot(hex(d.encoding), 3);
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
const questions = electionOf("questions", [1, 2]);
const honest = hex(vector("ok-cell-0").encoding);

describe("ballot record version 3", () => {
  test("a version-3 record never reads as version 2, and a version-2 context never checks it", () => {
    // The same bytes under version 2 put the range proofs where version 2's
    // one sum proof is, and leave bytes over (T-31).
    expect(() => decodeBallot(Uint8Array.from([0, 2, 2, ...honest.subarray(3)]), 2)).toThrow(
      DecodeError,
    );
    const record = decodeBallot(honest, 3);
    expect(() => checkBallotV2(questions as never, record as never)).toThrow(TypeError);
    expect(() => ballotSignalsV2(questions as never, record as never)).toThrow(TypeError);
    // A version-5 definition has no cell context of version 2.
    const d = definitionOf("questions");
    expect(() =>
      cellBallotElection(d as never, keySet([1, 2], d.ceremony_transcript_hash)),
    ).toThrow(UnsupportedVersionError);
  });

  test("a re-vote is ranked by the cell's tier and nullifier, replacing every answer", () => {
    const first = checkBallotV3(questions, decodeBallot(honest, 3));
    const revote = checkBallotV3(questions, decodeBallot(hex(vector("ok-revote").encoding), 3));
    const other = checkBallotV3(questions, decodeBallot(hex(vector("ok-remainder").encoding), 3));
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

  test("every byte of an admitted ballot is bound: changing one is refused", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: honest.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, delta) => {
          const bytes = Uint8Array.from(honest);
          bytes[at] = ((bytes[at] as number) + delta) & 0xff;
          let record: BallotRecordV3;
          try {
            record = decodeBallot(bytes, 3);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          // Every accepted encoding re-encodes to itself.
          expect(toHex(encodeBallotV3(record))).toBe(toHex(bytes));
          expect(checkBallotV3(questions, record).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  }, 120_000);

  test("any cell outside the partition is ballot-cell, before any proof is read", () => {
    const record = decodeBallot(honest, 3);
    fc.assert(
      fc.property(fc.integer({ min: questions.cells.length, max: 255 }), (cell) => {
        expect(codeOf(checkBallotV3(questions, { ...record, cell }))).toBe("ballot-cell");
        expect(ballotSignalsV3(questions, { ...record, cell })).toBeUndefined();
      }),
      { numRuns },
    );
  });

  test("a ballot passes only under its own election's key set", () => {
    const record = decodeBallot(hex(vector("ok-every-seat").encoding), 3);
    expect(checkBallotV3(electionOf("questions", [1, 2, 3]), record).ok).toBe(true);
    expect(codeOf(checkBallotV3(electionOf("questions", [2, 3]), record))).toBe(
      "share-hash-unqualified",
    );
  });

  test("the questions come from the definition: another election's limits refuse the same ballot", () => {
    // Question 1 as pick up to three (four values, one branch more than the
    // ballot's): the shape check fails before the membership proof, whose
    // scope binds the definition hash anyway (T-28, T-34).
    const record = decodeBallot(honest, 3);
    const d = definitionOf("questions");
    const wider: ElectionDefinitionV5 = {
      ...d,
      questions: d.questions.map((q, i) => (i === 1 ? { ...q, max_selections: 3 } : q)),
    };
    const election = questionBallotElection(wider, keySet([1, 2], wider.ceremony_transcript_hash));
    expect(codeOf(checkBallotV3(election, record))).toBe("ballot-stray");
    expect(
      codeOf(
        checkBallotV3(election, { ...record, definition_hash: electionDefinitionV5Hash(wider) }),
      ),
    ).toBe("validity-shape");
  });
});

describe("question ballot context", () => {
  const d = definitionOf("questions");

  const withPin = (type: number, version: number): ElectionDefinitionV5 => ({
    ...d,
    profile: {
      ...d.profile,
      pins: d.profile.pins.map((p) => (p.record_type === type ? { ...p, version } : p)),
    },
  });

  test("refuses a definition that pins another ballot version, or names another definition version", () => {
    for (const [type, version] of [
      [RECORD_TYPES.ballot, 2],
      [RECORD_TYPES.ballot, 4],
      [RECORD_TYPES.electionDefinition, 4],
    ] as const) {
      const other = withPin(type, version);
      expect(() =>
        questionBallotElection(other, keySet([1, 2], other.ceremony_transcript_hash)),
      ).toThrow(UnsupportedVersionError);
    }
  });

  test("refuses a definition that isn't well-formed", () => {
    // A question whose limits no ballot can meet (`selections`), and one
    // with fewer than two options (`option-count`).
    const first = d.questions[0] as ElectionDefinitionV5["questions"][number];
    for (const change of [{ min_selections: 3, max_selections: 2 }, { option_count: 1 }]) {
      const bad = { ...d, questions: [{ ...first, ...change }] };
      expect(electionDefinitionV5Rule(bad)).toBeDefined();
      expect(() =>
        questionBallotElection(bad, keySet([1, 2], bad.ceremony_transcript_hash)),
      ).toThrow(RangeError);
    }
  });

  test("refuses a key set checked for another transcript, and another membership key", () => {
    expect(() => questionBallotElection(d, keySet([1, 2], new Uint8Array(32)))).toThrow(RangeError);
    const other = { ...d, membership_vk_hash: new Uint8Array(32) };
    expect(() =>
      questionBallotElection(other, keySet([1, 2], other.ceremony_transcript_hash)),
    ).toThrow(RangeError);
  });

  test("refuses a cell root of 0, which anyone can prove membership of (T-04)", () => {
    const electorate = d.electorate.map((t, i) =>
      i === 0 ? { ...t, cells: t.cells.map((c, j) => (j === 1 ? { ...c, root: 0n } : c)) } : t,
    );
    const zero = { ...d, electorate };
    expect(() =>
      questionBallotElection(zero, keySet([1, 2], zero.ceremony_transcript_hash)),
    ).toThrow(RangeError);
  });

  test("overwriting the exposed definition hash or questions changes nothing checked", () => {
    const election = electionOf("questions", [1, 2]);
    const record = decodeBallot(honest, 3);
    const before = checkBallotV3(election, record);
    election.definitionHash.fill(0);
    expect(checkBallotV3(election, record)).toEqual(before);
    expect(before.ok).toBe(true);
    // The context and its questions are frozen.
    expect(Object.isFrozen(election)).toBe(true);
    expect(Object.isFrozen(election.questions)).toBe(true);
    expect(election.questions.every((q) => Object.isFrozen(q))).toBe(true);
  });

  test("checkBallotV3 and ballotSignalsV3 refuse a context questionBallotElection didn't make", () => {
    const record = decodeBallot(honest, 3);
    const copy = { ...questions };
    expect(() => checkBallotV3(copy, record)).toThrow(TypeError);
    expect(() => ballotSignalsV3(copy, record)).toThrow(TypeError);
  });
});
