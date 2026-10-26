import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  DecodeError,
  ds,
  H,
  membershipMessage,
  PARAMETERS,
  semaphoreField,
  tierTreeRoot,
  tierTreeZeros,
  verifyMembershipProof,
} from "../src/index.ts";
import { shapeOkV4 } from "../src/ballot-validity.ts";
import {
  BALLOT_V5,
  type BallotV5,
  ballotHash,
  concat,
  decodeV5,
  halves,
  head,
  rollingScope,
  SCHEMA,
} from "./ballot-v5.ts";
import { memberCount, type RollingEvent, rollingLeaves, tau } from "./rolling-tree.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ballot-v5-records.json comes from an independent Python
// implementation of ballot record version 5 and its admission checks
// (scripts/ballot-v5-records-vectors.py), with step roots rebuilt there from
// the listed groups' events, membership proofs made by snarkjs over
// Semaphore's depth-32 circuit (scripts/ballot-proofs.mjs) and every pairing
// verdict snarkjs's. This reads the record with a codec written from
// docs/spec/ballot-validity.md (Ballot record (version 5)) over version 4's
// committed vote, recomputes the hashes from their formulas, the step roots
// with packages/crypto's tier tree, and checks every membership proof with
// packages/crypto's Groth16 verifier against the signals derived here: a
// reading of the spec beside the production codec, context and admission,
// which ballot-v5-admission.test.ts runs over the same file, the validity
// proofs under version input 5 included.

type Admission = {
  readonly code: string;
  readonly panel?: number;
  readonly seat?: number;
  readonly ballotHash?: string;
  readonly message?: string;
  readonly tier?: number;
  readonly cell?: number;
  readonly step?: number;
};

interface Vectors {
  readonly format: string;
  readonly recordType: string;
  readonly version: number;
  readonly rootPeriod: string;
  readonly rootOffset: string;
  readonly rootWindow: string;
  readonly events: readonly RollingEvent[];
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
        }[];
        readonly threshold: number;
        readonly panelSize: number;
        readonly authorThreshold: number;
        readonly authorPanelSize: number;
        readonly rootL2Block: string;
        readonly registeredAt: string;
        readonly closesAt: string;
        readonly cells: readonly {
          readonly cell: number;
          readonly tier: number;
          readonly groups: readonly string[];
          readonly openingRoot: string;
          readonly openingCount: number;
          readonly scope: string;
          readonly steps: readonly {
            readonly step: number;
            readonly tau: string;
            readonly root: string;
            readonly memberCount: number;
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

const vectors = JSON.parse(
  readFileSync(new URL("ballot-v5-records.json", SPEC_VECTORS), "utf8"),
) as Vectors;
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// Hashes (version 5): version 4's statement and core with version input 5.
const statementHash = (b: BallotV5) =>
  H(ds("abolish/v1/ballot-statement", concat(head(b), halves(b.committed_vote))));
const coreHash = (b: BallotV5) =>
  H(
    ds(
      "abolish/v1/ballot-core",
      concat(b.definition_hash, Uint8Array.of(0x00, 0x02, 5, b.cell), halves(b.committed_vote)),
    ),
  );

type Election = Vectors["elections"][string];
const z32 = tierTreeZeros()[32]!;

/** Membership, Root clock and steps: the step's tree from the events, and whether the poll accepts it. */
function stepOf(e: Election, cell: number, step: number) {
  const groups = e.cells[cell]!.groups;
  const boundary = tau(BigInt(step));
  const leaves = rollingLeaves(vectors.events, groups, (ev) => BigInt(ev.timestamp) <= boundary);
  const root = tierTreeRoot(leaves);
  const accepted =
    boundary > BigInt(e.registeredAt) &&
    boundary <= BigInt(e.closesAt) &&
    leaves.length <= 2 ** 32 &&
    root !== z32;
  return { root, memberCount: memberCount(leaves), accepted };
}

/**
 * `[ρ_n, ν, m̂, ŝ_t]` as a verifier derives them from the record and the
 * definition, or undefined where admission has no root to check against: a
 * stray ballot, a cell outside the partition or a step the poll doesn't accept.
 */
function signalsOf(e: Election, b: BallotV5) {
  const cell = e.cells[b.cell];
  if (toHex(b.definition_hash) !== e.definitionHash || cell === undefined) return undefined;
  const step = stepOf(e, b.cell, b.step);
  if (!step.accepted) return undefined;
  const message = membershipMessage({
    definitionHash: b.definition_hash,
    tier: cell.tier,
    ballotHash: ballotHash(b),
    l1RefNumber: b.l1_ref_number,
    l1RefHash: b.l1_ref_hash,
  });
  return {
    root: step.root,
    nullifier: b.nullifier,
    message: semaphoreField(message),
    scope: rollingScope(b.definition_hash, cell.tier),
  };
}

/**
 * Admission (version 5) in order up to the membership proof, given its
 * pairing verdict; `undefined` once it passes, since the validity proofs
 * after it are part 3's to check.
 */
function admitUpToMembership(
  e: Election,
  v: Vectors["ballots"][number],
  b: BallotV5,
  member: boolean | undefined,
): { code: string; panel?: number; seat?: number } | undefined {
  if (toHex(b.definition_hash) !== e.definitionHash) return { code: "ballot-stray" };
  if (e.cells[b.cell] === undefined) return { code: "ballot-cell" };
  const ctx = {
    questions: e.questions,
    threshold: e.threshold,
    panelSize: e.panelSize,
    authorThreshold: e.authorThreshold,
    authorPanelSize: e.authorPanelSize,
    definitionHash: b.definition_hash,
    cell: b.cell,
    nullifier: b.nullifier,
  };
  if (!shapeOkV4(ctx, b.committed_vote)) return { code: "validity-shape" };
  for (const [panel, registered, hashes] of [
    [1, v.registered, b.committed_vote.share_hashes],
    [2, v.authorRegistered, b.committed_vote.author_share_hashes],
  ] as const)
    for (const [i, h] of hashes.entries())
      if (!registered.includes(i + 1) && h.some((x) => x !== 0))
        return { code: "share-hash-unqualified", panel, seat: i + 1 };
  if (!stepOf(e, b.cell, b.step).accepted) return { code: "root-step-range" };
  return member === true ? undefined : { code: "membership-proof" };
}

describe("ballot record version 5 (docs/spec/ballot-validity.md, Ballot record (version 5))", () => {
  test("is version 5 of 0x0002 under the root clock's parameters", () => {
    expect(vectors.format).toBe("abolish-ballot-vectors/1");
    expect([vectors.recordType, vectors.version]).toEqual(["0x0002", 5]);
    expect(vectors.rootPeriod).toBe(String(PARAMETERS.ROOT_PERIOD));
    expect(vectors.rootOffset).toBe(String(PARAMETERS.ROOT_OFFSET));
    expect(vectors.rootWindow).toBe(String(PARAMETERS.ROOT_WINDOW));
    expect(new Set(vectors.ballots.map((b) => b.id)).size).toBe(vectors.ballots.length);
  });

  test.each(Object.entries(vectors.elections))(
    "%s: the opening state, every step and the rolling scope",
    (_name, e) => {
      expect(toHex(H(ds("abolish/v1/election-definition", hex(e.definition))))).toBe(
        e.definitionHash,
      );
      for (const [i, c] of e.cells.entries()) {
        expect(c.cell).toBe(i);
        const opening = rollingLeaves(
          vectors.events,
          c.groups,
          (ev) => BigInt(ev.block) <= BigInt(e.rootL2Block),
        );
        expect(String(tierTreeRoot(opening))).toBe(c.openingRoot);
        expect(memberCount(opening)).toBe(c.openingCount);
        expect(String(rollingScope(hex(e.definitionHash), c.tier))).toBe(c.scope);
        for (const s of c.steps) {
          expect(String(tau(BigInt(s.step)))).toBe(s.tau);
          const got = stepOf(e, i, s.step);
          expect([String(got.root), got.memberCount, got.accepted]).toEqual([
            s.root,
            s.memberCount,
            s.accepted,
          ]);
        }
      }
    },
  );

  test.each(vectors.ballots.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const e = vectors.elections[v.election]!;
    const b = decodeV5(hex(v.encoding));
    expect(toHex(SCHEMA.encode(BALLOT_V5, 5, b))).toBe(v.encoding);
    expect(toHex(statementHash(b))).toBe(v.statementHash);
    expect(toHex(ballotHash(b))).toBe(v.ballotHash);
    expect(toHex(coreHash(b))).toBe(v.coreHash);

    const signals = signalsOf(e, b);
    let member: boolean | undefined;
    if (signals === undefined) expect(v.signals).toBeUndefined();
    else {
      expect(v.signals).toEqual({
        root: String(signals.root),
        nullifier: String(signals.nullifier),
        message: String(signals.message),
        scope: String(signals.scope),
      });
      // packages/crypto's pairing agrees with snarkjs's.
      member = verifyMembershipProof(hex(v.encoding).subarray(108, 364), signals);
      expect(member).toBe(v.snarkjs);
    }

    const rejected = admitUpToMembership(e, v, b, member);
    if (rejected !== undefined) {
      expect(rejected).toEqual({
        code: v.admission.code,
        ...(v.admission.panel === undefined ? {} : { panel: v.admission.panel }),
        ...(v.admission.seat === undefined ? {} : { seat: v.admission.seat }),
      });
      return;
    }
    expect(["ok", "option-proof", "sum-proof"]).toContain(v.admission.code);
    if (v.admission.code === "ok") {
      expect(v.admission.ballotHash).toBe(v.ballotHash);
      expect(v.admission.message).toBe(
        toHex(
          membershipMessage({
            definitionHash: b.definition_hash,
            tier: e.cells[b.cell]!.tier,
            ballotHash: ballotHash(b),
            l1RefNumber: b.l1_ref_number,
            l1RefHash: b.l1_ref_hash,
          }),
        ),
      );
      expect([v.admission.tier, v.admission.cell, v.admission.step]).toEqual([
        e.cells[b.cell]!.tier,
        b.cell,
        b.step,
      ]);
    }
  });

  test("covers every admission code version 5 adds and the order around them", () => {
    const codes = new Set(vectors.ballots.map((v) => v.admission.code));
    for (const c of [
      "ok",
      "ballot-stray",
      "ballot-cell",
      "validity-shape",
      "share-hash-unqualified",
      "root-step-range",
      "membership-proof",
      "option-proof",
      "sum-proof",
    ])
      expect(codes).toContain(c);
  });

  // revoting.md, Admission, under ballot version 5: t − ROOT_WINDOW < τ_n ≤ t.
  test.each(vectors.references.map((r) => [r.id, r] as const))("reference %s", (_id, r) => {
    const ballot = vectors.ballots.find((v) => v.id === r.ballot)!;
    expect(ballot.admission.code).toBe("ok");
    expect(decodeV5(hex(ballot.encoding)).step).toBe(r.step);
    const boundary = tau(BigInt(r.step));
    const t = BigInt(r.l1Timestamp);
    const verdict =
      boundary <= t - BigInt(PARAMETERS.ROOT_WINDOW)
        ? "root-step-stale"
        : boundary > t
          ? "root-step-future"
          : "ok";
    expect(verdict).toBe(r.expect);
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("decode %s", (_id, d) => {
    let error: DecodeError | undefined;
    try {
      decodeV5(hex(d.encoding));
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      error = e;
    }
    expect(error?.code).toBe(d.error);
    if (d.offset !== undefined) expect(error?.offset).toBe(d.offset);
  });
});
