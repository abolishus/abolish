import { CONTRACT_EVENT_SIGNATURES, type ContractRole } from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { CONTRACT_NAMES, type ContractName } from "../src/env.ts";
import { INDEXED_ABIS, indexedEvents } from "../src/events.ts";

const ROLE: Record<ContractName, ContractRole> = {
  ElectionRegistry: "election-registry",
  TrusteeRegistry: "trustee-registry",
  GroupRegistry: "group-registry",
  Board: "board",
};

// The newest version a deployable board emits: an event it adds must be
// indexed before any profile can pin it. Versions 10 and 11 add the rolling
// ballot events, which the board's ABI gains with its rolling calls (P2-17
// part 5); until then the registry refuses every definition that needs them.
const latest = 9;

const subscribed = (contract: ContractName) =>
  indexedEvents()
    .filter((e) => e.startsWith(`${contract}:`))
    .map((e) => e.slice(contract.length + 1));

describe("indexedEvents", () => {
  test("subscribes every event of each contract's ABI once, by a name Ponder can resolve", () => {
    for (const contract of CONTRACT_NAMES) {
      const names = (INDEXED_ABIS[contract] as readonly { type: string; name?: string }[])
        .filter((item) => item.type === "event")
        .map((item) => item.name);
      expect(names.length, contract).toBeGreaterThan(0);
      // An overloaded event would need Ponder's `Name(types)` form.
      expect(new Set(names).size, contract).toBe(names.length);
      expect(subscribed(contract), contract).toEqual(names);
    }
    expect(indexedEvents().length).toBe(new Set(indexedEvents()).size);
  });

  test(`covers every event of contract-event version ${latest}'s table for each role`, () => {
    for (const contract of CONTRACT_NAMES) {
      const table = CONTRACT_EVENT_SIGNATURES[latest][ROLE[contract]].map((s) =>
        s.slice(0, s.indexOf("(")),
      );
      expect(table.length, contract).toBeGreaterThan(0);
      expect(subscribed(contract), contract).toEqual(expect.arrayContaining(table));
    }
  });
});
