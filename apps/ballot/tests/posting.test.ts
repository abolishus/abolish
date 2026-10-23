// A posting through the operator's relay (src/posting.ts;
// docs/spec/posting-relay.md, Request, Answers and Outcome): the request
// carries the two records and no credential, every answer outside the
// route's forms is unreachable, and the client stands down only on the
// board's event at the finalized head, falling back at the relay's
// patience, its send cutoff, a sent posting's wait, and the client's
// deadline `c_P` (T-10, T-25, T-50, T-52).

import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { STAGING } from "../src/deployment.ts";
import type { Fetch, LoadedPostings } from "../src/load.ts";
import {
  POSTING_CLIENT_MARGIN,
  POSTING_FORCE_AFTER,
  POSTING_PATIENCE,
  POSTING_POLL_MS,
  POSTING_SEEN,
  POSTING_SEND_MARGIN,
  type PostingIo,
  postThroughRelay,
  type RelayAnswer,
  sendPosting,
} from "../src/posting.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const POSTING = Uint8Array.of(0, 13, 1, 0xaa, 0xbb);
const BALLOT = Uint8Array.of(0, 2, 3, 0xcc);
const TX = "ab".repeat(32);

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
});

describe("postThroughRelay", () => {
  // The poll's `c_D`, far enough ahead that only the relay's own waits end a run.
  const START = 1_800_000_000n;
  const CUTOFF = START + 100_000n;
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
  }: {
    relay: (posting: Uint8Array, call: number) => RelayAnswer;
    finalized?: (t: bigint) => readonly Uint8Array[];
    latest?: (t: bigint) => readonly Uint8Array[];
    chainAhead?: bigint;
    start?: bigint;
    readFails?: boolean;
  }) {
    let ms = Number(start) * 1000;
    const sends: { posting: Uint8Array; at: bigint }[] = [];
    const reads: { head: string; from: bigint | undefined }[] = [];
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
      now: () => ms,
      sleep(wait) {
        ms += wait;
        return Promise.resolve();
      },
    };
    return { io, sends, reads, elapsed: () => t() - start };
  }

  const sent: RelayAnswer = { kind: "sent", transaction: new Uint8Array(32), layer: "l2" };
  const POLL = BigInt(POSTING_POLL_MS / 1000);

  test("recorded once the finalized head carries every posting's exact bytes, each sent once", async () => {
    const w = world({
      relay: () => sent,
      finalized: (t) => (t >= 900n ? [OTHER, POSTING] : t >= 300n ? [POSTING] : []),
    });
    expect(await postThroughRelay(w.io, [POSTING, OTHER], CUTOFF)).toBe("recorded");
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
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF)).toBe("recorded");
    expect(w.sends).toHaveLength(0);
  });

  test("a refusal falls back at once", async () => {
    const w = world({
      relay: (_, call) => (call < 2 ? { kind: "busy" } : { kind: "refused", code: "ballot-cap" }),
    });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF)).toBe("refused");
    expect(w.sends).toHaveLength(3);
  });

  test("busy or unreachable is sent again each round, until the relay's patience runs out", async () => {
    for (const answer of [{ kind: "busy" }, { kind: "unreachable" }] as const) {
      const w = world({ relay: () => answer });
      expect(await postThroughRelay(w.io, [POSTING], CUTOFF)).toBe("unreachable");
      expect(w.sends.every((s) => s.at - START < POSTING_PATIENCE)).toBe(true);
      expect(w.sends).toHaveLength(Number(POSTING_PATIENCE / POLL));
      expect(w.elapsed()).toBe(POSTING_PATIENCE);
    }
  });

  test("nothing is sent past the relay's send cutoff", async () => {
    const start = CUTOFF - POSTING_SEND_MARGIN + 1n;
    const w = world({ relay: () => sent, start });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF)).toBe("unreachable");
    expect(w.sends).toHaveLength(0);
  });

  test("a sent posting the latest head never shows falls back once its wait is over", async () => {
    const w = world({ relay: () => sent });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF)).toBe("unreachable");
    expect(w.sends).toHaveLength(1);
    expect(w.elapsed()).toBe(POSTING_FORCE_AFTER + POSTING_SEEN);
    // The latest head is read only once the wait is over.
    expect(w.reads.filter((r) => r.head === "latest")).toHaveLength(1);
  });

  test("a sighting at the latest head keeps the client waiting, never past c_P", async () => {
    const start = CUTOFF - POSTING_CLIENT_MARGIN - 3_000n;
    const w = world({ relay: () => sent, latest: () => [POSTING], start });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF)).toBe("unreachable");
    // It stops at the first round past c_P.
    expect(start + w.elapsed()).toBeGreaterThan(CUTOFF - POSTING_CLIENT_MARGIN);
    expect(start + w.elapsed() - POLL).toBeLessThanOrEqual(CUTOFF - POSTING_CLIENT_MARGIN);
    // And a posting finalized while it waits is recorded.
    const v = world({
      relay: () => sent,
      latest: () => [POSTING],
      finalized: (t) => (t >= 2_400n ? [POSTING] : []),
    });
    expect(await postThroughRelay(v.io, [POSTING], CUTOFF)).toBe("recorded");
    expect(v.elapsed()).toBe(2_400n);
  });

  test("the finalized head's time counts toward the deadlines, as the device's clock does", async () => {
    const w = world({ relay: () => sent, chainAhead: 200_000n });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF)).toBe("unreachable");
    expect(w.sends).toHaveLength(0);
  });

  test("an RPC that can't be read records nothing, and the deadlines still end the run", async () => {
    const w = world({ relay: () => sent, readFails: true });
    expect(await postThroughRelay(w.io, [POSTING], CUTOFF)).toBe("unreachable");
    expect(w.elapsed()).toBe(POSTING_FORCE_AFTER + POSTING_SEEN);
  });

  test("never recorded unless the finalized head carried every posting, and every run ends by c_P", async () => {
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
        async (answers, finalAt, seenAt, before) => {
          const start = CUTOFF - POSTING_CLIENT_MARGIN - before;
          const w = world({
            relay: (_, call) => answers[Math.min(call, answers.length - 1)] as RelayAnswer,
            finalized: (t) => (finalAt !== null && t >= finalAt ? [POSTING] : []),
            latest: (t) => (seenAt !== null && t >= seenAt ? [POSTING] : []),
            start,
          });
          const result = await postThroughRelay(w.io, [POSTING], CUTOFF);
          if (result === "recorded") expect(finalAt !== null && w.elapsed() >= finalAt).toBe(true);
          // Ends within one round of c_P, and never sends past the send cutoff.
          expect(start + w.elapsed()).toBeLessThanOrEqual(CUTOFF - POSTING_CLIENT_MARGIN + POLL);
          for (const s of w.sends) expect(s.at).toBeLessThanOrEqual(CUTOFF - POSTING_SEND_MARGIN);
        },
      ),
      { numRuns },
    );
  });
});
