// The built page, as a host would serve it: nothing in it but this app's
// code, no URL but Turnstile's script and the entry points, no inline code,
// and the deployment's headers file (T-43, T-67).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { STAGING } from "../src/deployment.ts";
import { pageHeaders } from "../src/policy.ts";
import { TURNSTILE_ORIGIN, TURNSTILE_SCRIPT } from "../src/turnstile.ts";
import { buildPage, root, TEST } from "./build.ts";

const URL_TEXT = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`)]*/gi;
const BANNED =
  /\beval\s*\(|new Function|\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|\.search\b|location\.href/;

const dirs: string[] = [];
let withKey: { modules: string[]; files: string[]; dir: string };
let staging: { modules: string[]; files: string[]; dir: string };

async function built(deployment: typeof TEST) {
  const dir = await mkdtemp(join(tmpdir(), "abolish-challenge-"));
  dirs.push(dir);
  return { ...(await buildPage(deployment, dir)), dir };
}

beforeAll(async () => {
  withKey = await built(TEST);
  staging = await built(STAGING);
});

afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

const read = (b: { dir: string }, file: string) => readFile(join(b.dir, file), "utf8");
const script = (b: { dir: string; files: string[] }) =>
  read(b, b.files.find((f) => f.endsWith(".js")) ?? "");

describe("the build", () => {
  test("is the page, one script, one stylesheet and the headers file", () => {
    for (const { files } of [withKey, staging]) {
      expect(files).toHaveLength(4);
      expect(files.filter((f) => /^assets\/index-[\w-]+\.js$/.test(f))).toHaveLength(1);
      expect(files.filter((f) => /^assets\/index-[\w-]+\.css$/.test(f))).toHaveLength(1);
      expect(files).toContain("index.html");
      expect(files).toContain("headers.json");
    }
  });

  test("bundles this app's code and nothing else", () => {
    for (const { modules } of [withKey, staging]) {
      expect(modules.length).toBeGreaterThan(0);
      for (const id of modules)
        expect(
          id === "\0virtual:challenge-deployment" ||
            id.startsWith(join(root, "src/")) ||
            id === join(root, "index.html"),
          id,
        ).toBe(true);
    }
  });

  test("names no URL but Turnstile's script and the entry points", async () => {
    const text = await script(withKey);
    expect(new Set(text.match(URL_TEXT))).toEqual(new Set([TURNSTILE_SCRIPT, ...TEST.entryPoints]));
    expect(text).toContain(TEST.siteKey);
    expect(text).not.toMatch(BANNED);
  });

  test("loads nothing on staging, which has no site key yet", async () => {
    // The page loads Turnstile only with a site key, so without one the
    // build drops the code that would.
    expect(STAGING.siteKey).toBeUndefined();
    const text = await script(staging);
    expect(text).not.toContain(TURNSTILE_ORIGIN);
    expect(new Set(text.match(URL_TEXT))).toEqual(new Set(STAGING.entryPoints));
    expect(text).not.toMatch(BANNED);
  });

  test("serves the page with no inline code and only relative references", async () => {
    for (const b of [withKey, staging]) {
      const html = await read(b, "index.html");
      expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
      expect(html).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i);
      const refs = [...html.matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1]);
      expect(refs).toHaveLength(2);
      for (const ref of refs) expect(ref, ref).toMatch(/^\.\/assets\/[\w-]+\.(?:js|css)$/);
    }
  });

  test("writes the deployment's headers", async () => {
    expect(JSON.parse(await read(withKey, "headers.json"))).toEqual(pageHeaders(TEST));
    expect(JSON.parse(await read(staging, "headers.json"))).toEqual(pageHeaders(STAGING));
  });
});
