// Independent generator for docs/spec/vectors/content-addressing.json: each
// object's CID and CAR from two independent IPFS implementations, Kubo (Go,
// boxo's balanced importer and `ipfs dag export`) and ipfs-unixfs-importer
// (JavaScript, with @ipld/car), set to docs/spec/content-addressing.md's
// parameters, and refused unless both agree byte for byte. It shares no code
// with packages/crypto.
//
// It runs outside the workspace, because packages/crypto depends on @noble/*
// only. In an empty directory holding a package.json of `{"type": "module"}`,
// with a copy of this script (bare imports resolve from the script's own
// directory):
//
//   vp add ipfs-unixfs-importer@17.1.1 @ipld/car@5.4.7 @ipld/dag-pb@4.1.5 blockstore-core@7.0.1 multiformats@14.0.5
//   curl -LO https://github.com/ipfs/kubo/releases/download/v0.36.0/kubo_v0.36.0_linux-amd64.tar.gz
//   tar xzf kubo_v0.36.0_linux-amd64.tar.gz
//   vp node content-addressing-vectors.mjs <the tarball> kubo/ipfs <work-dir> <out.json>
//
// The script refuses a tarball whose sha512 isn't KUBO_SHA512 below, the
// published one for that release.
//
// Objects are deterministic: `object(label, length)` is SHA-256(label ‖
// u32be(i)) for i = 0, 1, … concatenated and cut to `length`, or `length`
// zero bytes for a label starting with "zeros". Small CARs are recorded whole;
// larger ones by length and sha256.

import { CarWriter } from "@ipld/car";
import { MemoryBlockstore } from "blockstore-core";
import { importer } from "ipfs-unixfs-importer";
import { balanced } from "ipfs-unixfs-importer/layout";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { CID } from "multiformats/cid";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit } from "node:process";

const [tarball, ipfs, work, outPath] = argv.slice(2);
if (outPath === undefined)
  throw new Error("usage: <kubo-tarball> <ipfs-binary> <work-dir> <out.json>");

// kubo_v0.36.0_linux-amd64.tar.gz, as github.com/ipfs/kubo/releases publishes it.
const KUBO_SHA512 =
  "bde93def3fbae2b86115efca8cbf82ecbe9fc11fcad6c24c204c37e717017ff143cc52987a0f57006561dc9c3fae3cc08e2898fb0bd55a5b70b75e61280df7f5";
if (createHash("sha512").update(readFileSync(tarball)).digest("hex") !== KUBO_SHA512)
  throw new Error("the Kubo tarball isn't the pinned release");
if (!execFileSync(ipfs, ["version"]).toString().includes("0.36.0"))
  throw new Error("the ipfs binary isn't Kubo 0.36.0");

const sha256 = (b) => createHash("sha256").update(b).digest();

function object(label, length) {
  if (label.startsWith("zeros")) return new Uint8Array(length);
  const out = new Uint8Array(length);
  for (let i = 0, at = 0; at < length; i++, at += 32) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i);
    out.set(sha256(Buffer.concat([Buffer.from(label), counter])).subarray(0, length - at), at);
  }
  return out;
}

const PROTOCOL = { chunkSize: 1_048_576, maxLinks: 1_024 };
const MIB = 1_048_576;
const cases = [
  // The protocol's parameters.
  { id: "one-byte", profile: "protocol", label: "one byte", length: 1 },
  { id: "small", profile: "protocol", label: "small", length: 100 },
  { id: "one-chunk", profile: "protocol", label: "one chunk", length: MIB },
  { id: "one-chunk-plus-one", profile: "protocol", label: "one chunk plus one", length: MIB + 1 },
  { id: "three-chunks", profile: "protocol", label: "three chunks", length: 3 * MIB + 5 },
  { id: "zeros-two-chunks", profile: "protocol", label: "zeros", length: 2 * MIB },
  // The balanced layout's deeper trees, with small limits no protocol object uses.
  ...[1, 4, 5, 16, 17, 21, 64, 65].map((leaves) => ({
    id: `layout-${leaves}-leaves`,
    profile: "layout",
    label: `layout ${leaves}`,
    length: leaves * 256 - 7,
  })),
  { id: "layout-zeros-17-leaves", profile: "layout", label: "zeros layout", length: 17 * 256 },
];
const PROFILES = { protocol: PROTOCOL, layout: { chunkSize: 256, maxLinks: 4 } };

async function bytesOf(chunks) {
  const parts = [];
  for await (const c of chunks) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}

// JavaScript: ipfs-unixfs-importer, then a CAR whose blocks are walked
// depth-first from the root, each once.
async function viaJs(bytes, { chunkSize, maxLinks }) {
  const store = new MemoryBlockstore();
  let root;
  for await (const entry of importer([{ content: bytes }], store, {
    cidVersion: 1,
    rawLeaves: true,
    reduceSingleLeafToSelf: true,
    chunker: fixedSize({ chunkSize }),
    layout: balanced({ maxChildrenPerNode: maxLinks }),
    leafType: "file",
  }))
    root = entry.cid;
  const order = [];
  const seen = new Set();
  const { decode } = await import("@ipld/dag-pb");
  const walk = async (cid) => {
    if (seen.has(cid.toString())) return;
    seen.add(cid.toString());
    // blockstore-core 7 streams a block as chunks.
    const got = await store.get(cid);
    const block = got instanceof Uint8Array ? got : await bytesOf(got);
    order.push({ cid, bytes: block });
    if (cid.code === 0x70) for (const link of decode(block).Links) await walk(link.Hash);
  };
  await walk(root);
  const { writer, out } = CarWriter.create([root]);
  const chunks = [];
  const collect = (async () => {
    for await (const c of out) chunks.push(c);
  })();
  for (const b of order) await writer.put(b);
  await writer.close();
  await collect;
  return { cid: root.toString(), car: Buffer.concat(chunks) };
}

// Kubo: `ipfs add` into a fresh offline repository, then `ipfs dag export`.
function viaKubo(bytes, { chunkSize, maxLinks }, n) {
  const repo = join(work, `repo-${n}`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env, IPFS_PATH: repo };
  const run = (args, input) => execFileSync(ipfs, args, { env, input, maxBuffer: 1 << 30 });
  run(["init", "--empty-repo", "--profile", "test"]);
  run(["config", "--json", "Import.UnixFSFileMaxLinks", String(maxLinks)]);
  const file = join(work, `object-${n}`);
  writeFileSync(file, bytes);
  const cid = run([
    "add",
    "--offline",
    "--quiet",
    "--cid-version=1",
    "--raw-leaves",
    `--chunker=size-${chunkSize}`,
    "--pin=false",
    file,
  ])
    .toString()
    .trim();
  const car = run(["dag", "export", "--offline", "--progress=false", cid]);
  return { cid, car };
}

const vectors = [];
let n = 0;
for (const c of cases) {
  const profile = PROFILES[c.profile];
  const bytes = object(c.label, c.length);
  const js = await viaJs(bytes, profile);
  const go = viaKubo(bytes, profile, n++);
  if (js.cid !== go.cid) throw new Error(`${c.id}: CIDs differ: js ${js.cid}, kubo ${go.cid}`);
  if (!js.car.equals(go.car))
    throw new Error(`${c.id}: CARs differ (${js.car.length} and ${go.car.length} bytes)`);
  const v = { id: c.id, profile: c.profile, label: c.label, length: c.length, cid: js.cid };
  v.cidHex = Buffer.from(CID.parse(js.cid).bytes).toString("hex");
  if (js.car.length <= 4096) v.car = js.car.toString("hex");
  v.carLength = js.car.length;
  v.carSha256 = sha256(js.car).toString("hex");
  vectors.push(v);
  console.log(`${c.id}: ${js.cid} (${js.car.length} bytes of CAR), Kubo and JavaScript agree`);
}

const out = {
  format: "abolish-content-addressing-vectors/1",
  title: "Content addressing: objects' CIDs and CARs",
  spec: "docs/spec/content-addressing.md",
  generator:
    "packages/crypto/scripts/content-addressing-vectors.mjs, run outside the workspace: every CID from Kubo 0.36.0 (`ipfs add --cid-version=1 --raw-leaves --chunker=size-N` with Import.UnixFSFileMaxLinks; the release tarball's sha512 checked) and from ipfs-unixfs-importer 17.1.1, and every CAR from Kubo's `ipfs dag export`, matched by @ipld/car 5.4.7 writing the JavaScript blocks in depth-first pre-order; any disagreement is refused",
  profiles: PROFILES,
  object:
    'SHA-256(label ‖ u32be(i)) for i = 0, 1, … concatenated and cut to `length` bytes; `length` zero bytes for a label starting with "zeros"',
  vectors,
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
exit(0);
