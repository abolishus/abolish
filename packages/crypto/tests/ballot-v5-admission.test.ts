import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { rollingBallotElectionWith, rollingStepRootOf } from "../src/ballot.ts";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import {
  type BallotCheckV5,
  type BallotMembershipV5,
  ballotHashV4,
  ballotHashV5,
  ballotSignalsV5,
  checkBallotV4,
  checkBallotV5,
  checkL1ReferenceV5,
  checkValidityV4,
  checkValidityV5,
  coreHashV5,
  DecodeError,
  decodeBallot,
  decodeElectionDefinitionV7,
  type ElectionDefinitionV7,
  encodeBallotV5,
  encodeElectionDefinitionV7,
  finishBallotStep,
  finishBallotSteps,
  kemKeygen,
  panelBallotElection,
  POLL_CLASSES,
  RECORD_TYPES,
  type RegisteredKeys,
  type RollingBallotElection,
  rollingBallotElection,
  rollingTierSteps,
  rootClockBoundary,
  semaphoreField,
  statementHashV4,
  statementHashV5,
  stepBallotV5,
  stepMembershipV5,
  UnsupportedVersionError,
  verifyMembershipProof,
} from "../src/index.ts";
import { type RollingEvent, tierEvent } from "./rolling-tree.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ballot-v5-records.json comes from an independent Python
// implementation of ballot record version 5 and its admission checks
// (scripts/ballot-v5-records-vectors.py), with step roots rebuilt there from
// the listed groups' events and membership proofs made by snarkjs, so the
// expected encodings, hashes and verdicts never come from the code under
// test. ballot-v5-records.test.ts reads the same file with a codec written
// from the spec; this suite runs it through packages/crypto's production
// codec, hashes, context and admission (P2-17 part 3c), and the supplied
// roots of docs/spec/vectors/contract-event-v10.json through
// `root-step-mismatch`.

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
  readonly step?: number;
};

interface Vectors {
  readonly events: readonly RollingEvent[];
  readonly elections: Readonly<
    Record<
      string,
      {
        readonly definition: string;
        readonly definitionHash: string;
        readonly registeredAt: string;
        readonly cells: readonly {
          readonly cell: number;
          readonly tier: number;
          readonly scope: string;
          readonly steps: readonly {
            readonly step: number;
            readonly root: string;
            readonly accepted: boolean;
          }[];
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
    readonly ballotHash: string;
    readonly coreHash: string;
    readonly signals?: Readonly<Record<"root" | "nullifier" | "message" | "scope", string>>;
    readonly snarkjs?: boolean;
    readonly admission: Admission;
  }[];
  readonly references: readonly {
    readonly id: string;
    readonly ballot: string;
    readonly step: number;
    readonly l1Timestamp: string;
    readonly expect: string;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset?: number;
  }[];
}

interface RootVectors {
  readonly rollingRoots: readonly {
    readonly record: string;
    readonly ballot: string;
    readonly suppliedRoot: string;
    readonly rootCheck: "match" | "root-step-mismatch" | "not-reached";
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("ballot-v5-records.json", SPEC_VECTORS), "utf8"),
) as Vectors;
const roots = JSON.parse(
  readFileSync(new URL("contract-event-v10.json", SPEC_VECTORS), "utf8"),
) as RootVectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const kem = kemKeygen().publicKey;
const keySet = (seats: readonly number[], transcript: Uint8Array): readonly RegisteredKeys[] =>
  checkedKeySetForTests(
    seats.map((index) => ({ index, kemKey: kem, signingKey: new Uint8Array(33) })),
    transcript,
  );

const definitions = new Map<string, ElectionDefinitionV7>(
  Object.entries(vectors.elections).map(([name, e]) => [
    name,
    decodeElectionDefinitionV7(hex(e.definition)),
  ]),
);
const definitionOf = (name: string) => definitions.get(name) as ElectionDefinitionV7;
const events = vectors.events.map(tierEvent);
const chainOf = (name: string) => ({
  events,
  registeredAt: BigInt(vectors.elections[name]!.registeredAt),
});

// These vectors carry no author run, so a context with an author panel comes
// from the internal seam that takes its seats as given, as version 4's.
function electionOf(
  name: string,
  seats: readonly number[],
  authorSeats: readonly number[],
): RollingBallotElection {
  const d = definitionOf(name);
  const registered = keySet(seats, d.ceremony_transcript_hash);
  return d.author_keys.length === 0 && authorSeats.length === 0
    ? rollingBallotElection(d, registered, chainOf(name))
    : rollingBallotElectionWith(d, registered, chainOf(name), authorSeats);
}

const vector = (id: string) => vectors.ballots.find((b) => b.id === id)!;
const contextOf = (b: Vectors["ballots"][number]) =>
  electionOf(b.election, b.registered, b.authorRegistered);

// A result as the vectors write it.
function admissionOf(r: BallotCheckV5): Admission {
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
    step: r.step,
  };
}

// The membership proof's and the step's offsets (Ballot record (version 5),
// Version 4's offsets up to the proof).
const PROOF_AT = 3 + 32 + 1 + 32 + 8 + 32;
const STEP_AT = PROOF_AT + 256;

const ORDER = [
  "ballot-stray",
  "ballot-cell",
  "validity-shape",
  "share-hash-unqualified",
  "root-step-range",
  "root-step-mismatch",
  "membership-proof",
  "option-proof",
  "sum-proof",
  "ok",
];

describe("ballot-v5-records.json through packages/crypto", () => {
  test.each(Object.entries(vectors.elections))(
    "election %s: a rolling version-7 definition, its cells, scopes and step roots",
    (name, e) => {
      const d = definitionOf(name);
      expect(toHex(encodeElectionDefinitionV7(d))).toBe(e.definition);
      const election = electionOf(name, [1, 2], d.author_keys.length === 0 ? [] : [1, 2]);
      expect(toHex(election.definitionHash)).toBe(e.definitionHash);
      expect(
        election.cells.map((c) => ({ cell: c.cell, tier: c.tier, scope: String(c.scope) })),
      ).toEqual(e.cells.map((c) => ({ cell: c.cell, tier: c.tier, scope: c.scope })));
      // Every step the file lists, from the distinct trees the context computed in one pass.
      for (const c of e.cells)
        for (const st of c.steps)
          expect(rollingStepRootOf(election, c.cell, st.step)).toBe(
            st.accepted ? BigInt(st.root) : undefined,
          );
    },
  );

  test.each(vectors.ballots.map((b) => [b.id, b] as const))("%s", (_, b) => {
    const bytes = hex(b.encoding);
    const record = decodeBallot(bytes, 5);
    expect(toHex(encodeBallotV5(record))).toBe(b.encoding);
    const vote = record.committed_vote;
    expect(
      toHex(
        coreHashV5({
          definitionHash: record.definition_hash,
          cell: record.cell,
          vss: vote.vss,
          shareHashes: vote.share_hashes,
          authorVss: vote.author_vss,
          authorShareHashes: vote.author_share_hashes,
        }),
      ),
    ).toBe(b.coreHash);
    const election = contextOf(b);
    const ctx = {
      questions: election.questions,
      threshold: election.threshold,
      panelSize: election.panelSize,
      authorThreshold: election.authorThreshold,
      authorPanelSize: election.authorPanelSize,
      definitionHash: record.definition_hash,
      cell: record.cell,
      nullifier: record.nullifier,
    };
    if (record.cell < 256) {
      expect(toHex(statementHashV5(ctx, record.committed_vote))).toBe(b.statementHash);
      expect(toHex(ballotHashV5({ ...ctx, step: record.step }, record.committed_vote))).toBe(
        b.ballotHash,
      );
    }
    const signals = ballotSignalsV5(election, record);
    if (b.signals === undefined) expect(signals).toBeUndefined();
    else {
      const s = signals as NonNullable<typeof signals>;
      expect({
        root: String(s.root),
        nullifier: String(s.nullifier),
        message: String(s.message),
        scope: String(s.scope),
      }).toEqual(b.signals);
      // The pairing's verdict on these signals is snarkjs's.
      expect(verifyMembershipProof(bytes.subarray(PROOF_AT, STEP_AT), s)).toBe(b.snarkjs);
    }
    const result = checkBallotV5(election, record);
    expect(admissionOf(result)).toEqual(b.admission);
    if (result.ok) {
      expect(result.nullifier).toBe(record.nullifier);
      expect(result.l1RefNumber).toBe(record.l1_ref_number);
      expect(toHex(result.l1RefHash)).toBe(toHex(record.l1_ref_hash));
    }
  });

  // Every vector's proof is checked twice, batched and alone, which can pass
  // the default timeout on a shared runner.
  test("batched together, each ballot's result is the one checking it alone gives", () => {
    const pairs = vectors.ballots.map(
      (b) => [contextOf(b), decodeBallot(hex(b.encoding), 5)] as const,
    );
    const batched = finishBallotSteps(pairs.map(([e, r]) => stepBallotV5(e, r)));
    for (const [i, b] of vectors.ballots.entries()) {
      const [election, record] = pairs[i] as (typeof pairs)[number];
      expect(admissionOf(batched[i] as BallotCheckV5)).toEqual(b.admission);
      expect(batched[i]).toEqual(checkBallotV5(election, record));
    }
  }, 60_000);

  // A per-step rebuild (packages/crypto's rollingTierSteps asked for that step
  // alone) against the context's distinct trees, at every step around the
  // poll and its events' boundaries.
  test("every step's root is the one a scan of that step alone gives", () => {
    for (const [name, e] of Object.entries(vectors.elections)) {
      const d = definitionOf(name);
      const election = electionOf(name, [1, 2], d.author_keys.length === 0 ? [] : [1, 2]);
      const listed = e.cells.flatMap((c) => c.steps.map((st) => st.step));
      const lo = Math.min(...listed) - 3;
      const hi = Math.max(...listed) + 3;
      for (const [cell, tier] of d.rolling_electorate.entries())
        for (let step = lo; step <= hi; step++) {
          const alone = rollingTierSteps(
            events,
            {
              groups: tier.groups,
              rootL2Block: tier.root_l2_block,
              registeredAt: BigInt(e.registeredAt),
              closesAt: d.closes_at,
            },
            [BigInt(step)],
          ).steps[0]!;
          expect(rollingStepRootOf(election, cell, step)).toBe(
            alone.accepted ? alone.root : undefined,
          );
        }
    }
  });

  // contract-event-v10.json: a root the board's rolling call carried beside
  // the ballot. It only ever rejects, at its place in the order.
  test.each(roots.rollingRoots.map((r) => [r.record, r] as const))("supplied root %s", (_, r) => {
    const b = vector(r.ballot);
    const record = decodeBallot(hex(b.encoding), 5);
    const election = contextOf(b);
    const alone = checkBallotV5(election, record);
    const supplied = checkBallotV5(election, record, BigInt(r.suppliedRoot));
    const before = ORDER.indexOf(b.admission.code) < ORDER.indexOf("root-step-mismatch");
    if (r.rootCheck === "root-step-mismatch" && !before)
      expect(admissionOf(supplied)).toEqual({ code: "root-step-mismatch" });
    else expect(supplied).toEqual(alone);
    if (r.rootCheck === "not-reached") expect(before).toBe(true);
  });

  // Live results' running sets count a ballot whose membership check passes
  // whatever its other checks find, and read one whose step isn't final as
  // pending (docs/spec/tally.md, Running set, condition 1; T-45): the
  // verdict is snarkjs's on the vector's own signals, and a step the poll
  // doesn't accept fails it with no proof to check.
  test("membership alone: admission's 5.1 to 5.3 over the ballot's own M and step, whatever else rejects it", () => {
    const steps = vectors.ballots.map((b) =>
      stepMembershipV5(contextOf(b), decodeBallot(hex(b.encoding), 5)),
    );
    const held = steps.flatMap((s) => (s === undefined ? [] : [s]));
    const batched = finishBallotSteps(held);
    let next = 0;
    const rejectedMembers = new Set<string>();
    for (const [i, b] of vectors.ballots.entries()) {
      const step = steps[i];
      const record = decodeBallot(hex(b.encoding), 5);
      if (b.admission.code === "ballot-stray" || b.admission.code === "ballot-cell") {
        expect(step).toBeUndefined();
        continue;
      }
      if (step === undefined) throw new Error(`${b.id}: no membership step`);
      const m = batched[next++] as BallotMembershipV5;
      expect(m).toEqual(finishBallotStep(step));
      // Without signals there is no root: the poll doesn't accept the step.
      expect(m.member).toBe(b.signals === undefined ? false : b.snarkjs);
      if (b.signals !== undefined)
        expect(String(semaphoreField(m.message))).toBe(b.signals.message);
      expect(m).toMatchObject({
        nullifier: record.nullifier,
        cell: record.cell,
        step: record.step,
        l1RefNumber: record.l1_ref_number,
        tier: vectors.elections[b.election]?.cells.find((c) => c.cell === record.cell)?.tier,
      });
      if (b.admission.code === "ok") expect(toHex(m.message)).toBe(b.admission.message);
      if (["membership-proof", "root-step-range"].includes(b.admission.code))
        expect(m.member).toBe(false);
      else if (m.member) rejectedMembers.add(b.admission.code);
    }
    // A ballot rejected after its membership proof, or before it for its
    // share hashes, is still a member's.
    for (const code of ["share-hash-unqualified", "option-proof", "sum-proof"])
      expect(rejectedMembers.has(code)).toBe(true);
  }, 60_000);

  test.each(roots.rollingRoots.map((r) => [r.record, r] as const))(
    "membership alone, supplied root %s: a root other than the step's fails it",
    (_, r) => {
      const b = vector(r.ballot);
      const record = decodeBallot(hex(b.encoding), 5);
      const election = contextOf(b);
      const step = stepMembershipV5(election, record, BigInt(r.suppliedRoot));
      const alone = stepMembershipV5(election, record);
      if (step === undefined || alone === undefined) {
        expect(step).toBe(alone);
        return;
      }
      const m = finishBallotStep(step);
      const unsupplied = finishBallotStep(alone);
      if (r.rootCheck === "root-step-mismatch") expect(m).toEqual({ ...unsupplied, member: false });
      else expect(m).toEqual(unsupplied);
    },
  );

  test("the supplied roots include a mismatch the verifier reaches", () => {
    expect(
      roots.rollingRoots.some(
        (r) =>
          r.rootCheck === "root-step-mismatch" &&
          ORDER.indexOf(vector(r.ballot).admission.code) > ORDER.indexOf("root-step-mismatch"),
      ),
    ).toBe(true);
  });

  // revoting.md, Admission, step 5, after steps 1 to 4 have admitted the reference.
  test.each(vectors.references.map((r) => [r.id, r] as const))("reference %s", (_, r) => {
    const b = vector(r.ballot);
    const record = decodeBallot(hex(b.encoding), 5);
    expect(record.step).toBe(r.step);
    const l1 = {
      head: record.l1_ref_number,
      block: () => ({ hash: record.l1_ref_hash, timestamp: BigInt(r.l1Timestamp) }),
    };
    const verdict = checkL1ReferenceV5(
      { l1RefNumber: record.l1_ref_number, l1RefHash: record.l1_ref_hash, step: record.step },
      l1,
      { l1RefMin: 0n, closesAt: (1n << 64n) - 1n },
    );
    expect(verdict === "admitted" ? "ok" : verdict).toBe(r.expect);
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("decode %s", (_, d) => {
    let error: DecodeError | undefined;
    try {
      decodeBallot(hex(d.encoding), 5);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      error = e;
    }
    expect(error?.code).toBe(d.error);
    if (d.offset !== undefined) expect(error?.offset).toBe(d.offset);
  });
});

describe("ballot record version 5 (docs/spec/ballot-validity.md, Ballot record (version 5))", () => {
  const honest = vector("ok-newest-step");
  const honestBytes = hex(honest.encoding);
  const honestRecord = decodeBallot(honestBytes, 5);

  test("round-trips, and re-encodes every record it accepts to the same bytes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), (step) => {
        const record = { ...honestRecord, step };
        const bytes = encodeBallotV5(record);
        // Version 4's offsets through the proof; the step at 364, big-endian.
        expect(toHex(bytes.subarray(0, STEP_AT))).toBe(toHex(honestBytes.subarray(0, STEP_AT)));
        expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(STEP_AT)).toBe(step);
        expect(decodeBallot(bytes, 5)).toEqual(record);
      }),
      { numRuns },
    );
    for (const b of vectors.ballots)
      expect(toHex(encodeBallotV5(decodeBallot(hex(b.encoding), 5)))).toBe(b.encoding);
  });

  test("is refused under every other ballot version's pin, and refuses theirs", () => {
    for (const pinned of [1, 2, 3, 4] as const)
      expect(() => decodeBallot(honestBytes, pinned as 4)).toThrow(DecodeError);
    const asV4 = Uint8Array.from(honestBytes);
    asV4[2] = 4;
    expect(() => decodeBallot(asV4, 5)).toThrow(DecodeError);
  });

  test("a record cut inside or before the step is truncated", () => {
    for (const cut of [STEP_AT - 1, STEP_AT, STEP_AT + 1, STEP_AT + 3]) {
      let error: DecodeError | undefined;
      try {
        decodeBallot(honestBytes.subarray(0, cut), 5);
      } catch (e) {
        if (!(e instanceof DecodeError)) throw e;
        error = e;
      }
      expect(error?.code).toBe("truncated");
    }
  });

  test("the ballot hash binds the step, the version and every vote byte; the statement neither the step", () => {
    const e = contextOf(honest);
    const ctx = {
      questions: e.questions,
      threshold: e.threshold,
      panelSize: e.panelSize,
      authorThreshold: e.authorThreshold,
      authorPanelSize: e.authorPanelSize,
      definitionHash: honestRecord.definition_hash,
      cell: honestRecord.cell,
      nullifier: honestRecord.nullifier,
    };
    const vote = honestRecord.committed_vote;
    const at = (step: number) => toHex(ballotHashV5({ ...ctx, step }, vote));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.integer({ min: 0, max: 0xffff_ffff }),
        (a, b) => {
          fc.pre(a !== b);
          expect(at(a)).not.toBe(at(b));
        },
      ),
      { numRuns },
    );
    expect(at(honestRecord.step)).not.toBe(toHex(ballotHashV4(ctx, vote)));
    expect(toHex(statementHashV5(ctx, vote))).not.toBe(toHex(statementHashV4(ctx, vote)));
    for (const step of [-1, 0x1_0000_0000, 1.5, Number.NaN])
      expect(() => ballotHashV5({ ...ctx, step }, vote)).toThrow(RangeError);
    // The proofs made under version input 5 verify only under it (T-31).
    expect(checkValidityV5(ctx, vote)).toEqual({ ok: true });
    expect(checkValidityV4(ctx, vote).ok).toBe(false);
  });

  test("a step relabelled on an honest ballot fails, whatever root its new step has", () => {
    const election = contextOf(honest);
    const steps = vectors.elections[honest.election]!.cells[honestRecord.cell]!.steps;
    fc.assert(
      fc.property(fc.constantFrom(...steps.map((s) => s.step)), (step) => {
        fc.pre(step !== honestRecord.step);
        const got = checkBallotV5(election, { ...honestRecord, step });
        expect(got.ok).toBe(false);
        expect(["root-step-range", "membership-proof"]).toContain(
          (got as { readonly code: string }).code,
        );
      }),
      { numRuns: Math.min(numRuns, 20) },
    );
  });

  test("a step outside the poll is refused from the clock alone, whatever its tree", () => {
    const election = contextOf(honest);
    const e = vectors.elections[honest.election]!;
    // τ ≤ registeredAt or τ > closesAt: no root exists, so no signals either.
    for (const step of [0, 1, 0xffff_ffff]) {
      const record = { ...honestRecord, step };
      expect(
        rootClockBoundary(BigInt(step)) <= BigInt(e.registeredAt) || step === 0xffff_ffff,
      ).toBe(true);
      expect(admissionOf(checkBallotV5(election, record))).toEqual({ code: "root-step-range" });
      expect(ballotSignalsV5(election, record)).toBeUndefined();
    }
  });

  test("the supplied root is checked only against the computed one, and never stands in for it", () => {
    const election = contextOf(honest);
    const root = BigInt(honest.signals!.root);
    expect(checkBallotV5(election, honestRecord, root)).toEqual(
      checkBallotV5(election, honestRecord),
    );
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 254n) - 1n }), (r) => {
        fc.pre(r !== root);
        expect(admissionOf(checkBallotV5(election, honestRecord, r))).toEqual({
          code: "root-step-mismatch",
        });
      }),
      { numRuns: Math.min(numRuns, 50) },
    );
    expect(() => checkBallotV5(election, honestRecord, Number(root) as unknown as bigint)).toThrow(
      TypeError,
    );
  });

  test("the window: τ_n in (t − ROOT_WINDOW, t], after steps 1 to 4 admit the reference", () => {
    const ref = { l1RefNumber: 7n, l1RefHash: new Uint8Array(32).fill(1) };
    const closesAt = (1n << 64n) - 1n;
    const at = (step: number, t: bigint, hash = ref.l1RefHash) =>
      checkL1ReferenceV5(
        { ...ref, step },
        { head: 7n, block: () => ({ hash, timestamp: t }) },
        { l1RefMin: 0n, closesAt },
      );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffff_fff0 }), (step) => {
        const tau = rootClockBoundary(BigInt(step));
        expect(at(step, tau)).toBe("admitted");
        if (tau > 0n) expect(at(step, tau - 1n)).toBe("root-step-future");
        expect(at(step, tau + 7199n)).toBe("admitted");
        expect(at(step, tau + 7200n)).toBe("root-step-stale");
      }),
      { numRuns },
    );
    // Steps 1 to 4 decide first: the window is never read for a reference they reject.
    expect(at(0, 0n, new Uint8Array(32))).toBe("l1-ref-unknown");
    expect(() => at(-1, 0n)).toThrow(RangeError);
  });

  test("rollingBallotElection refuses what isn't a rolling poll's definition and chain", () => {
    const d = definitionOf("default-only");
    const registered = keySet([1, 2], d.ceremony_transcript_hash);
    const chain = chainOf("default-only");
    expect(rollingBallotElection(d, registered, chain).cells).toHaveLength(
      d.rolling_electorate.length,
    );
    // The events must give each tier's opening state (verifier 2.4).
    const tier = d.rolling_electorate[0]!;
    const early = {
      blockNumber: 0n,
      timestamp: 0n,
      groupId: tier.groups[0]!,
      kind: "add" as const,
    };
    expect(() =>
      rollingBallotElection(d, registered, {
        ...chain,
        events: [{ ...early, commitments: [12345n] }, ...events],
      }),
    ).toThrow(/opening state/);
    const moved = { ...d, rolling_electorate: [{ ...tier, group_size: tier.group_size + 1n }] };
    expect(() =>
      rollingBallotElection(moved, keySet([1, 2], moved.ceremony_transcript_hash), chain),
    ).toThrow(RangeError);
    // Another ceremony's key set.
    expect(() => rollingBallotElection(d, keySet([1, 2], new Uint8Array(32)), chain)).toThrow(
      RangeError,
    );
    // A ballot pin other than 5.
    const pins = d.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.ballot ? { ...p, version: 4 } : p,
    );
    const pinned4 = { ...d, profile: { ...d.profile, pins } };
    expect(() =>
      rollingBallotElection(pinned4, keySet([1, 2], pinned4.ceremony_transcript_hash), chain),
    ).toThrow(UnsupportedVersionError);
    // A civic rolling definition fails `rolling-class`.
    const civic = { ...d, poll_class: POLL_CLASSES.civicReferendum };
    expect(() =>
      rollingBallotElection(civic, keySet([1, 2], civic.ceremony_transcript_hash), chain),
    ).toThrow(/well-formed/);
    // Malformed chains.
    expect(() => rollingBallotElection(d, registered, { ...chain, registeredAt: -1n })).toThrow(
      RangeError,
    );
    expect(() =>
      rollingBallotElection(d, registered, { ...chain, events: [...events].reverse() }),
    ).toThrow(RangeError);
    // An author panel's seats need its approved key set.
    const withAuthor = definitionOf("rolling");
    expect(() =>
      rollingBallotElection(
        withAuthor,
        keySet([1, 2], withAuthor.ceremony_transcript_hash),
        chainOf("rolling"),
        [],
      ),
    ).toThrow(/author panel/);
    // Version 6's context never takes a version-7 definition.
    expect(() => panelBallotElection(d as never, registered)).toThrow(UnsupportedVersionError);
  });

  test("a context copies its events: changing them afterwards changes nothing", () => {
    const mine = events.map((e) => ({ ...e }));
    const d = definitionOf(honest.election);
    const election = rollingBallotElectionWith(
      d,
      keySet(honest.registered, d.ceremony_transcript_hash),
      { events: mine, registeredAt: BigInt(vectors.elections[honest.election]!.registeredAt) },
      honest.authorRegistered,
    );
    mine.length = 0;
    expect(admissionOf(checkBallotV5(election, honestRecord))).toEqual(honest.admission);
  });

  test("checks refuse a context rollingBallotElection didn't make, and other versions' contexts", () => {
    const election = contextOf(honest);
    const copy = { ...election };
    expect(() => checkBallotV5(copy, honestRecord)).toThrow(TypeError);
    expect(() => ballotSignalsV5(copy, honestRecord)).toThrow(TypeError);
    expect(() => checkBallotV4(election as never, honestRecord as never)).toThrow(TypeError);
  });

  test("the package entry point exports rollingBallotElection, not its seam", async () => {
    const api: Record<string, unknown> = await import("../src/index.ts");
    expect(api).not.toHaveProperty("rollingBallotElectionWith");
    expect(api).toHaveProperty("rollingBallotElection");
  });

  test("one secret, one counted ballot per tier across steps: a re-vote at another step keeps its nullifier", () => {
    const older = vector("ok-older-step");
    const first = checkBallotV5(contextOf(older), decodeBallot(hex(older.encoding), 5));
    const revote = vector("ok-revote-newer-step");
    const second = checkBallotV5(contextOf(revote), decodeBallot(hex(revote.encoding), 5));
    expect(first.ok && second.ok).toBe(true);
    const [a, b] = [first, second] as Extract<BallotCheckV5, { ok: true }>[];
    expect(a!.step).not.toBe(b!.step);
    expect([a!.tier, a!.nullifier]).toEqual([b!.tier, b!.nullifier]);
  });
});
