// The node's command line: `keygen`, a seat's identity key; `run`, one
// seat's node against its coordinator; and `local-ceremony`, a whole
// ceremony between a local panel's nodes and a local coordinator over HTTP
// on loopback. Output is one JSON object per line, never a secret.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { encodeElectionDefinition, identityKey } from "@abolishus/crypto";
import { CeremonySeat } from "./ceremony.ts";
import { HttpCoordinator } from "./client.ts";
import { ConfigError, parseConfig, readIdentityKey } from "./config.ts";
import { LocalCoordinator, localStub, serveCoordinator } from "./local.ts";
import { type NodeEvent, TrusteeNode } from "./node.ts";
import { FileStore } from "./store.ts";
import type { ElectorateCheck } from "./stub.ts";

export interface CliIo {
  readonly out: (value: unknown) => void;
  readonly err: (value: unknown) => void;
  /** Aborts `run`; the process wires it to SIGINT and SIGTERM. */
  readonly signal: AbortSignal;
}

export const USAGE = [
  "usage: trustee-node keygen --out <file>",
  "       trustee-node run --config <file>",
  "       trustee-node local-ceremony [--seats <n>] [--threshold <k>] [--dir <path>]",
].join("\n");

const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))) as unknown;

/**
 * [[verifier]] 2.4 isn't built yet (P2-13 part 3), and a node must refuse a
 * stub it can't check (stub.ts), so a deployed node refuses every stub with
 * `stub-electorate` until it is.
 */
const NO_ELECTORATE_CHECK: ElectorateCheck = () => Promise.resolve(false);

/** Exit codes: 0 done, 2 bad usage or configuration, 1 a local ceremony that didn't register. */
export async function cli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "keygen") return await keygen(rest, io);
    if (command === "run") return await runNode(rest, io);
    if (command === "local-ceremony") return await localCeremony(rest, io);
  } catch (e) {
    if (e instanceof ConfigError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err({ error: (e as Error).message });
      return 2;
    }
    throw e;
  }
  io.err({ error: USAGE });
  return 2;
}

async function runNode(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { config: { type: "string" } },
    strict: true,
  });
  if (values.config === undefined) throw new ConfigError("run: --config is required");
  let text: string;
  try {
    text = await readFile(values.config, "utf8");
  } catch (e) {
    throw new ConfigError(`config: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  const config = parseConfig(text);
  const identitySecret = await readIdentityKey(config.identityKeyFile);
  const own = config.panel.keys[config.seat - 1] as Uint8Array;
  if (!Buffer.from(identityKey(identitySecret)).equals(Buffer.from(own)))
    throw new ConfigError("identity key: not the key of the configured seat");
  const seat = new CeremonySeat({
    panel: config.panel,
    l2ChainId: config.l2ChainId,
    trusteeRegistry: config.trusteeRegistry,
    index: config.seat,
    identitySecret,
    electorate: NO_ELECTORATE_CHECK,
    store: await FileStore.open(config.store),
  });
  const node = new TrusteeNode({
    seat,
    index: config.seat,
    coordinator: new HttpCoordinator(config.coordinator),
    log: (e: NodeEvent) => io.out(e),
  });
  io.out({ event: "started", seat: config.seat });
  await node.run(io.signal, config.pollSeconds * 1000);
  return 0;
}

/**
 * A fresh identity key in a new owner-only file (never over an existing
 * one), printing only its public key, for the panel's registration.
 */
async function keygen(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { out: { type: "string" } },
    strict: true,
  });
  if (values.out === undefined) throw new ConfigError("keygen: --out is required");
  const secret = crypto.getRandomValues(new Uint8Array(32));
  // `identityKey` rejects a secret outside the curve's scalar range.
  const key = identityKey(secret);
  try {
    await writeFile(values.out, `${Buffer.from(secret).toString("hex")}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (e) {
    throw new ConfigError(`keygen: ${(e as NodeJS.ErrnoException).code ?? "unwritable"}`);
  }
  io.out({ event: "keygen", identityKey: Buffer.from(key).toString("hex") });
  return 0;
}

const L2_CHAIN_ID = 31338n;
const TRUSTEE_REGISTRY = new Uint8Array(20).fill(0xa3);

async function localCeremony(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      seats: { type: "string", default: "7" },
      threshold: { type: "string", default: "4" },
      dir: { type: "string" },
    },
    strict: true,
  });
  const n = Number(values.seats);
  const k = Number(values.threshold);
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 2 || n > 16 || k < 1 || k > n)
    throw new ConfigError("local-ceremony: need 2 ≤ seats ≤ 16 and 1 ≤ threshold ≤ seats");
  const dir = values.dir ?? (await mkdtemp(join(tmpdir(), "trustee-node-")));
  // Fresh keys for a panel that exists only in this run.
  const secrets = Array.from({ length: n }, () => crypto.getRandomValues(new Uint8Array(32)));
  const panel = { threshold: k, keys: secrets.map((s) => identityKey(s)) };
  const stub = encodeElectionDefinition(localStub(panel, L2_CHAIN_ID, TRUSTEE_REGISTRY));
  const coordinator = new LocalCoordinator({
    stub,
    panel,
    l2ChainId: L2_CHAIN_ID,
    trusteeRegistry: TRUSTEE_REGISTRY,
    roundMs: 30_000,
    now: () => performance.now(),
  });
  const { url, server } = await serveCoordinator(coordinator);
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, io.signal]);
  // A node that fails (a store it can't open or read) ends the run; its
  // error is rethrown once the others have stopped and the server is closed.
  let failure: { error: unknown } | undefined;
  const nodes = secrets.map(async (identitySecret, i) => {
    const seat = new CeremonySeat({
      panel,
      l2ChainId: L2_CHAIN_ID,
      trusteeRegistry: TRUSTEE_REGISTRY,
      index: i + 1,
      identitySecret,
      // No chain in a local run: the stub's electorate is this command's own.
      electorate: () => Promise.resolve(true),
      store: await FileStore.open(join(dir, `seat-${i + 1}`)),
    });
    const node = new TrusteeNode({
      seat,
      index: i + 1,
      coordinator: new HttpCoordinator(url),
      log: (e) => io.err({ seat: i + 1, ...e }),
    });
    await node.run(signal, 20);
  });
  for (const node of nodes)
    node.catch((error: unknown) => {
      failure ??= { error };
      stop.abort();
    });
  try {
    for (;;) {
      const outcome = coordinator.outcome();
      if (outcome !== undefined || signal.aborted) {
        stop.abort();
        await Promise.allSettled(nodes);
        if (failure !== undefined) throw failure.error;
        if (outcome === undefined) return 1;
        const { check } = outcome;
        io.out(
          json({
            event: "ceremony",
            dir,
            seats: n,
            threshold: k,
            ok: check.ok,
            ...(check.ok
              ? {
                  transcriptHash: Buffer.from(check.hash).toString("hex"),
                  qualified: check.registered.map((r) => r.index),
                }
              : { code: check.code }),
            approved: [...outcome.approvals.keys()].sort((a, b) => a - b),
          }),
        );
        return check.ok && outcome.approvals.size >= Math.max(k, n - 1) ? 0 : 1;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    stop.abort();
    server.close();
  }
}
