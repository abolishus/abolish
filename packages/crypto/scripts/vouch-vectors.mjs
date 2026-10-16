// Independent generator for docs/spec/vectors/vouch.json and vouch-count.json
// (docs/spec/vouching.md).
// It shares no code with packages/crypto: proofs come from Semaphore v4.14.3's
// own `generateProof` and circuit artifacts, every proof's verdict from
// snarkjs 0.7.5's `groth16.verify`, the field mapping from Semaphore's own
// `hash` (keccak256 from ethers, shifted right by 8), the tier tree from
// poseidon-lite's `poseidon2`, SHA-256 from node:crypto, and the Tier 2
// records' EIP-712 digests, signatures and recovery from ethers. The expected
// verdict of each addition is written out by hand from the spec's checks, in
// the spec's order, and the script refuses to print a case whose proofs
// snarkjs judges differently from what the case claims, or, for the counting
// cases, whose verdicts this script's own replay of the counting rule
// (Counting across the deployment) doesn't reproduce.
//
// It runs outside the workspace, because packages/crypto depends on @noble/*
// only. In an empty directory:
//
//   vp add @semaphore-protocol/core@4.14.3 snarkjs@0.7.5 poseidon-lite@0.3.0 ffjavascript@0.3.1 ethers@6.13.4
//   curl -O https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.{wasm,zkey}
//   vp node vouch-vectors.mjs <artifacts-dir> <verification-keys.json> <out-dir>
//
// with packages/crypto/test-vectors/semaphore/verification-keys.json.
//
// Groth16 proving is randomised, so a rerun gives other proof bytes for the
// same statements; the committed file is the record.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit } from "node:process";
import { Identity, generateProof } from "@semaphore-protocol/core";
import { TypedDataEncoder, Wallet, keccak256, recoverAddress, toBeHex } from "ethers";
import { buildBn128 } from "ffjavascript";
import { poseidon2 } from "poseidon-lite";
import { groth16 } from "snarkjs";

const [artifacts, vkPath, outDir] = argv.slice(2);
if (outDir === undefined)
  throw new Error("usage: <artifacts-dir> <verification-keys.json> <out-dir>");

const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const P = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;
const DEPTH = 32;
const K = 3;
const L = 12;
const POSEIDON2_ZERO_ONE = poseidon2([0n, 1n]);

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
const keys = JSON.parse(readFileSync(vkPath, "utf8"));
const vk = { ...keys, vk_delta_2: keys.vk_delta_2[DEPTH - 1], IC: keys.IC[DEPTH - 1] };

// --- Encodings (docs/spec/notation.md, membership.md Proof encoding). ---
const word = (v) => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
const uint = (v, n) =>
  Buffer.from(
    BigInt(v)
      .toString(16)
      .padStart(2 * n, "0"),
    "hex",
  );
const g1 = (p) => Buffer.concat([word(p[0]), word(p[1])]);
// EIP-197 order: imaginary part first.
const g2 = (p) => Buffer.concat([word(p[0][1]), word(p[0][0]), word(p[1][1]), word(p[1][0])]);
const pack = (proof) => Buffer.concat([g1(proof.pi_a), g2(proof.pi_b), g1(proof.pi_c)]);
const ds = (tag, m) => Buffer.concat([Buffer.from([tag.length]), Buffer.from(tag, "ascii"), m]);
const big = (b) => BigInt(`0x${b.toString("hex")}`);
// Semaphore's `hash` (packages/proof/src/hash.ts), with the ethers version it pins.
const F = (b) => BigInt(keccak256(toBeHex(big(b), 32))) >> 8n;

// --- The binding, scopes and messages (docs/spec/vouching.md). ---
const CHAIN_ID = 84532n;
const REGISTRY = Buffer.from("5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0b", "hex");
const binding = (ctx, groupId) =>
  Buffer.concat([uint(ctx.chainId, 8), ctx.registry, uint(groupId, 8)]);
const vouchScope = (ctx, groupId, cv) => {
  const input = Buffer.concat([binding(ctx, groupId), word(cv)]);
  if (input.length !== 68) throw new Error("vouch scope input length");
  return sha256(ds("abolish/v1/vouch", input));
};
const slotScope = (ctx, j) => {
  const input = Buffer.concat([uint(ctx.chainId, 8), ctx.registry, uint(j, 2)]);
  if (input.length !== 30) throw new Error("slot scope input length");
  return sha256(ds("abolish/v1/vouch-slot", input));
};
const message = (ctx, role, groupId, cv, t2, block, other) => {
  const input = Buffer.concat([
    Buffer.from([role]),
    binding(ctx, groupId),
    word(cv),
    uint(t2, 8),
    uint(block, 8),
    word(other),
  ]);
  if (input.length !== 117) throw new Error("message input length");
  return sha256(ds("abolish/v1/vouch-message", input));
};
const CTX = { chainId: CHAIN_ID, registry: REGISTRY };
const OTHER_CTX = { chainId: 8453n, registry: REGISTRY };
const OTHER_REGISTRY = Buffer.from("5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0b5a0c", "hex");

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

const vouchers = Array.from(
  { length: 6 },
  (_, i) => new Identity(`abolish vouch vector voucher ${i}`),
);
const tier2Leaves = vouchers.slice(0, 5).map((v) => v.commitment);
const t2 = tree(tier2Leaves);
const T2_GROUP = 7n;
const ROOT_BLOCK = 1_234_567n;
const TIER1_GROUP = 9n;
const vouchees = Array.from(
  { length: 4 },
  (_, i) => new Identity(`abolish vouch vector vouchee ${i}`).commitment,
);

// One Semaphore proof of `voucher`'s membership at `t`'s root. Every Tier 2
// tree here holds vouchers in order from 0, so a voucher's index is its leaf's.
async function prove(voucherIndex, scopeBytes, messageBytes, t = t2) {
  const identity = vouchers[voucherIndex];
  const out = await generateProof(
    identity,
    {
      root: t.root,
      leaf: identity.commitment,
      index: voucherIndex,
      siblings: t.path(voucherIndex),
    },
    big(messageBytes),
    big(scopeBytes),
    DEPTH,
    art,
  );
  if (BigInt(out.merkleTreeRoot) !== t.root) throw new Error("root");
  // Semaphore reports the scope and message as given; it proves over their `hash`.
  if (BigInt(out.scope) !== big(scopeBytes) || BigInt(out.message) !== big(messageBytes))
    throw new Error("scope or message");
  const p = out.points;
  return {
    proof: {
      pi_a: [p[0], p[1], "1"],
      pi_b: [
        [p[3], p[2]],
        [p[5], p[4]],
        ["1", "0"],
      ],
      pi_c: [p[6], p[7], "1"],
      protocol: "groth16",
      curve: "bn128",
    },
    nullifier: BigInt(out.nullifier),
  };
}

// Each nullifier is Poseidon2(F(scope), s), computable before proving.
const nullifierOf = (voucherIndex, scopeBytes) =>
  poseidon2([F(scopeBytes), vouchers[voucherIndex].secretScalar]);

/**
 * A vouch for `cv` in Tier 1 group `groupId`: the vouchee proof by
 * `voucher` and the slot proof by `slotVoucher` (the same member unless the
 * slot is pooled), spending slot `j`.
 */
async function vouch({
  ctx = CTX,
  groupId = TIER1_GROUP,
  cv,
  voucher,
  slotVoucher = voucher,
  j,
  rootBlock = ROOT_BLOCK,
  tier2GroupId = T2_GROUP,
  t = t2,
}) {
  const sV = vouchScope(ctx, groupId, cv);
  const sJ = slotScope(ctx, j);
  const nV = nullifierOf(voucher, sV);
  const nS = nullifierOf(slotVoucher, sJ);
  const mV = message(ctx, 0, groupId, cv, tier2GroupId, rootBlock, nS);
  const mS = message(ctx, 1, groupId, cv, tier2GroupId, rootBlock, nV);
  const pV = await prove(voucher, sV, mV, t);
  const pS = await prove(slotVoucher, sJ, mS, t);
  if (pV.nullifier !== nV || pS.nullifier !== nS) throw new Error("nullifier");
  return {
    tier2GroupId,
    rootBlock,
    root: t.root,
    slot: j,
    voucheeNullifier: nV,
    slotNullifier: nS,
    voucheeProof: pV.proof,
    slotProof: pS.proof,
  };
}

const encodeVouch = (v) => {
  const out = Buffer.concat([
    uint(v.tier2GroupId, 8),
    uint(v.rootBlock, 8),
    word(v.root),
    uint(v.slot, 2),
    word(v.voucheeNullifier),
    word(v.slotNullifier),
    pack(v.voucheeProof),
    pack(v.slotProof),
  ]);
  if (out.length !== 626) throw new Error("vouch length");
  return out;
};
const encodeAddition = (groupId, cv, vouches) =>
  Buffer.concat([
    uint(groupId, 8),
    word(cv),
    Buffer.from([vouches.length]),
    ...vouches.map(encodeVouch),
  ]);

// snarkjs's verdict on each proof of a vouch, recomputing every signal from
// the spec, under context `ctx` and the record's own group and commitment.
async function snarkjsVerdicts(ctx, groupId, cv, v) {
  const sV = F(vouchScope(ctx, groupId, cv));
  const sJ = F(slotScope(ctx, v.slot));
  const mV = F(message(ctx, 0, groupId, cv, v.tier2GroupId, v.rootBlock, v.slotNullifier));
  const mS = F(message(ctx, 1, groupId, cv, v.tier2GroupId, v.rootBlock, v.voucheeNullifier));
  const ok = (signals, proof) =>
    signals.every((s) => s < R) ? groth16.verify(vk, signals.map(String), proof) : false;
  return [
    await ok([v.root, v.voucheeNullifier, mV, sV], v.voucheeProof),
    await ok([v.root, v.slotNullifier, mS, sJ], v.slotProof),
  ];
}

// The spec's checks, in its order (docs/spec/vouching.md, Checks of one
// addition), over decoded values; decoding is exercised by `decode` below.
async function expected(ctx, groupId, cv, vouches) {
  const forbidden = cv < 2n || cv >= R || cv === POSEIDON2_ZERO_ONE;
  if (forbidden) return { error: "forbidden-commitment" };
  for (const [i, v] of vouches.entries()) if (v.slot >= L) return { error: "slot", vouch: i };
  for (const [i, v] of vouches.entries()) if (v.root === 0n) return { error: "root", vouch: i };
  for (const field of ["voucheeNullifier", "slotNullifier"])
    for (let i = 1; i < vouches.length; i++)
      if (vouches.slice(0, i).some((u) => u[field] === vouches[i][field]))
        return {
          error: field === "voucheeNullifier" ? "duplicate-voucher" : "duplicate-slot",
          vouch: i,
        };
  for (const [i, v] of vouches.entries()) {
    const [a, b] = await snarkjsVerdicts(ctx, groupId, cv, v);
    if (!a || !b) return { error: "proof", vouch: i, which: a ? "slot" : "vouchee" };
  }
  return {};
}

const additions = [];
async function addition(id, description, { ctx = CTX, groupId = TIER1_GROUP, cv, vouches, want }) {
  const got = await expected(ctx, groupId, cv, vouches);
  // Whether every proof passes snarkjs with the recomputed signals: a case a
  // cheap check refuses but whose proofs all pass shows that check is needed.
  let snarkjs = true;
  for (const v of vouches)
    if ((await snarkjsVerdicts(ctx, groupId, cv, v)).includes(false)) snarkjs = false;
  if (JSON.stringify(got) !== JSON.stringify(want))
    throw new Error(
      `${id}: expected ${JSON.stringify(want)}, the checks give ${JSON.stringify(got)}`,
    );
  additions.push({
    id,
    description,
    context: { chainId: String(ctx.chainId), registry: ctx.registry.toString("hex") },
    groupId: String(groupId),
    commitment: String(cv),
    record: encodeAddition(groupId, cv, vouches).toString("hex"),
    snarkjs,
    ...(want.error === undefined ? { valid: true } : { valid: false, ...want }),
  });
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
const rerandomise = (proof, k) => ({
  ...proof,
  pi_a: [...fromG1(G1.timesFr(toG1(proof.pi_a), Fr.inv(Fr.e(k)))), "1"],
  pi_b: [...fromG2(G2.timesFr(toG2(proof.pi_b), Fr.e(k))), ["1", "0"]],
});

const [c0, c1, c2] = vouchees;
// Honest vouches for c0 from vouchers 0, 1 and 2.
const h0 = await vouch({ cv: c0, voucher: 0, j: 5 });
const h1 = await vouch({ cv: c0, voucher: 1, j: 0 });
const h2 = await vouch({ cv: c0, voucher: 2, j: 11 });
const honest = [h0, h1, h2];

await addition("honest", "three vouchers, three slots, one Tier 2 root", {
  cv: c0,
  vouches: honest,
  want: {},
});
await addition("honest-reordered", "the same vouches in another order", {
  cv: c0,
  vouches: [h2, h0, h1],
  want: {},
});
await addition(
  "rerandomised",
  "the honest vouches with every proof re-randomised (A·k⁻¹, B·k): other bytes, same vouch",
  {
    cv: c0,
    vouches: honest.map((v, i) => ({
      ...v,
      voucheeProof: rerandomise(v.voucheeProof, 0x1234n + BigInt(i)),
      slotProof: rerandomise(v.slotProof, 0x5678n + BigInt(i)),
    })),
    want: {},
  },
);

// Pooled: voucher 3's vouchee proof funded by voucher 4's slot. Valid.
const pooled = await vouch({ cv: c1, voucher: 3, slotVoucher: 4, j: 2 });
const p1 = await vouch({ cv: c1, voucher: 0, j: 3 });
const p2 = await vouch({ cv: c1, voucher: 1, j: 3 });
await addition(
  "pooled-slot",
  "one vouch pairs voucher 3's vouchee proof with voucher 4's slot proof: valid, and counted against both",
  { cv: c1, vouches: [pooled, p1, p2], want: {} },
);
// Self-vouch: a Tier 2 member vouching for their own Tier 1 commitment can't be detected.

// Duplicate voucher: voucher 0 twice for c0, from two slots.
const h0b = await vouch({ cv: c0, voucher: 0, j: 7 });
await addition("duplicate-voucher", "voucher 0 vouches twice, from slots 5 and 7", {
  cv: c0,
  vouches: [h0, h1, h0b],
  want: { error: "duplicate-voucher", vouch: 2 },
});
// Duplicate slot: voucher 4's slot 2 funds two vouchee proofs (3's and 2's).
const pooled2 = await vouch({ cv: c1, voucher: 2, slotVoucher: 4, j: 2 });
await addition(
  "duplicate-slot",
  "voucher 4's slot 2 funds two vouches: the vouchee nullifiers differ, the slot nullifiers don't",
  { cv: c1, vouches: [pooled, p1, pooled2], want: { error: "duplicate-slot", vouch: 2 } },
);
await addition("same-vouch-twice", "one vouch repeated: the vouchee duplicate is reported first", {
  cv: c0,
  vouches: [h0, h1, h0],
  want: { error: "duplicate-voucher", vouch: 2 },
});

// Any count but k is refused by the decoder's length rule (`decode` below).
const h3 = await vouch({ cv: c0, voucher: 3, j: 4 });
const countRecords = [
  ["two-vouches", "k − 1 vouches, framed consistently", encodeAddition(TIER1_GROUP, c0, [h0, h1])],
  [
    "four-vouches",
    "k + 1 valid vouches from four vouchers",
    encodeAddition(TIER1_GROUP, c0, [h0, h1, h2, h3]),
  ],
  ["no-vouches", "no vouch at all", encodeAddition(TIER1_GROUP, c0, [])],
];

// Vouches may name different blocks (and groups): each binds its own.
const late = await vouch({ cv: c1, voucher: 3, j: 8, rootBlock: ROOT_BLOCK + 100n });
await addition("mixed-root-blocks", "one vouch names a later root block than the other two", {
  cv: c1,
  vouches: [late, p1, p2],
  want: {},
});

// Slot out of range: proofs valid for S_12, refused by the range check alone.
const s12 = await vouch({ cv: c2, voucher: 3, j: L });
const c2a = await vouch({ cv: c2, voucher: 0, j: 1 });
const c2b = await vouch({ cv: c2, voucher: 1, j: 1 });
await addition(
  "slot-equals-L",
  "a vouch spends slot L = 12 with valid proofs: only the range check refuses it",
  {
    cv: c2,
    vouches: [c2a, c2b, s12],
    want: { error: "slot", vouch: 2 },
  },
);
const sMax = await vouch({ cv: c2, voucher: 4, j: 0xffff });
await addition("slot-max", "slot 65535 with valid proofs", {
  cv: c2,
  vouches: [sMax, c2a, c2b],
  want: { error: "slot", vouch: 0 },
});
const c2c = await vouch({ cv: c2, voucher: 2, j: 10 });
await addition(
  "honest-other-vouchee",
  "a second honest addition, sharing two vouchers with `honest`",
  {
    cv: c2,
    vouches: [c2a, c2b, c2c],
    want: {},
  },
);

// Forbidden commitments: valid proofs over them, refused first.
for (const [id, cv] of [
  ["forbidden-one", 1n],
  ["forbidden-zero-one", POSEIDON2_ZERO_ONE],
]) {
  const vs = [
    await vouch({ cv, voucher: 0, j: 6 }),
    await vouch({ cv, voucher: 1, j: 6 }),
    await vouch({ cv, voucher: 2, j: 6 }),
  ];
  await addition(
    id,
    `three valid vouches for the forbidden commitment ${cv === 1n ? "1" : "Poseidon2(0, 1)"}`,
    {
      cv,
      vouches: vs,
      want: { error: "forbidden-commitment" },
    },
  );
}

// Root 0: Semaphore's circuit outputs ρ = 0 for a proof length above the
// depth, for any secret, and snarkjs accepts such proofs. Only the root check
// refuses this vouch (docs/spec/membership.md, Statement).
async function forged(voucherIndex, scopeBytes, messageBytes) {
  const identity = vouchers[voucherIndex];
  const { proof, publicSignals } = await groth16.fullProve(
    {
      secret: identity.secretScalar,
      merkleProofLength: DEPTH + 1,
      merkleProofIndex: 0,
      merkleProofSiblings: Array(DEPTH).fill(0n),
      scope: F(scopeBytes),
      message: F(messageBytes),
    },
    art.wasm,
    art.zkey,
  );
  if (BigInt(publicSignals[0]) !== 0n) throw new Error("forged proof should output root 0");
  return proof;
}
{
  const sV = vouchScope(CTX, TIER1_GROUP, c0);
  const sJ = slotScope(CTX, 9);
  const nV = nullifierOf(4, sV);
  const nS = nullifierOf(4, sJ);
  const zero = {
    tier2GroupId: T2_GROUP,
    rootBlock: ROOT_BLOCK,
    root: 0n,
    slot: 9,
    voucheeNullifier: nV,
    slotNullifier: nS,
    voucheeProof: await forged(4, sV, message(CTX, 0, TIER1_GROUP, c0, T2_GROUP, ROOT_BLOCK, nS)),
    slotProof: await forged(4, sJ, message(CTX, 1, TIER1_GROUP, c0, T2_GROUP, ROOT_BLOCK, nV)),
  };
  await addition(
    "root-zero",
    "a vouch with forged proofs of root 0 (proof length 33), which snarkjs accepts",
    { cv: c0, vouches: [h0, zero, h2], want: { error: "root", vouch: 1 } },
  );
}

// Moved and rewritten vouches: every proof check recomputes the signals.
await addition("other-group", "the honest vouches submitted for another Tier 1 group", {
  groupId: TIER1_GROUP + 1n,
  cv: c0,
  vouches: honest,
  want: { error: "proof", vouch: 0, which: "vouchee" },
});
await addition("other-commitment", "the honest vouches submitted for another commitment", {
  cv: c2,
  vouches: honest,
  want: { error: "proof", vouch: 0, which: "vouchee" },
});
await addition("other-chain", "the honest record checked under another chain ID", {
  ctx: OTHER_CTX,
  cv: c0,
  vouches: honest,
  want: { error: "proof", vouch: 0, which: "vouchee" },
});
await addition(
  "swapped-slot-proofs",
  "vouches 0 and 1 exchange slot, slot nullifier and slot proof: each vouchee proof binds the other slot nullifier",
  {
    cv: c0,
    vouches: [
      { ...h0, slot: h1.slot, slotNullifier: h1.slotNullifier, slotProof: h1.slotProof },
      { ...h1, slot: h0.slot, slotNullifier: h0.slotNullifier, slotProof: h0.slotProof },
      h2,
    ],
    want: { error: "proof", vouch: 0, which: "vouchee" },
  },
);
await addition("other-slot", "a vouch claims slot 6 for a slot proof made for slot 0", {
  cv: c0,
  vouches: [h0, { ...h1, slot: 6 }, h2],
  want: { error: "proof", vouch: 1, which: "slot" },
});
await addition("other-root-block", "a vouch's root block rewritten (the root itself unchanged)", {
  cv: c0,
  vouches: [h0, h1, { ...h2, rootBlock: ROOT_BLOCK + 1n }],
  want: { error: "proof", vouch: 2, which: "vouchee" },
});
await addition("other-tier2-group", "a vouch's Tier 2 group rewritten", {
  cv: c0,
  vouches: [h0, h1, { ...h2, tier2GroupId: T2_GROUP + 1n }],
  want: { error: "proof", vouch: 2, which: "vouchee" },
});
await addition("proofs-exchanged", "a vouch's vouchee and slot proofs exchanged", {
  cv: c0,
  vouches: [h0, { ...h1, voucheeProof: h1.slotProof, slotProof: h1.voucheeProof }, h2],
  want: { error: "proof", vouch: 1, which: "vouchee" },
});
const P_A = h2.slotProof.pi_a;
await addition("tampered-slot-proof", "a slot proof's A negated", {
  cv: c0,
  vouches: [
    h0,
    h1,
    { ...h2, slotProof: { ...h2.slotProof, pi_a: [P_A[0], String(P - BigInt(P_A[1])), "1"] } },
  ],
  want: { error: "proof", vouch: 2, which: "slot" },
});
await addition("nullifier-plus-one", "a vouchee nullifier + 1 (still distinct)", {
  cv: c0,
  vouches: [h0, h1, { ...h2, voucheeNullifier: h2.voucheeNullifier + 1n }],
  want: { error: "proof", vouch: 2, which: "vouchee" },
});
// Root of another tree: proofs for t2's root don't verify under it.
await addition("other-root", "a vouch naming another nonzero root", {
  cv: c0,
  vouches: [h0, { ...h1, root: Z[DEPTH] }, h2],
  want: { error: "proof", vouch: 1, which: "vouchee" },
});

// --- Records every strict decoder refuses (docs/spec/vouching.md). ---
const good = encodeAddition(TIER1_GROUP, c0, honest);
const at = (record, offset, bytes) => {
  const out = Buffer.from(record);
  bytes.copy(out, offset);
  return out;
};
const V0 = 41; // first vouch
const decode = [
  { name: "empty", record: Buffer.alloc(0), error: "length" },
  { name: "header-only-short", record: good.subarray(0, 40), error: "length" },
  { name: "truncated", record: good.subarray(0, good.length - 1), error: "length" },
  { name: "trailing-byte", record: Buffer.concat([good, Buffer.from([0])]), error: "length" },
  { name: "count-says-four", record: at(good, 40, Buffer.from([4])), error: "length" },
  { name: "count-says-two", record: at(good, 40, Buffer.from([2])), error: "length" },
  { name: "commitment-r", record: at(good, 8, word(R)), error: "non-canonical", offset: 8 },
  { name: "root-r", record: at(good, V0 + 16, word(R)), error: "non-canonical", offset: V0 + 16 },
  {
    name: "vouchee-nullifier-max",
    record: at(good, V0 + 50, Buffer.alloc(32, 0xff)),
    error: "non-canonical",
    offset: V0 + 50,
  },
  {
    name: "slot-nullifier-r-plus-one",
    record: at(good, 626 + V0 + 82, word(R + 1n)),
    error: "non-canonical",
    offset: 626 + V0 + 82,
  },
  {
    name: "vouchee-proof-a-off-curve",
    record: at(good, V0 + 114, Buffer.concat([word(1n), word(1n)])),
    error: "non-canonical",
    offset: V0 + 114,
  },
  {
    name: "slot-proof-b-zero",
    record: at(good, 2 * 626 + V0 + 370 + 64, Buffer.alloc(128)),
    error: "non-canonical",
    offset: 2 * 626 + V0 + 370 + 64,
  },
  {
    name: "slot-proof-c-x-equals-p",
    record: at(good, V0 + 370 + 192, word(P)),
    error: "non-canonical",
    offset: V0 + 370 + 192,
  },
  ...countRecords.map(([name, note, record]) => ({ name, note, record, error: "length" })),
].map((d) => ({ ...d, record: d.record.toString("hex") }));
if (good.length !== 1919) throw new Error("addition length");

// --- Scopes and messages on their own, with Semaphore's field mapping. ---
const scopes = [
  ...[c0, c2].map((cv, i) => ({
    id: `vouchee-${i}`,
    kind: "vouchee",
    chainId: String(CHAIN_ID),
    registry: REGISTRY.toString("hex"),
    groupId: String(TIER1_GROUP),
    commitment: String(cv),
  })),
  ...[0, 11, 12, 0xffff].map((j) => ({
    id: `slot-${j}`,
    kind: "slot",
    chainId: String(CHAIN_ID),
    registry: REGISTRY.toString("hex"),
    slot: j,
  })),
  {
    id: "vouchee-other-group",
    kind: "vouchee",
    chainId: String(CHAIN_ID),
    registry: REGISTRY.toString("hex"),
    groupId: String(TIER1_GROUP + 1n),
    commitment: String(c0),
  },
  {
    id: "vouchee-other-registry",
    kind: "vouchee",
    chainId: String(CHAIN_ID),
    registry: OTHER_REGISTRY.toString("hex"),
    groupId: String(TIER1_GROUP),
    commitment: String(c0),
  },
  {
    id: "slot-0-other-registry",
    kind: "slot",
    chainId: String(CHAIN_ID),
    registry: OTHER_REGISTRY.toString("hex"),
    slot: 0,
  },
  {
    id: "slot-0-other-chain",
    kind: "slot",
    chainId: String(OTHER_CTX.chainId),
    registry: REGISTRY.toString("hex"),
    slot: 0,
  },
].map((s) => {
  const ctx = { chainId: BigInt(s.chainId), registry: Buffer.from(s.registry, "hex") };
  const bytes =
    s.kind === "vouchee"
      ? vouchScope(ctx, BigInt(s.groupId), BigInt(s.commitment))
      : slotScope(ctx, s.slot);
  return { ...s, scope: bytes.toString("hex"), scopeField: String(F(bytes)) };
});
const messages = [0, 1].map((role) => {
  const other = role === 0 ? h0.slotNullifier : h0.voucheeNullifier;
  const bytes = message(CTX, role, TIER1_GROUP, c0, T2_GROUP, ROOT_BLOCK, other);
  return {
    id: role === 0 ? "vouchee-message" : "slot-message",
    role,
    chainId: String(CHAIN_ID),
    registry: REGISTRY.toString("hex"),
    groupId: String(TIER1_GROUP),
    commitment: String(c0),
    tier2GroupId: String(T2_GROUP),
    rootBlock: String(ROOT_BLOCK),
    otherNullifier: String(other),
    message: bytes.toString("hex"),
    messageField: String(F(bytes)),
  };
});

const out = {
  format: "abolish-vouch-vectors/1",
  spec: "docs/spec/vouching.md",
  generator: "packages/crypto/scripts/vouch-vectors.mjs",
  source: {
    semaphore: "semaphore-protocol/semaphore v4.14.3 (4dbc39b83a4066bf5084fd7f5d336202aad2f815)",
    artifacts: Object.fromEntries(
      Object.entries(ARTIFACTS).map(([name, sha]) => [
        name,
        { url: `https://snark-artifacts.pse.dev/semaphore/4.13.0/${name}`, sha256: sha },
      ]),
    ),
  },
  parameters: { k: K, slots: L },
  context: { chainId: String(CHAIN_ID), registry: REGISTRY.toString("hex") },
  tier2: {
    groupId: String(T2_GROUP),
    rootBlock: String(ROOT_BLOCK),
    leaves: tier2Leaves.map(String),
    root: String(t2.root),
  },
  scopes,
  messages,
  additions,
  decode,
};
writeFileSync(join(outDir, "vouch.json"), `${JSON.stringify(out, null, 2)}\n`);
// --- Counting across the deployment (docs/spec/vouching.md). ---
// Each case is a group registry's whole event sequence: groups created,
// Tier 2 additions signed by the registrars, and Tier 1 additions. The
// expected verdicts are written by hand; `replay` below is this script's own
// reading of the counting rule, and every case must agree with it.

const INTERVAL = 1800n;
const WINDOW = 302_400n;
const GRID = INTERVAL * 700n; // a block on the root grid
const GRID2 = GRID + INTERVAL; // the next one

// Three fixed test registrars, in ascending address order; threshold 2.
const registrars = [1, 2, 3]
  .map(
    (i) =>
      new Wallet(`0x${sha256(Buffer.from(`abolish vouch-count registrar ${i}`)).toString("hex")}`),
  )
  .sort((a, b) => (a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1));
const THRESHOLD = 2;
const DOMAIN = {
  name: "Abolish group registry",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: `0x${REGISTRY.toString("hex")}`,
};
const ADD_TYPES = {
  AddMembers: [
    { name: "groupId", type: "uint64" },
    { name: "tier", type: "uint8" },
    { name: "firstIndex", type: "uint64" },
    { name: "commitments", type: "uint256[]" },
  ],
};
const signed = (digest, seats) =>
  Buffer.concat([
    Buffer.from([seats.length]),
    ...seats.map((seat) => {
      const sig = registrars[seat - 1].signingKey.sign(digest);
      return Buffer.concat([
        Buffer.from([seat]),
        Buffer.from(sig.r.slice(2), "hex"),
        Buffer.from(sig.s.slice(2), "hex"),
        Buffer.from([sig.v]),
      ]);
    }),
  ]);
// An `addMembers` record of a Tier 2 group (docs/spec/contracts.md, Group registry).
const addRecord = (groupId, firstIndex, commitments) =>
  Buffer.concat([
    uint(groupId, 8),
    uint(firstIndex, 8),
    uint(commitments.length, 2),
    ...commitments.map(word),
    signed(
      TypedDataEncoder.hash(DOMAIN, ADD_TYPES, { groupId, tier: 2, firstIndex, commitments }),
      [1, 2],
    ),
  ]);

// This script's strict replay of one Tier 2 addition record, for the
// generator's own check: null if it applies, else the reason.
function applyAdd(record, groupId, leaves) {
  const count = record.readUInt16BE(16);
  const approvalsAt = 18 + 32 * count;
  if (
    record.length < approvalsAt + 1 ||
    record.length !== approvalsAt + 1 + 66 * record[approvalsAt]
  )
    return "length";
  if (count < 1 || count > 256) return "batch";
  const commitments = Array.from({ length: count }, (_, i) =>
    big(record.subarray(18 + 32 * i, 50 + 32 * i)),
  );
  if (commitments.some((c) => c < 2n || c >= R || c === POSEIDON2_ZERO_ONE))
    return "forbidden-commitment";
  if (big(record.subarray(0, 8)) !== groupId) return "group";
  const firstIndex = big(record.subarray(8, 16));
  const digest = TypedDataEncoder.hash(DOMAIN, ADD_TYPES, {
    groupId,
    tier: 2,
    firstIndex,
    commitments,
  });
  const n = record[approvalsAt];
  if (n < THRESHOLD) return "approvals";
  let last = 0;
  for (let i = 0; i < n; i++) {
    const a = record.subarray(approvalsAt + 1 + 66 * i);
    const seat = a[0];
    if (seat <= last || seat > registrars.length) return "seat";
    last = seat;
    const signer = recoverAddress(digest, {
      r: `0x${a.subarray(1, 33).toString("hex")}`,
      s: `0x${a.subarray(33, 65).toString("hex")}`,
      v: a[65],
    });
    if (signer !== registrars[seat - 1].address) return "signature";
  }
  if (firstIndex !== BigInt(leaves.length)) return "position";
  leaves.push(...commitments);
  return null;
}

// This script's reading of the counting rule over a case's events.
async function replay(events) {
  const groups = new Map();
  let broken = null;
  const brk = (b) => {
    if (broken === null || b.at < broken.at) broken = b;
  };
  events.forEach((e, at) => {
    if (e.kind !== "group-created") return;
    if (groups.has(e.groupId))
      brk({ at, block: e.block, groupId: e.groupId, reason: "duplicate-group" });
    else groups.set(e.groupId, { at, block: e.block, tier: e.tier });
  });
  // Each Tier 2 group's leaves after each of its records, until one breaks.
  const history = new Map();
  for (const [groupId, g] of groups) {
    if (g.tier !== 2) continue;
    const leaves = [];
    const steps = [];
    for (const [at, e] of events.entries()) {
      if (e.kind !== "members-added" || e.groupId !== groupId) continue;
      const reason = at < g.at ? "created" : applyAdd(e.record, groupId, leaves);
      if (reason !== null) {
        brk({ at, block: e.block, groupId, reason });
        break;
      }
      steps.push({ block: e.block, leaves: leaves.slice() });
    }
    history.set(groupId, steps);
  }
  const rootAt = (groupId, block) =>
    tree((history.get(groupId) ?? []).filter((s) => s.block <= block).at(-1)?.leaves ?? []).root;

  const spent = new Set();
  const members = new Map();
  const additions = [];
  for (const [at, e] of events.entries()) {
    if (e.kind !== "tier1-addition") continue;
    if (broken !== null && e.block >= broken.block) break;
    const verdict = await judge(at, e);
    additions.push({ at, block: String(e.block), ...verdict });
  }
  async function judge(at, e) {
    if (e.raw !== undefined) return { valid: false, error: "decode" };
    const { groupId, cv, vouches } = e;
    // Checks 1 to 7 of one addition; the proofs' verdict is kept for last.
    const one = await expected(CTX, groupId, cv, vouches);
    if (one.error !== undefined && one.error !== "proof") return { valid: false, ...one };
    const fail = (error, vouch) => ({
      valid: false,
      error,
      ...(vouch === undefined ? {} : { vouch }),
    });
    const g = groups.get(groupId);
    if (g?.tier !== 1 || g.at > at) return fail("group");
    for (const [i, v] of vouches.entries())
      if (v.rootBlock % INTERVAL !== 0n) return fail("root-grid", i);
    for (const [i, v] of vouches.entries())
      if (v.rootBlock > e.block || e.block - v.rootBlock > WINDOW) return fail("root-window", i);
    for (const [i, v] of vouches.entries()) {
      const t = groups.get(v.tier2GroupId);
      if (t?.tier !== 2 || t.block > v.rootBlock) return fail("tier2-group", i);
    }
    for (const [i, v] of vouches.entries())
      if (v.root !== rootAt(v.tier2GroupId, v.rootBlock)) return fail("root-mismatch", i);
    const reused = vouches.findIndex((v) => spent.has(v.slotNullifier));
    if (reused >= 0) return fail("slot-spent", reused);
    const own = members.get(groupId) ?? { cvs: [], blocks: [] };
    if (own.cvs.includes(cv)) return fail("member");
    if (one.error === "proof") return { valid: false, ...one };
    for (const v of vouches) spent.add(v.slotNullifier);
    own.cvs.push(cv);
    own.blocks.push(e.block);
    members.set(groupId, own);
    return { valid: true, index: own.cvs.length - 1 };
  }
  const leavesAt = (groupId, block) => {
    if (broken !== null && broken.block <= block) return { error: "group-history" };
    const own = members.get(groupId) ?? { cvs: [], blocks: [] };
    return { leaves: own.cvs.filter((_, i) => own.blocks[i] <= block).map(String) };
  };
  return { additions, broken, members, leavesAt };
}

const c3 = vouchees[3];
const t2b = tree(vouchers.map((v) => v.commitment)); // group 7 after voucher 5 joins
const t8 = tree(vouchers.slice(0, 2).map((v) => v.commitment)); // group 8
const at9 = (o) => vouch({ groupId: TIER1_GROUP, rootBlock: GRID, ...o });
const tamperSlot = (v) => {
  const a = v.slotProof.pi_a;
  return { ...v, slotProof: { ...v.slotProof, pi_a: [a[0], String(P - BigInt(a[1])), "1"] } };
};

// Group 9's first counted addition, and its re-randomised copy.
const a1 = [
  await at9({ cv: c0, voucher: 0, j: 5 }),
  await at9({ cv: c0, voucher: 1, j: 0 }),
  await at9({ cv: c0, voucher: 2, j: 11 }),
];
const a1r = a1.map((v, i) => ({
  ...v,
  voucheeProof: rerandomise(v.voucheeProof, 0x9a1n + BigInt(i)),
  slotProof: rerandomise(v.slotProof, 0x9b1n + BigInt(i)),
}));
const a3 = [
  await at9({ cv: c0, voucher: 3, j: 1 }),
  await at9({ cv: c0, voucher: 4, j: 2 }),
  await at9({ cv: c0, voucher: 0, j: 3 }),
];
const a4 = [
  await at9({ cv: c2, voucher: 3, j: 6 }),
  await at9({ cv: c2, voucher: 0, j: 5 }),
  await at9({ cv: c2, voucher: 1, j: 1 }),
];
const a5 = [
  await at9({ cv: c1, voucher: 3, slotVoucher: 4, j: 2 }),
  await at9({ cv: c1, voucher: 0, j: 3 }),
  await at9({ cv: c1, voucher: 1, j: 3 }),
];
const at10 = (o) => vouch({ groupId: 10n, rootBlock: GRID, ...o });
const a6 = [
  await at10({ cv: c0, voucher: 2, j: 7 }),
  await at10({ cv: c0, voucher: 3, j: 4 }),
  await at10({ cv: c0, voucher: 4, j: 9 }),
];
const a7 = [
  await at10({ cv: c2, voucher: 1, j: 0 }),
  await at10({ cv: c2, voucher: 2, j: 8 }),
  await at10({ cv: c2, voucher: 3, j: 5 }),
];
const inGroup = async (groupId) => [
  await vouch({ groupId, rootBlock: GRID, cv: c2, voucher: 0, j: 6 }),
  await vouch({ groupId, rootBlock: GRID, cv: c2, voucher: 1, j: 6 }),
  await vouch({ groupId, rootBlock: GRID, cv: c2, voucher: 2, j: 6 }),
];
const a8 = await inGroup(3n);
const a9 = await inGroup(11n);
const at12 = (o) => vouch({ groupId: 12n, rootBlock: GRID, ...o });
const a10 = [
  await at12({ cv: c2, voucher: 2, j: 10 }),
  await at12({ cv: c2, voucher: 3, j: 7 }),
  await at12({ cv: c2, voucher: 4, j: 10 }),
];
// Vouches for c2 in group 9 that each break one check.
const v08 = await at9({ cv: c2, voucher: 0, j: 8 });
const v18 = await at9({ cv: c2, voucher: 1, j: 8 });
const v29 = await at9({ cv: c2, voucher: 2, j: 9 });
const offGrid = await at9({ cv: c2, voucher: 1, j: 8, rootBlock: GRID + 1n });
const v18late = await at9({ cv: c2, voucher: 1, j: 8, rootBlock: GRID2, t: t2b });
const tier0Root = await at9({ cv: c2, voucher: 1, j: 8, tier2GroupId: 3n });
const lateGroup = await at9({ cv: c2, voucher: 0, j: 8, tier2GroupId: 13n });
const otherGroupRoot = await at9({ cv: c2, voucher: 1, j: 8, tier2GroupId: 8n });
const staleRoot = await at9({ cv: c2, voucher: 0, j: 8, rootBlock: GRID2 });
const v08late = await at9({ cv: c2, voucher: 0, j: 8, rootBlock: GRID2, t: t2b });
const v29late = await at9({ cv: c2, voucher: 2, j: 9, rootBlock: GRID2, t: t2b });
const a23 = [
  await at9({ cv: c3, voucher: 5, j: 0, rootBlock: GRID2, t: t2b }),
  await at9({ cv: c3, voucher: 3, j: 8, rootBlock: GRID2, t: t2b }),
  await at9({ cv: c3, voucher: 4, j: 11, rootBlock: GRID2, t: t2b }),
];
const a24 = [
  await at10({ cv: c1, voucher: 0, j: 9 }),
  await at10({ cv: c1, voucher: 1, j: 9 }),
  await at10({ cv: c1, voucher: 2, j: 2 }),
];
const a25 = [
  await at10({ cv: c3, voucher: 3, j: 9 }),
  await at10({ cv: c3, voucher: 4, j: 5 }),
  await at10({ cv: c3, voucher: 5, j: 3, t: t2b, rootBlock: GRID2 }),
];
if (t8.root === t2.root) throw new Error("group 8's root must differ");

const created = (groupId, tier, block) => ({ kind: "group-created", block, groupId, tier });
const added = (groupId, block, record) => ({ kind: "members-added", block, groupId, record });
const t1 = (block, groupId, cv, vouches, note) => ({
  kind: "tier1-addition",
  block,
  groupId,
  cv,
  vouches,
  note,
});
const prefix = [
  created(T2_GROUP, 2, 1_000_000n),
  created(TIER1_GROUP, 1, 1_000_000n),
  added(T2_GROUP, 1_100_000n, addRecord(T2_GROUP, 0n, tier2Leaves)),
];
const fifth = vouchers[5].commitment;
const truncated = encodeAddition(TIER1_GROUP, c2, a4).subarray(0, 1918);

const countCases = [
  {
    id: "deployment",
    description:
      "Two Tier 2 groups and three Tier 1 groups: counted additions, every counting check refusing one, failures consuming nothing, and the window's edge",
    events: [
      ...prefix,
      created(3n, 0, 1_100_000n),
      // A Tier 0 group's records are no part of Tier 1 counting, however malformed.
      added(3n, 1_100_000n, Buffer.from("dead", "hex")),
      created(8n, 2, 1_100_000n),
      added(
        8n,
        1_100_001n,
        addRecord(
          8n,
          0n,
          vouchers.slice(0, 2).map((v) => v.commitment),
        ),
      ),
      created(10n, 1, 1_200_000n),
      created(13n, 2, GRID + 10n),
      added(T2_GROUP, GRID + 50n, addRecord(T2_GROUP, 5n, [fifth])),
      t1(GRID + 100n, TIER1_GROUP, c0, a1, "counted: leaf 0 of group 9"),
      t1(
        GRID + 110n,
        TIER1_GROUP,
        c0,
        a1r,
        "the first addition re-randomised: its slots are spent",
      ),
      t1(GRID + 120n, TIER1_GROUP, c0, a3, "a fresh vouch set for a counted commitment"),
      t1(GRID + 130n, TIER1_GROUP, c2, a4, "the second vouch reuses voucher 0's slot 5"),
      t1(
        GRID + 140n,
        TIER1_GROUP,
        c1,
        a5,
        "counted: leaf 1, a pooled vouch among its three, on slots the member addition left unspent",
      ),
      t1(
        GRID + 150n,
        10n,
        c0,
        a6,
        "counted: leaf 0 of group 10, a commitment group 9 already holds",
      ),
      t1(
        GRID + 160n,
        10n,
        c2,
        a7,
        "slots are deployment-wide: voucher 1's slot 0 was spent in group 9",
      ),
      t1(GRID + 170n, 3n, c2, a8, "group 3 is a Tier 0 group"),
      t1(GRID + 180n, 11n, c2, a9, "group 11 was never created"),
      t1(GRID + 190n, 12n, c2, a10, "group 12 is created only after this addition"),
      created(12n, 1, GRID + 200n),
      t1(GRID + 210n, 12n, c2, a10, "the same record once group 12 exists: counted, leaf 0"),
      t1(
        GRID + 220n,
        TIER1_GROUP,
        c2,
        [v08, offGrid, v29],
        "the second vouch's root block is off the grid",
      ),
      t1(
        GRID + 230n,
        TIER1_GROUP,
        c2,
        [v08, v18late, v29],
        "the second vouch names a root block after the addition's own",
      ),
      t1(
        GRID + 240n,
        TIER1_GROUP,
        c2,
        [v08, tier0Root, v29],
        "the second vouch names Tier 0 group 3",
      ),
      t1(
        GRID + 250n,
        TIER1_GROUP,
        c2,
        [lateGroup, v18, v29],
        "the first vouch names Tier 2 group 13, created after its root block",
      ),
      t1(
        GRID + 260n,
        TIER1_GROUP,
        c2,
        [v08, otherGroupRoot, v29],
        "the second vouch names group 8 with group 7's root",
      ),
      t1(
        GRID2 + 10n,
        TIER1_GROUP,
        c2,
        [staleRoot, v18late, v29late],
        "the first vouch names group 7 at the next grid block with the root before voucher 5 joined",
      ),
      t1(
        GRID2 + 20n,
        TIER1_GROUP,
        c2,
        [v08late, v18late, tamperSlot(v29late)],
        "the third vouch's slot proof is broken",
      ),
      t1(
        GRID2 + 30n,
        TIER1_GROUP,
        c2,
        [v08late, v18late, v29late],
        "counted: leaf 2, on slots every refused addition before left unspent",
      ),
      {
        kind: "tier1-addition",
        block: GRID2 + 40n,
        raw: truncated,
        note: "a record one byte short",
      },
      t1(GRID2 + 50n, TIER1_GROUP, c1, [a5[1], a5[2], a5[1]], "one vouch twice"),
      t1(
        GRID2 + 60n,
        TIER1_GROUP,
        c3,
        a23,
        "counted: leaf 3, vouched by voucher 5, who joined Tier 2 after the first grid block",
      ),
      t1(
        GRID + WINDOW,
        10n,
        c1,
        a24,
        "counted: leaf 1 of group 10, exactly W blocks after its root block",
      ),
      t1(GRID + WINDOW + 1n, 10n, c3, a25, "the first vouch's root block is W + 1 blocks back"),
    ],
    want: [
      { valid: true, index: 0 },
      { error: "slot-spent", vouch: 0 },
      { error: "member" },
      { error: "slot-spent", vouch: 1 },
      { valid: true, index: 1 },
      { valid: true, index: 0 },
      { error: "slot-spent", vouch: 0 },
      { error: "group" },
      { error: "group" },
      { error: "group" },
      { valid: true, index: 0 },
      { error: "root-grid", vouch: 1 },
      { error: "root-window", vouch: 1 },
      { error: "tier2-group", vouch: 1 },
      { error: "tier2-group", vouch: 0 },
      { error: "root-mismatch", vouch: 1 },
      { error: "root-mismatch", vouch: 0 },
      { error: "proof", vouch: 2, which: "slot" },
      { valid: true, index: 2 },
      { error: "decode" },
      { error: "duplicate-voucher", vouch: 2 },
      { valid: true, index: 3 },
      { valid: true, index: 1 },
      { error: "root-window", vouch: 0 },
    ],
    leaves: [
      [TIER1_GROUP, GRID + 99n],
      [TIER1_GROUP, GRID + 100n],
      [TIER1_GROUP, GRID + 139n],
      [TIER1_GROUP, GRID + 140n],
      [TIER1_GROUP, GRID2 + 60n],
      [10n, GRID + WINDOW + 1n],
      [12n, GRID + 210n],
      [11n, GRID + WINDOW + 1n],
    ],
  },
  {
    id: "broken-tier2",
    description:
      "A Tier 2 record whose signed position disagrees with the replay's count breaks Tier 1 from its block on, even for an addition logged before it in that block",
    events: [
      ...prefix,
      t1(GRID + 100n, TIER1_GROUP, c0, a1, "counted: before b_R"),
      t1(
        GRID + 150n,
        TIER1_GROUP,
        c1,
        a5,
        "undecided: in b_R's block, though logged before the breaking record",
      ),
      added(T2_GROUP, GRID + 150n, addRecord(T2_GROUP, 9n, [fifth])),
      t1(GRID + 200n, TIER1_GROUP, c2, a4, "undecided: after b_R"),
    ],
    want: [{ valid: true, index: 0 }],
    leaves: [
      [TIER1_GROUP, GRID + 149n],
      [TIER1_GROUP, GRID + 150n],
    ],
  },
  {
    id: "duplicate-group",
    description: "A second GroupCreated for a group breaks Tier 1 from its block on",
    events: [
      ...prefix,
      t1(GRID + 100n, TIER1_GROUP, c0, a1, "counted: before the repeat"),
      created(T2_GROUP, 0, GRID + 120n),
      t1(GRID + 130n, TIER1_GROUP, c1, a5, "undecided"),
    ],
    want: [{ valid: true, index: 0 }],
    leaves: [
      [TIER1_GROUP, GRID + 119n],
      [TIER1_GROUP, GRID + 120n],
    ],
  },
  {
    id: "created-after-records",
    description:
      "A Tier 2 group's record logged before its GroupCreated breaks Tier 1 from its block on",
    events: [
      created(TIER1_GROUP, 1, 1_000_000n),
      added(T2_GROUP, 1_000_000n, addRecord(T2_GROUP, 0n, tier2Leaves)),
      created(T2_GROUP, 2, 1_000_001n),
      t1(GRID + 100n, TIER1_GROUP, c0, a1, "undecided"),
    ],
    want: [],
    leaves: [
      [TIER1_GROUP, 999_999n],
      [TIER1_GROUP, 1_000_000n],
    ],
  },
];

const encodeEvent = (e) => {
  if (e.kind === "group-created")
    return { kind: e.kind, block: String(e.block), groupId: String(e.groupId), tier: e.tier };
  if (e.kind === "members-added")
    return {
      kind: e.kind,
      block: String(e.block),
      groupId: String(e.groupId),
      record: e.record.toString("hex"),
    };
  return {
    kind: e.kind,
    block: String(e.block),
    record: (e.raw ?? encodeAddition(e.groupId, e.cv, e.vouches)).toString("hex"),
    note: e.note,
  };
};
const counting = [];
for (const c of countCases) {
  const got = await replay(c.events);
  const verdicts = got.additions.map(({ at: _at, block: _block, ...v }) => v);
  const want = c.want.map((w) => (w.valid ? w : { valid: false, ...w }));
  if (JSON.stringify(verdicts) !== JSON.stringify(want))
    throw new Error(
      `${c.id}: expected ${JSON.stringify(want)}, the replay gives ${JSON.stringify(verdicts)}`,
    );
  counting.push({
    id: c.id,
    description: c.description,
    events: c.events.map(encodeEvent),
    additions: got.additions,
    broken:
      got.broken === null
        ? null
        : {
            at: got.broken.at,
            block: String(got.broken.block),
            groupId: String(got.broken.groupId),
            reason: got.broken.reason,
          },
    leaves: c.leaves.map(([groupId, block]) => ({
      groupId: String(groupId),
      block: String(block),
      ...got.leavesAt(groupId, block),
    })),
  });
}
writeFileSync(
  join(outDir, "vouch-count.json"),
  `${JSON.stringify(
    {
      format: "abolish-vouch-count-vectors/1",
      spec: "docs/spec/vouching.md",
      generator: "packages/crypto/scripts/vouch-vectors.mjs",
      parameters: { k: K, slots: L, rootInterval: String(INTERVAL), rootWindow: String(WINDOW) },
      context: {
        chainId: String(CHAIN_ID),
        registry: REGISTRY.toString("hex"),
        registrars: registrars.map((w) => w.address.slice(2).toLowerCase()),
        threshold: THRESHOLD,
      },
      cases: counting,
    },
    null,
    2,
  )}\n`,
);
console.log(`${counting.length} counting cases`);
await curve.terminate();
console.log(`${additions.length} additions, ${decode.length} decode cases`);
// Semaphore's prover leaves worker threads behind.
exit(0);
