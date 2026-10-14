import { readFileSync } from "node:fs";
import { type AdmittedBallot, L1_REF_MARGIN } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  BUNDLE_FORMAT_BLOCKS,
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  parseBundle,
  type Report,
  verifyBundle,
} from "../src/index.ts";
import type { CountedCandidate } from "../src/ballots.ts";
import { admissionSettled, selectionCheck, type SelectionInputs } from "../src/selection.ts";
import { run, toHex } from "./headers.ts";

// Selection (6.1, docs/spec/verifier.md, Selection): decided only once the
// counted extent is fixed, then by docs/spec/revoting.md's Selection over the
// ballots every admission check admitted. The rule itself is checked here
// against a linear model of revoting.md's steps 2 and 3, written from the
// spec, never from `selectBallots`; the gates in front of it on synthetic
// inputs; and the whole run on the vectors' bundles, where the copy and the
// anchors never reach a sealed, authenticated board, so 6.1 never passes.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const CLOCK = { epoch: 1000n, period: 100n, deadline: 50n, lastSegment: 9 };
// The seal's window: the end of period 9 plus the deadline.
const SEAL_ENDS = 1000n + 10n * 100n + 50n;

const message = (n: number) => {
  const m = new Uint8Array(32);
  new DataView(m.buffer).setUint32(28, n);
  return m;
};
const ballot = (entry: number, tier: number, nullifier: bigint, l1: bigint): AdmittedBallot => ({
  tier,
  nullifier,
  // Distinct per entry: admission has already rejected every repeat.
  message: message(entry),
  l1RefNumber: l1,
  index: BigInt(entry),
});
const candidate = (
  entry: number,
  segment: number,
  b: AdmittedBallot,
  path: CountedCandidate["path"] = "board",
): CountedCandidate => ({ entry, segment, path, ballot: b });

const inputs = (over: Partial<SelectionInputs> = {}): SelectionInputs => ({
  admissionSettled: true,
  candidates: [],
  ordinary: [],
  extent: 10,
  eventsPass: false,
  clock: CLOCK,
  now: SEAL_ENDS + 1n,
  floor: 5n,
  ...over,
});

describe("6.1 is decided only once the counted extent is fixed", () => {
  const candidates = [candidate(0, 1, ballot(0, 0, 7n, 20n))];

  test("an unsettled admission row, or none run, leaves 6.1 not reached", () => {
    for (const over of [{ admissionSettled: false }, { candidates: undefined }])
      expect(selectionCheck(inputs({ candidates, ...over }))).toEqual({
        row: { status: "unverifiable", code: "not-reached", at: {} },
      });
  });

  test("a copy 4.1 and 4.2 didn't authenticate leaves 6.1 not reached", () => {
    for (const over of [{ extent: undefined }, { now: undefined }])
      expect(selectionCheck(inputs({ candidates, ...over }))).toEqual({
        row: { status: "unverifiable", code: "not-reached", at: {} },
      });
  });

  test("before the seal's window closes the board isn't final, up to and including its last second", () => {
    for (const now of [0n, SEAL_ENDS - 1n, SEAL_ENDS])
      expect(selectionCheck(inputs({ candidates, now }))).toEqual({
        row: { status: "unverifiable", code: "not-sealed", at: {} },
      });
    expect(selectionCheck(inputs({ candidates, now: SEAL_ENDS + 1n })).row).toEqual({
      status: "pass",
    });
  });

  test("an ordinary ballot in the anchored extent waits on 4.4, whether or not it was admitted", () => {
    // Entry 3 carried an ordinary ballot that admission rejected: its
    // timestamp, not yet authenticated, may have rejected it.
    expect(selectionCheck(inputs({ candidates, ordinary: [3, 4] }))).toEqual({
      row: { status: "unverifiable", code: "not-reached", at: { entry: 3 } },
    });
    // Past the anchored extent, it isn't on the board.
    expect(selectionCheck(inputs({ candidates, ordinary: [10, 11] })).row.status).toBe("pass");
    expect(selectionCheck(inputs({ candidates, ordinary: [3], eventsPass: true })).row.status).toBe(
      "pass",
    );
  });

  test("an admitted ballot boarded after the floor of s_S can't be placed in the counted extent", () => {
    const later = [
      ...candidates,
      candidate(4, 6, ballot(4, 0, 8n, 20n), "ordinary"),
      candidate(5, 7, ballot(5, 0, 9n, 20n), "ordinary"),
    ];
    expect(
      selectionCheck(inputs({ candidates: later, ordinary: [4, 5], eventsPass: true })),
    ).toEqual({ row: { status: "unverifiable", code: "not-implemented", at: { entry: 4 } } });
    // At the floor itself it is inside.
    const atFloor = [...candidates, candidate(4, 5, ballot(4, 0, 8n, 20n))];
    expect(selectionCheck(inputs({ candidates: atFloor })).row.status).toBe("pass");
    // Past the anchored extent, no one boarded it.
    expect(selectionCheck(inputs({ candidates: later, extent: 4 })).row.status).toBe("pass");
  });

  test("admission is settled only when every row, 5.8 included, passed or failed", () => {
    const ids = ["5.1", "5.2", "5.3", "5.4", "5.5", "5.7", "5.8"];
    type Status = "pass" | "fail" | "unverifiable";
    const settled = new Map<string, { readonly status: Status }>(
      ids.map((id) => [id, { status: "pass" }]),
    );
    expect(admissionSettled(settled)).toBe(true);
    expect(
      admissionSettled(
        new Map<string, { readonly status: Status }>([...settled, ["5.4", { status: "fail" }]]),
      ),
    ).toBe(true);
    for (const id of ids) {
      expect(
        admissionSettled(
          new Map<string, { readonly status: Status }>([
            ...settled,
            [id, { status: "unverifiable" }],
          ]),
        ),
      ).toBe(false);
      // Format 4: 5.8 never runs, and a row nobody reported settles nothing.
      expect(admissionSettled(new Map([...settled].filter(([k]) => k !== id)))).toBe(false);
    }
  });

  test("the gates run in the spec's order", () => {
    const late = [candidate(2, 8, ballot(2, 0, 7n, 20n))];
    const all = { candidates: late, ordinary: [1], now: SEAL_ENDS };
    expect(selectionCheck(inputs({ ...all, admissionSettled: false })).row.code).toBe(
      "not-reached",
    );
    expect(selectionCheck(inputs({ ...all, extent: undefined })).row).toEqual({
      status: "unverifiable",
      code: "not-reached",
      at: {},
    });
    expect(selectionCheck(inputs(all)).row.code).toBe("not-sealed");
    expect(selectionCheck(inputs({ ...all, now: SEAL_ENDS + 1n })).row).toEqual({
      status: "unverifiable",
      code: "not-reached",
      at: { entry: 1 },
    });
    expect(selectionCheck(inputs({ ...all, now: SEAL_ENDS + 1n, ordinary: [] })).row).toEqual({
      status: "unverifiable",
      code: "not-implemented",
      at: { entry: 2 },
    });
  });

  test("an admitted repeat is an inconsistency of the caller's, never a selection", () => {
    const b = ballot(0, 0, 7n, 20n);
    const copy = { ...b, index: 1n };
    expect(() =>
      selectionCheck(inputs({ candidates: [candidate(0, 1, b), candidate(1, 1, copy)] })),
    ).toThrow(/repeat/);
  });
});

describe("6.1's selection", () => {
  test("the highest block counts, a shared highest block ties, and tiers are never compared", () => {
    const r = selectionCheck(
      inputs({
        candidates: [
          candidate(0, 1, ballot(0, 0, 7n, 20n)),
          candidate(1, 1, ballot(1, 0, 7n, 30n)),
          // Another tier, same nullifier: its own group (T-13).
          candidate(2, 2, ballot(2, 1, 7n, 10n)),
          candidate(3, 3, ballot(3, 0, 8n, 40n)),
          candidate(4, 4, ballot(4, 0, 8n, 40n)),
          // A lower block after a tie doesn't break it, and no earlier
          // ballot of a tied group counts in its place.
          candidate(5, 5, ballot(5, 0, 8n, 39n)),
        ],
      }),
    );
    expect(r).toEqual({
      row: { status: "pass" },
      report: {
        selected: [{ entry: 1 }, { entry: 2 }],
        ties: [{ entry: 3 }, { entry: 4 }],
      },
    });
  });

  test("an empty counted extent passes with nothing selected", () => {
    expect(selectionCheck(inputs())).toEqual({
      row: { status: "pass" },
      report: { selected: [], ties: [] },
    });
  });

  // revoting.md, Selection, steps 2 and 3, as a scan over every group.
  const model = (cs: readonly CountedCandidate[]) => {
    const selected: number[] = [];
    const ties: number[] = [];
    for (const c of cs) {
      const group = cs.filter(
        (o) => o.ballot.tier === c.ballot.tier && o.ballot.nullifier === c.ballot.nullifier,
      );
      const top = group.reduce((m, o) => (o.ballot.l1RefNumber > m ? o.ballot.l1RefNumber : m), 0n);
      if (c.ballot.l1RefNumber !== top) continue;
      (group.filter((o) => o.ballot.l1RefNumber === top).length === 1 ? selected : ties).push(
        c.entry,
      );
    }
    return {
      selected: selected.map((entry) => ({ entry })),
      ties: ties.map((entry) => ({ entry })),
    };
  };

  const arbCandidates = fc
    .array(
      fc.record({
        tier: fc.integer({ min: 0, max: 2 }),
        nullifier: fc.bigInt({ min: 1n, max: 4n }),
        l1: fc.bigInt({ min: 1n, max: 4n }),
      }),
      { maxLength: 24 },
    )
    .map((xs) =>
      xs.map((x, entry) => candidate(entry, entry % 6, ballot(entry, x.tier, x.nullifier, x.l1))),
    );

  test("matches the model over the anchored extent, and nothing past it changes the selection", () => {
    fc.assert(
      fc.property(arbCandidates, fc.nat({ max: 24 }), (cs, extent) => {
        const r = selectionCheck(inputs({ candidates: cs, extent }));
        expect(r.row).toEqual({ status: "pass" });
        expect(r.report).toEqual(model(cs.filter((c) => c.entry < extent)));
      }),
      { numRuns },
    );
  });

  test("permuting the candidates or their segments within the floor changes no selection (R3)", () => {
    fc.assert(
      fc.property(
        arbCandidates.chain((cs) =>
          fc.tuple(
            fc.constant(cs),
            fc.shuffledSubarray(cs, { minLength: cs.length, maxLength: cs.length }),
            fc.array(fc.integer({ min: 0, max: 5 }), {
              minLength: cs.length,
              maxLength: cs.length,
            }),
          ),
        ),
        ([cs, shuffled, segments]) => {
          const moved = shuffled.map((c, i) => ({ ...c, segment: segments[i] ?? 0 }));
          const a = selectionCheck(inputs({ candidates: cs, extent: 100 }));
          const b = selectionCheck(inputs({ candidates: moved, extent: 100 }));
          expect(b).toEqual(a);
        },
      ),
      { numRuns },
    );
  });

  test("every group either selects exactly one ballot or ties at least two", () => {
    fc.assert(
      fc.property(arbCandidates, (cs) => {
        const r = selectionCheck(inputs({ candidates: cs, extent: 100 }));
        const groups = new Set(cs.map((c) => `${c.ballot.tier}:${c.ballot.nullifier}`));
        const key = (e: { readonly entry: number }) => {
          const c = cs[e.entry] as CountedCandidate;
          return `${c.ballot.tier}:${c.ballot.nullifier}`;
        };
        const selected = (r.report?.selected ?? []).map(key);
        const tied = (r.report?.ties ?? []).map(key);
        expect(new Set(selected).size).toBe(selected.length);
        for (const g of groups) {
          const s = selected.filter((x) => x === g).length;
          const t = tied.filter((x) => x === g).length;
          expect(s === 1 ? t === 0 : s === 0 && t >= 2).toBe(true);
        }
      }),
      { numRuns },
    );
  });
});

// The vectors' bundles: docs/spec/vectors/verifier-ballots.json's ballots
// with l1-anchor.json's evidence, whose anchors aren't this copy's, so 4.1
// and 4.2 never both pass and 6.1 is never decided over them.
const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
}
const file = read("verifier-ballots.json") as {
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
const admitted = file.cases.find((c) => c.id === "admitted");
if (admitted === undefined) throw new Error("no admitted case");
const OPENS = 1_767_225_600n;
const CLOSES = 1_767_830_400n;

const bundle = (blocks?: readonly string[]) =>
  verifyBundle(
    parseBundle(
      JSON.stringify({
        format: blocks === undefined ? BUNDLE_FORMAT_CEREMONY : BUNDLE_FORMAT_BLOCKS,
        definition: admitted.definition,
        clock: file.clock,
        l1: {
          firstSegment: closed.firstSegment,
          header: closed.block.header,
          nodes: closed.nodes,
          checkpoints: closed.checkpoints,
        },
        panel: file.panels[admitted.panel],
        ...(blocks !== undefined && { l1Blocks: blocks }),
      }),
      Uint8Array.from(Buffer.from(admitted.board, "hex")),
    ),
  );
const settled = (r: Report) =>
  admissionSettled(new Map(r.checks.map((c) => [c.id, { status: c.status }])));
const row = (r: Report, id: string) => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};

// Each test verifies a whole bundle (a pairing per membership proof), which
// has taken over the 5-second default on CI's shared runners.
describe("6.1 over the vectors' bundles", { timeout: 60_000 }, () => {
  test("under format 4, 5.8 never runs, so 6.1 is never reached", () => {
    const r = bundle();
    expect(settled(r)).toBe(false);
    expect(row(r, "6.1")).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
    expect(r.ballots).not.toHaveProperty("selected");
  });

  test("with every admission row settled, a copy 4.1 and 4.2 don't authenticate still isn't selected from", () => {
    // A run whose head is after close rejects every reference, so every
    // admission row passes or fails.
    const blocks = run(21_000_000n, [OPENS - L1_REF_MARGIN - 12n, CLOSES + 12n]).map((h) =>
      toHex(h.encoded),
    );
    const r = bundle(blocks);
    for (const id of ["5.1", "5.2", "5.3", "5.4", "5.5", "5.7", "5.8"])
      expect(row(r, id).status).not.toBe("unverifiable");
    expect(settled(r)).toBe(true);
    expect([row(r, "4.1").status, row(r, "4.2").status]).not.toEqual(["pass", "pass"]);
    expect(row(r, "6.1")).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
    expect(r.ballots).not.toHaveProperty("ties");
  });

  test("a pending reference leaves 6.1 not reached", () => {
    const blocks = run(21_000_000n, [OPENS - L1_REF_MARGIN - 12n, CLOSES]).map((h) =>
      toHex(h.encoded),
    );
    const r = bundle(blocks);
    expect(row(r, "5.8").code).toBe("l1-ref-pending");
    expect(settled(r)).toBe(false);
    expect(row(r, "6.1")).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
  });

  test("a definition that stops the board checks leaves 6.1 not reached, as it does 5.8", () => {
    const blocks = run(21_000_000n, [OPENS - L1_REF_MARGIN - 12n, CLOSES + 12n]).map((h) =>
      toHex(h.encoded),
    );
    const r = verifyBundle(
      parseBundle(
        JSON.stringify({
          format: BUNDLE_FORMAT_BLOCKS,
          definition: admitted.definition.slice(0, -2),
          clock: file.clock,
          l1: {
            firstSegment: closed.firstSegment,
            header: closed.block.header,
            nodes: closed.nodes,
            checkpoints: closed.checkpoints,
          },
          panel: file.panels[admitted.panel],
          l1Blocks: blocks,
        }),
        Uint8Array.from(Buffer.from(admitted.board, "hex")),
      ),
    );
    expect(row(r, "2.1").status).toBe("fail");
    expect(row(r, "5.8")).toEqual({ status: "unverifiable", code: "not-reached" });
    expect(row(r, "6.1")).toEqual({ status: "unverifiable", code: "not-reached" });
  });
});
