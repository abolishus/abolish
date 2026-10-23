// The tally duty (P2-13 part 5a), over an electorate of three whose ballots
// carry real membership proofs, taken in by every seat's own intake: each
// seat sums its shares of the counted set, sends its sums to the others, and
// the seats that hold `k` passing sums sign the cell's opening. Every
// opening is judged by crypto's own checks (`checkOpening`, the signature)
// over the counted ballots, never by the duty.
import {
  aggregateCell,
  aggregateHash,
  ballotHash,
  type BallotRecord,
  checkOpening,
  decodeBallot,
  decodeTallyOpening,
  type ElectionDefinition,
  encodeBallot,
  encodeTallyOpening,
  identityKey,
  type RegisteredKeys,
  sealSummedShares,
  sumShares,
  tallyOpeningStatement,
  tallyRules,
  verifyStatement,
} from "@abolishus/crypto";
import fc from "fast-check";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import type { ApprovedElection, IntakeSecrets } from "../src/ceremony.ts";
import { heldShares } from "../src/intake.ts";
import type { BoardOpening, BoardOpenings } from "../src/openings.ts";
import type { SeatStore } from "../src/store.ts";
import type { SummingPanel, SummingStatus } from "../src/summing.ts";
import {
  type CountedSet,
  type SummedSharePeers,
  TallyDuty,
  type TallyDutyOptions,
  type TallyDutyStatus,
} from "../src/tally.ts";
import { type Cast, cast, type Setup, seatsOf, setup } from "./ballots.ts";
import { AVAILABLE, L2_CHAIN_ID, TRUSTEE_REGISTRY } from "./fixture.ts";

// Each run seals and opens messages over ML-KEM: a tenth of the runs, as the
// whole-ceremony properties take.
const numRuns = Math.max(1, Math.floor(Number(process.env["FC_NUM_RUNS"] ?? 100) / 10));

let s: Setup;
let ballots: Cast[];
let approved: ApprovedElection[];
let secrets: IntakeSecrets[];

beforeAll(async () => {
  s = await setup();
  // Voters 0 and 2 choose option 0, voter 1 option 1.
  ballots = [await cast(s, 0, 0), await cast(s, 1, 1), await cast(s, 2, 0)];
  const seats = seatsOf(s);
  for (const b of ballots)
    for (const [i, seat] of seats.intake.entries()) {
      const taken = await seat.intake(
        s.e.stubBytes,
        s.transcript,
        b.bytes,
        b.ciphertexts[i] as Uint8Array,
      );
      if (!taken.ok) throw new Error(`intake refused an honest ballot: ${taken.code}`);
    }
  approved = [];
  secrets = [];
  for (const seat of s.e.seats) {
    const a = await seat.approvedElection(s.e.stubHash);
    const k = await seat.intakeSecrets(s.e.stubHash);
    if (a === undefined || k === undefined) throw new Error("a seat holds no approval");
    approved.push(a);
    secrets.push(k);
  }
}, 120_000);

const fixed = (cells: readonly (readonly Uint8Array[])[]): CountedSet => ({
  state: "fixed",
  cells,
});
const all = () => fixed([ballots.map((b) => b.bytes)]);

/** A peer channel that hands each message to the recipient's duty, and records what it sent. */
class Wire implements SummedSharePeers {
  duties: TallyDuty[] = [];
  readonly sent: { recipient: number; message: Uint8Array }[] = [];
  /** Seats whose node can't be reached. */
  down = new Set<number>();
  /** Whether messages are delivered, or only recorded. */
  deliver = true;
  async send(recipient: number, message: Uint8Array): Promise<void> {
    if (this.down.has(recipient)) throw new Error("unreachable");
    this.sent.push({ recipient, message });
    if (this.deliver) await (this.duties[recipient - 1] as TallyDuty).receive(message);
  }
}

/**
 * Each seat steps once with nothing delivered, so every duty has fixed its
 * counted set (a message reaching a seat before that is dropped) and none
 * holds another's sums; then delivery starts.
 */
async function prime(wire: Wire): Promise<void> {
  const deliver = wire.deliver;
  wire.deliver = false;
  for (const duty of wire.duties) await duty.step();
  wire.sent.length = 0;
  wire.deliver = deliver;
}

interface Options {
  counted?: (seat: number) => CountedSet;
  stores?: readonly SeatStore[];
  definition?: ElectionDefinition;
  transcript?: Uint8Array;
  change?: (seat: number) => Partial<TallyDutyOptions>;
}

function duties(wire: Wire, o: Options = {}): TallyDuty[] {
  wire.duties = approved.map(
    (election, i) =>
      new TallyDuty({
        panel: s.e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        election,
        secrets: secrets[i] as IntakeSecrets,
        definition: o.definition ?? s.definition,
        transcript: o.transcript ?? s.transcript,
        store: (o.stores ?? s.stores)[i] as SeatStore,
        summing: AVAILABLE,
        counted: async () => (o.counted ?? (() => all()))(i + 1),
        board: async () => ({ state: "unread" }),
        peers: wire,
        ...o.change?.(i + 1),
      }),
  );
  return wire.duties;
}

/** A store over `store` holding no new record and none written before: each test's own tally records. */
const written = new WeakMap<SeatStore, ReadonlyMap<string, Uint8Array>>();
function overlay(store: SeatStore): SeatStore {
  const own = new Map<string, Uint8Array>();
  const over: SeatStore = {
    get: async (key) => own.get(key) ?? (key.startsWith("tally/") ? undefined : store.get(key)),
    putOnce: async (key, value) => {
      const held = own.get(key);
      if (held !== undefined) return { created: false, value: held };
      own.set(key, value);
      return { created: true, value };
    },
    list: async (prefix) => {
      const under = `${prefix}/`;
      const mine = [...own.keys()]
        .filter((k) => k.startsWith(under) && !k.slice(under.length).includes("/"))
        .map((k) => k.slice(under.length));
      const theirs = prefix.startsWith("tally/") ? [] : await store.list(prefix);
      return [...new Set([...mine, ...theirs])].sort();
    },
  };
  written.set(over, own);
  return over;
}
const fresh = () => s.stores.map(overlay);

const vssOf = (bytes: Uint8Array) => decodeBallot(bytes, 1).committed_vote.vss;
const rules = () => tallyRules({ version: 1, value: s.definition });

/** Checks a signed opening as a verifier does: over the counted ballots, attributed to its signer. */
function judge(bytes: Uint8Array, counted: readonly Uint8Array[], signer: number) {
  const o = decodeTallyOpening(bytes, 1);
  const vss = counted.map(vssOf);
  expect(o.definition_hash).toEqual(s.election.definitionHash);
  expect(o.cell).toBe(0);
  expect(o.signer).toBe(signer);
  expect(o.aggregate_hash).toEqual(aggregateHash(aggregateCell(rules(), vss)));
  const key = (s.registered.find((k) => k.index === signer) as RegisteredKeys).signingKey;
  expect(
    verifyStatement(key, "abolish/v1/sig/tally-opening", tallyOpeningStatement(o), o.signature),
  ).toBe(true);
  const checked = checkOpening(rules(), vss, o.opening);
  if (!checked.ok) expect.fail(`the opening fails ${checked.code}`);
  return checked.counts;
}

const states = (statuses: TallyDutyStatus[]) =>
  statuses.map((t) => (t.state === "tallying" ? t.cells.map((c) => c.state) : t.state));

describe("the tally duty", () => {
  test("every seat signs an opening of the counted set that passes the verifier's checks", async () => {
    const wire = new Wire();
    const stores = fresh();
    const d = duties(wire, { stores });
    await prime(wire);
    // Seat 1 holds only its own sums at first; seats 2 and 3 hold seat 1's
    // and their own, which is `k`, so they open and send nothing more.
    const first = [];
    for (const duty of d) first.push(await duty.step());
    expect(first[0]).toEqual({
      state: "tallying",
      cells: [{ state: "combining", held: 1, sent: 2 }],
      board: "unread",
    });
    expect(states(first.slice(1))).toEqual([["opened"], ["opened"]]);
    for (const [i, duty] of d.slice(1).entries()) {
      const opening = (await duty.openings()).get(0) as Uint8Array;
      expect(
        judge(
          opening,
          ballots.map((b) => b.bytes),
          i + 2,
        ),
      ).toEqual([2n, 1n]);
    }
    expect((await d[0]!.openings()).size).toBe(0);
    // Only public values reach the store: each cell's aggregate hash and the
    // signed openings, never a sum or a message (Destruction; T-15).
    for (const store of stores)
      for (const key of written.get(store)!.keys())
        expect(key).toMatch(/^tally\/[0-9a-f]{64}\/(aggregates|openings)\/0$/);
    // Seat 1 sent to each other seat once; the others opened before sending.
    expect(wire.sent.map((m) => m.recipient)).toEqual([2, 3]);
  });

  test("nothing is summed or sent before the counted set is fixed, or ever if the election is unavailable", async () => {
    for (const state of ["waiting", "unavailable"] as const) {
      const wire = new Wire();
      const d = duties(wire, { stores: fresh(), counted: () => ({ state }) });
      for (const duty of d) expect(await duty.step()).toEqual({ state });
      expect(wire.sent).toEqual([]);
      expect((await d[0]!.openings()).size).toBe(0);
    }
  });

  test("the summed-share rule is asked first, with the approved key set's panel, and nothing is read, summed or sent until it allows", async () => {
    const asked: SummingPanel[] = [];
    for (const [status, step] of [
      [{ state: "waiting", on: "l2", until: 1n }, { state: "waiting" }],
      [{ state: "unavailable", failures: [{ point: 2, panel: 1 }] }, { state: "unavailable" }],
      [
        { state: "unheld-roots" },
        {
          state: "refused",
          reason: "an attested root whose leaf object the seat doesn't hold",
        },
      ],
    ] as const) {
      const wire = new Wire();
      let read = 0;
      const d = duties(wire, {
        stores: fresh(),
        counted: () => {
          read++;
          return all();
        },
        change: () => ({
          summing: {
            check: async (panel) => {
              asked.push(panel);
              return status;
            },
          },
        }),
      });
      for (const duty of d) expect(await duty.step()).toEqual(step);
      expect(read).toBe(0);
      expect(wire.sent).toEqual([]);
      expect((await d[0]!.openings()).size).toBe(0);
    }
    // An unavailable election stays so for the seat, whatever the rule later says.
    const wire = new Wire();
    let status: SummingStatus = { state: "unavailable", failures: [{ point: 1, panel: 1 }] };
    const d = duties(wire, {
      stores: fresh(),
      change: () => ({ summing: { check: async () => status } }),
    });
    expect(await d[0]!.step()).toEqual({ state: "unavailable" });
    status = { state: "available" };
    expect(await d[0]!.step()).toEqual({ state: "unavailable" });
    expect(wire.sent).toEqual([]);
    // Waiting is never kept.
    expect((await d[1]!.step()).state).toBe("tallying");
    // k and every registered seat's per-election signing key, from the transcript the seat approved.
    const keys = approved.map((a) => ({
      index: a.index,
      signingKey: identityKey(a.signingSecret),
    }));
    for (const panel of asked) expect(panel).toEqual({ threshold: 2, registered: keys });
  });

  test("a definition or transcript other than the approved one is refused before the rule is asked", async () => {
    const wire = new Wire();
    const d = duties(wire, {
      stores: fresh(),
      transcript: s.transcript.slice(0, -1),
      change: () => ({ summing: { check: async () => expect.fail("asked") } }),
    });
    expect((await d[0]!.step()).state).toBe("refused");
  });

  test("a message that reaches a seat before its counted set is fixed is ignored", async () => {
    const wire = new Wire();
    let ready = false;
    const d = duties(wire, {
      stores: fresh(),
      counted: (seat) => (seat === 2 && !ready ? { state: "waiting" } : all()),
    });
    await d[0]!.step();
    ready = true;
    // Seat 2 dropped seat 1's message, so it holds only its own sums.
    expect(await d[1]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "combining", held: 1, sent: 2 }],
      board: "unread",
    });
  });

  test("the signed opening is written once: a later step or a restarted node never signs another", async () => {
    const wire = new Wire();
    const stores = fresh();
    const d = duties(wire, { stores });
    await prime(wire);
    for (const duty of d) await duty.step();
    const before = await Promise.all(d.map(async (x) => (await x.openings()).get(0)));
    const sent = wire.sent.length;
    // A restart: new duties over the same records, holding no message.
    const again = duties(new Wire(), { stores });
    expect(states(await Promise.all(again.map((x) => x.step())))).toEqual([
      ["combining"],
      ["opened"],
      ["opened"],
    ]);
    expect(await Promise.all(again.map(async (x) => (await x.openings()).get(0)))).toEqual(before);
    expect(wire.sent.length).toBe(sent);
  });

  test("a seat lacking shares of a counted ballot sends nothing but still combines the others' sums", async () => {
    const stores = fresh();
    const missing = ballots[2] as Cast;
    const hidden = Buffer.from(seatHash(missing)).toString("hex");
    // Seat 3's store without its intake record of ballot 3.
    const store = stores[2] as SeatStore;
    stores[2] = {
      ...store,
      get: (key) => (key.endsWith(hidden) ? Promise.resolve(undefined) : store.get(key)),
      putOnce: (key, value) => store.putOnce(key, value),
      list: (prefix) => store.list(prefix),
    };
    const wire = new Wire();
    const d = duties(wire, { stores });
    expect(await d[2]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "missing-shares", missing: 1, held: 0 }],
      board: "unread",
    });
    expect(wire.sent).toEqual([]);
    // Seats 1 and 2 each reach seat 3 alone, so neither opens first.
    wire.down = new Set([2]);
    await d[0]!.step();
    expect(await d[2]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "missing-shares", missing: 1, held: 1 }],
      board: "unread",
    });
    wire.down = new Set([1]);
    await d[1]!.step();
    expect(states([await d[2]!.step()])).toEqual([["opened"]]);
    const opening = (await d[2]!.openings()).get(0) as Uint8Array;
    expect(
      judge(
        opening,
        ballots.map((b) => b.bytes),
        3,
      ),
    ).toEqual([2n, 1n]);
  });

  test("one unreachable seat doesn't hold up the others' messages", async () => {
    const wire = new Wire();
    wire.down.add(2);
    const d = duties(wire, { stores: fresh() });
    await prime(wire);
    expect(await d[0]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "combining", held: 1, sent: 1 }],
      board: "unread",
    });
    expect(states([await d[2]!.step()])).toEqual([["opened"]]);
  });

  test("messages that fail their checks are ignored", async () => {
    const wire = new Wire();
    wire.deliver = false;
    const d = duties(wire, { stores: fresh() });
    await prime(wire);
    await d[0]!.step();
    const toSeat2 = wire.sent.find((m) => m.recipient === 2)!.message;
    const toSeat3 = wire.sent.find((m) => m.recipient === 3)!.message;
    // A flipped byte in the sealed sums, another recipient's message, and
    // sums over a counted set with a ballot left out (another aggregate).
    const flipped = Uint8Array.from(toSeat2);
    flipped[flipped.length - 70]! ^= 1;
    const subset = ballots.slice(0, 2).map((b) => b.bytes);
    const own = await Promise.all(
      ballots
        .slice(0, 2)
        .map(async (b) => (await heldShares(s.stores[0]!, s.e.stubHash, seatHash(b)))!),
    );
    const otherSet = sealSummedShares(
      { definition: s.definition, cell: 0, aggregate: aggregateCell(rules(), subset.map(vssOf)) },
      s.registered,
      { index: 1, signingSecret: approved[0]!.signingSecret },
      2,
      sumShares(rules(), own),
    );
    const signature = Uint8Array.from(toSeat2);
    signature[signature.length - 1]! ^= 1;
    for (const m of [flipped, signature, toSeat3, otherSet, new Uint8Array(10)])
      await d[1]!.receive(m);
    expect(await d[1]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "combining", held: 1, sent: 2 }],
      board: "unread",
    });
    await d[1]!.receive(toSeat2);
    expect(states([await d[1]!.step()])).toEqual([["opened"]]);
  });

  test("a property: whichever messages arrive, a seat opens exactly when it holds k passing sums, and every opening is the same", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), fc.boolean()), { maxLength: 8 }),
        async (schedule) => {
          const wire = new Wire();
          const d = duties(wire, { stores: fresh() });
          await prime(wire);
          const holds = [new Set([1]), new Set([2]), new Set([3])];
          for (const [seat, delivered] of schedule) {
            wire.deliver = delivered;
            const opened = holds[seat]!.size >= 2;
            const status = await d[seat]!.step();
            expect(states([status])).toEqual([[opened ? "opened" : "combining"]]);
            if (!opened && delivered)
              for (const other of [0, 1, 2]) if (other !== seat) holds[other]!.add(seat + 1);
          }
          const openings = (
            await Promise.all(d.map(async (x) => (await x.openings()).get(0)))
          ).flatMap((o) => (o === undefined ? [] : [decodeTallyOpening(o, 1).opening]));
          for (const o of openings) expect(o).toEqual(openings[0]);
        },
      ),
      { numRuns },
    );
  });
});

describe("what the duty refuses to sum over", () => {
  const refused = async (o: Options) => {
    const wire = new Wire();
    const status = await duties(wire, { stores: fresh(), ...o })[0]!.step();
    expect(status.state).toBe("refused");
    expect(wire.sent).toEqual([]);
    return status;
  };
  const withRecord = (b: Cast, change: Partial<BallotRecord>) =>
    encodeBallot({ ...b.record, ...change });

  test("another number of cells than the partition's", async () => {
    await refused({ counted: () => fixed([]) });
    await refused({ counted: () => fixed([[], []]) });
  });

  test("a ballot of another election or cell, or one that doesn't decode", async () => {
    const b = ballots[0] as Cast;
    await refused({
      counted: () => fixed([[withRecord(b, { definition_hash: new Uint8Array(32).fill(9) })]]),
    });
    await refused({ counted: () => fixed([[withRecord(b, { tier: 1 })]]) });
    await refused({ counted: () => fixed([[b.bytes.slice(1)]]) });
  });

  test("a voter counted twice, by the same ballot or another of theirs", async () => {
    const b = ballots[0] as Cast;
    await refused({ counted: () => fixed([[b.bytes, b.bytes]]) });
    const revote = await cast(s, 0, 1);
    await refused({ counted: () => fixed([[b.bytes, ballots[1]!.bytes, revote.bytes]]) });
  }, 60_000);

  test("a ballot of another shape", async () => {
    const b = ballots[0] as Cast;
    const vote = b.record.committed_vote;
    await refused({
      counted: () =>
        fixed([[withRecord(b, { committed_vote: { ...vote, vss: vote.vss.slice(1) } })]]),
    });
  });

  test("a counted set other than the one fixed before, after a restart", async () => {
    const stores = fresh();
    expect(states([await duties(new Wire(), { stores })[0]!.step()])).toEqual([["combining"]]);
    await refused({
      stores,
      counted: () => fixed([ballots.slice(1).map((b) => b.bytes)]),
    });
  });

  test("a definition, transcript or key set other than the approved one", async () => {
    await refused({ definition: { ...s.definition, closes_at: s.definition.closes_at + 1n } });
    await refused({ transcript: Uint8Array.from(s.transcript, (x, i) => (i === 40 ? x ^ 1 : x)) });
    await refused({
      change: () => ({ secrets: { ...secrets[0]!, keySetHash: new Uint8Array(32).fill(1) } }),
    });
    // Seat 2's per-election keys under seat 1's index: not seat 1's registered keys.
    await refused({ change: () => ({ election: { ...approved[1]!, index: 1 } }) });
  });

  test("sums from a store whose shares fail the summed-share check", async () => {
    const stores = fresh();
    const store = stores[0] as SeatStore;
    // The last share's `r` is followed by the tier and the nullifier (33 bytes).
    stores[0] = {
      ...store,
      get: async (key) => {
        const v = await store.get(key);
        if (v === undefined || !key.startsWith("intake/")) return v;
        const out = Uint8Array.from(v);
        // Little-endian: the low byte, so the scalar stays canonical.
        out[out.length - 65]! ^= 1;
        return out;
      },
      putOnce: (key, value) => store.putOnce(key, value),
      list: (prefix) => store.list(prefix),
    };
    const status = await refused({ stores });
    expect(status).toEqual({
      state: "refused",
      reason: "the seat's own sums fail the summed-share check",
    });
  });
});

describe("the board's openings read back", () => {
  /** A board read of these openings, through a checkpoint named by `n`. */
  const read = (n: number, openings: readonly BoardOpening[]): BoardOpenings => ({
    state: "read",
    checkpoint: new Uint8Array(32).fill(n),
    openings,
  });
  /** An opening re-encoded with some of its fields changed: its signature no longer attributes it. */
  const changed = (
    bytes: Uint8Array,
    change: (o: ReturnType<typeof decodeTallyOpening>) => object,
  ) =>
    encodeTallyOpening({
      ...decodeTallyOpening(bytes, 1),
      ...change(decodeTallyOpening(bytes, 1)),
    });

  /** Every seat stepped until seats 2 and 3 have signed their openings; seat 1 holds only its own sums. */
  async function opened(board: { current: BoardOpenings; reads: number }) {
    const wire = new Wire();
    const d = duties(wire, {
      stores: fresh(),
      change: () => ({
        board: async () => {
          board.reads++;
          return board.current;
        },
      }),
    });
    await prime(wire);
    for (const duty of d) await duty.step();
    const openings = [
      (await d[1]!.openings()).get(0) as Uint8Array,
      (await d[2]!.openings()).get(0) as Uint8Array,
    ];
    wire.sent.length = 0;
    return { wire, d, openings };
  }

  test("a cell is published once the anchored board carries a passing opening of it, whoever signed it, and the seat sends nothing more for it", async () => {
    const board = { current: { state: "unread" } as BoardOpenings, reads: 0 };
    const { wire, d, openings } = await opened(board);
    expect(await d[0]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "combining", held: 1, sent: 2 }],
      board: "unread",
    });
    wire.sent.length = 0;
    // Seat 2's opening, on the board in segment 140: seat 1, which signed
    // none, and seat 2 both see the cell published.
    board.current = read(1, [{ payload: openings[0]!, segment: 140 }]);
    for (const duty of [d[0]!, d[1]!])
      expect(await duty.step()).toEqual({
        state: "tallying",
        cells: [{ state: "published", segment: 140 }],
        board: "read",
      });
    expect(wire.sent).toEqual([]);
    // Seat 1 signs nothing for a published cell.
    expect((await d[0]!.openings()).size).toBe(0);
  });

  test("an unattributed opening that passes counts as well", async () => {
    const board = { current: { state: "unread" } as BoardOpenings, reads: 0 };
    const { d, openings } = await opened(board);
    // Signed by no registered seat: a passing opening is correct whoever computed it.
    board.current = read(1, [
      { payload: changed(openings[0]!, () => ({ signer: 9 })), segment: 141 },
    ]);
    expect(states([await d[0]!.step()])).toEqual([["published"]]);
  });

  test("only a passing opening counts, the first in board order giving the segment", async () => {
    const board = { current: { state: "unread" } as BoardOpenings, reads: 0 };
    const { d, openings } = await opened(board);
    const honest = openings[0]!;
    const failing = [
      // Not opening an option.
      changed(honest, (o) => ({
        opening: o.opening.map((x, j) => (j === 0 ? { v: x.v + 1n, r: x.r } : x)),
      })),
      // Over another counted set.
      changed(honest, () => ({ aggregate_hash: new Uint8Array(32).fill(1) })),
      // Another number of entries than options.
      changed(honest, (o) => ({ opening: o.opening.slice(1) })),
      // Another definition: stray.
      changed(honest, () => ({ definition_hash: new Uint8Array(32).fill(2) })),
      // A cell the partition doesn't have: stray.
      changed(honest, () => ({ cell: 1 })),
      // Doesn't decode.
      Uint8Array.of(0x00, 0x06, 0x01, 0xff),
    ].map((payload, i) => ({ payload, segment: 140 + i }));
    board.current = read(1, failing);
    expect(await d[0]!.step()).toMatchObject({ cells: [{ state: "combining" }], board: "read" });
    board.current = read(2, [
      ...failing,
      { payload: openings[1]!, segment: 150 },
      { payload: honest, segment: 151 },
    ]);
    expect(await d[0]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "published", segment: 150 }],
      board: "read",
    });
  });

  test("a published cell stays published whatever a later read says, and the board's failure is reported", async () => {
    const board = { current: { state: "unread" } as BoardOpenings, reads: 0 };
    const { d, openings } = await opened(board);
    board.current = read(1, [{ payload: openings[0]!, segment: 140 }]);
    await d[0]!.step();
    for (const [current, reported] of [
      [{ state: "unread" }, "unread"],
      [{ state: "board-failed", code: "checkpoint-equivocation" }, "checkpoint-equivocation"],
      [read(2, []), "read"],
    ] as const) {
      board.current = current;
      expect(await d[0]!.step()).toEqual({
        state: "tallying",
        cells: [{ state: "published", segment: 140 }],
        board: reported,
      });
    }
  });

  test("a failed board publishes nothing, even with a passing opening read before", async () => {
    const board = {
      current: { state: "board-failed", code: "wrong-index" } as BoardOpenings,
      reads: 0,
    };
    const { d } = await opened(board);
    expect(await d[1]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "opened" }],
      board: "wrong-index",
    });
  });

  test("the board is read only once the counted set is fixed", async () => {
    const board = { current: { state: "unread" } as BoardOpenings, reads: 0 };
    let counted: CountedSet = { state: "waiting" };
    const wire = new Wire();
    const d = duties(wire, {
      stores: fresh(),
      counted: () => counted,
      change: () => ({
        board: async () => {
          board.reads++;
          return board.current;
        },
      }),
    });
    expect(await d[0]!.step()).toEqual({ state: "waiting" });
    expect(board.reads).toBe(0);
    counted = all();
    await d[0]!.step();
    expect(board.reads).toBe(1);
  });
});

/** The ballot hash a seat stores a ballot's intake under. */
function seatHash(b: Cast): Uint8Array {
  const r = b.record;
  return ballotHash(
    { definitionHash: s.election.definitionHash, tier: r.tier, nullifier: r.nullifier },
    r.committed_vote,
  );
}
