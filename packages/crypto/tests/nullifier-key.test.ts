import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { encode } from "../src/codec.ts";
import {
  BJJ_ORDER,
  bjjPoint,
  checkNullifierAnswer,
  combineAnswers,
  encodeNullifierAnswer,
  evaluate,
  type NullifierAnswer,
} from "../src/keyed-nullifier.ts";
import { dealingMessageWith, type RegistrationSecrets } from "../src/nullifier-key.ts";
import {
  approveNullifierKey,
  approvingSeats,
  checkDealtShare,
  checkNullifierKeyTranscript,
  complaintsMessage,
  dealingMessage,
  dealtShareHash,
  DecodeError,
  decodeDealtShare,
  decodeNullifierKeyTranscript,
  decodeNullifierKeyTranscriptV2,
  encodeDealtShare,
  encodeNullifierKeyTranscript,
  encodeNullifierKeyTranscriptV2,
  identityKey,
  KEM_PUBLIC_KEY,
  MAX_KEY_WINDOW,
  type NullifierKeyCheck,
  nullifierKeyContext,
  nullifierKeyCounts,
  nullifierKeyId,
  type NullifierKeyParams,
  nullifierKeyQuorum,
  type NullifierKeyScope,
  PARAMETERS,
  type NullifierKeyTranscript,
  type Panel,
  type ReceivedShare,
  registrationKeygen,
  registrationKeysMessage,
  responsesMessage,
  seatShareOf,
  TAG_REGISTRY,
} from "../src/index.ts";
import { RECORD_TYPES } from "../src/record.ts";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/nullifier-key.json comes from an independent Python
// implementation (scripts/nullifier-key-vectors.py), so these expected values
// never come from the code under test.

interface SeatVector {
  readonly index: number;
  readonly kemSeed: string;
  readonly kemX: string;
  readonly signingSecret: string;
  readonly f: readonly string[];
  readonly g: readonly string[];
  readonly shareRandomness: readonly {
    readonly recipient: number;
    readonly mu: string;
    readonly e: string;
  }[];
  readonly dealtShares: readonly {
    readonly recipient: number;
    readonly bytes: string;
    readonly hash: string;
  }[];
}

interface Result {
  readonly ok: boolean;
  readonly code?: string;
  readonly keyId?: string;
  readonly deadline?: string;
  readonly seats?: readonly { readonly index: number; readonly reasons: readonly string[] }[];
  readonly dealers?: readonly number[];
  readonly qualified?: readonly {
    readonly index: number;
    readonly kemKey: string;
    readonly signingKey: string;
    readonly commitment: string;
  }[];
}

interface TranscriptVector {
  readonly id: string;
  readonly panel: string;
  readonly transcript: string;
  readonly result: Result;
  readonly shares?: readonly {
    readonly index: number;
    readonly sk: string;
    readonly s: string;
  }[];
  readonly runId?: string;
  readonly deadline?: string;
  readonly context?: string;
  readonly seats?: readonly SeatVector[];
}

interface ApprovalsVector {
  readonly panel: string;
  readonly keyId: string;
  readonly approvals: readonly {
    readonly index: number;
    readonly message: string;
    readonly signature: string;
  }[];
  readonly notCounted: readonly { readonly index: number; readonly signature: string }[];
}

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly recordTypes: { readonly transcript: number; readonly dealtShare: number };
  readonly scope: { readonly l2ChainId: string; readonly groupRegistry: string };
  readonly panels: Readonly<
    Record<
      string,
      {
        readonly threshold: number;
        readonly identitySecrets: readonly string[];
        readonly keys: readonly string[];
      }
    >
  >;
  readonly transcripts: readonly TranscriptVector[];
  readonly dealtShareChecks: readonly {
    readonly id: string;
    readonly run: string;
    readonly recipient: number;
    readonly bytes: string;
    readonly result: string;
    readonly dealer?: number;
    readonly share?: string;
    readonly blind?: string;
  }[];
  readonly approvals: ApprovalsVector;
  readonly decode: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly error: string;
  }[];
  readonly version2: {
    readonly transcripts: readonly TranscriptVector[];
    readonly approvals: ApprovalsVector;
    readonly decode: readonly {
      readonly id: string;
      readonly pinned: 1 | 2;
      readonly transcript: string;
      readonly error: string;
    }[];
  };
}

const V = JSON.parse(readFileSync(new URL("nullifier-key.json", SPEC_VECTORS), "utf8")) as Vectors;

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const panelOf = (name: string): Panel => {
  const p = V.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return { threshold: p.threshold, keys: p.keys.map(hex) };
};

const scopeOf = (panel: Panel): NullifierKeyScope => ({
  l2ChainId: BigInt(V.scope.l2ChainId),
  groupRegistry: hex(V.scope.groupRegistry),
  panel,
});

const vectorOf = (id: string): TranscriptVector => {
  const t = V.transcripts.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no transcript ${id}`);
  return t;
};

// The check's result in the vector file's shape.
function asVector(r: NullifierKeyCheck): Result {
  if (!r.ok)
    return r.seats === undefined
      ? { ok: false, code: r.code }
      : { ok: false, code: r.code, seats: r.seats };
  return {
    ok: true,
    keyId: toHex(r.keyId),
    ...(r.deadline === null ? {} : { deadline: String(r.deadline) }),
    seats: r.seats,
    dealers: r.dealers,
    qualified: r.qualified.map((q) => ({
      index: q.index,
      kemKey: toHex(encode(KEM_PUBLIC_KEY, q.kemKey)),
      signingKey: toHex(q.signingKey),
      commitment: toHex(encode(bjjPoint, q.commitment)),
    })),
  };
}

function seatsOf(t: TranscriptVector): RegistrationSecrets[] {
  const p = V.panels[t.panel];
  if (p === undefined || t.seats === undefined) throw new Error("bad vector");
  return t.seats.map((s) => ({
    index: s.index,
    identitySecret: hex(p.identitySecrets[s.index - 1] as string),
    kem: kemKeyPairWith(hex(s.kemSeed), BigInt(s.kemX)),
    signingSecret: hex(s.signingSecret),
  }));
}

const paramsOf = (t: TranscriptVector): NullifierKeyParams => ({
  ...scopeOf(panelOf(t.panel)),
  runId: hex(t.runId ?? ""),
  deadline: t.deadline === undefined ? null : BigInt(t.deadline),
});

const polynomialsOf = (s: SeatVector) => ({ f: s.f.map(BigInt), g: s.g.map(BigInt) });

describe("nullifier-key.json", () => {
  test("is the format this reader knows, with the registered tags and record types", () => {
    expect(V.format).toBe("abolish-nullifier-key-vectors/1");
    const registered = new Set<string>(TAG_REGISTRY.map((e) => e.tag));
    for (const tag of Object.keys(V.tags)) expect(registered.has(tag)).toBe(true);
    expect(V.recordTypes).toEqual({
      transcript: RECORD_TYPES.nullifierKeyTranscript,
      dealtShare: RECORD_TYPES.nullifierKeyShare,
    });
  }, 60_000);

  test.each(V.transcripts.map((t) => [t.id, t] as const))(
    "%s checks as the vector says",
    (_, t) => {
      const r = checkNullifierKeyTranscript(scopeOf(panelOf(t.panel)), hex(t.transcript), 1);
      expect(asVector(r)).toEqual(t.result);
      if (r.ok) {
        expect(r.keyId).toEqual(nullifierKeyId(hex(t.transcript)));
        // The answer check's key: only qualified seats, the transcript's threshold.
        expect(r.key.threshold).toBe(panelOf(t.panel).threshold);
        for (const [i, k] of r.key.signingKeys.entries()) {
          const q = r.qualified.find((x) => x.index === i + 1);
          expect(k).toEqual(q === undefined ? null : q.signingKey);
          expect(r.key.commitments[i] ?? null).toEqual(q === undefined ? null : q.commitment);
        }
      }
    },
    60_000,
  );

  const reproducible = V.transcripts.filter(
    (t) => t.seats !== undefined && t.id !== "complaint-answered",
  );

  test.each(reproducible.map((t) => [t.id, t] as const))(
    "%s is reproduced byte for byte from its seats' secrets",
    (_, t) => {
      const params = paramsOf(t);
      expect(toHex(nullifierKeyContext(params))).toBe(t.context);
      const seats = seatsOf(t);
      const vs = t.seats as readonly SeatVector[];
      const keys = seats.map((s) => registrationKeysMessage(params, s));
      // A seat that dealt sealed a share to every other seat; no-dealing's seat 3 sealed none.
      const dealers = seats.filter((_, i) => (vs[i] as SeatVector).dealtShares.length > 0);
      const dealings = dealers.map((s) => {
        const v = vs.find((x) => x.index === s.index) as SeatVector;
        const d = dealingMessageWith(
          params,
          s,
          keys,
          polynomialsOf(v),
          v.shareRandomness.map((x) => ({ mu: hex(x.mu), e: BigInt(x.e) })),
        );
        expect(d.shares.map((x) => ({ recipient: x.recipient, bytes: toHex(x.bytes) }))).toEqual(
          v.dealtShares.map((x) => ({ recipient: x.recipient, bytes: x.bytes })),
        );
        expect(d.message.share_hashes.map(toHex)).toEqual(v.dealtShares.map((x) => x.hash));
        return d.message;
      });
      const bytes = encodeNullifierKeyTranscript({
        run_id: params.runId,
        keys,
        dealings,
        complaints: [],
        responses: [],
      });
      expect(toHex(bytes)).toBe(t.transcript);
    },
    120_000,
  );

  test("complaint-answered: the complaints and the dealer's reveals are reproduced", () => {
    const t = vectorOf("complaint-answered");
    const params = paramsOf(t);
    const seats = seatsOf(t);
    const vs = t.seats as readonly SeatVector[];
    const tr = decodeNullifierKeyTranscript(hex(t.transcript), 1);
    const rounds = { keys: tr.keys, dealings: tr.dealings };
    const complaints = seats.flatMap((s, i) => {
      const dealers = (vs as SeatVector[])
        .filter((d) => d.index !== s.index)
        .flatMap((d) => {
          const shared = d.dealtShares.find((x) => x.recipient === s.index);
          const r = checkDealtShare(
            params,
            { index: s.index, secretKey: s.kem.secretKey },
            rounds,
            hex(shared?.bytes ?? ""),
          );
          return !r.ok && (r.code === "share-decrypt" || r.code === "share-verify")
            ? [d.index]
            : [];
        });
      expect(i).toBeGreaterThanOrEqual(0);
      return dealers.length === 0 ? [] : [complaintsMessage(params, s, rounds, dealers)];
    });
    expect(complaints.map((m) => m.index)).toEqual([3, 4]);
    const responses = [
      responsesMessage(
        params,
        seats[1] as RegistrationSecrets,
        { ...rounds, complaints },
        polynomialsOf(vs[1] as SeatVector),
      ),
    ];
    const bytes = encodeNullifierKeyTranscript({ ...tr, complaints, responses });
    expect(toHex(bytes)).toBe(t.transcript);
  }, 60_000);

  test.each(V.transcripts.filter((t) => t.seats !== undefined).map((t) => [t.id, t] as const))(
    "%s: each qualified seat's share is the vector's and opens its commitment",
    (_, t) => {
      const params = paramsOf(t);
      const tr = decodeNullifierKeyTranscript(hex(t.transcript), 1);
      const r = checkNullifierKeyTranscript(params, hex(t.transcript), 1);
      if (!r.ok) throw new Error("expected a valid transcript");
      const seats = seatsOf(t);
      const vs = t.seats as readonly SeatVector[];
      const got = r.qualified.map((q) => {
        const seat = seats.find((s) => s.index === q.index) as RegistrationSecrets;
        const received: ReceivedShare[] = [];
        for (const d of vs) {
          const shared = d.dealtShares.find((x) => x.recipient === q.index);
          if (d.index === q.index || shared === undefined) continue;
          const c = checkDealtShare(
            params,
            { index: q.index, secretKey: seat.kem.secretKey },
            tr,
            hex(shared.bytes),
          );
          if (c.ok) received.push({ dealer: c.dealer, share: c.share, blind: c.blind });
        }
        const share = seatShareOf(
          r,
          tr,
          q.index,
          polynomialsOf(vs.find((s) => s.index === q.index) as SeatVector),
          received,
        );
        return { index: q.index, sk: String(share.sk), s: String(share.s) };
      });
      expect(got).toEqual(t.shares);
    },
    60_000,
  );

  test.each(V.dealtShareChecks.map((c) => [c.id, c] as const))(
    "dealt share %s checks as the vector says",
    (_, c) => {
      const t = vectorOf(c.run);
      const params = paramsOf(t);
      const tr = decodeNullifierKeyTranscript(hex(t.transcript), 1);
      const seat = seatsOf(t).find((s) => s.index === c.recipient) as RegistrationSecrets;
      const r = checkDealtShare(
        params,
        { index: c.recipient, secretKey: seat.kem.secretKey },
        tr,
        hex(c.bytes),
      );
      if (c.result === "ok") {
        expect(r).toEqual({
          ok: true,
          dealer: c.dealer,
          share: BigInt(c.share ?? ""),
          blind: BigInt(c.blind ?? ""),
        });
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.code).toBe(c.result);
          expect(r.dealer).toBe(c.dealer);
        }
      }
    },
    60_000,
  );

  test("version 1's approvals, under a retired statement, never count", () => {
    const a = V.approvals;
    const scope = scopeOf(panelOf(a.panel));
    const all = [...a.approvals, ...a.notCounted].map((x) => ({
      index: x.index,
      signature: hex(x.signature),
    }));
    // Under the current statement, with any deadline: the bytes signed differ.
    for (const deadline of [0n, 25_000_000n])
      expect(approvingSeats(scope, hex(a.keyId), deadline, all)).toEqual([]);
    expect(nullifierKeyQuorum(scope)).toBe(4);
  }, 60_000);

  test.each(V.decode.map((d) => [d.id, d] as const))(
    "%s is rejected when decoded",
    (_, d) => {
      expect(() => decodeNullifierKeyTranscript(hex(d.transcript), 1)).toThrow(
        expect.objectContaining({ name: DecodeError.name, code: d.error }),
      );
      const r = checkNullifierKeyTranscript(scopeOf(panelOf("panel-2")), hex(d.transcript), 1);
      expect(r).toEqual({ ok: false, code: d.error });
    },
    60_000,
  );

  test("every transcript re-encodes to itself", () => {
    for (const t of V.transcripts)
      expect(
        toHex(encodeNullifierKeyTranscript(decodeNullifierKeyTranscript(hex(t.transcript), 1))),
      ).toBe(t.transcript);
  }, 60_000);
});

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// A whole run seals and opens n² shares with ML-KEM; JavaScript's is slow.
const keyRuns = Math.max(10, Math.ceil(numRuns / 50));

// A fresh honest run on a test panel, through the production entry points.
function honestRun(threshold: number, n: number, runId: Uint8Array) {
  const identitySecrets = Array.from({ length: n }, (_, i) => {
    const d = new Uint8Array(32);
    d[31] = i + 1;
    d[0] = 0x24;
    return d;
  });
  const panel: Panel = { threshold, keys: identitySecrets.map(identityKey) };
  const scope: NullifierKeyScope = {
    l2ChainId: 84532n,
    groupRegistry: new Uint8Array(20).fill(7),
    panel,
  };
  const params: NullifierKeyParams = { ...scope, runId, deadline: null };
  const seats = identitySecrets.map((d, i) => registrationKeygen(i + 1, d));
  const keys = seats.map((s) => registrationKeysMessage(params, s));
  const dealings = seats.map((s) => dealingMessage(params, s, keys));
  const transcript: NullifierKeyTranscript = {
    run_id: runId,
    keys,
    dealings: dealings.map((d) => d.message),
    complaints: [],
    responses: [],
  };
  const bytes = encodeNullifierKeyTranscript(transcript);
  return { scope, params, seats, keys, dealings, transcript, bytes };
}

function sharesOf(run: ReturnType<typeof honestRun>, check: NullifierKeyCheck) {
  if (!check.ok) throw new Error("expected a valid transcript");
  return run.seats.map((seat, i) => {
    const received: ReceivedShare[] = [];
    for (const d of run.dealings) {
      const shared = d.shares.find((x) => x.recipient === seat.index);
      if (shared === undefined) continue;
      const c = checkDealtShare(
        run.params,
        { index: seat.index, secretKey: seat.kem.secretKey },
        run.transcript,
        shared.bytes,
      );
      expect(c.ok).toBe(true);
      if (c.ok) received.push({ dealer: c.dealer, share: c.share, blind: c.blind });
    }
    return seatShareOf(
      check,
      run.transcript,
      seat.index,
      (run.dealings[i] as (typeof run.dealings)[number]).polynomials,
      received,
    );
  });
}

describe("an honest run", () => {
  test("qualifies every seat, and any k answers combine to sk · B", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 2 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.bigInt({ min: 1n, max: BJJ_ORDER - 1n }),
        (n, slack, runId, m) => {
          const threshold = Math.max(2, n - slack);
          const run = honestRun(threshold, n, runId);
          const check = checkNullifierKeyTranscript(run.scope, run.bytes, 1);
          expect(check.ok).toBe(true);
          if (!check.ok) return;
          expect(check.seats.every((s) => s.reasons.length === 0)).toBe(true);
          const shares = sharesOf(run, check);
          // sk = Σ_d f_d(0), which no seat holds, only the test.
          const sk =
            run.dealings.reduce((acc, d) => acc + (d.polynomials.f[0] as bigint), 0n) % BJJ_ORDER;
          const b = check.qualified[0]?.commitment.multiply(m);
          if (b === undefined) throw new Error("no seat");
          const q = { queryHash: new Uint8Array(32).fill(3), b };
          const answers = shares.map((share, i) => {
            const a = evaluate(
              check.key,
              q,
              share,
              (run.seats[i] as RegistrationSecrets).signingSecret,
            );
            expect(checkNullifierAnswer(check.key, q, encodeNullifierAnswer(a)).ok).toBe(true);
            return a;
          });
          const z = combineAnswers(check.key, answers.slice(0, threshold) as NullifierAnswer[]);
          expect(z.equals(b.multiply(sk))).toBe(true);
          const last = combineAnswers(check.key, answers.slice(-threshold) as NullifierAnswer[]);
          expect(last.equals(z)).toBe(true);
        },
      ),
      { numRuns: keyRuns },
    );
  }, 300_000);

  const run = honestRun(2, 3, new Uint8Array(32).fill(9));

  test("fails whole once any byte changes", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: run.bytes.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const b = Uint8Array.from(run.bytes);
          b[at] = (b[at] as number) ^ x;
          // Every byte is a header, a count, a seat or inside a signed message
          // or its signature: no change leaves a valid transcript.
          expect(checkNullifierKeyTranscript(run.scope, b, 1).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  }, 300_000);

  test("checks only for the chain, registry and panel it was made for", () => {
    const other = (patch: Partial<NullifierKeyScope>) =>
      checkNullifierKeyTranscript({ ...run.scope, ...patch }, run.bytes, 1);
    expect(other({ l2ChainId: 8453n })).toEqual({ ok: false, code: "key-signature" });
    expect(other({ groupRegistry: new Uint8Array(20).fill(8) })).toEqual({
      ok: false,
      code: "key-signature",
    });
    expect(other({ panel: { ...run.scope.panel, threshold: 3 } }).ok).toBe(false);
  }, 60_000);

  test("a dealt share opens only for its recipient, and any changed byte fails its hash", () => {
    const d = run.dealings[0] as (typeof run.dealings)[number];
    const shared = d.shares[0] as { recipient: number; bytes: Uint8Array };
    const seat = run.seats[shared.recipient - 1] as RegistrationSecrets;
    const other = run.seats[2] as RegistrationSecrets;
    expect(dealtShareHash(shared.bytes)).toEqual(d.message.share_hashes[0]);
    expect(
      checkDealtShare(
        run.params,
        { index: other.index, secretKey: other.kem.secretKey },
        run.transcript,
        shared.bytes,
      ),
    ).toEqual({ ok: false, code: "share-context" });
    fc.assert(
      fc.property(
        fc.nat({ max: shared.bytes.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const b = Uint8Array.from(shared.bytes);
          b[at] = (b[at] as number) ^ x;
          const r = checkDealtShare(
            run.params,
            { index: seat.index, secretKey: seat.kem.secretKey },
            run.transcript,
            b,
          );
          // Never grounds for a complaint: only a message matching the signed hash is.
          expect(r.ok).toBe(false);
          if (!r.ok) expect(["share-malformed", "share-context", "share-hash"]).toContain(r.code);
        },
      ),
      { numRuns: Math.max(10, Math.ceil(numRuns / 10)) },
    );
  }, 120_000);

  test("random bytes decode only if they re-encode to themselves", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (tail) => {
        const b = new Uint8Array([0x00, 0x11, 0x01, ...tail]);
        try {
          const t = decodeNullifierKeyTranscript(b, 1);
          expect(encodeNullifierKeyTranscript(t)).toEqual(b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns },
    );
  }, 60_000);

  test("a dealt share decodes only if it re-encodes to itself", () => {
    const d = run.dealings[0] as (typeof run.dealings)[number];
    const good = (d.shares[0] as { bytes: Uint8Array }).bytes;
    expect(encodeDealtShare(decodeDealtShare(good, 1))).toEqual(good);
    fc.assert(
      fc.property(
        fc.nat({ max: good.length - 1 }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        (at, patch) => {
          const b = Uint8Array.from(good);
          b.set(patch.subarray(0, b.length - at), at);
          try {
            expect(encodeDealtShare(decodeDealtShare(b, 1))).toEqual(b);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
          }
        },
      ),
      { numRuns },
    );
  }, 60_000);
});

describe("a seat's node", () => {
  const run = honestRun(2, 3, new Uint8Array(32).fill(5));
  const seat = run.seats[0] as RegistrationSecrets;

  test("signs only for its own seat", () => {
    const other = run.seats[1] as RegistrationSecrets;
    expect(() =>
      registrationKeysMessage(run.params, { ...seat, identitySecret: other.identitySecret }),
    ).toThrow(/seat/);
    expect(() => registrationKeysMessage(run.params, { ...seat, index: 4 })).toThrow(/seat/);
  }, 60_000);

  test("refuses to sign over a round 1 that fails the check", () => {
    const forged = run.keys.map((m, i) =>
      i === 1 ? { ...m, signature: (run.keys[2] as typeof m).signature } : m,
    );
    expect(() => dealingMessage(run.params, seat, forged)).toThrow(/key-signature/);
    expect(() => dealingMessage(run.params, seat, [...run.keys].reverse())).toThrow(/key-order/);
  }, 60_000);

  test("checks and complains only with the keys its round-1 message carries", () => {
    const rounds = { keys: run.keys, dealings: run.transcript.dealings };
    // As after a restart that regenerated the keys: every honest share would
    // fail to open, and the complaints would publish this seat's shares.
    const regenerated = registrationKeygen(seat.index, seat.identitySecret);
    const shared = (run.dealings[1] as (typeof run.dealings)[number]).shares.find(
      (x) => x.recipient === seat.index,
    ) as { bytes: Uint8Array };
    expect(() =>
      checkDealtShare(
        run.params,
        { index: seat.index, secretKey: regenerated.kem.secretKey },
        rounds,
        shared.bytes,
      ),
    ).toThrow(/round-1 message doesn't carry its keys/);
    expect(() => complaintsMessage(run.params, regenerated, rounds, [2])).toThrow(
      /round-1 message doesn't carry its keys/,
    );
    expect(() => dealingMessage(run.params, regenerated, run.keys)).toThrow(
      /round-1 message doesn't carry its keys/,
    );
    expect(
      checkDealtShare(
        run.params,
        { index: seat.index, secretKey: seat.kem.secretKey },
        rounds,
        shared.bytes,
      ).ok,
    ).toBe(true);
  }, 60_000);

  test("complains only about other dealers of round 2", () => {
    const rounds = { keys: run.keys, dealings: run.transcript.dealings };
    expect(() => complaintsMessage(run.params, seat, rounds, [])).toThrow(/complaints/);
    expect(() => complaintsMessage(run.params, seat, rounds, [1])).toThrow(/complaints/);
    expect(() => complaintsMessage(run.params, seat, rounds, [3, 2])).toThrow(/complaints/);
    expect(complaintsMessage(run.params, seat, rounds, [2, 3]).complaints).toEqual([2, 3]);
  }, 60_000);

  test("reveals only from the polynomials behind its dealing, and only when complained about", () => {
    const rounds = { keys: run.keys, dealings: run.transcript.dealings };
    const complaint = complaintsMessage(
      run.params,
      run.seats[1] as RegistrationSecrets,
      rounds,
      [1],
    );
    const own = (run.dealings[0] as (typeof run.dealings)[number]).polynomials;
    const other = (run.dealings[1] as (typeof run.dealings)[number]).polynomials;
    expect(() =>
      responsesMessage(run.params, seat, { ...rounds, complaints: [complaint] }, other),
    ).toThrow(/polynomials/);
    expect(() => responsesMessage(run.params, seat, { ...rounds, complaints: [] }, own)).toThrow(
      /complaint/,
    );
    const response = responsesMessage(
      run.params,
      seat,
      { ...rounds, complaints: [complaint] },
      own,
    );
    const bytes = encodeNullifierKeyTranscript({
      ...run.transcript,
      complaints: [complaint],
      responses: [response],
    });
    // A complaint answered correctly keeps the dealer, and seat 2 takes the reveal.
    const check = checkNullifierKeyTranscript(run.scope, bytes, 1);
    expect(check.ok && check.seats.every((s) => s.reasons.length === 0)).toBe(true);
  }, 60_000);

  test("refuses polynomials of the wrong degree or outside F_l", () => {
    const k = run.scope.panel.threshold;
    const randomness = [1, 2].map(() => ({ mu: new Uint8Array(32), e: 1n }));
    expect(() =>
      dealingMessageWith(run.params, seat, run.keys, { f: [1n], g: [1n] }, randomness),
    ).toThrow(/coefficients/);
    expect(() =>
      dealingMessageWith(
        run.params,
        seat,
        run.keys,
        { f: Array(k).fill(BJJ_ORDER), g: Array(k).fill(1n) },
        randomness,
      ),
    ).toThrow(/coefficients/);
  }, 60_000);

  test("a share that doesn't open the seat's commitment is refused", () => {
    const check = checkNullifierKeyTranscript(run.scope, run.bytes, 1);
    if (!check.ok) throw new Error("expected a valid transcript");
    const own = (run.dealings[0] as (typeof run.dealings)[number]).polynomials;
    expect(() => seatShareOf(check, run.transcript, 1, own, [])).toThrow(/qualified dealer 2/);
    const wrong = [2, 3].map((dealer) => ({ dealer, share: 1n, blind: 1n }));
    expect(() => seatShareOf(check, run.transcript, 1, own, wrong)).toThrow(/doesn't open/);
  }, 60_000);
});

test("the package entry point exports no way to choose the randomness", async () => {
  const api = (await import("../src/index.ts")) as Record<string, unknown>;
  expect(api["dealingMessageWith"]).toBeUndefined();
});

describe("nullifier-key.json, version 2", () => {
  const V2 = V.version2;
  const honest = V2.transcripts.find((t) => t.id === "honest-5") as TranscriptVector;
  const scope = scopeOf(panelOf("panel-5"));
  const deadline = BigInt(honest.deadline ?? "");

  test.each(V2.transcripts.map((t) => [t.id, t] as const))(
    "%s checks as the vector says",
    (_, t) => {
      const r = checkNullifierKeyTranscript(scopeOf(panelOf(t.panel)), hex(t.transcript), 2);
      expect(asVector(r)).toEqual(t.result);
      if (r.ok) {
        expect(r.version).toBe(2);
        expect(r.deadline).toBe(deadline);
        expect(r.keyId).toEqual(nullifierKeyId(hex(t.transcript)));
      }
      // The version-1 check refuses every version-2 transcript before reading it.
      expect(checkNullifierKeyTranscript(scope, hex(t.transcript), 1)).toEqual({
        ok: false,
        code: "profile-mismatch",
      });
    },
    60_000,
  );

  test("honest-5 is reproduced byte for byte from its seats' secrets and deadline", () => {
    const params = paramsOf(honest);
    expect(params.deadline).toBe(deadline);
    expect(toHex(nullifierKeyContext(params))).toBe(honest.context);
    // Version 1's context of the same run is another value under another tag.
    expect(toHex(nullifierKeyContext({ ...scope, runId: params.runId, deadline: null }))).not.toBe(
      honest.context,
    );
    const seats = seatsOf(honest);
    const vs = honest.seats as readonly SeatVector[];
    const keys = seats.map((s) => registrationKeysMessage(params, s, deadline - 1n));
    const dealings = seats.map((s, i) => {
      const v = vs[i] as SeatVector;
      const d = dealingMessageWith(
        params,
        s,
        keys,
        polynomialsOf(v),
        v.shareRandomness.map((x) => ({ mu: hex(x.mu), e: BigInt(x.e) })),
      );
      expect(d.shares.map((x) => toHex(x.bytes))).toEqual(v.dealtShares.map((x) => x.bytes));
      return d.message;
    });
    const transcript = {
      run_id: params.runId,
      deadline,
      keys,
      dealings,
      complaints: [],
      responses: [],
    };
    const bytes = encodeNullifierKeyTranscriptV2(transcript);
    expect(toHex(bytes)).toBe(honest.transcript);
    expect(decodeNullifierKeyTranscriptV2(bytes, 2)).toEqual(transcript);
  }, 120_000);

  test("honest-5: each seat's share is the vector's", () => {
    const params = paramsOf(honest);
    const tr = decodeNullifierKeyTranscriptV2(hex(honest.transcript), 2);
    const r = checkNullifierKeyTranscript(scope, hex(honest.transcript), 2);
    if (!r.ok) throw new Error("expected a valid transcript");
    const vs = honest.seats as readonly SeatVector[];
    const got = seatsOf(honest).map((seat, i) => {
      const received: ReceivedShare[] = [];
      for (const d of vs) {
        const shared = d.dealtShares.find((x) => x.recipient === seat.index);
        if (shared === undefined) continue;
        const c = checkDealtShare(
          params,
          { index: seat.index, secretKey: seat.kem.secretKey },
          tr,
          hex(shared.bytes),
        );
        if (!c.ok) throw new Error(`dealt share fails: ${c.code}`);
        received.push({ dealer: c.dealer, share: c.share, blind: c.blind });
      }
      const share = seatShareOf(r, tr, seat.index, polynomialsOf(vs[i] as SeatVector), received);
      return { index: seat.index, sk: String(share.sk), s: String(share.s) };
    });
    expect(got).toEqual(honest.shares);
  }, 60_000);

  test("a key counts on q approvals with its deadline, and never under a retired statement", () => {
    const a = V2.approvals;
    const keyId = hex(a.keyId);
    const secrets = V.panels[a.panel]?.identitySecrets ?? [];
    const r = checkNullifierKeyTranscript(scope, hex(honest.transcript), 2);
    if (!r.ok) throw new Error("expected a valid transcript");
    expect(r.keyId).toEqual(keyId);
    const sig = (x: { index: number; signature: string }) => ({
      index: x.index,
      signature: hex(x.signature),
    });
    // The frozen version-2 approvals are under the retired
    // abolish/v1/sig/nullifier-key-approval-2, which carries no deadline.
    expect(
      approvingSeats(scope, keyId, deadline, [...a.approvals, ...a.notCounted].map(sig)),
    ).toEqual([]);
    expect(nullifierKeyCounts(scope, r, a.approvals.map(sig))).toBe(false);

    const block = deadline - BigInt(PARAMETERS.RECORD_MARGIN);
    const approvals = [1, 2, 3, 4, 5].map((index) => ({
      index,
      signature: approveNullifierKey(scope, hex(secrets[index - 1] ?? ""), index, r, block),
    }));
    expect(approvingSeats(scope, keyId, deadline, approvals)).toEqual([1, 2, 3, 4, 5]);
    // Another deadline, or another key, is another statement.
    expect(approvingSeats(scope, keyId, deadline + 1n, approvals)).toEqual([]);
    expect(approvingSeats(scope, hex(V.approvals.keyId), deadline, approvals)).toEqual([]);
    // One seat's signature, many times, is one approval; one under another
    // seat's index is none.
    const one = approvals[0] as { index: number; signature: Uint8Array };
    expect(approvingSeats(scope, keyId, deadline, [one, one, one])).toEqual([1]);
    expect(approvingSeats(scope, keyId, deadline, [{ ...one, index: 2 }])).toEqual([]);

    expect(nullifierKeyCounts(scope, r, approvals.slice(0, 4))).toBe(true);
    expect(nullifierKeyCounts(scope, r, approvals.slice(0, 3))).toBe(false);
    expect(nullifierKeyCounts(scope, r, [one, one, one, one])).toBe(false);
    // A version-1 key never counts, whatever approves it.
    const r1 = checkNullifierKeyTranscript(scope, hex(vectorOf("honest-5").transcript), 1);
    if (!r1.ok) throw new Error("expected a valid transcript");
    expect(r1.version).toBe(1);
    expect(r1.deadline).toBeNull();
    expect(nullifierKeyCounts(scope, r1, approvals)).toBe(false);
  }, 60_000);

  test("a seat approves only a version-2 key whose deadline is in the window with RECORD_MARGIN left", () => {
    const r = checkNullifierKeyTranscript(scope, hex(honest.transcript), 2);
    const r1 = checkNullifierKeyTranscript(scope, hex(vectorOf("honest-5").transcript), 1);
    if (!r.ok || !r1.ok) throw new Error("expected valid transcripts");
    const secret = hex(V.panels["panel-5"]?.identitySecrets[0] ?? "");
    const approve = (key: typeof r, block: bigint) =>
      approveNullifierKey(scope, secret, 1, key, block);
    const margin = BigInt(PARAMETERS.RECORD_MARGIN);
    expect(() => approve(r1, 0n)).toThrow(/version-2/);
    expect(() => approve(r, deadline)).toThrow(/passed/);
    expect(() => approve(r, deadline + 1n)).toThrow(/passed/);
    expect(() => approve(r, deadline - 1n)).toThrow(/too close/);
    expect(() => approve(r, deadline - margin + 1n)).toThrow(/too close/);
    expect(approve(r, deadline - margin)).toHaveLength(64);
    expect(() => approve(r, deadline - MAX_KEY_WINDOW - 1n)).toThrow(/too far/);
    expect(approve(r, deadline - MAX_KEY_WINDOW)).toHaveLength(64);
    expect(() => approveNullifierKey(scope, secret, 2, r, deadline - margin)).toThrow(/seat/);
  }, 60_000);

  test("a seat takes part only in a run whose deadline is ahead and in the window", () => {
    const params = paramsOf(honest);
    const seat = seatsOf(honest)[0] as RegistrationSecrets;
    expect(() => registrationKeysMessage(params, seat)).toThrow(TypeError);
    expect(() => registrationKeysMessage(params, seat, deadline)).toThrow(/passed/);
    expect(() => registrationKeysMessage(params, seat, deadline - MAX_KEY_WINDOW - 1n)).toThrow(
      /too far/,
    );
    expect(registrationKeysMessage(params, seat, deadline - MAX_KEY_WINDOW).index).toBe(1);
  }, 60_000);

  test.each(V2.decode.map((d) => [d.id, d] as const))(
    "%s is rejected when decoded",
    (_, d) => {
      const decode = () =>
        d.pinned === 2
          ? decodeNullifierKeyTranscriptV2(hex(d.transcript), 2)
          : decodeNullifierKeyTranscript(hex(d.transcript), 1);
      expect(decode).toThrow(expect.objectContaining({ name: DecodeError.name, code: d.error }));
      expect(checkNullifierKeyTranscript(scope, hex(d.transcript), d.pinned)).toEqual({
        ok: false,
        code: d.error,
      });
    },
    60_000,
  );

  test("approving and counting take only a check's own result", () => {
    const r = checkNullifierKeyTranscript(scope, hex(honest.transcript), 2);
    const r1 = checkNullifierKeyTranscript(scope, hex(vectorOf("honest-5").transcript), 1);
    if (!r.ok || !r1.ok) throw new Error("expected valid transcripts");
    const secret = hex(V.panels["panel-5"]?.identitySecrets[0] ?? "");
    const approvals = V2.approvals.approvals.map((x) => ({
      index: x.index,
      signature: hex(x.signature),
    }));
    // A copy, and a version-1 result relabelled version 2 with this deadline.
    for (const forged of [{ ...r }, { ...r1, version: 2 as const, deadline }]) {
      expect(() =>
        approveNullifierKey(scope, secret, 1, forged, deadline - BigInt(PARAMETERS.RECORD_MARGIN)),
      ).toThrow(/checkNullifierKeyTranscript/);
      expect(() => nullifierKeyCounts(scope, forged, approvals)).toThrow(
        /checkNullifierKeyTranscript/,
      );
    }
    expect(Object.isFrozen(r) && Object.isFrozen(r.qualified)).toBe(true);
  }, 60_000);

  test("a dealt share of a version-2 run isn't taken in version 1's run of the same run_id", () => {
    const params = paramsOf(honest);
    const tr = decodeNullifierKeyTranscriptV2(hex(honest.transcript), 2);
    const seat = seatsOf(honest)[1] as RegistrationSecrets;
    const shared = ((honest.seats as readonly SeatVector[])[0] as SeatVector).dealtShares.find(
      (x) => x.recipient === 2,
    );
    if (shared === undefined) throw new Error("no share");
    const secret = { index: 2, secretKey: seat.kem.secretKey };
    expect(checkDealtShare(params, secret, tr, hex(shared.bytes)).ok).toBe(true);
    // Under the version-1 context the rounds it was dealt in don't check, so
    // the node refuses before it reads the share.
    expect(() =>
      checkDealtShare({ ...params, deadline: null }, secret, tr, hex(shared.bytes)),
    ).toThrow(/key-signature/);
  }, 60_000);

  test("a scope carrying a deadline doesn't change a version-1 check", () => {
    const t = vectorOf("honest-2");
    const withDeadline = { ...scopeOf(panelOf("panel-2")), deadline };
    expect(checkNullifierKeyTranscript(withDeadline, hex(t.transcript), 1).ok).toBe(true);
  }, 60_000);

  test("any other deadline fails the whole transcript", () => {
    const t = decodeNullifierKeyTranscriptV2(hex(honest.transcript), 2);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), (other) => {
        fc.pre(other !== deadline);
        const b = encodeNullifierKeyTranscriptV2({ ...t, deadline: other });
        expect(checkNullifierKeyTranscript(scope, b, 2)).toEqual({
          ok: false,
          code: "key-signature",
        });
      }),
      { numRuns: Math.max(10, Math.ceil(numRuns / 10)) },
    );
  }, 300_000);

  test("random bytes decode only if they re-encode to themselves", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (tail) => {
        const b = new Uint8Array([0x00, 0x11, 0x02, ...tail]);
        try {
          expect(encodeNullifierKeyTranscriptV2(decodeNullifierKeyTranscriptV2(b, 2))).toEqual(b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns },
    );
  }, 60_000);
});
