import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  PARAMETERS,
  rollingNullifierScope,
  rollingTierSteps,
  RollingTierTree,
  rootClockBoundary,
  rootStepWindow,
  semaphoreField,
  tierTreeZeros,
} from "../src/index.ts";
import { type RollingEvent, tierEvent } from "./rolling-tree.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// docs/spec/vectors/rolling-tier-tree.json, printed by
// scripts/rolling-electorate-vectors.py (P2-17 part 1), through packages/crypto's
// rolling tier tree, root clock and window (part 3b) and rolling scope (part
// 3a; the definition's vectors are in definition-v7-vectors.test.ts).
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

  const ctx = (t: RollingFile["trees"][number]) => ({
    groups: t.groups.map(BigInt),
    rootL2Block: BigInt(t.rootL2Block),
    registeredAt: BigInt(t.registeredAt),
    closesAt: BigInt(t.closesAt),
  });

  test.each(rolling.trees.map((t) => [t.id, t] as const))("%s", (_id, t) => {
    const events = t.events.map(tierEvent);
    const got = rollingTierSteps(
      events,
      ctx(t),
      t.steps.map((s) => BigInt(s.step)),
    );
    expect(String(got.opening.root)).toBe(t.opening.root);
    expect(String(got.opening.memberCount)).toBe(t.opening.memberCount);
    expect(got.steps.map((s) => String(s.step))).toEqual(t.steps.map((s) => s.step));
    for (const [i, s] of t.steps.entries()) {
      const step = got.steps[i]!;
      expect(String(rootClockBoundary(step.step))).toBe(s.tau);
      expect(String(step.root)).toBe(s.root);
      expect(String(step.memberCount)).toBe(s.memberCount);
      expect(step.size).toBe(s.leaves.length);
      expect(step.accepted).toBe(s.accepted);
      // The leaves themselves, from the tree updated in chain order.
      const tree = new RollingTierTree(ctx(t).groups);
      for (const e of events) if (e.timestamp <= rootClockBoundary(step.step)) tree.apply(e);
      expect(tree.leaves.map(String)).toEqual(s.leaves);
      expect(String(tree.root())).toBe(s.root);
    }
    const opening = new RollingTierTree(ctx(t).groups);
    for (const e of events) if (e.blockNumber <= BigInt(t.rootL2Block)) opening.apply(e);
    expect(opening.leaves.map(String)).toEqual(t.opening.leaves);
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
    expect(rootStepWindow(BigInt(w.step), BigInt(w.l1Timestamp))).toBe(w.window);
  });

  test.each(rolling.scopes.map((s) => [s.id, s] as const))("scope %s", (_id, s) => {
    const scope = rollingNullifierScope(hex(s.definitionHash), s.tier);
    expect(toHex(scope)).toBe(s.scope);
    expect(String(semaphoreField(scope))).toBe(s.scopeField);
  });
});
