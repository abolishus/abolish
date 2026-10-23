// The tally duty under definition version 5, the polls the website creates
// (P2-13 part 4c-2b): two questions over three cells, tier 0 split into two
// regional cells and tier 1 one cell, with version-3 ballots made as the
// ballot client makes them (packages/crypto's seal with a real Groth16
// membership proof) and taken in by every seat's own intake. Every opening is
// judged by crypto's own checks (`checkOpening` under the definition's
// questions, the signature), never by the duty.
import { readFileSync } from "node:fs";
import {
  aggregateCell,
  aggregateHash,
  type BallotRecordV3,
  castSealV3,
  checkCeremonyTranscript,
  checkOpening,
  decodeBallot,
  decodeTallyOpening,
  encodeTallyOpening,
  type ElectionDefinitionV5,
  encodeBallotV3,
  finishSealV3,
  identityCommitment,
  newIdentitySecret,
  questionBallotElection,
  type QuestionBallotElection,
  type RegisteredKeys,
  sealBallotV3,
  tallyOpeningStatement,
  tallyRules,
  tierTreeRoot,
  verifyStatement,
} from "@abolishus/crypto";
import { type MembershipProverArtifacts, proveMembership } from "@abolishus/membership-prover";
import { beforeAll, describe, expect, test } from "vite-plus/test";
import type { ApprovedElection, IntakeSecrets } from "../src/ceremony.ts";
import { IntakeSeat, type SeatStore } from "../src/index.ts";
import type { BoardOpenings } from "../src/openings.ts";
import { MemoryStore } from "../src/store.ts";
import {
  type CountedSet,
  type SummedSharePeers,
  type TallyDefinition,
  TallyDuty,
  type TallyDutyStatus,
} from "../src/tally.ts";
import {
  AVAILABLE,
  electionV5,
  type ElectionV5,
  L2_CHAIN_ID,
  runCeremony,
  TRUSTEE_REGISTRY,
  value,
} from "./fixture.ts";

const ARTIFACTS = new URL(
  "../../../packages/membership-prover/artifacts/snark-artifacts/",
  import.meta.url,
);
const artifacts: MembershipProverArtifacts = {
  zkey: readFileSync(new URL("semaphore-32.zkey", ARTIFACTS)),
  wasm: readFileSync(new URL("semaphore-32.wasm", ARTIFACTS)),
};

// Voters 0 and 1 are in tier 0's first region, voter 2 in its second and
// voter 3 in tier 1. Each cell's tree holds only its own voters' leaves.
const secrets = Array.from({ length: 4 }, () => newIdentitySecret());
const leaves = secrets.map((s) => identityCommitment(s));
const CELL_OF = [0, 0, 1, 2] as const;
const leavesOf = (cell: number) => leaves.filter((_, v) => CELL_OF[v] === cell);

// Question 0 has two options (at most one), question 1 three (any number):
// five flat options, so the opening of a cell is five counts.
const VOTES: readonly (readonly (0 | 1)[])[] = [
  [1, 0, 1, 0, 1],
  [0, 1, 1, 1, 0],
  [1, 0, 0, 0, 0],
  [0, 0, 0, 0, 0],
];
const COUNTS = [[1n, 1n, 2n, 1n, 1n], [1n, 0n, 0n, 0n, 0n], Array(5).fill(0n)];

interface Cast {
  readonly record: BallotRecordV3;
  readonly bytes: Uint8Array;
}

let e: ElectionV5;
let stores: SeatStore[];
let transcript: Uint8Array;
let definition: ElectionDefinitionV5;
let registered: readonly RegisteredKeys[];
let election: QuestionBallotElection;
let ballots: Cast[];
let approved: ApprovedElection[];
let intakeSecrets: IntakeSecrets[];

beforeAll(async () => {
  stores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
  const base = electionV5(3, 2).stub.electorate[0];
  if (base === undefined) throw new Error("no tier");
  // Two regions of at least MIN_CELL_ELECTORATE split tier 0 into two cells
  // (the fold); the stated counts are the creator's, which only the
  // verifier compares with the board (2.4).
  e = electionV5(3, 2, {
    stores,
    stub: {
      electorate: [
        {
          ...base,
          groups: [
            { group_id: 1n, region: 0 },
            { group_id: 2n, region: 1 },
          ],
          regions: [1000n, 1000n],
          cells: [
            { root: tierTreeRoot(leavesOf(0)), members: 1000n },
            { root: tierTreeRoot(leavesOf(1)), members: 1000n },
          ],
        },
        {
          ...base,
          tier: 1,
          groups: [{ group_id: 3n, region: 0 }],
          regions: [1n],
          cells: [{ root: tierTreeRoot(leavesOf(2)), members: 1n }],
        },
      ],
    },
  });
  const run = await runCeremony(e);
  for (const seat of e.seats) value(await seat.approve(e.stubBytes, run.transcript));
  transcript = run.transcript;
  const check = checkCeremonyTranscript(
    {
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      electionId: e.stub.election_id,
      stubHash: e.stubHash,
      panel: e.panelists.panel,
    },
    transcript,
    1,
  );
  if (!check.ok) throw new Error(`transcript: ${check.code}`);
  definition = { ...e.stub, ceremony_transcript_hash: check.hash };
  registered = check.registered;
  election = questionBallotElection(definition, registered);
  const intake = e.seats.map(
    (ceremony, i) =>
      new IntakeSeat({
        panel: e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        index: i + 1,
        ceremony,
        electorate: () => Promise.resolve(true),
        registration: () => Promise.resolve(true),
        store: stores[i] as SeatStore,
        now: () => e.stub.opens_at,
      }),
  );
  ballots = [];
  for (const [v, votes] of VOTES.entries()) {
    const cell = CELL_OF[v] as number;
    const sealed = sealBallotV3(election, cell, [...votes]);
    const casting = castSealV3(sealed, secrets[v] as Uint8Array, leavesOf(cell), {
      number: 100n,
      hash: new Uint8Array(32).fill(7),
    });
    const cast = finishSealV3(casting, await proveMembership(casting.witness, artifacts));
    for (const c of cast.ciphertexts) {
      const taken = await (intake[c.seat - 1] as IntakeSeat).intake(
        e.stubBytes,
        transcript,
        cast.ballot,
        c.ciphertext,
      );
      if (!taken.ok) throw new Error(`intake refused an honest ballot: ${taken.code}`);
    }
    ballots.push({ record: decodeBallot(cast.ballot, 3), bytes: cast.ballot });
  }
  approved = [];
  intakeSecrets = [];
  for (const seat of e.seats) {
    const a = await seat.approvedElection(e.stubHash);
    const k = await seat.intakeSecrets(e.stubHash);
    if (a === undefined || k === undefined) throw new Error("a seat holds no approval");
    approved.push(a);
    intakeSecrets.push(k);
  }
}, 240_000);

const tagged = (): TallyDefinition => ({ version: 5, value: definition });
const fixed = (cells: readonly (readonly Uint8Array[])[]): CountedSet => ({
  state: "fixed",
  cells,
});
const byCell = () =>
  [0, 1, 2].map((c) => ballots.filter((_, v) => CELL_OF[v] === c).map((b) => b.bytes));

class Wire implements SummedSharePeers {
  duties: TallyDuty[] = [];
  readonly sent: { recipient: number; message: Uint8Array }[] = [];
  deliver = true;
  async send(recipient: number, message: Uint8Array): Promise<void> {
    this.sent.push({ recipient, message });
    if (this.deliver) await (this.duties[recipient - 1] as TallyDuty).receive(message);
  }
}

/** A store over `store` whose tally records are this test's own. */
const written = new WeakMap<SeatStore, ReadonlyMap<string, Uint8Array>>();
function overlay(store: SeatStore): SeatStore {
  const own = new Map<string, Uint8Array>();
  const over: SeatStore = {
    get: async (key) => own.get(key) ?? (key.startsWith("tally/") ? undefined : store.get(key)),
    putOnce: async (key, value) => {
      const held = own.get(key);
      if (held !== undefined) return { created: false, value: held };
      own.set(key, value);
      return { created: true, value };
    },
    list: async (prefix) => {
      const under = `${prefix}/`;
      const mine = [...own.keys()]
        .filter((k) => k.startsWith(under) && !k.slice(under.length).includes("/"))
        .map((k) => k.slice(under.length));
      const theirs = prefix.startsWith("tally/") ? [] : await store.list(prefix);
      return [...new Set([...mine, ...theirs])].sort();
    },
  };
  written.set(over, own);
  return over;
}

interface Options {
  counted?: CountedSet;
  definition?: TallyDefinition;
  stores?: readonly SeatStore[];
  board?: () => Promise<BoardOpenings>;
}

function duties(wire: Wire, o: Options = {}): TallyDuty[] {
  const own = o.stores ?? stores.map(overlay);
  wire.duties = approved.map(
    (a, i) =>
      new TallyDuty({
        panel: e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        election: a,
        secrets: intakeSecrets[i] as IntakeSecrets,
        definition: o.definition ?? tagged(),
        transcript,
        store: own[i] as SeatStore,
        summing: AVAILABLE,
        counted: async () => o.counted ?? fixed(byCell()),
        board: o.board ?? (async () => ({ state: "unread" })),
        peers: wire,
      }),
  );
  return wire.duties;
}

/** Each seat fixes its counted set with nothing delivered, so no message is dropped later. */
async function prime(wire: Wire): Promise<void> {
  wire.deliver = false;
  for (const duty of wire.duties) await duty.step();
  wire.sent.length = 0;
  wire.deliver = true;
}

const rules = () => tallyRules({ version: 5, value: definition });
const vssOf = (bytes: Uint8Array) => decodeBallot(bytes, 3).committed_vote.vss;

/** Checks a signed opening as a verifier does: cell `cell`'s counted ballots, under the questions' ranges. */
function judge(bytes: Uint8Array, cell: number, signer: number) {
  const o = decodeTallyOpening(bytes, 1);
  const vss = (byCell()[cell] as Uint8Array[]).map(vssOf);
  expect(o.definition_hash).toEqual(election.definitionHash);
  expect(o.cell).toBe(cell);
  expect(o.signer).toBe(signer);
  expect(o.aggregate_hash).toEqual(aggregateHash(aggregateCell(rules(), vss)));
  const key = (registered.find((k) => k.index === signer) as RegisteredKeys).signingKey;
  expect(
    verifyStatement(key, "abolish/v1/sig/tally-opening", tallyOpeningStatement(o), o.signature),
  ).toBe(true);
  const checked = checkOpening(rules(), vss, o.opening);
  if (!checked.ok) expect.fail(`the opening fails ${checked.code}`);
  return checked.counts;
}

const states = (status: TallyDutyStatus) =>
  status.state === "tallying" ? status.cells.map((c) => c.state) : status.state;

describe("the tally duty under definition version 5", () => {
  test("every cell of the partition is opened, each over its own ballots and every question", async () => {
    const wire = new Wire();
    const own = stores.map(overlay);
    const d = duties(wire, { stores: own });
    await prime(wire);
    const first = [];
    for (const duty of d) first.push(await duty.step());
    expect(first[0]).toEqual({
      state: "tallying",
      cells: [0, 1, 2].map(() => ({ state: "combining", held: 1, sent: 2 })),
      board: "unread",
    });
    expect(first.slice(1).map(states)).toEqual([
      ["opened", "opened", "opened"],
      ["opened", "opened", "opened"],
    ]);
    for (const [i, duty] of d.slice(1).entries()) {
      const openings = await duty.openings();
      expect([...openings.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2]);
      for (const [c, expected] of COUNTS.entries())
        expect(judge(openings.get(c) as Uint8Array, c, i + 2)).toEqual(expected);
    }
    // Only each cell's aggregate hash and signed opening reach the store (T-15).
    for (const store of own)
      for (const key of written.get(store)!.keys())
        expect(key).toMatch(/^tally\/[0-9a-f]{64}\/(aggregates|openings)\/[0-2]$/);
  });

  test("each cell is published on its own once the board carries a passing opening of it", async () => {
    const wire = new Wire();
    let board: BoardOpenings = { state: "unread" };
    const d = duties(wire, { board: async () => board });
    await prime(wire);
    for (const duty of d) await duty.step();
    const openings = await d[1]!.openings();
    // Cells 0 and 2 on the board, cell 1's opening moved to cell 0 (over
    // another aggregate there, so it passes for neither).
    const o1 = decodeTallyOpening(openings.get(1) as Uint8Array, 1);
    board = {
      state: "read",
      checkpoint: new Uint8Array(32),
      openings: [
        { payload: encodeTallyOpening({ ...o1, cell: 0 }), segment: 139 },
        { payload: openings.get(2) as Uint8Array, segment: 140 },
        { payload: openings.get(0) as Uint8Array, segment: 141 },
      ],
    };
    wire.sent.length = 0;
    const status = await d[0]!.step();
    expect(status).toMatchObject({
      cells: [
        { state: "published", segment: 141 },
        { state: "combining" },
        { state: "published", segment: 140 },
      ],
      board: "read",
    });
    // Seat 1 still sends its sums of cell 1 alone.
    expect(wire.sent).toHaveLength(2);
  });

  test("an empty cell opens to zero counts", async () => {
    const wire = new Wire();
    const cells = byCell();
    cells[1] = [];
    const d = duties(wire, { counted: fixed(cells) });
    await prime(wire);
    for (const duty of d) await duty.step();
    const opening = (await d[2]!.openings()).get(1) as Uint8Array;
    expect(decodeTallyOpening(opening, 1).opening.map((s) => s.v)).toEqual(Array(5).fill(0n));
    expect(checkOpening(rules(), [], decodeTallyOpening(opening, 1).opening).ok).toBe(true);
  });
});

describe("what the duty refuses to sum over under version 5", () => {
  const refused = async (o: Options) => {
    const wire = new Wire();
    const status = await duties(wire, o)[0]!.step();
    expect(wire.sent).toEqual([]);
    return status;
  };
  const relabel = (b: Cast, change: Partial<BallotRecordV3>) =>
    encodeBallotV3({ ...b.record, ...change });
  const refusal = (reason: string) => ({ state: "refused", reason });

  test("the number of cells of version 1's partition, one per tier", async () => {
    const cells = byCell();
    expect(await refused({ counted: fixed([[...cells[0]!, ...cells[1]!], cells[2]!]) })).toEqual(
      refusal("another number of cells than the partition's"),
    );
    expect(await refused({ counted: fixed([...cells, []]) })).toEqual(
      refusal("another number of cells than the partition's"),
    );
  });

  test("a ballot listed under a cell other than the one it names", async () => {
    const cells = byCell();
    // Voter 2's ballot, of cell 1, listed under tier 0's other cell, and under tier 1's.
    for (const into of [0, 2]) {
      const moved = cells.map((c) => [...c]);
      moved[into]!.push(ballots[2]!.bytes);
      moved[1] = [];
      expect(await refused({ counted: fixed(moved) })).toEqual(
        refusal("a counted ballot of another election or cell"),
      );
    }
    const other = relabel(ballots[0]!, { definition_hash: new Uint8Array(32).fill(9) });
    expect(await refused({ counted: fixed([[other], [], []]) })).toEqual(
      refusal("a counted ballot of another election or cell"),
    );
  });

  test("a voter counted in two cells of their tier", async () => {
    // Voter 0's nullifier again in tier 0's second cell: the tier's one voter twice.
    const cells = byCell();
    cells[1] = [...cells[1]!, relabel(ballots[0]!, { cell: 1 })];
    expect(await refused({ counted: fixed(cells) })).toEqual(refusal("a voter counted twice"));
  });

  test("a ballot relabelled to another cell finds no shares there (T-38)", async () => {
    // Voter 2's vote re-encoded naming tier 0's first cell: it passes the
    // cell check, but its ballot hash binds the cell, so no seat holds shares
    // under it and none sends sums for that cell.
    const cells = byCell();
    cells[0] = [...cells[0]!, relabel(ballots[2]!, { cell: 0 })];
    cells[1] = [];
    const wire = new Wire();
    expect(await duties(wire, { counted: fixed(cells) })[0]!.step()).toEqual({
      state: "tallying",
      cells: [
        { state: "missing-shares", missing: 1, held: 0 },
        { state: "combining", held: 1, sent: 2 },
        { state: "combining", held: 1, sent: 2 },
      ],
      board: "unread",
    });
  });

  test("a record of another ballot version, or none", async () => {
    // The same bytes under version 1's version byte: never read as version 3 (T-34).
    const v1 = Uint8Array.from(ballots[3]!.bytes);
    v1[2] = 1;
    const cells = byCell();
    for (const bad of [v1, ballots[3]!.bytes.slice(1), new Uint8Array(0)]) {
      cells[2] = [bad];
      expect(await refused({ counted: fixed(cells) })).toEqual(
        refusal("a counted ballot doesn't decode"),
      );
    }
  });

  test("a ballot of another shape", async () => {
    const vote = ballots[0]!.record.committed_vote;
    const cells = byCell();
    cells[0] = [relabel(ballots[0]!, { committed_vote: { ...vote, vss: vote.vss.slice(1) } })];
    expect(await refused({ counted: fixed(cells) })).toEqual(
      refusal("a counted ballot of another shape"),
    );
  });

  test("a definition other than the approved one", async () => {
    // The version-5 definition tagged as version 1, hashed under version 1's layout (T-34).
    expect(await refused({ definition: { version: 1, value: definition as never } })).toEqual(
      refusal("the definition isn't the one the seat approved"),
    );
    const later = { ...definition, closes_at: definition.closes_at + 1n };
    expect(await refused({ definition: { version: 5, value: later } })).toEqual(
      refusal("the definition isn't the one the seat approved"),
    );
  });
});
