// Independent generator for docs/spec/vectors/vouch-prover.json
// (docs/spec/vouching.md, Scopes, Messages, The vouch and Prover rules; P3-3
// part 3c-3a): what a voucher's client hands the Groth16 prover for both
// proofs of a vouch, and what it must get back.
// It shares no code with packages/crypto: identities, their secret scalars and
// commitments and every proof come from Semaphore v4.14.3's own `Identity` and
// `generateProof`, each proof is checked by Semaphore's `verifyProof`, the
// tier tree and its paths from poseidon-lite's `poseidon2`, the field mapping
// from ethers' keccak256 and the hashes from node:crypto.
//
// The vouchers, vouchees, binding and Tier 2 leaves are vouch.json's (the same
// identity seeds, chain, registry and groups); this file adds the vouchers'
// secrets, both proofs' circuit inputs and fresh proofs, at a root block on
// the root grid (vouch.json's is off it, which only a prover refuses).
//
// It runs outside the workspace, because packages/crypto depends on @noble/*
// only. In an empty directory:
//
//   vp add @semaphore-protocol/core@4.14.3 snarkjs@0.7.5 poseidon-lite@0.3.0 ethers@6.13.4
//   curl -O https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.{wasm,zkey}
//   vp node vouch-prover-vectors.mjs <artifacts-dir> <out-dir>
//
// Groth16 proving is randomised, so a rerun gives other proof bytes (the same
// inputs and public signals); the committed file is the record.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit } from "node:process";
import { Identity, generateProof, verifyProof } from "@semaphore-protocol/core";
import { keccak256, toBeHex } from "ethers";
import { poseidon2 } from "poseidon-lite";

const [artifacts, outDir] = argv.slice(2);
if (outDir === undefined) throw new Error("usage: <artifacts-dir> <out-dir>");

const DEPTH = 32;
const K = 3;
const L = 12;
const VOUCH_ROOT_INTERVAL = 1800n;
const BJJ_L = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

const ARTIFACTS = {
  "semaphore-32.wasm": "528333d1247f585d33c5a40f46053fb7f8b1f5b8b8fa29118abfc47a60921dc5",
  "semaphore-32.zkey": "2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650",
};
const sha256 = (b) => createHash("sha256").update(b).digest();
for (const [name, want] of Object.entries(ARTIFACTS)) {
  const got = sha256(readFileSync(join(artifacts, name))).toString("hex");
  if (got !== want) throw new Error(`${name}: sha256 ${got}, expected ${want}`);
}
const art = {
  wasm: join(artifacts, "semaphore-32.wasm"),
  zkey: join(artifacts, "semaphore-32.zkey"),
};

const word = (v) => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
const uint = (v, n) =>
  Buffer.from(
    BigInt(v)
      .toString(16)
      .padStart(2 * n, "0"),
    "hex",
  );
const ds = (tag, m) => Buffer.concat([Buffer.from([tag.length]), Buffer.from(tag, "ascii"), m]);
const big = (b) => BigInt(`0x${b.toString("hex")}`);
// Semaphore's `hash` (packages/proof/src/hash.ts, not exported).
const F = (b) => BigInt(keccak256(toBeHex(big(b), 32))) >> 8n;

// --- The binding, scopes and messages (docs/spec/vouching.md), vouch.json's. ---
const CHAIN_ID = 84532n;
const REGISTRY = Buffer.from("5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0b", "hex");
const T2_GROUP = 7n;
const TIER1_GROUP = 9n;
// 686 · VOUCH_ROOT_INTERVAL.
const ROOT_BLOCK = 1_234_800n;
if (ROOT_BLOCK % VOUCH_ROOT_INTERVAL !== 0n) throw new Error("root block off the grid");
const binding = Buffer.concat([uint(CHAIN_ID, 8), REGISTRY, uint(TIER1_GROUP, 8)]);
const vouchScope = (cv) => {
  const input = Buffer.concat([binding, word(cv)]);
  if (input.length !== 68) throw new Error("vouch scope input length");
  return sha256(ds("abolish/v1/vouch", input));
};
const slotScope = (j) => {
  const input = Buffer.concat([uint(CHAIN_ID, 8), REGISTRY, uint(j, 2)]);
  if (input.length !== 30) throw new Error("slot scope input length");
  return sha256(ds("abolish/v1/vouch-slot", input));
};
const message = (role, cv, other) => {
  const input = Buffer.concat([
    Buffer.from([role]),
    binding,
    word(cv),
    uint(T2_GROUP, 8),
    uint(ROOT_BLOCK, 8),
    word(other),
  ]);
  if (input.length !== 117) throw new Error("message input length");
  return sha256(ds("abolish/v1/vouch-message", input));
};

// --- The Tier 2 tier tree (docs/spec/membership.md, Tier tree). ---
const Z = [0n];
for (let h = 0; h < DEPTH; h++) Z.push(poseidon2([Z[h], Z[h]]));
function tree(leaves) {
  const levels = [leaves.slice()];
  for (let h = 0; h < DEPTH; h++) {
    const below = levels[h];
    const up = [];
    for (let j = 0; j < Math.ceil(below.length / 2); j++)
      up.push(poseidon2([below[2 * j] ?? Z[h], below[2 * j + 1] ?? Z[h]]));
    levels.push(up);
  }
  const root = levels[DEPTH][0] ?? Z[DEPTH];
  const path = (i) => Array.from({ length: DEPTH }, (_, h) => levels[h][(i >> h) ^ 1] ?? Z[h]);
  return { root, path };
}

const voucherSeed = (i) => `abolish vouch vector voucher ${i}`;
const vouchers = Array.from({ length: 6 }, (_, i) => new Identity(voucherSeed(i)));
for (const id of vouchers) {
  if (id.secretScalar < 1n || id.secretScalar >= BJJ_L)
    throw new Error("secret scalar out of range");
  if (id.commitment !== poseidon2(id.publicKey)) throw new Error("commitment");
}
// vouch.json's Tier 2 group: vouchers 0 to 4, in order; voucher 5 isn't a member.
const leaves = vouchers.slice(0, 5).map((v) => v.commitment);
const t2 = tree(leaves);
const vouchees = Array.from(
  { length: 4 },
  (_, i) => new Identity(`abolish vouch vector vouchee ${i}`).commitment,
);

// One proof by `voucher` at its leaf, with the circuit inputs generateProof
// builds for it (its `fullProve` call, packages/proof/src/generate-proof.ts).
async function prove(voucher, scope, msg) {
  const identity = vouchers[voucher];
  const siblings = t2.path(voucher);
  const out = await generateProof(
    identity,
    { root: t2.root, leaf: identity.commitment, index: voucher, siblings: siblings.slice() },
    big(msg),
    big(scope),
    DEPTH,
    art,
  );
  if (!(await verifyProof(out))) throw new Error("verifyProof");
  if (BigInt(out.merkleTreeRoot) !== t2.root) throw new Error("root");
  if (BigInt(out.message) !== big(msg) || BigInt(out.scope) !== big(scope))
    throw new Error("message or scope");
  const nullifier = poseidon2([F(scope), identity.secretScalar]);
  if (BigInt(out.nullifier) !== nullifier) throw new Error("nullifier");
  // A ‖ B ‖ C, B imaginary part first: `packages/proof`'s packed points are in
  // EIP-197 order already.
  const proof = Buffer.concat(out.points.map(word));
  return {
    input: {
      secret: String(identity.secretScalar),
      merkleProofLength: String(siblings.length),
      merkleProofIndex: String(voucher),
      merkleProofSiblings: siblings.map(String),
      scope: String(F(scope)),
      message: String(F(msg)),
    },
    signals: {
      root: String(t2.root),
      nullifier: String(nullifier),
      message: String(F(msg)),
      scope: String(F(scope)),
    },
    proof,
  };
}

const cases = [];
async function vouch(name, note, voucher, vouchee, slot) {
  const cv = vouchees[vouchee];
  const sV = vouchScope(cv);
  const sJ = slotScope(slot);
  // Each nullifier needs only the secret and its scope, so both come first.
  const s = vouchers[voucher].secretScalar;
  const nV = poseidon2([F(sV), s]);
  const nS = poseidon2([F(sJ), s]);
  const v = await prove(voucher, sV, message(0, cv, nS));
  const j = await prove(voucher, sJ, message(1, cv, nV));
  const record = Buffer.concat([
    uint(T2_GROUP, 8),
    uint(ROOT_BLOCK, 8),
    word(t2.root),
    uint(slot, 2),
    word(nV),
    word(nS),
    v.proof,
    j.proof,
  ]);
  if (record.length !== 626) throw new Error("vouch length");
  cases.push({
    name,
    note,
    voucher,
    vouchee,
    slot,
    vouchee_proof: { ...v, proof: v.proof.toString("hex") },
    slot_proof: { ...j, proof: j.proof.toString("hex") },
    vouch: record.toString("hex"),
  });
}

await vouch("leaf-zero", "voucher 0 at leaf 0, slot 5", 0, 0, 5);
await vouch("middle", "voucher 3 at leaf 3, slot 0", 3, 0, 0);
await vouch("last-leaf", "voucher 4 at the last leaf, slot 11 (L − 1)", 4, 0, L - 1);
await vouch("other-vouchee", "voucher 0 for another vouchee, slot 5 again", 0, 1, 5);

// The first three vouch for vouchee 0: together they are an addition every
// check of one addition passes.
const forVouchee0 = cases.filter((c) => c.vouchee === 0);
if (forVouchee0.length !== K) throw new Error("addition count");
const addition = Buffer.concat([
  uint(TIER1_GROUP, 8),
  word(vouchees[0]),
  Buffer.from([K]),
  ...forVouchee0.map((c) => Buffer.from(c.vouch, "hex")),
]);
if (addition.length !== 41 + 626 * K) throw new Error("addition length");

const out = {
  format: "abolish-vouch-prover-vectors/1",
  title: "Vouch prover: voucher secrets, both proofs' circuit inputs and real Semaphore proofs",
  spec: "docs/spec/vouching.md",
  generator:
    "packages/crypto/scripts/vouch-prover-vectors.mjs, run outside the workspace: identities and proofs from Semaphore 4.14.3's Identity and generateProof over the semaphore-32 artifacts, each checked by Semaphore's verifyProof, the tier tree from poseidon-lite 0.3.0, the field mapping from ethers 6.13.4's keccak256, hashes from node:crypto",
  source: {
    semaphore:
      "semaphore-protocol/semaphore v4.14.3 (4dbc39b83a4066bf5084fd7f5d336202aad2f815), @semaphore-protocol/core 4.14.3",
    artifacts: Object.fromEntries(
      Object.entries(ARTIFACTS).map(([n, h]) => [
        `https://snark-artifacts.pse.dev/semaphore/4.13.0/${n}`,
        h,
      ]),
    ),
  },
  context: { chainId: String(CHAIN_ID), registry: REGISTRY.toString("hex") },
  groupId: String(TIER1_GROUP),
  tier2: {
    groupId: String(T2_GROUP),
    rootBlock: String(ROOT_BLOCK),
    leaves: leaves.map(String),
    root: String(t2.root),
  },
  vouchers: vouchers.map((id, i) => ({
    seed: voucherSeed(i),
    secret: word(id.secretScalar).toString("hex"),
    commitment: String(id.commitment),
  })),
  vouchees: vouchees.map(String),
  cases,
  addition: { vouchee: 0, cases: forVouchee0.map((c) => c.name), record: addition.toString("hex") },
};
writeFileSync(join(outDir, "vouch-prover.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(cases.map((c) => `${c.name}: ok`).join("\n"));
exit(0);
