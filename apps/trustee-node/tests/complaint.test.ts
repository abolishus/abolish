// The complaint duty (P2-13 part 4b-3a), over docs/spec/vectors/
// share-encryption.json's ballots, panel and postings, which an independent
// implementation printed: a dishonest client's ballots whose posted shares
// fail one seat's share check or decryption, and an honest one whose posted
// shares open. Each ballot is one voter's, so the seat's decision at `c_I`
// selects one of them for the scope, and only that one's failing posting is
// owed a complaint.
import { readFileSync } from "node:fs";
import {
  ballotHash,
  ballotHashV3,
  checkComplaint,
  COMMITTED_VOTE,
  decode,
  decodeBallot,
  decodeShareComplaintBatch,
  deliveryDeadlines,
  encodeBallot,
  encodeBallotV3,
  encodeSharePosting,
  type FinalizedL1,
  identityKey,
  intakeCutoff,
  KEM_PUBLIC_KEY,
  type KemKeyPair,
  L1_REF_MARGIN,
  membershipMessage,
  SHARE_CIPHERTEXT,
  shareComplaintBatchStatement,
  verifyStatement,
  type ViewBallot,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import type { ApprovedElection } from "../src/ceremony.ts";
import {
  ComplaintDuty,
  type ComplaintDutyStatus,
  type ComplaintPath,
  type RecordedPosting,
} from "../src/complaint.ts";
import type { ObligationView } from "../src/obligation.ts";
import { MemoryStore } from "../src/store.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";

// Each run checks and proves over ML-KEM: a tenth of the runs, as the
// whole-ceremony properties take.
const numRuns = Math.max(1, Math.floor(Number(process.env["FC_NUM_RUNS"] ?? 100) / 10));

const unhex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const vector = (file: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../docs/spec/vectors/${file}`, import.meta.url), "utf8"));

interface BallotVector {
  readonly id: string;
  readonly context: {
    readonly definitionHash: string;
    readonly tier: number;
    readonly nullifier: string;
  };
  readonly committedVote: string;
  /** The client's ciphertexts, and the ML-KEM message of each, which a posting carries. */
  readonly ciphertexts: readonly string[];
  readonly encapsulation: readonly { readonly m: string }[];
}
const shares = vector("share-encryption.json") as {
  readonly panels: Record<string, readonly { seed: string; x: string; publicKey: string }[]>;
  readonly ballots: readonly BallotVector[];
};
// Any membership proof that decodes: the duty never checks one, the view did.
const proof = decodeBallot(
  unhex((vector("ballot.json") as { ballots: { encoding: string }[] }).ballots[0]!.encoding),
  1,
).membership_proof;

const ballotVector = (id: string) => shares.ballots.find((b) => b.id === id)!;
const DEFINITION = unhex(ballotVector("plurality").context.definitionHash);
const keyPair = (seat: number): KemKeyPair => {
  const k = shares.panels["panel-3"]![seat - 1]!;
  return {
    publicKey: decode(KEM_PUBLIC_KEY, unhex(k.publicKey)),
    secretKey: { seed: unhex(k.seed), x: BigInt(k.x) },
  };
};

const OPENS = 1_800_000_000n;
const CLOSES = OPENS + 86_400n;
const BOUND = 3_600n;
const SEGMENT = 50n;
const { delivery: T_D, complaint: T_K } = deliveryDeadlines(CLOSES, BOUND);
const C_I = intakeCutoff(CLOSES, BOUND, RELEASE_WINDOWS);
const POSTINGS_RECORDED = T_D + RELEASE_WINDOWS.contractEventWindow;
const C_K = T_K - RELEASE_WINDOWS.forcedInclusion;
const DELIVERIES = `deliveries/${"51".repeat(32)}`;

const electionFor = (seat: number): ApprovedElection => ({
  index: seat,
  stubHash: new Uint8Array(32).fill(0x51),
  definitionHash: DEFINITION,
  electionId: new Uint8Array(32).fill(0x52),
  opensAt: OPENS,
  closesAt: CLOSES,
  l1InclusionBound: BOUND,
  members: 3n,
  signingSecret: keccak_256(new TextEncoder().encode(`signing ${seat}`)),
  kemKeyPair: keyPair(seat),
});

// Finalized L1 whose block `n` hashes to `n` repeated, from before
// `opens_at − L1_REF_MARGIN` to the first block after `closes_at`.
const START = OPENS - L1_REF_MARGIN - 1_200n;
const l1: FinalizedL1 = {
  head: (CLOSES - START) / 12n + 1n,
  block: (n) => ({ hash: new Uint8Array(32).fill(Number(n % 256n)), timestamp: START + n * 12n }),
};

/** A vector ballot as the board carries it, cast under L1 block `ref`. */
function ballotOf(id: string, ref: bigint, voter = 0n) {
  const b = ballotVector(id);
  // Another voter's ballot with the same vote: the ciphertexts bind the
  // definition, the seat and the commitments, never the nullifier.
  const nullifier = BigInt(b.context.nullifier) + voter;
  const vote = decode(COMMITTED_VOTE, unhex(b.committedVote));
  const hash = ballotHash({ definitionHash: DEFINITION, tier: 0, nullifier }, vote);
  const l1RefHash = new Uint8Array(32).fill(Number(ref % 256n));
  const record = encodeBallot({
    definition_hash: DEFINITION,
    tier: 0,
    nullifier,
    l1_ref_number: ref,
    l1_ref_hash: l1RefHash,
    membership_proof: proof,
    committed_vote: vote,
  });
  const copy: ViewBallot = {
    ballotHash: hash,
    tier: 0,
    nullifier,
    message: membershipMessage({
      definitionHash: DEFINITION,
      tier: 0,
      ballotHash: hash,
      l1RefNumber: ref,
      l1RefHash,
    }),
    l1RefNumber: ref,
    l1RefHash,
    entry: { path: "board", value: SEGMENT },
  };
  return { hash, vote, record, copy };
}

/**
 * `ballotOf` as a version-3 ballot naming `cell` (definition version 5,
 * P2-14): the vector's vote with its one sum proof as its one question's
 * range proof. The duty checks no validity proof, and version 3's shares,
 * ciphertexts and postings are version 1's (share-encryption.md, Ballot
 * versions 2 and 3), so its postings fail or open as version 1's do.
 */
function ballotOfV3(id: string, ref: bigint, cell = 0) {
  const { vote: v1, copy } = ballotOf(id, ref);
  const vote = {
    vss: v1.vss,
    share_hashes: v1.share_hashes,
    option_proofs: v1.option_proofs,
    sum_proofs: [v1.sum_proof],
  };
  const hash = ballotHashV3({ definitionHash: DEFINITION, cell, nullifier: copy.nullifier }, vote);
  const record = encodeBallotV3({
    definition_hash: DEFINITION,
    cell,
    nullifier: copy.nullifier,
    l1_ref_number: ref,
    l1_ref_hash: copy.l1RefHash,
    membership_proof: proof,
    committed_vote: vote,
  });
  const message = membershipMessage({
    definitionHash: DEFINITION,
    tier: 0,
    ballotHash: hash,
    l1RefNumber: ref,
    l1RefHash: copy.l1RefHash,
  });
  return { hash, vote: v1, record, copy: { ...copy, ballotHash: hash, message } };
}

interface Posted {
  readonly seat: number;
  readonly ciphertext: Uint8Array;
  readonly m: Uint8Array;
}

/** Seat `seat`'s ciphertext of vector ballot `id` with its own `m`: what the voter would post. */
function posted(id: string, seat: number): Posted {
  const b = ballotVector(id);
  return {
    seat,
    ciphertext: unhex(b.ciphertexts[seat - 1]!),
    m: unhex(b.encapsulation[seat - 1]!.m),
  };
}

/** `p` as the board contract recorded it, for `ballot`'s hash. */
function postingOf(
  p: Posted,
  ballot: ReturnType<typeof ballotOf>,
  submittedAt = T_D,
  change: { seat?: number; m?: Uint8Array; definitionHash?: Uint8Array } = {},
): RecordedPosting {
  return {
    record: encodeSharePosting({
      definition_hash: change.definitionHash ?? DEFINITION,
      ballot_hash: ballot.hash,
      seat: change.seat ?? p.seat,
      m: change.m ?? p.m,
      ciphertext: decode(SHARE_CIPHERTEXT, p.ciphertext),
    }),
    submittedAt,
  };
}

// The dishonest client's seat-2 posting of bad-share: the vectors' `pass-bad-share`.
const BAD = posted("bad-share", 2);

interface Harness {
  /** The duty over the harness, with `outside` as its budget outside the scope if given. */
  readonly duty: (store?: MemoryStore, outside?: number) => ComplaintDuty;
  readonly store: MemoryStore;
  readonly sent: { record: string; cutoff: bigint }[];
  recorded: Uint8Array[];
  postings: RecordedPosting[];
  ballots: Uint8Array[];
  finalizedAt: bigint;
  now: bigint;
  failSend: boolean;
}

function harness(seat: number, board: readonly ViewBallot[]): Harness {
  const election = electionFor(seat);
  const view: ObligationView = { l1, low: 0n, board, boardSegment: SEGMENT, absent: [] };
  const h: Harness = {
    store: new MemoryStore(),
    sent: [],
    recorded: [],
    postings: [],
    ballots: [],
    finalizedAt: POSTINGS_RECORDED + 1n,
    now: POSTINGS_RECORDED + 1n,
    failSend: false,
    duty: (store = h.store, outside) =>
      new ComplaintDuty({
        store,
        election,
        view: () => Promise.resolve(view),
        now: () => h.now,
        ballots: () => Promise.resolve(h.ballots),
        contract,
        ...(outside === undefined ? {} : { outside }),
      }),
  };
  const contract: ComplaintPath = {
    postings: async (definitionHash, s) => {
      expect([hex(definitionHash), s]).toEqual([hex(DEFINITION), seat]);
      return { finalizedAt: h.finalizedAt, postings: h.postings };
    },
    send: async (record, cutoff) => {
      if (h.failSend) throw new Error("unsent");
      h.sent.push({ record: hex(record), cutoff });
    },
    recorded: async () => h.recorded,
  };
  return h;
}

/** The duty done: `total` batches owed and `outside` outside the scope, `outsideMissing` of them never recorded. */
const done = (total: number, outside = 0, outsideMissing = 0): ComplaintDutyStatus => ({
  state: "recorded",
  total,
  outside,
  outsideMissing,
});

/** The one batch sent, decoded and checked: the seat's signature, and each entry's proof against `posting`. */
function checkSent(h: Harness, seat: number, ballot: ReturnType<typeof ballotOf>, p: Posted) {
  expect(h.sent).toHaveLength(1);
  const sent = h.sent[0]!;
  expect(sent.cutoff).toBe(C_K);
  const batch = decodeShareComplaintBatch(unhex(sent.record), 1);
  expect([hex(batch.definition_hash), batch.seat]).toEqual([hex(DEFINITION), seat]);
  expect(
    verifyStatement(
      identityKey(electionFor(seat).signingSecret),
      "abolish/v1/sig/share-complaint-batch",
      shareComplaintBatchStatement(batch),
      batch.signature,
    ),
  ).toBe(true);
  expect(batch.complaints.map((c) => hex(c.ballot_hash))).toEqual([hex(ballot.hash)]);
  expect(
    checkComplaint(
      { definitionHash: DEFINITION },
      seat,
      keyPair(seat).publicKey,
      ballot.vote.vss,
      ballot.vote.share_hashes,
      { ciphertext: p.ciphertext, m: p.m },
      batch.complaints[0]!.proof,
    ),
  ).toEqual({ ok: true });
  return unhex(sent.record);
}

describe("ComplaintDuty", () => {
  test("its deadlines: t_K, c_K = t_K − F and t_D + W_C", () => {
    const duty = harness(2, []).duty();
    expect([duty.deadline, duty.cutoff, duty.postingsRecorded]).toEqual([
      T_K,
      C_K,
      POSTINGS_RECORDED,
    ]);
  });

  test("decides nothing while intake is open", async () => {
    const h = harness(2, []);
    h.now = C_I - 1n;
    expect(await h.duty().step()).toEqual({ state: "open", until: C_I });
    expect(await h.store.list("obligations")).toEqual([]);
  });

  test("waits until the node's clock and its finalized L2 history pass t_D + W_C (T-54)", async () => {
    const bad = ballotOf("bad-share", 160n);
    const h = harness(2, [bad.copy]);
    h.postings = [postingOf(BAD, bad)];
    h.ballots = [bad.record];
    h.now = POSTINGS_RECORDED;
    const waiting: ComplaintDutyStatus = { state: "waiting-postings", until: POSTINGS_RECORDED };
    expect(await h.duty().step()).toEqual(waiting);
    h.now = POSTINGS_RECORDED + 1n;
    h.finalizedAt = POSTINGS_RECORDED;
    expect(await h.duty().step()).toEqual(waiting);
    expect(h.sent).toEqual([]);
    expect(await h.store.list(DELIVERIES)).toEqual([]);
    h.finalizedAt = POSTINGS_RECORDED + 1n;
    expect(await h.duty().step()).toMatchObject({ state: "sent", batches: 1 });
  });

  test.each([
    ["bad-share", 2, "fail the share check"],
    ["bad-seal", 2, "don't decrypt"],
    ["short-list", 1, "don't decrypt"],
  ] satisfies [string, number, string][])(
    "complains once about the selected %s ballot, whose seat-%i shares %s (T-29)",
    async (id, seat) => {
      const bad = ballotOf(id, 160n);
      // An earlier ballot of the voter's, superseded.
      const earlier = ballotOf("plurality", 150n);
      const h = harness(seat, [earlier.copy, bad.copy]);
      h.postings = [postingOf(posted(id, seat), bad)];
      h.ballots = [earlier.record, bad.record];
      expect(await h.duty().step()).toEqual({ state: "sent", batches: 1, recorded: 0, total: 1 });
      checkSent(h, seat, bad, posted(id, seat));
    },
  );

  test("stores the batch once and resends its bytes until recorded, after a restart and over later postings (T-52)", async () => {
    const bad = ballotOf("bad-share", 160n);
    const h = harness(2, [bad.copy]);
    h.postings = [postingOf(BAD, bad)];
    h.ballots = [bad.record];
    await h.duty().step();
    const batch = checkSent(h, 2, bad, BAD);
    // A later read shows another passing posting, and the ballot source is
    // gone: nothing is decided again.
    h.postings = [...h.postings, postingOf(BAD, bad, T_D - 1n)];
    h.ballots = [];
    const restarted = h.duty();
    expect(await restarted.step()).toEqual({ state: "sent", batches: 1, recorded: 0, total: 1 });
    expect(h.sent.map((s) => s.record)).toEqual([hex(batch), hex(batch)]);
    // Another batch of the seat's isn't the stored one.
    h.recorded = [new Uint8Array([1, 2, 3])];
    expect((await restarted.step()).state).toBe("sent");
    h.recorded = [batch];
    expect(await restarted.step()).toEqual(done(1));
    expect(h.sent).toHaveLength(3);
  });

  test("a failed send leaves the stored batch to resend", async () => {
    const bad = ballotOf("bad-share", 160n);
    const h = harness(2, [bad.copy]);
    h.postings = [postingOf(BAD, bad)];
    h.ballots = [bad.record];
    h.failSend = true;
    await expect(h.duty().step()).rejects.toThrow("unsent");
    h.failSend = false;
    expect((await h.duty().step()).state).toBe("sent");
    checkSent(h, 2, bad, BAD);
  });

  test("stops sending past t_K", async () => {
    const bad = ballotOf("bad-share", 160n);
    const h = harness(2, [bad.copy]);
    h.postings = [postingOf(BAD, bad)];
    h.ballots = [bad.record];
    await h.duty().step();
    h.now = T_K + 1n;
    expect(await h.duty().step()).toEqual({ state: "unrecorded", missing: 1, total: 1 });
    expect(h.sent).toHaveLength(1);
  });

  test("over any postings, restarts and send failures, it signs one set, owing exactly the failing posting in time (T-29, T-52)", async () => {
    const bad = ballotOf("bad-share", 160n);
    const honest = ballotOf("plurality", 150n);
    // What anyone may post for the seat: bad-share's passing posting, in
    // time or late, with a wrong m, or honest's, whose shares open.
    const kinds = {
      owed: postingOf(BAD, bad, T_D),
      late: postingOf(BAD, bad, T_D + 1n),
      wrongM: postingOf(BAD, bad, T_D, { m: new Uint8Array(32).fill(9) }),
      opens: postingOf(posted("plurality", 2), honest, T_D - 5n),
    } as const;
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            add: fc.subarray(Object.keys(kinds) as (keyof typeof kinds)[]),
            restart: fc.boolean(),
            fail: fc.boolean(),
            recorded: fc.boolean(),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (steps) => {
          const h = harness(2, [honest.copy, bad.copy]);
          h.ballots = [honest.record, bad.record];
          let duty = h.duty();
          let first: string | undefined;
          let owed = false;
          for (const s of steps) {
            h.postings = [...h.postings, ...s.add.map((k) => kinds[k])];
            if (s.restart) duty = h.duty();
            h.failSend = s.fail;
            const before = first === undefined;
            // The set is decided over the postings of the step that first decides.
            if (before) owed = h.postings.includes(kinds.owed);
            if (s.recorded && h.sent.length > 0) h.recorded = [unhex(h.sent[0]!.record)];
            const status = await duty.step().catch((e: Error) => e);
            const stored = await h.store.get(`${DELIVERIES}/complaints`);
            expect(stored).toBeDefined();
            first ??= hex(stored!);
            expect(hex(stored!)).toBe(first);
            if (status instanceof Error) expect([s.fail, owed]).toEqual([true, true]);
            else if (!owed) expect(status).toEqual(done(0));
          }
          // Every batch sent is the one stored, and complains about bad-share alone.
          for (const sent of h.sent) {
            expect(owed).toBe(true);
            checkSent({ ...h, sent: [sent] }, 2, bad, BAD);
          }
        },
      ),
      { numRuns },
    );
  });

  describe("owes nothing, and signs nothing outside its scope either, for", () => {
    const bad = ballotOf("bad-share", 160n);
    const honest = ballotOf("plurality", 160n);
    const cases: readonly [
      string,
      { seat: number; board: readonly ViewBallot[]; postings: () => RecordedPosting[] },
    ][] = [
      [
        "a passing posting whose shares open (no unfounded complaint, T-15)",
        {
          seat: 1,
          board: [honest.copy],
          postings: () => [postingOf(posted("plurality", 1), honest)],
        },
      ],
      [
        "a posting that fails the public check",
        {
          seat: 2,
          board: [bad.copy],
          postings: () => [postingOf(BAD, bad, T_D, { m: new Uint8Array(32) })],
        },
      ],
      [
        "a posting submitted after t_D",
        { seat: 2, board: [bad.copy], postings: () => [postingOf(BAD, bad, T_D + 1n)] },
      ],
      [
        "a posting for another seat",
        {
          seat: 2,
          board: [bad.copy],
          postings: () => [postingOf(BAD, bad, T_D, { seat: 3 })],
        },
      ],
      [
        "a posting naming another definition",
        {
          seat: 2,
          board: [bad.copy],
          postings: () => [postingOf(BAD, bad, T_D, { definitionHash: new Uint8Array(32) })],
        },
      ],
      [
        "a failing posting of a ballot a newer one supersedes, outside the scope (T-52)",
        {
          seat: 2,
          board: [ballotOf("bad-share", 150n).copy, ballotOf("plurality", 170n).copy],
          postings: () => [postingOf(BAD, bad)],
        },
      ],
      [
        "a failing posting of a ballot neither its view nor its sources hold",
        {
          seat: 2,
          board: [],
          postings: () => [postingOf(BAD, ballotOf("bad-share", 160n, 7n))],
        },
      ],
      [
        "a record that doesn't decode",
        {
          seat: 2,
          board: [bad.copy],
          postings: () => [{ record: new Uint8Array([0, 13, 1]), submittedAt: T_D }],
        },
      ],
    ];
    test.each(cases)("%s", async (_, c) => {
      const h = harness(c.seat, c.board);
      h.postings = c.postings();
      h.ballots = [bad.record, honest.record];
      expect(await h.duty().step()).toEqual(done(0));
      expect(h.sent).toEqual([]);
      expect(await h.store.list(DELIVERIES)).toEqual(["complaints", "complaints-outside"]);
    });
  });

  test("waits for a scope ballot its sources don't give, and never takes another ballot's record for it (T-38)", async () => {
    const bad = ballotOf("bad-share", 160n);
    const h = harness(2, [bad.copy]);
    h.postings = [postingOf(BAD, bad)];
    // The voter's other ballot, and the bad ballot under another nullifier:
    // neither hashes to the scope's ballot hash.
    const other = decodeBallot(bad.record, 1);
    h.ballots = [
      ballotOf("plurality", 160n).record,
      encodeBallot({ ...other, nullifier: other.nullifier + 1n }),
    ];
    expect(await h.duty().step()).toEqual({
      state: "waiting-ballots",
      missing: 1,
      until: C_K - RELEASE_WINDOWS.margin,
    });
    expect(await h.store.list(DELIVERIES)).toEqual([]);
    h.ballots = [bad.record];
    expect((await h.duty().step()).state).toBe("sent");
    checkSent(h, 2, bad, BAD);
  });

  test("past c_K − R it decides without a ballot its sources withhold, giving up only that one's complaint (T-29, T-54)", async () => {
    const withheld = ballotOf("bad-share", 160n);
    const held = ballotOf("bad-share", 160n, 1n);
    const h = harness(2, [withheld.copy, held.copy]);
    h.postings = [postingOf(BAD, withheld), postingOf(BAD, held)];
    h.ballots = [held.record];
    const giveUp = C_K - RELEASE_WINDOWS.margin;
    h.now = giveUp - 1n;
    expect(await h.duty().step()).toEqual({ state: "waiting-ballots", missing: 1, until: giveUp });
    h.now = giveUp;
    expect(await h.duty().step()).toEqual({ state: "sent", batches: 1, recorded: 0, total: 1 });
    checkSent(h, 2, held, BAD);
  });

  test("complains about a version-3 ballot's failing posting, by the ballot hash its cell gives (T-29)", async () => {
    const bad = ballotOfV3("bad-share", 160n, 1);
    const h = harness(2, [bad.copy]);
    h.postings = [postingOf(BAD, bad)];
    h.ballots = [bad.record];
    expect(await h.duty().step()).toEqual({ state: "sent", batches: 1, recorded: 0, total: 1 });
    checkSent(h, 2, bad, BAD);
  });

  test("never takes a version-3 scope ballot's vote from a record of another layout or cell (T-34, T-38)", async () => {
    const bad = ballotOfV3("bad-share", 160n, 1);
    const h = harness(2, [bad.copy]);
    h.postings = [postingOf(BAD, bad)];
    // The same vote and nullifier as a version-1 record, and as a version-3
    // record naming another cell: neither hashes to the scope's ballot hash.
    h.ballots = [ballotOf("bad-share", 160n).record, ballotOfV3("bad-share", 160n, 0).record];
    expect(await h.duty().step()).toEqual({
      state: "waiting-ballots",
      missing: 1,
      until: C_K - RELEASE_WINDOWS.margin,
    });
    h.ballots = [bad.record];
    expect((await h.duty().step()).state).toBe("sent");
    checkSent(h, 2, bad, BAD);
  });

  test("never waits on, or complains about, a ballot the seat receipted", async () => {
    const bad = ballotOf("bad-share", 160n);
    const h = harness(2, [bad.copy]);
    h.postings = [postingOf(BAD, bad)];
    // Decided at `c_I` before the postings are in, then shown receipted:
    // its shares passed this seat's intake, so a passing posting opens again.
    h.now = POSTINGS_RECORDED;
    expect((await h.duty().step()).state).toBe("waiting-postings");
    await h.store.putOnce(`intake/${"51".repeat(32)}/${hex(bad.hash)}`, new Uint8Array([1]));
    h.now = POSTINGS_RECORDED + 1n;
    expect(await h.duty().step()).toEqual(done(0));
    expect(h.sent).toEqual([]);
  });

  describe("outside its scope (delivery.md, What a node owes in complaints, SHOULD)", () => {
    // Another seat-2 ballot whose posted shares fail: the vectors' bad-seal.
    const SEAL = posted("bad-seal", 2);

    /** Batch `i` sent, its signature and each entry's proof checked, as the ballot hashes it complains about. */
    function sentBatch(h: Harness, i: number, held: readonly ReturnType<typeof ballotOf>[]) {
      const sent = h.sent[i]!;
      expect(sent.cutoff).toBe(C_K);
      const batch = decodeShareComplaintBatch(unhex(sent.record), 1);
      expect(
        verifyStatement(
          identityKey(electionFor(2).signingSecret),
          "abolish/v1/sig/share-complaint-batch",
          shareComplaintBatchStatement(batch),
          batch.signature,
        ),
      ).toBe(true);
      for (const c of batch.complaints) {
        const ballot = held.find((b) => hex(b.hash) === hex(c.ballot_hash))!;
        // Its proof checks against the ballot's own posted ciphertext, whichever it is.
        expect(
          [BAD, SEAL].map(
            (p) =>
              checkComplaint(
                { definitionHash: DEFINITION },
                2,
                keyPair(2).publicKey,
                ballot.vote.vss,
                ballot.vote.share_hashes,
                { ciphertext: p.ciphertext, m: p.m },
                c.proof,
              ).ok,
          ),
        ).toContain(true);
      }
      return batch.complaints.map((c) => hex(c.ballot_hash));
    }

    test("complains about a failing posting of a ballot withheld from its view, held from its sources (T-54)", async () => {
      // The seat attested no extent, so its view held none of the board's
      // ballots; the contract's record of this one is in its sources now.
      const withheld = ballotOf("bad-share", 160n);
      const h = harness(2, []);
      h.postings = [postingOf(BAD, withheld)];
      h.ballots = [withheld.record];
      expect(await h.duty().step()).toEqual({
        state: "outside-sent",
        batches: 1,
        recorded: 0,
        total: 1,
      });
      expect(sentBatch(h, 0, [withheld])).toEqual([hex(withheld.hash)]);
      expect(await h.store.list(DELIVERIES)).toEqual(["complaints", "complaints-outside"]);
      // Stored once: a restart over a source that no longer gives the ballot resends the same bytes.
      h.ballots = [];
      expect((await h.duty().step()).state).toBe("outside-sent");
      expect(h.sent[1]).toEqual(h.sent[0]);
      h.recorded = [unhex(h.sent[0]!.record)];
      expect(await h.duty().step()).toEqual(done(0, 1));
      expect(h.sent).toHaveLength(2);
    });

    test("sends nothing outside its scope until every batch it owes is recorded", async () => {
      const owed = ballotOf("bad-share", 160n);
      const withheld = ballotOf("bad-share", 160n, 1n);
      const h = harness(2, [owed.copy]);
      h.postings = [postingOf(BAD, owed), postingOf(BAD, withheld)];
      h.ballots = [owed.record, withheld.record];
      expect(await h.duty().step()).toEqual({ state: "sent", batches: 1, recorded: 0, total: 1 });
      expect(await h.duty().step()).toEqual({ state: "sent", batches: 1, recorded: 0, total: 1 });
      expect(await h.store.list(DELIVERIES)).toEqual(["complaints"]);
      expect(h.sent.map((x) => sentBatch({ ...h, sent: [x] }, 0, [owed]))).toEqual([
        [hex(owed.hash)],
        [hex(owed.hash)],
      ]);
      h.recorded = [unhex(h.sent[0]!.record)];
      expect(await h.duty().step()).toEqual({
        state: "outside-sent",
        batches: 1,
        recorded: 0,
        total: 1,
      });
      expect(sentBatch(h, 2, [withheld])).toEqual([hex(withheld.hash)]);
    });

    test("never complains about a ballot it receipted, one of its view or one in its scope", async () => {
      const receipted = ballotOf("bad-share", 160n);
      const superseded = ballotOf("bad-seal", 150n, 1n);
      const newer = ballotOf("plurality", 170n, 1n);
      const h = harness(2, [superseded.copy, newer.copy]);
      h.postings = [postingOf(BAD, receipted), postingOf(SEAL, superseded)];
      h.ballots = [receipted.record, superseded.record, newer.record];
      // Decided at `c_I` before the postings are in, then shown receipted,
      // as above.
      h.now = POSTINGS_RECORDED;
      expect((await h.duty().step()).state).toBe("waiting-postings");
      await h.store.putOnce(
        `intake/${"51".repeat(32)}/${hex(receipted.hash)}`,
        new Uint8Array([1]),
      );
      h.now = POSTINGS_RECORDED + 1n;
      expect(await h.duty().step()).toEqual(done(0));
      expect(h.sent).toEqual([]);
    });

    test("spends its budget one ballot per voter a round, each voter's newest first (T-52)", async () => {
      // Voter 0 posts against two ballots of its own; voter 1 against one.
      const older = ballotOf("bad-seal", 150n);
      const newest = ballotOf("bad-share", 170n);
      const other = ballotOf("bad-share", 160n, 1n);
      const all = [older, newest, other];
      const run = async (outside: number | undefined) => {
        const h = harness(2, []);
        h.postings = [postingOf(SEAL, older), postingOf(BAD, newest), postingOf(BAD, other)];
        h.ballots = all.map((b) => b.record);
        const status = await h.duty(undefined, outside).step();
        return { status, sent: h.sent.length === 0 ? [] : sentBatch(h, 0, all) };
      };
      const first = [hex(newest.hash), hex(other.hash)].sort()[0]!;
      expect((await run(1)).sent).toEqual([first]);
      expect((await run(2)).sent.sort()).toEqual([hex(newest.hash), hex(other.hash)].sort());
      expect((await run(undefined)).sent.sort()).toEqual(all.map((b) => hex(b.hash)).sort());
      expect(await run(0)).toEqual({ status: done(0), sent: [] });
    });

    test("past t_K sends nothing more, and a batch outside the scope never recorded is no alarm", async () => {
      const withheld = ballotOf("bad-share", 160n);
      const h = harness(2, []);
      h.postings = [postingOf(BAD, withheld)];
      h.ballots = [withheld.record];
      await h.duty().step();
      h.now = T_K + 1n;
      expect(await h.duty().step()).toEqual(done(0, 1, 1));
      expect(h.sent).toHaveLength(1);
      // Never decided by `t_K`: nothing is decided past it.
      const late = harness(2, []);
      late.postings = h.postings;
      late.ballots = h.ballots;
      late.now = T_K + 1n;
      expect(await late.duty().step()).toEqual(done(0));
      expect(await late.store.list(DELIVERIES)).toEqual(["complaints"]);
    });

    test("whatever it holds and its budget, it complains only about failing postings in time outside its view, at most its budget and one per voter before a second (T-52, T-15)", async () => {
      const candidates = [
        { b: ballotOf("bad-share", 160n, 1n), p: BAD, fails: true },
        { b: ballotOf("bad-seal", 150n, 1n), p: SEAL, fails: true },
        { b: ballotOf("bad-share", 160n, 2n), p: BAD, fails: true },
        { b: ballotOf("plurality", 160n, 3n), p: posted("plurality", 2), fails: false },
        { b: ballotOf("bad-seal", 160n, 4n), p: SEAL, fails: true },
      ];
      await fc.assert(
        fc.asyncProperty(
          fc.subarray([0, 1, 2, 3, 4]),
          fc.subarray([0, 1, 2, 3, 4]),
          fc.subarray([0, 1, 2, 3, 4]),
          fc.nat({ max: 4 }),
          async (held, late, viewed, outside) => {
            const h = harness(
              2,
              viewed.map((i) => candidates[i]!.b.copy),
            );
            h.postings = candidates.map((c, i) =>
              postingOf(c.p, c.b, late.includes(i) ? T_D + 1n : T_D),
            );
            h.ballots = held.map((i) => candidates[i]!.b.record);
            // Past the wait for a scope ballot its sources don't give.
            h.now = C_K - RELEASE_WINDOWS.margin;
            // The scope's own complaints first, recorded once sent: what
            // comes after is outside the scope.
            const duty = h.duty(undefined, outside);
            let status = await duty.step();
            if (status.state === "sent") {
              h.recorded = h.sent.map((x) => unhex(x.record));
              h.sent.length = 0;
              status = await duty.step();
            }
            expect(["recorded", "outside-sent"]).toContain(status.state);
            const eligible = candidates.filter(
              (c, i) => c.fails && held.includes(i) && !late.includes(i) && !viewed.includes(i),
            );
            const all = candidates.map((c) => c.b);
            const sent = h.sent.length === 0 ? [] : sentBatch(h, 0, all);
            expect(h.sent.length).toBeLessThanOrEqual(1);
            expect(sent.length).toBe(Math.min(outside, eligible.length));
            for (const s of sent) expect(eligible.map((c) => hex(c.b.hash))).toContain(s);
            // Voter 1 has two eligible ballots: its second comes only once every other voter has one.
            const voters = new Set(
              eligible.map((c) => decodeBallot(c.b.record, 1).nullifier.toString()),
            );
            const ones = sent.map((s) =>
              decodeBallot(
                eligible.find((c) => hex(c.b.hash) === s)!.b.record,
                1,
              ).nullifier.toString(),
            );
            expect(new Set(ones).size).toBe(Math.min(sent.length, voters.size));
          },
        ),
        { numRuns },
      );
    });
  });
});
