// What the voter's checker gets from this device ([[challenge]], Client rules
// 1 and 2): before the cast-or-challenge choice, the tracking code as a QR
// code of the full 32-byte hash with the election it is for; after a
// challenge, the opening's record bytes as a file. Neither goes through any
// server (T-42, T-44).

const HEX32 = /^[0-9a-f]{64}$/;

/**
 * The QR code's text: `ABOLISH:TRACK:1:`, the election id and the tracking
 * code, each as 64 upper-case hex digits, the two joined by `:`
 * ([[challenge]], Client rules). Upper case keeps every character in QR's
 * alphanumeric mode. Never a shortened code: a checker accepts a match only
 * on all 32 bytes.
 */
export function trackingCodeText(electionId: string, trackingCode: string): string {
  if (!HEX32.test(electionId) || !HEX32.test(trackingCode))
    throw new RangeError("the election id and the tracking code are 64 lowercase hex digits");
  return `ABOLISH:TRACK:1:${electionId.toUpperCase()}:${trackingCode.toUpperCase()}`;
}

/** The opening file's name: the tracking code's first 16 hex digits, so a voter can tell two apart. */
export function openingFileName(trackingCode: string): string {
  if (!HEX32.test(trackingCode))
    throw new RangeError("the tracking code is 64 lowercase hex digits");
  return `abolish-opening-${trackingCode.slice(0, 16)}.bin`;
}
