// The text CIDs the node answers for: the layout's CIDs only
// ([[content-addressing]]: `0x01 ‖ raw or dag-pb ‖ sha2-256`, 36 bytes), in
// the spec's text form, multibase base32 lowercase with no padding. Anything
// else is refused before any lookup. Only the canonical spelling is accepted,
// so one block has one URL.

import { cidText } from "@abolishus/crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
// `b` and 36 bytes' 58 base32 digits.
const TEXT = /^b[a-z2-7]{58}$/;

/** The binary CID `text` spells, or undefined if it isn't one of the layout's CIDs, canonically spelled. */
export function parseCid(text: string): Uint8Array | undefined {
  if (!TEXT.test(text)) return undefined;
  const cid = new Uint8Array(36);
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of text.slice(1)) {
    value = ((value << 5) | ALPHABET.indexOf(c)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      cid[at++] = (value >>> bits) & 0xff;
    }
  }
  // 58 digits carry 290 bits for 288: the last digit's 2 spare bits must be
  // zero, and re-encoding finds any that aren't.
  if (cidText(cid) !== text) return undefined;
  const [version, codec, hash, length] = cid;
  if (version !== 0x01 || (codec !== 0x55 && codec !== 0x70) || hash !== 0x12 || length !== 0x20)
    return undefined;
  return cid;
}
