// Runs docs/spec/vectors/keyed-nullifier-hashes.json through lib/keyed_nullifier
// and the vendored TACEO gadgets, so the circuits compute `H1` and `H2`
// exactly as the spec and its independent Python generator define them
// (docs/spec/keyed-nullifier-hashes.md; T-03, T-30, T-36, T-39). Each map is
// checked before the cofactor is cleared, which pins the sign rule that the
// generator's cross-check against TACEO's `encode` answers can't (that one is
// only up to 8-torsion). Noir can't read JSON, so this writes a throwaway
// Nargo package whose tests hold the vectors as literals, as vectors.test.ts
// does, and runs `nargo test` on it.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vite-plus/test";

interface Point {
  readonly x: string;
  readonly y: string;
}
interface MapCase {
  readonly u: string;
  readonly montgomery: { readonly s: string; readonly t: string };
  readonly edwards: Point;
}
interface Vectors {
  readonly format: string;
  readonly poseidon2: {
    readonly permutations: readonly { readonly input: string[]; readonly output: string[] }[];
    readonly sponges: readonly { readonly input: string[]; readonly output: string[] }[];
  };
  readonly tags: Record<"h1" | "h2", { readonly tag: string; readonly field: string }>;
  readonly map: {
    readonly cases: readonly MapCase[];
    readonly exceptional: readonly {
      readonly s: string;
      readonly t: string;
      readonly edwards: Point;
    }[];
  };
  readonly hashes: readonly {
    readonly name: string;
    readonly sigma: string;
    readonly x: string;
    readonly u0: string;
    readonly u1: string;
    readonly map0: MapCase;
    readonly map1: MapCase;
    readonly sum: Point;
    readonly h1: Point;
    readonly sk: string;
    readonly u: Point;
    readonly n: string;
  }[];
}

const ROOT = new URL("../", import.meta.url);
const vectors = JSON.parse(
  readFileSync(new URL("../../docs/spec/vectors/keyed-nullifier-hashes.json", ROOT), "utf8"),
) as Vectors;
const circuitTags = (
  JSON.parse(readFileSync(new URL("../../docs/spec/vectors/circuit.json", ROOT), "utf8")) as {
    tags: readonly { tag: string; field: string }[];
  }
).tags;
const LIB = fileURLToPath(new URL("lib/keyed_nullifier", ROOT));
const BJJ = fileURLToPath(new URL("vendor/oprf-nr/babyjubjub", ROOT));
const read = (f: string) => readFileSync(new URL(f, ROOT), "utf8");

/** `l`, the order of Baby Jubjub's prime-order subgroup ([[keyed-nullifier]]). */
const SUBGROUP_ORDER =
  "2736030358979909402780800718157159386076813972158567259200215660948447373041";
const pt = (p: Point) => `BabyJubJubPoint::new(${p.x}, ${p.y})`;
const xy = (p: Point) => `(${p.x}, ${p.y})`;
/** Asserts a Noir point expression equals a vector point (the type has no `Eq`). */
const eq = (e: string, p: Point) => `{ let q = ${e}; assert((q.x, q.y) == ${xy(p)}); }`;
const arr = (xs: readonly string[]) => `[${xs.join(", ")}]`;
const fn = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

function mapAsserts(m: MapCase): string {
  return `    let (s, t) = map_to_curve_elligator2(${m.u});
    assert((s, t) == (${m.montgomery.s}, ${m.montgomery.t}));
    ${eq(`map(${m.u})`, m.edwards)}`;
}

/** One Noir test per vector, plus the soundness tests for `H2`'s input check. */
function noirTests(): string {
  const out: string[] = [
    `use babyjubjub::BabyJubJubPoint;
use babyjubjub::hash_to_curve::map_to_curve_elligator2;
use keyed_nullifier::{H1_TAG, H2_TAG, h1, h2, map, rational_map::mont_to_edwards, sponge};`,
    `#[test]
fn tags() {
    assert(H1_TAG == ${vectors.tags.h1.field});
    assert(H2_TAG == ${vectors.tags.h2.field});
}`,
  ];
  vectors.poseidon2.permutations.forEach((p, i) =>
    out.push(`#[test]
fn permutation_${i}() {
    assert(std::hash::poseidon2_permutation(${arr(p.input)}) == ${arr(p.output)});
}`),
  );
  vectors.poseidon2.sponges.forEach((s, i) =>
    out.push(`#[test]
fn sponge_${i}() {
    assert(sponge(${arr(s.input)}) == ${arr(s.output)});
}`),
  );
  vectors.map.cases.forEach((m, i) =>
    out.push(`#[test]
fn map_${i}() {
${mapAsserts(m)}
}`),
  );
  vectors.map.exceptional.forEach((e, i) =>
    out.push(`#[test]
fn rational_map_exceptional_${i}() {
    assert(mont_to_edwards(${e.s}, ${e.t}) == (${e.edwards.x}, ${e.edwards.y}));
}`),
  );
  for (const h of vectors.hashes) {
    if (h.map0.u !== h.u0 || h.map1.u !== h.u1) throw new Error(`${h.name}: maps of other u`);
    out.push(`#[test]
fn hashes_${fn(h.name)}() {
    let u = sponge([H1_TAG, ${h.sigma}, ${h.x}]);
    assert((u[0], u[1]) == (${h.u0}, ${h.u1}));
${mapAsserts(h.map0)}
${mapAsserts(h.map1)}
    ${eq(`map(${h.u0}).add(map(${h.u1}))`, h.sum)}
    let p = h1(${h.sigma}, ${h.x});
    ${eq("p", h.h1)}
    assert(p.check_sub_group() & p.is_not_identity());
    let big_u = p.scalar_mul(${h.sk});
    ${eq("big_u", h.u)}
    assert(h2(${h.sigma}, ${h.x}, big_u) == ${h.n});
}`);
  }
  // Soundness of H2's input check (T-03): a point off the curve, and the
  // vector's U plus the point of order 2, which is on the curve and would
  // still satisfy Z = r · U for an even r.
  const h = vectors.hashes[3];
  if (h === undefined) throw new Error("missing hash vector");
  out.push(`#[test(should_fail_with = "U is not on the curve")]
fn h2_refuses_a_point_off_the_curve() {
    let _ = h2(${h.sigma}, ${h.x}, BabyJubJubPoint::new(${h.u.x}, ${h.u.y} + 1));
}`);
  out.push(`#[test(should_fail_with = "U is not in the prime-order subgroup")]
fn h2_refuses_u_plus_a_point_of_order_two() {
    let t = BabyJubJubPoint::new(0, -1);
    assert(t.is_on_curve() & t.double().is_identity());
    let _ = h2(${h.sigma}, ${h.x}, ${pt(h.u)}.add(t));
}`);
  // l · map(7) is a point of order exactly 8, so these cover every torsion
  // order finding A names.
  for (const [order, doublings] of [
    [8, ""],
    [4, ".double()"],
  ] as const) {
    out.push(`#[test(should_fail_with = "U is not in the prime-order subgroup")]
fn h2_refuses_u_plus_a_point_of_order_${order}() {
    let t8 = map(7).scalar_mul(${SUBGROUP_ORDER});
    assert(t8.double().double().is_not_identity() & t8.multiply_by_cofactor().is_identity());
    let _ = h2(${h.sigma}, ${h.x}, ${pt(h.u)}.add(t8${doublings}));
}`);
  }
  out.push(`#[test(should_fail_with = "U is not in the prime-order subgroup")]
fn h2_refuses_a_point_of_order_two() {
    let _ = h2(${h.sigma}, ${h.x}, BabyJubJubPoint::new(0, -1));
}`);
  return `${out.join("\n\n")}\n`;
}

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

// The upstream trees, as `git rev-parse` prints them at the pinned commits
// (README.md, Vendored dependencies). babyjubjub's Nargo.toml is ours (a path
// dependency instead of upstream's git one), so only its src tree is pinned.
const VENDORED = [
  { path: "vendor/oprf-nr/babyjubjub/src/", tree: "4c27dd3b30880bd23c95dd88f0c794a8c9482366" },
  { path: "vendor/noir-poseidon/poseidon2/", tree: "5c72d2098b1b0daefc7eea327302f46774a5eba6" },
  { path: "vendor/noir-poseidon/hash_utils/", tree: "e85d957d3cae9acd652cf09ae676d7dbf9d848b2" },
] as const;

const dir = mkdtempSync(join(tmpdir(), "abolish-keyed-nullifier-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("vendored gadgets", () => {
  test.each(VENDORED)("$path is upstream's tree, unchanged", ({ path, tree }) => {
    // T-55: a change to vendored code can't pass as a refresh of upstream.
    expect(gitTree(new URL(path, ROOT))).toBe(tree);
    expect(read("README.md")).toContain(tree);
  });

  test("babyjubjub takes poseidon2 from the vendored copy, and nothing else", () => {
    expect(read("vendor/oprf-nr/babyjubjub/Nargo.toml")).toBe(
      '[package]\nname = "babyjubjub"\ntype = "lib"\nauthors = [""]\n\n[dependencies]\nposeidon2 = { path = "../../noir-poseidon/poseidon2" }\n',
    );
  });

  test("the copied rational map is the vendored file's text", () => {
    const upstream = read("vendor/oprf-nr/babyjubjub/src/hash_to_curve.nr").split("\n");
    const ours = read("lib/keyed_nullifier/src/rational_map.nr");
    const copied = [upstream.slice(20, 49), upstream.slice(196, 223)].map((l) => l.join("\n"));
    expect(copied[0]).toMatch(/^fn is_zero[\s\S]*fn inverse_or_zero\(x: Field\)[\s\S]*\n}$/);
    expect(copied[1]).toMatch(/^fn rational_map_mont_to_twisted_edwards[\s\S]*\n}$/);
    // The whole file: a comment header, the copied text, and the one wrapper,
    // so nothing can comment the copy out and define a map of its own.
    const [header, rest, ...more] = ours.split(`\n\n${copied[0]}\n\n${copied[1]}\n`);
    expect(more).toEqual([]);
    expect(header?.split("\n").every((l) => l.startsWith("//"))).toBe(true);
    expect(rest).toBe(
      "\n// Ours: the copied function stays private, as upstream has it.\npub fn mont_to_edwards(s: Field, t: Field) -> (Field, Field) {\n    rational_map_mont_to_twisted_edwards(s, t)\n}\n",
    );
  });
});

describe("keyed-nullifier-hashes.json through the Noir library", () => {
  test("the file has the expected format", () => {
    expect(vectors.format).toBe("abolish-keyed-nullifier-hashes-vectors/1");
    expect(vectors.hashes.length).toBe(8);
    expect(vectors.map.cases.some((m) => BigInt(m.u) === 0n)).toBe(true);
  });

  test("the library's tags are circuit.json's", () => {
    // T-30: a tag enters a circuit only as the constant tag_field(tag).
    expect(vectors.tags.h1.tag).toBe("abolish/v1/keyed-nullifier/h1");
    expect(vectors.tags.h2.tag).toBe("abolish/v1/keyed-nullifier/h2");
    for (const k of ["h1", "h2"] as const) {
      const { tag, field } = vectors.tags[k];
      expect(BigInt(circuitTags.find((t) => t.tag === tag)?.field ?? -1)).toBe(BigInt(field));
    }
  });

  test("nargo test passes every vector and refuses U outside the subgroup", () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "Nargo.toml"),
      `[package]\nname = "vectors"\ntype = "lib"\nauthors = [""]\n\n[dependencies]\nkeyed_nullifier = { path = ${JSON.stringify(LIB)} }\nbabyjubjub = { path = ${JSON.stringify(BJJ)} }\n`,
    );
    const src = noirTests();
    writeFileSync(join(dir, "src", "lib.nr"), src);
    const out = execFileSync("nargo", ["test", "--program-dir", dir], { encoding: "utf8" });
    const expected = src.split("#[test").length - 1;
    expect(expected).toBe(
      1 +
        vectors.poseidon2.permutations.length +
        vectors.poseidon2.sponges.length +
        vectors.map.cases.length +
        vectors.map.exceptional.length +
        vectors.hashes.length +
        5,
    );
    expect(out).toContain(`${expected} tests passed`);
  }, 600_000);
});
