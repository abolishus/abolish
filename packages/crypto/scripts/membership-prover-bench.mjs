// Measurements behind ADR 0009's Amendment (P2-21 part 1): which Groth16
// prover the ballot client runs for docs/spec/membership.md's proofs. Nothing
// here is built into a package; it is the prototype the ADR's numbers come
// from, kept so anyone can rerun them.
//
// It times, over Semaphore's depth-32 artifacts:
//   - snarkjs 0.7.5's `groth16.fullProve`, single-threaded (the only mode the
//     ballot client's CSP allows: the multi-threaded one starts workers from
//     blob: URLs) and multi-threaded, in Node;
//   - the same proof on Chromium's main thread under CPU throttling (DevTools'
//     throttling doesn't reach dedicated workers, so the main thread stands in
//     for the client's worker), with a CSP of the shape the ADR proposes;
//   - the multi-scalar multiplications and FFTs a Groth16 prover over
//     @noble/curves' BN254 would need for this key's sizes, as a lower bound on
//     that candidate (its witness computation would come on top);
//   - re-randomising a snarkjs proof with @noble/curves and CSPRNG scalars
//     (A/t, t·B + t·u·δ, C + u·A), checked with snarkjs's verifier.
//
// It runs outside the workspace, because packages/crypto depends on @noble/*
// only. In an empty directory:
//
//   vp add snarkjs@0.7.5 @semaphore-protocol/core@4.14.3 poseidon-lite@0.3.0 @noble/curves@2.4.0 playwright@1.63.0
//   curl -O https://snark-artifacts.pse.dev/semaphore/4.13.0/semaphore-32.{wasm,zkey}
//   vp node membership-prover-bench.mjs <artifacts-dir> [chromium-throttling-rates...]
//
// for example `vp node membership-prover-bench.mjs . 1 4 6`. Rates need
// Playwright's Chromium (PLAYWRIGHT_BROWSERS_PATH, or CHROMIUM naming the binary).

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { argv, exit, memoryUsage } from "node:process";
import { pippenger } from "@noble/curves/abstract/curve.js";
import { bn254 } from "@noble/curves/bn254.js";
import { Identity } from "@semaphore-protocol/core";
import { poseidon2 } from "poseidon-lite";
import { groth16, zKey } from "snarkjs";

const [dir, ...rates] = argv.slice(2);
if (dir === undefined) throw new Error("usage: <artifacts-dir> [chromium-throttling-rates...]");

const ARTIFACTS = {
  "semaphore-32.wasm": "528333d1247f585d33c5a40f46053fb7f8b1f5b8b8fa29118abfc47a60921dc5",
  "semaphore-32.zkey": "2e5f7a9f880c337134ee4c7fc4e53573813b4c9c6ae46221c0b56e7992304650",
};
const bytes = {};
for (const [name, want] of Object.entries(ARTIFACTS)) {
  bytes[name] = new Uint8Array(readFileSync(join(dir, name)));
  const got = createHash("sha256").update(bytes[name]).digest("hex");
  if (got !== want) throw new Error(`${name}: sha256 ${got}, expected ${want}`);
}
const wasm = bytes["semaphore-32.wasm"];
const zkey = bytes["semaphore-32.zkey"];
const vk = await zKey.exportVerificationKey(zkey);

// One member at index 0 of an otherwise empty depth-32 tier tree: proving
// cost doesn't depend on the tree, since the circuit always hashes 32 levels.
const Z = [0n];
for (let i = 0; i < 32; i++) Z.push(poseidon2([Z[i], Z[i]]));
const input = {
  secret: new Identity("membership-prover-bench").secretScalar,
  merkleProofLength: 32,
  merkleProofIndex: 0,
  merkleProofSiblings: Z.slice(0, 32),
  message: 1n,
  scope: 2n,
};

const RUNS = 5;
const report = {};
let last;
for (const singleThread of [true, false]) {
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    last = await groth16.fullProve(input, wasm, zkey, undefined, undefined, { singleThread });
    ms.push(Math.round(performance.now() - t0));
    if (!(await groth16.verify(vk, last.publicSignals, last.proof)))
      throw new Error("snarkjs made a proof its own verifier rejects");
  }
  report[singleThread ? "nodeSingleThreadMs" : "nodeMultiThreadMs"] = ms;
}
report.nodeRssMiB = Math.round(memoryUsage().rss / 2 ** 20);

// --- Re-randomisation over @noble/curves, scalars from the CSPRNG. ---
const { Fp2 } = bn254.fields;
const R = bn254.fields.Fr.ORDER;
const G1 = bn254.G1.Point;
const G2 = bn254.G2.Point;
const scalar = () => {
  for (;;) {
    const k = BigInt(`0x${randomBytes(32).toString("hex")}`);
    if (k !== 0n && k < R) return k;
  }
};
const g1 = ([x, y]) => G1.fromAffine({ x: BigInt(x), y: BigInt(y) });
const g2 = ([[x0, x1], [y0, y1]]) =>
  G2.fromAffine({
    x: Fp2.create({ c0: BigInt(x0), c1: BigInt(x1) }),
    y: Fp2.create({ c0: BigInt(y0), c1: BigInt(y1) }),
  });
const g1Json = (P) => {
  const { x, y } = P.toAffine();
  return [x.toString(), y.toString(), "1"];
};
const g2Json = (P) => {
  const { x, y } = P.toAffine();
  return [
    [x.c0.toString(), x.c1.toString()],
    [y.c0.toString(), y.c1.toString()],
    ["1", "0"],
  ];
};
const t0 = performance.now();
const t = scalar();
const u = scalar();
const A = g1(last.proof.pi_a);
const rerandomised = {
  ...last.proof,
  pi_a: g1Json(A.multiply(bn254.fields.Fr.inv(t))),
  pi_b: g2Json(g2(last.proof.pi_b).add(g2(vk.vk_delta_2).multiply(u)).multiply(t)),
  pi_c: g1Json(g1(last.proof.pi_c).add(A.multiply(u))),
};
report.rerandomiseMs = Math.round(performance.now() - t0);
if (!(await groth16.verify(vk, last.publicSignals, rerandomised)))
  throw new Error("the re-randomised proof doesn't verify");

// --- A lower bound on a Groth16 prover over @noble/curves. ---
// Sizes from the zkey's header: 9,418 wires (4 public), domain 2^14.
const WIRES = 9418;
const DOMAIN = 16384;
const msm = (Point, n) => {
  const points = [];
  for (let i = 0, P = Point.BASE; i < n; i++, P = P.add(Point.BASE)) points.push(P);
  const scalars = Array.from({ length: n }, scalar);
  const s = performance.now();
  pippenger(Point, points, scalars);
  return performance.now() - s;
};
const { Fr } = bn254.fields;
const ntt = (a, w) => {
  const x = a.slice();
  for (let len = 2; len <= x.length; len <<= 1) {
    const wl = Fr.pow(w, BigInt(x.length / len));
    for (let i = 0; i < x.length; i += len) {
      let ww = 1n;
      for (let j = 0; j < len / 2; j++) {
        const p = x[i + j];
        const q = Fr.mul(x[i + j + len / 2], ww);
        x[i + j] = Fr.add(p, q);
        x[i + j + len / 2] = Fr.sub(p, q);
        ww = Fr.mul(ww, wl);
      }
    }
  }
  return x;
};
const msmMs = [WIRES, WIRES, WIRES - 5, DOMAIN].map((n) => msm(G1, n)).concat(msm(G2, WIRES));
const coeffs = Array.from({ length: DOMAIN }, scalar);
const w = Fr.pow(5n, (R - 1n) / BigInt(DOMAIN));
const f0 = performance.now();
for (let i = 0; i < 6; i++) ntt(coeffs, w); // three inverse and three coset transforms
report.nobleLowerBoundMs = Math.round(msmMs.reduce((s, v) => s + v, 0) + performance.now() - f0);

// --- Chromium, throttled. ---
if (rates.length > 0) {
  const require = createRequire(import.meta.url);
  const { chromium } = require("playwright");
  const CSP =
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
  // snarkjs's own browser build: `require.resolve("snarkjs")` is build/main.cjs.
  const snarkjsBrowser = readFileSync(join(dirname(require.resolve("snarkjs")), "snarkjs.min.js"));
  const page = `<!doctype html><meta charset="utf-8"><script src="snarkjs.js"></script><script src="bench.js"></script>`;
  const bench = `window.result = (async () => {
    const zkey = new Uint8Array(await (await fetch("semaphore-32.zkey")).arrayBuffer());
    const wasm = new Uint8Array(await (await fetch("semaphore-32.wasm")).arrayBuffer());
    const input = ${JSON.stringify(input, (_, v) => (typeof v === "bigint" ? v.toString() : v))};
    const ms = [];
    let last;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      last = await snarkjs.groth16.fullProve(input, wasm, zkey, undefined, undefined, { singleThread: true });
      ms.push(Math.round(performance.now() - t0));
    }
    return { ms, last };
  })();`;
  const files = {
    "/": ["text/html", page],
    "/snarkjs.js": ["text/javascript", snarkjsBrowser],
    "/bench.js": ["text/javascript", bench],
    "/semaphore-32.zkey": ["application/octet-stream", zkey],
    "/semaphore-32.wasm": ["application/wasm", wasm],
  };
  const server = createServer((q, s) => {
    const f = files[q.url];
    if (f === undefined) return s.writeHead(404).end();
    s.writeHead(200, { "content-type": f[0], "content-security-policy": CSP }).end(f[1]);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const browser = await chromium.launch(
    process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {},
  );
  report.chromium = {};
  for (const rate of rates.map(Number)) {
    const tab = await browser.newPage();
    const violations = [];
    tab.on("console", (m) => violations.push(m.text()));
    const cdp = await tab.context().newCDPSession(tab);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await tab.goto(`http://127.0.0.1:${server.address().port}/`);
    const { ms, last: proved } = await tab.evaluate(() => window.result);
    if (!(await groth16.verify(vk, proved.publicSignals, proved.proof)))
      throw new Error(`Chromium at ${rate}×: the proof doesn't verify`);
    report.chromium[`${rate}x`] = { ms, console: violations };
    await tab.close();
  }
  await browser.close();
  server.close();
}

console.log(JSON.stringify(report, null, 2));
exit(0);
