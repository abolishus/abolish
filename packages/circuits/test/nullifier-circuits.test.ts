// Runs the query and output circuits on docs/spec/vectors/nullifier-query.json,
// so each opens the commitment, blinds and outputs exactly what the spec and its
// independent Python generator compute (docs/spec/nullifier-query.md; T-03,
// T-21, T-30). The circuits' own `nargo test` holds the soundness tests; this
// adds completeness against the vectors, the public inputs' order in each
// compiled ABI, and the gate counts against gates.json. Noir can't read JSON,
// so, as the other vector tests do, this copies each circuit into a throwaway
// Nargo package with the vectors as literal tests and runs `nargo test` on it.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vite-plus/test";
import { BB } from "../scripts/toolchain.ts";

interface Point {
  readonly x: string;
  readonly y: string;
}
interface Vectors {
  readonly format: string;
  readonly scope: { readonly sigma: string };
  readonly queries: readonly {
    readonly id: string;
    readonly statement: {
      readonly d: readonly string[];
      readonly saltX: string;
      readonly x: string;
      readonly commIn: string;
      readonly r: string;
      readonly b: Point;
    };
    readonly ctx: string;
    readonly q: string;
    readonly queryPublicInputs: readonly string[];
  }[];
  readonly outputs: readonly {
    readonly id: string;
    readonly query: string;
    readonly z: Point;
    readonly u: Point;
    readonly n: string;
    readonly outputPublicInputs: readonly string[];
  }[];
}
interface Abi {
  readonly parameters: readonly { readonly name: string; readonly visibility: string }[];
  readonly return_type: { readonly abi_type: unknown; readonly visibility: string } | null;
}

const ROOT = new URL("../", import.meta.url);
const vectors = JSON.parse(
  readFileSync(new URL("../../docs/spec/vectors/nullifier-query.json", ROOT), "utf8"),
) as Vectors;
const gates = JSON.parse(readFileSync(new URL("gates.json", ROOT), "utf8")) as Record<
  string,
  { acir_opcodes: number; circuit_size: number }
>;
const path = (p: string) => JSON.stringify(fileURLToPath(new URL(p, ROOT)));
const fn = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").toLowerCase();
const queryOf = (id: string) => {
  const q = vectors.queries.find((v) => v.id === id);
  if (q === undefined) throw new Error(`no query ${id}`);
  return q;
};

/** Each circuit's public inputs, in the spec's order, the output last. */
const PUBLIC = {
  nullifier_query: ["sigma", "ctx", "comm_in"],
  nullifier_output: ["sigma", "q", "b_x", "b_y", "z_x", "z_y"],
} as const;
type Circuit = keyof typeof PUBLIC;
/** Each circuit's public output: B as (B.x, B.y), and N. */
const RETURN: Record<Circuit, unknown> = {
  nullifier_query: { kind: "tuple", fields: [{ kind: "field" }, { kind: "field" }] },
  nullifier_output: { kind: "field" },
};

function vectorTests(circuit: Circuit): string {
  const out: string[] = [];
  if (circuit === "nullifier_query") {
    for (const v of vectors.queries) {
      const s = v.statement;
      const inputs = [vectors.scope.sigma, v.ctx, s.commIn];
      expect([...inputs, s.b.x, s.b.y]).toEqual(v.queryPublicInputs);
      out.push(`    #[test]
    fn ${fn(v.id)}() {
        let b = super::main(${inputs.join(", ")}, [${s.d.join(", ")}], ${s.saltX}, ${s.x}, ${s.r});
        assert(b == (${s.b.x}, ${s.b.y}));
    }`);
    }
  } else {
    for (const v of vectors.outputs) {
      const s = queryOf(v.query).statement;
      const inputs = [vectors.scope.sigma, queryOf(v.query).q, s.b.x, s.b.y, v.z.x, v.z.y];
      expect([...inputs, v.n]).toEqual(v.outputPublicInputs);
      out.push(`    #[test]
    fn ${fn(v.id)}() {
        let n = super::main(${inputs.join(", ")}, ${s.x}, ${s.r}, ${v.u.x}, ${v.u.y});
        assert(n == ${v.n});
    }`);
    }
  }
  return `\nmod vectors {\n${out.join("\n\n")}\n}\n`;
}

/** Compiles the circuit as the workspace has it, once; returns its ACIR's path. */
const compiled = (() => {
  const done = new Set<Circuit>();
  return (circuit: Circuit) => {
    if (!done.has(circuit)) {
      execFileSync("nargo", ["compile", "--package", circuit], { cwd: fileURLToPath(ROOT) });
      done.add(circuit);
    }
    return fileURLToPath(new URL(`target/${circuit}.json`, ROOT));
  };
})();

const dir = mkdtempSync(join(tmpdir(), "abolish-nullifier-circuits-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("nullifier-query.json through the circuits", () => {
  test("the file has the expected format", () => {
    expect(vectors.format).toBe("abolish-nullifier-query-vectors/1");
    expect(vectors.queries.length).toBe(2);
    expect(vectors.outputs.length).toBe(2);
  });

  test.each(Object.keys(PUBLIC) as Circuit[])(
    "%s computes every vector's output",
    (circuit) => {
      const pkg = join(dir, circuit);
      mkdirSync(join(pkg, "src"), { recursive: true });
      writeFileSync(
        join(pkg, "Nargo.toml"),
        `[package]\nname = "${circuit}_vectors"\ntype = "bin"\nauthors = [""]\n\n[dependencies]\nbabyjubjub = { path = ${path("vendor/oprf-nr/babyjubjub")} }\nkeyed_nullifier = { path = ${path("lib/keyed_nullifier")} }\n`,
      );
      const tests = vectorTests(circuit);
      writeFileSync(
        join(pkg, "src", "main.nr"),
        readFileSync(new URL(`${circuit}/src/main.nr`, ROOT), "utf8") + tests,
      );
      const out = execFileSync("nargo", ["test", "--program-dir", pkg, "vectors::"], {
        encoding: "utf8",
      });
      expect(out).toContain(`${tests.split("#[test]").length - 1} tests passed`);
    },
    600_000,
  );
});

describe("compiled circuits", () => {
  test.each(Object.keys(PUBLIC) as Circuit[])(
    "%s has the spec's public inputs in order, the output last",
    (circuit) => {
      const { abi } = JSON.parse(readFileSync(compiled(circuit), "utf8")) as { abi: Abi };
      // T-21, T-30: a public input out of the spec's order would bind a proof
      // to another statement than the one the checks pass.
      expect(abi.parameters.filter((p) => p.visibility === "public").map((p) => p.name)).toEqual(
        PUBLIC[circuit],
      );
      expect(abi.parameters.findIndex((p) => p.visibility !== "public")).toBe(
        PUBLIC[circuit].length,
      );
      expect(abi.return_type?.visibility).toBe("public");
      expect(abi.return_type?.abi_type).toEqual(RETURN[circuit]);
    },
    600_000,
  );

  test.each(Object.keys(PUBLIC) as Circuit[])(
    "%s has gates.json's gate count",
    (circuit) => {
      // The circuits skill's snapshot: growth (or a change of gadget) shows up
      // here and in the reviewed diff of gates.json.
      const out = execFileSync(BB, ["gates", "-b", compiled(circuit)], { encoding: "utf8" });
      const counts = (
        JSON.parse(out.slice(out.indexOf("{"))) as {
          functions: { acir_opcodes: number; circuit_size: number }[];
        }
      ).functions;
      expect(counts).toEqual([gates[circuit]]);
    },
    600_000,
  );
});
