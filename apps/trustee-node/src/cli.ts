// The node's command line: `keygen`, a seat's identity key; `run`, one
// seat's node against its coordinator, with its availability duty and the
// gateway serving what it attests when the configuration names the chains
// and sources it needs; and `local-ceremony`, a whole
// ceremony between a local panel's nodes and a local coordinator over HTTP
// on loopback. Output is one JSON object per line, never a secret.
import { once } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type AsyncBlockSource,
  type BoardEntryVersion,
  encodeElectionDefinition,
  identityKey,
} from "@abolishus/crypto";
import { gateway, mirrorThen, type Rpc, rpcClient, RpcError } from "@abolishus/node";
import { gatewaySource } from "@abolishus/verifier";
import {
  type AvailabilityOptions,
  AvailabilitySeat,
  type ContractPath,
  type FinalizedBoardAnchors,
} from "./availability.ts";
import { type ApprovedElection, CeremonySeat } from "./ceremony.ts";
import { HttpCoordinator } from "./client.ts";
import {
  type AvailabilityConfig,
  ConfigError,
  type NodeConfig,
  parseConfig,
  readAccountKey,
  readIdentityKey,
} from "./config.ts";
import { AvailabilityDuties, type DutyEvent } from "./duties.ts";
import { type L1AnchorOptions, l1BoardAnchors } from "./l1.ts";
import { LocalCoordinator, localStub, serveCoordinator } from "./local.ts";
import { type NodeEvent, TrusteeNode } from "./node.ts";
import { l2RecordedAvailability, RecordedError } from "./recorded.ts";
import { availabilitySender, SendError } from "./send.ts";
import { type ServedBlocks, servedBlocks } from "./served.ts";
import { FileStore, type SeatStore } from "./store.ts";
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

/**
 * Exit codes: 0 done, 2 bad usage or configuration, 1 a local ceremony that
 * didn't register or, for `run`, a chain's node that couldn't be read at
 * start.
 */
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
  const store = await FileStore.open(config.store);
  const seat = new CeremonySeat({
    panel: config.panel,
    l2ChainId: config.l2ChainId,
    trusteeRegistry: config.trusteeRegistry,
    index: config.seat,
    identitySecret,
    electorate: NO_ELECTORATE_CHECK,
    store,
  });
  const node = new TrusteeNode({
    seat,
    index: config.seat,
    coordinator: new HttpCoordinator(config.coordinator),
    log: (e: NodeEvent) => io.out(e),
  });
  let availability: { duties: AvailabilityDuties; server: Server } | undefined;
  try {
    availability = await availabilityDuties(config, seat, store, identitySecret, io);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    io.err({ error: `availability: ${e.message}` });
    return 1;
  }
  const duties = availability?.duties;
  io.out({ event: "started", seat: config.seat, availability: duties !== undefined });
  // Either loop failing (a store it can't read) stops the other, and the
  // failure is rethrown once both have stopped and the gateway is closed.
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, io.signal]);
  const ms = config.pollSeconds * 1000;
  const loops = [node.run(signal, ms), ...(duties ? [duties.run(signal, ms)] : [])].map((loop) =>
    loop.catch((error: unknown) => {
      stop.abort();
      throw error;
    }),
  );
  const outcomes = await Promise.allSettled(loops);
  if (availability !== undefined) {
    const { server } = availability;
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  return 0;
}

/**
 * The availability duty over the configured nodes, contracts and sources
 * (README, Availability duty), with the gateway serving the blocks
 * directory and what the duty pins into it, listening; or undefined when the
 * configuration has no `availability`. One sender for the one paying
 * account, shared by every election, so two sends never take one nonce. Its
 * setup checks both chains and the contracts' code: a mismatch, or an
 * address the gateway can't listen on, is the configuration's error, a node
 * that can't be read an `RpcError`.
 */
async function availabilityDuties(
  config: NodeConfig,
  seat: CeremonySeat,
  store: SeatStore,
  identitySecret: Uint8Array,
  io: CliIo,
): Promise<{ duties: AvailabilityDuties; server: Server } | undefined> {
  const a = config.availability;
  if (a === undefined) return undefined;
  const l1 = rpcClient(a.l1);
  const l2 = rpcClient(a.l2);
  const accountKey = await readAccountKey(a.accountKeyFile);
  // The identity key signs the seat's approvals; on a hot, funded account
  // it would also sign transactions for a key of another curve (T-37).
  if (Buffer.from(accountKey).equals(Buffer.from(identitySecret)))
    throw new ConfigError("account key: must not be the identity key");
  const clock = () => BigInt(Math.floor(Date.now() / 1000));
  let contract;
  try {
    contract = {
      send: await availabilitySender({
        l2,
        l2ChainId: config.l2ChainId,
        l1,
        l1ChainId: a.l1ChainId,
        board: a.board,
        portal: a.portal,
        accountKey,
        l2MaxFeePerGas: a.l2MaxFeePerGas,
        l1MaxFeePerGas: a.l1MaxFeePerGas,
        forceAfter: a.forceAfter,
        forceLead: a.forceLead,
        clock,
      }),
      recorded: await l2RecordedAvailability({
        l2,
        l2ChainId: config.l2ChainId,
        board: a.board,
        l2FromBlock: a.boardFromBlock,
      }),
    };
  } catch (e) {
    // A RangeError here is the sender's option check, which never quotes the key.
    if (e instanceof SendError || e instanceof RecordedError || e instanceof RangeError)
      throw new ConfigError(`availability: ${e.message}`);
    throw e;
  }
  const served = await servedOf(a.blocks, io);
  const remote: AsyncBlockSource =
    a.gateways.length > 0 ? gatewaySource(a.gateways).source : () => Promise.resolve([]);
  // The directory first: a block it holds costs no request and tells no
  // gateway which election the seat reads (T-11). Every block is checked
  // against its CID by the readers, so neither source is trusted (T-49, T-53).
  const blocks = mirrorThen(served, remote);
  const wiring = dutyWiring(config.l2ChainId, a, {
    l1,
    l2,
    contract,
    blocks,
    pin: served.pin,
    store,
    clock,
  });
  const duties = new AvailabilityDuties({
    seat,
    clock,
    log: (e: DutyEvent) => io.out(e),
    build: async (election) => {
      const reader = await l1BoardAnchors(wiring.anchors, election);
      return new AvailabilitySeat(wiring.seat(election, reader));
    },
  });
  const server = gateway(served);
  server.listen(a.serve.port, a.serve.host);
  try {
    await once(server, "listening");
  } catch (e) {
    throw new ConfigError(`availability.serve: ${(e as NodeJS.ErrnoException).code ?? "failed"}`);
  }
  // T-52: an error after listening (an accept that fails because descriptors
  // ran out) is reported, never fatal, as `apps/node`'s `serve` does.
  server.on("error", (e: NodeJS.ErrnoException) =>
    io.err({ error: `serve: ${e.code ?? "failed"}` }),
  );
  io.out({ event: "serving", address: server.address() });
  return { duties, server };
}

/** What `run` builds the duty over, besides the configuration. */
export interface DutySources {
  readonly l1: Rpc;
  readonly l2: Rpc;
  readonly contract: ContractPath;
  readonly blocks: AsyncBlockSource;
  readonly pin: AvailabilityOptions["pin"];
  readonly store: SeatStore;
  readonly clock: () => bigint;
}

/**
 * The L1 reader's options and each election's duty options from the
 * configuration: the board is checked under the registered definition's
 * own board-entry pin, which the reader gives, never a configured one.
 */
export function dutyWiring(
  l2ChainId: bigint,
  a: AvailabilityConfig,
  s: DutySources,
): {
  readonly anchors: L1AnchorOptions;
  readonly seat: (
    election: ApprovedElection,
    reader: FinalizedBoardAnchors & { readonly boardVersion: BoardEntryVersion },
  ) => AvailabilityOptions;
} {
  return {
    anchors: {
      l1: s.l1,
      l1ChainId: a.l1ChainId,
      anchor: a.anchor,
      timing: a.anchorClock,
      l1FromBlock: a.anchorFromBlock,
      l2: s.l2,
      l2ChainId,
      registry: a.registry,
      l2FromBlock: a.registryFromBlock,
    },
    seat: (election, reader) => ({
      store: s.store,
      election,
      boardVersion: reader.boardVersion,
      l1: reader,
      blocks: s.blocks,
      pin: s.pin,
      contract: s.contract,
      clock: s.clock,
      sendMargin: a.sendMargin,
      maxBytes: a.maxBoardBytes,
    }),
  };
}

/** The operator's directory of CAR files, read at start, each file reported. */
async function servedOf(dir: string, io: CliIo): Promise<ServedBlocks> {
  let served;
  try {
    served = await servedBlocks(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === undefined) throw e;
    throw new ConfigError(`availability.blocks: ${code}`);
  }
  for (const file of served.files) io.out({ event: "blocks", ...file });
  return served;
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
