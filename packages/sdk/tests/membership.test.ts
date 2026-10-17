import { readFileSync } from "node:fs";
import { proveMembership } from "@abolishus/membership-prover";
import { parseBundle, type Report, verifyBundle } from "@abolishus/verifier";
import { describe, expect, it } from "vite-plus/test";
import { type MembershipProver, runSimulation, type Scenario } from "../src/index.ts";
import type { VerifierBundle } from "../src/simulation/bundle.ts";
import { judgeVerifierReport } from "../src/simulation/verify.ts";

// Ballots proved by the ballot client's own prover (@abolishus/membership-prover,
// snarkjs over the vendored, sha256-checked key and calculator), run here in
// Node: a few seconds per ballot, so the scenarios are small (P2-21; T-07,
// T-10, T-12).
const timeout = 600_000;

const ARTIFACTS = new URL("../../membership-prover/artifacts/snark-artifacts/", import.meta.url);
const artifacts = {
  zkey: readFileSync(new URL("semaphore-32.zkey", ARTIFACTS)),
  wasm: readFileSync(new URL("semaphore-32.wasm", ARTIFACTS)),
};
const prover: MembershipProver = (witness) => proveMembership(witness, artifacts);

// Every path a ballot takes: a challenge published after close, a re-vote,
// a reorganised block and its recast, and an outage with direct ballots
// and postings of the offline seat.
const base: Scenario = {
  voters: 4,
  election: "approval",
  options: 2,
  trustees: { panel: 3, threshold: 2, offline: [3], faulty: [], departures: [] },
  tiers: { "0": 1, "1": 0, "2": 1 },
  outage: { from: 0.5, to: 1 },
  challenges: 0.5,
  revotes: 0.5,
  publications: 1,
  postings: 1,
  reorgs: 0.5,
  seed: 5,
};

const verify = (b: VerifierBundle) => verifyBundle(parseBundle(b.json, b.board));

describe("runSimulation with the ballot client's prover", { timeout }, () => {
  it("proves every ballot, and the verifier admits each with its membership and validity proofs", async () => {
    let bundle: VerifierBundle | undefined;
    const r = await runSimulation(base, { prover, onBundle: (b) => (bundle = b) });
    expect(r.ok).toBe(true);
    expect(r.membershipProofs).toBe("real");
    const { challenged, published, superseded, reorged, direct, postings } = r.ballots;
    for (const n of [challenged, published, superseded, reorged, direct, postings])
      expect(n).toBeGreaterThan(0);
    expect(r.verifier.passed).toEqual(
      expect.arrayContaining(["5.1", "5.2", "5.3", "5.4", "5.5", "5.7"]),
    );
    expect(r.verifier.failed).toEqual([]);
    // A recast is a ballot of its own, with a proof over its own M.
    expect(r.verifier.admittedBallots).toBe(r.ballots.cast);
    expect(r.verifier.rejectedBallots).toBe(0);
    for (const c of r.cells) expect(c.counts).toEqual(c.expected);

    if (bundle === undefined) throw new Error("no bundle");
    const report = verify(bundle);
    const expected = {
      proven: true,
      entries: r.board.entries,
      ballots: r.ballots.cast,
      openings: r.board.spoiled,
      tallies: r.board.openings,
      registered: r.ceremony.registered.length,
      anchors: r.board.anchors.map((a) => ({ segment: a.segment, hash: a.hash })),
    };
    expect(judgeVerifierReport(report, expected)).toEqual([]);
    // Judged as proven, a placeholder's verdicts are departures.
    const judged = (changed: Partial<Report>) =>
      judgeVerifierReport({ ...report, ...changed }, expected);
    const checks = report.checks.map((c) =>
      c.id === "5.1" ? { ...c, status: "fail" as const, code: "membership-proof" as const } : c,
    );
    expect(judged({ checks })).toEqual(["5.1 didn't pass", "5.1 failed (membership-proof)"]);
    const ballots = report.ballots;
    if (ballots === undefined) throw new Error("no admission");
    expect(
      judged({
        ballots: {
          ...ballots,
          admitted: ballots.admitted - 1,
          rejected: [{ entry: 1, code: "membership-proof" }],
        },
      }),
    ).toEqual(["admission didn't admit exactly every ballot"]);
    expect(judgeVerifierReport(report, { ...expected, ballots: expected.ballots + 1 })).toEqual([
      "admission didn't admit exactly every ballot",
    ]);
    // And judged as placeholders, real proofs are departures too.
    expect(judgeVerifierReport(report, { ...expected, proven: false })).toEqual([
      "5.1 didn't fail the placeholder membership proofs",
      "5.2 didn't fail the placeholder membership proofs",
      "5.3 didn't fail the placeholder membership proofs",
      "admission didn't reject exactly every ballot's placeholder membership proof",
    ]);
  });

  it("proves every version-3 ballot of several questions, and the verifier admits each", async () => {
    const r = await runSimulation(
      {
        ...base,
        election: "questions",
        options: 6,
        questions: [
          { options: 2, min: 1, max: 1 },
          { options: 4, min: 0, max: 2 },
        ],
        reorgs: 0,
      },
      { prover },
    );
    expect(r.ok).toBe(true);
    expect(r.verifier.passed).toEqual(
      expect.arrayContaining(["5.1", "5.2", "5.3", "5.4", "5.5", "5.7"]),
    );
    expect(r.verifier.failed).toEqual([]);
    expect(r.verifier.admittedBallots).toBe(r.ballots.cast);
    for (const c of r.cells) {
      expect(c.counts).toEqual(c.expected);
      expect(c.questions?.map((q) => q.counts)).toEqual([
        c.expected.slice(0, 2),
        c.expected.slice(2),
      ]);
    }
  });

  it("boards no ballot whose proof doesn't verify against the client's own signals", async () => {
    const one: Scenario = {
      ...base,
      voters: 1,
      outage: null,
      challenges: 0,
      revotes: 0,
      reorgs: 0,
    };
    // Bytes that aren't a proof, and a real proof of another statement: the
    // same witness under another message.
    const zeros: MembershipProver = async () => new Uint8Array(256);
    const otherMessage: MembershipProver = (w) =>
      prover({ ...w, message: w.message === "1" ? "2" : "1" });
    for (const bad of [zeros, otherMessage]) {
      let boarded = false;
      await expect(
        runSimulation(one, { prover: bad, onBundle: () => (boarded = true) }),
      ).rejects.toThrow();
      expect(boarded).toBe(false);
    }
  });
});
