// A posting through the operator's relay (src/posting.ts;
// docs/spec/posting-relay.md, Request, Answers and Outcome): the request
// carries the two records and no credential, every answer outside the
// route's forms is unreachable, and the client stands down only on the
// board's event at the finalized head, falling back at the relay's
// patience, its send cutoff, a sent posting's wait, and the client's
// deadline `c_P`, read from the force cutoff `c_L`; a late run, past the
// send cutoff, at the last-offer cutoff `c_E`; and the wait after a run,
// which reads only the finalized head, until the send cutoff `c_S` (T-10,
// T-25, T-50, T-52).

import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import { keccak_256 } from "@noble/hashes/sha3.js";

import { STAGING } from "../src/deployment.ts";
import { WALLET_HOLD_MARGIN } from "../src/lapse.ts";
import type { Fetch, LoadedDeposits, LoadedPostings } from "../src/load.ts";
import {
  POSTING_CLIENT_MARGIN,
  POSTING_FORCE_AFTER,
  POSTING_PATIENCE,
  POSTING_POLL_MS,
  POSTING_SEEN,
  POSTING_SEND_MARGIN,
  type PostingIo,
  postingCalldata,
  postThroughRelay,
  postingTopics,
  type RecordWait,
  type RecordWaitIo,
  type RelayAnswer,
  sendPosting,
  timedFetch,
  waitForRecord,
} from "../src/posting.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const POSTING = Uint8Array.of(0, 13, 1, 0xaa, 0xbb);
const BALLOT = Uint8Array.of(0, 2, 3, 0xcc);
const TX = "ab".repeat(32);
// `F`, staging's.
const F = STAGING.forcedInclusion;

describe("sendPosting", () => {
  /** The route answering `status` with `body`, recording the request. */
  function route(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn: Fetch = (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
      );
    };
    return { calls, fetchFn };
  }

  test("sends both records as lowercase hex, with no credential, referrer or redirect", async () => {
    const { calls, fetchFn } = route(200, { transaction: TX, layer: "l2" });
    expect(await sendPosting(STAGING, POSTING, BALLOT, fetchFn)).toEqual({
      kind: "sent",
      transaction: new Uint8Array(32).fill(0xab),
      layer: "l2",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${STAGING.api}/postings`);
    expect(calls[0]?.init).toMatchObject({
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      redirect: "error",
      cache: "no-store",
    });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      posting: "000d01aabb",
      ballot: "000203cc",
    });
  });

  test("reads each answer the route gives", async () => {
    const cases: [number, unknown, RelayAnswer][] = [
      [
        200,
        { transaction: TX, layer: "l1" },
        { kind: "sent", transaction: new Uint8Array(32).fill(0xab), layer: "l1" },
      ],
      [
        422,
        { code: "POSTING_REFUSED", data: { code: "malformed", check: "posting-ballot" } },
        { kind: "refused", code: "malformed" },
      ],
      [
        422,
        { code: "POSTING_REFUSED", data: { code: "ballot-cap" } },
        { kind: "refused", code: "ballot-cap" },
      ],
      [400, { code: "BAD_REQUEST" }, { kind: "refused", code: "malformed" }],
      [503, { code: "RELAY_BUSY" }, { kind: "busy" }],
      [503, { code: "RELAY_UNAVAILABLE" }, { kind: "busy" }],
      [429, { code: "RATE_LIMITED" }, { kind: "busy" }],
    ];
    for (const [status, body, expected] of cases)
      expect(await sendPosting(STAGING, POSTING, BALLOT, route(status, body).fetchFn)).toEqual(
        expected,
      );
  });

  test("an answer outside the route's forms, or no answer, is unreachable", async () => {
    const cases: [number, unknown][] = [
      [200, { transaction: TX }],
      [200, { transaction: TX, layer: "l3" }],
      [200, { transaction: TX.toUpperCase(), layer: "l2" }],
      [200, { transaction: TX.slice(2), layer: "l2" }],
      [200, { transaction: TX, layer: "l2", extra: 1 }],
      [201, { transaction: TX, layer: "l2" }],
      [200, "not json"],
      [422, { code: "POSTING_REFUSED" }],
      [422, { code: "POSTING_REFUSED", data: { code: "Not A Code" } }],
      [422, { code: "POSTING_REFUSED", data: { code: "x".repeat(65) } }],
      [503, { code: "RATE_LIMITED" }],
      [429, { code: "RELAY_BUSY" }],
      [500, { code: "INTERNAL_SERVER_ERROR" }],
      [200, "x".repeat(5000)],
    ];
    for (const [status, body] of cases)
      expect(await sendPosting(STAGING, POSTING, BALLOT, route(status, body).fetchFn)).toEqual({
        kind: "unreachable",
      });
    const down: Fetch = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await sendPosting(STAGING, POSTING, BALLOT, down)).toEqual({ kind: "unreachable" });
  });

  test("a relay that holds the request or its body open is cut off, as unreachable", async () => {
    // A server that answers nothing until the request is aborted.
    const held: Fetch = (_, init) =>
      new Promise((_resolve, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      );
    expect(await sendPosting(STAGING, POSTING, BALLOT, timedFetch(held, 20))).toEqual({
      kind: "unreachable",
    });
    // One that sends its status, then trickles a body it never ends.
    const trickled: Fetch = (_, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
              init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
            },
          }),
          { status: 200 },
        ),
      );
    expect(await sendPosting(STAGING, POSTING, BALLOT, timedFetch(trickled, 20))).toEqual({
      kind: "unreachable",
    });
  });
});

describe("postThroughRelay", () => {
  // The poll's `c_D`, far enough ahead that only the relay's own waits end a run.
  const START = 1_800_000_000n;
  const CUTOFF = START + 100_000n;
  // The last-offer cutoff `c_E`, as far past `c_L` as the deployed values put it.
  const LAST = CUTOFF + 3_600n;
  // A late run's cutoff, given once the voter was told it is best effort.
  const LATE = { lastOffer: LAST };
  const OTHER = Uint8Array.of(0, 13, 1, 0xdd);

  /**
   * A relay and a board on a clock that moves only by the loop's sleeps:
   * `relay` answers each send, `finalized` and `latest` say, at each time
   * (seconds from `START`), which records each head carries.
   */
  function world({
    relay,
    finalized = () => [],
    latest = () => [],
    chainAhead = 0n,
    start = START,
    readFails = false,
    landed = () => [],
    l1Ahead = 0n,
  }: {
    relay: (posting: Uint8Array, call: number) => RelayAnswer;
    finalized?: (t: bigint) => readonly Uint8Array[];
    latest?: (t: bigint) => readonly Uint8Array[];
    chainAhead?: bigint;
    start?: bigint;
    readFails?: boolean;
    /** Each posting's qualifying deposit's L1 time, by seconds from `start`, as L1 shows them at `t`. */
    landed?: (t: bigint) => readonly (bigint | undefined)[];
    l1Ahead?: bigint;
  }) {
    let ms = Number(start) * 1000;
    const sends: { posting: Uint8Array; at: bigint }[] = [];
    const reads: { head: string; from: bigint | undefined }[] = [];
    const l1Reads: { since: bigint; at: bigint }[] = [];
    const t = () => BigInt(Math.floor(ms / 1000));
    const io: PostingIo = {
      send(posting) {
        sends.push({ posting, at: t() });
        return Promise.resolve(relay(posting, sends.length - 1));
      },
      find(head, from): Promise<LoadedPostings> {
        reads.push({ head, from });
        if (readFails) return Promise.resolve({ ok: false, problem: "unreachable" });
        const records = head === "finalized" ? finalized(t() - start) : latest(t() - start);
        return Promise.resolve({
          ok: true,
          block: t(),
          timestamp: t() + chainAhead,
          records,
        });
      },
      deposits(since): Promise<LoadedDeposits> {
        l1Reads.push({ since, at: t() });
        if (readFails) return Promise.resolve({ ok: false, problem: "unreachable" });
        return Promise.resolve({
          ok: true,
          timestamp: t() + l1Ahead,
          landed: landed(t() - start).map((x) => (x === undefined ? undefined : start + x)),
        });
      },
      now: () => ms,
      sleep(wait) {
        ms += wait;
        return Promise.resolve();
      },
    };
    return { io, sends, reads, l1Reads, elapsed: () => t() - start };
  }

  const sent: RelayAnswer = { kind: "sent", transaction: new Uint8Array(32), layer: "l2" };
  const POLL = BigInt(POSTING_POLL_MS / 1000);

  test("recorded once the finalized head carries every posting's exact bytes, each sent once", async () => {
    const w = world({
      relay: () => sent,
      finalized: (t) => (t >= 900n ? [OTHER, POSTING] : t >= 300n ? [POSTING] : []),
    });
    expect(await postThroughRelay(w.io, [POSTING, OTHER], CUTOFF, F, LATE)).toBe("recorded");
    expect(w.sends.map((s) => s.posting)).toEqual([POSTING, OTHER]);
    expect(w.elapsed()).toBe(900n);
    // Each finalized read starts past the last one's head.
    const finals = w.reads.filter((r) => r.head === "finalized");
    expect(finals[0]?.from).toBeUndefined();
    for (let i = 1; i < finals.length; i++)
      expect(finals[i]?.from).toBe(START + POLL * BigInt(i - 1) + 1n);
  });

  test("a posting the board already carries is never sent", async () => {
    const w = world({ relay: () => sent, finalized: () => [POSTING] });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("recorded");
    expect(w.sends).toHaveLength(0);
  });

  test("a refusal falls back at once, the relay having read the posting", async () => {
    const w = world({
      relay: (_, call) => (call < 2 ? { kind: "busy" } : { kind: "refused", code: "ballot-cap" }),
    });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(w.sends).toHaveLength(3);
  });

  test("busy or unreachable is sent again each round, until the relay's patience runs out", async () => {
    // Sent, the relay may have read it, whatever it answered.
    const answers = [
      [{ kind: "busy" }, "relayed"],
      [{ kind: "unreachable" }, "relayed"],
    ] as const;
    for (const [answer, outcome] of answers) {
      const w = world({ relay: () => answer });
      expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe(outcome);
      expect(w.sends.every((s) => s.at - START < POSTING_PATIENCE)).toBe(true);
      expect(w.sends).toHaveLength(Number(POSTING_PATIENCE / POLL));
      expect(w.elapsed()).toBe(POSTING_PATIENCE);
    }
  });

  test("each send checks the time again: a slow send ends the round's later ones past the cutoff", async () => {
    const start = CUTOFF - POSTING_SEND_MARGIN - 10n;
    const w = world({ relay: () => ({ kind: "busy" }), start });
    // Every send takes the request's whole 30 seconds.
    const slow = {
      ...w.io,
      send: async (posting: Uint8Array) => {
        const answer = await w.io.send(posting);
        await w.io.sleep(30_000);
        return answer;
      },
    };
    expect(await postThroughRelay(slow, [POSTING, OTHER, POSTING], CUTOFF, F, LATE)).toBe(
      "relayed",
    );
    expect(w.sends).toHaveLength(1);
  });

  test("a relay that reads the posting and never answers still leaves it relayed", async () => {
    const w = world({ relay: () => sent });
    const reset = { ...w.io, send: () => Promise.reject(new TypeError("connection reset")) };
    expect(await postThroughRelay(reset, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    const silent = {
      ...w.io,
      send: async (): Promise<RelayAnswer> => {
        await w.io.sleep(30_000);
        return { kind: "unreachable" };
      },
    };
    expect(await postThroughRelay(silent, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
  });

  test("a board read that answers each range slowly is given up at c_P", async () => {
    const start = CUTOFF - POSTING_SEND_MARGIN - 600n;
    const w = world({ relay: () => sent, start });
    // Each range takes 29 seconds, just under a request's timeout, without end.
    const slow = {
      ...w.io,
      find: async (_: "finalized" | "latest", __: bigint | undefined, stop: () => boolean) => {
        while (!stop()) await w.io.sleep(29_000);
        return { ok: false, problem: "unreachable" } as const;
      },
    };
    expect(await postThroughRelay(slow, [POSTING], CUTOFF, F, LATE)).toBe("unreachable");
    expect(start + w.elapsed()).toBeLessThanOrEqual(CUTOFF - POSTING_CLIENT_MARGIN + 29n);
    expect(w.sends).toHaveLength(0);
  });

  test("a run that reaches the relay's send cutoff sends nothing more", async () => {
    // Started before it, busy until past it.
    const start = CUTOFF - POSTING_SEND_MARGIN - 100n;
    const w = world({ relay: () => ({ kind: "busy" }), start });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(w.sends.length).toBeGreaterThan(0);
    for (const s of w.sends) expect(s.at).toBeLessThanOrEqual(CUTOFF - POSTING_SEND_MARGIN);
    expect(start + w.elapsed()).toBeLessThanOrEqual(CUTOFF - POSTING_SEND_MARGIN + POLL);
  });

  test("a run started past the send cutoff is a late run: it sends, best effort, until c_E (T-25)", async () => {
    const start = CUTOFF - POSTING_SEND_MARGIN + 1n;
    // An honest relay: recorded within minutes.
    const honest = world({
      relay: () => sent,
      finalized: (t) => (t >= 600n ? [POSTING] : []),
      start,
    });
    expect(await postThroughRelay(honest.io, [POSTING], CUTOFF, F, LATE)).toBe("recorded");
    expect(honest.sends).toHaveLength(1);
    // With nothing to fall back to in time, a sent posting no head shows is
    // waited for to c_E, its deadline, and no longer: one recorded past it is
    // the page's wait to find, without the election's lock (T-52).
    const unseen = world({ relay: () => sent, start });
    expect(await postThroughRelay(unseen.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(start + unseen.elapsed()).toBeGreaterThan(LAST);
    expect(start + unseen.elapsed()).toBeLessThanOrEqual(LAST + POLL);
    const slow = world({
      relay: () => sent,
      finalized: (t) => (t >= 900n ? [POSTING] : []),
      start: LAST - 300n,
    });
    expect(await postThroughRelay(slow.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(slow.sends).toHaveLength(1);
    expect(LAST - 300n + slow.elapsed()).toBeLessThanOrEqual(LAST + POLL);
  });

  test("a late run the voter wasn't told of sends nothing (T-15)", async () => {
    const w = world({ relay: () => sent, start: CUTOFF - POSTING_SEND_MARGIN + 1n });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F)).toBe("unreachable");
    expect(w.sends).toHaveLength(0);
  });

  test("a late run ends at c_E, its deadline, and sends nothing past it", async () => {
    const start = LAST - 600n;
    const busy = world({ relay: () => ({ kind: "busy" }), start });
    expect(await postThroughRelay(busy.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    for (const s of busy.sends) expect(s.at).toBeLessThanOrEqual(LAST);
    expect(start + busy.elapsed()).toBeGreaterThan(LAST);
    expect(start + busy.elapsed()).toBeLessThanOrEqual(LAST + POLL);
    // A sent posting is waited for to c_E, never past it, a sighting or not.
    const seen = world({ relay: () => sent, latest: () => [POSTING], start });
    expect(await postThroughRelay(seen.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(start + seen.elapsed()).toBeLessThanOrEqual(LAST + POLL);
    // Past c_E nothing is sent at all, and the finalized head is read once.
    const past = world({ relay: () => sent, start: LAST + 1n });
    expect(await postThroughRelay(past.io, [POSTING], CUTOFF, F, LATE)).toBe("unreachable");
    expect(past.sends).toHaveLength(0);
    expect(past.reads.map(({ head }) => head)).toEqual(["finalized"]);
    // Where it finds what an earlier run handed out, the ballot can go.
    const earlier = world({ relay: () => sent, finalized: () => [POSTING], start: LAST + 1n });
    expect(await postThroughRelay(earlier.io, [POSTING], CUTOFF, F, LATE)).toBe("recorded");
  });

  test("a sent posting the latest head never shows falls back once its wait is over", async () => {
    const w = world({ relay: () => sent });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(w.sends).toHaveLength(1);
    expect(w.elapsed()).toBe(POSTING_FORCE_AFTER + POSTING_SEEN);
    // The latest head is read only once the wait is over.
    expect(w.reads.filter((r) => r.head === "latest")).toHaveLength(1);
  });

  test("a sighting at the latest head keeps the client waiting, never past c_P", async () => {
    const start = CUTOFF - POSTING_CLIENT_MARGIN - 3_000n;
    const w = world({ relay: () => sent, latest: () => [POSTING], start });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    // It stops at the first round past c_P.
    expect(start + w.elapsed()).toBeGreaterThan(CUTOFF - POSTING_CLIENT_MARGIN);
    expect(start + w.elapsed() - POLL).toBeLessThanOrEqual(CUTOFF - POSTING_CLIENT_MARGIN);
    // And a posting finalized while it waits is recorded.
    const v = world({
      relay: () => sent,
      latest: () => [POSTING],
      finalized: (t) => (t >= 2_400n ? [POSTING] : []),
    });
    expect(await postThroughRelay(v.io, [POSTING], CUTOFF, F, LATE)).toBe("recorded");
    expect(v.elapsed()).toBe(2_400n);
  });

  test("the finalized head's time counts toward the deadlines, as the device's clock does", async () => {
    const w = world({ relay: () => sent, chainAhead: 200_000n });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("unreachable");
    expect(w.sends).toHaveLength(0);
  });

  test("a late run counts a head's time only within WALLET_HOLD_MARGIN of the device's clock (T-25)", async () => {
    const start = CUTOFF - POSTING_SEND_MARGIN + 1n;
    // An endpoint answering a head past c_E can't end the run before it sends.
    const forged = world({
      relay: () => sent,
      finalized: (t) => (t >= 600n ? [POSTING] : []),
      chainAhead: LAST - start + 1n,
      start,
    });
    expect(await postThroughRelay(forged.io, [POSTING], CUTOFF, F, LATE)).toBe("recorded");
    expect(forged.sends).toHaveLength(1);
    // One within the margin still counts: a head past c_E ends the sends.
    const near = world({
      relay: () => ({ kind: "busy" }),
      chainAhead: WALLET_HOLD_MARGIN,
      start: LAST - WALLET_HOLD_MARGIN + 1n,
    });
    expect(await postThroughRelay(near.io, [POSTING], CUTOFF, F, LATE)).toBe("unreachable");
    expect(near.sends).toHaveLength(0);
  });

  test("an RPC that can't be read, or whose read throws, records nothing, and the deadlines still end the run", async () => {
    const w = world({ relay: () => sent, readFails: true });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(w.elapsed()).toBe(POSTING_FORCE_AFTER + POSTING_SEEN);
    const v = world({ relay: () => sent });
    const throwing = { ...v.io, find: () => Promise.reject(new DOMException("t", "TimeoutError")) };
    expect(await postThroughRelay(throwing, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(v.elapsed()).toBe(POSTING_FORCE_AFTER + POSTING_SEEN);
  });

  test("the latest head's time ends a sighting's wait as the finalized head's does", async () => {
    const start = CUTOFF - POSTING_CLIENT_MARGIN - 3_000n;
    // The finalized head can't be read; the latest shows the posting, at a
    // time past c_P that the device's clock is still 3,000 seconds short of.
    const w = world({ relay: () => sent, start });
    const late = {
      ...w.io,
      find: (head: "finalized" | "latest"): Promise<LoadedPostings> =>
        Promise.resolve(
          head === "finalized"
            ? { ok: false, problem: "unreachable" }
            : { ok: true, block: 1n, timestamp: CUTOFF, records: [POSTING] },
        ),
    };
    expect(await postThroughRelay(late, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(w.elapsed()).toBeLessThanOrEqual(POSTING_FORCE_AFTER + POSTING_SEEN + POLL);
  });

  test("a qualifying deposit keeps the client waiting until its L1 time plus F, then it falls back", async () => {
    const WAIT = POSTING_FORCE_AFTER + POSTING_SEEN;
    const w = world({ relay: () => sent, landed: () => [700n] });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    // The first round at or past the deposit's time to reach L2.
    expect(w.elapsed()).toBeGreaterThanOrEqual(700n + F);
    expect(w.elapsed() - POLL).toBeLessThan(700n + F);
    // L1 is read once, when the wait is over, from the run's start.
    expect(w.l1Reads).toEqual([{ since: START, at: START + WAIT }]);
    // And a posting the deposit lands is recorded.
    const v = world({
      relay: () => sent,
      landed: () => [700n],
      finalized: (t) => (t >= 30_000n ? [POSTING] : []),
    });
    expect(await postThroughRelay(v.io, [POSTING], CUTOFF, F, LATE)).toBe("recorded");
    expect(v.elapsed()).toBe(30_000n);
  });

  test("a deposit's wait never runs past c_P, and one already past its time holds nothing", async () => {
    const start = CUTOFF - POSTING_CLIENT_MARGIN - 3_000n;
    const w = world({ relay: () => sent, landed: () => [1_000n], start });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(start + w.elapsed()).toBeGreaterThan(CUTOFF - POSTING_CLIENT_MARGIN);
    expect(start + w.elapsed() - POLL).toBeLessThanOrEqual(CUTOFF - POSTING_CLIENT_MARGIN);
    // A deposit whose L1 time plus F is already behind the clock.
    const v = world({ relay: () => sent, landed: () => [-F] });
    expect(await postThroughRelay(v.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(v.elapsed()).toBe(POSTING_FORCE_AFTER + POSTING_SEEN);
  });

  test("L1 is looked at only for a posting neither head shows, and each posting needs its own deposit", async () => {
    // Seen at the latest head: no L1 read.
    const w = world({ relay: () => sent, latest: () => [POSTING], landed: () => [0n] });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(w.l1Reads).toHaveLength(0);
    // Two postings, a deposit for only the second: the first falls back.
    const v = world({ relay: () => sent, landed: () => [undefined, 700n] });
    expect(await postThroughRelay(v.io, [POSTING, OTHER], CUTOFF, F, LATE)).toBe("relayed");
    expect(v.elapsed()).toBe(POSTING_FORCE_AFTER + POSTING_SEEN);
    // One seen, the other deposited: both are waited on.
    const u = world({
      relay: () => sent,
      latest: () => [POSTING],
      landed: () => [undefined, 700n],
    });
    expect(await postThroughRelay(u.io, [POSTING, OTHER], CUTOFF, F, LATE)).toBe("relayed");
    expect(u.elapsed()).toBeGreaterThanOrEqual(700n + F);
  });

  test("an L1 that can't be read, or whose read throws, falls back once the wait is over", async () => {
    const WAIT = POSTING_FORCE_AFTER + POSTING_SEEN;
    const w = world({ relay: () => sent, landed: () => [700n] });
    const failing = {
      ...w.io,
      deposits: () => Promise.resolve<LoadedDeposits>({ ok: false, problem: "unreachable" }),
    };
    expect(await postThroughRelay(failing, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(w.elapsed()).toBe(WAIT);
    const v = world({ relay: () => sent });
    const throwing = { ...v.io, deposits: () => Promise.reject(new TypeError("network")) };
    expect(await postThroughRelay(throwing, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(v.elapsed()).toBe(WAIT);
  });

  test("the L1 head's time counts toward the deadlines", async () => {
    // A deposit far from landing, on an L1 whose time is past c_P.
    const w = world({ relay: () => sent, landed: () => [700n], l1Ahead: 200_000n });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(w.elapsed()).toBeLessThanOrEqual(POSTING_FORCE_AFTER + POSTING_SEEN + POLL);
  });

  test("the L1 read is given up at c_P", async () => {
    // Sent at the send cutoff, so the L1 read starts 1,800 seconds before c_P.
    const start = CUTOFF - POSTING_SEND_MARGIN;
    const w = world({ relay: () => sent, start });
    const slow = {
      ...w.io,
      deposits: async (_: bigint, stop: () => boolean): Promise<LoadedDeposits> => {
        while (!stop()) await w.io.sleep(29_000);
        return { ok: false, problem: "unreachable" };
      },
    };
    expect(await postThroughRelay(slow, [POSTING], CUTOFF, F, LATE)).toBe("relayed");
    expect(start + w.elapsed()).toBeGreaterThan(CUTOFF - POSTING_CLIENT_MARGIN);
    expect(start + w.elapsed()).toBeLessThanOrEqual(CUTOFF - POSTING_CLIENT_MARGIN + 29n);
  });

  test("never recorded unless the finalized head carried every posting, and every run ends by its deadline", async () => {
    const answer = fc.constantFrom<RelayAnswer>(
      sent,
      { kind: "busy" },
      { kind: "unreachable" },
      { kind: "refused", code: "too-late" },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(answer, { minLength: 1, maxLength: 80 }),
        fc.option(fc.bigInt({ min: 0n, max: 4_000n })),
        fc.option(fc.bigInt({ min: 0n, max: 4_000n })),
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.option(fc.bigInt({ min: -60_000n, max: 4_000n })),
        async (answers, finalAt, seenAt, before, depositAt) => {
          const start = CUTOFF - POSTING_CLIENT_MARGIN - before;
          const w = world({
            relay: (_, call) => answers[Math.min(call, answers.length - 1)] as RelayAnswer,
            finalized: (t) => (finalAt !== null && t >= finalAt ? [POSTING] : []),
            latest: (t) => (seenAt !== null && t >= seenAt ? [POSTING] : []),
            landed: () => [depositAt ?? undefined],
            start,
          });
          const result = await postThroughRelay(w.io, [POSTING], CUTOFF, F, LATE);
          if (result === "recorded") expect(finalAt !== null && w.elapsed() >= finalAt).toBe(true);
          // A posting that ends unrecorded after the relay answered is never called unsent.
          if (w.sends.length > 0 && result !== "recorded") expect(result).toBe("relayed");
          // Ends within one round of c_P, and never sends past the send
          // cutoff; a late run, started past it, within one round of c_E and
          // never sending past it.
          const late = start > CUTOFF - POSTING_SEND_MARGIN;
          const deadline = late ? LAST : CUTOFF - POSTING_CLIENT_MARGIN;
          expect(start + w.elapsed()).toBeLessThanOrEqual(deadline + POLL);
          for (const s of w.sends)
            expect(s.at).toBeLessThanOrEqual(late ? LAST : CUTOFF - POSTING_SEND_MARGIN);
        },
      ),
      { numRuns },
    );
  });
});

describe("waitForRecord", () => {
  // The send cutoff `c_S`, an hour ahead of the wait's start.
  const START = 1_800_000_000n;
  const SEND = START + 3_600n;
  const POLL = BigInt(POSTING_POLL_MS / 1000);
  const SECOND = Uint8Array.of(0, 13, 1, 0xee);
  const OTHER_RECORD = Uint8Array.of(0, 13, 1, 0xaa, 0xbc);

  /**
   * A page and a board on a clock that moves only by the wait's sleeps:
   * `postings` says, at each time (seconds from `start`), which records the
   * page makes (`undefined` once the cast is gone), and `finalized` which
   * the finalized head carries from each block on; each block is a second.
   */
  function world({
    postings = () => [POSTING],
    finalized = () => [],
    chainAhead = 0n,
    start = START,
    readFails = false,
    endAt,
  }: {
    postings?: (t: bigint) => readonly Uint8Array[] | undefined;
    finalized?: (t: bigint) => readonly { readonly at: bigint; readonly record: Uint8Array }[];
    chainAhead?: bigint;
    start?: bigint;
    readFails?: boolean;
    /** When, in seconds from `start`, the page gives the wait up. */
    endAt?: bigint;
  }) {
    let ms = Number(start) * 1000;
    const t = () => BigInt(Math.floor(ms / 1000));
    const made: Uint8Array[] = [];
    const reads: { from: bigint | undefined; at: bigint }[] = [];
    const io: RecordWaitIo = {
      postings() {
        const records = postings(t() - start)?.map((p) => p.slice());
        if (records !== undefined) made.push(...records);
        return Promise.resolve(records);
      },
      find(_, from): Promise<LoadedPostings> {
        reads.push({ from, at: t() });
        if (readFails) return Promise.resolve({ ok: false, problem: "unreachable" });
        // Only the events from block `from` on: a record read once stays read.
        const low = from === undefined ? 0n : from - start;
        const records = finalized(t() - start)
          .filter(({ at }) => at >= low && at <= t() - start)
          .map(({ record }) => record);
        return Promise.resolve({ ok: true, block: t(), timestamp: t() + chainAhead, records });
      },
      now: () => ms,
      sleep(wait) {
        ms += wait;
        return Promise.resolve();
      },
      ended: () => endAt !== undefined && t() - start >= endAt,
    };
    return { io, made, reads, elapsed: () => t() - start };
  }

  const on = (at: bigint, record = POSTING) => ({ at, record });

  test("recorded once the finalized head carries every posting's exact bytes, read at a run's cadence", async () => {
    const w = world({
      postings: () => [POSTING, SECOND],
      finalized: () => [on(300n), on(900n, SECOND)],
    });
    expect(await waitForRecord(w.io, SEND)).toBe("recorded");
    // Read first a round after the run's own last read, then once a round.
    expect(w.reads.map(({ at }) => at - START)).toEqual(
      Array.from({ length: Number(900n / POLL) }, (_, i) => BigInt(i + 1) * POLL),
    );
    // Each read from where the last one ended, the earlier record still counted.
    for (const [i, { from }] of w.reads.entries())
      expect(from).toBe(i === 0 ? undefined : START + BigInt(i) * POLL + 1n);
  });

  test("never recorded on other bytes for the ballot, nor on a record of only some seats", async () => {
    const other = world({ finalized: () => [on(0n, OTHER_RECORD)] });
    expect(await waitForRecord(other.io, SEND)).toBe("lapsed");
    const some = world({ postings: () => [POSTING, SECOND], finalized: () => [on(0n)] });
    expect(await waitForRecord(some.io, SEND)).toBe("lapsed");
  });

  test("a seat receipted since is no longer waited for, and none left sends the ballot at once", async () => {
    // Seat two receipted in another tab after ten minutes; only the first is posted.
    const w = world({
      postings: (t) => (t >= 600n ? [POSTING] : [POSTING, SECOND]),
      finalized: () => [on(60n)],
    });
    expect(await waitForRecord(w.io, SEND)).toBe("recorded");
    expect(w.elapsed()).toBe(600n);
    // Every seat receipted: no read at all.
    const none = world({ postings: () => [] });
    expect(await waitForRecord(none.io, SEND)).toBe("recorded");
    expect(none.reads).toHaveLength(0);
  });

  test("a cast declined or erased since ends the wait (gone)", async () => {
    const w = world({ postings: (t) => (t >= 300n ? undefined : [POSTING]) });
    expect(await waitForRecord(w.io, SEND)).toBe("gone");
    expect(w.elapsed()).toBe(300n);
  });

  test("lapses at c_S by this device's clock, and a record found past it sends nothing", async () => {
    const w = world({});
    expect(await waitForRecord(w.io, SEND)).toBe("lapsed");
    expect(START + w.elapsed()).toBeGreaterThan(SEND);
    expect(START + w.elapsed()).toBeLessThanOrEqual(SEND + POLL);
    for (const { at } of w.reads) expect(at).toBeLessThanOrEqual(SEND);
    // A head past c_S within WALLET_HOLD_MARGIN of the device's clock counts:
    // the record it carries is too late to send the ballot.
    const late = world({
      finalized: () => [on(0n)],
      chainAhead: WALLET_HOLD_MARGIN,
      start: SEND - WALLET_HOLD_MARGIN + 1n - POLL,
    });
    expect(await waitForRecord(late.io, SEND)).toBe("lapsed");
  });

  test("a head further ahead than WALLET_HOLD_MARGIN can't end the wait (T-25)", async () => {
    const w = world({
      finalized: () => [on(1_200n)],
      chainAhead: WALLET_HOLD_MARGIN + 1n,
      start: SEND - 1_800n,
    });
    expect(await waitForRecord(w.io, SEND)).toBe("recorded");
    expect(w.elapsed()).toBe(1_200n);
  });

  test("a read that fails or throws records nothing, and c_S still ends the wait", async () => {
    const fails = world({ finalized: () => [on(0n)], readFails: true });
    expect(await waitForRecord(fails.io, SEND)).toBe("lapsed");
    const v = world({ finalized: () => [on(0n)] });
    const throwing = { ...v.io, find: () => Promise.reject(new DOMException("t", "TimeoutError")) };
    expect(await waitForRecord(throwing, SEND)).toBe("lapsed");
  });

  test("the page giving the wait up ends it before any further read or record", async () => {
    const w = world({ finalized: () => [on(600n)], endAt: 300n });
    expect(await waitForRecord(w.io, SEND)).toBe("ended");
    expect(w.elapsed()).toBe(300n);
    expect(w.reads.every(({ at }) => at - START < 300n)).toBe(true);
    // Given up while a read is under way: that read's record sends nothing.
    const during = world({ finalized: () => [on(0n)] });
    let reading = false;
    const io = {
      ...during.io,
      find: (...args: Parameters<RecordWaitIo["find"]>) => {
        reading = true;
        return during.io.find(...args);
      },
      ended: () => reading,
    };
    expect(await waitForRecord(io, SEND)).toBe("ended");
  });

  test("every record the page made is zeroed once read for (T-18)", async () => {
    const w = world({ postings: () => [POSTING, SECOND], finalized: () => [on(600n)] });
    expect(await waitForRecord(w.io, SEND)).toBe("lapsed");
    expect(w.made.length).toBeGreaterThan(0);
    for (const record of w.made) expect(record).toEqual(new Uint8Array(record.length));
  });

  test("recorded only once every posting is on the finalized head by c_S, and every wait ends within a round of it", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(fc.bigInt({ min: 0n, max: 5_000n })),
        fc.option(fc.bigInt({ min: 0n, max: 5_000n })),
        fc.option(fc.bigInt({ min: 0n, max: 5_000n })),
        fc.bigInt({ min: 0n, max: 2_000n }),
        async (firstAt, secondAt, goneAt, ahead) => {
          const w = world({
            postings: (t) => (goneAt !== null && t >= goneAt ? undefined : [POSTING, SECOND]),
            finalized: () => [
              ...(firstAt === null ? [] : [on(firstAt)]),
              ...(secondAt === null ? [] : [on(secondAt, SECOND)]),
            ],
            chainAhead: ahead,
          });
          const result: RecordWait = await waitForRecord(w.io, SEND);
          const end = START + w.elapsed();
          if (result === "recorded") {
            expect(firstAt !== null && firstAt <= w.elapsed()).toBe(true);
            expect(secondAt !== null && secondAt <= w.elapsed()).toBe(true);
            expect(end).toBeLessThanOrEqual(SEND);
            if (ahead <= WALLET_HOLD_MARGIN) expect(end + ahead).toBeLessThanOrEqual(SEND);
          }
          if (result === "gone") expect(goneAt !== null && goneAt <= w.elapsed()).toBe(true);
          expect(end).toBeLessThanOrEqual(SEND + POLL);
          for (const record of w.made) expect(record).toEqual(new Uint8Array(record.length));
        },
      ),
      { numRuns },
    );
  });
});

describe("postingTopics", () => {
  // docs/spec/vectors/delivery.json's posting, from an independent generator.
  const vectors = JSON.parse(
    readFileSync(new URL("../../../docs/spec/vectors/delivery.json", import.meta.url), "utf8"),
  ) as { readonly records: readonly { readonly id: string; readonly encoding: string }[] };
  const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
  const posting = hex(vectors.records.find((r) => r.id === "posting")?.encoding ?? "");

  test("names the ballot's definition and ballot hash, the record's bytes 3 to 67", () => {
    expect(postingTopics([posting, posting])).toEqual({
      definitionHash: posting.slice(3, 35),
      ballotHash: posting.slice(35, 67),
    });
  });

  test("refuses no posting, postings of two ballots, and bytes that aren't a posting", () => {
    expect(() => postingTopics([])).toThrow(RangeError);
    const other = posting.slice();
    other[40] = (other[40] as number) ^ 1;
    expect(() => postingTopics([posting, other])).toThrow(RangeError);
    expect(() => postingTopics([posting.subarray(1)])).toThrow();
  });
});

describe("postingCalldata", () => {
  test("is submitPosting's selector, both offsets, and each record's length and padded bytes", () => {
    const selector = Buffer.from(
      keccak_256(new TextEncoder().encode("submitPosting(bytes,bytes)")),
    ).subarray(0, 4);
    const word = (n: number) => n.toString(16).padStart(64, "0");
    expect(Buffer.from(postingCalldata(POSTING, BALLOT)).toString("hex")).toBe(
      selector.toString("hex") +
        word(0x40) +
        word(0x80) +
        word(5) +
        "000d01aabb".padEnd(64, "0") +
        word(4) +
        "000203cc".padEnd(64, "0"),
    );
  });

  test("a record of whole words takes no padding, and the length is the ABI's", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), fc.uint8Array({ maxLength: 200 }), (p, b) => {
        const call = postingCalldata(p, b);
        const padded = (n: number) => Math.ceil(n / 32) * 32;
        expect(call.length).toBe(132 + padded(p.length) + padded(b.length));
        const view = new DataView(call.buffer);
        const second = view.getUint32(4 + 60);
        expect(second).toBe(96 + padded(p.length));
        expect(call.subarray(100, 100 + p.length)).toEqual(p);
        expect(view.getUint32(4 + second + 28)).toBe(b.length);
        expect(call.subarray(4 + second + 32, 4 + second + 32 + b.length)).toEqual(b);
      }),
      { numRuns },
    );
  });
});
