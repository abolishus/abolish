import {
  BoardError,
  decodeOpening,
  openingV2CoreHash,
  RECORD_TYPES,
  ceremonyTranscriptHash,
  decodeBoardEntry,
  decodeElectionDefinitionRecord,
  type ElectionDefinitionV4,
  electionDefinitionV4Hash,
  encodeBoardEntry,
  encodeElectionDefinitionV4,
  splitSegmentObject,
} from "@abolishus/crypto";
import { beforeAll, describe, expect, it } from "vite-plus/test";
import { runSimulation, type Scenario, type SimulationReport } from "../src/index.ts";
import { SimulatedAnchor } from "../src/simulation/anchor.ts";
import { SegmentPublisher, SimulatedIpfs } from "../src/simulation/archive.ts";
import { SIMULATED_BOARD_ENTRY_VERSION } from "../src/simulation/election.ts";
import type { SimulatedL1 } from "../src/simulation/l1.ts";
import {
  judgeRebuild,
  type PublicRecord,
  type RebuildExpectation,
  RebuildError,
  rebuildElection,
} from "../src/simulation/rebuild.ts";

const timeout = 120_000;

// Every stage the rebuild reads: an offline seat posted by every voter, ballots
// cast directly during the outage, re-votes, and published openings.
const scenario: Scenario = {
  voters: 6,
  election: "plurality",
  options: 3,
  trustees: { panel: 3, threshold: 2, offline: [3], faulty: [], departures: [] },
  tiers: { "0": 1, "1": 1, "2": 0 },
  outage: { from: 0.5, to: 1 },
  challenges: 1,
  revotes: 0.5,
  publications: 1,
  postings: 1,
  reorgs: 0,
  seed: 11,
};

let report: SimulationReport;
let record: PublicRecord;
let ipfs: SimulatedIpfs;
// The core hashes of the published openings on the operator's copy before
// the wipe, read from the verifier's bundle rather than from the rebuild.
let spoiledBefore: string[];

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const typeOf = (p: Uint8Array) => ((p[0] ?? 0) << 8) | (p[1] ?? 0);

beforeAll(async () => {
  let captured: PublicRecord | undefined;
  let copy: Uint8Array | undefined;
  report = await runSimulation(scenario, {
    onPublicRecord: (r) => (captured = r),
    onBundle: (b) => (copy = b.board),
  });
  if (captured === undefined || copy === undefined) throw new Error("no public record");
  record = captured;
  ipfs = record.ipfs as SimulatedIpfs;
  spoiledBefore = splitSegmentObject(copy)
    .map((e) => decodeBoardEntry(e, SIMULATED_BOARD_ENTRY_VERSION).payload)
    .filter((p) => typeOf(p) === RECORD_TYPES.spoiledBallotOpening)
    .map((p) => hex(openingV2CoreHash(decodeOpening(p, 2), 2)));
}, timeout);

const rebuildCode = (r: PublicRecord) => {
  try {
    rebuildElection(r);
  } catch (e) {
    if (e instanceof RebuildError || e instanceof BoardError) return e.code;
    throw e;
  }
  return "rebuilt";
};

// The fetched board: every segment object the anchors name, split.
const boardOf = (r: PublicRecord) => {
  const seen = new Set<string>();
  const entries: Uint8Array[] = [];
  for (const a of r.anchor.anchors) {
    const key = a.checkpoint.object_cid.join();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(...splitSegmentObject(r.ipfs.get(a.checkpoint.object_cid) as Uint8Array));
  }
  return entries;
};

// `r` with its board replaced by `entries`, published and anchored as an
// honest operator and authority would have: a board whose anchors and
// archive agree, so only the checks after the board checks can refuse it.
const reanchored = (r: PublicRecord, entries: readonly Uint8Array[]): PublicRecord => {
  const store = new SimulatedIpfs();
  const publisher = new SegmentPublisher(store, SIMULATED_BOARD_ENTRY_VERSION);
  const first = decodeBoardEntry(entries[0] as Uint8Array, SIMULATED_BOARD_ENTRY_VERSION).segment;
  const seal = r.anchor.clock.lastSegment;
  const anchor = new SimulatedAnchor(r.electionId, first, seal, r.l1 as SimulatedL1);
  for (let s = first; s <= seal; s++) {
    publisher.publishThrough(entries, s);
    anchor.anchorThrough(entries, s);
  }
  return { ...r, anchor, ipfs: store };
};

// The transcript entry with its last byte changed.
const tamperedTranscript = (entries: readonly Uint8Array[]) => {
  const e = decodeBoardEntry(entries[0] as Uint8Array, SIMULATED_BOARD_ENTRY_VERSION);
  const payload = Uint8Array.from(e.payload);
  payload[payload.length - 1] = (payload.at(-1) ?? 0) ^ 1;
  return {
    payload,
    entries: [
      encodeBoardEntry({ ...e, payload }, SIMULATED_BOARD_ENTRY_VERSION),
      ...entries.slice(1),
    ],
  };
};

const expectationOf = (r: SimulationReport): RebuildExpectation => ({
  definitionHash: r.definition.hash,
  entries: r.board.entries,
  counted: r.board.counted,
  head: r.board.head,
  cast: r.ballots.cast,
  countedBallots: r.cells.reduce((n, c) => n + c.ballots, 0),
  undelivered: r.ballots.undelivered,
  cells: r.cells,
  destruction: r.destruction,
  spoiled: spoiledBefore,
});

describe("rebuildElection", { timeout }, () => {
  it("gives back every result of the run from chain and IPFS alone", () => {
    expect(report.ok).toBe(true);
    expect(report.ballots.direct).toBeGreaterThan(0);
    expect(report.board.spoiled).toBeGreaterThan(0);
    const rebuilt = rebuildElection(record);
    expect(report.rebuild).toEqual({
      objects: rebuilt.board.objects,
      entries: report.board.entries,
    });
    // One object per period that added entries, each named by its anchor.
    expect(rebuilt.board.objects).toBe(
      new Set(report.board.anchors.slice(0, -1).map((a) => a.size)).size,
    );
    expect(rebuilt.definitionHash).toBe(report.definition.hash);
    expect(rebuilt.board).toMatchObject({
      entries: report.board.entries,
      counted: report.board.counted,
      head: report.board.head,
    });
    expect(rebuilt.ballots.cast).toBe(report.ballots.cast);
    expect(rebuilt.ballots.undelivered).toBe(0);
    expect(rebuilt.cells.map((c) => c.counts)).toEqual(report.cells.map((c) => c.counts));
    expect(rebuilt.cells.map((c) => c.ballots)).toEqual(report.cells.map((c) => c.ballots));
    expect(rebuilt.total).toEqual(report.total);
    expect(rebuilt.destruction).toEqual(report.destruction);
    expect(rebuilt.spoiled).toHaveLength(report.board.spoiled);
    expect(rebuilt.spoiled).toEqual(spoiledBefore);
    expect(rebuilt.ballots.rejected).toBe(0);
    expect(judgeRebuild(rebuilt, expectationOf(report))).toEqual([]);
  });

  it("refuses when any segment object or entry-hash list is withheld", () => {
    const cps = [...new Set(record.anchor.anchors.map((a) => a.checkpoint))];
    for (const [cid, code] of [
      [cps[0]?.object_cid, "object-unavailable"],
      [cps.at(-1)?.object_cid, "object-unavailable"],
      [cps[1]?.hashes_cid, "hashes-unavailable"],
    ] as const) {
      const held = ipfs.get(cid as Uint8Array) as Uint8Array;
      ipfs.replace(cid as Uint8Array, undefined);
      expect(rebuildCode(record)).toBe(code);
      // A mirror serving other bytes under the CID is no better.
      ipfs.replace(
        cid as Uint8Array,
        Uint8Array.from(held, (b, i) => (i === 0 ? b ^ 1 : b)),
      );
      expect(rebuildCode(record)).toBe(code);
      ipfs.replace(cid as Uint8Array, held);
    }
    expect(rebuildCode(record)).toBe("rebuilt");
  });

  it("refuses an object an anchor names that doesn't split into entries", () => {
    const store = new SimulatedIpfs();
    const object = Uint8Array.of(1, 2, 3);
    const cid = store.put(object);
    const anchors = record.anchor.anchors.map((a, i) =>
      i === 0 ? { ...a, checkpoint: { ...a.checkpoint, object_cid: cid } } : a,
    );
    const first = record.anchor.anchors[0]?.checkpoint.hashes_cid as Uint8Array;
    store.put(ipfs.get(first) as Uint8Array);
    expect(rebuildCode({ ...record, anchor: { ...record.anchor, anchors }, ipfs: store })).toBe(
      "object-malformed",
    );
  });

  it("fails the board checks when an anchor is missing", () => {
    const { anchors } = record.anchor;
    // Without the seal's anchor the board is unsealed; without an earlier
    // one, its period is unanchored.
    expect(
      rebuildCode({ ...record, anchor: { ...record.anchor, anchors: anchors.slice(0, -1) } }),
    ).toBe("unsealed");
    expect(
      rebuildCode({ ...record, anchor: { ...record.anchor, anchors: anchors.slice(1) } }),
    ).toBe("copy-mismatch");
  });

  it("rebuilds the same results from a board published and anchored afresh", () => {
    const rebuilt = rebuildElection(reanchored(record, boardOf(record)));
    expect(judgeRebuild(rebuilt, expectationOf(report))).toEqual([]);
  });

  it("refuses an election the registry doesn't hold, and a definition it didn't register", () => {
    expect(rebuildCode({ ...record, electionId: new Uint8Array(32) })).toBe(
      "definition-unregistered",
    );
    const registry = record.electionRegistry;
    const held = registry.definitionOf(record.electionId) as Uint8Array;
    const d = decodeElectionDefinitionRecord(held).value as ElectionDefinitionV4;
    const other = encodeElectionDefinitionV4({ ...d, option_count: d.option_count + 1 });
    // Another definition under the registered hash, and the registered one
    // under another hash.
    expect(
      rebuildCode({
        ...record,
        electionRegistry: { ...registryOf(record), definitionOf: () => other },
      }),
    ).toBe("definition-mismatch");
    expect(
      rebuildCode({
        ...record,
        electionRegistry: { ...registryOf(record), definitionHashOf: () => new Uint8Array(32) },
      }),
    ).toBe("definition-mismatch");
  });

  it("refuses a panel the trustee registry doesn't pin, and a key set it didn't record", () => {
    const trustees = record.trusteeRegistry;
    const of = {
      panelOf: (id: Uint8Array) => trustees.panelOf(id),
      keySetOf: (stub: Uint8Array, id: Uint8Array) => trustees.keySetOf(stub, id),
    };
    expect(rebuildCode({ ...record, trusteeRegistry: { ...of, panelOf: () => undefined } })).toBe(
      "panel-unpinned",
    );
    expect(rebuildCode({ ...record, trusteeRegistry: { ...of, keySetOf: () => undefined } })).toBe(
      "key-set-mismatch",
    );
    expect(
      rebuildCode({
        ...record,
        trusteeRegistry: {
          ...of,
          keySetOf: (stub, id) => {
            const k = trustees.keySetOf(stub, id);
            if (k === undefined) return undefined;
            return { ...k, keySetHash: Uint8Array.from(k.keySetHash, (b, i) => (i ? b : b ^ 1)) };
          },
        },
      }),
    ).toBe("key-set-mismatch");
  });

  it("refuses a board whose first entry isn't the transcript the definition names, and a transcript that fails its check", () => {
    const { payload, entries } = tamperedTranscript(boardOf(record));
    const tampered = reanchored(record, entries);
    expect(rebuildCode(tampered)).toBe("transcript-mismatch");
    // A registered definition naming the tampered transcript: the ceremony
    // check over it fails.
    const d = decodeElectionDefinitionRecord(
      record.electionRegistry.definitionOf(record.electionId) as Uint8Array,
    ).value as ElectionDefinitionV4;
    const naming = { ...d, ceremony_transcript_hash: ceremonyTranscriptHash(payload) };
    expect(
      rebuildCode({
        ...tampered,
        electionRegistry: {
          definitionOf: () => encodeElectionDefinitionV4(naming),
          definitionHashOf: () => electionDefinitionV4Hash(naming),
        },
      }),
    ).toBe("ceremony-failed");
  });

  it("refuses a registered encoding that doesn't decode, and a definition for another election or board-entry version", () => {
    const d = definitionOf(record);
    expect(
      rebuildCode({
        ...record,
        electionRegistry: { ...registryOf(record), definitionOf: () => Uint8Array.of(0, 1, 4) },
      }),
    ).toBe("definition-mismatch");
    expect(
      rebuildCode(withDefinition(record, { ...d, election_id: new Uint8Array(32).fill(9) })),
    ).toBe("definition-mismatch");
    const pins = d.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.boardEntry ? { ...p, version: 4 } : p,
    );
    expect(rebuildCode(withDefinition(record, { ...d, profile: { ...d.profile, pins } }))).toBe(
      "definition-mismatch",
    );
    // The registered definition itself, served by the same stand-in, rebuilds.
    expect(rebuildCode(withDefinition(record, d))).toBe("rebuilt");
  });

  it("refuses a pinned panel that isn't the one the definition names", () => {
    const trustees = record.trusteeRegistry;
    expect(
      rebuildCode({
        ...record,
        trusteeRegistry: {
          keySetOf: (stub, id) => trustees.keySetOf(stub, id),
          panelOf: (id) => {
            const p = trustees.panelOf(id);
            return p === undefined ? undefined : { ...p, keys: [...p.keys].reverse() };
          },
        },
      }),
    ).toBe("panel-unpinned");
  });

  it("refuses an anchor clock other than the one the definition's windows assume", () => {
    const { clock } = record.anchor;
    for (const other of [
      { ...clock, lastSegment: clock.lastSegment + 1 },
      { ...clock, deadline: clock.deadline + 1n },
      { ...clock, period: clock.period * 2n },
      { ...clock, epoch: 1n },
    ])
      expect(rebuildCode({ ...record, anchor: { ...record.anchor, clock: other } })).toBe(
        "clock-mismatch",
      );
  });

  it("fetches nothing an untimely anchor names, as the board checks count none", () => {
    const { anchors, clock } = record.anchor;
    const first = anchors[0] as (typeof anchors)[number];
    // Anchored long after its deadline, naming an object no one serves.
    const late = {
      checkpoint: { ...first.checkpoint, size: 1n << 40n, object_cid: new Uint8Array(36) },
      anchoredAt: first.anchoredAt + clock.period * 10n,
    };
    expect(
      rebuildCode({ ...record, anchor: { ...record.anchor, anchors: [...anchors, late] } }),
    ).toBe("rebuilt");
  });

  it("rejects a ballot entry that doesn't decode without stopping, and rebuilds every result", () => {
    const decoded = boardOf(record).map((e) => decodeBoardEntry(e, SIMULATED_BOARD_ENTRY_VERSION));
    // After the counted extent's last ballot, in its segment.
    const at = decoded.findLastIndex((e) => typeOf(e.payload) === RECORD_TYPES.ballot) + 1;
    const junk = {
      ...(decoded[at - 1] as (typeof decoded)[number]),
      index: BigInt(at),
      payload: Uint8Array.of(RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 2, 1, 2, 3),
    };
    const board = [
      ...decoded.slice(0, at),
      junk,
      ...decoded.slice(at).map((e) => ({ ...e, index: e.index + 1n })),
    ].map((e) => encodeBoardEntry(e, SIMULATED_BOARD_ENTRY_VERSION));
    const rebuilt = rebuildElection(reanchored(record, board));
    expect(rebuilt.ballots.rejected).toBe(1);
    expect(rebuilt.board.entries).toBe(report.board.entries + 1);
    expect(rebuilt.cells.map((c) => c.counts)).toEqual(report.cells.map((c) => c.counts));
    expect(rebuilt.destruction).toEqual(report.destruction);
    expect(
      judgeRebuild(rebuilt, expectationOf(report)).map((d) => d.slice(0, d.indexOf(":"))),
    ).toEqual(["board entries", "counted extent", "board head", "entries rejected"]);
  });

  it("reads the contract-path postings from chain: without them, ballots posting a down seat aren't delivered", () => {
    const rebuilt = rebuildElection({ ...record, postings: [] });
    expect(rebuilt.ballots.undelivered).toBeGreaterThan(0);
    const differences = judgeRebuild(rebuilt, expectationOf(report));
    expect(differences.some((d) => d.startsWith("ballots counted"))).toBe(true);
    expect(differences.some((d) => d.startsWith("cells"))).toBe(true);
  });
});

const definitionOf = (r: PublicRecord) =>
  decodeElectionDefinitionRecord(r.electionRegistry.definitionOf(r.electionId) as Uint8Array)
    .value as ElectionDefinitionV4;

// `r` with a registry that holds `d` and its hash for the election asked about.
const withDefinition = (r: PublicRecord, d: ElectionDefinitionV4): PublicRecord => ({
  ...r,
  electionRegistry: {
    definitionOf: () => encodeElectionDefinitionV4(d),
    definitionHashOf: () => electionDefinitionV4Hash(d),
  },
});

const registryOf = (r: PublicRecord) => ({
  definitionOf: (id: Uint8Array) => r.electionRegistry.definitionOf(id),
  definitionHashOf: (id: Uint8Array) => r.electionRegistry.definitionHashOf(id),
});

describe("judgeRebuild", { timeout }, () => {
  it("names every result the rebuild gave otherwise, and nothing when all agree", () => {
    const rebuilt = rebuildElection(record);
    const want = expectationOf(report);
    expect(judgeRebuild(rebuilt, want)).toEqual([]);
    const changed: [Partial<RebuildExpectation>, string][] = [
      [{ definitionHash: "00" }, "definition"],
      [{ entries: want.entries + 1 }, "board entries"],
      [{ counted: want.counted - 1 }, "counted extent"],
      [{ head: "00" }, "board head"],
      [{ cast: want.cast + 1 }, "ballots cast"],
      [{ countedBallots: want.countedBallots + 1 }, "ballots counted"],
      [{ undelivered: 1 }, "ballots undelivered"],
      [{ cells: want.cells.slice(1) }, "cells"],
      [
        { cells: want.cells.map((c, i) => (i === 0 ? { tier: c.tier, ballots: c.ballots } : c)) },
        "cells",
      ],
      [{ destruction: { ...want.destruction, from: want.destruction.from + 1 } }, "destruction"],
      [{ spoiled: want.spoiled.slice(1) }, "spoiled openings"],
    ];
    for (const [change, what] of changed) {
      const got = judgeRebuild(rebuilt, { ...want, ...change } as RebuildExpectation);
      expect(got).toHaveLength(1);
      expect(got[0]).toMatch(new RegExp(`^${what}: `));
    }
  });
});
