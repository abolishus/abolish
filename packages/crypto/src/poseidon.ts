// circomlib's two-input Poseidon over BN254 (docs/spec/membership.md,
// Statement), the hash of Semaphore's identity commitments, nullifiers and
// Merkle nodes, and so of the tier tree. The permutation is @noble/curves';
// its round constants and MDS matrix come from noble's Grain LFSR generator
// with circomlib's parameters (Poseidon paper, eprint 2019/458: t = 3, 8 full
// and 57 partial rounds, x^5), and tests check them against circomlibjs's
// published constants and circomlib's known answers.

import { grainGenConstants, poseidon, type PoseidonFn } from "@noble/curves/abstract/poseidon.js";
import { bn254_Fr } from "@noble/curves/bn254.js";
import { BN254_R } from "./codec.ts";

const PARAMETERS = { Fp: bn254_Fr, t: 3, roundsFull: 8, roundsPartial: 57 } as const;

let permutation: PoseidonFn | undefined;

function perm(): PoseidonFn {
  permutation ??= poseidon({
    ...grainGenConstants(PARAMETERS),
    ...PARAMETERS,
    sboxPower: 5,
  });
  return permutation;
}

/** circomlib's round constants and MDS matrix for two inputs, for the tests. */
export function poseidon2Constants(): {
  readonly roundConstants: bigint[][];
  readonly mds: bigint[][];
} {
  return grainGenConstants(PARAMETERS);
}

/**
 * `Poseidon2(a, b)`: circomlib's `Poseidon(2)`, state `[0, a, b]`, output the
 * first element. Inputs must be canonical field elements; the permutation
 * would reduce anything else, and two encodings of one input would hash
 * alike (T-31).
 */
export function poseidon2(a: bigint, b: bigint): bigint {
  for (const x of [a, b])
    if (typeof x !== "bigint" || x < 0n || x >= BN254_R)
      throw new RangeError("poseidon2: inputs must be field elements below r");
  const out = perm()([0n, a, b])[0];
  // The permutation returns a state of width 3.
  return out as bigint;
}
