// Check 4's refusal of a rolling stub is the node's own: approving one also
// needs version-5 intake and the served record's rolling flag ([[P2-17]]
// part 7c-3b), so it holds even if crypto's capacity check one day fits a
// set holding a rolling election (T-25, T-52, T-54).
import {
  encodeElectionDefinitionV5,
  encodeElectionDefinitionV7,
  forcedPathFits,
} from "@abolishus/crypto";
import { expect, test, vi } from "vite-plus/test";
import { checkStub, type Pins } from "../src/index.ts";
import { L2_CHAIN_ID, panelOf, rollingStubFor, stubV5For, TRUSTEE_REGISTRY } from "./fixture.ts";

vi.mock(import("@abolishus/crypto"), async (original) => ({
  ...(await original()),
  forcedPathFits: vi.fn(() => true),
}));

const { panel } = panelOf(4, 2);
const pins: Pins = { panel, l2ChainId: L2_CHAIN_ID, trusteeRegistry: TRUSTEE_REGISTRY };
const pass = () => Promise.resolve(true);

test("refuses a rolling stub at check 4 even where the capacity check would fit it", async () => {
  // The mock is in force: a fixed stub of any size fits.
  expect(
    (await checkStub(encodeElectionDefinitionV5(stubV5For(panel)), pins, pass, new Map())).ok,
  ).toBe(true);
  expect(vi.mocked(forcedPathFits)).toHaveBeenCalled();
  expect(
    await checkStub(encodeElectionDefinitionV7(rollingStubFor(panel)), pins, pass, new Map()),
  ).toEqual({ ok: false, code: "stub-capacity" });
});
