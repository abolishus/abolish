import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  decodeNullifierAnswer,
  decodeNullifierQuery,
  decodeNullifierReply,
  decodeNullifierRequest,
  encodeNullifierAnswer,
  encodeNullifierQuery,
  encodeNullifierReply,
  encodeNullifierRequest,
  KEM_PUBLIC_KEY,
  kemKeygen,
  MAX_REQUEST_SEALED,
  nullifierRequestHash,
  openNullifierReply,
  openNullifierRequest,
  type RequestHolder,
  sealNullifierReply,
  sealNullifierRequest,
  TAG_REGISTRY,
} from "../src/index.ts";
import { encode } from "../src/codec.ts";
import { sealNullifierReplyWith, sealNullifierRequestWith } from "../src/nullifier-transport.ts";
import { RECORD_TYPES } from "../src/record.ts";
import { type KemKeyPair, kemKeyPairWith } from "../src/share-encryption.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/nullifier-transport.json comes from an independent Python
// implementation of docs/spec/nullifier-transport.md (scripts/nullifier-
// transport-vectors.py, over share-encryption-vectors.py's ML-KEM-768,
// ChaCha20-Poly1305 and ristretto255), sealing nullifier-query.json's queries
// and answers, so these values never come from the code under test.

interface Pair {
  readonly kemKey: string;
  readonly seed: string;
  readonly x: string;
}

interface Sealing {
  readonly mu: string;
  readonly e: string;
}

interface Vectors {
  readonly tags: Readonly<
    Record<"requestKem" | "requestAad" | "replyKem" | "replyAad" | "request", string>
  >;
  readonly recordTypes: { readonly request: number; readonly reply: number };
  readonly maxRequestSealed: number;
  readonly key: {
    readonly keyId: string;
    readonly seats: readonly (Pair & { readonly index: number })[];
  };
  readonly queries: readonly {
    readonly id: string;
    readonly query: string;
    readonly client: Pair;
    readonly requests: readonly {
      readonly seat: number;
      readonly sealing: Sealing;
      readonly record: string;
      readonly requestHash: string;
      readonly reply: {
        readonly sealing: Sealing;
        readonly answer: string;
        readonly record: string;
      };
    }[];
  }[];
  readonly rejectedRequests: readonly {
    readonly description: string;
    readonly code: string;
    readonly seat: number;
    readonly openedBy: number;
    readonly record: string;
  }[];
  readonly rejectedReplies: readonly {
    readonly description: string;
    readonly code: string;
    readonly seat: number;
    readonly requestHash: string;
    readonly openedBy: string;
    readonly record: string;
  }[];
}

const V = JSON.parse(
  readFileSync(new URL("nullifier-transport.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const keyId = hex(V.key.keyId);

function pairOf(p: Pair): KemKeyPair {
  const pair = kemKeyPairWith(hex(p.seed), BigInt(p.x));
  expect(toHex(encode(KEM_PUBLIC_KEY, pair.publicKey))).toBe(p.kemKey);
  return pair;
}

const seats = new Map(V.key.seats.map((s) => [s.index, pairOf(s)]));
const clients = new Map(V.queries.map((q) => [q.id, pairOf(q.client)]));

function seatPair(index: number): KemKeyPair {
  const pair = seats.get(index);
  if (pair === undefined) throw new Error(`no seat ${index}`);
  return pair;
}

function holder(seat: number, secretOf = seat): RequestHolder {
  return { keyId, seat, secretKey: seatPair(secretOf).secretKey };
}

const randomness = (s: Sealing) => ({ mu: hex(s.mu), e: BigInt(s.e) });

describe("nullifier transport: constants", () => {
  test("record types, tags and the sealed bound are the spec's", () => {
    expect(RECORD_TYPES.nullifierRequest).toBe(V.recordTypes.request);
    expect(RECORD_TYPES.nullifierReply).toBe(V.recordTypes.reply);
    expect(MAX_REQUEST_SEALED).toBe(V.maxRequestSealed);
    const registered = new Map<string, (typeof TAG_REGISTRY)[number]>(
      TAG_REGISTRY.map((e) => [e.tag, e]),
    );
    for (const tag of [V.tags.requestKem, V.tags.requestAad, V.tags.replyKem, V.tags.replyAad])
      expect(registered.get(tag)).toMatchObject({ primitive: "kdf-aead", status: "specified" });
    expect(registered.get(V.tags.request)).toMatchObject({
      primitive: "plain",
      status: "specified",
    });
  });
});

describe("nullifier transport: vectors", () => {
  for (const q of V.queries)
    for (const r of q.requests) {
      test(`${q.id}, seat ${r.seat}: the request and its reply re-made byte for byte, and opened`, () => {
        const client = clients.get(q.id);
        if (client === undefined) throw new Error("no client");
        const query = decodeNullifierQuery(hex(q.query), 1);
        const request = sealNullifierRequestWith(
          { index: r.seat, kemKey: seatPair(r.seat).publicKey },
          client.publicKey,
          query,
          randomness(r.sealing),
        );
        expect(toHex(request)).toBe(r.record);
        expect(toHex(nullifierRequestHash(request))).toBe(r.requestHash);
        expect(toHex(encodeNullifierRequest(decodeNullifierRequest(request, 1)))).toBe(r.record);

        const opened = openNullifierRequest([holder(r.seat)], request);
        if (!opened.ok) throw new Error(`request refused: ${opened.code}`);
        expect(toHex(encodeNullifierQuery(opened.query))).toBe(q.query);
        expect(toHex(opened.requestHash)).toBe(r.requestHash);
        expect(toHex(encode(KEM_PUBLIC_KEY, opened.replyKey))).toBe(q.client.kemKey);

        const answer = decodeNullifierAnswer(hex(r.reply.answer), 1);
        const reply = sealNullifierReplyWith(opened, answer, randomness(r.reply.sealing));
        expect(toHex(reply)).toBe(r.reply.record);
        expect(toHex(encodeNullifierReply(decodeNullifierReply(reply, 1)))).toBe(r.reply.record);

        const back = openNullifierReply(
          { requestHash: opened.requestHash, seat: r.seat, secretKey: client.secretKey },
          reply,
        );
        if (!back.ok) throw new Error(`reply refused: ${back.code}`);
        expect(toHex(encodeNullifierAnswer(back.answer))).toBe(r.reply.answer);
      });
    }

  for (const c of V.rejectedRequests)
    test(`request refused (${c.code}): ${c.description}`, () => {
      expect(openNullifierRequest([holder(c.seat, c.openedBy)], hex(c.record))).toEqual({
        ok: false,
        code: c.code,
      });
    });

  for (const c of V.rejectedReplies)
    test(`reply refused (${c.code}): ${c.description}`, () => {
      const client = clients.get(c.openedBy);
      if (client === undefined) throw new Error("no client");
      const sent = { requestHash: hex(c.requestHash), seat: c.seat, secretKey: client.secretKey };
      expect(openNullifierReply(sent, hex(c.record))).toEqual({ ok: false, code: c.code });
    });
});

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// Each run seals and opens with ML-KEM twice; JavaScript's is slow.
const kemRuns = Math.max(10, Math.ceil(numRuns / 20));

describe("nullifier transport: the production entry points", () => {
  const first = V.queries[0];
  if (first === undefined) throw new Error("no query vectors");
  const query = decodeNullifierQuery(hex(first.query), 1);
  const firstRequest = first.requests[0];
  if (firstRequest === undefined) throw new Error("no request vectors");
  const answer = decodeNullifierAnswer(hex(firstRequest.reply.answer), 1);
  const seat = { index: 1, kemKey: seatPair(1).publicKey };

  test("a fresh client key carries the answer back, and only to that key", () => {
    const client = kemKeygen();
    const request = sealNullifierRequest(seat, client.publicKey, query);
    const opened = openNullifierRequest([holder(1)], request);
    if (!opened.ok) throw new Error(`request refused: ${opened.code}`);
    const reply = sealNullifierReply(opened, answer);
    const sent = { requestHash: nullifierRequestHash(request), seat: 1 };
    expect(openNullifierReply({ ...sent, secretKey: client.secretKey }, reply)).toEqual({
      ok: true,
      answer,
    });
    expect(openNullifierReply({ ...sent, secretKey: kemKeygen().secretKey }, reply)).toEqual({
      ok: false,
      code: "reply-decrypt",
    });
  });

  test("sealing draws fresh randomness: two requests for one query differ", () => {
    const client = kemKeygen();
    expect(toHex(sealNullifierRequest(seat, client.publicKey, query))).not.toBe(
      toHex(sealNullifierRequest(seat, client.publicKey, query)),
    );
  });

  test("a seat holding two keys opens each request under its own key only", () => {
    const client = kemKeygen();
    const other = { keyId: new Uint8Array(32).fill(9), seat: 1, secretKey: kemKeygen().secretKey };
    const request = sealNullifierRequest(seat, client.publicKey, query);
    expect(openNullifierRequest([other, holder(1)], request).ok).toBe(true);
    expect(openNullifierRequest([other], request)).toEqual({ ok: false, code: "request-key" });
  });

  test("a request never opens as a reply, nor a reply as a request", () => {
    const client = kemKeygen();
    const request = sealNullifierRequest(seat, client.publicKey, query);
    const opened = openNullifierRequest([holder(1)], request);
    if (!opened.ok) throw new Error(`request refused: ${opened.code}`);
    const reply = sealNullifierReply(opened, answer);
    expect(openNullifierRequest([holder(1)], reply)).toEqual({
      ok: false,
      code: "request-malformed",
    });
    const sent = { requestHash: opened.requestHash, seat: 1, secretKey: client.secretKey };
    expect(openNullifierReply(sent, request)).toEqual({ ok: false, code: "reply-malformed" });
  });

  test("refuses to seal another seat's answer, or with randomness out of range", () => {
    const client = kemKeygen();
    const request = sealNullifierRequest(seat, client.publicKey, query);
    const opened = openNullifierRequest([holder(1)], request);
    if (!opened.ok) throw new Error(`request refused: ${opened.code}`);
    expect(() => sealNullifierReply({ ...opened, seat: 2 }, answer)).toThrow(RangeError);
    const mu = new Uint8Array(32);
    expect(() => sealNullifierReplyWith(opened, answer, { mu, e: 0n })).toThrow(RangeError);
    expect(() =>
      sealNullifierRequestWith(seat, client.publicKey, query, { mu: mu.subarray(1), e: 1n }),
    ).toThrow(RangeError);
  });

  test("any flipped bit of a request or a reply is refused", () => {
    const client = kemKeygen();
    const request = sealNullifierRequest(seat, client.publicKey, query);
    const opened = openNullifierRequest([holder(1)], request);
    if (!opened.ok) throw new Error(`request refused: ${opened.code}`);
    const reply = sealNullifierReply(opened, answer);
    const sent = { requestHash: opened.requestHash, seat: 1, secretKey: client.secretKey };
    fc.assert(
      fc.property(fc.nat(), fc.integer({ min: 0, max: 7 }), (at, bit) => {
        const r = Uint8Array.from(request);
        const i = at % r.length;
        r[i] = (r[i] as number) ^ (1 << bit);
        expect(openNullifierRequest([holder(1)], r).ok).toBe(false);
        const p = Uint8Array.from(reply);
        const j = at % p.length;
        p[j] = (p[j] as number) ^ (1 << bit);
        expect(openNullifierReply(sent, p).ok).toBe(false);
      }),
      { numRuns: kemRuns },
    );
  });
});
