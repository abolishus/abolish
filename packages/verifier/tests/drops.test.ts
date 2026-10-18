import { readFileSync } from "node:fs";
import {
  boardEntryHash,
  decodeBoardEntry,
  encodeBoardEntry,
  encodeReceipt,
  pinnedVersion,
  type ReceiptVerdict,
  RECORD_TYPES,
  signReceipt,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks, judgeFor } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { authorRunOf, decodeDefinition, isReadable, readDefinition } from "../src/definition.ts";
import { type DropInputs, judgeDropRule } from "../src/drops.ts";
import {
  BUNDLE_FORMAT_BLOCKS,
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  judgeDrop,
  parseBundle,
  verifyBundle,
} from "../src/index.ts";
import { anchoredAdmitted } from "../src/verify.ts";
import { run, toHex } from "./headers.ts";
import { anchoredL1 } from "./state.ts";

// The drop rule (docs/spec/receipts.md, Drops), over docs/spec/vectors/
// verifier-ballots-v3.json's boards (an independent implementation's
// ballots, with snarkjs's verdict on every membership proof): the payload's
// own admission, the close rule and the L1 reference decide whether its loss
// could matter, and presence is by (tier, ν, M) among the admitted ballots
// of the whole board. The vectors' references name no block of any run a
// test can build, and their anchors aren't their copies', so the rule is run
// on its own with the board's admitted ballots and an L1 judgement given,
// and `judgeDrop` on the vectors' bundles reaches only the outcomes that
// stop before them.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
}
const file = read("verifier-ballots-v3.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly panels: Readonly<Record<string, unknown>>;
  readonly cases: readonly Case[];
};
const l1File = read("l1-anchor.json") as {
  readonly vectors: readonly {
    readonly id: string;
    readonly firstSegment: string;
    readonly block: { readonly header: string };
    readonly nodes: readonly string[];
    readonly checkpoints: readonly string[];
  }[];
};
const closed = l1File.vectors.find((v) => v.id === "closed");
if (closed === undefined) throw new Error("no closed L1 vector");
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

const bundleOf = (c: Case, blocks?: readonly string[], definition = c.definition) =>
  parseBundle(
    JSON.stringify({
      format: blocks === undefined ? BUNDLE_FORMAT_CEREMONY : BUNDLE_FORMAT_BLOCKS,
      definition,
      clock: file.clock,
      l1: {
        firstSegment: closed.firstSegment,
        header: closed.block.header,
        nodes: closed.nodes,
        checkpoints: closed.checkpoints,
      },
      panel: file.panels[c.panel],
      ...(blocks !== undefined && { l1Blocks: blocks }),
    }),
    hex(c.board),
  );

/** A case's election as the verifier judges it, and its board's ballot payloads by entry. */
function election(id: string) {
  const bundle = bundleOf(byId(id));
  if (bundle.format !== "abolish-verifier-bundle/4") throw new Error("not a format-4 bundle");
  const definition = decodeDefinition(bundle.definition);
  const { stubHash } = readDefinition(definition);
  const version = pinnedVersion(definition.value, RECORD_TYPES.boardEntry);
  if (!isReadable(version)) throw new Error("unexpected board-entry version");
  const { registered, authorRegistered } = ceremonyChecks(
    definition.value,
    stubHash,
    bundle.panel,
    authorRunOf(definition),
    bundle.entries,
    version,
  );
  const judge = judgeFor(definition, registered, authorRegistered);
  const payloads = new Map<number, Uint8Array>();
  for (const [at, entry] of bundle.entries.entries()) {
    const { payload } = decodeBoardEntry(entry, version);
    if (((payload[0] as number) << 8) + (payload[1] as number) === RECORD_TYPES.ballot)
      payloads.set(at, payload);
  }
  // The admitted ballots of a board of `entries`, each kept with the entry
  // it has on the full board.
  const admittedOf = (entries: readonly number[]) => {
    const { candidates } = ballotChecks(
      definition,
      registered,
      authorRegistered,
      entries.map((at) => bundle.entries[at] as Uint8Array),
      version,
      bundle.clock,
    );
    if (candidates === undefined) throw new Error("admission didn't settle");
    return candidates.map((c) => ({ ...c, entry: entries[c.entry] as number }));
  };
  const all = bundle.entries.map((_, at) => at);
  return { bundle, definition, version, judge, payloads, admittedOf, all };
}

const admitted = election("admitted");
const repeats = election("repeats");

const UNANCHORED: ReceiptVerdict = { verdict: "unanchored" };
const OTHER_VERDICTS: readonly ReceiptVerdict[] = [
  { verdict: "not-evidence", reason: "receipt-signature" },
  { verdict: "unjudged", reason: "receipt-key-unsettled" },
  { verdict: "board-failed", reason: "unsealed" },
  { verdict: "pending" },
  { verdict: "included", consistency: [] },
  { verdict: "unresolved" },
];

const ruleInputs = (
  e: typeof admitted,
  entry: number,
  over: Partial<DropInputs> = {},
): DropInputs => ({
  verdict: UNANCHORED,
  segment: 1,
  payload: e.payloads.get(entry) as Uint8Array,
  judge: e.judge,
  references: () => "admitted",
  lastBoardSegment: 199n,
  admitted: e.admittedOf(e.all.filter((at) => at !== entry)),
  ...over,
});

// Each case judges whole ballots (a pairing per membership proof), which
// has taken over the 5-second default on CI's shared runners.
describe("the drop rule", { timeout: 120_000 }, () => {
  test("only an unanchored or forked receipt can be a drop", () => {
    for (const verdict of OTHER_VERDICTS)
      expect(judgeDropRule(ruleInputs(admitted, 1, { verdict }))).toEqual({
        status: "not-drop",
        code: "not-alarm",
      });
    const forked: ReceiptVerdict = {
      verdict: "forked",
      by: "l1",
      checkpoint: { segment: 1, size: 1n, head: new Uint8Array(32), root: new Uint8Array(32) },
    } as ReceiptVerdict;
    for (const verdict of [UNANCHORED, forked])
      expect(judgeDropRule(ruleInputs(admitted, 1, { verdict }))).toEqual({ status: "drop" });
  });

  test("an admitted ballot missing from the board is a drop, and one on it is present", () => {
    for (const entry of admitted.payloads.keys()) {
      expect(judgeDropRule(ruleInputs(admitted, entry))).toEqual({ status: "drop" });
      expect(
        judgeDropRule(ruleInputs(admitted, entry, { admitted: admitted.admittedOf(admitted.all) })),
      ).toEqual({
        status: "not-drop",
        code: "present",
        entry,
      });
    }
  });

  test("a copy under other bytes with the same (tier, ν, M) is presence: by M recomputed, never by bytes", () => {
    // Entry 2 is the original; entry 3 is it with its proof negated, a
    // repeat on the full board, and the first copy once entry 2 is gone.
    const original = repeats.payloads.get(2) as Uint8Array;
    const negated = repeats.payloads.get(3) as Uint8Array;
    expect(Buffer.from(original).equals(Buffer.from(negated))).toBe(false);
    const without = repeats.all.filter((at) => at !== 2);
    expect(
      judgeDropRule(ruleInputs(repeats, 2, { admitted: repeats.admittedOf(without) })),
    ).toEqual({
      status: "not-drop",
      code: "present",
      entry: 3,
    });
    // With every copy gone, it is a drop.
    const none = repeats.all.filter((at) => ![2, 3, 5].includes(at));
    expect(judgeDropRule(ruleInputs(repeats, 2, { admitted: repeats.admittedOf(none) }))).toEqual({
      status: "drop",
    });
  });

  test("a payload the board's own admission rejects is no drop, with its code", () => {
    const mixed = election("mixed");
    const expected: Record<number, unknown> = {
      5: { code: "ballot-stray" },
      6: { code: "ballot-cell" },
      8: { code: "validity-shape" },
      9: { code: "share-hash-unqualified" },
      10: { code: "membership-proof" },
      12: { code: "option-proof" },
      13: { code: "sum-proof" },
      15: { code: "decode", decodeError: "trailing-bytes" },
      16: { code: "decode", decodeError: "profile-mismatch" },
    };
    for (const [entry, outcome] of Object.entries(expected))
      expect(judgeDropRule(ruleInputs(mixed, Number(entry)))).toEqual({
        status: "not-drop",
        ...(outcome as object),
      });
  });

  test("a payload that isn't a ballot record is no drop", () => {
    const payload = (admitted.payloads.get(1) as Uint8Array).slice();
    payload[1] = (payload[1] as number) ^ 1;
    for (const p of [payload, new Uint8Array(1), new Uint8Array()])
      expect(judgeDropRule(ruleInputs(admitted, 1, { payload: p }))).toEqual({
        status: "not-drop",
        code: "decode",
        decodeError: "unexpected-record-type",
      });
  });

  test("a ballot the close rule rejects is no drop: a board-path ballot after s_A", () => {
    expect(judgeDropRule(ruleInputs(admitted, 1, { segment: 200 }))).toEqual({
      status: "not-drop",
      code: "window-boarded-late",
    });
    expect(judgeDropRule(ruleInputs(admitted, 1, { segment: 199 }))).toEqual({ status: "drop" });
  });

  test("the L1 reference decides as 5.8 does: rejected is no drop, a check that can't run is unjudged", () => {
    expect(judgeDropRule(ruleInputs(admitted, 1, { references: undefined }))).toEqual({
      status: "unjudged",
      code: "l1-blocks-missing",
    });
    expect(judgeDropRule(ruleInputs(admitted, 1, { references: "l1-blocks-short" }))).toEqual({
      status: "unjudged",
      code: "l1-blocks-short",
    });
    expect(judgeDropRule(ruleInputs(admitted, 1, { references: () => "pending" }))).toEqual({
      status: "unjudged",
      code: "l1-ref-pending",
    });
    for (const code of ["l1-ref-before-open", "l1-ref-after-close", "l1-ref-unknown"] as const)
      expect(judgeDropRule(ruleInputs(admitted, 1, { references: () => code }))).toEqual({
        status: "not-drop",
        code,
      });
  });

  test("presence waits on the whole board: without its admitted ballots the outcome is unjudged", () => {
    expect(judgeDropRule(ruleInputs(admitted, 1, { admitted: undefined }))).toEqual({
      status: "unjudged",
      code: "board-unsettled",
    });
  });

  test("an election whose ballots can't be judged leaves every receipt unjudged", () => {
    for (const [judge, code] of [
      [{ status: "unverifiable", code: "not-reached" }, "not-reached"],
      [{ status: "unverifiable", code: "unsupported-version", at: {} }, "unsupported-version"],
    ] as const)
      expect(judgeDropRule(ruleInputs(admitted, 1, { judge }))).toEqual({
        status: "unjudged",
        code,
      });
  });

  test("property: over any board the operator keeps, a drop is exactly an admitted ballot with no copy kept", () => {
    const ballots = [...admitted.payloads.keys()];
    fc.assert(
      fc.property(fc.subarray(ballots), fc.constantFrom(...ballots), (kept, entry) => {
        const entries = admitted.all.filter(
          (at) => !admitted.payloads.has(at) || kept.includes(at),
        );
        const outcome = judgeDropRule(
          ruleInputs(admitted, entry, { admitted: admitted.admittedOf(entries) }),
        );
        // The model: the case's ballots differ in M, its re-vote included
        // (the same tier and ν), so a ballot's only copy is its own entry.
        expect(outcome).toEqual(
          kept.includes(entry)
            ? { status: "not-drop", code: "present", entry }
            : { status: "drop" },
        );
      }),
      { numRuns: Math.min(numRuns, 20) },
    );
  });
});

describe("judgeDrop over a bundle", { timeout: 120_000 }, () => {
  const c = byId("admitted");
  const d = admitted.definition.value;
  const payload = admitted.payloads.get(1) as Uint8Array;
  const receiptFor = (covered: Uint8Array = payload, electionId: Uint8Array = d.election_id) =>
    encodeReceipt(
      signReceipt(new Uint8Array(32).fill(7), {
        election_id: electionId,
        index: 5n,
        segment: 1,
        entry_hash: boardEntryHash(
          encodeBoardEntry(
            { election_id: electionId, index: 5n, segment: 1, payload: covered },
            admitted.version,
          ),
        ),
        link: new Uint8Array(32),
        root: new Uint8Array(32),
        inclusion: [],
      }),
    );
  const OPENS = d.opens_at;
  const CLOSES = d.closes_at;
  // Every input of a vectors' bundle is a local file, so `drop` never
  // claims what `dropAgainstInputs` found.
  const againstInputs = (dropAgainstInputs: unknown) => ({
    drop: { status: "unjudged", code: "inputs-unauthenticated" },
    dropAgainstInputs,
  });

  test("a verdict that isn't an alarm is never a drop", () => {
    const notAlarm = { status: "not-drop", code: "not-alarm" };
    for (const verdict of OTHER_VERDICTS)
      expect(judgeDrop(bundleOf(c), receiptFor(), payload, verdict)).toEqual({
        drop: notAlarm,
        dropAgainstInputs: notAlarm,
      });
  });

  test("under format 4 the L1 reference can't be judged, so no receipt's ballot is", () => {
    expect(judgeDrop(bundleOf(c), receiptFor(), payload, UNANCHORED)).toEqual(
      againstInputs({ status: "unjudged", code: "l1-blocks-missing" }),
    );
  });

  test("under format 5, the payload's reference is judged as the board's copy of it is, against the inputs only", () => {
    // The vectors' references name no block of this run, whose head is after
    // close: 5.8 rejects them all, and so the payload.
    const blocks = run(21_000_000n, [OPENS - 3600n - 12n, CLOSES + 12n]).map((h) =>
      toHex(h.encoded),
    );
    const bundle = bundleOf(c, blocks);
    const row = verifyBundle(bundle).checks.find((x) => x.id === "5.8") as CheckResult;
    expect(row.status).toBe("fail");
    expect(judgeDrop(bundle, receiptFor(), payload, UNANCHORED)).toEqual(
      againstInputs({ status: "not-drop", code: row.code }),
    );
  });

  test("a bundle whose definition doesn't decode reaches no ballot", () => {
    expect(
      judgeDrop(
        bundleOf(c, undefined, c.definition.slice(0, -2)),
        receiptFor(),
        payload,
        UNANCHORED,
      ),
    ).toEqual(againstInputs({ status: "unjudged", code: "not-reached" }));
  });

  test("a payload the receipt doesn't cover isn't judged: no other ballot can be called the dropped one", () => {
    // Another admitted ballot of the election, never under this receipt.
    const other = admitted.payloads.get(2) as Uint8Array;
    expect(() => judgeDrop(bundleOf(c), receiptFor(), other, UNANCHORED)).toThrow(RangeError);
    expect(() => judgeDrop(bundleOf(c), receiptFor(other), other, UNANCHORED)).not.toThrow();
  });

  test("a receipt for another election isn't this board's to judge", () => {
    expect(() =>
      judgeDrop(bundleOf(c), receiptFor(payload, new Uint8Array(32).fill(1)), payload, UNANCHORED),
    ).toThrow(RangeError);
  });

  test("the board's admitted ballots are read only from a sealed copy its anchors authenticate, once 6.1 passes", () => {
    // The case's board anchored in an L1 state built here (state.ts), with
    // a run past close: 4.1, 4.2 and every admission row settle, and 6.1
    // passes once the seal's window has closed. Every vector reference is
    // rejected by this run, so none of the board's ballots is admitted.
    const clock = admitted.bundle.clock;
    const sealEnds = clock.epoch + BigInt(clock.lastSegment + 1) * clock.period + clock.deadline;
    const blocks = run(21_000_000n, [OPENS - 3600n - 12n, CLOSES + 12n]).map((h) =>
      toHex(h.encoded),
    );
    const anchoredAt = (timestamp: bigint) =>
      parseBundle(
        JSON.stringify({
          format: BUNDLE_FORMAT_BLOCKS,
          definition: c.definition,
          clock: file.clock,
          l1: anchoredL1(
            d.election_id,
            d.l1_anchor,
            admitted.bundle.entries,
            admitted.version,
            clock,
            {
              number: 20_000_000n,
              timestamp,
            },
          ),
          panel: file.panels[c.panel],
          l1Blocks: blocks,
        }),
        hex(c.board),
      );
    const definition = decodeDefinition(hex(c.definition));
    const sealed = anchoredAt(sealEnds + 1n);
    const report = verifyBundle(sealed);
    const status = (id: string) => report.checks.find((x) => x.id === id)?.status;
    expect([status("4.1"), status("4.2"), status("6.1")]).toEqual(["pass", "pass", "pass"]);
    const read = (b: typeof sealed) => {
      if (b.format !== "abolish-verifier-bundle/5") throw new Error("not a format-5 bundle");
      const { stubHash } = readDefinition(definition);
      const checked = ceremonyChecks(
        definition.value,
        stubHash,
        b.panel,
        undefined,
        b.entries,
        admitted.version,
      );
      return anchoredAdmitted(
        b,
        definition,
        {
          electionId: d.election_id,
          boardEntryVersion: admitted.version,
          l1: { ...b.l1, anchor: d.l1_anchor },
        },
        checked,
      );
    };
    expect(read(sealed)).toEqual([]);
    // Up to and including the seal window's last second, the board isn't final.
    expect(read(anchoredAt(sealEnds))).toBeUndefined();
    // The vectors' own evidence anchors another copy.
    expect(read(bundleOf(c, blocks))).toBeUndefined();
  });
});
