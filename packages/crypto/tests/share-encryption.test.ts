import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { type OptionPolynomials, shareVoteWith, VSS } from "../src/ballot-validity.ts";
import {
  encryptSharesWith,
  kemKeyPairWith,
  proveComplaintWith,
  type ShareEncapsulation,
} from "../src/share-encryption.ts";
import {
  checkComplaint,
  checkPosting,
  checkValidity,
  type Codec,
  COMMITTED_VOTE,
  COMPLAINT_PROOF,
  type ComplaintCode,
  decode,
  DecodeError,
  encode,
  encryptShares,
  G,
  KEM_PUBLIC_KEY,
  KEM_SECRET_KEY,
  type KemKeyPair,
  kemKeygen,
  type KemPublicKey,
  type OpenCode,
  openShares,
  type PostingCode,
  proveComplaint,
  proveValidity,
  SHARE_CIPHERTEXT,
  shareCiphertextHash,
  SHARES,
  shareVote,
  type ValidityContext,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/share-encryption.json comes from an independent Python
// implementation of docs/spec/share-encryption.md, with its own ML-KEM-768
// and ChaCha20-Poly1305 (scripts/share-encryption-vectors.py), so these
// expected bytes and verdicts never come from the code under test.

interface KeyVector {
  readonly seed: string;
  readonly x: string;
  readonly publicKey: string;
}

interface BallotVector {
  readonly id: string;
  readonly context: {
    readonly definitionHash: string;
    readonly optionCount: number;
    readonly minSelections: number;
    readonly maxSelections: number;
    readonly threshold: number;
    readonly panelSize: number;
    readonly tier: number;
    readonly nullifier: string;
  };
  readonly panel: string;
  readonly votes: readonly (0 | 1)[];
  readonly randomness: {
    readonly polynomials: readonly {
      readonly f: readonly string[];
      readonly g: readonly string[];
    }[];
  };
  readonly encapsulation: readonly { readonly m: string; readonly e: string; readonly w: string }[];
  readonly ciphertexts: readonly string[];
  readonly shareHashes: readonly string[];
  readonly committedVote: string;
  readonly decryptions: readonly {
    readonly seat: number;
    readonly result: "ok" | OpenCode;
    readonly shares?: string;
  }[];
}

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly panels: Readonly<Record<string, readonly KeyVector[]>>;
  readonly ballots: readonly BallotVector[];
  readonly decryptFailures: readonly {
    readonly id: string;
    readonly definitionHash: string;
    readonly seat: number;
    readonly keySeat: number;
    readonly vss: string;
    readonly ciphertext: string;
    readonly result: OpenCode;
  }[];
  readonly postings: readonly {
    readonly id: string;
    readonly ballot: string;
    readonly seat: number;
    readonly ciphertext: string;
    readonly m: string;
    readonly result: "ok" | PostingCode;
  }[];
  readonly complaints: readonly {
    readonly id: string;
    readonly ballot: string;
    readonly seat: number;
    readonly ciphertext: string;
    readonly m: string;
    readonly proof: string;
    readonly w?: string;
    readonly result: "ok" | ComplaintCode;
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly type: "kem-key" | "kem-secret" | "share-ciphertext" | "complaint-proof";
    readonly encoding: string;
    readonly error: string | null;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("share-encryption.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const keyPair = (k: KeyVector): KemKeyPair => kemKeyPairWith(hex(k.seed), BigInt(k.x));
const panels = Object.fromEntries(
  Object.entries(vectors.panels).map(([name, keys]) => [name, keys.map(keyPair)]),
);
const panelOf = (b: BallotVector) => panels[b.panel] as KemKeyPair[];
const ballotById = (id: string) => vectors.ballots.find((b) => b.id === id) as BallotVector;

function validityContext(b: BallotVector): ValidityContext {
  const c = b.context;
  return {
    definitionHash: hex(c.definitionHash),
    optionCount: c.optionCount,
    minSelections: c.minSelections,
    maxSelections: c.maxSelections,
    threshold: c.threshold,
    panelSize: c.panelSize,
    tier: c.tier,
    nullifier: BigInt(c.nullifier),
  };
}

const bytesHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("share-encryption.json", () => {
  test("is the format and tag set this code implements", () => {
    expect(vectors.format).toBe("abolish-share-encryption-vectors/1");
    expect(vectors.tags).toEqual({
      kem: "abolish/v1/kem/share",
      aad: "abolish/v1/kem/share-aad",
      ciphertext: "abolish/v1/share-ciphertext",
      ephemeral: "abolish/v1/fs/share-ephemeral",
      complaint: "abolish/v1/fs/share-complaint",
    });
    expect(vectors.ballots.length).toBe(7);
    expect(vectors.decryptFailures.length).toBe(11);
    expect(vectors.postings.length).toBe(9);
    expect(vectors.complaints.length).toBe(11);
    expect(vectors.decode.length).toBe(23);
  });

  test.each(Object.entries(vectors.panels))("derives every key of %s from its seed", (_, keys) => {
    for (const k of keys) {
      const pair = keyPair(k);
      expect(bytesHex(encode(KEM_PUBLIC_KEY, pair.publicKey))).toBe(k.publicKey);
      const x = BigInt(k.x).toString(16).padStart(64, "0");
      const xLe = x.match(/../g)?.reverse().join("");
      expect(bytesHex(encode(KEM_SECRET_KEY, pair.secretKey))).toBe(k.seed + xLe);
    }
  });

  test.each(vectors.ballots.map((b) => [b.id, b] as const))(
    "ballot %s",
    { timeout: 60_000 },
    (_, b) => {
      const ctx = validityContext(b);
      const keys = panelOf(b);
      const vote = decode(COMMITTED_VOTE, hex(b.committedVote));
      // The committed vote carries the ciphertexts' hashes and is valid.
      expect(vote.share_hashes.map(bytesHex)).toEqual(b.shareHashes);
      expect(b.ciphertexts.map((c) => bytesHex(shareCiphertextHash(hex(c))))).toEqual(
        b.shareHashes,
      );
      expect(checkValidity(ctx, vote)).toEqual({ ok: true });
      for (const d of b.decryptions) {
        const r = openShares(
          ctx,
          d.seat,
          (keys[d.seat - 1] as KemKeyPair).secretKey,
          vote.vss,
          hex(b.ciphertexts[d.seat - 1] as string),
        );
        if (d.result === "ok") {
          expect(r.ok).toBe(true);
          if (r.ok) expect(bytesHex(encode(SHARES, r.shares))).toBe(d.shares);
        } else expect(r).toEqual({ ok: false, code: d.result });
      }
    },
  );

  test.each(
    vectors.ballots
      .filter((b) => b.decryptions.every((d) => d.result === "ok"))
      .map((b) => [b.id, b] as const),
  )("reproduces every ciphertext of %s byte for byte", { timeout: 60_000 }, (_, b) => {
    const polynomials: OptionPolynomials[] = b.randomness.polynomials.map((p) => ({
      f: p.f.map(BigInt),
      g: p.g.map(BigInt),
    }));
    const sharing = shareVoteWith(validityContext(b), b.votes, polynomials);
    const randomness: ShareEncapsulation[] = b.encapsulation.map((r) => ({
      m: hex(r.m),
      e: BigInt(r.e),
      w: BigInt(r.w),
    }));
    const out = encryptSharesWith(
      validityContext(b),
      sharing,
      panelOf(b).map((k) => k.publicKey),
      randomness,
    );
    expect(out.ciphertexts.map(bytesHex)).toEqual(b.ciphertexts);
    expect(out.hashes.map(bytesHex)).toEqual(b.shareHashes);
  });

  test.each(vectors.decryptFailures.map((d) => [d.id, d] as const))("decryption %s", (_, d) => {
    const key = (panels["panel-3"] as KemKeyPair[])[d.keySeat - 1] as KemKeyPair;
    const r = openShares(
      { definitionHash: hex(d.definitionHash) },
      d.seat,
      key.secretKey,
      decode(VSS, hex(d.vss)),
      hex(d.ciphertext),
    );
    expect(r).toEqual({ ok: false, code: d.result });
  });

  test.each(vectors.postings.map((p) => [p.id, p] as const))("posting %s", (_, p) => {
    const b = ballotById(p.ballot);
    const key = (panelOf(b)[p.seat - 1] as KemKeyPair).publicKey;
    const vss = decode(COMMITTED_VOTE, hex(b.committedVote)).vss;
    const r = checkPosting(validityContext(b), p.seat, key, vss, b.shareHashes.map(hex), {
      ciphertext: hex(p.ciphertext),
      m: hex(p.m),
    });
    expect(r).toEqual(p.result === "ok" ? { ok: true } : { ok: false, code: p.result });
  });

  test.each(vectors.complaints.map((c) => [c.id, c] as const))("complaint %s", (_, c) => {
    const b = ballotById(c.ballot);
    const ctx = validityContext(b);
    const pair = panelOf(b)[c.seat - 1] as KemKeyPair;
    const vote = decode(COMMITTED_VOTE, hex(b.committedVote));
    const proof = decode(COMPLAINT_PROOF, hex(c.proof));
    const posting = { ciphertext: hex(c.ciphertext), m: hex(c.m) };
    const r = checkComplaint(
      ctx,
      c.seat,
      pair.publicKey,
      vote.vss,
      vote.share_hashes,
      posting,
      proof,
    );
    expect(r).toEqual(c.result === "ok" ? { ok: true } : { ok: false, code: c.result });
    if (c.w !== undefined)
      expect(
        bytesHex(
          encode(
            COMPLAINT_PROOF,
            proveComplaintWith(
              ctx,
              c.seat,
              pair,
              vote.vss,
              vote.share_hashes,
              posting,
              BigInt(c.w),
            ),
          ),
        ),
      ).toBe(c.proof);
  });

  test("covers every result code", () => {
    const codes = new Set([
      ...vectors.ballots.flatMap((b) => b.decryptions.map((d) => d.result)),
      ...vectors.decryptFailures.map((d) => d.result),
      ...vectors.postings.map((p) => p.result),
      ...vectors.complaints.map((c) => c.result),
    ]);
    expect([...codes].sort()).toEqual([
      "complaint-proof",
      "complaint-unfounded",
      "ok",
      "posting-encapsulation",
      "posting-hash",
      "posting-malformed",
      "posting-proof",
      "share-check",
      "share-decrypt",
      "share-malformed",
      "share-proof",
    ]);
  });

  const codecs: Record<Vectors["decode"][number]["type"], Codec<unknown>> = {
    "kem-key": KEM_PUBLIC_KEY as Codec<unknown>,
    "kem-secret": KEM_SECRET_KEY as Codec<unknown>,
    "share-ciphertext": SHARE_CIPHERTEXT as Codec<unknown>,
    "complaint-proof": COMPLAINT_PROOF as Codec<unknown>,
  };

  test.each(vectors.decode.map((d) => [d.id, d] as const))("codec %s", (_, d) => {
    const codec = codecs[d.type];
    if (d.error === null) {
      expect(bytesHex(encode(codec, decode(codec, hex(d.encoding))))).toBe(d.encoding);
      return;
    }
    const run = () => decode(codec, hex(d.encoding));
    expect(run).toThrow(DecodeError);
    try {
      run();
    } catch (e) {
      expect((e as DecodeError).code).toBe(d.error);
    }
  });
});

// --- Properties --------------------------------------------------------------

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Key generation and ML-KEM are slow in JavaScript, so the properties share a
// small panel and scale their runs down.
const keyRuns = Math.max(10, Math.ceil(numRuns / 20));
const PANEL = Array.from({ length: 4 }, () => kemKeygen());

/** An election on PANEL: 1 to 4 options, 2 ≤ k ≤ n ≤ 4, and a vote it allows. */
const election = fc
  .record({
    m: fc.integer({ min: 1, max: 4 }),
    n: fc.integer({ min: 2, max: 4 }),
    kOffset: fc.nat(2),
    bits: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
    definitionHash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  })
  .map(({ m, n, kOffset, bits, definitionHash }) => {
    const votes = bits.slice(0, m).map((b) => (b ? 1 : 0)) as (0 | 1)[];
    const ctx: ValidityContext = {
      definitionHash,
      optionCount: m,
      minSelections: 0,
      maxSelections: m,
      threshold: Math.max(2, n - kOffset),
      panelSize: n,
      tier: 0,
      nullifier: 1n,
    };
    return { ctx, votes, keys: PANEL.slice(0, n) };
  });

function castBallot(ctx: ValidityContext, votes: readonly (0 | 1)[], keys: readonly KemKeyPair[]) {
  const sharing = shareVote(ctx, votes);
  const enc = encryptShares(
    ctx,
    sharing,
    keys.map((k) => k.publicKey),
  );
  return { sharing, enc, vote: proveValidity(ctx, sharing, enc.hashes) };
}

// options-max checks 64 options' validity and decrypts two 4 KB ciphertexts,
// and the properties run ML-KEM many times: over 5 s on a shared CI runner.
describe("properties", () => {
  test("every trustee opens its honest ciphertext to its own shares", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(election, ({ ctx, votes, keys }) => {
        const { sharing, enc, vote } = castBallot(ctx, votes, keys);
        keys.forEach((k, i) => {
          const r = openShares(ctx, i + 1, k.secretKey, vote.vss, enc.ciphertexts[i] as Uint8Array);
          expect(r.ok && bytesHex(encode(SHARES, r.shares))).toBe(
            bytesHex(encode(SHARES, sharing.shares[i] as never)),
          );
        });
      }),
      { numRuns: keyRuns },
    );
  });

  test(
    "an honest posting passes, and its trustee refuses to complain about it",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(election, fc.nat(), ({ ctx, votes, keys }, pick) => {
          const { enc, vote } = castBallot(ctx, votes, keys);
          const seat = (pick % keys.length) + 1;
          const ct = enc.ciphertexts[seat - 1] as Uint8Array;
          const posting = { ciphertext: ct, m: (enc.randomness[seat - 1] as ShareEncapsulation).m };
          const pair = keys[seat - 1] as KemKeyPair;
          expect(
            checkPosting(ctx, seat, pair.publicKey, vote.vss, vote.share_hashes, posting),
          ).toEqual({ ok: true });
          expect(() =>
            proveComplaint(ctx, seat, pair, vote.vss, vote.share_hashes, posting),
          ).toThrow(RangeError);
        }),
        { numRuns: keyRuns },
      );
    },
  );

  test(
    "a ciphertext carrying another ciphertext's ephemeral and proof fails its proof",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(election, ({ ctx, votes, keys }) => {
          // The copy attack of docs/spec/share-encryption.md (Ciphertext): an
          // attacker's own ciphertext with a victim's ct_dh and proof.
          const victim = castBallot(ctx, votes, keys).enc.ciphertexts[0] as Uint8Array;
          const own = castBallot(ctx, votes, keys);
          const ct = Uint8Array.from(own.enc.ciphertexts[0] as Uint8Array);
          ct.set(victim.subarray(1088, 1184), 1088);
          const pair = keys[0] as KemKeyPair;
          expect(openShares(ctx, 1, pair.secretKey, own.vote.vss, ct)).toEqual({
            ok: false,
            code: "share-proof",
          });
          const hashes = [shareCiphertextHash(ct), ...own.vote.share_hashes.slice(1)];
          const posting = { ciphertext: ct, m: (own.enc.randomness[0] as ShareEncapsulation).m };
          expect(checkPosting(ctx, 1, pair.publicKey, own.vote.vss, hashes, posting)).toEqual({
            ok: false,
            code: "posting-proof",
          });
        }),
        { numRuns: keyRuns },
      );
    },
  );

  test(
    "a changed byte anywhere in a ciphertext stops it opening and fails its posting",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(
          election,
          fc.nat(),
          fc.integer({ min: 1, max: 255 }),
          ({ ctx, votes, keys }, at, flip) => {
            const { enc, vote } = castBallot(ctx, votes, keys);
            const ct = Uint8Array.from(enc.ciphertexts[0] as Uint8Array);
            const i = at % ct.length;
            ct[i] = (ct[i] as number) ^ flip;
            const r = openShares(ctx, 1, (keys[0] as KemKeyPair).secretKey, vote.vss, ct);
            expect(r.ok).toBe(false);
            const posting = { ciphertext: ct, m: (enc.randomness[0] as ShareEncapsulation).m };
            expect(
              checkPosting(
                ctx,
                1,
                (keys[0] as KemKeyPair).publicKey,
                vote.vss,
                vote.share_hashes,
                posting,
              ).ok,
            ).toBe(false);
          },
        ),
        { numRuns: keyRuns },
      );
    },
  );

  test("a complaint with any altered field fails its proof", { timeout: 60_000 }, () => {
    const c = vectors.complaints.find((v) => v.id === "bad-share-complaint");
    if (c === undefined) throw new Error("no bad-share-complaint vector");
    const b = ballotById(c.ballot);
    const ctx = validityContext(b);
    const pair = panelOf(b)[c.seat - 1] as KemKeyPair;
    const vote = decode(COMMITTED_VOTE, hex(b.committedVote));
    const posting = { ciphertext: hex(c.ciphertext), m: hex(c.m) };
    const order = 2n ** 252n + 27742317777372353535851937790883648493n;
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        fc.bigInt({ min: 1n, max: 1n << 200n }),
        (field, delta) => {
          const p = proveComplaint(ctx, c.seat, pair, vote.vss, vote.share_hashes, posting);
          expect(
            checkComplaint(ctx, c.seat, pair.publicKey, vote.vss, vote.share_hashes, posting, p),
          ).toEqual({ ok: true });
          const bad =
            field === 0
              ? { ...p, dh: p.dh.add(G.multiply(delta)) }
              : field === 1
                ? { ...p, c: (p.c + delta) % order }
                : { ...p, z: (p.z + delta) % order };
          expect(
            checkComplaint(ctx, c.seat, pair.publicKey, vote.vss, vote.share_hashes, posting, bad),
          ).toEqual({ ok: false, code: "complaint-proof" });
        },
      ),
      { numRuns: keyRuns },
    );
  });

  test(
    "a ciphertext decodes only to a value that re-encodes to the same bytes",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 1188, maxLength: 1400 }), (bytes) => {
          let v: unknown;
          try {
            v = decode(SHARE_CIPHERTEXT, bytes);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
            return;
          }
          expect(bytesHex(encode(SHARE_CIPHERTEXT, v as never))).toBe(bytesHex(bytes));
        }),
        { numRuns },
      );
    },
  );

  test("a KEM key decodes only if it re-encodes to the same bytes", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1216, maxLength: 1216 }), (bytes) => {
        let v: unknown;
        try {
          v = decode(KEM_PUBLIC_KEY, bytes);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
          return;
        }
        expect(bytesHex(encode(KEM_PUBLIC_KEY, v as KemPublicKey))).toBe(bytesHex(bytes));
      }),
      { numRuns },
    );
  });
});

describe("input checks", () => {
  const rules = { optionCount: 2, minSelections: 0, maxSelections: 1, threshold: 2, panelSize: 2 };
  const ctx = { ...rules, definitionHash: new Uint8Array(32), tier: 0, nullifier: 1n };
  const keys = PANEL.slice(0, 2).map((k) => k.publicKey);

  test("encrypts only a sharing shareVote made", () => {
    const sharing = shareVote(rules, [1, 0]);
    expect(() => encryptShares(ctx, { ...sharing }, keys)).toThrow(TypeError);
  });

  test("needs one key and one encapsulation per seat", () => {
    const sharing = shareVote(rules, [1, 0]);
    expect(() => encryptShares(ctx, sharing, keys.slice(0, 1))).toThrow(RangeError);
    expect(() =>
      encryptSharesWith(ctx, sharing, keys, [{ m: new Uint8Array(32), e: 1n, w: 1n }]),
    ).toThrow(RangeError);
  });

  test("refuses an ephemeral or proof nonce of 0 and a short ML-KEM message", () => {
    const sharing = shareVote(rules, [1, 0]);
    const ok = { m: new Uint8Array(32), e: 1n, w: 1n };
    for (const bad of [
      { m: new Uint8Array(32), e: 0n, w: 1n },
      { m: new Uint8Array(32), e: 1n, w: 0n },
      { m: new Uint8Array(31), e: 1n, w: 1n },
    ])
      expect(() => encryptSharesWith(ctx, sharing, keys, [ok, bad])).toThrow(RangeError);
  });

  test("refuses a key that fails the modulus check or has an identity DH key", () => {
    const sharing = shareVote(rules, [1, 0]);
    const ek = Uint8Array.from((keys[0] as KemPublicKey).ek);
    ek[0] = 0xff;
    ek[1] = (ek[1] as number) | 0x0f;
    expect(() =>
      encryptShares(ctx, sharing, [{ ...(keys[0] as KemPublicKey), ek }, keys[1] as KemPublicKey]),
    ).toThrow();
    const identity = G.subtract(G);
    expect(() =>
      encryptShares(ctx, sharing, [
        { ...(keys[0] as KemPublicKey), dh: identity },
        keys[1] as KemPublicKey,
      ]),
    ).toThrow();
  });

  test("refuses a secret key of 0", () => {
    expect(() => kemKeyPairWith(new Uint8Array(64), 0n)).toThrow();
  });

  test("the package entry point exports no way to choose the randomness", async () => {
    const api: Record<string, unknown> = await import("../src/index.ts");
    expect(api["encryptSharesWith"]).toBeUndefined();
    expect(api["kemKeyPairWith"]).toBeUndefined();
    expect(api["proveComplaintWith"]).toBeUndefined();
  });
});
