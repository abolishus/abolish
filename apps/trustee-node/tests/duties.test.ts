// The availability duty's schedule (P4-3 part 2c-4b-2b-2): one duty per
// election the seat approved, built once its reader can be set up, stepped
// until it settles, each status and failure reported once, and anything the
// node can't get past ending the loop.
import { L2Error, RpcError } from "@abolishus/node";
import { L1Error } from "@abolishus/verifier";
import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import type { AvailabilityStatus } from "../src/availability.ts";
import type { ApprovedElection } from "../src/ceremony.ts";
import { AvailabilityDuties, type Duty, type DutyEvent } from "../src/duties.ts";
import { L1AnchorError } from "../src/l1.ts";
import { SendError } from "../src/send.ts";
import { MemoryStore } from "../src/store.ts";
import { election, runCeremony, value } from "./fixture.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const DEADLINE = 1_000n;

/** An election approved under `stubHash` `0x<n><n>…`, for a scripted seat. */
const approvedOf = (n: number): ApprovedElection => ({
  index: 1,
  stubHash: new Uint8Array(32).fill(n),
  definitionHash: new Uint8Array(32).fill(0x40 + n),
  electionId: new Uint8Array(32).fill(0x80 + n),
  closesAt: 0n,
  l1InclusionBound: 0n,
  signingSecret: new Uint8Array(32).fill(0xee),
});

type Step = AvailabilityStatus | Error | Promise<AvailabilityStatus> | (() => AvailabilityStatus);

interface Harness {
  readonly duties: AvailabilityDuties;
  readonly events: DutyEvent[];
  /** Elections built, by stub hash, in order. */
  readonly built: string[];
  /** Steps taken, by stub hash, in order. */
  readonly stepped: string[];
  /** Each election's scripted steps; the last repeats. */
  readonly steps: Map<number, Step[]>;
  /** Each election's scripted build failures, taken in order before it builds. */
  readonly buildFailures: Map<number, Error[]>;
  readonly approved: number[];
  wall: bigint;
}

function harness(approved: number[]): Harness {
  const h: Harness = {
    duties: undefined as unknown as AvailabilityDuties,
    events: [],
    built: [],
    stepped: [],
    steps: new Map(),
    buildFailures: new Map(),
    approved,
    wall: 0n,
  };
  const duty = (n: number): Duty => ({
    deadline: DEADLINE,
    step: async () => {
      h.stepped.push(hex(approvedOf(n).stubHash));
      const script = h.steps.get(n) ?? [{ state: "fetching" }];
      const next = (script.length > 1 ? script.shift() : script[0]) as Step;
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : await next;
    },
  });
  (h as { duties: AvailabilityDuties }).duties = new AvailabilityDuties({
    seat: {
      approvedStubs: async () => h.approved.map((n) => approvedOf(n).stubHash),
      approvedElection: async (stubHash) => approvedOf(stubHash[0] as number),
    },
    build: async (e) => {
      const n = e.stubHash[0] as number;
      const failure = h.buildFailures.get(n)?.shift();
      if (failure !== undefined) throw failure;
      h.built.push(hex(e.stubHash));
      return duty(n);
    },
    clock: () => h.wall,
    log: (e) => h.events.push(e),
  });
  return h;
}

const name = (n: number) => hex(approvedOf(n).stubHash);

describe("the availability duties", () => {
  test("build each approved election's duty once and step it every round until its attestation is recorded", async () => {
    const h = harness([1, 2]);
    h.steps.set(1, [
      { state: "waiting", until: 500n },
      { state: "sent", kind: "attestation" },
      { state: "recorded" },
    ]);
    for (let i = 0; i < 5; i++) await h.duties.step();
    expect(h.built).toEqual([name(1), name(2)]);
    // Election 1 stops at `recorded`; election 2 keeps fetching.
    expect(h.stepped.filter((s) => s === name(1))).toHaveLength(3);
    expect(h.stepped.filter((s) => s === name(2))).toHaveLength(5);
    expect(h.events).toEqual([
      { event: "availability", stubHash: name(1), state: "waiting", until: "500" },
      { event: "availability", stubHash: name(2), state: "fetching" },
      { event: "availability", stubHash: name(1), state: "sent", kind: "attestation" },
      { event: "availability", stubHash: name(1), state: "recorded" },
    ]);
  });

  test("take up an election approved after they started", async () => {
    const h = harness([1]);
    await h.duties.step();
    h.approved.push(2);
    await h.duties.step();
    expect(h.built).toEqual([name(1), name(2)]);
  });

  test.each<[string, AvailabilityStatus]>([
    ["unrecorded", { state: "unrecorded", kind: "complaint" }],
    ["foreign-record", { state: "foreign-record", kind: "attestation" }],
  ])("stop at the alarm %s, reported once", async (_, alarm) => {
    const h = harness([1]);
    h.steps.set(1, [alarm]);
    for (let i = 0; i < 3; i++) await h.duties.step();
    expect(h.stepped).toHaveLength(1);
    expect(h.events).toEqual([{ event: "availability", stubHash: name(1), ...alarm }]);
  });

  test("keep stepping past the cutoff until t_A is behind the node, since a stored record still counts by then", async () => {
    const h = harness([1]);
    h.steps.set(1, [{ state: "past-cutoff", complained: true }]);
    h.wall = DEADLINE;
    await h.duties.step();
    await h.duties.step();
    expect(h.stepped).toHaveLength(2);
    h.wall = DEADLINE + 1n;
    await h.duties.step();
    await h.duties.step();
    expect(h.stepped).toHaveLength(3);
  });

  test("retry a node's failures and report each once, until it changes", async () => {
    const h = harness([1]);
    h.buildFailures.set(1, [
      new L2Error("l2-definition-missing"),
      new RpcError("eth_chainId: TimeoutError"),
    ]);
    h.steps.set(1, [
      new L1Error("l1-proof-missing"),
      new L1Error("l1-proof-missing"),
      new SendError("unsent"),
      { state: "sent", kind: "attestation" },
    ]);
    for (let i = 0; i < 7; i++) await h.duties.step();
    expect(h.built).toEqual([name(1)]);
    expect(h.events).toEqual([
      {
        event: "availability-error",
        stubHash: name(1),
        error: "L2Error",
        message: "l2-definition-missing",
      },
      {
        event: "availability-error",
        stubHash: name(1),
        error: "RpcError",
        message: "eth_chainId: TimeoutError",
      },
      {
        event: "availability-error",
        stubHash: name(1),
        error: "L1Error",
        message: "l1-proof-missing",
      },
      { event: "availability-error", stubHash: name(1), error: "SendError", message: "unsent" },
      { event: "availability", stubHash: name(1), state: "sent", kind: "attestation" },
    ]);
  });

  test("give up on an election still not set up once t_A has passed, since nothing it sent could count", async () => {
    const h = harness([1, 2]);
    const failures = Array.from({ length: 4 }, () => new L2Error("l2-definition-missing"));
    h.buildFailures.set(1, failures);
    await h.duties.step();
    h.wall = 10n ** 12n;
    await h.duties.step();
    await h.duties.step();
    expect(h.built).toEqual([name(2)]);
    // Two attempts: one before t_A, retried, and one after it, abandoned.
    expect(failures).toHaveLength(2);
    expect(h.events.filter((e) => e.stubHash === name(1))).toEqual([
      {
        event: "availability-error",
        stubHash: name(1),
        error: "L2Error",
        message: "l2-definition-missing",
      },
      { event: "availability-abandoned", stubHash: name(1) },
    ]);
  });

  test("settle at past-cutoff only by a time the step had passed, so an unrecorded record is still reported", async () => {
    const h = harness([1]);
    h.steps.set(1, [
      () => {
        // t_A passes while the step resends the complaint.
        h.wall = DEADLINE + 1n;
        return { state: "past-cutoff", complained: true };
      },
      { state: "unrecorded", kind: "complaint" },
    ]);
    h.wall = DEADLINE;
    await h.duties.step();
    await h.duties.step();
    await h.duties.step();
    expect(h.stepped).toHaveLength(2);
    expect(h.events.at(-1)).toEqual({
      event: "availability",
      stubHash: name(1),
      state: "unrecorded",
      kind: "complaint",
    });
  });

  test("step the elections side by side: one whose sources hang delays no other's step", async () => {
    const h = harness([1, 2]);
    let release: (s: AvailabilityStatus) => void = () => {};
    const hung = new Promise<AvailabilityStatus>((r) => {
      release = r;
    });
    h.steps.set(1, [hung, { state: "recorded" }]);
    h.steps.set(2, [{ state: "sent", kind: "attestation" }]);
    const stepping = h.duties.step();
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).toEqual([
      { event: "availability", stubHash: name(2), state: "sent", kind: "attestation" },
    ]);
    release({ state: "fetching" });
    await stepping;
    expect(h.events.at(-1)).toEqual({
      event: "availability",
      stubHash: name(1),
      state: "fetching",
    });
  });

  test("give up on an election whose reader refuses it for good, and go on with the others", async () => {
    const h = harness([1, 2]);
    h.buildFailures.set(1, [new L1AnchorError("definition-hash")]);
    for (let i = 0; i < 3; i++) await h.duties.step();
    expect(h.built).toEqual([name(2)]);
    expect(h.events).toEqual([
      {
        event: "availability-error",
        stubHash: name(1),
        error: "L1AnchorError",
        message: "definition-hash",
      },
      { event: "availability", stubHash: name(2), state: "fetching" },
    ]);
  });

  test("end on a failure the node can't get past, as the ceremony's loop does", async () => {
    const h = harness([1]);
    h.steps.set(1, [new Error("a corrupt record")]);
    await expect(h.duties.step()).rejects.toThrow("a corrupt record");
    const run = harness([1]);
    run.steps.set(1, [new RangeError("a bad key")]);
    await expect(run.duties.run(new AbortController().signal, 1)).rejects.toThrow("a bad key");
  });

  test("stop at once when aborted", async () => {
    const h = harness([1]);
    const stop = new AbortController();
    const running = h.duties.run(stop.signal, 60_000);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await running;
    expect(h.stepped).toEqual([name(1)]);
  });

  test("over any statuses and failures, step each election until it settles and never after, reporting only changes", async () => {
    const status = fc.oneof(
      fc.constant<Step>({ state: "fetching" }),
      fc.constant<Step>({ state: "waiting", until: 7n }),
      fc.constant<Step>({ state: "sent", kind: "attestation" }),
      fc.constant<Step>({ state: "complained" }),
      fc.constant<Step>({ state: "past-cutoff", complained: false }),
      fc.constant<Step>({ state: "recorded" }),
      fc.constant<Step>({ state: "unrecorded", kind: "attestation" }),
      fc.constant<Step>(new RpcError("eth_getLogs: status 503")),
      fc.constant<Step>(new SendError("unsent")),
      fc.constant<Step>(new L2Error("l2-creation-missing")),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(status, { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        async (scripts, pastDeadline) => {
          const h = harness(scripts.map((_, i) => i + 1));
          // The harness repeats a script's last step, so pad each with a final
          // fetching step to keep the expected count exact.
          scripts.forEach((s, i) => h.steps.set(i + 1, [...s, { state: "fetching" }]));
          h.wall = pastDeadline ? DEADLINE + 1n : 0n;
          const rounds = 10;
          for (let i = 0; i < rounds; i++) await h.duties.step();
          scripts.forEach((script, i) => {
            const settledAt = script.findIndex(
              (s) =>
                !(s instanceof Error) &&
                !(s instanceof Promise) &&
                typeof s !== "function" &&
                (s.state === "recorded" ||
                  s.state === "unrecorded" ||
                  (s.state === "past-cutoff" && pastDeadline)),
            );
            const expected = settledAt === -1 ? rounds : settledAt + 1;
            expect(h.stepped.filter((s) => s === name(i + 1))).toHaveLength(expected);
          });
          // No two lines in a row for one election are the same.
          for (const n of scripts.keys()) {
            const lines = h.events
              .filter((e) => e.stubHash === name(n + 1))
              .map((e) => JSON.stringify(e));
            lines.forEach((line, j) => expect(line).not.toBe(lines[j - 1]));
          }
        },
      ),
      { numRuns },
    );
  });
});

describe("approvedStubs", () => {
  let e: ReturnType<typeof election>;
  beforeAll(async () => {
    e = election(3, 2, { stores: [0, 1, 2].map(() => new MemoryStore()) });
    const run = await runCeremony(e);
    for (const seat of e.seats.slice(0, 2)) value(await seat.approve(e.stubBytes, run.transcript));
  });

  test("lists the stubs a seat approved, each with its election, and nothing for a seat that approved none", async () => {
    const [first, , third] = e.seats;
    const stubs = await first?.approvedStubs();
    expect(stubs?.map(hex)).toEqual([hex(e.stubHash)]);
    expect(await first?.approvedElection(stubs?.[0] as Uint8Array)).toBeDefined();
    expect(await third?.approvedStubs()).toEqual([]);
  });
});
