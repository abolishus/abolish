import { readFileSync } from "node:fs";

import {
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { instant, instructionOf, pollStatus } from "../src/poll.ts";
import { definitionView } from "../src/server/definition.ts";
import { fromHex, toHex } from "../src/values.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

interface Vector {
  id: string;
  value?: {
    election_id: string;
    election_type: string;
    option_count: string;
    min_selections: string;
    max_selections: string;
    threshold: string;
    panel_size: string;
    opens_at: string;
    closes_at: string;
    electorate: { tier: string; group_size: string }[];
    ceremony_transcript_hash: string;
  };
  encoding: string;
  hash?: string;
  illFormed?: string;
  error?: string;
}

// The published cross-language vectors (docs/spec/vectors), never values
// computed by the code under test.
const load = <V>(name: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8"),
    ) as { vectors: V[] }
  ).vectors;
const vectors = load<Vector>("election-definition.json");
const decodable = vectors.filter((v) => v.value !== undefined);
const undecodable = vectors.filter((v) => v.error !== undefined);

describe("definitionView", () => {
  test("has vectors of both kinds", () => {
    expect(decodable.length).toBeGreaterThan(10);
    expect(undecodable.length).toBeGreaterThan(10);
  });

  test.each(decodable.map((v) => [v.id, v] as const))(
    "%s: shows the vector's hash, rule and facts",
    (_, v) => {
      const value = v.value!; // `decodable` holds only vectors with a value
      const result = definitionView(value.election_id, v.encoding);
      if (!result.ok) throw new Error(`refused: ${result.problem}`);
      const { poll } = result;
      expect(poll.definitionHash).toBe(v.hash);
      expect(poll.version).toBe(1);
      // Versions 1 and 5 carry no class: everyday polls.
      expect(poll.pollClass).toBe("everyday");
      expect(poll.illFormed).toEqual(
        v.illFormed === undefined ? undefined : { rule: v.illFormed, question: undefined },
      );
      expect(poll.counting).toBe(value.election_type === "2" ? "approval" : "plurality");
      expect(poll.questions).toEqual([
        {
          optionCount: Number(value.option_count),
          minSelections: Number(value.min_selections),
          maxSelections: Number(value.max_selections),
        },
      ]);
      expect(poll.threshold).toBe(Number(value.threshold));
      expect(poll.panelSize).toBe(Number(value.panel_size));
      expect(poll.opensAt.seconds).toBe(value.opens_at);
      expect(poll.closesAt.seconds).toBe(value.closes_at);
      expect(poll.electorate).toEqual(
        value.electorate.map((g) => ({ tier: Number(g.tier), groupSize: g.group_size })),
      );
    },
  );

  test.each(undecodable.map((v) => [v.id, v] as const))("%s: refused as undecodable", (_, v) => {
    expect(definitionView("00".repeat(32), v.encoding)).toEqual({
      ok: false,
      problem: "undecodable",
    });
  });

  test("refuses a definition served for another election (T-34)", () => {
    for (const v of decodable) {
      // `decodable` holds only vectors with a value.
      const other = v.value!.election_id.replace(/^./, (c) => (c === "0" ? "1" : "0"));
      expect(definitionView(other, v.encoding)).toEqual({
        ok: false,
        problem: "another-election",
      });
    }
  });

  test("carries the board-entry version the profile pins, and none unless exactly one", () => {
    const typical = decodable.find((v) => v.id === "definition-typical")!;
    const result = definitionView(typical.value!.election_id, typical.encoding);
    expect(result.ok && result.boardEntryVersion).toBe(1);
    const d = decodeElectionDefinition(fromHex(typical.encoding));
    const others = d.profile.pins.filter((p) => p.record_type !== 7);
    for (const pins of [
      others,
      [...others, { record_type: 7, version: 1 }, { record_type: 7, version: 1 }],
      [...others, { record_type: 7, version: 2 }],
    ]) {
      const encoding = toHex(encodeElectionDefinition({ ...d, profile: { ...d.profile, pins } }));
      const view = definitionView(typical.value!.election_id, encoding);
      // Such a profile breaks a rule the page reports, but it never picks a version for it.
      expect(view.ok && view.boardEntryVersion).toBeUndefined();
    }
  });

  test("carries the transcript hash the definition commits to, pinned only by exactly one version 1", () => {
    const typical = decodable.find((v) => v.id === "definition-typical")!;
    const result = definitionView(typical.value!.election_id, typical.encoding);
    expect(result.ok && result.transcript).toEqual({
      hash: typical.value!.ceremony_transcript_hash,
      pinned: true,
    });
    const d = decodeElectionDefinition(fromHex(typical.encoding));
    const others = d.profile.pins.filter((p) => p.record_type !== 5);
    for (const pins of [
      others,
      [...others, { record_type: 5, version: 1 }, { record_type: 5, version: 1 }],
      [...others, { record_type: 5, version: 2 }],
    ]) {
      const encoding = toHex(encodeElectionDefinition({ ...d, profile: { ...d.profile, pins } }));
      const view = definitionView(typical.value!.election_id, encoding);
      expect(view.ok && view.transcript.pinned).toBe(false);
    }
  });

  test("carries one cell per tier, of its group", () => {
    const typical = decodable.find((v) => v.id === "definition-typical")!;
    const result = definitionView(typical.value!.election_id, typical.encoding);
    expect(result.ok && result.cells).toEqual([
      { tier: 0, members: "5000", regions: undefined },
      { tier: 2, members: "120", regions: undefined },
    ]);
  });

  test("never throws on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), (bytes) => {
        const result = definitionView("00".repeat(32), toHex(bytes));
        if (result.ok) expect(result.poll.electionId).toBe("00".repeat(32));
      }),
      runs,
    );
  });

  test("never throws on a mutated vector, and shows it only if it still decodes to this election", () => {
    const typical = decodable[0]!; // asserted non-empty above
    const electionId = typical.value!.election_id; // `decodable` holds only vectors with a value
    const bytes = fromHex(typical.encoding);
    fc.assert(
      fc.property(fc.nat(bytes.length - 1), fc.integer({ min: 1, max: 255 }), (at, flip) => {
        const mutated = bytes.slice();
        mutated[at]! ^= flip; // `at` is in range
        const mutatedHex = toHex(mutated);
        const result = definitionView(electionId, mutatedHex);
        if (!result.ok) return;
        expect(result.poll.definitionHash).not.toBe(typical.hash);
        // Shown only because it still names this election.
        expect(toHex(decodeElectionDefinition(mutated).election_id)).toBe(electionId);
      }),
      runs,
    );
  });

  test("shows the raw seconds of an instant past what Date holds", () => {
    const typical = decodable[0]!; // asserted non-empty above
    const electionId = typical.value!.election_id; // `decodable` holds only vectors with a value
    const far = encodeElectionDefinition({
      ...decodeElectionDefinition(fromHex(typical.encoding)),
      closes_at: (1n << 64n) - 1n,
    });
    const result = definitionView(electionId, toHex(far));
    if (!result.ok) throw new Error(result.problem);
    expect(result.poll.closesAt).toEqual({ seconds: "18446744073709551615", iso: undefined });
  });
});

interface VectorV5 {
  id: string;
  value?: {
    election_id: string;
    questions: { option_count: string; min_selections: string; max_selections: string }[];
    threshold: string;
    panel_size: string;
    opens_at: string;
    closes_at: string;
    electorate: { tier: string; regions: string[]; cells: { members: string }[] }[];
  };
  encoding: string;
  hash?: string;
  illFormed?: string;
  illFormedQuestion?: string;
  error?: string;
}

const vectorsV5 = load<VectorV5>("election-definition-v5.json");
const decodableV5 = vectorsV5.filter((v) => v.value !== undefined);

describe("definitionView, version 5", () => {
  test("carries version 5's pinned board-entry version", () => {
    const typical = decodableV5.find((v) => v.id === "definition-v5-typical")!;
    const result = definitionView(typical.value!.election_id, typical.encoding);
    expect(result.ok && result.boardEntryVersion).toBe(4);
  });

  test("carries each tier's cells in partition order, with the regions the fold gives them", () => {
    const typical = decodableV5.find((v) => v.id === "definition-v5-typical")!;
    const result = definitionView(typical.value!.election_id, typical.encoding);
    // Regions 5,000, 1,200, 40 and 980: the two large ones alone, the small two folded.
    expect(result.ok && result.cells).toEqual([
      { tier: 0, members: "5000", regions: [0] },
      { tier: 0, members: "1200", regions: [1] },
      { tier: 0, members: "1020", regions: [2, 3] },
      { tier: 2, members: "120", regions: [0] },
    ]);
  });

  test("names no regions for cells that aren't the fold's", () => {
    const typical = decodableV5.find((v) => v.id === "definition-v5-typical")!;
    const d = decodeElectionDefinitionV5(fromHex(typical.encoding));
    const [first, ...rest] = d.electorate;
    // Tier 0's cells stated as one: the rule `cells` fails, and the page says
    // only what the definition states.
    const merged = {
      ...first!,
      cells: [{ root: first!.cells[0]!.root, members: 7220n }],
    };
    const encoding = toHex(encodeElectionDefinitionV5({ ...d, electorate: [merged, ...rest] }));
    const result = definitionView(typical.value!.election_id, encoding);
    expect(result.ok && result.poll.illFormed?.rule).toBe("cells");
    expect(result.ok && result.cells).toEqual([
      { tier: 0, members: "7220", regions: undefined },
      { tier: 2, members: "120", regions: [0] },
    ]);
  });

  test("has vectors of every kind", () => {
    expect(decodableV5.length).toBeGreaterThan(10);
    expect(decodableV5.filter((v) => v.illFormedQuestion !== undefined).length).toBeGreaterThan(5);
    expect(vectorsV5.filter((v) => v.error !== undefined).length).toBeGreaterThan(5);
  });

  test.each(decodableV5.map((v) => [v.id, v] as const))(
    "%s: shows the vector's hash, rule, question and facts",
    (_, v) => {
      const value = v.value!; // `decodableV5` holds only vectors with a value
      const result = definitionView(value.election_id, v.encoding);
      if (!result.ok) throw new Error(`refused: ${result.problem}`);
      const { poll } = result;
      expect(poll.version).toBe(5);
      expect(poll.pollClass).toBe("everyday");
      expect(poll.counting).toBe("questions");
      expect(poll.definitionHash).toBe(v.hash);
      expect(poll.illFormed).toEqual(
        v.illFormed === undefined
          ? undefined
          : {
              rule: v.illFormed,
              question: v.illFormedQuestion === undefined ? undefined : Number(v.illFormedQuestion),
            },
      );
      expect(poll.questions).toEqual(
        value.questions.map((q) => ({
          optionCount: Number(q.option_count),
          minSelections: Number(q.min_selections),
          maxSelections: Number(q.max_selections),
        })),
      );
      expect(poll.threshold).toBe(Number(value.threshold));
      expect(poll.panelSize).toBe(Number(value.panel_size));
      expect(poll.opensAt.seconds).toBe(value.opens_at);
      expect(poll.closesAt.seconds).toBe(value.closes_at);
      // Each tier's members are its region counts' sum.
      expect(poll.electorate).toEqual(
        value.electorate.map((t) => ({
          tier: Number(t.tier),
          groupSize: t.regions.reduce((sum, r) => sum + BigInt(r), 0n).toString(),
        })),
      );
    },
  );

  test("a well-formed tier's members are its cells' members too", () => {
    for (const v of decodableV5.filter((v) => v.illFormed === undefined)) {
      const result = definitionView(v.value!.election_id, v.encoding);
      if (!result.ok) throw new Error(result.problem);
      expect(result.poll.electorate.map((t) => t.groupSize)).toEqual(
        v.value!.electorate.map((t) =>
          t.cells.reduce((sum, c) => sum + BigInt(c.members), 0n).toString(),
        ),
      );
    }
  });

  test.each(vectorsV5.filter((v) => v.error !== undefined).map((v) => [v.id, v] as const))(
    "%s: refused as undecodable",
    (_, v) => {
      expect(definitionView("00".repeat(32), v.encoding)).toEqual({
        ok: false,
        problem: "undecodable",
      });
    },
  );

  // The API stores versions 1 and 5 only; the page guesses at no other.
  test.each([
    "election-definition-v3.json",
    "election-definition-v4.json",
    "election-definition-v6.json",
  ])("refuses every definition of %s as undecodable", (name) => {
    const decodable = load<{ value?: { election_id: string }; encoding: string }>(name).filter(
      (v) => v.value !== undefined,
    );
    expect(decodable.length).toBeGreaterThan(0);
    for (const v of decodable)
      expect(definitionView(v.value!.election_id, v.encoding)).toEqual({
        ok: false,
        problem: "undecodable",
      });
  });

  test("refuses a version-5 definition served for another election (T-34)", () => {
    for (const v of decodableV5) {
      const other = v.value!.election_id.replace(/^./, (c) => (c === "0" ? "1" : "0"));
      expect(definitionView(other, v.encoding)).toEqual({ ok: false, problem: "another-election" });
    }
  });

  test("never throws on a mutated version-5 vector", () => {
    const typical = decodableV5[0]!; // asserted non-empty above
    const electionId = typical.value!.election_id;
    const bytes = fromHex(typical.encoding);
    fc.assert(
      fc.property(fc.nat(bytes.length - 1), fc.integer({ min: 1, max: 255 }), (at, flip) => {
        const mutated = bytes.slice();
        mutated[at]! ^= flip; // `at` is in range
        const result = definitionView(electionId, toHex(mutated));
        if (result.ok) expect(result.poll.definitionHash).not.toBe(typical.hash);
      }),
      runs,
    );
  });
});

interface VectorV7 {
  id: string;
  value?: {
    election_id: string;
    electorate_mode: string;
    poll_class: string;
    electorate: { tier: string; regions: string[]; cells: { members: string }[] }[];
    rolling_electorate: { tier: string; group_size: string }[];
  };
  encoding: string;
  hash?: string;
  illFormed?: string;
  error?: string;
}

const vectorsV7 = load<VectorV7>("election-definition-v7.json");
const decodableV7 = vectorsV7.filter((v) => v.value !== undefined);

// Version 7 (P2-17): version 5's questions with an electorate mode. A rolling
// tier is one cell whose count is its members at the opening root, which is
// all the definition states: whoever joins by the close can answer too
// ([[0028-rolling-electorates]]; T-01, T-16, T-34).
describe("definitionView, version 7", () => {
  test("has rolling and fixed vectors, well formed and not", () => {
    const rolling = decodableV7.filter((v) => v.value!.electorate_mode === "2");
    expect(rolling.filter((v) => v.illFormed === undefined).length).toBeGreaterThan(1);
    expect(rolling.filter((v) => v.illFormed !== undefined).length).toBeGreaterThan(5);
    expect(decodableV7.filter((v) => v.value!.electorate_mode === "1").length).toBeGreaterThan(1);
    expect(vectorsV7.filter((v) => v.error !== undefined).length).toBeGreaterThan(5);
    expect(new Set(decodableV7.map((v) => v.value!.poll_class))).toEqual(new Set(["1", "2", "3"]));
  });

  test.each(decodableV7.map((v) => [v.id, v] as const))(
    "%s: its version, hash, first broken rule, mode, electorate and cells",
    (_, v) => {
      const value = v.value!; // `decodableV7` holds only vectors with a value
      const result = definitionView(value.election_id, v.encoding);
      if (!result.ok) throw new Error(`refused: ${result.problem}`);
      expect(result.poll.version).toBe(7);
      expect(result.poll.definitionHash).toBe(v.hash);
      expect(result.poll.illFormed?.rule).toBe(v.illFormed);
      expect(result.poll.counting).toBe("questions");
      // The class as the definition states it, on the civic record or not (T-14).
      expect(result.poll.pollClass).toBe(
        ({ "1": "everyday", "2": "organisational", "3": "civic" } as const)[
          value.poll_class as "1" | "2" | "3"
        ],
      );
      const rolling = value.electorate_mode === "2";
      expect(result.poll.rolling).toBe(rolling);
      if (rolling) {
        const tiers = value.rolling_electorate.map((t) => ({
          tier: Number(t.tier),
          groupSize: t.group_size,
        }));
        expect(result.poll.electorate).toEqual(tiers);
        expect(result.cells).toEqual(
          tiers.map((t) => ({ tier: t.tier, members: t.groupSize, regions: undefined })),
        );
      } else {
        expect(result.poll.electorate).toEqual(
          value.electorate.map((t) => ({
            tier: Number(t.tier),
            groupSize: t.regions.reduce((sum, r) => sum + BigInt(r), 0n).toString(),
          })),
        );
        expect(result.cells.map((c) => [c.tier, c.members])).toEqual(
          value.electorate.flatMap((t) => t.cells.map((c) => [Number(t.tier), c.members])),
        );
      }
    },
  );

  test("a question rule names its question, as under version 5", () => {
    const v = decodableV7.find((x) => x.id === "definition-v7-selections-and-electorate-broken")!;
    const result = definitionView(v.value!.election_id, v.encoding);
    expect(result.ok && result.poll.illFormed).toEqual({
      rule: "selections",
      question: expect.any(Number),
    });
  });

  test.each(vectorsV7.filter((v) => v.error !== undefined).map((v) => [v.id, v] as const))(
    "%s is refused as undecodable",
    (_, v) => {
      expect(definitionView("00".repeat(32), v.encoding)).toEqual({
        ok: false,
        problem: "undecodable",
      });
    },
  );

  test("names another election as such", () => {
    const v = decodableV7[0]!;
    const other = v.value!.election_id.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    expect(definitionView(other, v.encoding)).toEqual({ ok: false, problem: "another-election" });
  });
});

describe("instructionOf", () => {
  const q = (optionCount: number, minSelections: number, maxSelections: number) => ({
    optionCount,
    minSelections,
    maxSelections,
  });

  test("words the owner's four methods from their limits", () => {
    expect(instructionOf(q(3, 0, 1))).toEqual({ kind: "one" });
    expect(instructionOf(q(5, 0, 5))).toEqual({ kind: "any" });
    expect(instructionOf(q(4, 0, 2))).toEqual({ kind: "upTo", max: 2 });
    expect(instructionOf(q(6, 3, 3))).toEqual({ kind: "exactly", count: 3 });
  });

  test("words every other range as at least N or N to M", () => {
    expect(instructionOf(q(2, 1, 1))).toEqual({ kind: "exactly", count: 1 });
    expect(instructionOf(q(4, 1, 4))).toEqual({ kind: "atLeast", min: 1 });
    expect(instructionOf(q(5, 2, 3))).toEqual({ kind: "between", min: 2, max: 3 });
  });

  test("names only the question's own limits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 64 }), fc.nat(64), fc.nat(64), (m, a, b) => {
        const [min, max] = [Math.min(a, b, m), Math.min(Math.max(a, b), m)];
        if (max === 0) return;
        const i = instructionOf(q(m, min, max));
        const named = Object.entries(i)
          .filter(([k]) => k !== "kind")
          .map(([, v]) => v as number);
        for (const n of named) expect([min, max]).toContain(n);
      }),
      runs,
    );
  });
});

describe("pollStatus", () => {
  const U64_MAX = 2n ** 64n - 1n;
  const u64 = fc.bigInt({ min: 0n, max: U64_MAX });

  test("is scheduled before opens_at, open through closes_at and closed after", () => {
    fc.assert(
      fc.property(u64, u64, u64, (opens, closes, now) => {
        const status = pollStatus(
          { opensAt: instant(opens), closesAt: instant(closes) },
          instant(now),
        );
        expect(status).toBe(now < opens ? "scheduled" : now <= closes ? "open" : "closed");
      }),
      runs,
    );
  });

  test("decides at the boundaries by the second, past what Date holds too", () => {
    const poll = { opensAt: instant(100n), closesAt: instant(U64_MAX - 1n) };
    expect(pollStatus(poll, instant(99n))).toBe("scheduled");
    expect(pollStatus(poll, instant(100n))).toBe("open");
    expect(pollStatus(poll, instant(U64_MAX - 1n))).toBe("open");
    expect(pollStatus(poll, instant(U64_MAX))).toBe("closed");
  });
});
