// The rolling poll's group on the fixture's L2 (P2-17 part 4f): a Tier 0
// group created in the group registry, filled and changed by records both
// registrars sign, through the registry's own checks (docs/spec/contracts.md,
// Group registry, Additions and Removals; [[registration]], The batch), and
// read back from the registry's logs as the events a rolling tier's tree is
// built from (docs/spec/membership.md, Rolling tier tree). No registration
// service batches them yet (STUBS.groupRegistrars).

import {
  decodeGroupAddition,
  decodeGroupRemoval,
  encodeGroupAddition,
  encodeGroupRemoval,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  groupRemovalDigest,
  type RollingTierEvent,
  signGroupApproval,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Rpc } from "./anvil.ts";
import { word } from "./l1.ts";
import { bytesCalldata, type L2, transact } from "./l2.ts";

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const unhex = (s: string) => hexToBytes(s.startsWith("0x") ? s.slice(2) : s);
const topic = (signature: string) => hex(keccak_256(new TextEncoder().encode(signature)));
const selector = (signature: string) => keccak_256(new TextEncoder().encode(signature)).slice(0, 4);

const MEMBERS_ADDED = topic("MembersAdded(uint64,uint64,bytes)");
const MEMBERS_REMOVED = topic("MembersRemoved(uint64,bytes)");

/** Every group the fixture creates is Tier 0: the registry's additions are signed for one tier. */
const TIER = 0;

const view = async (l2: L2, data: Uint8Array) =>
  BigInt(
    await l2.rpc.call<string>("eth_call", [
      { to: hex(l2.groupRegistry), data: hex(data) },
      "latest",
    ]),
  );

/** Creates the registry's next group, of Tier 0, and returns its ID. */
export async function createGroup(l2: L2, l1: Rpc): Promise<bigint> {
  const groupId = await view(l2, selector("groupCount()"));
  await transact(
    l2,
    l1,
    l2.groupRegistry,
    Uint8Array.of(...selector("createGroup(uint8)"), ...word(BigInt(TIER))),
  );
  if ((await view(l2, selector("groupCount()"))) !== groupId + 1n)
    throw new Error("createGroup didn't count the group");
  return groupId;
}

/** What a record is signed for: the registry, its chain and its registrars' keys in seat order. */
export type Signers = Pick<L2, "l2ChainId" | "groupRegistry" | "registrarSecrets">;

const separator = (l2: Signers) => groupRegistryDomainSeparator(l2.l2ChainId, l2.groupRegistry);

/** Every registrar's approval of `digest`, in seat order. */
const approvals = (l2: Signers, digest: Uint8Array) =>
  l2.registrarSecrets.map((secret, i) => signGroupApproval(digest, i + 1, secret.slice()));

/** The `addMembers` record adding `commitments` to `groupId` at `firstIndex`, signed by every registrar. */
export function additionRecord(
  l2: Signers,
  groupId: bigint,
  firstIndex: bigint,
  commitments: readonly bigint[],
): Uint8Array {
  const digest = groupAdditionDigest(separator(l2), {
    groupId,
    tier: TIER,
    firstIndex,
    commitments,
  });
  return encodeGroupAddition({
    groupId,
    firstIndex,
    commitments,
    approvals: approvals(l2, digest),
  });
}

/**
 * The `removeMembers` record removing the members at `indices` of `groupId`,
 * signed by every registrar at `size`, the member count they saw: no index
 * can be at or past it (T-06).
 */
export function removalRecord(
  l2: Signers,
  groupId: bigint,
  size: bigint,
  indices: readonly bigint[],
): Uint8Array {
  const digest = groupRemovalDigest(separator(l2), { groupId, tier: TIER, size, indices });
  return encodeGroupRemoval({ groupId, size, indices, approvals: approvals(l2, digest) });
}

/** Adds `commitments` to `groupId` at `firstIndex`, its member count. */
export async function addMembers(
  l2: L2,
  l1: Rpc,
  groupId: bigint,
  firstIndex: bigint,
  commitments: readonly bigint[],
): Promise<void> {
  const record = additionRecord(l2, groupId, firstIndex, commitments);
  await transact(l2, l1, l2.groupRegistry, bytesCalldata("addMembers(bytes)", record));
}

/** Removes the members at `indices` of `groupId`, signed at `size`. */
export async function removeMembers(
  l2: L2,
  l1: Rpc,
  groupId: bigint,
  size: bigint,
  indices: readonly bigint[],
): Promise<void> {
  const record = removalRecord(l2, groupId, size, indices);
  await transact(l2, l1, l2.groupRegistry, bytesCalldata("removeMembers(bytes)", record));
}

/** The `bytes` an event's data ABI-encodes alone: its offset, its length, the bytes. */
export function eventBytes(data: Uint8Array): Uint8Array {
  const length = data.length >= 64 ? BigInt(hex(data.slice(32, 64))) : -1n;
  if (length < 0n || 64n + length > BigInt(data.length))
    throw new Error("a group registry log whose data isn't one ABI-encoded bytes");
  return data.slice(64, 64 + Number(length));
}

interface RawLog {
  readonly blockNumber: string;
  readonly logIndex: string;
  readonly topics: readonly string[];
  readonly data: string;
}

/**
 * The group registry's additions and removals, in chain order, as a rolling
 * tier's tree reads them: each with its L2 block's number and timestamp, and
 * the commitments or member indices its record carries.
 */
export async function groupEvents(l2: L2): Promise<RollingTierEvent[]> {
  const logs = await l2.rpc.call<RawLog[]>("eth_getLogs", [
    {
      address: hex(l2.groupRegistry),
      fromBlock: "0x0",
      toBlock: "latest",
      topics: [[MEMBERS_ADDED, MEMBERS_REMOVED]],
    },
  ]);
  const ordered = [...logs].sort((a, b) => {
    const d = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    return d !== 0n ? (d < 0n ? -1 : 1) : Number(BigInt(a.logIndex) - BigInt(b.logIndex));
  });
  const times = new Map<bigint, bigint>();
  const events: RollingTierEvent[] = [];
  for (const log of ordered) {
    const blockNumber = BigInt(log.blockNumber);
    let timestamp = times.get(blockNumber);
    if (timestamp === undefined) {
      const block = await l2.rpc.call<{ timestamp: string }>("eth_getBlockByNumber", [
        log.blockNumber,
        false,
      ]);
      timestamp = BigInt(block.timestamp);
      times.set(blockNumber, timestamp);
    }
    const record = eventBytes(unhex(log.data));
    if (log.topics[0] === MEMBERS_ADDED) {
      const added = decodeGroupAddition(record);
      if (!added.ok)
        throw new Error(`the registry logged an addition that doesn't decode: ${added.error}`);
      const { groupId, commitments } = added.value;
      events.push({ blockNumber, timestamp, groupId, kind: "add", commitments });
    } else {
      const removed = decodeGroupRemoval(record);
      if (!removed.ok)
        throw new Error(`the registry logged a removal that doesn't decode: ${removed.error}`);
      const { groupId, indices } = removed.value;
      events.push({ blockNumber, timestamp, groupId, kind: "remove", indices });
    }
  }
  return events;
}
