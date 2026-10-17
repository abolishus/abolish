import { Tier0Batches } from "@abolishus/core";
import { Redis } from "ioredis";
import postgres from "postgres";
import { createPublicClient, http } from "viem";
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
});

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  REDIS_URL: process.env["REDIS_URL"],
  AUDIT_EVERY_MS: process.env["AUDIT_EVERY_MS"],
});

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
// (T-06, T-62). Each HTTP call times out well within core's batch lock.
let tier0: WorkerOptions["tier0"];
if (tier0Config !== undefined) {
  const c = tier0Config;
  const client = createPublicClient({ transport: http(c.l2RpcUrl, { timeout: 30_000 }) });
  await checkTier0Deployment(client, {
    chainId: c.chainId,
    registry: c.registry,
    fromBlock: c.registryBlock,
    registrars: c.registrars,
    threshold: c.threshold,
    signers: c.signers,
  });
  const submit = await connectTier0Bundler({
    client,
    bundler: http(c.bundlerUrl, { timeout: 30_000, retryCount: 0 })({}).request,
    chainId: c.chainId,
    entryPoint: c.entryPoint,
    account: c.account,
    ownerKey: c.accountKey,
    paymaster: c.paymaster,
    registry: c.registry,
  });
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
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    worker
      .close()
      .then(() => Promise.all([sql.end(), connection.quit()]))
      .catch(() => process.exit(1));
  });
