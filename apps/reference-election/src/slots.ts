// The board anchor's storage words the verifier proves for one election
// (docs/spec/contracts.md, Board anchor, Verification): the lowest anchored
// segment plus one, and each segment's checkpoint hash, under the contract's
// ERC-7201 namespace `abolish.board-anchor`. `eth_getProof` takes the slots
// themselves; the trie is keyed by their Keccak-256.

import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
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
