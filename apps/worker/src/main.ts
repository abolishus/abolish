import {
  BallotAdmissions,
  CREATE_DAILY_CEILING,
  L1References,
  Tier0Batches,
} from "@abolishus/core";
import { Redis } from "ioredis";
import postgres from "postgres";
import { BaseError, createPublicClient, http } from "viem";
import * as z from "zod";
import { registrySyncFromEnv, REGISTRY_SYNC_ENV } from "./registry-env.ts";
import { RegistrySync, ViemRegistryAccumulator } from "./registry-sync.ts";
import { connectTier0Bundler } from "./tier0-bundler.ts";
import { ViemL1Source } from "./l1-source.ts";
import { checkPollCreationDeployment, ViemPollCreationChain } from "./poll-create-chain.ts";
import {
  POLL_CREATE_CEILING_ENV,
  POLL_CREATE_ENV,
  pollCreationFromEnv,
} from "./poll-create-env.ts";
import { checkTier0Deployment, ViemTier0Chain } from "./tier0-chain.ts";
import { TIER0_ENV, tier0FromEnv } from "./tier0-env.ts";
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
});

const Panels = z
  .array(
    z.strictObject({
      threshold: z.number().int().min(1),
      keys: z.array(z.string().regex(/^(?:[0-9a-f]{2})+$/)).min(1),
    }),
  )
  .min(1);

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  REDIS_URL: process.env["REDIS_URL"],
  AUDIT_EVERY_MS: process.env["AUDIT_EVERY_MS"],
  BALLOT_PINNED_PANELS: process.env["BALLOT_PINNED_PANELS"],
  BALLOT_ANCHOR_EPOCH: process.env["BALLOT_ANCHOR_EPOCH"],
  BALLOT_ANCHOR_PERIOD: process.env["BALLOT_ANCHOR_PERIOD"],
  BALLOT_L1_RPC_URL: process.env["BALLOT_L1_RPC_URL"],
  BALLOT_L1_CHAIN_ID: process.env["BALLOT_L1_CHAIN_ID"],
});

const pollCreationConfig = pollCreationFromEnv(
  Object.fromEntries(
    [...POLL_CREATE_ENV, POLL_CREATE_CEILING_ENV].map((name) => [name, process.env[name]]),
  ),
  CREATE_DAILY_CEILING,
);
// T-65: read once; nothing later in the process, or anything it spawns,
// finds the key in its environment.
delete process.env["CREATE_KEY"];
// The creation key runs alone (ADR 0032, rule 2): refused before any other
// job's chain is touched, as startWorker refuses it too.
if (
  pollCreationConfig !== undefined &&
  [
    env.BALLOT_PINNED_PANELS,
    env.BALLOT_ANCHOR_EPOCH,
    env.BALLOT_ANCHOR_PERIOD,
    ...TIER0_ENV.map((name) => process.env[name]),
    ...REGISTRY_SYNC_ENV.map((name) => process.env[name]),
  ].some((v) => v !== undefined && v !== "")
)
  throw new Error("a worker holding the creation key runs nothing else");

let ballots: WorkerOptions["ballots"];
const ballotEnv = [env.BALLOT_PINNED_PANELS, env.BALLOT_ANCHOR_EPOCH, env.BALLOT_ANCHOR_PERIOD];
if (env.BALLOT_L1_RPC_URL !== undefined || env.BALLOT_L1_CHAIN_ID !== undefined) {
  if (ballotEnv.some((v) => v === undefined))
    throw new Error("the ballot L1 check needs ballot admission configured");
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
  ballots = {
    admissions: new BallotAdmissions({
      panels: Panels.parse(JSON.parse(env.BALLOT_PINNED_PANELS)).map((p) => ({
        threshold: p.threshold,
        keys: p.keys.map((k) => new Uint8Array(Buffer.from(k, "hex"))),
      })),
      clock: { epoch: BigInt(env.BALLOT_ANCHOR_EPOCH), period: BigInt(env.BALLOT_ANCHOR_PERIOD) },
      ...(l1 !== undefined && { l1 }),
    }),
  };
}

const tier0Config = tier0FromEnv(
  Object.fromEntries(TIER0_ENV.map((name) => [name, process.env[name]])),
);

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

// The registry sync (P3-5 part 3a), only when configured: it reads the
// indexer's database as a role that can only read it, and starts only once
// the L2 node is on the configured chain. viem's errors quote the node's
// URL, and postgres' can quote the index's, so neither is reported.
let registry: WorkerOptions["registry"];
let index: postgres.Sql | undefined;
const registryConfig = registrySyncFromEnv(
  Object.fromEntries(REGISTRY_SYNC_ENV.map((name) => [name, process.env[name]])),
);
if (registryConfig !== undefined) {
  const c = registryConfig;
  let accumulator;
  try {
    accumulator = await ViemRegistryAccumulator.connect(
      createPublicClient({ transport: http(c.l2RpcUrl, { timeout: 30_000 }) }),
      c.chainId,
    );
  } catch (e) {
    if (e instanceof BaseError) throw new Error("the registry sync couldn't reach the L2 node");
    throw e;
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
}

// The creation step (ADR 0032, P2-22 part 3a), only when configured, and
// only once the node is on the configured chain and the registry is one our
// definitions can name. The URL can carry a provider's API key, which viem's
// errors quote, so a failure here is reported by step only.
let pollCreation: WorkerOptions["pollCreation"];
if (pollCreationConfig !== undefined) {
  const c = pollCreationConfig;
  const client = createPublicClient({ transport: http(c.l2RpcUrl, { timeout: 30_000 }) });
  try {
    await checkPollCreationDeployment(client, { chainId: c.chainId, registry: c.registry });
  } catch (e) {
    if (e instanceof BaseError) throw new Error("the creation step couldn't reach the chain");
    throw e;
  }
  pollCreation = {
    chain: new ViemPollCreationChain({
      client,
      chainId: c.chainId,
      registry: c.registry,
      key: c.key,
    }),
    dailyCeiling: c.dailyCeiling,
  };
}

const worker = await startWorker({
  connection,
  sql,
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  auditEveryMs: env.AUDIT_EVERY_MS,
  ...(tier0 !== undefined && { tier0 }),
  ...(ballots !== undefined && { ballots }),
  ...(registry !== undefined && { registry }),
  ...(pollCreation !== undefined && { pollCreation }),
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    worker
      .close()
      .then(() => Promise.all([sql.end(), index?.end(), connection.quit()]))
      .catch(() => process.exit(1));
  });
