// The posting worker's loop (docs/spec/posting-relay.md, Queue, Sending, In
// flight and Pruning; P2-8 part 3c-1b-2b-2b-2d-2b-2b-2b-2b-2b-2): every
// `POSTING_TICK_MS`, the queue's tick, then the ledger's tend with the L2
// node's latest block, and every `POSTING_PRUNE_EVERY_MS` the ledger's prune
// with its finalized one. One round at a time, the next timed from the end
// of the last, so no two steps share the posting key's nonce at once within
// this process; the ledger's lock serialises them against a deploy's
// overlap.
//
// Not BullMQ: a scheduled job's ID and times stay in its queue's events
// stream, and the queue is drained in place, never a job per request (Queue;
// T-11, T-13). The log holds counts and a step only, never a posting, a
// ballot hash, a nullifier, a transaction, an address or an error's message
// (T-10, T-18); a step that keeps failing is logged when it starts to and
// when it recovers, not every round.

import {
  POSTING_TICK_MS,
  type PostingHead,
  type PostingPruneReport,
  type PostingTendReport,
  type PostingTickReport,
} from "@abolishus/core";
import type { Log, PostingStep } from "./log.ts";

/**
 * The finalized head moves on an OP Stack L2 every few minutes, and a prune
 * deletes only what is final or past its `t_D`, so once a minute adds little.
 */
export const POSTING_PRUNE_EVERY_MS = 60_000;

export interface PostingRunnerOptions {
  readonly worker: { tick(): Promise<PostingTickReport | null> };
  readonly ledger: {
    tend(head: PostingHead): Promise<PostingTendReport>;
    prune(finalized: PostingHead): Promise<PostingPruneReport>;
  };
  /** The posting key's node, as `ViemPostingChain` reads it. */
  readonly chain: { latest(): Promise<PostingHead>; finalized(): Promise<PostingHead> };
  readonly log: Log;
  /** Milliseconds between rounds; `POSTING_TICK_MS` unless a test says otherwise. */
  readonly tickMs?: number;
  /** Milliseconds between prunes; `POSTING_PRUNE_EVERY_MS` unless a test says otherwise. */
  readonly pruneEveryMs?: number;
}

export interface RunningPostingRunner {
  /** Stops the loop once the round under way, if any, has finished. */
  close(): Promise<void>;
}

const anything = (counts: Readonly<Record<string, number>>) =>
  Object.values(counts).some((n) => n > 0);

/** Starts the loop: its first round at once. */
export function startPostingRunner(options: PostingRunnerOptions): RunningPostingRunner {
  const { worker, ledger, chain, log } = options;
  const tickMs = options.tickMs ?? POSTING_TICK_MS;
  const pruneEveryMs = options.pruneEveryMs ?? POSTING_PRUNE_EVERY_MS;
  if (!Number.isSafeInteger(tickMs) || tickMs <= 0)
    throw new RangeError("tickMs must be an integer > 0");
  if (!Number.isSafeInteger(pruneEveryMs) || pruneEveryMs < tickMs)
    throw new RangeError("pruneEveryMs must be an integer ≥ tickMs");
  const pruneEvery = Math.ceil(pruneEveryMs / tickMs);
  const failing = new Set<PostingStep>();
  const outcome = (step: PostingStep, ok: boolean) => {
    if (ok === !failing.has(step)) return;
    if (ok) failing.delete(step);
    else failing.add(step);
    log({ queue: "{posting}", step, outcome: ok ? "recovered" : "failing" });
  };
  // Each step's failure is its own: a node down for the tick may still
  // answer the prune, and a tend's failure never holds up the next tick.
  const step = async (name: PostingStep, run: () => Promise<boolean>) => {
    let ok: boolean;
    try {
      ok = await run();
    } catch {
      ok = false;
    }
    outcome(name, ok);
  };

  const round = async (n: number) => {
    await step("tick", async () => {
      const report = await worker.tick();
      if (report === null) return true;
      if (report.kept > 0 || anything(report.answered))
        log({ queue: "{posting}", step: "tick", answered: report.answered, kept: report.kept });
      // An unread or stale head judged nothing, and the route's index ages out.
      return report.chain;
    });
    await step("tend", async () => {
      const report = await ledger.tend(await chain.latest());
      if (anything({ ...report })) log({ queue: "{posting}", step: "tend", ...report });
      return report.failed === 0;
    });
    if (n % pruneEvery === 0)
      await step("prune", async () => {
        const report = await ledger.prune(await chain.finalized());
        if (anything({ ...report })) log({ queue: "{posting}", step: "prune", ...report });
        return report.failed === 0;
      });
  };

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: Promise<void> = Promise.resolve();
  const next = (n: number) => {
    // `round` never rejects: every step catches its own failure.
    current = round(n).then(() => {
      if (!closed) timer = setTimeout(() => next(n + 1), tickMs);
    });
  };
  next(0);
  return {
    async close() {
      closed = true;
      clearTimeout(timer);
      await current;
    },
  };
}
