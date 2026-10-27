// The node's deployment configuration (README, Configuration): the pinned
// panel, the seat, where the identity key and the store live, the
// coordinator, and, for the availability duty, the chains' nodes, the
// deployment's contracts, the paying account's key, the block sources and
// where it serves them, the tally's summed-share channel and the other
// seats' endpoints, and where the intake endpoint listens. JSON at a
// transport boundary, so it is parsed with a strict schema; the panel's keys
// are protocol bytes, so they are checked by
// `@abolishus/crypto` (`panelId`) and must hash to the `panelId` the trustee
// compared out of band, so a mistyped key can't pin another panel (T-17).
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { panelId, PanelError, type Panel } from "@abolishus/crypto";
import { type AnchorTiming, parseRpcUrl } from "@abolishus/node";
import { DEFAULT_MAX_BOARD_BYTES, MAX_GATEWAYS, parseGateway } from "@abolishus/verifier";
import { z } from "zod";
import { coordinatorUrl } from "./client.ts";

const hexOf = (bytes: number) =>
  z
    .string()
    .regex(new RegExp(`^(0x)?[0-9a-f]{${2 * bytes}}$`))
    .transform((s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex")));

// A decimal below 2^bits, as JSON carries numbers past 2^53 only as text.
const decimal = (bits: number) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]{0,77})$/)
    .transform(BigInt)
    .refine((v) => v < 1n << BigInt(bits), `must be below 2^${bits}`);

// A week: longer than any margin a ballot extent's windows leave.
const seconds = z
  .number()
  .int()
  .min(0)
  .max(7 * 86_400)
  .transform(BigInt);

const LOOPBACK = ["127.0.0.1", "::1", "localhost"];

// Where the summed-share channel listens, as the intake endpoint does, and
// the other seats' endpoints by seat index (README, Summed-share channel).
const TALLY = z.strictObject({
  host: z.string().min(1),
  port: z.number().int().min(0).max(65_535),
  tlsCertFile: z.string().min(1).optional(),
  tlsKeyFile: z.string().min(1).optional(),
  queue: z.number().int().min(1).max(1024).default(16),
  peers: z.record(z.string().regex(/^[1-9][0-9]{0,2}$/), z.string().min(1)),
  caFile: z.string().min(1).optional(),
  timeoutSeconds: z.number().int().min(1).max(300).default(30),
  operator: z.string().min(1),
});

// The group registry and its registrars as the release's deployment record
// pins them ([[deployment]], `registrars` and `registrar_threshold`), for the
// electorate check: ascending addresses, at least two, and a threshold no
// single key meets (T-62, T-71).
const GROUP_REGISTRY = z
  .strictObject({
    address: hexOf(20),
    fromBlock: decimal(64),
    registrars: z.array(hexOf(20)).min(2).max(16),
    threshold: z.number().int().min(2),
  })
  .refine(
    (g) =>
      g.registrars.every(
        (r, i) => i === 0 || Buffer.compare(g.registrars[i - 1] as Uint8Array, r) < 0,
      ),
    { message: "must be in strictly ascending order", path: ["registrars"] },
  )
  .refine((g) => g.threshold <= g.registrars.length, {
    message: "must be at most the number of registrars",
    path: ["threshold"],
  });

const AVAILABILITY = z.strictObject({
  l1: z.string().min(1),
  l1ChainId: decimal(64),
  l2: z.string().min(1),
  anchor: hexOf(20),
  anchorFromBlock: decimal(64),
  anchorClock: z.strictObject({
    epoch: decimal(64),
    period: decimal(64).refine((v) => v > 0n, "must be positive"),
    deadline: decimal(64),
  }),
  registry: hexOf(20),
  registryFromBlock: decimal(64),
  board: hexOf(20),
  boardFromBlock: decimal(64),
  portal: hexOf(20),
  accountKeyFile: z.string().min(1),
  l1MaxFeePerGas: decimal(256).refine((v) => v > 0n, "must be positive"),
  l2MaxFeePerGas: decimal(256).refine((v) => v > 0n, "must be positive"),
  forceAfterSeconds: seconds,
  forceLeadSeconds: seconds,
  sendMarginSeconds: seconds,
  maxBoardBytes: z
    .number()
    .int()
    .min(1)
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_MAX_BOARD_BYTES),
  gateways: z.array(z.string()).max(MAX_GATEWAYS).default([]),
  blocks: z.string().min(1),
  serve: z.strictObject({
    port: z.number().int().min(0).max(65_535),
    // Loopback unless the operator publishes it, as `apps/node`'s `serve`.
    host: z.string().min(1).default("127.0.0.1"),
  }),
  tally: TALLY.optional(),
  groupRegistry: GROUP_REGISTRY.optional(),
});

const INTAKE = z
  .strictObject({
    host: z.string().min(1),
    port: z.number().int().min(0).max(65_535),
    tlsCertFile: z.string().min(1).optional(),
    tlsKeyFile: z.string().min(1).optional(),
    queue: z.number().int().min(1).max(1024).default(16),
  })
  .refine((i) => (i.tlsCertFile === undefined) === (i.tlsKeyFile === undefined), {
    message: "needs both tlsCertFile and tlsKeyFile, or neither",
    path: ["tlsCertFile"],
  })
  .refine((i) => i.tlsCertFile !== undefined || LOOPBACK.includes(i.host), {
    message: "plain HTTP only on a loopback address",
    path: ["host"],
  });

const CONFIG = z.strictObject({
  panel: z.strictObject({
    threshold: z.number().int().min(1),
    keys: z.array(hexOf(33)).min(1),
  }),
  panelId: hexOf(32),
  l2ChainId: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .transform(BigInt)
    .refine((v) => v < 1n << 64n),
  trusteeRegistry: hexOf(20),
  seat: z.number().int().min(1),
  identityKeyFile: z.string().min(1),
  store: z.string().min(1),
  coordinator: z.string().min(1),
  pollSeconds: z.number().min(1).max(3600).default(5),
  availability: AVAILABILITY.optional(),
  intake: INTAKE.optional(),
});

/**
 * Where the intake endpoint listens (README, Intake endpoint). With the
 * certificate and key it serves HTTPS; without, plain HTTP on loopback only,
 * behind a TLS proxy on the same host.
 */
export interface IntakeEndpointConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: { readonly certFile: string; readonly keyFile: string } | undefined;
  readonly queue: number;
}

/**
 * Where the availability duty reads and sends (docs/spec/availability.md,
 * What a seat does). The node URLs may hold a provider's key, so they are
 * never printed.
 */
export interface AvailabilityConfig {
  readonly l1: URL;
  readonly l1ChainId: bigint;
  /** The seat's own L2 node, deriving its finalized chain from L1. */
  readonly l2: URL;
  readonly anchor: Uint8Array;
  readonly anchorFromBlock: bigint;
  /** The anchor deployment's clock, pinned: its getters are only compared with it. */
  readonly anchorClock: AnchorTiming;
  readonly registry: Uint8Array;
  readonly registryFromBlock: bigint;
  readonly board: Uint8Array;
  readonly boardFromBlock: bigint;
  /** The L2's `OptimismPortal` on L1, for forced inclusion. */
  readonly portal: Uint8Array;
  readonly accountKeyFile: string;
  readonly l1MaxFeePerGas: bigint;
  readonly l2MaxFeePerGas: bigint;
  readonly forceAfter: bigint;
  readonly forceLead: bigint;
  readonly sendMargin: bigint;
  readonly maxBoardBytes: number;
  readonly gateways: readonly URL[];
  /**
   * A directory of CAR files read before any gateway, where the seat pins
   * every object it attests (docs/spec/availability.md, What a seat does, 4).
   */
  readonly blocks: string;
  /** Where the seat serves that directory as a trustless gateway. */
  readonly serve: { readonly port: number; readonly host: string };
  /** The tally duty's channel, or undefined: the node then runs no tally duty. */
  readonly tally: TallyConfig | undefined;
  /**
   * The group registry the electorate check reads, or undefined: the node
   * then refuses every stub (`stub-electorate`).
   */
  readonly groupRegistry: GroupRegistryConfig | undefined;
}

/** The group registry, from its deployment block, and the registrars the release pins. */
export interface GroupRegistryConfig {
  readonly address: Uint8Array;
  readonly fromBlock: bigint;
  /** In ascending order, as the registry's `RegistrarsPinned` logs them. */
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
}

/**
 * The summed-share channel (README, Summed-share channel): where the seat's
 * endpoint listens, as the intake endpoint does, and each other seat's
 * endpoint by seat index (`https:`, or `http:` on loopback), with the CA its
 * certificates chain to in place of the system's roots.
 */
export interface TallyConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: { readonly certFile: string; readonly keyFile: string } | undefined;
  readonly queue: number;
  readonly peers: ReadonlyMap<number, string>;
  readonly caFile: string | undefined;
  readonly timeoutMs: number;
  /**
   * The board operator's API base URL (`https:`, or `http:` on loopback),
   * which the seat sends its signed tally openings to until the seal, and
   * its destruction statement to until the destruction window ends.
   */
  readonly operator: string;
}

export interface NodeConfig {
  readonly panel: Panel;
  readonly l2ChainId: bigint;
  readonly trusteeRegistry: Uint8Array;
  readonly seat: number;
  readonly identityKeyFile: string;
  readonly store: string;
  readonly coordinator: string;
  readonly pollSeconds: number;
  readonly availability: AvailabilityConfig | undefined;
  readonly intake: IntakeEndpointConfig | undefined;
}

/** A configuration the node can't run with; the message says which field. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export function parseConfig(json: string): NodeConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ConfigError("config: not JSON");
  }
  const parsed = CONFIG.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`config: ${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`);
  }
  const c = parsed.data;
  const panel: Panel = { threshold: c.panel.threshold, keys: c.panel.keys };
  let id: Uint8Array;
  try {
    id = panelId(panel);
  } catch (e) {
    if (e instanceof PanelError) throw new ConfigError(`config: panel: ${e.message}`);
    throw e;
  }
  if (!Buffer.from(id).equals(Buffer.from(c.panelId)))
    throw new ConfigError("config: panelId: the panel's keys hash to another identifier");
  if (c.seat > panel.keys.length) throw new ConfigError("config: seat: not a seat of the panel");
  try {
    coordinatorUrl(c.coordinator);
  } catch (e) {
    throw new ConfigError(`config: coordinator: ${(e as Error).message}`);
  }
  return {
    panel,
    l2ChainId: c.l2ChainId,
    trusteeRegistry: c.trusteeRegistry,
    seat: c.seat,
    identityKeyFile: c.identityKeyFile,
    store: c.store,
    coordinator: c.coordinator,
    pollSeconds: c.pollSeconds,
    availability: c.availability && availabilityOf(c.availability, c.seat, panel),
    intake: c.intake && {
      host: c.intake.host,
      port: c.intake.port,
      tls:
        c.intake.tlsCertFile === undefined || c.intake.tlsKeyFile === undefined
          ? undefined
          : { certFile: c.intake.tlsCertFile, keyFile: c.intake.tlsKeyFile },
      queue: c.intake.queue,
    },
  };
}

function availabilityOf(
  a: z.output<typeof AVAILABILITY>,
  seat: number,
  panel: Panel,
): AvailabilityConfig {
  // Neither error quotes the URL, which may hold a provider's key.
  const url = (field: string, parse: (text: string) => URL, text: string) => {
    try {
      return parse(text);
    } catch (e) {
      if (e instanceof RangeError)
        throw new ConfigError(`config: availability.${field}: ${e.message}`);
      throw e;
    }
  };
  return {
    l1: url("l1", parseRpcUrl, a.l1),
    l1ChainId: a.l1ChainId,
    l2: url("l2", parseRpcUrl, a.l2),
    anchor: a.anchor,
    anchorFromBlock: a.anchorFromBlock,
    anchorClock: a.anchorClock,
    registry: a.registry,
    registryFromBlock: a.registryFromBlock,
    board: a.board,
    boardFromBlock: a.boardFromBlock,
    portal: a.portal,
    accountKeyFile: a.accountKeyFile,
    l1MaxFeePerGas: a.l1MaxFeePerGas,
    l2MaxFeePerGas: a.l2MaxFeePerGas,
    forceAfter: a.forceAfterSeconds,
    forceLead: a.forceLeadSeconds,
    sendMargin: a.sendMarginSeconds,
    maxBoardBytes: a.maxBoardBytes,
    gateways: a.gateways.map((g, i) => url(`gateways.${i}`, parseGateway, g)),
    blocks: a.blocks,
    serve: a.serve,
    tally: a.tally && tallyOf(a.tally, seat, panel),
    groupRegistry: a.groupRegistry,
  };
}

function tallyOf(t: z.output<typeof TALLY>, seat: number, panel: Panel): TallyConfig {
  const fail = (field: string, message: string) =>
    new ConfigError(`config: availability.tally.${field}: ${message}`);
  if ((t.tlsCertFile === undefined) !== (t.tlsKeyFile === undefined))
    throw fail("tlsCertFile", "needs both tlsCertFile and tlsKeyFile, or neither");
  if (t.tlsCertFile === undefined && !LOOPBACK.includes(t.host))
    throw fail("host", "plain HTTP only on a loopback address");
  const peers = new Map<number, string>();
  for (const [key, url] of Object.entries(t.peers)) {
    const index = Number(key);
    if (index > panel.keys.length || index === seat)
      throw fail(`peers.${key}`, "not another seat of the panel");
    peers.set(index, url);
  }
  try {
    coordinatorUrl(t.operator, "operator");
  } catch (e) {
    if (e instanceof TypeError || e instanceof RangeError) throw fail("operator", e.message);
    throw e;
  }
  return {
    host: t.host,
    port: t.port,
    tls:
      t.tlsCertFile === undefined || t.tlsKeyFile === undefined
        ? undefined
        : { certFile: t.tlsCertFile, keyFile: t.tlsKeyFile },
    queue: t.queue,
    peers,
    caFile: t.caFile,
    timeoutMs: t.timeoutSeconds * 1000,
    operator: t.operator,
  };
}

/**
 * The seat's identity secret key: 32 bytes as hex in a regular file only
 * its owner can reach, as `FileStore` requires of its root. A key others
 * can read could sign the seat's approvals (T-37).
 */
export function readIdentityKey(path: string): Promise<Uint8Array> {
  return readKeyFile(path, "identity key");
}

/**
 * The availability duty's paying account key, held as the identity key is:
 * it grants no authority over the board (the board takes a record for its
 * seat's signature whoever sends it), but whoever reads it can spend the
 * account's funds and so starve the seat's sends (T-50).
 */
export function readAccountKey(path: string): Promise<Uint8Array> {
  return readKeyFile(path, "account key");
}

/**
 * The intake endpoint's TLS private key, PEM, held as the identity key is:
 * whoever reads it can pose as the seat's endpoint and read each delivery's
 * ballot record (T-11), though never a share, which is sealed to the seat's
 * KEM key.
 */
export function readTlsKey(path: string): Promise<string> {
  return readOwnerFile(path, "TLS key");
}

async function readKeyFile(path: string, what: string): Promise<Uint8Array> {
  const text = (await readOwnerFile(path, what)).replace(/\n$/, "");
  if (!/^[0-9a-f]{64}$/.test(text)) throw new ConfigError(`${what}: expected 64 hex digits`);
  return Uint8Array.from(Buffer.from(text, "hex"));
}

async function readOwnerFile(path: string, what: string): Promise<string> {
  // Opened without following a link and checked through the same handle, so
  // the file checked is the file read.
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    throw new ConfigError(`${what}: ${(e as NodeJS.ErrnoException).code ?? "unreadable"}`);
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new ConfigError(`${what}: not a regular file`);
    if ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
      throw new ConfigError(`${what}: the file must be owned by this user and mode 0600 or 0400`);
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
