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
// contract-event-v5.json (version 5, with the obligation root's),
// contract-event-v6.json (version 6, with the group registry's Tier 1
// addition), contract-event-v7.json (version 7, with its two self-paid
// events) and contract-event-v8.json (version 8, with the board's two
// availability events), written by independent generators. The board
// declares version 8's eleven, so only version 8 is compared with it, and the
// group registry declares version 7's seven, so only versions 7 and 8 are
// compared with it: no board with the availability calls may be deployed
// beside a registry that serves a profile pinning versions 1 to 7, and no
// group registry with the self-paid calls beside one that serves a profile
// pinning versions 1 to 6 (contracts.md, Contract-event record, Event tables
// (versions 7 and 8)). The group registry's two nullifier-key events join the
// tables in a later version (contracts.md, Group registry, Events), so they
// are compared apart: declared exactly as the spec lists them, and in no
// version's table yet.

import { readdirSync, readFileSync } from "node:fs";
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
// eleven, version 3's six, version 4's eight and versions 5 to 7 nine.
// Versions 1 to 5 name four of the group registry's seven events, and
// version 6 five.
const cases = [
  ...registries.map(([role, abi]) => ["contract-event.json", role, abi] as const),
  ...registries.map(([role, abi]) => ["contract-event-v2.json", role, abi] as const),
  ...registries.map(([role, abi]) => ["contract-event-v3.json", role, abi] as const),
  ...registries.map(([role, abi]) => ["contract-event-v4.json", role, abi] as const),
  ...registries.map(([role, abi]) => ["contract-event-v5.json", role, abi] as const),
  ...registries.map(([role, abi]) => ["contract-event-v6.json", role, abi] as const),
  ...[...registries, groupRegistry].map(
    ([role, abi]) => ["contract-event-v7.json", role, abi] as const,
  ),
  ...[...registries, groupRegistry, board].map(
    ([role, abi]) => ["contract-event-v8.json", role, abi] as const,
  ),
];

// The events a contract declares that no version's table lists yet.
const pending: Readonly<Record<string, readonly { signature: string; indexed: string[] }[]>> = {
  "group-registry": [
    { signature: "NullifierKeyRecorded(bytes32,bytes)", indexed: ["keyId"] },
    {
      signature: "NullifierKeyReshared(bytes32,bytes32,bytes32,bytes)",
      indexed: ["predecessor", "keyId", "newPanelId"],
    },
  ],
};

function declaredEvents(abi: readonly AbiItem[]) {
  const events = abi.filter((item) => item.type === "event");
  expect(events.every((e) => e.anonymous !== true)).toBe(true);
  return events
    .map((e) => ({
      signature: `${e.name ?? ""}(${(e.inputs ?? []).map((i) => i.type).join(",")})`,
      indexed: (e.inputs ?? []).filter((i) => i.indexed === true).map((i) => i.name),
    }))
    .sort((a, b) => a.signature.localeCompare(b.signature));
}

const isPending = (role: string, signature: string) =>
  (pending[role] ?? []).some((e) => e.signature === signature);

describe("contract-event tables", () => {
  test.each(cases)("%s: %s declares exactly its table's events", (file, role, abi) => {
    const vectors = load(file);
    const declared = declaredEvents(abi).filter((e) => !isPending(role, e.signature));
    const table = vectors.events
      .filter((e) => e.role === role)
      .map((e) => ({ signature: e.signature, indexed: [...e.indexed] }))
      .sort((a, b) => a.signature.localeCompare(b.signature));
    expect(table.length).toBeGreaterThan(0);
    expect(declared).toEqual(table);
  });

  test("the group registry declares its two nullifier-key events, which no table lists yet", () => {
    const declared = declaredEvents(groupRegistryAbi).filter((e) =>
      isPending("group-registry", e.signature),
    );
    expect(declared).toEqual(pending["group-registry"]);
    const files = readdirSync(new URL("../../../docs/spec/vectors/", import.meta.url)).filter((f) =>
      /^contract-event(-v\d+)?\.json$/.test(f),
    );
    expect(files.length).toBeGreaterThanOrEqual(8);
    for (const file of files)
      for (const e of load(file).events)
        expect(isPending(e.role, e.signature), `${file}: ${e.signature}`).toBe(false);
  });
});
