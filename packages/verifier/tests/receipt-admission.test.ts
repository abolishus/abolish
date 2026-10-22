import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { electionAdmission, splitEntries } from "../src/index.ts";
import {
  ballots,
  definition,
  definitionBytes,
  panel,
  receiptFor,
  transcript,
  transcriptEntry,
} from "./receipt-poll.ts";

// `electionAdmission`'s share-receipt judge, which a board operator runs
// before boarding a receipt through the board path (docs/spec/delivery.md,
// Boarding, rules 1 and 4): a receipt names this definition and a seat of
// the registered key set, and passes `share-receipt` against the boarded
// ballot its ballot hash names, with that ballot's own share hash for the
// seat (T-17, T-52). The election's ceremony is run in tests/receipt-poll.ts,
// so its seats' keys are known; each receipt is signed there over the
// statement the spec gives.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const admission = (() => {
  const a = electionAdmission(definitionBytes, panel, [transcriptEntry]);
  if (!a.ok) throw new Error(`election refused: ${a.code}`);
  return a;
})();

const [first, second] = ballots as [(typeof ballots)[number], (typeof ballots)[number]];
const SEATS = Array.from({ length: definition.panel_size }, (_, i) => i + 1);

/** The receipt's verdict with rule 4 run against `ballot`: a code, or whether it passes. */
function judged(receipt: Uint8Array, ballot: Uint8Array): string | boolean {
  const r = admission.receipt(receipt);
  return r.ok ? r.check(ballot) : r.code;
}

test("the election is version 5's, with ballots to receipt", () => {
  expect(ballots.length).toBeGreaterThanOrEqual(2);
  expect(admission.l1InclusionBound).toBe(BigInt(definition.l1_inclusion_bound));
});

describe("an honest receipt", () => {
  test("each seat's, for each ballot, names its ballot and seat and passes against it", () => {
    for (const ballot of ballots)
      for (const seat of SEATS) {
        const r = admission.receipt(receiptFor(ballot, seat));
        expect(r).toMatchObject({ ok: true, ballotHash: ballot.hash, seat });
        if (r.ok) expect(r.check(ballot.payload)).toBe(true);
      }
  });

  test("passes against no other ballot", () => {
    expect(judged(receiptFor(first, 1), second.payload)).toBe(false);
    expect(judged(receiptFor(second, 2), first.payload)).toBe(false);
  });

  test("keeps no reference to the bytes it was given", () => {
    const receipt = receiptFor(first, 1);
    const r = admission.receipt(receipt);
    receipt.fill(0);
    expect(r.ok && r.check(first.payload)).toBe(true);
  });
});

describe("rule 1", () => {
  test("a receipt naming another definition is refused before any ballot is read", () => {
    const other = new Uint8Array(32).fill(7);
    expect(admission.receipt(receiptFor(first, 1, { definitionHash: other }))).toEqual({
      ok: false,
      code: "receipt-definition",
    });
  });

  test("a seat outside the registered key set is refused", () => {
    for (const seat of [definition.panel_size + 1, 255])
      expect(admission.receipt(receiptFor(first, 1, { seat }))).toEqual({
        ok: false,
        code: "receipt-seat",
      });
  });

  test.each([
    ["truncated", (r: Uint8Array) => r.subarray(0, r.length - 1), "truncated"],
    ["with a trailing byte", (r: Uint8Array) => Uint8Array.of(...r, 0), "trailing-bytes"],
    [
      "of another record type",
      (r: Uint8Array) => Uint8Array.of(0x00, 0x0e, ...r.subarray(2)),
      "unexpected-record-type",
    ],
    [
      "of version 2",
      (r: Uint8Array) => Uint8Array.of(r[0]!, r[1]!, 2, ...r.subarray(3)),
      undefined,
    ],
    ["empty", () => new Uint8Array(0), "truncated"],
  ])("a record %s doesn't decode", (_, change, decodeError) => {
    const r = admission.receipt(change(receiptFor(first, 1)));
    expect(r).toMatchObject({ ok: false, code: "decode" });
    if (decodeError !== undefined) expect(r).toMatchObject({ decodeError });
  });
});

describe("rule 4", () => {
  test("another seat's signature fails", () => {
    expect(judged(receiptFor(first, 1, { signer: 2 }), first.payload)).toBe(false);
  });

  test("another seat's share hash fails, under the seat's own signature", () => {
    const shareHash = first.shareHashes[1] as Uint8Array;
    expect(judged(receiptFor(first, 1, { shareHash }), first.payload)).toBe(false);
  });

  test("a ballot hash that isn't the ballot's fails against it", () => {
    expect(judged(receiptFor(first, 1, { ballotHash: second.hash }), first.payload)).toBe(false);
  });

  test("bytes that aren't a ballot of this election fail, and never throw", () => {
    const r = admission.receipt(receiptFor(first, 1));
    if (!r.ok) throw new Error("refused");
    expect(r.check(transcript)).toBe(false);
    expect(r.check(first.payload.subarray(0, 40))).toBe(false);
    expect(r.check(new Uint8Array(0))).toBe(false);
    const elsewhere = Uint8Array.from(first.payload);
    elsewhere[3] = (elsewhere[3] as number) ^ 1;
    expect(r.check(elsewhere)).toBe(false);
  });

  test("any single-byte change to an honest receipt stops it", () => {
    const receipt = receiptFor(first, 2);
    fc.assert(
      fc.property(
        fc.nat({ max: receipt.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = Uint8Array.from(receipt);
          changed[at] = (changed[at] as number) ^ flip;
          expect(judged(changed, first.payload)).not.toBe(true);
        },
      ),
      { numRuns },
    );
  });
});

test("an election of a definition version whose receipts aren't judged yet refuses every one", () => {
  const file = JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/verifier-ballots.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly panels: Readonly<Record<string, { threshold: string; keys: string[] }>>;
    readonly cases: readonly { id: string; panel: string; definition: string; board: string }[];
  };
  const c = file.cases.find((x) => x.id === "admitted");
  if (c === undefined) throw new Error("no admitted case");
  const p = file.panels[c.panel];
  if (p === undefined) throw new Error("no panel");
  const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
  const v1 = electionAdmission(
    hex(c.definition),
    { threshold: Number(p.threshold), keys: p.keys.map(hex) },
    splitEntries(hex(c.board)).entries,
  );
  if (!v1.ok) throw new Error(`election refused: ${v1.code}`);
  expect(v1.receipt(receiptFor(first, 1))).toEqual({ ok: false, code: "unsupported-version" });
});
