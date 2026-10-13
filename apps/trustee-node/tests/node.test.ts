import {
  decodeCeremonyTranscript,
  encodeCeremonyTranscript,
  encodeElectionDefinition,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  CeremonySeat,
  type Coordinator,
  type NodeEvent,
  type SeatStore,
  TransportError,
  TrusteeNode,
} from "../src/index.ts";
import { LocalCoordinator, type LocalOutcome } from "../src/local.ts";
import { MemoryStore } from "../src/store.ts";
import type { ApprovalPost, CeremonyRequest, MessagePost } from "../src/wire.ts";
import { L2_CHAIN_ID, panelOf, stubFor, TRUSTEE_REGISTRY } from "./fixture.ts";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
// A whole ceremony per run, as ceremony.test.ts scales its properties.
const CEREMONY_RUNS = Math.max(10, Math.ceil(NUM_RUNS / 10));

interface Local {
  readonly coordinator: LocalCoordinator;
  readonly stores: SeatStore[];
  readonly seat: (index: number, electorate?: () => Promise<boolean>) => CeremonySeat;
  readonly clock: { now: number };
  readonly stub: Uint8Array;
}

function local(n: number, k: number, roundMs = 1000): Local {
  const { panel, secrets } = panelOf(n, k);
  const stub = encodeElectionDefinition(stubFor(panel));
  const clock = { now: 0 };
  const coordinator = new LocalCoordinator({
    stub,
    panel,
    l2ChainId: L2_CHAIN_ID,
    trusteeRegistry: TRUSTEE_REGISTRY,
    roundMs,
    now: () => clock.now,
  });
  const stores = secrets.map(() => new MemoryStore() as SeatStore);
  const seat = (index: number, electorate = () => Promise.resolve(true)) =>
    new CeremonySeat({
      panel,
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      index,
      identitySecret: secrets[index - 1] as Uint8Array,
      electorate,
      store: stores[index - 1] as SeatStore,
    });
  return { coordinator, stores, seat, clock, stub };
}

function node(
  l: Local,
  index: number,
  coordinator: Coordinator = l.coordinator,
  log: NodeEvent[] = [],
) {
  return new TrusteeNode({ seat: l.seat(index), index, coordinator, log: (e) => log.push(e) });
}

/**
 * Polls every node in turn until the coordinator's outcome is in, at most
 * `polls` times each, moving the clock on `advance` after each sweep.
 */
async function drive(
  l: Local,
  nodes: readonly TrusteeNode[],
  polls = 12,
  advance = 0,
): Promise<LocalOutcome> {
  for (let i = 0; i < polls; i++) {
    for (const n of nodes) await n.poll();
    l.clock.now += advance;
    const outcome = l.coordinator.outcome();
    if (outcome !== undefined) return outcome;
  }
  expect.fail("the ceremony didn't finish");
}

/**
 * A coordinator whose transport fails as `faults` says: a post lost before
 * it arrives, or after (its response lost), and polls that fail.
 */
class Flaky implements Coordinator {
  readonly #inner: Coordinator;
  readonly #faults: () => "none" | "before" | "after";
  constructor(inner: Coordinator, faults: () => "none" | "before" | "after") {
    this.#inner = inner;
    this.#faults = faults;
  }
  async requests(seat: number): Promise<readonly CeremonyRequest[]> {
    if (this.#faults() !== "none") throw new TransportError("poll lost");
    return this.#inner.requests(seat);
  }
  postMessage(seat: number, post: MessagePost) {
    return this.#post(() => this.#inner.postMessage(seat, post));
  }
  postApproval(seat: number, post: ApprovalPost) {
    return this.#post(() => this.#inner.postApproval(seat, post));
  }
  async #post(send: () => Promise<void>) {
    const fault = this.#faults();
    if (fault === "before") throw new TransportError("post lost");
    // A seat's repeat is refused by the coordinator; to the node that's a failed post.
    try {
      await send();
    } catch {
      throw new TransportError("refused");
    }
    if (fault === "after") throw new TransportError("response lost");
  }
}

describe("nodes and a coordinator", () => {
  test("an honest ceremony registers every seat, and every seat's approval verifies", async () => {
    const l = local(4, 2);
    const outcome = await drive(
      l,
      [1, 2, 3, 4].map((i) => node(l, i)),
    );
    if (!outcome.check.ok) expect.fail(outcome.check.code);
    expect(outcome.check.registered.map((r) => r.index)).toEqual([1, 2, 3, 4]);
    expect([...outcome.approvals.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  test("lost polls, lost posts and lost responses end in the same ceremony: a node only ever resends what its seat recorded", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("none", "before", "after"), { maxLength: 64 }),
        async (script) => {
          const l = local(3, 2);
          let at = 0;
          // Each call takes the script's next fault, and none once it runs out.
          const faults = () => script[at++] ?? "none";
          const logs: NodeEvent[][] = [[], [], []];
          const nodes = [1, 2, 3].map((i) =>
            node(l, i, new Flaky(l.coordinator, faults), logs[i - 1]),
          );
          // Enough polls for every round once the script's faults are spent.
          const outcome = await drive(l, nodes, 6 + script.length);
          if (!outcome.check.ok) expect.fail(outcome.check.code);
          expect(outcome.check.registered.map((r) => r.index)).toEqual([1, 2, 3]);
          expect(outcome.approvals.size).toBe(3);
          // Never a refusal: every retry was one the seat answers with its record.
          expect(logs.flat().filter((e) => e.event === "refused")).toEqual([]);
        },
      ),
      { numRuns: CEREMONY_RUNS },
    );
  }, 600_000);

  test("a node restarted over its store resends its recorded message and never begins the run again", async () => {
    const l = local(3, 2);
    const nodes = [1, 2, 3].map((i) => node(l, i));
    // Round 1 from seats 1 and 2 only; seat 3 runs round 1, then restarts.
    await nodes[0]?.poll();
    await nodes[1]?.poll();
    const [request] = await l.coordinator.requests(3);
    if (request === undefined) expect.fail("no request");
    const first = await l
      .seat(3)
      .keys(request.stub, decodeCeremonyTranscript(request.transcript, 1).run_id);
    const restarted = node(l, 3);
    await restarted.poll();
    const outcome = await drive(l, [nodes[0], nodes[1], restarted] as TrusteeNode[]);
    if (!outcome.check.ok) expect.fail(outcome.check.code);
    const sent = decodeCeremonyTranscript(outcome.transcript, 1).keys.find((m) => m.index === 3);
    expect(first.ok && sent).toEqual(first.ok && first.value);
  });

  test("a seat the coordinator withholds from round 2 refuses to approve, and the ceremony goes on without it", async () => {
    const l = local(4, 2);
    const log: NodeEvent[] = [];
    const nodes = [1, 2, 3].map((i) => node(l, i));
    const four = node(l, 4, l.coordinator, log);
    // Seat 4 sends round 1 and then misses round 2's deadline.
    for (const n of [...nodes, four]) await n.poll();
    for (const n of nodes) await n.poll();
    l.clock.now += 2000;
    const outcome = await drive(l, [...nodes, four], 12, 2000);
    if (!outcome.check.ok) expect.fail(outcome.check.code);
    expect(outcome.check.registered.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(outcome.approvals.has(4)).toBe(false);
    expect(log.some((e) => e.event === "refused" && e.round !== 1)).toBe(true);
  });

  test("a request the transport can't read is refused once and not acted on again", async () => {
    const log: NodeEvent[] = [];
    const l = local(3, 2);
    let polls = 0;
    const junk: Coordinator = {
      requests: async () => {
        polls++;
        return [{ stub: l.stub, transcript: Uint8Array.of(1, 2, 3) }];
      },
      postMessage: () => expect.fail("posted"),
      postApproval: () => expect.fail("posted"),
    };
    const n = node(l, 1, junk, log);
    await n.poll();
    await n.poll();
    expect(polls).toBe(2);
    expect(log).toEqual([{ event: "refused", round: undefined, code: "request" }]);
  });

  test("a later round over a stub the node never began is refused, and nothing is posted", async () => {
    const log: NodeEvent[] = [];
    const l = local(3, 2);
    const other = local(3, 2);
    const transcript = encodeCeremonyTranscript({
      run_id: new Uint8Array(32),
      keys: await Promise.all(
        [1, 2, 3].map(async (i) => {
          const r = await other.seat(i).keys(other.stub, new Uint8Array(32));
          if (!r.ok) expect.fail(r.code);
          return r.value;
        }),
      ),
      challenges: [],
      answers: [],
      reveals: [],
    });
    const n = node(
      l,
      1,
      {
        requests: async () => [{ stub: l.stub, transcript }],
        postMessage: () => expect.fail("posted"),
        postApproval: () => expect.fail("posted"),
      },
      log,
    );
    await n.poll();
    expect(log).toMatchObject([{ event: "refused", round: 2, code: "no-run" }]);
  });

  test("a stub the electorate check can't confirm yet is asked about again on the next poll", async () => {
    const l = local(3, 2);
    const log: NodeEvent[] = [];
    let final = false;
    const n = new TrusteeNode({
      seat: l.seat(1, () => Promise.resolve(final)),
      index: 1,
      coordinator: l.coordinator,
      log: (e) => log.push(e),
    });
    await n.poll();
    await n.poll();
    final = true;
    await n.poll();
    expect(log.map((e) => (e.event === "refused" ? e.code : e.event))).toEqual([
      "stub-electorate",
      "stub-electorate",
      "sent",
    ]);
  });

  test("a poll that fails is logged and the next one carries on", async () => {
    const l = local(3, 2);
    const log: NodeEvent[] = [];
    let down = true;
    const n = node(
      l,
      1,
      {
        requests: (seat) =>
          down ? Promise.reject(new TransportError("down")) : l.coordinator.requests(seat),
        postMessage: (s, p) => l.coordinator.postMessage(s, p),
        postApproval: (s, p) => l.coordinator.postApproval(s, p),
      },
      log,
    );
    await n.poll();
    down = false;
    await n.poll();
    expect(log.map((e) => e.event)).toEqual(["transport", "sent"]);
  });
});
