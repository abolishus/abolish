import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  PARAMETERS,
  rollingNullifierScope,
  semaphoreField,
  tierTreeRoot,
  tierTreeZeros,
} from "../src/index.ts";
import { memberCount, type RollingEvent, rollingLeaves, tau } from "./rolling-tree.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/rolling-tier-tree.json, printed by
// scripts/rolling-electorate-vectors.py (P2-17 part 1). The rolling scope is
// packages/crypto's (part 3a; the definition's vectors are in
// definition-v7-vectors.test.ts). packages/crypto has no rolling tree yet
// (part 3b), so these tests read the rolling tier tree and the root clock from
// docs/spec/membership.md directly, with only the tier tree's root taken from
// packages/crypto.
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface RollingTree {
  readonly leaves: readonly string[];
  readonly root: string;
  readonly memberCount: string;
}

interface RollingFile {
  readonly format: string;
  readonly rootPeriod: string;
  readonly rootOffset: string;
  readonly rootWindow: string;
  readonly trees: readonly {
    readonly id: string;
    readonly groups: readonly string[];
    readonly events: readonly RollingEvent[];
    readonly rootL2Block: string;
    readonly registeredAt: string;
    readonly closesAt: string;
    readonly opening: RollingTree;
    readonly steps: readonly (RollingTree & {
      readonly step: string;
      readonly tau: string;
      readonly accepted: boolean;
    })[];
  }[];
  readonly windows: readonly {
    readonly id: string;
    readonly step: string;
    readonly l1Timestamp: string;
    readonly window: "in" | "stale" | "future";
  }[];
  readonly scopes: readonly {
    readonly id: string;
    readonly definitionHash: string;
    readonly tier: number;
    readonly scope: string;
    readonly scopeField: string;
  }[];
}

describe("rolling tier trees (docs/spec/membership.md, Rolling tier tree, Root clock and steps)", () => {
  const rolling = JSON.parse(
    readFileSync(new URL("rolling-tier-tree.json", SPEC_VECTORS), "utf8"),
  ) as RollingFile;
  const z32 = tierTreeZeros()[32]!;

  test("carries the root clock's parameters", () => {
    expect(rolling.format).toBe("abolish-rolling-tier-tree-vectors/1");
    expect(rolling.rootPeriod).toBe(String(PARAMETERS.ROOT_PERIOD));
    expect(rolling.rootOffset).toBe(String(PARAMETERS.ROOT_OFFSET));
    expect(rolling.rootWindow).toBe(String(PARAMETERS.ROOT_WINDOW));
  });

  const check = (leaves: bigint[], want: RollingTree) => {
    expect(leaves.map(String)).toEqual(want.leaves);
    expect(String(tierTreeRoot(leaves))).toBe(want.root);
    expect(String(memberCount(leaves))).toBe(want.memberCount);
  };

  test.each(rolling.trees.map((t) => [t.id, t] as const))("%s", (_id, t) => {
    check(
      rollingLeaves(t.events, t.groups, (e) => BigInt(e.block) <= BigInt(t.rootL2Block)),
      t.opening,
    );
    for (const s of t.steps) {
      const boundary = tau(BigInt(s.step));
      expect(String(boundary)).toBe(s.tau);
      const leaves = rollingLeaves(t.events, t.groups, (e) => BigInt(e.timestamp) <= boundary);
      check(leaves, s);
      const accepted =
        boundary > BigInt(t.registeredAt) &&
        boundary <= BigInt(t.closesAt) &&
        leaves.length <= 2 ** 32 &&
        tierTreeRoot(leaves) !== z32;
      expect(accepted).toBe(s.accepted);
    }
  });

  test("covers accepted and refused steps, an empty opening and a repeated commitment", () => {
    const steps = rolling.trees.flatMap((t) => t.steps);
    expect(new Set(steps.map((s) => s.accepted))).toEqual(new Set([true, false]));
    expect(rolling.trees.some((t) => t.opening.root === String(z32))).toBe(true);
    // A repeat keeps its leaf but never counts twice.
    expect(
      steps.some((s) => s.leaves.filter((x) => x !== "0").length > Number(s.memberCount)),
    ).toBe(true);
  });

  test.each(rolling.windows.map((w) => [w.id, w] as const))("window %s", (_id, w) => {
    const boundary = tau(BigInt(w.step));
    const t = BigInt(w.l1Timestamp);
    const window = BigInt(PARAMETERS.ROOT_WINDOW);
    const verdict = boundary > t ? "future" : boundary <= t - window ? "stale" : "in";
    expect(verdict).toBe(w.window);
  });

  test.each(rolling.scopes.map((s) => [s.id, s] as const))("scope %s", (_id, s) => {
    const scope = rollingNullifierScope(hex(s.definitionHash), s.tier);
    expect(toHex(scope)).toBe(s.scope);
    expect(String(semaphoreField(scope))).toBe(s.scopeField);
  });
});
