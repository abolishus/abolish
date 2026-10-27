// The board anchor's storage words the verifier proves for one election
// (docs/spec/contracts.md, Board anchor, Verification): the lowest anchored
// segment plus one, each segment's checkpoint hash and each listed receipt
// key's record, under the contract's
// ERC-7201 namespace `abolish.board-anchor`, and for the archive (4.3) the
// latest locator, the count posted and the event accumulator. `eth_getProof` takes the slots
// themselves; the trie is keyed by their Keccak-256.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { word } from "./l1.ts";

/** BoardAnchor's `ANCHOR_SLOT`. */
export const ANCHOR_NAMESPACE = 0x16eba4501d0a9dddbfa03518d843c364be664629e6d99efb7169d8f090095b00n;

/** Slot of `checkpointHash[electionId][segment]` (the struct's first member). */
export function checkpointSlot(electionId: Uint8Array, segment: number): Uint8Array {
  const inner = keccak_256(concatBytes(electionId, word(ANCHOR_NAMESPACE)));
  return keccak_256(concatBytes(word(BigInt(segment)), inner));
}

/** Slot of `lowestSegmentPlusOne[electionId]` (the struct's second member). */
export function lowestSegmentSlot(electionId: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(electionId, word(ANCHOR_NAMESPACE + 1n)));
}

/** Every slot the verifier reads for segments `first` to `last`. */
export function anchorSlots(electionId: Uint8Array, first: number, last: number): Uint8Array[] {
  const slots = [lowestSegmentSlot(electionId)];
  for (let s = first; s <= last; s++) slots.push(checkpointSlot(electionId, s));
  return slots;
}

/**
 * Slot of `receiptKeys[prefix][x]` (the struct's fifth member) for a
 * compressed receipt key `prefix ‖ x`.
 */
export function receiptKeySlot(key: Uint8Array): Uint8Array {
  if (key.length !== 33) throw new RangeError("receiptKeySlot: a receipt key is 33 bytes");
  const inner = keccak_256(
    concatBytes(word(BigInt(key[0] as number)), word(ANCHOR_NAMESPACE + 4n)),
  );
  return keccak_256(concatBytes(key.subarray(1), inner));
}

/**
 * Slots of `latestLocator` (the struct's third member, a Solidity `bytes`),
 * its data words for a locator of `length` bytes over 31, and `locatorCount`
 * (the fourth): what the verifier reads the latest locator from
 * (docs/spec/contracts.md, Archive locator).
 */
export function locatorSlots(length: number): Uint8Array[] {
  const slots = [word(ANCHOR_NAMESPACE + 2n), word(ANCHOR_NAMESPACE + 3n)];
  if (length > 31) {
    const start = BigInt(`0x${bytesToHex(keccak_256(word(ANCHOR_NAMESPACE + 2n)))}`);
    for (let i = 0; i * 32 < length; i++) slots.push(word(start + BigInt(i)));
  }
  return slots;
}

/** EventAccumulator's `ACCUMULATOR_SLOT`, the namespace `abolish.event-accumulator`. */
export const ACCUMULATOR_SLOT = 0x1073a090f5464cb55b258e445c2f90eb0f9b00fb8b1700430d20b9c53b939600n;

/** Slots of the anchor's event accumulator and its count, which its logs are proven against. */
export function accumulatorSlots(): Uint8Array[] {
  return [word(ACCUMULATOR_SLOT), word(ACCUMULATOR_SLOT + 1n)];
}
