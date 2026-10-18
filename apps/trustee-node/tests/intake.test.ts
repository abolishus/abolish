import {
  ballotHash,
  batchShareReceipts,
  checkShareReceipt,
  decodeShareReceipt,
  decodeShareReceiptBatch,
  deliveryDeadlines,
  electionDefinitionHash,
  encodeBallot,
  encodeShareReceiptBatch,
  type FinalizedL1,
  L1_REF_MARGIN,
  membershipMessage,
  shareReceiptBatchStatement,
  verifyStatement,
  type ViewBallot,
} from "@abolishus/crypto";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import {
  type ApprovedElection,
  CeremonySeat,
  decideObligation,
  encodeDelivery,
  IntakeSeat,
  type ObligationStatus,
  type ObligationView,
  ReceiptDuty,
  type ReceiptPath,
  type SeatStore,
  serveIntake,
} from "../src/index.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import { election, L2_CHAIN_ID, TRUSTEE_REGISTRY } from "./fixture.ts";

import { cast, castAgain, type Cast, seatsOf, setup, type Setup, TIER } from "./ballots.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

let s: Setup;
let honest: Cast;

beforeAll(async () => {
  s = await setup();
  honest = await cast(s, 0, 1);
}, 120_000);

describe("intake", () => {
  it("receipts a member's ballot at every seat, under the seat's registered signing key", async () => {
    const seats = seatsOf(s);
    for (const [i, seat] of seats.intake.entries()) {
      const out = await seat.intake(
        s.e.stubBytes,
        s.transcript,
        honest.bytes,
        honest.ciphertexts[i] as Uint8Array,
      );
      if (!out.ok) expect.fail(`seat ${i + 1} refused: ${out.code}`);
      const receipt = decodeShareReceipt(out.receipt, 1);
      expect(receipt.seat).toBe(i + 1);
      expect(hex(receipt.definition_hash)).toBe(hex(electionDefinitionHash(s.definition)));
      expect(
        checkShareReceipt(
          s.registered,
          {
            definitionHash: s.election.definitionHash,
            tier: TIER,
            nullifier: honest.record.nullifier,
          },
          honest.record.committed_vote,
          i + 1,
          receipt.signature,
        ),
      ).toBe(true);
      expect((await seat.receipted(s.e.stubHash)).map(hex)).toEqual([hex(out.ballotHash)]);
    }
    // The registration check is asked about the definition and the key set the seat approved.
    expect(seats.registrations.map((r) => hex(r.definitionHash))).toEqual(
      Array(3).fill(hex(electionDefinitionHash(s.definition))),
    );
  });

  it("gives the same receipt again for the same delivery, after a restart too", async () => {
    const first = await seatsOf(s).intake[0]!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    // A new node process over the same store: its ceremony seat and intake both restart.
    const restarted = s.e.seats.map(
      (_, i) =>
        new CeremonySeat({
          panel: s.e.panelists.panel,
          l2ChainId: L2_CHAIN_ID,
          trusteeRegistry: TRUSTEE_REGISTRY,
          index: i + 1,
          identitySecret: s.e.panelists.secrets[i] as Uint8Array,
          electorate: () => Promise.resolve(true),
          store: s.stores[i] as SeatStore,
        }),
    );
    const again = await seatsOf(s, {}, restarted).intake[0]!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(first.ok && again.ok).toBe(true);
    if (first.ok && again.ok) expect(hex(again.receipt)).toBe(hex(first.receipt));
    expect(await s.stores[0]!.list(`intake/${hex(s.e.stubHash)}`)).toHaveLength(1);
  });

  it("keeps every L1 reference a receipted ballot was delivered under (T-25, T-54)", async () => {
    const store = new MemoryStore();
    const [seat] = seatsOf(s, { store }).intake;
    const recast = await castAgain(s, 0, honest, {
      number: 101n,
      hash: new Uint8Array(32).fill(8),
    });
    const first = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    const second = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      recast.bytes,
      recast.ciphertexts[0] as Uint8Array,
    );
    if (!first.ok || !second.ok) expect.fail("an honest delivery was refused");
    // One public part: the same ballot hash and the same receipt.
    expect(hex(second.receipt)).toBe(hex(first.receipt));
    expect(await store.list(`intake/${hex(s.e.stubHash)}`)).toEqual([hex(first.ballotHash)]);
    expect(await store.list(`copies/${hex(s.e.stubHash)}/${hex(first.ballotHash)}`)).toEqual([
      `100-${"07".repeat(32)}`,
      `101-${"08".repeat(32)}`,
    ]);
  });

  it("stores and signs nothing for a delivery that finishes at the cutoff (T-54)", async () => {
    const store = new MemoryStore();
    const times = [s.cutoff - 1n, s.cutoff];
    const [seat] = seatsOf(s, { store, now: () => times.shift() ?? s.cutoff }).intake;
    const out = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(out).toEqual({ ok: false, code: "intake-closed" });
    expect(await store.list(`intake/${hex(s.e.stubHash)}`)).toEqual([]);
  });

  it("refuses another seat's ciphertext and a malformed record, storing nothing", async () => {
    const stores = [new MemoryStore()];
    const [seat] = seatsOf(s, { store: stores[0] as SeatStore }).intake;
    const wrong = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[1] as Uint8Array,
    );
    expect(wrong).toEqual({ ok: false, code: "share-hash" });
    const cut = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes.subarray(0, honest.bytes.length - 1),
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(cut).toEqual({ ok: false, code: "delivery-malformed" });
    expect(await stores[0]!.list(`intake/${hex(s.e.stubHash)}`)).toEqual([]);
  });

  it("refuses a ballot whose membership proof doesn't verify (T-52)", async () => {
    const stores = [new MemoryStore()];
    const [seat] = seatsOf(s, { store: stores[0] as SeatStore }).intake;
    const proof = honest.record.membership_proof;
    const tampered = encodeBallot({
      ...honest.record,
      // Another L1 reference changes M, which the proof binds.
      l1_ref_number: honest.record.l1_ref_number + 1n,
      membership_proof: proof,
    });
    const out = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      tampered,
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(out).toEqual({ ok: false, code: "membership-proof" });
    expect(await stores[0]!.list(`intake/${hex(s.e.stubHash)}`)).toEqual([]);
  });
});

describe("the intake endpoint over a seat", () => {
  it("returns the receipt the seat gives in-process, and a refusal's code", async () => {
    const [seat] = seatsOf(s, { store: new MemoryStore() }).intake;
    const endpoint = await serveIntake(seat!, { host: "127.0.0.1", port: 0, queue: 4 });
    try {
      const body = (ciphertext: Uint8Array) =>
        Buffer.from(
          encodeDelivery({
            stub: s.e.stubBytes,
            transcript: s.transcript,
            record: honest.bytes,
            ciphertext,
          }),
        );
      const deliver = (ciphertext: Uint8Array) =>
        fetch(endpoint.url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: body(ciphertext),
        });
      const res = await deliver(honest.ciphertexts[0] as Uint8Array);
      expect(res.status).toBe(200);
      const direct = await seat!.intake(
        s.e.stubBytes,
        s.transcript,
        honest.bytes,
        honest.ciphertexts[0] as Uint8Array,
      );
      if (!direct.ok) expect.fail(direct.code);
      expect(hex(new Uint8Array(await res.arrayBuffer()))).toBe(hex(direct.receipt));
      const refused = await deliver(honest.ciphertexts[1] as Uint8Array);
      expect(refused.status).toBe(422);
      expect(await refused.text()).toBe("share-hash");
    } finally {
      await endpoint.close();
    }
  });
});

describe("the election's checks before intake", () => {
  const deliver = (seat: IntakeSeat, stubBytes = s.e.stubBytes, transcript = s.transcript) =>
    seat.intake(stubBytes, transcript, honest.bytes, honest.ciphertexts[0] as Uint8Array);

  it("refuses a stub the seat never approved", async () => {
    const other = election(3, 2);
    const [seat] = seatsOf(s).intake;
    expect(await deliver(seat!, other.stubBytes)).toEqual({ ok: false, code: "intake-unapproved" });
    expect(await deliver(seat!, new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      code: "intake-unapproved",
    });
  });

  it("refuses any transcript but the one the seat approved (T-37)", async () => {
    const [seat] = seatsOf(s).intake;
    const altered = Uint8Array.from(s.transcript);
    altered[altered.length - 1]! ^= 1;
    expect(await deliver(seat!, s.e.stubBytes, altered)).toEqual({
      ok: false,
      code: "intake-transcript",
    });
  });

  it("refuses until the electorate check passes, then takes the ballot", async () => {
    let decided = false;
    const [seat] = seatsOf(s, {
      store: new MemoryStore(),
      electorate: () => Promise.resolve(decided),
    }).intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-definition" });
    decided = true;
    expect((await deliver(seat!)).ok).toBe(true);
  });

  it("refuses until finalized L2 shows the definition registered", async () => {
    let decided = false;
    const [seat] = seatsOf(s, {
      store: new MemoryStore(),
      registration: () => Promise.resolve(decided),
    }).intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-unregistered" });
    decided = true;
    expect((await deliver(seat!)).ok).toBe(true);
  });

  it("refuses an election whose pins this node doesn't hold", async () => {
    const [seat] = seatsOf(s, { l2ChainId: L2_CHAIN_ID + 1n }).intake;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-definition" });
  });

  it("stays open until the intake cutoff and refuses from it on (T-54)", async () => {
    const seats = seatsOf(s, { store: new MemoryStore() });
    const [seat] = seats.intake;
    seats.clock = s.cutoff - 1n;
    expect((await deliver(seat!)).ok).toBe(true);
    seats.clock = s.cutoff;
    expect(await deliver(seat!)).toEqual({ ok: false, code: "intake-closed" });
  });
});

describe("the obligation decided at the intake cutoff", () => {
  // Finalized L1 with 12-second blocks: block 100, which the casts name, is the
  // first at `opens_at − L1_REF_MARGIN`, and the head is the first after
  // `closes_at`. Block `n` hashes to `n` repeated, but 100 and 101 to the
  // casts' 0x07 and 0x08 unless `reorged`.
  const l1Of = (closedAt: bigint, reorged = false): FinalizedL1 => {
    const start = s.e.stub.opens_at - L1_REF_MARGIN - 100n * 12n;
    const head = (closedAt - start) / 12n + 1n;
    return {
      head,
      block(n) {
        const fill = reorged ? 0xee : n === 100n ? 0x07 : n === 101n ? 0x08 : Number(n % 256n);
        return { hash: new Uint8Array(32).fill(fill), timestamp: start + n * 12n };
      },
    };
  };
  const SEGMENT = 50n;
  const viewOf = (change: Partial<ObligationView> = {}): ObligationView => ({
    l1: l1Of(s.e.stub.closes_at),
    low: 0n,
    board: [],
    boardSegment: SEGMENT,
    absent: [],
    ...change,
  });
  /** A board copy for voter `v`'s nullifier under another ballot hash, as a newer ballot the seat never receipted. */
  const boardCopy = (nullifier: bigint, l1RefNumber: bigint, fill: number): ViewBallot => {
    const ballotHash = new Uint8Array(32).fill(fill);
    const l1RefHash = new Uint8Array(32).fill(Number(l1RefNumber % 256n));
    return {
      ballotHash,
      tier: TIER,
      nullifier,
      message: membershipMessage({
        definitionHash: s.election.definitionHash,
        tier: TIER,
        ballotHash,
        l1RefNumber,
        l1RefHash,
      }),
      l1RefNumber,
      l1RefHash,
      entry: { path: "board", value: SEGMENT },
    };
  };

  async function receipted(store: SeatStore, ...casts: Cast[]) {
    const seats = seatsOf(s, { store });
    for (const c of casts) {
      const out = await seats.intake[0]!.intake(
        s.e.stubBytes,
        s.transcript,
        c.bytes,
        c.ciphertexts[0] as Uint8Array,
      );
      if (!out.ok) expect.fail(out.code);
    }
    const approved = await s.e.seats[0]!.approvedElection(s.e.stubHash);
    if (approved === undefined) expect.fail("the seat approved the stub");
    return { seats, approved };
  }

  const options = (store: SeatStore, view: ObligationView, now = s.cutoff) => ({
    store,
    view: () => Promise.resolve(view),
    now: () => now,
  });
  const hashes = (status: ObligationStatus) =>
    status.state === "decided"
      ? { receipts: status.receipts.map(hex), complaints: status.complaints.map(hex) }
      : status;
  const honestHash = () =>
    hex(
      ballotHash(
        {
          definitionHash: s.election.definitionHash,
          tier: TIER,
          nullifier: honest.record.nullifier,
        },
        honest.record.committed_vote,
      ),
    );

  it("decides nothing while intake is open, then owes the receipt of the ballot it receipted", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    expect(await decideObligation(options(store, viewOf(), s.cutoff - 1n), approved)).toEqual({
      state: "open",
      until: s.cutoff,
    });
    expect(hashes(await decideObligation(options(store, viewOf()), approved))).toEqual({
      receipts: [honestHash()],
      complaints: [honestHash()],
    });
    expect(approved.members).toBe(3n);
  });

  it("waits for finalized L1 past the close", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    const early = viewOf({ l1: l1Of(s.e.stub.closes_at - 12n) });
    expect(await decideObligation(options(store, early), approved)).toEqual({
      state: "waiting-l1",
    });
    expect(await store.list("obligations")).toEqual([]);
  });

  it("decides once: a view that changes later changes nothing it owes (T-52, T-54)", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    const first = await decideObligation(options(store, viewOf()), approved);
    const newer = boardCopy(honest.record.nullifier, 110n, 0xb1);
    const later = viewOf({ board: [newer] });
    expect(await decideObligation(options(store, later, s.cutoff + 3600n), approved)).toEqual(
      first,
    );
    // A decision taken over the later view would have owed nothing.
    expect(hashes(await decideObligation(options(new MemoryStore(), later), approved))).toEqual({
      receipts: [],
      complaints: [hex(newer.ballotHash)],
    });
  });

  it("owes nothing for a ballot a newer one on the board supersedes, which it complains over", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    const newer = boardCopy(honest.record.nullifier, 110n, 0xb1);
    const other = boardCopy(123n, 105n, 0xc1);
    const status = await decideObligation(
      options(store, viewOf({ board: [newer, other] })),
      approved,
    );
    expect(hashes(status)).toEqual({
      receipts: [],
      complaints: [hex(newer.ballotHash), hex(other.ballotHash)].sort(),
    });
  });

  it("drops a ballot it shows absent from the view, but a copy boarded late doesn't displace it", async () => {
    const absentStore = new MemoryStore();
    const a = await receipted(absentStore, honest);
    const absent = viewOf({ absent: [Buffer.from(honestHash(), "hex")] });
    expect(hashes(await decideObligation(options(absentStore, absent), a.approved))).toEqual({
      receipts: [],
      complaints: [],
    });
    const lateStore = new MemoryStore();
    const b = await receipted(lateStore, honest);
    const late = {
      ...boardCopy(honest.record.nullifier, 110n, 0xb1),
      entry: { path: "board" as const, value: SEGMENT + 1n },
    };
    expect(
      hashes(await decideObligation(options(lateStore, viewOf({ board: [late] })), b.approved)),
    ).toEqual({
      receipts: [honestHash()],
      complaints: [honestHash()],
    });
  });

  it("owes the receipt of a ballot whose block was reorganised away, once per voter (T-25)", async () => {
    const store = new MemoryStore();
    const recast = await castAgain(s, 0, honest, {
      number: 101n,
      hash: new Uint8Array(32).fill(8),
    });
    const { approved } = await receipted(store, honest, recast);
    const view = viewOf({ l1: l1Of(s.e.stub.closes_at, true) });
    expect(hashes(await decideObligation(options(store, view), approved))).toEqual({
      receipts: [honestHash()],
      complaints: [honestHash()],
    });
  });

  it("refuses a view that holds a ballot shown absent from the board, and an obligation over 2M", async () => {
    const store = new MemoryStore();
    const { approved } = await receipted(store, honest);
    const copy = boardCopy(7n, 105n, 0xd1);
    await expect(
      decideObligation(
        options(store, viewOf({ board: [copy], absent: [copy.ballotHash] })),
        approved,
      ),
    ).rejects.toThrow("shown absent");
    // Three members: a view naming seven voters' ballots holds copies no member made.
    const flood = Array.from({ length: 7 }, (_, i) => boardCopy(BigInt(1000 + i), 105n, 0xe0 + i));
    await expect(
      decideObligation(options(store, viewOf({ board: flood })), approved),
    ).rejects.toThrow("bound of 2M");
    expect(await store.list("obligations")).toEqual([]);
  });

  it("gives no receipt for a delivery whose records become durable at the cutoff", async () => {
    const store = new MemoryStore();
    const times = [s.cutoff - 1n, s.cutoff - 1n, s.cutoff];
    const [seat] = seatsOf(s, { store, now: () => times.shift() ?? s.cutoff }).intake;
    const out = await seat!.intake(
      s.e.stubBytes,
      s.transcript,
      honest.bytes,
      honest.ciphertexts[0] as Uint8Array,
    );
    expect(out).toEqual({ ok: false, code: "intake-closed" });
  });

  describe("the receipts it owes, sent as batches by c_D (part 4b-2b-1)", () => {
    const BATCH_TAG = "abolish/v1/sig/share-receipt-batch";
    const deadline = () =>
      deliveryDeadlines(s.e.stub.closes_at, BigInt(s.e.stub.l1_inclusion_bound)).delivery;

    /** A board contract path that records what `record` lets through. */
    const contract = (record: (batch: Uint8Array) => boolean = () => false) => {
      const sent: { batch: string; cutoff: bigint }[] = [];
      const recorded: Uint8Array[] = [];
      const path: ReceiptPath = {
        send: async (batch, cutoff) => {
          sent.push({ batch: hex(batch), cutoff });
          if (record(batch)) recorded.push(batch);
        },
        recorded: async (definitionHash, seat) => {
          expect(hex(definitionHash)).toBe(hex(s.election.definitionHash));
          expect(seat).toBe(1);
          return recorded;
        },
      };
      return { path, sent, recorded };
    };
    const duty = (
      store: SeatStore,
      approved: ApprovedElection,
      path: ReceiptPath,
      view = viewOf(),
      now = s.cutoff,
    ) => new ReceiptDuty({ ...options(store, view, now), election: approved, contract: path });

    /** The share hash seat 1's receipt of the honest ballot names. */
    const honestShareHash = async (store: SeatStore) => {
      const out = await seatsOf(s, { store }).intake[0]!.intake(
        s.e.stubBytes,
        s.transcript,
        honest.bytes,
        honest.ciphertexts[0] as Uint8Array,
      );
      if (!out.ok) expect.fail(out.code);
      return hex(decodeShareReceipt(out.receipt, 1).share_hash);
    };

    it("owes nothing while intake is open, then signs the owed receipt as one batch under the seat's key and sends it by c_D", async () => {
      const store = new MemoryStore();
      const shareHash = await honestShareHash(store);
      const { approved } = await receipted(store, honest);
      const c = contract();
      expect(await duty(store, approved, c.path, viewOf(), s.cutoff - 1n).step()).toEqual({
        state: "open",
        until: s.cutoff,
      });
      expect(c.sent).toEqual([]);
      const d = duty(store, approved, c.path);
      expect(d.cutoff).toBe(deadline() - RELEASE_WINDOWS.forcedInclusion);
      expect(d.cutoff - s.cutoff).toBe(RELEASE_WINDOWS.margin);
      expect(await d.step()).toEqual({ state: "sent", batches: 1, recorded: 0, total: 1 });
      expect(c.sent).toHaveLength(1);
      expect(c.sent[0]?.cutoff).toBe(d.cutoff);
      const batch = decodeShareReceiptBatch(Buffer.from(c.sent[0]!.batch, "hex"), 1);
      expect(batch.seat).toBe(1);
      expect(hex(batch.definition_hash)).toBe(hex(s.election.definitionHash));
      expect(batch.receipts.map((p) => [hex(p.ballot_hash), hex(p.share_hash)])).toEqual([
        [honestHash(), shareHash],
      ]);
      const key = s.registered.find((k) => k.index === 1)?.signingKey;
      if (key === undefined) expect.fail("seat 1 is registered");
      expect(
        verifyStatement(key, BATCH_TAG, shareReceiptBatchStatement(batch), batch.signature),
      ).toBe(true);
    });

    it("resends the stored batch until it is recorded, then stops", async () => {
      const store = new MemoryStore();
      const { approved } = await receipted(store, honest);
      let take = false;
      const c = contract(() => take);
      expect((await duty(store, approved, c.path).step()).state).toBe("sent");
      expect((await duty(store, approved, c.path).step()).state).toBe("sent");
      take = true;
      expect(await duty(store, approved, c.path).step()).toEqual({
        state: "sent",
        batches: 1,
        recorded: 0,
        total: 1,
      });
      expect(await duty(store, approved, c.path).step()).toEqual({ state: "recorded", total: 1 });
      expect(c.sent).toHaveLength(3);
      expect(new Set(c.sent.map((x) => x.batch)).size).toBe(1);
    });

    it("signs once: a restart, a later view and a later clock resend the same bytes (T-52, T-54)", async () => {
      const store = new MemoryStore();
      const { approved } = await receipted(store, honest);
      const c = contract();
      await duty(store, approved, c.path).step();
      // A view that would owe nothing, read after the decision.
      const later = viewOf({ board: [boardCopy(honest.record.nullifier, 110n, 0xb1)] });
      await duty(store, approved, c.path, later, s.cutoff + 3_600n).step();
      expect(c.sent).toHaveLength(2);
      expect(c.sent[1]?.batch).toBe(c.sent[0]?.batch);
    });

    it("counts a batch recorded only as the stored bytes: another batch of the seat's doesn't stop it", async () => {
      const store = new MemoryStore();
      const { approved } = await receipted(store, honest);
      const c = contract();
      const [foreign] = batchShareReceipts(approved.signingSecret, approved.definitionHash, 1, [
        { ballot_hash: new Uint8Array(32).fill(0x55), share_hash: new Uint8Array(32) },
      ]);
      c.recorded.push(encodeShareReceiptBatch(foreign!));
      expect(await duty(store, approved, c.path).step()).toEqual({
        state: "sent",
        batches: 1,
        recorded: 0,
        total: 1,
      });
    });

    it("owes nothing and sends nothing when the view supersedes every receipted ballot", async () => {
      const store = new MemoryStore();
      const { approved } = await receipted(store, honest);
      const c = contract();
      const view = viewOf({ board: [boardCopy(honest.record.nullifier, 110n, 0xb1)] });
      expect(await duty(store, approved, c.path, view).step()).toEqual({
        state: "recorded",
        total: 0,
      });
      expect(c.sent).toEqual([]);
    });

    it("stops sending past t_D, reporting the batch it never saw recorded", async () => {
      const store = new MemoryStore();
      const { approved } = await receipted(store, honest);
      const c = contract();
      await duty(store, approved, c.path).step();
      expect((await duty(store, approved, c.path, viewOf(), deadline()).step()).state).toBe("sent");
      expect(await duty(store, approved, c.path, viewOf(), deadline() + 1n).step()).toEqual({
        state: "unrecorded",
        missing: 1,
        total: 1,
      });
      expect(c.sent).toHaveLength(2);
    });

    it("passes waiting on L1 through, storing nothing, and a send that fails leaves the batch to resend", async () => {
      const store = new MemoryStore();
      const { approved } = await receipted(store, honest);
      const c = contract();
      const early = viewOf({ l1: l1Of(s.e.stub.closes_at - 12n) });
      expect(await duty(store, approved, c.path, early).step()).toEqual({ state: "waiting-l1" });
      expect(await store.list("deliveries")).toEqual([]);
      const failing: ReceiptPath = {
        ...c.path,
        send: () => Promise.reject(new Error("unsent")),
      };
      await expect(duty(store, approved, failing).step()).rejects.toThrow("unsent");
      expect(await duty(store, approved, c.path).step()).toEqual({
        state: "sent",
        batches: 1,
        recorded: 0,
        total: 1,
      });
    });
  });
});
