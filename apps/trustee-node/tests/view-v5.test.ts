// The deployment's view at `c_I` under definition version 5, the stubs the
// website creates (P2-13 part 4c-2a): a version-5 ceremony between seats,
// version-3 ballots made as the ballot client makes them (packages/crypto's
// seal with a real Groth16 membership proof), each naming a real Anvil
// block, and the registration and board logs from an L2 node scripted here.
// The view must read the registered version-5 definition under its own
// hash, admit the board's version-3 ballots as the verifier does, show
// absent the receipted one that never reached the board and so make the
// decision owe the older ballot the delivery check selects; the complaint
// duty's source must give the version-3 records (T-25, T-34, T-38, T-52,
// T-54).
import { readFileSync } from "node:fs";
import {
  castSealV3,
  checkCeremonyTranscript,
  decodeBallot,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  encodeBoardEntry,
  encodeElectionDefinitionV5,
  finishSealV3,
  frameBallot,
  identityCommitment,
  intakeCutoff,
  type L1Origin,
  newIdentitySecret,
  pinnedVersion,
  questionBallotElection,
  type QuestionBallotElection,
  RECORD_TYPES,
  sealBallotV3,
  tierTreeRoot,
} from "@abolishus/crypto";
import { type MembershipProverArtifacts, proveMembership } from "@abolishus/membership-prover";
import { DEFINITION_REGISTERED, ELECTION_CREATED, type Rpc } from "@abolishus/node";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { HeldExtent } from "../src/availability.ts";
import type { ApprovedElection } from "../src/ceremony.ts";
import { IntakeSeat, type SeatStore } from "../src/index.ts";
import { decideObligation } from "../src/obligation.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import { complaintBallots, obligationView, type ViewOptions } from "../src/view.ts";
import { anvil, type Node } from "./anvil.ts";
import {
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
// The board's `BallotSubmitted` topic, from contract-event-v8.json's tables.
const BALLOT_SUBMITTED = `0x${
  (
    JSON.parse(
      readFileSync(
        new URL("../../../docs/spec/vectors/contract-event-v8.json", import.meta.url),
        "utf8",
      ),
    ) as { events: { signature: string; topic0: string }[] }
  ).events.find((e) => e.signature.startsWith("BallotSubmitted("))?.topic0
}`;

const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}`;
const plain = (b: Uint8Array) => Buffer.from(b).toString("hex");
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

// As view.test.ts: the stub opens at 1,000,000 and closes a day later, and
// Anvil mines a block every 600 seconds from two hours before opening to
// past the close, its finalized block the latest but two.
const GENESIS = 1_000_000n - 7_200n;
const INTERVAL = 600n;
const L2_FINALIZED = 100n;
const S_A = 25n;

const secrets = Array.from({ length: 3 }, () => newIdentitySecret());
const leaves = secrets.map((s) => identityCommitment(s));

interface Cast {
  readonly bytes: Uint8Array;
  /** Each seat's `ct_i`, by seat. */
  readonly ciphertexts: readonly Uint8Array[];
}

interface Log {
  readonly address: Uint8Array;
  readonly topics: readonly string[];
  readonly data: Uint8Array;
  readonly block: bigint;
}

let e: ElectionV5;
let stores: SeatStore[];
let transcript: Uint8Array;
let definition: ElectionDefinitionV5;
let election: QuestionBallotElection;
let cutoff: bigint;
let l1: Node;
/** Voter 0's older and newer ballots, each naming a real block. */
let older: Cast;
let newer: Cast;

/** One version-3 ballot of voter `v`, cast under L1 block `ref` as the ballot client casts it. */
async function cast(v: number, votes: readonly (0 | 1)[], ref: bigint): Promise<Cast> {
  const b = (await l1.rpc.call("eth_getBlockByNumber", [`0x${ref.toString(16)}`, false])) as {
    hash: string;
  };
  const sealed = sealBallotV3(election, 0, votes);
  const casting = castSealV3(sealed, secrets[v] as Uint8Array, leaves, {
    number: ref,
    hash: hexToBytes(b.hash.slice(2)),
  });
  const c = finishSealV3(casting, await proveMembership(casting.witness, artifacts));
  const ciphertexts: Uint8Array[] = [];
  for (const x of c.ciphertexts) ciphertexts[x.seat - 1] = x.ciphertext;
  return { bytes: c.ballot, ciphertexts };
}

beforeAll(async () => {
  stores = [new MemoryStore(), new MemoryStore(), new MemoryStore()];
  const base = electionV5(3, 2).stub.electorate[0];
  if (base === undefined) throw new Error("no tier");
  e = electionV5(3, 2, {
    stores,
    stub: { electorate: [{ ...base, cells: [{ root: tierTreeRoot(leaves), members: 3n }] }] },
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
  election = questionBallotElection(definition, check.registered);
  cutoff = intakeCutoff(e.stub.closes_at, BigInt(e.stub.l1_inclusion_bound), RELEASE_WINDOWS);
  l1 = await anvil(e.stub.l1_chain_id, true, [
    "--timestamp",
    GENESIS.toString(),
    "--slots-in-an-epoch",
    "1",
  ]);
  await l1.rpc.call("anvil_mine", ["0xc8", `0x${INTERVAL.toString(16)}`]);
  // Blocks 20 and 40: after opening, before the close.
  older = await cast(0, [1, 0, 1, 0, 1], 20n);
  newer = await cast(0, [0, 1, 0, 1, 0], 40n);
}, 300_000);

afterAll(() => {
  l1?.process.kill();
});

/** The ballot hash the board's framing computes, which a ballot log's topic carries. */
const ballotHashOf = (c: Cast) => {
  const framed = frameBallot(c.bytes);
  if (framed === undefined) throw new Error("an honest ballot the board can't frame");
  return framed.ballotHash;
};

/** A store holding seat 1's receipts for `casts`, and the election it approved. */
async function receipted(...casts: Cast[]): Promise<{
  store: MemoryStore;
  approved: ApprovedElection;
}> {
  const store = new MemoryStore();
  const seat = new IntakeSeat({
    panel: e.panelists.panel,
    l2ChainId: L2_CHAIN_ID,
    trusteeRegistry: TRUSTEE_REGISTRY,
    index: 1,
    ceremony: e.seats[0]!,
    electorate: () => Promise.resolve(true),
    registration: () => Promise.resolve(true),
    store,
    now: () => e.stub.opens_at,
  });
  for (const c of casts) {
    const out = await seat.intake(e.stubBytes, transcript, c.bytes, c.ciphertexts[0]!);
    if (!out.ok) expect.fail(out.code);
  }
  const approved = await e.seats[0]!.approvedElection(e.stubHash);
  if (approved === undefined) expect.fail("the seat approved the stub");
  return { store, approved };
}

const ORIGIN: L1Origin = { number: 1n, timestamp: GENESIS + INTERVAL, hash: new Uint8Array(32) };
const originWords = (o: L1Origin) => concatBytes(word(o.number), word(o.timestamp), o.hash);

/** The election's creation and the registration of `encoding` under `hash`, as the registry logs them. */
function registrationLogs(
  encoding = encodeElectionDefinitionV5(definition),
  hash = electionDefinitionV5Hash(definition),
): Log[] {
  const registry = definition.election_registry;
  const id = hex(definition.election_id);
  return [
    {
      address: registry,
      topics: [hex(ELECTION_CREATED), id, hex(word(0xc4ea70n))],
      data: concatBytes(word(3n), originWords(ORIGIN)),
      block: 10n,
    },
    {
      address: registry,
      topics: [hex(DEFINITION_REGISTERED), id, hex(hash)],
      data: concatBytes(
        originWords(ORIGIN),
        word(128n),
        word(BigInt(encoding.length)),
        padded(encoding),
      ),
      block: 10n,
    },
  ];
}

/** The board's `BallotSubmitted` for `c` in L2 block `block`. */
function submitted(c: Cast, block: bigint): Log {
  return {
    address: definition.board,
    topics: [BALLOT_SUBMITTED, hex(election.definitionHash), hex(ballotHashOf(c))],
    data: concatBytes(word(32n), word(BigInt(c.bytes.length)), padded(c.bytes)),
    block,
  };
}

/** An L2 node answering from `logs` as a real one filters them, finalized past the contract-event window. */
function l2Node(logs: readonly Log[]): Rpc {
  const finalizedAt = e.stub.closes_at + RELEASE_WINDOWS.contractEventWindow + 1n;
  return {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${L2_CHAIN_ID.toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        const tag = params[0] as string;
        const n = tag === "finalized" ? L2_FINALIZED : BigInt(tag);
        const t = n === L2_FINALIZED ? finalizedAt : GENESIS + n;
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

/** The ballot extent through `C_A`: the transcript first, then `ballots` at segments 3, 4, …, under the pinned board-entry version. */
function extentOf(ballots: readonly Cast[]): HeldExtent {
  const version = pinnedVersion(definition, RECORD_TYPES.boardEntry) as 1;
  const payloads = [transcript, ...ballots.map((c) => c.bytes)];
  return {
    entries: payloads.map((payload, index) =>
      encodeBoardEntry(
        {
          election_id: definition.election_id,
          index: BigInt(index),
          segment: index === 0 ? 0 : index + 2,
          payload,
        },
        version,
      ),
    ),
    boardSegment: S_A,
  };
}

function viewOptions(
  store: MemoryStore,
  change: { logs?: readonly Log[]; held?: HeldExtent } = {},
): ViewOptions {
  const { logs = registrationLogs(), held } = change;
  return {
    store,
    panel: e.panelists.panel,
    l1: l1.rpc,
    l1ChainId: e.stub.l1_chain_id,
    l2: l2Node(logs),
    l2ChainId: L2_CHAIN_ID,
    registry: definition.election_registry,
    registryFromBlock: 0n,
    board: definition.board,
    boardFromBlock: 0n,
    extent: () => Promise.resolve(held),
  };
}

describe("the view under definition version 5", () => {
  test("is over version-3 ballots", () => {
    expect(pinnedVersion(definition, RECORD_TYPES.ballot)).toBe(3);
    expect(decodeBallot(older.bytes, 3).definition_hash).toEqual(election.definitionHash);
  });

  test("holds each admitted version-3 board ballot with its segment and cell's tier", async () => {
    const { store, approved } = await receipted(older);
    const view = await obligationView(viewOptions(store, { held: extentOf([older]) }))(approved);
    expect(view.board.map((b) => [plain(b.ballotHash), b.tier, b.entry])).toEqual([
      [plain(ballotHashOf(older)), 0, { path: "board", value: 3n }],
    ]);
    expect(view.absent).toEqual([]);
  });

  test("shows absent a receipted ballot that never reached the board, and owes the older one the delivery check selects", async () => {
    const { store, approved } = await receipted(older, newer);
    const options = viewOptions(store, { held: extentOf([older]) });
    const view = await obligationView(options)(approved);
    expect(view.absent.map(plain)).toEqual([plain(ballotHashOf(newer))]);
    const status = await decideObligation(
      { store, view: obligationView(options), now: () => cutoff },
      approved,
    );
    if (status.state !== "decided") expect.fail(status.state);
    expect([status.receipts.map(plain), status.complaints.map(plain)]).toEqual([
      [plain(ballotHashOf(older))],
      [plain(ballotHashOf(older))],
    ]);
  });

  test("holds the board contract's version-3 ballots, so a newer one recorded there is owed", async () => {
    const { store, approved } = await receipted(older, newer);
    const options = viewOptions(store, {
      held: extentOf([older]),
      logs: [...registrationLogs(), submitted(newer, 50n)],
    });
    const view = await obligationView(options)(approved);
    expect(view.absent).toEqual([]);
    expect(view.board.map((b) => [plain(b.ballotHash), b.entry])).toEqual([
      [plain(ballotHashOf(older)), { path: "board", value: 3n }],
      [plain(ballotHashOf(newer)), { path: "ordinary", value: GENESIS + 50n }],
    ]);
  });

  test("gives the complaint duty the extent's and the contract's version-3 records", async () => {
    const { store, approved } = await receipted(older);
    const options = viewOptions(store, {
      held: extentOf([older]),
      logs: [...registrationLogs(), submitted(newer, 50n)],
    });
    expect((await complaintBallots(options)(approved)).map(plain)).toEqual(
      [older.bytes, newer.bytes].map(plain),
    );
  });

  test("refuses a registered version-5 definition that isn't the approved one (T-34)", async () => {
    const { store, approved } = await receipted(older);
    const changed = { ...definition, closes_at: definition.closes_at + 1n };
    const logs = registrationLogs(
      encodeElectionDefinitionV5(changed),
      electionDefinitionV5Hash(changed),
    );
    for (const read of [obligationView, complaintBallots])
      await expect(read(viewOptions(store, { logs }))(approved)).rejects.toMatchObject({
        name: "ViewError",
        code: "definition",
      });
  });
});
