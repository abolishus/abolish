import { readFileSync } from "node:fs";
import {
  type AnchorClock,
  checkChallengeOpeningV3,
  coreHashV4,
  decodeBoardEntry,
  decodeOpening,
  openingV3CoreHash,
  panelBallotElection,
  type RollingBallotChain,
  rollingBallotElection,
  type RollingTierEvent,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { authorRunOf, decodeDefinition, isRolling, readDefinition } from "../src/definition.ts";
import { type Report, splitEntries } from "../src/index.ts";
import { openingChecks } from "../src/openings.ts";

// Spoiled-ballot openings (6.2) under a rolling definition (definition
// version 7, `electorate_mode` 2), whose openings are version 3 and open
// both halves of ballot version 5's cores, each tracking code version 5's
// core hash (docs/spec/verifier.md, Spoiled-ballot openings; challenge.md,
// Opening version 3, Core and tracking code; P2-17 part 4d-2b-2b-1). Each
// opening is judged against the context admission made from the same
// chain, and `opening-cast` against the ballots admission admitted from it.
// Fixtures: docs/spec/vectors/verifier-openings-v3-rolling.json
// (packages/crypto/scripts/verifier-openings-v3-rolling-vectors.py, an
// independent implementation), whose ballots are verifier-ballots-v5.json's,
// beside that file's group registry events and registration time.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly clock: Readonly<Record<string, string>>;
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly openings: NonNullable<Report["openings"]>;
}

const file = read("verifier-openings-v3-rolling.json") as {
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: readonly string[] }>
  >;
  readonly cases: readonly Case[];
};
const ballotsFile = read("verifier-ballots-v5.json") as {
  readonly events: readonly {
    readonly block: string;
    readonly timestamp: string;
    readonly group: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  }[];
  readonly registeredAt: string;
};
const events: RollingTierEvent[] = ballotsFile.events.map((e) => {
  const at = {
    blockNumber: BigInt(e.block),
    timestamp: BigInt(e.timestamp),
    groupId: BigInt(e.group),
  };
  return e.remove === undefined
    ? { ...at, kind: "add", commitments: (e.add ?? []).map(BigInt) }
    : { ...at, kind: "remove", indices: e.remove.map(BigInt) };
});
const chain: RollingBallotChain = { events, registeredAt: BigInt(ballotsFile.registeredAt) };

const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const clockOf = (c: Case): AnchorClock => ({
  epoch: BigInt(c.clock["epoch"] ?? ""),
  period: BigInt(c.clock["period"] ?? ""),
  deadline: BigInt(c.clock["deadline"] ?? ""),
  lastSegment: Number(c.clock["lastSegment"]),
});

/** A case's definition, registered key set, entries and admitted ballots, as `verifyBundle` reaches 6.2 under the chain. */
function election(c: Case) {
  const definition = decodeDefinition(hex(c.definition));
  const { stubHash } = readDefinition(definition);
  const { entries } = splitEntries(hex(c.board));
  const p = file.panels[c.panel];
  if (p === undefined) throw new Error(`no panel ${c.panel}`);
  const panel = { threshold: Number(p.threshold), keys: p.keys.map(hex) };
  const ceremony = ceremonyChecks(
    definition.value,
    stubHash,
    panel,
    authorRunOf(definition),
    entries,
    5,
  );
  const admission = ballotChecks(
    definition,
    ceremony.registered,
    ceremony.authorRegistered,
    entries,
    5,
    clockOf(c),
    undefined,
    chain,
  );
  return { definition, entries, ceremony, admission };
}

function opened(c: Case, rolling: RollingBallotChain | "none" = chain) {
  const { definition, entries, ceremony, admission } = election(c);
  return openingChecks(
    definition,
    ceremony.registered,
    ceremony.authorRegistered,
    admission.admitted,
    entries,
    5,
    clockOf(c),
    rolling === "none" ? undefined : rolling,
  );
}

const plain = ({ status, code, at }: { status: string; code?: string; at?: object }) => ({
  status,
  ...(code !== undefined && { code }),
  ...(at !== undefined && Object.keys(at).length > 0 && { at }),
});

test(
  "every definition is a rolling version 7, and every ballot passes 5.1 to 5.4 against its step",
  { timeout: 60_000 },
  () => {
    for (const c of file.cases) {
      const { definition, ceremony, admission } = election(c);
      expect(isRolling(definition), c.id).toBe(true);
      expect(ceremony.rows.get("3.2")?.status, c.id).toBe("pass");
      // Only the close rule turns any away: a ballot boarded after the
      // window, which no opening's verdict rests on.
      expect(
        admission.report?.rejected.every((b) => b.code === "window-boarded-late"),
        c.id,
      ).toBe(true);
      expect(admission.admitted?.length, c.id).toBeGreaterThan(0);
    }
  },
);

describe("6.2 against the independent implementation", { timeout: 60_000 }, () => {
  for (const c of file.cases)
    test(c.id, () => {
      const r = opened(c);
      expect(plain(r.row)).toEqual(c.expected["6.2"]);
      expect(r.report).toEqual(c.openings);
    });
});

describe("what a rolling poll's openings are judged against", { timeout: 60_000 }, () => {
  test("without the chain no opening is judged, as no ballot is", () => {
    const c = byId("mixed");
    expect(opened(c, "none")).toEqual({
      row: { status: "unverifiable", code: "not-reached" },
    });
  });

  test("a passing opening's tracking code is ballot version 5's core hash, never version 4's", () => {
    // One code never names cores of two ballot versions (T-42, T-47).
    const c = byId("honest");
    const { definition, entries, ceremony } = election(c);
    if (definition.version !== 7 || ceremony.registered === undefined)
      throw new Error("expected a registered version 7");
    const context = rollingBallotElection(definition.value, ceremony.registered, chain);
    const report = c.openings;
    expect(report.length).toBe(2);
    for (const o of report) {
      const payload = decodeBoardEntry(entries[o.entry] as Uint8Array, 5).payload;
      const opening = decodeOpening(payload, 3);
      const checked = checkChallengeOpeningV3(context, opening);
      if (!checked.ok) throw new Error(`expected a passing opening, got ${checked.code}`);
      expect(Buffer.from(checked.coreHash).toString("hex")).toBe(o.coreHash);
      expect(openingV3CoreHash(opening, 5)).toEqual(checked.coreHash);
      const v4 = coreHashV4({
        definitionHash: opening.definition_hash,
        cell: opening.cell,
        vss: opening.vss,
        shareHashes: opening.share_hashes,
        authorVss: opening.author_vss,
        authorShareHashes: opening.author_share_hashes,
      });
      expect(openingV3CoreHash(opening)).toEqual(v4);
      expect(checked.coreHash).not.toEqual(v4);
    }
  });

  test("the rolling definition never yields a version-4 context", () => {
    // panelBallotElection refuses a rolling version 7, so no opening of its
    // cores is ever hashed under version 4 (T-36).
    const { definition, ceremony } = election(byId("honest"));
    if (definition.version !== 7 || ceremony.registered === undefined)
      throw new Error("expected a registered version 7");
    expect(() => panelBallotElection(definition.value, ceremony.registered ?? [])).toThrow();
  });

  test("openingV3CoreHash takes only ballot versions 4 and 5", () => {
    const c = byId("honest");
    const { entries } = election(c);
    const first = c.openings[0];
    if (first === undefined) throw new Error("no opening");
    const opening = decodeOpening(
      decodeBoardEntry(entries[first.entry] as Uint8Array, 5).payload,
      3,
    );
    for (const v of [3, 6, 0])
      expect(() => openingV3CoreHash(opening, v as 4)).toThrow(/ballotVersion must be 4 or 5/);
  });
});
