import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

// What the image runs (Dockerfile): the bundle in dist/, copied away from the
// repository so nothing resolves through node_modules, run by plain Node with
// the image's default command.

const pkg = fileURLToPath(new URL("..", import.meta.url));

let dir: string;

beforeAll(() => {
  // Packed straight into a directory outside the repository, so nothing
  // resolves through node_modules and a concurrent build's dist/ is untouched.
  dir = mkdtempSync(join(tmpdir(), "abolish-trustee-node-image-"));
  execFileSync("vp", ["pack", "--out-dir", join(dir, "app")], { cwd: pkg, stdio: "inherit" });
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Runs the bundle with `args` and exactly `env`, to its exit. */
async function run(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["main.mjs", ...args], {
    cwd: join(dir, "app"),
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const [code] = (await once(child, "exit")) as [number];
  return { code, stdout, stderr };
}

describe("the bundle", () => {
  test("run-env refuses to start without its volume, then without its configuration", async () => {
    expect(await run(["run-env", "--data", join(dir, "data")])).toEqual({
      code: 2,
      stdout: "",
      stderr: `${JSON.stringify({ error: "data: ENOENT" })}\n`,
    });
    mkdirSync(join(dir, "data"), { mode: 0o700 });
    expect(await run(["run-env", "--data", join(dir, "data")])).toEqual({
      code: 2,
      stdout: "",
      stderr: `${JSON.stringify({ error: "TRUSTEE_CONFIG: not set" })}\n`,
    });
  }, 30_000);

  test("keygen writes a key and prints only its public key", async () => {
    const { code, stdout } = await run(["keygen", "--out", join(dir, "identity.key")]);
    expect(code).toBe(0);
    const secret = readFileSync(join(dir, "identity.key"), "utf8").trim();
    expect(stdout).not.toContain(secret);
    expect(JSON.parse(stdout)).toMatchObject({ event: "keygen" });
  }, 30_000);
});

describe("the Dockerfile", () => {
  const dockerfile = readFileSync(join(pkg, "Dockerfile"), "utf8");

  test("builds on the repository's Node, pinned by digest", () => {
    const node = readFileSync(new URL("../../../.node-version", import.meta.url), "utf8").trim();
    const from = dockerfile.match(/^FROM (\S+)$/m)?.[1] ?? "";
    expect(from).toMatch(
      new RegExp(`:${node.replaceAll(".", "\\.")}-[a-z-]+@sha256:[0-9a-f]{64}$`),
    );
  });

  test("runs the seat from its volume as node, with no package manager and no /data of its own", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^CMD \["node", "main\.mjs", "run-env", "--data", "\/data"\]$/m);
    expect(dockerfile).toContain("rm -rf /usr/local/lib/node_modules /usr/local/bin/npm");
    expect(dockerfile).not.toMatch(/^(?:RUN|VOLUME|WORKDIR|COPY).*\/data/m);
  });
});
