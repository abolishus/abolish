import { readFileSync } from "node:fs";
import {
  type ContractEventRecord,
  type ContractRole,
  decodeElectionDefinitionV7,
  ELECTORATE_MODES,
  RESULTS_MODES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import { authorRunOf, decodeDefinition, readDefinition } from "../src/definition.ts";
import {
  archivedChain,
  BUNDLE_FORMAT_BLOCKS,
  BUNDLE_FORMAT_CEREMONY,
  type Bundle,
  type CheckResult,
  parseBundle,
  type PinnedPanel,
  type Report,
  type RollingChainRelease,
  splitEntries,
  verifyBundle,
} from "../src/index.ts";
import type { ContractSequence } from "../src/replay.ts";
import { definitionRegistered } from "./registration-logs.ts";
import { logs, release, rollingEvents, type RollingVectorEvent } from "./registry-logs.ts";
import { anchoredL1, receiptKeyStorage } from "./state.ts";

// A live rolling poll whose only tier is Tier 0, through `verifyBundle` end
// to end (docs/spec/verifier.md, Electorate, The rolling chain, From the
// archive; Ballot admission; P2-17 part 4d-2b-2b-2b-2b-2b-2a): the run builds
// the chain from the archive's replay of the group and election registries,
// under the registries the release pins, and admission judges each ballot's
// step against it. The definition, board, panel, events, registration time,
// rows and report are verifier-ballots-v5-tier0.json's
// (packages/crypto/scripts/verifier-ballots-v5-tier0-vectors.py, an
// independent implementation that rebuilds every step root from the events,
// with snarkjs's verdict on every membership proof); the registries' records
// are those events as the registry logs them (T-08, T-34, T-53, T-71).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface Expected {
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly archived: Readonly<Record<string, Record<string, unknown>>>;
  readonly ballots: NonNullable<Report["ballots"]>;
}
const file = read("verifier-ballots-v5-tier0.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly panels: Readonly<Record<string, unknown>>;
  readonly events: readonly RollingVectorEvent[];
  readonly registeredAt: string;
  readonly case: Expected & {
    readonly panel: string;
    readonly definition: string;
    readonly definitionHash: string;
    readonly board: string;
  };
  readonly shortEvents: Expected & { readonly events: number };
};
const l1File = read("l1-anchor.json") as {
  readonly vectors: readonly {
    readonly id: string;
    readonly firstSegment: string;
    readonly block: { readonly header: string };
    readonly nodes: readonly string[];
    readonly checkpoints: readonly string[];
  }[];
};
const closed = l1File.vectors.find((v) => v.id === "closed");
if (closed === undefined) throw new Error("no closed L1 vector");

const c = file.case;
const d = { version: 7 as const, value: decodeElectionDefinitionV7(hex(c.definition)) };
const v = d.value;
const registries: RollingChainRelease = { ...release, electionRegistry: v.election_registry };
// The live restriction (2.3): k of the panel's seats are ours.
const pins: PinnedPanel[] = [
  {
    panelId: Buffer.from(v.panel_id).toString("hex"),
    kind: "transitional",
    seats: Array.from({ length: v.panel_size }, (_, i) => ({
      holder: `seat ${i + 1}`,
      ours: i < v.threshold,
    })),
  },
];

/** A contract's replay holding `records`, with one record proven at `at` that they reproduce. */
function sequence(
  role: ContractRole,
  contract: Uint8Array,
  records: readonly ContractEventRecord[],
  at: { readonly block: bigint; readonly timestamp: bigint },
): ContractSequence {
  const count = BigInt(records.length);
  return {
    role,
    contract,
    evidence: {
      records: [
        {
          accumulator: {
            accumulator: new Uint8Array(32),
            count,
            block: at.block,
            blockHash: new Uint8Array(32),
            timestamp: at.timestamp,
          },
          gameIndex: 0n,
          game: new Uint8Array(20),
          outputRoot: new Uint8Array(32),
          cid: new Uint8Array(36),
          transaction: new Uint8Array(32),
          replay: null,
        },
      ],
      reads: 1,
      findings: [],
    },
    runs: { taken: [], complete: true, spent: 0, reads: 0, findings: [] },
    held: count,
    records,
  };
}

/** The archive's replay of the registries, the group registry's holding `events`, each proven past close. */
function replayOf(events: readonly RollingVectorEvent[]) {
  const after = { block: 10_000n, timestamp: v.closes_at + 1n };
  const registration = definitionRegistered(
    d,
    hex(c.definition),
    hex(c.definitionHash),
    99n,
    BigInt(file.registeredAt),
  );
  return {
    contracts: [
      sequence("election-registry", v.election_registry, [registration], after),
      sequence("trustee-registry", v.trustee_registry, [], after),
      sequence("group-registry", v.group_registry, logs(rollingEvents(events)), after),
      sequence("board", v.board, [], after),
    ],
    findings: [],
  };
}

/** The bundle with `replayOf(events)` as its archive's replay. */
function bundleOf(events = file.events): Bundle {
  const bundle = parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_CEREMONY,
      definition: c.definition,
      clock: file.clock,
      l1: {
        firstSegment: closed?.firstSegment,
        header: closed?.block.header,
        nodes: closed?.nodes,
        checkpoints: closed?.checkpoints,
      },
      panel: file.panels[c.panel],
    }),
    hex(c.board),
  );
  return {
    ...bundle,
    archive: {
      count: 1n,
      walk: { latest: 0n, manifests: 1, reads: 1, findings: [] },
      replay: replayOf(events),
    },
  };
}

const row = (r: Report, id: string) => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
const ADMISSION = ["3.2", "5.1", "5.2", "5.3", "5.4", "5.5", "5.7"];

describe("a live Tier-0-only rolling poll through verifyBundle", { timeout: 60_000 }, () => {
  test("the fixture is a live rolling definition whose only tier is Tier 0", () => {
    expect(v.electorate_mode).toBe(ELECTORATE_MODES.rolling);
    expect(v.results_mode).toBe(RESULTS_MODES.live);
    expect(v.rolling_electorate.map((t) => t.tier)).toEqual([0]);
  });

  test("the chain from the archive admits the vectors' ballots, its rejections resting on the archive's word", () => {
    const r = verifyBundle(bundleOf(), pins, registries);
    // A profile that fits, with its chain built: the board checks run.
    expect(row(r, "2.3")).toEqual({ status: "unverifiable", code: "not-implemented" });
    for (const id of ADMISSION) expect(row(r, id), id).toEqual(c.archived[id]);
    expect(r.ballots).toEqual(c.ballots);
    // A rejection resting on the chain leaves selection unsettled (verifier.md,
    // The rolling chain, step 3), and the releases wait on 7.1.
    expect(row(r, "6.1").code).toBe("not-reached");
    for (const id of ["7.5", "7.6"])
      expect(row(r, id)).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
    expect(r).not.toHaveProperty("releases");
    // The chain is the archive's word, so no verdict rests on it (T-71).
    expect(r.verdictAgainstInputs).toBe("unverifiable");
  });

  // Until P1-19 checks the archive's output roots the run reports a
  // rejection resting on the chain as unverifiable; over the same chain,
  // proven, admission's own rows are the vectors' `expected`.
  test("over the same chain, admission's own rows are the vectors' for a proven chain", () => {
    const definition = decodeDefinition(hex(c.definition));
    const { entries } = splitEntries(hex(c.board));
    const p = file.panels[c.panel] as { readonly threshold: string; readonly keys: string[] };
    const ceremony = ceremonyChecks(
      v,
      readDefinition(definition).stubHash,
      { threshold: Number(p.threshold), keys: p.keys.map(hex) },
      authorRunOf(definition),
      entries,
      6,
      pins,
    );
    const clock = bundleOf().clock;
    for (const [events, want] of [
      [file.events, c],
      [file.events.slice(0, file.shortEvents.events), file.shortEvents],
    ] as const) {
      const chain = archivedChain(d, replayOf(events), registries);
      if (chain === undefined) throw new Error("fixture: no chain");
      const r = ballotChecks(
        definition,
        ceremony.registered,
        ceremony.authorRegistered,
        entries,
        6,
        clock,
        undefined,
        chain,
      );
      for (const [id, { status, code, at }] of [...ceremony.rows, ...r.rows])
        if (ADMISSION.includes(id))
          expect(
            {
              status,
              ...(code !== undefined && { code }),
              ...(at !== undefined && Object.keys(at).length > 0 && { at }),
            },
            id,
          ).toEqual(want.expected[id]);
      expect(r.report).toEqual(want.ballots);
    }
  });

  // An archive claiming completeness past the close while omitting an
  // addition before it: possible only by forging its output root, until
  // P1-19 checks them on L1.
  test("the step roots are the archive's events': without the last addition, its steps' ballots fail", () => {
    const short = file.shortEvents;
    expect(short.events).toBe(file.events.length - 1);
    const r = verifyBundle(bundleOf(file.events.slice(0, short.events)), pins, registries);
    for (const id of ADMISSION) expect(row(r, id), id).toEqual(short.archived[id]);
    expect(r.ballots).toEqual(short.ballots);
    // A forged archive suppresses those ballots, but never fails or passes
    // the election on its word (T-71, T-53).
    expect(r.verdictAgainstInputs).toBe("unverifiable");
  });

  test("a live poll with fewer than k seats pinned as ours fails 2.3, whatever the archive holds", () => {
    const fewer = pins.map((p) => ({
      ...p,
      seats: p.seats.map((s, i) => ({ ...s, ours: i < v.threshold - 1 })),
    }));
    const r = verifyBundle(bundleOf(), fewer, registries);
    expect(row(r, "2.3")).toEqual({ status: "fail", code: "profile-combination", at: {} });
    expect(row(r, "5.1")).toMatchObject({ code: "not-reached" });
  });

  test("without the registries pinned the run stops at 2.3", () => {
    const r = verifyBundle(bundleOf(), pins, undefined);
    expect(row(r, "2.3")).toEqual({ status: "unverifiable", code: "unsupported-version", at: {} });
    expect(row(r, "4.1")).toEqual({ status: "unverifiable", code: "not-reached" });
  });
});

// The same poll sealed (verifier-ballots-v5-tier0-sealed.json, from
// packages/crypto/scripts/verifier-ballots-v5-tier0-sealed-vectors.py; P2-17
// part 4d-2b-2b-2b-2b-2b-2b): its honest ballots naming a run of L1 headers,
// every registered seat's receipts and openings, and no rejection resting on
// the chain, anchored in an L1 state built here (state.ts) so 4.1 and 4.2
// pass. Selection (6.1) is reached, and through it delivery, the counted
// set and the releases (verifier.md, Selection, Counted set and tally and
// Releases).
const sealed = read("verifier-ballots-v5-tier0-sealed.json") as {
  readonly definition: string;
  readonly definitionHash: string;
  readonly panel: unknown;
  readonly clock: Readonly<Record<string, string>>;
  readonly l1Blocks: readonly string[];
  readonly board: string;
  readonly expected: Readonly<Record<string, Record<string, unknown>>>;
  readonly ballots: NonNullable<Report["ballots"]>;
  readonly delivery: NonNullable<Report["delivery"]>;
  readonly cells: NonNullable<Report["cells"]>;
  readonly tallies: NonNullable<Report["tallies"]>;
  readonly releases: NonNullable<Report["releases"]>;
};

function sealedBundle(): Bundle {
  const entries = splitEntries(hex(sealed.board)).entries;
  const clock = {
    epoch: BigInt(sealed.clock["epoch"] as string),
    period: BigInt(sealed.clock["period"] as string),
    deadline: BigInt(sealed.clock["deadline"] as string),
    lastSegment: Number(sealed.clock["lastSegment"]),
  };
  // Well after the seal's window closes.
  const now = clock.epoch + BigInt(clock.lastSegment + 1) * clock.period + clock.deadline + 1n;
  const bundle = parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_BLOCKS,
      definition: sealed.definition,
      clock: sealed.clock,
      // The definition's receipt keys registered at its registration, so
      // before opens_at and never retired (2.9).
      l1: anchoredL1(
        v.election_id,
        v.l1_anchor,
        entries,
        6,
        clock,
        // B, after the run of headers in number as in time.
        { number: 21_000_100n, timestamp: now },
        receiptKeyStorage(v.receipt_keys, BigInt(file.registeredAt)),
      ),
      panel: sealed.panel,
      l1Blocks: sealed.l1Blocks,
    }),
    hex(sealed.board),
  );
  return {
    ...bundle,
    archive: {
      count: 1n,
      walk: { latest: 0n, manifests: 1, reads: 1, findings: [] },
      replay: replayOf(file.events),
    },
  };
}

describe(
  "the same poll sealed, through the counted set and the releases",
  { timeout: 60_000 },
  () => {
    test("it is verifier-ballots-v5-tier0.json's definition", () => {
      expect(sealed.definition).toBe(c.definition);
      expect(sealed.definitionHash).toBe(c.definitionHash);
    });

    const r = verifyBundle(sealedBundle(), pins, registries);

    test("4.1, 4.2 and 2.9 pass: the copy is the board, and the receipt keys judge it", () => {
      for (const id of ["4.1", "4.2", "2.9"]) expect(row(r, id), id).toEqual({ status: "pass" });
    });

    test("admission, selection, delivery, the counted set and the releases give the vectors' rows", () => {
      for (const [id, want] of Object.entries(sealed.expected))
        expect(row(r, id), id).toEqual(want);
    });

    test("the report gives the vectors' ballots, delivery, cells and tallies", () => {
      expect(r.ballots).toEqual(sealed.ballots);
      expect(r.delivery).toEqual(sealed.delivery);
      expect(r.cells).toEqual(sealed.cells);
      expect(r.tallies).toEqual(sealed.tallies);
    });

    // The poll is shorter than live_every periods, so it has no scheduled
    // snapshot (tally.md, Schedule): the releases run over none.
    test("the releases ran, with the vectors' report", () => {
      expect(r.releases).toEqual(sealed.releases);
    });

    test("the chain is still the archive's word, so the verdict rests on it nowhere", () => {
      expect(r.verdictAgainstInputs).toBe("unverifiable");
    });
  },
);
