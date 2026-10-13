import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { panelBallotElectionWith } from "../src/ballot.ts";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import {
  checkReceiptStatement,
  checkReceiptStatementV4,
  checkShareReceiptV4With,
  type PanelReceiptSigners,
} from "../src/share-receipt.ts";
import * as entry from "../src/index.ts";
import {
  ballotHashV4,
  checkShareReceiptV4,
  decodeBallot,
  decodeElectionDefinitionV6,
  intakeBallot,
  intakeBallotV4,
  type IntakeCodeV4,
  type IntakeResultV4,
  type PanelBallotElection,
  panelBallotElection,
  type RegisteredKeys,
  SEAT_PANELS,
  type SeatPanel,
  shareReceiptStatement,
  shareReceiptStatementV4,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/intake-v4.json comes from an independent Python
// implementation of intake at a seat of either panel and the version-2 share
// receipt (scripts/intake-v4-vectors.py, reusing the ballot-v4-records,
// share-encryption-v4 and trustee generators), with membership proofs from
// snarkjs over Semaphore's own circuit, so the expected verdicts and receipt
// bytes never come from the code under test.

interface SeatVector {
  readonly seat: number;
  readonly kem: { readonly seed: string; readonly x: string };
  readonly signingSecret: string;
  readonly signingKey: string;
  readonly identityKey: string;
}

interface Vectors {
  readonly format: string;
  readonly tags: { readonly receipt: string };
  readonly panels: { readonly default: number; readonly author: number };
  readonly elections: Readonly<
    Record<
      string,
      { readonly version: 6; readonly definition: string; readonly definitionHash: string }
    >
  >;
  readonly seats: {
    readonly default: readonly SeatVector[];
    readonly author: readonly SeatVector[];
  };
  readonly cases: readonly {
    readonly id: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly authorRegistered: readonly number[];
    readonly panel: SeatPanel;
    readonly seat: number;
    readonly record: string;
    readonly ciphertext: string;
    readonly result: "ok" | IntakeCodeV4;
    readonly option?: number;
    readonly question?: number;
    readonly unqualifiedPanel?: number;
    readonly unqualifiedSeat?: number;
    readonly snarkjs?: boolean;
    readonly ballotHash?: string;
    readonly shareHash?: string;
    readonly statement?: string;
    readonly receipt?: string;
    readonly tier?: number;
    readonly cell?: number;
    readonly nullifier?: string;
    readonly message?: string;
    readonly l1RefNumber?: string;
    readonly l1RefHash?: string;
  }[];
  readonly checks: readonly {
    readonly id: string;
    readonly definitionHash: string;
    readonly ballotHash: string;
    readonly panel: number;
    readonly seat: number;
    readonly shareHash: string;
    readonly authorRegistered: readonly number[];
    readonly signature: string;
    readonly valid: boolean;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("intake-v4.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type Case = Vectors["cases"][number];
const seatsOf = (panel: SeatPanel) =>
  panel === SEAT_PANELS.author ? vectors.seats.author : vectors.seats.default;
const seatOf = (panel: SeatPanel, seat: number) => seatsOf(panel)[seat - 1] as SeatVector;
const kemOf = (panel: SeatPanel, seat: number) => {
  const { kem } = seatOf(panel, seat);
  return kemKeyPairWith(hex(kem.seed), BigInt(kem.x));
};

const signersOf = (panel: SeatPanel, seats: readonly number[]) =>
  seats.map((index) => ({ index, signingKey: hex(seatOf(panel, index).signingKey) }));

const panelSigners = (
  seats: readonly number[],
  authorSeats: readonly number[],
): PanelReceiptSigners => ({
  default: signersOf(SEAT_PANELS.default, seats),
  author: signersOf(SEAT_PANELS.author, authorSeats),
});

// The author panel's registered key set is P2-16 part 3's, so a context with
// an author panel comes from the internal seam that takes its seats as given.
function electionOf(
  name: string,
  seats: readonly number[],
  authorSeats: readonly number[],
): PanelBallotElection {
  const e = vectors.elections[name];
  if (e === undefined) throw new Error(`no election ${name}`);
  const d = decodeElectionDefinitionV6(hex(e.definition));
  const registered: readonly RegisteredKeys[] = checkedKeySetForTests(
    signersOf(SEAT_PANELS.default, seats).map((s) => ({
      ...s,
      kemKey: kemOf(SEAT_PANELS.default, s.index).publicKey,
    })),
    d.ceremony_transcript_hash,
  );
  return d.author_keys.length === 0
    ? panelBallotElection(d, registered)
    : panelBallotElectionWith(d, registered, authorSeats);
}

const keysOf = (panel: SeatPanel, seat: number) => ({
  panel,
  seat,
  kemSecret: kemOf(panel, seat).secretKey,
  signingSecret: hex(seatOf(panel, seat).signingSecret),
});

const codeOf = (r: IntakeResultV4) => (r.ok ? "ok" : r.code);

const caseOf = (id: string) => vectors.cases.find((c) => c.id === id) as Case;
const run = (c: Case, keys = keysOf(c.panel, c.seat)) =>
  intakeBallotV4(
    electionOf(c.election, c.registered, c.authorRegistered),
    keys,
    hex(c.record),
    hex(c.ciphertext),
  );

const other = (panel: SeatPanel): SeatPanel =>
  panel === SEAT_PANELS.author ? SEAT_PANELS.default : SEAT_PANELS.author;

describe("intake-v4.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-intake-vectors/2");
    expect(vectors.tags.receipt).toBe("abolish/v1/sig/share-receipt-2");
    expect(vectors.panels).toEqual(SEAT_PANELS);
    expect(Object.values(vectors.elections).map((e) => e.version)).toEqual([6, 6]);
  });

  for (const c of vectors.cases) {
    test(`${c.id}: ${c.result}`, () => {
      const r = run(c);
      expect(codeOf(r)).toBe(c.result);
      if (!r.ok) {
        expect(r.option).toBe(c.option);
        expect(r.question).toBe(c.question);
        expect(r.panel).toBe(c.unqualifiedPanel);
        expect(r.seat).toBe(c.unqualifiedSeat);
        return;
      }
      expect(toHex(r.ballotHash)).toBe(c.ballotHash);
      expect(toHex(r.shareHash)).toBe(c.shareHash);
      expect(toHex(r.receipt)).toBe(c.receipt);
      expect(r.tier).toBe(c.tier);
      expect(r.cell).toBe(c.cell);
      expect(String(r.nullifier)).toBe(c.nullifier);
      expect(toHex(r.message)).toBe(c.message);
      expect(String(r.l1RefNumber)).toBe(c.l1RefNumber);
      expect(toHex(r.l1RefHash)).toBe(c.l1RefHash);
      const statement = {
        definition_hash: hex(vectors.elections[c.election]?.definitionHash as string),
        ballot_hash: r.ballotHash,
        panel: c.panel,
        seat: c.seat,
        share_hash: r.shareHash,
      };
      expect(toHex(shareReceiptStatementV4(statement))).toBe(c.statement);
      // The receipt passes the public check against the ballot hash and the
      // own panel's share hash recomputed from the record, and never as the
      // same index of the other panel.
      const ballot = decodeBallot(hex(c.record), 4);
      const ctx = {
        definitionHash: ballot.definition_hash,
        cell: ballot.cell,
        nullifier: ballot.nullifier,
      };
      expect(toHex(ballotHashV4(ctx, ballot.committed_vote))).toBe(c.ballotHash);
      const signers = panelSigners(c.registered, c.authorRegistered);
      const vote = ballot.committed_vote;
      expect(checkShareReceiptV4With(signers, ctx, vote, c.panel, c.seat, r.receipt)).toBe(true);
      expect(checkShareReceiptV4With(signers, ctx, vote, other(c.panel), c.seat, r.receipt)).toBe(
        false,
      );
      expect(r.panel).toBe(c.panel);
      // The exported check reads only the default panel's keys until P2-16
      // part 3 gives the author panel's a checked source.
      const defaultOnly = { default: signers.default, author: [] };
      expect(checkShareReceiptV4(defaultOnly, ctx, vote, c.panel, c.seat, r.receipt)).toBe(
        c.panel === SEAT_PANELS.default,
      );
      if (c.authorRegistered.length !== 0)
        expect(() => checkShareReceiptV4(signers, ctx, vote, c.panel, c.seat, r.receipt)).toThrow(
          RangeError,
        );
      // Its shares are its own panel's half: one per flat option.
      expect(r.shares).toHaveLength(vote.vss.length);
    });
  }

  for (const c of vectors.checks) {
    test(`receipt check ${c.id}: ${c.valid}`, () => {
      const statement = {
        definition_hash: hex(c.definitionHash),
        ballot_hash: hex(c.ballotHash),
        panel: c.panel,
        seat: c.seat,
        share_hash: hex(c.shareHash),
      };
      expect(
        checkReceiptStatementV4(
          panelSigners([1, 2, 3], c.authorRegistered),
          statement,
          hex(c.signature),
        ),
      ).toBe(c.valid);
    });
  }
});

describe("intakeBallotV4", () => {
  test("covers every code it can return at seats of both panels, beside acceptance", () => {
    const codes = new Set(vectors.cases.map((c) => c.result));
    for (const code of [
      "ok",
      "delivery-malformed",
      "ballot-stray",
      "ballot-cell",
      "validity-shape",
      "share-hash-unqualified",
      "share-hash",
      "membership-proof",
      "option-proof",
      "sum-proof",
      "share-malformed",
      "share-proof",
      "share-decrypt",
      "share-check",
    ])
      expect(codes.has(code as IntakeCodeV4)).toBe(true);
    for (const panel of [SEAT_PANELS.default, SEAT_PANELS.author])
      for (const code of ["ok", "share-hash", "share-check"])
        expect(vectors.cases.some((c) => c.panel === panel && c.result === code)).toBe(true);
  });

  test("refuses every single-byte change to an accepted record at an author seat", () => {
    const c = caseOf("intake-ok-author-2");
    const election = electionOf(c.election, c.registered, c.authorRegistered);
    const keys = keysOf(c.panel, c.seat);
    const record = hex(c.record);
    const ct = hex(c.ciphertext);
    fc.assert(
      fc.property(
        fc.nat({ max: record.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = Uint8Array.from(record);
          changed[at] = (changed[at] as number) ^ flip;
          expect(intakeBallotV4(election, keys, changed, ct).ok).toBe(false);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  }, 120_000);

  test("a seat's ciphertext never passes at the same index of the other panel, even with that panel's key", () => {
    for (const seat of [1, 2, 3]) {
      const c = caseOf(`intake-ok-author-${seat}`);
      const d = caseOf(`intake-ok-default-${seat}`);
      // The author ciphertext delivered to the default seat, with the
      // default seat's keys and with the author seat's: share-hash first.
      expect(codeOf(run({ ...c, panel: SEAT_PANELS.default }))).toBe("share-hash");
      expect(
        codeOf(
          run(
            { ...c, panel: SEAT_PANELS.default },
            { ...keysOf(SEAT_PANELS.author, seat), panel: SEAT_PANELS.default },
          ),
        ),
      ).toBe("share-hash");
      expect(codeOf(run({ ...d, panel: SEAT_PANELS.author }))).toBe("share-hash");
    }
  });

  test("a seat with another seat's KEM secret fails at decryption and signs nothing", () => {
    const c = caseOf("intake-ok-author-1");
    const r = run(c, {
      ...keysOf(SEAT_PANELS.author, 1),
      kemSecret: kemOf(SEAT_PANELS.author, 2).secretKey,
    });
    expect(r.ok).toBe(false);
    expect(["share-proof", "share-decrypt"]).toContain(codeOf(r));
  });

  test("throws for a seat outside its panel's registered key set, a panel byte of 3, and a hand-built context", () => {
    const c = caseOf("intake-ok-author-1");
    const record = hex(c.record);
    const ct = hex(c.ciphertext);
    const election = electionOf("panels", [1, 2, 3], [1, 2]);
    expect(() => intakeBallotV4(election, keysOf(SEAT_PANELS.author, 3), record, ct)).toThrow(
      RangeError,
    );
    expect(() =>
      intakeBallotV4(
        election,
        { ...keysOf(SEAT_PANELS.author, 1), panel: 3 as SeatPanel },
        record,
        ct,
      ),
    ).toThrow(RangeError);
    expect(() =>
      intakeBallotV4({ ...election }, keysOf(SEAT_PANELS.author, 1), record, ct),
    ).toThrow(TypeError);
    // A poll without an author panel has no author seat.
    const plain = caseOf("intake-ok-default-only-1");
    expect(() =>
      intakeBallotV4(
        electionOf("default-only", [1, 2, 3], []),
        keysOf(SEAT_PANELS.author, 1),
        hex(plain.record),
        hex(plain.ciphertext),
      ),
    ).toThrow(RangeError);
  });

  test("version 1's intake refuses a version-4 context", () => {
    const c = caseOf("intake-ok-default-1");
    const election = electionOf(c.election, c.registered, c.authorRegistered);
    expect(() =>
      intakeBallot(
        election as unknown as Parameters<typeof intakeBallot>[0],
        keysOf(SEAT_PANELS.default, 1),
        hex(c.record),
        hex(c.ciphertext),
      ),
    ).toThrow(TypeError);
  });

  test("the internal statement checks aren't exported from the entry point", () => {
    expect("checkReceiptStatementV4" in entry).toBe(false);
    expect("checkShareReceiptV4With" in entry).toBe(false);
    expect("admitForIntakeV4" in entry).toBe(false);
  });
});

describe("share receipt version 2", () => {
  const c = caseOf("intake-ok-author-2");
  const defh = hex(vectors.elections[c.election]?.definitionHash as string);
  const statement = {
    definition_hash: defh,
    ballot_hash: hex(c.ballotHash as string),
    panel: SEAT_PANELS.author,
    seat: 2,
    share_hash: hex(c.shareHash as string),
  };

  test("is 98 bytes: version 1's with the panel byte before the seat", () => {
    const m = shareReceiptStatementV4(statement);
    expect(m).toHaveLength(98);
    const v1 = shareReceiptStatement({
      definition_hash: statement.definition_hash,
      ballot_hash: statement.ballot_hash,
      seat: 2,
      share_hash: statement.share_hash,
    });
    expect(toHex(m)).toBe(toHex(v1.subarray(0, 64)) + "0202" + toHex(v1.subarray(65)));
  });

  test("a version-4 receipt is never a version-1 one, for the same seat's key", () => {
    const v1 = {
      definition_hash: defh,
      ballot_hash: statement.ballot_hash,
      seat: 2,
      share_hash: statement.share_hash,
    };
    expect(
      checkReceiptStatement(signersOf(SEAT_PANELS.author, [1, 2, 3]), v1, hex(c.receipt as string)),
    ).toBe(false);
  });

  test("a receipt checks only for its own panel, seat and statement", () => {
    const signers = panelSigners([1, 2, 3], [1, 2, 3]);
    const receipt = hex(c.receipt as string);
    fc.assert(
      fc.property(
        fc.constantFrom<SeatPanel>(SEAT_PANELS.default, SEAT_PANELS.author),
        fc.integer({ min: 0, max: 17 }),
        (panel, seat) => {
          const ok = checkReceiptStatementV4(signers, { ...statement, panel, seat }, receipt);
          expect(ok).toBe(panel === SEAT_PANELS.author && seat === 2);
        },
      ),
      { numRuns: Math.min(numRuns, 100) },
    );
  });
});
