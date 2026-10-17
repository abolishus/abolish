import {
  cellBallotCore,
  cellBallotElection,
  encryptShares,
  identityKey,
  type IntakeKeys,
  proveValidity,
  shareVote,
  type ValidityContext,
} from "@abolishus/crypto";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { planElection, type Scenario } from "../src/index.ts";
import { simulateElection } from "../src/simulation/election.ts";
import {
  intakeInThread,
  intakeInWorkers,
  MAX_INTAKE_WORKERS,
  type SeatCiphertext,
} from "../src/simulation/intake.ts";
import { oneQuestion } from "./one-question.ts";

const timeout = 60_000;

const scenario: Scenario = {
  voters: 2,
  election: "approval",
  options: 3,
  trustees: { panel: 3, threshold: 2, offline: [], faulty: [], departures: [] },
  tiers: { "0": 1, "1": 0, "2": 0 },
  outage: null,
  challenges: 0,
  revotes: 0,
  publications: 0,
  postings: 0,
  reorgs: 0,
  seed: 1,
};

// One election, and one honest ballot for every seat, as a voter's client makes it.
const election = simulateElection(
  scenario,
  planElection(scenario),
  identityKey(crypto.getRandomValues(new Uint8Array(32))),
);
const { definitionHash, seats, registered } = election;
const keys: IntakeKeys[] = seats.map((s) => ({
  seat: s.index,
  kemSecret: s.kem.secretKey,
  signingSecret: s.signingSecret,
}));
const ctx: ValidityContext = {
  optionCount: 3,
  minSelections: 0,
  maxSelections: 3,
  threshold: 2,
  panelSize: 3,
  definitionHash,
  ballotVersion: 2,
  cell: 0,
  nullifier: 1n,
};
const sharing = shareVote(ctx, [1, 0, 1]);
const encrypted = encryptShares(
  { definitionHash },
  sharing,
  registered.map((r) => r.kemKey),
);
const core = cellBallotCore(
  cellBallotElection(oneQuestion(election.definition), registered),
  0,
  encrypted,
);
const vote = proveValidity(ctx, sharing, core.shareHashes);
const every: SeatCiphertext[] = [1, 2, 3].map((seat) => ({
  seat,
  ciphertext: encrypted.ciphertexts[seat - 1] as Uint8Array,
}));

describe("intake in worker threads", { timeout }, () => {
  const pool = intakeInWorkers(keys, 2);
  afterAll(() => pool.close());

  it("gives each seat the result intake gives in the calling thread, shares and receipt alike", async () => {
    const inThread = await intakeInThread(keys).run(ctx, vote, every);
    expect(inThread.every((r) => r.ok)).toBe(true);
    // Several ballots at once, spread over both workers, each back in order.
    const runs = await Promise.all([1, 2, 3, 4].map(() => pool.run(ctx, vote, every)));
    for (const results of runs) expect(results).toEqual(inThread);
  });

  it("reports a seat's refusal as intake does, without failing the pool", async () => {
    // Seat 2's ciphertext given to seat 1: its hash isn't seat 1's.
    const swapped = [{ seat: 1, ciphertext: every[1]?.ciphertext as Uint8Array }];
    const want = await intakeInThread(keys).run(ctx, vote, swapped);
    expect(want[0]).toMatchObject({ ok: false, code: "share-hash" });
    expect(await pool.run(ctx, vote, swapped)).toEqual(want);
    expect((await pool.run(ctx, vote, every)).every((r) => r.ok)).toBe(true);
  });

  it("rejects a ballot for a seat it holds no keys for, and keeps serving others", async () => {
    await expect(pool.run(ctx, vote, [{ seat: 4, ciphertext: new Uint8Array(1) }])).rejects.toThrow(
      /no keys for seat 4/,
    );
    expect((await pool.run(ctx, vote, every.slice(0, 1))).every((r) => r.ok)).toBe(true);
  });

  it("rejects every ballot once closed", async () => {
    const closed = intakeInWorkers(keys, 1);
    await closed.close();
    await expect(closed.run(ctx, vote, every)).rejects.toThrow(/closed/);
  });

  it("serves no worker started without its marker, which exits rather than listening", async () => {
    const unmarked = new Worker(new URL("../src/simulation/intake-worker.ts", import.meta.url), {
      workerData: { seats: keys },
    });
    expect(await new Promise((resolve) => unmarked.once("exit", resolve))).toBe(0);
  });

  it("refuses a worker count that isn't an integer from 1 to the maximum", () => {
    for (const count of [0, -1, 1.5, Number.NaN, MAX_INTAKE_WORKERS + 1])
      expect(() => intakeInWorkers(keys, count)).toThrow(RangeError);
  });
});
