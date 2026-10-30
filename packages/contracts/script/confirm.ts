// Confirms a deployment record (`deployments/<chain-id>.json`) against the
// chain, after `script/Deploy.s.sol` has broadcast it (P2-32 part 3). The
// script writes its record while simulating, before forge sends anything,
// so a broadcast that fails part-way leaves a record of contracts that may
// not all exist (README, Deploy script). This takes only the transaction
// hashes from forge's broadcast file and asks the chain for everything else:
// each contract's creating transaction is the deployer's, at its nonce in
// order, succeeded and created that address; the code there hashes to the
// record's `codehash`; and that code is the build's `deployedBytecode` with
// only the immutables differing (T-64, T-34). Every transaction in the
// broadcast must create a recorded contract, and every recorded contract
// must be created by one. Since that comparison lets any immutable through,
// every immutable, and every value the record's `pins` give, is then read
// back from the chain and must be the record's. It prints the record with each contract's
// creating transaction and block added, which the services' creation blocks
// and `l2_from_block` need and the script can't know.
//
//   RPC_URL=<url> vp node script/confirm.ts <record> <broadcast> <artifacts>
//
// The URL is read from the environment: an RPC URL can carry a provider's
// key, and arguments end up in logs. The artifacts directory is required:
// the default `out/` is what `forge script` itself rebuilt, so comparing
// against it couldn't catch a build that differs from the release build.

import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export class ConfirmError extends Error {
  constructor(contract: string, reason: string) {
    super(`${contract}: ${reason}`);
  }
}

export interface Contract {
  readonly address: string;
  readonly codehash: string;
}

export interface DeploymentRecord {
  readonly chainId: number;
  readonly deployer: string;
  readonly deployerNonce: number;
  readonly contracts: { readonly [name: string]: Contract };
  readonly [key: string]: unknown;
}

export interface Confirmed extends DeploymentRecord {
  readonly contracts: {
    readonly [name: string]: Contract & { readonly transaction: string; readonly block: number };
  };
}

interface BroadcastTransaction {
  readonly hash: string;
  readonly transactionType: string;
  readonly contractName: string | null;
  readonly contractAddress: string | null;
  readonly additionalContracts: readonly {
    readonly transactionType: string;
    readonly contractName: string | null;
    readonly address: string;
  }[];
}

interface Broadcast {
  readonly chain: number;
  readonly transactions: readonly BroadcastTransaction[];
}

export type Rpc = <T>(method: string, params: readonly unknown[]) => Promise<T>;

export function httpRpc(url: string): Rpc {
  return async <T>(method: string, params: readonly unknown[]) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
    const body = (await response.json()) as { result?: T; error?: { message: string } };
    if (body.error !== undefined) throw new Error(`${method}: ${body.error.message}`);
    if (body.result === undefined) throw new Error(`${method}: no result`);
    return body.result;
  };
}

const same = (a: string | null | undefined, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

interface Artifact {
  readonly deployedBytecode: {
    readonly object: string;
    readonly immutableReferences?: { readonly [id: string]: { start: number; length: number }[] };
  };
}

const artifactOf = (artifacts: string, name: string) =>
  JSON.parse(readFileSync(`${artifacts}/${name}.sol/${name}.json`, "utf8")) as Artifact;

/**
 * The runtime code `name` must have once deployed: the build's
 * `deployedBytecode` with each immutable's bytes taken from `code`, so only
 * the immutables (constructor arguments and addresses) may differ.
 */
function expected(artifact: Artifact, code: Uint8Array): Uint8Array {
  const built = hexToBytes(artifact.deployedBytecode.object.slice(2));
  if (built.length !== code.length) return built;
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {}))
    for (const { start, length } of refs) built.set(code.subarray(start, start + length), start);
  return built;
}

/** One ABI word, as 64 lower-case hex digits. */
const word = (hex: string) => hex.slice(2).toLowerCase().padStart(64, "0");
const uint = (n: bigint) => n.toString(16).padStart(64, "0");
const selector = (signature: string) =>
  bytesToHex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4));

/**
 * A view the record says what it must return: `want` is the whole return
 * data, or a test of it. `immutables` is how many of the contract's
 * immutables the view reads back, so that every immutable the build has is
 * read by one (a storage pin, or another contract's, reads none).
 */
interface Read {
  readonly getter: string;
  readonly args?: readonly string[];
  readonly to?: string;
  readonly want: string | ((data: string) => boolean);
  readonly immutables?: number;
}

/** The record's `pins`, each value checked for its form as it is taken. */
function pinsOf(record: DeploymentRecord) {
  const at = (path: string): unknown => {
    let v: unknown = record["pins"];
    for (const key of path.split(".")) {
      if (typeof v !== "object" || v === null || !Object.hasOwn(v, key))
        throw new ConfirmError("pins", `no ${path}`);
      v = (v as Record<string, unknown>)[key];
    }
    return v;
  };
  const hex = (path: string, bytes: number) => {
    const v = at(path);
    if (typeof v !== "string" || !new RegExp(`^0x([0-9a-fA-F]{2}){${bytes}}$`).test(v))
      throw new ConfirmError("pins", `${path} isn't ${bytes} bytes of hex`);
    return v.toLowerCase();
  };
  const integer = (path: string) => {
    const v = at(path);
    // A safe JSON integer, or a decimal string for what a JSON number can't carry.
    if (Number.isSafeInteger(v) && (v as number) >= 0) return BigInt(v as number);
    if (typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v)) return BigInt(v);
    throw new ConfirmError("pins", `${path} isn't an unsigned integer`);
  };
  const list = (path: string) => {
    const v = at(path);
    if (!Array.isArray(v) || v.length === 0) throw new ConfirmError("pins", `${path} isn't a list`);
    return v.map((_, i) => hex(`${path}.${i}`, 20));
  };
  return { at, address: (path: string) => hex(path, 20), hex, integer, list };
}

/** `address[]` as a function returns it alone. */
const addresses = (list: readonly string[]) =>
  `0x${uint(32n)}${uint(BigInt(list.length))}${list.map(word).join("")}`;

/** A Safe's owners and threshold, as the record gives them (T-69). */
const safe = (pins: ReturnType<typeof pinsOf>, path: string): Read[] => [
  {
    to: pins.address(`${path}.address`),
    getter: "getOwners()",
    want: addresses(pins.list(`${path}.owners`)),
  },
  {
    to: pins.address(`${path}.address`),
    getter: "getThreshold()",
    want: `0x${uint(pins.integer(`${path}.threshold`))}`,
  },
];

/**
 * What each contract's views must return, from the record's pins and the
 * other recorded addresses (T-64, T-34). The code comparison lets any
 * immutable through, and a constructor's storage writes aren't in the code
 * at all, so a contract built from other creation code with the release's
 * runtime code would otherwise pass. A contract not listed has no immutables.
 */
function reads(record: DeploymentRecord, chainId: bigint): { [name: string]: Read[] } {
  const pins = pinsOf(record);
  const address = (name: string) => {
    const c = record.contracts[name];
    if (c === undefined) throw new ConfirmError(name, "not in the record");
    return `0x${word(c.address)}`;
  };
  const is = (value: string) => `0x${word(value)}`;
  const n = (value: bigint) => `0x${uint(value)}`;
  const has = (name: string) => Object.hasOwn(record.contracts, name);
  const out: { [name: string]: Read[] } = {};

  if (has("BoardAnchor"))
    out["BoardAnchor"] = [
      { getter: "epoch()", want: n(pins.integer("anchor.epoch")), immutables: 1 },
      { getter: "period()", want: n(pins.integer("anchor.period")), immutables: 1 },
      { getter: "deadline()", want: n(pins.integer("anchor.deadline")), immutables: 1 },
      { getter: "authority()", want: is(pins.address("anchor.authority.address")), immutables: 1 },
      ...safe(pins, "anchor.authority"),
    ];
  if (has("BallotRelay"))
    out["BallotRelay"] = [
      { getter: "portal()", want: is(pins.address("portal")), immutables: 1 },
      { getter: "board()", want: is(pins.address("board")), immutables: 1 },
    ];
  if (has("TrusteeRegistry")) {
    // The launch panel is the only panel the record lists, and its
    // identifier is the hash of its threshold, size and keys (DS_PANEL).
    const id = pins.hex("launchPanel.id", 32);
    const threshold = pins.integer("launchPanel.threshold");
    const size = pins.integer("launchPanel.size");
    if (threshold > 255n || size > 255n)
      throw new ConfirmError("pins", "launchPanel's threshold or size exceeds u8");
    const keys = hexToBytes(pins.hex("launchPanel.keys", Number(size) * 33).slice(2));
    const computed = sha256(
      new Uint8Array([
        16,
        ...new TextEncoder().encode("abolish/v1/panel"),
        Number(threshold),
        Number(size),
        ...keys,
      ]),
    );
    if (`0x${bytesToHex(computed)}` !== id)
      throw new ConfirmError("pins", "launchPanel.id isn't its threshold's, size's and keys' hash");
    out["TrusteeRegistry"] = [
      { getter: "panelCount()", want: n(1n) },
      { getter: "panelIds(uint256)", args: [uint(0n)], want: id },
      {
        getter: "panelOf(bytes32)",
        args: [word(id)],
        want: `0x${uint(threshold)}${uint(size)}${uint(pins.integer("launchPanel.quorum"))}`,
      },
      { getter: "kindOf(bytes32)", args: [word(id)], want: n(pins.integer("launchPanel.kind")) },
      // Each seat's key as the registry holds it, `(x, y)`: the record's
      // compressed key is its prefix (2 + y's parity) and x.
      ...Array.from({ length: Number(size) }, (_, i): Read => {
        const key = keys.subarray(i * 33, (i + 1) * 33);
        return {
          getter: "keyOf(bytes32,uint256)",
          args: [word(id), uint(BigInt(i + 1))],
          want: (data) =>
            data.length === 130 &&
            data.slice(2, 66) === bytesToHex(key.subarray(1)) &&
            key[0] === 2 + (parseInt(data.slice(-1), 16) & 1),
        };
      }),
    ];
  }
  if (has("GroupRegistry")) {
    const typehash = (s: string) => bytesToHex(keccak_256(new TextEncoder().encode(s)));
    const domain = bytesToHex(
      keccak_256(
        hexToBytes(
          typehash(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
          ) +
            typehash("Abolish group registry") +
            typehash("1") +
            uint(chainId) +
            word(address("GroupRegistry")),
        ),
      ),
    );
    out["GroupRegistry"] = [
      { getter: "threshold()", want: n(pins.integer("registrars.threshold")), immutables: 1 },
      { getter: "registrars()", want: addresses(pins.list("registrars.addresses")) },
      { getter: "trusteeRegistry()", want: address("TrusteeRegistry"), immutables: 1 },
      { getter: "initialPanelId()", want: pins.hex("launchPanel.id", 32), immutables: 1 },
      // The cached separator and the chain it was cached for: on this chain
      // the view returns the cached one, which must be this chain's and
      // this address's.
      { getter: "domainSeparator()", want: `0x${domain}`, immutables: 2 },
    ];
  }
  if (has("ElectionRegistry"))
    out["ElectionRegistry"] = [
      { getter: "board()", want: address("Board"), immutables: 1 },
      { getter: "trusteeRegistry()", want: address("TrusteeRegistry"), immutables: 1 },
      { getter: "groupRegistry()", want: address("GroupRegistry"), immutables: 1 },
      { getter: "l1ChainId()", want: n(pins.integer("l1ChainId")), immutables: 1 },
      { getter: "l1Anchor()", want: is(pins.address("l1Anchor")), immutables: 1 },
      { getter: "l1Relay()", want: is(pins.address("l1Relay")), immutables: 1 },
      { getter: "epoch()", want: n(pins.integer("epoch")), immutables: 1 },
    ];
  if (has("Board"))
    out["Board"] = [
      { getter: "electionRegistry()", want: address("ElectionRegistry"), immutables: 1 },
      { getter: "trusteeRegistry()", want: address("TrusteeRegistry"), immutables: 1 },
      { getter: "relay()", want: is(pins.address("l1Relay")), immutables: 1 },
      // A board from other creation code could name other code while a
      // genuine ballot check sits at its first CREATE address.
      { getter: "ballotCheck()", want: address("BallotCheck"), immutables: 1 },
    ];
  if (has("RegistrationAccount"))
    out["RegistrationAccount"] = [
      { getter: "entryPoint()", want: is(pins.address("registration.entryPoint")), immutables: 1 },
      { getter: "owner()", want: is(pins.address("registration.serviceOwner")), immutables: 1 },
    ];
  if (has("RegistrationPaymaster"))
    out["RegistrationPaymaster"] = [
      { getter: "entryPoint()", want: is(pins.address("registration.entryPoint")), immutables: 1 },
      { getter: "registry()", want: address("GroupRegistry"), immutables: 1 },
      { getter: "service()", want: address("RegistrationAccount"), immutables: 1 },
      {
        getter: "admin()",
        want: is(pins.address("registration.admin.address")),
        immutables: 1,
      },
      { getter: "maxCost()", want: n(pins.integer("registration.maxCost")), immutables: 1 },
      {
        to: pins.address("registration.admin.address"),
        getter: "getMinDelay()",
        want: n(pins.integer("registration.admin.minDelay")),
      },
      ...safe(pins, "registration.admin.safe"),
    ];
  return out;
}

/** The address `creator` gives its CREATE at `nonce`, which here is below 0x80. */
export function createAddress(creator: string, nonce: number): string {
  // RLP of [creator, nonce]: a 21-byte string and a one-byte integer, which
  // a larger nonce wouldn't be.
  if (nonce < 1 || nonce >= 0x80) throw new RangeError(`nonce ${nonce}`);
  const rlp = new Uint8Array([0xd6, 0x94, ...hexToBytes(creator.slice(2)), nonce]);
  return `0x${bytesToHex(keccak_256(rlp).subarray(12))}`;
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export async function confirm(
  record: DeploymentRecord,
  broadcast: Broadcast,
  rpc: Rpc,
  artifacts: string,
): Promise<Confirmed> {
  const chainId = Number(await rpc<string>("eth_chainId", []));
  if (chainId !== record.chainId || broadcast.chain !== record.chainId)
    throw new ConfirmError("chain", `RPC ${chainId}, broadcast ${broadcast.chain}`);

  // Which transaction created each contract: its own CREATE, or a contract
  // its constructor created (the board's ballot check).
  const creators = new Map<string, { hash: string; nonce: number; created: string | null }>();
  const recorded = new Map(
    Object.entries(record.contracts).map(([name, c]) => [c.address.toLowerCase(), name]),
  );
  const claim = (
    name: string | null,
    address: string | null,
    t: BroadcastTransaction,
    nonce: number,
  ) => {
    const at = address?.toLowerCase() ?? "";
    const owner = recorded.get(at);
    if (owner === undefined || owner !== name || creators.has(owner))
      throw new ConfirmError(name ?? t.hash, `creates ${address ?? "nothing"}, not as recorded`);
    creators.set(owner, { hash: t.hash, nonce, created: t.contractAddress });
  };
  broadcast.transactions.forEach((t, i) => {
    if (t.transactionType !== "CREATE")
      throw new ConfirmError(t.contractName ?? t.hash, `a ${t.transactionType}, not a CREATE`);
    claim(t.contractName, t.contractAddress, t, i);
    t.additionalContracts.forEach((a, j) => {
      if (a.transactionType !== "CREATE")
        throw new ConfirmError(a.contractName ?? a.address, `a ${a.transactionType}`);
      // Its creator's CREATEs in order, from nonce 1 (EIP-161): the address
      // the creator pins as an immutable is its own (T-64).
      if (t.contractAddress === null || !same(a.address, createAddress(t.contractAddress, j + 1)))
        throw new ConfirmError(a.contractName ?? a.address, "not its creator's CREATE address");
      claim(a.contractName, a.address, t, i);
    });
  });

  const views = reads(record, BigInt(chainId));
  const contracts: { [name: string]: Contract & { transaction: string; block: number } } = {};
  for (const [name, c] of Object.entries(record.contracts)) {
    const creator = creators.get(name);
    if (creator === undefined) throw new ConfirmError(name, "no transaction in the broadcast");
    const tx = await rpc<{ from: string; to: string | null; nonce: string } | null>(
      "eth_getTransactionByHash",
      [creator.hash],
    );
    const receipt = await rpc<{
      status: string;
      blockNumber: string;
      contractAddress: string | null;
    } | null>("eth_getTransactionReceipt", [creator.hash]);
    if (tx === null || receipt === null) throw new ConfirmError(name, "transaction not mined");
    if (!same(tx.from, record.deployer) || tx.to !== null)
      throw new ConfirmError(name, `sent by ${tx.from}, to ${tx.to ?? "none"}`);
    // The deployer's transactions in the script's order, from its starting
    // nonce, so the addresses are the CREATE addresses the other chain pins.
    if (Number(tx.nonce) !== record.deployerNonce + creator.nonce)
      throw new ConfirmError(name, `sent at nonce ${Number(tx.nonce)}`);
    if (receipt.status !== "0x1") throw new ConfirmError(name, "transaction reverted");
    // A contract created by another's constructor is judged by its code
    // below; its creator's receipt names the creator.
    if (creator.created === null || !same(receipt.contractAddress, creator.created))
      throw new ConfirmError(name, `receipt created ${receipt.contractAddress ?? "nothing"}`);

    const code = hexToBytes((await rpc<string>("eth_getCode", [c.address, "latest"])).slice(2));
    if (code.length === 0) throw new ConfirmError(name, "no code");
    if (`0x${bytesToHex(keccak_256(code))}` !== c.codehash.toLowerCase())
      throw new ConfirmError(name, "code doesn't hash to the record's codehash");
    const artifact = artifactOf(artifacts, name);
    if (!equal(code, expected(artifact, code)))
      throw new ConfirmError(name, "code isn't the build's beyond its immutables");
    const built = Object.keys(artifact.deployedBytecode.immutableReferences ?? {}).length;
    const read = (views[name] ?? []).reduce((sum, r) => sum + (r.immutables ?? 0), 0);
    if (read !== built)
      throw new ConfirmError(name, `the build has ${built} immutables, ${read} are read back`);
    contracts[name] = { ...c, transaction: creator.hash, block: Number(receipt.blockNumber) };
  }
  for (const [name, list] of Object.entries(views))
    for (const { getter, args = [], to, want } of list) {
      const target = to ?? record.contracts[name]!.address;
      const data = await rpc<string>("eth_call", [
        { to: target, data: `0x${selector(getter)}${args.join("")}` },
        "latest",
      ]);
      if (typeof want === "string" ? data.toLowerCase() !== want : !want(data.toLowerCase()))
        throw new ConfirmError(
          name,
          `${to === undefined ? "" : `${to}'s `}${getter} reads ${data}, not the record's`,
        );
    }
  // The EntryPoint both registration contracts pin is the code the record names.
  if (
    Object.hasOwn(views, "RegistrationAccount") ||
    Object.hasOwn(views, "RegistrationPaymaster")
  ) {
    const pins = pinsOf(record);
    const entryPoint = pins.address("registration.entryPoint");
    const code = hexToBytes((await rpc<string>("eth_getCode", [entryPoint, "latest"])).slice(2));
    if (`0x${bytesToHex(keccak_256(code))}` !== pins.hex("registration.entryPointCodehash", 32))
      throw new ConfirmError("EntryPoint", "code doesn't hash to the record's entryPointCodehash");
  }
  return { ...record, contracts };
}

// Compared as resolved file URLs: a path that needs encoding or a symlink
// would otherwise skip the command and exit 0 having checked nothing.
const main = process.argv[1];
if (main !== undefined && import.meta.url === pathToFileURL(realpathSync(main)).href) {
  const [recordFile, broadcastFile, artifacts] = process.argv.slice(2);
  const url = process.env["RPC_URL"];
  if (
    recordFile === undefined ||
    broadcastFile === undefined ||
    artifacts === undefined ||
    url === undefined
  ) {
    console.error(
      "usage: RPC_URL=<url> vp node script/confirm.ts <record> <broadcast> <artifacts>",
    );
    process.exit(2);
  }
  const read = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;
  try {
    const confirmed = await confirm(
      read<DeploymentRecord>(recordFile),
      read<Broadcast>(broadcastFile),
      httpRpc(url),
      artifacts,
    );
    process.stdout.write(`${JSON.stringify(confirmed, null, 2)}\n`);
  } catch (e) {
    console.error(e instanceof ConfirmError ? `refused: ${e.message}` : e);
    process.exit(1);
  }
}
