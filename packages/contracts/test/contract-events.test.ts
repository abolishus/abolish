// The contract-event record's event tables (docs/spec/contracts.md,
// Contract-event record) against the contracts' compiled ABI, through the
// generated bindings: each L2 registry declares exactly the events its table
// lists, with the same signature and indexed parameters, so a contract that
// gains, loses or changes an event fails here before its logs could fail
// verifier 4.4 (T-17, T-71). The tables come from
// docs/spec/vectors/contract-event.json, written by an independent generator.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { electionRegistryAbi, groupRegistryAbi, trusteeRegistryAbi } from "../src/generated/abi.ts";

interface Vectors {
  readonly events: readonly {
    readonly role: string;
    readonly signature: string;
    readonly indexed: readonly string[];
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/contract-event.json", import.meta.url), "utf8"),
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

const roles: readonly [string, readonly AbiItem[]][] = [
  ["election-registry", electionRegistryAbi],
  ["trustee-registry", trusteeRegistryAbi],
  ["group-registry", groupRegistryAbi],
];

describe("contract-event tables", () => {
  test.each(roles)("%s declares exactly its table's events", (role, abi) => {
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
