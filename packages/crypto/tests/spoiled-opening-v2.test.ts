import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { type OptionPolynomials, shareVoteV3With, shareVoteWith } from "../src/ballot-validity.ts";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { encryptSharesWith, kemKeyPairWith } from "../src/share-encryption.ts";
import {
  ballotElection,
  cellBallotCore,
  cellBallotElection,
  type CellBallotElection,
  cellCoreHash,
  cellTrackingCode,
  type ChallengeOpeningV2Check,
  checkChallengeOpening,
  checkChallengeOpeningV2,
  DecodeError,
  decodeElectionDefinition,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  decodeOpening,
  type ElectionDefinitionV4,
  encodeOpeningV2,
  encryptShares,
  KEM_PUBLIC_KEY,
  openChallengeV2,
  openedCommitments,
  openingV2CoreHash,
  opensBallotCommitment,
  proveValidity,
  proveValidityV3,
  questionBallotElection,
  type QuestionBallotElection,
  type RegisteredKeys,
  shareVote,
  shareVoteV3,
  type SpoiledBallotOpeningV2,
} from "../src/index.ts";
import { decode, encode } from "../src/codec.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/spoiled-opening-v2.json comes from an independent Python
// implementation of docs/spec/challenge.md, Opening version 2
// (scripts/ballot-v3-vectors.py), with ML-KEM-768 and ChaCha20-Poly1305
// written from FIPS 203 and RFC 8439, so the expected encodings, core hashes
// and verdicts never come from the code under test.

interface Vectors {
  readonly format: string;
  readonly recordType: string;
  readonly version: number;
  readonly tag: string;
  readonly panels: Readonly<
    Record<
      string,
      readonly {
        readonly seat: number;
        readonly seed: string;
        readonly x: string;
        readonly publicKey: string;
      }[]
    >
  >;
  readonly elections: Readonly<
    Record<
      string,
      {
        readonly definition: string;
        readonly definitionHash: string;
        readonly definitionVersion: 4 | 5;
        readonly ballotVersion: 2 | 3;
        readonly optionTotal: number;
        readonly cells: number;
        readonly panel: string;
        readonly registered: readonly number[];
      }
    >
  >;
  readonly openings: readonly {
    readonly id: string;
    readonly election: string;
    readonly encoding: string;
    readonly randomness?: {
      readonly polynomials: readonly {
        readonly f: readonly string[];
        readonly g: readonly string[];
      }[];
      readonly encapsulation: readonly {
        readonly m: string;
        readonly e: string;
        readonly w: string;
      }[];
    };
    readonly coreHash: string;
    readonly result: string;
    readonly votes?: readonly string[];
    readonly voteOutside?: { readonly question: number };
    readonly option?: number;
    readonly seat?: number;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset?: number;
  }[];
  readonly decodedCells: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly cell: number;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("spoiled-opening-v2.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

type CellElection = CellBallotElection | QuestionBallotElection;

const panelKeys = (name: string) =>
  (vectors.panels[name] ?? []).map((k) => decode(KEM_PUBLIC_KEY, hex(k.publicKey)));

function electionOf(name: string): CellElection {
  const e = vectors.elections[name];
  if (e === undefined) throw new Error(`no election ${name}`);
  const keys = panelKeys(e.panel);
  const keySet = (transcript: Uint8Array): readonly RegisteredKeys[] =>
    checkedKeySetForTests(
      e.registered.map((index) => ({
        index,
        kemKey: keys[index - 1] as (typeof keys)[number],
        signingKey: new Uint8Array(33),
      })),
      transcript,
    );
  if (e.definitionVersion === 5) {
    const d = decodeElectionDefinitionV5(hex(e.definition));
    return questionBallotElection(d, keySet(d.ceremony_transcript_hash));
  }
  const record = decodeElectionDefinitionRecord(hex(e.definition));
  if (record.version !== 4) throw new Error(`${name}: expected definition version 4`);
  const d = record.value as ElectionDefinitionV4;
  return cellBallotElection(d, keySet(d.ceremony_transcript_hash));
}

const elections = new Map(Object.keys(vectors.elections).map((n) => [n, electionOf(n)]));
const contextOf = (name: string) => elections.get(name) as CellElection;
const metaOf = (name: string) =>
  vectors.elections[name] as NonNullable<(typeof vectors.elections)[string]>;

const codeOf = (r: ChallengeOpeningV2Check) => (r.ok ? "ok" : r.code);

describe("spoiled-opening-v2.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-spoiled-opening-v2-vectors/1");
    expect(vectors.recordType).toBe("0x0003");
    expect(vectors.version).toBe(2);
    expect(vectors.tag).toBe("abolish/v1/ballot-core");
  });

  test.each(Object.entries(vectors.elections))("election %s: its context", (name, e) => {
    const election = contextOf(name);
    expect(toHex(election.definitionHash)).toBe(e.definitionHash);
    expect(election.cells.length).toBe(e.cells);
  });

  test.each(Object.entries(vectors.panels))("panel %s: keys from their seeds", (_, keys) => {
    for (const k of keys)
      expect(
        toHex(encode(KEM_PUBLIC_KEY, kemKeyPairWith(hex(k.seed), BigInt(k.x)).publicKey)),
      ).toBe(k.publicKey);
  });

  test.each(vectors.openings.map((o) => [o.id, o] as const))("%s", (_, o) => {
    const record = decodeOpening(hex(o.encoding), 2);
    expect(toHex(encodeOpeningV2(record))).toBe(o.encoding);
    // The tracking code under the ballot version the named election pins.
    expect(toHex(openingV2CoreHash(record, metaOf(o.election).ballotVersion))).toBe(o.coreHash);
    const result = checkChallengeOpeningV2(contextOf(o.election), record);
    expect(codeOf(result)).toBe(o.result);
    if (result.ok) {
      expect(toHex(result.coreHash)).toBe(o.coreHash);
      expect(result.votes.map(String)).toEqual(o.votes);
      expect(result.withinRules).toBe(o.voteOutside === undefined);
      expect(result.question).toBe(o.voteOutside?.question);
    } else {
      expect(result.option).toBe(o.option);
      expect(result.seat).toBe(o.seat);
    }
  });

  test("every check is covered, and so is a vote outside each kind of rule", () => {
    const codes = new Set(vectors.openings.map((o) => o.result));
    for (const code of [
      "ok",
      "opening-stray",
      "opening-cell",
      "opening-shape",
      "opening-unqualified",
      "opening-vss",
      "opening-ciphertext",
    ])
      expect(codes).toContain(code);
    expect(vectors.openings.filter((o) => o.voteOutside !== undefined).length).toBeGreaterThan(0);
  });

  // An honest client's opening, re-made byte for byte from the randomness
  // that made it: the polynomials, then every seat's encapsulation.
  test.each(
    vectors.openings
      .filter((o) => o.result === "ok" && o.voteOutside === undefined)
      .map((o) => [o.id, o] as const),
  )("openChallengeV2 re-makes %s", (_, o) => {
    const election = contextOf(o.election);
    const meta = metaOf(o.election);
    const r = o.randomness as NonNullable<typeof o.randomness>;
    const polynomials: OptionPolynomials[] = r.polynomials.map((p) => ({
      f: p.f.map(BigInt),
      g: p.g.map(BigInt),
    }));
    const votes = polynomials.map((p) => Number(p.f[0]) as 0 | 1);
    const sharing =
      "questions" in election
        ? shareVoteV3With(election, votes, polynomials)
        : shareVoteWith(election, votes, polynomials);
    const encrypted = encryptSharesWith(
      { definitionHash: election.definitionHash },
      sharing,
      panelKeys(meta.panel),
      r.encapsulation.map((x) => ({ m: hex(x.m), e: BigInt(x.e), w: BigInt(x.w) })),
    );
    const { cell } = decodeOpening(hex(o.encoding), 2);
    expect(toHex(cellTrackingCode(election, cell, encrypted))).toBe(o.coreHash);
    const made = openChallengeV2(election, cell, encrypted);
    expect(toHex(encodeOpeningV2(made.opening))).toBe(o.encoding);
    expect(toHex(made.coreHash)).toBe(o.coreHash);
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("rejects %s", (_, d) => {
    let error: unknown;
    try {
      decodeOpening(hex(d.encoding), 2);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).code).toBe(d.error);
    if (d.offset !== undefined) expect((error as DecodeError).offset).toBe(d.offset);
  });

  test.each(vectors.decodedCells.map((d) => [d.id, d] as const))("%s", (_, d) => {
    const record = decodeOpening(hex(d.encoding), 2);
    expect(record.cell).toBe(d.cell);
    expect(toHex(encodeOpeningV2(record))).toBe(d.encoding);
  });

  test("a version-2 opening is refused under a pin of 1, and a version-1 opening under 2", () => {
    const o = vectors.openings[0] as (typeof vectors.openings)[number];
    expect(() => decodeOpening(hex(o.encoding), 1)).toThrow(DecodeError);
    const v1 = JSON.parse(readFileSync(new URL("challenge.json", SPEC_VECTORS), "utf8")) as {
      readonly openings: readonly { readonly encoding: string }[];
    };
    expect(() => decodeOpening(hex((v1.openings[0] as { encoding: string }).encoding), 2)).toThrow(
      DecodeError,
    );
  });
});

const four = contextOf("opening-four") as QuestionBallotElection;
const regional = contextOf("opening-regional") as CellBallotElection;
const fourKeys = panelKeys(metaOf("opening-four").panel);
const regionalKeys = panelKeys(metaOf("opening-regional").panel);
const honestVector = vectors.openings.find((o) => o.id === "questions");
if (honestVector === undefined) throw new Error("no honest version-3 opening");
const honest = hex(honestVector.encoding);

// Votes within every question's limits, over the flat options.
const votesFor = (
  questions: readonly { optionCount: number; minSelections: number; maxSelections: number }[],
) =>
  fc
    .tuple(
      ...questions.map((q) =>
        fc
          .array(fc.boolean(), { minLength: q.optionCount, maxLength: q.optionCount })
          .map((bits) => bits.map((b) => (b ? 1 : 0) as 0 | 1))
          .filter((v) => {
            const total = v.reduce<number>((a, x) => a + x, 0);
            return total >= q.minSelections && total <= q.maxSelections;
          }),
      ),
    )
    .map((parts) => parts.flat());

const sharingFor = (election: CellElection, votes: readonly (0 | 1)[]) =>
  "questions" in election ? shareVoteV3(election, votes) : shareVote(election, votes);

describe("opening version 2", () => {
  test("an honest client's opening passes, shows its votes and has the code shown before the choice", () => {
    const cases: [CellElection, typeof fourKeys, number][] = [
      [four, fourKeys, four.cells.length - 1],
      [regional, regionalKeys, 2],
    ];
    for (const [election, keys, cell] of cases)
      fc.assert(
        fc.property(
          votesFor("questions" in election ? election.questions : [election]),
          (votes) => {
            const encrypted = encryptShares(
              { definitionHash: election.definitionHash },
              sharingFor(election, votes),
              keys,
            );
            const shown = cellTrackingCode(election, cell, encrypted);
            const core = cellBallotCore(election, cell, encrypted);
            const { opening, coreHash } = openChallengeV2(election, cell, encrypted);
            expect(toHex(coreHash)).toBe(toHex(shown));
            expect(toHex(cellCoreHash(core))).toBe(toHex(shown));
            expect(opening.cell).toBe(cell);
            const result = checkChallengeOpeningV2(election, opening);
            if (!result.ok) throw new Error(`expected a passing opening, got ${result.code}`);
            expect(result.votes).toEqual(votes.map(BigInt));
            expect(result.withinRules).toBe(true);
            expect(result.question).toBeUndefined();
            expect(toHex(result.coreHash)).toBe(toHex(shown));
            // Its commitments are opened under any cell of the election.
            expect(
              opensBallotCommitment(openedCommitments(opening), {
                definitionHash: election.definitionHash,
                vss: core.vss,
              }),
            ).toBe(true);
          },
        ),
        { numRuns: Math.max(5, Math.floor(numRuns / 20)) },
      );
  }, 300_000);

  test("the ballot version the context checks decides the code: version 2 and 3 cores differ", () => {
    const record = decodeOpening(honest, 2);
    const result = checkChallengeOpeningV2(four, record);
    if (!result.ok) throw new Error(result.code);
    expect(toHex(result.coreHash)).toBe(toHex(openingV2CoreHash(record, 3)));
    expect(toHex(result.coreHash)).not.toBe(toHex(openingV2CoreHash(record, 2)));
  });

  test("no changed byte opens the same core: it fails to decode, fails a check or names another core", () => {
    const code = honestVector.coreHash;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: honest.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, delta) => {
          const bytes = Uint8Array.from(honest);
          bytes[at] = ((bytes[at] as number) + delta) & 0xff;
          let record: SpoiledBallotOpeningV2;
          try {
            record = decodeOpening(bytes, 2);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          expect(toHex(encodeOpeningV2(record))).toBe(toHex(bytes));
          const result = checkChallengeOpeningV2(four, record);
          // A changed cell is a different core: the cell is free before the
          // choice, and the checker compares the full code (challenge.md).
          if (result.ok) expect(toHex(result.coreHash)).not.toBe(code);
        },
      ),
      { numRuns: Math.max(10, Math.floor(numRuns / 10)) },
    );
  }, 300_000);

  test("an opened sharing is never proved, and a proved sharing is never opened", () => {
    const ctx = { definitionHash: four.definitionHash };
    const votes: (0 | 1)[] = [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, 0];
    const validity = { ...four, cell: 0, nullifier: 12345n };
    const opened = shareVoteV3(four, votes);
    const openedShares = encryptShares(ctx, opened, fourKeys);
    openChallengeV2(four, 0, openedShares);
    expect(() => proveValidityV3(validity, opened, openedShares.hashes)).toThrow(
      /opened by a challenge/,
    );
    const cast = shareVoteV3(four, votes);
    const castShares = encryptShares(ctx, cast, fourKeys);
    proveValidityV3(validity, cast, castShares.hashes);
    expect(() => openChallengeV2(four, 0, castShares)).toThrow(/proved for casting/);
    // Ballot version 2 proves a version-1 sharing over the cell.
    const rctx = { definitionHash: regional.definitionHash };
    const v2 = shareVote(regional, [0, 1, 0]);
    const v2Shares = encryptShares(rctx, v2, regionalKeys);
    proveValidity({ ...regional, ballotVersion: 2, cell: 1, nullifier: 1n }, v2, v2Shares.hashes);
    expect(() => openChallengeV2(regional, 1, v2Shares)).toThrow(/proved for casting/);
  });

  test("openChallengeV2 opens only this context's sharing version, cells and registered keys", () => {
    const ctx = { definitionHash: four.definitionHash };
    const votes: (0 | 1)[] = [0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 0];
    const encrypted = encryptShares(ctx, shareVoteV3(four, votes), fourKeys);
    // A cell past the partition, or not a cell at all.
    for (const cell of [four.cells.length, -1, 0.5, 255])
      expect(() => openChallengeV2(four, cell, encrypted)).toThrow(/no such cell/);
    // A copy isn't the object encryptShares made.
    expect(() => openChallengeV2(four, 0, { ...encrypted })).toThrow(/encryptShares/);
    // Another election's definition hash.
    const other = encryptShares(
      { definitionHash: new Uint8Array(32).fill(7) },
      shareVoteV3(four, votes),
      fourKeys,
    );
    expect(() => openChallengeV2(four, 0, other)).toThrow(/another election/);
    // Seat 1's shares encrypted to seat 2's key.
    const swapped = encryptShares(ctx, shareVoteV3(four, votes), [
      fourKeys[1] as (typeof fourKeys)[number],
      ...fourKeys.slice(1),
    ]);
    expect(() => openChallengeV2(four, 0, swapped)).toThrow(/registered key/);
    // A version-1 sharing of the same width under the question context, and
    // a version-3 sharing under ballot version 2's: neither is that ballot
    // version's core (T-42).
    const v1 = encryptShares(
      ctx,
      shareVote(
        { optionCount: 18, minSelections: 0, maxSelections: 18, threshold: 3, panelSize: 4 },
        votes,
      ),
      fourKeys,
    );
    expect(() => openChallengeV2(four, 0, v1)).toThrow(/version-3 sharing/);
    expect(() => cellTrackingCode(four, 0, v1)).toThrow(/version-3 sharing/);
    const rctx = { definitionHash: regional.definitionHash };
    const v3 = encryptShares(
      rctx,
      shareVoteV3(
        {
          questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
          threshold: 2,
          panelSize: 3,
        },
        [1, 0, 0],
      ),
      regionalKeys,
    );
    expect(() => openChallengeV2(regional, 0, v3)).toThrow(/version-1 sharing/);
    // A seat outside the registered key set gets a zero share hash and reveals nothing.
    const { opening } = openChallengeV2(four, 0, encrypted);
    expect(opening.seats.map((s) => s.seat)).toEqual([1, 2, 4]);
    expect(toHex(opening.share_hashes[2] as Uint8Array)).toBe("00".repeat(32));
    expect(checkChallengeOpeningV2(four, opening).ok).toBe(true);
  });

  test("version-1 and cell contexts never cross", () => {
    const v1 = JSON.parse(readFileSync(new URL("challenge.json", SPEC_VECTORS), "utf8")) as {
      readonly panels: Readonly<Record<string, readonly { readonly publicKey: string }[]>>;
      readonly elections: Readonly<
        Record<
          string,
          { readonly definition: string; readonly panel: string; readonly registered: number[] }
        >
      >;
    };
    const e = v1.elections["plurality"] as NonNullable<(typeof v1.elections)[string]>;
    const keys = (v1.panels[e.panel] ?? []).map((k) => decode(KEM_PUBLIC_KEY, hex(k.publicKey)));
    const definition = decodeElectionDefinition(hex(e.definition));
    const plurality = ballotElection(
      definition,
      checkedKeySetForTests(
        e.registered.map((index) => ({
          index,
          kemKey: keys[index - 1] as (typeof keys)[number],
          signingKey: new Uint8Array(33),
        })),
        definition.ceremony_transcript_hash,
      ),
    );
    const record = decodeOpening(honest, 2);
    expect(() => checkChallengeOpeningV2(plurality as unknown as CellElection, record)).toThrow(
      /cellBallotElection or questionBallotElection/,
    );
    expect(() =>
      checkChallengeOpening(four as unknown as typeof plurality, record as never),
    ).toThrow(/ballotElection/);
    // A copy of a context isn't the one its maker recorded.
    expect(() => checkChallengeOpeningV2({ ...four }, record)).toThrow(
      /cellBallotElection or questionBallotElection/,
    );
  });

  test("a hand-built opening with a cell past the partition is opening-cell before its shape", () => {
    const record = decodeOpening(honest, 2);
    const result = checkChallengeOpeningV2(four, { ...record, cell: four.cells.length, vss: [] });
    expect(codeOf(result)).toBe("opening-cell");
    // Nor is any cell that isn't a u8 a decoder could have returned.
    for (const cell of [-1, 0.5])
      expect(codeOf(checkChallengeOpeningV2(four, { ...record, cell }))).toBe("opening-cell");
  });
});
