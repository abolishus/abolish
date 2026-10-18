import { readFile } from "node:fs/promises";
import {
  type Checkpoint,
  decodeElectionDefinitionRecord,
  definitionMembers,
  electionDefinitionHash,
  type ElectionDefinition,
  encodeElectionDefinition,
  type L1Origin,
  objectCid,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import { chainId, L2Error, type Rpc, RpcError } from "@abolishus/node";
import { L1Error } from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
// The community node's Anvil fixture: the board anchor deployed from
// `packages/contracts` and checkpoints anchored through an impersonated
// authority, so this reader is tested against the contract it reads.
import {
  type Anchor,
  type Chain,
  DEADLINE,
  forgedLog,
  hex,
  padded,
  PERIOD,
  startChain,
  word,
} from "../../node/tests/anvil.ts";
import { AvailabilitySeat } from "../src/availability.ts";
import type { ApprovedElection } from "../src/ceremony.ts";
import { L1AnchorError, type L1AnchorOptions, l1BoardAnchors } from "../src/l1.ts";
import { MemoryStore } from "../src/store.ts";

// The availability duty's L1 reader (P4-3 part 2c-4b-1): the board anchor on
// Anvil holds each election's checkpoints, an L2 node scripted here answers
// the election registry's creation and registration logs, whose L1 origin is
// a real Anvil block, and the reader must give exactly the anchors the anchor
// holds for segments `f` to `s_A`, with the pinned clock and the finalized
// time, whatever the L1 node does to its logs and proofs (T-24, T-51, T-53).
// The registry's topics come from contract-event-v8.json's tables rather
// than the node's constants.

const vector = async (file: string) =>
  JSON.parse(
    await readFile(new URL(`../../../docs/spec/vectors/${file}`, import.meta.url), "utf8"),
  );
const events = (await vector("contract-event-v8.json")) as {
  events: { signature: string; topic0: string }[];
};
const topic0 = (signature: string) => {
  const t = events.events.find((e) => e.signature.startsWith(`${signature}(`))?.topic0;
  if (t === undefined) throw new Error(`no ${signature} in the vectors`);
  return `0x${t}`;
};
const CREATED = topic0("ElectionCreated");
const REGISTERED = topic0("DefinitionRegistered");

type Vectors = { vectors: { encoding: string; hash?: string }[] };
const record = decodeElectionDefinitionRecord(
  hexToBytes(((await vector("election-definition.json")) as Vectors).vectors[0]!.encoding),
);
if (record.version !== 1) throw new Error("the first vector is a version-1 definition");
const typical: ElectionDefinition = record.value;
const v3 = ((await vector("election-definition-v3.json")) as Vectors).vectors[0]!;

const text = (s: string) => new TextEncoder().encode(s);
const REGISTRY = keccak_256(text("election registry")).slice(12);
const L2_FINALIZED = 100n;

let chain: Chain;
let anchor: Anchor;
let l1ChainId: bigint;
beforeAll(async () => {
  chain = await startChain();
  anchor = await chain.deployAnchor();
  l1ChainId = await chainId(chain.rpc);
}, 120_000);
afterAll(async () => {
  await chain?.stop();
});

const end = (segment: bigint) => anchor.epoch + (segment + 1n) * PERIOD;
const period = (t: bigint) => (t - anchor.epoch) / PERIOD;

/** Anvil's latest block, mined now and then finalized, as an L1 origin. */
async function origin(): Promise<L1Origin> {
  await chain.mine(1);
  const b = (await chain.rpc.call("eth_getBlockByNumber", ["latest", false])) as {
    number: string;
    hash: string;
    timestamp: string;
  };
  await chain.mine(3);
  return {
    number: BigInt(b.number),
    hash: hexToBytes(b.hash.slice(2)),
    timestamp: BigInt(b.timestamp),
  };
}

/** Moves Anvil's clock to `t` and mines past finality there. */
async function advanceTo(t: bigint): Promise<void> {
  await chain.rpc.call("evm_setNextBlockTimestamp", [`0x${t.toString(16)}`]);
  await chain.mine(3);
}

interface Log {
  readonly address: Uint8Array;
  readonly topics: readonly string[];
  readonly data: Uint8Array;
}

// The two events, ABI-encoded here as docs/spec/contracts.md lists them.
const originWords = (o: L1Origin) => concatBytes(word(o.number), word(o.timestamp), o.hash);

const created = (electionId: Uint8Array, o: L1Origin): Log => ({
  address: REGISTRY,
  topics: [CREATED, hex(electionId), hex(word(BigInt(hex(keccak_256(text("creator")).slice(12)))))],
  data: concatBytes(word(3n), originWords(o)),
});

const registered = (
  electionId: Uint8Array,
  encoding: Uint8Array,
  hash: Uint8Array,
  o: L1Origin,
): Log => ({
  address: REGISTRY,
  topics: [REGISTERED, hex(electionId), hex(hash)],
  data: concatBytes(originWords(o), word(128n), word(BigInt(encoding.length)), padded(encoding)),
});

/** An L2 node answering `eth_getLogs` from `logs` as a real one filters them, up to its finalized block. */
function l2Node(logs: readonly Log[], l2ChainId = typical.l2_chain_id): Rpc {
  return {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${l2ChainId.toString(16)}`;
      if (method === "eth_getBlockByNumber") return { number: `0x${L2_FINALIZED.toString(16)}` };
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const filter = params[0] as { address: string; topics: (string | string[] | null)[] };
      return logs
        .filter(
          (l) =>
            hex(l.address) === filter.address &&
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
          blockNumber: "0x10",
        }));
    },
  };
}

/** An L1 node that passes every call to Anvil's, with `answer` rewriting some answers. */
function l1Node(answer: (method: string, result: unknown) => unknown): Rpc {
  return {
    call: async (method, params) => answer(method, await chain.rpc.call(method, params)),
  };
}

/** A checkpoint of `id`'s board at `segment`; the reader judges nothing else about it. */
function checkpoint(id: Uint8Array, segment: bigint): Checkpoint {
  const s = Number(segment);
  return {
    election_id: id,
    segment: s,
    size: BigInt(s + 1),
    head: keccak_256(concatBytes(id, word(segment))),
    root: keccak_256(concatBytes(word(segment), id)),
    object_cid: objectCid(concatBytes(id, word(segment))),
    hashes_cid: objectCid(new Uint8Array(32 * (s + 1)).fill(s % 256)),
  };
}

interface Setup {
  readonly d: ElectionDefinition;
  readonly o: L1Origin;
  /** The period of the creation's origin. */
  readonly f: bigint;
  readonly election: ApprovedElection;
  readonly options: L1AnchorOptions;
}

/**
 * An election `name` created now, whose origin is Anvil's latest block and
 * which closes `closes` seconds after the start of the next period, through
 * the anchor and registry, with `changes` to its definition, `options` to
 * the reader's and `logs` changing what the L2 node answers.
 */
async function setup(
  name: string,
  closes: bigint,
  changes: Partial<ElectionDefinition> = {},
  options: Partial<L1AnchorOptions> = {},
  logs?: (election: Uint8Array, d: ElectionDefinition, o: L1Origin) => Log[],
): Promise<Setup> {
  const o = await origin();
  const f = period(o.timestamp);
  const d: ElectionDefinition = {
    ...typical,
    election_id: keccak_256(text(`election ${name}`)),
    election_registry: REGISTRY,
    l1_anchor: anchor.address,
    l1_chain_id: l1ChainId,
    opens_at: o.timestamp,
    closes_at: end(f) + closes,
    ...changes,
  };
  const id = d.election_id;
  const answered = logs?.(id, d, o) ?? [
    created(id, o),
    registered(id, encodeElectionDefinition(d), electionDefinitionHash(d), o),
  ];
  return {
    d,
    o,
    f,
    election: {
      index: 1,
      stubHash: keccak_256(text(`stub ${name}`)),
      definitionHash: electionDefinitionHash(d),
      electionId: id,
      opensAt: d.opens_at,
      closesAt: d.closes_at,
      l1InclusionBound: BigInt(d.l1_inclusion_bound),
      members: definitionMembers(d),
      signingSecret: keccak_256(text(`secret ${name}`)),
    },
    options: {
      l1: chain.rpc,
      l1ChainId,
      anchor: anchor.address,
      timing: { epoch: anchor.epoch, period: PERIOD, deadline: DEADLINE },
      l1FromBlock: 0n,
      l2: l2Node(answered),
      l2ChainId: typical.l2_chain_id,
      registry: REGISTRY,
      l2FromBlock: 0n,
      ...options,
    },
  };
}

const finalizedTime = async () =>
  BigInt(
    ((await chain.rpc.call("eth_getBlockByNumber", ["finalized", false])) as { timestamp: string })
      .timestamp,
  );

const anchored = (c: Checkpoint) => ({ checkpoint: c, anchoredAt: end(BigInt(c.segment)) });

describe("l1BoardAnchors", () => {
  test("reads the election's anchors for segments f to s_A from finalized L1, with the pinned clock and the finalized time", async () => {
    // Closing in period f + 1: s_A = f + 2.
    const { f, election, options } = await setup("plain", 600n);
    await advanceTo(end(f + 3n) + 60n);
    const cps = [0n, 1n, 2n, 3n].map((k) => checkpoint(election.electionId, f + k));
    await chain.anchorAll(anchor, [...cps, checkpoint(keccak_256(text("election another")), f)]);
    const read = await (await l1BoardAnchors(options, election)).read(election.electionId);
    // Segment f + 3 is past s_A, and the other election's checkpoint is its own.
    expect(read.anchors).toEqual(cps.slice(0, 3).map(anchored));
    expect(read.clock).toEqual({
      epoch: anchor.epoch,
      period: PERIOD,
      deadline: DEADLINE,
      lastSegment: Number(f + 2n),
    });
    expect(read.now).toBe(await finalizedTime());
  });

  test("reads segments up to the last one ended while s_A is still to come", async () => {
    // Closing in period f + 6: s_A = f + 7, and only segments up to f + 1 have ended.
    const { f, election, options } = await setup("early", 5n * PERIOD);
    await advanceTo(end(f + 1n) + 60n);
    const cps = [0n, 1n].map((k) => checkpoint(election.electionId, f + k));
    await chain.anchorAll(anchor, cps);
    const read = await (await l1BoardAnchors(options, election)).read(election.electionId);
    expect(read.anchors).toEqual(cps.map(anchored));
    expect(read.clock.lastSegment).toBe(Number(f + 7n));
  });

  test("reads no anchor for a segment that ended before the creation's L1 origin", async () => {
    // Segment f - 1 ended before the origin, so its anchor, which a quorum
    // could have made before the election existed, doesn't count.
    const { f, election, options } = await setup("pre-creation", 600n);
    await advanceTo(end(f) + 60n);
    const cps = [-1n, 0n].map((k) => checkpoint(election.electionId, f + k));
    await chain.anchorAll(anchor, cps);
    const read = await (await l1BoardAnchors(options, election)).read(election.electionId);
    expect(read.anchors).toEqual([anchored(cps[1]!)]);
  });

  test("reads no anchors for an election nothing was anchored for", async () => {
    const { election, options } = await setup("empty", 600n);
    const read = await (await l1BoardAnchors(options, election)).read(election.electionId);
    expect(read.anchors).toEqual([]);
  });

  test("a node that withholds a log can't hide its anchor: the read fails", async () => {
    const { f, election, options } = await setup("withheld", 600n);
    await advanceTo(end(f + 1n) + 60n);
    await chain.anchorAll(
      anchor,
      [0n, 1n].map((k) => checkpoint(election.electionId, f + k)),
    );
    const l1 = l1Node((method, result) =>
      method === "eth_getLogs" ? (result as unknown[]).slice(0, 1) : result,
    );
    const reader = await l1BoardAnchors({ ...options, l1 }, election);
    await expect(reader.read(election.electionId)).rejects.toMatchObject({
      name: "L1Error",
      code: "l1-checkpoint-unknown",
    });
  });

  test("a forged log is never an anchor: only the proven word names one", async () => {
    const { f, election, options } = await setup("forged", 600n);
    await advanceTo(end(f) + 60n);
    await chain.anchorAll(anchor, [checkpoint(election.electionId, f)]);
    // The same segment with another root, in a log well formed in every way.
    const forged = { ...checkpoint(election.electionId, f), root: new Uint8Array(32).fill(7) };
    const l1 = l1Node((method, result) =>
      method === "eth_getLogs"
        ? (result as { address: string; topics: string[]; data: string }[]).map((l) =>
            forgedLog(l, forged),
          )
        : result,
    );
    const reader = await l1BoardAnchors({ ...options, l1 }, election);
    await expect(reader.read(election.electionId)).rejects.toMatchObject({
      code: "l1-checkpoint-unknown",
    });
  });

  test("a changed proof node fails the read rather than hiding a word", async () => {
    const { f, election, options } = await setup("proof", 600n);
    await advanceTo(end(f) + 60n);
    await chain.anchorAll(anchor, [checkpoint(election.electionId, f)]);
    const l1 = l1Node((method, result) => {
      if (method !== "eth_getProof") return result;
      const p = result as { accountProof: string[]; storageProof: { proof: string[] }[] };
      // The last node of the first slot's proof, its final byte flipped.
      const proof = [...(p.storageProof[0]?.proof ?? [])];
      const last = proof.at(-1) as string;
      proof[proof.length - 1] =
        last.slice(0, -2) + (Number.parseInt(last.slice(-2), 16) ^ 1).toString(16).padStart(2, "0");
      return { ...p, storageProof: [{ ...p.storageProof[0], proof }, ...p.storageProof.slice(1)] };
    });
    const reader = await l1BoardAnchors({ ...options, l1 }, election);
    await expect(reader.read(election.electionId)).rejects.toBeInstanceOf(L1Error);
  });

  test("reads only its own election", async () => {
    const { election, options } = await setup("own", 600n);
    const reader = await l1BoardAnchors(options, election);
    await expect(reader.read(keccak_256(text("election another")))).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  test("gives the board-entry version the registered definition pins", async () => {
    const { d, election, options } = await setup("board-version", 600n);
    const reader = await l1BoardAnchors(options, election);
    expect(reader.boardVersion).toBe(pinnedVersion(d, RECORD_TYPES.boardEntry));
    expect(reader.boardVersion).toBeTypeOf("number");
  });

  test("an AvailabilitySeat over it waits until s_A's anchoring deadline has passed on finalized L1", async () => {
    const { f, election, options } = await setup("seat", 600n);
    await advanceTo(end(f + 1n) + 60n);
    await chain.anchorAll(
      anchor,
      [0n, 1n].map((k) => checkpoint(election.electionId, f + k)),
    );
    const seat = new AvailabilitySeat({
      store: new MemoryStore(),
      election,
      boardVersion: 1,
      l1: await l1BoardAnchors(options, election),
      blocks: async () => [],
      pin: async () => expect.fail("nothing is pinned before C_A is fixed"),
      contract: {
        send: async () => {
          throw new Error("nothing is sent before C_A is fixed");
        },
        recorded: async () => undefined,
      },
      clock: () => end(f + 1n) + 60n,
      sendMargin: 600n,
      maxBytes: 2 ** 20,
    });
    // s_A = f + 2, whose anchors count until its period's end plus the deadline.
    expect(await seat.step()).toEqual({ state: "waiting", until: end(f + 2n) + DEADLINE });
  });
});

describe("l1BoardAnchors refuses an election", () => {
  const refused = async (s: Setup, code: string) =>
    expect(l1BoardAnchors(s.options, s.election)).rejects.toMatchObject({
      name: "L1AnchorError",
      code,
    });

  test("whose registered definition isn't the approved one", async () => {
    const s = await setup("swapped", 600n);
    await refused(
      { ...s, election: { ...s.election, definitionHash: new Uint8Array(32).fill(1) } },
      "definition-hash",
    );
  });

  test("whose registered definition is of a version the node doesn't read", async () => {
    const encoding = hexToBytes(v3.encoding);
    const id = decodeElectionDefinitionRecord(encoding).value.election_id;
    const s = await setup("v3", 600n, { election_id: id }, {}, (_, __, o) => [
      created(id, o),
      registered(id, encoding, hexToBytes(v3.hash as string), o),
    ]);
    await refused(s, "definition-version");
  });

  test("whose definition pins a board-entry version the node doesn't read", async () => {
    // This release reads board-entry versions 1 and 3 to 7, not 2.
    const pins = typical.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.boardEntry ? { ...p, version: 2 } : p,
    );
    await refused(
      await setup("board-v2", 600n, { profile: { ...typical.profile, pins } }),
      "definition-version",
    );
  });

  test("whose definition names another anchor, registry or chain", async () => {
    const other = new Uint8Array(20).fill(9);
    await refused(await setup("anchor", 600n, { l1_anchor: other }), "definition-deployment");
    await refused(
      await setup("registry", 600n, { election_registry: other }),
      "definition-deployment",
    );
    await refused(
      await setup("l1", 600n, { l1_chain_id: l1ChainId + 1n }),
      "definition-deployment",
    );
    await refused(
      await setup("l2", 600n, { l2_chain_id: typical.l2_chain_id + 1n }),
      "definition-deployment",
    );
  });

  test("when a node is on another chain", async () => {
    await refused(await setup("l1-chain", 600n, {}, { l1ChainId: l1ChainId + 1n }), "chain");
    await refused(
      await setup("l2-chain", 600n, {}, { l2: l2Node([], typical.l2_chain_id + 1n) }),
      "chain",
    );
  });

  test("when the anchor's clock isn't the pinned one", async () => {
    const timing = { epoch: anchor.epoch, period: PERIOD, deadline: DEADLINE };
    await refused(
      await setup("epoch", 600n, {}, { timing: { ...timing, epoch: timing.epoch + 1n } }),
      "clock",
    );
    await refused(
      await setup("period", 600n, {}, { timing: { ...timing, period: 1800n } }),
      "clock",
    );
    await refused(
      await setup("deadline", 600n, {}, { timing: { ...timing, deadline: 1n } }),
      "clock",
    );
  });

  test("whose creation's L1 origin isn't the finalized L1 block of its number", async () => {
    const shifted = (name: string, change: (o: L1Origin) => L1Origin) =>
      setup(name, 600n, {}, {}, (id, d, o) => [
        created(id, change(o)),
        registered(id, encodeElectionDefinition(d), electionDefinitionHash(d), o),
      ]);
    // An earlier time, which would lower `f`; another hash.
    await refused(
      await shifted("time", (o) => ({ ...o, timestamp: o.timestamp - PERIOD })),
      "origin",
    );
    await refused(
      await shifted("hash", (o) => ({ ...o, hash: new Uint8Array(32).fill(3) })),
      "origin",
    );
    // A block not yet final at the L1 node is a lag to wait out, retried, never a refusal.
    const unfinal = await shifted("unfinal", (o) => ({ ...o, number: o.number + 1000n }));
    await expect(l1BoardAnchors(unfinal.options, unfinal.election)).rejects.toThrow(RpcError);
  });

  test("that closes before its creation, or whose s_A is past a u32", async () => {
    await refused(await setup("closed", -PERIOD), "outside-clock");
    await refused(await setup("far", 2n ** 32n * PERIOD), "outside-clock");
  });

  test("the registry never registered", async () => {
    const s = await setup("unregistered", 600n, {}, {}, (id, _, o) => [created(id, o)]);
    const reader = l1BoardAnchors(s.options, s.election);
    await expect(reader).rejects.toBeInstanceOf(L2Error);
    await expect(reader).rejects.toMatchObject({ code: "l2-definition-missing" });
  });

  test("refusals are typed", () => {
    expect(new L1AnchorError("chain")).toMatchObject({ name: "L1AnchorError", code: "chain" });
  });
});
