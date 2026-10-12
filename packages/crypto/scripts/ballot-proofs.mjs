// Membership proofs for docs/spec/vectors/ballot.json: the second step of
// ballot-vectors.py (see its docstring). It shares no code with
// packages/crypto: every proof comes from snarkjs 0.7.5's `fullProve` over
// Semaphore 4.14.3's depth-32 circuit artifacts, and every verdict from
// snarkjs's `groth16.verify` under the key exported from the zkey.
//
// It runs outside the workspace, because packages/crypto depends on @noble/*
// only. In an empty directory:
//
//   vp add snarkjs@0.7.5
//   curl -O https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.{wasm,zkey}
//   vp node ballot-proofs.mjs <artifacts-dir> <statements.json> <proofs.json>
//
// For each witness it checks that the circuit's outputs (the root and the
// nullifier) equal the values ballot-vectors.py computed with its own
// Baby Jubjub, Poseidon and tier tree, so the two agree with Semaphore's
// circuit itself, and that the proof verifies under its own signals.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit } from "node:process";
import { groth16, zKey } from "snarkjs";

const [artifacts, statementsPath, outPath] = argv.slice(2);
if (outPath === undefined)
  throw new Error("usage: <artifacts-dir> <statements.json> <proofs.json>");

const ARTIFACTS = {
  "semaphore-32.wasm": "528333d1247f585d33c5a40f46053fb7f8b1f5b8b8fa29118abfc47a60921dc5",
  "semaphore-32.zkey": "2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650",
};
for (const [name, want] of Object.entries(ARTIFACTS)) {
  const got = createHash("sha256")
    .update(readFileSync(join(artifacts, name)))
    .digest("hex");
  if (got !== want) throw new Error(`${name}: sha256 ${got}, expected ${want}`);
}
const wasm = join(artifacts, "semaphore-32.wasm");
const zkey = join(artifacts, "semaphore-32.zkey");
const vk = await zKey.exportVerificationKey(zkey);

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
// EIP-197's order: B's imaginary parts first (docs/spec/membership.md, Proof encoding).
const encode = (p) =>
  [
    p.pi_a[0],
    p.pi_a[1],
    p.pi_b[0][1],
    p.pi_b[0][0],
    p.pi_b[1][1],
    p.pi_b[1][0],
    p.pi_c[0],
    p.pi_c[1],
  ]
    .map(word)
    .join("");

const { proofs, checks } = JSON.parse(readFileSync(statementsPath, "utf8"));
const made = new Map();
const encoded = {};
for (const { id, witness, expect } of proofs) {
  const { proof, publicSignals } = await groth16.fullProve(witness, wasm, zkey);
  const [root, nullifier, message, scope] = publicSignals;
  if (root !== expect.root) throw new Error(`${id}: circuit root ${root}, expected ${expect.root}`);
  if (nullifier !== expect.nullifier)
    throw new Error(`${id}: circuit nullifier ${nullifier}, expected ${expect.nullifier}`);
  if (message !== witness.message || scope !== witness.scope)
    throw new Error(`${id}: public inputs differ from the witness`);
  if (!(await groth16.verify(vk, publicSignals, proof)))
    throw new Error(`${id}: the proof fails its own signals`);
  made.set(id, proof);
  encoded[id] = encode(proof);
  console.log(`${id}: proved`);
}

const verdicts = {};
for (const { case: id, proof, signals } of checks) {
  const p = made.get(proof);
  if (p === undefined) throw new Error(`${id}: no proof ${proof}`);
  const s = [signals.root, signals.nullifier, signals.message, signals.scope];
  verdicts[id] = await groth16.verify(vk, s, p);
  console.log(`${id}: snarkjs ${verdicts[id]}`);
}

writeFileSync(outPath, `${JSON.stringify({ proofs: encoded, verdicts }, null, 2)}\n`);
exit(0);
