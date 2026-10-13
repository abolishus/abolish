import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";

import { cellPosition, layoutBoard } from "../src/lib/board-layout.ts";
import { auditPath } from "../src/lib/board-tree.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

/**
 * The sides docs/spec/board.md's verification loop (RFC 9162 §2.1.3.2) puts
 * each hash of a path on, for a path of `length` hashes; undefined if the
 * loop fails.
 */
function verifierSides(index: number, size: number, length: number): string[] | undefined {
  let fn = index;
  let sn = size - 1;
  const sides: string[] = [];
  for (let p = 0; p < length; p++) {
    if (sn === 0) return undefined;
    if (fn % 2 === 1 || fn === sn) {
      sides.push("left");
      if (fn % 2 === 0) while (fn % 2 === 0 && fn !== 0) [fn, sn] = [fn >> 1, sn >> 1];
    } else sides.push("right");
    [fn, sn] = [fn >> 1, sn >> 1];
  }
  return sn === 0 ? sides : undefined;
}

const leafOf = fc
  .integer({ min: 1, max: 1 << 20 })
  .chain((size) => fc.tuple(fc.integer({ min: 0, max: size - 1 }), fc.constant(size)));

describe("auditPath", () => {
  it("puts every hash on the side the spec's verifier reads it from", () => {
    fc.assert(
      fc.property(leafOf, ([index, size]) => {
        const path = auditPath(index, size);
        expect(path.map((s) => s.side)).toEqual(verifierSides(index, size, path.length));
      }),
      { numRuns },
    );
  });

  it("grows the running node by its sibling, from the leaf to the whole tree", () => {
    fc.assert(
      fc.property(leafOf, ([index, size]) => {
        let running = { from: index, to: index + 1 };
        for (const step of auditPath(index, size)) {
          const [left, right] =
            step.side === "left" ? [step.sibling, running] : [running, step.sibling];
          expect(left.to).toBe(right.from);
          expect(step.parent).toEqual({ from: left.from, to: right.to });
          running = step.parent;
        }
        expect(running).toEqual({ from: 0, to: size });
      }),
      { numRuns },
    );
  });

  it("has no hashes for a tree of one, and refuses a leaf outside the tree", () => {
    expect(auditPath(0, 1)).toEqual([]);
    expect(() => auditPath(3, 3)).toThrow(RangeError);
    expect(() => auditPath(0, 0)).toThrow(RangeError);
  });
});

describe("layoutBoard", () => {
  const options = (sizes: number[], width: number, maxHeight = 400) => {
    let first = 0;
    const segments = sizes.map((size) => {
      const s = { first, size };
      first += size;
      return s;
    });
    return {
      segments,
      range: { from: 0, to: first },
      width,
      maxHeight,
      maxPitch: 12,
      minRows: 3,
      gap: 6,
      labelWidth: 48,
      lanes: { label: 18, rule: 6, group: 20, mine: 26, between: 10 },
    };
  };

  it("gives every entry its own cell, inside its block and the width", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 400 }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 40, max: 1200 }),
        (sizes, width) => {
          const layout = layoutBoard(options(sizes, width));
          const seen = new Set<string>();
          for (const block of layout.blocks) {
            for (let i = block.first; i < block.first + block.size; i++) {
              const { x, y } = cellPosition(layout, block, i);
              expect(x + layout.cell).toBeLessThanOrEqual(width);
              expect(x).toBeGreaterThanOrEqual(block.x);
              expect(x).toBeLessThan(block.x + block.width);
              expect(y + layout.cell).toBeLessThanOrEqual(layout.height);
              seen.add(`${x},${y}`);
            }
          }
          expect(seen.size).toBe(sizes.reduce((a, b) => a + b, 0));
        },
      ),
      { numRuns },
    );
  });

  it("draws a board of 161,874 entries at one entry per cell", () => {
    const hours = [
      8, 5_596, 9_134, 8_672, 9_778, 11_917, 13_173, 14_662, 15_538, 13_482, 13_340, 14_110, 13_450,
      9_520, 9_122, 372,
    ];
    const layout = layoutBoard(options(hours, 2176, 1200));
    expect(layout.blocks.reduce((n, b) => n + b.size, 0)).toBe(161_874);
    expect(layout.height).toBeLessThanOrEqual(1200);
  });
});
