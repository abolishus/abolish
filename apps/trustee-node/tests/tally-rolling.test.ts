// The counted source, the view, the complaint duty's ballot source and the
// tally duty over a rolling poll (P2-17 parts 7c-3c-2b and 7c-3c-2c): a
// whole ceremony between seats over a rolling version-7 stub, version-5
// ballots made as a client makes them (a real Groth16 membership
// proof against a step's root, naming a real L1 block whose time puts the
// step in its window, 5.8), taken in by every seat's own intake, then the
// anchored counted extent read by `countedSource` against the chain the
// seat's rolling check gives, and the tally duty summing and opening over
// that set. The set must be exactly the verifier's under that chain, wait
// while the chain isn't proven past the close, and the duty must open the
// one rolling tier's cell to the votes cast (T-14, T-16, T-29, T-38). The
// view at `c_I` and the complaint duty's ballot source read the same poll
// (part 7c-3c-2c): the view judges the extent's ballots and the board
// contract's rolling copies against a chain read afresh past the close, each
// contract copy under the root its event carries (T-25, T-54).
//
// Stub check 4 refuses every rolling stub until roots can be sent and read
// ([[P1-12f]] parts 3b and 3c), so this file lifts that one refusal, and
// only it, as intake-rolling.test.ts does.
import { readFileSync } from "node:fs";
import {
  aggregateCell,
  aggregateHash,
  type AnchorClock,
  availabilityWindows,
  type BallotRecordV5,
  ballotHashV5,
  type BoardEntryVersion,
  checkCeremonyTranscript,
  checkOpening,
  countedExtent,
  decodeBallot,
  decodeMembershipProof,
  decodeTallyOpening,
  deliverySegments,
  type ElectionDefinitionV7,
  electionDefinitionV7Hash,
  decode,
  encodeBallotV5,
  encodeBoardEntry,
  encodeElectionDefinitionV7,
  encryptSharesV4,
  finishMembershipProof,
  identityCommitment,
  membershipMessage,
  newIdentitySecret,
  pinnedVersion,
  proveValidityV5,
  RECORD_TYPES,
  type RegisteredKeys,
  type RollingBallotChain,
  rollingBallotElection,
  type RollingBallotElection,
  rollingMembershipNullifier,
  rollingMembershipProverInput,
  RollingTierTree,
  SEAT_PANELS,
  SHARE_CIPHERTEXT,
  type RollingTierEvent,
  encodeSharePosting,
  encodeSharePostingV2,
  shareVoteV4,
  tallyOpeningStatement,
  tallyRules,
  verifyStatement,
} from "@abolishus/crypto";
import { type MembershipProverArtifacts, proveMembership } from "@abolishus/membership-prover";
import {
  DEFINITION_REGISTERED,
  ELECTION_CREATED,
  finalizedBlock,
  headerRun,
  type Rpc,
} from "@abolishus/node";
import { countedSet, decodeHeader } from "@abolishus/verifier";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { ApprovedElection, IntakeSecrets } from "../src/ceremony.ts";
import { IntakeSeat, type SeatStore } from "../src/index.ts";
import type { RollingIntakeChain } from "../src/rolling-chain.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import {
  type CountedSet,
  type SummedSharePeers,
  type TallyDefinition,
  TallyDuty,
} from "../src/tally.ts";
import {
  complaintBallots,
  countedSource,
  type CountedSourceOptions,
  obligationView,
  tallyDefinition,
  type ViewOptions,
} from "../src/view.ts";
import { anvil, type Node } from "./anvil.ts";
import {
  AVAILABLE,
  type ElectionV7,
  L2_CHAIN_ID,
  rollingElection,
  runCeremony,
  TRUSTEE_REGISTRY,
  value,
} from "./fixture.ts";

vi.mock(import("../src/stub.ts"), async (original) => {
  const stub = await original();
  return {
    ...stub,
    checkStub: vi.fn(async (...args: Parameters<typeof stub.checkStub>) => {
      const checked = await stub.checkStub(...args);
      if (checked.ok || checked.code !== "stub-capacity") return checked;
      const record = stub.decodeStub(args[0]);
      return record.version === 7
        ? { ok: true as const, stub: record, stubHash: stub.stubHash(record) }
        : checked;
    }),
  };
});

const ARTIFACTS = new URL(
  "../../../packages/membership-prover/artifacts/snark-artifacts/",
  import.meta.url,
);
const artifacts: MembershipProverArtifacts = {
  zkey: readFileSync(new URL("semaphore-32.zkey", ARTIFACTS)),
  wasm: readFileSync(new URL("semaphore-32.wasm", ARTIFACTS)),
};

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const word = (n: bigint) => {
  const w = new Uint8Array(32);
  for (let i = 31, x = n; x > 0n; i--, x >>= 8n) w[i] = Number(x & 0xffn);
  return w;
};
const padded = (b: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(b.length / 32) * 32);
  out.set(b);
  return out;
};

const GROUP = 1n;
const secrets = Array.from({ length: 3 }, () => newIdentitySecret());
const leaves = secrets.map((s) => identityCommitment(s));
// Voters 0 and 1 join before the opening state's block; voter 2 after the
// definition's registration, between steps EARLY and LATE (boundaries
// τ_n = 600n + 300), as in intake-rolling.test.ts.
const OPENING: RollingTierEvent = {
  blockNumber: 5n,
  timestamp: 1_005_000n,
  groupId: GROUP,
  kind: "add",
  commitments: [leaves[0] as bigint, leaves[1] as bigint],
};
const JOINER: RollingTierEvent = {
  blockNumber: 20n,
  timestamp: 1_020_910n,
  groupId: GROUP,
  kind: "add",
  commitments: [leaves[2] as bigint],
};
const CHAIN: RollingBallotChain = { events: [OPENING, JOINER], registeredAt: 1_010_000n };
const EARLY = 1700; // τ = 1,020,300: the opening tree
const LATE = 1702; // τ = 1,021,500: the joiner's tree too
// The tier's `root_l2_block` (rollingStubFor's).
const ROOT_BLOCK = 7n;
// The step roots' intake read: past LATE's boundary, long before the close.
const INTAKE_AT = 1_022_000n;
// Each voter's votes over the stub's five options, and their sums.
const VOTES = [
  [1, 0, 1, 0, 1],
  [0, 1, 1, 0, 0],
  [1, 0, 0, 1, 1],
] as const;
const COUNTS = [2n, 1n, 2n, 1n, 2n];

// Anvil starts two hours before the opening and mines a block every 600
// seconds to past the close, so the run holds every block a ballot may name
// (5.8); the ballots name one just after LATE's boundary, which puts both
// steps in its window (`t − ROOT_WINDOW < τ_n ≤ t`).
const GENESIS = 1_000_000n - 7_200n;
const INTERVAL = 600n;
const TIMING = { epoch: GENESIS, period: 3600n, deadline: 600n };
const L1_REF = 50n;
const L2_FINALIZED = 100n;

interface Cast {
  readonly record: BallotRecordV5;
  readonly bytes: Uint8Array;
  /** Each seat's `ct_i`, by seat. */
  readonly ciphertexts: readonly Uint8Array[];
  /** Each seat's ML-KEM message `m_i`, by seat, which a posting carries. */
  readonly ms: readonly Uint8Array[];
}

let e: ElectionV7;
let l1: Node;
let stores: SeatStore[];
let transcript: Uint8Array;
let definition: ElectionDefinitionV7;
let registered: readonly RegisteredKeys[];
let election: RollingBallotElection;
let ballots: Cast[];
/** Each ballot's version-2 receipts from seats 1 to 3. */
let receipts: Uint8Array[][];
let approved: ApprovedElection[];
let intakeSecrets: IntakeSecrets[];
let sS: number;
let sD: number;
/** The close; a chain must be proven past it. */
let closesAt: bigint;
/** `t_A'`: the L2 node's finalized history must be past it. */
let countedDeadline: bigint;

const treeOf = (events: readonly RollingTierEvent[]) => {
  const tree = new RollingTierTree([GROUP]);
  for (const ev of events) tree.apply(ev);
  return tree;
};

async function cast(
  voter: number,
  step: number,
  events: readonly RollingTierEvent[],
  l1Ref: { readonly number: bigint; readonly hash: Uint8Array },
): Promise<Cast> {
  const { definitionHash } = election;
  const rules = {
    questions: election.questions,
    threshold: election.threshold,
    panelSize: election.panelSize,
    authorThreshold: election.authorThreshold,
    authorPanelSize: election.authorPanelSize,
  };
  const secret = secrets[voter] as Uint8Array;
  const sharing = shareVoteV4(rules, [...(VOTES[voter] as readonly (0 | 1)[])]);
  const encrypted = encryptSharesV4(
    { definitionHash },
    sharing,
    registered.map((k) => k.kemKey),
    [],
  );
  const nullifier = rollingMembershipNullifier(secret, { definitionHash, tier: 0 });
  const named = { definitionHash, cell: 0, nullifier };
  const vote = proveValidityV5({ ...rules, ...named }, sharing, encrypted.hashes, []);
  const tree = treeOf(events);
  const message = membershipMessage({
    definitionHash,
    tier: 0,
    ballotHash: ballotHashV5({ ...named, step }, vote),
    l1RefNumber: l1Ref.number,
    l1RefHash: l1Ref.hash,
  });
  const input = rollingMembershipProverInput(secret, tree.leaves, {
    definitionHash,
    tier: 0,
    root: tree.root(),
    message,
  });
  const proof = finishMembershipProof(input, await proveMembership(input.witness, artifacts));
  const record: BallotRecordV5 = {
    definition_hash: definitionHash,
    cell: 0,
    nullifier,
    l1_ref_number: l1Ref.number,
    l1_ref_hash: l1Ref.hash,
    membership_proof: decodeMembershipProof(proof),
    step,
    committed_vote: vote,
  };
  return {
    record,
    bytes: encodeBallotV5(record),
    ciphertexts: encrypted.ciphertexts,
    ms: encrypted.randomness.map((r) => r.m),
  };
}

beforeAll(async () => {
  stores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
  const opening = treeOf([OPENING]);
  e = rollingElection(3, 2, {
    stores,
    stub: {
      rolling_electorate: [
        {
          tier: 0,
          root_l2_block: ROOT_BLOCK,
          groups: [GROUP],
          root: opening.root(),
          group_size: BigInt(opening.memberCount),
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
  election = rollingBallotElection(definition, registered, CHAIN);
  closesAt = definition.closes_at;

  l1 = await anvil(definition.l1_chain_id, true, ["--timestamp", GENESIS.toString()]);
  await l1.rpc.call("anvil_mine", ["0xc8", `0x${INTERVAL.toString(16)}`]);
  const block = (await l1.rpc.call("eth_getBlockByNumber", [
    `0x${L1_REF.toString(16)}`,
    false,
  ])) as { hash: string };
  const ref = { number: L1_REF, hash: hexToBytes(block.hash.slice(2)) };
  ballots = [
    await cast(0, EARLY, [OPENING], ref),
    await cast(1, EARLY, [OPENING], ref),
    await cast(2, LATE, [OPENING, JOINER], ref),
  ];

  // Every seat takes in every ballot, against the chain through a proven
  // block past LATE's boundary.
  const intakeChain: RollingIntakeChain = { chain: CHAIN, safeAt: INTAKE_AT, block: 30n };
  const seats = e.seats.map(
    (ceremony, i) =>
      new IntakeSeat({
        panel: e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        index: i + 1,
        ceremony,
        electorate: () => Promise.resolve(true),
        registration: () => Promise.resolve(true),
        rolling: () => Promise.resolve(intakeChain),
        store: stores[i] as SeatStore,
        now: () => INTAKE_AT,
      }),
  );
  receipts = [];
  for (const ballot of ballots) {
    const given: Uint8Array[] = [];
    for (const [i, seat] of seats.entries()) {
      const out = await seat.intake(
        e.stubBytes,
        transcript,
        ballot.bytes,
        ballot.ciphertexts[i] as Uint8Array,
      );
      if (!out.ok) throw new Error(`seat ${i + 1} refused an honest ballot: ${out.code}`);
      given.push(out.receipt);
    }
    receipts.push(given);
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
  const bound = BigInt(definition.l1_inclusion_bound);
  const extent = countedExtent(TIMING, closesAt, bound);
  sS = Number(extent.segment);
  sD = Number(deliverySegments(TIMING, closesAt, bound).delivery);
  countedDeadline = availabilityWindows(
    closesAt,
    bound,
    extent.due,
    RELEASE_WINDOWS,
  ).countedDeadline;
}, 300_000);

afterAll(() => {
  l1?.process.kill();
});

const originWords = () => concatBytes(word(1n), word(GENESIS + INTERVAL), new Uint8Array(32));

interface Log {
  readonly address: Uint8Array;
  readonly topics: readonly string[];
  readonly data: Uint8Array;
  readonly block: bigint;
}

/** The election's creation and the registration of `d`, as the registry logs them. */
function registrationLogs(d: ElectionDefinitionV7 = definition): Log[] {
  const registry = definition.election_registry;
  const id = hex(definition.election_id);
  const encoding = encodeElectionDefinitionV7(d);
  return [
    {
      address: registry,
      topics: [hex(ELECTION_CREATED), id, hex(word(0xc4ea70n))],
      data: concatBytes(word(3n), originWords()),
      block: 10n,
    },
    {
      address: registry,
      topics: [hex(DEFINITION_REGISTERED), id, hex(electionDefinitionV7Hash(d))],
      data: concatBytes(originWords(), word(128n), word(BigInt(encoding.length)), padded(encoding)),
      block: 10n,
    },
  ];
}

/** An L2 node answering from `logs`, its finalized block timestamped just past `t_A'`. */
function l2Node(logs: readonly Log[] = registrationLogs()): Rpc {
  return {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${L2_CHAIN_ID.toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        const tag = params[0] as string;
        const n = tag === "finalized" ? L2_FINALIZED : BigInt(tag);
        const t = n === L2_FINALIZED ? countedDeadline + 1n : definition.opens_at + n * 60n;
        return { number: `0x${n.toString(16)}`, timestamp: `0x${t.toString(16)}` };
      }
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const filter = params[0] as {
        address: string;
        fromBlock: string;
        toBlock: string;
        topics: (string | string[] | null)[];
      };
      return logs
        .filter(
          (l) =>
            hex(l.address) === filter.address &&
            l.block >= BigInt(filter.fromBlock) &&
            l.block <= BigInt(filter.toBlock) &&
            filter.topics.every(
              (t, i) =>
                t === null ||
                (Array.isArray(t) ? t.includes(l.topics[i] ?? "") : t === l.topics[i]),
            ),
        )
        .map((l) => ({
          address: hex(l.address),
          topics: l.topics,
          data: hex(l.data),
          blockNumber: `0x${l.block.toString(16)}`,
        }));
    },
  };
}

/**
 * The counted extent: the transcript at segment 0, each ballot at segments
 * 3 to 5, then every seat's receipt of each at `s_D`.
 */
function board(casts: readonly Uint8Array[] = ballots.map((b) => b.bytes)): Uint8Array[] {
  const version = pinnedVersion(definition, RECORD_TYPES.boardEntry) as BoardEntryVersion;
  const payloads = [
    { segment: 0, payload: transcript },
    ...casts.map((payload, i) => ({ segment: 3 + i, payload })),
    ...receipts.flat().map((payload) => ({ segment: sD, payload })),
  ];
  return payloads.map(({ segment, payload }, index) =>
    encodeBoardEntry(
      { election_id: definition.election_id, index: BigInt(index), segment, payload },
      version,
    ),
  );
}

/** The chain read through a proven block just past the close. */
const PAST_CLOSE = (): RollingIntakeChain => ({
  chain: CHAIN,
  safeAt: closesAt + 1n,
  block: L2_FINALIZED,
});

function options(
  change: {
    entries?: readonly Uint8Array[];
    rolling?: CountedSourceOptions["rolling"] | null;
    logs?: readonly Log[];
  } = {},
): CountedSourceOptions {
  const entries = change.entries ?? board();
  const rolling =
    change.rolling === null ? {} : { rolling: change.rolling ?? (async () => PAST_CLOSE()) };
  return {
    panel: e.panelists.panel,
    l1: l1.rpc,
    l1ChainId: definition.l1_chain_id,
    l2: l2Node(change.logs),
    l2ChainId: L2_CHAIN_ID,
    registry: definition.election_registry,
    registryFromBlock: 0n,
    board: definition.board,
    boardFromBlock: 0n,
    extent: () => Promise.resolve({ entries, boardSegment: BigInt(sS) }),
    counted: TIMING,
    ...rolling,
  };
}

const read = (o: CountedSourceOptions) => countedSource(o)(approved[0] as ApprovedElection);

describe("a rolling poll's counted set from the attested counted extent", () => {
  test("is the verifier's set under the seat's own chain, every member's ballot at every step in the tier's cell", async () => {
    const chains: unknown[] = [];
    const got = await read(
      options({
        rolling: async (d) => {
          chains.push(d);
          return PAST_CLOSE();
        },
      }),
    );
    expect(got).toEqual({ state: "fixed", cells: [ballots.map((b) => b.bytes)], postings: [] });
    // Read for the registered definition, the one the seat approved.
    expect(chains).toEqual([{ version: 7, value: definition }]);
    const head = await finalizedBlock(l1.rpc);
    const run = await headerRun(l1.rpc, head, {
      before: definition.opens_at - 3_600n,
      after: closesAt,
    });
    const clock: AnchorClock = { ...TIMING, lastSegment: sS };
    expect(
      countedSet({
        definition: encodeElectionDefinitionV7(definition),
        panel: e.panelists.panel,
        entries: board(),
        clock,
        blocks: run.map(decodeHeader),
        eventsAuthenticated: true,
        rolling: { chain: CHAIN, through: { block: L2_FINALIZED, timestamp: closesAt + 1n } },
      }),
    ).toEqual({
      ok: true,
      definitionHash: election.definitionHash,
      cells: [ballots.map((b) => b.bytes)],
    });
  });

  test("waits while no chain can be had, or the chain isn't proven past the close and the tier's root block", async () => {
    // A chain read mid-poll gives LATE the opening tree only, so voter 2's
    // ballot would fail `membership-proof` and drop out of every seat's sum
    // (T-14, T-16): the set waits for a later read instead.
    for (const chain of [
      undefined,
      { chain: { ...CHAIN, events: [OPENING] }, safeAt: INTAKE_AT, block: 30n },
      { ...PAST_CLOSE(), safeAt: closesAt },
      { ...PAST_CLOSE(), block: ROOT_BLOCK - 1n },
    ])
      expect(await read(options({ rolling: async () => chain }))).toEqual({ state: "waiting" });
    // At the bounds it decides.
    const bounds = { chain: CHAIN, safeAt: closesAt + 1n, block: ROOT_BLOCK };
    expect((await read(options({ rolling: async () => bounds }))).state).toBe("fixed");
  });

  test("decides a member's rejection against the seat's own step roots", async () => {
    // Voter 2's ballot relabelled to EARLY, before they joined: its proof
    // was made against LATE's tree, so it fails there, and the rest count.
    const relabelled = encodeBallotV5({ ...ballots[2]!.record, step: EARLY });
    expect(
      await read(options({ entries: board([ballots[0]!.bytes, ballots[1]!.bytes, relabelled]) })),
    ).toEqual({ state: "fixed", cells: [[ballots[0]!.bytes, ballots[1]!.bytes]], postings: [] });
  });

  test("refuses a rolling poll's set without a rolling chain check", async () => {
    expect(await read(options({ rolling: null }))).toEqual({
      state: "refused",
      reason: "no rolling chain check",
    });
  });

  test("refuses a registered definition other than the approved one", async () => {
    const later = { ...definition, closes_at: closesAt + 1n };
    await expect(read(options({ logs: registrationLogs(later) }))).rejects.toMatchObject({
      name: "ViewError",
      code: "definition",
    });
  });
});

describe("the reads of a rolling poll's registered definition", () => {
  test("the tally's reads take it", async () => {
    expect(await tallyDefinition(options(), approved[0] as ApprovedElection)).toEqual({
      version: 7,
      value: definition,
    });
  });

  test("the view and the complaint duty's ballot source take it", async () => {
    const view = viewOptions();
    expect((await obligationView(view)(approved[0] as ApprovedElection)).board).toHaveLength(3);
    expect(await complaintBallots(view)(approved[0] as ApprovedElection)).toHaveLength(3);
  });
});

// The board's two rolling ballot events' topics, from contract-event-v11.json's tables.
const topicOf = (signature: string) =>
  `0x${
    (
      JSON.parse(
        readFileSync(
          new URL("../../../docs/spec/vectors/contract-event-v11.json", import.meta.url),
          "utf8",
        ),
      ) as { events: { signature: string; topic0: string }[] }
    ).events.find((ev) => ev.signature.startsWith(`${signature}(`))?.topic0
  }`;
const ROLLING_SUBMITTED = topicOf("RollingBallotSubmitted");
const RELAYED_ROLLING_SUBMITTED = topicOf("RelayedRollingBallotSubmitted");
// The step roots: EARLY's over the opening tree, LATE's with the joiner.
const EARLY_ROOT = () => treeOf([OPENING]).root();
const LATE_ROOT = () => treeOf([OPENING, JOINER]).root();
const RELAY_STAMP = 1_030_000n;

/** The board's `RollingBallotSubmitted` for `c` in L2 block `block`, under the root `root`. */
function rollingSubmitted(c: Cast, root: bigint, block = 40n): Log {
  return {
    address: definition.board,
    topics: [ROLLING_SUBMITTED, hex(election.definitionHash), hex(hashOf(c))],
    data: concatBytes(word(root), word(64n), word(BigInt(c.bytes.length)), padded(c.bytes)),
    block,
  };
}

/** The board's `RelayedRollingBallotSubmitted` for `c`, under the root `root`. */
function relayedRollingSubmitted(c: Cast, root: bigint, block = 41n): Log {
  return {
    address: definition.board,
    topics: [RELAYED_ROLLING_SUBMITTED, hex(election.definitionHash), hex(hashOf(c))],
    data: concatBytes(
      word(0n),
      word(L1_REF + 10n),
      word(RELAY_STAMP),
      word(1_000_000n),
      word(root),
      word(192n),
      word(BigInt(c.bytes.length)),
      padded(c.bytes),
    ),
    block,
  };
}

/** The view's options over seat 1's store, with the board-ballot extent `entries`. */
function viewOptions(
  change: {
    entries?: readonly Uint8Array[];
    rolling?: CountedSourceOptions["rolling"] | null;
    logs?: readonly Log[];
  } = {},
): ViewOptions {
  const { counted: _, extent: __, ...rest } = options(change);
  const entries = change.entries ?? board();
  return {
    ...rest,
    store: stores[0] as SeatStore,
    extent: () => Promise.resolve({ entries, boardSegment: BigInt(sS) }),
  };
}

const viewOf = (o: ViewOptions) => obligationView(o)(approved[0] as ApprovedElection);
const plainHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("a rolling poll's view at c_I", () => {
  test("holds every member's ballot at every step from the attested extent, judged against the seat's own step roots", async () => {
    const chains: unknown[] = [];
    const view = await viewOf(
      viewOptions({
        rolling: async (d) => {
          chains.push(d);
          return PAST_CLOSE();
        },
      }),
    );
    expect(view.board.map((b) => [plainHex(b.ballotHash), b.nullifier, b.entry])).toEqual(
      ballots.map((c, i) => [
        plainHex(hashOf(c)),
        c.record.nullifier,
        { path: "board", value: BigInt(3 + i) },
      ]),
    );
    expect(view.absent).toEqual([]);
    expect(chains).toEqual([{ version: 7, value: definition }]);
  });

  test("shows a receipted ballot absent from the extent, and one relabelled to a step before its voter joined (T-25, T-38)", async () => {
    const relabelled = encodeBallotV5({ ...ballots[2]!.record, step: EARLY });
    for (const casts of [
      [ballots[0]!.bytes, ballots[1]!.bytes],
      [ballots[0]!.bytes, ballots[1]!.bytes, relabelled],
    ]) {
      const view = await viewOf(viewOptions({ entries: board(casts) }));
      expect(view.board.map((b) => plainHex(b.ballotHash))).toEqual(
        [ballots[0]!, ballots[1]!].map((c) => plainHex(hashOf(c))),
      );
      expect(view.absent.map(plainHex)).toEqual([plainHex(hashOf(ballots[2]!))]);
    }
  });

  test("takes a contract copy from either rolling event under the root of its step", async () => {
    const without = board([ballots[0]!.bytes, ballots[1]!.bytes]);
    const direct = await viewOf(
      viewOptions({
        entries: without,
        logs: [...registrationLogs(), rollingSubmitted(ballots[2]!, LATE_ROOT())],
      }),
    );
    expect(direct.board.map((b) => [plainHex(b.ballotHash), b.entry])).toContainEqual([
      plainHex(hashOf(ballots[2]!)),
      { path: "ordinary", value: definition.opens_at + 40n * 60n },
    ]);
    expect(direct.absent).toEqual([]);
    const relayed = await viewOf(
      viewOptions({
        entries: without,
        logs: [...registrationLogs(), relayedRollingSubmitted(ballots[2]!, LATE_ROOT())],
      }),
    );
    expect(relayed.board.map((b) => [plainHex(b.ballotHash), b.entry])).toContainEqual([
      plainHex(hashOf(ballots[2]!)),
      { path: "relayed", value: RELAY_STAMP },
    ]);
  });

  test("never takes a contract copy under another root than its step's, which the verifier rejects (5.1; T-25, T-54)", async () => {
    const without = board([ballots[0]!.bytes, ballots[1]!.bytes]);
    for (const log of [
      rollingSubmitted(ballots[2]!, EARLY_ROOT()),
      relayedRollingSubmitted(ballots[2]!, EARLY_ROOT()),
    ]) {
      const view = await viewOf(
        viewOptions({ entries: without, logs: [...registrationLogs(), log] }),
      );
      expect(view.board.map((b) => plainHex(b.ballotHash))).toEqual(
        [ballots[0]!, ballots[1]!].map((c) => plainHex(hashOf(c))),
      );
      // A ballot log of the board's names it, so it isn't shown absent either.
      expect(view.absent).toEqual([]);
    }
  });

  test("is retried while no chain can be had, or the chain isn't proven past the close and the tier's root block", async () => {
    for (const chain of [
      undefined,
      { chain: { ...CHAIN, events: [OPENING] }, safeAt: INTAKE_AT, block: 30n },
      { ...PAST_CLOSE(), safeAt: closesAt },
      { ...PAST_CLOSE(), block: ROOT_BLOCK - 1n },
    ])
      await expect(viewOf(viewOptions({ rolling: async () => chain }))).rejects.toMatchObject({
        name: "RpcError",
      });
    const bounds = { chain: CHAIN, safeAt: closesAt + 1n, block: ROOT_BLOCK };
    expect((await viewOf(viewOptions({ rolling: async () => bounds }))).board).toHaveLength(3);
  });

  test("is refused without a rolling chain check, and for a definition other than the approved one", async () => {
    await expect(viewOf(viewOptions({ rolling: null }))).rejects.toMatchObject({
      name: "ViewError",
      code: "rolling",
    });
    const later = { ...definition, closes_at: closesAt + 1n };
    await expect(viewOf(viewOptions({ logs: registrationLogs(later) }))).rejects.toMatchObject({
      name: "ViewError",
      code: "definition",
    });
  });
});

describe("a rolling poll's ballot source for the complaint duty", () => {
  const source = (o: ViewOptions) => complaintBallots(o)(approved[0] as ApprovedElection);

  test("gives the extent's ballots and the board contract's rolling copies, under any root, with no chain read", async () => {
    const got = await source(
      viewOptions({
        entries: board([ballots[0]!.bytes]),
        // The source admits nothing: the duty matches each record by the
        // ballot hash it recomputes (T-38).
        rolling: null,
        logs: [
          ...registrationLogs(),
          rollingSubmitted(ballots[1]!, EARLY_ROOT()),
          relayedRollingSubmitted(ballots[2]!, EARLY_ROOT()),
        ],
      }),
    );
    expect(got.map(plainHex)).toEqual(ballots.map((c) => plainHex(c.bytes)));
  });

  test("is refused for a definition other than the approved one", async () => {
    const later = { ...definition, closes_at: closesAt + 1n };
    await expect(source(viewOptions({ logs: registrationLogs(later) }))).rejects.toMatchObject({
      name: "ViewError",
      code: "definition",
    });
  });
});

class Wire implements SummedSharePeers {
  duties: TallyDuty[] = [];
  deliver = true;
  readonly sent: Uint8Array[] = [];
  async send(recipient: number, message: Uint8Array): Promise<void> {
    this.sent.push(message);
    if (this.deliver) await (this.duties[recipient - 1] as TallyDuty).receive(message);
  }
}

const tagged = (): TallyDefinition => ({ version: 7, value: definition });
const fixed = (cells: readonly (readonly Uint8Array[])[]): CountedSet => ({
  state: "fixed",
  cells,
});

function duties(
  wire: Wire,
  counted: (election: ApprovedElection) => Promise<CountedSet>,
  definitionOf: TallyDefinition = tagged(),
  hidden?: { readonly seat: number; readonly ballot: Cast },
): TallyDuty[] {
  wire.duties = approved.map(
    (a, i) =>
      new TallyDuty({
        panel: e.panelists.panel,
        l2ChainId: L2_CHAIN_ID,
        trusteeRegistry: TRUSTEE_REGISTRY,
        election: a,
        secrets: intakeSecrets[i] as IntakeSecrets,
        definition: definitionOf,
        transcript,
        // Each duty's tally records are its own, over the seat's intake.
        store: overlay(stores[i] as SeatStore, hidden?.seat === i + 1 ? hidden.ballot : undefined),
        summing: AVAILABLE,
        counted,
        board: async () => ({ state: "unread" }),
        peers: wire,
      }),
  );
  return wire.duties;
}

/** `store` with the tally's records kept apart, and without its intake record of `hidden`, if given. */
function overlay(store: SeatStore, hidden?: Cast): SeatStore {
  const own = new Map<string, Uint8Array>();
  const gone =
    hidden === undefined
      ? undefined
      : `intake/${hex(e.stubHash).slice(2)}/${hex(hashOf(hidden)).slice(2)}`;
  return {
    remove: () => Promise.reject(new Error("the tally duty removes nothing")),
    get: async (key) =>
      key === gone
        ? undefined
        : (own.get(key) ?? (key.startsWith("tally/") ? undefined : store.get(key))),
    putOnce: async (key, v) => {
      const held = own.get(key);
      if (held !== undefined) return { created: false, value: held };
      own.set(key, v);
      return { created: true, value: v };
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
}

/** Each seat fixes its counted set with nothing delivered, so no message is dropped later. */
async function prime(wire: Wire): Promise<void> {
  wire.deliver = false;
  for (const duty of wire.duties) await duty.step();
  wire.sent.length = 0;
  wire.deliver = true;
}

const vssOf = (bytes: Uint8Array) => decodeBallot(bytes, 5).committed_vote.vss;
const hashOf = (c: Cast) =>
  ballotHashV5(
    {
      definitionHash: election.definitionHash,
      cell: 0,
      nullifier: c.record.nullifier,
      step: c.record.step,
    },
    c.record.committed_vote,
  );

/** `c`'s posting for `seat`: version 2 naming `panel` (the default panel's by default), or version 1. */
function posting(c: Cast, seat: number, as: { version?: 1 | 2; panel?: 1 | 2 } = {}) {
  const fields = {
    definition_hash: election.definitionHash,
    ballot_hash: hashOf(c),
    seat,
    m: c.ms[seat - 1] as Uint8Array,
    ciphertext: decode(SHARE_CIPHERTEXT, c.ciphertexts[seat - 1] as Uint8Array),
  };
  return as.version === 1
    ? encodeSharePosting(fields)
    : encodeSharePostingV2({ ...fields, panel: as.panel ?? SEAT_PANELS.default });
}

/** Every duty's first step with seat 1 holding no intake record of voter 2's ballot. */
async function stepWithout(postings: readonly Uint8Array[]) {
  const wire = new Wire();
  const counted = { ...fixed([ballots.map((b) => b.bytes)]), postings };
  const d = duties(wire, async () => counted, tagged(), { seat: 1, ballot: ballots[2]! });
  return d[0]!.step();
}

describe("the tally duty over a rolling poll", () => {
  test("opens the rolling tier's cell over the counted source's set to the votes cast", async () => {
    const wire = new Wire();
    const d = duties(wire, countedSource(options()));
    await prime(wire);
    for (const duty of d) await duty.step();
    const rules = tallyRules({ version: 7, value: definition });
    const vss = ballots.map((b) => vssOf(b.bytes));
    for (const [i, duty] of d.slice(1).entries()) {
      const opening = (await duty.openings()).get(0);
      if (opening === undefined) return expect.fail(`seat ${i + 2} signed no opening`);
      const o = decodeTallyOpening(opening, 1);
      expect(o.definition_hash).toEqual(election.definitionHash);
      expect(o.cell).toBe(0);
      expect(o.aggregate_hash).toEqual(aggregateHash(aggregateCell(rules, vss)));
      const key = (registered.find((k) => k.index === i + 2) as RegisteredKeys).signingKey;
      expect(
        verifyStatement(key, "abolish/v1/sig/tally-opening", tallyOpeningStatement(o), o.signature),
      ).toBe(true);
      const checked = checkOpening(rules, vss, o.opening);
      if (!checked.ok) return expect.fail(`the opening fails ${checked.code}`);
      expect(checked.counts).toEqual(COUNTS);
    }
  });

  test("opens a counted ballot's shares from its version-2 posting where intake holds none", async () => {
    // Seat 1 never took voter 2's ballot in: without a posting it has no sums.
    expect(await stepWithout([])).toMatchObject({
      cells: [{ state: "missing-shares", missing: 1 }],
    });
    // Its default-panel posting for seat 1 gives them, and its sums pass.
    expect(await stepWithout([posting(ballots[2]!, 1)])).toMatchObject({
      cells: [{ state: "combining", sent: 2 }],
    });
  });

  test("reads no posting of version 1, of the author panel or of another seat (T-34, T-38)", async () => {
    for (const p of [
      posting(ballots[2]!, 1, { version: 1 }),
      posting(ballots[2]!, 1, { panel: SEAT_PANELS.author }),
      posting(ballots[2]!, 2),
    ])
      expect(await stepWithout([p])).toMatchObject({
        cells: [{ state: "missing-shares", missing: 1 }],
      });
  });

  const refused = async (counted: CountedSet, definitionOf?: TallyDefinition) => {
    const wire = new Wire();
    const status = await duties(wire, async () => counted, definitionOf)[0]!.step();
    expect(wire.sent).toEqual([]);
    return status;
  };
  const relabel = (b: Cast, change: Partial<BallotRecordV5>) =>
    encodeBallotV5({ ...b.record, ...change });
  const refusal = (reason: string) => ({ state: "refused", reason });
  const all = () => ballots.map((b) => b.bytes);

  test("a ballot relabelled to another step finds no shares (T-38)", async () => {
    // The step is bound by the ballot hash, so no seat holds shares under it.
    const wire = new Wire();
    const cells = [[...all().slice(0, 2), relabel(ballots[2]!, { step: EARLY })]];
    expect(await duties(wire, async () => fixed(cells))[0]!.step()).toEqual({
      state: "tallying",
      cells: [{ state: "missing-shares", missing: 1, held: 0 }],
      board: "unread",
    });
  });

  test("a voter counted twice, at two steps", async () => {
    // The nullifier doesn't depend on the step: one voter's two ballots are one voter.
    const again = relabel(ballots[0]!, { step: LATE });
    expect(await refused(fixed([[...all(), again]]))).toEqual(refusal("a voter counted twice"));
  });

  test("another number of cells, a ballot of another cell or election, or of another version", async () => {
    expect(await refused(fixed([all(), []]))).toEqual(
      refusal("another number of cells than the partition's"),
    );
    for (const change of [{ cell: 1 }, { definition_hash: new Uint8Array(32).fill(9) }])
      expect(await refused(fixed([[relabel(ballots[0]!, change)]]))).toEqual(
        refusal("a counted ballot of another election or cell"),
      );
    // The same bytes under version 3's version byte: never read as version 5 (T-34).
    const v3 = Uint8Array.from(ballots[0]!.bytes);
    v3[2] = 3;
    expect(await refused(fixed([[v3]]))).toEqual(refusal("a counted ballot doesn't decode"));
  });

  test("a ballot carrying an author half no panel can open", async () => {
    const vote = ballots[0]!.record.committed_vote;
    const authored = relabel(ballots[0]!, {
      committed_vote: { ...vote, author_vss: vote.vss, author_share_hashes: vote.share_hashes },
    });
    expect(await refused(fixed([[authored]]))).toEqual(
      refusal("a counted ballot of another shape"),
    );
  });

  test("a definition other than the approved one, or tagged with another version", async () => {
    const later = { ...definition, closes_at: closesAt + 1n };
    expect(await refused(fixed([all()]), { version: 7, value: later })).toEqual(
      refusal("the definition isn't the one the seat approved"),
    );
    expect(await refused(fixed([all()]), { version: 5, value: definition as never })).toEqual(
      refusal("the definition isn't the one the seat approved"),
    );
  });
});
