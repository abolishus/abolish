import { BallotAdmissions, Tier0Batches } from "@abolishus/core";
import { Redis } from "ioredis";
import postgres from "postgres";
import { BaseError, createPublicClient, http } from "viem";
import * as z from "zod";
import { connectTier0Bundler } from "./tier0-bundler.ts";
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
});

let ballots: WorkerOptions["ballots"];
const ballotEnv = [env.BALLOT_PINNED_PANELS, env.BALLOT_ANCHOR_EPOCH, env.BALLOT_ANCHOR_PERIOD];
if (ballotEnv.some((v) => v !== undefined)) {
  if (
    env.BALLOT_PINNED_PANELS === undefined ||
    env.BALLOT_ANCHOR_EPOCH === undefined ||
    env.BALLOT_ANCHOR_PERIOD === undefined
  )
    throw new Error(
      "BALLOT_PINNED_PANELS, BALLOT_ANCHOR_EPOCH and BALLOT_ANCHOR_PERIOD go together",
    );
  ballots = {
    admissions: new BallotAdmissions({
      panels: Panels.parse(JSON.parse(env.BALLOT_PINNED_PANELS)).map((p) => ({
        threshold: p.threshold,
        keys: p.keys.map((k) => new Uint8Array(Buffer.from(k, "hex"))),
      })),
      clock: { epoch: BigInt(env.BALLOT_ANCHOR_EPOCH), period: BigInt(env.BALLOT_ANCHOR_PERIOD) },
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

const worker = await startWorker({
  connection,
  sql,
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
  auditEveryMs: env.AUDIT_EVERY_MS,
  ...(tier0 !== undefined && { tier0 }),
  ...(ballots !== undefined && { ballots }),
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    worker
      .close()
      .then(() => Promise.all([sql.end(), connection.quit()]))
      .catch(() => process.exit(1));
  });
