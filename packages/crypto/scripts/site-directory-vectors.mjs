// Independent generator for docs/spec/vectors/site-directory.json: each
// site's directory CID and CAR from two independent IPFS implementations,
// Kubo (Go, `ipfs add -r` and `ipfs dag export`) and ipfs-unixfs-importer
// (JavaScript, with @ipld/car), set to docs/spec/content-addressing.md's
// parameters, and refused unless both agree byte for byte. It shares no code
// with packages/crypto, and none with content-addressing-vectors.mjs beyond
// the parameters both take from the spec.
//
// It runs outside the workspace, because packages/crypto depends on @noble/*
// only. In an empty directory holding a package.json of `{"type": "module"}`,
// with a copy of this script (bare imports resolve from the script's own
// directory):
//
//   vp add ipfs-unixfs-importer@17.1.1 @ipld/car@5.4.7 @ipld/dag-pb@4.1.5 blockstore-core@7.0.1 multiformats@14.0.5
//   curl -LO https://github.com/ipfs/kubo/releases/download/v0.36.0/kubo_v0.36.0_linux-amd64.tar.gz
//   tar xzf kubo_v0.36.0_linux-amd64.tar.gz
//   vp node site-directory-vectors.mjs <the tarball> kubo/ipfs <work-dir> <out.json>
//
// The script refuses a tarball whose sha512 isn't KUBO_SHA512 below, the
// published one for that release.
//
// A file's bytes are deterministic: `object(label, length)` is
// SHA-256(label ‖ u32be(i)) for i = 0, 1, … concatenated and cut to `length`,
// as in content-addressing-vectors.mjs. Each site lists its files as
// `[path, label, length]`.

import { CarWriter } from "@ipld/car";
import { decode } from "@ipld/dag-pb";
import { MemoryBlockstore } from "blockstore-core";
import { importer } from "ipfs-unixfs-importer";
import { fixedSize } from "ipfs-unixfs-importer/chunker";
import { balanced } from "ipfs-unixfs-importer/layout";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  const out = new Uint8Array(length);
  for (let i = 0, at = 0; at < length; i++, at += 32) {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(i);
    out.set(sha256(Buffer.concat([Buffer.from(label), counter])).subarray(0, length - at), at);
  }
  return out;
}

const MIB = 1_048_576;
const CHUNK = MIB;
const MAX_LINKS = 1_024;
const name128 = `${"n".repeat(123)}.html`;
const deep = Array.from({ length: 15 }, (_, i) => `d${i}`).join("/");
// 1,024 bytes: seven 128-byte segments, a 121-byte one and seven slashes.
const longest = [...Array.from({ length: 7 }, (_, i) => `${i}`.repeat(128)), "f".repeat(121)].join(
  "/",
);
const sites = [
  { id: "index-only", description: "One file, index.html", files: [["index.html", "index", 200]] },
  {
    id: "ballot-like",
    description:
      "The shape of a ballot-client build: the page, hashed assets, a nested directory, a dot-directory, a multi-chunk file",
    files: [
      ["index.html", "page", 1_412],
      ["font-licenses.txt", "licences", 9_000],
      ["assets/index-3f9a.js", "app", 70_000],
      ["assets/index-3f9a.css", "style", 12_000],
      ["assets/worker-77b0.js", "worker", 40_000],
      ["assets/fonts/oxanium-latin.woff2", "oxanium", 30_000],
      ["assets/fonts/jetbrains-mono-latin.woff2", "mono", 28_000],
      ["assets/semaphore-32-0123.zkey", "zkey", 2 * MIB + 333],
      [".well-known/webauthn", "well-known", 60],
    ],
  },
  {
    id: "challenge-like",
    description: "The shape of the challenge page: the page and one script",
    files: [
      ["index.html", "challenge page", 900],
      ["assets/challenge-5c1d.js", "challenge script", 8_000],
    ],
  },
  {
    id: "identical-files",
    description:
      "The same bytes at two paths in two directories: one leaf, carried once in the CAR",
    files: [
      ["index.html", "index", 100],
      ["a/same.txt", "same", 500],
      ["b/same.txt", "same", 500],
    ],
  },
  {
    id: "name-order",
    description: "Names sorted by their bytes: '-' < '.' < digits < upper case < '_' < lower case",
    files: [
      ["index.html", "index", 10],
      ["-x", "dash", 1],
      [".x", "dot", 2],
      ["0x", "digit", 3],
      ["Ax", "upper", 4],
      ["_x", "underscore", 5],
      ["ax", "lower", 6],
      ["a-x", "lower-dash", 7],
      ["a.x", "lower-dot", 8],
    ],
  },
  {
    id: "longest-name-deepest-path",
    description: "A 128-byte name, and a file 16 segments deep (15 directories below the root)",
    files: [
      ["index.html", "index", 10],
      [name128, "long name", 10],
      [`${deep}/leaf.txt`, "deep", 10],
    ],
  },
  {
    id: "longest-path",
    description: "A path of 1,024 bytes, the longest a release record allows",
    files: [
      ["index.html", "index", 10],
      [longest, "longest path", 10],
    ],
  },
  {
    id: "widest-directory",
    description:
      "A root of 1,024 entries, index.html and 1,023 128-byte names, as many as a site's files: neither implementation shards it",
    files: [
      ["index.html", "index", 10],
      ...Array.from({ length: 1_023 }, (_, i) => [
        `${String(i).padStart(4, "0")}${"w".repeat(120)}.txt`,
        `wide ${i}`,
        1 + (i % 7),
      ]),
    ],
  },
  {
    id: "chunk-boundaries",
    description: "Files of exactly one chunk and of one chunk and a byte",
    files: [
      ["index.html", "index", 10],
      ["one-chunk.bin", "one chunk", CHUNK],
      ["one-chunk-plus-one.bin", "one chunk plus one", CHUNK + 1],
    ],
  },
];

async function bytesOf(chunks) {
  const parts = [];
  for await (const c of chunks) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}

// JavaScript: ipfs-unixfs-importer with every path under one wrapping
// directory, then a CAR whose blocks are walked depth-first from the root,
// each once.
async function viaJs(files) {
  const store = new MemoryBlockstore();
  let root;
  for await (const entry of importer(
    files.map(([path, label, length]) => ({ path, content: object(label, length) })),
    store,
    {
      cidVersion: 1,
      rawLeaves: true,
      reduceSingleLeafToSelf: true,
      chunker: fixedSize({ chunkSize: CHUNK }),
      layout: balanced({ maxChildrenPerNode: MAX_LINKS }),
      leafType: "file",
      wrapWithDirectory: true,
    },
  ))
    root = entry.cid;
  const order = [];
  const seen = new Set();
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
  return { cid: root, car: Buffer.concat(chunks), blocks: order };
}

// Kubo: the files written under a fresh directory, `ipfs add -r --hidden`
// into a fresh offline repository (so `.well-known` is kept), then
// `ipfs dag export`.
function viaKubo(files, n) {
  const repo = join(work, `repo-${n}`);
  const dir = join(work, `site-${n}`);
  for (const d of [repo, dir]) {
    rmSync(d, { recursive: true, force: true });
    mkdirSync(d, { recursive: true });
  }
  for (const [path, label, length] of files) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), object(label, length));
  }
  const env = { ...process.env, IPFS_PATH: repo };
  const run = (args) => execFileSync(ipfs, args, { env, maxBuffer: 1 << 30 });
  run(["init", "--empty-repo", "--profile", "test"]);
  run(["config", "--json", "Import.UnixFSFileMaxLinks", String(MAX_LINKS)]);
  const cid = run([
    "add",
    "--offline",
    "--quieter",
    "--recursive",
    "--hidden",
    "--cid-version=1",
    "--raw-leaves",
    `--chunker=size-${CHUNK}`,
    "--pin=false",
    dir,
  ])
    .toString()
    .trim();
  const car = run(["dag", "export", "--offline", "--progress=false", cid]);
  return { cid, car };
}

const vectors = [];
let n = 0;
for (const site of sites) {
  const js = await viaJs(site.files);
  const go = viaKubo(site.files, n++);
  if (js.cid.toString() !== go.cid)
    throw new Error(`${site.id}: CIDs differ: js ${js.cid}, kubo ${go.cid}`);
  if (!js.car.equals(go.car))
    throw new Error(`${site.id}: CARs differ (${js.car.length} and ${go.car.length} bytes)`);
  if (js.cid.code !== 0x70) throw new Error(`${site.id}: the root isn't a dag-pb node`);
  // The root node itself, so a reader can check its links without the CAR.
  const rootBlock = js.blocks[0].bytes;
  for (const { cid, bytes } of js.blocks)
    if (cid.code === 0x70 && bytes.length > 256 * 1024)
      throw new Error(`${site.id}: a node of ${bytes.length} bytes, near the sharding threshold`);
  const v = {
    id: site.id,
    description: site.description,
    files: site.files.map(([path, label, length]) => ({ path, label, length })),
    cid: go.cid,
    cidHex: Buffer.from(js.cid.bytes).toString("hex"),
    blocks: js.blocks.length,
  };
  if (rootBlock.length <= 4096) v.root = Buffer.from(rootBlock).toString("hex");
  v.rootLength = rootBlock.length;
  v.rootSha256 = sha256(rootBlock).toString("hex");
  if (js.car.length <= 4096) v.car = js.car.toString("hex");
  v.carLength = js.car.length;
  v.carSha256 = sha256(js.car).toString("hex");
  vectors.push(v);
  console.log(`${site.id}: ${go.cid} (${js.car.length} bytes of CAR), Kubo and JavaScript agree`);
}

const out = {
  format: "abolish-site-directory-vectors/1",
  title: "Content addressing: sites' directory CIDs and CARs",
  spec: "docs/spec/content-addressing.md",
  generator:
    "packages/crypto/scripts/site-directory-vectors.mjs, run outside the workspace: every directory CID from Kubo 0.36.0 (`ipfs add --recursive --hidden --cid-version=1 --raw-leaves --chunker=size-1048576` with Import.UnixFSFileMaxLinks 1024; the release tarball's sha512 checked) and from ipfs-unixfs-importer 17.1.1 (wrapWithDirectory), and every CAR from Kubo's `ipfs dag export`, matched by @ipld/car 5.4.7 writing the JavaScript blocks in depth-first pre-order; any disagreement is refused. packages/crypto/scripts/release-record-vectors.py rebuilds every root and CID from the spec alone",
  object: "SHA-256(label ‖ u32be(i)) for i = 0, 1, … concatenated and cut to `length` bytes",
  vectors,
};
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
exit(0);
