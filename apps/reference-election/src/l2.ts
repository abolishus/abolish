// The fixture's L2: a second local Anvil holding the registries and the board
// (packages/contracts), deployed from forge's build output, with the panel
// pinned in the trustee registry, each election created and its ceremony and
// definition registered through the contracts' own checks
// (docs/spec/contracts.md, Trustee registry and Election registry). The OP
// Stack's L1Block predeploy, which Anvil lacks, is forge's MockL1Block, set
// before each event to the L1 Anvil's latest block.

import { readFileSync } from "node:fs";
import {
  checkCeremonyTranscript,
  encodeCeremonyRegistration,
  keySetEntry,
  keySetHash,
  type Panel,
  signCeremonyRegistration,
} from "@abolishus/crypto";
import { p256 } from "@noble/curves/nist.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import { type Rpc, RpcError } from "./anvil.ts";
import {
  type Ceremony,
  definitionBytes,
  definitionHash,
  type FixtureDefinition,
  type L2Deployment,
  placeholder,
  stubHash,
  type Trustees,
} from "./election.ts";
import { padded, send, word } from "./l1.ts";
import { encodeRlp, uintBytes } from "./rlp.ts";

const OUT = new URL("../../../packages/contracts/out/", import.meta.url);
/** The OP Stack's L1Block predeploy, a constant of the election registry. */
const L1_BLOCK = hexToBytes("4200000000000000000000000000000000000015");

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const unhex = (s: string) => hexToBytes(s.startsWith("0x") ? s.slice(2) : s);
const selector = (signature: string) => keccak_256(new TextEncoder().encode(signature)).slice(0, 4);
const address = (a: Uint8Array) => word(BigInt(hex(a)));
const equalBytes = (a: Uint8Array, b: Uint8Array) => hex(a) === hex(b);

function artifact(name: string): { bytecode: Uint8Array; deployed: Uint8Array } {
  const json = JSON.parse(readFileSync(new URL(`${name}.sol/${name}.json`, OUT), "utf8")) as {
    bytecode: { object: string };
    deployedBytecode: { object: string };
  };
  return { bytecode: unhex(json.bytecode.object), deployed: unhex(json.deployedBytecode.object) };
}

/** The address a CREATE from `sender` at `nonce` deploys to. */
export function createAddress(sender: Uint8Array, nonce: bigint): Uint8Array {
  return keccak_256(encodeRlp([sender, uintBytes(nonce)])).slice(12);
}

/**
 * Calldata for a function taking one `bytes` argument, in the one encoding
 * the contracts accept (CanonicalCalldata): the offset, the length, the bytes
 * zero-padded to a word, nothing after.
 */
export function bytesCalldata(signature: string, arg: Uint8Array): Uint8Array {
  return concatBytes(selector(signature), word(32n), word(BigInt(arg.length)), padded(arg));
}

/** A `p256-key` as the trustee registry's `(x, y)`. */
function point(key: Uint8Array): readonly [bigint, bigint] {
  const { x, y } = p256.Point.fromBytes(key).toAffine();
  return [x, y];
}

/**
 * The trustee registry's constructor argument `PanelInput[]`, one panel:
 * `(uint8 threshold, uint8 quorum, bytes keys, uint256[2][] points)`.
 */
function panelInputs(panel: Panel, quorum: number): Uint8Array {
  const keys = concatBytes(...panel.keys);
  const keysPart = concatBytes(word(BigInt(keys.length)), padded(keys));
  const pointsPart = concatBytes(
    word(BigInt(panel.keys.length)),
    ...panel.keys.flatMap((k) => point(k).map(word)),
  );
  const tuple = concatBytes(
    word(BigInt(panel.threshold)),
    word(BigInt(quorum)),
    word(128n),
    word(128n + BigInt(keysPart.length)),
    keysPart,
    pointsPart,
  );
  // The argument's offset, the array's length, the tuple's offset in it.
  return concatBytes(word(32n), word(1n), word(32n), tuple);
}

export interface L2 extends L2Deployment {
  readonly rpc: Rpc;
  /** The account that deployed the contracts and creates the elections. */
  readonly operator: string;
}

/** The deployment's fixed inputs. */
export interface L2Inputs {
  readonly l2ChainId: bigint;
  readonly l1ChainId: bigint;
  readonly l1Anchor: Uint8Array;
  /** The anchoring clock's epoch: no election opens before it. */
  readonly epoch: bigint;
  readonly panel: Panel;
  /** How many distinct seats must sign a ceremony registration. */
  readonly quorum: number;
}

/**
 * Deploys the trustee registry (the panel pinned), the group registry, the
 * election registry and the board. The election registry and the board name
 * each other, so the board's address is the one its CREATE will have.
 */
export async function deployL2(rpc: Rpc, l1: Rpc, inputs: L2Inputs): Promise<L2> {
  const [operator] = await rpc.call<string[]>("eth_accounts");
  if (operator === undefined) throw new Error("the L2 anvil has no development account");
  await rpc.call("anvil_setCode", [hex(L1_BLOCK), hex(artifact("MockL1Block").deployed)]);
  await setL1Origin(rpc, l1, operator);

  const deploy = async (name: string, args: Uint8Array): Promise<Uint8Array> => {
    const receipt = await send(rpc, {
      from: operator,
      data: hex(concatBytes(artifact(name).bytecode, args)),
    });
    if (receipt.contractAddress === null) throw new Error(`${name} wasn't deployed`);
    return unhex(receipt.contractAddress);
  };
  const trusteeRegistry = await deploy("TrusteeRegistry", panelInputs(inputs.panel, inputs.quorum));
  // Two placeholder registrars in ascending order, threshold 2: no group is
  // created yet (STUBS.groupRegistrars).
  const registrars = [placeholder("registrar-1"), placeholder("registrar-2")].sort((a, b) =>
    hex(a) < hex(b) ? -1 : 1,
  );
  const groupRegistry = await deploy(
    "GroupRegistry",
    concatBytes(word(2n), word(64n), word(2n), ...registrars.map(address)),
  );
  const l1Relay = placeholder("l1-relay");
  const nonce = BigInt(await rpc.call<string>("eth_getTransactionCount", [operator, "latest"]));
  const sender = unhex(operator);
  const board = createAddress(sender, nonce + 1n);
  const electionRegistry = await deploy(
    "ElectionRegistry",
    concatBytes(
      address(board),
      address(trusteeRegistry),
      address(groupRegistry),
      word(inputs.l1ChainId),
      address(inputs.l1Anchor),
      address(l1Relay),
      word(inputs.epoch),
    ),
  );
  const deployedBoard = await deploy(
    "Board",
    concatBytes(address(electionRegistry), address(trusteeRegistry), address(l1Relay)),
  );
  if (!equalBytes(deployedBoard, board))
    throw new Error("the board isn't at the address the election registry names");
  return {
    rpc,
    operator,
    l2ChainId: inputs.l2ChainId,
    electionRegistry,
    board,
    trusteeRegistry,
    groupRegistry,
    l1Relay,
  };
}

/**
 * Sets the mock predeploy to the L1 Anvil's latest block, so the next
 * event's origin is a real L1 block (docs/spec/contracts.md, The L1 origin).
 * Both Anvils keep wall-clock time until the run moves the L1's forward to
 * anchor, which comes after every registration.
 */
async function setL1Origin(rpc: Rpc, l1: Rpc, from: string): Promise<void> {
  const block = await l1.call<{ number: string; timestamp: string; hash: string }>(
    "eth_getBlockByNumber",
    ["latest", false],
  );
  await send(rpc, {
    from,
    to: hex(L1_BLOCK),
    data: hex(
      concatBytes(
        selector("set(uint64,uint64,bytes32)"),
        word(BigInt(block.number)),
        word(BigInt(block.timestamp)),
        unhex(block.hash),
      ),
    ),
  });
}

/** Creates an election as the operator, and returns the registry's counter for it. */
export async function createElection(l2: L2, l1: Rpc): Promise<bigint> {
  const count = selector("electionCount()");
  const read = async () =>
    BigInt(
      await l2.rpc.call<string>("eth_call", [
        { to: hex(l2.electionRegistry), data: hex(count) },
        "latest",
      ]),
    );
  const counter = await read();
  await setL1Origin(l2.rpc, l1, l2.operator);
  await send(l2.rpc, {
    from: l2.operator,
    to: hex(l2.electionRegistry),
    data: hex(selector("createElection()")),
  });
  if ((await read()) !== counter + 1n) throw new Error("createElection didn't count the election");
  return counter;
}

/**
 * The trustee registry's registration record for `c`
 * (docs/spec/contracts.md, Trustee registry, Registration): every seat that
 * took part checks the transcript as the spec has it, and each signs the key
 * set the check returned.
 */
export function ceremonyRegistration(
  l2: L2Deployment,
  trustees: Trustees,
  c: Ceremony,
): Uint8Array {
  const d = c.definition.value;
  const stub = stubHash(c.definition);
  const check = checkCeremonyTranscript(
    {
      l2ChainId: d.l2_chain_id,
      trusteeRegistry: d.trustee_registry,
      electionId: d.election_id,
      stubHash: stub,
      panel: trustees.panel,
    },
    c.transcript,
    1,
  );
  if (!check.ok) throw new Error(`the ceremony's transcript fails: ${check.code}`);
  const entries = check.registered.map(keySetEntry);
  const setHash = keySetHash(entries);
  const signers = c.seats.filter((t) => check.registered.some((k) => k.index === t.index));
  return encodeCeremonyRegistration({
    panelId: d.panel_id,
    stubHash: stub,
    ceremonyTranscriptHash: d.ceremony_transcript_hash,
    keySet: entries,
    approvals: signers.map((t) => ({
      index: t.index,
      signature: signCeremonyRegistration(t.identitySecret, trustees.panel, {
        l2ChainId: d.l2_chain_id,
        trusteeRegistry: l2.trusteeRegistry,
        index: t.index,
        stubHash: stub,
        ceremonyTranscriptHash: d.ceremony_transcript_hash,
        keySetHash: setHash,
      }),
    })),
  });
}

/** The 4-byte selector of the custom error a call reverted with, or `undefined` if it didn't. */
async function revertOf(l2: L2, to: Uint8Array, data: Uint8Array): Promise<string | undefined> {
  try {
    await l2.rpc.call("eth_call", [{ from: l2.operator, to: hex(to), data: hex(data) }, "latest"]);
    return undefined;
  } catch (e) {
    if (!(e instanceof RpcError) || typeof e.data !== "string") throw e;
    return e.data.slice(0, 10);
  }
}

/**
 * Sends a call the contract must accept, or the error `expect` names (its
 * signature) and nothing is sent. Each is tried with `eth_call` first, so a
 * refusal shows its error rather than a bare revert.
 */
async function transact(
  l2: L2,
  l1: Rpc,
  to: Uint8Array,
  data: Uint8Array,
  expect?: string,
): Promise<void> {
  await setL1Origin(l2.rpc, l1, l2.operator);
  const got = await revertOf(l2, to, data);
  const want = expect === undefined ? undefined : hex(selector(expect));
  if (got !== want)
    throw new Error(
      `expected ${expect ?? "success"}, got ${got === undefined ? "success" : `revert ${got}`}`,
    );
  if (got === undefined) await send(l2.rpc, { from: l2.operator, to: hex(to), data: hex(data) });
}

/** Registers the ceremony's record with the trustee registry, or expects `refusal`. */
export async function registerCeremony(
  l2: L2,
  l1: Rpc,
  record: Uint8Array,
  refusal?: string,
): Promise<void> {
  await transact(
    l2,
    l1,
    l2.trusteeRegistry,
    bytesCalldata("registerCeremony(bytes)", record),
    refusal,
  );
}

/**
 * Registers `definition` with the election registry, or expects `refusal`; a
 * registration then reads back the definition's hash and the ceremony the
 * trustee registry recorded for it.
 */
export async function registerDefinition(
  l2: L2,
  l1: Rpc,
  definition: FixtureDefinition,
  refusal?: string,
): Promise<void> {
  await transact(
    l2,
    l1,
    l2.electionRegistry,
    bytesCalldata("registerDefinition(bytes)", definitionBytes(definition)),
    refusal,
  );
  const d = definition.value;
  const view = (data: Uint8Array, to = l2.electionRegistry) =>
    l2.rpc.call<string>("eth_call", [{ to: hex(to), data: hex(data) }, "latest"]);
  const registered = unhex(
    await view(concatBytes(selector("definitionHashOf(bytes32)"), d.election_id)),
  );
  const want = refusal === undefined ? definitionHash(definition) : new Uint8Array(32);
  if (!equalBytes(registered, want))
    throw new Error(`the election registry holds definition hash ${hex(registered)}`);
  const recorded = BigInt(
    await view(
      concatBytes(
        selector("ceremonyRecorded(bytes32,bytes32,bytes32,uint8,uint8)"),
        stubHash(definition),
        d.ceremony_transcript_hash,
        d.panel_id,
        word(BigInt(d.threshold)),
        word(BigInt(d.panel_size)),
      ),
      l2.trusteeRegistry,
    ),
  );
  if (recorded !== (refusal === undefined ? 1n : 0n))
    throw new Error(`the trustee registry's ceremonyRecorded is ${recorded}`);
}
