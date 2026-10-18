import fc from "fast-check";
import {
  type Anchor,
  copyCheckpoints,
  encodeBoardEntry,
  identityKey,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { concatBytes } from "@noble/hashes/utils.js";
import { expect, test } from "vite-plus/test";
import { segmentObjects } from "../src/blocks.ts";
import { word } from "../src/l1.ts";
import { tagged, taggedReviver } from "../src/verify.ts";
import {
  checkAtCast,
  dropIs,
  judge,
  type JudgeView,
  operatorReceipt,
  type ReceiptElection,
  verdictIs,
} from "../src/receipts.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 20);

// The fixture's clock: the ceremony in segment 1, ballots in 2, the seal 3.
const PERIOD = 3600n;
const DEADLINE = 43_200n;
const EPOCH = 36_000n;
const [FIRST, CAST, SEAL] = [1, 2, 3] as const;
const end = (s: number) => EPOCH + (BigInt(s) + 1n) * PERIOD;
const clock = { epoch: EPOCH, period: PERIOD, deadline: DEADLINE, lastSegment: SEAL };

const secret = new Uint8Array(32).fill(7);
const election: ReceiptElection = {
  electionId: new Uint8Array(32).fill(0xe1),
  boardEntryVersion: 1,
  receiptKeys: [identityKey(secret)],
  opensAt: end(FIRST),
};
// A record the anchor writes: registered an hour before the poll opens, never retired.
const registered = word(end(FIRST) - PERIOD);

/** A stand-in ballot record: the header the board reads, then `body`. */
const ballot = (body: Uint8Array) =>
  Uint8Array.of(RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 1, ...body);
const entry = (index: number, segment: number, payload: Uint8Array) =>
  encodeBoardEntry(
    { election_id: election.electionId, index: BigInt(index), segment, payload },
    election.boardEntryVersion,
  );

/** The board's anchors as the fixture anchors them: each segment's checkpoint, inside its window. */
function anchorsOf(entries: readonly Uint8Array[]): Anchor[] {
  const copies = copyCheckpoints(election.electionId, entries, [FIRST, CAST]);
  return [FIRST, CAST, SEAL].map((segment) => {
    const c = (segment >= CAST ? copies.get(CAST) : undefined) ?? copies.get(FIRST);
    if (c === undefined) throw new Error("no checkpoint");
    return { checkpoint: { ...c, segment }, anchoredAt: end(segment) + 60n };
  });
}

function viewOf(entries: readonly Uint8Array[], now = end(SEAL) + DEADLINE + 1n): JudgeView {
  return {
    words: [registered],
    now,
    anchors: anchorsOf(entries),
    clock,
    firstSegment: FIRST,
    sources: [concatBytes(...segmentObjects(entries).map((o) => o.hashes))],
  };
}

const bodies = fc.uniqueArray(fc.uint8Array({ minLength: 1, maxLength: 40 }), {
  minLength: 2,
  maxLength: 8,
  selector: (b) => Buffer.from(b).toString("hex"),
});

test("every honest receipt passes at cast and is included once its board is anchored", () => {
  fc.assert(
    fc.property(bodies, (bs) => {
      const entries = [entry(0, FIRST, ballot(Uint8Array.of(0)))];
      const signed = bs.map((b) => {
        const payload = ballot(b);
        entries.push(entry(entries.length, CAST, payload));
        return { payload, receipt: operatorReceipt(secret, election, entries, CAST) };
      });
      const view = viewOf(entries);
      for (const { payload, receipt } of signed) {
        expect(checkAtCast(election, receipt, payload, { min: CAST, max: SEAL })).toBe(true);
        expect(verdictIs("included", judge(election, receipt, payload, view))).toBe(true);
      }
    }),
    { numRuns },
  );
});

test("a receipt for a board shown with the voter's ballot moved earlier is forked from the copy", () => {
  fc.assert(
    fc.property(bodies, (bs) => {
      const payloads = bs.map(ballot);
      const entries = [
        entry(0, FIRST, ballot(Uint8Array.of(0))),
        ...payloads.map((p, i) => entry(i + 1, CAST, p)),
      ];
      // The last ballot shown at index 1, where the anchored board has the first.
      const last = payloads.at(-1) as Uint8Array;
      const fork = [entries[0] as Uint8Array, entry(1, CAST, last)];
      const receipt = operatorReceipt(secret, election, fork, CAST);
      expect(checkAtCast(election, receipt, last, { min: CAST, max: SEAL })).toBe(true);
      const v = judge(election, receipt, last, viewOf(entries));
      expect(verdictIs("forked-copy", v)).toBe(true);
      expect(verdictIs("included", v)).toBe(false);
    }),
    { numRuns },
  );
});

test("a receipt for a ballot shown appended but never anchored is forked from L1 alone", () => {
  fc.assert(
    fc.property(bodies, (bs) => {
      const [dropped, ...kept] = bs.map(ballot);
      const entries = [
        entry(0, FIRST, ballot(Uint8Array.of(0))),
        ...kept.map((p, i) => entry(i + 1, CAST, p)),
      ];
      const d = dropped as Uint8Array;
      const receipt = operatorReceipt(
        secret,
        election,
        [...entries, entry(entries.length, CAST, d)],
        CAST,
      );
      expect(checkAtCast(election, receipt, d, { min: CAST, max: SEAL })).toBe(true);
      // No source is needed: the anchored size already excludes the index.
      const v = judge(election, receipt, d, { ...viewOf(entries), sources: [] });
      expect(verdictIs("forked-l1", v)).toBe(true);
    }),
    { numRuns },
  );
});

test("a receipt is pending before its window closes and unresolved with no source", () => {
  const payload = ballot(Uint8Array.of(1, 2, 3));
  const entries = [entry(0, FIRST, ballot(Uint8Array.of(0))), entry(1, CAST, payload)];
  const receipt = operatorReceipt(secret, election, entries, CAST);
  const pending = judge(election, receipt, payload, viewOf(entries, end(CAST) + DEADLINE));
  expect(pending.verdict).toBe("pending");
  const blind = judge(election, receipt, payload, { ...viewOf(entries), sources: [] });
  expect(blind.verdict).toBe("unresolved");
  for (const expected of ["included", "forked-copy", "forked-l1"] as const)
    expect(verdictIs(expected, blind)).toBe(false);
});

test("a receipt is no evidence under a key the anchor never registered or a key the poll doesn't list", () => {
  const payload = ballot(Uint8Array.of(9));
  const entries = [entry(0, FIRST, ballot(Uint8Array.of(0))), entry(1, CAST, payload)];
  const receipt = operatorReceipt(secret, election, entries, CAST);
  const unregistered = judge(election, receipt, payload, {
    ...viewOf(entries),
    words: [new Uint8Array(32)],
  });
  // Its only listed key judges nothing, so no key the receipt could be under does.
  expect(unregistered).toEqual({ verdict: "not-evidence", reason: "receipt-key" });
  const other = operatorReceipt(new Uint8Array(32).fill(8), election, entries, CAST);
  expect(checkAtCast(election, other, payload, { min: CAST, max: SEAL })).toBe(false);
  expect(judge(election, other, payload, viewOf(entries))).toEqual({
    verdict: "not-evidence",
    reason: "receipt-key",
  });
});

test("a forked-from-L1 verdict crosses to the verifier's process as it was", () => {
  // The verdict judgeDrops hands the verifier holds a checkpoint: integers
  // and byte strings, which plain JSON would turn into strings and objects.
  fc.assert(
    fc.property(bodies, (bs) => {
      const [dropped, ...kept] = bs.map(ballot);
      const entries = [
        entry(0, FIRST, ballot(Uint8Array.of(0))),
        ...kept.map((p, i) => entry(i + 1, CAST, p)),
      ];
      const d = dropped as Uint8Array;
      const receipt = operatorReceipt(
        secret,
        election,
        [...entries, entry(entries.length, CAST, d)],
        CAST,
      );
      const v = judge(election, receipt, d, { ...viewOf(entries), sources: [] });
      expect(JSON.parse(tagged(v), taggedReviver)).toEqual(v);
    }),
    { numRuns },
  );
});

test("a drop outcome matches only the expectation that names it", () => {
  const notAlarm = { status: "not-drop", code: "not-alarm" } as const;
  const present = { status: "not-drop", code: "present", entry: 1 } as const;
  const drop = { status: "drop" } as const;
  const unjudged = { status: "unjudged", code: "inputs-unauthenticated" } as const;
  expect(dropIs({ status: "not-alarm" }, notAlarm)).toBe(true);
  expect(dropIs({ status: "present", entry: 1 }, present)).toBe(true);
  expect(dropIs({ status: "drop" }, drop)).toBe(true);
  // The entry carrying the ballot is pinned, not only that one does.
  expect(dropIs({ status: "present", entry: 2 }, present)).toBe(false);
  for (const o of [notAlarm, present, unjudged]) expect(dropIs({ status: "drop" }, o)).toBe(false);
  for (const o of [notAlarm, drop, unjudged])
    expect(dropIs({ status: "present", entry: 1 }, o)).toBe(false);
  for (const o of [present, drop, unjudged, { status: "not-drop", code: "decode" } as const])
    expect(dropIs({ status: "not-alarm" }, o)).toBe(false);
});
