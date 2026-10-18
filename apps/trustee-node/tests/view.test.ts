// The deployment's view at `c_I` (docs/spec/delivery.md, What a node owes):
// finalized L1 from an Anvil node whose blocks cover the poll's window, the
// registration and the board contract's ballot logs from an L2 node
// scripted here, and the ballot extent the seat attested, with ballots
// carrying real membership proofs. The view must hold exactly the copies the
// verifier's admission passes, each with the entry the close rule judges,
// show absent exactly the receipted ballots no copy or ballot log carries,
// and so make the decision owe the receipt the delivery check needs: the
// older receipted ballot when the newer one never reached the board, the
// newer one when it did (T-25, T-52, T-54).
import { readFile } from "node:fs/promises";
import {
  ceremonyTranscriptHash,
  type ContractEventVersion,
  decode,
  decodeSharePosting,
  decodeShareReceiptBatch,
  deliveryDeadlines,
  electionDefinitionHash,
  encodeBoardEntry,
  encodeContractEvent,
  encodeElectionDefinition,
  encodeSharePosting,
  frameBallot,
  type L1Origin,
  L1_REF_MARGIN,
  pinnedVersion,
  RECORD_TYPES,
  SHARE_CIPHERTEXT,
} from "@abolishus/crypto";
import { DEFINITION_REGISTERED, ELECTION_CREATED, type Rpc, RpcError } from "@abolishus/node";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import type { HeldExtent } from "../src/availability.ts";
import type { ApprovedElection } from "../src/ceremony.ts";
import { ComplaintDuty } from "../src/complaint.ts";
import { ReceiptDuty } from "../src/delivery.ts";
import { type ReceiptEvent, ReceiptDuties } from "../src/duties.ts";
import { decideObligation } from "../src/obligation.ts";
import { RELEASE_WINDOWS } from "../src/stub.ts";
import { MemoryStore } from "../src/store.ts";
import { complaintBallots, obligationView, ViewError, type ViewOptions } from "../src/view.ts";
import { anvil, type Node } from "./anvil.ts";
import { type Cast, cast, castAgain, seatsOf, setup, type Setup } from "./ballots.ts";
import { L2_CHAIN_ID } from "./fixture.ts";

const vector = async (file: string) =>
  JSON.parse(
    await readFile(new URL(`../../../docs/spec/vectors/${file}`, import.meta.url), "utf8"),
  );
// The board's topics from contract-event-v8.json's tables, not the view's constants.
const events = (await vector("contract-event-v8.json")) as {
  events: { signature: string; topic0: string }[];
};
const topic0 = (signature: string) => {
  const t = events.events.find((e) => e.signature.startsWith(`${signature}(`))?.topic0;
  if (t === undefined) throw new Error(`no ${signature} in the vectors`);
  return `0x${t}`;
};
const BALLOT_SUBMITTED = topic0("BallotSubmitted");
const RELAYED_BALLOT_SUBMITTED = topic0("RelayedBallotSubmitted");

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

// The local stub opens at 1,000,000 and closes a day later. Anvil starts
// two hours before opening and mines a block every 600 seconds to past the
// close; with one slot per epoch its finalized block is the latest but two.
const GENESIS = 1_000_000n - 7_200n;
const INTERVAL = 600n;
const L2_FINALIZED = 100n;

interface Log {
  readonly address: Uint8Array;
  readonly topics: readonly string[];
  readonly data: Uint8Array;
  readonly block: bigint;
}

let s: Setup;
let l1: Node;
/** Voter 0's older and newer ballots and voter 1's, each naming a real block. */
let older: Cast;
let newer: Cast;
let other: Cast;
let refs: { older: bigint; newer: bigint };

/** The ballot hash the board's framing computes, which a ballot log's topic carries. */
const ballotHashOf = (c: Cast) => {
  const framed = frameBallot(c.bytes);
  if (framed === undefined) throw new Error("an honest ballot the board can't frame");
  return framed.ballotHash;
};

beforeAll(async () => {
  s = await setup();
  l1 = await anvil(s.e.stub.l1_chain_id, true, [
    "--timestamp",
    GENESIS.toString(),
    "--slots-in-an-epoch",
    "1",
  ]);
  await l1.rpc.call("anvil_mine", ["0xc8", `0x${INTERVAL.toString(16)}`]);
  const refOf = async (n: bigint) => {
    const b = (await l1.rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])) as {
      hash: string;
    };
    return { number: n, hash: hexToBytes(b.hash.slice(2)) };
  };
  // Blocks 20 and 40: after opening, before the close.
  refs = { older: 20n, newer: 40n };
  const [a, b, c] = await Promise.all([cast(s, 0, 1), cast(s, 0, 0), cast(s, 1, 1)]);
  older = await castAgain(s, 0, a, await refOf(refs.older));
  newer = await castAgain(s, 0, b, await refOf(refs.newer));
  other = await castAgain(s, 1, c, await refOf(refs.older));
}, 300_000);

afterAll(() => {
  l1?.process.kill();
});

/** A store holding seat 1's receipts for `casts`, and the election it approved. */
async function receipted(...casts: Cast[]): Promise<{
  store: MemoryStore;
  approved: ApprovedElection;
}> {
  const store = new MemoryStore();
  const seats = seatsOf(s, { store });
  for (const c of casts) {
    const out = await seats.intake[0]!.intake(
      s.e.stubBytes,
      s.transcript,
      c.bytes,
      c.ciphertexts[0] as Uint8Array,
    );
    if (!out.ok) expect.fail(out.code);
  }
  const approved = await s.e.seats[0]!.approvedElection(s.e.stubHash);
  if (approved === undefined) expect.fail("the seat approved the stub");
  return { store, approved };
}

const ORIGIN: L1Origin = { number: 1n, timestamp: GENESIS + INTERVAL, hash: new Uint8Array(32) };
const originWords = (o: L1Origin) => concatBytes(word(o.number), word(o.timestamp), o.hash);

/** The election's creation and the registration of `definition`, as the registry logs them. */
function registrationLogs(definition = s.definition): Log[] {
  const registry = s.definition.election_registry;
  const id = hex(s.definition.election_id);
  const encoding = encodeElectionDefinition(definition);
  return [
    {
      address: registry,
      topics: [hex(ELECTION_CREATED), id, hex(word(0xc4ea70n))],
      data: concatBytes(word(3n), originWords(ORIGIN)),
      block: 10n,
    },
    {
      address: registry,
      topics: [hex(DEFINITION_REGISTERED), id, hex(electionDefinitionHash(definition))],
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

/** The board's `BallotSubmitted` for `c` in L2 block `block`, under the topic `named` (its own hash by default). */
function submitted(c: Cast, block: bigint, named = ballotHashOf(c)): Log {
  return {
    address: s.definition.board,
    topics: [BALLOT_SUBMITTED, hex(s.election.definitionHash), hex(named)],
    data: concatBytes(word(32n), word(BigInt(c.bytes.length)), padded(c.bytes)),
    block,
  };
}

/** The board's `RelayedBallotSubmitted` for `c`, stamped `stamp` by its relay call. */
function relayed(c: Cast, stamp: bigint): Log {
  return {
    address: s.definition.board,
    topics: [RELAYED_BALLOT_SUBMITTED, hex(s.election.definitionHash), hex(ballotHashOf(c))],
    data: concatBytes(
      word(0n),
      word(5n),
      word(stamp),
      word(500_000n),
      word(160n),
      word(BigInt(c.bytes.length)),
      padded(c.bytes),
    ),
    block: 60n,
  };
}

/** Just past the contract-event window's end, by when every in-window ballot the contract records is in a block. */
const pastWindow = () => s.e.stub.closes_at + RELEASE_WINDOWS.contractEventWindow + 1n;

/**
 * An L2 node answering from `logs` as a real one filters them, up to its
 * finalized block, timestamped `finalizedAt`; any earlier block `n` is
 * timestamped `times(n)`.
 */
function l2Node(
  logs: readonly Log[],
  chain = L2_CHAIN_ID,
  times = (n: bigint) => GENESIS + n,
  finalizedAt = pastWindow(),
): Rpc {
  return {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${chain.toString(16)}`;
      if (method === "eth_getBlockByNumber") {
        const tag = params[0] as string;
        const n = tag === "finalized" ? L2_FINALIZED : BigInt(tag);
        const t = n === L2_FINALIZED ? finalizedAt : times(n);
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

const S_A = 25n;

/** A board log as the anchored board archives it: a contract-event record (`0x0008`) under the pinned version. */
function archived(log: Log): Uint8Array {
  const version = pinnedVersion(s.definition, RECORD_TYPES.contractEvent) as ContractEventVersion;
  return encodeContractEvent(
    {
      contract: log.address,
      n: 1n,
      l2_block: log.block,
      l2_timestamp: s.e.stub.opens_at + 60n,
      topics: log.topics.map((t) => hexToBytes(t.slice(2))),
      data: log.data,
    },
    version,
  );
}

/** The ballot extent through `C_A`: the transcript first, then `ballots` at segments 3, 4, …, then `extra` payloads. */
function extentOf(ballots: readonly Cast[], extra: readonly Uint8Array[] = []): HeldExtent {
  const version = pinnedVersion(s.definition, RECORD_TYPES.boardEntry) as 1;
  const payloads = [s.transcript, ...ballots.map((c) => c.bytes), ...extra];
  return {
    entries: payloads.map((payload, index) =>
      encodeBoardEntry(
        {
          election_id: s.definition.election_id,
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
  change: { logs?: readonly Log[]; held?: HeldExtent; l2?: Rpc } & Partial<
    Omit<ViewOptions, "extent">
  > = {},
): ViewOptions {
  const { logs = registrationLogs(), held, l2 = l2Node(logs), ...rest } = change;
  return {
    store,
    panel: s.e.panelists.panel,
    l1: l1.rpc,
    l1ChainId: s.e.stub.l1_chain_id,
    l2,
    l2ChainId: L2_CHAIN_ID,
    registry: s.definition.election_registry,
    registryFromBlock: 0n,
    board: s.definition.board,
    boardFromBlock: 0n,
    extent: () => Promise.resolve(held),
    ...rest,
  };
}

const owed = async (options: ViewOptions, approved: ApprovedElection) => {
  const status = await decideObligation(
    { store: options.store, view: obligationView(options), now: () => s.cutoff },
    approved,
  );
  if (status.state !== "decided") expect.fail(status.state);
  return { receipts: status.receipts.map(plain), complaints: status.complaints.map(plain) };
};

describe("the view's finalized L1", () => {
  test("covers the poll's window from the seat's L1 node, block by block as the node holds it", async () => {
    const { store, approved } = await receipted(older);
    const view = await obligationView(viewOptions(store))(approved);
    const at = async (n: bigint) =>
      (await l1.rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])) as {
        hash: string;
        timestamp: string;
      };
    // From before `opens_at − L1_REF_MARGIN`, which `l1_ref_min` is searched from…
    expect(view.l1.block(view.low).timestamp).toBeLessThan(s.e.stub.opens_at - L1_REF_MARGIN);
    // …to the first block after the close, so every reference is decided.
    expect(view.l1.block(view.l1.head).timestamp).toBeGreaterThan(s.e.stub.closes_at);
    expect(view.l1.block(view.l1.head - 1n).timestamp).toBeLessThanOrEqual(s.e.stub.closes_at);
    for (const n of [view.low, refs.older, refs.newer, view.l1.head]) {
      const b = await at(n);
      expect(hex(view.l1.block(n).hash)).toBe(b.hash);
      expect(view.l1.block(n).timestamp).toBe(BigInt(b.timestamp));
    }
  });

  test("refuses a run its budget cut, rather than search `l1_ref_min` from inside the window", async () => {
    const { store, approved } = await receipted(older);
    await expect(
      obligationView(viewOptions(store, { maxRunBytes: 4096 }))(approved),
    ).rejects.toMatchObject({ name: "ViewError", code: "l1-run-short" });
  });
});

describe("a seat that didn't attest the ballot extent", () => {
  test("decides over its own intake alone, and owes its newest receipted ballot", async () => {
    const { store, approved } = await receipted(older, newer);
    // A ballot log of the board changes nothing without the transcript the
    // extent carries: the seat admits no copy it can't check.
    const options = viewOptions(store, { logs: [...registrationLogs(), submitted(other, 50n)] });
    const view = await obligationView(options)(approved);
    expect(view.board).toEqual([]);
    expect(view.absent).toEqual([]);
    expect(await owed(options, approved)).toEqual({
      receipts: [plain(ballotHashOf(newer))],
      complaints: [plain(ballotHashOf(newer))],
    });
  });
});

describe("a seat that attested the ballot extent", () => {
  test("holds each admitted board ballot with its segment, and drops what admission refuses", async () => {
    const { store, approved } = await receipted(older);
    const garbage = Uint8Array.of(RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 1, 0);
    const view = await obligationView(
      viewOptions(store, { held: extentOf([older, other], [garbage]) }),
    )(approved);
    expect(view.boardSegment).toBe(S_A);
    expect(view.board.map((b) => [plain(b.ballotHash), b.entry])).toEqual([
      [plain(ballotHashOf(older)), { path: "board", value: 3n }],
      [plain(ballotHashOf(other)), { path: "board", value: 4n }],
    ]);
    const copy = view.board[0];
    expect(copy?.l1RefNumber).toBe(refs.older);
    expect(copy?.nullifier).toBe(older.record.nullifier);
    expect(view.absent).toEqual([]);
  });

  test("shows absent a receipted ballot that never reached the board, and owes the older one the delivery check selects", async () => {
    const { store, approved } = await receipted(older, newer);
    const options = viewOptions(store, { held: extentOf([older]) });
    const view = await obligationView(options)(approved);
    expect(view.absent.map(plain)).toEqual([plain(ballotHashOf(newer))]);
    // Without it, the seat would owe the newer ballot only, and the older
    // one, which every verifier counts, would lack this seat's receipt.
    expect(await owed(options, approved)).toEqual({
      receipts: [plain(ballotHashOf(older))],
      complaints: [plain(ballotHashOf(older))],
    });
  });

  test("holds the board contract's ballots by their path, so a newer ballot recorded there is owed", async () => {
    const { store, approved } = await receipted(older, newer);
    const opensAt = s.e.stub.opens_at;
    const options = viewOptions(store, {
      held: extentOf([older]),
      logs: [...registrationLogs(), submitted(newer, 50n), relayed(other, opensAt + 900n)],
      l2: l2Node(
        [...registrationLogs(), submitted(newer, 50n), relayed(other, opensAt + 900n)],
        L2_CHAIN_ID,
        (n) => opensAt + n * 10n,
      ),
    });
    const view = await obligationView(options)(approved);
    expect(view.board.map((b) => [plain(b.ballotHash), b.entry])).toEqual([
      [plain(ballotHashOf(older)), { path: "board", value: 3n }],
      [plain(ballotHashOf(newer)), { path: "ordinary", value: opensAt + 500n }],
      [plain(ballotHashOf(other)), { path: "relayed", value: opensAt + 900n }],
    ]);
    expect(view.absent).toEqual([]);
    const decided = await owed(options, approved);
    expect(decided.receipts).toEqual([plain(ballotHashOf(newer))]);
    // Voter 1's relayed ballot is in the scope, though the seat never receipted it.
    expect(decided.complaints).toEqual(
      [plain(ballotHashOf(newer)), plain(ballotHashOf(other))].sort(),
    );
  });

  test("never shows absent a ballot a board log names, even one failing the event check", async () => {
    const { store, approved } = await receipted(older, newer);
    // The older ballot's bytes under the newer one's topic: no copy of
    // either from it, and the newer one isn't shown absent.
    const forged = submitted(older, 50n, ballotHashOf(newer));
    const logs = [...registrationLogs(), forged];
    const options = viewOptions(store, { held: extentOf([older]), logs });
    const view = await obligationView(options)(approved);
    expect(view.board.map((b) => plain(b.ballotHash))).toEqual([plain(ballotHashOf(older))]);
    expect(view.absent).toEqual([]);
    expect((await owed(options, approved)).receipts).toEqual([plain(ballotHashOf(newer))]);
  });

  test("waits for the L2 node's finalized history to pass the contract-event window before showing anything absent", async () => {
    const { store, approved } = await receipted(older, newer);
    // The node hasn't finalized the block recording the newer ballot yet:
    // shown absent now, it would lose the receipt the delivery check needs.
    const logs = [...registrationLogs(), submitted(newer, L2_FINALIZED + 1n)];
    const lagging = l2Node(logs, L2_CHAIN_ID, (n) => GENESIS + n, pastWindow() - 1n);
    await expect(
      obligationView(viewOptions(store, { held: extentOf([older]), l2: lagging }))(approved),
    ).rejects.toBeInstanceOf(RpcError);
    // Without the extent nothing is shown absent, so there is nothing to wait for.
    const view = await obligationView(viewOptions(store, { l2: lagging }))(approved);
    expect(view.absent).toEqual([]);
  });

  test("shows absent a ballot whose contract event only the board archives: the operator's claim, not the contract's record", async () => {
    const { store, approved } = await receipted(older, newer);
    // An operator that never boarded the newer ballot archives a forged
    // `BallotSubmitted` for it, which passes the event check offline.
    const options = viewOptions(store, {
      held: extentOf([older], [archived(submitted(newer, 50n))]),
    });
    const view = await obligationView(options)(approved);
    expect(view.absent.map(plain)).toEqual([plain(ballotHashOf(newer))]);
    expect((await owed(options, approved)).receipts).toEqual([plain(ballotHashOf(older))]);
  });

  test("reads ballot logs only from the board's deployment block, up to the L2 node's finalized one", async () => {
    const { store, approved } = await receipted(older, newer);
    for (const [boardFromBlock, block] of [
      [60n, 50n],
      [0n, L2_FINALIZED + 1n],
    ] as const) {
      const logs = [...registrationLogs(), submitted(newer, block)];
      const view = await obligationView(
        viewOptions(store, { held: extentOf([older]), logs, boardFromBlock }),
      )(approved);
      expect(view.absent.map(plain)).toEqual([plain(ballotHashOf(newer))]);
    }
  });
});

describe("refusals", () => {
  test("a registered definition that isn't the approved one", async () => {
    const { store, approved } = await receipted(older);
    const other = {
      ...s.definition,
      closes_at: s.definition.closes_at + 1n,
      ceremony_transcript_hash: ceremonyTranscriptHash(s.transcript),
    };
    const err = await obligationView(viewOptions(store, { logs: registrationLogs(other) }))(
      approved,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ViewError);
    expect(err).toMatchObject({ code: "definition" });
  });

  test("a node on another chain, and an L2 node whose blocks can't be read", async () => {
    const { store, approved } = await receipted(older);
    await expect(
      obligationView(viewOptions(store, { l2: l2Node(registrationLogs(), L2_CHAIN_ID + 1n) }))(
        approved,
      ),
    ).rejects.toMatchObject({ name: "ViewError", code: "chain" });
    await expect(
      obligationView(viewOptions(store, { l1ChainId: s.e.stub.l1_chain_id + 1n }))(approved),
    ).rejects.toMatchObject({ name: "ViewError", code: "chain" });
    const logs = [...registrationLogs(), submitted(newer, 50n)];
    const broken: Rpc = {
      call: async (method, params) => {
        if (method === "eth_getBlockByNumber" && params[0] !== "finalized") return null;
        return l2Node(logs).call(method, params);
      },
    };
    await expect(
      obligationView(viewOptions(store, { held: extentOf([older]), l2: broken }))(approved),
    ).rejects.toBeInstanceOf(RpcError);
  });
});

describe("stepped by the receipt duties", () => {
  /**
   * The deployment's schedule over one approved election, its duty built as
   * `run` builds it over `options`, with a contract path that records what
   * it is sent once `recording` is set.
   */
  function scheduled(options: ViewOptions, approved: ApprovedElection) {
    const sent: Uint8Array[] = [];
    const events: ReceiptEvent[] = [];
    const path = {
      recording: false,
      recordedBatches: [] as Uint8Array[],
    };
    let wall = s.cutoff - 1n;
    const duties = new ReceiptDuties({
      seat: {
        approvedStubs: async () => [approved.stubHash],
        approvedElection: async () => approved,
      },
      build: async (election) =>
        new ReceiptDuty({
          store: options.store,
          election,
          view: obligationView(options),
          contract: {
            send: async (batch) => {
              sent.push(batch);
              if (path.recording) path.recordedBatches.push(batch);
            },
            recorded: async () => path.recordedBatches,
          },
          now: () => wall,
        }),
      clock: () => wall,
      log: (e) => events.push(e),
    });
    return {
      duties,
      sent,
      events,
      path,
      at: (t: bigint) => {
        wall = t;
      },
    };
  }

  test("decide at c_I over the deployment's view and send the receipt the delivery check needs until it is recorded", async () => {
    const { store, approved } = await receipted(older, newer);
    const h = scheduled(viewOptions(store, { held: extentOf([older]) }), approved);
    await h.duties.step();
    expect(h.sent).toEqual([]);
    h.at(s.cutoff);
    await h.duties.step();
    // The newer ballot never reached the board: the seat owes the older,
    // counted one, signed as one batch.
    expect(h.sent).toHaveLength(1);
    const batch = decodeShareReceiptBatch(h.sent[0] as Uint8Array, 1);
    expect(batch.receipts.map((p) => plain(p.ballot_hash))).toEqual([plain(ballotHashOf(older))]);
    h.path.recording = true;
    await h.duties.step();
    await h.duties.step();
    expect(h.sent).toHaveLength(2);
    const name = plain(approved.stubHash);
    expect(h.events).toEqual([
      { event: "receipts", stubHash: name, state: "open", until: s.cutoff.toString() },
      { event: "receipts", stubHash: name, state: "sent", batches: 1, recorded: 0, total: 1 },
      { event: "receipts", stubHash: name, state: "recorded", total: 1 },
    ]);
  });

  test("give up, reported, a view no retry can read, sending nothing", async () => {
    const { store, approved } = await receipted(older);
    const h = scheduled(
      viewOptions(store, { l2: l2Node(registrationLogs(), L2_CHAIN_ID + 1n) }),
      approved,
    );
    h.at(s.cutoff);
    await h.duties.step();
    await h.duties.step();
    expect(h.sent).toEqual([]);
    expect(h.events).toEqual([
      {
        event: "receipts-error",
        stubHash: plain(approved.stubHash),
        error: "ViewError",
        message: "chain",
      },
    ]);
  });

  test("retry a view its nodes can't give yet, and decide once they can", async () => {
    const { store, approved } = await receipted(older);
    let down = true;
    const node = l1.rpc;
    const h = scheduled(
      viewOptions(store, {
        l1: {
          call: (method, params) =>
            down
              ? Promise.reject(new RpcError(`${method}: status 503`))
              : node.call(method, params),
        },
      }),
      approved,
    );
    h.at(s.cutoff);
    await h.duties.step();
    expect(h.events.map((e) => e.event)).toEqual(["receipts-error"]);
    down = false;
    await h.duties.step();
    expect(h.sent).toHaveLength(1);
  });
});

describe("the complaint duty's ballot source", () => {
  const ballotsOf = async (options: ViewOptions, approved: ApprovedElection) =>
    (await complaintBallots(options)(approved)).map(plain);

  test("gives the attested extent's ballot records and the board contract's, the transcript and failing logs left out", async () => {
    const { store, approved } = await receipted(older);
    const garbage = Uint8Array.of(RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 1, 0);
    const logs = [
      ...registrationLogs(),
      submitted(newer, 50n),
      relayed(other, s.e.stub.opens_at + 900n),
      // The older ballot's bytes under another ballot's topic fail the event check.
      submitted(older, 50n, ballotHashOf(newer)),
    ];
    const options = viewOptions(store, { held: extentOf([older], [garbage]), logs });
    // Nothing is admitted here: the duty matches each record by the hash it recomputes.
    expect(await ballotsOf(options, approved)).toEqual(
      [older.bytes, garbage, newer.bytes, other.bytes].map(plain),
    );
  });

  test("gives the contract's alone for a seat that didn't attest, or whose pinned blocks lost the extent", async () => {
    const { store, approved } = await receipted(older);
    const logs = [...registrationLogs(), submitted(newer, 50n)];
    expect(await ballotsOf(viewOptions(store, { logs }), approved)).toEqual([plain(newer.bytes)]);
    const lost = {
      ...viewOptions(store, { logs }),
      extent: () => Promise.reject(new ViewError("extent-lost")),
    };
    expect(await ballotsOf(lost, approved)).toEqual([plain(newer.bytes)]);
    // Any other failure to read the extent is the duty's to retry or give up.
    const failing = {
      ...viewOptions(store, { logs }),
      extent: () => Promise.reject(new RpcError("eth_call: status 503")),
    };
    await expect(complaintBallots(failing)(approved)).rejects.toBeInstanceOf(RpcError);
  });

  test("refuses as the view does: a definition that isn't the approved one, a node on another chain", async () => {
    const { store, approved } = await receipted(older);
    const changed = { ...s.definition, closes_at: s.definition.closes_at + 1n };
    await expect(
      complaintBallots(viewOptions(store, { logs: registrationLogs(changed) }))(approved),
    ).rejects.toMatchObject({ name: "ViewError", code: "definition" });
    await expect(
      complaintBallots(viewOptions(store, { l2: l2Node(registrationLogs(), L2_CHAIN_ID + 1n) }))(
        approved,
      ),
    ).rejects.toMatchObject({ name: "ViewError", code: "chain" });
  });

  test("lets the complaint duty check a posting against a scope ballot the seat never receipted", async () => {
    const { store, approved } = await receipted(older);
    const opensAt = s.e.stub.opens_at;
    const logs = [...registrationLogs(), relayed(other, opensAt + 900n)];
    const options = viewOptions(store, { held: extentOf([older]), logs });
    const { delivery } = deliveryDeadlines(approved.closesAt, approved.l1InclusionBound);
    const after = delivery + RELEASE_WINDOWS.contractEventWindow + 1n;
    // A posting for voter 1's relayed ballot, which is in the seat's scope
    // but not its intake, carrying an `m` that isn't the ballot's: it fails
    // the public check, so nothing is owed, but only once its ballot is read.
    const deliveryVectors = JSON.parse(
      await readFile(new URL("../../../docs/spec/vectors/delivery.json", import.meta.url), "utf8"),
    ) as { records: { id: string; encoding: string }[] };
    const { m } = decodeSharePosting(
      hexToBytes(deliveryVectors.records.find((r) => r.id === "posting")?.encoding ?? ""),
      1,
    );
    const posting = encodeSharePosting({
      definition_hash: approved.definitionHash,
      ballot_hash: ballotHashOf(other),
      seat: approved.index,
      m,
      ciphertext: decode(SHARE_CIPHERTEXT, other.ciphertexts[approved.index - 1] as Uint8Array),
    });
    const duty = (ballots: typeof complaintBallots) =>
      new ComplaintDuty({
        store,
        election: approved,
        view: obligationView(options),
        contract: {
          postings: async () => ({
            finalizedAt: after,
            postings: [{ record: posting, submittedAt: delivery }],
          }),
          send: async () => expect.fail("nothing is owed"),
          recorded: async () => [],
        },
        ballots: ballots(options),
        now: () => after,
      });
    // Without the ballot the duty waits for it; with the source it decides.
    expect(await duty(() => async () => []).step()).toMatchObject({
      state: "waiting-ballots",
      missing: 1,
    });
    expect(await duty(complaintBallots).step()).toEqual({ state: "recorded", total: 0 });
  });
});
