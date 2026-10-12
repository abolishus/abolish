import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  aggregateCell,
  type CommittedVote,
  decode,
  DecodeError,
  decodeElectionDefinition,
  decodeSummedShareMessage,
  type ElectionDefinition,
  element,
  encode,
  encodeSummedShareMessage,
  GROUP_ORDER,
  identityKey,
  KEM_PUBLIC_KEY,
  list,
  openSummedShares,
  sealSummedShares,
  type Share,
  shareVote,
  type SummedShareElection,
  sumShares,
  signStatement,
  type TallyRules,
} from "../src/index.ts";
import { ristretto255 } from "@noble/curves/ed25519.js";
import { checkedKeySetForTests } from "../src/ceremony.ts";
import { kemKeyPairWith, openShares, SHARE_CIPHERTEXT } from "../src/share-encryption.ts";
import {
  openSummedSharesWith,
  sealSummedSharesWith,
  type SummedShareElectionContext,
} from "../src/summed-share.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/summed-share.json comes from an independent Python
// implementation of docs/spec/tally.md, Summed-share message
// (scripts/summed-share-vectors.py, with its own ML-KEM-768, ChaCha20-Poly1305,
// P-256 ECDSA, strict decoder and receiving checks), so these bytes and
// verdicts never come from the code under test.

interface Vectors {
  readonly format: string;
  readonly recordType: string;
  readonly version: number;
  readonly tags: { readonly kem: string; readonly aad: string; readonly signature: string };
  readonly election: {
    readonly definitionHash: string;
    readonly rules: TallyRules;
    readonly cells: readonly (readonly string[])[];
    readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
  };
  readonly seats: readonly {
    readonly index: number;
    readonly kem: { readonly seed: string; readonly x: string; readonly publicKey: string };
    readonly signingSecret: string;
    readonly signingKey: string;
  }[];
  readonly messages: readonly {
    readonly id: string;
    readonly cell: number;
    readonly sender: number;
    readonly recipient: number;
    readonly summed: readonly { readonly v: string; readonly r: string }[];
    readonly mu: string;
    readonly e: string;
    readonly encoding: string;
  }[];
  readonly decodeErrors: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly error: string;
    readonly offset: number;
  }[];
  readonly receiving: readonly {
    readonly id: string;
    readonly recipient: number;
    readonly encoding: string;
    readonly result: string;
  }[];
}

const DEFINITIONS = JSON.parse(
  readFileSync(new URL("election-definition.json", SPEC_VECTORS), "utf8"),
) as { readonly vectors: readonly { readonly id: string; readonly encoding?: string }[] };

const vectors = JSON.parse(
  readFileSync(new URL("summed-share.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VSS = list(list(element, 16), 64);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const shares = (s: readonly { readonly v: string; readonly r: string }[]): Share[] =>
  s.map(({ v, r }) => ({ v: BigInt(v), r: BigInt(r) }));

const rules = vectors.election.rules;
const definitionHash = hex(vectors.election.definitionHash);
const aggregates = vectors.election.cells.map((c) =>
  aggregateCell(
    rules,
    c.map((b) => decode(VSS, hex(b)) as CommittedVote["vss"]),
  ),
);
const seats = vectors.seats.map((s) => ({
  index: s.index,
  kem: kemKeyPairWith(hex(s.kem.seed), BigInt(s.kem.x)),
  signingSecret: hex(s.signingSecret),
}));
const seat = (i: number) => {
  const s = seats[i - 1];
  if (s === undefined) throw new Error(`no seat ${i}`);
  return s;
};
/** The registered key set: seat 4 has keys but isn't qualified. */
/** The definition's `ceremony_transcript_hash` the key sets below are checked against (test data). */
const ceremonyTranscriptHash = new Uint8Array(32).fill(0x5a);
const registered = checkedKeySetForTests(
  vectors.election.registered.map((k) => ({
    index: k.index,
    kemKey: seat(k.index).kem.publicKey,
    signingKey: hex(k.signingKey),
  })),
  ceremonyTranscriptHash,
);
const election: SummedShareElectionContext = {
  definitionHash,
  ceremonyTranscriptHash,
  rules,
  aggregates,
  registered,
};

describe("summed-share.json", () => {
  test("is the file this suite reads", () => {
    expect(vectors.format).toBe("abolish-summed-share-vectors/1");
    expect(vectors.recordType).toBe("0x000b");
    expect(vectors.version).toBe(1);
    expect(vectors.tags).toEqual({
      kem: "abolish/v1/kem/summed-share",
      aad: "abolish/v1/kem/summed-share-aad",
      signature: "abolish/v1/sig/summed-share",
    });
  });

  test.each(vectors.seats)("seat $index's keys come from its secrets", (s) => {
    expect(toHex(encode(KEM_PUBLIC_KEY, seat(s.index).kem.publicKey))).toBe(s.kem.publicKey);
    expect(toHex(identityKey(hex(s.signingSecret)))).toBe(s.signingKey);
  });

  test.each(vectors.messages)("$id is re-made byte for byte and opens", (v) => {
    const sender = seat(v.sender);
    const recipient = seat(v.recipient);
    const summed = shares(v.summed);
    const sealed = sealSummedSharesWith(
      {
        definitionHash,
        ceremonyTranscriptHash,
        rules,
        cell: v.cell,
        aggregate: aggregates[v.cell] ?? [],
      },
      registered,
      { index: v.sender, signingSecret: sender.signingSecret },
      v.recipient,
      summed,
      hex(v.mu),
      BigInt(v.e),
    );
    expect(toHex(sealed)).toBe(v.encoding);
    expect(toHex(encodeSummedShareMessage(decodeSummedShareMessage(sealed, 1)))).toBe(v.encoding);
    expect(
      openSummedSharesWith(
        election,
        { index: v.recipient, secretKey: recipient.kem.secretKey },
        sealed,
      ),
    ).toEqual({ ok: true, cell: v.cell, sender: v.sender, summed });
  });

  test.each(vectors.decodeErrors)("$id is rejected with $error at $offset", (v) => {
    let caught: unknown;
    try {
      decodeSummedShareMessage(hex(v.encoding), 1);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    expect((caught as DecodeError).code).toBe(v.error);
    expect((caught as DecodeError).offset).toBe(v.offset);
    expect(
      openSummedSharesWith(
        election,
        { index: 2, secretKey: seat(2).kem.secretKey },
        hex(v.encoding),
      ),
    ).toEqual({ ok: false, code: "summed-malformed" });
  });

  test.each(vectors.receiving)("receiving $id: $result", (v) => {
    const r = openSummedSharesWith(
      election,
      { index: v.recipient, secretKey: seat(v.recipient).kem.secretKey },
      hex(v.encoding),
    );
    expect(r.ok ? "ok" : r.code).toBe(v.result);
  });
});

describe("summed-share messages", () => {
  // A registered definition (election-definition.json's typical one) with a
  // 2-of-3 panel over three options, naming the transcript the key sets below
  // are checked against: the public API derives the definition hash, the
  // transcript hash and the rules from it.
  const typical = DEFINITIONS.vectors.find((v) => v.id === "definition-typical");
  if (typical?.encoding === undefined) throw new Error("no typical definition vector");
  const definition: ElectionDefinition = {
    ...decodeElectionDefinition(hex(typical.encoding)),
    option_count: 3,
    threshold: 2,
    panel_size: 3,
    ceremony_transcript_hash: ceremonyTranscriptHash,
  };

  // A fresh 2-of-3 election with one cell of random ballots, all seats registered.
  function freshElection(votes: readonly (readonly (0 | 1)[])[]) {
    const r: TallyRules = { optionCount: 3, threshold: 2, panelSize: 3 };
    const validity = { ...r, minSelections: 0, maxSelections: 3 };
    const sharings = votes.map((v) => shareVote(validity, v));
    const aggregate = aggregateCell(
      r,
      sharings.map((s) => s.vss),
    );
    const summed = [1, 2, 3].map((i) =>
      sumShares(
        r,
        sharings.map((s) => s.shares[i - 1] as readonly Share[]),
      ),
    );
    const e: SummedShareElection = {
      definition,
      aggregates: [aggregate],
      registered: checkedKeySetForTests(
        [1, 2, 3].map((i) => ({
          index: i,
          kemKey: seat(i).kem.publicKey,
          signingKey: identityKey(seat(i).signingSecret),
        })),
        ceremonyTranscriptHash,
      ),
    };
    return { rules: r, aggregate, summed, election: e };
  }

  const fresh = freshElection([
    [1, 0, 0],
    [0, 1, 1],
  ]);
  const cell = { definition, cell: 0, aggregate: fresh.aggregate };
  const send = (from: number, to: number, summed?: readonly Share[]) =>
    sealSummedShares(
      cell,
      fresh.election.registered,
      { index: from, signingSecret: seat(from).signingSecret },
      to,
      summed ?? (fresh.summed[from - 1] as Share[]),
    );
  const receive = (to: number, bytes: Uint8Array) =>
    openSummedShares(fresh.election, { index: to, secretKey: seat(to).kem.secretKey }, bytes);

  test("honest sums from any seat open at any other seat", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.constantFrom<0 | 1>(0, 1), { minLength: 3, maxLength: 3 }), {
          maxLength: 4,
        }),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 2 }),
        (votes, from, step) => {
          const f = freshElection(votes);
          const to = ((from - 1 + step) % 3) + 1;
          const summed = f.summed[from - 1] as Share[];
          const bytes = sealSummedShares(
            { definition, cell: 0, aggregate: f.aggregate },
            f.election.registered,
            { index: from, signingSecret: seat(from).signingSecret },
            to,
            summed,
          );
          expect(
            openSummedShares(f.election, { index: to, secretKey: seat(to).kem.secretKey }, bytes),
          ).toEqual({ ok: true, cell: 0, sender: from, summed });
        },
      ),
      { numRuns: Math.min(numRuns, 50) },
    );
  });

  test("any changed byte of a message is refused", { timeout: 60_000 }, () => {
    const bytes = send(1, 2);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: bytes.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = Uint8Array.from(bytes);
          changed[at] = (changed[at] as number) ^ flip;
          expect(receive(2, changed).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  });

  /** Decodes or throws a DecodeError; whatever decodes re-encodes to the same bytes. */
  function canonical(b: Uint8Array): void {
    let decoded;
    try {
      decoded = decodeSummedShareMessage(b, 1);
    } catch (e) {
      expect(e).toBeInstanceOf(DecodeError);
      return;
    }
    expect(encodeSummedShareMessage(decoded)).toEqual(b);
  }

  test(
    "every accepted encoding re-encodes to itself, and other bytes are refused",
    { timeout: 60_000 },
    () => {
      const honest = send(2, 3);
      canonical(honest);
      const header = Uint8Array.of(0x00, 0x0b, 0x01);
      fc.assert(
        fc.property(
          fc.oneof(
            // Random bytes, and random tails behind a valid header, around the
            // record's length so the fixed fields are reached.
            fc.uint8Array({ maxLength: 2000 }),
            fc
              .uint8Array({ minLength: 1150, maxLength: 1500 })
              .map((t) => Uint8Array.from([...header, ...t])),
            // Near-valid: an honest record cut, extended, or with a byte changed.
            fc.integer({ min: 0, max: honest.length }).map((n) => honest.slice(0, n)),
            fc
              .uint8Array({ minLength: 1, maxLength: 8 })
              .map((t) => Uint8Array.from([...honest, ...t])),
            fc
              .tuple(
                fc.integer({ min: 0, max: honest.length - 1 }),
                fc.integer({ min: 1, max: 255 }),
              )
              .map(([at, flip]) => {
                const b = Uint8Array.from(honest);
                b[at] = (b[at] as number) ^ flip;
                return b;
              }),
          ),
          canonical,
        ),
        { numRuns },
      );
    },
  );

  test(
    "records round-trip: decode(encode(x)) = x for any field values",
    { timeout: 60_000 },
    () => {
      const secret = seat(1).signingSecret;
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          fc.integer({ min: 0, max: 255 }),
          fc.uint8Array({ minLength: 32, maxLength: 32 }),
          fc.integer({ min: 0, max: 255 }),
          fc.integer({ min: 0, max: 255 }),
          fc.uint8Array({ minLength: 1088, maxLength: 1088 }),
          fc.bigInt({ min: 1n, max: GROUP_ORDER - 1n }),
          fc.uint8Array({ maxLength: 4 + 64 * 64 + 16 }),
          (definition_hash, cell, aggregate_hash, sender, recipient, ct_mlkem, e, sealed) => {
            const unsigned = {
              definition_hash,
              cell,
              aggregate_hash,
              sender,
              recipient,
              ct_mlkem,
              ct_dh: ristretto255.Point.BASE.multiply(e),
              sealed,
            };
            const message = {
              ...unsigned,
              signature: signStatement(secret, "abolish/v1/sig/summed-share", new Uint8Array(1)),
            };
            const bytes = encodeSummedShareMessage(message);
            const back = decodeSummedShareMessage(bytes, 1);
            expect({ ...back, ct_dh: toHex(back.ct_dh.toBytes()) }).toEqual({
              ...message,
              ct_dh: toHex(message.ct_dh.toBytes()),
            });
            expect(encodeSummedShareMessage(back)).toEqual(bytes);
          },
        ),
        { numRuns: Math.min(numRuns, 200) },
      );
    },
  );

  test("each message seals under fresh randomness", () => {
    const a = decodeSummedShareMessage(send(1, 3), 1);
    const b = decodeSummedShareMessage(send(1, 3), 1);
    expect(a.ct_mlkem).not.toEqual(b.ct_mlkem);
    expect(a.ct_dh.equals(b.ct_dh)).toBe(false);
  });

  test("a sender seals only to a registered seat's registered KEM key, under its own registered key", () => {
    // Seat 4 isn't in the registered set: refused, whatever key a caller has for it.
    expect(() => send(1, 4)).toThrow(RangeError);
    // A sender whose signing key isn't the one registered for its seat is refused.
    expect(() =>
      sealSummedShares(
        cell,
        fresh.election.registered,
        { index: 1, signingSecret: seat(2).signingSecret },
        2,
        fresh.summed[0] as Share[],
      ),
    ).toThrow(RangeError);
    // The KEM key used is the registered set's, never one passed alongside: with
    // seat 2's registered key replaced by seat 3's, seat 2 can't open the message.
    const swapped = checkedKeySetForTests(
      fresh.election.registered.map((k) =>
        k.index === 2 ? { ...k, kemKey: seat(3).kem.publicKey } : k,
      ),
      ceremonyTranscriptHash,
    );
    const bytes = sealSummedShares(
      cell,
      swapped,
      { index: 1, signingSecret: seat(1).signingSecret },
      2,
      fresh.summed[0] as Share[],
    );
    expect(receive(2, bytes)).toEqual({ ok: false, code: "summed-decrypt" });
  });

  test("a sender refuses a key set checkCeremonyTranscript didn't return", () => {
    // The same keys, served as a plain array (from an API, a cache, a file):
    // refused, so no one serving keys to a node can substitute one (T-37).
    const served = fresh.election.registered.map((k) => ({ ...k }));
    expect(() =>
      sealSummedShares(
        cell,
        served,
        { index: 1, signingSecret: seat(1).signingSecret },
        2,
        fresh.summed[0] as Share[],
      ),
    ).toThrow(TypeError);
  });

  test("a checked key set from another transcript is refused on both sides", () => {
    // Another run's or another election's checked set: its transcript isn't
    // the one this definition names.
    const other = checkedKeySetForTests(fresh.election.registered, new Uint8Array(32).fill(0x11));
    expect(() =>
      sealSummedShares(
        cell,
        other,
        { index: 1, signingSecret: seat(1).signingSecret },
        2,
        fresh.summed[0] as Share[],
      ),
    ).toThrow(TypeError);
    const bytes = send(1, 2);
    const open = (registered: SummedShareElection["registered"]) =>
      openSummedShares(
        { ...fresh.election, registered },
        { index: 2, secretKey: seat(2).kem.secretKey },
        bytes,
      );
    expect(() => open(other)).toThrow(TypeError);
    // The transcript hash comes from the definition itself: a definition
    // naming another transcript refuses this election's checked set.
    const elsewhere = { ...definition, ceremony_transcript_hash: new Uint8Array(32).fill(0x11) };
    expect(() =>
      openSummedShares(
        { ...fresh.election, definition: elsewhere },
        { index: 2, secretKey: seat(2).kem.secretKey },
        bytes,
      ),
    ).toThrow(TypeError);
    // A plain array with the same keys is refused by the recipient too, so
    // only the definition's checked set decides who reaches decapsulation (T-39).
    expect(() => open(fresh.election.registered.map((k) => ({ ...k })))).toThrow(TypeError);
    expect(open(fresh.election.registered).ok).toBe(true);
  });

  test("a sender refuses sums that fail its own check, and never sends to itself", () => {
    const wrong = (fresh.summed[0] as Share[]).map((s, j) =>
      j === 0 ? { ...s, v: (s.v + 1n) % GROUP_ORDER } : s,
    );
    expect(() => send(1, 2, wrong)).toThrow(RangeError);
    expect(() => send(1, 2, fresh.summed[1])).toThrow(RangeError);
    expect(() => send(2, 2)).toThrow(RangeError);
  });

  test("only the addressed recipient's key opens a message", () => {
    const bytes = send(1, 2);
    expect(receive(2, bytes).ok).toBe(true);
    // Seat 3 is the wrong recipient by context; even read as seat 2's, its key
    // fails decryption.
    expect(receive(3, bytes)).toEqual({ ok: false, code: "summed-context" });
    const asSeat2 = openSummedShares(
      fresh.election,
      { index: 2, secretKey: seat(3).kem.secretKey },
      bytes,
    );
    expect(asSeat2).toEqual({ ok: false, code: "summed-decrypt" });
  });

  test("a signing key other than the sender's registered one fails summed-signature", () => {
    const e = {
      ...fresh.election,
      registered: checkedKeySetForTests(
        fresh.election.registered.map((k) =>
          k.index === 1 ? { ...k, signingKey: identityKey(seat(3).signingSecret) } : k,
        ),
        ceremonyTranscriptHash,
      ),
    };
    expect(openSummedShares(e, { index: 2, secretKey: seat(2).kem.secretKey }, send(1, 2))).toEqual(
      { ok: false, code: "summed-signature" },
    );
  });

  test("a summed-share message's KEM parts fail share intake at the proof of knowledge", () => {
    const m = decodeSummedShareMessage(send(1, 2), 1);
    const ct = encode(SHARE_CIPHERTEXT, {
      ct_mlkem: m.ct_mlkem,
      ct_dh: m.ct_dh,
      pok_c: 1n,
      pok_z: 1n,
      sealed: m.sealed,
    });
    const r = openShares({ definitionHash }, 2, seat(2).kem.secretKey, fresh.aggregate, ct);
    // Only the ephemeral's owner can make a passing proof over these parts;
    // the tag separation behind it is the cross-use vector's.
    expect(r).toEqual({ ok: false, code: "share-proof" });
  });
});
