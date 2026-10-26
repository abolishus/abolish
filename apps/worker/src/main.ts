import {
  anchoredCountedTally,
  BallotAdmissions,
  CREATE_DAILY_CEILING,
  L1References,
  OpeningBoardings,
  openingTargets,
  Tier0Batches,
  Tier1Batches,
} from "@abolishus/core";
import { parseRpcUrl, rpcClient } from "@abolishus/node";
import { Redis } from "ioredis";
import postgres from "postgres";
import { BaseError, createPublicClient, getAddress, http } from "viem";
import * as z from "zod";
import { ANCHOR_ENV, ANCHOR_EVERY_ENV, anchorFromEnv } from "./anchor-env.ts";
import { checkAnchorClock, ViemAnchorReader } from "./anchor-chain.ts";
import { pinnedPanels } from "./ballot-env.ts";
import { connectAnchorRunner } from "./anchor-runner.ts";
import { registrySyncFromEnv, REGISTRY_SYNC_ENV } from "./registry-env.ts";
import { DisputeGameRoots, ProvenRegistryAccumulator } from "./output-roots.ts";
import { RegistrySync } from "./registry-sync.ts";
import { POLL_ROOT_ENV, pollRootFromEnv } from "./poll-root-env.ts";
import { PollRoots } from "./poll-roots.ts";
import { pollStubDeployment } from "./poll-stub-chain.ts";
import { POLL_STUB_ENV, pollStubFromEnv } from "./poll-stub-env.ts";
import { POSTING_ENV } from "./posting-env.ts";
import { connectTier0Bundler } from "./tier0-bundler.ts";
import { RpcL1HeaderRun } from "./l1-headers.ts";
import { ViemL1Source } from "./l1-source.ts";
import { checkCreationAnchorsDeployment, ViemCreationAnchors } from "./creation-anchors.ts";
import { checkPollCreationDeployment, ViemPollCreationChain } from "./poll-create-chain.ts";
import {
  POLL_CREATE_CEILING_ENV,
  POLL_CREATE_ENV,
  pollCreationFromEnv,
} from "./poll-create-env.ts";
import { checkTier0Deployment, ViemTier0Chain } from "./tier0-chain.ts";
import { TIER0_ENV, tier0FromEnv } from "./tier0-env.ts";
import { checkTier1Deployment, ViemTier1Chain } from "./tier1-chain.ts";
import { TIER1_ENV, tier1FromEnv } from "./tier1-env.ts";
import { startWorker, type WorkerOptions } from "./worker.ts";

// Entry point: reads the environment, connects to Redis (or Dragonfly) and to
// Postgres as a user granted abolish_app (never the owner; packages/core,
// Database), and runs every queue.

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  AUDIT_EVERY_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .default(10 * 60_000),
  // Ballot admission for the API's queue, all three or none: the trustee
  // panels the release pins, as JSON (`[{"threshold": k, "keys": ["<hex>",
  // …]}]`, each key a seat's identity key in seat order), and the anchoring
  // clock of the anchor contract our definitions name (docs/spec/board.md,
  // Timing). Without them the worker boards no ballot.
  BALLOT_PINNED_PANELS: z.string().min(1).optional(),
  BALLOT_ANCHOR_EPOCH: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .optional(),
  BALLOT_ANCHOR_PERIOD: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .optional(),
  // Optional, both or neither, and only with the three above: an L1 node
  // and the chain our definitions name as `l1_chain_id`, to refuse ballots
  // whose L1 reference verifier 5.8 already rejects (T-17, T-52). Without
  // it, every reference is left to the verifier. The URL can carry a
  // provider's API key, so it is never logged or quoted in an error.
  BALLOT_L1_RPC_URL: z.url({ protocol: /^https?$/ }).optional(),
  BALLOT_L1_CHAIN_ID: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .optional(),
  // Optional, both or neither, and only with all five above: the address of
  // the anchor contract our definitions name and the deadline it fixes, to
  // board the trustees' tally openings over the anchored counted set (core's
  // OpeningBoardings; docs/spec/tally.md, Opening record, Boarding). The
  // anchor and finalized L1 are read from the ballot L1 check's node, and
  // the anchor must fix this clock. Without them the worker boards no
  // opening.
  BALLOT_ANCHOR_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  BALLOT_ANCHOR_DEADLINE: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .optional(),
});

// The posting key runs in a deployment of its own, beside nothing else
// (posting-main.ts; docs/spec/posting-relay.md, Roles).
if (POSTING_ENV.some((name) => process.env[name] !== undefined && process.env[name] !== ""))
  throw new Error("the posting worker's variables belong to posting.mjs alone");

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  REDIS_URL: process.env["REDIS_URL"],
  AUDIT_EVERY_MS: process.env["AUDIT_EVERY_MS"],
  BALLOT_PINNED_PANELS: process.env["BALLOT_PINNED_PANELS"],
  BALLOT_ANCHOR_EPOCH: process.env["BALLOT_ANCHOR_EPOCH"],
  BALLOT_ANCHOR_PERIOD: process.env["BALLOT_ANCHOR_PERIOD"],
  BALLOT_L1_RPC_URL: process.env["BALLOT_L1_RPC_URL"],
  BALLOT_L1_CHAIN_ID: process.env["BALLOT_L1_CHAIN_ID"],
  BALLOT_ANCHOR_ADDRESS: process.env["BALLOT_ANCHOR_ADDRESS"],
  BALLOT_ANCHOR_DEADLINE: process.env["BALLOT_ANCHOR_DEADLINE"],
});

const pollCreationConfig = pollCreationFromEnv(
  Object.fromEntries(
    [...POLL_CREATE_ENV, POLL_CREATE_CEILING_ENV].map((name) => [name, process.env[name]]),
  ),
  CREATE_DAILY_CEILING,
);
const tier1Config = tier1FromEnv(
  Object.fromEntries(TIER1_ENV.map((name) => [name, process.env[name]])),
);
const anchorConfig = anchorFromEnv(
  Object.fromEntries([...ANCHOR_ENV, ANCHOR_EVERY_ENV].map((name) => [name, process.env[name]])),
);
// T-65: read once; nothing later in the process, or anything it spawns,
// finds the key in its environment. The relay's key and the anchoring
// runner's keys are treated the same.
delete process.env["CREATE_KEY"];
delete process.env["TIER1_RELAY_KEY"];
delete process.env["ANCHOR_OWNER_KEYS"];
delete process.env["ANCHOR_EXECUTOR_KEY"];
// The creation key runs alone (ADR 0032, rule 2): refused before any other
// job's chain is touched, as startWorker refuses it too.
if (
  pollCreationConfig !== undefined &&
  [
    env.BALLOT_PINNED_PANELS,
    env.BALLOT_ANCHOR_EPOCH,
    env.BALLOT_ANCHOR_PERIOD,
    env.BALLOT_ANCHOR_ADDRESS,
    env.BALLOT_ANCHOR_DEADLINE,
    ...TIER0_ENV.map((name) => process.env[name]),
    ...TIER1_ENV.map((name) => process.env[name]),
    ...REGISTRY_SYNC_ENV.map((name) => process.env[name]),
    ...POLL_ROOT_ENV.map((name) => process.env[name]),
    ...POLL_STUB_ENV.map((name) => process.env[name]),
    ...ANCHOR_ENV.map((name) => process.env[name]),
  ].some((v) => v !== undefined && v !== "")
)
  throw new Error("a worker holding the creation key runs nothing else");

let ballots: WorkerOptions["ballots"];
let openings: WorkerOptions["openings"];
const ballotEnv = [env.BALLOT_PINNED_PANELS, env.BALLOT_ANCHOR_EPOCH, env.BALLOT_ANCHOR_PERIOD];
if (env.BALLOT_L1_RPC_URL !== undefined || env.BALLOT_L1_CHAIN_ID !== undefined) {
  if (ballotEnv.some((v) => v === undefined))
    throw new Error("the ballot L1 check needs ballot admission configured");
}
if (env.BALLOT_ANCHOR_ADDRESS !== undefined || env.BALLOT_ANCHOR_DEADLINE !== undefined) {
  if (env.BALLOT_ANCHOR_ADDRESS === undefined || env.BALLOT_ANCHOR_DEADLINE === undefined)
    throw new Error("BALLOT_ANCHOR_ADDRESS and BALLOT_ANCHOR_DEADLINE go together");
  if (env.BALLOT_L1_RPC_URL === undefined || ballotEnv.some((v) => v === undefined))
    throw new Error("tally openings need ballot admission and its L1 node configured");
}
if (ballotEnv.some((v) => v !== undefined)) {
  if (
    env.BALLOT_PINNED_PANELS === undefined ||
    env.BALLOT_ANCHOR_EPOCH === undefined ||
    env.BALLOT_ANCHOR_PERIOD === undefined
  )
    throw new Error(
      "BALLOT_PINNED_PANELS, BALLOT_ANCHOR_EPOCH and BALLOT_ANCHOR_PERIOD go together",
    );
  let l1: L1References | undefined;
  if ((env.BALLOT_L1_RPC_URL === undefined) !== (env.BALLOT_L1_CHAIN_ID === undefined))
    throw new Error("BALLOT_L1_RPC_URL and BALLOT_L1_CHAIN_ID go together");
  if (env.BALLOT_L1_RPC_URL !== undefined && env.BALLOT_L1_CHAIN_ID !== undefined) {
    // Each read gives up within L1References' own budget; viem's retries
    // would only spend it.
    const client = createPublicClient({
      transport: http(env.BALLOT_L1_RPC_URL, { timeout: 2_000, retryCount: 0 }),
    });
    let source;
    try {
      source = await ViemL1Source.connect(client, BigInt(env.BALLOT_L1_CHAIN_ID));
    } catch (e) {
      // viem's errors quote the URL.
      if (e instanceof BaseError) throw new Error("the ballot L1 check couldn't reach the node");
      throw e;
    }
    l1 = new L1References({ source });
  }
  const panels = pinnedPanels(env.BALLOT_PINNED_PANELS);
  const clock = {
    epoch: BigInt(env.BALLOT_ANCHOR_EPOCH),
    period: BigInt(env.BALLOT_ANCHOR_PERIOD),
  };
  ballots = {
    admissions: new BallotAdmissions({ panels, clock, ...(l1 !== undefined && { l1 }) }),
  };
  // The tally openings' boarding (P2-13 part 5b-2b-3b-2b-2), only once the
  // node is on the definitions' chain and the anchor there fixes this
  // clock, so the counted extent is judged as the anchor and the verifier
  // judge it (T-29, T-49, T-53). Its reads may take longer than the ballot
  // check's: a header run is many requests, each of which may take 60 s
  // (apps/node's `RPC_TIMEOUT_MS`).
  if (
    env.BALLOT_ANCHOR_ADDRESS !== undefined &&
    env.BALLOT_ANCHOR_DEADLINE !== undefined &&
    env.BALLOT_L1_RPC_URL !== undefined &&
    env.BALLOT_L1_CHAIN_ID !== undefined
  ) {
    const chainId = BigInt(env.BALLOT_L1_CHAIN_ID);
    const anchor = getAddress(env.BALLOT_ANCHOR_ADDRESS);
    const anchorClock = { ...clock, deadline: BigInt(env.BALLOT_ANCHOR_DEADLINE) };
    const client = createPublicClient({
      transport: http(env.BALLOT_L1_RPC_URL, { timeout: 30_000 }),
    });
    let headers;
    try {
      await checkAnchorClock(client, { chainId, anchor, clock: anchorClock });
      headers = await RpcL1HeaderRun.connect(
        rpcClient(parseRpcUrl(env.BALLOT_L1_RPC_URL)),
        chainId,
      );
    } catch (e) {
      // viem's errors quote the URL; apps/node's name only the method.
      if (e instanceof BaseError)
        throw new Error("the tally openings' anchor check couldn't reach the node");
      throw e;
    }
    openings = {
      boardings: new OpeningBoardings({
        tally: anchoredCountedTally({
          panels,
          anchor: new ViemAnchorReader({ client, chainId, anchor, clock: anchorClock }),
          l1: headers,
        }),
        target: openingTargets(panels),
        clock,
      }),
    };
  }
}

const tier0Config = tier0FromEnv(
  Object.fromEntries(TIER0_ENV.map((name) => [name, process.env[name]])),
);

// T-69, T-62: the Safe's owner keys never share a process with a relay's
// keys, refused before either chain is touched, as startWorker refuses it.
if (
  anchorConfig !== undefined &&
  [...TIER0_ENV, ...TIER1_ENV].some(
    (name) => process.env[name] !== undefined && process.env[name] !== "",
  )
)
  throw new Error("a worker holding the anchoring keys runs no relay");

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
// BullMQ's workers block on Redis, so commands must wait out a reconnect
// rather than fail after a retry count.
const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

// The Tier 0 batch job (docs/spec/registration.md, The batch), only when
// configured: it starts only once the registry, the account and the
// paymaster are the configured ones, so a misconfigured job signs nothing
// (T-06, T-62). Each HTTP attempt times out after 30 s; a read that runs
// past core's batch lock loses its writes to the lock's fence. The URLs can
// carry a provider's API key, which viem's errors quote, so a failure here
// is reported by step only.
let tier0: WorkerOptions["tier0"];
if (tier0Config !== undefined) {
  const c = tier0Config;
  const client = createPublicClient({ transport: http(c.l2RpcUrl, { timeout: 30_000 }) });
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (e) {
      // The checks' own errors name the mismatch and nothing secret; viem's
      // quote the URL.
      if (e instanceof BaseError)
        throw new Error(`the Tier 0 job's ${name} couldn't reach the chain`);
      throw e;
    }
  };
  await step("deployment check", () =>
    checkTier0Deployment(client, {
      chainId: c.chainId,
      registry: c.registry,
      fromBlock: c.registryBlock,
      registrars: c.registrars,
      threshold: c.threshold,
      signers: c.signers,
    }),
  );
  const submit = await step("bundler check", () =>
    connectTier0Bundler({
      client,
      bundler: http(c.bundlerUrl, { timeout: 30_000, retryCount: 0 })({}).request,
      chainId: c.chainId,
      entryPoint: c.entryPoint,
      account: c.account,
      ownerKey: c.accountKey,
      paymaster: c.paymaster,
      registry: c.registry,
    }),
  );
  const bytes = (a: string) => Uint8Array.from(Buffer.from(a.slice(2), "hex"));
  tier0 = {
    batches: new Tier0Batches({
      redis: connection,
      chain: new ViemTier0Chain({
        client,
        registry: c.registry,
        fromBlock: c.registryBlock,
        submit,
      }),
      groups: new Map([[0, c.group]]),
      chainId: c.chainId,
      registry: bytes(c.registry),
      registrars: c.registrars.map(bytes),
      threshold: c.threshold,
      signers: c.signers,
      now: () => Math.floor(Date.now() / 1000),
    }),
  };
}

// The Tier 1 relay's job (docs/spec/tier1-relay.md, The batch), only when
// configured: it starts only once the registry and the published group are
// the configured ones, so a misconfigured relay pays for nothing (T-52,
// T-53). As Tier 0's, each HTTP attempt times out after 30 s, and a failure
// here is reported by step only, since viem's errors quote the URL.
let tier1: WorkerOptions["tier1"];
if (tier1Config !== undefined) {
  const c = tier1Config;
  const client = createPublicClient({ transport: http(c.l2RpcUrl, { timeout: 30_000 }) });
  try {
    await checkTier1Deployment(client, {
      chainId: c.chainId,
      registry: c.registry,
      fromBlock: c.registryBlock,
      registrars: c.registrars,
      threshold: c.threshold,
      group: c.group,
    });
  } catch (e) {
    if (e instanceof BaseError)
      throw new Error("the Tier 1 relay's deployment check couldn't reach the chain");
    throw e;
  }
  const bytes = (a: string) => Uint8Array.from(Buffer.from(a.slice(2), "hex"));
  tier1 = {
    batches: new Tier1Batches({
      redis: connection,
      chain: new ViemTier1Chain({
        client,
        chainId: c.chainId,
        registry: c.registry,
        fromBlock: c.registryBlock,
        key: c.relayKey,
        maxFeePerGas: c.maxFeePerGas,
      }),
      groups: new Map([[0, c.group]]),
      chainId: c.chainId,
      registry: bytes(c.registry),
      registrars: c.registrars.map(bytes),
      threshold: c.threshold,
      version: c.eventVersion,
      now: () => Math.floor(Date.now() / 1000),
    }),
  };
}

// The registry sync (P3-5 parts 3a and 3b), only when configured: it reads
// the indexer's database as a role that can only read it, and starts only
// once the L1 and L2 nodes are on the configured chains. viem's errors quote
// the nodes' URLs, and postgres' can quote the index's, so none is reported.
let registry: WorkerOptions["registry"];
let pollRoots: WorkerOptions["pollRoots"];
let index: postgres.Sql | undefined;
const registryConfig = registrySyncFromEnv(
  Object.fromEntries(REGISTRY_SYNC_ENV.map((name) => [name, process.env[name]])),
);
// The roots step (P2-22 part 3b-2) reads with the registry sync's index,
// nodes and group registry, so it runs only beside it.
const pollRootConfig = pollRootFromEnv(
  Object.fromEntries(POLL_ROOT_ENV.map((name) => [name, process.env[name]])),
);
if (pollRootConfig !== undefined && registryConfig === undefined)
  throw new Error("the roots step runs only beside the registry sync");
// The stub step (P2-22 part 4b) pins the registry sync's deployment, so it
// runs only beside it too.
const pollStubConfig = pollStubFromEnv(
  Object.fromEntries(POLL_STUB_ENV.map((name) => [name, process.env[name]])),
);
if (pollStubConfig !== undefined && registryConfig === undefined)
  throw new Error("the stub step runs only beside the registry sync");
let pollStubs: WorkerOptions["pollStubs"];
if (registryConfig !== undefined) {
  const c = registryConfig;
  let accumulator;
  const l2 = createPublicClient({ transport: http(c.l2RpcUrl, { timeout: 30_000 }) });
  try {
    const roots = await DisputeGameRoots.connect(
      createPublicClient({ transport: http(c.l1RpcUrl, { timeout: 30_000 }) }),
      c.l1ChainId,
      c.portal,
    );
    accumulator = await ProvenRegistryAccumulator.connect(l2, c.chainId, roots);
  } catch (e) {
    if (e instanceof BaseError) throw new Error("the registry sync couldn't reach its nodes");
    throw e;
  }
  if (pollStubConfig !== undefined) {
    let deployment;
    try {
      deployment = await pollStubDeployment(
        l2,
        {
          chainId: c.chainId,
          l1ChainId: c.l1ChainId,
          electionRegistry: c.electionRegistry,
          board: c.board,
          trusteeRegistry: c.trusteeRegistry,
          groupRegistry: c.groupRegistry,
          eventVersion: c.eventVersion,
        },
        pollStubConfig,
      );
    } catch (e) {
      if (e instanceof BaseError) throw new Error("the stub step couldn't reach the L2 node");
      throw e;
    }
    // The opening step boards each transcript by the clock of the anchor
    // every stub pins, read from its finalized code on L1, never configured
    // (docs/spec/board.md, Timing).
    try {
      const clock = await checkCreationAnchorsDeployment(
        createPublicClient({ transport: http(c.l1RpcUrl, { timeout: 30_000 }) }),
        { chainId: c.l1ChainId, anchor: `0x${Buffer.from(deployment.l1Anchor).toString("hex")}` },
      );
      pollStubs = { deployment, clock: { anchor: deployment.l1Anchor, ...clock } };
    } catch (e) {
      if (e instanceof BaseError) throw new Error("the opening step couldn't reach the L1 node");
      throw e;
    }
  }
  const bytes = (a: string) => Uint8Array.from(Buffer.from(a.slice(2), "hex"));
  index = postgres(c.indexUrl, { onnotice: () => {}, max: 1 });
  registry = {
    sync: new RegistrySync({
      sql,
      index,
      indexSchema: c.indexSchema,
      accumulator,
      deployment: {
        chainId: c.chainId,
        contracts: {
          electionRegistry: bytes(c.electionRegistry),
          trusteeRegistry: bytes(c.trusteeRegistry),
          groupRegistry: bytes(c.groupRegistry),
          board: bytes(c.board),
        },
        version: c.eventVersion,
      },
    }),
  };
  if (pollRootConfig !== undefined)
    pollRoots = {
      roots: new PollRoots({
        sql,
        index,
        indexSchema: c.indexSchema,
        accumulator,
        chainId: c.chainId,
        deployment: {
          groups: pollRootConfig.groups,
          pins: {
            version: c.eventVersion,
            chainId: c.chainId,
            registry: bytes(c.groupRegistry),
            registrars: pollRootConfig.registrars.map(bytes),
            threshold: pollRootConfig.threshold,
          },
        },
      }),
    };
}

// The creation step (ADR 0032, P2-22 parts 3a, 3b-1 and 5b), only when
// configured, and only once the L2 node is on the configured chain with a
// registry our definitions can name, whose trustee registry pins the
// default panel, and the L1 node on its chain with the
// anchor whose clock the per-slot check reads by. The URLs can carry a
// provider's API key, which viem's errors quote, so a failure here is
// reported by step only.
let pollCreation: WorkerOptions["pollCreation"];
if (pollCreationConfig !== undefined) {
  const c = pollCreationConfig;
  const client = createPublicClient({ transport: http(c.l2RpcUrl, { timeout: 30_000 }) });
  const l1 = createPublicClient({ transport: http(c.l1RpcUrl, { timeout: 30_000 }) });
  let clock;
  let trusteeRegistry;
  try {
    ({ trusteeRegistry } = await checkPollCreationDeployment(client, {
      chainId: c.chainId,
      registry: c.registry,
      l1ChainId: c.l1ChainId,
      anchor: c.anchor,
      panel: c.panel,
    }));
  } catch (e) {
    if (e instanceof BaseError) throw new Error("the creation step couldn't reach the chain");
    throw e;
  }
  try {
    clock = await checkCreationAnchorsDeployment(l1, { chainId: c.l1ChainId, anchor: c.anchor });
  } catch (e) {
    if (e instanceof BaseError) throw new Error("the creation step couldn't reach L1");
    throw e;
  }
  pollCreation = {
    chain: new ViemPollCreationChain({
      client,
      chainId: c.chainId,
      registry: c.registry,
      trusteeRegistry,
      key: c.key,
    }),
    dailyCeiling: c.dailyCeiling,
    anchors: new ViemCreationAnchors({ client: l1, anchor: c.anchor, clock }),
    panel: c.panel,
  };
}

// The anchoring runner (P4-1 part 2b-2b-1), only when configured: it starts
// only once the anchor's finalized code fixes the configured clock and Safe
// and the Safe is exactly the deployment record's (T-49, T-69). Each HTTP
// attempt times out after 30 s, well within the run's schedule; a failure
// here is reported by step only, since viem's errors quote the URL.
let anchor: WorkerOptions["anchor"];
if (anchorConfig !== undefined) {
  const c = anchorConfig;
  const client = createPublicClient({ transport: http(c.l1RpcUrl, { timeout: 30_000 }) });
  try {
    anchor = { chain: await connectAnchorRunner(client, c), everyMs: c.everyMs };
  } catch (e) {
    if (e instanceof BaseError)
      throw new Error("the anchoring runner's startup check couldn't reach L1");
    throw e;
  }
}

const worker = await startWorker({
  connection,
  sql,
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  auditEveryMs: env.AUDIT_EVERY_MS,
  ...(anchor !== undefined && { anchor }),
  ...(tier0 !== undefined && { tier0 }),
  ...(tier1 !== undefined && { tier1 }),
  ...(ballots !== undefined && { ballots }),
  ...(openings !== undefined && { openings }),
  ...(registry !== undefined && { registry }),
  ...(pollRoots !== undefined && { pollRoots }),
  ...(pollStubs !== undefined && { pollStubs }),
  ...(pollCreation !== undefined && { pollCreation }),
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    worker
      .close()
      .then(() => Promise.all([sql.end(), index?.end(), connection.quit()]))
      .catch(() => process.exit(1));
  });
