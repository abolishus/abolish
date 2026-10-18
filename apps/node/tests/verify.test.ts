import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  type Checkpoint,
  decodeElectionDefinitionRecord,
  electionDefinitionHash,
  type ElectionDefinition,
  encodeCheckpoint,
  encodeElectionDefinition,
  identityKey,
  objectCar,
  objectCid,
} from "@abolishus/crypto";
import { decodeHeader, gatewaySource, loadBundle, verifyBundle } from "@abolishus/verifier";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vite-plus/test";
import { cli } from "../src/cli.ts";
import { gateway } from "../src/gateway.ts";
import { anchorTiming, finalizedBlock, MAX_RUN_BYTES } from "../src/l1.ts";
import { chainId, type Rpc, RpcError } from "../src/rpc.ts";
import { openMirror } from "../src/store.ts";
import { type VerifyReport, verifyElections } from "../src/verify.ts";
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
} from "./anvil.ts";
import { blocksDir, close, listen, removeDirs } from "./fixture.ts";

// Verifying what was pinned (P4-5 part 3): the board anchor on Anvil holds
// each election's checkpoints, an L2 node scripted here answers the election
// and trustee registries' logs, and the node gathers every input into a
// bundle the verifier reads. What it gathers is checked against values
// computed here, the topics come from contract-event-v8.json's tables rather
// than the node's own constants, and the report must be the one the
// verifier's own loader gives for the bundle it wrote (T-24, T-49, T-53).

const vectors = JSON.parse(
  await readFile(
    new URL("../../../docs/spec/vectors/contract-event-v8.json", import.meta.url),
    "utf8",
  ),
) as { events: { signature: string; topic0: string }[] };
const topic0 = (signature: string) => {
  const t = vectors.events.find((e) => e.signature.startsWith(`${signature}(`))?.topic0;
  if (t === undefined) throw new Error(`no ${signature} in the vectors`);
  return `0x${t}`;
};
const CREATED = topic0("ElectionCreated");
const REGISTERED = topic0("DefinitionRegistered");
const PINNED = topic0("PanelPinned");

const definitions = JSON.parse(
  await readFile(
    new URL("../../../docs/spec/vectors/election-definition.json", import.meta.url),
    "utf8",
  ),
) as { vectors: { encoding: string }[] };
const record = decodeElectionDefinitionRecord(hexToBytes(definitions.vectors[0]!.encoding));
if (record.version !== 1) throw new Error("the first vector is a version-1 definition");
const typical: ElectionDefinition = record.value;

const text = (s: string) => new TextEncoder().encode(s);
const address = (name: string) => keccak_256(text(name)).slice(12);
const REGISTRY = address("election registry");
const TRUSTEES = address("trustee registry");
const PANEL = {
  threshold: 2,
  keys: [1, 2, 3].map((i) => identityKey(keccak_256(text(`seat ${i}`)))),
};

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
const servers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of servers.splice(0)) await stop();
  await removeDirs();
});

/** A well-formed definition for `name`'s election through the anchor and registry, with `changes`. */
function definition(name: string, changes: Partial<ElectionDefinition> = {}): ElectionDefinition {
  return {
    ...typical,
    election_id: keccak_256(text(`election ${name}`)),
    election_registry: REGISTRY,
    trustee_registry: TRUSTEES,
    l1_anchor: anchor.address,
    l1_chain_id: l1ChainId,
    ...changes,
  };
}

interface Log {
  readonly address: Uint8Array;
  readonly topics: readonly string[];
  readonly data: Uint8Array;
  readonly blockNumber?: bigint;
  readonly removed?: true;
}

// The three events, ABI-encoded here as docs/spec/contracts.md lists them.
const origin = (timestamp: bigint) =>
  concatBytes(word(17n), word(timestamp), keccak_256(text(`L1 block at ${timestamp}`)));

function created(d: ElectionDefinition, timestamp: bigint): Log {
  return {
    address: REGISTRY,
    topics: [CREATED, hex(d.election_id), hex(word(BigInt(hex(address("creator")))))],
    data: concatBytes(word(3n), origin(timestamp)),
  };
}

function registered(d: ElectionDefinition, timestamp: bigint): Log {
  const encoding = encodeElectionDefinition(d);
  return {
    address: REGISTRY,
    topics: [REGISTERED, hex(d.election_id), hex(electionDefinitionHash(d))],
    data: concatBytes(
      origin(timestamp),
      word(128n),
      word(BigInt(encoding.length)),
      padded(encoding),
    ),
  };
}

function pinned(panelId: Uint8Array): Log {
  const keys = concatBytes(...PANEL.keys);
  return {
    address: TRUSTEES,
    topics: [PINNED, hex(panelId)],
    data: concatBytes(
      word(BigInt(PANEL.threshold)),
      word(BigInt(PANEL.keys.length)),
      word(96n),
      word(BigInt(keys.length)),
      padded(keys),
    ),
  };
}

const FINALIZED = 100n;

const answered = (l: Log) => ({
  address: hex(l.address),
  topics: l.topics,
  data: hex(l.data),
  blockNumber: `0x${(l.blockNumber ?? 16n).toString(16)}`,
  ...(l.removed && { removed: true }),
});

/**
 * An L2 node answering `eth_getLogs` from `logs` as a real one filters them,
 * up to its finalized block, plus `extra` whatever the filter: a node that
 * lies about which logs match.
 */
function l2Node(logs: readonly Log[], extra: readonly Log[] = []): Rpc {
  return {
    call: async (method, params) => {
      if (method === "eth_chainId") return `0x${typical.l2_chain_id.toString(16)}`;
      if (method === "eth_getBlockByNumber") return { number: `0x${FINALIZED.toString(16)}` };
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const filter = params[0] as { address: string; topics: (string | string[] | null)[] };
      return [
        ...logs.filter(
          (l) =>
            hex(l.address) === filter.address &&
            filter.topics.every(
              (t, i) =>
                t === null ||
                (Array.isArray(t) ? t.includes(l.topics[i] ?? "") : t === l.topics[i]),
            ),
        ),
        ...extra,
      ].map(answered);
    },
  };
}

/** A checkpoint naming `object`; the node judges nothing else about it. */
function checkpoint(
  d: Pick<ElectionDefinition, "election_id">,
  segment: number,
  object: Uint8Array,
): Checkpoint {
  return {
    election_id: d.election_id,
    segment,
    size: BigInt(segment + 1),
    head: keccak_256(concatBytes(d.election_id, word(BigInt(segment)))),
    root: keccak_256(concatBytes(word(BigInt(segment)), d.election_id)),
    object_cid: objectCid(object),
    hashes_cid: objectCid(new Uint8Array(32 * (segment + 1)).fill(segment)),
  };
}

async function run(l2: Rpc, dir: string, reports: string, l1: Rpc = chain.rpc) {
  const { header, rlp } = await finalizedBlock(chain.rpc);
  const lines: VerifyReport[] = [];
  await verifyElections({
    l1,
    anchor: anchor.address,
    header,
    headerRlp: rlp,
    timing: await anchorTiming(chain.rpc, anchor.address, header),
    l2,
    registry: REGISTRY,
    l1ChainId,
    l2ChainId: typical.l2_chain_id,
    l2Finalized: FINALIZED,
    mirror: await openMirror(dir),
    reports,
    fromBlock: 0n,
    l2FromBlock: 0n,
    maxBoardBytes: 2 ** 30,
    maxRunBytes: MAX_RUN_BYTES,
    report: (r) => lines.push(r),
  });
  return { lines, header, rlp };
}

const byElection = (lines: readonly VerifyReport[], d: ElectionDefinition) =>
  lines.find((l) => l.election === bytesToHex(d.election_id));

describe("verify", () => {
  test("gathers every input from L1, L2 and its blocks into the bundle the verifier reads, and writes its report", async () => {
    // Created in period 1, so `f` is 1; anchored in segments 1 and 2, so the seal is 2.
    const createdAt = anchor.epoch + PERIOD + 5n;
    const objects = [text("segment 1"), text("segments 1 and 2")];
    const id = { election_id: keccak_256(text("election honest")) };
    const cps = [checkpoint(id, 1, objects[0]!), checkpoint(id, 2, objects[1]!)];
    await chain.anchorAll(anchor, cps);
    // Then L1 blocks 1,200 seconds apart, and a window from an hour after
    // block `b + 5`'s time to an hour before block `b + 12`'s, less the
    // inclusion bound: the run is blocks `b + 4` to `b + 13`.
    const b = BigInt((await chain.rpc.call("eth_blockNumber", [])) as string);
    await chain.rpc.call("anvil_mine", ["0x14", "0x4b0"]);
    await chain.mine(2);
    const at = async (n: bigint) =>
      (await chain.rpc.call("eth_getBlockByNumber", [`0x${n.toString(16)}`, false])) as {
        hash: string;
        timestamp: string;
      };
    const d = definition("honest", {
      opens_at: BigInt((await at(b + 5n)).timestamp) + 3600n,
      closes_at: BigInt((await at(b + 12n)).timestamp) - BigInt(typical.l1_inclusion_bound),
    });
    const dir = await blocksDir(
      Object.fromEntries(objects.map((o, i) => [`${i}.car`, objectCar(o)])),
    );
    const reports = await blocksDir({});
    const registration = registered(d, createdAt + 60n);
    const l2 = l2Node(
      [created(d, createdAt), registration, pinned(d.panel_id)],
      // Each a second registration, were it not dropped (`l2-repeated`):
      // another contract's log under the same topics, one reorganised away,
      // and one past the finalized block.
      [
        {
          ...registered(definition("honest", { opens_at: 1n }), createdAt),
          address: address("other"),
        },
        { ...registration, removed: true },
        { ...registration, blockNumber: FINALIZED + 1n },
      ],
    );
    const { lines, header, rlp } = await run(l2, dir, reports);

    const line = byElection(lines, d);
    expect(line).toMatchObject({
      verdict: "unverifiable",
      report: join(reports, bytesToHex(d.election_id)),
    });
    const out = join(reports, bytesToHex(d.election_id));
    const bundle = JSON.parse(await readFile(join(out, "bundle.json"), "utf8"));
    expect(bundle).toMatchObject({
      format: "abolish-verifier-bundle/5",
      definition: bytesToHex(encodeElectionDefinition(d)),
      clock: {
        epoch: anchor.epoch.toString(),
        period: PERIOD.toString(),
        deadline: DEADLINE.toString(),
        lastSegment: "2",
      },
      l1: {
        firstSegment: "1",
        header: bytesToHex(rlp),
        checkpoints: cps.map((c) => bytesToHex(encodeCheckpoint(c))),
      },
      panel: { threshold: "2", keys: PANEL.keys.map(bytesToHex) },
    });
    const headers = (bundle.l1Blocks as string[]).map((h) => decodeHeader(hexToBytes(h)));
    const numbers = Array.from({ length: 10 }, (_, i) => b + 4n + BigInt(i));
    expect(headers.map((h) => h.number)).toEqual(numbers);
    expect(headers.map((h) => `0x${bytesToHex(h.hash)}`)).toEqual(
      await Promise.all(numbers.map(async (n) => (await at(n)).hash)),
    );
    // The report is the verifier's own on that bundle, read here through the
    // node's gateway rather than its directory.
    const report = JSON.parse(await readFile(join(out, "report.json"), "utf8"));
    const server = gateway(await openMirror(dir));
    const base = await listen(server);
    servers.push(() => close(server));
    const theirs = verifyBundle(await loadBundle(out, 2 ** 30, gatewaySource([new URL(base)])));
    expect(report.checks).toEqual(theirs.checks);
    expect(report.verdict).toBe(theirs.verdict);
    expect(report.l1).toMatchObject({
      blockNumber: header.number.toString(),
      anchors: [{ segment: 1 }, { segment: 2 }],
    });
    expect(report.board.byCid).toMatchObject({ storeBlocks: 2 });
    expect(report.inputs).toMatchObject({ l1Blocks: "local-file" });
  });

  test("reports and skips each election whose inputs it can't gather, and verifies the others", async () => {
    const at = anchor.epoch + PERIOD + 5n;
    const honest = definition("still verified");
    const panelless = definition("unpinned panel", { panel_id: keccak_256(text("no panel")) });
    const cases: [string, ElectionDefinition, Log[]][] = [
      ["l2-definition-missing", definition("unregistered"), []],
      ["l2-creation-missing", definition("uncreated"), []],
      ["l2-repeated", definition("registered twice"), []],
      ["definition-anchor", definition("another anchor", { l1_anchor: address("other") }), []],
      [
        "definition-registry",
        definition("another registry", { election_registry: address("x") }),
        [],
      ],
      ["definition-chain", definition("another L1", { l1_chain_id: l1ChainId + 1n }), []],
      ["definition-chain", definition("another L2", { l2_chain_id: 1n }), []],
      ["creation-outside-clock", definition("created before the epoch"), []],
      ["creation-outside-clock", definition("created past the last segment"), []],
      ["l2-panel-missing", panelless, []],
      ["unanchored", definition("never anchored"), []],
      ["l1-checkpoint-unknown at segment 1", definition("a withheld L1 log"), []],
    ];
    for (const c of cases) {
      const [code, d, logs] = c;
      if (code === "l2-definition-missing") {
        // Its registration with a byte past the canonical encoding: no event.
        const r = registered(d, at);
        logs.push(created(d, at), { ...r, data: concatBytes(r.data, new Uint8Array(1)) });
      } else if (code === "l2-creation-missing") logs.push(registered(d, at));
      else if (code === "l2-repeated")
        logs.push(created(d, at), registered(d, at), registered(d, at + 1n));
      else if (d === cases[7]![1]) logs.push(created(d, anchor.epoch - 1n), registered(d, at));
      else if (d === cases[8]![1])
        logs.push(created(d, anchor.epoch + PERIOD * 2n ** 32n), registered(d, at));
      else logs.push(created(d, at), registered(d, at));
    }
    const anchored = [honest, ...cases.filter(([code]) => code !== "unanchored").map(([, d]) => d)];
    await chain.anchorAll(
      anchor,
      anchored.map((d) => checkpoint(d, 1, text("segment 1"))),
    );
    const withheld = cases.at(-1)![1];
    await chain.anchorAll(anchor, [checkpoint(withheld, 2, text("segment 1"))]);
    // An L1 node that forges a log for the election never anchored and
    // withholds the withheld election's log of segment 1.
    const never = cases.at(-2)![1];
    const l1: Rpc = {
      call: async (method, params) => {
        const result = await chain.rpc.call(method, params);
        if (method !== "eth_getLogs") return result;
        const logs = result as { address: string; topics: string[]; data: string }[];
        const kept = logs.filter(
          (l) => !(l.topics[1] === hex(withheld.election_id) && BigInt(l.topics[2]!) === 1n),
        );
        return [...kept, forgedLog(logs[0]!, checkpoint(never, 1, text("forged")))];
      },
    };
    const dir = await blocksDir({ "0.car": objectCar(text("segment 1")) });
    const l2 = l2Node([
      created(honest, at),
      registered(honest, at),
      pinned(honest.panel_id),
      ...cases.flatMap(([, , logs]) => logs),
    ]);
    const { lines } = await run(l2, dir, await blocksDir({}), l1);
    for (const [code, d] of cases)
      expect(byElection(lines, d), code).toEqual({
        election: bytesToHex(d.election_id),
        error: code,
      });
    expect(byElection(lines, honest)).toMatchObject({ verdict: "unverifiable" });
  });

  test("reports an unreachable L2 node's election and goes on", async () => {
    const d = definition("behind a broken node");
    await chain.anchorAll(anchor, [checkpoint(d, 1, text("segment 1"))]);
    const broken: Rpc = {
      call: async () => {
        throw new RpcError("eth_getLogs: refused");
      },
    };
    const { lines } = await run(broken, await blocksDir({}), await blocksDir({}));
    expect(byElection(lines, d)).toEqual({
      election: bytesToHex(d.election_id),
      error: "l2: eth_getLogs: refused",
    });
  });
});

/** `l2Node` over HTTP, for the command line. */
async function l2Server(node: Rpc): Promise<string> {
  const server: Server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    const result = await node.call(request.method, request.params);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  const base = await listen(server);
  servers.push(() => close(server));
  return base;
}

function io() {
  const out: unknown[] = [];
  const err: unknown[] = [];
  return {
    out,
    err,
    io: {
      out: (v: unknown) => out.push(v),
      err: (v: unknown) => err.push(v),
      signal: new AbortController().signal,
    },
  };
}

describe("abolish-node verify", () => {
  test("verifies every election from the two chains and its directory, then serves the reports", async () => {
    const d = definition("from the command line");
    const at = anchor.epoch + PERIOD + 5n;
    await chain.anchorAll(anchor, [checkpoint(d, 1, text("segment 1"))]);
    const dir = await blocksDir({ "0.car": objectCar(text("segment 1")) });
    const reports = await blocksDir({});
    const l2 = await l2Server(l2Node([created(d, at), registered(d, at), pinned(d.panel_id)]));
    const argv = [
      "verify",
      "--blocks",
      dir,
      "--reports",
      reports,
      "--l1",
      chain.url.href,
      "--anchor",
      hex(anchor.address),
      "--l2",
      l2,
      "--registry",
      hex(REGISTRY),
    ];
    const ran = io();
    expect(await cli(argv, ran.io)).toBe(0);
    expect(ran.err).toEqual([]);
    expect(ran.out).toContainEqual(
      expect.objectContaining({ election: bytesToHex(d.election_id) }),
    );

    // `serve --reports` answers the report as written, and nothing else under /reports/.
    const controller = new AbortController();
    const served: unknown[] = [];
    const serving = cli(["serve", "--blocks", dir, "--reports", reports, "--port", "0"], {
      out: (v) => served.push(v),
      err: () => {},
      signal: controller.signal,
    });
    while (!served.some((v) => typeof v === "object" && v !== null && "listening" in v))
      await new Promise((r) => setTimeout(r, 20));
    const { port } = (
      served.find((v) => "listening" in (v as object)) as { listening: { port: number } }
    ).listening;
    const id = bytesToHex(d.election_id);
    const response = await fetch(`http://127.0.0.1:${port}/reports/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await response.text()).toBe(await readFile(join(reports, id, "report.json"), "utf8"));
    for (const path of [
      `/reports/${"0".repeat(64)}`,
      `/reports/${id.toUpperCase()}`,
      `/reports/${id}/`,
      "/reports/",
    ])
      expect((await fetch(`http://127.0.0.1:${port}${path}`)).status, path).toBe(404);
    controller.abort();
    expect(await serving).toBe(0);
  });

  test("exits 1 when the L2 node can't be read, and 2 on bad usage", async () => {
    const base = [
      "verify",
      "--blocks",
      await blocksDir({}),
      "--reports",
      await blocksDir({}),
      "--l1",
      chain.url.href,
      "--anchor",
      hex(anchor.address),
      "--registry",
      hex(REGISTRY),
    ];
    const unreachable = io();
    expect(await cli([...base, "--l2", "http://127.0.0.1:9/"], unreachable.io)).toBe(1);
    expect(JSON.stringify(unreachable.err)).toMatch(/"l2: /u);
    expect(JSON.stringify(unreachable.err)).not.toMatch(/127\.0\.0\.1:9/u);
    const missing = io();
    expect(await cli(base, missing.io)).toBe(2);
    const badRegistry = io();
    const short = base.map((a) => (a === hex(REGISTRY) ? "0x12" : a));
    expect(await cli([...short, "--l2", "http://127.0.0.1:9/"], badRegistry.io)).toBe(2);
  });
});

test("a gateway given no reports directory answers no report", async () => {
  const server = gateway(await openMirror(await blocksDir({})));
  const base = await listen(server);
  servers.push(() => close(server));
  expect((await fetch(`${base}/reports/${"0".repeat(64)}`)).status).toBe(404);
});
