import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { parseRsp, readManifest, readVendored, VECTORS_ROOT } from "./harness.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe("vendored vector files", () => {
  test("every vendored file is listed in the manifest and matches its sha256", () => {
    const listed = readManifest().map((f) => f.path);
    const onDisk = readdirSync(VECTORS_ROOT, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() || d.isSymbolicLink())
      .map((d) => join(d.parentPath, d.name).slice(fileURLToPath(VECTORS_ROOT).length))
      .filter((p) => !["manifest.json", "README.md", ".gitattributes"].includes(p))
      .sort();
    expect(onDisk).toEqual([...listed].sort());
    for (const path of listed) expect(readVendored(path).length).toBeGreaterThan(0);
  });
});

describe("readVendored", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  const fixture = (bytes: Buffer, sha256: string, path = "pub/file.txt") => {
    dir = mkdtempSync(join(tmpdir(), "vectors-"));
    mkdirSync(join(dir, "pub"));
    writeFileSync(join(dir, "pub/file.txt"), bytes);
    const entry = {
      path,
      sha256,
      source: "https://example.org/file.txt",
      origin: "test",
      originUrl: "https://example.org/",
      license: "test",
      retrieved: "2026-10-09",
      covers: "test",
    };
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ format: "abolish-test-vectors-manifest/1", files: [entry] }),
    );
    return pathToFileURL(`${dir}/`);
  };
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  test("returns the bytes when the sha256 matches", () => {
    const bytes = Buffer.from("vector\r\n");
    expect(readVendored("pub/file.txt", fixture(bytes, sha(bytes)))).toEqual(bytes);
  });

  test("rejects any single-byte change to a vendored file", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1, maxLength: 64 }),
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (raw, at, delta) => {
          const original = Buffer.from(raw);
          const tampered = Buffer.from(raw);
          const i = at % tampered.length;
          tampered[i] = ((tampered[i] ?? 0) + delta) % 256;
          const root = fixture(tampered, sha(original));
          expect(() => readVendored("pub/file.txt", root)).toThrow(/does not match/);
          rmSync(dir ?? "", { recursive: true, force: true });
          dir = undefined;
        },
      ),
      { numRuns },
    );
  });

  test("rejects unlisted files and paths that leave test-vectors/", () => {
    const bytes = Buffer.from("x");
    expect(() => readVendored("pub/other.txt", fixture(bytes, sha(bytes)))).toThrow(/not listed/);
    rmSync(dir ?? "", { recursive: true, force: true });
    for (const path of ["../pub/file.txt", "/etc/passwd", "pub/../../x", "file.txt"]) {
      expect(() => readVendored(path, fixture(bytes, sha(bytes), path))).toThrow(/bad path/);
      rmSync(dir ?? "", { recursive: true, force: true });
    }
    dir = undefined;
  });
});

describe("parseRsp", () => {
  const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,6}$/);
  const value = fc.stringMatching(/^[0-9a-f]{0,16}$/);
  const record = fc
    .uniqueArray(fc.tuple(name, value), { minLength: 1, maxLength: 4, selector: ([k]) => k })
    .map((pairs) => Object.fromEntries(pairs));

  test("round-trips records written in the CAVP layout, with either line ending", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.option(fc.tuple(name, value), { nil: undefined }), record), {
          maxLength: 6,
        }),
        fc.constantFrom("\n", "\r\n"),
        (groups, eol) => {
          const lines = ["#  CAVS 11.0", "#  generated", ""];
          const expected: { params: Record<string, string>; fields: Record<string, string> }[] = [];
          let params: Record<string, string> = {};
          for (const [param, fields] of groups) {
            if (param !== undefined) {
              lines.push(`[${param[0]} = ${param[1]}]`, "");
              params = { ...params, [param[0]]: param[1] };
            }
            for (const [k, v] of Object.entries(fields)) lines.push(`${k} = ${v}`);
            lines.push("");
            expected.push({ params, fields });
          }
          expect(parseRsp(lines.join(eol))).toEqual(expected);
        },
      ),
      { numRuns },
    );
  });

  test("rejects lines it does not understand and repeated fields", () => {
    expect(() => parseRsp("Len = 0\nMsg 00\n")).toThrow(/unrecognised/);
    expect(() => parseRsp("Len = 0\nLen = 8\n")).toThrow(/repeated/);
    expect(() => parseRsp("[L = 32\n")).toThrow(/unrecognised/);
  });
});
