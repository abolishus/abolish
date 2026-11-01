// The seat's own board-path copies of the receipts it gave
// (docs/spec/delivery.md, Client rules; Boarding): every receipt goes to the
// operator until an answer carries it; a refusal for a ballot not yet on the
// board, or an election not taking receipts, waits `retryAfter`; any other
// refusal waits `resendAfter` and is counted as an alarm; an answer that
// doesn't carry the receipt, or an operator that can't answer, is asked
// again next step, so the operator's word only paces the sending (T-25,
// T-53). Under a board-entry version that can't carry `0x000c`, nothing is
// sent.
import {
  type BoardEntryVersion,
  encodeBoardEntry,
  encodeShareReceipt,
  encodeShareReceiptV2,
  type ShareReceiptRecord,
  type ShareReceiptRecordV2,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import type { ApprovedElectionInfo } from "../src/ceremony.ts";
import { RESEND_AFTER } from "../src/opening-sender.ts";
import type { OperatorAnswer, ReceiptOperator } from "../src/operator.ts";
import {
  RECEIPTS_PER_STEP,
  type ReceiptCopySenderOptions,
  ReceiptCopySender,
  RETRY_AFTER,
} from "../src/receipt-copies.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const ELECTION_ID = new Uint8Array(32).fill(7);
const DEFINITION = new Uint8Array(32).fill(9);
const ELECTION = { electionId: ELECTION_ID, index: 2 } as ApprovedElectionInfo;
// A board-entry version that allows `0x000c`, and `0x000f` beside it.
const BOARD: BoardEntryVersion = 4;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** Seat 2's receipt for ballot `n`, its signature `r ‖ s` both in range and low. */
const fieldsOf = (n: number, over: Partial<ShareReceiptRecord> = {}): ShareReceiptRecord => ({
  definition_hash: DEFINITION,
  ballot_hash: new Uint8Array(32).fill(n),
  seat: 2,
  share_hash: new Uint8Array(32).fill(0x50 + n),
  signature: new Uint8Array(64).fill(1),
  ...over,
});
const receiptOf = (n: number, over: Partial<ShareReceiptRecord> = {}) =>
  encodeShareReceipt(fieldsOf(n, over));
/** The same statement in other bytes, as another nonce, or `s`'s other form, would sign it. */
const resigned = (n: number) => receiptOf(n, { signature: new Uint8Array(64).fill(2) });
const givenOf = (ns: number[]) =>
  ns.map((n) => ({ ballot: hex(new Uint8Array(32).fill(n)), receipt: receiptOf(n) }));
const entryOf = (payload: Uint8Array, version: BoardEntryVersion = BOARD) =>
  encodeBoardEntry({ election_id: ELECTION_ID, index: 3n, segment: 4, payload }, version);

/** An operator answering each request from `answer`, recording what was sent. */
function operator(answer: (receipt: Uint8Array) => OperatorAnswer) {
  const sent: { electionId: Uint8Array; receipt: Uint8Array }[] = [];
  const op: ReceiptOperator = {
    submitReceipt: async (electionId, receipt) => {
      sent.push({ electionId, receipt });
      return answer(receipt);
    },
  };
  return { op, sent };
}

function sender(
  given: { receipts: ReturnType<typeof givenOf> },
  op: ReceiptOperator,
  world: { now: bigint },
  options: Partial<ReceiptCopySenderOptions> = {},
) {
  return new ReceiptCopySender({
    election: ELECTION,
    boardVersion: BOARD,
    receipts: async () => given.receipts,
    operator: op,
    clock: () => world.now,
    ...options,
  });
}

const boarded = (receipt: Uint8Array, earlier = false): OperatorAnswer => ({
  state: "boarded",
  entry: entryOf(receipt),
  earlier,
});
const missingBallot: OperatorAnswer = { state: "rejected", code: "receipt-ballot" };
const sending = (given: number, boarded: number, refused = 0) => ({
  state: "sending",
  given,
  boarded,
  refused,
});

describe("ReceiptCopySender", () => {
  test("sends every receipt the seat gave for its election, and none again once an answer carries it", async () => {
    const { op, sent } = operator((r) => boarded(r));
    const given = { receipts: givenOf([1, 2]) };
    const s = sender(given, op, { now: 10n });
    expect(await s.step()).toEqual(sending(2, 2));
    expect(sent.map((x) => x.receipt)).toEqual([receiptOf(1), receiptOf(2)]);
    expect(sent.every((x) => x.electionId === ELECTION_ID)).toBe(true);
    expect(await s.step()).toEqual(sending(2, 2));
    expect(sent).toHaveLength(2);
    // A receipt given since is sent at the next step.
    given.receipts = givenOf([1, 2, 3]);
    expect(await s.step()).toEqual(sending(3, 3));
    expect(sent.map((x) => x.receipt)).toEqual([receiptOf(1), receiptOf(2), receiptOf(3)]);
  });

  test("sends nothing and reports unboardable under a board-entry version without 0x000c", async () => {
    const { op, sent } = operator((r) => boarded(r));
    for (const version of [1] as BoardEntryVersion[]) {
      const s = sender({ receipts: givenOf([1]) }, op, { now: 0n }, { boardVersion: version });
      expect(await s.step()).toEqual({ state: "unboardable" });
    }
    expect(sent).toHaveLength(0);
  });

  test.each([
    ["its ballot isn't on the board yet", missingBallot],
    ["the operator takes no receipt of the election now", { state: "not-open" } as OperatorAnswer],
  ])("waits RETRY_AFTER before sending again when %s", async (_, answer) => {
    let first = true;
    const { op, sent } = operator((r) => {
      if (first) {
        first = false;
        return answer;
      }
      return boarded(r);
    });
    const world = { now: 100n };
    const s = sender({ receipts: givenOf([1]) }, op, world);
    expect(await s.step()).toEqual(sending(1, 0));
    world.now += RETRY_AFTER - 1n;
    expect(await s.step()).toEqual(sending(1, 0));
    expect(sent).toHaveLength(1);
    world.now += 1n;
    expect(await s.step()).toEqual(sending(1, 1));
    expect(sent).toHaveLength(2);
  });

  test("counts any other refusal as an alarm and waits RESEND_AFTER before sending again", async () => {
    const { op, sent } = operator(() => ({ state: "rejected", code: "share-receipt" }));
    const world = { now: 0n };
    const s = sender({ receipts: givenOf([1, 2]) }, op, world);
    expect(await s.step()).toEqual(sending(2, 0, 2));
    world.now += RESEND_AFTER - 1n;
    expect(await s.step()).toEqual(sending(2, 0, 2));
    expect(sent).toHaveLength(2);
    world.now += 1n;
    await s.step();
    expect(sent).toHaveLength(4);
  });

  test("ends the step at an operator that can't answer, and asks again next step", async () => {
    let down = true;
    const { op, sent } = operator((r) =>
      down ? { state: "unavailable", reason: "unreached (ECONNREFUSED)" } : boarded(r),
    );
    const s = sender({ receipts: givenOf([1, 2, 3]) }, op, { now: 0n });
    expect(await s.step()).toEqual(sending(3, 0));
    expect(sent).toHaveLength(1);
    down = false;
    expect(await s.step()).toEqual(sending(3, 3));
    expect(sent.map((x) => x.receipt)).toEqual([
      receiptOf(1),
      receiptOf(1),
      receiptOf(2),
      receiptOf(3),
    ]);
  });

  test.each<[string, (r: Uint8Array) => OperatorAnswer]>([
    ["another ballot's receipt", () => boarded(receiptOf(9))],
    ["another ballot's receipt as earlier", () => boarded(receiptOf(9), true)],
    ["its own bytes claimed as earlier", (r) => boarded(r, true)],
    [
      "the same receipt from another seat as earlier",
      () => boarded(receiptOf(1, { seat: 3 }), true),
    ],
    [
      "another share hash as earlier",
      () => boarded(receiptOf(1, { share_hash: new Uint8Array(32).fill(0xee) }), true),
    ],
    [
      "another definition as earlier",
      () => boarded(receiptOf(1, { definition_hash: new Uint8Array(32).fill(0xdd) }), true),
    ],
    [
      "an entry under another board-entry version",
      (r) => ({ ...boarded(r), entry: entryOf(r, 3) }),
    ],
    ["bytes that aren't an entry", (r) => ({ ...boarded(r), entry: r })],
    [
      "an entry carrying something else as earlier",
      () => boarded(Uint8Array.of(0, 0x0f, 1, 9), true),
    ],
  ])("sends again next step when the operator answers with %s", async (_, answer) => {
    const { op, sent } = operator(answer);
    const s = sender({ receipts: givenOf([1]) }, op, { now: 0n });
    expect(await s.step()).toEqual(sending(1, 0));
    expect(await s.step()).toEqual(sending(1, 0));
    expect(sent).toHaveLength(2);
  });

  test("takes the same receipt in other bytes, answered as earlier, as carrying it", async () => {
    const { op, sent } = operator(() => boarded(resigned(1), true));
    const s = sender({ receipts: givenOf([1]) }, op, { now: 0n });
    expect(await s.step()).toEqual(sending(1, 1));
    await s.step();
    expect(sent).toHaveLength(1);
  });

  describe("in a rolling election, whose receipts are version 2 naming the panel", () => {
    const ROLLING = { ...ELECTION, rolling: true } as ApprovedElectionInfo;
    const v2Of = (n: number, over: Partial<ShareReceiptRecordV2> = {}) =>
      encodeShareReceiptV2({ ...fieldsOf(n), panel: 1, ...over });
    const givenV2 = [{ ballot: hex(new Uint8Array(32).fill(1)), receipt: v2Of(1) }];

    test("takes the same version-2 receipt in other bytes, answered as earlier, as carrying it", async () => {
      const { op, sent } = operator(() =>
        boarded(v2Of(1, { signature: new Uint8Array(64).fill(2) }), true),
      );
      const s = sender({ receipts: givenV2 }, op, { now: 0n }, { election: ROLLING });
      expect(await s.step()).toEqual(sending(1, 1));
      await s.step();
      expect(sent).toHaveLength(1);
    });

    test("takes its own bytes as carrying it", async () => {
      const { op } = operator((r) => boarded(r));
      const s = sender({ receipts: givenV2 }, op, { now: 0n }, { election: ROLLING });
      expect(await s.step()).toEqual(sending(1, 1));
    });

    test.each<[string, () => OperatorAnswer]>([
      [
        "the same receipt for the other panel",
        () => boarded(v2Of(1, { panel: 2, signature: new Uint8Array(64).fill(2) }), true),
      ],
      ["the same statement as a version-1 receipt", () => boarded(resigned(1), true)],
      ["another seat's", () => boarded(v2Of(1, { seat: 3 }), true)],
      [
        "another definition",
        () => boarded(v2Of(1, { definition_hash: new Uint8Array(32).fill(0xdd) }), true),
      ],
      ["another ballot", () => boarded(v2Of(9), true)],
      ["its own bytes claimed as earlier", () => boarded(v2Of(1), true)],
      [
        "another share hash",
        () => boarded(v2Of(1, { share_hash: new Uint8Array(32).fill(0xee) }), true),
      ],
    ])("sends again when answered as earlier with %s", async (_, answer) => {
      const { op, sent } = operator(answer);
      const s = sender({ receipts: givenV2 }, op, { now: 0n }, { election: ROLLING });
      expect(await s.step()).toEqual(sending(1, 0));
      await s.step();
      expect(sent).toHaveLength(2);
    });

    test("a fixed election's seat doesn't take a version-2 receipt as its own version-1 one", async () => {
      const { op } = operator(() => boarded(v2Of(1), true));
      const s = sender({ receipts: givenOf([1]) }, op, { now: 0n });
      expect(await s.step()).toEqual(sending(1, 0));
    });
  });

  test("sends at most perStep receipts a step, the rest at the next", async () => {
    const { op, sent } = operator((r) => boarded(r));
    const s = sender({ receipts: givenOf([1, 2, 3, 4, 5]) }, op, { now: 0n }, { perStep: 2 });
    expect(await s.step()).toEqual(sending(5, 2));
    expect(await s.step()).toEqual(sending(5, 4));
    expect(await s.step()).toEqual(sending(5, 5));
    expect(sent).toHaveLength(5);
    expect(RECEIPTS_PER_STEP).toBeGreaterThan(0);
  });

  test("whatever the operator answers, a step sends each receipt at most once and at most perStep in all, never one an answer carried, and none within its wait", async () => {
    const answers = fc.constantFrom<(r: Uint8Array) => OperatorAnswer>(
      (r) => boarded(r),
      (r) => boarded(r, true),
      () => boarded(receiptOf(9)),
      () => missingBallot,
      () => ({ state: "rejected", code: "share-receipt" }),
      () => ({ state: "not-open" }),
      () => ({ state: "unavailable", reason: "503" }),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.array(answers, { minLength: 1, maxLength: 8 }), fc.nat(700)), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.integer({ min: 1, max: 4 }),
        async (steps, perStep) => {
          const world = { now: 0n };
          let queue: ((r: Uint8Array) => OperatorAnswer)[] = [];
          const { op, sent } = operator((r) => {
            const next = queue.shift() ?? ((x: Uint8Array) => boarded(x));
            return next(r);
          });
          const s = sender({ receipts: givenOf([1, 2, 3, 4, 5]) }, op, world, { perStep });
          const carried = new Set<string>();
          const waitUntil = new Map<string, bigint>();
          for (const [script, advance] of steps) {
            queue = [...script];
            const before = sent.length;
            await s.step();
            const now = sent.slice(before);
            expect(now.length).toBeLessThanOrEqual(perStep);
            const names = now.map((x) => hex(x.receipt));
            expect(new Set(names).size).toBe(names.length);
            for (const name of names) {
              expect(carried.has(name)).toBe(false);
              expect(world.now >= (waitUntil.get(name) ?? 0n)).toBe(true);
            }
            // What each answer this step means for the next ones, replayed.
            const replay = [...script];
            for (const x of now) {
              const name = hex(x.receipt);
              const answer = (replay.shift() ?? ((y: Uint8Array) => boarded(y)))(x.receipt);
              if (
                answer.state === "boarded" &&
                hex(answer.entry) === hex(entryOf(x.receipt)) &&
                !answer.earlier
              )
                carried.add(name);
              else if (answer.state === "rejected" && answer.code === "receipt-ballot")
                waitUntil.set(name, world.now + RETRY_AFTER);
              else if (answer.state === "rejected") waitUntil.set(name, world.now + RESEND_AFTER);
              else if (answer.state === "not-open") waitUntil.set(name, world.now + RETRY_AFTER);
              else waitUntil.delete(name);
            }
            world.now += BigInt(advance);
          }
        },
      ),
      { numRuns },
    );
  });
});
