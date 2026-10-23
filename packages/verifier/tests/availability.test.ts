import {
  type Anchor,
  AVAILABILITY_POINTS,
  type AvailabilityPoint,
  type Checkpoint,
  checkpointHash,
  DELIVERY_WINDOW,
  encodeAvailabilityAttestation,
  encodeAvailabilityComplaint,
  decodeContractEvent,
  encodeContractEvent,
  identityKey,
  objectCid,
  replayEventAccumulator,
  SEAT_PANELS,
  type SeatPanel,
  signAvailabilityAttestation,
  signAvailabilityComplaint,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  type AvailabilityInputs,
  availabilityChecks,
  PINNED_FORCED_INCLUSION,
  PINNED_MARGIN,
} from "../src/availability.ts";
import type { ArchivedAccumulator } from "../src/evidence.ts";
import { ACCUMULATOR_SLOT } from "../src/output-root.ts";
import { l2State, word } from "./state.ts";

// The availability check (4.6, src/availability.ts; docs/spec/availability.md,
// Availability check) over synthetic inputs: counted checkpoints, a panel
// whose seats' keys are made here, and the board contract's events as
// contract-event records under version 8, ABI-encoded here from
// docs/spec/contracts.md (Board, Events) and proven under an L2 output root
// built by the tests' own trie writer (state.ts). The moments are written
// from the spec's formulas, never through the windows' code (T-24, T-53).

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CLOCK = { epoch: 1_000_000n, period: 3_600n, deadline: 43_200n, lastSegment: 100 };
// In period 10, so `s_A` is 11.
const CLOSES = CLOCK.epoch + 10n * CLOCK.period + 100n;
const BOUND = 600n;
const S_A = 11;
// `t_A = c_I + F = t_D − R`, with `t_D = closes_at + l1_inclusion_bound + DELIVERY_WINDOW`.
const T_A = CLOSES + BOUND + DELIVERY_WINDOW - PINNED_MARGIN;
// `s_A`'s anchoring deadline: the end of its period plus `deadline`.
const S_A_DUE = CLOCK.epoch + BigInt(S_A + 1) * CLOCK.period + CLOCK.deadline;
const L2_CHAIN = 84_532n;

const filled = (n: number, x: number) => new Uint8Array(n).fill(x);
const ELECTION = filled(32, 0xe1);
const DEFINITION = filled(32, 0xd1);
const BOARD = filled(20, 0xb0);
const CONTRACTS = {
  electionRegistry: filled(20, 0xa1),
  trusteeRegistry: filled(20, 0xa2),
  groupRegistry: filled(20, 0xa3),
  board: BOARD,
};

const checkpoint = (segment: number): Checkpoint => ({
  election_id: ELECTION,
  segment,
  size: BigInt(segment + 1),
  head: filled(32, segment + 1),
  root: filled(32, segment + 101),
  object_cid: objectCid(Uint8Array.of(segment)),
  hashes_cid: objectCid(Uint8Array.of(segment, 0)),
});
const anchor = (segment: number): Anchor => ({
  checkpoint: checkpoint(segment),
  anchoredAt: CLOCK.epoch + BigInt(segment + 1) * CLOCK.period + 1n,
});
// Every segment through `s_A` + 2 is anchored; `C_A` is segment 11's.
const ANCHORS = Array.from({ length: S_A + 3 }, (_, s) => anchor(s));
const C_A = checkpointHash(checkpoint(S_A));

const secret = (panel: SeatPanel, seat: number) => filled(32, 16 * panel + seat);
const seats = (panel: SeatPanel, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    signingKey: identityKey(secret(panel, i + 1)),
  }));
const DEFAULT = { panel: SEAT_PANELS.default, threshold: 2, registered: seats(1, 3) };

interface Sent {
  readonly kind: "attestation" | "complaint";
  readonly seat: number;
  readonly at: bigint;
  readonly point?: AvailabilityPoint;
  readonly panel?: SeatPanel;
  readonly checkpoint?: Uint8Array;
  readonly definition?: Uint8Array;
  /** Signed by another seat's key. */
  readonly signer?: number;
}

const signature = (s: string) => keccak_256(utf8ToBytes(s));
const ATTESTED = signature("AvailabilityAttestationSubmitted(bytes32,uint8,bytes)");
const COMPLAINED = signature("AvailabilityComplaintSubmitted(bytes32,uint8,bytes)");

// `abi.encode(bytes)`: the offset, the length and the bytes padded to words.
function abiBytes(b: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
  padded.set(b);
  return Uint8Array.from([...word(32n), ...word(BigInt(b.length)), ...padded]);
}

function recordOf(s: Sent): Uint8Array {
  const panel = s.panel ?? SEAT_PANELS.default;
  const fields = {
    definition_hash: s.definition ?? DEFINITION,
    panel,
    seat: s.seat,
    point: s.point ?? AVAILABILITY_POINTS.ballotExtent,
    checkpoint_hash: s.checkpoint ?? C_A,
  };
  const key = secret(panel, s.signer ?? s.seat);
  return s.kind === "attestation"
    ? encodeAvailabilityAttestation(signAvailabilityAttestation(key, { ...fields, roots: [] }))
    : encodeAvailabilityComplaint(
        signAvailabilityComplaint(key, { ...fields, cid: checkpoint(S_A).object_cid }),
      );
}

/** The board's events, one per L2 block (number = timestamp − T_A + 1,000), proven at `proven`. */
function board(
  sent: readonly Sent[],
  proven: { readonly timestamp: bigint; readonly cut?: number; readonly version?: 8 | 9 },
) {
  const logs = sent.map((s, n) => {
    const payload = recordOf(s);
    return {
      contract: BOARD,
      n: BigInt(n),
      l2_block: s.at - T_A + 100_000n,
      l2_timestamp: s.at,
      topics: [
        s.kind === "attestation" ? ATTESTED : COMPLAINED,
        s.definition ?? DEFINITION,
        word(BigInt(s.seat)),
      ],
      data: abiBytes(payload),
    };
  });
  const block = proven.timestamp - T_A + 100_000n;
  const counted = logs.filter((l) => l.l2_block <= block);
  const { accumulator, count } = replayEventAccumulator(
    L2_CHAIN,
    BOARD,
    counted.map((l) => ({
      block: l.l2_block,
      timestamp: l.l2_timestamp,
      topics: l.topics,
      data: l.data,
    })),
  );
  const state = l2State(
    [
      {
        address: BOARD,
        storage: [
          [word(ACCUMULATOR_SLOT), accumulator],
          [word(ACCUMULATOR_SLOT + 1n), word(count)],
        ],
      },
    ],
    block,
    proven.timestamp,
  );
  const events = logs
    .slice(0, proven.cut ?? logs.length)
    .map((l) => encodeContractEvent(l, proven.version ?? 8));
  return {
    events,
    proof: state.evidence,
    // What the proof shows, as an archived record proving it would.
    archived: (n: number): ArchivedAccumulator => ({
      accumulator: {
        accumulator,
        count,
        block,
        timestamp: proven.timestamp,
        blockHash: filled(32, n),
      },
      gameIndex: BigInt(n),
      game: filled(20, n),
      outputRoot: state.evidence.outputRoot,
      cid: objectCid(Uint8Array.of(n, n)),
      transaction: filled(32, n),
    }),
  };
}

const inputs = (
  sent: readonly Sent[],
  over: Partial<AvailabilityInputs> & { readonly provenAt?: bigint } = {},
): AvailabilityInputs => {
  const { provenAt, ...rest } = over;
  return {
    definitionHash: DEFINITION,
    electionId: ELECTION,
    closesAt: CLOSES,
    l1InclusionBound: BOUND,
    l2ChainId: L2_CHAIN,
    eventVersion: 8,
    contracts: CONTRACTS,
    panels: [DEFAULT],
    anchors: ANCHORS,
    clock: CLOCK,
    now: T_A + 1n,
    l2: board(sent, { timestamp: provenAt ?? T_A + 10n }),
    ...rest,
  };
};

const attest = (seat: number, at = T_A - 100n, over: Partial<Sent> = {}): Sent => ({
  kind: "attestation",
  seat,
  at,
  ...over,
});
const complain = (seat: number, at = T_A - 100n, over: Partial<Sent> = {}): Sent => ({
  kind: "complaint",
  seat,
  at,
  ...over,
});

describe("the ballot extent", { timeout: 120_000 }, () => {
  test("the moments are the spec's: t_A = t_D − R with the pinned F and R", () => {
    // Base's 12-hour forced-inclusion delay and an hour of missed slots, and one hour.
    expect(PINNED_FORCED_INCLUSION).toBe(46_800n);
    expect(PINNED_MARGIN).toBe(3_600n);
    const r = availabilityChecks(inputs([]));
    expect(r.report?.ballotExtent.deadline).toBe(T_A.toString());
    expect(r.report?.ballotExtent.checkpoint).toEqual({
      segment: S_A,
      hash: Buffer.from(C_A).toString("hex"),
    });
  });

  test("a panel holding its threshold leaves 4.6 unverifiable on the counted extent, never a pass", () => {
    const r = availabilityChecks(inputs([attest(1), complain(3), attest(2, T_A)]));
    expect(r.row).toEqual({ status: "unverifiable", code: "not-implemented" });
    expect(r.report?.ballotExtent.panels).toEqual([
      {
        panel: 1,
        holds: true,
        attested: [1, 2],
        complained: [{ seat: 3, cid: Buffer.from(checkpoint(S_A).object_cid).toString("hex") }],
        silent: [],
      },
    ]);
    expect(r.report?.records?.map((x) => x.code)).toEqual(["valid", "valid", "valid"]);
    expect(r.report?.proven.count).toBe("3");
  });

  test("one attestation short of the threshold fails unavailable, attributed to no one", () => {
    const r = availabilityChecks(inputs([attest(1), complain(2)]));
    expect(r.row).toEqual({ status: "fail", code: "unavailable", at: { point: 1, panel: 1 } });
    expect(r.report?.ballotExtent.panels?.[0]).toMatchObject({
      holds: false,
      attested: [1],
      silent: [3],
    });
  });

  test("no attestation at all fails, whatever copy of the board exists", () => {
    expect(availabilityChecks(inputs([])).row).toMatchObject({
      status: "fail",
      code: "unavailable",
    });
  });

  test("an attestation submitted a second after t_A doesn't count", () => {
    const r = availabilityChecks(inputs([attest(1), attest(2, T_A + 1n)], { provenAt: T_A + 5n }));
    expect(r.row).toMatchObject({ status: "fail", code: "unavailable" });
    expect(r.report?.records?.[1]).toMatchObject({ code: "availability-late", seat: 2, point: 1 });
  });

  test("an attestation naming another checkpoint than C_A doesn't count", () => {
    const earlier = checkpointHash(checkpoint(S_A - 1));
    const later = checkpointHash(checkpoint(S_A + 1));
    const r = availabilityChecks(
      inputs([
        attest(1),
        attest(2, undefined, { checkpoint: earlier }),
        attest(3, undefined, { checkpoint: later }),
      ]),
    );
    expect(r.row).toMatchObject({ status: "fail", code: "unavailable" });
    expect(r.report?.records?.map((x) => x.code)).toEqual([
      "valid",
      "availability-checkpoint",
      "availability-checkpoint",
    ]);
  });

  test("C_A is the latest counted checkpoint at or before s_A, so a missing one moves it back", () => {
    const anchors = ANCHORS.filter((a) => a.checkpoint.segment !== S_A);
    const previous = checkpointHash(checkpoint(S_A - 1));
    const r = availabilityChecks(
      inputs(
        [
          attest(1, undefined, { checkpoint: previous }),
          attest(2, undefined, { checkpoint: previous }),
        ],
        { anchors },
      ),
    );
    expect(r.report?.ballotExtent.checkpoint?.segment).toBe(S_A - 1);
    expect(r.row).toEqual({ status: "unverifiable", code: "not-implemented" });
  });

  test("without any counted checkpoint at or before s_A, no attestation counts", () => {
    const r = availabilityChecks(inputs([attest(1), attest(2)], { anchors: [] }));
    expect(r.report?.ballotExtent.checkpoint).toBeNull();
    expect(r.row).toMatchObject({ status: "fail", code: "unavailable" });
  });

  test("another seat's signature, a stray definition and a repeat don't count", () => {
    const r = availabilityChecks(
      inputs([
        attest(1, undefined, { signer: 2 }),
        attest(2, undefined, { definition: filled(32, 0xd2) }),
        attest(3),
        attest(3, T_A - 50n),
      ]),
    );
    expect(r.row).toMatchObject({ status: "fail", code: "unavailable" });
    expect(r.report?.records?.map((x) => x.code)).toEqual([
      "availability-signature",
      "availability-stray",
      "valid",
      "availability-repeat",
    ]);
  });

  test("an author panel the board has no key set for holds no point", () => {
    const author = { panel: SEAT_PANELS.author, threshold: 2, registered: [] };
    const r = availabilityChecks(
      inputs([attest(1), attest(2), attest(1, undefined, { panel: SEAT_PANELS.author })], {
        panels: [DEFAULT, author],
      }),
    );
    expect(r.row).toEqual({ status: "fail", code: "unavailable", at: { point: 1, panel: 2 } });
    expect(r.report?.records?.[2]).toMatchObject({ code: "availability-seat" });
  });

  test("the counted extent's records are left out of the report, and decide nothing yet", () => {
    const counted = { point: AVAILABILITY_POINTS.countedExtent } as const;
    const r = availabilityChecks(
      inputs([
        attest(1, undefined, counted),
        attest(1),
        attest(2),
        complain(3, undefined, counted),
        attest(3, undefined, { ...counted, definition: filled(32, 0xd2) }),
      ]),
    );
    expect(r.row).toEqual({ status: "unverifiable", code: "not-implemented" });
    // Positions are in the board's events, the counted extent's left out.
    expect(r.report?.records?.map((x) => x.at)).toEqual([1, 2]);
  });

  test("a seal never anchored doesn't hide a failure, since 4.6 reads no copy", () => {
    // The seal's window (segment 20's end plus the deadline) closed before
    // `now` with no checkpoint for it: the board checks fail `unsealed`,
    // which no attestation settles, and 4.6 still decides the ballot extent.
    const clock = { ...CLOCK, lastSegment: 20 };
    expect(CLOCK.epoch + 21n * CLOCK.period + CLOCK.deadline).toBeLessThan(T_A + 1n);
    expect(availabilityChecks(inputs([], { clock })).row).toEqual({
      status: "fail",
      code: "unavailable",
      at: { point: 1, panel: 1 },
    });
    expect(availabilityChecks(inputs([attest(1), attest(2)], { clock })).row).toEqual({
      status: "unverifiable",
      code: "not-implemented",
    });
  });

  test("a close before the clock's epoch isn't reached, even within a period of it", () => {
    for (const closesAt of [CLOCK.epoch - 1n, CLOCK.epoch - CLOCK.period])
      expect(availabilityChecks(inputs([], { closesAt })).row).toEqual({
        status: "unverifiable",
        code: "not-reached",
      });
  });

  test("a panel holds exactly when its threshold of seats attested in time", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("attest", "complain", "late", "silent"), {
          minLength: 3,
          maxLength: 3,
        }),
        fc.integer({ min: 1, max: 3 }),
        (choices, threshold) => {
          const sent = choices.flatMap((c, i): Sent[] =>
            c === "attest"
              ? [attest(i + 1)]
              : c === "complain"
                ? [complain(i + 1)]
                : c === "late"
                  ? [attest(i + 1, T_A + 1n)]
                  : [],
          );
          // Submission times never decrease in event order.
          sent.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
          const r = availabilityChecks(
            inputs(sent, { panels: [{ ...DEFAULT, threshold }], provenAt: T_A + 5n }),
          );
          const attested = choices.filter((c) => c === "attest").length;
          expect(r.row.status).toBe(attested >= threshold ? "unverifiable" : "fail");
          expect(r.report?.ballotExtent.panels?.[0]?.attested.length).toBe(attested);
        },
      ),
      { numRuns },
    );
  });
});

describe("contract-event version 9", { timeout: 120_000 }, () => {
  // Version 9 names the availability events as version 8 does, so 4.6
  // judges the same records alike under either pin ([[contracts]], Event
  // tables (version 9); T-36).
  const under9 = (sent: readonly Sent[]) =>
    availabilityChecks(
      inputs(sent, { eventVersion: 9, l2: board(sent, { timestamp: T_A + 10n, version: 9 }) }),
    );

  test("a panel holding its threshold is judged as under version 8", () => {
    const sent = [attest(1), complain(3), attest(2, T_A)];
    const r = under9(sent);
    expect(r).toEqual(availabilityChecks(inputs(sent)));
    expect(r.row).toEqual({ status: "unverifiable", code: "not-implemented" });
  });

  test("one attestation short of the threshold fails unavailable, as under version 8", () => {
    const sent = [attest(1), complain(2)];
    expect(under9(sent).row).toEqual({
      status: "fail",
      code: "unavailable",
      at: { point: 1, panel: 1 },
    });
  });
});

describe("evidence that isn't held is unverifiable, never a failure", () => {
  test("before s_A's anchoring deadline on finalized L1", () => {
    const r = availabilityChecks(inputs([], { now: S_A_DUE - 1n }));
    expect(r.row).toEqual({ status: "unverifiable", code: "availability-pending", at: {} });
    // `C_A` isn't fixed yet, so nothing judged against it is reported.
    expect(r.report?.ballotExtent).toEqual({ deadline: T_A.toString() });
    expect(r.report?.records).toBeUndefined();
    expect(availabilityChecks(inputs([], { now: S_A_DUE })).row).toMatchObject({
      status: "fail",
    });
  });

  test("with the accumulator proven before t_A", () => {
    const r = availabilityChecks(inputs([attest(1)], { provenAt: T_A - 1n }));
    expect(r.row).toEqual({ status: "unverifiable", code: "availability-pending", at: {} });
    expect(availabilityChecks(inputs([attest(1)], { provenAt: T_A })).row).toMatchObject({
      status: "fail",
    });
  });

  test("an event withheld from the archive", () => {
    const sent = [attest(1), attest(2)];
    const l2 = board(sent, { timestamp: T_A + 10n, cut: 1 });
    expect(availabilityChecks(inputs(sent, { l2 })).row).toEqual({
      status: "unverifiable",
      code: "accumulator",
      at: {},
    });
  });

  test("an event dropped from the middle, or the archive reordered", () => {
    const sent = [attest(1), attest(2, T_A - 90n), attest(3, T_A - 80n)];
    const l2 = board(sent, { timestamp: T_A + 10n });
    const dropped = { ...l2, events: [l2.events[0], l2.events[2]] as Uint8Array[] };
    expect(availabilityChecks(inputs(sent, { l2: dropped })).row).toMatchObject({
      status: "unverifiable",
      code: "index",
    });
  });

  test("an output root its header doesn't hash to", () => {
    const l2 = board([attest(1)], { timestamp: T_A + 10n });
    const root = Uint8Array.from(l2.proof.outputRoot);
    root[0] = (root[0] as number) ^ 1;
    expect(
      availabilityChecks(inputs([], { l2: { ...l2, proof: { ...l2.proof, outputRoot: root } } }))
        .row,
    ).toEqual({ status: "unverifiable", code: "output-root", at: {} });
  });

  test("an event that doesn't decode under the pinned version", () => {
    const l2 = board([attest(1)], { timestamp: T_A + 10n });
    const events = [Uint8Array.from([...(l2.events[0] as Uint8Array), 0])];
    expect(availabilityChecks(inputs([], { l2: { ...l2, events } })).row).toMatchObject({
      status: "unverifiable",
      code: "decode",
      at: { event: 0, decodeError: "trailing-bytes" },
    });
  });

  test("a proven event with no topics, which the replay can't take", () => {
    const l2 = board([attest(1)], { timestamp: T_A + 10n });
    const record = decodeContractEvent(l2.events[0] as Uint8Array, 8);
    const events = [encodeContractEvent({ ...record, topics: [] }, 8)];
    expect(availabilityChecks(inputs([], { l2: { ...l2, events } })).row).toEqual({
      status: "unverifiable",
      code: "event-topics",
      at: {},
    });
  });

  test("another chain's accumulator", () => {
    expect(availabilityChecks(inputs([attest(1)], { l2ChainId: 8_453n })).row).toMatchObject({
      status: "unverifiable",
      code: "accumulator",
    });
  });

  test("a profile pinning a contract-event version without availability events", () => {
    expect(availabilityChecks(inputs([], { eventVersion: 7 })).row).toEqual({
      status: "unverifiable",
      code: "not-reached",
    });
    expect(availabilityChecks(inputs([], { eventVersion: 10 })).row).toEqual({
      status: "unverifiable",
      code: "unsupported-version",
      at: {},
    });
  });

  test("a version-8 archive under a version-9 pin doesn't decode, nor a version-9 one under version 8", () => {
    for (const [pinned, archived] of [
      [9, 8],
      [8, 9],
    ] as const)
      expect(
        availabilityChecks(
          inputs([attest(1)], {
            eventVersion: pinned,
            l2: board([attest(1)], { timestamp: T_A + 10n, version: archived }),
          }),
        ).row,
      ).toEqual({
        status: "unverifiable",
        code: "decode",
        at: { event: 0, decodeError: "profile-mismatch" },
      });
  });

  test("anchors that fail the board checks from L1 alone", () => {
    const equivocal = [
      ...ANCHORS,
      { ...anchor(3), checkpoint: { ...checkpoint(3), root: filled(32, 9) } },
    ];
    expect(availabilityChecks(inputs([], { anchors: equivocal })).row).toEqual({
      status: "unverifiable",
      code: "not-reached",
    });
  });
});

describe("the board's accumulator from the archive", { timeout: 120_000 }, () => {
  const sent = [attest(1), attest(2, T_A)];
  const early = board(sent, { timestamp: T_A - 1n });
  const late = board(sent, { timestamp: T_A + 10n });

  test("an archived record at or after t_A stands in for a bundle proof before it", () => {
    const before = availabilityChecks(inputs(sent, { l2: early }));
    expect(before.row).toEqual({ status: "unverifiable", code: "availability-pending", at: {} });
    expect(before.report?.proven.source).toBe("bundle");
    const r = availabilityChecks(inputs(sent, { l2: early, archived: late.archived(9) }));
    expect(r.row).toEqual({ status: "unverifiable", code: "not-implemented" });
    expect(r.report?.ballotExtent.panels?.[0]).toMatchObject({ holds: true, attested: [1, 2] });
    expect(r.report?.proven).toEqual({
      block: (T_A + 10n - T_A + 100_000n).toString(),
      hash: "09".repeat(32),
      timestamp: (T_A + 10n).toString(),
      count: "2",
      source: "archive",
      evidence: {
        cid: Buffer.from(objectCid(Uint8Array.of(9, 9))).toString("hex"),
        transaction: "09".repeat(32),
        gameIndex: "9",
        game: "09".repeat(20),
        outputRoot: Buffer.from(late.proof.outputRoot).toString("hex"),
      },
    });
  });

  test("an archived record stands in for a bundle proof that doesn't hold", () => {
    const broken = { ...early, proof: { ...early.proof, outputRoot: filled(32, 1) } };
    expect(availabilityChecks(inputs(sent, { l2: broken })).row).toEqual({
      status: "unverifiable",
      code: "output-root",
      at: {},
    });
    const r = availabilityChecks(inputs(sent, { l2: broken, archived: late.archived(9) }));
    expect(r.row).toEqual({ status: "unverifiable", code: "not-implemented" });
    // Even one too early to hold the point: pending, as the bundle's would be.
    const pending = availabilityChecks(inputs(sent, { l2: broken, archived: early.archived(9) }));
    expect(pending.row).toEqual({
      status: "unverifiable",
      code: "availability-pending",
      at: {},
    });
    expect(pending.report?.proven.source).toBe("archive");
  });

  test("a bundle proof at or after t_A is kept, and an archived one no later than it adds nothing", () => {
    const kept = availabilityChecks(inputs(sent, { l2: late, archived: early.archived(9) }));
    expect(kept.report?.proven.source).toBe("bundle");
    expect(kept.report?.proven.evidence).toBeUndefined();
    const later = board(sent, { timestamp: T_A + 20n });
    expect(
      availabilityChecks(inputs(sent, { l2: late, archived: later.archived(9) })).report?.proven
        .source,
    ).toBe("bundle");
    const earlier = board(sent, { timestamp: T_A - 2n });
    expect(
      availabilityChecks(inputs(sent, { l2: early, archived: earlier.archived(9) })).report?.proven
        .source,
    ).toBe("bundle");
  });

  test("the archived record's count is replayed against the bundle's events like the bundle's own", () => {
    // Seat 1's attestation dropped from the events: the replay doesn't hold.
    const short = { ...early, events: early.events.slice(1) };
    expect(
      availabilityChecks(inputs(sent, { l2: short, archived: late.archived(9) })).row,
    ).toMatchObject({ status: "unverifiable", code: "index" });
    // A failing archived set: one short of the threshold fails, from the archive alone.
    const one = [attest(1)];
    const r = availabilityChecks(
      inputs(one, {
        l2: board(one, { timestamp: T_A - 1n }),
        archived: board(one, { timestamp: T_A + 10n }).archived(9),
      }),
    );
    expect(r.row).toEqual({ status: "fail", code: "unavailable", at: { point: 1, panel: 1 } });
    expect(r.report?.proven.source).toBe("archive");
  });
});
