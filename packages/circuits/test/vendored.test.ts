// Every file under vendor/ is upstream's at its pinned commit (README,
// Vendored dependencies), so a change to vendored code can't pass as a
// refresh of upstream (T-55). Each entry is checked against the git object id
// `git rev-parse <commit>:<path>` prints upstream. A Nargo.toml whose git
// dependencies point at the vendored copies instead is checked by putting
// upstream's lines back: what comes out must hash to upstream's file, so the
// rewritten lines are the only change and each names the copy of the
// repository and tag the line it replaces named.

import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { dirname, posix } from "node:path";
import { describe, expect, test } from "vite-plus/test";

const ROOT = new URL("../", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, ROOT), "utf8");

/** Git's object id of a directory as a tree (`git rev-parse <commit>:<path>`). */
function gitTree(dir: URL): string {
  const entries = readdirSync(dir, { withFileTypes: true }).map((e) => {
    // A symlink would be hashed as its target's content; the trees have none.
    if (!e.isDirectory() && !e.isFile()) throw new Error(`not a file: ${e.name}`);
    const isDir = e.isDirectory();
    const id = isDir
      ? gitTree(new URL(`${e.name}/`, dir))
      : gitObject("blob", readFileSync(new URL(e.name, dir)));
    // Git sorts a tree's entries by name, a directory's as if it ended in "/".
    return {
      key: isDir ? `${e.name}/` : e.name,
      mode: isDir ? "40000" : "100644",
      name: e.name,
      id,
    };
  });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const body = Buffer.concat(
    entries.map((e) =>
      Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.id, "hex")]),
    ),
  );
  return gitObject("tree", body);
}

function gitObject(kind: string, body: Buffer): string {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`${kind} ${body.length}\0`), body]))
    .digest("hex");
}

/** Where each upstream repository and tag a Nargo.toml names is vendored. */
const COPIES: Record<string, string> = {
  "https://github.com/TaceoLabs/oprf-nr@v1.0.0": "vendor/oprf-nr",
  "https://github.com/TaceoLabs/noir-poseidon@v0.6.1": "vendor/noir-poseidon",
  "https://github.com/noir-lang/poseidon@v0.3.0": "vendor/poseidon",
  "https://github.com/noir-lang/sha256@v0.3.0": "vendor/sha256",
  "https://github.com/zac-williamson/sha1@v0.11": "vendor/sha1",
  "https://github.com/zkpassport/sha512@v0.2.0": "vendor/sha512",
  "https://github.com/madztheo/noir-date@v0.5.6": "vendor/noir-date",
  "https://github.com/zkpassport/noir-bignum@v0.10.0-2": "vendor/noir-bignum",
  "https://github.com/zkpassport/noir_rsa@v0.12.0": "vendor/noir_rsa",
};

// Upstream's READMEs are left out. `upstream` lists a Nargo.toml's git
// dependency lines, each replaced by a path to the vendored copy.
const VENDORED: readonly { path: string; id: string; upstream?: readonly string[] }[] = [
  { path: "vendor/oprf-nr/LICENSE", id: "b82e0563feef75ccfd57f081fd2efb5f80b391d7" },
  {
    path: "vendor/oprf-nr/babyjubjub/Nargo.toml",
    id: "6b8273fbf649348b6124bef0c0ecc2470fc2ac91",
    upstream: [
      'poseidon2 = { tag = "v0.6.1", git = "https://github.com/TaceoLabs/noir-poseidon", directory = "poseidon2" }',
    ],
  },
  { path: "vendor/oprf-nr/babyjubjub/src/", id: "4c27dd3b30880bd23c95dd88f0c794a8c9482366" },
  { path: "vendor/noir-poseidon/LICENSE", id: "3fe6670c1099f6fb152d1cde560c3495ee3f9555" },
  {
    path: "vendor/noir-poseidon/poseidon2/Nargo.toml",
    id: "7bf975d0e027da52afd3887ca1ddecef5092e8f4",
  },
  { path: "vendor/noir-poseidon/poseidon2/src/", id: "f3a287154fe93da15680fca1398ad583fe782450" },
  {
    path: "vendor/noir-poseidon/hash_utils/Nargo.toml",
    id: "3e8398fa4ffff7a9e20c717791ca7607610dc58c",
  },
  { path: "vendor/noir-poseidon/hash_utils/src/", id: "d8bc189c687d2d01419758e43a49576b2bae66ff" },
  { path: "vendor/zkpassport-circuits/LICENSE", id: "195d3262e75c1630565fd92cf332f8ec8ae55330" },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/common/Nargo.toml",
    id: "bdb0a287e398aa175a32069d817bf2c2963bc8f7",
    upstream: ['poseidon = { tag = "v0.3.0", git = "https://github.com/noir-lang/poseidon" }'],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/common/src/",
    id: "682ede99bec8a168e487a2bebc7931666c6bf1db",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/csc-to-dsc/Nargo.toml",
    id: "20460db2731deb904d734f03a6631081fe14ecc5",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/csc-to-dsc/src/",
    id: "0f8729954e4da449f8715a545e2449f31bac212e",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/dsc-to-id/Nargo.toml",
    id: "af6149d7623f4e86446aba2a9fbdc069e878ad33",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/dsc-to-id/src/",
    id: "c7747ca86979712fa1083e7e87d3f6462dff60ef",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/integrity-to-disclosure/Nargo.toml",
    id: "e67e03e45c908b32e639bc91c6b25b1bf22c3879",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/integrity-to-disclosure/src/",
    id: "2e3c64169eb0ba613264c22ce34b33ad75fc776b",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/scoped-nullifier/Nargo.toml",
    id: "2acaea8ebb79cf61d78fb671008ab63678b147e9",
    upstream: [
      'poseidon = { tag = "v0.3.0", git = "https://github.com/noir-lang/poseidon" }',
      'babyjubjub = { tag = "v1.0.0", git = "https://github.com/TaceoLabs/oprf-nr", directory = "babyjubjub" }',
      'oprf = { tag = "v1.0.0", git = "https://github.com/TaceoLabs/oprf-nr", directory = "oprf" }',
    ],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/commitment/scoped-nullifier/src/",
    id: "f5618d5989adaad0421ce49035110dd3e04e6453",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/compare/age/Nargo.toml",
    id: "ffafc8d224b95efd0531c04158e7febc9aa62a09",
    upstream: [
      'date = { tag = "v0.5.6", git = "https://github.com/madztheo/noir-date.git" }',
      'sha256 = { tag = "v0.3.0", git = "https://github.com/noir-lang/sha256" }',
      'poseidon = { tag = "v0.3.0", git = "https://github.com/noir-lang/poseidon" }',
    ],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/compare/age/src/",
    id: "496cfd5344432a709580159e1f45085b3c40cb9f",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/data-check/expiry/Nargo.toml",
    id: "b87a4f87b519c5c78cec6b0a6c62a3c66fd9f7f4",
    upstream: ['date = { tag = "v0.5.6", git = "https://github.com/madztheo/noir-date.git" }'],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/data-check/expiry/src/",
    id: "715de49176da02ec75cd5599ab8e996c814644a7",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/data-check/integrity/Nargo.toml",
    id: "6e1e43678a8028fcf7a7364b7d8e2eed839b46da",
    upstream: [
      'sha256 = { tag = "v0.3.0", git = "https://github.com/noir-lang/sha256" }',
      'sha512 = { tag = "v0.2.0", git = "https://github.com/zkpassport/sha512" }',
      'sha1 = { tag = "v0.11", git = "https://github.com/zac-williamson/sha1" }',
    ],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/data-check/integrity/src/",
    id: "be5202e189a6ccb56015b28ced0902a5e9759ae3",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/data-check/tbs-pubkey/Nargo.toml",
    id: "91affca7d3a25310ba78d22d969429d5ea11e0a3",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/data-check/tbs-pubkey/src/",
    id: "9e3637ac0e104ea50bebe0bee45be15029e57e50",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/inclusion-check/country/Nargo.toml",
    id: "85d4f21a69d22ebb5aec0962d44623dc6231b672",
    upstream: [
      'sha256 = { tag = "v0.3.0", git = "https://github.com/noir-lang/sha256" }',
      'poseidon = { tag = "v0.3.0", git = "https://github.com/noir-lang/poseidon" }',
    ],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/inclusion-check/country/src/",
    id: "ef8897969247ab0f7e34981194ea608ca23df0e2",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/sig-check/common/Nargo.toml",
    id: "59510839cbb06d941dbeb2d9715216246ba5aee9",
    upstream: [
      'sha256 = { tag = "v0.3.0", git = "https://github.com/noir-lang/sha256" }',
      'sha512 = { tag = "v0.2.0", git = "https://github.com/zkpassport/sha512" }',
      'sha1 = { tag = "v0.11", git = "https://github.com/zac-williamson/sha1" }',
    ],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/sig-check/common/src/",
    id: "813fc5381165d25c459c63f6a4cf92c317e6ea59",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/sig-check/rsa/Nargo.toml",
    id: "4f7c28bb8e503eec5942dde82b794e8260d4df69",
    upstream: [
      'rsa = { git = "https://github.com/zkpassport/noir_rsa", tag = "v0.12.0" }',
      'bignum = { git = "https://github.com/zkpassport/noir-bignum", tag = "v0.10.0-2"}',
    ],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/sig-check/rsa/src/",
    id: "e501fa389366bcd6cd78d4b74d8fcc9c91c51f4b",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/utils/Nargo.toml",
    id: "a92c03e442c9eeef43cf4a6eac3c8fa333b8f90d",
    upstream: [
      'poseidon = { tag = "v0.3.0", git = "https://github.com/noir-lang/poseidon" }',
      'babyjubjub = { tag = "v1.0.0", git = "https://github.com/TaceoLabs/oprf-nr", directory = "babyjubjub" }',
    ],
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/lib/utils/src/",
    id: "1a7e5fb3b842054705f6e8233aa98ac39c7ed694",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/bin/compare/age/standard/Nargo.toml",
    id: "460f82f7719ce6e36c5cc60d22f75b34556e9f4d",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/bin/compare/age/standard/src/",
    id: "d9230e79130879a5483522de2b76ac29eb6451a0",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/bin/inclusion-check/nationality/standard/Nargo.toml",
    id: "6f5f28ac9bf746204e3209e6d200655abde7a3d2",
  },
  {
    path: "vendor/zkpassport-circuits/src/noir/bin/inclusion-check/nationality/standard/src/",
    id: "4d0138fddeb975d0c4d90d529e0992159e721d7d",
  },
  { path: "vendor/poseidon/LICENSE", id: "c61b66391a3c1545c8c274bc6d7d764bafb84993" },
  { path: "vendor/sha1/LICENSE", id: "c61b66391a3c1545c8c274bc6d7d764bafb84993" },
  { path: "vendor/sha512/LICENSE", id: "c61b66391a3c1545c8c274bc6d7d764bafb84993" },
  { path: "vendor/noir-date/LICENSE", id: "3285316f6b59c81ed0df57f80576fdb779494e15" },
  { path: "vendor/noir-bignum/LICENSE", id: "c61b66391a3c1545c8c274bc6d7d764bafb84993" },
  { path: "vendor/noir_rsa/LICENSE", id: "c61b66391a3c1545c8c274bc6d7d764bafb84993" },
  { path: "vendor/poseidon/Nargo.toml", id: "bc2f9b292b57961e839865cb4d45233be62c0984" },
  { path: "vendor/poseidon/src/", id: "8a265c8dc3e93e91a8ebbfb74ade8437ff649e25" },
  { path: "vendor/sha256/Nargo.toml", id: "7afdf910a143104ecdfb37ede2b099af51aa541f" },
  { path: "vendor/sha256/src/", id: "a29ada5689f6e213a587c2995ca67d51bdc6218d" },
  { path: "vendor/sha1/Nargo.toml", id: "c2aa756f000d98971849d5ff708b2c3bfa2efbe4" },
  { path: "vendor/sha1/src/", id: "d9ead839874603c843e7d6865672a56b60dd5a57" },
  { path: "vendor/sha512/Nargo.toml", id: "b38232d29febe9ecc379f76a12460cbfc07dda63" },
  { path: "vendor/sha512/src/", id: "41fb8f81389367d4e376b28b08c37e73b694d2cf" },
  { path: "vendor/noir-date/Nargo.toml", id: "5d0990651236dc63c21671f7712ac27e8a46c375" },
  { path: "vendor/noir-date/src/", id: "1042c7eaa545d70d9a10e724d2b151367c5d3afb" },
  {
    path: "vendor/noir-bignum/Nargo.toml",
    id: "e381b8351892fb82428c9b4a09fa09b34b7cd6b5",
    upstream: ['poseidon = { git = "https://github.com/noir-lang/poseidon", tag = "v0.3.0" }'],
  },
  { path: "vendor/noir-bignum/src/", id: "4a6958dcd47a1e96f7aac96536b7fc33c7779964" },
  {
    path: "vendor/noir_rsa/Nargo.toml",
    id: "105a48d7e821b0a81f3c34c60ceb889280e25714",
    upstream: [
      'bignum = {tag = "v0.10.0-2", git = "https://github.com/zkpassport/noir-bignum"}',
      'sha256 = { tag = "v0.3.0", git = "https://github.com/noir-lang/sha256" }',
      'sha512 = { tag = "v0.2.0", git = "https://github.com/zkpassport/sha512" }',
      'sha1 = { tag = "v0.11", git = "https://github.com/zac-williamson/sha1" }',
    ],
  },
  { path: "vendor/noir_rsa/src/", id: "2794e852766c0c5fe024e5a4dabcd39bd923d198" },
  {
    path: "vendor/oprf-nr/oprf/Nargo.toml",
    id: "aba6597741a8e4a24340742028ff247ae1cb1d74",
    upstream: [
      'poseidon2 = { tag = "v0.6.1", git = "https://github.com/TaceoLabs/noir-poseidon", directory = "poseidon2" }',
    ],
  },
  { path: "vendor/oprf-nr/oprf/src/", id: "f0cbcffe6ef95ca7a2c4df03aeee984019957e88" },
];

/** nargo writes a bin's Prover.toml at its first check: a template, no witness. */
const TEMPLATES = [
  "vendor/zkpassport-circuits/src/noir/bin/compare/age/standard/Prover.toml",
  "vendor/zkpassport-circuits/src/noir/bin/inclusion-check/nationality/standard/Prover.toml",
];

/** The line a git dependency becomes: a path to the vendored copy. */
function rewrite(file: string, line: string): string {
  const m = /^(\w+) = \{(.*)\}$/.exec(line);
  const fields = Object.fromEntries(
    (m?.[2] ?? "").split(",").map((kv) => {
      const [k, v] = kv.split("=").map((s) => s.trim());
      return [k, JSON.parse(v ?? "null") as string];
    }),
  );
  const copy = COPIES[`${String(fields.git).replace(/\.git$/, "")}@${String(fields.tag)}`];
  expect(copy, line).toBeDefined();
  const target = posix.join(copy ?? "", fields.directory ?? "");
  return `${m?.[1] ?? ""} = { path = "${posix.relative(dirname(file), target)}" }`;
}

describe("vendored sources", () => {
  test.each(VENDORED)("$path is upstream's, unchanged", ({ path, id, upstream }) => {
    const url = new URL(path, ROOT);
    if (path.endsWith("/")) {
      expect(gitTree(url)).toBe(id);
    } else {
      let lines = read(path).split("\n");
      for (const line of upstream ?? []) {
        const ours = rewrite(path, line);
        expect(
          lines.filter((l) => l === ours),
          ours,
        ).toHaveLength(1);
        lines = lines.map((l) => (l === ours ? line : l));
      }
      expect(gitObject("blob", Buffer.from(lines.join("\n")))).toBe(id);
    }
    expect(read("README.md")).toContain(id);
  });

  test("nothing else is vendored", () => {
    const pinned = VENDORED.map((v) => v.path);
    const files = readdirSync(new URL("vendor/", ROOT), { recursive: true, encoding: "utf8" })
      .map((f) => `vendor/${f}`)
      .filter((f) => {
        // lstat: a symlink is neither, so it can't pass as a directory.
        const st = lstatSync(new URL(f, ROOT));
        expect(st.isFile() || st.isDirectory(), f).toBe(true);
        return st.isFile();
      });
    for (const f of files) {
      const covered =
        TEMPLATES.includes(f) || pinned.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
      expect(covered, f).toBe(true);
    }
  });

  test.each(TEMPLATES)("%s holds no values", (file) => {
    for (const line of read(file).split("\n")) {
      expect(line).toMatch(/^(|\[[a-z0-9_.]+\]|[a-z0-9_]+ = (0|"_+"|\[((0|"_+"), )*(0|"_+")\]))$/);
    }
  });
});
