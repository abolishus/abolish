import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { verifyDecodedMembershipProof } from "../src/membership-proof.ts";
import {
  type BallotCheck,
  type BallotElection,
  ballotElection,
  type BallotRecord,
  ballotSignals,
  checkBallot,
  DecodeError,
  decodeBallot,
  decodeElectionDefinition,
  decodeMembershipProof,
  electionDefinitionHash,
  type ElectionDefinition,
  encodeBallot,
  encodeElectionDefinition,
  kemKeygen,
  type RegisteredKeys,
  selectBallots,
  UnsupportedVersionError,
  verifyMembershipProof,
  finishBallotStep,
  finishBallotSteps,
  stepBallot,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ballot.json comes from an independent Python
// implementation of the ballot record and its admission checks
// (scripts/ballot-vectors.py), with membership proofs made by snarkjs over
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
        readonly tiers: readonly {
          readonly tier: number;
          readonly root: string;
          readonly scope: string;
        }[];
      }
    >
  >;
  readonly ballots: readonly {
    readonly id: string;
    readonly description: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly encoding: string;
    readonly ballotHash: string;
    readonly message?: string;
    readonly signals?: Readonly<Record<"root" | "nullifier" | "message" | "scope", string>>;
    readonly snarkjs?: boolean;
    readonly result: string;
    readonly option?: number;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly description: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset?: number;
  }[];
}

const vectors = JSON.parse(readFileSync(new URL("ballot.json", SPEC_VECTORS), "utf8")) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const kem = kemKeygen().publicKey;
const keySet = (seats: readonly number[], transcript: Uint8Array): readonly RegisteredKeys[] =>
  checkedKeySetForTests(
    seats.map((index) => ({ index, kemKey: kem, signingKey: new Uint8Array(33) })),
    transcript,
  );

const definitions = new Map<string, ElectionDefinition>(
  Object.entries(vectors.elections).map(([name, e]) => [
    name,
    decodeElectionDefinition(hex(e.definition)),
  ]),
);

function electionOf(name: string, seats: readonly number[]): BallotElection {
  const d = definitions.get(name) as ElectionDefinition;
  return ballotElection(d, keySet(seats, d.ceremony_transcript_hash));
}

const signalsJson = (s: { root: bigint; nullifier: bigint; message: bigint; scope: bigint }) => ({
  root: String(s.root),
  nullifier: String(s.nullifier),
  message: String(s.message),
  scope: String(s.scope),
});

const codeOf = (r: BallotCheck) => (r.ok ? "ok" : r.code);

describe("ballot.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-ballot-vectors/1");
    expect(vectors.recordType).toBe("0x0002");
    expect(vectors.version).toBe(1);
  });

  test.each(Object.entries(vectors.elections))(
    "election %s: definition hash, tiers, roots and scopes",
    (name, e) => {
      const d = definitions.get(name) as ElectionDefinition;
      expect(toHex(electionDefinitionHash(d))).toBe(e.definitionHash);
      const election = electionOf(name, [1, 2]);
      expect(toHex(election.definitionHash)).toBe(e.definitionHash);
      expect(
        election.tiers.map((t) => ({ tier: t.tier, root: String(t.root), scope: String(t.scope) })),
      ).toEqual(e.tiers.map((t) => ({ tier: t.tier, root: t.root, scope: t.scope })));
    },
  );

  test.each(vectors.ballots.map((b) => [b.id, b] as const))("%s", (_, b) => {
    const bytes = hex(b.encoding);
    const record = decodeBallot(bytes, 1);
    expect(toHex(encodeBallot(record))).toBe(b.encoding);
    const election = electionOf(b.election, b.registered);
    const signals = ballotSignals(election, record);
    if (b.signals === undefined) expect(signals).toBeUndefined();
    else {
      expect(signalsJson(signals as NonNullable<typeof signals>)).toEqual(b.signals);
      // The pairing's verdict on these signals is snarkjs's.
      expect(
        verifyMembershipProof(bytes.subarray(108, 364), signals as NonNullable<typeof signals>),
      ).toBe(b.snarkjs);
    }
    const result = checkBallot(election, record);
    expect(codeOf(result)).toBe(b.result);
    if (!result.ok) expect(result.option).toBe(b.option);
    else {
      expect(toHex(result.ballotHash)).toBe(b.ballotHash);
      expect(toHex(result.message)).toBe(b.message);
      expect(result.tier).toBe(record.tier);
      expect(result.nullifier).toBe(record.nullifier);
      expect(result.l1RefNumber).toBe(record.l1_ref_number);
      expect(toHex(result.l1RefHash)).toBe(toHex(record.l1_ref_hash));
    }
  });

  test("batched together, each ballot's result is the one checking it alone gives", () => {
    const pairs = vectors.ballots.map(
      (b) => [electionOf(b.election, b.registered), decodeBallot(hex(b.encoding), 1)] as const,
    );
    const batched = finishBallotSteps(pairs.map(([e, r]) => stepBallot(e, r)));
    for (const [i, b] of vectors.ballots.entries()) {
      const [election, record] = pairs[i] as (typeof pairs)[number];
      expect(codeOf(batched[i] as BallotCheck)).toBe(b.result);
      expect(batched[i]).toEqual(checkBallot(election, record));
    }
  });

  test("a passing batch of 64 and a failing one that is split each give every ballot its own result", () => {
    const ok = vectors.ballots.filter((b) => b.result === "ok");
    const bad = vectors.ballots.find((b) => b.id === "membership-other-proof");
    if (bad === undefined) throw new Error("no membership-other-proof vector");
    const step = (b: (typeof ok)[number]) =>
      stepBallot(electionOf(b.election, b.registered), decodeBallot(hex(b.encoding), 1));
    // The first 64 all pass; the next 66 hold one failing proof, past the split threshold.
    const picks = [
      ...Array.from({ length: 64 }, (_, i) => ok[i % ok.length] as (typeof ok)[number]),
      ...Array.from({ length: 66 }, (_, i) =>
        i === 40 ? bad : (ok[i % ok.length] as (typeof ok)[number]),
      ),
    ];
    const batched = finishBallotSteps(picks.map(step));
    expect(batched.map((r) => codeOf(r))).toEqual(picks.map((b) => b.result));
  }, 120_000);

  test("any multiset of the vectors, in any order and past a batch of 64, gets each ballot's own result", () => {
    const steps = vectors.ballots.map((b) =>
      stepBallot(electionOf(b.election, b.registered), decodeBallot(hex(b.encoding), 1)),
    );
    // Each run checks up to 80 Groth16 proofs, a third of them failing, so the
    // runs are capped.
    fc.assert(
      fc.property(fc.array(fc.nat(steps.length - 1), { maxLength: 80, size: "max" }), (picks) => {
        const batched = finishBallotSteps(picks.map((i) => steps[i] as (typeof steps)[number]));
        expect(batched.map((r) => codeOf(r))).toEqual(picks.map((i) => vectors.ballots[i]?.result));
      }),
      { numRuns: Math.min(numRuns, 3) },
    );
  }, 120_000);

  test.each(vectors.decode.map((d) => [d.id, d] as const))("rejects %s", (_, d) => {
    let error: unknown;
    try {
      decodeBallot(hex(d.encoding), 1);
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
const plurality = electionOf("plurality", [1, 2]);
const honest = hex(vector("ok-tier-0").encoding);

describe("ballot record", () => {
  test("a re-proved copy is a repeat: other proof bytes, the same message", () => {
    const first = checkBallot(plurality, decodeBallot(honest, 1));
    const copy = checkBallot(plurality, decodeBallot(hex(vector("ok-reproved").encoding), 1));
    const revote = checkBallot(plurality, decodeBallot(hex(vector("ok-revote").encoding), 1));
    expect(vector("ok-reproved").encoding).not.toBe(vector("ok-tier-0").encoding);
    if (!first.ok || !copy.ok || !revote.ok) throw new Error("expected admitted ballots");
    expect(toHex(copy.message)).toBe(toHex(first.message));
    expect(revote.nullifier).toBe(first.nullifier);
    const admitted = [first, copy, revote].map((r, i) => ({
      tier: r.tier,
      nullifier: r.nullifier,
      message: r.message,
      l1RefNumber: r.l1RefNumber,
      index: BigInt(i),
    }));
    const selection = selectBallots(admitted);
    expect(selection.repeats.map((r) => r.index)).toEqual([1n]);
    const newer = first.l1RefNumber > revote.l1RefNumber ? 0n : 2n;
    expect(selection.selected.map((r) => r.index)).toEqual([newer]);
  });

  test("every byte of an admitted ballot is bound: changing one is refused", () => {
    // Each case is a decode or an admission failure; none is admitted.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: honest.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, delta) => {
          const bytes = Uint8Array.from(honest);
          bytes[at] = ((bytes[at] as number) + delta) & 0xff;
          let record: BallotRecord;
          try {
            record = decodeBallot(bytes, 1);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          // Every accepted encoding re-encodes to itself.
          expect(toHex(encodeBallot(record))).toBe(toHex(bytes));
          expect(checkBallot(plurality, record).ok).toBe(false);
        },
      ),
      { numRuns },
    );
    // About 25 ms a run: a pairing product and the validity proofs.
  }, 120_000);

  test("encode(decode(b)) = b for every accepted record in the vectors", () => {
    for (const b of vectors.ballots)
      expect(toHex(encodeBallot(decodeBallot(hex(b.encoding), 1)))).toBe(b.encoding);
  });

  test("a ballot passes only under its own election's key set rules", () => {
    const record = decodeBallot(hex(vector("ok-every-seat").encoding), 1);
    expect(checkBallot(electionOf("plurality", [1, 2, 3]), record).ok).toBe(true);
    expect(codeOf(checkBallot(electionOf("plurality", [1, 2]), record))).toBe(
      "share-hash-unqualified",
    );
    expect(codeOf(checkBallot(electionOf("plurality", [2, 3]), record))).toBe(
      "share-hash-unqualified",
    );
  });

  test("ballotSignals is undefined for another election or an unlisted tier", () => {
    const approval = decodeBallot(hex(vector("ok-approval").encoding), 1);
    expect(ballotSignals(plurality, approval)).toBeUndefined();
    const record = decodeBallot(honest, 1);
    expect(ballotSignals(plurality, { ...record, tier: 1 })).toBeUndefined();
  });
});

describe("ballot context", () => {
  const d = definitions.get("plurality") as ElectionDefinition;

  test("refuses a key set no transcript check returned", () => {
    const unchecked = [{ index: 1, kemKey: kem, signingKey: new Uint8Array(33) }];
    expect(() => ballotElection(d, unchecked)).toThrow(RangeError);
  });

  test("refuses a key set checked for another transcript", () => {
    expect(() => ballotElection(d, keySet([1, 2], new Uint8Array(32)))).toThrow(RangeError);
  });

  test("refuses a definition that pins another ballot version", () => {
    const pins = d.profile.pins.map((p) => (p.record_type === 2 ? { ...p, version: 2 } : p));
    const other = decodeElectionDefinition(
      encodeElectionDefinition({ ...d, profile: { ...d.profile, pins } }),
    );
    expect(() => ballotElection(other, keySet([1, 2], other.ceremony_transcript_hash))).toThrow(
      UnsupportedVersionError,
    );
  });

  test("refuses a definition naming another membership key", () => {
    const other = decodeElectionDefinition(
      encodeElectionDefinition({ ...d, membership_vk_hash: new Uint8Array(32) }),
    );
    expect(() => ballotElection(other, keySet([1, 2], other.ceremony_transcript_hash))).toThrow(
      RangeError,
    );
  });

  test("overwriting the exposed definition hash changes nothing checked", () => {
    const election = electionOf("plurality", [1, 2]);
    const record = decodeBallot(honest, 1);
    const before = checkBallot(election, record);
    election.definitionHash.fill(0);
    expect(checkBallot(election, record)).toEqual(before);
    expect(before.ok).toBe(true);
    expect(checkBallot(election, { ...record, definition_hash: new Uint8Array(32) })).toEqual({
      ok: false,
      code: "ballot-stray",
    });
  });

  test("checkBallot and ballotSignals refuse a context ballotElection didn't make", () => {
    const record = decodeBallot(honest, 1);
    const copy = { ...plurality };
    expect(() => checkBallot(copy, record)).toThrow(TypeError);
    expect(() => ballotSignals(copy, record)).toThrow(TypeError);
  });

  test("finishing refuses a step stepBallot didn't make, so no caller supplies a proof's verdict", () => {
    const step = stepBallot(plurality, decodeBallot(honest, 1));
    for (const forged of [{}, { ...step }, { result: { ok: true } }])
      expect(() => finishBallotStep(forged)).toThrow(TypeError);
    expect(() => finishBallotSteps([step, {}])).toThrow(TypeError);
    expect(() => finishBallotSteps(step as never)).toThrow(TypeError);
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the input under test
    expect(() => finishBallotSteps([, step] as never)).toThrow(TypeError);
    expect(codeOf(finishBallotStep(step))).toBe("ok");
    expect(() => stepBallot({ ...plurality }, decodeBallot(honest, 1))).toThrow(TypeError);
  });

  test("the decoded-proof verifier refuses points the decoder didn't make", () => {
    const record = decodeBallot(honest, 1);
    const signals = ballotSignals(plurality, record) as NonNullable<
      ReturnType<typeof ballotSignals>
    >;
    expect(verifyDecodedMembershipProof(record.membership_proof, signals)).toBe(true);
    const fresh = decodeMembershipProof(honest.subarray(108, 364));
    expect(verifyDecodedMembershipProof(fresh, signals)).toBe(true);
    expect(() => verifyDecodedMembershipProof({ ...fresh }, signals)).toThrow(TypeError);
  });
});
