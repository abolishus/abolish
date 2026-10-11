// What Abolish derives around Semaphore v4's membership circuit
// (docs/spec/membership.md, ADR 0009): the per-poll, per-tier-group scope and
// the field mapping of scope and message. The circuit and its Groth16
// verification are Semaphore's (P1-17b).

import { keccak_256 } from "@noble/hashes/sha3.js";
import { encode, fieldBn254 } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";

function bytes32(x: unknown, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x) || x.length !== 32)
    throw new TypeError(`${what}: expected 32 bytes`);
  return new Uint8Array(x);
}

/**
 * `F(x) = int(keccak256(x)) >> 8`: Semaphore v4's `hash` of the 32-byte word
 * `x`, read big-endian. The result is below 2^248, so below the BN254 scalar
 * field order with no reduction.
 */
export function semaphoreField(x: Uint8Array): bigint {
  let v = 0n;
  for (const b of keccak_256(bytes32(x, "semaphoreField"))) v = (v << 8n) | BigInt(b);
  return v >> 8n;
}

/**
 * `S_g = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ encode(root_g)))`.
 * Binding the definition hash makes the scope unique to one poll on one
 * deployment (T-12, T-30); binding the tier's root gives each tier group its
 * own nullifiers, so one person's ballots in two tiers can't be linked (T-13)
 * and a proof can't be moved to another tier.
 */
export function nullifierScope(definitionHash: Uint8Array, root: bigint): Uint8Array {
  const input = new Uint8Array(64);
  input.set(bytes32(definitionHash, "nullifierScope: definitionHash"));
  input.set(encode(fieldBn254, root), 32);
  return H(ds("abolish/v1/nullifier-scope", input));
}

/** `ŝ_g = F(S_g)`: the scope as the circuit's public input. */
export function membershipScope(definitionHash: Uint8Array, root: bigint): bigint {
  return semaphoreField(nullifierScope(definitionHash, root));
}

/**
 * `D_g = max(1, ⌈log₂ n⌉)`: the one tree depth whose verification key a tier
 * group of `n` members uses, so the depth reveals nothing about the voter's
 * leaf position (T-13).
 */
export function membershipDepth(groupSize: bigint): number {
  if (typeof groupSize !== "bigint" || groupSize < 1n || groupSize > 1n << 32n)
    throw new RangeError("membershipDepth: group size must be from 1 to 2^32");
  let d = 0;
  while (1n << BigInt(d) < groupSize) d++;
  return Math.max(1, d);
}
