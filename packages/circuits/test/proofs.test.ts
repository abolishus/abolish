// Proves both circuits on every vector of docs/spec/vectors/nullifier-query.json
// through bb, under the committed artifacts and the vendored reference string,
// and checks what [[nullifier-query]] asks of the proofs: each verifies under
// its own public inputs, in the spec's order, and fails under any other, `ctx`
// and `q` included though no constraint uses them (T-21, T-30); each has the
// length the proof checks pin; and each is zero knowledge, so two proofs of
// one witness differ (T-03, T-13). Also checks that the committed artifacts
// are what scripts/artifacts.ts builds from the sources (T-55).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BB } from "../scripts/toolchain.ts";
import { CIRCUITS, TARGET, writeArtifacts } from "../scripts/artifacts.ts";

type Circuit = (typeof CIRCUITS)[number];
interface Vectors {
  readonly scope: { readonly sigma: string };
  readonly queries: readonly {
    readonly id: string;
    readonly statement: {
      readonly d: readonly string[];
      readonly saltX: string;
      readonly x: string;
      readonly r: string;
    };
    readonly queryPublicInputs: readonly string[];
  }[];
  readonly outputs: readonly {
    readonly id: string;
    readonly query: string;
    readonly u: { readonly x: string; readonly y: string };
    readonly outputPublicInputs: readonly string[];
  }[];
}

const ROOT = new URL("../", import.meta.url);
const at = (p: string) => fileURLToPath(new URL(p, ROOT));
const vectors = JSON.parse(
  readFileSync(at("../../docs/spec/vectors/nullifier-query.json"), "utf8"),
) as Vectors;

const spec = readFileSync(at("../../docs/spec/nullifier-query.md"), "utf8");
/** A proof's length in bytes: 458 field elements, the same for both circuits. */
const PROOF_LENGTH = 14_656;
/** Each key's sha256, as [[nullifier-query]] (Keys and proofs) pins it. */
const VK_SHA256: Record<(typeof CIRCUITS)[number], string> = {
  nullifier_query: "7acd95ec349d94b384baad47d08a1d7e050f307e997544d5d3fe309d5f1ab1dc",
  nullifier_output: "b953a354fbc14d9c325ef03f311874c82f6b5ee178c16612dd516075de41d8cb",
};
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

interface Statement {
  readonly id: string;
  readonly circuit: Circuit;
  /** The private inputs, by the circuit's parameter names. */
  readonly witness: Record<string, string | readonly string[]>;
  /** Every public input in order, the output's fields last. */
  readonly publicInputs: readonly string[];
}

const statements: Statement[] = [
  ...vectors.queries.map((v): Statement => {
    const s = v.statement;
    return {
      id: v.id,
      circuit: "nullifier_query",
      witness: { d: s.d, s_x: s.saltX, x: s.x, r: s.r },
      publicInputs: v.queryPublicInputs,
    };
  }),
  ...vectors.outputs.map((v): Statement => {
    const s = vectors.queries.find((q) => q.id === v.query)?.statement;
    if (s === undefined) throw new Error(`no query ${v.query}`);
    return {
      id: v.id,
      circuit: "nullifier_output",
      witness: { x: s.x, r: s.r, u_x: v.u.x, u_y: v.u.y },
      publicInputs: v.outputPublicInputs,
    };
  }),
];

/** The public inputs' parameter names, in order. */
const PUBLIC_NAMES: Record<Circuit, readonly string[]> = {
  nullifier_query: ["sigma", "ctx", "comm_in"],
  nullifier_output: ["sigma", "q", "b_x", "b_y", "z_x", "z_y"],
};
/** Every public value a proof binds: the inputs, then the output's fields. */
const PUBLIC_VALUES: Record<Circuit, readonly string[]> = {
  nullifier_query: [...PUBLIC_NAMES.nullifier_query, "B.x", "B.y"],
  nullifier_output: [...PUBLIC_NAMES.nullifier_output, "N"],
};

const dir = mkdtempSync(join(tmpdir(), "abolish-circuit-proofs-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterAll(() => {
  // bb fetches points over the network when crs/ holds too few; after every
  // proof here, crs/ must still hold only the vendored files (and bb's lock).
  expect(readdirSync(at("crs")).filter((f) => f !== "crs.lock")).toEqual([
    "bn254_g1.dat",
    "bn254_g2.dat",
  ]);
});

const toml = (v: string | readonly string[]) =>
  typeof v === "string" ? JSON.stringify(v) : `[${v.map((e) => JSON.stringify(e)).join(", ")}]`;

/** The statement's witness from `nargo execute` on a copy of its circuit. */
function witness(s: Statement): string {
  const pkg = join(dir, `${s.id}-pkg`);
  mkdirSync(join(pkg, "src"), { recursive: true });
  const deps = readFileSync(at(`${s.circuit}/Nargo.toml`), "utf8").replace(
    /path = "\.\.\/([^"]+)"/g,
    (_, p: string) => `path = ${JSON.stringify(at(p))}`,
  );
  writeFileSync(join(pkg, "Nargo.toml"), deps);
  writeFileSync(join(pkg, "src", "main.nr"), readFileSync(at(`${s.circuit}/src/main.nr`)));
  const inputs = Object.entries(s.witness);
  PUBLIC_NAMES[s.circuit].forEach((name, i) => inputs.push([name, s.publicInputs[i] ?? ""]));
  writeFileSync(join(pkg, "Prover.toml"), inputs.map(([k, v]) => `${k} = ${toml(v)}\n`).join(""));
  const file = join(pkg, "target", "witness.gz");
  if (!existsSync(file)) {
    execFileSync("nargo", ["execute", "--program-dir", pkg, "witness"], { stdio: "pipe" });
  }
  return file;
}

const bbArgs = (circuit: Circuit) => [
  "-k",
  at(`artifacts/${circuit}.vk`),
  "-t",
  TARGET,
  "-c",
  at("crs"),
];

function prove(s: Statement, name: string): { proof: string; publicInputs: string } {
  const out = join(dir, `${s.id}-${name}`);
  execFileSync(
    BB,
    [
      "prove",
      "-b",
      at(`artifacts/${s.circuit}.json`),
      "-w",
      witness(s),
      "-o",
      out,
      ...bbArgs(s.circuit),
    ],
    { stdio: "pipe" },
  );
  return { proof: join(out, "proof"), publicInputs: join(out, "public_inputs") };
}

let files = 0;
/**
 * `bb verify` of the proof under these public inputs and the circuit's key:
 * `accepted`, `rejected` (the verifier ran and refused it) or `error` (bb
 * stopped before verifying), with bb's output. Telling the last two apart
 * keeps a test that expects a refusal from passing on a bad path or input.
 */
function verify(
  proof: string | Uint8Array,
  publicInputs: readonly string[],
  circuit: Circuit,
): { verdict: "accepted" | "rejected" | "error"; output: string } {
  const n = files++;
  const inputs = join(dir, `inputs-${n}`);
  writeFileSync(inputs, Buffer.concat(publicInputs.map((v) => field(v))));
  let path = proof;
  if (typeof proof !== "string") {
    path = join(dir, `proof-${n}`);
    writeFileSync(path, proof);
  }
  const run = spawnSync(BB, ["verify", "-p", path as string, "-i", inputs, ...bbArgs(circuit)], {
    encoding: "utf8",
  });
  const output = `${run.stdout}${run.stderr}`;
  if (run.status === 0 && output.includes("Proof verified successfully")) {
    return { verdict: "accepted", output };
  }
  if (run.status !== 0 && output.includes("Proof verification failed")) {
    return { verdict: "rejected", output };
  }
  return { verdict: "error", output };
}
const verdict = (...args: Parameters<typeof verify>) => verify(...args).verdict;

/** BN254's scalar field, the circuits' field. */
const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const field = (v: string) => Buffer.from(BigInt(v).toString(16).padStart(64, "0"), "hex");
const hex = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const other = (v: string) => hex((BigInt(v) + 1n) % R);
const fields = (file: string) => {
  const b = readFileSync(file);
  return Array.from({ length: b.length / 32 }, (_, i) =>
    hex(BigInt(`0x${b.subarray(32 * i, 32 * i + 32).toString("hex")}`)),
  );
};

describe("the committed artifacts", () => {
  test.each(CIRCUITS)("%s.vk has the spec's sha256", (circuit) => {
    const hash = createHash("sha256")
      .update(readFileSync(at(`artifacts/${circuit}.vk`)))
      .digest("hex");
    expect(hash).toBe(VK_SHA256[circuit]);
    expect(spec).toContain(`${circuit}.vk\` (sha256 \`${hash}\`)`);
  });

  test("the proof length is the spec's", () => {
    expect(spec).toContain(`exactly ${PROOF_LENGTH.toLocaleString("en-US")} bytes`);
  });

  test("are what scripts/artifacts.ts builds", () => {
    const out = join(dir, "artifacts");
    writeArtifacts(out);
    expect(readdirSync(out).sort()).toEqual(readdirSync(at("artifacts")).sort());
    for (const f of readdirSync(out)) {
      expect(readFileSync(join(out, f)).equals(readFileSync(at(`artifacts/${f}`))), f).toBe(true);
    }
  }, 600_000);
});

describe.each(statements)("$id: a proof of $circuit", (s) => {
  let first: { proof: string; publicInputs: string };
  beforeAll(() => {
    first = prove(s, "a");
  }, 600_000);

  test("has the spec's public inputs and the pinned length", () => {
    expect(fields(first.publicInputs)).toEqual(s.publicInputs.map((v) => hex(BigInt(v))));
    expect(readFileSync(first.proof).length).toBe(PROOF_LENGTH);
  });

  test("verifies under its own public inputs", () => {
    expect(verdict(first.proof, s.publicInputs, s.circuit)).toBe("accepted");
  });

  // `ctx` and `q` among them, though they enter no constraint: only the
  // proof binds them ([[nullifier-query]], Query circuit).
  test.each(PUBLIC_VALUES[s.circuit].map((name, i) => ({ name, i })))(
    "fails with $name changed",
    ({ i }) => {
      const changed = s.publicInputs.map((v, j) => (j === i ? other(v) : v));
      expect(verdict(first.proof, changed, s.circuit)).toBe("rejected");
    },
  );

  test("fails with any one proof field changed", () => {
    const proof = new Uint8Array(readFileSync(first.proof));
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: PROOF_LENGTH / 32 - 1 }),
        fc.bigInt({ min: 1n, max: R - 1n }),
        (index, delta) => {
          const tampered = proof.slice();
          const slot = tampered.subarray(32 * index, 32 * index + 32);
          slot.set(field(hex((BigInt(`0x${Buffer.from(slot).toString("hex")}`) + delta) % R)));
          expect(verdict(tampered, s.publicInputs, s.circuit)).not.toBe("accepted");
        },
      ),
      { numRuns },
    );
  }, 600_000);

  test("fails under the other circuit's key", () => {
    // The keys differ in their count of public inputs, so bb refuses before
    // verifying; under a key of the same count it would be a rejection.
    const another = CIRCUITS.find((c) => c !== s.circuit) ?? s.circuit;
    const { verdict, output } = verify(first.proof, s.publicInputs, another);
    expect(verdict).toBe("error");
    expect(output).toContain("num_public_inputs mismatch");
  });

  test("differs from a second proof of the same witness, which also verifies", () => {
    // The zero-knowledge prover masks the witness with fresh randomness, so
    // its proofs of one witness differ; a proof without it is a function of
    // the witness (circuits skill, Rules; T-13).
    const second = prove(s, "b");
    expect(readFileSync(second.proof).equals(readFileSync(first.proof))).toBe(false);
    expect(verdict(second.proof, s.publicInputs, s.circuit)).toBe("accepted");
  });
});

test("the other vector's public inputs fail each proof", () => {
  for (const circuit of CIRCUITS) {
    const [a, b] = statements.filter((s) => s.circuit === circuit);
    if (a === undefined || b === undefined) throw new Error(`${circuit}: two vectors expected`);
    expect(verdict(prove(a, "x").proof, b.publicInputs, circuit)).toBe("rejected");
  }
}, 600_000);
