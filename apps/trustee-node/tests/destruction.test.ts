// Destruction (P2-13 part 5c-1; docs/spec/tally.md, Destruction): the seat
// removes every ballot's shares and the approved run's KEM and signing
// secrets behind a write-once record, signs its statement once with the
// signing key as that key's last use, and hands out no secret of the
// election again; the duty destroys at the earlier of every cell's anchored
// passing opening and finalized L1 reaching `t_D`, never by the node's clock.
import { checkDestruction, decodeDestructionStatement } from "@abolishus/crypto";
import { RpcError } from "@abolishus/node";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import type { CeremonySeat } from "../src/ceremony.ts";
import { DestructionDuty, destructionDuties } from "../src/destruction.ts";
import { type DestructionEvent, tallyDeadline } from "../src/duties.ts";
import { type PublishedCells, PublishedReads } from "../src/opening-sender.ts";
import { MemoryStore, type SeatStore } from "../src/store.ts";
import { election, runCeremony, value } from "./fixture.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const BALLOTS = ["aa".repeat(32), "bb".repeat(32)];

/** Seat 1 of a 3-of-4 panel that approved its stub over `store`, with two ballots taken in and an opening signed. */
async function approved(store: SeatStore = new MemoryStore()) {
  const e = election(4, 3, { stores: [store] });
  const run = await runCeremony(e);
  for (const seat of e.seats) value(await seat.approve(e.stubBytes, run.transcript));
  const seat = e.seats[0] as CeremonySeat;
  const stub = hex(e.stubHash);
  // Stand-ins for intake's records and the tally's opening: destruction
  // reads only their names.
  for (const ballot of BALLOTS) await store.putOnce(`intake/${stub}/${ballot}`, Uint8Array.of(1));
  await store.putOnce(`tally/${stub}/openings/0`, Uint8Array.of(2));
  const signingKey = run.keys.find((k) => k.index === 1)?.signing_key;
  if (signingKey === undefined) expect.fail("seat 1 sent its keys");
  return {
    e,
    run,
    seat,
    store,
    stub,
    secrets: `runs/${stub}/${hex(run.runId)}/secrets`,
    signingKey,
  };
}

/** A store that fails the first write or removal of a key starting with `prefix`, as a crash there would. */
function crashingAt(prefix: string, op: "putOnce" | "remove"): SeatStore & { crashed: boolean } {
  const inner = new MemoryStore();
  const store = {
    crashed: false,
    get: (key: string) => inner.get(key),
    list: (p: string) => inner.list(p),
    putOnce: (key: string, value: Uint8Array) => {
      if (op === "putOnce" && !store.crashed && key.startsWith(prefix)) {
        store.crashed = true;
        return Promise.reject(new Error("crash"));
      }
      return inner.putOnce(key, value);
    },
    remove: (key: string) => {
      if (op === "remove" && !store.crashed && key.startsWith(prefix)) {
        store.crashed = true;
        return Promise.reject(new Error("crash"));
      }
      return inner.remove(key);
    },
  };
  return store;
}

describe("the seat's destruction", () => {
  test("removes every ballot's shares and the run's secrets, and signs a statement the verifier attributes to the seat", async () => {
    const a = await approved();
    expect(await a.store.get(a.secrets)).toBeDefined();
    const statement = await a.seat.destroy(a.e.stubHash);
    if (statement === undefined) expect.fail("the seat approved the stub");
    expect(await a.store.list(`intake/${a.stub}`)).toEqual([]);
    expect(await a.store.get(a.secrets)).toBeUndefined();
    const decoded = decodeDestructionStatement(statement, 1);
    const info = await a.seat.approvedElectionInfo(a.e.stubHash);
    expect(decoded.signer).toBe(1);
    expect(decoded.definition_hash).toEqual(info?.definitionHash);
    const report = checkDestruction(
      {
        definitionHash: info?.definitionHash as Uint8Array,
        registered: a.run.keys.map((k) => ({ index: k.index, signingKey: k.signing_key })),
      },
      [{ segment: 9, payload: statement }],
      { firstPassing: [8], windowSegment: 20 },
      1,
    );
    expect(report.seats.find((s) => s.seat === 1)).toEqual({ seat: 1, code: "destroyed", at: 0 });
    expect(report.unattributed).toEqual([]);
  });

  test("keeps the public records: the approval, the transcript, the election and the signed openings", async () => {
    const a = await approved();
    const before = await a.seat.approvedElectionInfo(a.e.stubHash);
    const transcript = await a.seat.approvedTranscript(a.e.stubHash);
    await a.seat.destroy(a.e.stubHash);
    expect(await a.seat.approvedStubs()).toEqual([a.e.stubHash]);
    expect(await a.seat.approvedElectionInfo(a.e.stubHash)).toEqual(before);
    expect(await a.seat.approvedTranscript(a.e.stubHash)).toEqual(transcript);
    expect(await a.store.get(`tally/${a.stub}/openings/0`)).toEqual(Uint8Array.of(2));
  });

  test("hands out no secret of the election once destruction has begun", async () => {
    const a = await approved();
    expect(await a.seat.destroying(a.e.stubHash)).toBe(false);
    expect(await a.seat.approvedElection(a.e.stubHash)).toBeDefined();
    expect(await a.seat.intakeSecrets(a.e.stubHash)).toBeDefined();
    await a.seat.destroy(a.e.stubHash);
    expect(await a.seat.destroying(a.e.stubHash)).toBe(true);
    expect(await a.seat.approvedElection(a.e.stubHash)).toBeUndefined();
    expect(await a.seat.intakeSecrets(a.e.stubHash)).toBeUndefined();
  });

  test("never signs a second statement: a repeat returns the first one's bytes", async () => {
    const a = await approved();
    const first = await a.seat.destroy(a.e.stubHash);
    expect(await a.seat.destroy(a.e.stubHash)).toEqual(first);
  });

  test("refuses a stub the seat didn't approve, writing nothing", async () => {
    const store = new MemoryStore();
    const e = election(4, 3, { stores: [store] });
    const seat = e.seats[0] as CeremonySeat;
    expect(await seat.destroy(e.stubHash)).toBeUndefined();
    expect(await seat.destroying(e.stubHash)).toBe(false);
    expect(await store.list("destroying")).toEqual([]);
  });

  test("a crash before the statement leaves no secret handed out, and the next call finishes with one statement", async () => {
    const store = crashingAt("destruction/", "putOnce");
    const a = await approved(store);
    await expect(a.seat.destroy(a.e.stubHash)).rejects.toThrow("crash");
    expect(store.crashed).toBe(true);
    // The record that destruction began is durable, and the shares are gone.
    expect(await a.seat.destroying(a.e.stubHash)).toBe(true);
    expect(await a.seat.approvedElection(a.e.stubHash)).toBeUndefined();
    expect(await store.list(`intake/${a.stub}`)).toEqual([]);
    const statement = await a.seat.destroy(a.e.stubHash);
    expect(statement).toBeDefined();
    expect(await store.get(a.secrets)).toBeUndefined();
    expect(await a.seat.destroy(a.e.stubHash)).toEqual(statement);
  });

  test("a crash after the statement, before the secrets go, removes them on the next call with the same statement", async () => {
    const store = crashingAt("runs/", "remove");
    const a = await approved(store);
    await expect(a.seat.destroy(a.e.stubHash)).rejects.toThrow("crash");
    const held = await store.get(`destruction/${a.stub}`);
    expect(held).toBeDefined();
    expect(await store.get(a.secrets)).toBeDefined();
    expect(await a.seat.destroy(a.e.stubHash)).toEqual(held);
    expect(await store.get(a.secrets)).toBeUndefined();
  });
});

describe("the statement held for sending", () => {
  test("is nothing before destruction, and the bytes `destroy` returned once it has finished", async () => {
    const a = await approved();
    expect(await a.seat.destructionStatement(a.e.stubHash)).toBeUndefined();
    const statement = await a.seat.destroy(a.e.stubHash);
    expect(await a.seat.destructionStatement(a.e.stubHash)).toEqual(statement);
  });

  test("is nothing while a crash left the secrets after the statement, until destruction finishes", async () => {
    const store = crashingAt("runs/", "remove");
    const a = await approved(store);
    await expect(a.seat.destroy(a.e.stubHash)).rejects.toThrow("crash");
    expect(await store.get(`destruction/${a.stub}`)).toBeDefined();
    expect(await a.seat.destructionStatement(a.e.stubHash)).toBeUndefined();
    // Reading it never puts back what destruction removes, nor signs.
    expect(await store.get(a.secrets)).toBeDefined();
    const statement = await a.seat.destroy(a.e.stubHash);
    expect(await a.seat.destructionStatement(a.e.stubHash)).toEqual(statement);
  });

  test("is nothing while a crash cut destruction short before the statement", async () => {
    const store = crashingAt("destruction/", "putOnce");
    const a = await approved(store);
    await expect(a.seat.destroy(a.e.stubHash)).rejects.toThrow("crash");
    expect(await a.seat.destroying(a.e.stubHash)).toBe(true);
    expect(await a.seat.destructionStatement(a.e.stubHash)).toBeUndefined();
    expect(await store.list("destruction")).toEqual([]);
  });

  test("is nothing for a stub the seat didn't approve", async () => {
    const e = election(4, 3);
    expect(await (e.seats[0] as CeremonySeat).destructionStatement(e.stubHash)).toBeUndefined();
  });
});

describe("uses of the secrets and destruction", () => {
  test("destruction waits for a use of the secrets already begun, and none begins after it", async () => {
    const a = await approved();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const use = a.seat.withSecrets(a.e.stubHash, async (secrets) => {
      await gate;
      return secrets.signingSecret.length;
    });
    const destroyed = a.seat.destroy(a.e.stubHash);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    // Begun, and waiting: nothing is removed while the use runs.
    expect(await a.seat.destroying(a.e.stubHash)).toBe(true);
    expect(await a.store.get(a.secrets)).toBeDefined();
    expect(await a.store.list(`intake/${a.stub}`)).toHaveLength(BALLOTS.length);
    let ran = false;
    expect(await a.seat.withSecrets(a.e.stubHash, async () => (ran = true))).toBeUndefined();
    expect(ran).toBe(false);
    release();
    expect(await use).toBe(32);
    expect(await destroyed).toBeDefined();
    expect(await a.store.get(a.secrets)).toBeUndefined();
  });

  test("a read of the secrets in flight never puts back the record destruction removed", async () => {
    const inner = new MemoryStore();
    let held: (() => void) | undefined;
    // Holds the first read of a run's secrets until the record is removed.
    const store: SeatStore = {
      get: async (key) => {
        const value = await inner.get(key);
        if (held === undefined && key.endsWith("/secrets") && armed) {
          await new Promise<void>((resolve) => (held = resolve));
        }
        return value;
      },
      putOnce: (key, value) => inner.putOnce(key, value),
      list: (prefix) => inner.list(prefix),
      remove: async (key) => {
        await inner.remove(key);
        if (key.endsWith("/secrets")) held?.();
      },
    };
    let armed = false;
    const a = await approved(store);
    armed = true;
    // The coordinator can ask for any round of the approved run at any time.
    const asked = a.seat.challenges(a.e.stubHash, a.run.runId, a.run.keys);
    const statement = await a.seat.destroy(a.e.stubHash);
    await asked;
    expect(statement).toBeDefined();
    expect(await inner.get(a.secrets)).toBeUndefined();
  });

  test("the deployment's destruction finishes one a crash cut short after the destroying record, however the board and L1 stand", async () => {
    const store = crashingAt("destruction/", "putOnce");
    const a = await approved(store);
    await expect(a.seat.destroy(a.e.stubHash)).rejects.toThrow("crash");
    const events: DestructionEvent[] = [];
    const duties = destructionDuties({
      seat: a.seat,
      published: new PublishedReads(),
      finalizedL1Time: async () => 0n,
      anchorClock: { epoch: 0n, period: 3600n, deadline: 43_200n },
      clock: () => 0n,
      log: (e) => events.push(e),
    });
    await duties.step();
    expect(events).toEqual([
      { event: "destruction", stubHash: a.stub, state: "destroyed", at: "resumed" },
    ]);
    expect(await store.get(a.secrets)).toBeUndefined();
    expect(await store.get(`destruction/${a.stub}`)).toBeDefined();
  });

  test("the deployment's destruction reads t_D from finalized L1, not the node's clock", async () => {
    const a = await approved();
    const clock = { epoch: 0n, period: 3600n, deadline: 43_200n };
    const info = await a.seat.approvedElectionInfo(a.e.stubHash);
    if (info === undefined) expect.fail("approved");
    const tD = tallyDeadline(info, clock);
    let finalized = tD - 1n;
    const duties = destructionDuties({
      seat: a.seat,
      published: new PublishedReads(),
      finalizedL1Time: async () => finalized,
      anchorClock: clock,
      // A node clock long past t_D destroys nothing.
      clock: () => tD + 1_000_000n,
      log: () => undefined,
    });
    await duties.step();
    expect(await a.seat.destroying(a.e.stubHash)).toBe(false);
    finalized = tD;
    await duties.step();
    expect(await a.store.get(a.secrets)).toBeUndefined();
  });
});

const DEADLINE = 5_000n;

/** A duty over a scripted seat, board read and finalized L1 time. */
function duty(world: {
  published: PublishedCells;
  finalized: bigint | Error;
  destroying: boolean;
}) {
  const destroyed: Uint8Array[] = [];
  const seat: Pick<CeremonySeat, "destroy" | "destroying"> = {
    destroying: async () => world.destroying,
    destroy: async (stubHash) => {
      destroyed.push(stubHash);
      world.destroying = true;
      return Uint8Array.of(0x0f);
    },
  };
  let reads = 0;
  const d = new DestructionDuty({
    election: { stubHash: new Uint8Array(32).fill(3) } as never,
    seat,
    published: () => world.published,
    finalizedTime: async () => {
      reads++;
      if (world.finalized instanceof Error) throw world.finalized;
      return world.finalized;
    },
    deadline: DEADLINE,
  });
  return { d, destroyed, reads: () => reads };
}

const none: PublishedCells = { cells: new Set(), complete: false };
const all: PublishedCells = { cells: new Set([0, 1]), complete: true };

describe("the destruction duty", () => {
  test("holds while some cell lacks an anchored passing opening and finalized L1 is before t_D", async () => {
    const world = {
      published: { cells: new Set([0]), complete: false },
      finalized: DEADLINE - 1n,
      destroying: false,
    };
    const { d, destroyed } = duty(world);
    expect(await d.step()).toEqual({ state: "holding", finalized: DEADLINE - 1n });
    expect(destroyed).toEqual([]);
  });

  test("destroys once every cell is published, without reading L1", async () => {
    const world = {
      published: all,
      finalized: new RpcError("down") as bigint | Error,
      destroying: false,
    };
    const { d, destroyed, reads } = duty(world);
    expect(await d.step()).toEqual({ state: "destroyed", at: "published" });
    expect(destroyed).toHaveLength(1);
    expect(reads()).toBe(0);
  });

  test("destroys once finalized L1 shows t_D, at it and not a second before", async () => {
    const world = {
      published: none,
      finalized: (DEADLINE - 1n) as bigint | Error,
      destroying: false,
    };
    const { d, destroyed } = duty(world);
    expect((await d.step()).state).toBe("holding");
    world.finalized = DEADLINE;
    expect(await d.step()).toEqual({ state: "destroyed", at: "deadline" });
    expect(destroyed).toHaveLength(1);
  });

  test("a finalized L1 node that can't answer fails the step, to be retried, destroying nothing", async () => {
    const world = {
      published: none,
      finalized: new RpcError("down") as bigint | Error,
      destroying: false,
    };
    const { d, destroyed } = duty(world);
    await expect(d.step()).rejects.toThrow(RpcError);
    expect(destroyed).toEqual([]);
  });

  test("finishes a destruction begun before, whatever the board or L1 shows", async () => {
    const world = { published: none, finalized: 0n as bigint | Error, destroying: true };
    const { d, destroyed } = duty(world);
    expect(await d.step()).toEqual({ state: "destroyed", at: "resumed" });
    expect(destroyed).toHaveLength(1);
  });

  test("destroys exactly when every cell is published or finalized L1 is at or past t_D", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.bigInt({ min: 0n, max: 2n * DEADLINE }),
        async (complete, finalized) => {
          const world = {
            published: complete ? all : none,
            finalized: finalized as bigint | Error,
            destroying: false,
          };
          const { d, destroyed } = duty(world);
          const status = await d.step();
          const due = complete || finalized >= DEADLINE;
          expect(status.state).toBe(due ? "destroyed" : "holding");
          expect(destroyed).toHaveLength(due ? 1 : 0);
        },
      ),
      { numRuns },
    );
  });
});
