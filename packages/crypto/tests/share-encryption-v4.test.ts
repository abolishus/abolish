import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type OptionPolynomials,
  proveValidityV4With,
  shareVoteWith,
  shareVoteV4With,
  type ValidityNoncesV3,
  VSS,
} from "../src/ballot-validity.ts";
import {
  encryptionOfV4,
  encryptSeatV4,
  encryptSharesV4With,
  encryptSharesWith,
  kemKeyPairWith,
  proveComplaintV4With,
  type ShareEncapsulation,
} from "../src/share-encryption.ts";
import * as entry from "../src/index.ts";
import {
  checkComplaint,
  checkComplaintV4,
  checkPosting,
  checkPostingV4,
  COMMITTED_VOTE_V4,
  COMPLAINT_PROOF,
  type ComplaintCode,
  type CommittedVoteV4,
  decode,
  encode,
  encryptSharesV4,
  type KemKeyPair,
  type OpenCode,
  openShares,
  openSharesV4,
  type PostingCode,
  proveComplaintV4,
  type QuestionRules,
  type SeatPanel,
  shareCiphertextHash,
  SHARES,
  shareVoteV4,
  type ValidityContextV4,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// Share encryption under ballot version 4 (P2-16 part 2b-3a) against
// docs/spec/vectors/share-encryption-v4.json, printed by
// scripts/share-encryption-v4-vectors.py, an implementation of the spec with
// its own ML-KEM-768 and ChaCha20-Poly1305 that shares no code with this
// package: every byte and verdict here comes from it, never from the code
// under test (T-15, T-30, T-31, T-37).

interface KeyVector {
  readonly seed: string;
  readonly x: string;
  readonly publicKey: string;
}

interface Polynomial {
  readonly f: readonly string[];
  readonly g: readonly string[];
}

interface Nonces {
  readonly w: string;
  readonly simulated: readonly { readonly c: string; readonly z: string }[];
}

interface Election {
  readonly definitionHash: string;
  readonly questions: readonly QuestionRules[];
  readonly threshold: number;
  readonly panelSize: number;
  readonly authorThreshold: number;
  readonly authorPanelSize: number;
}

interface SeatVector {
  readonly panel: SeatPanel;
  readonly seat: number;
  readonly shares: string;
  readonly encapsulation: { readonly m: string; readonly e: string; readonly w: string };
  readonly ciphertext: string;
  readonly shareHash: string;
  readonly decryption: "ok" | OpenCode;
}

interface BallotVector {
  readonly id: string;
  readonly election: string;
  readonly definitionHash: string;
  readonly cell: number;
  readonly nullifier: string;
  readonly keys: string;
  readonly authorKeys: string | null;
  readonly votes: readonly (0 | 1)[];
  readonly randomness: {
    readonly polynomials: readonly Polynomial[];
    readonly authorPolynomials: readonly Polynomial[];
    readonly options: readonly Nonces[];
    readonly questions: readonly Nonces[];
  };
  readonly committedVote: string;
  readonly seats: readonly SeatVector[];
}

const vectors = JSON.parse(
  readFileSync(new URL("share-encryption-v4.json", SPEC_VECTORS), "utf8"),
) as {
  readonly format: string;
  readonly version: number;
  readonly tags: Readonly<Record<string, string>>;
  readonly elections: Readonly<Record<string, Election>>;
  readonly keySets: Readonly<Record<string, readonly KeyVector[]>>;
  readonly ballots: readonly BallotVector[];
  readonly decryptFailures: readonly {
    readonly id: string;
    readonly ballotVersion: 1 | 4;
    readonly definitionHash: string;
    readonly panel: SeatPanel;
    readonly seat: number;
    readonly keyPanel: SeatPanel;
    readonly keySeat: number;
    readonly vss: string;
    readonly authorVss: string;
    readonly ciphertext: string;
    readonly result: OpenCode;
  }[];
  readonly postings: readonly {
    readonly id: string;
    readonly ballot: string;
    readonly panel: SeatPanel;
    readonly seat: number;
    readonly keyPanel: SeatPanel;
    readonly keySeat: number;
    readonly ciphertext: string;
    readonly m: string;
    readonly result: "ok" | PostingCode;
  }[];
  readonly complaints: readonly {
    readonly id: string;
    readonly ballot: string;
    readonly panel: SeatPanel;
    readonly seat: number;
    readonly keyPanel: SeatPanel;
    readonly ciphertext: string;
    readonly m: string;
    readonly proof: string;
    readonly w?: string;
    readonly result: "ok" | ComplaintCode;
  }[];
};

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run of the costlier properties shares a whole ballot to both panels, then encrypts and decrypts.
const ballotRuns = Math.max(10, Math.ceil(numRuns / 20));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const keySets = Object.fromEntries(
  Object.entries(vectors.keySets).map(([name, keys]) => [
    name,
    keys.map((k) => kemKeyPairWith(hex(k.seed), BigInt(k.x))),
  ]),
);
const keySet = (name: string | null): KemKeyPair[] =>
  name === null ? [] : (keySets[name] as KemKeyPair[]);
const keysOf = (b: BallotVector, panel: SeatPanel) => keySet(panel === 2 ? b.authorKeys : b.keys);

const byId = (id: string): BallotVector => {
  const b = vectors.ballots.find((x) => x.id === id);
  if (b === undefined) throw new Error(`${id} isn't listed`);
  return b;
};
const voteOf = (b: BallotVector): CommittedVoteV4 =>
  decode(COMMITTED_VOTE_V4, hex(b.committedVote));
const ctxOf = (b: BallotVector) => ({ definitionHash: hex(b.definitionHash) });
const encapsulationOf = (e: SeatVector["encapsulation"]): ShareEncapsulation => ({
  m: hex(e.m),
  e: BigInt(e.e),
  w: BigInt(e.w),
});
const polynomialsOf = (ps: readonly Polynomial[]): OptionPolynomials[] =>
  ps.map((p) => ({ f: p.f.map(BigInt), g: p.g.map(BigInt) }));
const noncesOf = (n: Nonces) => ({
  w: BigInt(n.w),
  simulated: n.simulated.map((s) => ({ c: BigInt(s.c), z: BigInt(s.z) })),
});

function validityContext(b: BallotVector): ValidityContextV4 {
  const e = vectors.elections[b.election] as Election;
  return {
    definitionHash: hex(b.definitionHash),
    cell: b.cell,
    nullifier: BigInt(b.nullifier),
    questions: e.questions.map(({ optionCount, minSelections, maxSelections }) => ({
      optionCount,
      minSelections,
      maxSelections,
    })),
    threshold: e.threshold,
    panelSize: e.panelSize,
    authorThreshold: e.authorThreshold,
    authorPanelSize: e.authorPanelSize,
  };
}

// The ballots whose every seat decrypts: an honest client made them.
const honest = vectors.ballots.filter((b) => b.seats.every((s) => s.decryption === "ok"));

describe("share-encryption-v4.json through the production code", () => {
  test("is the file this suite reads, under version 4's tags", () => {
    expect(vectors.format).toBe("abolish-share-encryption-v4-vectors/1");
    expect(vectors.version).toBe(4);
    expect(vectors.tags["complaint"]).toBe("abolish/v1/fs/share-complaint-2");
    expect(vectors.tags["aad"]).toBe("abolish/v1/kem/share-aad");
    expect(vectors.tags["ephemeral"]).toBe("abolish/v1/fs/share-ephemeral");
    for (const [name, keys] of Object.entries(vectors.keySets))
      keys.forEach((k, i) =>
        expect(toHex(encode(entry.KEM_PUBLIC_KEY, keySet(name)[i]!.publicKey))).toBe(k.publicKey),
      );
  });

  test("covers both panels, every decryption code and an election without an author panel", () => {
    const seats = vectors.ballots.flatMap((b) => b.seats);
    expect(new Set(seats.map((s) => s.panel))).toEqual(new Set([1, 2]));
    expect(new Set(seats.map((s) => s.decryption))).toEqual(
      new Set(["ok", "share-proof", "share-decrypt", "share-check"]),
    );
    expect(vectors.ballots.some((b) => b.authorKeys === null)).toBe(true);
    expect(new Set(vectors.decryptFailures.map((f) => f.result))).toContain("share-malformed");
  });

  test.each(honest.map((b) => [b.id, b] as const))(
    "reproduces %s byte for byte: the sharing, both panels' ciphertexts, then the committed vote",
    { timeout: 60_000 },
    (_, b) => {
      const ctx = validityContext(b);
      const sharing = shareVoteV4With(
        ctx,
        b.votes,
        polynomialsOf(b.randomness.polynomials),
        polynomialsOf(b.randomness.authorPolynomials),
      );
      const of = (panel: SeatPanel) => b.seats.filter((s) => s.panel === panel);
      const encrypted = encryptSharesV4With(
        ctxOf(b),
        sharing,
        keysOf(b, 1).map((k) => k.publicKey),
        keysOf(b, 2).map((k) => k.publicKey),
        of(1).map((s) => encapsulationOf(s.encapsulation)),
        of(2).map((s) => encapsulationOf(s.encapsulation)),
      );
      expect(encrypted.ciphertexts.map(toHex)).toEqual(of(1).map((s) => s.ciphertext));
      expect(encrypted.hashes.map(toHex)).toEqual(of(1).map((s) => s.shareHash));
      expect(encrypted.authorCiphertexts.map(toHex)).toEqual(of(2).map((s) => s.ciphertext));
      expect(encrypted.authorHashes.map(toHex)).toEqual(of(2).map((s) => s.shareHash));
      const nonces: ValidityNoncesV3 = {
        options: b.randomness.options.map(noncesOf),
        questions: b.randomness.questions.map(noncesOf),
      };
      const vote = proveValidityV4With(
        ctx,
        sharing,
        encrypted.hashes,
        encrypted.authorHashes,
        nonces,
      );
      expect(toHex(encode(COMMITTED_VOTE_V4, vote))).toBe(b.committedVote);
    },
  );

  const seatCases = vectors.ballots.flatMap((b) =>
    b.seats.map((s) => [`${b.id} panel ${s.panel} seat ${s.seat}`, b, s] as const),
  );

  test.each(seatCases)("decrypts %s with the seat's own key as listed", (_, b, s) => {
    const vote = voteOf(b);
    const key = keysOf(b, s.panel)[s.seat - 1]!;
    const ct = hex(s.ciphertext);
    expect(toHex(shareCiphertextHash(ct))).toBe(s.shareHash);
    const hashes = s.panel === 2 ? vote.author_share_hashes : vote.share_hashes;
    expect(toHex(hashes[s.seat - 1]!)).toBe(s.shareHash);
    const r = openSharesV4(ctxOf(b), s.panel, s.seat, key.secretKey, vote, ct);
    if (s.decryption === "ok") {
      expect(r.ok).toBe(true);
      if (r.ok) expect(toHex(encode(SHARES, r.shares))).toBe(s.shares);
      // The seat's ciphertext is rebuilt from its shares and randomness.
      const rebuilt = encryptSeatV4(
        ctxOf(b),
        s.panel,
        s.seat,
        key.publicKey,
        vote,
        decode(SHARES, hex(s.shares)),
        encapsulationOf(s.encapsulation),
      );
      expect(toHex(rebuilt)).toBe(s.ciphertext);
    } else expect(r).toEqual({ ok: false, code: s.decryption });
  });

  test.each(vectors.decryptFailures.map((f) => [f.id, f] as const))(
    "decryption %s fails as listed",
    (_, f) => {
      const a = byId("author");
      const key = keysOf(a, f.keyPanel)[f.keySeat - 1]!;
      const halves = { vss: decode(VSS, hex(f.vss)), author_vss: decode(VSS, hex(f.authorVss)) };
      const ctx = { definitionHash: hex(f.definitionHash) };
      const ct = hex(f.ciphertext);
      const r =
        f.ballotVersion === 1
          ? openShares(ctx, f.seat, key.secretKey, halves.vss, ct)
          : openSharesV4(ctx, f.panel, f.seat, key.secretKey, halves, ct);
      expect(r).toEqual({ ok: false, code: f.result });
    },
  );

  test.each(vectors.postings.map((p) => [p.id, p] as const))(
    "posting %s checks as listed",
    (_, p) => {
      const b = byId(p.ballot);
      const key = keysOf(b, p.keyPanel)[p.keySeat - 1]!;
      const r = checkPostingV4(ctxOf(b), p.panel, p.seat, key.publicKey, voteOf(b), {
        ciphertext: hex(p.ciphertext),
        m: hex(p.m),
      });
      expect(r).toEqual(p.result === "ok" ? { ok: true } : { ok: false, code: p.result });
    },
  );

  test.each(vectors.complaints.map((c) => [c.id, c] as const))(
    "complaint %s checks as listed, and an honest one is re-made byte for byte",
    (_, c) => {
      const b = byId(c.ballot);
      const keyPair = keysOf(b, c.keyPanel)[c.seat - 1]!;
      const posting = { ciphertext: hex(c.ciphertext), m: hex(c.m) };
      const vote = voteOf(b);
      const proof = decode(COMPLAINT_PROOF, hex(c.proof));
      const r = checkComplaintV4(
        ctxOf(b),
        c.panel,
        c.seat,
        keyPair.publicKey,
        vote,
        posting,
        proof,
      );
      expect(r).toEqual(c.result === "ok" ? { ok: true } : { ok: false, code: c.result });
      if (c.w !== undefined) {
        const made = proveComplaintV4With(
          ctxOf(b),
          c.panel,
          c.seat,
          keyPair,
          vote,
          posting,
          BigInt(c.w),
        );
        expect(toHex(encode(COMPLAINT_PROOF, made))).toBe(c.proof);
      }
    },
  );
});

describe("ballot version 4's ciphertexts are never version 1's", () => {
  const a = byId("author");
  const vote = voteOf(a);
  const seat1 = a.seats.find((s) => s.panel === 1 && s.seat === 1)!;
  const posting = { ciphertext: hex(seat1.ciphertext), m: hex(seat1.encapsulation.m) };

  test("version 1's posting check fails a default seat's version-4 posting at its proof", () => {
    const key = keysOf(a, 1)[0]!.publicKey;
    expect(checkPostingV4(ctxOf(a), 1, 1, key, vote, posting)).toEqual({ ok: true });
    expect(checkPosting(ctxOf(a), 1, key, vote.vss, vote.share_hashes, posting)).toEqual({
      ok: false,
      code: "posting-proof",
    });
  });

  test("version 1's complaint check finds a proven version-4 complaint void", () => {
    const c = vectors.complaints.find((x) => x.id === "bad-default-seal-complaint")!;
    const b = byId(c.ballot);
    const v = voteOf(b);
    const key = keysOf(b, 1)[c.seat - 1]!.publicKey;
    const p = { ciphertext: hex(c.ciphertext), m: hex(c.m) };
    const proof = decode(COMPLAINT_PROOF, hex(c.proof));
    expect(checkComplaintV4(ctxOf(b), 1, c.seat, key, v, p, proof)).toEqual({ ok: true });
    expect(checkComplaint(ctxOf(b), c.seat, key, v.vss, v.share_hashes, p, proof)).toEqual({
      ok: false,
      code: "posting-proof",
    });
  });

  test("version 1's encryption refuses a version-4 sharing, and version 4's a version-1 sharing", () => {
    const ctx = validityContext(a);
    const sharing = shareVoteV4(ctx, a.votes);
    const keys = keysOf(a, 1).map((k) => k.publicKey);
    const authorKeys = keysOf(a, 2).map((k) => k.publicKey);
    const randomness = keys.map(() => encapsulationOf(seat1.encapsulation));
    expect(() => encryptSharesWith(ctxOf(a), sharing as never, keys, randomness)).toThrow(
      /shareVote/,
    );
    const v1 = shareVoteWith(
      { optionCount: 2, minSelections: 0, maxSelections: 1, threshold: 2, panelSize: 3 },
      [1, 0],
      [
        { f: [1n, 5n], g: [7n, 11n] },
        { f: [0n, 3n], g: [2n, 13n] },
      ],
    );
    expect(() => encryptSharesV4(ctxOf(a), v1 as never, keys, authorKeys)).toThrow(/shareVoteV4/);
  });
});

describe("version-4 refusals", () => {
  const a = byId("author");
  const vote = voteOf(a);
  const plain = byId("no-author");
  const plainVote = voteOf(plain);
  const s = a.seats.find((x) => x.panel === 2 && x.seat === 1)!;
  const author1 = keysOf(a, 2)[0]!;
  const posting = { ciphertext: hex(s.ciphertext), m: hex(s.encapsulation.m) };

  test("no author seat exists for a ballot without an author half", () => {
    const key = keysOf(plain, 1)[0]!;
    expect(() =>
      openSharesV4(ctxOf(plain), 2, 1, key.secretKey, plainVote, hex(s.ciphertext)),
    ).toThrow(/no author half/);
    expect(() => checkPostingV4(ctxOf(plain), 2, 1, key.publicKey, plainVote, posting)).toThrow(
      /no author half/,
    );
  });

  test("a panel byte other than 1 or 2, and seats outside the panel, are refused", () => {
    expect(() =>
      openSharesV4(ctxOf(a), 3 as SeatPanel, 1, author1.secretKey, vote, posting.ciphertext),
    ).toThrow(/panel/);
    expect(() => checkPostingV4(ctxOf(a), 2, 4, author1.publicKey, vote, posting)).toThrow(/seat/);
    expect(() => checkPostingV4(ctxOf(a), 2, 0, author1.publicKey, vote, posting)).toThrow(/seat/);
  });

  test("an honest trustee never complains about valid shares or a failing posting", () => {
    expect(() => proveComplaintV4(ctxOf(a), 2, 1, author1, vote, posting)).toThrow(/don't fail/);
    const wrongM = {
      ...posting,
      m: hex(a.seats.find((x) => x.panel === 2 && x.seat === 2)!.encapsulation.m),
    };
    expect(() => proveComplaintV4(ctxOf(a), 2, 1, author1, vote, wrongM)).toThrow(
      /posting-encapsulation/,
    );
    // Another seat's key pair, the default seat with the same index included.
    expect(() => proveComplaintV4(ctxOf(a), 2, 1, keysOf(a, 1)[0]!, vote, posting)).toThrow();
  });

  test("encryption takes one key and one encapsulation per seat of each panel", () => {
    const ctx = validityContext(a);
    const sharing = shareVoteV4(ctx, a.votes);
    const keys = keysOf(a, 1).map((k) => k.publicKey);
    const authorKeys = keysOf(a, 2).map((k) => k.publicKey);
    const r = keys.map(() => encapsulationOf(s.encapsulation));
    expect(() => encryptSharesV4(ctxOf(a), sharing, keys, authorKeys.slice(1))).toThrow(
      /author seat/,
    );
    expect(() => encryptSharesV4(ctxOf(a), sharing, keys.slice(1), authorKeys)).toThrow(
      /default seat/,
    );
    expect(() => encryptSharesV4With(ctxOf(a), sharing, keys, authorKeys, r, r.slice(1))).toThrow(
      /encapsulation per author seat/,
    );
  });

  test("the seams aren't exported from the package entry point", () => {
    for (const name of [
      "encryptSeatV4",
      "encryptSharesV4With",
      "proveComplaintV4With",
      "encryptionOfV4",
    ])
      expect(name in entry).toBe(false);
  });

  test("encryptionOfV4 knows only encryptions made here, and hands out copies", () => {
    const ctx = validityContext(a);
    const sharing = shareVoteV4(ctx, a.votes);
    const keys = keysOf(a, 1).map((k) => k.publicKey);
    const authorKeys = keysOf(a, 2).map((k) => k.publicKey);
    const encrypted = encryptSharesV4(ctxOf(a), sharing, keys, authorKeys);
    const made = encryptionOfV4(encrypted)!;
    expect(made.sharing).toBe(sharing);
    expect(made.authorHashes.map(toHex)).toEqual(encrypted.authorHashes.map(toHex));
    made.authorRandomness[0]!.m.fill(0);
    expect(toHex(encryptionOfV4(encrypted)!.authorRandomness[0]!.m)).toBe(
      toHex(encrypted.authorRandomness[0]!.m),
    );
    expect(encryptionOfV4({ ...encrypted })).toBeUndefined();
  });
});

describe("properties of version-4 share encryption", () => {
  const a = byId("author");
  const ctx = validityContext(a);
  const keys = keysOf(a, 1);
  const authorKeys = keysOf(a, 2);
  const flatOptions = ctx.questions.reduce((n, q) => n + q.optionCount, 0);
  const votesArb = fc
    .tuple(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 3 }))
    .map(([q0, q1]) => {
      // One pick of three (or none), then any of two.
      const v: (0 | 1)[] = Array.from({ length: flatOptions }, () => 0);
      if (q0 > 0) v[q0 - 1] = 1;
      if (q1 & 1) v[3] = 1;
      if (q1 & 2) v[4] = 1;
      return v;
    });

  test(
    "every seat of both panels opens its own ciphertext to its own shares, and no seat of the other panel's",
    { timeout: 120_000 },
    () => {
      fc.assert(
        fc.property(votesArb, fc.integer({ min: 1, max: 3 }), (votes, seat) => {
          const sharing = shareVoteV4(ctx, votes);
          const enc = encryptSharesV4(
            ctxOf(a),
            sharing,
            keys.map((k) => k.publicKey),
            authorKeys.map((k) => k.publicKey),
          );
          const halves = { vss: sharing.vss, author_vss: sharing.authorVss };
          const own = openSharesV4(
            ctxOf(a),
            2,
            seat,
            authorKeys[seat - 1]!.secretKey,
            halves,
            enc.authorCiphertexts[seat - 1]!,
          );
          expect(own.ok && toHex(encode(SHARES, own.shares))).toBe(
            toHex(encode(SHARES, sharing.authorShares[seat - 1]!)),
          );
          const dflt = openSharesV4(
            ctxOf(a),
            1,
            seat,
            keys[seat - 1]!.secretKey,
            halves,
            enc.ciphertexts[seat - 1]!,
          );
          expect(dflt.ok && toHex(encode(SHARES, dflt.shares))).toBe(
            toHex(encode(SHARES, sharing.shares[seat - 1]!)),
          );
          // The author ciphertext read as the default seat of the same index, with either key.
          for (const key of [keys[seat - 1]!, authorKeys[seat - 1]!])
            expect(
              openSharesV4(
                ctxOf(a),
                1,
                seat,
                key.secretKey,
                halves,
                enc.authorCiphertexts[seat - 1]!,
              ),
            ).toEqual({ ok: false, code: "share-proof" });
        }),
        { numRuns: ballotRuns },
      );
    },
  );

  test("any single-byte change of a ciphertext is refused", { timeout: 120_000 }, () => {
    const sharing = shareVoteV4(ctx, [0, 1, 0, 1, 0]);
    const enc = encryptSharesV4(
      ctxOf(a),
      sharing,
      keys.map((k) => k.publicKey),
      authorKeys.map((k) => k.publicKey),
    );
    const ct = enc.authorCiphertexts[1]!;
    const halves = { vss: sharing.vss, author_vss: sharing.authorVss };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: ct.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const changed = Uint8Array.from(ct);
          changed[at] = (changed[at] as number) ^ x;
          expect(openSharesV4(ctxOf(a), 2, 2, authorKeys[1]!.secretKey, halves, changed).ok).toBe(
            false,
          );
        },
      ),
      { numRuns },
    );
  });

  test(
    "a ciphertext is bound to both halves: another ballot's author half fails the default seat's proof",
    { timeout: 120_000 },
    () => {
      fc.assert(
        fc.property(votesArb, votesArb, (v1, v2) => {
          const s1 = shareVoteV4(ctx, v1);
          const s2 = shareVoteV4(ctx, v2);
          const enc = encryptSharesV4(
            ctxOf(a),
            s1,
            keys.map((k) => k.publicKey),
            authorKeys.map((k) => k.publicKey),
          );
          expect(
            openSharesV4(
              ctxOf(a),
              1,
              1,
              keys[0]!.secretKey,
              { vss: s1.vss, author_vss: s2.authorVss },
              enc.ciphertexts[0]!,
            ),
          ).toEqual({ ok: false, code: "share-proof" });
        }),
        { numRuns: ballotRuns },
      );
    },
  );
});
