import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { encode } from "../src/codec.ts";
import {
  BJJ_ORDER,
  bjjLagrangeAtZero,
  bjjPoint,
  checkNullifierAnswer,
  combineAnswers,
  encodeNullifierAnswer,
  evaluate,
  type NullifierAnswer,
  type NullifierKey,
  type SeatShare,
} from "../src/keyed-nullifier.ts";
import { opening } from "../src/nullifier-key.ts";
import { reshareDealingWith } from "../src/nullifier-reshare.ts";
import {
  approveNullifierReshare,
  consentNullifierReshare,
  checkDealtShare,
  MAX_RESHARE_WINDOW,
  checkNullifierKeyTranscript,
  checkNullifierReshareTranscript,
  checkResharedShare,
  DecodeError,
  decodeNullifierKeyTranscript,
  decodeNullifierReshareTranscript,
  decodeResharedShare,
  dealingMessage,
  encodeNullifierKeyTranscript,
  encodeNullifierReshareTranscript,
  encodeResharedShare,
  identityKey,
  KEM_PUBLIC_KEY,
  PARAMETERS,
  type NullifierReshareCheck,
  nullifierReshareContext,
  nullifierReshareCounts,
  nullifierReshareDealerQuorum,
  nullifierReshareKeyId,
  type NullifierReshareParams,
  nullifierReshareQuorum,
  type NullifierReshareScope,
  type NullifierReshareTranscript,
  type OldSeat,
  type Panel,
  type ReceivedShare,
  registrationKeygen,
  registrationKeysMessage,
  type RegistrationSecrets,
  reshareApprovingSeats,
  reshareConsentingSeats,
  reshareComplaintsMessage,
  reshareDealing,
  resharedShareHash,
  reshareKeysMessage,
  reshareResponsesMessage,
  reshareSeatShareOf,
  seatShareOf,
  TAG_REGISTRY,
} from "../src/index.ts";
import { RECORD_TYPES } from "../src/record.ts";
import { kemKeyPairWith } from "../src/share-encryption.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/nullifier-reshare.json comes from an independent Python
// implementation (scripts/nullifier-reshare-vectors.py), so these expected
// values never come from the code under test.

interface Result {
  readonly ok: boolean;
  readonly code?: string;
  readonly keyId?: string;
  readonly predecessor?: string;
  readonly deadline?: string;
  readonly dealerResults?: readonly {
    readonly index: number;
    readonly reasons: readonly string[];
  }[];
  readonly dealers?: readonly number[];
  readonly seats?: readonly { readonly index: number; readonly reasons: readonly string[] }[];
  readonly qualified?: readonly {
    readonly index: number;
    readonly kemKey: string;
    readonly signingKey: string;
    readonly commitment: string;
  }[];
}

interface DealerVector {
  readonly index: number;
  readonly f: readonly string[];
  readonly g: readonly string[];
  readonly shareRandomness: readonly {
    readonly recipient: number;
    readonly mu: string;
    readonly e: string;
  }[];
  readonly resharedShares: readonly {
    readonly recipient: number;
    readonly bytes: string;
    readonly hash: string;
  }[];
}

interface SeatVector {
  readonly index: number;
  readonly kemSeed: string;
  readonly kemX: string;
  readonly signingSecret: string;
}

interface ShareVector {
  readonly index: number;
  readonly sk: string;
  readonly s: string;
}

interface TranscriptVector {
  readonly id: string;
  readonly newPanel: string;
  readonly transcript: string;
  readonly result: Result;
  readonly shares?: readonly ShareVector[];
  readonly runId?: string;
  readonly deadline?: string;
  readonly context?: string;
  readonly dealers?: readonly DealerVector[];
  readonly seats?: readonly SeatVector[];
}

interface Vectors {
  readonly format: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly recordTypes: { readonly transcript: number; readonly resharedShare: number };
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
  readonly predecessor: {
    readonly panel: string;
    readonly transcript: string;
    readonly keyId: string;
    readonly sk: string;
    readonly shares: readonly ShareVector[];
  };
  readonly transcripts: readonly TranscriptVector[];
  readonly resharedShareChecks: readonly {
    readonly id: string;
    readonly run: string;
    readonly recipient: number;
    readonly bytes: string;
    readonly result: string;
    readonly dealer?: number;
    readonly share?: string;
    readonly blind?: string;
  }[];
  readonly approvals: {
    readonly newPanel: string;
    readonly keyId: string;
    readonly approvals: readonly {
      readonly index: number;
      readonly message: string;
      readonly signature: string;
    }[];
    readonly notCounted: readonly { readonly index: number; readonly signature: string }[];
  };
  readonly decode: readonly {
    readonly id: string;
    readonly transcript: string;
    readonly error: string;
  }[];
}

const V = JSON.parse(
  readFileSync(new URL("nullifier-reshare.json", SPEC_VECTORS), "utf8"),
) as Vectors;

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const panelOf = (name: string): Panel => {
  const p = V.panels[name];
  if (p === undefined) throw new Error(`no panel ${name}`);
  return { threshold: p.threshold, keys: p.keys.map(hex) };
};

const secretsOf = (name: string) => (V.panels[name]?.identitySecrets ?? []).map(hex);

const oldPanel = panelOf(V.predecessor.panel);

// The predecessor's key, from its own check (nullifier-key.json tests that check).
const predecessorCheck = checkNullifierKeyTranscript(
  {
    l2ChainId: BigInt(V.scope.l2ChainId),
    groupRegistry: hex(V.scope.groupRegistry),
    panel: oldPanel,
  },
  hex(V.predecessor.transcript),
  1,
);
if (!predecessorCheck.ok) throw new Error("the predecessor's transcript must check");
const predecessor = predecessorCheck.key;

const scopeOf = (newPanel: string): NullifierReshareScope => ({
  l2ChainId: BigInt(V.scope.l2ChainId),
  groupRegistry: hex(V.scope.groupRegistry),
  oldPanel,
  predecessor,
  newPanel: panelOf(newPanel),
});

const vectorOf = (id: string) => {
  const t = V.transcripts.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no transcript ${id}`);
  return t;
};

const paramsOf = (t: TranscriptVector): NullifierReshareParams => ({
  ...scopeOf(t.newPanel),
  runId: hex(t.runId ?? ""),
  deadline: BigInt(t.deadline ?? ""),
});

const oldShareOf = (index: number): SeatShare => {
  const s = V.predecessor.shares.find((x) => x.index === index);
  if (s === undefined) throw new Error(`no predecessor share for ${index}`);
  return { seat: index, sk: BigInt(s.sk), s: BigInt(s.s) };
};

const oldSeatOf = (index: number): OldSeat => ({
  index,
  identitySecret: secretsOf(V.predecessor.panel)[index - 1] as Uint8Array,
});

function newSeatsOf(t: TranscriptVector): RegistrationSecrets[] {
  const secrets = secretsOf(t.newPanel);
  return (t.seats ?? []).map((s) => ({
    index: s.index,
    identitySecret: secrets[s.index - 1] as Uint8Array,
    kem: kemKeyPairWith(hex(s.kemSeed), BigInt(s.kemX)),
    signingSecret: hex(s.signingSecret),
  }));
}

const polynomialsOf = (d: DealerVector) => ({ f: d.f.map(BigInt), g: d.g.map(BigInt) });

function asVector(r: NullifierReshareCheck): Result {
  if (!r.ok) {
    const out: { ok: false; code: string; dealerResults?: unknown; seats?: unknown } = {
      ok: false,
      code: r.code,
    };
    if (r.dealerResults !== undefined) out.dealerResults = r.dealerResults;
    if (r.seats !== undefined) out.seats = r.seats;
    return out as Result;
  }
  return {
    ok: true,
    keyId: toHex(r.keyId),
    predecessor: toHex(r.predecessor),
    deadline: String(r.deadline),
    dealerResults: r.dealerResults,
    dealers: r.dealers,
    seats: r.seats,
    qualified: r.qualified.map((q) => ({
      index: q.index,
      kemKey: toHex(encode(KEM_PUBLIC_KEY, q.kemKey)),
      signingKey: toHex(q.signingKey),
      commitment: toHex(encode(bjjPoint, q.commitment)),
    })),
  };
}

const interpolate = (points: readonly { index: number; sk: bigint }[]) => {
  const seats = points.map((p) => p.index);
  return points.reduce((acc, p) => acc + bjjLagrangeAtZero(p.index, seats) * p.sk, 0n) % BJJ_ORDER;
};

function subsets<T>(items: readonly T[], k: number): T[][] {
  if (k === 0) return [[]];
  return items.flatMap((x, i) => subsets(items.slice(i + 1), k - 1).map((rest) => [x, ...rest]));
}

describe("nullifier-reshare.json", () => {
  test("is the format this reader knows, with the registered tags and record types", () => {
    expect(V.format).toBe("abolish-nullifier-reshare-vectors/1");
    const registered = new Set<string>(TAG_REGISTRY.map((e) => e.tag));
    for (const tag of Object.keys(V.tags)) expect(registered.has(tag)).toBe(true);
    expect(V.recordTypes).toEqual({
      transcript: RECORD_TYPES.nullifierReshareTranscript,
      resharedShare: RECORD_TYPES.nullifierReshareShare,
    });
    expect(toHex(predecessor.keyId)).toBe(V.predecessor.keyId);
  }, 60_000);

  test("the predecessor's shares are its seats' and interpolate to its sk", () => {
    const tr = decodeNullifierKeyTranscript(hex(V.predecessor.transcript), 1);
    expect(predecessorCheck.ok && predecessorCheck.qualified.map((q) => q.index)).toEqual([
      1, 2, 3,
    ]);
    const sk = BigInt(V.predecessor.sk);
    for (const pair of subsets(V.predecessor.shares, oldPanel.threshold))
      expect(interpolate(pair.map((s) => ({ index: s.index, sk: BigInt(s.sk) })))).toBe(sk);
    expect(tr.keys.length).toBe(3);
    // Each opens its seat's commitment: the dealers' precondition.
    for (const x of V.predecessor.shares)
      expect(
        opening(BigInt(x.sk), BigInt(x.s)).equals(
          predecessor.commitments[x.index - 1] as NonNullable<NullifierKey["commitments"][number]>,
        ),
      ).toBe(true);
  }, 60_000);

  test.each(V.transcripts.map((t) => [t.id, t] as const))(
    "%s checks as the vector says",
    (_, t) => {
      const r = checkNullifierReshareTranscript(scopeOf(t.newPanel), hex(t.transcript), 1);
      expect(asVector(r)).toEqual(t.result);
      if (r.ok) {
        expect(r.keyId).toEqual(nullifierReshareKeyId(hex(t.transcript)));
        expect(r.key.threshold).toBe(panelOf(t.newPanel).threshold);
        expect(r.key.signingKeys.length).toBe(panelOf(t.newPanel).keys.length);
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
    (t) => t.dealers !== undefined && t.id !== "complaint-answered",
  );

  test.each(reproducible.map((t) => [t.id, t] as const))(
    "%s is reproduced byte for byte from its parties' secrets",
    (_, t) => {
      const params = paramsOf(t);
      expect(toHex(nullifierReshareContext(params))).toBe(t.context);
      const keys = newSeatsOf(t).map((s) => reshareKeysMessage(params, s, params.deadline - 1000n));
      const dealings = (t.dealers ?? []).map((d) => {
        const out = reshareDealingWith(
          params,
          oldSeatOf(d.index),
          oldShareOf(d.index),
          keys,
          polynomialsOf(d),
          d.shareRandomness.map((x) => ({ mu: hex(x.mu), e: BigInt(x.e) })),
          params.deadline - 1000n,
        );
        expect(out.shares.map((x) => ({ recipient: x.recipient, bytes: toHex(x.bytes) }))).toEqual(
          d.resharedShares.map((x) => ({ recipient: x.recipient, bytes: x.bytes })),
        );
        expect(out.message.share_hashes.map(toHex)).toEqual(d.resharedShares.map((x) => x.hash));
        return out.message;
      });
      const bytes = encodeNullifierReshareTranscript({
        run_id: params.runId,
        predecessor: predecessor.keyId,
        deadline: params.deadline,
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
    const tr = decodeNullifierReshareTranscript(hex(t.transcript), 1);
    const rounds = { keys: tr.keys, dealings: tr.dealings };
    const complaints = newSeatsOf(t).flatMap((s) => {
      const dealers = (t.dealers ?? []).flatMap((d) => {
        const shared = d.resharedShares.find((x) => x.recipient === s.index);
        const r = checkResharedShare(
          params,
          { index: s.index, secretKey: s.kem.secretKey },
          rounds,
          hex(shared?.bytes ?? ""),
        );
        return !r.ok && (r.code === "share-decrypt" || r.code === "share-verify") ? [d.index] : [];
      });
      return dealers.length === 0 ? [] : [reshareComplaintsMessage(params, s, rounds, dealers)];
    });
    expect(complaints.map((m) => m.index)).toEqual([2, 4]);
    const d2 = (t.dealers ?? []).find((d) => d.index === 2) as DealerVector;
    const responses = [
      reshareResponsesMessage(params, oldSeatOf(2), { ...rounds, complaints }, polynomialsOf(d2)),
    ];
    expect(toHex(encodeNullifierReshareTranscript({ ...tr, complaints, responses }))).toBe(
      t.transcript,
    );
  }, 60_000);

  test.each(V.transcripts.filter((t) => t.dealers !== undefined).map((t) => [t.id, t] as const))(
    "%s: each new seat's share is the vector's, and any k' give the predecessor's sk",
    (_, t) => {
      const params = paramsOf(t);
      const tr = decodeNullifierReshareTranscript(hex(t.transcript), 1);
      const r = checkNullifierReshareTranscript(params, hex(t.transcript), 1);
      if (!r.ok) throw new Error("expected a valid transcript");
      const seats = newSeatsOf(t);
      const got = r.qualified.map((q) => {
        const seat = seats.find((s) => s.index === q.index) as RegistrationSecrets;
        const received: ReceivedShare[] = [];
        for (const d of t.dealers ?? []) {
          const shared = d.resharedShares.find((x) => x.recipient === q.index);
          if (shared === undefined) continue;
          const c = checkResharedShare(
            params,
            { index: q.index, secretKey: seat.kem.secretKey },
            tr,
            hex(shared.bytes),
          );
          if (c.ok) received.push({ dealer: c.dealer, share: c.share, blind: c.blind });
        }
        const share = reshareSeatShareOf(r, tr, q.index, received);
        return { index: q.index, sk: String(share.sk), s: String(share.s) };
      });
      expect(got).toEqual(t.shares);
      for (const set of subsets(got, panelOf(t.newPanel).threshold))
        expect(interpolate(set.map((s) => ({ index: s.index, sk: BigInt(s.sk) })))).toBe(
          BigInt(V.predecessor.sk),
        );
    },
    60_000,
  );

  test.each(V.resharedShareChecks.map((c) => [c.id, c] as const))(
    "reshared share %s checks as the vector says",
    (_, c) => {
      const t = vectorOf(c.run);
      const tr = decodeNullifierReshareTranscript(hex(t.transcript), 1);
      const seat = newSeatsOf(t).find((s) => s.index === c.recipient) as RegistrationSecrets;
      const r = checkResharedShare(
        paramsOf(t),
        { index: c.recipient, secretKey: seat.kem.secretKey },
        tr,
        hex(c.bytes),
      );
      if (c.result === "ok")
        expect(r).toEqual({
          ok: true,
          dealer: c.dealer,
          share: BigInt(c.share ?? ""),
          blind: BigInt(c.blind ?? ""),
        });
      else {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.code).toBe(c.result);
          expect(r.dealer).toBe(c.dealer);
        }
      }
    },
    60_000,
  );

  test("the frozen approvals, under a retired statement, never count", () => {
    const a = V.approvals;
    const scope = scopeOf(a.newPanel);
    const deadline = BigInt(vectorOf("honest").deadline ?? "");
    const all = [...a.approvals, ...a.notCounted].map((x) => ({
      index: x.index,
      signature: hex(x.signature),
    }));
    // Under abolish/v1/sig/nullifier-reshare-approval, which carries no deadline.
    expect(reshareApprovingSeats(scope, hex(a.keyId), deadline, all)).toEqual([]);
    expect(nullifierReshareQuorum(scope)).toBe(3);
  }, 60_000);

  test("a successor counts on the old panel's consents and q' approvals, both with its deadline", () => {
    const scope = scopeOf("new-4");
    const secrets = secretsOf("new-4");
    const oldSecrets = secretsOf(V.predecessor.panel);
    const honest = checkNullifierReshareTranscript(scope, hex(vectorOf("honest").transcript), 1);
    if (!honest.ok) throw new Error("expected a valid transcript");
    const { deadline, keyId } = honest;
    const now = deadline - BigInt(PARAMETERS.RECORD_MARGIN);
    const approvals = [1, 2, 3, 4].map((index) => ({
      index,
      signature: approveNullifierReshare(
        scope,
        secrets[index - 1] as Uint8Array,
        index,
        honest,
        now,
      ),
    }));
    // The old 2-of-4 panel's consent: 3 qualified dealers, as honest has and two-dealers doesn't.
    expect(nullifierReshareDealerQuorum(scope)).toBe(3);
    expect(honest.dealers).toEqual([1, 2, 3]);
    const consents = honest.dealers.map((index) => ({
      index,
      signature: consentNullifierReshare(
        scope,
        oldSecrets[index - 1] as Uint8Array,
        index,
        honest,
        now,
      ),
    }));
    expect(reshareApprovingSeats(scope, keyId, deadline, approvals)).toEqual([1, 2, 3, 4]);
    expect(reshareConsentingSeats(scope, keyId, deadline, consents)).toEqual([1, 2, 3]);
    // Another deadline is another statement, and neither list counts as the other.
    expect(reshareApprovingSeats(scope, keyId, deadline + 1n, approvals)).toEqual([]);
    expect(reshareConsentingSeats(scope, keyId, deadline - 1n, consents)).toEqual([]);
    expect(reshareApprovingSeats(scope, keyId, deadline, consents)).toEqual([]);
    expect(reshareConsentingSeats(scope, keyId, deadline, approvals)).toEqual([]);
    const one = approvals[0] as { index: number; signature: Uint8Array };
    expect(reshareApprovingSeats(scope, keyId, deadline, [one, one])).toEqual([1]);

    expect(nullifierReshareCounts(scope, honest, consents, approvals)).toBe(true);
    expect(nullifierReshareCounts(scope, honest, consents, approvals.slice(0, 2))).toBe(false);
    expect(nullifierReshareCounts(scope, honest, consents.slice(0, 2), approvals)).toBe(false);
    const c1 = consents[0] as { index: number; signature: Uint8Array };
    expect(nullifierReshareCounts(scope, honest, [c1, c1, c1], approvals)).toBe(false);

    // two-dealers lacks the dealer quorum: no seat approves or consents, and
    // counting refuses it however many sign.
    const twoCheck = checkNullifierReshareTranscript(
      scope,
      hex(vectorOf("two-dealers").transcript),
      1,
    );
    if (!twoCheck.ok) throw new Error("expected a valid transcript");
    expect(twoCheck.dealers.length).toBe(2);
    const twoNow = twoCheck.deadline - BigInt(PARAMETERS.RECORD_MARGIN);
    expect(() =>
      approveNullifierReshare(scope, secrets[0] as Uint8Array, 1, twoCheck, twoNow),
    ).toThrow(/dealers/);
    expect(() =>
      consentNullifierReshare(scope, oldSecrets[0] as Uint8Array, 1, twoCheck, twoNow),
    ).toThrow(/dealers/);
    expect(nullifierReshareCounts(scope, twoCheck, consents, approvals)).toBe(false);
  }, 60_000);

  test("a seat approves or consents only within its role, the window and RECORD_MARGIN", () => {
    const scope = scopeOf("new-4");
    const secrets = secretsOf("new-4");
    const oldSecrets = secretsOf(V.predecessor.panel);
    const honest = checkNullifierReshareTranscript(scope, hex(vectorOf("honest").transcript), 1);
    if (!honest.ok) throw new Error("expected a valid transcript");
    const { deadline } = honest;
    const margin = BigInt(PARAMETERS.RECORD_MARGIN);
    const approve = (block: bigint) =>
      approveNullifierReshare(scope, secrets[0] as Uint8Array, 1, honest, block);
    const consent = (block: bigint) =>
      consentNullifierReshare(scope, oldSecrets[0] as Uint8Array, 1, honest, block);
    for (const sign of [approve, consent]) {
      expect(() => sign(deadline)).toThrow(/passed/);
      expect(() => sign(deadline - margin + 1n)).toThrow(/too close/);
      expect(sign(deadline - margin)).toHaveLength(64);
      expect(() => sign(deadline - MAX_RESHARE_WINDOW - 1n)).toThrow(/too far ahead/);
      expect(sign(deadline - MAX_RESHARE_WINDOW)).toHaveLength(64);
    }
    const now = deadline - margin;
    // An old seat's key signs no approval, a new seat's no consent, and old
    // seat 4, absent from the predecessor, deals in nothing.
    expect(() =>
      approveNullifierReshare(scope, oldSecrets[0] as Uint8Array, 1, honest, now),
    ).toThrow(/seat/);
    expect(() => consentNullifierReshare(scope, secrets[0] as Uint8Array, 1, honest, now)).toThrow(
      /seat/,
    );
    expect(() =>
      consentNullifierReshare(scope, oldSecrets[3] as Uint8Array, 4, honest, now),
    ).toThrow(/qualified dealer/);
    // Only a check's own result: a copy is refused.
    expect(() =>
      approveNullifierReshare(scope, secrets[0] as Uint8Array, 1, { ...honest }, now),
    ).toThrow(/checkNullifierReshareTranscript/);
    expect(() => nullifierReshareCounts(scope, { ...honest }, [], [])).toThrow(
      /checkNullifierReshareTranscript/,
    );
    expect(Object.isFrozen(honest) && Object.isFrozen(honest.dealers)).toBe(true);
  }, 60_000);

  test.each(V.decode.map((d) => [d.id, d] as const))(
    "%s is rejected when decoded",
    (_, d) => {
      expect(() => decodeNullifierReshareTranscript(hex(d.transcript), 1)).toThrow(
        expect.objectContaining({ name: DecodeError.name, code: d.error }),
      );
      expect(checkNullifierReshareTranscript(scopeOf("new-4"), hex(d.transcript), 1)).toEqual({
        ok: false,
        code: d.error,
      });
    },
    60_000,
  );

  test("every transcript re-encodes to itself", () => {
    for (const t of V.transcripts)
      expect(
        toHex(
          encodeNullifierReshareTranscript(decodeNullifierReshareTranscript(hex(t.transcript), 1)),
        ),
      ).toBe(t.transcript);
  }, 60_000);
});

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
// A run seals and opens a share per pair with ML-KEM; JavaScript's is slow.
const keyRuns = Math.max(5, Math.ceil(numRuns / 100));

function testPanel(threshold: number, n: number, salt: number) {
  const secrets = Array.from({ length: n }, (_, i) => {
    const d = new Uint8Array(32);
    d[0] = salt;
    d[31] = i + 1;
    return d;
  });
  return { secrets, panel: { threshold, keys: secrets.map(identityKey) } as Panel };
}

const L2 = 84532n;
const REGISTRY = new Uint8Array(20).fill(7);

// An initial key through the production entry points, with every share.
function initialKey(threshold: number, n: number) {
  const { secrets, panel } = testPanel(threshold, n, 0x31);
  const params = {
    l2ChainId: L2,
    groupRegistry: REGISTRY,
    panel,
    runId: new Uint8Array(32),
    deadline: null,
  };
  const seats = secrets.map((d, i) => registrationKeygen(i + 1, d));
  const keys = seats.map((s) => registrationKeysMessage(params, s));
  const dealings = seats.map((s) => dealingMessage(params, s, keys));
  const transcript = {
    run_id: params.runId,
    keys,
    dealings: dealings.map((d) => d.message),
    complaints: [],
    responses: [],
  };
  const check = checkNullifierKeyTranscript(params, encodeNullifierKeyTranscript(transcript), 1);
  if (!check.ok) throw new Error("expected a valid initial key");
  const shares = seats.map((seat, i) => {
    const received: ReceivedShare[] = [];
    for (const d of dealings) {
      const shared = d.shares.find((x) => x.recipient === seat.index);
      if (shared === undefined) continue;
      const c = checkDealtShare(
        params,
        { index: seat.index, secretKey: seat.kem.secretKey },
        transcript,
        shared.bytes,
      );
      if (c.ok) received.push({ dealer: c.dealer, share: c.share, blind: c.blind });
    }
    return seatShareOf(
      check,
      transcript,
      seat.index,
      (dealings[i] as (typeof dealings)[number]).polynomials,
      received,
    );
  });
  const sk = dealings.reduce((acc, d) => acc + (d.polynomials.f[0] as bigint), 0n) % BJJ_ORDER;
  return { panel, secrets, key: check.key, seats, shares, sk };
}

type Holders = {
  readonly panel: Panel;
  readonly secrets: readonly Uint8Array[];
  readonly key: NullifierKey;
  readonly seats: readonly RegistrationSecrets[];
  readonly shares: readonly SeatShare[];
};

// One honest reshare from `from` to a fresh panel, with the given old dealers.
function reshareTo(from: Holders, threshold: number, n: number, salt: number, dealers: number[]) {
  const { secrets, panel } = testPanel(threshold, n, salt);
  const scope: NullifierReshareScope = {
    l2ChainId: L2,
    groupRegistry: REGISTRY,
    oldPanel: from.panel,
    predecessor: from.key,
    newPanel: panel,
  };
  const params: NullifierReshareParams = {
    ...scope,
    runId: new Uint8Array(32).fill(salt),
    deadline: 40_000_000n,
  };
  const seats = secrets.map((d, i) => registrationKeygen(i + 1, d));
  const keys = seats.map((s) => reshareKeysMessage(params, s, params.deadline - 1000n));
  const dealings = dealers.map((i) =>
    reshareDealing(
      params,
      { index: i, identitySecret: from.secrets[i - 1] as Uint8Array },
      from.shares[i - 1] as SeatShare,
      keys,
      params.deadline - 1000n,
    ),
  );
  const transcript: NullifierReshareTranscript = {
    run_id: params.runId,
    predecessor: from.key.keyId,
    deadline: params.deadline,
    keys,
    dealings: dealings.map((d) => d.message),
    complaints: [],
    responses: [],
  };
  const bytes = encodeNullifierReshareTranscript(transcript);
  const check = checkNullifierReshareTranscript(scope, bytes, 1);
  if (!check.ok) throw new Error(`expected a valid reshare, got ${check.code}`);
  const shares = seats.map((seat) => {
    const received: ReceivedShare[] = [];
    for (const d of dealings) {
      const shared = d.shares.find((x) => x.recipient === seat.index);
      if (shared === undefined) continue;
      const c = checkResharedShare(
        params,
        { index: seat.index, secretKey: seat.kem.secretKey },
        transcript,
        shared.bytes,
      );
      expect(c.ok).toBe(true);
      if (c.ok) received.push({ dealer: c.dealer, share: c.share, blind: c.blind });
    }
    return reshareSeatShareOf(check, transcript, seat.index, received);
  });
  return {
    scope,
    params,
    panel,
    secrets,
    seats,
    keys,
    dealings,
    transcript,
    bytes,
    check,
    key: check.key,
    shares,
  };
}

// Every `k` of the holders' answers combine to `sk · B`.
function answersGive(h: Holders, sk: bigint, m: bigint) {
  const b = (
    h.key.commitments.find((c) => c !== null) as NonNullable<NullifierKey["commitments"][number]>
  ).multiply(m);
  const q = { queryHash: new Uint8Array(32).fill(3), b };
  const answers = h.shares.map((share, i) => {
    const a = evaluate(h.key, q, share, (h.seats[i] as RegistrationSecrets).signingSecret);
    expect(checkNullifierAnswer(h.key, q, encodeNullifierAnswer(a)).ok).toBe(true);
    return a;
  });
  for (const set of subsets(answers, h.key.threshold))
    expect(combineAnswers(h.key, set as NullifierAnswer[]).equals(b.multiply(sk))).toBe(true);
}

describe("an honest reshare", () => {
  const initial = initialKey(2, 3);

  test("keeps sk across two epochs, whichever k old seats deal", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 4 }),
        fc.integer({ min: 0, max: 2 }),
        fc.subarray([1, 2, 3], { minLength: 2 }),
        fc.bigInt({ min: 1n, max: BJJ_ORDER - 1n }),
        (n, slack, dealers, m) => {
          const threshold = Math.max(2, n - slack);
          const first = reshareTo(initial, threshold, n, 0x41, dealers);
          expect(first.check.ok && first.check.seats.every((s) => s.reasons.length === 0)).toBe(
            true,
          );
          answersGive(first, initial.sk, m);
          // A second epoch reshares the first's shares back to a 2-of-3 panel.
          const allFirst = first.panel.keys.map((_, i) => i + 1).slice(0, threshold);
          const second = reshareTo(first, 2, 3, 0x42, allFirst);
          answersGive(second, initial.sk, m);
          // The successor's key never verifies the predecessor's answers.
          expect(second.check.ok && second.check.keyId).not.toEqual(first.check.keyId);
        },
      ),
      { numRuns: keyRuns },
    );
  }, 600_000);

  const run = reshareTo(initial, 2, 3, 0x43, [1, 2, 3]);

  test("fails whole once any byte changes", () => {
    fc.assert(
      fc.property(
        fc.nat({ max: run.bytes.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, x) => {
          const b = Uint8Array.from(run.bytes);
          b[at] = (b[at] as number) ^ x;
          expect(checkNullifierReshareTranscript(run.scope, b, 1).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  }, 300_000);

  test("checks only for the chain, registry, panels and predecessor it was made for", () => {
    const other = (patch: Partial<NullifierReshareScope>) =>
      checkNullifierReshareTranscript({ ...run.scope, ...patch }, run.bytes, 1);
    expect(other({ l2ChainId: 8453n })).toEqual({ ok: false, code: "key-signature" });
    expect(other({ groupRegistry: new Uint8Array(20).fill(8) })).toEqual({
      ok: false,
      code: "key-signature",
    });
    expect(other({ newPanel: testPanel(2, 3, 0x44).panel }).ok).toBe(false);
    expect(other({ predecessor: { ...initial.key, keyId: new Uint8Array(32) } })).toEqual({
      ok: false,
      code: "key-predecessor",
    });
    expect(() => other({ predecessor: { ...initial.key, threshold: 3 } })).toThrow(/predecessor/);
  }, 60_000);

  test("a reshared share opens only for its recipient, and any changed byte fails its hash", () => {
    const d = run.dealings[0] as (typeof run.dealings)[number];
    const shared = d.shares[0] as { recipient: number; bytes: Uint8Array };
    const seat = run.seats[shared.recipient - 1] as RegistrationSecrets;
    const other = run.seats[2] as RegistrationSecrets;
    expect(resharedShareHash(shared.bytes)).toEqual(d.message.share_hashes[0]);
    expect(
      checkResharedShare(
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
          const r = checkResharedShare(
            run.params,
            { index: seat.index, secretKey: seat.kem.secretKey },
            run.transcript,
            b,
          );
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
        const b = new Uint8Array([0x00, 0x13, 0x01, ...tail]);
        try {
          expect(encodeNullifierReshareTranscript(decodeNullifierReshareTranscript(b, 1))).toEqual(
            b,
          );
        } catch (e) {
          expect(e).toBeInstanceOf(DecodeError);
        }
      }),
      { numRuns },
    );
  }, 60_000);

  test("a reshared share decodes only if it re-encodes to itself", () => {
    const good = (
      (run.dealings[0] as (typeof run.dealings)[number]).shares[0] as { bytes: Uint8Array }
    ).bytes;
    expect(encodeResharedShare(decodeResharedShare(good, 1))).toEqual(good);
    fc.assert(
      fc.property(
        fc.nat({ max: good.length - 1 }),
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        (at, patch) => {
          const b = Uint8Array.from(good);
          b.set(patch.subarray(0, b.length - at), at);
          try {
            expect(encodeResharedShare(decodeResharedShare(b, 1))).toEqual(b);
          } catch (e) {
            expect(e).toBeInstanceOf(DecodeError);
          }
        },
      ),
      { numRuns },
    );
  }, 60_000);
});

describe("a reshare's transcript check", () => {
  const initial = initialKey(2, 3);
  const run = reshareTo(initial, 2, 3, 0x46, [1, 2, 3]);
  const rounds = { keys: run.keys, dealings: run.transcript.dealings };
  const complaint = reshareComplaintsMessage(
    run.params,
    run.seats[1] as RegistrationSecrets,
    rounds,
    [1],
  );
  const response = reshareResponsesMessage(
    run.params,
    { index: 1, identitySecret: initial.secrets[0] as Uint8Array },
    { ...rounds, complaints: [complaint] },
    (run.dealings[0] as (typeof run.dealings)[number]).polynomials,
  );
  const full: NullifierReshareTranscript = {
    ...run.transcript,
    complaints: [complaint],
    responses: [response],
  };
  const codeOf = (t: NullifierReshareTranscript, scope = run.scope) => {
    const r = checkNullifierReshareTranscript(scope, encodeNullifierReshareTranscript(t), 1);
    return r.ok ? "ok" : r.code;
  };
  const dealing = full.dealings[0] as (typeof full.dealings)[number];

  test("the complete transcript checks", () => {
    expect(codeOf(full)).toBe("ok");
  }, 60_000);

  test("rejects each wrong shape before any signature", () => {
    const extra = dealing.commitments[0] as (typeof dealing.commitments)[number];
    const withDealing = (m: typeof dealing) => ({
      ...full,
      dealings: [m, ...full.dealings.slice(1)],
    });
    expect(codeOf(withDealing({ ...dealing, commitments: [...dealing.commitments, extra] }))).toBe(
      "key-shape",
    );
    expect(codeOf(withDealing({ ...dealing, commitments: dealing.commitments.slice(1) }))).toBe(
      "key-shape",
    );
    const withComplaints = (c: number[]) => ({
      ...full,
      complaints: [{ ...complaint, complaints: c }],
    });
    expect(codeOf(withComplaints([]))).toBe("key-shape");
    expect(codeOf(withComplaints([2, 1]))).toBe("key-shape");
    expect(codeOf({ ...full, complaints: [{ ...complaint, complaints: [4] }] })).toBe("key-shape");
    expect(codeOf({ ...full, responses: [{ ...response, reveals: [] }] })).toBe("key-shape");
    expect(codeOf({ ...full, responses: [{ ...response, index: 2 }] })).toBe("key-shape");
  }, 60_000);

  test("rejects messages from seats out of order or outside the rounds", () => {
    expect(codeOf({ ...full, responses: [{ ...response, index: 4 }] })).toBe("key-order");
    const k3 = full.keys[2] as (typeof full.keys)[number];
    expect(codeOf({ ...full, keys: [...full.keys.slice(0, 2), { ...k3, index: 4 }] })).toBe(
      "key-order",
    );
    expect(codeOf({ ...full, keys: [...full.keys].reverse() })).toBe("key-order");
  }, 60_000);

  test("rejects a signature moved to another seat in rounds 1, 3 and 4", () => {
    const [a, b] = full.keys as [(typeof full.keys)[number], (typeof full.keys)[number]];
    expect(
      codeOf({ ...full, keys: [{ ...a, signature: b.signature }, b, ...full.keys.slice(2)] }),
    ).toBe("key-signature");
    expect(codeOf({ ...full, complaints: [{ ...complaint, signature: response.signature }] })).toBe(
      "key-signature",
    );
    expect(codeOf({ ...full, responses: [{ ...response, signature: complaint.signature }] })).toBe(
      "key-signature",
    );
  }, 60_000);

  test("checks only under the old panel that dealt", () => {
    const other = testPanel(2, 3, 0x47).panel;
    expect(codeOf(full, { ...run.scope, oldPanel: other })).toBe("key-signature");
  }, 60_000);

  test("excludes new seats sharing a signing key or using an identity key", () => {
    const { secrets, panel } = testPanel(2, 4, 0x48);
    const scope: NullifierReshareScope = { ...run.scope, newPanel: panel };
    const params: NullifierReshareParams = {
      ...scope,
      runId: new Uint8Array(32).fill(0x48),
      deadline: 40_000_000n,
    };
    const seats = secrets.map((d, i) => registrationKeygen(i + 1, d));
    const shared = (seats[0] as RegistrationSecrets).signingSecret;
    const tweaked = seats.map((s, i) =>
      i === 1
        ? { ...s, signingSecret: shared }
        : i === 3
          ? { ...s, signingSecret: secrets[2] as Uint8Array }
          : s,
    );
    const keys = tweaked.map((s) => reshareKeysMessage(params, s, params.deadline - 1000n));
    const dealings = [1, 2].map(
      (i) =>
        reshareDealing(
          params,
          { index: i, identitySecret: initial.secrets[i - 1] as Uint8Array },
          initial.shares[i - 1] as SeatShare,
          keys,
          params.deadline - 1000n,
        ).message,
    );
    const r = checkNullifierReshareTranscript(
      scope,
      encodeNullifierReshareTranscript({
        run_id: params.runId,
        predecessor: initial.key.keyId,
        deadline: params.deadline,
        keys,
        dealings,
        complaints: [],
        responses: [],
      }),
      1,
    );
    // Only seat 3 qualifies: below k' = 2.
    expect(r.ok ? r : r.code).toBe("key-quorum");
    expect(r.seats).toEqual([
      { index: 1, reasons: ["duplicate-key"] },
      { index: 2, reasons: ["duplicate-key"] },
      { index: 3, reasons: [] },
      { index: 4, reasons: ["duplicate-key"] },
    ]);
  }, 60_000);
});

describe("a node", () => {
  const initial = initialKey(2, 3);
  const run = reshareTo(initial, 2, 3, 0x45, [1, 2]);
  const dealer = { index: 1, identitySecret: initial.secrets[0] as Uint8Array };
  const share = initial.shares[0] as SeatShare;

  test("a new seat joins only a run whose deadline is ahead, and not too far", () => {
    const seat = run.seats[0] as RegistrationSecrets;
    const d = run.params.deadline;
    expect(() => reshareKeysMessage(run.params, seat, d)).toThrow(/passed/);
    expect(() => reshareKeysMessage(run.params, seat, d - MAX_RESHARE_WINDOW - 1n)).toThrow(
      /too far ahead/,
    );
    expect(reshareKeysMessage(run.params, seat, d - MAX_RESHARE_WINDOW).index).toBe(1);
  }, 60_000);

  test("reshares only its own share, as its polynomials' constant terms", () => {
    const randomness = run.keys.map(() => ({ mu: new Uint8Array(32), e: 1n }));
    const other = initial.shares[1] as SeatShare;
    const now = run.params.deadline - 1000n;
    expect(() => reshareDealing(run.params, dealer, other, run.keys, now)).toThrow(/doesn't open/);
    expect(() =>
      reshareDealing(run.params, dealer, { ...share, sk: share.sk + 1n }, run.keys, now),
    ).toThrow(/doesn't open/);
    expect(() =>
      reshareDealingWith(
        run.params,
        dealer,
        share,
        run.keys,
        { f: [share.sk + 1n, 1n], g: [share.s, 1n] },
        randomness,
        now,
      ),
    ).toThrow(/constant terms/);
    expect(() =>
      reshareDealing(
        run.params,
        { ...dealer, identitySecret: initial.secrets[1] as Uint8Array },
        share,
        run.keys,
        now,
      ),
    ).toThrow(/seat/);
  }, 60_000);

  test("an old seat deals only in a run whose deadline is ahead, and not too far", () => {
    const d = run.params.deadline;
    expect(() => reshareDealing(run.params, dealer, share, run.keys, d)).toThrow(/passed/);
    expect(() =>
      reshareDealing(run.params, dealer, share, run.keys, d - MAX_RESHARE_WINDOW - 1n),
    ).toThrow(/too far ahead/);
    expect(
      reshareDealing(run.params, dealer, share, run.keys, d - MAX_RESHARE_WINDOW).message.index,
    ).toBe(1);
  }, 60_000);

  test("complains only about dealers of round 2, and with its own round-1 keys", () => {
    const seat = run.seats[0] as RegistrationSecrets;
    const rounds = { keys: run.keys, dealings: run.transcript.dealings };
    expect(() => reshareComplaintsMessage(run.params, seat, rounds, [])).toThrow(/complaints/);
    expect(() => reshareComplaintsMessage(run.params, seat, rounds, [3])).toThrow(/complaints/);
    expect(() => reshareComplaintsMessage(run.params, seat, rounds, [2, 1])).toThrow(/complaints/);
    const regenerated = registrationKeygen(seat.index, seat.identitySecret);
    expect(() => reshareComplaintsMessage(run.params, regenerated, rounds, [1])).toThrow(
      /round-1 message doesn't carry its keys/,
    );
    // A new seat may complain about old seat 1 even though it is new seat 1 too: different panels.
    expect(reshareComplaintsMessage(run.params, seat, rounds, [1]).complaints).toEqual([1]);
  }, 60_000);

  test("a complaint answered correctly keeps the dealer; a wrong reveal disqualifies it", () => {
    const rounds = { keys: run.keys, dealings: run.transcript.dealings };
    const complaint = reshareComplaintsMessage(
      run.params,
      run.seats[1] as RegistrationSecrets,
      rounds,
      [1],
    );
    const own = (run.dealings[0] as (typeof run.dealings)[number]).polynomials;
    const other = (run.dealings[1] as (typeof run.dealings)[number]).polynomials;
    expect(() =>
      reshareResponsesMessage(run.params, dealer, { ...rounds, complaints: [complaint] }, other),
    ).toThrow(/polynomials/);
    const response = reshareResponsesMessage(
      run.params,
      dealer,
      { ...rounds, complaints: [complaint] },
      own,
    );
    const bytes = encodeNullifierReshareTranscript({
      ...run.transcript,
      complaints: [complaint],
      responses: [response],
    });
    const check = checkNullifierReshareTranscript(run.scope, bytes, 1);
    expect(check.ok && check.dealers).toEqual([1, 2]);
  }, 60_000);

  test("a new seat's share must open its commitment", () => {
    if (!run.check.ok) throw new Error("expected a valid reshare");
    expect(() => reshareSeatShareOf(run.check as never, run.transcript, 1, [])).toThrow(
      /qualified dealer 1/,
    );
    const wrong = [1, 2].map((d) => ({ dealer: d, share: 1n, blind: 1n }));
    expect(() => reshareSeatShareOf(run.check as never, run.transcript, 1, wrong)).toThrow(
      /doesn't open/,
    );
  }, 60_000);
});

test("the package entry point exports no way to choose the randomness", async () => {
  const api = (await import("../src/index.ts")) as Record<string, unknown>;
  expect(api["reshareDealingWith"]).toBeUndefined();
});
