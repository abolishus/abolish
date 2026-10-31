import { readFileSync } from "node:fs";
import {
  aggregateCell,
  aggregateHash,
  type AnchorClock,
  ballotHashV4,
  ballotHashV5,
  checkContractEvent,
  type CommittedVoteV4,
  decode,
  decodeBallot,
  decodeBoardEntry,
  decodeContractEvent,
  type ElectionDefinitionV7,
  ELECTORATE_MODES,
  encodeBoardEntry,
  encodeElectionDefinitionV7,
  encodeRunningOpening,
  encodeShareReceiptV2,
  identityKey,
  KEM_PUBLIC_KEY,
  openCell,
  PARAMETERS,
  proveValidityV5,
  type QuestionRules,
  RECORD_TYPES,
  type RegisteredKeys,
  RESULTS_MODES,
  type RollingBallotChain,
  rollingBallotElection,
  type RollingTierEvent,
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
import { isLive, judgeFor, LiveCopies, type LiveBallotCopy } from "../src/ballots.ts";
import { ceremonyChecks } from "../src/ceremony.ts";
import {
  authorRunOf,
  decodeDefinition,
  isRolling,
  type PanelledRecord,
  readDefinition,
} from "../src/definition.ts";
import { decodeHeader, splitEntries } from "../src/index.ts";
import { type ReleaseInputs, releaseChecks } from "../src/live.ts";
import { run, toHex } from "./headers.ts";

// Live releases (docs/spec/verifier.md, Releases; 7.5 and 7.6) under a
// rolling definition (definition version 7, `electorate_mode` 2), whose
// ballots (version 5) each name the root-clock step their membership proof
// used: a copy whose step isn't final at a snapshot's head, `h_r`'s
// timestamp below `τ_n + ROOT_FINALITY`, is pending there and counts toward
// the one-ballot rule whatever its membership check later finds (tally.md,
// Running set, condition 1; membership.md, Root clock and steps; T-45).
//
// The copies admission gives are checked on verifier-ballots-v5.json's
// boards, from an independent generator with snarkjs's verdict on every
// membership proof (packages/crypto/scripts/verifier-ballots-v5-vectors.py),
// under their own sealed definition: what `LiveCopies` reads doesn't depend
// on the mode. No vector reaches a sealed live rolling board with ballots
// (P2-17 part 4d-2b-2b-2b-2b-2b-2b), so `releaseChecks` runs on an election
// cast here, as live-election.ts casts one for live.test.ts: the `board`
// case's definition, kept to its Tier 0 rolling tier and made live, with
// @abolishus/crypto's client and trustee paths, never with the checks under
// test, and the expected releases follow from tally.md's rules by hand.

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const text = (s: string) => new TextEncoder().encode(s);

interface Case {
  readonly id: string;
  readonly panel: string;
  readonly definition: string;
  readonly board: string;
  readonly ballots: {
    readonly rejected: readonly { readonly entry: number; readonly code: string }[];
  };
}
interface File {
  readonly clock: Readonly<Record<string, string>>;
  readonly panels: Readonly<
    Record<string, { readonly threshold: string; readonly keys: readonly string[] }>
  >;
  readonly events: readonly {
    readonly block: string;
    readonly timestamp: string;
    readonly group: string;
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  }[];
  readonly registeredAt: string;
  readonly cases: readonly Case[];
}
const file = JSON.parse(readFileSync(new URL("verifier-ballots-v5.json", VECTORS), "utf8")) as File;
const byId = (id: string) => {
  const c = file.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
};
const events: RollingTierEvent[] = file.events.map((e) => {
  const at = {
    blockNumber: BigInt(e.block),
    timestamp: BigInt(e.timestamp),
    groupId: BigInt(e.group),
  };
  return e.remove === undefined
    ? { ...at, kind: "add", commitments: (e.add ?? []).map(BigInt) }
    : { ...at, kind: "remove", indices: e.remove.map(BigInt) };
});
const chain: RollingBallotChain = { events, registeredAt: BigInt(file.registeredAt) };

type V7 = Extract<PanelledRecord, { readonly version: 7 }>;

const ROOT_CODES = new Set(["root-step-range", "root-step-mismatch", "membership-proof"]);

/**
 * Every ballot entry of a case, judged as admission judges it, each read by
 * `LiveCopies` with the root its path supplied, beside the case's rejections.
 */
function copiesOf(c: Case) {
  const definition = decodeDefinition(hex(c.definition)) as V7;
  const d = definition.value;
  const { stubHash } = readDefinition(definition);
  const { entries } = splitEntries(hex(c.board));
  const p = file.panels[c.panel];
  if (p === undefined) throw new Error(`no panel ${c.panel}`);
  const ceremony = ceremonyChecks(
    d,
    stubHash,
    { threshold: Number(p.threshold), keys: p.keys.map(hex) },
    authorRunOf(definition),
    entries,
    5,
  );
  const registered = ceremony.registered;
  if (registered === undefined) throw new Error("fixture: no key set");
  const judge = judgeFor(definition, registered, undefined, chain);
  if (typeof judge !== "function") throw new Error("fixture: no judge");
  const copies = new LiveCopies(rollingBallotElection(d, registered, chain), true);
  const contracts = {
    electionRegistry: d.election_registry,
    trusteeRegistry: d.trustee_registry,
    groupRegistry: d.group_registry,
    board: d.board,
  };
  const seen: { readonly entry: number; readonly payload: Uint8Array }[] = [];
  for (const [at, encoded] of entries.entries()) {
    const { segment, payload: framed } = decodeBoardEntry(encoded, 5);
    const type = ((framed[0] as number) << 8) + (framed[1] as number);
    let payload = framed;
    let supplied: bigint | undefined;
    if (type === RECORD_TYPES.contractEvent) {
      const checked = checkContractEvent(decodeContractEvent(framed, 13), contracts, 13);
      if (!checked.ok) continue;
      const e = checked.event;
      if (e.event !== "RollingBallotSubmitted" && e.event !== "RelayedRollingBallotSubmitted")
        continue;
      payload = e.record;
      supplied = e.root;
    } else if (type !== RECORD_TYPES.ballot) continue;
    let j;
    try {
      j = judge(payload, supplied);
    } catch {
      continue;
    }
    seen.push({ entry: at, payload });
    copies.judged(at, segment, payload, j.checked, j.tally, supplied);
  }
  const rejected = c.ballots.rejected;
  return {
    live: copies.finish(rejected as never),
    seen,
    code: new Map(rejected.map((r) => [r.entry, r.code])),
  };
}

describe(
  "the copies a rolling poll's admission gives the running sets",
  { timeout: 60_000 },
  () => {
    for (const id of ["board", "rolling-path", "relayed-rolling-path"])
      test(`${id}: every ballot of the partition is read with its step, a failed membership check among them`, () => {
        const { live, seen, code } = copiesOf(byId(id));
        // Another definition's or cell's ballot isn't the tier's; every other
        // one is read, since a step that isn't final yet leaves even a failed
        // membership check pending (Releases, step 3).
        const unread = new Set(["ballot-stray", "ballot-cell"]);
        expect(live.map((l) => l.entry)).toEqual(
          seen.filter((s) => !unread.has(code.get(s.entry) ?? "")).map((s) => s.entry),
        );
        for (const l of live) {
          const why = code.get(l.entry);
          const record = decodeBallot(
            (seen.find((s) => s.entry === l.entry) as { readonly payload: Uint8Array }).payload,
            5,
          );
          expect(l.step).toBe(record.step);
          expect(l.nullifier).toBe(record.nullifier);
          expect(l.cell).toBe(record.cell);
          expect(l.reference).toBe(record.l1_ref_number);
          // Admission's own membership verdict: a step the poll doesn't
          // accept fails it even where an earlier check rejected the ballot.
          if (why !== undefined && ROOT_CODES.has(why)) expect(l.member).toBe(false);
          if (why === undefined || ["repeat", "option-proof", "sum-proof"].includes(why))
            expect(l.member).toBe(true);
          if (why === undefined) {
            expect(l.rejected).toBe(false);
            // Delivery hashes the ballot under version 5, which binds the step (T-38).
            expect(l.tally?.deliveryV4?.step).toBe(record.step);
          }
        }
        if (id === "board")
          for (const kind of [
            "root-step-range",
            "membership-proof",
            "validity-shape",
            "option-proof",
          ])
            expect(
              live.some((l) => code.get(l.entry) === kind),
              kind,
            ).toBe(true);
      });

    test("a supplied root other than the step's fails the copy's membership check", () => {
      const { live, code } = copiesOf(byId("rolling-path"));
      const mismatched = live.filter((l) => code.get(l.entry) === "root-step-mismatch");
      expect(mismatched.length).toBeGreaterThan(0);
      for (const l of mismatched) expect(l).toMatchObject({ member: false, rejected: true });
    });
  },
);

// The `board` case's definition, Tier 0's rolling tier alone, open for a
// week and made live: releases every 24 hourly periods, a batch of 20.
const sealed = decodeDefinition(hex(byId("board").definition)) as V7;
const value: ElectionDefinitionV7 = {
  ...sealed.value,
  rolling_electorate: sealed.value.rolling_electorate.filter((t) => t.tier === 0),
  opens_at: 1_780_000_000n,
  closes_at: 1_780_000_000n + 168n * 3600n,
  results_mode: RESULTS_MODES.live,
  live_every: 24,
  live_batch: 20,
};
const definition = decodeDefinition(encodeElectionDefinitionV7(value)) as V7;
const { hash, rule } = readDefinition(definition);
const RULES = tallyRules(definition);
const OPENS = value.opens_at;
const CLOCK: AnchorClock = { epoch: OPENS, period: 3600n, deadline: 600n, lastSegment: 1000 };

// A finalized header every 12 hours from just before opening to after
// close: snapshot r's head is the one at `OPENS + 24r h − 12`.
const BLOCKS = run(
  21_000_000n,
  Array.from({ length: 17 }, (_, k) => OPENS - 12n + BigInt(k) * 43_200n),
).map((h) => decodeHeader(h.encoded));
const head = (r: number) => OPENS + BigInt(r) * 86_400n - 12n;
const REFERENCE = 21_000_000n;

const PERIOD = BigInt(PARAMETERS.ROOT_PERIOD);
const OFFSET = BigInt(PARAMETERS.ROOT_OFFSET);
const FINALITY = BigInt(PARAMETERS.ROOT_FINALITY);
/** The newest step whose boundary plus `ROOT_FINALITY` is at or before `t`: final at a head of timestamp `t`. */
const finalBy = (t: bigint) => Number((t - FINALITY - OFFSET) / PERIOD);

const delivery = JSON.parse(readFileSync(new URL("delivery-v2.json", VECTORS), "utf8")) as {
  readonly seats: { readonly default: readonly { readonly kemKey: string }[] };
};
const KEM = decode(
  KEM_PUBLIC_KEY,
  hex((delivery.seats.default[0] as { readonly kemKey: string }).kemKey),
);
const SEATS = [1, 2, 3];
const SECRETS = [1, 2, 3, 4].map((i) => sha256(text(`live-rolling.test seat ${i}`)));
const secret = (seat: number) => SECRETS[seat - 1] as Uint8Array;
const REGISTERED: RegisteredKeys[] = SEATS.map((index) => ({
  index,
  kemKey: KEM,
  signingKey: identityKey(secret(index)),
}));

const VOTE: readonly (0 | 1)[] = [1, 0, 0, 1, 0, 0, 0, 1, 0];
const OTHER: readonly (0 | 1)[] = [0, 1, 0, 0, 1, 0, 0, 0, 1];
const counts = (ballots: number, votes: readonly (0 | 1)[]) =>
  votes.map((v) => String(v * ballots));

interface Cast {
  readonly nullifier: bigint;
  readonly step: number;
  readonly vote: CommittedVoteV4;
  readonly hash: Uint8Array;
  readonly sharing: VoteSharingV4;
}

let nextNullifier = 7_000n;
const rules = {
  questions: RULES.questions as readonly QuestionRules[],
  threshold: RULES.threshold,
  panelSize: RULES.panelSize,
  authorThreshold: 0,
  authorPanelSize: 0,
};
/** A version-5 ballot in cell 0 naming `step`, by a new nullifier unless one is given. */
function cast(votes: readonly (0 | 1)[], step: number, nullifier = nextNullifier++): Cast {
  const sharing = shareVoteV4(rules, votes);
  const shareHashes = Array.from({ length: RULES.panelSize }, (_, i) =>
    SEATS.includes(i + 1)
      ? sha256(text(`share ${nullifier} ${i + 1} ${votes.join("")}`))
      : new Uint8Array(32),
  );
  const named = { definitionHash: hash, cell: 0, nullifier };
  const vote = proveValidityV5({ ...rules, ...named }, sharing, shareHashes, []);
  return { nullifier, step, vote, hash: ballotHashV5({ ...named, step }, vote), sharing };
}

// Steps final at snapshot 1's head, and ones final only from snapshot 2's.
const EARLY = finalBy(head(1));
const LATE = EARLY + 1;
const BATCH_A = Array.from({ length: 20 }, () => cast(VOTE, EARLY));
const BATCH_B = Array.from({ length: 20 }, () => cast(OTHER, LATE));
// Later entrants, which the lag needs after a release (tally.md, Release choice, rule 2).
const BATCH_C = Array.from({ length: 20 }, () => cast(VOTE, EARLY));
const BATCH_D = Array.from({ length: 20 }, () => cast(VOTE, LATE));
const PLACEHOLDER = (() => {
  for (const e of splitEntries(hex(byId("board").board)).entries) {
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
        { election_id: value.election_id, index: BigInt(entries.length), segment, payload },
        6,
      ),
    );
    return entries.length - 1;
  };
  /** `b`'s copy as admission gives it: admitted, or failing its membership check alone. */
  const ballot = (b: Cast, segment: number, member = true) => {
    const entry = board(segment, PLACEHOLDER);
    copies.push({
      entry,
      segment,
      tier: 0,
      cell: 0,
      nullifier: b.nullifier,
      message: sha256(b.hash),
      step: b.step,
      member,
      rejected: !member,
      reference: REFERENCE,
      referenceKnown: true,
      ...(member && {
        tally: {
          cell: 0,
          vss: b.vote.vss,
          deliveryV4: { cell: 0, nullifier: b.nullifier, vote: b.vote, step: b.step },
        },
      }),
    });
  };
  /** Seat `seat`'s receipt for `b`, naming `ballotHash` (`b`'s own unless given). */
  const receipt = (b: Cast, seat: number, ballotHash = b.hash) => {
    const shareHash = b.vote.share_hashes[seat - 1] as Uint8Array;
    const m = shareReceiptStatementV4({
      definition_hash: hash,
      ballot_hash: ballotHash,
      panel: 1,
      seat,
      share_hash: shareHash,
    });
    return encodeShareReceiptV2(
      shareReceiptRecordV2(hash, seat, {
        panel: 1,
        ballotHash,
        shareHash,
        receipt: signStatement(secret(seat), "abolish/v1/sig/share-receipt-2", m),
      }),
    );
  };
  const deliver = (ballots: readonly Cast[], segment: number, hashOf = (b: Cast) => b.hash) => {
    for (const b of ballots) for (const seat of SEATS) board(segment, receipt(b, seat, hashOf(b)));
  };
  /** Seats 1 to k's opening of `set` in cell 0 as release `snapshot`, signed by `signer`. */
  const opening = (set: readonly Cast[], snapshot: number, signer: number) => {
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
    return encodeRunningOpening(
      signRunningOpening(secret(signer), {
        definition_hash: hash,
        cell: 0,
        snapshot,
        aggregate_hash: aggregateHash(aggregateCell(RULES, vss)),
        signer,
        opening: opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint })),
      }),
    );
  };
  const inputs = (counted: readonly Cast[], over: Partial<ReleaseInputs> = {}): ReleaseInputs => ({
    definition,
    definitionHash: hash,
    registered: REGISTERED,
    copies,
    entries,
    boardEntryVersion: 6,
    extent: entries.length,
    clock: CLOCK,
    blocks: BLOCKS,
    counted: [new Set(counted.map((b) => toHex(sha256(b.hash))))],
    ...over,
  });
  return { entries, board, ballot, deliver, opening, inputs };
}

const tier0 = (r: ReturnType<typeof releaseChecks>) => r.report?.tiers.find((t) => t.tier === 0);
const cell0 = (r: ReturnType<typeof releaseChecks>) => r.report?.cells[0]?.releases;

describe("the releases of a live rolling poll once 7.1 passed", { timeout: 120_000 }, () => {
  test("the fixture's definition is a well-formed live rolling version 7 with Tier 0 alone", () => {
    expect(rule).toBeUndefined();
    expect(isRolling(definition)).toBe(true);
    expect(isLive(definition)).toBe(true);
    expect(definition.value.electorate_mode).toBe(ELECTORATE_MODES.rolling);
    expect(definition.value.rolling_electorate.map((t) => t.tier)).toEqual([0]);
    expect(definition.value.author_keys).toEqual([]);
    // EARLY is final at snapshot 1's head, LATE only from snapshot 2's.
    const boundary = (n: number) => BigInt(n) * PERIOD + OFFSET;
    expect(boundary(EARLY) + FINALITY).toBeLessThanOrEqual(head(1));
    expect(boundary(LATE) + FINALITY).toBeGreaterThan(head(1));
    expect(boundary(LATE) + FINALITY).toBeLessThanOrEqual(head(2));
  });

  test("ballots whose step is final at snapshot 1's head enter it, and release 1 opens them", () => {
    const e = election();
    for (const b of BATCH_A) e.ballot(b, 10);
    e.deliver(BATCH_A, 11);
    for (const b of BATCH_C) e.ballot(b, 30);
    e.deliver(BATCH_C, 31);
    e.board(50, e.opening(BATCH_A, 1, 1));
    const r = releaseChecks(e.inputs([...BATCH_A, ...BATCH_C]));
    expect(Object.fromEntries(r.rows)).toEqual({
      "7.5": { status: "pass" },
      "7.6": { status: "pass" },
    });
    expect(tier0(r)?.decisions.map((x) => x.release)).toEqual([1, null, null, null, null, null]);
    expect(tier0(r)?.releases).toEqual([{ snapshot: 1, counts: counts(20, VOTE) }]);
    expect(cell0(r)).toEqual([
      { snapshot: 1, size: 20, entered: 20, counts: counts(20, VOTE), signers: [1] },
    ]);
  });

  test("ballots whose step isn't final at snapshot 1's head are pending there and enter at snapshot 2", () => {
    // Batch B is boarded and receipted before snapshot 1, but names a step
    // final only from snapshot 2's head: R_1 is empty and R_2 holds it, so
    // the decision at 3 releases snapshot 2 once batch C has entered.
    const e = election();
    for (const b of BATCH_B) e.ballot(b, 10);
    e.deliver(BATCH_B, 11);
    for (const b of BATCH_C) e.ballot(b, 50);
    e.deliver(BATCH_C, 51);
    e.board(80, e.opening(BATCH_B, 2, 2));
    const r = releaseChecks(e.inputs([...BATCH_B, ...BATCH_C]));
    expect(Object.fromEntries(r.rows)).toEqual({
      "7.5": { status: "pass" },
      "7.6": { status: "pass" },
    });
    expect(tier0(r)?.decisions.map((x) => x.release)).toEqual([null, 2, null, null, null, null]);
    expect(cell0(r)).toEqual([
      { snapshot: 2, size: 20, entered: 20, counts: counts(20, OTHER), signers: [2] },
    ]);
  });

  test("an opening of snapshot 1 over ballots whose step wasn't final there is unscheduled", () => {
    // Read as final at snapshot 1, batch B would be released there; an
    // honest node never computes that release (T-34), so its opening is the
    // signer's breach, over a set the running sets never held.
    const e = election();
    for (const b of BATCH_B) e.ballot(b, 10);
    e.deliver(BATCH_B, 11);
    for (const b of BATCH_C) e.ballot(b, 50);
    e.deliver(BATCH_C, 51);
    const at = e.board(30, e.opening(BATCH_B, 1, 1));
    const r = releaseChecks(e.inputs([...BATCH_B, ...BATCH_C]));
    expect(r.rows.get("7.6")).toEqual({
      status: "fail",
      code: "running-unscheduled",
      at: { entry: at },
    });
    expect(r.report?.openings[0]).toMatchObject({
      kind: "outside-schedule",
      discloses: false,
      blamed: 1,
    });
  });

  test("a copy failing its membership check holds its nullifier out while its step is pending", () => {
    // A copy for each of batch A's nullifiers naming a LATE step, whose
    // membership check fails, boarded ahead of the real ballots: at
    // snapshot 1 it is pending and counts, so no nullifier of batch A has
    // exactly one ballot; at snapshot 2 it is final and doesn't count, and
    // batch A enters with batch C (tally.md, Running set, condition 1; T-45).
    const e = election();
    for (const b of BATCH_A) e.ballot(cast(OTHER, LATE, b.nullifier), 9, false);
    for (const b of BATCH_A) e.ballot(b, 10);
    e.deliver(BATCH_A, 11);
    for (const b of BATCH_C) e.ballot(b, 30);
    e.deliver(BATCH_C, 31);
    for (const b of BATCH_D) e.ballot(b, 50);
    e.deliver(BATCH_D, 51);
    e.board(80, e.opening([...BATCH_A, ...BATCH_C], 2, 1));
    const r = releaseChecks(e.inputs([...BATCH_A, ...BATCH_C, ...BATCH_D]));
    expect(Object.fromEntries(r.rows)).toEqual({
      "7.5": { status: "pass" },
      "7.6": { status: "pass" },
    });
    expect(cell0(r)).toEqual([
      { snapshot: 2, size: 40, entered: 40, counts: counts(40, VOTE), signers: [1] },
    ]);
    // The same copies naming an EARLY step, final at snapshot 1, never
    // count, and batch A enters at snapshot 1.
    const f = election();
    for (const b of BATCH_A) f.ballot(cast(OTHER, EARLY, b.nullifier), 9, false);
    for (const b of BATCH_A) f.ballot(b, 10);
    f.deliver(BATCH_A, 11);
    for (const b of BATCH_C) f.ballot(b, 30);
    f.deliver(BATCH_C, 31);
    expect(cell0(releaseChecks(f.inputs([...BATCH_A, ...BATCH_C])))?.[0]).toMatchObject({
      snapshot: 1,
      size: 20,
    });
  });

  test("a step final at no header of the run stays pending at every snapshot", () => {
    const never = finalBy(BLOCKS.at(-1)?.timestamp as bigint) + 1;
    const late = BATCH_A.map((b) => cast(VOTE, never, b.nullifier));
    const e = election();
    for (const b of late) e.ballot(b, 10);
    e.deliver(late, 11);
    for (const b of BATCH_C) e.ballot(b, 30);
    e.deliver(BATCH_C, 31);
    for (const b of BATCH_D) e.ballot(b, 50);
    e.deliver(BATCH_D, 51);
    const r = releaseChecks(e.inputs([...late, ...BATCH_C, ...BATCH_D]));
    // R_2 is batch C alone: the never-final copies stay out of every set.
    expect(cell0(r)).toEqual([{ snapshot: 2, size: 20, entered: 20, counts: null, signers: [] }]);
  });

  test("a step is final from the first header at exactly its boundary plus ROOT_FINALITY", () => {
    // Snapshot 1's head moved to exactly EARLY's boundary plus
    // ROOT_FINALITY: final there, and batch A is released at 1. One second
    // earlier it is pending, R_1 is empty and nothing is ever released.
    const edge = BigInt(EARLY) * PERIOD + OFFSET + FINALITY;
    const blocksWith = (t: bigint) =>
      run(
        21_000_000n,
        Array.from({ length: 17 }, (_, k) => (k === 2 ? t : OPENS - 12n + BigInt(k) * 43_200n)),
      ).map((h) => decodeHeader(h.encoded));
    for (const [t, released] of [
      [edge, [1]],
      [edge - 1n, []],
    ] as const) {
      const e = election();
      for (const b of BATCH_A) e.ballot(b, 10);
      e.deliver(BATCH_A, 11);
      for (const b of BATCH_C) e.ballot(b, 30);
      e.deliver(BATCH_C, 31);
      const r = releaseChecks(e.inputs([...BATCH_A, ...BATCH_C], { blocks: blocksWith(t) }));
      expect(r.report?.snapshots[0]?.l1Head.number).toBe("21000002");
      expect(cell0(r)?.map((x) => x.snapshot)).toEqual(released);
    }
  });

  test("a receipt names the ballot hash with its step: one for the same fields under another hash receipts nothing", () => {
    // Every seat receipts batch A's fields under version 4's hash, which
    // binds no step, or under version 5's at another step: batch A is never
    // fully receipted, and R_2 is batch C alone (T-38).
    for (const hashOf of [
      (b: Cast) => ballotHashV4({ definitionHash: hash, cell: 0, nullifier: b.nullifier }, b.vote),
      (b: Cast) =>
        ballotHashV5({ definitionHash: hash, cell: 0, nullifier: b.nullifier, step: LATE }, b.vote),
    ]) {
      const e = election();
      for (const b of BATCH_A) e.ballot(b, 10);
      e.deliver(BATCH_A, 11, hashOf);
      for (const b of BATCH_C) e.ballot(b, 30);
      e.deliver(BATCH_C, 31);
      for (const b of BATCH_D) e.ballot(b, 50);
      e.deliver(BATCH_D, 51);
      const r = releaseChecks(e.inputs([...BATCH_C, ...BATCH_D]));
      expect(cell0(r)).toEqual([{ snapshot: 2, size: 20, entered: 20, counts: null, signers: [] }]);
    }
  });
});
