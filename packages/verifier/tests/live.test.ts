import { readFileSync } from "node:fs";
import {
  aggregateCell,
  aggregateHash,
  type AnchorClock,
  ballotHashV4,
  type CommittedVoteV4,
  decode,
  decodeBallot,
  decodeBoardEntry,
  encodeBoardEntry,
  encodeElectionDefinitionV6,
  encodeRunningOpening,
  encodeShareReceiptV2,
  identityKey,
  KEM_PUBLIC_KEY,
  openCell,
  panelBallotElection,
  proveValidityV4,
  type QuestionRules,
  RECORD_TYPES,
  type RegisteredKeys,
  RESULTS_MODES,
  type Share,
  shareReceiptRecordV2,
  shareReceiptStatementV4,
  shareVoteV4,
  signRunningOpening,
  signStatement,
  sumShares,
  tallyRules,
  type VoteSharingV4,
} from "@abolishus/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, test } from "vite-plus/test";
import {
  ballotChecks,
  judgeFor,
  LiveCopies,
  type LiveBallotCopy,
  type RejectedBallot,
} from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import {
  authorRunOf,
  decodeDefinition,
  readDefinition,
  type VerifiedDefinition,
} from "../src/definition.ts";
import {
  BUNDLE_FORMAT_BLOCKS,
  BUNDLE_FORMAT_CEREMONY,
  type CheckResult,
  decodeHeader,
  parseBundle,
  type Report,
  splitEntries,
  verifyBundle,
} from "../src/index.ts";
import { releaseChecks, type ReleaseInputs } from "../src/live.ts";
import { run, toHex } from "./headers.ts";

// Live releases in the verdict (docs/spec/verifier.md, Releases): the copies
// admission gives the running sets, each judged by its membership proof
// alone where 5.4 rejects it (tally.md, Running set, condition 1); full
// receipting by crypto's delivery check over the receipts boarded by each
// snapshot; the rows and the report's `releases` once 7.1 passed; and
// 7.5's and 7.6's gates in `verifyBundle`. No vector reaches a sealed live
// board with ballots (P2-15 part 7), so `releaseChecks` runs on an election
// cast here under verifier-ballots-v4.json's `admitted` definition made
// live, with @abolishus/crypto's client and trustee paths (`shareVoteV4`,
// `proveValidityV4`, the receipt and running-opening signatures, `openCell`),
// never with the checks under test; the expected releases follow from
// tally.md's release choice by hand, and releases.test.ts checks the choice
// itself against live-verifier.json.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, VECTORS), "utf8")) as unknown;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const text = (s: string) => new TextEncoder().encode(s);

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly ballots?: { readonly rejected: readonly RejectedBallot[] };
}
const file = read("verifier-ballots-v4.json") as {
  readonly panels: Readonly<Record<string, unknown>>;
  readonly clock: Readonly<Record<string, string>>;
  readonly cases: readonly Case[];
};
const caseOf = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const delivery = read("delivery-v2.json") as {
  readonly seats: { readonly default: readonly { readonly kemKey: string }[] };
};
const KEM = decode(
  KEM_PUBLIC_KEY,
  hex((delivery.seats.default[0] as { readonly kemKey: string }).kemKey),
);

type V6 = Extract<VerifiedDefinition, { readonly version: 6 }>;

/** A case's board-entry version 5 copy, its definition, and the key set its transcript registers. */
function judged(c: Case) {
  const definition = decodeDefinition(hex(c.definition));
  const entries = splitEntries(hex(c.board)).entries;
  const bundle = parseBundle(
    JSON.stringify({
      format: BUNDLE_FORMAT_CEREMONY,
      definition: c.definition,
      clock: file.clock,
      l1: L1,
      panel: file.panels[c.panel],
    }),
    hex(c.board),
  );
  if (bundle.format !== BUNDLE_FORMAT_CEREMONY) throw new Error("fixture: not format 4");
  const { stubHash } = readDefinition(definition);
  const ceremony = ceremonyChecks(
    definition.value,
    stubHash as Uint8Array,
    bundle.panel,
    authorRunOf(definition),
    entries,
    5,
  );
  if (ceremony.registered === undefined) throw new Error("fixture: no key set");
  return { definition, entries, registered: ceremony.registered, clock: bundle.clock };
}

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
const L1 = {
  firstSegment: closed.firstSegment,
  header: closed.block.header,
  nodes: closed.nodes,
  checkpoints: closed.checkpoints,
};

describe("the copies admission gives the running sets", () => {
  test("a ballot rejected after its membership proof is still a member's, with its own M", () => {
    // `mixed`'s ballots, judged as admission judges them, under its own
    // (sealed) definition: what `LiveCopies` reads doesn't depend on the mode.
    const c = caseOf("mixed");
    const { definition, entries, registered } = judged(c);
    const judge = judgeFor(definition, registered);
    if (typeof judge !== "function") throw new Error("fixture: no judge");
    const copies = new LiveCopies(
      panelBallotElection(definition.value as V6["value"], registered, []),
    );
    const seen: number[] = [];
    for (const [at, encoded] of entries.entries()) {
      const { segment, payload } = decodeBoardEntry(encoded, 5);
      if (((payload[0] as number) << 8) + (payload[1] as number) !== RECORD_TYPES.ballot) continue;
      let j;
      try {
        j = judge(payload);
      } catch {
        continue;
      }
      seen.push(at);
      copies.judged(at, segment, payload, j.checked, j.tally);
    }
    const rejected = c.ballots?.rejected ?? [];
    const code = new Map(rejected.map((r) => [r.entry, r.code]));
    const live = copies.finish(rejected);
    // Another definition's or cell's ballot isn't the tier's, and a failed
    // membership proof never counts under definition version 6.
    const unread = new Set(["ballot-stray", "ballot-cell", "membership-proof"]);
    expect(live.map((l) => l.entry)).toEqual(seen.filter((at) => !unread.has(code.get(at) ?? "")));
    for (const l of live) {
      const why = code.get(l.entry);
      const record = decodeBallot(decodeBoardEntry(entries[l.entry] as Uint8Array, 5).payload, 4);
      expect(l.nullifier).toBe(record.nullifier);
      expect(l.cell).toBe(record.cell);
      expect(l.reference).toBe(record.l1_ref_number);
      // Rejected by 5.4 or as a repeat: whatever the head, it stays rejected.
      expect(l.rejected).toBe(why !== undefined);
      expect(l.tally !== undefined).toBe(why === undefined || why === "repeat");
      // The validity proofs run only once the membership proof passed.
      if (why === "option-proof" || why === "sum-proof") expect(l.member).toBe(true);
      if (why === undefined) expect(l.member).toBe(true);
    }
    // A byte-identical repeat has its first copy's M.
    const repeat = live.find((l) => code.get(l.entry) === "repeat");
    const first = live.find(
      (l) => l.entry < (repeat?.entry ?? 0) && l.nullifier === repeat?.nullifier,
    );
    expect(repeat && first && toHex(repeat.message)).toBe(first && toHex(first.message));
    for (const kind of ["option-proof", "sum-proof", "share-hash-unqualified", "validity-shape"])
      expect(live.some((l) => code.get(l.entry) === kind)).toBe(true);
  }, 60_000);

  test("ballotChecks gives the copies only under a live definition", () => {
    const live = judged(caseOf("live"));
    const sealed = judged(caseOf("admitted"));
    const run = (j: ReturnType<typeof judged>) =>
      ballotChecks(j.definition, j.registered, undefined, j.entries, 5, j.clock);
    const r = run(live);
    expect(r.live?.length).toBe(2);
    for (const l of r.live ?? []) {
      expect(l).toMatchObject({ member: true, rejected: false, referenceKnown: true });
      expect(l.tally?.deliveryV4).toBeDefined();
    }
    expect(r.live?.map((l) => l.entry)).toEqual(r.candidates?.map((c) => c.entry));
    expect(run(sealed).live).toBeUndefined();
  }, 60_000);
});

// verifier-ballots-v4.json's `admitted` definition, made live: releases every
// 24 hourly periods, a batch of 20. Tier 0 has cells 0 and 1, tier 2 cell 2.
const sealedDefinition = decodeDefinition(hex(caseOf("admitted").definition)) as V6;
const definition = decodeDefinition(
  encodeElectionDefinitionV6({
    ...sealedDefinition.value,
    results_mode: RESULTS_MODES.live,
    live_every: 24,
    live_batch: 20,
  }),
) as V6;
const d = definition.value;
const { hash, rule } = readDefinition(definition);
const RULES = tallyRules(definition);
const OPENS = d.opens_at;
const CLOSES = d.closes_at;
const CLOCK: AnchorClock = { epoch: OPENS, period: 3600n, deadline: 600n, lastSegment: 1000 };

// Seats 1 to 3 of the 3-of-4 default panel, with signing keys of the test's own.
const SEATS = [1, 2, 3];
const SECRETS = [1, 2, 3, 4].map((i) => sha256(text(`live.test seat ${i}`)));
const secret = (seat: number) => SECRETS[seat - 1] as Uint8Array;
const REGISTERED: RegisteredKeys[] = SEATS.map((index) => ({
  index,
  kemKey: KEM,
  signingKey: identityKey(secret(index)),
}));

// A finalized header every 12 hours from just before opening to after close.
const BLOCKS = run(
  21_000_000n,
  Array.from({ length: 17 }, (_, k) => OPENS - 12n + BigInt(k) * 43_200n),
).map((h) => decodeHeader(h.encoded));
const REFERENCE = 21_000_000n;

interface Cast {
  readonly cell: number;
  readonly nullifier: bigint;
  readonly vote: CommittedVoteV4;
  readonly hash: Uint8Array;
  readonly sharing: VoteSharingV4;
}

let nextNullifier = 5_000n;
const rules = {
  questions: RULES.questions as readonly QuestionRules[],
  threshold: RULES.threshold,
  panelSize: RULES.panelSize,
  authorThreshold: 0,
  authorPanelSize: 0,
};
/** A version-4 ballot in cell 2 with these flat votes, by a new nullifier unless one is given. */
function cast(votes: readonly (0 | 1)[], nullifier = nextNullifier++): Cast {
  const sharing = shareVoteV4(rules, votes);
  const shareHashes = Array.from({ length: RULES.panelSize }, (_, i) =>
    SEATS.includes(i + 1)
      ? sha256(text(`share ${nullifier} ${i + 1} ${votes.join("")}`))
      : new Uint8Array(32),
  );
  const vote = proveValidityV4(
    { ...rules, definitionHash: hash, cell: 2, nullifier },
    sharing,
    shareHashes,
    [],
  );
  return {
    cell: 2,
    nullifier,
    vote,
    hash: ballotHashV4({ definitionHash: hash, cell: 2, nullifier }, vote),
    sharing,
  };
}

// Pick the first option of each question: one of three, up to two of four,
// exactly one of two.
const VOTE: readonly (0 | 1)[] = [1, 0, 0, 1, 0, 0, 0, 1, 0];
const OTHER: readonly (0 | 1)[] = [0, 1, 0, 0, 1, 0, 0, 0, 1];
const BATCH_A = Array.from({ length: 20 }, () => cast(VOTE));
const BATCH_B = Array.from({ length: 20 }, () => cast(OTHER));
// A re-voter: two distinct ballots of one nullifier before the first snapshot.
const FIRST = cast(VOTE);
const SECOND = cast(OTHER, FIRST.nullifier);
// Any ballot payload stands for a ballot's entry: releaseChecks reads its copies from admission.
const PLACEHOLDER = (() => {
  const { entries } = splitEntries(hex(caseOf("admitted").board));
  for (const e of entries) {
    const { payload } = decodeBoardEntry(e, 5);
    if (((payload[0] as number) << 8) + (payload[1] as number) === RECORD_TYPES.ballot)
      return payload;
  }
  throw new Error("fixture: no ballot");
})();

/** One board under board-entry version 6, which carries running openings. */
function election() {
  const entries: Uint8Array[] = [];
  const copies: LiveBallotCopy[] = [];
  const board = (segment: number, payload: Uint8Array) => {
    entries.push(
      encodeBoardEntry(
        { election_id: d.election_id, index: BigInt(entries.length), segment, payload },
        6,
      ),
    );
    return entries.length - 1;
  };
  const ballot = (b: Cast, segment: number) => {
    const entry = board(segment, PLACEHOLDER);
    copies.push({
      entry,
      segment,
      tier: 2,
      cell: b.cell,
      nullifier: b.nullifier,
      // The test's own stand-in for M: one per ballot.
      message: sha256(b.hash),
      member: true,
      rejected: false,
      reference: REFERENCE,
      referenceKnown: true,
      tally: {
        cell: b.cell,
        vss: b.vote.vss,
        deliveryV4: { cell: b.cell, nullifier: b.nullifier, vote: b.vote },
      },
    });
  };
  const receipt = (b: Cast, seat: number, signer = seat) => {
    const shareHash = b.vote.share_hashes[seat - 1] as Uint8Array;
    const m = shareReceiptStatementV4({
      definition_hash: hash,
      ballot_hash: b.hash,
      panel: 1,
      seat,
      share_hash: shareHash,
    });
    return encodeShareReceiptV2(
      shareReceiptRecordV2(hash, seat, {
        panel: 1,
        ballotHash: b.hash,
        shareHash,
        receipt: signStatement(secret(signer), "abolish/v1/sig/share-receipt-2", m),
      }),
    );
  };
  const deliver = (ballots: readonly Cast[], segment: number, seats = SEATS) => {
    for (const b of ballots) for (const seat of seats) board(segment, receipt(b, seat));
  };
  /** Seats 1 to k's opening of `set` in cell 2 as release `snapshot`, signed by `signer`. */
  const opening = (
    set: readonly Cast[],
    snapshot: number,
    signer: number,
    tamper?: (o: Share[]) => Share[],
  ) => {
    const vss = set.map((b) => b.vote.vss);
    const summed = new Map(
      SEATS.slice(0, RULES.threshold).map((seat) => [
        seat,
        sumShares(
          RULES,
          set.map((b) => b.sharing.shares[seat - 1] as readonly Share[]),
        ),
      ]),
    );
    const opened = openCell(RULES, vss, summed);
    if (!opened.ok) throw new Error(`fixture: the set doesn't open (${opened.code})`);
    const shares = opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint }));
    return encodeRunningOpening(
      signRunningOpening(secret(signer), {
        definition_hash: hash,
        cell: 2,
        snapshot,
        aggregate_hash: aggregateHash(aggregateCell(RULES, vss)),
        signer,
        opening: tamper === undefined ? shares : tamper(shares),
      }),
    );
  };
  const counted = (ballots: readonly Cast[]) => [
    new Set<string>(),
    new Set<string>(),
    new Set(ballots.map((b) => toHex(sha256(b.hash)))),
  ];
  const inputs = (over: Partial<ReleaseInputs> = {}): ReleaseInputs => ({
    definition,
    definitionHash: hash,
    registered: REGISTERED,
    copies,
    entries,
    boardEntryVersion: 6,
    extent: entries.length,
    clock: CLOCK,
    blocks: BLOCKS,
    counted: counted([...BATCH_A, ...BATCH_B, SECOND]),
    ...over,
  });
  return { entries, board, ballot, deliver, opening, inputs };
}

/**
 * Batch A cast and receipted before snapshot 1 (σ_1 = 23), batch B before
 * snapshot 2 (σ_2 = 47), and a re-voter's two ballots before snapshot 1.
 */
function honest(withhold = false) {
  const e = election();
  for (const b of BATCH_A) e.ballot(b, 10);
  e.ballot(FIRST, 10);
  e.ballot(SECOND, 12);
  // Seat 3's receipts for batch A wait until after snapshot 1 when it withholds them.
  e.deliver([...BATCH_A], 11, withhold ? [1, 2] : SEATS);
  if (withhold) e.deliver([...BATCH_A], 30, [3]);
  e.deliver([FIRST, SECOND], 13);
  for (const b of BATCH_B) e.ballot(b, 30);
  e.deliver([...BATCH_B], 31);
  return e;
}

const counts = (ballots: number, votes: readonly (0 | 1)[]) =>
  votes.map((v) => String(v * ballots));

describe("the releases once 7.1 passed", { timeout: 120_000 }, () => {
  test("the fixture's definition is a well-formed live version 6 without an author panel", () => {
    expect(rule).toBeUndefined();
    expect(d.author_keys).toEqual([]);
    expect(CLOSES - OPENS).toBe(168n * 3600n);
  });

  test("an honest election: release 1 opens batch A, the re-voter is held out, and the final tally is a batch from it", () => {
    const e = honest();
    // Released at the decision of snapshot 2, opened after it.
    e.board(50, e.opening(BATCH_A, 1, 1));
    const r = releaseChecks(e.inputs());
    expect(Object.fromEntries(r.rows)).toEqual({
      "7.5": { status: "pass" },
      "7.6": { status: "pass" },
    });
    const report = r.report;
    if (report === undefined) throw new Error("no report");
    // σ_r = 24r − 1 while below s_close = 168.
    expect(report.snapshots.map((s) => s.segment)).toEqual([23, 47, 71, 95, 119, 143, 167]);
    for (const s of report.snapshots) {
      const end = OPENS + BigInt(s.segment + 1) * 3600n;
      const head = BLOCKS.filter((b) => b.timestamp < end).at(-1);
      expect(s.l1Head).toEqual({
        number: String(head?.number),
        hash: toHex(head?.hash ?? new Uint8Array()),
      });
    }
    const tier2 = report.tiers.find((t) => t.tier === 2);
    expect(tier2?.releases).toEqual([{ snapshot: 1, counts: counts(20, VOTE) }]);
    // Every later candidate is held back by the lag: nothing enters after snapshot 2.
    expect(tier2?.decisions.map((x) => x.release)).toEqual([1, null, null, null, null, null]);
    expect(
      tier2?.decisions
        .slice(1)
        .every((x) => x.refused.every((f) => f.rule === "lag" || f.rule === "batch")),
    ).toBe(true);
    // Tier 0's cells hold nothing, so no candidate passes the batch.
    expect(report.tiers.find((t) => t.tier === 0)?.releases).toEqual([]);
    const cell2 = report.cells[2];
    expect(cell2?.releases).toEqual([
      { snapshot: 1, size: 20, entered: 20, counts: counts(20, VOTE), signers: [1] },
    ]);
    // Batch A entered at release 1 and is counted; batch B and the re-vote
    // are counted in no release: the least side is batch A's 20.
    expect(cell2?.finalBatch).toMatchObject({
      cut: 20,
      flagged: false,
      side: { kind: "entered", release: 1 },
    });
    expect(cell2?.finalBatch?.side?.ballots).toHaveLength(20);
    expect(report.cells[0]?.finalBatch).toBeNull();
    expect(report.openings).toEqual([
      {
        entry: e.entries.length - 1,
        cell: 2,
        snapshot: 1,
        signer: 1,
        kind: "release",
        passes: true,
        breaks: [],
        blamed: null,
      },
    ]);
  });

  test("a ballot enters only once every qualified seat's receipt is boarded by the snapshot", () => {
    // Seat 3 receipts batch A only after snapshot 1, so R_1 is empty and no
    // release is ever chosen; the opening of batch A at snapshot 1 is then
    // unscheduled, and over another set than R_1, so it discloses nothing.
    const e = honest(true);
    const at = e.board(50, e.opening(BATCH_A, 1, 1));
    const r = releaseChecks(e.inputs());
    expect(r.rows.get("7.6")).toEqual({
      status: "fail",
      code: "running-unscheduled",
      at: { entry: at },
    });
    expect(r.rows.get("7.5")).toEqual({ status: "pass" });
    expect(r.report?.cells[2]?.releases).toEqual([]);
    expect(r.report?.openings[0]).toMatchObject({
      kind: "outside-schedule",
      discloses: false,
      blamed: 1,
    });
  });

  test("an unscheduled opening of a snapshot's running set discloses it", () => {
    const e = honest();
    e.board(50, e.opening(BATCH_A, 1, 1));
    // R_2 holds batches A and B: snapshot 2 was never chosen.
    const at = e.board(80, e.opening([...BATCH_A, ...BATCH_B], 2, 2));
    const r = releaseChecks(e.inputs());
    expect(r.rows.get("7.6")).toEqual({
      status: "fail",
      code: "running-unscheduled",
      at: { entry: at },
    });
    expect(r.report?.openings[1]).toMatchObject({
      snapshot: 2,
      kind: "outside-schedule",
      discloses: true,
      blamed: 2,
    });
  });

  test("an opening that doesn't open the release leaves it skipped, against its signer", () => {
    const e = honest();
    const at = e.board(
      50,
      e.opening(BATCH_A, 1, 3, (o) => o.map((s, j) => (j === 0 ? { ...s, v: s.v + 1n } : s))),
    );
    const r = releaseChecks(e.inputs());
    expect(r.rows.get("7.6")).toEqual({
      status: "fail",
      code: "running-opening",
      at: { entry: at },
    });
    expect(r.rows.get("7.5")).toEqual({ status: "pass" });
    expect(r.report?.openings[0]).toMatchObject({
      passes: false,
      blamed: 3,
      breaks: [{ code: "running-opening", option: 0 }],
    });
    expect(r.report?.cells[2]?.releases[0]).toMatchObject({
      snapshot: 1,
      counts: null,
      signers: [],
    });
    expect(r.report?.tiers.find((t) => t.tier === 2)?.releases).toEqual([
      { snapshot: 1, counts: null },
    ]);
  });

  test("only the anchored extent is read", () => {
    const e = honest();
    const extent = e.entries.length;
    e.board(50, e.opening(BATCH_A, 1, 1));
    const r = releaseChecks(e.inputs({ extent }));
    expect(r.report?.openings).toEqual([]);
    expect(r.report?.cells[2]?.releases[0]).toMatchObject({ counts: null });
    // A copy past the extent is no one's: the release is the same without it.
    const later = election();
    for (const b of BATCH_A) later.ballot(b, 10);
    later.deliver([...BATCH_A], 11);
    const cut = later.entries.length;
    for (const b of BATCH_B) later.ballot(b, 30);
    later.deliver([...BATCH_B], 31);
    const short = releaseChecks(later.inputs({ extent: cut }));
    expect(short.report?.cells[2]?.releases).toEqual([]);
  });

  test("a run of headers that doesn't fix a snapshot's head leaves both rows unverifiable", () => {
    const e = honest();
    // The run ends before snapshot 7's end, σ_7 = 167.
    const end7 = OPENS + 168n * 3600n;
    const r = releaseChecks(e.inputs({ blocks: BLOCKS.filter((b) => b.timestamp < end7) }));
    expect(Object.fromEntries(r.rows)).toEqual({
      "7.5": { status: "unverifiable", code: "l1-blocks-short", at: { snapshot: 7 } },
      "7.6": { status: "unverifiable", code: "l1-blocks-short", at: { snapshot: 7 } },
    });
    expect(r.report).toBeUndefined();
  });
});

const row = (r: Report, id: string) => {
  const { status, code, at } = r.checks.find((x) => x.id === id) as CheckResult;
  return { status, ...(code !== undefined && { code }), ...(at !== undefined && { at }) };
};
const bundle = (c: Case, definitionHex = c.definition) =>
  verifyBundle(
    parseBundle(
      JSON.stringify({
        format: BUNDLE_FORMAT_BLOCKS,
        definition: definitionHex,
        clock: file.clock,
        l1: L1,
        panel: file.panels[c.panel],
        l1Blocks: run(21_000_000n, [OPENS - 3600n - 12n, CLOSES + 3600n + 12n]).map((h) =>
          toHex(h.encoded),
        ),
      }),
      hex(c.board),
    ),
  );

describe("7.5's and 7.6's gates in verifyBundle (Releases, step 1)", { timeout: 60_000 }, () => {
  test("a sealed definition has no releases: both pass, and the report has none", () => {
    const r = bundle(caseOf("admitted"));
    for (const id of ["7.5", "7.6"]) expect(row(r, id)).toEqual({ status: "pass" });
    expect(r).not.toHaveProperty("releases");
  });

  test("a live definition under tally-opening version 1 is a later release's", () => {
    const r = bundle(caseOf("live"));
    for (const id of ["7.5", "7.6"])
      expect(row(r, id)).toEqual({ status: "unverifiable", code: "unsupported-version", at: {} });
  });

  test("under tally-opening version 2, both wait on 7.1's pass", () => {
    const c = caseOf("live");
    const v = decodeDefinition(hex(c.definition)) as V6;
    const pinned = encodeElectionDefinitionV6({
      ...v.value,
      profile: {
        ...v.value.profile,
        pins: v.value.profile.pins.map((p) =>
          p.record_type === RECORD_TYPES.tallyOpening
            ? { ...p, version: 2 }
            : p.record_type === RECORD_TYPES.boardEntry
              ? { ...p, version: 6 }
              : p,
        ),
      },
    });
    const r = bundle(c, toHex(pinned));
    expect(row(r, "7.1").status).toBe("unverifiable");
    for (const id of ["7.5", "7.6"])
      expect(row(r, id)).toEqual({ status: "unverifiable", code: "not-reached", at: {} });
    expect(r).not.toHaveProperty("releases");
  });

  test("a definition that stops the board checks leaves both not reached", () => {
    const r = bundle(caseOf("admitted"), "00");
    for (const id of ["7.5", "7.6"])
      expect(row(r, id)).toEqual({ status: "unverifiable", code: "not-reached" });
  });
});
