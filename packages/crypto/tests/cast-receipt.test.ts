import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import {
  castPostingSeatV3,
  castReceiptSeatV3,
  decodeElectionDefinitionV5,
  encodeShareReceipt,
  type QuestionBallotElection,
  questionBallotElection,
  type RegisteredKeys,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// The ballot client's check of a seat's receipt for the ballot it cast
// ([[delivery]], Client rule 1), over docs/spec/vectors/intake-v3.json: its
// receipts and ballot hashes come from an independent Python implementation
// of intake (scripts/ballot-v3-records-vectors.py), never from the code
// under test. Each receipt record is assembled from the vector's own fields.

interface Vectors {
  readonly elections: Readonly<Record<string, { readonly definition: string }>>;
  readonly panel: readonly {
    readonly seat: number;
    readonly kem: { readonly seed: string; readonly x: string };
    readonly signingKey: string;
  }[];
  readonly cases: readonly {
    readonly id: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly seat: number;
    readonly record: string;
    readonly result: string;
    readonly ballotHash?: string;
    readonly shareHash?: string;
    readonly receipt?: string;
    readonly ciphertext?: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("intake-v3.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

type Seat = Vectors["panel"][number];
const kem = vectors.panel.map((s) => kemKeyPairWith(hex(s.kem.seed), BigInt(s.kem.x)));
const signers = (seats: readonly number[]) =>
  seats.map((index) => ({
    index,
    signingKey: hex((vectors.panel[index - 1] as Seat).signingKey),
  }));

const definitionOf = (name: string) => {
  const e = vectors.elections[name];
  if (e === undefined) throw new Error(`no election ${name}`);
  return decodeElectionDefinitionV5(hex(e.definition));
};

/**
 * The election under `seats`' registered keys, with any seat's signing key
 * replaced by `signing`'s and its KEM key by seat `kemOf[seat]`'s.
 */
function electionOf(
  name: string,
  seats: readonly number[],
  signing: Readonly<Record<number, Uint8Array>> = {},
  kemOf: Readonly<Record<number, number>> = {},
): QuestionBallotElection {
  const d = definitionOf(name);
  const keys: RegisteredKeys[] = signers(seats).map((s) => ({
    ...s,
    signingKey: signing[s.index] ?? s.signingKey,
    kemKey: kem[(kemOf[s.index] ?? s.index) - 1]?.publicKey as RegisteredKeys["kemKey"],
  }));
  return questionBallotElection(d, checkedKeySetForTests(keys, d.ceremony_transcript_hash));
}

type Case = Vectors["cases"][number];
const accepted = vectors.cases.filter((c) => c.result === "ok");
const caseOf = (id: string) => vectors.cases.find((c) => c.id === id) as Case;

/** The receipt record a seat's intake answers with, from the vector's fields. */
const receiptOf = (c: Case) =>
  encodeShareReceipt({
    definition_hash: electionOf(c.election, c.registered).definitionHash,
    ballot_hash: hex(c.ballotHash as string),
    seat: c.seat,
    share_hash: hex(c.shareHash as string),
    signature: hex(c.receipt as string),
  });

describe("castReceiptSeatV3", () => {
  test("reads this suite's accepted deliveries", () => {
    expect(accepted.length).toBeGreaterThanOrEqual(4);
  });

  for (const c of accepted)
    test(`${c.id}: passes for seat ${c.seat}`, () => {
      const election = electionOf(c.election, c.registered);
      expect(castReceiptSeatV3(election, hex(c.record), receiptOf(c))).toBe(c.seat);
    });

  test("refuses a receipt for another ballot, even under the right seat's signature", () => {
    const one = caseOf("intake-ok-seat-1");
    const other = caseOf("intake-ok-remainder");
    expect(other.record).not.toBe(one.record);
    const election = electionOf(one.election, one.registered);
    expect(castReceiptSeatV3(election, hex(other.record), receiptOf(one))).toBeUndefined();
  });

  test("refuses every single-byte change to a passing receipt record", () => {
    const c = caseOf("intake-ok-seat-1");
    const election = electionOf(c.election, c.registered);
    const receipt = receiptOf(c);
    fc.assert(
      fc.property(
        fc.nat({ max: receipt.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = Uint8Array.from(receipt);
          changed[at] = (changed[at] as number) ^ flip;
          expect(castReceiptSeatV3(election, hex(c.record), changed)).toBeUndefined();
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  }, 120_000);

  test("refuses a truncated or extended record", () => {
    const c = caseOf("intake-ok-seat-2");
    const election = electionOf(c.election, c.registered);
    const receipt = receiptOf(c);
    for (const bytes of [receipt.subarray(0, -1), Uint8Array.of(...receipt, 0), new Uint8Array()])
      expect(castReceiptSeatV3(election, hex(c.record), bytes)).toBeUndefined();
  });

  test("refuses a seat whose registered signing key is another seat's", () => {
    const c = caseOf("intake-ok-seat-3");
    const receipt = receiptOf(c);
    const swapped = electionOf(c.election, c.registered, {
      [c.seat]: hex((vectors.panel[0] as Seat).signingKey),
    });
    expect(castReceiptSeatV3(swapped, hex(c.record), receipt)).toBeUndefined();
  });

  test("refuses a seat with no registered signing key", () => {
    const c = caseOf("intake-ok-seat-3");
    const without = electionOf(
      c.election,
      c.registered.filter((seat) => seat !== c.seat),
    );
    expect(castReceiptSeatV3(without, hex(c.record), receiptOf(c))).toBeUndefined();
  });

  test("throws for an election questionBallotElection didn't make, a ballot of another election or bytes that aren't a version-3 ballot", () => {
    const c = caseOf("intake-ok-seat-1");
    const election = electionOf(c.election, c.registered);
    // A copy with another definition hash: not a context the key set was bound to.
    const copied = { ...election, definitionHash: new Uint8Array(32).fill(7) };
    expect(() => castReceiptSeatV3(copied, hex(c.record), receiptOf(c))).toThrow(TypeError);
    const other = electionOf("questions", c.registered);
    const changed = hex(c.record).slice();
    changed[3] = (changed[3] as number) ^ 1;
    expect(() => castReceiptSeatV3(other, changed, receiptOf(c))).toThrow(TypeError);
    expect(() => castReceiptSeatV3(election, hex(c.record).subarray(1), receiptOf(c))).toThrow();
  });
});

// The client's check of a kept `m_i` before it offers a posting ([[delivery]],
// Client rule 4). The vectors keep no `m_i`, so a posting with a made-up one
// can only fail at its last step, the re-encapsulation: reaching it shows the
// ciphertext was judged against this seat's share hash and this seat's
// registered KEM key. A kept `m_i` that passes is the membership prover's
// test (seal.test.ts), over a ballot sealed end to end.
describe("castPostingSeatV3", () => {
  const c = caseOf("intake-ok-seat-2");
  const other = caseOf("intake-ok-seat-1");
  const posting = (m = new Uint8Array(32)) => ({ ciphertext: hex(c.ciphertext as string), m });

  test("reaches the re-encapsulation only for the seat's own ciphertext under its own key", () => {
    const election = electionOf(c.election, c.registered);
    expect(castPostingSeatV3(election, hex(c.record), c.seat, posting())).toEqual({
      ok: false,
      code: "posting-encapsulation",
    });
    // Another seat's ciphertext of the same ballot hashes to another share hash.
    expect(castPostingSeatV3(election, hex(c.record), other.seat, posting())).toEqual({
      ok: false,
      code: "posting-hash",
    });
  });

  test("judges the ephemeral's proof under the seat's registered key, never another seat's", () => {
    const swapped = electionOf(c.election, c.registered, {}, { [c.seat]: other.seat });
    expect(castPostingSeatV3(swapped, hex(c.record), c.seat, posting())).toEqual({
      ok: false,
      code: "posting-proof",
    });
  });

  test("refuses an m_i of another length and a seat with no registered key", () => {
    const election = electionOf(c.election, c.registered);
    for (const m of [new Uint8Array(31), new Uint8Array(33), new Uint8Array()])
      expect(castPostingSeatV3(election, hex(c.record), c.seat, posting(m))).toEqual({
        ok: false,
        code: "posting-malformed",
      });
    const without = electionOf(
      c.election,
      c.registered.filter((seat) => seat !== c.seat),
    );
    expect(castPostingSeatV3(without, hex(c.record), c.seat, posting())).toEqual({
      ok: false,
      code: "posting-seat",
    });
  });

  test("throws for a seat outside the panel, a ballot of another election or bytes that aren't a version-3 ballot", () => {
    const election = electionOf(c.election, c.registered);
    const record = hex(c.record);
    for (const seat of [0, -1, 1.5, 17, Number.NaN])
      expect(() => castPostingSeatV3(election, record, seat, posting())).toThrow(RangeError);
    const changed = record.slice();
    changed[3] = (changed[3] as number) ^ 1;
    expect(() => castPostingSeatV3(election, changed, c.seat, posting())).toThrow(TypeError);
    expect(() => castPostingSeatV3(election, record.subarray(1), c.seat, posting())).toThrow();
  });
});
