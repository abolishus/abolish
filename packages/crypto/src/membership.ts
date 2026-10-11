// What Abolish derives around Semaphore v4's membership circuit
// (docs/spec/membership.md, ADR 0009): the per-poll, per-tier-group scope and
// the field mapping of scope and message. The circuit and its Groth16
// verification are Semaphore's (P1-17b).

import { keccak_256 } from "@noble/hashes/sha3.js";
import { encode, fieldBn254, u8 } from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { H } from "./group.ts";

// Copies before checking the length: a Uint8Array subclass could report a
// false `length` while holding another number of bytes (codec.ts, copyBytes).
function bytes32(x: unknown, what: string): Uint8Array {
  if (!(x instanceof Uint8Array) || !ArrayBuffer.isView(x))
    throw new TypeError(`${what}: expected 32 bytes`);
  const copy = new Uint8Array(x);
  if (copy.length !== 32) throw new TypeError(`${what}: expected 32 bytes`);
  return copy;
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
 * `S_g = H(DS("abolish/v1/nullifier-scope", definition_hash ‖ u8(tier) ‖ encode(root_g)))`.
 * Binding the definition hash makes the scope unique to one poll on one
 * deployment (T-12, T-30). Binding the tier, not only its root, gives each
 * tier group its own nullifiers even when two tiers have the same root, so
 * one person's ballots in two tiers can't be linked (T-13) and a proof can't
 * be moved to another tier. A root of 0 is rejected: Semaphore's circuit
 * proves membership of root 0 for any secret when the proof length exceeds
 * the depth, so such a tier would admit anyone with unlimited nullifiers
 * (T-04, T-05).
 */
export function nullifierScope(definitionHash: Uint8Array, tier: number, root: bigint): Uint8Array {
  if (tier !== 0 && tier !== 1 && tier !== 2)
    throw new RangeError("nullifierScope: tier must be 0, 1 or 2");
  if (root === 0n) throw new RangeError("nullifierScope: a tier root of 0 is provable by anyone");
  const input = new Uint8Array(65);
  input.set(bytes32(definitionHash, "nullifierScope: definitionHash"));
  input.set(encode(u8, tier), 32);
  input.set(encode(fieldBn254, root), 33);
  return H(ds("abolish/v1/nullifier-scope", input));
}

/** `ŝ_g = F(S_g)`: the scope as the circuit's public input. */
export function membershipScope(definitionHash: Uint8Array, tier: number, root: bigint): bigint {
  return semaphoreField(nullifierScope(definitionHash, tier, root));
}

/**
 * The one protocol-wide tree depth every membership proof uses (Semaphore's
 * maximum). A per-tier depth would be an input a server could steer to
 * suppress and identify one voter's ballot (T-10, T-13); a fixed one also
 * says nothing about the voter's leaf position.
 */
export const MEMBERSHIP_DEPTH = 32;
