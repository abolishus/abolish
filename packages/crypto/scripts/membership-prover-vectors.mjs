// Independent generator for docs/spec/vectors/membership-prover.json
// (docs/spec/membership.md, Statement, Tier tree and Security notes; P2-21
// part 2): what a client hands the Groth16 prover, and what it must get back.
// It shares no code with packages/crypto: identities, their secret scalars and
// commitments and every proof come from Semaphore v4.14.3's own `Identity` and
// `generateProof`, each proof is checked by Semaphore's `verifyProof`, the
// tier trees and paths from poseidon-lite's `poseidon2`, the field mapping
// from ethers' keccak256 and the hashes from node:crypto.
//
// The members and trees are membership-proof.json's (the same identity seeds,
// leaves and definition hash), so the two files agree; this one adds the
// secrets, the circuit's private inputs and a fresh proof per case.
//
// It runs outside the workspace, because packages/crypto depends on @noble/*
// only. In an empty directory:
//
//   vp add @semaphore-protocol/core@4.14.3 snarkjs@0.7.5 poseidon-lite@0.3.0 ethers@6.13.4
//   curl -O https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.{wasm,zkey}
//   vp node membership-prover-vectors.mjs <artifacts-dir> <out-dir>
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
const L = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

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
const ds = (tag, m) => Buffer.concat([Buffer.from([tag.length]), Buffer.from(tag, "ascii"), m]);
const big = (b) => BigInt(`0x${b.toString("hex")}`);
// Semaphore's `hash` (packages/proof/src/hash.ts, not exported).
const F = (b) => BigInt(keccak256(toBeHex(big(b), 32))) >> 8n;

// --- Tier trees (docs/spec/membership.md, Tier tree), with poseidon-lite. ---
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

// membership-proof.json's definition hash, identities and trees.
const definitionHash = sha256(Buffer.from("membership-proof vectors: definition"));
const scopeBytes = (tier, root) =>
  sha256(
    ds(
      "abolish/v1/nullifier-scope",
      Buffer.concat([definitionHash, Buffer.from([tier]), word(root)]),
    ),
  );
const messageBytes = (label) => sha256(Buffer.from(`membership-prover vectors: ${label}`));

const identities = Array.from(
  { length: 8 },
  (_, i) => new Identity(`abolish membership-proof vector ${i}`),
);
for (const id of identities) {
  if (id.secretScalar < 1n || id.secretScalar >= L) throw new Error("secret scalar out of range");
  if (id.commitment !== poseidon2(id.publicKey)) throw new Error("commitment");
}
const tiers = {
  "tier-0": { tier: 0, leaves: [0, 1, 2].map((i) => identities[i].commitment) },
  "tier-2": {
    tier: 2,
    leaves: [identities[3].commitment, 0n, identities[4].commitment, 0n].concat(
      [5, 6].map((i) => identities[i].commitment),
    ),
  },
  // One member registered twice: the client proves at the first of its leaves.
  repeated: {
    tier: 1,
    leaves: [identities[7].commitment, identities[0].commitment, identities[7].commitment],
  },
};
for (const t of Object.values(tiers)) Object.assign(t, tree(t.leaves));

const cases = [];
async function prove(name, note, member, treeId, index) {
  const t = tiers[treeId];
  const identity = identities[member];
  if (t.leaves.indexOf(identity.commitment) !== index) throw new Error(`${name}: index`);
  const scope = scopeBytes(t.tier, t.root);
  const message = messageBytes(name);
  const siblings = t.path(index);
  const out = await generateProof(
    identity,
    { root: t.root, leaf: identity.commitment, index, siblings: siblings.slice() },
    big(message),
    big(scope),
    DEPTH,
    art,
  );
  if (!(await verifyProof(out))) throw new Error(`${name}: verifyProof`);
  if (BigInt(out.merkleTreeRoot) !== t.root) throw new Error(`${name}: root`);
  const nullifier = poseidon2([F(scope), identity.secretScalar]);
  if (BigInt(out.nullifier) !== nullifier) throw new Error(`${name}: nullifier`);
  // generateProof returns the message and scope as given; its verifyProof maps them.
  if (BigInt(out.message) !== big(message) || BigInt(out.scope) !== big(scope))
    throw new Error(`${name}: message or scope`);
  const [ax, ay, bx1, bx0, by1, by0, cx, cy] = out.points;
  // A ‖ B ‖ C, B imaginary part first: `packages/proof`'s packed points are in
  // EIP-197 order already.
  const proof = Buffer.concat([ax, ay, bx1, bx0, by1, by0, cx, cy].map(word));
  cases.push({
    name,
    note,
    member,
    tree: treeId,
    message: message.toString("hex"),
    // The circuit inputs generateProof builds from this path (its
    // `fullProve` call, packages/proof/src/generate-proof.ts), whose proof
    // Semaphore's verifyProof accepted: a full 32-sibling path, so
    // `merkleProofLength` is 32.
    input: {
      secret: String(identity.secretScalar),
      merkleProofLength: String(siblings.length),
      merkleProofIndex: String(index),
      merkleProofSiblings: siblings.map(String),
      scope: String(F(scope)),
      message: String(F(message)),
    },
    signals: {
      root: String(t.root),
      nullifier: String(nullifier),
      message: String(F(message)),
      scope: String(F(scope)),
    },
    proof: proof.toString("hex"),
  });
}

await prove("first-tier", "tier 0, leaf 1 of 3", 1, "tier-0", 1);
await prove(
  "sparse",
  "tier 2, leaf 4 of 6, after removed and forbidden leaves (0)",
  5,
  "tier-2",
  4,
);
await prove("leaf-zero", "tier 2, leaf 0", 3, "tier-2", 0);
await prove(
  "repeated",
  "tier 1, a commitment at leaves 0 and 2, proven at leaf 0",
  7,
  "repeated",
  0,
);

const out = {
  format: "abolish-membership-prover-vectors/1",
  title: "Membership prover: identity secrets, the circuit's inputs and real Semaphore proofs",
  spec: "docs/spec/membership.md",
  generator:
    "packages/crypto/scripts/membership-prover-vectors.mjs, run outside the workspace: identities and proofs from Semaphore 4.14.3's Identity and generateProof over the semaphore-32 artifacts, each checked by Semaphore's verifyProof, tier trees from poseidon-lite 0.3.0, the field mapping from ethers 6.13.4's keccak256, hashes from node:crypto",
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
  definitionHash: definitionHash.toString("hex"),
  members: identities.map((id, i) => ({
    seed: `abolish membership-proof vector ${i}`,
    secret: word(id.secretScalar).toString("hex"),
    commitment: String(id.commitment),
  })),
  trees: Object.entries(tiers).map(([id, t]) => ({
    id,
    tier: t.tier,
    leaves: t.leaves.map(String),
    root: String(t.root),
  })),
  cases,
};
writeFileSync(join(outDir, "membership-prover.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(cases.map((c) => `${c.name}: ok`).join("\n"));
exit(0);
