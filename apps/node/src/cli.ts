// The node's command line. `serve`: mirror every block in a directory of CAR
// files over HTTP, and the reports `verify` wrote. `fetch`: pin into that
// directory every board object the board anchor's checkpoints name on L1.
// `verify`: run the verifier over every election those checkpoints name,
// its board copy read from that directory. Output is one JSON object per line.

import { once } from "node:events";
import { parseArgs } from "node:util";
import {
  DEFAULT_MAX_BOARD_BYTES,
  gatewaySource,
  MAX_GATEWAYS,
  parseGateway,
} from "@abolishus/verifier";
import { bytesToHex } from "@noble/hashes/utils.js";
import { gateway } from "./gateway.ts";
import { anchorTiming, finalizedBlock, finalizedHeader, parseAddress } from "./l1.ts";
import { l2Finalized } from "./l2.ts";
import { DEFAULT_MAX_ELECTION_BYTES, mirrorThen, pinElections } from "./pin.ts";
import { chainId, parseRpcUrl, rpcClient, RpcError } from "./rpc.ts";
import { type Mirror, openMirror } from "./store.ts";
import { verifyElections } from "./verify.ts";

export interface CliIo {
  readonly out: (value: unknown) => void;
  readonly err: (value: unknown) => void;
  /** Stops `serve`; the process wires it to SIGINT and SIGTERM. */
  readonly signal: AbortSignal;
}

export const USAGE = [
  "usage: abolish-node serve --blocks <directory> [--reports <directory>] [--port <n>] [--host <address>]",
  "       abolish-node fetch --blocks <directory> --l1 <url> --anchor <address> --gateway <url>... [--from-block <n>] [--max-bytes <n>]",
  "       abolish-node verify --blocks <directory> --reports <directory> --l1 <url> --anchor <address> --l2 <url> --registry <address> [--from-block <n>] [--l2-from-block <n>] [--max-bytes <n>]",
].join("\n");

/**
 * Exit codes: 0 stopped (`serve`) or done (`fetch` and `verify`, whatever
 * they couldn't fetch or verify, which they report); 1 L1's or L2's block,
 * L1's logs or the anchor's clock couldn't be read; 2 bad usage, a directory
 * that can't be read or written or an address it can't listen on.
 */
export async function cli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "serve") return await serve(rest, io);
    if (command === "fetch") return await fetchAndPin(rest, io);
    if (command === "verify") return await verify(rest, io);
  } catch (e) {
    if ((e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err({ error: (e as Error).message });
      return 2;
    }
    throw e;
  }
  io.err({ error: USAGE });
  return 2;
}

async function serve(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      blocks: { type: "string" },
      reports: { type: "string" },
      port: { type: "string", default: "8080" },
      // Loopback unless the operator chooses to publish the mirror.
      host: { type: "string", default: "127.0.0.1" },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (values.blocks === undefined || !/^\d{1,5}$/.test(values.port) || port > 65_535) {
    io.err({ error: USAGE });
    return 2;
  }
  const mirror = await mirrorOf(values.blocks, io);
  if (mirror === undefined) return 2;
  for (const file of mirror.files) io.out(file);
  const server = gateway(mirror, {}, values.reports);
  server.listen(port, values.host);
  try {
    await once(server, "listening");
  } catch (e) {
    io.err({ error: `listen: ${(e as NodeJS.ErrnoException).code ?? "failed"}` });
    return 2;
  }
  // T-52: an error after listening (an accept that fails because descriptors
  // ran out) is reported, never fatal: the node keeps serving.
  server.on("error", (e: NodeJS.ErrnoException) =>
    io.err({ error: `server: ${e.code ?? "failed"}` }),
  );
  const address = server.address();
  io.out({ listening: typeof address === "object" && address !== null ? address : values.host });
  if (!io.signal.aborted) await once(io.signal, "abort");
  server.close();
  server.closeAllConnections();
  await once(server, "close");
  return 0;
}

const DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/u;

// The mirror, or the filesystem error code that kept `dir` from being listed.
async function mirrorOf(dir: string, io: CliIo): Promise<Mirror | undefined> {
  try {
    return await openMirror(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === undefined) throw e;
    io.err({ error: `blocks: ${code}` });
    return undefined;
  }
}

async function fetchAndPin(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      blocks: { type: "string" },
      l1: { type: "string" },
      anchor: { type: "string" },
      gateway: { type: "string", multiple: true },
      "from-block": { type: "string", default: "0" },
      "max-bytes": { type: "string", default: String(DEFAULT_MAX_ELECTION_BYTES) },
    },
    strict: true,
  });
  const gateways = values.gateway ?? [];
  const fromBlock = values["from-block"];
  const maxBytes = values["max-bytes"];
  if (
    values.blocks === undefined ||
    values.l1 === undefined ||
    values.anchor === undefined ||
    gateways.length === 0 ||
    !DECIMAL.test(fromBlock) ||
    !DECIMAL.test(maxBytes) ||
    !Number.isSafeInteger(Number(maxBytes)) ||
    Number(maxBytes) < 1
  ) {
    io.err({ error: USAGE });
    return 2;
  }
  if (gateways.length > MAX_GATEWAYS) {
    io.err({ error: `--gateway: at most ${MAX_GATEWAYS}` });
    return 2;
  }
  let parsed;
  try {
    parsed = {
      rpc: rpcClient(parseRpcUrl(values.l1)),
      anchor: parseAddress(values.anchor),
      gateways: gatewaySource(gateways.map(parseGateway)),
    };
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err({ error: e.message });
    return 2;
  }
  const mirror = await mirrorOf(values.blocks, io);
  if (mirror === undefined) return 2;
  try {
    const header = await finalizedHeader(parsed.rpc);
    io.out({
      l1: {
        number: header.number.toString(),
        hash: `0x${bytesToHex(header.hash)}`,
      },
    });
    const run = await pinElections(header, {
      rpc: parsed.rpc,
      anchor: parsed.anchor,
      blocks: mirrorThen(mirror, parsed.gateways.source),
      dir: values.blocks,
      fromBlock: BigInt(fromBlock),
      maxElectionBytes: Number(maxBytes),
      report: io.out,
    });
    io.out({ refusedLogs: run.refusedLogs, gateways: parsed.gateways.stats() });
  } catch (e) {
    if (e instanceof RpcError) {
      io.err({ error: `l1: ${e.message}` });
      return 1;
    }
    // The directory can't be written (EACCES, ENOSPC), as `serve` reports it.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === undefined) throw e;
    io.err({ error: `blocks: ${code}` });
    return 2;
  }
  return 0;
}

async function verify(args: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      blocks: { type: "string" },
      reports: { type: "string" },
      l1: { type: "string" },
      anchor: { type: "string" },
      l2: { type: "string" },
      registry: { type: "string" },
      "from-block": { type: "string", default: "0" },
      "l2-from-block": { type: "string", default: "0" },
      "max-bytes": { type: "string", default: String(DEFAULT_MAX_BOARD_BYTES) },
    },
    strict: true,
  });
  const { blocks, reports, l1, anchor, l2, registry } = values;
  const maxBytes = values["max-bytes"];
  if (
    blocks === undefined ||
    reports === undefined ||
    l1 === undefined ||
    anchor === undefined ||
    l2 === undefined ||
    registry === undefined ||
    !DECIMAL.test(values["from-block"]) ||
    !DECIMAL.test(values["l2-from-block"]) ||
    !DECIMAL.test(maxBytes) ||
    !Number.isSafeInteger(Number(maxBytes)) ||
    Number(maxBytes) < 1
  ) {
    io.err({ error: USAGE });
    return 2;
  }
  let parsed;
  try {
    parsed = {
      l1: rpcClient(parseRpcUrl(l1)),
      anchor: parseAddress(anchor),
      l2: rpcClient(parseRpcUrl(l2)),
      registry: parseAddress(registry),
    };
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    io.err({ error: e.message });
    return 2;
  }
  const mirror = await mirrorOf(blocks, io);
  if (mirror === undefined) return 2;
  let l1Inputs;
  try {
    const { header, rlp } = await finalizedBlock(parsed.l1);
    io.out({ l1: { number: header.number.toString(), hash: `0x${bytesToHex(header.hash)}` } });
    const timing = await anchorTiming(parsed.l1, parsed.anchor, header);
    l1Inputs = { header, headerRlp: rlp, timing, l1ChainId: await chainId(parsed.l1) };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    io.err({ error: `l1: ${e.message}` });
    return 1;
  }
  let finalized;
  let l2ChainId;
  try {
    l2ChainId = await chainId(parsed.l2);
    finalized = await l2Finalized(parsed.l2);
    io.out({ l2: { number: finalized.toString() } });
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    io.err({ error: `l2: ${e.message}` });
    return 1;
  }
  try {
    const run = await verifyElections({
      ...parsed,
      ...l1Inputs,
      l2Finalized: finalized,
      l2ChainId,
      mirror,
      reports,
      fromBlock: BigInt(values["from-block"]),
      l2FromBlock: BigInt(values["l2-from-block"]),
      maxBoardBytes: Number(maxBytes),
      report: io.out,
    });
    io.out({ refusedLogs: run.refusedLogs });
  } catch (e) {
    if (e instanceof RpcError) {
      io.err({ error: `l1: ${e.message}` });
      return 1;
    }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === undefined) throw e;
    io.err({ error: `reports: ${code}` });
    return 2;
  }
  return 0;
}
