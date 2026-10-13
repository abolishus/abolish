import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import { checkReceiptStatement } from "../src/share-receipt.ts";
import {
  ballotHash,
  checkShareReceipt,
  COMMITTED_VOTE,
  decode,
  encode,
  encryptShares,
  identityKey,
  intakeShares,
  type IntakeCode,
  type KemKeyPair,
  kemKeygen,
  proveValidity,
  type ReceiptSigner,
  shareCiphertextHash,
  shareReceiptStatement,
  SHARES,
  shareVote,
  signStatement,
  type ValidityContext,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/share-receipt.json comes from an independent Python
// implementation of the ballot hash and of intake and share receipts
// (scripts/share-receipt-vectors.py, with its own P-256 ECDSA and
// share-encryption-vectors.py's ML-KEM and AEAD), so the expected hashes,
// verdicts and receipt bytes never come from the code under test.

interface ContextVector {
  readonly definitionHash: string;
  readonly optionCount: number;
  readonly minSelections: number;
  readonly maxSelections: number;
  readonly threshold: number;
  readonly panelSize: number;
  readonly tier: number;
  readonly nullifier: string;
}

interface SeatVector {
  readonly seat: number;
  readonly signingSecret: string;
  readonly signingKey: string;
  readonly identityKey: string;
}

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly panels: Readonly<Record<string, readonly SeatVector[]>>;
  readonly ballotHashes: readonly {
    readonly source: "ballot-validity.json" | "share-encryption.json";
    readonly ballot: string;
    readonly ballotHash: string;
  }[];
  readonly intakes: readonly {
    readonly ballot: string;
    readonly seat: number;
    readonly result: "ok" | IntakeCode;
    readonly ballotHash?: string;
    readonly shareHash?: string;
    readonly statement?: string;
    readonly receipt?: string;
  }[];
  readonly intakeFailures: readonly {
    readonly id: string;
    readonly context: ContextVector;
    readonly seat: number;
    readonly committedVote: string;
    readonly ciphertext: string;
    readonly result: IntakeCode;
    readonly option?: number;
  }[];
  readonly receiptChecks: readonly {
    readonly id: string;
    readonly panel: string;
    readonly definitionHash: string;
    readonly ballotHash: string;
    readonly seat: number;
    readonly shareHash: string;
    readonly signature: string;
    readonly valid: boolean;
  }[];
}

interface SourceBallot {
  readonly id: string;
  readonly context: ContextVector;
  readonly result?: string;
  readonly encoding?: string;
  readonly committedVote?: string;
  readonly panel?: string;
  readonly ciphertexts?: readonly string[];
}

const read = <T>(name: string) =>
  JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as T;

const vectors = read<Vectors>("share-receipt.json");
const validity = read<{ ballots: readonly SourceBallot[] }>("ballot-validity.json");
const encryption = read<{
  panels: Readonly<Record<string, readonly { seed: string; x: string }[]>>;
  ballots: readonly SourceBallot[];
}>("share-encryption.json");

const bytesHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function validityContext(c: ContextVector): ValidityContext {
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

const kemPanels = Object.fromEntries(
  Object.entries(encryption.panels).map(([name, keys]) => [
    name,
    keys.map((k) => kemKeyPairWith(hex(k.seed), BigInt(k.x))),
  ]),
);

const signers = (panel: string): ReceiptSigner[] =>
  (vectors.panels[panel] as readonly SeatVector[]).map((s) => ({
    index: s.seat,
    signingKey: hex(s.signingKey),
  }));

function seatKeys(panel: string, seat: number) {
  const s = (vectors.panels[panel] as readonly SeatVector[])[seat - 1] as SeatVector;
  return {
    seat,
    kemSecret: ((kemPanels[panel] as KemKeyPair[])[seat - 1] as KemKeyPair).secretKey,
    signingSecret: hex(s.signingSecret),
  };
}

const encryptedBallot = (id: string) => encryption.ballots.find((b) => b.id === id) as SourceBallot;

describe("share-receipt.json", () => {
  test("is the format and tag set this code implements", () => {
    expect(vectors.format).toBe("abolish-share-receipt-vectors/1");
    expect(vectors.tags).toEqual({
      ballot: "abolish/v1/ballot",
      receipt: "abolish/v1/sig/share-receipt",
    });
    expect(vectors.ballotHashes.length).toBe(16);
    expect(vectors.intakes.length).toBe(33);
    expect(vectors.intakeFailures.length).toBe(11);
    expect(vectors.receiptChecks.length).toBe(16);
  });

  test.each(Object.entries(vectors.panels))("derives every key of %s", (_, seats) => {
    for (const s of seats) expect(bytesHex(identityKey(hex(s.signingSecret)))).toBe(s.signingKey);
  });

  test.each(vectors.ballotHashes.map((v) => [`${v.source} ${v.ballot}`, v] as const))(
    "ballot hash of %s",
    (_, v) => {
      const source = v.source === "ballot-validity.json" ? validity.ballots : encryption.ballots;
      const b = source.find((x) => x.id === v.ballot) as SourceBallot;
      const encoded = (b.encoding ?? b.committedVote) as string;
      const vote = decode(COMMITTED_VOTE, hex(encoded));
      expect(bytesHex(ballotHash(validityContext(b.context), vote))).toBe(v.ballotHash);
    },
  );

  test.each(vectors.intakes.map((v) => [`${v.ballot} seat ${v.seat}`, v] as const))(
    "intake of %s",
    { timeout: 60_000 },
    (_, v) => {
      const b = encryptedBallot(v.ballot);
      const vote = decode(COMMITTED_VOTE, hex(b.committedVote as string));
      const r = intakeShares(
        validityContext(b.context),
        seatKeys(b.panel as string, v.seat),
        vote,
        hex((b.ciphertexts as readonly string[])[v.seat - 1] as string),
      );
      if (v.result !== "ok") {
        expect(r).toEqual({ ok: false, code: v.result });
        return;
      }
      if (!r.ok) throw new Error(`intake failed: ${r.code}`);
      expect(bytesHex(r.ballotHash)).toBe(v.ballotHash);
      expect(bytesHex(r.shareHash)).toBe(v.shareHash);
      // RFC 6979: the receipt is reproduced byte for byte.
      expect(bytesHex(r.receipt)).toBe(v.receipt);
      const statement = {
        definition_hash: hex(b.context.definitionHash),
        ballot_hash: r.ballotHash,
        seat: v.seat,
        share_hash: r.shareHash,
      };
      expect(bytesHex(shareReceiptStatement(statement))).toBe(v.statement);
      expect(checkReceiptStatement(signers(b.panel as string), statement, r.receipt)).toBe(true);
      const ctx = validityContext(b.context);
      expect(checkShareReceipt(signers(b.panel as string), ctx, vote, v.seat, r.receipt)).toBe(
        true,
      );
      // The same receipt never checks for another seat of the same ballot.
      const other = (v.seat % ctx.panelSize) + 1;
      expect(checkShareReceipt(signers(b.panel as string), ctx, vote, other, r.receipt)).toBe(
        false,
      );
    },
  );

  test.each(vectors.intakeFailures.map((v) => [v.id, v] as const))("intake fails: %s", (_, v) => {
    const r = intakeShares(
      validityContext(v.context),
      seatKeys("panel-3", v.seat),
      decode(COMMITTED_VOTE, hex(v.committedVote)),
      hex(v.ciphertext),
    );
    expect(r).toEqual(
      v.option === undefined
        ? { ok: false, code: v.result }
        : { ok: false, code: v.result, option: v.option },
    );
  });

  test.each(vectors.receiptChecks.map((v) => [v.id, v] as const))("receipt check: %s", (_, v) => {
    const statement = {
      definition_hash: hex(v.definitionHash),
      ballot_hash: hex(v.ballotHash),
      seat: v.seat,
      share_hash: hex(v.shareHash),
    };
    expect(checkReceiptStatement(signers(v.panel), statement, hex(v.signature))).toBe(v.valid);
  });

  test("an identity key is never a receipt signer", () => {
    // The identity-key vector's signature verifies under the identity key
    // itself, so only registering the per-election key keeps it out.
    const v = vectors.receiptChecks.find((c) => c.id === "identity-key");
    const seat = (vectors.panels["panel-3"] as readonly SeatVector[])[0] as SeatVector;
    const statement = {
      definition_hash: hex(v?.definitionHash as string),
      ballot_hash: hex(v?.ballotHash as string),
      seat: 1,
      share_hash: hex(v?.shareHash as string),
    };
    const sig = hex(v?.signature as string);
    expect(
      checkReceiptStatement([{ index: 1, signingKey: hex(seat.identityKey) }], statement, sig),
    ).toBe(true);
    expect(checkReceiptStatement(signers("panel-3"), statement, sig)).toBe(false);
  });
});

// --- Properties --------------------------------------------------------------

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// ML-KEM is slow in JavaScript, so the intake properties share a small panel
// and scale their runs down.
const keyRuns = Math.max(10, Math.ceil(numRuns / 20));
const PANEL = Array.from({ length: 3 }, () => kemKeygen());
const SIGNING = Array.from({ length: 3 }, (_, i) =>
  Uint8Array.from({ length: 32 }, (_, j) => (j === 31 ? i + 1 : 0x5a)),
);
const SIGNERS: ReceiptSigner[] = SIGNING.map((s, i) => ({
  index: i + 1,
  signingKey: identityKey(s),
}));

const election = fc
  .record({
    m: fc.integer({ min: 1, max: 3 }),
    n: fc.integer({ min: 2, max: 3 }),
    bits: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
    definitionHash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    tier: fc.integer({ min: 0, max: 2 }),
    nullifier: fc.bigInt({ min: 0n, max: 2n ** 253n }),
  })
  .map(({ m, n, bits, definitionHash, tier, nullifier }) => {
    const votes = bits.slice(0, m).map((b) => (b ? 1 : 0)) as (0 | 1)[];
    const ctx: ValidityContext = {
      definitionHash,
      optionCount: m,
      minSelections: 0,
      maxSelections: m,
      threshold: 2,
      panelSize: n,
      tier,
      nullifier,
    };
    return { ctx, votes };
  });

function castBallot(ctx: ValidityContext, votes: readonly (0 | 1)[]) {
  const sharing = shareVote(ctx, votes);
  const enc = encryptShares(
    ctx,
    sharing,
    PANEL.slice(0, ctx.panelSize).map((k) => k.publicKey),
  );
  return { sharing, enc, vote: proveValidity(ctx, sharing, enc.hashes) };
}

const keysOf = (seat: number) => ({
  seat,
  kemSecret: (PANEL[seat - 1] as KemKeyPair).secretKey,
  signingSecret: SIGNING[seat - 1] as Uint8Array,
});

describe("properties", () => {
  test(
    "every seat's intake of an honest ballot gives its shares and a receipt that checks",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(election, ({ ctx, votes }) => {
          const { sharing, enc, vote } = castBallot(ctx, votes);
          for (let seat = 1; seat <= ctx.panelSize; seat++) {
            const ct = enc.ciphertexts[seat - 1] as Uint8Array;
            const r = intakeShares(ctx, keysOf(seat), vote, ct);
            if (!r.ok) throw new Error(`intake failed: ${r.code}`);
            expect(bytesHex(encode(SHARES, r.shares))).toBe(
              bytesHex(encode(SHARES, sharing.shares[seat - 1] as never)),
            );
            expect(bytesHex(r.ballotHash)).toBe(bytesHex(ballotHash(ctx, vote)));
            expect(bytesHex(r.shareHash)).toBe(bytesHex(shareCiphertextHash(ct)));
            const statement = {
              definition_hash: ctx.definitionHash,
              ballot_hash: r.ballotHash,
              seat,
              share_hash: r.shareHash,
            };
            expect(checkReceiptStatement(SIGNERS, statement, r.receipt)).toBe(true);
            expect(checkShareReceipt(SIGNERS, ctx, vote, seat, r.receipt)).toBe(true);
            expect(
              checkShareReceipt(SIGNERS, { ...ctx, tier: ctx.tier ^ 1 }, vote, seat, r.receipt),
            ).toBe(false);
            // Delivered again, the same receipt (RFC 6979).
            const again = intakeShares(ctx, keysOf(seat), vote, ct);
            expect(again.ok && bytesHex(again.receipt)).toBe(bytesHex(r.receipt));
          }
        }),
        { numRuns: keyRuns },
      );
    },
  );

  test(
    "intake refuses another seat's ciphertext without decrypting it",
    { timeout: 60_000 },
    () => {
      fc.assert(
        fc.property(election, fc.nat(), ({ ctx, votes }, pick) => {
          const { enc, vote } = castBallot(ctx, votes);
          const seat = (pick % ctx.panelSize) + 1;
          const other = (seat % ctx.panelSize) + 1;
          const r = intakeShares(ctx, keysOf(seat), vote, enc.ciphertexts[other - 1] as Uint8Array);
          expect(r).toEqual({ ok: false, code: "share-hash" });
        }),
        { numRuns: keyRuns },
      );
    },
  );

  // One signature and three verifications per run: P-256 in JavaScript needs
  // more than the default 5 s at FC_NUM_RUNS=1000.
  test("a receipt checks only for its own statement", { timeout: 120_000 }, () => {
    const statement = fc.record({
      definition_hash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
      ballot_hash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
      seat: fc.integer({ min: 1, max: 3 }),
      share_hash: fc.uint8Array({ minLength: 32, maxLength: 32 }),
    });
    fc.assert(
      fc.property(
        statement,
        fc.nat(),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (s, field, at, x) => {
          const sig = signWith(s);
          expect(checkReceiptStatement(SIGNERS, s, sig)).toBe(true);
          // Any one byte of the 97-byte statement changed.
          const m = shareReceiptStatement(s);
          const i = at % m.length;
          m[i] = (m[i] as number) ^ x;
          const changed = {
            definition_hash: m.slice(0, 32),
            ballot_hash: m.slice(32, 64),
            seat: m[64] as number,
            share_hash: m.slice(65, 97),
          };
          expect(checkReceiptStatement(SIGNERS, changed, sig)).toBe(false);
          // Or the signature itself.
          const bad = Uint8Array.from(sig);
          const j = field % bad.length;
          bad[j] = (bad[j] as number) ^ x;
          expect(checkReceiptStatement(SIGNERS, s, bad)).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  test("the ballot hash changes with every input", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(election, fc.nat(), ({ ctx, votes }, pick) => {
        const vote = proveValidity(
          ctx,
          shareVote(ctx, votes),
          Array.from({ length: ctx.panelSize }, () => new Uint8Array(32)),
        );
        const h = bytesHex(ballotHash(ctx, vote));
        const changes: (() => Uint8Array)[] = [
          () => ballotHash({ ...ctx, definitionHash: flip(ctx.definitionHash, pick) }, vote),
          () => ballotHash({ ...ctx, tier: ctx.tier ^ 1 }, vote),
          () => ballotHash({ ...ctx, nullifier: ctx.nullifier + 1n }, vote),
          () => {
            const enc = encode(COMMITTED_VOTE, vote);
            // A byte of a proof, the last field: it still decodes unless it
            // made a scalar non-canonical, which a property elsewhere covers.
            try {
              return ballotHash(
                ctx,
                decode(COMMITTED_VOTE, flip(enc, enc.length - 1 - (pick % 31))),
              );
            } catch {
              return new Uint8Array(32);
            }
          },
        ];
        for (const change of changes) expect(bytesHex(change())).not.toBe(h);
      }),
      { numRuns: Math.max(10, Math.ceil(numRuns / 10)) },
    );
  });
});

function flip(b: Uint8Array, at: number): Uint8Array {
  const out = Uint8Array.from(b);
  out[at % out.length] = (out[at % out.length] as number) ^ 1;
  return out;
}

function signWith(s: {
  readonly definition_hash: Uint8Array;
  readonly ballot_hash: Uint8Array;
  readonly seat: number;
  readonly share_hash: Uint8Array;
}): Uint8Array {
  // A receipt as intake signs it, without running intake.
  return signStatement(
    SIGNING[s.seat - 1] as Uint8Array,
    "abolish/v1/sig/share-receipt",
    shareReceiptStatement(s),
  );
}
