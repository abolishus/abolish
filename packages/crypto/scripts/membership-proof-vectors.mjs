// Independent generator for docs/spec/vectors/membership-proof.json
// (docs/spec/membership.md, Proof encoding and Verification key). It shares no
// code with packages/crypto: proofs come from Semaphore v4.14.3's own
// `generateProof` and circuit artifacts, every verdict from snarkjs 0.7.5's
// `groth16.verify`, the tier tree from poseidon-lite's `poseidon2` and the
// hashes from node:crypto. Off-curve and wrong-subgroup points are built with
// ffjavascript, snarkjs's own field and curve code.
//
// It runs outside the workspace, because packages/crypto depends on @noble/*
// only. In an empty directory:
//
//   vp add @semaphore-protocol/core@4.14.3 snarkjs@0.7.5 poseidon-lite@0.3.0 ffjavascript@0.3.1 ethers@6.13.4
//   curl -O https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.{wasm,zkey}
//   curl -O https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-1.{wasm,zkey}
//   vp node membership-proof-vectors.mjs <artifacts-dir> <verification-keys.json> <out-dir>
//
// The artifacts are the ones `generateProof` downloads for Semaphore 4.14.3.
// Their sha256s are checked below, and the depth-32 zkey's verification key
// is checked against the vendored verification-keys.json before anything is
// written. Groth16 proving is randomised, so a rerun gives other proof bytes
// (the same public signals); the committed file is the record.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit } from "node:process";
import { Identity, generateProof, verifyProof } from "@semaphore-protocol/core";
import { keccak256, toBeHex } from "ethers";
import { buildBn128 } from "ffjavascript";
import { poseidon2 } from "poseidon-lite";
import { groth16, zKey } from "snarkjs";

const [artifacts, vkPath, outDir] = argv.slice(2);
if (outDir === undefined)
  throw new Error("usage: <artifacts-dir> <verification-keys.json> <out-dir>");

const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const P = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
const DEPTH = 32;

const ARTIFACTS = {
  "semaphore-32.wasm": "528333d1247f585d33c5a40f46053fb7f8b1f5b8b8fa29118abfc47a60921dc5",
  "semaphore-32.zkey": "2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650",
  "semaphore-1.wasm": "70289ef3bdfa86e97debdb227e76721b392f45b5e73d5e7136d93a04dce0dff9",
  "semaphore-1.zkey": "471a978875f91411b21ba5a2fbea41df30ec45eb23e3ac045edf7f30a2846a08",
};
const sha256 = (b) => createHash("sha256").update(b).digest();
for (const [name, want] of Object.entries(ARTIFACTS)) {
  const got = sha256(readFileSync(join(artifacts, name))).toString("hex");
  if (got !== want) throw new Error(`${name}: sha256 ${got}, expected ${want}`);
}
const art = (d) => ({
  wasm: join(artifacts, `semaphore-${d}.wasm`),
  zkey: join(artifacts, `semaphore-${d}.zkey`),
});

// --- The pinned key, from the vendored file, checked against the zkey. ---
const keys = JSON.parse(readFileSync(vkPath, "utf8"));
const vk32 = { ...keys, vk_delta_2: keys.vk_delta_2[DEPTH - 1], IC: keys.IC[DEPTH - 1] };
const vk1 = { ...keys, vk_delta_2: keys.vk_delta_2[0], IC: keys.IC[0] };
for (const [d, vk] of [
  [32, vk32],
  [1, vk1],
]) {
  const z = await zKey.exportVerificationKey(art(d).zkey);
  const pick = (k) => JSON.stringify([k.vk_alpha_1, k.vk_beta_2, k.vk_gamma_2, k.vk_delta_2, k.IC]);
  if (pick(z) !== pick(vk)) throw new Error(`depth ${d}: zkey and verification-keys.json differ`);
}

const word = (v) => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
const g1 = (p) => Buffer.concat([word(p[0]), word(p[1])]);
// EIP-197 order: imaginary part first.
const g2 = (p) => Buffer.concat([word(p[0][1]), word(p[0][0]), word(p[1][1]), word(p[1][0])]);
const vkEncoding = Buffer.concat([
  g1(vk32.vk_alpha_1),
  g2(vk32.vk_beta_2),
  g2(vk32.vk_gamma_2),
  g2(vk32.vk_delta_2),
  ...vk32.IC.map(g1),
]);
if (vkEncoding.length !== 768) throw new Error("verification key encoding length");
const zkeySha256 = Buffer.from(ARTIFACTS["semaphore-32.zkey"], "hex");
const ds = (tag, m) => Buffer.concat([Buffer.from([tag.length]), Buffer.from(tag, "ascii"), m]);
const vkHash = sha256(
  ds("abolish/v1/membership-vk", Buffer.concat([Buffer.from([DEPTH]), vkEncoding, zkeySha256])),
);

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
    levels.push(up.length ? up : []);
  }
  const root = levels[DEPTH][0] ?? Z[DEPTH];
  const path = (i) => Array.from({ length: DEPTH }, (_, h) => levels[h][(i >> h) ^ 1] ?? Z[h]);
  return { root, path };
}

// --- Abolish's scope and message bytes, tied to Semaphore's own `hash`. ---
const definitionHash = sha256(Buffer.from("membership-proof vectors: definition"));
const scopeBytes = (tier, root) =>
  sha256(
    ds(
      "abolish/v1/nullifier-scope",
      Buffer.concat([definitionHash, Buffer.from([tier]), word(root)]),
    ),
  );
// A stand-in for revoting's M: any 32 bytes; only F(M) enters the circuit.
const messageBytes = (label) => sha256(Buffer.from(`membership-proof vectors: ${label}`));
const big = (b) => BigInt(`0x${b.toString("hex")}`);

const identities = Array.from(
  { length: 8 },
  (_, i) => new Identity(`abolish membership-proof vector ${i}`),
);
const tier0Leaves = [identities[0], identities[1], identities[2]].map((id) => id.commitment);
// Tier 2 holds a removed member (leaf 0) and a forbidden one (leaf 0) before the prover.
const tier2Leaves = [
  identities[3].commitment,
  0n,
  identities[4].commitment,
  0n,
  identities[5].commitment,
  identities[6].commitment,
];
const t0 = tree(tier0Leaves);
const t2 = tree(tier2Leaves);

const pack = (proof) => Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]);

async function semaphore(identity, t, index, tier, label, depth = DEPTH) {
  const scope = scopeBytes(tier, t.root);
  const message = messageBytes(label);
  const merkleProof = { root: t.root, leaf: identity.commitment, index, siblings: t.path(index) };
  const out = await generateProof(
    identity,
    merkleProof,
    big(message),
    big(scope),
    depth,
    art(depth),
  );
  return { out, scope, message };
}

function unpack(points) {
  return {
    pi_a: [points[0], points[1], "1"],
    pi_b: [
      [points[3], points[2]],
      [points[5], points[4]],
      ["1", "0"],
    ],
    pi_c: [points[6], points[7], "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

const curve = await buildBn128(true);
const { G1, G2, Fr } = curve;
const toG1 = (p) => G1.fromObject([BigInt(p[0]), BigInt(p[1]), 1n]);
const toG2 = (p) =>
  G2.fromObject([
    [BigInt(p[0][0]), BigInt(p[0][1])],
    [BigInt(p[1][0]), BigInt(p[1][1])],
    [1n, 0n],
  ]);
const fromG1 = (q) => G1.toObject(G1.toAffine(q)).map(String);
const fromG2 = (q) =>
  G2.toObject(G2.toAffine(q)).map((c) => (Array.isArray(c) ? c.map(String) : String(c)));

const cases = [];
async function record(name, proof, signals, expected, reason, note) {
  const verdict = await groth16.verify(vk32, signals.map(String), proof);
  cases.push({
    name,
    note,
    proof: pack(proof).toString("hex"),
    signals: {
      root: String(signals[0]),
      nullifier: String(signals[1]),
      message: String(signals[2]),
      scope: String(signals[3]),
    },
    snarkjs: verdict,
    valid: expected,
    ...(reason === undefined ? {} : { reason }),
  });
}

// Honest proofs, through Semaphore's own API with Abolish's scope and message.
const a = await semaphore(identities[1], t0, 1, 0, "a");
const aProof = unpack(a.out.points);
const aSignals = [t0.root, BigInt(a.out.nullifier), null, null];
// Semaphore's `hash` (packages/proof/src/hash.ts, not exported), with the
// ethers version Semaphore pins. `verifyProof` below runs Semaphore's own copy.
const hashOf = (b) => BigInt(keccak256(toBeHex(big(b), 32))) >> 8n;
aSignals[2] = hashOf(a.message);
aSignals[3] = hashOf(a.scope);
if (BigInt(a.out.merkleTreeRoot) !== t0.root) throw new Error("root");
for (const p of [a.out]) if (!(await verifyProof(p))) throw new Error("Semaphore's verifyProof");

const b = await semaphore(identities[5], t2, 4, 2, "b");
const bProof = unpack(b.out.points);
const bSignals = [t2.root, BigInt(b.out.nullifier), hashOf(b.message), hashOf(b.scope)];
if (!(await verifyProof(b.out))) throw new Error("Semaphore's verifyProof");

const ties = [
  {
    scopeBytes: a.scope.toString("hex"),
    tier: 0,
    root: String(t0.root),
    scope: String(aSignals[3]),
  },
  {
    scopeBytes: b.scope.toString("hex"),
    tier: 2,
    root: String(t2.root),
    scope: String(bSignals[3]),
  },
  { messageBytes: a.message.toString("hex"), message: String(aSignals[2]) },
  { messageBytes: b.message.toString("hex"), message: String(bSignals[2]) },
];

await record("honest", aProof, aSignals, true, undefined, "tier 0, leaf 1 of 3");
await record(
  "honest-sparse",
  bProof,
  bSignals,
  true,
  undefined,
  "tier 2, leaf 4 of 6, after removed and forbidden leaves (0)",
);

// Re-randomised: A/k, k·B. Same statement, other bytes, still valid (T-38).
const k = Fr.e(0x1234567890abcdefn);
const rerand = {
  ...aProof,
  pi_a: [...fromG1(G1.timesFr(toG1(aProof.pi_a), Fr.inv(k))), "1"],
  pi_b: [...fromG2(G2.timesFr(toG2(aProof.pi_b), k)), ["1", "0"]],
};
await record(
  "rerandomised",
  rerand,
  aSignals,
  true,
  undefined,
  "the honest proof with A·k⁻¹ and B·k: other bytes, same statement",
);

// Tampered proofs.
const negA = { ...aProof, pi_a: [aProof.pi_a[0], String(P - BigInt(aProof.pi_a[1])), "1"] };
await record("tampered-a", negA, aSignals, false, "proof", "A negated");
const cPlusG = { ...aProof, pi_c: [...fromG1(G1.add(toG1(aProof.pi_c), G1.g)), "1"] };
await record("tampered-c", cPlusG, aSignals, false, "proof", "C + G1");
const swapAC = { ...aProof, pi_a: aProof.pi_c, pi_c: aProof.pi_a };
await record("swapped-a-c", swapAC, aSignals, false, "proof", "A and C exchanged");

// Wrong public signals.
await record(
  "wrong-nullifier",
  aProof,
  [aSignals[0], aSignals[1] + 1n, aSignals[2], aSignals[3]],
  false,
  "proof",
  "ν + 1",
);
await record(
  "wrong-message",
  aProof,
  [aSignals[0], aSignals[1], bSignals[2], aSignals[3]],
  false,
  "proof",
  "another ballot's m̂",
);
await record(
  "wrong-root",
  aProof,
  [t2.root, aSignals[1], aSignals[2], aSignals[3]],
  false,
  "proof",
  "another tier's root",
);
// The same root under tier 1: the scope binds the tier, so the proof doesn't move.
const tier1Scope = hashOf(scopeBytes(1, t0.root));
await record(
  "other-tier-scope",
  aProof,
  [aSignals[0], aSignals[1], aSignals[2], tier1Scope],
  false,
  "proof",
  "tier 1's scope over tier 0's root",
);
await record(
  "swapped-signals",
  aProof,
  [aSignals[0], aSignals[1], aSignals[3], aSignals[2]],
  false,
  "proof",
  "m̂ and ŝ exchanged",
);

// Out-of-range signals: a public input is never reduced modulo r.
await record(
  "nullifier-plus-r",
  aProof,
  [aSignals[0], aSignals[1] + R, aSignals[2], aSignals[3]],
  false,
  "signal",
  "ν + r, non-canonical",
);
await record(
  "root-plus-r",
  aProof,
  [aSignals[0] + R, aSignals[1], aSignals[2], aSignals[3]],
  false,
  "signal",
  "ρ + r, non-canonical",
);

// A proof under the depth-1 key, for a one-member tree (root = its commitment).
const one = { root: identities[7].commitment, path: () => [0n] };
const scope1 = scopeBytes(0, one.root);
const msg1 = messageBytes("depth-1");
const d1 = await generateProof(
  identities[7],
  { root: one.root, leaf: identities[7].commitment, index: 0, siblings: [] },
  big(msg1),
  big(scope1),
  1,
  art(1),
);
const d1Proof = unpack(d1.points);
const d1Signals = [one.root, BigInt(d1.nullifier), hashOf(msg1), hashOf(scope1)];
if (!(await groth16.verify(vk1, d1Signals.map(String), d1Proof))) throw new Error("depth-1 proof");
await record(
  "depth-1-key",
  d1Proof,
  d1Signals,
  false,
  "proof",
  "valid under Semaphore's depth-1 key, not the pinned depth-32 key",
);

// Root 0: a proof length above the depth makes the circuit output root 0 for any secret.
async function raw(identity, len, index, siblings, scope, message) {
  const { proof, publicSignals } = await groth16.fullProve(
    {
      secret: identity.secretScalar,
      merkleProofLength: len,
      merkleProofIndex: index,
      merkleProofSiblings: siblings,
      scope: hashOf(scope),
      message: hashOf(message),
    },
    art(32).wasm,
    art(32).zkey,
  );
  return { proof, signals: publicSignals.map(BigInt) };
}
const zeroMsg = messageBytes("root-0");
const zero = await raw(
  identities[2],
  33,
  0,
  Array(DEPTH).fill(0n),
  scopeBytes(0, t0.root),
  zeroMsg,
);
if (zero.signals[0] !== 0n) throw new Error("root-0 proof should output root 0");
await record(
  "root-zero",
  zero.proof,
  zero.signals,
  false,
  "root",
  "proof length 33 > 32: the circuit outputs ρ = 0, which snarkjs accepts and Abolish never does",
);

// Hidden subtree: register V = Poseidon2(C_a, C_b), then prove C_a with V's
// path pushed down one level (len = 32: C_b, then V's first 31 siblings).
const hiddenLeaves = [
  identities[0].commitment,
  poseidon2([identities[3].commitment, identities[4].commitment]),
];
const th = tree(hiddenLeaves);
const hScope = scopeBytes(0, th.root);
const hMsg = messageBytes("hidden");
const hidden = await raw(
  identities[3],
  DEPTH,
  0b10,
  [identities[4].commitment, ...th.path(1).slice(0, DEPTH - 1)],
  hScope,
  hMsg,
);
if (hidden.signals[0] === th.root) throw new Error("hidden subtree reached the tier root");
await record(
  "hidden-subtree",
  hidden.proof,
  [th.root, hidden.signals[1], hidden.signals[2], hidden.signals[3]],
  false,
  "proof",
  "a member of a private tree whose root is a registered leaf, proven at depth 32: its root is not the tier root",
);

// Decoding: the honest proof's bytes with one field broken.
const honest = pack(aProof);
const splice = (at, bytes) => {
  const b = Buffer.from(honest);
  bytes.copy(b, at);
  return b;
};
const coord = (at) => BigInt(`0x${honest.subarray(at, at + 32).toString("hex")}`);
// A point of the twist that isn't in the order-r subgroup.
function twistPointOutsideSubgroup() {
  const F2 = curve.F2;
  for (let x0 = 1n; ; x0++) {
    const x = F2.fromObject([x0, 0n]);
    const rhs = F2.add(F2.mul(F2.square(x), x), G2.b);
    if (!F2.isSquare(rhs)) continue;
    const y = F2.sqrt(rhs);
    if (!F2.eq(F2.square(y), rhs)) throw new Error("sqrt");
    const p = G2.fromObject([F2.toObject(x), F2.toObject(y), [1n, 0n]]);
    if (!G2.isZero(G2.timesScalar(p, leBytes(R)))) return [F2.toObject(x), F2.toObject(y)];
  }
}
function leBytes(v) {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number((v >> BigInt(8 * i)) & 0xffn);
  return b;
}
const outside = twistPointOutsideSubgroup();
const outsideBytes = g2([outside[0].map(String), outside[1].map(String)]);
const bx = honest.subarray(64, 192);
const decode = [
  { name: "short", proof: honest.subarray(0, 255).toString("hex"), note: "255 bytes" },
  {
    name: "long",
    proof: Buffer.concat([honest, Buffer.from([0])]).toString("hex"),
    note: "257 bytes",
  },
  {
    name: "a-x-plus-p",
    proof: splice(0, word(coord(0) + P)).toString("hex"),
    note: "A.x + p, non-canonical",
  },
  {
    name: "a-y-off-curve",
    proof: splice(32, word(coord(32) ^ 1n)).toString("hex"),
    note: "A not on the curve",
  },
  {
    name: "a-identity",
    proof: splice(0, Buffer.alloc(64)).toString("hex"),
    note: "A = (0, 0), the identity",
  },
  {
    name: "b-coordinate-plus-p",
    proof: splice(64 + 32, word(coord(96) + P)).toString("hex"),
    note: "B.x.c0 + p, non-canonical",
  },
  {
    name: "b-component-order",
    proof: splice(
      64,
      Buffer.concat([
        bx.subarray(32, 64),
        bx.subarray(0, 32),
        bx.subarray(96, 128),
        bx.subarray(64, 96),
      ]),
    ).toString("hex"),
    note: "B with c0 before c1 (snarkjs's order, not EIP-197's)",
  },
  {
    name: "b-off-curve",
    proof: splice(64 + 96, word(coord(160) ^ 1n)).toString("hex"),
    note: "B not on the twist",
  },
  {
    name: "b-outside-subgroup",
    proof: splice(64, outsideBytes).toString("hex"),
    note: "B on the twist, outside the order-r subgroup",
  },
  {
    name: "b-identity",
    proof: splice(64, Buffer.alloc(128)).toString("hex"),
    note: "B = 0, the identity",
  },
  {
    name: "c-x-plus-p",
    proof: splice(192, word(coord(192) + P)).toString("hex"),
    note: "C.x + p, non-canonical",
  },
  {
    name: "c-identity",
    proof: splice(192, Buffer.alloc(64)).toString("hex"),
    note: "C = (0, 0), the identity",
  },
];
if (Buffer.from(decode[2].proof, "hex").length !== 256) throw new Error("splice");

const out = {
  format: "abolish-membership-proof-vectors/1",
  title: "Membership proofs: the pinned verification key, real Semaphore proofs, and rejections",
  spec: "docs/spec/membership.md",
  generator:
    "packages/crypto/scripts/membership-proof-vectors.mjs, run outside the workspace: proofs from Semaphore 4.14.3's generateProof (and snarkjs 0.7.5's fullProve for witnesses generateProof refuses) over the semaphore-32 and semaphore-1 artifacts, every verdict in `snarkjs` from snarkjs's groth16.verify, tier trees from poseidon-lite 0.3.0, hashes from node:crypto",
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
  verificationKey: {
    depth: DEPTH,
    encoding: vkEncoding.toString("hex"),
    zkeySha256: zkeySha256.toString("hex"),
    hash: vkHash.toString("hex"),
  },
  definitionHash: definitionHash.toString("hex"),
  trees: [
    { id: "tier-0", tier: 0, leaves: tier0Leaves.map(String), root: String(t0.root) },
    { id: "tier-2", tier: 2, leaves: tier2Leaves.map(String), root: String(t2.root) },
    { id: "hidden", tier: 0, leaves: hiddenLeaves.map(String), root: String(th.root) },
  ],
  fieldMapping: ties,
  proofs: cases,
  decode,
};
writeFileSync(join(outDir, "membership-proof.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(cases.map((c) => `${c.name}: snarkjs ${c.snarkjs}, valid ${c.valid}`).join("\n"));
exit(0);
