import { sha256 } from "@noble/hashes/sha2.js";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ANSWER_PLAINTEXT,
  decodeSealedAnswer,
  decodeSealedDelivery,
  DELIVERY_ENVELOPE,
  type DeliveryAnswer,
  type DeliveryEnvelope,
  deliveryHolder,
  type DeliveryKey,
  encodeSealedAnswer,
  encodeSealedDelivery,
  KEM_PUBLIC_KEY,
  kemKeygen,
  kemKeyHash,
  MAX_ANSWER_BODY,
  MAX_DELIVERY,
  MAX_SEALED_REQUEST,
  openSealedAnswer,
  openSealedDelivery,
  PAD_BUCKETS,
  padDeliveryEnvelope,
  paddedDeliveryLength,
  SEALED_ANSWER_LENGTH,
  sealAnswer,
  sealDelivery,
  sealedDeliveryHash,
  TAG_REGISTRY,
} from "../src/index.ts";
import { encode } from "../src/codec.ts";
import { RECORD_TYPES } from "../src/record.ts";
import { sealAnswerWith, sealDeliveryWith } from "../src/sealed-delivery.ts";
import { type KemKeyPair, kemKeyPairWith } from "../src/share-encryption.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/sealed-delivery.json comes from an independent Python
// implementation of docs/spec/sealed-delivery.md (scripts/sealed-delivery-
// vectors.py, over share-encryption-vectors.py's ML-KEM-768, ChaCha20-Poly1305
// and ristretto255), delivering intake.json's ballots and ciphertexts, so
// these values never come from the code under test.

type Outcome = "receipt" | "refused" | "busy";

interface AnswerSealing {
  readonly answerNonce: string;
  readonly answerKey: string;
  readonly aad: string;
}

interface Vectors {
  readonly tags: Readonly<
    Record<"kemKey" | "requestKem" | "requestAad" | "answerKey" | "answerAad" | "request", string>
  >;
  readonly recordTypes: { readonly request: number; readonly answer: number };
  readonly maxDelivery: number;
  readonly padBuckets: readonly number[];
  readonly maxRequest: number;
  readonly answerLength: number;
  readonly answerPlaintext: number;
  readonly seats: readonly {
    readonly seat: number;
    readonly kemKey: string;
    readonly kemKeyHash: string;
    readonly seed: string;
    readonly x: string;
  }[];
  readonly deliveries: readonly {
    readonly id: string;
    readonly seat: number;
    readonly envelope: {
      readonly stub: string;
      readonly transcript: { readonly length: number; readonly label: string };
      readonly intakeCase: string;
      readonly length: number;
      readonly paddedLength: number;
    };
    readonly sealing: {
      readonly mu: string;
      readonly e: string;
      readonly ssM: string;
      readonly ssDh: string;
      readonly key: string;
      readonly aad: string;
    };
    readonly record: string;
    readonly requestHash: string;
    readonly answers: readonly {
      readonly outcome: Outcome;
      readonly body: string;
      readonly sealing: AnswerSealing;
      readonly record: string;
    }[];
  }[];
  readonly versionTwoReceipt: {
    readonly request: string;
    readonly body: string;
    readonly sealing: AnswerSealing;
    readonly record: string;
  };
  readonly padding: readonly { readonly envelopeLength: number; readonly paddedLength: number }[];
  readonly rejectedRequests: readonly {
    readonly description: string;
    readonly code: string;
    readonly seat: number;
    readonly openedBy: number;
    readonly record: string;
  }[];
  readonly acceptedAnswers: readonly {
    readonly description: string;
    readonly request: string;
    readonly outcome: Outcome;
    readonly body: string;
    readonly sealing: AnswerSealing;
    readonly record: string;
  }[];
  readonly rejectedAnswers: readonly {
    readonly description: string;
    readonly code: string;
    readonly request: string;
    readonly record: string;
  }[];
}

interface IntakeCase {
  readonly id: string;
  readonly record: string;
  readonly ciphertext: string;
}

const V = JSON.parse(
  readFileSync(new URL("sealed-delivery.json", SPEC_VECTORS), "utf8"),
) as Vectors;
const INTAKE = JSON.parse(readFileSync(new URL("intake.json", SPEC_VECTORS), "utf8")) as {
  readonly cases: readonly IntakeCase[];
};

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const ascii = (b: Uint8Array) => String.fromCharCode(...b);

const seats = new Map(
  V.seats.map((s) => {
    const pair = kemKeyPairWith(hex(s.seed), BigInt(s.x));
    expect(toHex(encode(KEM_PUBLIC_KEY, pair.publicKey))).toBe(s.kemKey);
    expect(toHex(kemKeyHash(pair.publicKey))).toBe(s.kemKeyHash);
    return [s.seat, pair];
  }),
);

function seatPair(seat: number): KemKeyPair {
  const pair = seats.get(seat);
  if (pair === undefined) throw new Error(`no seat ${seat}`);
  return pair;
}

/** The vectors' filler: SHA-256(label ‖ u32(i)) for i = 0, 1, … cut to `n` bytes. */
function filler(label: string, n: number): Uint8Array {
  const out = new Uint8Array(Math.ceil(n / 32) * 32);
  const prefix = Uint8Array.from(label, (c) => c.charCodeAt(0));
  for (let i = 0; i * 32 < n; i++) {
    const input = new Uint8Array(prefix.length + 4);
    input.set(prefix);
    new DataView(input.buffer).setUint32(prefix.length, i);
    out.set(sha256(input), i * 32);
  }
  return out.subarray(0, n);
}

function envelopeOf(d: Vectors["deliveries"][number]): DeliveryEnvelope {
  const c = INTAKE.cases.find((x) => x.id === d.envelope.intakeCase);
  if (c === undefined) throw new Error(`no intake case ${d.envelope.intakeCase}`);
  return {
    stub: hex(d.envelope.stub),
    transcript: filler(d.envelope.transcript.label, d.envelope.transcript.length),
    record: hex(c.record),
    ciphertext: hex(c.ciphertext),
  };
}

/** What the client kept of each delivery's request, by its intake case. */
const sentBy = new Map(
  V.deliveries.map((d): [string, DeliveryKey] => [
    d.envelope.intakeCase,
    { key: hex(d.sealing.key), requestHash: hex(d.requestHash) },
  ]),
);

function sentTo(intakeCase: string): DeliveryKey {
  const sent = sentBy.get(intakeCase) ?? sentBy.get(intakeCase.replace(/-(small|large)$/, ""));
  if (sent === undefined) throw new Error(`no request ${intakeCase}`);
  return sent;
}

function answerOf(outcome: Outcome, body: string): DeliveryAnswer {
  if (outcome === "receipt") return { outcome, receipt: hex(body) };
  if (outcome === "refused") return { outcome, code: ascii(hex(body)) };
  return { outcome };
}

describe("sealed delivery: constants", () => {
  test("record types, tags, buckets and lengths are the spec's", () => {
    expect(RECORD_TYPES.sealedDelivery).toBe(V.recordTypes.request);
    expect(RECORD_TYPES.sealedAnswer).toBe(V.recordTypes.answer);
    expect(MAX_DELIVERY).toBe(V.maxDelivery);
    expect(PAD_BUCKETS).toEqual(V.padBuckets);
    expect(MAX_SEALED_REQUEST).toBe(V.maxRequest);
    expect(SEALED_ANSWER_LENGTH).toBe(V.answerLength);
    expect(ANSWER_PLAINTEXT).toBe(V.answerPlaintext);
    const registered = new Map<string, (typeof TAG_REGISTRY)[number]>(
      TAG_REGISTRY.map((e) => [e.tag, e]),
    );
    for (const tag of [V.tags.requestKem, V.tags.requestAad, V.tags.answerKey, V.tags.answerAad])
      expect(registered.get(tag)).toMatchObject({ primitive: "kdf-aead", status: "specified" });
    for (const tag of [V.tags.request, V.tags.kemKey])
      expect(registered.get(tag)).toMatchObject({ primitive: "plain", status: "specified" });
  });

  test("an envelope pads to the smallest bucket at or above it, at every bucket's edge", () => {
    for (const p of V.padding) expect(paddedDeliveryLength(p.envelopeLength)).toBe(p.paddedLength);
    expect(() => paddedDeliveryLength(15)).toThrow(RangeError);
    expect(() => paddedDeliveryLength(MAX_DELIVERY + 1)).toThrow(RangeError);
  });
});

describe("sealed delivery: vectors", () => {
  for (const d of V.deliveries)
    test(`${d.id}: the request and its answers re-made byte for byte, and opened`, () => {
      const pair = seatPair(d.seat);
      const envelope = envelopeOf(d);
      const padded = padDeliveryEnvelope(envelope);
      expect(encode(DELIVERY_ENVELOPE, envelope).length).toBe(d.envelope.length);
      expect(padded.length).toBe(d.envelope.paddedLength);

      const { request, sent } = sealDeliveryWith(pair.publicKey, envelope, {
        mu: hex(d.sealing.mu),
        e: BigInt(d.sealing.e),
      });
      expect(toHex(request)).toBe(d.record);
      expect(toHex(sent.key)).toBe(d.sealing.key);
      expect(toHex(sent.requestHash)).toBe(d.requestHash);
      expect(toHex(sealedDeliveryHash(request))).toBe(d.requestHash);
      expect(toHex(encodeSealedDelivery(decodeSealedDelivery(request, 1)))).toBe(d.record);

      const opened = openSealedDelivery([deliveryHolder(pair.secretKey)], request);
      if (!opened.ok) throw new Error(`request refused: ${opened.code}`);
      expect(opened.envelope).toEqual(envelope);
      expect(toHex(opened.opened.key)).toBe(d.sealing.key);
      expect(toHex(opened.opened.requestHash)).toBe(d.requestHash);

      for (const a of d.answers) {
        const answer = answerOf(a.outcome, a.body);
        const sealed = sealAnswerWith(opened.opened, answer, hex(a.sealing.answerNonce));
        expect(toHex(sealed)).toBe(a.record);
        expect(toHex(encodeSealedAnswer(decodeSealedAnswer(sealed, 1)))).toBe(a.record);
        expect(openSealedAnswer(sent, sealed)).toEqual({ ok: true, answer });
      }
    });

  test("a version-2 share receipt rides in an answer", () => {
    const r = V.versionTwoReceipt;
    const sent = sentTo(r.request);
    const answer = answerOf("receipt", r.body);
    expect(hex(r.body).length).toBe(165);
    expect(toHex(sealAnswerWith(sent, answer, hex(r.sealing.answerNonce)))).toBe(r.record);
    expect(openSealedAnswer(sent, hex(r.record))).toEqual({ ok: true, answer });
  });

  for (const c of V.rejectedRequests)
    test(`request refused (${c.code}): ${c.description}`, () => {
      const result = openSealedDelivery(
        [deliveryHolder(seatPair(c.openedBy).secretKey)],
        hex(c.record),
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe(c.code);
      // Only a request that opened carries what seals its refusal.
      expect("opened" in result).toBe(c.code === "sealed-envelope");
    });

  for (const c of V.acceptedAnswers)
    test(`answer accepted: ${c.description}`, () => {
      const sent = sentTo(c.request);
      const answer = answerOf(c.outcome, c.body);
      expect(toHex(sealAnswerWith(sent, answer, hex(c.sealing.answerNonce)))).toBe(c.record);
      expect(openSealedAnswer(sent, hex(c.record))).toEqual({ ok: true, answer });
    });

  for (const c of V.rejectedAnswers)
    test(`answer refused (${c.code}): ${c.description}`, () => {
      expect(openSealedAnswer(sentTo(c.request), hex(c.record))).toEqual({
        ok: false,
        code: c.code,
      });
    });
});

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run seals and opens with ML-KEM; JavaScript's is slow.
const kemRuns = Math.max(10, Math.ceil(numRuns / 20));

describe("sealed delivery: the production entry points", () => {
  const first = V.deliveries[0];
  if (first === undefined) throw new Error("no delivery vectors");
  const envelope = envelopeOf(first);
  const seat = seatPair(first.seat);
  const holder = deliveryHolder(seat.secretKey);

  function opened(request: Uint8Array): DeliveryKey {
    const result = openSealedDelivery([holder], request);
    if (!result.ok) throw new Error(`request refused: ${result.code}`);
    return result.opened;
  }

  test("each answer opens only for the request it answers, under a fresh nonce", () => {
    const one = sealDelivery(seat.publicKey, envelope);
    const two = sealDelivery(seat.publicKey, envelope);
    const answer: DeliveryAnswer = { outcome: "busy" };
    const a = sealAnswer(opened(one.request), answer);
    expect(openSealedAnswer(one.sent, a)).toEqual({ ok: true, answer });
    expect(openSealedAnswer(two.sent, a)).toEqual({ ok: false, code: "answer-decrypt" });
    // A replayed request answered again gets its own key.
    const again = sealAnswer(opened(one.request), answer);
    expect(toHex(again)).not.toBe(toHex(a));
    expect(openSealedAnswer(one.sent, again)).toEqual({ ok: true, answer });
  });

  test("every attempt is fresh: two requests share only the key hash and the length", () => {
    const one = sealDelivery(seat.publicKey, envelope).request;
    const two = sealDelivery(seat.publicKey, envelope).request;
    expect(one.length).toBe(two.length);
    expect(toHex(one.subarray(0, 35))).toBe(toHex(two.subarray(0, 35)));
    expect(toHex(one.subarray(35))).not.toBe(toHex(two.subarray(35)));
  });

  test("a node holding several elections' secrets opens each request under its own only", () => {
    const other = deliveryHolder(kemKeygen().secretKey);
    const { request } = sealDelivery(seat.publicKey, envelope);
    expect(openSealedDelivery([other, holder], request).ok).toBe(true);
    expect(openSealedDelivery([other], request)).toEqual({ ok: false, code: "sealed-key" });
  });

  test("a request never opens as an answer, nor an answer as a request", () => {
    const { request, sent } = sealDelivery(seat.publicKey, envelope);
    const answer = sealAnswer(opened(request), { outcome: "busy" });
    expect(openSealedDelivery([holder], answer)).toEqual({ ok: false, code: "sealed-malformed" });
    expect(openSealedAnswer(sent, request)).toEqual({ ok: false, code: "answer-malformed" });
  });

  test("refuses to seal what has no encoding, or with randomness out of range", () => {
    const k = opened(sealDelivery(seat.publicKey, envelope).request);
    const mu = new Uint8Array(32);
    expect(() => sealDeliveryWith(seat.publicKey, envelope, { mu, e: 0n })).toThrow(RangeError);
    expect(() => sealDeliveryWith(seat.publicKey, envelope, { mu: mu.subarray(1), e: 1n })).toThrow(
      RangeError,
    );
    const tooLong = { ...envelope, record: new Uint8Array(2 ** 20 + 1) };
    expect(() => sealDelivery(seat.publicKey, tooLong)).toThrow();
    for (const code of ["", "Intake", "intake-", "-intake", "intake--closed", "a".repeat(65)])
      expect(() => sealAnswer(k, { outcome: "refused", code })).toThrow(RangeError);
    for (const receipt of [new Uint8Array(0), new Uint8Array(MAX_ANSWER_BODY + 1)])
      expect(() => sealAnswer(k, { outcome: "receipt", receipt })).toThrow(RangeError);
    expect(() => sealAnswerWith(k, { outcome: "busy" }, new Uint8Array(31))).toThrow(RangeError);
  });

  test("every answer round-trips, and every one is the same length", () => {
    const { request, sent } = sealDelivery(seat.publicKey, envelope);
    const k = opened(request);
    const code = fc
      .array(fc.stringMatching(/^[a-z0-9]{1,8}$/), { minLength: 1, maxLength: 7 })
      .map((parts) => parts.join("-"))
      .filter((c) => c.length <= 64);
    const answer = fc.oneof(
      fc
        .uint8Array({ minLength: 1, maxLength: MAX_ANSWER_BODY })
        .map((receipt): DeliveryAnswer => ({ outcome: "receipt", receipt })),
      code.map((c): DeliveryAnswer => ({ outcome: "refused", code: c })),
      fc.constant<DeliveryAnswer>({ outcome: "busy" }),
    );
    fc.assert(
      fc.property(answer, (a) => {
        const sealed = sealAnswer(k, a);
        expect(sealed.length).toBe(SEALED_ANSWER_LENGTH);
        expect(openSealedAnswer(sent, sealed)).toEqual({ ok: true, answer: a });
      }),
      { numRuns },
    );
  });

  test("any envelope round-trips through its padded form", () => {
    const field = fc.uint8Array({ maxLength: 4096 });
    fc.assert(
      fc.property(field, field, field, field, (stub, transcript, record, ciphertext) => {
        const e = { stub, transcript, record, ciphertext };
        const { request } = sealDelivery(seat.publicKey, e);
        const result = openSealedDelivery([holder], request);
        expect(result.ok && result.envelope).toEqual(e);
        expect(request.length).toBe(1159 + (PAD_BUCKETS[0] as number) + 16);
      }),
      { numRuns: kemRuns },
    );
  });

  test("any flipped bit of a request or an answer is refused", () => {
    const { request, sent } = sealDelivery(seat.publicKey, envelope);
    const answer = sealAnswer(opened(request), { outcome: "busy" });
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 0, max: 7 }), (at, bit) => {
        const r = Uint8Array.from(request);
        const i = at % r.length;
        r[i] = (r[i] as number) ^ (1 << bit);
        expect(openSealedDelivery([holder], r).ok).toBe(false);
        const p = Uint8Array.from(answer);
        const j = at % p.length;
        p[j] = (p[j] as number) ^ (1 << bit);
        expect(openSealedAnswer(sent, p).ok).toBe(false);
      }),
      { numRuns: kemRuns },
    );
  });
});
