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
// events), contract-event-v8.json (version 8, with the board's two
// availability events), contract-event-v9.json (version 9, with the
// election registry's AuthorPanelRegistered), contract-event-v10.json and
// contract-event-v11.json (versions 10 and 11, with the board's two rolling
// ballots) and contract-event-v12.json (version 12, with the trustee
// registry's kind-carrying PanelPinned in place of version 1's), written by
// independent generators. The election registry declares version 9's three,
// so versions 1 to 8 are compared with it less AuthorPanelRegistered, which
// they lack; the board declares version 8's eleven, which versions 9 to 12
// keep, so only versions 8 to 12 are compared with it, less the two rolling
// ballots versions 10 to 12 add, which the board doesn't take until P2-17
// part 5; the group registry declares version 7's seven, so only versions 7
// to 12 are compared with it; and the trustee registry logs each panel's
// kind, so only version 12 is compared with it: no trustee registry that
// logs the kind may be deployed beside an election registry serving a
// profile pinning versions 1 to 11, no election registry with the author
// registration beside one pinning versions 1 to 8, no board with the
// availability calls beside one pinning versions 1 to 7, and no group
// registry with the self-paid calls beside one pinning versions 1 to 6
// (contracts.md, Contract-event record, Event tables (versions 7 to 12)).
// The version rule 9 pins is read from the election registry's source and
// must name every event the four contracts deployed together declare.
// The group registry's two nullifier-key events join the tables in a later
// version (contracts.md, Group registry, Events), so they are compared apart:
// declared exactly as the spec lists them, and in no version's table yet.

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

const electionRegistry: readonly [string, readonly AbiItem[]] = [
  "election-registry",
  electionRegistryAbi,
];
const trusteeRegistry: readonly [string, readonly AbiItem[]] = [
  "trustee-registry",
  trusteeRegistryAbi,
];

const groupRegistry: readonly [string, readonly AbiItem[]] = ["group-registry", groupRegistryAbi];
const board: readonly [string, readonly AbiItem[]] = ["board", boardAbi];

// Version 1's tables name no board event; version 2's name four of its
// eleven, version 3's six, version 4's eight and versions 5 to 7 nine.
// Versions 1 to 5 name four of the group registry's seven events, and
// version 6 five. Versions 1 to 8 name two of the election registry's three.
const versions = [
  "",
  "-v2",
  "-v3",
  "-v4",
  "-v5",
  "-v6",
  "-v7",
  "-v8",
  "-v9",
  "-v10",
  "-v11",
  "-v12",
].map((suffix) => `contract-event${suffix}.json`);
// The events a table may lack because a later version adds them: versions 1
// to 8 lack the election registry's AuthorPanelRegistered, and every other
// event the registry declares must still match their rows.
const AUTHOR_PANEL = "AuthorPanelRegistered(bytes32,bytes32,bytes)";
// The events a table names that the contract doesn't declare yet: the
// rolling ballot version 10 adds and the relayed one version 11 adds, which
// the board takes in P2-17 part 5.
const ROLLING = [
  "RollingBallotSubmitted(bytes32,bytes32,bytes32,bytes)",
  "RelayedRollingBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes32,bytes)",
];
const cases = [
  ...versions.slice(11).map((file) => [file, ...trusteeRegistry, [], []] as const),
  ...versions.slice(6).map((file) => [file, ...groupRegistry, [], []] as const),
  ...versions
    .slice(7)
    .map((file, i) => [file, ...board, [], ROLLING.slice(0, Math.max(0, i - 1))] as const),
  ...versions.map(
    (file, i) => [file, ...electionRegistry, i < 8 ? [AUTHOR_PANEL] : [], []] as const,
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
  test.each(cases)(
    "%s: %s declares exactly its table's events",
    (file, role, abi, later, undeclared) => {
      const vectors = load(file);
      const declared = declaredEvents(abi).filter(
        (e) => !isPending(role, e.signature) && !(later as readonly string[]).includes(e.signature),
      );
      const table = vectors.events
        .filter((e) => e.role === role)
        .map((e) => ({ signature: e.signature, indexed: [...e.indexed] }))
        .sort((a, b) => a.signature.localeCompare(b.signature));
      expect(table.length).toBeGreaterThan(0);
      expect(table.some((e) => (later as readonly string[]).includes(e.signature))).toBe(false);
      for (const signature of undeclared)
        expect(table.some((e) => e.signature === signature)).toBe(true);
      expect(declared).toEqual(
        table.filter((e) => !(undeclared as readonly string[]).includes(e.signature)),
      );
    },
  );

  test("the version rule 9 pins names every event of the contracts deployed together", () => {
    const source = readFileSync(new URL("../src/ElectionRegistry.sol", import.meta.url), "utf8");
    const pins = [...source.matchAll(/if \(pins\[7\] != (\d+)\) revert ProfileNotServed\(0x0008/g)];
    expect(pins).toHaveLength(1);
    const pinned = Number(pins[0]?.[1]);
    expect(pinned).toBe(12);
    const table = load(`contract-event-v${pinned}.json`).events;
    for (const [role, abi] of [electionRegistry, trusteeRegistry, groupRegistry, board])
      for (const e of declaredEvents(abi).filter((d) => !isPending(role, d.signature)))
        expect(
          table.find((row) => row.role === role && row.signature === e.signature)?.indexed,
          `${role}: ${e.signature}`,
        ).toEqual(e.indexed);
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
