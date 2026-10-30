import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { type OptionPolynomials, shareVoteV4With } from "../src/ballot-validity.ts";
import { panelBallotElectionWith } from "../src/ballot.ts";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import {
  checkChallengeOpeningV3With,
  openChallengeV3With,
  panelBallotCoreWith,
} from "../src/challenge.ts";
import { decode, encode } from "../src/codec.ts";
import { elementOrIdentity, G, GENERATOR_H } from "../src/group.ts";
import { encryptSharesV4, encryptSharesV4With, kemKeyPairWith } from "../src/share-encryption.ts";
import {
  type ChallengeOpeningV3Check,
  checkChallengeOpeningV2,
  checkChallengeOpeningV3,
  coreHashV4,
  coreHashV5,
  DecodeError,
  decodeElectionDefinitionV6,
  decodeOpening,
  encodeOpeningV3,
  KEM_PUBLIC_KEY,
  openChallengeV3,
  openedCommitments,
  openedCommitmentsV3,
  openingV3CoreHash,
  opensBallotCommitment,
  opensBallotCommitmentV4,
  type PanelBallotElection,
  panelBallotCore,
  panelBallotElection,
  panelTrackingCode,
  proveValidityV4,
  type RegisteredKeys,
  shareVoteV4,
  type SpoiledBallotOpeningV3,
  voteCommitmentsV4,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/spoiled-opening-v3.json comes from an independent Python
// implementation of docs/spec/challenge.md, Opening version 3
// (scripts/spoiled-opening-v3-vectors.py), with ML-KEM-768 and
// ChaCha20-Poly1305 written from FIPS 203 and RFC 8439, so the expected
// encodings, core hashes, verdicts and opened commitments never come from the
// code under test. These vectors carry no author run, so polls with an author
// panel run through the internal `…With` paths, which take its key set as
// given; the exported paths take only the approved set `panelBallotElection`
// was made with and refuse these (author-key-set.test.ts runs them with one).

interface Vectors {
  readonly format: string;
  readonly recordType: string;
  readonly version: number;
  readonly tag: string;
  readonly panels: {
    readonly default: number;
    readonly author: number;
    readonly keys: Readonly<
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
  };
  readonly elections: Readonly<
    Record<
      string,
      {
        readonly definition: string;
        readonly definitionHash: string;
        readonly optionTotal: number;
        readonly cells: number;
        readonly authorPanelSize: number;
        readonly panel: string;
        readonly authorPanel: string | null;
        readonly registered: readonly number[];
        readonly authorRegistered: readonly number[];
      }
    >
  >;
  readonly openings: readonly {
    readonly id: string;
    readonly election: string;
    readonly encoding: string;
    readonly coreHash: string;
    readonly randomness?: {
      readonly polynomials: readonly {
        readonly f: readonly string[];
        readonly g: readonly string[];
      }[];
      readonly authorPolynomials: readonly {
        readonly f: readonly string[];
        readonly g: readonly string[];
      }[];
      readonly encapsulation: readonly {
        readonly m: string;
        readonly e: string;
        readonly w: string;
      }[];
      readonly authorEncapsulation: readonly {
        readonly m: string;
        readonly e: string;
        readonly w: string;
      }[];
    };
    readonly result: string;
    readonly votes?: readonly string[];
    readonly voteRandomness?: readonly string[];
    readonly voteOutside?: { readonly question: number };
    readonly option?: number;
    readonly seat?: number;
    readonly panel?: number;
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
  readonly opened: readonly {
    readonly id: string;
    readonly opening: string;
    readonly definitionHash: string;
    readonly vss: readonly (readonly string[])[];
    readonly authorVss: readonly (readonly string[])[];
    readonly opens: boolean;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("spoiled-opening-v3.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const metaOf = (name: string) =>
  vectors.elections[name] as NonNullable<(typeof vectors.elections)[string]>;

const panelKeys = (name: string | null) =>
  name === null
    ? []
    : (vectors.panels.keys[name] ?? []).map((k) => decode(KEM_PUBLIC_KEY, hex(k.publicKey)));

const registeredOf = (keys: ReturnType<typeof panelKeys>, seats: readonly number[]) =>
  seats.map((index) => ({
    index,
    kemKey: keys[index - 1] as (typeof keys)[number],
    signingKey: new Uint8Array(33),
  }));

interface Poll {
  readonly election: PanelBallotElection;
  /** The author panel's registered key set, as the internal paths take it. */
  readonly authorKeys: readonly RegisteredKeys[];
}

function pollOf(name: string): Poll {
  const e = metaOf(name);
  const d = decodeElectionDefinitionV6(hex(e.definition));
  const registered = checkedKeySetForTests(
    registeredOf(panelKeys(e.panel), e.registered),
    d.ceremony_transcript_hash,
  );
  return {
    election: panelBallotElectionWith(d, registered, e.authorRegistered),
    authorKeys: registeredOf(panelKeys(e.authorPanel), e.authorRegistered),
  };
}

const polls = new Map(Object.keys(vectors.elections).map((n) => [n, pollOf(n)]));
const pollNamed = (name: string) => polls.get(name) as Poll;

const codeOf = (r: ChallengeOpeningV3Check) => (r.ok ? "ok" : r.code);
const elementOf = (h: string) => decode(elementOrIdentity, hex(h));

describe("spoiled-opening-v3.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-spoiled-opening-v3-vectors/1");
    expect(vectors.recordType).toBe("0x0003");
    expect(vectors.version).toBe(3);
    expect(vectors.tag).toBe("abolish/v1/ballot-core");
    expect([vectors.panels.default, vectors.panels.author]).toEqual([1, 2]);
  });

  test.each(Object.entries(vectors.elections))("election %s: its context", (name, e) => {
    const { election } = pollNamed(name);
    expect(toHex(election.definitionHash)).toBe(e.definitionHash);
    expect(election.cells.length).toBe(e.cells);
    expect(election.authorPanelSize).toBe(e.authorPanelSize);
  });

  test.each(Object.entries(vectors.panels.keys))("panel %s: keys from their seeds", (_, keys) => {
    for (const k of keys)
      expect(
        toHex(encode(KEM_PUBLIC_KEY, kemKeyPairWith(hex(k.seed), BigInt(k.x)).publicKey)),
      ).toBe(k.publicKey);
  });

  test.each(vectors.openings.map((o) => [o.id, o] as const))("%s", (_, o) => {
    const record = decodeOpening(hex(o.encoding), 3);
    expect(toHex(encodeOpeningV3(record))).toBe(o.encoding);
    expect(toHex(openingV3CoreHash(record))).toBe(o.coreHash);
    const { election, authorKeys } = pollNamed(o.election);
    const result = checkChallengeOpeningV3With(election, authorKeys, record);
    expect(codeOf(result)).toBe(o.result);
    if (result.ok) {
      expect(toHex(result.coreHash)).toBe(o.coreHash);
      expect(result.votes.map(String)).toEqual(o.votes);
      expect(result.randomness.map(String)).toEqual(o.voteRandomness);
      expect(result.withinRules).toBe(o.voteOutside === undefined);
      expect(result.question).toBe(o.voteOutside?.question);
      // The vote and its randomness open each C_j = E^D_{j,0} · E^A_{j,0}.
      const commitments = voteCommitmentsV4(record);
      result.votes.forEach((v, j) => {
        const r = result.randomness[j] as bigint;
        const opened =
          v === 0n ? GENERATOR_H.multiply(r) : G.multiply(v).add(GENERATOR_H.multiply(r));
        expect(opened.equals(commitments[j] as (typeof commitments)[number])).toBe(true);
      });
    } else {
      expect(result.option).toBe(o.option);
      expect(result.seat).toBe(o.seat);
      expect(result.panel).toBe(o.panel);
    }
    // Without an author panel the exported check agrees.
    if (election.authorPanelSize === 0)
      expect(checkChallengeOpeningV3(election, record)).toEqual(result);
  });

  test("every check is covered in both panels, and so is a vote outside the rules", () => {
    const seen = new Set(vectors.openings.map((o) => `${o.result}/${o.panel ?? ""}`));
    for (const code of [
      "ok/",
      "opening-stray/",
      "opening-cell/",
      "opening-shape/",
      "opening-unqualified/",
      "opening-vss/1",
      "opening-vss/2",
      "opening-ciphertext/1",
      "opening-ciphertext/2",
    ])
      expect(seen).toContain(code);
    expect(vectors.openings.filter((o) => o.voteOutside !== undefined).length).toBeGreaterThan(0);
  });

  // An honest client's opening, re-made byte for byte from the randomness
  // that made it: both halves' polynomials, then every seat's encapsulation
  // in each panel, an unregistered seat's included (its hash is zeroed).
  test.each(
    vectors.openings
      .filter((o) => o.result === "ok" && o.voteOutside === undefined)
      .map((o) => [o.id, o] as const),
  )("openChallengeV3With re-makes %s", (_, o) => {
    const { election, authorKeys } = pollNamed(o.election);
    const meta = metaOf(o.election);
    const r = o.randomness as NonNullable<typeof o.randomness>;
    const polys = (ps: typeof r.polynomials): OptionPolynomials[] =>
      ps.map((p) => ({ f: p.f.map(BigInt), g: p.g.map(BigInt) }));
    const encapsulation = (es: typeof r.encapsulation) =>
      es.map((x) => ({ m: hex(x.m), e: BigInt(x.e), w: BigInt(x.w) }));
    const record = decodeOpening(hex(o.encoding), 3);
    const votes = (o.votes ?? []).map((v) => Number(v) as 0 | 1);
    const sharing = shareVoteV4With(
      election,
      votes,
      polys(r.polynomials),
      polys(r.authorPolynomials),
    );
    const encrypted = encryptSharesV4With(
      { definitionHash: election.definitionHash },
      sharing,
      panelKeys(meta.panel),
      panelKeys(meta.authorPanel),
      encapsulation(r.encapsulation),
      encapsulation(r.authorEncapsulation),
    );
    const core = panelBallotCoreWith(election, authorKeys, record.cell, encrypted);
    expect(toHex(coreHashV4(core))).toBe(o.coreHash);
    const made = openChallengeV3With(election, authorKeys, record.cell, encrypted);
    expect(toHex(encodeOpeningV3(made.opening))).toBe(o.encoding);
    expect(toHex(made.coreHash)).toBe(o.coreHash);
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("rejects %s", (_, d) => {
    let error: unknown;
    try {
      decodeOpening(hex(d.encoding), 3);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).code).toBe(d.error);
    if (d.offset !== undefined) expect((error as DecodeError).offset).toBe(d.offset);
  });

  test.each(vectors.decodedCells.map((d) => [d.id, d] as const))("%s", (_, d) => {
    const record = decodeOpening(hex(d.encoding), 3);
    expect(record.cell).toBe(d.cell);
    expect(toHex(encodeOpeningV3(record))).toBe(d.encoding);
  });

  test.each(vectors.opened.map((v) => [v.id, v] as const))("opened: %s", (_, v) => {
    const source = vectors.openings.find((o) => o.id === v.opening);
    if (source === undefined) throw new Error(`no opening ${v.opening}`);
    const opened = openedCommitmentsV3(decodeOpening(hex(source.encoding), 3));
    const ballot = {
      definitionHash: hex(v.definitionHash),
      vss: v.vss.map((row) => row.map(elementOf)),
      authorVss: v.authorVss.map((row) => row.map(elementOf)),
    };
    expect(opensBallotCommitmentV4(opened, ballot)).toBe(v.opens);
  });

  test("version 3 is read only under its own pin, and versions 1 and 2 never under it", () => {
    const o = vectors.openings[0] as (typeof vectors.openings)[number];
    expect(() => decodeOpening(hex(o.encoding), 2)).toThrow(DecodeError);
    for (const file of ["challenge.json", "spoiled-opening-v2.json"]) {
      const older = JSON.parse(readFileSync(new URL(file, SPEC_VECTORS), "utf8")) as {
        readonly openings: readonly { readonly encoding: string }[];
      };
      expect(() =>
        decodeOpening(hex((older.openings[0] as { encoding: string }).encoding), 3),
      ).toThrow(DecodeError);
    }
  });
});

const author = pollNamed("author");
const plain = pollNamed("no-author");
const authorMeta = metaOf("author");
const plainMeta = metaOf("no-author");
const honestVector = vectors.openings.find((o) => o.id === "author");
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

const encryptFor = (poll: Poll, votes: readonly (0 | 1)[], meta: typeof authorMeta) =>
  encryptSharesV4(
    { definitionHash: poll.election.definitionHash },
    shareVoteV4(poll.election, votes),
    panelKeys(meta.panel),
    panelKeys(meta.authorPanel),
  );

describe("opening version 3", () => {
  test("an honest client's opening passes, shows its votes and has the code shown before the choice", () => {
    for (const [poll, meta] of [
      [author, authorMeta],
      [plain, plainMeta],
    ] as const)
      fc.assert(
        fc.property(
          votesFor(poll.election.questions),
          fc.integer({ min: 0, max: poll.election.cells.length - 1 }),
          (votes, cell) => {
            const encrypted = encryptFor(poll, votes, meta);
            const core = panelBallotCoreWith(poll.election, poll.authorKeys, cell, encrypted);
            const { opening, coreHash } = openChallengeV3With(
              poll.election,
              poll.authorKeys,
              cell,
              encrypted,
            );
            expect(toHex(coreHash)).toBe(toHex(coreHashV4(core)));
            const result = checkChallengeOpeningV3With(poll.election, poll.authorKeys, opening);
            if (!result.ok) throw new Error(`expected a passing opening, got ${result.code}`);
            expect(result.votes).toEqual(votes.map(BigInt));
            expect(result.withinRules).toBe(true);
            expect(toHex(result.coreHash)).toBe(toHex(coreHash));
            // A seat outside its panel's registered key set reveals nothing.
            expect(opening.seats.map((s) => s.seat)).toEqual([...poll.election.qualified]);
            expect(opening.author_seats.map((s) => s.seat)).toEqual([
              ...poll.election.authorQualified,
            ]);
            // Its commitments are opened under any cell of the election.
            expect(opensBallotCommitmentV4(openedCommitmentsV3(opening), core)).toBe(true);
          },
        ),
        { numRuns: Math.max(5, Math.floor(numRuns / 20)) },
      );
  }, 300_000);

  test("without an author panel the exported paths agree with the internal ones", () => {
    const votes: (0 | 1)[] = [1, 0, 0, 1];
    const encrypted = encryptFor(plain, votes, plainMeta);
    const shown = panelTrackingCode(plain.election, 2, encrypted);
    expect(toHex(coreHashV4(panelBallotCore(plain.election, 2, encrypted)))).toBe(toHex(shown));
    const { opening, coreHash } = openChallengeV3(plain.election, 2, encrypted);
    expect(toHex(coreHash)).toBe(toHex(shown));
    expect(opening.author_vss).toEqual([]);
    expect(opening.author_share_hashes).toEqual([]);
    expect(opening.author_polynomials).toEqual([]);
    expect(opening.author_seats).toEqual([]);
    const result = checkChallengeOpeningV3(plain.election, opening);
    expect(result).toEqual(checkChallengeOpeningV3With(plain.election, [], opening));
    expect(result.ok).toBe(true);
  });

  test("the exported paths refuse a context beside an author panel with no approved key set", () => {
    const encrypted = encryptFor(author, [0, 1, 0, 1, 0], authorMeta);
    const record = decodeOpening(honest, 3);
    expect(() => checkChallengeOpeningV3(author.election, record)).toThrow(/approved one/);
    expect(() => openChallengeV3(author.election, 0, encrypted)).toThrow(/approved one/);
    expect(() => panelBallotCore(author.election, 0, encrypted)).toThrow(/approved one/);
    expect(() => panelTrackingCode(author.election, 0, encrypted)).toThrow(/approved one/);
    // And panelBallotElection makes one only from an approved author key set
    // (author-key-set.test.ts).
    const d = decodeElectionDefinitionV6(hex(authorMeta.definition));
    expect(() => panelBallotElection(d, [])).toThrow(RangeError);
  });

  test("the internal paths take exactly the author panel's registered seats", () => {
    const record = decodeOpening(honest, 3);
    const [first, second] = author.authorKeys as [RegisteredKeys, RegisteredKeys];
    for (const keys of [[], [first], [first, second, { ...second, index: 2 }], [second, second]])
      expect(() => checkChallengeOpeningV3With(author.election, keys, record)).toThrow(
        /registered seats/,
      );
    // Their order doesn't matter.
    expect(checkChallengeOpeningV3With(author.election, [second, first], record).ok).toBe(true);
    // An author seat's key other than the one its ciphertext was made to fails that seat.
    const swapped = [first, { ...second, kemKey: first.kemKey }];
    expect(checkChallengeOpeningV3With(author.election, swapped, record)).toEqual({
      ok: false,
      code: "opening-ciphertext",
      seat: 3,
      panel: 2,
    });
  });

  test("no changed byte opens the same core: it fails to decode, fails a check or names another core", () => {
    const code = honestVector.coreHash;
    const votes = honestVector.votes;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: honest.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, delta) => {
          const bytes = Uint8Array.from(honest);
          bytes[at] = ((bytes[at] as number) + delta) & 0xff;
          let record: SpoiledBallotOpeningV3;
          try {
            record = decodeOpening(bytes, 3);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          expect(toHex(encodeOpeningV3(record))).toBe(toHex(bytes));
          const result = checkChallengeOpeningV3With(author.election, author.authorKeys, record);
          // A changed cell is a different core, with the same vote.
          if (result.ok) {
            expect(toHex(result.coreHash)).not.toBe(code);
            expect(result.votes.map(String)).toEqual(votes);
          }
        },
      ),
      { numRuns: Math.max(10, Math.floor(numRuns / 10)) },
    );
  }, 300_000);

  test("an opened sharing is never proved, and a proved sharing is never opened", () => {
    const ctx = { ...plain.election, cell: 0, nullifier: 12345n };
    const votes: (0 | 1)[] = [0, 1, 1, 0];
    const shares = (sharing: ReturnType<typeof shareVoteV4>) =>
      encryptSharesV4(
        { definitionHash: plain.election.definitionHash },
        sharing,
        panelKeys(plainMeta.panel),
        [],
      );
    const opened = shareVoteV4(plain.election, votes);
    const openedShares = shares(opened);
    openChallengeV3(plain.election, 0, openedShares);
    expect(() => proveValidityV4(ctx, opened, openedShares.hashes, [])).toThrow(
      /opened by a challenge/,
    );
    const cast = shareVoteV4(plain.election, votes);
    const castShares = shares(cast);
    proveValidityV4(ctx, cast, castShares.hashes, []);
    expect(() => openChallengeV3(plain.election, 0, castShares)).toThrow(/proved for casting/);
  });

  test("openChallengeV3 opens only this context's shares, cells and registered keys", () => {
    const votes: (0 | 1)[] = [1, 0, 0, 0, 1];
    const encrypted = encryptFor(author, votes, authorMeta);
    const open = (cell: number, shares: typeof encrypted) =>
      openChallengeV3With(author.election, author.authorKeys, cell, shares);
    for (const cell of [author.election.cells.length, -1, 0.5, 255])
      expect(() => open(cell, encrypted)).toThrow(/no such cell/);
    // A copy isn't the object encryptSharesV4 made.
    expect(() => open(0, { ...encrypted })).toThrow(/encryptSharesV4/);
    // Another election's definition hash.
    const keys = panelKeys(authorMeta.panel);
    const authorPanel = panelKeys(authorMeta.authorPanel);
    const other = encryptSharesV4(
      { definitionHash: new Uint8Array(32).fill(7) },
      shareVoteV4(author.election, votes),
      keys,
      authorPanel,
    );
    expect(() => open(0, other)).toThrow(/another election/);
    // Author seat 3's shares encrypted to author seat 1's key.
    const swapped = encryptSharesV4(
      { definitionHash: author.election.definitionHash },
      shareVoteV4(author.election, votes),
      keys,
      [authorPanel[0], authorPanel[1], authorPanel[0]] as typeof authorPanel,
    );
    expect(() => open(0, swapped)).toThrow(/registered key/);
    // A sharing for a poll without an author panel isn't this poll's.
    const narrow = encryptSharesV4(
      { definitionHash: author.election.definitionHash },
      shareVoteV4({ ...author.election, authorThreshold: 0, authorPanelSize: 0 }, votes),
      keys,
      [],
    );
    expect(() => open(0, narrow)).toThrow(/doesn't match the election/);
    // Unregistered seats of both panels get zero share hashes and reveal nothing.
    const { opening } = open(0, encrypted);
    expect(toHex(opening.share_hashes[2] as Uint8Array)).toBe("00".repeat(32));
    expect(toHex(opening.author_share_hashes[1] as Uint8Array)).toBe("00".repeat(32));
    expect(opening.seats.map((s) => s.seat)).toEqual([1, 2, 4]);
    expect(opening.author_seats.map((s) => s.seat)).toEqual([1, 3]);
  });

  test("version-3 and cell contexts never cross", () => {
    const record = decodeOpening(honest, 3);
    expect(() => checkChallengeOpeningV2(author.election as never, record as never)).toThrow(
      /cellBallotElection or questionBallotElection/,
    );
    // A copy of a context isn't the one its maker recorded.
    expect(() =>
      checkChallengeOpeningV3With({ ...author.election }, author.authorKeys, record),
    ).toThrow(/panelBallotElection/);
  });

  test("its tracking code is the core hash of the ballot version the election pins, 4 or 5", () => {
    // One code never names cores of two ballot versions (docs/spec/
    // challenge.md, Opening version 3, Core and tracking code; T-42, T-47).
    const record = decodeOpening(honest, 3);
    const core = {
      definitionHash: record.definition_hash,
      cell: record.cell,
      vss: record.vss,
      shareHashes: record.share_hashes,
      authorVss: record.author_vss,
      authorShareHashes: record.author_share_hashes,
    };
    expect(openingV3CoreHash(record)).toEqual(coreHashV4(core));
    expect(openingV3CoreHash(record, 4)).toEqual(coreHashV4(core));
    expect(openingV3CoreHash(record, 5)).toEqual(coreHashV5(core));
    expect(openingV3CoreHash(record, 5)).not.toEqual(openingV3CoreHash(record, 4));
    for (const v of [2, 3, 6, 4.5])
      expect(() => openingV3CoreHash(record, v as 4)).toThrow(/ballotVersion must be 4 or 5/);
  });

  test("a hand-built opening with a cell past the partition is opening-cell before its shape", () => {
    const record = decodeOpening(honest, 3);
    const check = (o: SpoiledBallotOpeningV3) =>
      codeOf(checkChallengeOpeningV3With(author.election, author.authorKeys, o));
    expect(check({ ...record, cell: author.election.cells.length, vss: [] })).toBe("opening-cell");
    for (const cell of [-1, 0.5]) expect(check({ ...record, cell })).toBe("opening-cell");
  });

  test("an opening opens the commitments of ballots under its own definition only", () => {
    const record = decodeOpening(honest, 3);
    const opened = openedCommitmentsV3(record);
    const core = {
      definitionHash: record.definition_hash,
      vss: record.vss,
      authorVss: record.author_vss,
    };
    expect(opensBallotCommitmentV4(opened, core)).toBe(true);
    expect(
      opensBallotCommitmentV4(opened, { ...core, definitionHash: new Uint8Array(32).fill(1) }),
    ).toBe(false);
    // Versions 1 and 2's matching never takes a version-3 opening or a
    // version-4 ballot: it would miss the author half (T-47).
    expect(() => openedCommitments(record as never)).toThrow(/openedCommitmentsV3/);
    expect(() => opensBallotCommitment(opened, core as never)).toThrow(/opensBallotCommitmentV4/);
    // The opened set is private: only lookups are exposed.
    expect(Object.keys(opened).sort()).toEqual(["definitionHash", "has", "hasHalf"]);
  });
});
