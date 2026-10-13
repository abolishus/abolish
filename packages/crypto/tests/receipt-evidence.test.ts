import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  type Anchor,
  type AnchorClock,
  BOARD_TREE,
  boardEntryHash,
  calldataCarries,
  disputeEnd,
  encodeBoardEntry,
  inclusionProof,
  isReceiptAlarm,
  judgeReceipt,
  type JudgingKeys,
  merkleRoot,
  PARAMETERS,
  receiptCommitment,
  type ReceiptJudgeInput,
  type ReceiptKeyJudgement,
  type ReceiptOpeningCheck,
  type ReceiptVerdict,
  signReceipt,
  chainLink,
  encodeReceipt,
  identityKey,
  decodeReceipt,
  verifyConsistency,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/receipt-evidence.json comes from an independent Python
// implementation (scripts/receipt-evidence-vectors.py), so these expected
// values never come from the code under test.

interface JsonClock {
  readonly epoch: string;
  readonly period: string;
  readonly deadline: string;
  readonly lastSegment: number;
}

interface Expected {
  readonly verdict: string;
  readonly reason?: string;
  readonly opening?: string;
  readonly by?: string;
  readonly checkpoint?: { readonly segment: number; readonly size: string };
  readonly rootAtIndex?: string;
  readonly consistency?: readonly {
    readonly segment: number;
    readonly size: string;
    readonly proof: readonly string[];
  }[];
}

interface EvidenceVectors {
  readonly format: string;
  readonly tag: string;
  readonly disputeWindow: number;
  readonly electionId: string;
  readonly boardEntryVersion: 1;
  readonly clock: JsonClock;
  readonly disputeEnds: readonly { id: string; clock: JsonClock; disputeEnd: string }[];
  readonly commitments: readonly {
    id: string;
    salt: string;
    receipt: string;
    commitment: string;
  }[];
  readonly calldata: readonly {
    id: string;
    calldata: string;
    commitment: string;
    carries: boolean;
  }[];
  readonly verdicts: readonly {
    readonly id: string;
    readonly receipt: string;
    readonly payload: string;
    readonly keys:
      | { kind: "pinned"; keys: readonly string[] }
      | { kind: "definition"; keys: readonly { key: string; judgement: string }[] };
    readonly firstSegment: number;
    readonly anchors: readonly {
      checkpoint: { electionId: string; segment: number; size: string; head: string; root: string };
      anchoredAt: string;
    }[];
    readonly now: string;
    readonly openings?: readonly string[];
    readonly sources: readonly string[];
    readonly expected: Expected;
  }[];
}

const V = JSON.parse(
  readFileSync(new URL("receipt-evidence.json", SPEC_VECTORS), "utf8"),
) as EvidenceVectors;

const clockOf = (c: JsonClock): AnchorClock => ({
  epoch: BigInt(c.epoch),
  period: BigInt(c.period),
  deadline: BigInt(c.deadline),
  lastSegment: c.lastSegment,
});

const openingOf = (o: string): ReceiptOpeningCheck =>
  o === "ok" ? { ok: true } : ({ ok: false, code: o } as ReceiptOpeningCheck);

type VerdictVector = EvidenceVectors["verdicts"][number];

function inputOf(v: VerdictVector): ReceiptJudgeInput {
  const keys: JudgingKeys =
    v.keys.kind === "pinned"
      ? { kind: "pinned", keys: v.keys.keys.map(hex) }
      : {
          kind: "definition",
          keys: v.keys.keys.map((k) => ({
            key: hex(k.key),
            judgement: k.judgement as ReceiptKeyJudgement,
          })),
        };
  return {
    receipt: hex(v.receipt),
    payload: hex(v.payload),
    electionId: hex(V.electionId),
    boardEntryVersion: V.boardEntryVersion,
    keys,
    firstSegment: v.firstSegment,
    clock: clockOf(V.clock),
    anchors: v.anchors.map((a) => ({
      checkpoint: {
        election_id: hex(a.checkpoint.electionId),
        segment: a.checkpoint.segment,
        size: BigInt(a.checkpoint.size),
        head: hex(a.checkpoint.head),
        root: hex(a.checkpoint.root),
      },
      anchoredAt: BigInt(a.anchoredAt),
    })),
    now: BigInt(v.now),
    ...(v.openings === undefined ? {} : { openings: v.openings.map(openingOf) }),
    sources: v.sources.map(hex),
  };
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A verdict in the vectors' shape, so one comparison covers every field. */
function shape(v: ReceiptVerdict): Expected {
  const cp = (c: { segment: number; size: bigint }) => ({
    segment: c.segment,
    size: c.size.toString(),
  });
  switch (v.verdict) {
    case "not-evidence":
      return v.opening === undefined
        ? { verdict: v.verdict, reason: v.reason }
        : { verdict: v.verdict, reason: v.reason, opening: v.opening };
    case "unjudged":
    case "board-failed":
      return { verdict: v.verdict, reason: v.reason };
    case "forked":
      return v.by === "l1"
        ? { verdict: v.verdict, by: v.by, checkpoint: cp(v.checkpoint) }
        : {
            verdict: v.verdict,
            by: v.by,
            rootAtIndex: toHex(v.rootAtIndex),
            consistency: [
              { ...cp(v.consistency.checkpoint), proof: v.consistency.proof.map(toHex) },
            ],
          };
    case "included":
      return {
        verdict: v.verdict,
        consistency: v.consistency.map((c) => ({
          ...cp(c.checkpoint),
          proof: c.proof.map(toHex),
        })),
      };
    default:
      return { verdict: v.verdict };
  }
}

const runs = { numRuns: Number(process.env.FC_NUM_RUNS ?? 100) };

describe("receipt-evidence.json", () => {
  test("is the file this suite reads", () => {
    expect(V.format).toBe("abolish-receipt-evidence-vectors/1");
    expect(V.tag).toBe("abolish/v1/receipt-commitment");
    expect(V.disputeWindow).toBe(PARAMETERS.DISPUTE_WINDOW);
  });

  test.each(V.disputeEnds.map((c) => [c.id, c] as const))("dispute end %s", (_, c) => {
    expect(disputeEnd(clockOf(c.clock))).toBe(BigInt(c.disputeEnd));
  });

  test.each(V.commitments.map((c) => [c.id, c] as const))("commitment %s", (_, c) => {
    expect(toHex(receiptCommitment(hex(c.salt), hex(c.receipt)))).toBe(c.commitment);
  });

  test.each(V.calldata.map((c) => [c.id, c] as const))("calldata %s", (_, c) => {
    expect(calldataCarries(hex(c.calldata), hex(c.commitment))).toBe(c.carries);
  });

  test.each(V.verdicts.map((v) => [v.id, v] as const))("verdict %s", (_, v) => {
    expect(shape(judgeReceipt(inputOf(v)))).toEqual(v.expected);
  });

  test("covers every verdict, by and reason the judge returns", () => {
    const seen = new Set(V.verdicts.map((v) => v.expected.verdict));
    for (const verdict of [
      "not-evidence",
      "unjudged",
      "board-failed",
      "pending",
      "unanchored",
      "forked",
      "included",
      "unresolved",
    ])
      expect(seen, verdict).toContain(verdict);
    const reasons = new Set(V.verdicts.map((v) => v.expected.reason));
    for (const reason of [
      "receipt-key",
      "receipt-signature",
      "receipt-segment",
      "receipt-entry",
      "decode",
      "expired",
      "opening-fork-unknown",
      "receipt-key-unsettled",
      "checkpoint-equivocation",
      "checkpoint-inconsistent",
      "checkpoint-size",
      "wrong-election",
      "unsealed",
      "receipt-key-retired",
    ])
      expect(reasons, reason).toContain(reason);
  });
});

describe("judgeReceipt", () => {
  const included = V.verdicts.find((v) => v.id === "included") as VerdictVector;

  test("an included verdict's proofs verify from the receipt's root to every later checkpoint", () => {
    const input = inputOf(included);
    const v = judgeReceipt(input);
    if (v.verdict !== "included") throw new Error("expected included");
    const r = decodeReceipt(input.receipt);
    expect(v.consistency.length).toBeGreaterThan(0);
    for (const { checkpoint, proof } of v.consistency)
      expect(
        verifyConsistency(
          BOARD_TREE,
          r.index + 1n,
          checkpoint.size,
          r.root,
          checkpoint.root,
          proof,
        ),
      ).toBe(true);
  });

  test("never asks about the voter's entry: the verdict doesn't depend on the order of sources' bad copies", () => {
    const input = inputOf(included);
    const good = (input.sources as Uint8Array[])[0] as Uint8Array;
    fc.assert(
      fc.property(fc.array(fc.uint8Array({ maxLength: 300 }), { maxLength: 4 }), (junk) => {
        const shuffled = [...junk, good];
        expect(judgeReceipt({ ...input, sources: shuffled }).verdict).toBe("included");
      }),
      runs,
    );
  });

  test("a passing opening is needed from t_E on, and none before", () => {
    const input = inputOf(included);
    const tE = disputeEnd(input.clock);
    expect(judgeReceipt({ ...input, now: tE - 1n }).verdict).toBe("included");
    expect(judgeReceipt({ ...input, now: tE })).toEqual({
      verdict: "not-evidence",
      reason: "expired",
    });
    expect(judgeReceipt({ ...input, now: tE, openings: [{ ok: true }] }).verdict).toBe("included");
  });

  test("an unknown fork leaves the receipt unjudged whatever the other openings' failures", () => {
    const input = inputOf(included);
    const tE = disputeEnd(input.clock);
    const codes = [
      "opening-decode",
      "opening-transaction",
      "opening-commitment",
      "opening-late",
      "opening-payload",
      "opening-canonical",
    ] as const;
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...codes)), fc.nat(), (failing, at) => {
        const openings: ReceiptOpeningCheck[] = failing.map((code) => ({ ok: false, code }));
        openings.splice(at % (openings.length + 1), 0, {
          ok: false,
          code: "opening-fork-unknown",
        });
        expect(judgeReceipt({ ...input, now: tE, openings })).toEqual({
          verdict: "unjudged",
          reason: "opening-fork-unknown",
        });
      }),
      runs,
    );
  });

  test("anchors for segments before the first are no reading of the election", () => {
    const input = inputOf(included);
    const first = input.anchors[0] as Anchor;
    const stray: Anchor = {
      checkpoint: { ...first.checkpoint, size: 1000n },
      anchoredAt: first.anchoredAt,
    };
    // With f = 0 the stray equivocates with segment 0's checkpoint; anchors
    // only from f on are read, so with f = 1 it is ignored.
    expect(judgeReceipt({ ...input, anchors: [stray, ...input.anchors] })).toEqual({
      verdict: "board-failed",
      reason: "checkpoint-equivocation",
    });
    expect(
      judgeReceipt({ ...input, firstSegment: 1, anchors: [stray, ...input.anchors.slice(1)] })
        .verdict,
    ).toBe("included");
  });

  test("alarms are board-failed, unanchored, forked and unresolved only", () => {
    const alarms = V.verdicts
      .map((v) => judgeReceipt(inputOf(v)))
      .filter(isReceiptAlarm)
      .map((v) => v.verdict);
    expect(new Set(alarms)).toEqual(
      new Set(["board-failed", "unanchored", "forked", "unresolved"]),
    );
    expect(isReceiptAlarm({ verdict: "pending" })).toBe(false);
    expect(isReceiptAlarm({ verdict: "included", consistency: [] })).toBe(false);
  });

  test("any honest board's receipt is included, and any other entry at its index is forked", () => {
    const secret = new Uint8Array(32).fill(7);
    const electionId = hex(V.electionId);
    const clock: AnchorClock = { epoch: 0n, period: 100n, deadline: 10n, lastSegment: 3 };
    const payload = (i: number, salt: number) =>
      Uint8Array.from([0, 2, 1, ...new Uint8Array(32).fill((i * 7 + salt) & 0xff)]);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 12 }),
        fc.nat(),
        (rawSegments, pick) => {
          const segments = [...rawSegments].sort((a, b) => a - b);
          const entries = segments.map((s, i) =>
            encodeBoardEntry(
              { election_id: electionId, index: BigInt(i), segment: s, payload: payload(i, 0) },
              1,
            ),
          );
          const hashes = entries.map(boardEntryHash);
          const links: Uint8Array[] = [];
          for (const e of hashes) links.push(chainLink(links.at(-1) ?? new Uint8Array(32), e));
          const anchors: Anchor[] = [];
          for (let s = 0; s <= 3; s++) {
            const size = segments.filter((x) => x <= s).length;
            if (size === 0) continue;
            anchors.push({
              checkpoint: {
                election_id: electionId,
                segment: s,
                size: BigInt(size),
                head: links[size - 1] as Uint8Array,
                root: merkleRoot(BOARD_TREE, hashes.slice(0, size)),
              },
              anchoredAt: BigInt((s + 1) * 100 + 5),
            });
          }
          const i = pick % entries.length;
          const signFor = (leaves: Uint8Array[], chain: Uint8Array) =>
            encodeReceipt(
              signReceipt(secret, {
                election_id: electionId,
                index: BigInt(i),
                segment: segments[i] as number,
                entry_hash: leaves[i] as Uint8Array,
                link: chain,
                root: merkleRoot(BOARD_TREE, leaves.slice(0, i + 1)),
                inclusion: inclusionProof(BOARD_TREE, leaves.slice(0, i + 1), i),
              }),
            );
          const base: ReceiptJudgeInput = {
            receipt: signFor(hashes, links[i] as Uint8Array),
            payload: payload(i, 0),
            electionId,
            boardEntryVersion: 1,
            keys: { kind: "pinned", keys: [identityKey(secret)] },
            firstSegment: 0,
            clock,
            anchors,
            now: 1000n,
            sources: [Uint8Array.from(hashes.flatMap((h) => [...h]))],
          };
          expect(judgeReceipt(base).verdict).toBe("included");
          // Another payload at index i: the operator signed a board the
          // anchored one doesn't extend.
          const forkHashes = [...hashes];
          const other = payload(i, 1);
          forkHashes[i] = boardEntryHash(
            encodeBoardEntry(
              {
                election_id: electionId,
                index: BigInt(i),
                segment: segments[i] as number,
                payload: other,
              },
              1,
            ),
          );
          const forked = judgeReceipt({
            ...base,
            receipt: signFor(forkHashes, new Uint8Array(32)),
            payload: other,
          });
          expect(forked.verdict).toBe("forked");
        },
      ),
      runs,
    );
  });

  test("rejects malformed inputs", () => {
    const input = inputOf(included);
    expect(() => judgeReceipt({ ...input, now: -1n })).toThrow(RangeError);
    expect(() => judgeReceipt({ ...input, firstSegment: 5 })).toThrow(RangeError);
    const first = input.anchors[0] as Anchor;
    expect(() =>
      judgeReceipt({
        ...input,
        anchors: [{ ...first, checkpoint: { ...first.checkpoint, segment: Number.NaN } }],
      }),
    ).toThrow(RangeError);
    const tE = disputeEnd(input.clock);
    for (const bad of [{ ok: 1 }, { ok: false, code: "opening-maybe" }, { ok: false }])
      expect(() =>
        judgeReceipt({ ...input, now: tE, openings: [bad as unknown as ReceiptOpeningCheck] }),
      ).toThrow(TypeError);
    expect(() =>
      judgeReceipt({
        ...input,
        keys: {
          kind: "definition",
          keys: [{ key: new Uint8Array(33), judgement: "maybe" as never }],
        },
      }),
    ).toThrow(TypeError);
  });
});

describe("receiptCommitment and calldataCarries", () => {
  test("the salt hides nothing it shouldn't: other salts give other commitments", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.uint8Array({ maxLength: 64 }),
        (a, b, receipt) => {
          fc.pre(toHex(a) !== toHex(b));
          expect(toHex(receiptCommitment(a, receipt))).not.toBe(
            toHex(receiptCommitment(b, receipt)),
          );
        },
      ),
      runs,
    );
  });

  test("refuses salts of any other length", () => {
    for (const n of [0, 31, 33])
      expect(() => receiptCommitment(new Uint8Array(n), new Uint8Array())).toThrow(RangeError);
  });

  test("finds a commitment at every aligned position of a batch", () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 32, maxLength: 32 }), { maxLength: 6 }),
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.nat(),
        (others, c, at) => {
          fc.pre(others.every((o) => toHex(o) !== toHex(c)));
          const words = [...others];
          words.splice(at % (words.length + 1), 0, c);
          const batch = Uint8Array.from(words.flatMap((w) => [...w]));
          expect(calldataCarries(batch, c)).toBe(true);
        },
      ),
      runs,
    );
  });
});
