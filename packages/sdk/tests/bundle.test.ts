import { identityKey, RECORD_TYPES } from "@abolishus/crypto";
import { parseBundle, type Report, verifyBundle } from "@abolishus/verifier";
import { describe, expect, it } from "vite-plus/test";
import { planElection, runSimulation, type Scenario } from "../src/index.ts";
import {
  receiptKeyWord,
  SIMULATED_RECEIPT_KEY_LEAD,
  SimulatedAnchor,
} from "../src/simulation/anchor.ts";
import {
  endOf,
  SIMULATED_ANCHOR_DEADLINE,
  SimulatedBoard,
  segmentAt,
} from "../src/simulation/board.ts";
import {
  type BundleInputs,
  type VerifierBundle,
  verifierBundle,
} from "../src/simulation/bundle.ts";
import {
  SIMULATED_BOARD_ENTRY_VERSION,
  type SimulatedElection,
  simulateElection,
} from "../src/simulation/election.ts";
import { SimulatedL1 } from "../src/simulation/l1.ts";
import { SIMULATED_OPENS_AT } from "../src/simulation/plan.ts";
import { judgeVerifierReport } from "../src/simulation/verify.ts";

const timeout = 120_000;

const base: Scenario = {
  voters: 6,
  election: "plurality",
  options: 3,
  trustees: { panel: 4, threshold: 2, offline: [2], faulty: [], departures: [] },
  tiers: { "0": 2, "1": 1, "2": 1 },
  outage: { from: 0.5, to: 1 },
  challenges: 1,
  revotes: 1,
  publications: 1,
  postings: 1,
  reorgs: 0,
  seed: 3,
};

// A record of the given type with any body: the board checks never decode a payload's fields.
const payload = (type: number, body: number) => Uint8Array.of(type >> 8, type & 0xff, 1, body);

const row = (r: Report, id: string) => r.checks.find((c) => c.id === id);
const verify = (b: VerifierBundle) => verifyBundle(parseBundle(b.json, b.board));

// The board operator's receipt secret, whose key every simulated definition lists.
const receiptSecret = crypto.getRandomValues(new Uint8Array(32));

// A board of the ceremony transcript, then entries over three periods, a
// quiet one, and the seal two periods after the last, every period
// anchored in the first block after it ends; the operator's receipt key is
// registered a day before opening, unless `registerAt` says otherwise.
function election(
  e: SimulatedElection,
  registerAt = SIMULATED_OPENS_AT - SIMULATED_RECEIPT_KEY_LEAD,
) {
  const l1 = new SimulatedL1();
  const first = segmentAt(SIMULATED_OPENS_AT);
  const seal = first + 5;
  const board = new SimulatedBoard(
    e.definition.election_id,
    SIMULATED_BOARD_ENTRY_VERSION,
    receiptSecret,
  );
  const anchor = new SimulatedAnchor(e.definition.election_id, first, seal, l1);
  anchor.registerReceiptKey(board.receiptKey, registerAt);
  board.board(first, e.transcript);
  for (const [i, s] of [first, first + 1, first + 1, first + 3].entries())
    board.board(s, payload(RECORD_TYPES.shareReceipt, i));
  anchor.anchorThrough(board.entries, seal);
  const at = (moment: bigint) => {
    const number = l1.firstAfter(moment);
    return { number, timestamp: l1.block(number).timestamp };
  };
  const block = at(endOf(seal) + SIMULATED_ANCHOR_DEADLINE);
  const inputs: BundleInputs = {
    definition: e.definition,
    panel: e.panel,
    clock: anchor.clock,
    entries: board.entries,
    anchors: anchor.anchors,
    firstSegment: first,
    receiptKeys: anchor.receiptKeysAt(block.timestamp),
    block,
  };
  return { inputs, anchor, at, first, seal };
}

describe("verifierBundle", { timeout }, () => {
  const simulated = simulateElection(base, planElection(base), identityKey(receiptSecret));

  it("gives the verifier every anchor from the anchor's L1 state, authenticating the whole board", () => {
    const { inputs, anchor } = election(simulated);
    const b = verifierBundle(inputs);
    const parsed = parseBundle(b.json, b.board);
    expect(parsed.format).toBe("abolish-verifier-bundle/4");
    expect(parsed.entries).toEqual(inputs.entries);
    expect(parsed.unreadableBytes).toBe(0);
    const r = verifyBundle(parsed);
    for (const id of ["2.9", "3.2", "4.1", "4.2"]) expect(row(r, id)?.status, id).toBe("pass");
    expect(r.board).toEqual({ entries: 5, unreadableBytes: 0, unauthenticated: 0 });
    expect(r.l1?.blockNumber).toBe(inputs.block.number.toString());
    expect(r.l1?.timestamp).toBe(inputs.block.timestamp.toString());
    // One word per anchored period, each matched by the copy.
    expect(r.l1?.anchors?.map((a) => [a.segment, a.source])).toEqual(
      anchor.anchors.map((a) => [a.checkpoint.segment, "copy"]),
    );
    expect(r.ceremony).toBeDefined();
  });

  it("holds in L1 state only the anchors made by its block, so later entries are unauthenticated, never failed", () => {
    const { inputs, at, first } = election(simulated);
    // Before period first + 3's anchor: its entry is past every word the state has.
    const r = verify(verifierBundle({ ...inputs, block: at(endOf(first + 2)) }));
    expect(row(r, "4.1")?.status).toBe("pass");
    expect(r.board.unauthenticated).toBe(1);
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
  });

  it("fails 4.2 when a period that added entries has no anchor in state", () => {
    const { inputs, first } = election(simulated);
    const anchors = inputs.anchors.filter((a) => a.checkpoint.segment !== first + 1);
    const r = verify(verifierBundle({ ...inputs, anchors }));
    expect(row(r, "4.2")).toMatchObject({ status: "fail", code: "unanchored" });
  });

  it("leaves the board unverifiable, never failed, when a proof node is missing", () => {
    const { inputs } = election(simulated);
    const b = verifierBundle(inputs);
    const json = JSON.parse(b.json) as { l1: { nodes: string[] } };
    // The last node is a storage-trie node the walk to some word needs.
    json.l1.nodes.pop();
    const r = verify({ json: JSON.stringify(json), board: b.board });
    expect(row(r, "4.1")?.code).toBe("not-reached");
    expect(row(r, "4.2")).toMatchObject({ status: "unverifiable", code: "l1-proof-missing" });
  });

  // 2.9 reads the operator's key from the anchor's receipt-key record in the
  // bundle's L1 state, so the run's pass isn't vacuous: a key the record
  // doesn't hold, or holds from too late, fails the election (T-26, T-71).
  it("fails 2.9 when the anchor's record doesn't hold the listed key by opening", () => {
    const { inputs } = election(simulated);
    expect(row(verify(verifierBundle({ ...inputs, receiptKeys: [] })), "2.9")).toMatchObject({
      status: "fail",
      code: "receipt-key-unregistered",
      at: { key: 0 },
    });
    // Registered as voting opens: after `opens_at` in L1 time, so too late.
    const late = election(simulated, SIMULATED_OPENS_AT);
    expect(row(verify(verifierBundle(late.inputs)), "2.9")).toMatchObject({
      status: "fail",
      code: "receipt-key-unregistered",
    });
    // A word the release code can't write: retired before it was registered.
    const [held] = inputs.receiptKeys;
    if (held === undefined) throw new Error("no key held");
    const broken = { key: held.key, word: receiptKeyWord(2n, 1n) };
    expect(row(verify(verifierBundle({ ...inputs, receiptKeys: [broken] })), "2.9")).toMatchObject({
      status: "fail",
      code: "receipt-key-record",
    });
  });

  it("leaves 2.9 unverifiable while the verifier's block is before opening", () => {
    const { inputs, at } = election(simulated);
    const block = at(SIMULATED_OPENS_AT - 600n);
    const r = verify(verifierBundle({ ...inputs, block }));
    expect(row(r, "2.9")).toMatchObject({ status: "unverifiable", code: "receipt-key-unsettled" });
  });

  it("leaves 3.1 unverifiable when the board lacks the ceremony transcript", () => {
    const { inputs } = election(simulated);
    const b = verifierBundle({ ...inputs, entries: [] });
    const r = verify(b);
    expect(row(r, "3.1")).toMatchObject({
      status: "unverifiable",
      code: "ceremony-transcript-missing",
    });
  });
});

describe("judgeVerifierReport", { timeout }, () => {
  it("agrees with the verifier over a run's bundle, and names each departure from it", async () => {
    let bundle: VerifierBundle | undefined;
    const r = await runSimulation(base, { onBundle: (b) => (bundle = b) });
    if (bundle === undefined) throw new Error("no bundle");
    const report = verify(bundle);
    // What the run boarded, as its report counts it.
    const expected = {
      proven: false,
      entries: r.board.entries,
      ballots: r.ballots.cast,
      openings: r.board.spoiled,
      tallies: r.board.openings,
      registered: r.ceremony.registered.length,
      anchors: r.board.anchors.map((a) => ({ segment: a.segment, hash: a.hash })),
    };
    expect(expected.openings).toBeGreaterThan(0);
    expect(expected.registered).toBe(base.trustees.panel);
    expect(judgeVerifierReport(report, expected)).toEqual([]);
    expect(r.verifier).toEqual({
      verdict: "unverifiable",
      verdictAgainstInputs: "unverifiable",
      block: { number: Number(report.l1?.blockNumber), headerHash: report.l1?.blockHash },
      passed: ["2.9", "3.2", "4.1", "4.2", "5.4", "5.5", "5.7"],
      failed: ["5.1", "5.2", "5.3"].map((id) => ({ id, code: "membership-proof" })),
      admittedBallots: 0,
      rejectedBallots: r.ballots.cast,
    });

    const checks = (id: string, change: object) =>
      report.checks.map((c) => (c.id === id ? { ...c, ...change } : c));
    const judged = (changed: Partial<Report>) =>
      judgeVerifierReport({ ...report, ...changed }, expected);
    expect(judged({ checks: checks("4.2", { status: "unverifiable" }) })).toEqual([
      "4.2 didn't pass",
    ]);
    expect(judged({ checks: checks("5.1", { code: "membership-root" }) })).toEqual([
      "5.1 didn't fail the placeholder membership proofs",
    ]);
    expect(judged({ checks: checks("2.3", { status: "fail", code: "profile-mismatch" }) })).toEqual(
      ["2.3 failed (profile-mismatch)"],
    );
    expect(judged({ verdictAgainstInputs: "failed" })).toEqual(["the election failed"]);
    expect(judged({ board: { ...report.board, unauthenticated: 1 } })).toEqual([
      "an entry no anchor authenticates",
    ]);
    const ballots = report.ballots;
    if (ballots === undefined) throw new Error("no admission");
    expect(judged({ ballots: { ...ballots, rejected: ballots.rejected.slice(1) } })).toEqual([
      "admission didn't reject exactly every ballot's placeholder membership proof",
    ]);
    const [opening] = report.openings ?? [];
    if (opening === undefined) throw new Error("no opening");
    expect(
      judged({ openings: [{ ...opening, breaks: [{ code: "opening-cast", ballot: 1 }] }] }),
    ).toEqual(["6.2 didn't report every published opening without a break"]);
    expect(judged({ tallies: report.tallies?.slice(1) ?? [] })).toEqual([
      "7.4 didn't report every tally opening without a break",
    ]);
    const [, ...later] = expected.anchors;
    expect(judgeVerifierReport(report, { ...expected, anchors: later })).toEqual([
      "the anchors read from L1 state aren't the authority's, matched by the copy",
    ]);
    expect(judgeVerifierReport(report, { ...expected, registered: 3 })).toEqual([
      "3.2 didn't register every seat from the board's first entry",
    ]);
  });
});
