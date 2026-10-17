// Writes crs/bn254_g1.dat and crs/bn254_g2.dat, the reference string bb proves
// and verifies the circuits with, from the first transcript of Aztec's Ignition
// ceremony. bb would otherwise download it from crs.aztec-labs.com at its first
// use, a source no test pins and sessions can't reach; vendored, it is in the
// reviewed diff and test/crs.test.ts checks it (README, Reference string; T-21,
// T-55). Run from the package root: `vp node scripts/crs.ts`.
//
// The transcript stores a 28-byte header of seven big-endian u32s
// (transcript number, transcript count, total G1 points, total G2 points, G1
// points here, G2 points here, start index), then the G1 points [x^i]_1 from
// i = 0, then the G2 points, each coordinate as four 64-bit limbs, least
// significant first, each limb big-endian. bb's files hold the same points with
// each coordinate as 32 bytes big-endian: G1 as x ‖ y, G2 as x.c0 ‖ x.c1 ‖ y.c0
// ‖ y.c1, and only [x]_2, the first G2 point.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const TRANSCRIPT =
  "https://aztec-ignition.s3.amazonaws.com/MAIN%20IGNITION/monomial/transcript00.dat";
/** Points bb asks for: the output circuit's dyadic size (gates.json), 2^15. */
const POINTS = 32768;
const HEADER = 28;
const G1_TOTAL = 5_040_001;

async function range(start: number, end: number): Promise<Uint8Array> {
  const res = await fetch(TRANSCRIPT, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (res.status !== 206) throw new Error(`${TRANSCRIPT}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length !== end - start) throw new Error(`${TRANSCRIPT}: short read`);
  return bytes;
}

/** One coordinate from four limbs, least significant first, to 32 bytes big-endian. */
function coordinate(limbs: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) out.set(limbs.subarray(8 * i, 8 * i + 8), 24 - 8 * i);
  return out;
}

function reencode(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 32) out.set(coordinate(raw.subarray(i, i + 32)), i);
  return out;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const head = await range(0, HEADER + POINTS * 64);
const header = new DataView(head.buffer, 0, HEADER);
const fields = Array.from({ length: 7 }, (_, i) => header.getUint32(4 * i));
// Transcript 0 of 1, all 5,040,001 G1 points and both G2 points, from index 0.
if (fields.join() !== [0, 1, G1_TOTAL, 2, G1_TOTAL, 2, 0].join()) {
  throw new Error(`unexpected transcript header ${fields.join()}`);
}
const g2Start = HEADER + G1_TOTAL * 64;
const g2Raw = await range(g2Start, g2Start + 128);

mkdirSync("crs", { recursive: true });
const g1 = reencode(head.subarray(HEADER));
const g2 = reencode(g2Raw);
writeFileSync("crs/bn254_g1.dat", g1);
writeFileSync("crs/bn254_g2.dat", g2);
console.log(`transcript bytes 0-${head.length - 1}: sha256 ${sha256(head)}`);
console.log(`transcript bytes ${g2Start}-${g2Start + 127}: sha256 ${sha256(g2Raw)}`);
console.log(`crs/bn254_g1.dat: sha256 ${sha256(g1)}`);
console.log(`crs/bn254_g2.dat: sha256 ${sha256(g2)}`);
