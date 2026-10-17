import { CREATE_DAILY_CEILING, creationKeyRecords } from "@abolishus/core";
import postgres from "postgres";
import {
  BaseError,
  createPublicClient,
  hexToBytes,
  http,
  WaitForTransactionReceiptTimeoutError,
} from "viem";
import * as z from "zod";
import {
  creationKeyChainState,
  creationKeyReport,
  parseCreationKeyCommand,
  sweepCreationKey,
} from "./creation-key.ts";
import { checkPollCreationDeployment } from "./poll-create-chain.ts";
import {
  POLL_CREATE_CEILING_ENV,
  POLL_CREATE_ENV,
  pollCreationFromEnv,
} from "./poll-create-env.ts";

// The creation key's operator commands (creation-key.ts; the poll-creation
// runbook): `vp run --filter @abolishus/worker creation-key status`, or
// `… creation-key sweep <funding address>`, run in the `worker-create`
// service with its variables. Each prints one JSON object. The L2 node's URL
// can carry a provider's API key, which viem's errors quote, so a failure
// to reach it is reported without the error (T-65).

async function main(): Promise<void> {
  const command = parseCreationKeyCommand(process.argv.slice(2));
  const config = pollCreationFromEnv(
    Object.fromEntries(
      [...POLL_CREATE_ENV, POLL_CREATE_CEILING_ENV].map((name) => [name, process.env[name]]),
    ),
    CREATE_DAILY_CEILING,
  );
  // T-65: as in main.ts, nothing later finds the key in the environment.
  delete process.env["CREATE_KEY"];
  if (config === undefined)
    throw new Error("the creation key's commands need the creation step's variables");
  const client = createPublicClient({ transport: http(config.l2RpcUrl, { timeout: 30_000 }) });
  // The key is used only against the registry it creates on, on its chain.
  await checkPollCreationDeployment(client, {
    chainId: config.chainId,
    registry: config.registry,
    l1ChainId: config.l1ChainId,
    anchor: config.anchor,
    panel: config.panel,
  });

  // Both commands read the creation step's ledger.
  const url = z.url({ protocol: /^postgres(?:ql)?$/ }).safeParse(process.env["DATABASE_URL"]);
  if (!url.success) throw new Error("the creation key's commands need DATABASE_URL");
  const sql = postgres(url.data, { onnotice: () => {}, max: 1 });
  try {
    if (command.command === "status") {
      const chain = await creationKeyChainState(client, config);
      const records = await creationKeyRecords(
        sql,
        hexToBytes(chain.address),
        chain.nonces,
        new Date(),
      );
      process.stdout.write(
        `${JSON.stringify(creationKeyReport(chain, records, config.dailyCeiling), null, 2)}\n`,
      );
      return;
    }
    const sweep = await sweepCreationKey({
      client,
      sql,
      chainId: config.chainId,
      key: config.key,
      to: command.to,
    });
    // The hash first, so an operator has it even if the wait gives up.
    process.stdout.write(
      `${JSON.stringify({ hash: sweep.hash, value: sweep.value.toString(), to: command.to })}\n`,
    );
    let receipt;
    try {
      receipt = await client.waitForTransactionReceipt({ hash: sweep.hash, timeout: 300_000 });
    } catch (e) {
      // Sent, so not a refusal: a second run refuses while it is pending.
      if (e instanceof WaitForTransactionReceiptTimeoutError)
        throw new Error("the sweep was sent and isn't included after five minutes; check its hash");
      throw e;
    }
    process.stdout.write(
      `${JSON.stringify({ status: receipt.status, block: receipt.blockNumber.toString() })}\n`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((e: unknown) => {
  process.stderr.write(
    `${e instanceof BaseError ? "the L2 node refused or couldn't be reached" : (e as Error).message}\n`,
  );
  process.exit(1);
});
