import { readFileSync } from "node:fs";

import { decodeElectionDefinition, encodeElectionDefinition } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { definitionView } from "../src/poll.ts";
import { fromHex, toHex } from "../src/values.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

interface Vector {
  id: string;
  value?: {
    election_id: string;
    election_type: string;
    option_count: string;
    threshold: string;
    panel_size: string;
    opens_at: string;
    closes_at: string;
    electorate: { tier: string; group_size: string }[];
  };
  encoding: string;
  hash?: string;
  illFormed?: string;
  error?: string;
}

// The published cross-language vectors (docs/spec/vectors), never values
// computed by the code under test.
const vectors = (
  JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
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
      const value = v.value!; // filtered above
      const result = definitionView(value.election_id, v.encoding);
      if (!result.ok) throw new Error(`refused: ${result.problem}`);
      const { poll } = result;
      expect(poll.definitionHash).toBe(v.hash);
      expect(poll.illFormed).toBe(v.illFormed);
      expect(poll.electionType).toBe(value.election_type === "2" ? "approval" : "plurality");
      expect(poll.optionCount).toBe(Number(value.option_count));
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
      const other = v.value!.election_id.replace(/^./, (c) => (c === "0" ? "1" : "0"));
      expect(definitionView(other, v.encoding)).toEqual({
        ok: false,
        problem: "another-election",
      });
    }
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
    const bytes = fromHex(typical.encoding);
    fc.assert(
      fc.property(fc.nat(bytes.length - 1), fc.integer({ min: 1, max: 255 }), (at, flip) => {
        const mutated = bytes.slice();
        mutated[at]! ^= flip; // `at` is in range
        const result = definitionView(typical.value!.election_id, toHex(mutated));
        if (result.ok) expect(result.poll.definitionHash).not.toBe(typical.hash);
      }),
      runs,
    );
  });

  test("shows the raw seconds of an instant past what Date holds", () => {
    const typical = decodable[0]!;
    const far = encodeElectionDefinition({
      ...decodeElectionDefinition(fromHex(typical.encoding)),
      closes_at: (1n << 64n) - 1n,
    });
    const result = definitionView(typical.value!.election_id, toHex(far));
    if (!result.ok) throw new Error(result.problem);
    expect(result.poll.closesAt).toEqual({ seconds: "18446744073709551615", iso: undefined });
  });
});
