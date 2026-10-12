import { p256 } from "@noble/curves/nist.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import {
  ballotElection,
  type BallotCheckV2,
  type BallotRecordV2,
  ballotSignalsV2,
  type CellBallotElection,
  cellBallotElection,
  checkBallot,
  checkBallotV2,
  checkDelivery,
  DecodeError,
  decodeBallot,
  decodeElectionDefinitionRecord,
  type ElectionDefinitionV3,
  type ElectionDefinitionV4,
  electionDefinitionV3Hash,
  electionDefinitionV4Hash,
  electionDefinitionV3Rule,
  encodeBallotV2,
  encodeElectionDefinitionV3,
  kemKeygen,
  profileCombinationRule,
  RECORD_TYPES,
  type RegisteredKeys,
  selectBallots,
  UnsupportedVersionError,
  verifyMembershipProof,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ballot-v2.json comes from an independent Python
// implementation of ballot record version 2 and its admission checks
// (scripts/ballot-v2-vectors.py), which builds every cell tree itself by the
// first-occurrence rule, with membership proofs made by snarkjs over
// Semaphore's depth-32 circuit (scripts/ballot-proofs.mjs) and every pairing
// verdict snarkjs's, so the expected encodings, hashes and verdicts never
// come from the code under test.

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
        readonly cells: readonly {
          readonly cell: number;
          readonly tier: number;
          readonly root: string;
          readonly members: string;
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
  readFileSync(new URL("ballot-v2.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const kem = kemKeygen().publicKey;
const keySet = (seats: readonly number[], transcript: Uint8Array): readonly RegisteredKeys[] =>
  checkedKeySetForTests(
    seats.map((index) => ({ index, kemKey: kem, signingKey: new Uint8Array(33) })),
    transcript,
  );

const definitions = new Map<string, ElectionDefinitionV3>(
  Object.entries(vectors.elections).map(([name, e]) => {
    const record = decodeElectionDefinitionRecord(hex(e.definition));
    if (record.version !== 3) throw new Error(`${name}: expected definition version 3`);
    return [name, record.value as ElectionDefinitionV3];
  }),
);

function electionOf(name: string, seats: readonly number[]): CellBallotElection {
  const d = definitions.get(name) as ElectionDefinitionV3;
  return cellBallotElection(d, keySet(seats, d.ceremony_transcript_hash));
}

const signalsJson = (s: { root: bigint; nullifier: bigint; message: bigint; scope: bigint }) => ({
  root: String(s.root),
  nullifier: String(s.nullifier),
  message: String(s.message),
  scope: String(s.scope),
});

const codeOf = (r: BallotCheckV2) => (r.ok ? "ok" : r.code);

describe("ballot-v2.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-ballot-vectors/1");
    expect(vectors.recordType).toBe("0x0002");
    expect(vectors.version).toBe(2);
  });

  test.each(Object.entries(vectors.elections))(
    "election %s: a well-formed version-3 definition, its hash, cells, roots and scopes",
    (name, e) => {
      const d = definitions.get(name) as ElectionDefinitionV3;
      expect(toHex(encodeElectionDefinitionV3(d))).toBe(e.definition);
      expect(electionDefinitionV3Rule(d)).toBeUndefined();
      expect(profileCombinationRule(d)).toBeUndefined();
      expect(toHex(electionDefinitionV3Hash(d))).toBe(e.definitionHash);
      const election = electionOf(name, [1, 2]);
      expect(toHex(election.definitionHash)).toBe(e.definitionHash);
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
    const record = decodeBallot(bytes, 2);
    expect(toHex(encodeBallotV2(record))).toBe(b.encoding);
    const election = electionOf(b.election, b.registered);
    const signals = ballotSignalsV2(election, record);
    if (b.signals === undefined) expect(signals).toBeUndefined();
    else {
      expect(signalsJson(signals as NonNullable<typeof signals>)).toEqual(b.signals);
      // The pairing's verdict on these signals is snarkjs's.
      expect(
        verifyMembershipProof(bytes.subarray(108, 364), signals as NonNullable<typeof signals>),
      ).toBe(b.snarkjs);
    }
    const result = checkBallotV2(election, record);
    expect(codeOf(result)).toBe(b.result);
    if (!result.ok) expect(result.option).toBe(b.option);
    else {
      expect(toHex(result.ballotHash)).toBe(b.ballotHash);
      expect(toHex(result.message)).toBe(b.message);
      expect(result.cell).toBe(record.cell);
      expect(result.tier).toBe(b.tier);
      expect(result.nullifier).toBe(record.nullifier);
      expect(result.l1RefNumber).toBe(record.l1_ref_number);
      expect(toHex(result.l1RefHash)).toBe(toHex(record.l1_ref_hash));
    }
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("rejects %s", (_, d) => {
    let error: unknown;
    try {
      decodeBallot(hex(d.encoding), 2);
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
const regional = electionOf("regional", [1, 2]);
const honest = hex(vector("ok-cell-0").encoding);

describe("ballot record version 2", () => {
  test("the statement hash binds the version and the cell: a version-2 ballot's proofs verify only as version 2", () => {
    const record = decodeBallot(honest, 2);
    // The same bytes read as version 1 name tier 0 in the version-1 statement,
    // so the validity proofs fail there (T-31).
    const asV1 = decodeBallot(Uint8Array.from([0, 2, 1, ...honest.subarray(3)]), 1);
    expect(asV1.tier).toBe(record.cell);
    const d = definitions.get("regional") as ElectionDefinitionV3;
    expect(() => ballotElection(d as never, keySet([1, 2], d.ceremony_transcript_hash))).toThrow(
      UnsupportedVersionError,
    );
    expect(checkBallotV2(regional, record).ok).toBe(true);
    expect(() => checkBallot(regional as never, asV1)).toThrow(TypeError);
  });

  test("a re-vote in a cell is ranked by the cell's tier and nullifier", () => {
    const first = checkBallotV2(regional, decodeBallot(honest, 2));
    const revote = checkBallotV2(regional, decodeBallot(hex(vector("ok-revote").encoding), 2));
    const other = checkBallotV2(
      regional,
      decodeBallot(hex(vector("ok-remainder-region-1").encoding), 2),
    );
    if (!first.ok || !revote.ok || !other.ok) throw new Error("expected admitted ballots");
    expect(revote.nullifier).toBe(first.nullifier);
    // Cells 0 and 1 are both tier 0; their members' nullifiers differ.
    expect(other.tier).toBe(first.tier);
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
          let record: BallotRecordV2;
          try {
            record = decodeBallot(bytes, 2);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          // Every accepted encoding re-encodes to itself.
          expect(toHex(encodeBallotV2(record))).toBe(toHex(bytes));
          expect(checkBallotV2(regional, record).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  }, 120_000);

  test("any cell outside the partition is ballot-cell, before any proof is read", () => {
    const record = decodeBallot(honest, 2);
    fc.assert(
      fc.property(fc.integer({ min: regional.cells.length, max: 255 }), (cell) => {
        expect(codeOf(checkBallotV2(regional, { ...record, cell }))).toBe("ballot-cell");
        expect(ballotSignalsV2(regional, { ...record, cell })).toBeUndefined();
      }),
      { numRuns },
    );
  });

  test("a ballot passes only under its own election's key set", () => {
    const record = decodeBallot(hex(vector("ok-every-seat").encoding), 2);
    expect(checkBallotV2(electionOf("regional", [1, 2, 3]), record).ok).toBe(true);
    expect(codeOf(checkBallotV2(electionOf("regional", [2, 3]), record))).toBe(
      "share-hash-unqualified",
    );
  });

  test("delivery hashes a version-2 ballot by its cell", () => {
    const record = decodeBallot(honest, 2);
    const d = definitions.get("regional") as ElectionDefinitionV3;
    const report = checkDelivery(
      {
        definitionHash: electionDefinitionV3Hash(d),
        panelSize: 3,
        registered: keySet([1, 2], d.ceremony_transcript_hash),
        segments: { delivery: 10n, complaint: 20n },
        deadlines: { delivery: 10n, complaint: 20n },
      },
      [
        {
          ballotVersion: 2,
          cell: record.cell,
          nullifier: record.nullifier,
          vote: record.committed_vote,
        },
      ],
      [],
      1,
    );
    // Nothing delivered it, so it doesn't count; the report names its ballot hash.
    expect(report.ballots.map((b) => toHex(b.ballotHash))).toEqual([
      vector("ok-cell-0").ballotHash,
    ]);
  });
});

describe("cell ballot context", () => {
  const d = definitions.get("regional") as ElectionDefinitionV3;

  const withPin = (type: number, version: number): ElectionDefinitionV3 => ({
    ...d,
    profile: {
      ...d.profile,
      pins: d.profile.pins.map((p) => (p.record_type === type ? { ...p, version } : p)),
    },
  });

  test("refuses a definition that pins another ballot version", () => {
    const other = withPin(RECORD_TYPES.ballot, 1);
    expect(() => cellBallotElection(other, keySet([1, 2], other.ceremony_transcript_hash))).toThrow(
      UnsupportedVersionError,
    );
  });

  test("reads a definition version 4, version 3's partition with receipt keys", () => {
    const v4: ElectionDefinitionV4 = {
      ...withPin(RECORD_TYPES.electionDefinition, 4),
      receipt_keys: [p256.getPublicKey(new Uint8Array(32).fill(7), true)],
    };
    const election = cellBallotElection(v4, keySet([1, 2], v4.ceremony_transcript_hash));
    expect(toHex(election.definitionHash)).toBe(toHex(electionDefinitionV4Hash(v4)));
    expect(election.cells.map((c) => c.root)).toEqual(regional.cells.map((c) => c.root));
    // Another definition hash, so other scopes: a version-3 ballot doesn't pass here.
    expect(election.cells[0]?.scope).not.toBe(regional.cells[0]?.scope);
    expect(codeOf(checkBallotV2(election, decodeBallot(honest, 2)))).toBe("ballot-stray");
    // A value's layout must be the version its own pin names.
    const mislabelled = withPin(RECORD_TYPES.electionDefinition, 4);
    expect(() =>
      cellBallotElection(mislabelled, keySet([1, 2], mislabelled.ceremony_transcript_hash)),
    ).toThrow(UnsupportedVersionError);
    const asV3 = { ...v4, profile: d.profile };
    expect(() => cellBallotElection(asV3, keySet([1, 2], asV3.ceremony_transcript_hash))).toThrow(
      UnsupportedVersionError,
    );
  });

  test("refuses a key set checked for another transcript, and another membership key", () => {
    expect(() => cellBallotElection(d, keySet([1, 2], new Uint8Array(32)))).toThrow(RangeError);
    const other = { ...d, membership_vk_hash: new Uint8Array(32) };
    expect(() => cellBallotElection(other, keySet([1, 2], other.ceremony_transcript_hash))).toThrow(
      RangeError,
    );
  });

  test("refuses a cell root of 0, which anyone can prove membership of (T-04)", () => {
    const electorate = d.electorate.map((t, i) =>
      i === 0 ? { ...t, cells: t.cells.map((c, j) => (j === 1 ? { ...c, root: 0n } : c)) } : t,
    );
    const zero = { ...d, electorate };
    expect(() => cellBallotElection(zero, keySet([1, 2], zero.ceremony_transcript_hash))).toThrow(
      RangeError,
    );
  });

  test("overwriting the exposed definition hash changes nothing checked", () => {
    const election = electionOf("regional", [1, 2]);
    const record = decodeBallot(honest, 2);
    const before = checkBallotV2(election, record);
    election.definitionHash.fill(0);
    expect(checkBallotV2(election, record)).toEqual(before);
    expect(before.ok).toBe(true);
  });

  test("checkBallotV2 and ballotSignalsV2 refuse a context cellBallotElection didn't make", () => {
    const record = decodeBallot(honest, 2);
    const copy = { ...regional };
    expect(() => checkBallotV2(copy, record)).toThrow(TypeError);
    expect(() => ballotSignalsV2(copy, record)).toThrow(TypeError);
  });
});
