import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { type OptionPolynomials, shareVoteWith, VSS } from "../src/ballot-validity.ts";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { encryptSharesWith, kemKeyPairWith } from "../src/share-encryption.ts";
import {
  type BallotElection,
  ballotCore,
  ballotCoreHash,
  sharesVoteCommitment,
  ballotElection,
  type ChallengeOpeningCheck,
  checkChallengeOpening,
  coreHash,
  DecodeError,
  decodeBallot,
  decodeElectionDefinition,
  decodeOpening,
  type ElectionDefinition,
  encodeOpening,
  encryptShares,
  KEM_PUBLIC_KEY,
  openChallenge,
  openingCoreHash,
  proveValidity,
  type RegisteredKeys,
  shareVote,
  type SpoiledBallotOpening,
  trackingCode,
  type ValidityContext,
} from "../src/index.ts";
import { decode, encode } from "../src/codec.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/challenge.json comes from an independent Python
// implementation of docs/spec/challenge.md (scripts/challenge-vectors.py),
// with ML-KEM-768 and ChaCha20-Poly1305 written from FIPS 203 and RFC 8439,
// so the expected encodings, core hashes and verdicts never come from the
// code under test.

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
        readonly panel: string;
        readonly registered: readonly number[];
      }
    >
  >;
  readonly openings: readonly {
    readonly id: string;
    readonly description: string;
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
    readonly withinRules?: boolean;
    readonly option?: number;
    readonly seat?: number;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly description: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset?: number;
  }[];
  readonly sharedCommitment: readonly {
    readonly id: string;
    readonly opening: string;
    readonly core: {
      readonly definitionHash: string;
      readonly tier: number;
      readonly vss: string;
      readonly shareHashes: readonly string[];
    };
    readonly coreHash: string;
    readonly shared: boolean;
  }[];
  readonly castBallots: readonly { readonly ballot: string; readonly coreHash: string }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("challenge.json", SPEC_VECTORS), "utf8"),
) as Vectors;
const ballotVectors = JSON.parse(readFileSync(new URL("ballot.json", SPEC_VECTORS), "utf8")) as {
  readonly ballots: readonly { readonly id: string; readonly encoding: string }[];
};

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const panelKeys = (name: string) =>
  (vectors.panels[name] ?? []).map((k) => decode(KEM_PUBLIC_KEY, hex(k.publicKey)));

function electionOf(name: string): {
  readonly election: BallotElection;
  readonly definition: ElectionDefinition;
} {
  const e = vectors.elections[name];
  if (e === undefined) throw new Error(`no election ${name}`);
  const definition = decodeElectionDefinition(hex(e.definition));
  const keys = panelKeys(e.panel);
  const registered: readonly RegisteredKeys[] = checkedKeySetForTests(
    e.registered.map((index) => ({
      index,
      kemKey: keys[index - 1] as (typeof keys)[number],
      signingKey: new Uint8Array(33),
    })),
    definition.ceremony_transcript_hash,
  );
  return { election: ballotElection(definition, registered), definition };
}

const elections = new Map(Object.keys(vectors.elections).map((n) => [n, electionOf(n)]));
const contextOf = (name: string) => elections.get(name) as ReturnType<typeof electionOf>;

const codeOf = (r: ChallengeOpeningCheck) => (r.ok ? "ok" : r.code);

describe("challenge.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-challenge-vectors/1");
    expect(vectors.recordType).toBe("0x0003");
    expect(vectors.version).toBe(1);
    expect(vectors.tag).toBe("abolish/v1/ballot-core");
  });

  test.each(Object.entries(vectors.elections))("election %s: definition hash", (name, e) => {
    expect(toHex(contextOf(name).election.definitionHash)).toBe(e.definitionHash);
  });

  test.each(Object.entries(vectors.panels))("panel %s: keys from their seeds", (_, keys) => {
    for (const k of keys)
      expect(
        toHex(encode(KEM_PUBLIC_KEY, kemKeyPairWith(hex(k.seed), BigInt(k.x)).publicKey)),
      ).toBe(k.publicKey);
  });

  test.each(vectors.openings.map((o) => [o.id, o] as const))("%s", (_, o) => {
    const record = decodeOpening(hex(o.encoding), 1);
    expect(toHex(encodeOpening(record))).toBe(o.encoding);
    expect(toHex(openingCoreHash(record))).toBe(o.coreHash);
    const result = checkChallengeOpening(contextOf(o.election).election, record);
    expect(codeOf(result)).toBe(o.result);
    if (result.ok) {
      expect(toHex(result.coreHash)).toBe(o.coreHash);
      expect(result.votes.map(String)).toEqual(o.votes);
      expect(result.withinRules).toBe(o.withinRules);
    } else {
      expect(result.option).toBe(o.option);
      expect(result.seat).toBe(o.seat);
    }
  });

  // An honest client's opening, re-made byte for byte from the randomness
  // that made it: the polynomials, then every seat's encapsulation.
  test.each(
    vectors.openings
      .filter((o) => o.result === "ok" && o.withinRules === true)
      .map((o) => [o.id, o] as const),
  )("openChallenge re-makes %s", (_, o) => {
    const { election } = contextOf(o.election);
    const e = vectors.elections[o.election] as NonNullable<(typeof vectors.elections)[string]>;
    const r = o.randomness as NonNullable<typeof o.randomness>;
    const polynomials: OptionPolynomials[] = r.polynomials.map((p) => ({
      f: p.f.map(BigInt),
      g: p.g.map(BigInt),
    }));
    const votes = polynomials.map((p) => Number(p.f[0]) as 0 | 1);
    const sharing = shareVoteWith(election, votes, polynomials);
    const encrypted = encryptSharesWith(
      { definitionHash: election.definitionHash },
      sharing,
      panelKeys(e.panel),
      r.encapsulation.map((x) => ({ m: hex(x.m), e: BigInt(x.e), w: BigInt(x.w) })),
    );
    const tier = decodeOpening(hex(o.encoding), 1).tier;
    const made = openChallenge(election, tier, encrypted);
    expect(toHex(encodeOpening(made.opening))).toBe(o.encoding);
    expect(toHex(made.coreHash)).toBe(o.coreHash);
  });

  test.each(vectors.decode.map((d) => [d.id, d] as const))("rejects %s", (_, d) => {
    let error: unknown;
    try {
      decodeOpening(hex(d.encoding), 1);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DecodeError);
    expect((error as DecodeError).code).toBe(d.error);
    if (d.offset !== undefined) expect((error as DecodeError).offset).toBe(d.offset);
  });

  test.each(vectors.sharedCommitment.map((c) => [c.id, c] as const))(
    "shared commitments: %s",
    (_, c) => {
      const o = vectors.openings.find((x) => x.id === c.opening);
      if (o === undefined) throw new Error(`no opening ${c.opening}`);
      const opening = decodeOpening(hex(o.encoding), 1);
      const core = {
        definitionHash: hex(c.core.definitionHash),
        tier: c.core.tier as 0 | 1 | 2,
        vss: decode(VSS, hex(c.core.vss)),
        shareHashes: c.core.shareHashes.map(hex),
      };
      expect(toHex(coreHash(core))).toBe(c.coreHash);
      const opened = { definitionHash: opening.definition_hash, vss: opening.vss };
      expect(sharesVoteCommitment(opened, core)).toBe(c.shared);
      expect(sharesVoteCommitment(core, opened)).toBe(c.shared);
    },
  );

  test.each(vectors.castBallots.map((c) => [c.ballot, c] as const))(
    "the cast ballot %s's tracking code",
    (id, c) => {
      const b = ballotVectors.ballots.find((x) => x.id === id);
      if (b === undefined) throw new Error(`no ballot ${id}`);
      expect(toHex(ballotCoreHash(decodeBallot(hex(b.encoding), 1)))).toBe(c.coreHash);
    },
  );
});

const plurality = contextOf("plurality");
const approval = contextOf("approval");
const keys3 = panelKeys("panel-3");
const keys4 = panelKeys("challenge-panel-4");
const honestVector = vectors.openings.find((o) => o.id === "plurality");
if (honestVector === undefined) throw new Error("no honest plurality opening");
const honest = hex(honestVector.encoding);

const validity = (election: BallotElection, tier: number): ValidityContext => ({
  definitionHash: election.definitionHash,
  optionCount: election.optionCount,
  minSelections: election.minSelections,
  maxSelections: election.maxSelections,
  threshold: election.threshold,
  panelSize: election.panelSize,
  tier,
  nullifier: 12345n,
});

// Votes an election's rules allow: each 0 or 1, with min to max selected.
const votesFor = (election: BallotElection) =>
  fc
    .array(fc.boolean(), { minLength: election.optionCount, maxLength: election.optionCount })
    .map((bits) => bits.map((b) => (b ? 1 : 0) as 0 | 1))
    .filter((v) => {
      const total = v.reduce<number>((a, x) => a + x, 0);
      return total >= election.minSelections && total <= election.maxSelections;
    });

describe("Benaloh challenge", () => {
  test("an honest client's opening passes and shows the vote it was made for", () => {
    const cases: [ReturnType<typeof electionOf>, number, typeof keys3][] = [
      [plurality, 0, keys3],
      [approval, 1, keys4],
    ];
    for (const [{ election }, tier, keys] of cases)
      fc.assert(
        fc.property(votesFor(election), (votes) => {
          const sharing = shareVote(election, votes);
          const encrypted = encryptShares(
            { definitionHash: election.definitionHash },
            sharing,
            keys,
          );
          // The code shown before the choice, and the core cast or opened.
          const shown = trackingCode(election, tier as 0 | 1, encrypted);
          const core = ballotCore(election, tier as 0 | 1, encrypted);
          const { opening, coreHash: code } = openChallenge(election, tier as 0 | 1, encrypted);
          expect(toHex(code)).toBe(toHex(shown));
          expect(opening.share_hashes.map(toHex)).toEqual(core.shareHashes.map(toHex));
          const result = checkChallengeOpening(election, opening);
          if (!result.ok) throw new Error(`expected a passing opening, got ${result.code}`);
          expect(result.votes).toEqual(votes.map(BigInt));
          expect(result.withinRules).toBe(true);
          expect(toHex(result.coreHash)).toBe(toHex(code));
          // The code the client shows before the choice, from the core alone.
          expect(
            toHex(
              coreHash({
                definitionHash: election.definitionHash,
                tier: opening.tier,
                vss: sharing.vss,
                shareHashes: opening.share_hashes,
              }),
            ),
          ).toBe(toHex(code));
        }),
        { numRuns: Math.max(10, Math.floor(numRuns / 10)) },
      );
  }, 120_000);

  test("no changed byte opens the same core: it fails to decode, fails a check or names another core", () => {
    const code = honestVector.coreHash;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: honest.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, delta) => {
          const bytes = Uint8Array.from(honest);
          bytes[at] = ((bytes[at] as number) + delta) & 0xff;
          let record: SpoiledBallotOpening;
          try {
            record = decodeOpening(bytes, 1);
          } catch (e) {
            if (e instanceof DecodeError) return;
            throw e;
          }
          // Every accepted encoding re-encodes to itself.
          expect(toHex(encodeOpening(record))).toBe(toHex(bytes));
          const result = checkChallengeOpening(plurality.election, record);
          // A changed tier is a different core: the tier is free before the
          // choice, and the checker compares the full code (challenge.md).
          if (result.ok) expect(toHex(result.coreHash)).not.toBe(code);
        },
      ),
      { numRuns },
    );
  }, 120_000);

  test("an opened sharing is never proved, and a proved sharing is never opened", () => {
    const { election } = plurality;
    const ctx = { definitionHash: election.definitionHash };
    const opened = shareVote(election, [0, 1, 0]);
    const openedShares = encryptShares(ctx, opened, keys3);
    openChallenge(election, 0, openedShares);
    expect(() => proveValidity(validity(election, 0), opened, openedShares.hashes)).toThrow(
      /opened by a challenge/,
    );
    const cast = shareVote(election, [1, 0, 0]);
    const castShares = encryptShares(ctx, cast, keys3);
    proveValidity(validity(election, 0), cast, castShares.hashes);
    expect(() => openChallenge(election, 0, castShares)).toThrow(/proved for casting/);
  });

  test("openChallenge reveals only shares encrypted here, for this election, to its registered keys", () => {
    const { election } = plurality;
    const ctx = { definitionHash: election.definitionHash };
    const sharing = shareVote(election, [0, 0, 1]);
    const encrypted = encryptShares(ctx, sharing, keys3);
    // A copy isn't the object encryptShares made.
    expect(() => openChallenge(election, 0, { ...encrypted })).toThrow(/encryptShares/);
    // Another election's definition hash.
    const other = encryptShares({ definitionHash: new Uint8Array(32).fill(7) }, sharing, keys3);
    expect(() => openChallenge(election, 0, other)).toThrow(/another election/);
    // Seat 2's shares encrypted to a key that isn't its registered one.
    const swapped = encryptShares(ctx, sharing, [
      keys3[0] as (typeof keys3)[number],
      keys3[2] as (typeof keys3)[number],
      keys3[2] as (typeof keys3)[number],
    ]);
    expect(() => openChallenge(election, 0, swapped)).toThrow(/registered key/);
    // A tier the election doesn't list.
    expect(() => openChallenge(election, 1, encrypted)).toThrow(/tier/);
    // Changing the exposed fields changes nothing openChallenge reveals.
    (encrypted.hashes[0] as Uint8Array).fill(0);
    const { opening } = openChallenge(election, 0, encrypted);
    expect(checkChallengeOpening(election, opening).ok).toBe(true);
  });

  test("a seat outside the registered key set gets a zero share hash and reveals nothing", () => {
    const { election } = approval;
    const sharing = shareVote(election, [0, 1, 1, 0]);
    const encrypted = encryptShares({ definitionHash: election.definitionHash }, sharing, keys4);
    const { opening } = openChallenge(election, 1, encrypted);
    expect(opening.seats.map((s) => s.seat)).toEqual([1, 2, 4]);
    expect(toHex(opening.share_hashes[2] as Uint8Array)).toBe("00".repeat(32));
    expect(checkChallengeOpening(election, opening).ok).toBe(true);
  });
});
