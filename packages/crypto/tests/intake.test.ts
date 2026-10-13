import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import {
  ballotElection,
  BN254_R,
  type BallotElection,
  type CellBallotElection,
  cellBallotElection,
  checkShareReceipt,
  decodeBallot,
  decodeElectionDefinition,
  decodeElectionDefinitionRecord,
  type ElectionDefinitionV3,
  type FinalizedL1,
  intakeBallot,
  type IntakeCode,
  type IntakeResult,
  owedReceipts,
  type RegisteredKeys,
  shareReceiptStatement,
  type ViewBallot,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/intake.json comes from an independent Python
// implementation of intake on whole ballot records (scripts/intake-vectors.py,
// reusing the ballot, share-encryption and share-receipt generators), with
// membership proofs from snarkjs over Semaphore's own circuit, so the expected
// verdicts and receipt bytes never come from the code under test.

interface Vectors {
  readonly format: string;
  readonly elections: Readonly<
    Record<
      string,
      { readonly version: 1 | 2; readonly definition: string; readonly definitionHash: string }
    >
  >;
  readonly panel: readonly {
    readonly seat: number;
    readonly kem: { readonly seed: string; readonly x: string };
    readonly signingSecret: string;
    readonly signingKey: string;
  }[];
  readonly cases: readonly {
    readonly id: string;
    readonly election: string;
    readonly registered: readonly number[];
    readonly seat: number;
    readonly record: string;
    readonly ciphertext: string;
    readonly result: "ok" | IntakeCode;
    readonly option?: number;
    readonly ballotHash?: string;
    readonly shareHash?: string;
    readonly statement?: string;
    readonly receipt?: string;
    readonly tier?: number;
    readonly nullifier?: string;
    readonly message?: string;
    readonly l1RefNumber?: string;
    readonly l1RefHash?: string;
  }[];
}

const vectors = JSON.parse(readFileSync(new URL("intake.json", SPEC_VECTORS), "utf8")) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const kem = vectors.panel.map((s) => kemKeyPairWith(hex(s.kem.seed), BigInt(s.kem.x)));

const keySet = (seats: readonly number[], transcript: Uint8Array): readonly RegisteredKeys[] =>
  checkedKeySetForTests(
    seats.map((index) => ({
      index,
      kemKey: kem[index - 1]?.publicKey as RegisteredKeys["kemKey"],
      signingKey: hex((vectors.panel[index - 1] as Vectors["panel"][number]).signingKey),
    })),
    transcript,
  );

function electionOf(name: string, seats: readonly number[]): BallotElection | CellBallotElection {
  const e = vectors.elections[name];
  if (e === undefined) throw new Error(`no election ${name}`);
  if (e.version === 1) {
    const d = decodeElectionDefinition(hex(e.definition));
    return ballotElection(d, keySet(seats, d.ceremony_transcript_hash));
  }
  const d = decodeElectionDefinitionRecord(hex(e.definition)).value as ElectionDefinitionV3;
  return cellBallotElection(d, keySet(seats, d.ceremony_transcript_hash));
}

const keysOf = (seat: number) => ({
  seat,
  kemSecret: (kem[seat - 1] as ReturnType<typeof kemKeyPairWith>).secretKey,
  signingSecret: hex((vectors.panel[seat - 1] as Vectors["panel"][number]).signingSecret),
});

const codeOf = (r: IntakeResult) => (r.ok ? "ok" : r.code);

const okCase = vectors.cases.find((c) => c.id === "ok-seat-1") as Vectors["cases"][number];

describe("intake.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-intake-vectors/1");
    expect(vectors.cases.length).toBeGreaterThan(0);
  });

  for (const c of vectors.cases) {
    test(`${c.id}: ${c.result}`, () => {
      const election = electionOf(c.election, c.registered);
      const r = intakeBallot(election, keysOf(c.seat), hex(c.record), hex(c.ciphertext));
      expect(codeOf(r)).toBe(c.result);
      if (!r.ok) {
        expect(r.option).toBe(c.option);
        return;
      }
      expect(toHex(r.ballotHash)).toBe(c.ballotHash);
      expect(toHex(r.shareHash)).toBe(c.shareHash);
      expect(toHex(r.receipt)).toBe(c.receipt);
      expect(r.tier).toBe(c.tier);
      expect(String(r.nullifier)).toBe(c.nullifier);
      expect(toHex(r.message)).toBe(c.message);
      expect(String(r.l1RefNumber)).toBe(c.l1RefNumber);
      expect(toHex(r.l1RefHash)).toBe(c.l1RefHash);
      expect(
        toHex(
          shareReceiptStatement({
            definition_hash: hex(vectors.elections[c.election]?.definitionHash as string),
            ballot_hash: r.ballotHash,
            seat: c.seat,
            share_hash: r.shareHash,
          }),
        ),
      ).toBe(c.statement);
      // The receipt passes the public check against the ballot it was made for.
      const ballot =
        vectors.elections[c.election]?.version === 1
          ? decodeBallot(hex(c.record), 1)
          : decodeBallot(hex(c.record), 2);
      const named =
        "cell" in ballot ? { ballotVersion: 2 as const, cell: ballot.cell } : { tier: ballot.tier };
      expect(
        checkShareReceipt(
          c.registered.map((index) => ({
            index,
            signingKey: hex((vectors.panel[index - 1] as Vectors["panel"][number]).signingKey),
          })),
          { definitionHash: ballot.definition_hash, nullifier: ballot.nullifier, ...named },
          ballot.committed_vote,
          c.seat,
          r.receipt,
        ),
      ).toBe(true);
    });
  }
});

describe("intakeBallot", () => {
  test("covers every refusal code it can return, beside acceptance", () => {
    const codes = new Set(vectors.cases.map((c) => c.result));
    for (const code of [
      "ok",
      "delivery-malformed",
      "ballot-stray",
      "ballot-tier",
      "ballot-cell",
      "validity-shape",
      "share-hash-unqualified",
      "share-hash",
      "membership-proof",
      "option-proof",
      "sum-proof",
      "share-proof",
      "share-check",
    ])
      expect(codes.has(code as IntakeCode)).toBe(true);
  });

  test("refuses every single-byte change to an accepted record", () => {
    const election = electionOf(okCase.election, okCase.registered);
    const record = hex(okCase.record);
    const ct = hex(okCase.ciphertext);
    fc.assert(
      fc.property(
        fc.nat({ max: record.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = Uint8Array.from(record);
          changed[at] = (changed[at] as number) ^ flip;
          expect(intakeBallot(election, keysOf(okCase.seat), changed, ct).ok).toBe(false);
        },
      ),
      { numRuns: Math.min(numRuns, 200) },
    );
  });

  test("throws for a seat outside the registered key set, and for a hand-built context", () => {
    const election = electionOf("plurality", [1, 2]);
    expect(() =>
      intakeBallot(election, keysOf(3), hex(okCase.record), hex(okCase.ciphertext)),
    ).toThrow(RangeError);
    expect(() =>
      intakeBallot(
        { ...(election as BallotElection) },
        keysOf(1),
        hex(okCase.record),
        hex(okCase.ciphertext),
      ),
    ).toThrow(TypeError);
  });
});

// A finalized L1 where block n has hash H(n) and a timestamp 12 s per block,
// closing at block 100's time.
const blockHash = (n: bigint) => {
  const h = new Uint8Array(32);
  new DataView(h.buffer).setBigUint64(24, n);
  return h;
};
const l1At = (head: bigint): FinalizedL1 => ({
  head,
  block: (n) => ({ hash: blockHash(n), timestamp: 1_000_000n + 12n * n }),
});
const window = { l1RefMin: 10n, closesAt: 1_000_000n + 12n * 100n };
const closed = l1At(101n);

// A view ballot with whether the node holds a receipt for its hash; `owed`
// passes those hashes as the node's receipts.
type TestBallot = ViewBallot & { readonly receipted: boolean };

const view = (
  b: Partial<TestBallot> & {
    readonly id: number;
    readonly block: bigint;
    /** The public part's id, when two casts share one ballot hash (default: `id`). */
    readonly core?: number;
  },
): TestBallot => ({
  ballotHash: Uint8Array.of(b.core ?? b.id, ...new Uint8Array(31)),
  tier: b.tier ?? 0,
  nullifier: b.nullifier ?? 7n,
  message: Uint8Array.of(0xaa, b.id, ...new Uint8Array(30)),
  l1RefNumber: b.block,
  l1RefHash: b.l1RefHash ?? blockHash(b.block),
  receipted: b.receipted ?? true,
});

const receiptsOf = (v: readonly TestBallot[]) =>
  v.filter((b) => b.receipted).map((b) => b.ballotHash);
const owed = (v: readonly TestBallot[]) =>
  owedReceipts(v, receiptsOf(v), closed, window).map((h) => h[0]);

describe("owedReceipts", () => {
  test("owes only the newest receipted ballot of a tier and nullifier", () => {
    expect(owed([view({ id: 1, block: 20n }), view({ id: 2, block: 30n })])).toEqual([2]);
  });

  test("owes one ballot per tier and nullifier", () => {
    expect(
      owed([
        view({ id: 1, block: 20n }),
        view({ id: 2, block: 21n, nullifier: 8n }),
        view({ id: 3, block: 22n, tier: 2 }),
      ]),
    ).toEqual([1, 2, 3]);
  });

  test("owes nothing on a tie at the newest block", () => {
    expect(
      owed([view({ id: 1, block: 20n }), view({ id: 2, block: 30n }), view({ id: 3, block: 30n })]),
    ).toEqual([]);
  });

  test("owes nothing when a newer ballot it didn't receipt supersedes", () => {
    expect(
      owed([view({ id: 1, block: 20n }), view({ id: 2, block: 30n, receipted: false })]),
    ).toEqual([]);
  });

  test("a copy from the board of a ballot it receipted is the same ballot", () => {
    expect(
      owed([view({ id: 1, block: 20n }), { ...view({ id: 1, block: 20n }), receipted: false }]),
    ).toEqual([1]);
  });

  test("a receipt for a ballot hash covers its public part cast again under another block", () => {
    // Revoting Client rule 4: the first cast's block was reorganised away, and
    // the client cast the same core again; the node only receipted the first.
    expect(
      owed([
        view({ id: 1, core: 9, block: 20n, l1RefHash: new Uint8Array(32).fill(7) }),
        view({ id: 2, core: 9, block: 25n, receipted: false }),
      ]),
    ).toEqual([9]);
  });

  test("a receipt still counts for a ballot hash whose receipted copy was shown absent", () => {
    // The first copy's block was reorganised away and the full board shows it
    // absent, so it leaves the view; the copy cast again is on the board, and
    // the node's receipt for its ballot hash delivers it.
    const recast = view({ id: 2, core: 9, block: 25n, receipted: false });
    expect(owedReceipts([recast], [recast.ballotHash], closed, window).map((h) => h[0])).toEqual([
      9,
    ]);
    expect(owedReceipts([recast], [], closed, window)).toEqual([]);
  });

  test("ballots whose L1 reference isn't admitted can't supersede; the newest receipted one is owed too", () => {
    expect(
      owed([
        view({ id: 1, block: 20n }),
        view({ id: 2, block: 30n, l1RefHash: new Uint8Array(32).fill(9) }),
        view({ id: 3, block: 5n }),
        view({ id: 4, block: 101n }),
        view({ id: 5, block: 102n, receipted: false }),
      ]),
    ).toEqual([1, 4]);
  });

  test("owes a receipt whose ballot's block was reorganised away when the board's copy is withheld", () => {
    // The client cast the same core again under a newer block (revoting
    // Client rule 4); the operator anchored it and withholds its data, so the
    // node holds only its own copy, which fails the L1 check.
    expect(
      owed([view({ id: 1, core: 9, block: 20n, l1RefHash: new Uint8Array(32).fill(7) })]),
    ).toEqual([9]);
  });

  test("throws while L1 hasn't finalized a block after close", () => {
    expect(() => owedReceipts([view({ id: 1, block: 99n })], [], l1At(98n), window)).toThrow(
      RangeError,
    );
  });

  test("throws when one message names two ballot hashes", () => {
    const a = view({ id: 1, block: 20n });
    expect(() =>
      owedReceipts([a, { ...a, ballotHash: new Uint8Array(32).fill(3) }], [], closed, window),
    ).toThrow(RangeError);
  });

  test("throws for a tier or nullifier out of range, even on a reference that isn't admitted", () => {
    // Block 5 is before l1RefMin, so these never reach selectBallots' checks.
    for (const bad of [
      { tier: 3 },
      { nullifier: -1n },
      { nullifier: BN254_R },
      { nullifier: BN254_R + 7n },
    ])
      expect(() =>
        owedReceipts([{ ...view({ id: 1, block: 5n }), ...bad }], [], closed, window),
      ).toThrow(RangeError);
  });

  test("owes at most two receipted ballots per tier and nullifier, whatever the view's order", () => {
    const ballot = fc.record({
      id: fc.integer({ min: 0, max: 255 }),
      block: fc.bigInt({ min: 0n, max: 110n }),
      tier: fc.constantFrom(0, 1, 2),
      nullifier: fc.bigInt({ min: 1n, max: 4n }),
      receipted: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.uniqueArray(ballot, { selector: (b) => b.id, maxLength: 40 }), (bs) => {
        const v = bs.map((b) => view(b));
        const got = owedReceipts(v, receiptsOf(v), closed, window).map(toHex);
        const reversed = owedReceipts([...v].reverse(), receiptsOf(v), closed, window).map(toHex);
        expect(reversed).toEqual(got);
        const perGroup = new Map<string, number>();
        for (const h of got) {
          const b = v.find((x) => toHex(x.ballotHash) === h) as ViewBallot;
          expect(receiptsOf(v).map(toHex)).toContain(h);
          const key = `${b.tier}:${b.nullifier}`;
          perGroup.set(key, (perGroup.get(key) ?? 0) + 1);
        }
        for (const n of perGroup.values()) expect(n).toBeLessThanOrEqual(2);
      }),
      { numRuns },
    );
  });

  test("agrees with a direct reading of the rule", () => {
    const ballot = fc.record({
      id: fc.integer({ min: 0, max: 255 }),
      core: fc.integer({ min: 0, max: 7 }),
      block: fc.bigInt({ min: 0n, max: 110n }),
      tier: fc.constantFrom(0, 2),
      nullifier: fc.bigInt({ min: 1n, max: 3n }),
      receipted: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.uniqueArray(ballot, { selector: (b) => b.id, maxLength: 30 }), (bs) => {
        // Few cores, so casts often share a ballot hash under distinct messages.
        const v = bs.map((b) => view(b));
        const receipted = new Set(v.filter((b) => b.receipted).map((b) => toHex(b.ballotHash)));
        // Admitted references: blocks 10 to 100 (the window, closing at block 100).
        const admitted = v.filter((b) => b.l1RefNumber >= 10n && b.l1RefNumber <= 100n);
        const want: string[] = [];
        for (const key of new Set(admitted.map((b) => `${b.tier}:${b.nullifier}`))) {
          const group = admitted.filter((b) => `${b.tier}:${b.nullifier}` === key);
          const top = group.reduce((m, b) => (b.l1RefNumber > m ? b.l1RefNumber : m), -1n);
          const best = new Map(
            group.filter((b) => b.l1RefNumber === top).map((b) => [toHex(b.message), b]),
          );
          if (best.size !== 1) continue;
          const [only] = [...best.values()] as [TestBallot];
          if (receipted.has(toHex(only.ballotHash))) want.push(toHex(only.ballotHash));
        }
        // And each group's newest view ballot with a receipt whose reference isn't admitted.
        const failed = v.filter(
          (b) =>
            receipted.has(toHex(b.ballotHash)) && (b.l1RefNumber < 10n || b.l1RefNumber > 100n),
        );
        for (const key of new Set(failed.map((b) => `${b.tier}:${b.nullifier}`))) {
          const [newest] = failed
            .filter((b) => `${b.tier}:${b.nullifier}` === key)
            .sort((a, b) =>
              a.l1RefNumber !== b.l1RefNumber
                ? a.l1RefNumber > b.l1RefNumber
                  ? -1
                  : 1
                : toHex(a.ballotHash) < toHex(b.ballotHash)
                  ? -1
                  : 1,
            ) as [TestBallot];
          if (!want.includes(toHex(newest.ballotHash))) want.push(toHex(newest.ballotHash));
        }
        // A set of ballot hashes: test views may give one hash two tiers.
        expect(owedReceipts(v, receiptsOf(v), closed, window).map(toHex)).toEqual(
          [...new Set(want)].sort(),
        );
      }),
      { numRuns },
    );
  });

  test("an accepted intake's ranking fields feed the obligation", () => {
    const election = electionOf(okCase.election, okCase.registered);
    const r = intakeBallot(
      election,
      keysOf(okCase.seat),
      hex(okCase.record),
      hex(okCase.ciphertext),
    );
    if (!r.ok) throw new Error("expected the vector's intake to pass");
    // An L1 that finalized the ballot's own block with its hash, and a block after close.
    const l1: FinalizedL1 = {
      head: r.l1RefNumber + 1n,
      block: (n) => ({ hash: n === r.l1RefNumber ? r.l1RefHash : blockHash(n), timestamp: n }),
    };
    const got = owedReceipts([r], [r.ballotHash], l1, {
      l1RefMin: 0n,
      closesAt: r.l1RefNumber,
    });
    expect(got.map(toHex)).toEqual([toHex(r.ballotHash)]);
  });
});
