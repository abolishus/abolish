// The contract-event record's event tables (docs/spec/contracts.md,
// Contract-event record) against the contracts' compiled ABI, through the
// generated bindings: each L2 contract declares exactly the events its table
// lists, with the same signature and indexed parameters, so a contract that
// gains, loses or changes an event fails here before its logs could fail
// verifier 4.4 (T-17, T-71). The tables come from
// docs/spec/vectors/contract-event.json (version 1, the three registries),
// contract-event-v2.json (version 2, with the board's four delivery and ballot
// events), contract-event-v3.json (version 3, with the close rule's two),
// contract-event-v4.json (version 4, with the two batches'),
// contract-event-v5.json (version 5, with the obligation root's) and
// contract-event-v6.json (version 6, with the group registry's Tier 1
// addition), written by independent generators. The board declares version
// 5's nine, so only versions 5 and 6 are compared with it, and the group
// registry declares version 6's five, so only version 6 is compared with it:
// no board with the root call may be deployed beside a registry that serves
// a profile pinning versions 1 to 4, and no group registry with the Tier 1
// call beside one that serves a profile pinning versions 1 to 5
// (contracts.md, Contract-event record, Event tables (versions 5 and 6)).

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  boardAbi,
  electionRegistryAbi,
  groupRegistryAbi,
  trusteeRegistryAbi,
} from "../src/generated/abi.ts";

interface Vectors {
  readonly events: readonly {
    readonly role: string;
    readonly signature: string;
    readonly indexed: readonly string[];
  }[];
}

const load = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../docs/spec/vectors/${file}`, import.meta.url), "utf8"),
  ) as Vectors;

interface AbiItem {
  readonly type: string;
  readonly name?: string;
  readonly anonymous?: boolean;
  readonly inputs?: readonly {
    readonly name: string;
    readonly type: string;
    readonly indexed?: boolean;
  }[];
}

const registries: readonly [string, readonly AbiItem[]][] = [
  ["election-registry", electionRegistryAbi],
  ["trustee-registry", trusteeRegistryAbi],
];

const groupRegistry: readonly [string, readonly AbiItem[]] = ["group-registry", groupRegistryAbi];
const board: readonly [string, readonly AbiItem[]] = ["board", boardAbi];

// Version 1's tables name no board event; version 2's name four of its
// nine, version 3's six and version 4's eight. Versions 1 to 5 name four of
// the group registry's five events.
const cases = [
  ...registries.map(([role, abi]) => ["contract-event.json", role, abi] as const),
  ...registries.map(([role, abi]) => ["contract-event-v2.json", role, abi] as const),
  ...registries.map(([role, abi]) => ["contract-event-v3.json", role, abi] as const),
  ...registries.map(([role, abi]) => ["contract-event-v4.json", role, abi] as const),
  ...[...registries, board].map(([role, abi]) => ["contract-event-v5.json", role, abi] as const),
  ...[...registries, groupRegistry, board].map(
    ([role, abi]) => ["contract-event-v6.json", role, abi] as const,
  ),
];

describe("contract-event tables", () => {
  test.each(cases)("%s: %s declares exactly its table's events", (file, role, abi) => {
    const vectors = load(file);
    const events = abi.filter((item) => item.type === "event");
    expect(events.every((e) => e.anonymous !== true)).toBe(true);
    const declared = events
      .map((e) => ({
        signature: `${e.name ?? ""}(${(e.inputs ?? []).map((i) => i.type).join(",")})`,
        indexed: (e.inputs ?? []).filter((i) => i.indexed === true).map((i) => i.name),
      }))
      .sort((a, b) => a.signature.localeCompare(b.signature));
    const table = vectors.events
      .filter((e) => e.role === role)
      .map((e) => ({ signature: e.signature, indexed: [...e.indexed] }))
      .sort((a, b) => a.signature.localeCompare(b.signature));
    expect(table.length).toBeGreaterThan(0);
    expect(declared).toEqual(table);
  });
});
