import { describe, expect, test, vi } from "vite-plus/test";

// tally-conflict needs two different passing openings of one cell, which
// exist only if log_g h is known, so no vector can reach the check. Here
// `h` is replaced by g^x for a known x: (V, R) and (V + x, R − 1) then both
// open g^V · h^R, and the cell must fail tally-conflict in either board order
// (docs/spec/tally.md, Opening checks; T-29).
const X = 0x1234_5678_9abcn;

vi.mock("../src/group.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/group.ts")>();
  return { ...real, GENERATOR_H: real.G.multiply(X) };
});

const {
  aggregateCell,
  aggregateHash,
  checkTally,
  encodeTallyOpening,
  G,
  GENERATOR_H,
  GROUP_ORDER,
  signTallyOpening,
} = await import("../src/index.ts");

describe("tally-conflict", () => {
  test("two different passing openings of one cell fail it, in either order", () => {
    expect(GENERATOR_H.equals(G.multiply(X))).toBe(true);
    const rules = { optionCount: 2, threshold: 2, panelSize: 3 };
    const [v, r] = [1n, 5n];
    const c = G.multiply(v).add(GENERATOR_H.multiply(r));
    // One ballot: option 0 commits to (1, 5), option 1 to (0, 7); the higher
    // VSS commitments are irrelevant to an opening and set to g.
    const ballots = [
      [
        [c, G],
        [GENERATOR_H.multiply(7n), G],
      ],
    ];
    const aggregate_hash = aggregateHash(aggregateCell(rules, ballots));
    const definition_hash = new Uint8Array(32);
    const record = (opening: { v: bigint; r: bigint }[]) =>
      encodeTallyOpening(
        signTallyOpening(
          Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)),
          {
            definition_hash,
            cell: 0,
            aggregate_hash,
            signer: 1,
            opening,
          },
        ),
      );
    const honest = record([
      { v, r },
      { v: 0n, r: 7n },
    ]);
    const forged = record([
      { v: (v + X) % GROUP_ORDER, r: (r - 1n + GROUP_ORDER) % GROUP_ORDER },
      { v: 0n, r: 7n },
    ]);
    const election = { definitionHash: definition_hash, rules, registered: [] };
    for (const board of [
      [honest, forged],
      [forged, honest],
    ]) {
      const result = checkTally(election, [ballots], board, 1);
      expect(result.cells[0]?.passing).toHaveLength(2);
      expect(result.failure).toEqual({ cell: 0, code: "tally-conflict" });
    }
    // One of them alone passes: the check, not the openings, is what fails the cell.
    expect(checkTally(election, [ballots], [honest], 1).ok).toBe(true);
  });
});
