import { readFileSync } from "node:fs";
import {
  type CommittedVote,
  decode,
  element,
  leastDirectedCut,
  list,
  releaseGraph,
  type ReleaseChoice,
  type RunningSet,
  type TallyElection,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  copyStatus,
  type LiveBlock,
  type LiveCopy,
  type LiveReleases,
  liveReleases,
  type LiveRunning,
  liveRunning,
  type RunningOpeningFacts,
  runningOpeningFacts,
  snapshotHeads,
} from "../src/releases.ts";

// Releases (docs/spec/verifier.md, Releases; 7.5, 7.6 and 8.2's
// `live-final-batch`). live-verifier.json comes from an independent Python
// implementation of the section (packages/crypto/scripts/
// live-verifier-vectors.py), whose ballots and openings are a model: a
// ballot's admission results and an opening's fields are given, so the
// adapter below turns each into the facts the verifier's own checks would
// find. running-opening.json (scripts/running-opening-vectors.py) gives the
// byte-level openings `runningOpeningFacts` judges.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

interface ModelBallot {
  readonly id: string;
  readonly message: string;
  readonly cell: number;
  readonly segment: number;
  readonly ref: number;
  readonly receipted: number | null;
  readonly votes: readonly number[];
  readonly member?: boolean;
  readonly stepFinalAt?: number;
  readonly refKnown?: boolean;
  readonly invalid?: string;
}

interface ModelOpening {
  readonly entry: number;
  readonly cell: number;
  readonly snapshot: number;
  readonly signer: number | null;
  readonly message: string;
  readonly thisDefinition?: boolean;
  readonly aggregateOf?: number;
  readonly entries?: number;
  readonly counts?: readonly number[];
  readonly badR?: number;
  readonly randomness?: string;
  readonly bindingBroken?: boolean;
}

interface ModelCase {
  readonly id: string;
  readonly snapshots: readonly { readonly segment: number; readonly head: number }[];
  readonly nullifiers: Readonly<
    Record<string, { readonly tier: number; readonly ballots: readonly ModelBallot[] }>
  >;
}

interface Election extends ModelCase {
  readonly batch: number;
  readonly options: number;
  readonly questions: readonly {
    readonly options: number;
    readonly min: number;
    readonly max: number;
  }[];
  readonly cellTiers: readonly number[];
  readonly openings: readonly ModelOpening[];
  readonly result: {
    readonly runningSets: readonly (readonly Readonly<Record<string, string>>[])[];
    readonly finalBallots: readonly Readonly<Record<string, string>>[];
    readonly tiers: readonly {
      readonly tier: number;
      readonly decisions: readonly {
        readonly at: number;
        readonly release: number | null;
        readonly refused: Readonly<Record<string, string>>;
      }[];
      readonly releases: readonly { readonly snapshot: number; readonly counts: string[] | null }[];
    }[];
    readonly cells: readonly {
      readonly cell: number;
      readonly tier: number;
      readonly releases: readonly {
        readonly snapshot: number;
        readonly size: number;
        readonly entered: number;
        readonly counts: string[] | null;
        readonly signers: number[];
      }[];
      readonly finalBatch: {
        readonly cut: number | null;
        readonly flagged: boolean;
        readonly side: { kind: string; release: number | null; ballots: string[] } | null;
      } | null;
    }[];
    readonly openings: readonly {
      readonly entry: number;
      readonly cell: number;
      readonly snapshot: number;
      readonly signer: number | null;
      readonly kind: string;
      readonly passes?: boolean;
      readonly discloses?: boolean;
      readonly breaks: readonly Readonly<Record<string, unknown>>[];
      readonly blamed: number | null;
    }[];
    readonly rows: Readonly<Record<"7.5" | "7.6", Readonly<Record<string, unknown>>>>;
  };
}

const file = read("live-verifier.json") as {
  readonly format: string;
  readonly minLiveBatch: string;
  readonly heads: readonly {
    readonly id: string;
    readonly epoch: string;
    readonly period: string;
    readonly opensAt: string;
    readonly closesAt: string;
    readonly liveEvery: number;
    readonly blocks: {
      readonly first: { readonly number: string; readonly timestamp: string };
      readonly last: { readonly number: string; readonly timestamp: string };
      readonly spacing: string;
      readonly missing: readonly string[];
    };
    readonly snapshots: readonly {
      readonly segment: number;
      readonly head: { readonly number: string; readonly timestamp: string } | null;
    }[];
  }[];
  readonly ballots: ModelCase & {
    readonly statuses: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
    readonly runningSets: readonly (readonly Readonly<Record<string, string>>[])[];
  };
  readonly elections: readonly Election[];
};

const NO_HASH = new Uint8Array(32);
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Each model ballot as a copy, entries numbered by segment, then nullifier, then list order. */
function copiesOf(c: ModelCase) {
  const all = Object.entries(c.nullifiers).flatMap(([nullifier, n]) =>
    n.ballots.map((b, i) => ({ nullifier, tier: n.tier, b, i })),
  );
  all.sort(
    (x, y) =>
      x.b.segment - y.b.segment ||
      (x.nullifier < y.nullifier ? -1 : x.nullifier > y.nullifier ? 1 : 0) ||
      x.i - y.i,
  );
  const byId = new Map<string, LiveCopy<string, string>>();
  const copies = all.map(({ nullifier, b }, entry): LiveCopy<string, string> => {
    const copy = {
      entry,
      segment: b.segment,
      nullifier,
      ballot: b.message,
      cell: b.cell,
      stepFinalAt: b.stepFinalAt === undefined ? null : BigInt(b.stepFinalAt),
      member: b.member ?? true,
      rejected: b.invalid !== undefined,
      reference: BigInt(b.ref),
      referenceKnown: b.refKnown ?? true,
      receiptedAt: b.receipted,
    };
    byId.set(b.id, copy);
    return copy;
  });
  const message = new Map(all.map(({ b }) => [b.id, b.message] as const));
  const votes = new Map(all.map(({ b }) => [b.message, b.votes] as const));
  const atEntry = new Map(copies.map((c) => [c.entry, c.ballot] as const));
  return { copies, byId, message, votes, atEntry };
}

const snapshotsOf = (c: ModelCase) =>
  c.snapshots.map((s) => ({
    segment: s.segment,
    head: { number: BigInt(s.head), timestamp: 0n, hash: NO_HASH },
  }));

/** A running set by message, from the vector's nullifier-to-ballot-id objects. */
const setOf = (o: Readonly<Record<string, string>>, message: ReadonlyMap<string, string>) =>
  new Map(Object.entries(o).map(([n, id]) => [n, message.get(id) as string] as const));

const sameSet = (a: RunningSet<string, string>, b: RunningSet<string, string>) =>
  a.size === b.size && [...a].every(([n, v]) => b.get(n) === v);

/**
 * The model's openings as the verifier's facts: `aggregateOf` is the
 * running set its aggregate is over, `counts` its `V`s (by default the
 * totals of that set), `badR` an option whose `R` doesn't open, and
 * `bindingBroken` other counts opening the aggregate, which only a known
 * `log_g h` allows (live-verifier-vectors.py, judge_openings).
 */
function factsOf(
  e: Election,
  running: LiveRunning<string, string>,
  votes: ReadonlyMap<string, readonly number[]>,
) {
  const totals = (set: RunningSet<string, string>) => {
    const out = Array.from({ length: e.options }, () => 0n);
    for (const b of set.values())
      for (const [j, v] of (votes.get(b) as readonly number[]).entries())
        out[j] = (out[j] as bigint) + BigInt(v);
    return out;
  };
  return e.openings.map((o): RunningOpeningFacts => {
    const thisElection = o.thisDefinition ?? true;
    const entries = o.entries ?? e.options;
    const sets = running.sets[o.cell];
    const target = sets?.[o.snapshot];
    const over = sets?.[o.aggregateOf ?? o.snapshot];
    const counts = o.counts?.map(BigInt) ?? totals(over ?? target ?? new Map());
    const facts = {
      entry: o.entry,
      thisElection,
      cell: o.cell,
      snapshot: o.snapshot,
      signer: o.signer,
      entries,
      message: o.message,
      opening: JSON.stringify([counts.map(String), o.randomness ?? "summed"]),
      counts,
    };
    if (!thisElection || target === undefined || o.snapshot < 1 || entries !== e.options)
      return facts;
    if (over === undefined || !sameSet(over, target))
      return { ...facts, verdict: { passes: false, reason: "aggregate" } };
    const want = totals(target);
    const bad =
      o.bindingBroken === true ? [] : counts.flatMap((v, j) => (v !== want[j] ? [j] : []));
    if (o.badR !== undefined) bad.push(o.badR);
    return bad.length === 0
      ? { ...facts, verdict: { passes: true } }
      : { ...facts, verdict: { passes: false, reason: "opening", option: Math.min(...bad) } };
  });
}

function run(e: Election) {
  const model = copiesOf(e);
  const running = liveRunning({
    cellTiers: e.cellTiers,
    snapshots: snapshotsOf(e),
    copies: model.copies,
    batch: e.batch,
  });
  const counted = e.result.finalBallots.map(
    (f) => new Set(Object.values(f).map((id) => model.message.get(id) as string)),
  );
  const result = liveReleases({
    running,
    rules: {
      optionCount: e.options,
      questions: e.questions.map((q) => ({
        optionCount: q.options,
        minSelections: q.min,
        maxSelections: q.max,
      })),
    },
    batch: e.batch,
    openings: factsOf(e, running, model.votes),
    counted,
  });
  return { model, running, result };
}

/** A decision in the vector's shape: refused candidates as an object (key order aside). */
const decisionsOf = (choice: ReleaseChoice) =>
  choice.decisions.map((d) => ({
    at: d.at,
    release: d.release,
    refused: Object.fromEntries([...d.refused].map(([q, r]) => [String(q), r])),
  }));

describe("live-verifier.json", () => {
  test("is the file this suite reads", () => {
    expect(file.format).toBe("abolish-live-verifier-vectors/1");
    expect(file.minLiveBatch).toBe("20");
  });

  test.each(file.heads)("snapshot heads: $id", (h) => {
    const epoch = BigInt(h.epoch);
    const first = BigInt(h.blocks.first.number);
    const spacing = BigInt(h.blocks.spacing);
    const missing = new Set(h.blocks.missing);
    const blocks: LiveBlock[] = [];
    for (let n = first; n <= BigInt(h.blocks.last.number); n++) {
      const timestamp = BigInt(h.blocks.first.timestamp) + (n - first) * spacing;
      if (!missing.has(String(timestamp))) blocks.push({ number: n, timestamp, hash: NO_HASH });
    }
    const got = snapshotHeads(
      { epoch, period: BigInt(h.period) },
      BigInt(h.opensAt),
      BigInt(h.closesAt),
      h.liveEvery,
      blocks,
    );
    const short = h.snapshots.findIndex((s) => s.head === null);
    if (short !== -1) {
      expect(got).toEqual({ ok: false, code: "l1-blocks-short", at: { snapshot: short + 1 } });
      return;
    }
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(
      got.snapshots.map((s) => ({
        segment: s.segment,
        head: { number: String(s.head.number), timestamp: String(s.head.timestamp) },
      })),
    ).toEqual(h.snapshots);
  });

  test("each copy's standing at each snapshot, and the running sets", () => {
    const b = file.ballots;
    const model = copiesOf(b);
    for (const [, ids] of Object.entries(b.statuses))
      for (const [id, statuses] of Object.entries(ids)) {
        const copy = model.byId.get(id) as LiveCopy<string, string>;
        expect(b.snapshots.map((s) => copyStatus(copy, s.segment, BigInt(s.head)))).toEqual(
          statuses,
        );
      }
    const running = liveRunning({
      cellTiers: [0],
      snapshots: snapshotsOf(b),
      copies: model.copies,
      batch: 20,
    });
    expect(running.sets.map((c) => c.slice(1))).toEqual(
      b.runningSets.map((c) => c.map((s) => setOf(s, model.message))),
    );
  });

  describe.each(file.elections)("$id", (e) => {
    const { model, running, result } = run(e);

    test("running sets and the release choice", () => {
      expect(running.sets.map((c) => c.slice(1))).toEqual(
        e.result.runningSets.map((c) => c.map((s) => setOf(s, model.message))),
      );
      expect([...running.choices.keys()]).toEqual(e.result.tiers.map((t) => t.tier));
      for (const t of e.result.tiers) {
        const choice = running.choices.get(t.tier) as ReleaseChoice;
        expect(decisionsOf(choice)).toEqual(t.decisions);
      }
    });

    test("the tiers' and cells' releases", () => {
      expect(result.tiers.map((t) => ({ tier: t.tier, releases: t.releases }))).toEqual(
        e.result.tiers.map((t) => ({ tier: t.tier, releases: t.releases })),
      );
      const ballots = (entries: readonly number[]) =>
        entries.map((n) => model.atEntry.get(n) as string).sort(byString);
      expect(
        result.cells.map((c) => ({
          ...c,
          finalBatch:
            c.finalBatch === null
              ? null
              : {
                  ...c.finalBatch,
                  side:
                    c.finalBatch.side === null
                      ? null
                      : { ...c.finalBatch.side, ballots: ballots(c.finalBatch.side.ballots) },
                },
        })),
      ).toEqual(
        e.result.cells.map((c) => ({
          cell: c.cell,
          tier: c.tier,
          releases: c.releases.map(({ snapshot, size, entered, counts, signers }) => ({
            snapshot,
            size,
            entered,
            counts,
            signers,
          })),
          finalBatch:
            c.finalBatch === null
              ? null
              : {
                  ...c.finalBatch,
                  side:
                    c.finalBatch.side === null
                      ? null
                      : {
                          ...c.finalBatch.side,
                          ballots: c.finalBatch.side.ballots
                            .map((id) => model.message.get(id) as string)
                            .sort(byString),
                        },
                },
        })),
      );
    });

    test("each running opening's breaks and blame", () => {
      expect(result.openings).toEqual(
        e.result.openings.map((o) => ({
          entry: o.entry,
          cell: o.cell,
          snapshot: o.snapshot,
          signer: o.signer,
          kind: o.kind,
          ...(o.passes === undefined ? {} : { passes: o.passes }),
          ...(o.discloses === undefined ? {} : { discloses: o.discloses }),
          breaks: o.breaks,
          blamed: o.blamed,
        })),
      );
    });

    test("the 7.5 and 7.6 rows", () => {
      expect(result.rows).toEqual(e.result.rows);
    });
  });
});

describe("running-opening.json through runningOpeningFacts", () => {
  const v = read("running-opening.json") as {
    readonly election: {
      readonly definitionHash: string;
      readonly rules: TallyElection["rules"];
      readonly registered: readonly { readonly index: number; readonly signingKey: string }[];
      readonly chosen: readonly { readonly tier: number; readonly snapshots: readonly number[] }[];
      readonly cells: readonly {
        readonly cell: number;
        readonly tier: number;
        readonly ballots: readonly { readonly enters: number; readonly vss: string }[];
      }[];
    };
    readonly boards: readonly {
      readonly id: string;
      readonly payloads: readonly string[];
      readonly result: {
        readonly entries: readonly {
          readonly at: number;
          readonly kind: string;
          readonly snapshot?: number;
          readonly cell?: number;
          readonly signer?: number | null;
          readonly passes?: boolean;
          readonly reason?: string;
          readonly option?: number;
          readonly error?: string;
        }[];
        readonly releases: readonly {
          readonly snapshot: number;
          readonly cell: number;
          readonly counts: string[] | null;
        }[];
      };
    }[];
  };
  const VSS = list(list(element, 16), 64);
  const election = {
    definitionHash: hex(v.election.definitionHash),
    rules: v.election.rules,
    registered: v.election.registered.map((k) => ({
      index: k.index,
      signingKey: hex(k.signingKey),
    })),
  };
  // Ballots are named `c<cell>-<i>`; R_{q,c} holds those that entered by q.
  const vss = new Map<string, CommittedVote["vss"]>();
  const last = Math.max(...v.election.cells.flatMap((c) => c.ballots.map((b) => b.enters)));
  const sets = v.election.cells.map((c) => {
    for (const [i, b] of c.ballots.entries())
      vss.set(`c${c.cell}-${i}`, decode(VSS, hex(b.vss)) as CommittedVote["vss"]);
    return Array.from(
      { length: last + 1 },
      (_, q) =>
        new Map(
          c.ballots.flatMap((b, i) =>
            b.enters <= q ? [[`n${c.cell}-${i}`, `c${c.cell}-${i}`] as const] : [],
          ),
        ),
    );
  });
  // The vectors take the chosen releases as inputs, so the choice is given
  // here too; every other value is the verifier's.
  const running: LiveRunning<string, string> = {
    cellTiers: v.election.cells.map((c) => c.tier),
    snapshots: Array.from({ length: last }, (_, i) => ({
      segment: i,
      head: { number: BigInt(i), timestamp: 0n, hash: NO_HASH },
    })),
    sets,
    choices: new Map(
      v.election.chosen.map((t) => [t.tier, { releases: t.snapshots, decisions: [] }] as const),
    ),
    firstEntry: new Map([...vss.keys()].map((b, i) => [b, i] as const)),
  };
  const chosen = new Set(v.election.chosen.flatMap((t) => t.snapshots));

  test.each(v.boards)("$id", (board) => {
    const facts = runningOpeningFacts(
      election,
      running,
      board.payloads.map((p, i) => ({ entry: 100 + i, payload: hex(p) })),
      (b) => vss.get(b) as CommittedVote["vss"],
    );
    const result = liveReleases({
      running,
      rules: election.rules,
      batch: 20,
      openings: facts,
      counted: sets.map(() => new Set<string>()),
    });
    for (const [i, want] of board.result.entries.entries()) {
      const got = result.openings[i];
      expect(got?.entry).toBe(100 + i);
      if (want.kind === "rejected") {
        expect(got).toEqual({ entry: 100 + i, code: "decode", decodeError: want.error });
        continue;
      }
      if (got === undefined || "code" in got) throw new Error("decoded opening expected");
      expect(got.signer).toBe(want.signer);
      if (want.kind === "release") {
        expect(got.kind).toBe("release");
        expect(got.passes).toBe(want.passes);
        const breaks = got.breaks.filter(
          (b) =>
            b.code !== "running-unattributed" &&
            b.code !== "running-second" &&
            b.code !== "running-repeat",
        );
        expect(breaks).toEqual(
          want.passes === true
            ? []
            : want.reason === "entries"
              ? [{ code: "running-missing" }]
              : want.reason === "aggregate"
                ? [{ code: "running-aggregate" }]
                : [{ code: "running-opening", option: want.option }],
        );
      } else {
        // Outside the schedule: a stray one names another election or a cell
        // the partition lacks; an unscheduled one at a scheduled snapshot that
        // opens its set discloses (T-16).
        expect(got.kind).toBe("outside-schedule");
        const stray = got.breaks[0]?.code === "running-stray";
        expect(stray).toBe(
          got.cell >= sets.length ||
            facts[i] === undefined ||
            ("thisElection" in (facts[i] as object) &&
              !(facts[i] as { thisElection: boolean }).thisElection),
        );
        if (!stray) {
          expect(got.breaks[0]).toEqual({ code: "running-unscheduled" });
          expect(chosen.has(got.snapshot)).toBe(false);
          expect(got.discloses).toBe(
            got.snapshot >= 1 && got.snapshot <= last && board.id === "unchosen-snapshot",
          );
        }
      }
    }
    expect(
      result.cells.flatMap((c) =>
        c.releases.map((r) => ({ snapshot: r.snapshot, cell: c.cell, counts: r.counts })),
      ),
    ).toEqual(board.result.releases);
  });
});

/** Arbitrary releases of one cell and a final tally: each ballot enters at some release or none, and is counted or not. */
const releasesAndFinal = fc
  .record({
    m: fc.integer({ min: 1, max: 5 }),
    ballots: fc.array(
      fc.record({ enters: fc.integer({ min: 1, max: 6 }), counted: fc.boolean() }),
      { maxLength: 40 },
    ),
  })
  .map(({ m, ballots }) => {
    const releases = Array.from(
      { length: m },
      (_, i) =>
        new Map(
          ballots.flatMap((b, j) => (b.enters <= i + 1 ? [[`n${j}`, `b${j}`] as const] : [])),
        ),
    );
    const final = new Set(ballots.flatMap((b, j) => (b.counted ? [`b${j}`] : [])));
    return { m, ballots, releases, final };
  });

function oneCell(
  releases: readonly Map<string, string>[],
  ballots: number,
): LiveRunning<string, string> {
  return {
    cellTiers: [0],
    snapshots: releases.map((_, i) => ({
      segment: i,
      head: { number: BigInt(i), timestamp: 0n, hash: NO_HASH },
    })),
    sets: [[new Map(), ...releases]],
    choices: new Map([[0, { releases: releases.map((_, i) => i + 1), decisions: [] }]]),
    firstEntry: new Map(Array.from({ length: ballots }, (_, j) => [`b${j}`, j] as const)),
  };
}

describe("the final tally's least side", () => {
  test("is the least positive directed cut of the release graph with the final tally", () => {
    fc.assert(
      fc.property(releasesAndFinal, ({ ballots, releases, final }) => {
        const r = liveReleases({
          running: oneCell(releases, ballots.length),
          rules: { optionCount: 1 },
          batch: 20,
          openings: [],
          counted: [final],
        });
        const fb = r.cells[0]?.finalBatch;
        const graph = releaseGraph([...releases, new Map([...final].map((b) => [b, b] as const))]);
        const cut = leastDirectedCut(graph);
        expect(fb?.cut ?? null).toBe(cut?.cut ?? null);
        if (fb?.side != null) {
          expect(fb.side.ballots.length).toBe(fb.cut);
          expect(fb.flagged).toBe((fb.cut as number) < 20);
          expect([...fb.side.ballots].sort((a, b) => a - b)).toEqual(fb.side.ballots);
        }
      }),
      { numRuns },
    );
  });

  test("a tier with no release reports none", () => {
    const running: LiveRunning<string, string> = {
      ...oneCell([], 0),
      choices: new Map([[0, { releases: [], decisions: [] }]]),
    };
    expect(
      liveReleases({
        running,
        rules: { optionCount: 1 },
        batch: 20,
        openings: [],
        counted: [new Set<string>()],
      }).cells[0]?.finalBatch,
    ).toBeNull();
  });
});

describe("running sets", () => {
  const copy = (
    entry: number,
    nullifier: string,
    ballot: string,
    over: Partial<LiveCopy<string, string>> = {},
  ): LiveCopy<string, string> => ({
    entry,
    segment: 10,
    nullifier,
    ballot,
    cell: 0,
    stepFinalAt: null,
    member: true,
    rejected: false,
    reference: 100n,
    referenceKnown: true,
    receiptedAt: 10,
    ...over,
  });
  const snapshots = [10, 11, 12].map((segment, i) => ({
    segment,
    head: { number: 110n + BigInt(i), timestamp: 0n, hash: NO_HASH },
  }));

  test("don't depend on the order copies are given in", () => {
    const arb = fc.array(
      fc.record({
        n: fc.integer({ min: 0, max: 5 }),
        b: fc.integer({ min: 0, max: 2 }),
        segment: fc.integer({ min: 10, max: 12 }),
        member: fc.boolean(),
        rejected: fc.boolean(),
        ref: fc.integer({ min: 100, max: 113 }),
        receipted: fc.option(fc.integer({ min: 10, max: 13 }), { nil: null }),
      }),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(arb, fc.integer(), (specs, seed) => {
        const copies = specs.map((s, entry) =>
          copy(entry, `n${s.n}`, `n${s.n}/b${s.b}`, {
            segment: s.segment,
            member: s.member,
            rejected: s.rejected,
            reference: BigInt(s.ref),
            receiptedAt: s.receipted,
          }),
        );
        const shuffled = [...copies].sort(
          (x, y) => ((x.entry * 7919 + seed) % 97) - ((y.entry * 7919 + seed) % 97),
        );
        const a = liveRunning({ cellTiers: [0], snapshots, copies, batch: 20 });
        const b = liveRunning({ cellTiers: [0], snapshots, copies: shuffled, batch: 20 });
        expect(b.sets).toEqual(a.sets);
        // Running sets only grow, each nullifier keeping its ballot.
        const sets = a.sets[0] as readonly RunningSet<string, string>[];
        for (let i = 1; i < sets.length; i++)
          for (const [n, ballot] of sets[i - 1] as RunningSet<string, string>)
            expect((sets[i] as RunningSet<string, string>).get(n)).toBe(ballot);
      }),
      { numRuns },
    );
  });

  test("a broken copy ahead of the real one changes nothing, a second ballot keeps both out", () => {
    const r = liveRunning({
      cellTiers: [0],
      snapshots,
      copies: [
        copy(0, "a", "a/1", { member: false }),
        copy(1, "a", "a/1", { segment: 11, receiptedAt: 11 }),
        copy(2, "b", "b/1"),
        copy(3, "b", "b/2", { rejected: true }),
        copy(4, "c", "c/1", { segment: 12, receiptedAt: null }),
      ],
      batch: 20,
    });
    expect((r.sets[0] as RunningSet<string, string>[]).map((s) => [...s])).toEqual([
      [],
      [],
      [["a", "a/1"]],
      [["a", "a/1"]],
    ]);
  });

  test("tiers keep their own cells and choices", () => {
    const r = liveRunning({
      cellTiers: [1, 0, 1],
      snapshots,
      copies: [copy(0, "1:x", "x", { cell: 2 }), copy(1, "0:y", "y", { cell: 1 })],
      batch: 20,
    });
    expect(r.sets.map((c) => [...(c[1] as RunningSet<string, string>)])).toEqual([
      [],
      [["0:y", "y"]],
      [["1:x", "x"]],
    ]);
    expect([...r.choices.keys()]).toEqual([0, 1]);
  });

  test("refuse a copy naming no cell of the partition", () => {
    expect(() =>
      liveRunning({
        cellTiers: [0],
        snapshots,
        copies: [copy(0, "a", "a", { cell: 1 })],
        batch: 20,
      }),
    ).toThrow(RangeError);
  });
});

describe("running openings", () => {
  const set = new Map([["n", "b"]]);
  const running: LiveRunning<string, string> = {
    cellTiers: [0],
    snapshots: [1, 2, 3].map((segment) => ({
      segment,
      head: { number: BigInt(segment), timestamp: 0n, hash: NO_HASH },
    })),
    sets: [[new Map(), set, set, set]],
    choices: new Map([[0, { releases: [2], decisions: [] }]]),
    firstEntry: new Map([["b", 0]]),
  };
  type Facts = Extract<RunningOpeningFacts, { thisElection: boolean }>;
  /** An opening of release 2 in cell 0 by seat 1 that passes; `verdict: null` for one with none. */
  const opening = (
    entry: number,
    over: Partial<Omit<Facts, "verdict">> & { readonly verdict?: Facts["verdict"] | null } = {},
  ): RunningOpeningFacts => {
    const { verdict = { passes: true }, ...rest } = over;
    return {
      entry,
      thisElection: true,
      cell: 0,
      snapshot: 2,
      signer: 1,
      entries: 1,
      message: `m${entry}`,
      opening: "1:7",
      counts: [1n],
      ...rest,
      ...(verdict === null ? {} : { verdict }),
    };
  };
  const judge = (openings: readonly RunningOpeningFacts[]): LiveReleases =>
    liveReleases({
      running,
      rules: {
        optionCount: 1,
        questions: [{ optionCount: 1, minSelections: 0, maxSelections: 1 }],
      },
      batch: 20,
      openings,
      counted: [new Set(["b"])],
    });

  test("a replay is the operator's alone, a second message also its signer's", () => {
    const r = judge([
      opening(1),
      opening(2, { message: "m1" }),
      opening(3, { verdict: { passes: false, reason: "aggregate" } }),
    ]);
    expect(r.openings.map((o) => ("breaks" in o ? [o.breaks, o.blamed] : null))).toEqual([
      [[], null],
      [[{ code: "running-repeat", of: 1 }], null],
      [[{ code: "running-aggregate" }, { code: "running-second", of: 1 }], 1],
    ]);
    expect(r.rows["7.6"]).toEqual({ status: "fail", code: "running-repeat", at: { entry: 2 } });
  });

  test("a stray opening is never checked against a set, and an unattributed one never blames", () => {
    const r = judge([
      opening(1, { thisElection: false, signer: null, verdict: null }),
      opening(2, { cell: 3, verdict: null }),
    ]);
    expect(r.openings.map((o) => ("breaks" in o ? [o.kind, o.breaks, o.blamed] : null))).toEqual([
      ["outside-schedule", [{ code: "running-stray" }, { code: "running-unattributed" }], null],
      ["outside-schedule", [{ code: "running-stray" }], 1],
    ]);
  });

  test("an unscheduled opening discloses only at a scheduled snapshot it opens", () => {
    const r = judge([
      opening(1, { snapshot: 3 }),
      opening(2, { snapshot: 1, verdict: { passes: false, reason: "opening", option: 0 } }),
      opening(3, { snapshot: 9, verdict: null }),
    ]);
    expect(r.openings.map((o) => ("discloses" in o ? o.discloses : undefined))).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("an unscheduled opening with other than m entries is also missing, and discloses nothing", () => {
    const r = judge([opening(1, { snapshot: 3, entries: 2, verdict: null })]);
    expect(r.openings[0]).toMatchObject({
      kind: "outside-schedule",
      discloses: false,
      breaks: [{ code: "running-unscheduled" }, { code: "running-missing" }],
    });
  });

  test("7.5 fails on two passing openings with different (V, R), and on counts binding rules out", () => {
    expect(judge([opening(1), opening(2, { signer: 2, opening: "1:8" })]).rows["7.5"]).toEqual({
      status: "fail",
      code: "running-conflict",
      at: { cell: 0, snapshot: 2 },
    });
    expect(judge([opening(1), opening(2, { signer: 2 })]).rows["7.5"]).toEqual({ status: "pass" });
    expect(judge([opening(1, { counts: [2n] })]).rows["7.5"]).toEqual({
      status: "fail",
      code: "running-range",
      at: { cell: 0, snapshot: 2, option: 0 },
    });
    // Under `minSelections` 1, a total below the set's size is out of range too.
    expect(
      liveReleases({
        running,
        rules: {
          optionCount: 1,
          questions: [{ optionCount: 1, minSelections: 1, maxSelections: 1 }],
        },
        batch: 20,
        openings: [opening(1, { counts: [0n] })],
        counted: [new Set(["b"])],
      }).rows["7.5"],
    ).toEqual({
      status: "fail",
      code: "running-question-range",
      at: { cell: 0, snapshot: 2, question: 0 },
    });
    // A failing opening's counts are never read.
    expect(
      judge([
        opening(1, { counts: [2n], verdict: { passes: false, reason: "opening", option: 0 } }),
      ]).rows["7.5"],
    ).toEqual({ status: "pass" });
  });

  test("a release no opening passes is skipped, with no counts", () => {
    const r = judge([opening(1, { entries: 2 })]);
    expect(r.cells[0]?.releases).toEqual([
      { snapshot: 2, size: 1, entered: 1, counts: null, signers: [] },
    ]);
    expect(r.tiers[0]?.releases).toEqual([{ snapshot: 2, counts: null }]);
    expect(r.openings[0]).toMatchObject({
      breaks: [{ code: "running-missing" }],
      passes: false,
      blamed: 1,
    });
  });
});
