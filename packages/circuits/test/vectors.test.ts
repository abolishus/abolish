// Runs the packing vectors of docs/spec/vectors/circuit.json through the Noir
// library, so the circuits pack bytes exactly as packages/crypto and the
// independent Python generator do (docs/spec/notation.md, Circuit-facing
// values; T-31). Noir can't read JSON, so this writes a throwaway Nargo
// package whose tests hold the vectors as literals, and runs `nargo test` on it.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vite-plus/test";

interface CircuitVectors {
  readonly format: string;
  readonly packBytes: readonly {
    readonly id: string;
    readonly bytes: string;
    readonly fields: readonly string[];
  }[];
  readonly packBoundedBytes: readonly {
    readonly id: string;
    readonly max: number;
    readonly bytes: string;
    readonly fields?: readonly string[];
    readonly error?: string;
  }[];
}

const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/circuit.json", import.meta.url), "utf8"),
) as CircuitVectors;
const LIB = fileURLToPath(new URL("../lib/abolish", import.meta.url));

const bytesOf = (h: string) => (h.match(/../g) ?? []).map((b) => Number.parseInt(b, 16));
const array = (xs: readonly (number | string)[]) => `[${xs.join(", ")}]`;
const fn = (id: string) => id.replace(/-/g, "_");

/** One Noir test per vector, plus a should-fail test per bounded vector with padding. */
function noirTests(): string {
  const out: string[] = ["use abolish::pack::{pack_bounded_bytes, pack_bytes};"];
  for (const v of vectors.packBytes) {
    const b = bytesOf(v.bytes);
    out.push(`#[test]
fn bytes_${fn(v.id)}() {
    let out: [Field; ${v.fields.length}] = pack_bytes(${array(b)});
    assert(out == ${array(v.fields)});
}`);
  }
  for (const v of vectors.packBoundedBytes) {
    const b = bytesOf(v.bytes);
    const chunks = Math.ceil(v.max / 31);
    if (v.error !== undefined) {
      // A value longer than its maximum can't be passed as [u8; MAX], so the
      // prover claims its length with the first MAX bytes.
      out.push(`#[test(should_fail_with = "length exceeds the maximum")]
fn bounded_${fn(v.id)}() {
    let _: (Field, [Field; ${chunks}]) = pack_bounded_bytes(${array(b.slice(0, v.max))}, ${b.length});
}`);
      continue;
    }
    const fields = v.fields ?? [];
    const padded = [...b, ...Array.from({ length: v.max - b.length }, () => 0)];
    out.push(`#[test]
fn bounded_${fn(v.id)}() {
    let (len, out): (Field, [Field; ${chunks}]) = pack_bounded_bytes(${array(padded)}, ${b.length});
    assert(len == ${fields[0]});
    assert(out == ${array(fields.slice(1))});
}`);
    // The first and the last padding byte, so an off-by-one in either
    // direction of the padding check fails a test.
    for (const at of new Set(b.length < v.max ? [b.length, v.max - 1] : [])) {
      const dirty = [...padded];
      dirty[at] = 1;
      out.push(`#[test(should_fail_with = "padding byte is not zero")]
fn bounded_${fn(v.id)}_rejects_padding_at_${at}() {
    let _: (Field, [Field; ${chunks}]) = pack_bounded_bytes(${array(dirty)}, ${b.length});
}`);
    }
  }
  return `${out.join("\n\n")}\n`;
}

const dir = mkdtempSync(join(tmpdir(), "abolish-circuit-vectors-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("circuit.json through the Noir library", () => {
  test("the file has the expected format", () => {
    expect(vectors.format).toBe("abolish-circuit-vectors/1");
  });

  test("nargo test passes every packing vector", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "Nargo.toml"),
      `[package]\nname = "vectors"\ntype = "lib"\nauthors = [""]\n\n[dependencies]\nabolish = { path = ${JSON.stringify(LIB)} }\n`,
    );
    writeFileSync(join(dir, "src", "lib.nr"), noirTests());
    const out = execFileSync("nargo", ["test", "--program-dir", dir], { encoding: "utf8" });
    const expected = noirTests().split("#[test").length - 1;
    expect(expected).toBeGreaterThan(vectors.packBytes.length + vectors.packBoundedBytes.length);
    expect(out).toContain(`${expected} tests passed`);
  }, 120_000);
});
