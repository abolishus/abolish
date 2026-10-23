import {
  BallotAdmissions,
  PostgresPostingDeposits,
  PostgresPostingElections,
  PostgresPostingLedger,
  PostingWorker,
} from "@abolishus/core";
import { Redis } from "ioredis";
import postgres from "postgres";
import { BaseError, bytesToHex, createPublicClient, http } from "viem";
import { privateKeyToAddress } from "viem/accounts";
import * as z from "zod";
import { ANCHOR_ENV, ANCHOR_EVERY_ENV } from "./anchor-env.ts";
import { pinnedPanels } from "./ballot-env.ts";
import { POLL_CREATE_CEILING_ENV, POLL_CREATE_ENV } from "./poll-create-env.ts";
import { POLL_ROOT_ENV } from "./poll-root-env.ts";
import { POLL_STUB_ENV } from "./poll-stub-env.ts";
import { checkPostingDeployment, ViemPostingChain } from "./posting-chain.ts";
import { POSTING_ENV, postingFromEnv } from "./posting-env.ts";
import {
  checkPostingL1,
  postingDepositChain,
  ViemPostingL1,
  ViemPostingRegistry,
} from "./posting-l1.ts";
import { startPostingRunner } from "./posting-runner.ts";
import { REGISTRY_SYNC_ENV } from "./registry-env.ts";
import { TIER0_ENV } from "./tier0-env.ts";
import { TIER1_ENV } from "./tier1-env.ts";

// The posting worker's entry point (docs/spec/posting-relay.md, Roles; ADR
// 0042, option A; P2-8 part 3c-1b-2b-2b-2d-2b-2b-2b-2b-2b-2): a deployment of
// its own, the only one holding the posting key, which runs the queue's
// tick, the ledger's tend and its prune and nothing else (posting-runner.ts).
// and the forced path's deposits on L1 (part 2b-2b-2b-2b-3b-2). It reads
// Postgres as a user granted abolish_app (never the owner) and the relay's
// own store, never the other workers' Redis, whose BullMQ queues persist
// (T-18). It refuses to start beside any other job's variable, so the key
// never shares a process with another job's secrets or chain (T-69), and
// before anything is read unless the L2 node, the board and the key's
// account pass `checkPostingDeployment`, and the L1 node, the relay the
// registry names, its portal and the key's L1 account pass `checkPostingL1`.

const OTHERS = [
  "REDIS_URL",
  "AUDIT_EVERY_MS",
  "BALLOT_L1_RPC_URL",
  "BALLOT_L1_CHAIN_ID",
  ...POLL_CREATE_ENV,
  POLL_CREATE_CEILING_ENV,
  ...TIER0_ENV,
  ...TIER1_ENV,
  ...REGISTRY_SYNC_ENV,
  ...POLL_ROOT_ENV,
  ...POLL_STUB_ENV,
  ...ANCHOR_ENV,
  ANCHOR_EVERY_ENV,
] as const;

const config = postingFromEnv(
  Object.fromEntries(POSTING_ENV.map((name) => [name, process.env[name]])),
);
if (config === undefined)
  throw new Error(`the posting worker needs every one of ${POSTING_ENV.join(", ")}`);
// T-69: read once; nothing later in the process, or anything it spawns,
// finds the key in its environment.
delete process.env["POSTING_KEY"];
if (OTHERS.some((name) => process.env[name] !== undefined && process.env[name] !== ""))
  throw new Error("the posting worker runs nothing else");

const Env = z.strictObject({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  // Admission as the route's and the ballot queue's: the panels the release
  // pins and the anchoring clock of the anchor our definitions name.
  BALLOT_PINNED_PANELS: z.string().min(1),
  BALLOT_ANCHOR_EPOCH: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  BALLOT_ANCHOR_PERIOD: z.string().regex(/^[1-9][0-9]{0,19}$/),
});

const env = Env.parse({
  DATABASE_URL: process.env["DATABASE_URL"],
  BALLOT_PINNED_PANELS: process.env["BALLOT_PINNED_PANELS"],
  BALLOT_ANCHOR_EPOCH: process.env["BALLOT_ANCHOR_EPOCH"],
  BALLOT_ANCHOR_PERIOD: process.env["BALLOT_ANCHOR_PERIOD"],
});
const panels = pinnedPanels(env.BALLOT_PINNED_PANELS);

// Each HTTP attempt gives up well within the ledger's `POSTING_CHAIN_TIMEOUT_MS`
// (ten seconds); viem's retries would only spend it.
const client = createPublicClient({
  transport: http(config.l2RpcUrl, { timeout: 5_000, retryCount: 0 }),
});
const l1Client = createPublicClient({
  transport: http(config.l1RpcUrl, { timeout: 5_000, retryCount: 0 }),
});

// The check's own errors name the mismatch and nothing secret; viem's quote
// the URL, which can carry a provider's key.
const checked = async <T>(node: "L1" | "L2", check: () => Promise<T>): Promise<T> => {
  try {
    return await check();
  } catch (e) {
    if (e instanceof BaseError)
      throw new Error(`the posting worker's startup check couldn't reach the ${node} node`);
    throw e;
  }
};
const address = privateKeyToAddress(bytesToHex(config.key));
const deployment = await checked("L2", () =>
  checkPostingDeployment(client, {
    chainId: config.chainId,
    board: config.board,
    fromBlock: config.boardBlock,
    address,
  }),
);
const portal = await checked("L1", () =>
  checkPostingL1(l1Client, {
    l1ChainId: deployment.l1ChainId,
    l1Relay: deployment.l1Relay,
    board: config.board,
    address,
  }),
);
const l1 = new ViemPostingL1({
  client: l1Client,
  chainId: deployment.l1ChainId,
  portal,
  board: config.board,
  key: config.key,
  l1FeeCap: config.l1FeeCap,
});
const chain = new ViemPostingChain({
  client,
  chainId: config.chainId,
  board: config.board,
  fromBlock: config.boardBlock,
  key: config.key,
  deposits: l1,
});

const sql = postgres(env.DATABASE_URL, { onnotice: () => {} });
// Failing fast, as the API's side of the store: a tick that can't reach it
// leaves every pair queued and the index to age out.
const redis = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  commandTimeout: 1000,
});
// Its errors can quote a script's arguments, a pair among them (T-11, T-18).
redis.on("error", () => process.stdout.write(`${JSON.stringify({ error: "posting-redis" })}\n`));

const now = () => Math.floor(Date.now() / 1000);
const ledger = new PostgresPostingLedger({
  sql,
  chain,
  budget: config.budget,
  feeCap: config.feeCap,
  now,
});
const deposits = new PostgresPostingDeposits({
  sql,
  chain: postingDepositChain(chain, l1),
  elections: new PostgresPostingElections({
    sql,
    registry: new ViemPostingRegistry({
      client,
      registry: deployment.registry,
      fromBlock: config.boardBlock,
    }),
    now,
  }),
  budget: config.budget,
  l1FeeCap: config.l1FeeCap,
  now,
});
const runner = startPostingRunner({
  worker: new PostingWorker({
    sql,
    redis,
    chain,
    ledger,
    admissions: new BallotAdmissions({
      panels,
      clock: { epoch: BigInt(env.BALLOT_ANCHOR_EPOCH), period: BigInt(env.BALLOT_ANCHOR_PERIOD) },
    }),
    now,
  }),
  ledger,
  chain,
  deposits,
  l1,
  log: (line) => process.stdout.write(`${JSON.stringify(line)}\n`),
});

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    runner
      .close()
      .then(() => Promise.all([sql.end(), redis.quit()]))
      .catch(() => process.exit(1));
  });
