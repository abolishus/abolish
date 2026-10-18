// Writes each circuit's committed artifacts into a directory (`artifacts/` by
// default): `<circuit>.json`, the ACIR and ABI as nargo compiles them, and
// `<circuit>.vk`, its UltraHonk verification key from bb under the vendored
// reference string (README, Artifacts). test/proofs.test.ts runs this into a
// scratch directory and fails if anything differs from what is committed.
// Run from the package root: `vp node scripts/artifacts.ts [dir]`.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BB } from "./toolchain.ts";

export const CIRCUITS = ["nullifier_query", "nullifier_output"] as const;
/**
 * bb's target for every key and proof: Poseidon2 transcript, zero knowledge
 * (circuits skill, Rules). The keys and proofs are checked off-chain by the
 * seats and attesters ([[nullifier-query]]), so no EVM target is needed.
 */
export const TARGET = "noir-recursive";

export function writeArtifacts(out: string): void {
  const root = resolve(import.meta.dirname, "..");
  mkdirSync(out, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "abolish-circuit-artifacts-"));
  try {
    for (const circuit of CIRCUITS) {
      // nargo has no output option, so each circuit compiles as a scratch copy
      // with its path dependencies made absolute: the package's own target/
      // stays untouched for the tests that compile into it concurrently, and
      // the build leaves only artifacts/ behind for repro-build to hash. The
      // program is the same as the workspace's (test/proofs.test.ts).
      const pkg = join(scratch, `${circuit}-pkg`);
      mkdirSync(join(pkg, "src"), { recursive: true });
      writeFileSync(
        join(pkg, "Nargo.toml"),
        readFileSync(join(root, circuit, "Nargo.toml"), "utf8").replace(
          /path = "\.\.\/([^"]+)"/g,
          (_, p: string) => `path = ${JSON.stringify(join(root, p))}`,
        ),
      );
      copyFileSync(join(root, circuit, "src", "main.nr"), join(pkg, "src", "main.nr"));
      execFileSync("nargo", ["compile", "--program-dir", pkg], { stdio: "pipe" });
      const compiled = JSON.parse(
        readFileSync(join(pkg, "target", `${circuit}.json`), "utf8"),
      ) as Record<string, unknown>;
      // debug_symbols and file_map carry the sources' absolute paths; proving
      // needs only the bytecode and the ABI.
      const { noir_version, hash, abi, bytecode } = compiled;
      const acir = join(out, `${circuit}.json`);
      writeFileSync(acir, `${JSON.stringify({ noir_version, hash, abi, bytecode }, null, 2)}\n`);
      const vk = join(scratch, circuit);
      execFileSync(BB, ["write_vk", "-b", acir, "-o", vk, "-t", TARGET, "-c", join(root, "crs")], {
        stdio: "pipe",
      });
      copyFileSync(join(vk, "vk"), join(out, `${circuit}.vk`));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  writeArtifacts(resolve(process.argv[2] ?? "artifacts"));
}
