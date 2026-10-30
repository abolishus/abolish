import { readFileSync } from "node:fs";
import {
  type ContractEventRecord,
  type ContractRole,
  decodeElectionDefinitionV7,
  DEFINITION_V6_LIMITS,
  type ElectionDefinitionV7,
  encodeElectionDefinitionV7,
  membershipVkHash,
  RECORD_TYPES,
  RESULTS_MODES,
} from "@abolishus/crypto";
import { describe, expect, test } from "vite-plus/test";
import {
  archivedChain,
  BUNDLE_FORMAT_DEFINITION,
  type Bundle,
  type CheckResult,
  parseBundle,
  PINNED_REGISTRIES,
  type Report,
  type RollingChainRelease,
  verifyBundle,
} from "../src/index.ts";
import { ALL_ROWS, type BallotOutcome, restsOnChain, unprovenRoots } from "../src/ballots.ts";
import { admissionSettled } from "../src/selection.ts";
import type { ContractSequence } from "../src/replay.ts";
import { definitionRegistered } from "./registration-logs.ts";
import { added, definitionOf, logs, release, rolling, rollingTree } from "./registry-logs.ts";

// A rolling poll in the run (docs/spec/verifier.md, Electorate, The rolling
// chain, From the archive; P2-17 part 4d-2b-2a): the run builds its chain
// from the archive's replay of the group and election registries, under the
// registries the release pins, and only then reads its profile as fitting
// 2.3 and runs the board checks. The trees, their events and registration
// times are rolling-tier-tree.json's (rolling-electorate-vectors.py), and
// the L1 evidence and board l1-anchor.json's and board.json's, as
// definition.test.ts reads them (T-08, T-36, T-53, T-71).

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface L1Vector {
  readonly id: string;
  readonly anchor: string;
  readonly firstSegment: string;
  readonly block: { readonly header: string };
  readonly nodes: readonly string[];
  readonly checkpoints: readonly string[];
  readonly copy: string;
  readonly copyEntries?: string;
}
const l1File = read("l1-anchor.json") as {
  readonly clock: Readonly<Record<string, string>>;
  readonly electionId: string;
  readonly vectors: readonly L1Vector[];
};
const boards = (read("board.json") as { boards: { id: string; entries: string[] }[] }).boards;
const closed = l1File.vectors.find((v) => v.id === "closed") as L1Vector;

function copyOf(v: L1Vector): Uint8Array {
  const copy = boards.find((b) => b.id === v.copy);
  if (copy === undefined) throw new Error(`no board ${v.copy}`);
  const n = v.copyEntries === undefined ? undefined : Number(v.copyEntries);
  return hex(copy.entries.slice(0, n).join(""));
}

const minimal = decodeElectionDefinitionV7(
  definitionOf("election-definition-v7.json", "definition-v7-rolling-minimal"),
);
const pick = ({
  l2_chain_id,
  group_registry,
  closes_at,
  rolling_electorate,
}: ElectionDefinitionV7) => ({ l2_chain_id, group_registry, closes_at, rolling_electorate });

const row = (r: Report, id: string) => r.checks.find((c) => c.id === id) as CheckResult;

/** A tree's poll for the L1 vectors' election and anchor, its records and its pinned registries. */
function poll(
  id: string,
  results_mode: (typeof RESULTS_MODES)[keyof typeof RESULTS_MODES] = RESULTS_MODES.sealed,
) {
  const t = rollingTree(id);
  // The minimal rolling definition (no author panel) on the tree's
  // registry, tier and close, as `rolling` sets them on the typical one.
  const base = { value: { ...minimal, ...pick(rolling([t.tier], t.closesAt).value) } };
  const value: ElectionDefinitionV7 = {
    ...base.value,
    election_id: hex(l1File.electionId),
    l1_anchor: hex(closed.anchor),
    membership_vk_hash: membershipVkHash(),
    // The profile 2.3 lets a rolling poll pin (definition.test.ts's
    // ROLLING_FITTING), a live one with tally-opening version 2 and
    // board-entry version 6, which carries its running openings.
    profile: {
      ...base.value.profile,
      pins: base.value.profile.pins.map((x) => ({
        ...x,
        version:
          {
            [RECORD_TYPES.ballot]: 5,
            [RECORD_TYPES.spoiledBallotOpening]: 3,
            [RECORD_TYPES.tallyOpening]: results_mode === RESULTS_MODES.live ? 2 : 1,
            [RECORD_TYPES.boardEntry]: results_mode === RESULTS_MODES.live ? 6 : 5,
            [RECORD_TYPES.contractEvent]: 13,
            [RECORD_TYPES.displayText]: 2,
          }[x.record_type] ?? x.version,
      })),
    },
    // A sealed poll releases nothing; a live one at least the smallest batch.
    ...(results_mode === RESULTS_MODES.sealed
      ? { results_mode, live_every: 0, live_batch: 0 }
      : {
          results_mode,
          live_every: Math.max(base.value.live_every, 1),
          live_batch: Math.max(base.value.live_batch, DEFINITION_V6_LIMITS.minLiveBatch),
        }),
  };
  const d = { version: 7 as const, value };
  const registration = definitionRegistered(d, undefined, undefined, 99n, t.registeredAt);
  const registries: RollingChainRelease = {
    ...release,
    electionRegistry: d.value.election_registry,
  };
  return { t, d, registration, registries };
}

/** A contract's replay holding `records`, with one record proven at `at` that they reproduce. */
function sequence(
  role: ContractRole,
  contract: Uint8Array,
  records: readonly ContractEventRecord[],
  at: { readonly block: bigint; readonly timestamp: bigint },
  replay: ContractSequence["evidence"]["records"][number]["replay"] = null,
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
          replay,
        },
      ],
      reads: 1,
      findings: [],
    },
    runs: { taken: [], complete: true, spent: 0, reads: 0, findings: [] },
    held: replay === null ? count : 0n,
    records,
  };
}

type Poll = ReturnType<typeof poll>;
type Replay = { contracts: ContractSequence[]; findings: [] };

/** The archive's replay of `p`'s registries, each proven at a block after its close. */
function replayOf(p: Poll, records = p.t.records): Replay {
  const after = { block: 10_000n, timestamp: p.t.closesAt + 1n };
  const v = p.d.value;
  return {
    contracts: [
      sequence("election-registry", v.election_registry, [p.registration], after),
      sequence("trustee-registry", v.trustee_registry, [], after),
      sequence("group-registry", v.group_registry, records, after),
      sequence("board", v.board, [], after),
    ],
    findings: [],
  };
}

function bundleOf(p: Poll, replay?: Replay): Bundle {
  const json = JSON.stringify({
    format: BUNDLE_FORMAT_DEFINITION,
    definition: toHex(encodeElectionDefinitionV7(p.d.value)),
    clock: l1File.clock,
    l1: {
      firstSegment: closed.firstSegment,
      header: closed.block.header,
      nodes: closed.nodes,
      checkpoints: closed.checkpoints,
    },
  });
  const bundle = parseBundle(json, copyOf(closed));
  return replay === undefined
    ? bundle
    : {
        ...bundle,
        archive: {
          count: 1n,
          walk: { latest: 0n, manifests: 1, reads: 1, findings: [] },
          replay,
        },
      };
}

const UNSUPPORTED = { status: "unverifiable", code: "unsupported-version", at: {} };
const NOT_REACHED = { status: "unverifiable", code: "not-reached" };

const TREE = "repeats-and-re-additions";

describe("the run builds a rolling poll's chain from the archive", () => {
  test("the release pins no registries yet, so the run stops a rolling poll at 2.3", () => {
    expect(PINNED_REGISTRIES).toBeUndefined();
    const p = poll(TREE);
    const r = verifyBundle(bundleOf(p, replayOf(p)));
    expect(row(r, "2.3")).toMatchObject(UNSUPPORTED);
    expect(row(r, "4.1")).toMatchObject(NOT_REACHED);
  });

  test("with the registries pinned and the archive proven past close, 2.3 fits and the board checks run", () => {
    const p = poll(TREE);
    expect(archivedChain(p.d, replayOf(p), p.registries)).toBeDefined();
    // A record at exactly the latest root_l2_block is that block's end
    // state, so it covers every event up to it.
    const v = p.d.value;
    const atRoot = {
      block: v.rolling_electorate.reduce((b, t) => (t.root_l2_block > b ? t.root_l2_block : b), 0n),
      timestamp: p.t.closesAt + 1n,
    };
    const honest = replayOf(p);
    const rootBound: Replay = {
      ...honest,
      contracts: honest.contracts.map((c) =>
        c.role === "group-registry" ? sequence(c.role, c.contract, p.t.records, atRoot) : c,
      ),
    };
    expect(archivedChain(p.d, rootBound, p.registries)).toBeDefined();
    const r = verifyBundle(bundleOf(p, replayOf(p)), [], p.registries);
    expect(row(r, "2.1").status).not.toBe("fail");
    // A profile that fits leaves 2.3 to the checks not yet built, never
    // unsupported.
    expect(row(r, "2.3")).toMatchObject({ status: "unverifiable", code: "not-implemented" });
    // The L1 vectors' board is another profile's, so 4.1 fails on it: it ran.
    expect(row(r, "4.1")).toMatchObject({ status: "fail", code: "decode" });
    expect(r.verdict).toBe("unverifiable");
    // A sealed poll has no releases.
    expect(row(r, "7.5")).toMatchObject({ status: "pass" });
  });

  test("a live rolling poll's releases can't pass while its running copies aren't read", () => {
    const p = poll(TREE, RESULTS_MODES.live);
    const pins = [
      {
        panelId: toHex(p.d.value.panel_id),
        kind: "transitional" as const,
        seats: Array.from({ length: p.d.value.panel_size }, (_, i) => ({
          holder: `seat ${i + 1}`,
          ours: true,
        })),
      },
    ];
    const r = verifyBundle(bundleOf(p, replayOf(p)), pins, p.registries);
    expect(row(r, "2.3").status).not.toBe("fail");
    expect(row(r, "4.1").code).not.toBe("not-reached");
    for (const id of ["7.5", "7.6"]) expect(row(r, id)).toMatchObject(NOT_REACHED);
  });

  test("without the archive, or with no chain from it, the run stops at 2.3 as before", () => {
    const p = poll(TREE);
    const v = p.d.value;
    const after = { block: 10_000n, timestamp: p.t.closesAt + 1n };
    const atClose = { block: 10_000n, timestamp: p.t.closesAt };
    const beforeRoot = {
      block: v.rolling_electorate[0]!.root_l2_block - 1n,
      timestamp: after.timestamp,
    };
    const honest = replayOf(p);
    const replace = (role: ContractRole, s: ContractSequence): Replay => ({
      ...honest,
      contracts: honest.contracts.map((c) => (c.role === role ? s : c)),
    });
    const first = p.t.events.findIndex((e) => e.kind !== "created");
    const { block, timestamp } = p.t.events[first] as (typeof p.t.events)[number];
    const stray = {
      ...added(v.rolling_electorate[0]!.groups[0]!, 5n, [1_000_000_000_999n]),
      block,
      timestamp,
    };
    for (const [name, replay, registries] of [
      ["no archive read", undefined, p.registries],
      ["no registries pinned", honest, undefined],
      // The group registry proven only up to the close, not past it: a
      // later event in a block at closes_at may be missing.
      [
        "group registry proven only at close",
        replace(
          "group-registry",
          sequence("group-registry", v.group_registry, p.t.records, atClose),
        ),
        p.registries,
      ],
      [
        "group registry proven before root_l2_block",
        replace(
          "group-registry",
          sequence("group-registry", v.group_registry, p.t.records, beforeRoot),
        ),
        p.registries,
      ],
      [
        "election registry proven only at close",
        replace(
          "election-registry",
          sequence("election-registry", v.election_registry, [p.registration], atClose),
        ),
        p.registries,
      ],
      // A replay that doesn't reproduce its record holds nothing.
      [
        "group registry not reproduced",
        replace(
          "group-registry",
          sequence("group-registry", v.group_registry, p.t.records, after, "accumulator"),
        ),
        p.registries,
      ],
      // Only a record at close is reproduced: the one past it isn't, so the
      // events held may stop short of the close.
      [
        "group registry reproduced only at close",
        replace("group-registry", {
          ...sequence("group-registry", v.group_registry, p.t.records, atClose),
          evidence: {
            records: [
              ...sequence("group-registry", v.group_registry, p.t.records, atClose).evidence
                .records,
              ...sequence("group-registry", v.group_registry, p.t.records, after, "accumulator")
                .evidence.records,
            ],
            reads: 2,
            findings: [],
          },
        }),
        p.registries,
      ],
      [
        "group registry missing",
        { ...honest, contracts: honest.contracts.filter((c) => c.role !== "group-registry") },
        p.registries,
      ],
      [
        "walk kept no more evidence",
        { ...honest, findings: [{ code: "evidence-over-budget" }] },
        p.registries,
      ],
      // The recount fails: a stray addition breaks a listed group's history.
      [
        "stray addition",
        replace(
          "group-registry",
          sequence("group-registry", v.group_registry, logsWith(p, stray), after),
        ),
        p.registries,
      ],
      // The registration isn't found: another registry is pinned.
      [
        "another election registry pinned",
        honest,
        { ...p.registries, electionRegistry: new Uint8Array(20).fill(7) },
      ],
    ] as const) {
      const r = verifyBundle(bundleOf(p, replay as Replay | undefined), [], registries);
      expect(row(r, "2.3"), name).toMatchObject(UNSUPPORTED);
      expect(row(r, "4.1"), name).toMatchObject(NOT_REACHED);
    }
  });

  test("a rolling profile that doesn't fit fails 2.3 whatever the archive holds", () => {
    const p = poll(TREE);
    const unfit = {
      ...p,
      d: {
        ...p.d,
        value: {
          ...p.d.value,
          profile: {
            ...p.d.value.profile,
            // Board-entry version 4 carries no close statement.
            pins: p.d.value.profile.pins.map((x) =>
              x.record_type === 7 ? { ...x, version: 4 } : x,
            ),
          },
        },
      },
    };
    const r = verifyBundle(bundleOf(unfit, replayOf(unfit)), [], unfit.registries);
    expect(row(r, "2.3")).toMatchObject({ status: "fail", code: "profile-combination" });
    expect(row(r, "4.1")).toMatchObject(NOT_REACHED);
  });
});

// The tree's group records with `extra` logged before its first addition,
// every record numbered in log order.
function logsWith(p: Poll, extra: ReturnType<typeof added> & { block: bigint; timestamp: bigint }) {
  const first = p.t.events.findIndex((e) => e.kind !== "created");
  return logs([...p.t.events.slice(0, first), extra, ...p.t.events.slice(first)]);
}

describe("5.1 to 5.3 under a chain from the archive's word", () => {
  const pass = { status: "pass" } as const;
  const rows = () =>
    new Map(
      ["5.1", "5.2", "5.3", "5.4", "5.5"].map((id) => [
        id,
        { status: "fail" as const, code: "repeat" as const, at: { entry: 0 } },
      ]),
    );

  test("a rejection resting on the step roots or the registration time leaves its rows unverifiable", () => {
    for (const code of ["root-step-range", "root-step-mismatch", "membership-proof"] as const) {
      const out = unprovenRoots(
        new Map<string, BallotOutcome>([
          ["5.1", { status: "fail", code, at: { entry: 3 } }],
          ["5.2", code === "membership-proof" ? { status: "fail", code, at: { entry: 3 } } : pass],
          ["5.3", code === "membership-proof" ? { status: "fail", code, at: { entry: 3 } } : pass],
        ]),
        [{ entry: 3, code }],
      );
      expect(out.get("5.1"), code).toEqual({
        status: "unverifiable",
        code: "not-implemented",
        at: { entry: 3 },
      });
      expect(out.get("5.2"), code).toEqual(
        code === "membership-proof"
          ? { status: "unverifiable", code: "not-implemented", at: { entry: 3 } }
          : pass,
      );
    }
  });

  test("a rejection that doesn't rest on them still fails its row, ahead of an earlier one that does", () => {
    const out = unprovenRoots(
      new Map([["5.1", { status: "fail", code: "root-step-range", at: { entry: 1 } }]]),
      [
        { entry: 1, code: "root-step-range" },
        { entry: 4, code: "ballot-stray" },
      ],
    );
    expect(out.get("5.1")).toEqual({ status: "fail", code: "ballot-stray", at: { entry: 4 } });
  });

  test("a rejection resting on the chain leaves selection unsettled", () => {
    // 6.1 runs only where every admission row passed or failed (Selection,
    // condition 1), so it's never decided over a set the archive alone chose.
    const settled = new Map<string, BallotOutcome>(ALL_ROWS.map((id) => [id, pass]));
    settled.set("5.1", { status: "fail", code: "root-step-mismatch", at: { entry: 2 } });
    expect(admissionSettled(settled)).toBe(true);
    expect(
      admissionSettled(unprovenRoots(settled, [{ entry: 2, code: "root-step-mismatch" }])),
    ).toBe(false);
  });

  test("beside a rejection that fails the row, one resting on the chain still leaves selection unsettled", () => {
    // A junk ballot failing 5.1 can't settle selection over a ballot the
    // archive's chain rejected (T-53, T-71).
    const mixed = [
      { entry: 2, code: "root-step-mismatch" },
      { entry: 5, code: "ballot-cell" },
    ] as const;
    expect(unprovenRoots(new Map(), mixed).get("5.1")).toMatchObject({
      status: "fail",
      code: "ballot-cell",
    });
    expect(restsOnChain(mixed)).toBe(true);
    for (const code of ["root-step-range", "membership-proof"] as const)
      expect(restsOnChain([{ entry: 0, code }])).toBe(true);
    expect(
      restsOnChain([
        { entry: 5, code: "ballot-cell" },
        { entry: 6, code: "repeat" },
      ]),
    ).toBe(false);
  });

  test("every other row is left as given", () => {
    const given = rows();
    const out = unprovenRoots(given, [
      { entry: 0, code: "membership-proof" },
      { entry: 0, code: "repeat" },
    ]);
    expect(out.get("5.4")).toEqual(given.get("5.4"));
    expect(out.get("5.5")).toEqual(given.get("5.5"));
  });
});
