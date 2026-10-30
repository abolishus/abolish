// The deployment record ([[deployment]], record 0x0020) built from what the
// deploy script wrote on each chain (packages/contracts/deployments/<chain-id>.json,
// [[P2-32]] part 1b) and the owner's off-chain inputs, so no address, pin or
// panel key is copied into it by hand (T-34, T-37, T-71). The two chain files
// are judged against each other before anything is built: one deployment,
// one commit, and each chain naming the other's contracts where they are
// (T-64). The record is then judged by crypto's well-formedness rules, so
// whatever this returns is a record a release could bind. That the chains
// hold what the files say is the verifier's (1.2) and the release Safe's
// signers' (T-64), and the deploy workflow's, which confirms each file
// against the receipts before committing it.

import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  type DecodedDeploymentRecord,
  type DeploymentFailure,
  type DeploymentGroup,
  deploymentHash,
  deploymentRecordRule,
  type DeploymentSeatRelay,
  type DeploymentTokenKey,
  decodeDeploymentRecord,
  DEPLOYMENT_LIMITS,
  encodeDeploymentRecord,
  PANEL_KINDS,
  panelId,
} from "@abolishus/crypto";

const U32_MAX = 2 ** 32 - 1;
const U64_MAX = 2n ** 64n - 1n;
const SEAT_KEY_BYTES = 33;

/** Which file a malformed value is in: the L1's chain file, the L2's, or the owner's inputs. */
export type DeploymentRecordSource = "l1" | "l2" | "inputs";

/**
 * Why no record was built. `malformed` names the file and the JSON path of
 * the first value that isn't what it must be; a mismatch names what the two
 * chain files disagree on; `address` a contract that isn't at the address
 * its deployer's nonce puts it; `ill-formed` is the first well-formedness rule
 * the record breaks, as crypto names it.
 */
export type DeploymentRecordError =
  | { readonly code: "malformed"; readonly source: DeploymentRecordSource; readonly path: string }
  | {
      readonly code: "mismatch";
      readonly what:
        | "target"
        | "commit"
        | "deployer"
        | "l1-chain"
        | "l2-chain"
        | "board"
        | "anchor"
        | "relay"
        | "epoch";
    }
  | { readonly code: "address"; readonly contract: string }
  | { readonly code: "panel-id" }
  | { readonly code: "seats" }
  | { readonly code: "ill-formed"; readonly failure: DeploymentFailure };

export class DeploymentRecordRefused extends Error {
  override readonly name = "DeploymentRecordRefused";
  readonly error: DeploymentRecordError;
  constructor(error: DeploymentRecordError) {
    super(error.code);
    this.error = error;
  }
}

export interface BuiltDeploymentRecord {
  readonly record: DecodedDeploymentRecord;
  /** Its one encoding, which strict decoding accepts. */
  readonly encoding: Uint8Array;
  /** `deployment_hash` ([[deployment]], Deployment hash), which a release record carries. */
  readonly hash: Uint8Array;
}

/**
 * The deployment record of the deployment `l1` and `l2` (the chain files,
 * parsed JSON) describe, with the off-chain fields from `inputs` (parsed
 * JSON, every key required, no other key allowed; see
 * `apps/admin-cli/README.md`, Deployment record). Its version is the lowest
 * that carries the inputs: 3 with seat relays, otherwise 2 with token keys,
 * otherwise 1, so one set of pins has one record (T-31). Lists whose order
 * the spec fixes are put in that order here; a repeated entry still breaks
 * its rule. Throws `DeploymentRecordRefused` for anything else.
 */
export function buildDeploymentRecord(
  l1: unknown,
  l2: unknown,
  inputs: unknown,
): BuiltDeploymentRecord {
  const a = chainFile(new Reader("l1", l1));
  const b = chainFile(new Reader("l2", l2));
  const l1Pins = l1PinsOf(new Reader("l1", l1).at("pins"));
  const l2Pins = l2PinsOf(new Reader("l2", l2).at("pins"));
  const off = inputsOf(new Reader("inputs", inputs));

  const mismatch = (what: Extract<DeploymentRecordError, { code: "mismatch" }>["what"]) => {
    throw new DeploymentRecordRefused({ code: "mismatch", what });
  };
  // One deployment: the L2 run already refuses an L1 file that isn't its own
  // configuration's, but the files are read here as they were committed.
  if (a.target !== b.target) mismatch("target");
  if (!same(a.commit, b.commit)) mismatch("commit");
  if (!same(a.deployer, b.deployer)) mismatch("deployer");
  if (a.chainId !== l2Pins.l1ChainId) mismatch("l1-chain");
  if (b.chainId !== l1Pins.l2ChainId) mismatch("l2-chain");
  if (!same(l1Pins.board, b.contracts("Board"))) mismatch("board");
  if (!same(l2Pins.l1Anchor, a.contracts("BoardAnchor"))) mismatch("anchor");
  if (!same(l2Pins.l1Relay, a.contracts("BallotRelay"))) mismatch("relay");
  if (l2Pins.epoch !== l1Pins.epoch) mismatch("epoch");
  // Each contract is the deployer's CREATE at its place in the script's
  // order, so an address edited in either file, or a file from another run,
  // is refused rather than pinned (T-34, T-64).
  for (const [file, order] of [
    [a, ["BoardAnchor", "BallotRelay"]],
    [b, ["TrusteeRegistry", "GroupRegistry", "ElectionRegistry", "Board"]],
  ] as const)
    for (const [i, name] of order.entries())
      if (!same(file.contracts(name), createAddress(file.deployer, file.deployerNonce + BigInt(i))))
        throw new DeploymentRecordRefused({ code: "address", contract: name });

  const panel = l2Pins.launchPanel;
  if (off.ours.length !== panel.keys.length) throw new DeploymentRecordRefused({ code: "seats" });
  // The trustee registry computed the identifier on chain; one computed here
  // from the same threshold and keys must agree, or the file's keys aren't
  // the ones the registry pins (T-37).
  let id: Uint8Array | undefined;
  try {
    id = panelId({ threshold: panel.threshold, keys: panel.keys });
  } catch {
    // An invalid panel is left to the rules, which name the seat.
  }
  if (id !== undefined && !same(id, panel.id))
    throw new DeploymentRecordRefused({ code: "panel-id" });

  const v1 = {
    l1_chain_id: a.chainId,
    l2_chain_id: b.chainId,
    election_registry: b.contracts("ElectionRegistry"),
    board: b.contracts("Board"),
    trustee_registry: b.contracts("TrusteeRegistry"),
    group_registry: b.contracts("GroupRegistry"),
    l2_from_block: off.l2FromBlock,
    l2_max_sequencer_drift: off.l2MaxSequencerDrift,
    l1_anchor: a.contracts("BoardAnchor"),
    l1_relay: a.contracts("BallotRelay"),
    l1_portal: l1Pins.portal,
    dispute_game_types: [...off.disputeGameTypes].sort((x, y) => x - y),
    anchor_epoch: l1Pins.epoch,
    anchor_period: l1Pins.period,
    anchor_deadline: l1Pins.deadline,
    anchor_authority: l1Pins.authority,
    contracts_commit: a.commit,
    registrar_threshold: l2Pins.registrarThreshold,
    // As the group registry logs them: the rules judge their order.
    registrars: l2Pins.registrars,
    initial_panel: panel.id,
    panels: [
      {
        kind: panel.kind,
        threshold: panel.threshold,
        seats: panel.keys.map((key, i) => ({ key, ours: off.ours[i] === true })),
      },
    ],
    groups: [...off.groups].sort((x, y) => cmpBig(x.group_id, y.group_id)),
    api: sortedBytes(off.api),
    l2_rpc: sortedBytes(off.l2Rpc),
    l1_rpc: sortedBytes(off.l1Rpc),
    backup_rp_id: off.backupRpId,
    backups: off.backups,
    account_rp_id: off.accountRpId,
    membership_zkey_sha256: off.membershipZkeySha256,
    membership_wasm_sha256: off.membershipWasmSha256,
  };
  const tokenKeys = [...off.tier0TokenKeys].sort((x, y) => x.period - y.period);
  const seatRelays = off.seatRelays
    .map((s) => ({
      key: s.key,
      relays: [...s.relays].sort((x, y) => cmpBytes(x.origin, y.origin)),
    }))
    .sort((x, y) => cmpBytes(x.key, y.key));
  const record: DecodedDeploymentRecord =
    seatRelays.length > 0
      ? { version: 3, value: { ...v1, tier0_token_keys: tokenKeys, seat_relays: seatRelays } }
      : tokenKeys.length > 0
        ? { version: 2, value: { ...v1, tier0_token_keys: tokenKeys } }
        : { version: 1, value: v1 };

  const failure = deploymentRecordRule(record);
  if (failure !== undefined) throw new DeploymentRecordRefused({ code: "ill-formed", failure });
  const encoding = encodeDeploymentRecord(record);
  // Decoded back, so the hash is of bytes a strict reader accepts (T-31).
  decodeDeploymentRecord(encoding);
  return { record, encoding, hash: deploymentHash(encoding) };
}

interface ChainFile {
  readonly target: string;
  readonly chainId: bigint;
  readonly deployer: Uint8Array;
  readonly deployerNonce: bigint;
  readonly commit: Uint8Array;
  readonly contracts: (name: string) => Uint8Array;
}

function chainFile(r: Reader): ChainFile {
  const target = r.at("target").string();
  const chainId = r.at("chainId").u64();
  const deployer = r.at("deployer").address();
  const deployerNonce = r.at("deployerNonce").u64();
  const commit = r.at("commit").commit();
  const contracts = r.at("contracts");
  return {
    target,
    chainId,
    deployer,
    deployerNonce,
    commit,
    contracts: (name) => contracts.at(name).at("address").address(),
  };
}

function l1PinsOf(r: Reader) {
  const anchor = r.at("anchor");
  return {
    l2ChainId: r.at("l2ChainId").u64(),
    board: r.at("board").address(),
    epoch: anchor.at("epoch").u64(),
    period: anchor.at("period").u64(),
    deadline: anchor.at("deadline").u64(),
    authority: anchor.at("authority").at("address").address(),
    portal: r.at("portal").address(),
  };
}

function l2PinsOf(r: Reader) {
  const p = r.at("launchPanel");
  const size = p.at("size").uint(16);
  const keys = p.at("keys").hex();
  if (keys.length !== size * SEAT_KEY_BYTES) p.at("keys").refuse();
  const kind = p.at("kind").uint(2);
  if (kind !== PANEL_KINDS.independent && kind !== PANEL_KINDS.transitional) p.at("kind").refuse();
  const registrars = r.at("registrars");
  return {
    l1ChainId: r.at("l1ChainId").u64(),
    l1Anchor: r.at("l1Anchor").address(),
    l1Relay: r.at("l1Relay").address(),
    epoch: r.at("epoch").u64(),
    launchPanel: {
      id: p.at("id").fixedHex(32),
      threshold: p.at("threshold").uint(255),
      kind: kind as 1 | 2,
      keys: Array.from({ length: size }, (_, i) =>
        keys.slice(i * SEAT_KEY_BYTES, (i + 1) * SEAT_KEY_BYTES),
      ),
    },
    registrarThreshold: registrars.at("threshold").uint(255),
    registrars: registrars
      .at("addresses")
      .list(DEPLOYMENT_LIMITS.registrars)
      .map((x) => x.address()),
  };
}

const INPUT_KEYS = [
  "l2FromBlock",
  "l2MaxSequencerDrift",
  "disputeGameTypes",
  "ours",
  "groups",
  "api",
  "l2Rpc",
  "l1Rpc",
  "backupRpId",
  "backups",
  "accountRpId",
  "membershipZkeySha256",
  "membershipWasmSha256",
  "tier0TokenKeys",
  "seatRelays",
] as const;

function inputsOf(r: Reader) {
  r.keys(INPUT_KEYS);
  const L = DEPLOYMENT_LIMITS;
  const text = (max: number) => (x: Reader) => x.text(max);
  return {
    // Decimal strings, as a u64 may be past what a JSON number holds exactly.
    l2FromBlock: r.at("l2FromBlock").decimal(),
    l2MaxSequencerDrift: r.at("l2MaxSequencerDrift").u64(),
    disputeGameTypes: r
      .at("disputeGameTypes")
      .list(L.gameTypes)
      .map((x) => x.uint(U32_MAX)),
    ours: r
      .at("ours")
      .list(L.seats)
      .map((x) => x.bool()),
    groups: r
      .at("groups")
      .list(L.groups)
      .map((g): DeploymentGroup => {
        g.keys(["groupId", "tier", "selfPaid", "region"]);
        const tier = g.at("tier").uint(1);
        return {
          group_id: g.at("groupId").decimal(),
          tier: tier as 0 | 1,
          self_paid: g.at("selfPaid").bool(),
          region: g.at("region").uint(U32_MAX),
        };
      }),
    api: r.at("api").list(L.origins).map(text(L.origin)),
    l2Rpc: r.at("l2Rpc").list(L.origins).map(text(L.origin)),
    l1Rpc: r.at("l1Rpc").list(L.origins).map(text(L.origin)),
    backupRpId: text(L.rpId)(r.at("backupRpId")),
    backups: r.at("backups").bool(),
    accountRpId: text(L.rpId)(r.at("accountRpId")),
    membershipZkeySha256: r.at("membershipZkeySha256").fixedHex(32),
    membershipWasmSha256: r.at("membershipWasmSha256").fixedHex(32),
    tier0TokenKeys: r
      .at("tier0TokenKeys")
      .list(L.tokenKeys)
      .map((k): DeploymentTokenKey => {
        k.keys(["period", "key", "retired"]);
        return {
          period: k.at("period").uint(U32_MAX),
          key: k.at("key").fixedHex(32),
          retired: k.at("retired").bool(),
        };
      }),
    seatRelays: r
      .at("seatRelays")
      .list(L.seatRelays)
      .map((s): DeploymentSeatRelay => {
        s.keys(["key", "relays"]);
        return {
          key: s.at("key").fixedHex(SEAT_KEY_BYTES),
          relays: s
            .at("relays")
            .list(L.relays)
            .map((x) => {
              x.keys(["origin", "path"]);
              return {
                origin: text(L.origin)(x.at("origin")),
                path: text(L.relayPath)(x.at("path")),
              };
            }),
        };
      }),
  };
}

/** A value in one of the files, with its JSON path, for `malformed`'s report. */
class Reader {
  private readonly source: DeploymentRecordSource;
  private readonly value: unknown;
  private readonly path: string;

  constructor(source: DeploymentRecordSource, value: unknown, path = "") {
    this.source = source;
    this.value = value;
    this.path = path;
  }

  refuse(): never {
    throw new DeploymentRecordRefused({
      code: "malformed",
      source: this.source,
      path: this.path === "" ? "." : this.path,
    });
  }

  private object(): Record<string, unknown> {
    if (typeof this.value !== "object" || this.value === null || Array.isArray(this.value))
      this.refuse();
    return this.value as Record<string, unknown>;
  }

  at(key: string): Reader {
    const o = this.object();
    const path = `${this.path}.${key}`;
    // Own properties only, so `constructor` or `__proto__` is never a value.
    if (!Object.hasOwn(o, key)) new Reader(this.source, undefined, path).refuse();
    return new Reader(this.source, o[key], path);
  }

  /** Refuses a key outside `allowed`: a misspelt one would otherwise be dropped unseen. */
  keys(allowed: readonly string[]): void {
    for (const key of Object.keys(this.object()))
      if (!allowed.includes(key))
        new Reader(this.source, undefined, `${this.path}.${key}`).refuse();
  }

  /** A list of at most `max` entries, the record's bound for it, so none is cut off unseen (T-52). */
  list(max: number): Reader[] {
    if (!Array.isArray(this.value) || this.value.length > max) this.refuse();
    return this.value.map((v, i) => new Reader(this.source, v, `${this.path}[${i}]`));
  }

  string(): string {
    if (typeof this.value !== "string") this.refuse();
    return this.value;
  }

  /** A string as UTF-8 of at most `max` bytes; the rules judge its grammar. */
  text(max: number): Uint8Array {
    const b = new TextEncoder().encode(this.string());
    if (b.length > max) this.refuse();
    return b;
  }

  bool(): boolean {
    if (typeof this.value !== "boolean") this.refuse();
    return this.value;
  }

  /** A JSON integer from 0 to `max`, which must be a safe integer. */
  uint(max: number): number {
    // `-0` is never what the script writes.
    if (typeof this.value !== "number" || !Number.isSafeInteger(this.value)) this.refuse();
    if (Object.is(this.value, -0)) this.refuse();
    if (this.value < 0 || this.value > max) this.refuse();
    return this.value;
  }

  /**
   * A JSON number that is a u64. Above 2^53 JSON.parse may already have
   * rounded it, so only a safe integer is taken: a chain ID, nonce or time
   * the script writes is far below.
   */
  u64(): bigint {
    return BigInt(this.uint(Number.MAX_SAFE_INTEGER));
  }

  /** A u64 as a decimal string with no sign or leading zero. */
  decimal(): bigint {
    const s = this.string();
    if (!/^(0|[1-9][0-9]{0,19})$/.test(s) || BigInt(s) > U64_MAX) this.refuse();
    return BigInt(s);
  }

  /** `0x` and an even number of hex digits, either case, as forge prints bytes. */
  hex(): Uint8Array {
    const s = this.string();
    if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) this.refuse();
    return Uint8Array.from(s.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16));
  }

  fixedHex(n: number): Uint8Array {
    const b = this.hex();
    if (b.length !== n) this.refuse();
    return b;
  }

  /**
   * An address as forge prints it: `0x` and 40 hex digits, and if their
   * case is mixed, EIP-55's checksum, so a digit edited by hand is caught.
   */
  address(): Uint8Array {
    const b = this.fixedHex(20);
    const digits = this.string().slice(2);
    if (digits !== digits.toLowerCase() && digits !== digits.toUpperCase()) {
      const lower = digits.toLowerCase();
      const hash = keccak_256(new TextEncoder().encode(lower));
      const sum = Array.from(lower, (c, i) => {
        const nibble = ((hash[i >> 1] ?? 0) >> (i % 2 === 0 ? 4 : 0)) & 0xf;
        return nibble >= 8 ? c.toUpperCase() : c;
      }).join("");
      if (sum !== digits) this.refuse();
    }
    return b;
  }

  /** The deploy script's commit: 40 lower-case hex digits, no `0x` (its `_checkCommit`). */
  commit(): Uint8Array {
    const s = this.string();
    if (!/^[0-9a-f]{40}$/.test(s)) this.refuse();
    return Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
  }
}

/** `keccak256(rlp([deployer, nonce]))[12..]`, the address CREATE gives a contract. */
function createAddress(deployer: Uint8Array, nonce: bigint): Uint8Array {
  const n: number[] = [];
  for (let v = nonce; v > 0n; v >>= 8n) n.unshift(Number(v & 0xffn));
  // RLP: 0 is the empty string, a byte below 0x80 is itself, else a length prefix.
  const encodedNonce =
    n.length === 0 ? [0x80] : n.length === 1 && (n[0] ?? 0) < 0x80 ? n : [0x80 + n.length, ...n];
  const body = [0x80 + 20, ...deployer, ...encodedNonce];
  return keccak_256(Uint8Array.from([0xc0 + body.length, ...body])).slice(12);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return a.length - b.length;
}

function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedBytes(list: readonly Uint8Array[]): Uint8Array[] {
  return [...list].sort(cmpBytes);
}
