import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { admitForIntakeV5, rollingBallotElectionWith } from "../src/ballot.ts";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { signStatement } from "../src/trustee.ts";
import {
  ballotHashV4,
  ballotHashV5,
  checkShareReceiptV5,
  decodeBallot,
  decodeElectionDefinitionV7,
  type ElectionDefinitionV7,
  encodeBallotV5,
  intakeBallotV5,
  kemKeygen,
  type RegisteredKeys,
  type RollingBallotElection,
  rollingBallotElection,
  rootClockBoundary,
  SEAT_PANELS,
  type SeatPanel,
  shareReceiptStatementV4,
  identityKey,
} from "../src/index.ts";
import { type RollingEvent, tierEvent } from "./rolling-tree.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// Trustee intake's admission under ballot version 5 (docs/spec/share-encryption.md,
// Ballot version 5), over docs/spec/vectors/ballot-v5-records.json: records
// and verdicts from an independent Python implementation of version 5's
// admission (scripts/ballot-v5-records-vectors.py), with membership proofs
// from snarkjs. Intake must give each record the verdict a verifier gives it,
// with `share-hash` and `step-unsettled` in their places. The vectors' share
// hashes are labels, not ciphertext hashes, so decryption isn't reached here:
// it is version 4's, which intake-v4.test.ts checks against intake-v4.json,
// and the reference election runs it over real version-5 ballots.

interface Vectors {
  readonly events: readonly RollingEvent[];
  readonly elections: Readonly<
    Record<string, { readonly definition: string; readonly registeredAt: string }>
  >;
  readonly ballots: readonly {
    readonly id: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly authorRegistered: readonly number[];
    readonly encoding: string;
    readonly ballotHash: string;
    readonly admission: {
      readonly code: string;
      readonly ballotHash?: string;
      readonly cell?: number;
      readonly step?: number;
    };
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("ballot-v5-records.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const kem = kemKeygen().publicKey;
const keySet = (seats: readonly number[], transcript: Uint8Array): readonly RegisteredKeys[] =>
  checkedKeySetForTests(
    seats.map((index) => ({ index, kemKey: kem, signingKey: new Uint8Array(33) })),
    transcript,
  );
const events = vectors.events.map(tierEvent);

type Ballot = Vectors["ballots"][number];

const definitionOf = (b: Ballot): ElectionDefinitionV7 => {
  const e = vectors.elections[b.election];
  if (e === undefined) throw new Error(`no election ${b.election}`);
  return decodeElectionDefinitionV7(hex(e.definition));
};

// These vectors carry no author run, so a context with an author panel comes
// from the internal seam that takes its seats as given, as version 4's.
const contexts = new Map<Ballot, RollingBallotElection>();
function contextOf(b: Ballot): RollingBallotElection {
  const made = contexts.get(b) ?? makeContext(b);
  contexts.set(b, made);
  return made;
}

function makeContext(b: Ballot): RollingBallotElection {
  const d = definitionOf(b);
  const registered = keySet(b.registered, d.ceremony_transcript_hash);
  const chain = { events, registeredAt: BigInt(vectors.elections[b.election]!.registeredAt) };
  return d.author_keys.length === 0 && b.authorRegistered.length === 0
    ? rollingBallotElection(d, registered, chain)
    : rollingBallotElectionWith(d, registered, chain, b.authorRegistered);
}

// The ballot's step and the hash it carries for a seat, read from the record
// when it decodes.
function seatOf(b: Ballot, panel: SeatPanel = SEAT_PANELS.default) {
  const seats = panel === SEAT_PANELS.author ? b.authorRegistered : b.registered;
  const seat = seats[0];
  if (seat === undefined) throw new Error(`${b.id} has no seat of panel ${panel}`);
  let shareHash: Uint8Array = new Uint8Array(32).fill(0xab);
  let step: number | undefined;
  try {
    const r = decodeBallot(hex(b.encoding), 5);
    const hashes =
      panel === SEAT_PANELS.author
        ? r.committed_vote.author_share_hashes
        : r.committed_vote.share_hashes;
    shareHash = hashes[seat - 1] ?? shareHash;
    step = r.step;
  } catch {
    // Left as the vector's decode verdict.
  }
  return { panel, seat, shareHash, step };
}

// Every step of the vectors is settled once the safe chain is past every close.
const lateSafeAt = (b: Ballot) => definitionOf(b).closes_at + 1n;

const admitted = vectors.ballots.filter((b) => b.admission.code === "ok");
const vector = (id: string) => {
  const b = vectors.ballots.find((x) => x.id === id);
  if (b === undefined) throw new Error(`no vector ${id}`);
  return b;
};
const tauOf = (b: Ballot) => {
  const { step } = seatOf(b);
  if (step === undefined) throw new Error(`${b.id} doesn't decode`);
  return rootClockBoundary(BigInt(step));
};

describe("admitForIntakeV5 over ballot-v5-records.json", () => {
  test.each(vectors.ballots.map((b) => [b.id, b] as const))(
    "%s: the verifier's verdict, once every step is settled",
    (_, b) => {
      const { panel, seat, shareHash } = seatOf(b);
      const r = admitForIntakeV5(
        contextOf(b),
        hex(b.encoding),
        panel,
        seat,
        shareHash,
        lateSafeAt(b),
      );
      expect(r.ok ? "ok" : r.code).toBe(b.admission.code);
      if (r.ok) {
        expect(toHex(r.ballotHash)).toBe(b.admission.ballotHash);
        expect(r.cell).toBe(b.admission.cell);
        expect(r.step).toBe(b.admission.step);
        expect(r.panel).toBe(panel);
      }
    },
  );

  test("an author seat admits against its own panel's share hash (T-37)", () => {
    const withAuthor = admitted.filter((b) => b.authorRegistered.length > 0);
    expect(withAuthor.length).toBeGreaterThan(0);
    for (const b of withAuthor) {
      const own = seatOf(b, SEAT_PANELS.author);
      const ctx = contextOf(b);
      const at = lateSafeAt(b);
      const r = admitForIntakeV5(ctx, hex(b.encoding), own.panel, own.seat, own.shareHash, at);
      expect(r.ok).toBe(true);
      // The default seat of the same index has its own hash, never the author's.
      const other = seatOf(b, SEAT_PANELS.default);
      if (b.registered.includes(own.seat) && toHex(other.shareHash) !== toHex(own.shareHash)) {
        const crossed = admitForIntakeV5(
          ctx,
          hex(b.encoding),
          SEAT_PANELS.default,
          own.seat,
          own.shareHash,
          at,
        );
        expect(crossed).toMatchObject({ ok: false, code: "share-hash" });
      }
    }
  });

  test("an admitted ballot with another ciphertext's hash is share-hash, before the membership proof", () => {
    for (const id of ["ok-newest-step", "order-membership-before-option"]) {
      const b = vector(id);
      const { panel, seat } = seatOf(b);
      const r = admitForIntakeV5(
        contextOf(b),
        hex(b.encoding),
        panel,
        seat,
        new Uint8Array(32).fill(7),
        lateSafeAt(b),
      );
      expect(r).toMatchObject({ ok: false, code: "share-hash" });
    }
  });

  test("a step the safe chain hasn't passed is step-unsettled, judged the moment it has (T-52, T-54)", () => {
    expect(admitted.length).toBeGreaterThan(3);
    fc.assert(
      fc.property(
        fc.constantFrom(...admitted),
        fc.oneof(fc.bigInt({ min: -2n, max: 2n }), fc.bigInt({ min: -3600n, max: 3600n })),
        (b, offset) => {
          const tau = tauOf(b);
          const safeAt = tau + offset < 0n ? 0n : tau + offset;
          const { panel, seat, shareHash } = seatOf(b);
          const r = admitForIntakeV5(contextOf(b), hex(b.encoding), panel, seat, shareHash, safeAt);
          // Settled once the chain holds a block later than τ (membership.md, Root clock and steps).
          if (safeAt > tau) expect(r.ok).toBe(true);
          else expect(r).toMatchObject({ ok: false, code: "step-unsettled" });
        },
      ),
      // A settled ballot costs a pairing check, so the cases are capped.
      { numRuns: Math.min(numRuns, 16) },
    );
  }, 60_000);

  test("step-unsettled comes before share-hash, so an unsettled delivery is never judged further", () => {
    const b = vector("ok-newest-step");
    const { panel, seat } = seatOf(b);
    const r = admitForIntakeV5(
      contextOf(b),
      hex(b.encoding),
      panel,
      seat,
      new Uint8Array(32).fill(7),
      tauOf(b),
    );
    expect(r).toMatchObject({ ok: false, code: "step-unsettled" });
  });

  test("a step the clock alone puts outside the poll is root-step-range, whatever the node has seen", () => {
    for (const id of ["root-step-range-before-registration", "root-step-range-after-close"]) {
      const b = vector(id);
      const { panel, seat, shareHash } = seatOf(b);
      for (const safeAt of [0n, tauOf(b), lateSafeAt(b)])
        expect(
          admitForIntakeV5(contextOf(b), hex(b.encoding), panel, seat, shareHash, safeAt),
        ).toMatchObject({ ok: false, code: "root-step-range" });
    }
  });

  test("a step inside the poll whose tree the node can't yet judge is step-unsettled, then root-step-range", () => {
    const b = vector("root-step-range-no-member");
    const { panel, seat, shareHash } = seatOf(b);
    const ctx = contextOf(b);
    const record = hex(b.encoding);
    expect(admitForIntakeV5(ctx, record, panel, seat, shareHash, tauOf(b))).toMatchObject({
      ok: false,
      code: "step-unsettled",
    });
    expect(admitForIntakeV5(ctx, record, panel, seat, shareHash, tauOf(b) + 1n)).toMatchObject({
      ok: false,
      code: "root-step-range",
    });
  });

  test("the checks on the record's header and shares come before the step's, as admission's", () => {
    for (const [id, code] of [
      ["ballot-stray", "ballot-stray"],
      ["ballot-cell", "ballot-cell"],
      ["validity-shape", "validity-shape"],
      ["order-unqualified-before-step", "share-hash-unqualified"],
    ] as const) {
      const b = vector(id);
      const { panel, seat, shareHash } = seatOf(b);
      expect(
        admitForIntakeV5(contextOf(b), hex(b.encoding), panel, seat, shareHash, 0n),
      ).toMatchObject({ ok: false, code });
    }
  });

  test("a record that isn't a strict version-5 record is delivery-malformed", () => {
    const b = vector("ok-newest-step");
    const { panel, seat, shareHash } = seatOf(b);
    const record = hex(b.encoding);
    const ctx = contextOf(b);
    const at = lateSafeAt(b);
    const decoded = decodeBallot(record, 5);
    expect(toHex(encodeBallotV5(decoded))).toBe(toHex(record));
    for (const bad of [
      record.subarray(0, record.length - 1),
      Uint8Array.of(...record, 0),
      Uint8Array.of(record[0] as number, record[1] as number, 4, ...record.subarray(3)),
    ])
      expect(admitForIntakeV5(ctx, bad, panel, seat, shareHash, at)).toMatchObject({
        ok: false,
        code: "delivery-malformed",
      });
  });

  test("refuses a seat outside its panel's key set, another panel, and a malformed safeAt", () => {
    const b = vector("ok-newest-step");
    const { shareHash } = seatOf(b);
    const ctx = contextOf(b);
    const record = hex(b.encoding);
    const outside = [0, 17, ...[1, 2, 3, 4, 5, 6, 7].filter((s) => !b.registered.includes(s))];
    for (const seat of outside)
      expect(() => admitForIntakeV5(ctx, record, SEAT_PANELS.default, seat, shareHash, 1n)).toThrow(
        RangeError,
      );
    const seat = b.registered[0] as number;
    expect(() => admitForIntakeV5(ctx, record, 3 as SeatPanel, seat, shareHash, 1n)).toThrow(
      RangeError,
    );
    expect(() =>
      admitForIntakeV5(ctx, record, SEAT_PANELS.default, seat, shareHash.subarray(1), 1n),
    ).toThrow(RangeError);
    expect(() => admitForIntakeV5(ctx, record, SEAT_PANELS.default, seat, shareHash, -1n)).toThrow(
      RangeError,
    );
    expect(() =>
      admitForIntakeV5(ctx, record, SEAT_PANELS.default, seat, shareHash, 1 as unknown as bigint),
    ).toThrow(RangeError);
  });

  test("refuses a context rollingBallotElection didn't make", () => {
    const b = vector("ok-newest-step");
    const { panel, seat, shareHash } = seatOf(b);
    const forged = { ...contextOf(b) } as RollingBallotElection;
    expect(() => admitForIntakeV5(forged, hex(b.encoding), panel, seat, shareHash, 1n)).toThrow(
      TypeError,
    );
  });
});

describe("intakeBallotV5", () => {
  const keysOf = (seat: number) => ({
    panel: SEAT_PANELS.default,
    seat,
    kemSecret: kemKeygen().secretKey,
    signingSecret: new Uint8Array(32).fill(1),
  });

  test("hashes the delivered ciphertext: one the record doesn't name is share-hash, nothing opened", () => {
    const b = vector("ok-newest-step");
    const seat = b.registered[0] as number;
    const r = intakeBallotV5(
      contextOf(b),
      keysOf(seat),
      hex(b.encoding),
      new Uint8Array(1088),
      lateSafeAt(b),
    );
    expect(r).toMatchObject({ ok: false, code: "share-hash" });
  });

  test("refuses an unsettled step before the ciphertext's hash is compared or anything opened", () => {
    const b = vector("ok-newest-step");
    const seat = b.registered[0] as number;
    const r = intakeBallotV5(
      contextOf(b),
      keysOf(seat),
      hex(b.encoding),
      new Uint8Array(1088),
      tauOf(b),
    );
    expect(r).toMatchObject({ ok: false, code: "step-unsettled" });
  });
});

describe("checkShareReceiptV5", () => {
  const b = vector("ok-newest-step");
  const record = decodeBallot(hex(b.encoding), 5);
  const vote = record.committed_vote;
  const seat = b.registered[0] as number;
  const secret = new Uint8Array(32).fill(3);
  const signers = {
    default: b.registered.map((index) => ({
      index,
      signingKey: identityKey(index === seat ? secret : new Uint8Array(32).fill(index + 10)),
    })),
    author: [],
  };
  const named = {
    definitionHash: record.definition_hash,
    cell: record.cell,
    nullifier: record.nullifier,
  };
  const ctx = { ...named, step: record.step };
  const sign = (ballotHash: Uint8Array) =>
    signStatement(
      secret,
      "abolish/v1/sig/share-receipt-2",
      shareReceiptStatementV4({
        definition_hash: named.definitionHash,
        ballot_hash: ballotHash,
        panel: SEAT_PANELS.default,
        seat,
        share_hash: vote.share_hashes[seat - 1] as Uint8Array,
      }),
    );
  const receipt = sign(ballotHashV5(ctx, vote));

  test("checks a receipt over the version-5 ballot hash, and not the same vote at another step (T-38)", () => {
    expect(checkShareReceiptV5(signers, ctx, vote, SEAT_PANELS.default, seat, receipt)).toBe(true);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }).filter((n) => n !== record.step),
        (step) =>
          !checkShareReceiptV5(
            signers,
            { ...named, step },
            vote,
            SEAT_PANELS.default,
            seat,
            receipt,
          ),
      ),
      { numRuns },
    );
  });

  test("a receipt over the version-4 hash of the same vote doesn't check (T-31)", () => {
    const v4 = sign(ballotHashV4(named, vote));
    expect(checkShareReceiptV5(signers, ctx, vote, SEAT_PANELS.default, seat, v4)).toBe(false);
  });

  test("is false for another seat, the author panel, a panel outside both or a seat out of range", () => {
    const other = b.registered.find((s) => s !== seat) as number;
    for (const [panel, at] of [
      [SEAT_PANELS.default, other],
      [SEAT_PANELS.author, seat],
      [3 as SeatPanel, seat],
      [SEAT_PANELS.default, 0],
      [SEAT_PANELS.default, 17],
    ] as const)
      expect(checkShareReceiptV5(signers, ctx, vote, panel, at, receipt)).toBe(false);
  });

  test("refuses an author panel's signing keys given beside it", () => {
    expect(() =>
      checkShareReceiptV5(
        { ...signers, author: [{ index: 1, signingKey: identityKey(secret) }] },
        ctx,
        vote,
        SEAT_PANELS.default,
        seat,
        receipt,
      ),
    ).toThrow(RangeError);
  });
});
