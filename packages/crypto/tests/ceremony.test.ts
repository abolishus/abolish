import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  challengesMessageWith,
  type CeremonyParams,
  keysMessageWith,
  type SeatSecrets,
} from "../src/ceremony.ts";
import {
  answersMessage,
  type CeremonyCheck,
  ceremonyContext,
  ceremonyKeygen,
  ceremonyTranscriptHash,
  challengesMessage,
  checkCeremonyTranscript,
  DecodeError,
  decodeCeremonyTranscript,
  encodeCeremonyTranscript,
  identityKey,
  KEM_PUBLIC_KEY,
  keysMessage,
  type Panel,
  revealsMessage,
} from "../src/index.ts";
import { encode } from "../src/codec.ts";
import { checkedKeySetBinding } from "../src/ceremony.ts";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/ceremony.json comes from an independent Python
// implementation (scripts/ceremony-vectors.py), so these expected values never
// come from the code under test.

interface SeatVector {
  readonly index: number;
  readonly kemSeed: string;
  readonly kemX: string;
  readonly signingSecret: string;
  readonly pokNonce: string;
  readonly challengeSecrets: readonly string[];
}

interface Result {
  readonly ok: boolean;
  readonly code?: string;
  readonly hash?: string;
  readonly seats?: readonly { readonly index: number; readonly reasons: readonly string[] }[];
  readonly registered?: readonly {
    readonly index: number;
    readonly kemKey: string;
    readonly signingKey: string;
  }[];
}

interface CeremonyVectors {
  readonly format: string;
  readonly election: {
    readonly l2ChainId: string;
    readonly trusteeRegistry: string;
    readonly electionId: string;
    readonly stubHash: string;
  };
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
  readonly transcripts: readonly {
    readonly id: string;
    readonly panel: string;
    readonly transcript: string;
    readonly result: Result;
    readonly context?: string;
    readonly runId?: string;
    readonly seats?: readonly SeatVector[];
  }[];
  readonly decode: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly error: string;
  }[];
}

const V = JSON.parse(
  readFileSync(new URL("ceremony.json", SPEC_VECTORS), "utf8"),
) as CeremonyVectors;

const panelOf = (name: string): Panel => {
  const p = V.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return { threshold: p.threshold, keys: p.keys.map(hex) };
};

const election = (panel: Panel): Omit<CeremonyParams, "runId"> => ({
  l2ChainId: BigInt(V.election.l2ChainId),
  trusteeRegistry: hex(V.election.trusteeRegistry),
  electionId: hex(V.election.electionId),
  stubHash: hex(V.election.stubHash),
  panel,
});

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// The check's result in the vector file's shape.
function asVector(r: CeremonyCheck): Result {
  if (!r.ok)
    return r.seats === undefined
      ? { ok: false, code: r.code }
      : { ok: false, code: r.code, seats: r.seats };
  return {
    ok: true,
    hash: toHex(r.hash),
    seats: r.seats,
    registered: r.registered.map((k) => ({
      index: k.index,
      kemKey: toHex(encode(KEM_PUBLIC_KEY, k.kemKey)),
      signingKey: toHex(k.signingKey),
    })),
  };
}

describe("ceremony.json", () => {
  test("is the format this reader knows", () => {
    expect(V.format).toBe("abolish-ceremony-vectors/1");
  });

  test.each(V.transcripts.map((t) => [t.id, t] as const))(
    "%s checks as the vector says",
    (_, t) => {
      const r = checkCeremonyTranscript(election(panelOf(t.panel)), hex(t.transcript), 1);
      // Only a set this check returned is accepted where keys are used to send secrets.
      if (r.ok)
        expect(checkedKeySetBinding(r.registered)).toEqual({
          transcriptHash: r.hash,
          stubHash: hex(V.election.stubHash),
        });
      expect(asVector(r)).toEqual(t.result);
    },
  );

  const honest = V.transcripts.filter((t) => t.seats !== undefined);

  test.each(honest.map((t) => [t.id, t] as const))(
    "%s is reproduced byte for byte from its seats' secrets",
    (_, t) => {
      const p = V.panels[t.panel];
      if (p === undefined || t.seats === undefined || t.runId === undefined)
        throw new Error("bad vector");
      const params: CeremonyParams = { ...election(panelOf(t.panel)), runId: hex(t.runId) };
      expect(toHex(ceremonyContext(params))).toBe(t.context);
      const seats: SeatSecrets[] = t.seats.map((s) => ({
        index: s.index,
        identitySecret: hex(p.identitySecrets[s.index - 1] as string),
        kem: kemKeyPairWith(hex(s.kemSeed), BigInt(s.kemX)),
        signingSecret: hex(s.signingSecret),
      }));
      const keys = seats.map((s, i) =>
        keysMessageWith(params, s, BigInt((t.seats as SeatVector[])[i]?.pokNonce ?? "")),
      );
      const challenges = seats.map((s, i) =>
        challengesMessageWith(
          params,
          s,
          keys,
          ((t.seats as SeatVector[])[i]?.challengeSecrets ?? []).map(hex),
        ),
      );
      const round2 = challenges.map((c) => c.message);
      const answers = seats.map((s) => answersMessage(params, s, keys, round2));
      const reveals = seats.map((s, i) =>
        revealsMessage(
          params,
          s,
          { keys, challenges: round2, answers },
          (challenges[i] as { secrets: readonly Uint8Array[] }).secrets,
        ),
      );
      const bytes = encodeCeremonyTranscript({
        run_id: params.runId,
        keys,
        challenges: round2,
        answers,
        reveals,
      });
      expect(toHex(bytes)).toBe(t.transcript);
    },
    // Every node checks the rounds before signing: at 16 seats, thousands of signatures.
    120_000,
  );

  test.each(V.decode.map((d) => [d.id, d] as const))("%s is rejected when decoded", (_, d) => {
    expect(() => decodeCeremonyTranscript(hex(d.transcript), 1)).toThrow(
      expect.objectContaining({ name: DecodeError.name, code: d.error }),
    );
    const r = checkCeremonyTranscript(election(panelOf("panel-2")), hex(d.transcript), 1);
    expect(r).toEqual({ ok: false, code: d.error });
  });

  test("every decoded vector re-encodes to itself", () => {
    for (const t of V.transcripts) {
      const bytes = hex(t.transcript);
      expect(toHex(encodeCeremonyTranscript(decodeCeremonyTranscript(bytes, 1)))).toBe(
        t.transcript,
      );
    }
  });
});

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// A whole ceremony runs ML-KEM n² times; JavaScript's is slow.
const ceremonyRuns = Math.max(10, Math.ceil(numRuns / 50));

// A fresh honest ceremony on a test panel, through the production entry points.
function ceremony(threshold: number, n: number, runId: Uint8Array) {
  const identitySecrets = Array.from({ length: n }, (_, i) => {
    const d = new Uint8Array(32);
    d[31] = i + 1;
    d[0] = 0x42;
    return d;
  });
  const panel: Panel = { threshold, keys: identitySecrets.map(identityKey) };
  const params: CeremonyParams = {
    l2ChainId: 84532n,
    trusteeRegistry: new Uint8Array(20).fill(7),
    electionId: new Uint8Array(32).fill(1),
    stubHash: new Uint8Array(32).fill(2),
    panel,
    runId,
  };
  const seats = identitySecrets.map((d, i) => ceremonyKeygen(i + 1, d));
  const keys = seats.map((s) => keysMessage(params, s));
  const challenges = seats.map((s) => challengesMessage(params, s, keys));
  const round2 = challenges.map((c) => c.message);
  const answers = seats.map((s) => answersMessage(params, s, keys, round2));
  const reveals = seats.map((s, i) =>
    revealsMessage(
      params,
      s,
      { keys, challenges: round2, answers },
      (challenges[i] as { secrets: readonly Uint8Array[] }).secrets,
    ),
  );
  const bytes = encodeCeremonyTranscript({
    run_id: runId,
    keys,
    challenges: round2,
    answers,
    reveals,
  });
  const { runId: _, ...electionParams } = params;
  const secrets = challenges.map((x) => x.secrets);
  return { params, electionParams, seats, keys, round2, answers, secrets, bytes };
}

describe("an honest ceremony", () => {
  test("qualifies every seat and registers the keys each sent", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 2 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        (n, slack, runId) => {
          const threshold = Math.max(2, n - slack);
          const c = ceremony(threshold, n, runId);
          const r = checkCeremonyTranscript(c.electionParams, c.bytes, 1);
          expect(r.ok).toBe(true);
          if (!r.ok) return;
          expect(r.seats.every((s) => s.reasons.length === 0)).toBe(true);
          expect(r.registered.map((k) => k.index)).toEqual(c.seats.map((s) => s.index));
          for (const [i, k] of r.registered.entries()) {
            const seat = c.seats[i] as SeatSecrets;
            expect(encode(KEM_PUBLIC_KEY, k.kemKey)).toEqual(
              encode(KEM_PUBLIC_KEY, seat.kem.publicKey),
            );
            expect(k.signingKey).toEqual(identityKey(seat.signingSecret));
          }
          expect(r.hash).toEqual(ceremonyTranscriptHash(c.bytes));
        },
      ),
      { numRuns: ceremonyRuns },
    );
  }, 300_000);

  const c = ceremony(2, 3, new Uint8Array(32).fill(9));

  test("fails whole once any byte changes", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: c.bytes.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const b = Uint8Array.from(c.bytes);
          b[at] = (b[at] as number) ^ x;
          // Every byte is a header, a count, a seat or inside a signed message
          // or its signature: no change leaves a valid transcript.
          expect(checkCeremonyTranscript(c.electionParams, b, 1).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  }, 300_000);

  test("checks only for the election, panel and registry it was made for", () => {
    const other = (patch: Partial<Omit<CeremonyParams, "runId">>) =>
      checkCeremonyTranscript({ ...c.electionParams, ...patch }, c.bytes, 1);
    expect(other({ l2ChainId: 8453n })).toEqual({ ok: false, code: "ceremony-signature" });
    expect(other({ trusteeRegistry: new Uint8Array(20).fill(8) })).toEqual({
      ok: false,
      code: "ceremony-signature",
    });
    expect(other({ electionId: new Uint8Array(32).fill(3) })).toEqual({
      ok: false,
      code: "ceremony-signature",
    });
    expect(other({ stubHash: new Uint8Array(32).fill(3) })).toEqual({
      ok: false,
      code: "ceremony-signature",
    });
    // Same keys, another threshold: another panel identifier.
    expect(other({ panel: { ...c.params.panel, threshold: 3 } })).toEqual({
      ok: false,
      code: "ceremony-signature",
    });
  });

  test("random bytes decode only if they re-encode to themselves", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), (tail) => {
        const b = new Uint8Array([0x00, 0x05, 0x01, ...tail]);
        try {
          const t = decodeCeremonyTranscript(b, 1);
          expect(encodeCeremonyTranscript(t)).toEqual(b);
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns },
    );
  });
});

describe("a seat's node", () => {
  const c = ceremony(2, 3, new Uint8Array(32).fill(5));
  const seat = c.seats[0] as SeatSecrets;

  test("signs only for its own seat", () => {
    const other = c.seats[1] as SeatSecrets;
    expect(() => keysMessage(c.params, { ...seat, identitySecret: other.identitySecret })).toThrow(
      /seat/,
    );
    expect(() => keysMessage(c.params, { ...seat, index: 4 })).toThrow(/seat/);
  });

  test("refuses to sign over a round 1 that fails the check", () => {
    const forged = c.keys.map((m, i) =>
      i === 1 ? { ...m, signature: (c.keys[2] as typeof m).signature } : m,
    );
    expect(() => challengesMessage(c.params, seat, forged)).toThrow(/ceremony-signature/);
    expect(() => challengesMessage(c.params, seat, [...c.keys].reverse())).toThrow(
      /ceremony-order/,
    );
  });

  test("answers only for the KEM key it registered", () => {
    const fresh = ceremonyKeygen(1, seat.identitySecret);
    expect(() => answersMessage(c.params, fresh, c.keys, c.round2)).toThrow(/KEM key/);
  });

  test("reveals one μ per other seat, and only after sending challenges", () => {
    const rounds = { keys: c.keys, challenges: c.round2, answers: c.answers };
    expect(() => revealsMessage(c.params, seat, rounds, [new Uint8Array(32)])).toThrow(/μ/);
    expect(revealsMessage(c.params, seat, rounds, c.secrets[0] ?? []).index).toBe(1);
    expect(() =>
      revealsMessage(c.params, seat, { ...rounds, challenges: c.round2.slice(1) }, []),
    ).toThrow();
  });

  test("reveals only the μs behind the challenges the transcript holds for it", () => {
    // As after a restart: secrets of a round 2 that isn't the one in the transcript.
    const rounds = { keys: c.keys, challenges: c.round2, answers: c.answers };
    const stale = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    expect(() => revealsMessage(c.params, seat, rounds, stale)).toThrow(/doesn't match/);
    // Another seat's μs, in another seat's slots, don't match either.
    expect(() => revealsMessage(c.params, seat, rounds, c.secrets[1] ?? [])).toThrow(
      /doesn't match/,
    );
  });

  test("refuses a proof nonce outside 1 to ℓ − 1", () => {
    expect(() => keysMessageWith(c.params, seat, 0n)).toThrow(/w/);
  });
});

test("the package entry point exports no way to choose the randomness", async () => {
  const api = (await import("../src/index.ts")) as Record<string, unknown>;
  expect(api["keysMessageWith"]).toBeUndefined();
  expect(api["challengesMessageWith"]).toBeUndefined();
});
