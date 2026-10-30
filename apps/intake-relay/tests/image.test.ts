import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  dir = mkdtempSync(join(tmpdir(), "abolish-intake-relay-image-"));
  execFileSync("vp", ["pack", "--out-dir", join(dir, "app")], { cwd: pkg, stdio: "inherit" });
}, 120_000);
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Starts the bundle with exactly `env`. */
function start(env: Record<string, string>) {
  const child = spawn(process.execPath, ["main.mjs"], {
    cwd: join(dir, "app"),
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  return { child, out: () => ({ stdout, stderr }) };
}

describe("the bundle", () => {
  test("refuses to start without its configuration, never quoting one", async () => {
    const none = start({});
    expect((await once(none.child, "exit"))[0]).toBe(2);
    expect(none.out()).toEqual({
      stdout: "",
      stderr: `${JSON.stringify({ error: "RELAY_CONFIG: not set" })}\n`,
    });
    const bad = start({
      RELAY_CONFIG: JSON.stringify({
        host: "127.0.0.1",
        port: 0,
        resources: [{ path: "seat-1", node: "http://secret-node.example" }],
      }),
    });
    expect((await once(bad.child, "exit"))[0]).toBe(2);
    expect(bad.out().stderr).not.toContain("secret-node");
  }, 30_000);

  test("listens with its configuration and stops on SIGTERM", async () => {
    const relay = start({
      RELAY_CONFIG: JSON.stringify({
        host: "127.0.0.1",
        port: 0,
        resources: [{ path: "seat-1", node: "https://seat-1.example" }],
      }),
    });
    while (!relay.out().stdout.includes("\n")) await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(relay.out().stdout)).toEqual({ event: "relay-listening", resources: 1 });
    relay.child.kill("SIGTERM");
    expect((await once(relay.child, "exit"))[0]).toBe(0);
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

  test("runs the bundle as node, with no package manager and no volume", () => {
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toMatch(/^CMD \["node", "main\.mjs"\]$/m);
    expect(dockerfile).toContain("rm -rf /usr/local/lib/node_modules /usr/local/bin/npm");
    expect(dockerfile).not.toMatch(/^VOLUME/m);
  });
});
