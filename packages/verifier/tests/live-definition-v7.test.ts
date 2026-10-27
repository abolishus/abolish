import { readFileSync } from "node:fs";
import {
  decodeBallot,
  decodeBoardEntry,
  ELECTORATE_MODES,
  encodeElectionDefinitionV6,
  encodeElectionDefinitionV7,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, test } from "vite-plus/test";
import { ballotChecks } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import {
  authorRunOf,
  decodeDefinition,
  isPanelled,
  type PanelledRecord,
  readDefinition,
} from "../src/definition.ts";
import {
  BUNDLE_FORMAT_BLOCKS,
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  electionAdmission,
  parseBundle,
  type PinnedPanel,
  type Report,
  splitEntries,
  verifyBundle,
} from "../src/index.ts";
import { releaseChecks } from "../src/live.ts";
import { run, toHex } from "./headers.ts";
import { counts, liveElection, VOTE } from "./live-election.ts";

// Live releases (docs/spec/verifier.md, Releases; 7.5 and 7.6) under
// definition version 7 with a fixed electorate, which the verifier reads as
// version 6 under version 7's own hash (docs/spec/verifier.md, Definition).
// No generator writes a live board with ballots under any version (P2-15
// part 7), so, as live.test.ts does for version 6, live-election.ts casts
// one with @abolishus/crypto's client and trustee paths under a definition
// from an independent implementation made live: here
// verifier-ballots-v4-definition-v7.json's `admitted` one (packages/crypto/
// scripts/verifier-ballots-v4-vectors.py with `7`), beside
// verifier-ballots-v4.json's for version 6. Every scenario of live.test.ts
// gets the same rows and report under both. The sealed definition's hash is
// the one the generator's own ballots name, and the live one, which every
// ballot, receipt and opening here binds, is `readDefinition`'s over the
// same encoding with only the live fields changed.
// Two scenarios are version 7's own: receipts and an opening made for the
// same election read as version 6. 7.5's and 7.6's gates in `verifyBundle`,
// the copies admission gives and the live restriction run on the version-7
// file's own `live` and `admitted` cases.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
}
interface File {
  readonly panels: Readonly<Record<string, unknown>>;
  readonly clock: Readonly<Record<string, string>>;
  readonly cases: readonly Case[];
}
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as File;
const v7 = read("verifier-ballots-v4-definition-v7.json");
const v6 = read("verifier-ballots-v4.json");
const byId = (file: File, id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};

type V7 = Extract<PanelledRecord, { readonly version: 7 }>;

const live7 = liveElection(byId(v7, "admitted").definition, byId(v7, "admitted").board);
const live6 = liveElection(byId(v6, "admitted").definition, byId(v6, "admitted").board);
const d = (live7.definition as V7).value;

/**
 * The same election read as version 6 (verifier-ballots-v4-vectors.py's
 * `v6_reading`): version 7's fields but the mode and the empty list,
 * pinning definition version 6.
 */
function v6Reading(value: V7["value"]) {
  const { electorate_mode: _mode, rolling_electorate: _rolling, ...fields } = value;
  return encodeElectionDefinitionV6({
    ...fields,
    profile: {
      ...fields.profile,
      pins: fields.profile.pins.map((p) =>
        p.record_type === RECORD_TYPES.electionDefinition ? { ...p, version: 6 } : p,
      ),
    },
  });
}
const V6_HASH = readDefinition(decodeDefinition(v6Reading(d))).hash;

/** The definition hash of every ballot on a case's board, as its generator made it. */
function ballotHashes(c: Case) {
  const hashes = new Set<string>();
  for (const e of splitEntries(hex(c.board)).entries) {
    const { payload } = decodeBoardEntry(e, 5);
    if (((payload[0] as number) << 8) + (payload[1] as number) === RECORD_TYPES.ballot)
      hashes.add(toHex(decodeBallot(payload, 4).definition_hash));
  }
  return [...hashes];
}

describe("the fixture's definition", () => {
  test("is a live version 7 under a fixed electorate without an author panel, and reads as version 6", () => {
    expect(live7.definition.version).toBe(7);
    expect(d.electorate_mode).toBe(ELECTORATE_MODES.fixed);
    expect(isPanelled(live7.definition)).toBe(true);
    expect(live7.rule).toBeUndefined();
    expect(d.author_keys).toEqual([]);
    expect(live7.CLOSES - live7.OPENS).toBe(168n * 3600n);
  });

  test("its hash is version 7's own: the one the generator's ballots name once sealed, never the version-6 reading's", () => {
    // The sealed definition's hash is the generator's: every ballot of its
    // `admitted` board names it (T-29, T-37).
    const sealed = decodeDefinition(hex(byId(v7, "admitted").definition));
    expect(ballotHashes(byId(v7, "admitted"))).toEqual([toHex(readDefinition(sealed).hash)]);
    // And `v6Reading` is the generator's: `v6-reading`'s stray ballot, made
    // for the same sealed election read as version 6, names its hash.
    const sealedV6 = readDefinition(decodeDefinition(v6Reading((sealed as V7).value))).hash;
    expect(ballotHashes(byId(v7, "v6-reading")).sort()).toEqual(
      [toHex(readDefinition(sealed).hash), toHex(sealedV6)].sort(),
    );
    // Made live, only the live fields move, and the hash with them.
    const back = decodeDefinition(
      encodeElectionDefinitionV7({
        ...d,
        results_mode: (sealed as V7).value.results_mode,
        live_every: (sealed as V7).value.live_every,
        live_batch: (sealed as V7).value.live_batch,
      }),
    );
    expect(toHex(readDefinition(back).hash)).toBe(toHex(readDefinition(sealed).hash));
    expect(toHex(live7.hash)).not.toBe(toHex(readDefinition(sealed).hash));
    expect(toHex(V6_HASH)).not.toBe(toHex(live7.hash));
  });

  test("is the version-6 fixture's election: the same clock, schedule and cells", () => {
    expect([live7.OPENS, live7.CLOSES]).toEqual([live6.OPENS, live6.CLOSES]);
    expect(live7.BLOCKS).toEqual(live6.BLOCKS);
    const v6d = (live6.definition as Extract<PanelledRecord, { readonly version: 6 }>).value;
    expect([d.live_every, d.live_batch, d.panel_size, d.threshold]).toEqual([
      v6d.live_every,
      v6d.live_batch,
      v6d.panel_size,
      v6d.threshold,
    ]);
    expect(d.electorate).toEqual(v6d.electorate);
  });
});

type Live = ReturnType<typeof liveElection>;

// live.test.ts's scenarios, each built the same way under either definition.
const SCENARIOS: Record<string, (l: Live) => ReturnType<typeof releaseChecks>> = {
  honest: (l) => {
    const e = l.honest();
    e.board(50, e.opening(l.BATCH_A, 1, 1));
    return releaseChecks(e.inputs());
  },
  "receipts boarded after the snapshot": (l) => {
    const e = l.honest(true);
    e.board(50, e.opening(l.BATCH_A, 1, 1));
    return releaseChecks(e.inputs());
  },
  "a later ballot with another L1 reference": (l) => {
    const e = l.honest();
    e.board(50, e.opening(l.BATCH_A, 1, 1));
    const first = l.BATCH_A[0] as (typeof l.BATCH_A)[number];
    e.ballot(first, 60, sha256(Uint8Array.from([...first.hash, 1])));
    return releaseChecks(e.inputs());
  },
  "an unscheduled opening that discloses": (l) => {
    const e = l.honest();
    e.board(50, e.opening(l.BATCH_A, 1, 1));
    e.board(80, e.opening([...l.BATCH_A, ...l.BATCH_B], 2, 2));
    return releaseChecks(e.inputs());
  },
  "an opening that doesn't open": (l) => {
    const e = l.honest();
    e.board(
      50,
      e.opening(l.BATCH_A, 1, 3, (o) => o.map((s, j) => (j === 0 ? { ...s, v: s.v + 1n } : s))),
    );
    return releaseChecks(e.inputs());
  },
  "only the anchored extent": (l) => {
    const e = l.honest();
    const extent = e.entries.length;
    e.board(50, e.opening(l.BATCH_A, 1, 1));
    return releaseChecks(e.inputs({ extent }));
  },
  "headers short of the last snapshot": (l) => {
    const e = l.honest();
    const end7 = l.OPENS + 168n * 3600n;
    return releaseChecks(e.inputs({ blocks: l.BLOCKS.filter((b) => b.timestamp < end7) }));
  },
};

describe("a fixed version 7 gets version 6's rows and report", { timeout: 120_000 }, () => {
  for (const [name, scenario] of Object.entries(SCENARIOS))
    test(name, () => {
      const r7 = scenario(live7);
      const r6 = scenario(live6);
      expect(Object.fromEntries(r7.rows)).toEqual(Object.fromEntries(r6.rows));
      expect(r7.report).toEqual(r6.report);
    });

  test("the honest election's release is batch A's counts, signed by seat 1", () => {
    // The comparison above can't tell two empty reports apart: this one
    // passes, with a release (live.test.ts states every field).
    const r = SCENARIOS["honest"]?.(live7);
    expect(Object.fromEntries(r?.rows ?? [])).toEqual({
      "7.5": { status: "pass" },
      "7.6": { status: "pass" },
    });
    expect(r?.report?.cells[2]?.releases).toEqual([
      { snapshot: 1, size: 20, entered: 20, counts: counts(20, VOTE), signers: [1] },
    ]);
    expect(r?.report?.cells[2]?.finalBatch).toMatchObject({ cut: 20, flagged: false });
  });
});

describe(
  "records made for the version-6 reading of the same election are another election's",
  {
    timeout: 120_000,
  },
  () => {
    test("an opening: stray, against its signer, and the release it names has no counts", () => {
      // It binds the version-6 encoding's hash, so it is no release of this
      // election, whatever it opens (T-29, T-37).
      const e = live7.honest();
      const at = e.board(50, e.opening(live7.BATCH_A, 1, 1, undefined, V6_HASH));
      const r = releaseChecks(e.inputs());
      expect(r.rows.get("7.5")).toEqual({ status: "pass" });
      expect(r.rows.get("7.6")).toEqual({
        status: "fail",
        code: "running-stray",
        at: { entry: at },
      });
      expect(r.report?.openings).toEqual([
        {
          entry: at,
          cell: 2,
          snapshot: 1,
          signer: 1,
          kind: "outside-schedule",
          breaks: [{ code: "running-stray" }],
          blamed: 1,
        },
      ]);
      expect(r.report?.cells[2]?.releases).toEqual([
        { snapshot: 1, size: 20, entered: 20, counts: null, signers: [] },
      ]);
    });

    test("receipts: no ballot they name enters a running set, so nothing is released", () => {
      // Batch A is receipted only for the version-6 reading's hash, then
      // batch B for this election's: R_1 is empty, so snapshot 1 fails the
      // batch rule, and R_2 is batch B's 20 with nothing entering after it,
      // so the lag rule never lets snapshot 2 through. No snapshot is chosen,
      // and an opening of batch A at snapshot 1 is unscheduled over a set
      // R_1 isn't (T-16).
      const e = live7.election();
      for (const b of live7.BATCH_A) e.ballot(b, 10);
      e.deliver([...live7.BATCH_A], 11, undefined, V6_HASH);
      for (const b of live7.BATCH_B) e.ballot(b, 30);
      e.deliver([...live7.BATCH_B], 31);
      const at = e.board(50, e.opening(live7.BATCH_A, 1, 1));
      const r = releaseChecks(e.inputs({ counted: [new Set(), new Set(), new Set()] }));
      expect(r.rows.get("7.5")).toEqual({ status: "pass" });
      expect(r.rows.get("7.6")).toEqual({
        status: "fail",
        code: "running-unscheduled",
        at: { entry: at },
      });
      expect(r.report?.cells[2]?.releases).toEqual([]);
      expect(r.report?.openings[0]).toMatchObject({
        kind: "outside-schedule",
        discloses: false,
        blamed: 1,
      });
    });
  },
);

const l1File = JSON.parse(readFileSync(new URL("l1-anchor.json", VECTORS), "utf8")) as {
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
const L1 = {
  firstSegment: closed.firstSegment,
  header: closed.block.header,
  nodes: closed.nodes,
  checkpoints: closed.checkpoints,
};

const row = (r: Report, id: string) => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
const bundle = (c: Case, definitionHex = c.definition) => {
  const sealed = decodeDefinition(hex(c.definition)) as V7;
  return verifyBundle(
    parseBundle(
      JSON.stringify({
        format: BUNDLE_FORMAT_BLOCKS,
        definition: definitionHex,
        clock: v7.clock,
        l1: L1,
        panel: v7.panels[c.panel],
        l1Blocks: run(21_000_000n, [
          sealed.value.opens_at - 3600n - 12n,
          sealed.value.closes_at + 3600n + 12n,
        ]).map((h) => toHex(h.encoded)),
      }),
      hex(c.board),
    ),
  );
};
/** `value` pinning tally-opening version 2 and board-entry version 6, as a live poll must. */
const pinnedForReleases = (value: V7["value"]) =>
  encodeElectionDefinitionV7({
    ...value,
    profile: {
      ...value.profile,
      pins: value.profile.pins.map((p) =>
        p.record_type === RECORD_TYPES.tallyOpening
          ? { ...p, version: 2 }
          : p.record_type === RECORD_TYPES.boardEntry
            ? { ...p, version: 6 }
            : p,
      ),
    },
  });

describe("7.5's and 7.6's gates in verifyBundle (Releases, step 1)", { timeout: 60_000 }, () => {
  test("a sealed definition has no releases: both pass, and the report has none", () => {
    const r = bundle(byId(v7, "admitted"));
    for (const id of ["7.5", "7.6"]) expect(row(r, id)).toEqual({ status: "pass" });
    expect(r).not.toHaveProperty("releases");
  });

  test("a live definition under tally-opening version 1 is a later release's", () => {
    const r = bundle(byId(v7, "live"));
    for (const id of ["7.5", "7.6"])
      expect(row(r, id)).toEqual({ status: "unverifiable", code: "unsupported-version", at: {} });
  });

  test("under tally-opening version 2, both wait on 7.1's pass", () => {
    const c = byId(v7, "live");
    const v = decodeDefinition(hex(c.definition)) as V7;
    const r = bundle(c, toHex(pinnedForReleases(v.value)));
    expect(row(r, "7.1").status).toBe("unverifiable");
    for (const id of ["7.5", "7.6"])
      expect(row(r, id)).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
    expect(r).not.toHaveProperty("releases");
  });
});

describe("the copies admission gives and the live restriction", { timeout: 60_000 }, () => {
  const panelOf = (c: Case) => {
    const parsed = parseBundle(
      JSON.stringify({
        format: BUNDLE_FORMAT_CEREMONY,
        definition: c.definition,
        clock: v7.clock,
        l1: L1,
        panel: v7.panels[c.panel],
      }),
      hex(c.board),
    );
    if (parsed.format !== BUNDLE_FORMAT_CEREMONY) throw new Error("fixture: not format 4");
    return parsed;
  };

  test("ballotChecks gives the copies only under a live definition", () => {
    const copies = (c: Case) => {
      const definition = decodeDefinition(hex(c.definition));
      const { entries } = splitEntries(hex(c.board));
      const parsed = panelOf(c);
      const ceremony = ceremonyChecks(
        definition.value,
        readDefinition(definition).stubHash,
        parsed.panel,
        authorRunOf(definition),
        entries,
        5,
      );
      if (ceremony.registered === undefined) throw new Error("fixture: no key set");
      return ballotChecks(definition, ceremony.registered, undefined, entries, 5, parsed.clock);
    };
    const r = copies(byId(v7, "live"));
    expect(r.live?.length).toBe(2);
    for (const l of r.live ?? []) {
      expect(l).toMatchObject({ member: true, rejected: false, referenceKnown: true });
      expect(l.tally?.deliveryV4).toBeDefined();
    }
    expect(r.live?.map((l) => l.entry)).toEqual(r.candidates?.map((c) => c.entry));
    expect(copies(byId(v7, "admitted")).live).toBeUndefined();
  });

  // Admission runs 2.3's live restriction with the same pins `verifyBundle`
  // reads (docs/spec/verifier.md, 2.3; T-16, T-45).
  const livePinned = pinnedForReleases(d);
  const { panel } = panelOf(byId(v7, "admitted"));
  const pinnedWith = (ours: number): PinnedPanel[] => [
    {
      panelId: toHex(d.panel_id),
      kind: "transitional",
      seats: Array.from({ length: d.panel_size }, (_, i) => ({
        holder: `seat ${i + 1}`,
        ours: i < ours,
      })),
    },
  ];

  test("admission refuses a live poll under fewer than k seats pinned as ours, and by default", () => {
    for (const pins of [undefined, [], ...[0, d.threshold - 1].map(pinnedWith)])
      expect(electionAdmission(livePinned, panel, [], pins), JSON.stringify(pins)).toEqual({
        ok: false,
        code: "profile-combination",
      });
  });

  test("admission passes the restriction under k seats pinned as ours, and goes on to the ceremony", () => {
    const r = electionAdmission(livePinned, panel, [], pinnedWith(d.threshold));
    expect(r).toEqual({ ok: false, code: "ceremony-transcript-missing" });
  });
});
