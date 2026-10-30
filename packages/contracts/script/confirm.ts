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
// must be created by one. It prints the record with each contract's
// creating transaction and block added, which the services' creation blocks
// and `l2_from_block` need and the script can't know.
//
//   RPC_URL=<url> vp node script/confirm.ts <record> <broadcast> <artifacts>
//
// The URL is read from the environment: an RPC URL can carry a provider's
// key, and arguments end up in logs. The artifacts directory is required:
// the default `out/` is what `forge script` itself rebuilt, so comparing
// against it couldn't catch a build that differs from the release build.

import { readFileSync } from "node:fs";
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

/**
 * The runtime code `name` must have once deployed: the build's
 * `deployedBytecode` with each immutable's bytes taken from `code`, so only
 * the immutables (constructor arguments and addresses) may differ.
 */
function expected(artifacts: string, name: string, code: Uint8Array): Uint8Array {
  const artifact = JSON.parse(readFileSync(`${artifacts}/${name}.sol/${name}.json`, "utf8")) as {
    deployedBytecode: {
      object: string;
      immutableReferences?: { [id: string]: { start: number; length: number }[] };
    };
  };
  const built = hexToBytes(artifact.deployedBytecode.object.slice(2));
  if (built.length !== code.length) return built;
  for (const refs of Object.values(artifact.deployedBytecode.immutableReferences ?? {}))
    for (const { start, length } of refs) built.set(code.subarray(start, start + length), start);
  return built;
}

/** The address `creator` gives its CREATE at `nonce`, which here is below 0x80. */
function createAddress(creator: string, nonce: number): string {
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
    if (!equal(code, expected(artifacts, name, code)))
      throw new ConfirmError(name, "code isn't the build's beyond its immutables");
    contracts[name] = { ...c, transaction: creator.hash, block: Number(receipt.blockNumber) };
  }
  return { ...record, contracts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
