// The node's command line: `keygen`, a seat's identity key; `run`, one
// seat's node against its coordinator, with its availability and receipt
// duties and the gateway serving what it attests when the configuration
// names the chains and sources they need, its tally duty and summed-share
// channel when it names the other seats' endpoints, and its intake endpoint when it
// names where to listen; `run-env`, the same from the environment and a
// persistent volume (env-seat.ts); and `local-ceremony`, a whole
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
  AVAILABILITY_POINTS,
  type BoardEntryVersion,
  encodeElectionDefinition,
  identityKey,
  type Panel,
} from "@abolishus/crypto";
import { gateway, mirrorThen, type Rpc, rpcClient, RpcError } from "@abolishus/node";
import { gatewaySource } from "@abolishus/verifier";
import {
  attested,
  type AvailabilityOptions,
  AvailabilitySeat,
  type ContractPath,
  type FinalizedBoardAnchors,
} from "./availability.ts";
import { type ApprovedElection, CeremonySeat } from "./ceremony.ts";
import { type ComplaintDutyOptions, ComplaintDuty, type ComplaintPath } from "./complaint.ts";
import { HttpCoordinator } from "./client.ts";
import { httpPeers, serveSummedShares } from "./channel.ts";
import {
  type AvailabilityConfig,
  ConfigError,
  type NodeConfig,
  parseConfig,
  readAccountKey,
  readIdentityKey,
  readTlsKey,
  type TallyConfig,
} from "./config.ts";
import { type ReceiptDutyOptions, type ReceiptPath, ReceiptDuty } from "./delivery.ts";
import {
  AvailabilityDuties,
  ComplaintDuties,
  CountedAvailabilityDuties,
  type DutyEvent,
  ReceiptDuties,
  TallyDuties,
  tallyDeadline,
} from "./duties.ts";
import { type Endpoint, serveIntake } from "./endpoint.ts";
import { seatFromEnv } from "./env-seat.ts";
import { IntakeSeat, type RegistrationCheck } from "./intake.ts";
import { type L1AnchorOptions, l1BoardAnchors } from "./l1.ts";
import { LocalCoordinator, localStub, serveCoordinator } from "./local.ts";
import { type NodeEvent, TrusteeNode } from "./node.ts";
import {
  l2AvailabilityRecords,
  l2Postings,
  l2RecordedAvailability,
  l2RecordedComplaintBatches,
  l2RecordedReceiptBatches,
  RecordedError,
} from "./recorded.ts";
import { boardSender, SendError } from "./send.ts";
import { type ServedBlocks, servedBlocks } from "./served.ts";
import { FileStore, type SeatStore } from "./store.ts";
import type { ElectorateCheck } from "./stub.ts";
import { type AvailabilityRecords, summingRule } from "./summing.ts";
import { TallyDuty } from "./tally.ts";
import {
  complaintBallots,
  countedSource,
  type CountedSourceOptions,
  obligationView,
  tallyDefinition,
  ViewError,
  type ViewOptions,
} from "./view.ts";

export interface CliIo {
  readonly out: (value: unknown) => void;
  readonly err: (value: unknown) => void;
  /** Aborts `run`; the process wires it to SIGINT and SIGTERM. */
  readonly signal: AbortSignal;
}

export const USAGE = [
  "usage: trustee-node keygen --out <file>",
  "       trustee-node run --config <file>",
  "       trustee-node run-env --data <dir>",
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
 * Nor is the registration read from finalized L2 (P2-13 part 3), so the
 * deployed endpoint refuses every delivery until it is: with no stub
 * approved, `intake-unapproved` comes first.
 */
const NO_REGISTRATION_CHECK: RegistrationCheck = () => Promise.resolve(false);

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
    if (command === "run-env") return await runFromEnv(rest, io);
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
  return runConfig(text, io);
}

/**
 * `run` over `TRUSTEE_CONFIG` and `TRUSTEE_IDENTITY_KEY`, with the key file
 * and the store on the volume at `--data` (env-seat.ts).
 */
async function runFromEnv(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: { data: { type: "string" } },
    strict: true,
  });
  if (values.data === undefined) throw new ConfigError("run-env: --data is required");
  const env = {
    config: process.env["TRUSTEE_CONFIG"],
    identityKey: process.env["TRUSTEE_IDENTITY_KEY"],
  };
  // T-65: read once and unset, so nothing the process spawns inherits the
  // key, or the nodes' URLs a configuration can carry. The kernel's copy of
  // the initial environment stays, readable only as the volume's key file is.
  delete process.env["TRUSTEE_IDENTITY_KEY"];
  delete process.env["TRUSTEE_CONFIG"];
  const text = await seatFromEnv(env, values.data);
  return runConfig(text, io);
}

async function runConfig(text: string, io: CliIo): Promise<number> {
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
  let availability: Duties | undefined;
  try {
    availability = await availabilityDuties(config, seat, store, identitySecret, io);
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    io.err({ error: `availability: ${e.message}` });
    return 1;
  }
  let endpoint;
  try {
    endpoint = await intakeEndpoint(config, seat, store, io);
  } catch (e) {
    // Nothing runs, so nothing may stay listening.
    if (availability !== undefined) await closeDuties(availability);
    throw e;
  }
  io.out({
    event: "started",
    seat: config.seat,
    availability: availability !== undefined,
    ...(endpoint === undefined ? {} : { intake: endpoint.url }),
  });
  // Any loop failing (a store it can't read) stops the others, and the
  // failure is rethrown once all have stopped and the gateway is closed.
  const stop = new AbortController();
  const signal = AbortSignal.any([stop.signal, io.signal]);
  const ms = config.pollSeconds * 1000;
  const loops = [
    node.run(signal, ms),
    ...(availability
      ? [
          availability.duties.run(signal, ms),
          availability.counted.run(signal, ms),
          availability.receipts.run(signal, ms),
          availability.complaints.run(signal, ms),
          ...(availability.tally ? [availability.tally.run(signal, ms)] : []),
        ]
      : []),
  ].map((loop) =>
    loop.catch((error: unknown) => {
      stop.abort();
      throw error;
    }),
  );
  const outcomes = await Promise.allSettled(loops);
  if (availability !== undefined) await closeDuties(availability);
  await endpoint?.close();
  for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
  return 0;
}

/** Closes the gateway and the summed-share channel. */
async function closeDuties({ server, channel }: Duties): Promise<void> {
  server.close();
  server.closeAllConnections();
  await once(server, "close");
  await channel?.close();
}

/**
 * The seat's intake endpoint (README, Intake endpoint), or undefined when
 * the configuration has no `intake`. A port it can't take is the
 * configuration's error.
 */
async function intakeEndpoint(
  config: NodeConfig,
  seat: CeremonySeat,
  store: SeatStore,
  io: CliIo,
): Promise<Endpoint | undefined> {
  const i = config.intake;
  if (i === undefined) return undefined;
  const tls = await tlsOf(i.tls);
  const intake = new IntakeSeat({
    panel: config.panel,
    l2ChainId: config.l2ChainId,
    trusteeRegistry: config.trusteeRegistry,
    index: config.seat,
    ceremony: seat,
    electorate: NO_ELECTORATE_CHECK,
    registration: NO_REGISTRATION_CHECK,
    store,
    now: () => BigInt(Math.floor(Date.now() / 1000)),
  });
  try {
    return await serveIntake(intake, {
      host: i.host,
      port: i.port,
      ...(tls === undefined ? {} : { tls }),
      queue: i.queue,
      log: (e) => io.out(e),
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // A certificate or key OpenSSL can't read has a code of its own too.
    if (code === undefined) throw e;
    throw new ConfigError(`intake: ${code}`);
  }
}

/** An endpoint's certificate chain and key, read from the configured files. */
async function tlsOf(
  files: { readonly certFile: string; readonly keyFile: string } | undefined,
): Promise<{ readonly cert: string; readonly key: string } | undefined> {
  if (files === undefined) return undefined;
  let cert;
  try {
    cert = await readFile(files.certFile, "utf8");
  } catch (e) {
    throw new ConfigError(`TLS certificate: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  return { cert, key: await readTlsKey(files.keyFile) };
}

/** The duties `run` steps beside the ceremony, and the gateway serving what the seat attests. */
interface Duties {
  readonly duties: AvailabilityDuties;
  readonly counted: CountedAvailabilityDuties;
  readonly receipts: ReceiptDuties;
  readonly complaints: ComplaintDuties;
  /** With `availability.tally` only. */
  readonly tally: TallyDuties | undefined;
  readonly channel: Endpoint | undefined;
  readonly server: Server;
}

/**
 * The availability duties at both points, and the receipt and complaint
 * duties, over the configured nodes, contracts and sources (README,
 * Availability duty, Receipt duty and
 * Complaint duty), with the gateway serving the blocks directory and what
 * the availability duty pins into it, listening; or undefined when the
 * configuration has no `availability`. One sender for the one paying
 * account, shared by every election and every duty, so two sends never take
 * one nonce. Its setup checks both chains
 * and the contracts' code: a mismatch, or an address the gateway can't
 * listen on, is the configuration's error, a node that can't be read an
 * `RpcError`.
 */
async function availabilityDuties(
  config: NodeConfig,
  seat: CeremonySeat,
  store: SeatStore,
  identitySecret: Uint8Array,
  io: CliIo,
): Promise<Duties | undefined> {
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
  let contract: ContractPath;
  let receiptPath: ReceiptPath;
  let complaintPath: ComplaintPath;
  let records: AvailabilityRecords | undefined;
  try {
    const sender = await boardSender({
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
    });
    const recorded = {
      l2,
      l2ChainId: config.l2ChainId,
      board: a.board,
      l2FromBlock: a.boardFromBlock,
    };
    contract = { send: sender.availability, recorded: await l2RecordedAvailability(recorded) };
    receiptPath = {
      send: sender.receiptBatch,
      recorded: await l2RecordedReceiptBatches(recorded),
    };
    complaintPath = {
      postings: await l2Postings(recorded),
      send: sender.complaintBatch,
      recorded: await l2RecordedComplaintBatches(recorded),
    };
    if (a.tally !== undefined) records = await l2AvailabilityRecords(recorded);
  } catch (e) {
    // A RangeError here is the sender's option check, which never quotes the key.
    if (e instanceof SendError || e instanceof RecordedError || e instanceof RangeError)
      throw new ConfigError(`availability: ${e.message}`);
    throw e;
  }
  const served = await servedOf(a.blocks, io);
  const gateways: AsyncBlockSource =
    a.gateways.length > 0 ? gatewaySource(a.gateways).source : () => Promise.resolve([]);
  const wiring = dutyWiring(config, a, {
    l1,
    l2,
    contract,
    receipts: receiptPath,
    complaints: complaintPath,
    served,
    gateways,
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
  // The counted extent's reader proves the anchor's words through `s_S`,
  // and the seat fixes `C_S` by the same pinned clock the reader checked.
  const counted = new CountedAvailabilityDuties(
    {
      seat,
      clock,
      log: (e: DutyEvent) => io.out(e),
      build: async (election) => {
        const reader = await l1BoardAnchors(
          wiring.anchors,
          election,
          AVAILABILITY_POINTS.countedExtent,
        );
        return new AvailabilitySeat({ ...wiring.seat(election, reader), counted: a.anchorClock });
      },
    },
    a.anchorClock,
  );
  const receipts = new ReceiptDuties({
    seat,
    clock,
    log: (e: DutyEvent) => io.out(e),
    build: async (election) => new ReceiptDuty(wiring.receipts(election)),
  });
  const complaints = new ComplaintDuties({
    seat,
    clock,
    log: (e: DutyEvent) => io.out(e),
    build: async (election) => new ComplaintDuty(wiring.complaints(election)),
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
  let tally: { readonly duties: TallyDuties; readonly channel: Endpoint } | undefined;
  if (a.tally !== undefined && records !== undefined) {
    try {
      tally = await tallyDuties(config, a, a.tally, { seat, wiring, records, store, clock }, io);
    } catch (e) {
      server.close();
      throw e;
    }
  }
  return {
    duties,
    counted,
    receipts,
    complaints,
    tally: tally?.duties,
    channel: tally?.channel,
    server,
  };
}

/**
 * The tally duty of every approved election (README, Tally duty), with the
 * summed-share channel listening and handing every message to it, and the
 * other seats' endpoints to send through. Each election's duty is built
 * over the definition registered on the seat's own L2 node, the transcript
 * the seat's approval signed for, the summed-share rule over the counted
 * extent's L1 reader and the board's availability records, and the counted
 * set from the counted extent the seat attested (T-14, T-54, T-15).
 */
async function tallyDuties(
  config: NodeConfig,
  a: AvailabilityConfig,
  t: TallyConfig,
  s: {
    readonly seat: CeremonySeat;
    readonly wiring: ReturnType<typeof dutyWiring>;
    readonly records: AvailabilityRecords;
    readonly store: SeatStore;
    readonly clock: () => bigint;
  },
  io: CliIo,
): Promise<{ readonly duties: TallyDuties; readonly channel: Endpoint }> {
  let ca: string | undefined;
  if (t.caFile !== undefined) {
    try {
      ca = await readFile(t.caFile, "utf8");
    } catch (e) {
      throw new ConfigError(`tally CA: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
    }
  }
  let peers;
  try {
    peers = httpPeers({
      peers: t.peers,
      ...(ca === undefined ? {} : { ca }),
      timeoutMs: t.timeoutMs,
    });
  } catch (e) {
    // A URL the parser refuses, or another scheme: neither message quotes it.
    if (e instanceof TypeError || e instanceof RangeError)
      throw new ConfigError(`availability.tally.peers: ${e.message}`);
    throw e;
  }
  const { seat, wiring, records, store, clock } = s;
  const duties = new TallyDuties(
    {
      seat,
      clock,
      log: (e: DutyEvent) => io.out(e),
      build: async (election) => {
        const secrets = await seat.intakeSecrets(election.stubHash);
        // Listed as approved, so its secrets exist; intakeSecrets throws if they don't.
        if (secrets === undefined) throw new Error("trustee node: an approval without its secrets");
        // An approval from before the seat kept its copy gives this election
        // up, reported, rather than stopping the node.
        const transcript = await seat.approvedTranscript(election.stubHash);
        if (transcript === undefined) throw new ViewError("transcript");
        const definition = await tallyDefinition(wiring.view, election);
        const reader = await l1BoardAnchors(
          wiring.anchors,
          election,
          AVAILABILITY_POINTS.countedExtent,
        );
        const duty = new TallyDuty({
          panel: config.panel,
          l2ChainId: config.l2ChainId,
          trusteeRegistry: config.trusteeRegistry,
          election,
          secrets,
          definition,
          transcript,
          store,
          summing: summingRule({ election, l1: reader, counted: a.anchorClock, records, clock }),
          counted: countedSource(wiring.counted),
          peers,
        });
        return {
          step: () => duty.step(),
          receive: (message) => duty.receive(message),
          deadline: tallyDeadline(election, a.anchorClock),
        };
      },
    },
    a.anchorClock,
  );
  const tls = await tlsOf(t.tls);
  let channel;
  try {
    channel = await serveSummedShares((message) => duties.receive(message), {
      host: t.host,
      port: t.port,
      ...(tls === undefined ? {} : { tls }),
      queue: t.queue,
      log: (e) => io.out(e),
    });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === undefined) throw e;
    throw new ConfigError(`availability.tally: ${code}`);
  }
  io.out({ event: "summed-shares", url: channel.url });
  return { duties, channel };
}

/** What `run` builds the duty over, besides the configuration. */
export interface DutySources {
  readonly l1: Rpc;
  readonly l2: Rpc;
  readonly contract: ContractPath;
  /** The board's receipt-batch call, over the same account as `contract`. */
  readonly receipts: ReceiptPath;
  /** The board's postings, complaint-batch call and recorded batches, over the same account. */
  readonly complaints: ComplaintPath;
  /** The blocks directory, read first, where the seat pins what it attests. */
  readonly served: ServedBlocks;
  readonly gateways: AsyncBlockSource;
  readonly store: SeatStore;
  readonly clock: () => bigint;
}

/**
 * The L1 reader's options, each election's availability duty options, the
 * decision's view and each election's receipt and complaint duty options
 * from the configuration: the board is checked under the registered definition's
 * own board-entry pin, which the reader gives, never a configured one;
 * blocks are read from the directory the seat pins into, then the gateways.
 * The view reads the extent the seat attested through a reader and an
 * `AvailabilitySeat` set up as its availability duty's are, over the same
 * store, so it sees the attestation that duty stored and the blocks it
 * pinned (README, View).
 */
export function dutyWiring(
  config: { readonly l2ChainId: bigint; readonly panel: Panel },
  a: AvailabilityConfig,
  s: DutySources,
): {
  readonly anchors: L1AnchorOptions;
  readonly seat: (
    election: ApprovedElection,
    reader: FinalizedBoardAnchors & { readonly boardVersion: BoardEntryVersion },
  ) => AvailabilityOptions;
  readonly view: ViewOptions;
  readonly counted: CountedSourceOptions;
  readonly receipts: (election: ApprovedElection) => ReceiptDutyOptions;
  readonly complaints: (election: ApprovedElection) => ComplaintDutyOptions;
} {
  const { l2ChainId } = config;
  // The directory first: a block it holds costs no request and tells no
  // gateway which election the seat reads (T-11). Every block is checked
  // against its CID by the readers, so neither source is trusted (T-49, T-53).
  const blocks = mirrorThen(s.served, s.gateways);
  const anchors: L1AnchorOptions = {
    l1: s.l1,
    l1ChainId: a.l1ChainId,
    anchor: a.anchor,
    timing: a.anchorClock,
    l1FromBlock: a.anchorFromBlock,
    l2: s.l2,
    l2ChainId,
    registry: a.registry,
    l2FromBlock: a.registryFromBlock,
  };
  const seat = (
    election: ApprovedElection,
    reader: FinalizedBoardAnchors & { readonly boardVersion: BoardEntryVersion },
  ): AvailabilityOptions => ({
    store: s.store,
    election,
    boardVersion: reader.boardVersion,
    l1: reader,
    blocks,
    pin: s.served.pin,
    contract: s.contract,
    clock: s.clock,
    sendMargin: a.sendMargin,
    maxBytes: a.maxBoardBytes,
  });
  const view: ViewOptions = {
    store: s.store,
    panel: config.panel,
    l1: s.l1,
    l1ChainId: a.l1ChainId,
    l2: s.l2,
    l2ChainId,
    registry: a.registry,
    registryFromBlock: a.registryFromBlock,
    board: a.board,
    boardFromBlock: a.boardFromBlock,
    // Only an attesting seat sets up the reader, so a seat that didn't
    // attest decides over its own intake whatever the L1 reader says.
    extent: async (election) =>
      (await attested(s.store, election.definitionHash))
        ? new AvailabilitySeat(seat(election, await l1BoardAnchors(anchors, election))).heldExtent()
        : undefined,
  };
  // The counted set's source reads the counted extent the seat attested at
  // point 2, set up as the counted availability duty's is, over the same
  // store (README, Tally duty).
  const counted: CountedSourceOptions = {
    panel: view.panel,
    l1: view.l1,
    l1ChainId: view.l1ChainId,
    l2: view.l2,
    l2ChainId: view.l2ChainId,
    registry: view.registry,
    registryFromBlock: view.registryFromBlock,
    board: view.board,
    boardFromBlock: view.boardFromBlock,
    counted: a.anchorClock,
    extent: async (election) => {
      const point = AVAILABILITY_POINTS.countedExtent;
      if (!(await attested(s.store, election.definitionHash, point))) return undefined;
      const reader = await l1BoardAnchors(anchors, election, point);
      return new AvailabilitySeat({
        ...seat(election, reader),
        counted: a.anchorClock,
      }).heldExtent();
    },
  };
  // One view for every election: it holds no state of its own.
  const decide = obligationView(view);
  const ballots = complaintBallots(view);
  return {
    anchors,
    seat,
    view,
    counted,
    receipts: (election) => ({
      store: s.store,
      election,
      view: decide,
      contract: s.receipts,
      now: s.clock,
    }),
    // The same decision as the receipt duty's, read from the same store, so
    // the scope the complaints come from is the one decided at `c_I`.
    complaints: (election) => ({
      store: s.store,
      election,
      view: decide,
      contract: s.complaints,
      ballots,
      now: s.clock,
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
