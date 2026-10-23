import type {
  PostingDepositReport,
  PostingHead,
  PostingL1Head,
  PostingPruneReport,
  PostingTendReport,
  PostingTickReport,
} from "@abolishus/core";
import { describe, expect, test } from "vite-plus/test";
import { type LogLine, type PostingRunnerOptions, startPostingRunner } from "../src/index.ts";

// The posting worker's loop (P2-8 part 2b-2b-2b-2b-2; docs/spec/posting-relay.md,
// Queue, In flight, Pruning and Depositing): each round ticks the queue, then
// tends what is in flight at the latest head, every so many rounds tends the
// deposits at the L1's latest and finalized heads (part 2b-2b-2b-2b-3b-2), and
// every so many prunes at the finalized head; one round at a time, each
// step's failure its own, and a log of counts and steps only (T-10, T-18).

const LATEST: PostingHead = { number: 100n, timestamp: 1_000n };
const FINALIZED: PostingHead = { number: 90n, timestamp: 980n };

const ANSWERED: PostingTickReport["answered"] = {
  sent: 0,
  malformed: 0,
  "too-late": 0,
  simulation: 0,
  unavailable: 0,
  "too-costly": 0,
  "ballot-cap": 0,
  budget: 0,
};
const TICK: PostingTickReport = { chain: true, answered: ANSWERED, kept: 0 };
const TEND: PostingTendReport = {
  landed: 0,
  unlanded: 0,
  posted: 0,
  rebroadcast: 0,
  replaced: 0,
  resent: 0,
  held: 0,
  failed: 0,
};
const PRUNE: PostingPruneReport = { final: 0, expired: 0, elections: 0, failed: 0 };
const L1_LATEST: PostingL1Head = { number: 7n, timestamp: 990n };
const L1_FINALIZED: PostingL1Head = { number: 5n, timestamp: 966n };
const DEPOSIT: PostingDepositReport = {
  deposited: 0,
  held: 0,
  rebroadcast: 0,
  replaced: 0,
  cancelled: 0,
  landed: 0,
  failed: 0,
  unsettled: 0,
  final: 0,
  unseen: 0,
  consumed: 0,
  released: 0,
  unjudged: 0,
  errors: 0,
};

/** Resolves once `done` holds, checking every millisecond for up to two seconds. */
async function until(done: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A runner over fakes that record each call, every step answering `answers`' next value. */
function fakes(
  answers: {
    tick?: (round: number) => Promise<PostingTickReport | null>;
    tend?: (round: number) => Promise<PostingTendReport>;
    prune?: (round: number) => Promise<PostingPruneReport>;
    deposit?: (round: number) => Promise<PostingDepositReport>;
  } = {},
) {
  const calls: string[] = [];
  const lines: LogLine[] = [];
  let ticks = 0;
  let tends = 0;
  let prunes = 0;
  let deposits = 0;
  const options: PostingRunnerOptions = {
    worker: {
      tick: () => {
        calls.push("tick");
        return answers.tick?.(ticks++) ?? Promise.resolve(TICK);
      },
    },
    ledger: {
      tend: (head) => {
        calls.push(`tend ${head.number}`);
        return answers.tend?.(tends++) ?? Promise.resolve(TEND);
      },
      prune: (head) => {
        calls.push(`prune ${head.number}`);
        return answers.prune?.(prunes++) ?? Promise.resolve(PRUNE);
      },
    },
    chain: {
      latest: () => Promise.resolve(LATEST),
      finalized: () => Promise.resolve(FINALIZED),
    },
    deposits: {
      tend: (heads) => {
        calls.push(`deposit ${heads.latest.number} ${heads.finalized.number}`);
        return answers.deposit?.(deposits++) ?? Promise.resolve(DEPOSIT);
      },
    },
    l1: {
      latest: () => Promise.resolve(L1_LATEST),
      finalized: () => Promise.resolve(L1_FINALIZED),
    },
    log: (line) => lines.push(line),
    tickMs: 1,
    pruneEveryMs: 3,
    depositEveryMs: 2,
  };
  return { options, calls, lines, rounds: () => calls.filter((c) => c === "tick").length };
}

describe("the posting worker's loop", () => {
  test("ticks, then tends at the latest head each round, deposits at the L1's heads and prunes at the finalized head every few", async () => {
    const f = fakes();
    const runner = startPostingRunner(f.options);
    await until(() => f.rounds() >= 8);
    await runner.close();
    const round = ["tick", "tend 100"];
    const deposit = "deposit 7 5";
    expect(f.calls.slice(0, 21)).toEqual([
      ...round,
      deposit,
      "prune 90",
      ...round,
      ...round,
      deposit,
      ...round,
      "prune 90",
      ...round,
      deposit,
      ...round,
      ...round,
      deposit,
      "prune 90",
    ]);
    // Nothing moved, so nothing is logged.
    expect(f.lines).toEqual([]);
  });

  test("logs a round's counts only when something moved", async () => {
    const f = fakes({
      tick: async (n) =>
        n === 1 ? { ...TICK, answered: { ...ANSWERED, sent: 2 }, kept: 1 } : TICK,
      tend: async (n) => (n === 2 ? { ...TEND, landed: 1 } : TEND),
      prune: async (n) => (n === 1 ? { ...PRUNE, expired: 3, elections: 1 } : PRUNE),
      deposit: async (n) => (n === 1 ? { ...DEPOSIT, deposited: 1, held: 2 } : DEPOSIT),
    });
    const runner = startPostingRunner(f.options);
    await until(() => f.rounds() >= 5);
    await runner.close();
    expect(f.lines).toEqual([
      { queue: "{posting}", step: "tick", answered: { ...ANSWERED, sent: 2 }, kept: 1 },
      { queue: "{posting}", step: "tend", ...TEND, landed: 1 },
      { queue: "{posting}", step: "deposit", ...DEPOSIT, deposited: 1, held: 2 },
      { queue: "{posting}", step: "prune", ...PRUNE, expired: 3, elections: 1 },
    ]);
  });

  test("logs a step once as it starts failing and once as it recovers, never the error", async () => {
    const f = fakes({
      // An unread head, then a thrown tick, then a good one.
      tick: async (n) => {
        if (n === 0) return { ...TICK, chain: false };
        if (n === 1) throw new Error("the node at https://l2.example/v2/provider-api-key");
        return TICK;
      },
      // A tend that leaves an entry, then one that throws, then good ones.
      tend: async (n) => {
        if (n === 0) return { ...TEND, failed: 1 };
        if (n === 1) throw new Error("m_i 0xdeadbeef");
        return TEND;
      },
      // A prune whose finalized head the ledger refused.
      prune: async (n) => {
        if (n === 0) throw new Error("the finalized head is ahead of the clock");
        return PRUNE;
      },
      // A due posting no election's times let it judge, then a good tend.
      deposit: async (n) => (n === 0 ? { ...DEPOSIT, unjudged: 1 } : DEPOSIT),
    });
    const runner = startPostingRunner(f.options);
    await until(() => f.rounds() >= 5);
    await runner.close();
    expect(f.lines).toEqual([
      { queue: "{posting}", step: "tick", outcome: "failing" },
      { queue: "{posting}", step: "tend", ...TEND, failed: 1 },
      { queue: "{posting}", step: "tend", outcome: "failing" },
      { queue: "{posting}", step: "deposit", ...DEPOSIT, unjudged: 1 },
      { queue: "{posting}", step: "deposit", outcome: "failing" },
      { queue: "{posting}", step: "prune", outcome: "failing" },
      { queue: "{posting}", step: "tick", outcome: "recovered" },
      { queue: "{posting}", step: "tend", outcome: "recovered" },
      { queue: "{posting}", step: "deposit", outcome: "recovered" },
      { queue: "{posting}", step: "prune", outcome: "recovered" },
    ]);
    const text = JSON.stringify(f.lines);
    expect(text).not.toContain("provider-api-key");
    expect(text).not.toContain("deadbeef");
  });

  test("a failing step never holds up the others", async () => {
    const f = fakes({
      tick: () => Promise.reject(new Error("Redis is down")),
      tend: () => Promise.reject(new Error("Postgres is down")),
      deposit: () => Promise.reject(new Error("the L1 node is down")),
    });
    const runner = startPostingRunner(f.options);
    await until(() => f.rounds() >= 4);
    await runner.close();
    expect(f.calls.slice(0, 9)).toEqual([
      "tick",
      "tend 100",
      "deposit 7 5",
      "prune 90",
      "tick",
      "tend 100",
      "tick",
      "tend 100",
      "deposit 7 5",
    ]);
  });

  test("a log that can't be written never fails a step or stops the loop", async () => {
    const f = fakes({ tend: async () => ({ ...TEND, landed: 1 }) });
    let tried = 0;
    const runner = startPostingRunner({
      ...f.options,
      log: () => {
        tried++;
        throw new Error("stdout is closed");
      },
    });
    await until(() => f.rounds() >= 3);
    await runner.close();
    // Only the tend's counts were written: no step was counted as failing.
    expect(tried).toBe(f.calls.filter((c) => c.startsWith("tend")).length);
  });

  test("a tick another tick holds is a round done, not a failure", async () => {
    const f = fakes({ tick: async () => null });
    const runner = startPostingRunner(f.options);
    await until(() => f.rounds() >= 2);
    await runner.close();
    expect(f.lines).toEqual([]);
  });

  test("runs one round at a time, and close waits for the round under way and starts none after", async () => {
    let release: () => void = () => {};
    let inTick = 0;
    let most = 0;
    const f = fakes({
      tick: async (n) => {
        inTick++;
        most = Math.max(most, inTick);
        if (n === 2) await new Promise<void>((r) => (release = r));
        inTick--;
        return TICK;
      },
    });
    const runner = startPostingRunner(f.options);
    await until(() => f.rounds() === 3);
    let closed = false;
    const closing = runner.close().then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(false);
    release();
    await closing;
    const after = f.calls.length;
    await new Promise((r) => setTimeout(r, 10));
    // The held round finished its tend and deposits; no round started after it.
    expect(f.calls.length).toBe(after);
    expect(f.calls.slice(-2)).toEqual(["tend 100", "deposit 7 5"]);
    expect(f.rounds()).toBe(3);
    expect(most).toBe(1);
  });

  test("refuses a period that isn't one", () => {
    const { options } = fakes();
    expect(() => startPostingRunner({ ...options, tickMs: 0 })).toThrow(RangeError);
    expect(() => startPostingRunner({ ...options, tickMs: 1.5 })).toThrow(RangeError);
    expect(() => startPostingRunner({ ...options, tickMs: 10, pruneEveryMs: 5 })).toThrow(
      RangeError,
    );
    expect(() => startPostingRunner({ ...options, tickMs: 10, depositEveryMs: 5 })).toThrow(
      RangeError,
    );
  });
});
