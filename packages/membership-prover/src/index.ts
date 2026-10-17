// The ballot client's Groth16 prover (docs/spec/membership.md, Security
// notes; ADR 0009, Amendment of 2026-10-17): snarkjs behind the one call the
// client makes. It runs only in the prover worker, a realm of its own. It
// takes the witness `membershipProverInput` built in the ballot worker and
// the pinned proving key and witness calculator, and returns snarkjs's proof
// as `membership_proof` bytes for the ballot worker to finish
// (`finishMembershipProof`: verified against inputs computed there, then
// re-randomised). Nothing here is trusted for soundness or zero knowledge;
// the pins keep the secret from reaching any other key or calculator (T-07,
// T-12, T-55).

import {
  checkMembershipWasm,
  checkMembershipZkey,
  MEMBERSHIP_DEPTH,
  MEMBERSHIP_PROOF_LENGTH,
  type MembershipWitness,
} from "@abolishus/crypto";
import { groth16 } from "snarkjs";

/** The artifacts the release serves beside the client, checked by sha256 on every proof. */
export interface MembershipProverArtifacts {
  /** `semaphore-32.zkey`. */
  readonly zkey: Uint8Array;
  /** `semaphore-32.wasm`. */
  readonly wasm: Uint8Array;
}

/**
 * The prover's steps after the witness, as snarkjs 0.7.5's `groth16.prove`
 * logs them, in order. Progress counts steps reached, never elapsed time, so
 * a progress indicator shows only what has happened ([[language]], no
 * motion). A snarkjs that logs other steps fails this package's tests.
 */
const STEPS = [
  "Reading Wtns",
  "Reading Coeffs",
  "Building ABC",
  "Join ABC",
  "Reading A Points",
  "Reading B1 Points",
  "Reading B2 Points",
  "Reading C Points",
  "Reading H Points",
] as const;

/** Steps in a proof: the witness, each of `STEPS`, and the proof's encoding. */
export const MEMBERSHIP_PROVER_STEPS = STEPS.length + 1;

/** Called as each step completes, with how many of `MEMBERSHIP_PROVER_STEPS` are done. */
export type MembershipProverProgress = (done: number) => void;

const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

function word(decimal: unknown, out: Uint8Array, at: number): void {
  if (typeof decimal !== "string" || !DECIMAL.test(decimal))
    throw new TypeError("prover: expected a decimal coordinate");
  let v = BigInt(decimal);
  if (v >> 256n !== 0n) throw new TypeError("prover: coordinate out of range");
  for (let i = at + 31; i >= at; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function list(value: unknown, length: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length !== length)
    throw new TypeError("prover: unexpected proof shape");
  return value;
}

/**
 * snarkjs's affine proof as `membership_proof` bytes: A, then B with each
 * coordinate's imaginary part first, then C (docs/spec/membership.md, Proof
 * encoding). Only the shape is checked here; the ballot worker decodes the
 * bytes strictly and verifies them.
 */
function encodeSnarkjsProof(proof: unknown): Uint8Array {
  const { pi_a, pi_b, pi_c } = (proof ?? {}) as Record<string, unknown>;
  const a = list(pi_a, 3);
  const b = list(pi_b, 3).map((c) => list(c, 2));
  const c = list(pi_c, 3);
  // Affine points: snarkjs normalises Z to 1 before it returns them.
  if (a[2] !== "1" || c[2] !== "1" || b[2]?.[0] !== "1" || b[2]?.[1] !== "0")
    throw new TypeError("prover: expected affine points");
  const [bx = [], by = []] = b;
  const out = new Uint8Array(MEMBERSHIP_PROOF_LENGTH);
  [a[0], a[1], bx[1], bx[0], by[1], by[0], c[0], c[1]].forEach((v, i) => word(v, out, 32 * i));
  return out;
}

/**
 * snarkjs's proof for `witness`, as the 256 bytes the ballot worker finishes.
 * The artifacts are copied, then checked against their pinned sha256s
 * (`MembershipProverError` `zkey` or `wasm`) before the witness reaches
 * them, and the prover runs single-threaded, since its threaded mode starts
 * workers the client's CSP refuses. snarkjs's public signals are discarded:
 * the ballot worker checks the proof against its own.
 */
export async function proveMembership(
  witness: MembershipWitness,
  artifacts: MembershipProverArtifacts,
  onProgress: MembershipProverProgress = () => {},
): Promise<Uint8Array> {
  // Copied first, so the bytes checked are the bytes proved with.
  const zkey = copy(artifacts.zkey, "zkey");
  const wasm = copy(artifacts.wasm, "wasm");
  checkMembershipZkey(zkey);
  checkMembershipWasm(wasm);
  const input = {
    secret: witness.secret,
    merkleProofLength: witness.merkleProofLength,
    merkleProofIndex: witness.merkleProofIndex,
    merkleProofSiblings: [...witness.merkleProofSiblings],
    scope: witness.scope,
    message: witness.message,
  };
  if (
    input.merkleProofLength !== String(MEMBERSHIP_DEPTH) ||
    input.merkleProofSiblings.length !== MEMBERSHIP_DEPTH
  )
    throw new TypeError("witness: expected a path of exactly 32 siblings");
  let done = 0;
  const step = (message: unknown) => {
    if (message === STEPS[done]) onProgress(++done);
  };
  const logger = { debug: step, info() {}, warn() {}, error() {} };
  const { proof } = await groth16.fullProve(
    input,
    { type: "mem", data: wasm },
    { type: "mem", data: zkey },
    logger,
    undefined,
    { singleThread: true },
  );
  const bytes = encodeSnarkjsProof(proof);
  onProgress(MEMBERSHIP_PROVER_STEPS);
  return bytes;
}

function copy(bytes: Uint8Array, name: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || !ArrayBuffer.isView(bytes))
    throw new TypeError(`${name}: expected bytes`);
  return new Uint8Array(bytes);
}
