// The proof checks and proving of src/ against docs/spec/nullifier-query.md
// and its vectors (from an independent Python generator): the pins
// (keys, reference string, length, zero knowledge) refused when broken; the
// WebAssembly backend under the vendored reference string, with nothing
// downloaded; queries and outputs proved from the vectors' statements to the
// vectors' `B` and `N`; `query-proof` and `output-proof` accepting them and
// refusing any changed public input, proof, length or encoding; proofs the
// pinned bb binary accepts too; and answers only to a query
// whose proof was checked (T-03, T-05, T-21, T-30, T-55).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BjjPoint,
  bjjPoint,
  checkNullifierAnswer,
  decode,
  decodeNullifierOutput,
  decodeNullifierQuery,
  encodeNullifierAnswer,
  encodeNullifierOutput,
  encodeNullifierQuery,
  identityKey,
  type NullifierKey,
  type NullifierQueryRecord,
  type QueryCheckContext,
} from "@abolishus/crypto";
import { p256 } from "@noble/curves/nist.js";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { BB } from "../scripts/toolchain.ts";
import {
  answerQuery,
  checkOutput,
  checkQuery,
  CIRCUITS,
  CRS_SHA256,
  type CheckedQuery,
  type NullifierCircuit,
  NullifierProofs,
  PROOF_LENGTH,
  PROOF_SETTINGS,
  proveOutput,
  type ProvedQuery,
  VK_SHA256,
} from "../src/index.ts";
import { proveQueryWith } from "../src/nullifier.ts";

interface Point {
  readonly x: string;
  readonly y: string;
}
interface Vectors {
  readonly scope: { readonly l2ChainId: string; readonly groupRegistry: string };
  readonly tier2Groups: readonly string[];
  readonly key: {
    readonly keyId: string;
    readonly k: number;
    readonly seats: readonly {
      readonly seat: number;
      readonly sk: string;
      readonly s: string;
      readonly commitment: string;
      readonly signingKey: string;
    }[];
  };
  readonly queries: readonly {
    readonly id: string;
    readonly statement: {
      readonly d: readonly string[];
      readonly saltX: string;
      readonly x: string;
      readonly r: string;
    };
    readonly queryHash: string;
    readonly queryPublicInputs: readonly string[];
    readonly record: string;
  }[];
  readonly outputs: readonly {
    readonly query: string;
    readonly z: Point;
    readonly n: string;
    readonly outputPublicInputs: readonly string[];
    readonly record: string;
  }[];
}

const ROOT = new URL("../", import.meta.url);
const at = (p: string) => fileURLToPath(new URL(p, ROOT));
const vectors = JSON.parse(
  readFileSync(at("../../docs/spec/vectors/nullifier-query.json"), "utf8"),
) as Vectors;
const spec = readFileSync(at("../../docs/spec/nullifier-query.md"), "utf8");
const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const bytes = (h: string) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const point = (h: string): BjjPoint => decode(bjjPoint, bytes(h));
/** BN254's scalar field, the circuits' field. */
const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

const CRS = { g1: readFileSync(at("crs/bn254_g1.dat")), g2: readFileSync(at("crs/bn254_g2.dat")) };
const KEYS = {
  nullifier_query: readFileSync(at("artifacts/nullifier_query.vk")),
  nullifier_output: readFileSync(at("artifacts/nullifier_output.vk")),
};
const PROGRAMS = {
  nullifier_query: JSON.parse(readFileSync(at("artifacts/nullifier_query.json"), "utf8")),
  nullifier_output: JSON.parse(readFileSync(at("artifacts/nullifier_output.json"), "utf8")),
};

const tier2 = new Set(vectors.tier2Groups.map(BigInt));
const CONTEXT: QueryCheckContext = {
  keyId: bytes(vectors.key.keyId),
  l2ChainId: BigInt(vectors.scope.l2ChainId),
  groupRegistry: bytes(vectors.scope.groupRegistry),
  isTier2Group: (id) => tier2.has(id),
};
/** The vectors' key, whose answers in the output vectors its seats signed. */
const VECTOR_KEY: NullifierKey = {
  keyId: bytes(vectors.key.keyId),
  threshold: vectors.key.k,
  signingKeys: vectors.key.seats.map((s) => bytes(s.signingKey)),
  commitments: vectors.key.seats.map((s) => point(s.commitment)),
};
// The vectors don't publish the seats' signing secrets, so the seats here
// sign with keys of their own; the shares, and so every `Z` and `N`, are the
// vectors'.
const SIGNING_SECRETS = vectors.key.seats.map(() => p256.utils.randomSecretKey());
const KEY: NullifierKey = {
  ...VECTOR_KEY,
  signingKeys: SIGNING_SECRETS.map((s) => identityKey(s)),
};
const shareOf = (i: number) => {
  const s = vectors.key.seats[i];
  if (s === undefined) throw new Error(`no seat ${i + 1}`);
  return { seat: s.seat, sk: BigInt(s.sk), s: BigInt(s.s) };
};

// bb.js looks for a reference string under CRS_PATH, and downloads one there
// if it finds none; the proofs here must never reach that code.
const crsPath = join(mkdtempSync(join(tmpdir(), "abolish-bbjs-")), "crs");
process.env["CRS_PATH"] = crsPath;

let proofs: NullifierProofs;
beforeAll(async () => {
  proofs = await NullifierProofs.open({ crs: CRS, keys: KEYS, programs: PROGRAMS });
}, 120_000);
afterAll(async () => {
  await proofs.destroy();
  expect(() => readFileSync(join(crsPath, "bn254_g1.dat"))).toThrow();
  rmSync(join(crsPath, ".."), { recursive: true, force: true });
});

describe("the pins", () => {
  test("the keys' hashes and the proof length are the spec's", () => {
    for (const circuit of CIRCUITS)
      expect(spec).toContain(`${circuit}.vk\` (sha256 \`${VK_SHA256[circuit]}\`)`);
    expect(spec).toContain(`bn254_g1.dat\` (sha256 \`${CRS_SHA256.g1}\`)`);
    expect(spec).toContain(`bn254_g2.dat\` (sha256 \`${CRS_SHA256.g2}\`)`);
    expect(spec).toContain(`exactly ${PROOF_LENGTH.toLocaleString("en-US")} bytes`);
  });

  test("the settings are bb's noir-recursive target with zero knowledge", () => {
    // circuits skill, Rules: the zero-knowledge flavour only (T-13, T-15).
    expect(PROOF_SETTINGS).toEqual({
      ipaAccumulation: false,
      oracleHashType: "poseidon2",
      disableZk: false,
      optimizedSolidityVerifier: false,
    });
    expect(Object.isFrozen(PROOF_SETTINGS)).toBe(true);
  });

  test("Barretenberg is opened only as WebAssembly, without bb.js's own reference string", () => {
    // Explicit, so bb.js neither spawns the native binary (its default in
    // Node) nor fetches a reference string (T-55).
    const src = readFileSync(at("src/proofs.ts"), "utf8");
    const opens = src.match(/Barretenberg\.new\([^)]*\)/g);
    expect(opens).toEqual(["Barretenberg.new({ backend: BackendType.Wasm, skipSrsInit: true })"]);
    expect(src).not.toMatch(/initSRSChonk|initSingleton|Crs\.new|BarretenbergSync/);
  });

  const flip = (b: Uint8Array, i = 0) => {
    const out = Uint8Array.from(b);
    out[i] = (out[i] ?? 0) ^ 1;
    return out;
  };

  test("a reference string file other than the pinned one is refused", async () => {
    await expect(
      NullifierProofs.open({ crs: { ...CRS, g1: flip(CRS.g1, 100) }, keys: KEYS }),
    ).rejects.toThrow("G1");
    await expect(
      NullifierProofs.open({
        crs: { ...CRS, g1: CRS.g1.subarray(0, CRS.g1.length - 64) },
        keys: KEYS,
      }),
    ).rejects.toThrow("G1");
    await expect(
      NullifierProofs.open({ crs: { ...CRS, g2: flip(CRS.g2) }, keys: KEYS }),
    ).rejects.toThrow("G2");
  });

  test.each(CIRCUITS)("a %s key other than the pinned one is refused", async (circuit) => {
    await expect(
      NullifierProofs.open({ crs: CRS, keys: { ...KEYS, [circuit]: flip(KEYS[circuit], 40) } }),
    ).rejects.toThrow(circuit);
    const other = CIRCUITS.find((c) => c !== circuit) ?? circuit;
    await expect(
      NullifierProofs.open({ crs: CRS, keys: { ...KEYS, [circuit]: KEYS[other] } }),
    ).rejects.toThrow(circuit);
  });

  test("a verifier opened without the programs can't prove", async () => {
    const verifier = await NullifierProofs.open({ crs: CRS, keys: KEYS });
    try {
      await expect(verifier.prove("nullifier_query", {})).rejects.toThrow("program");
    } finally {
      await verifier.destroy();
    }
  }, 120_000);
});

const fieldsOf = (record: NullifierQueryRecord) => {
  const { query_id: _id, b: _b, proof: _proof, ...fields } = record;
  return fields;
};

const proved: ProvedQuery[] = [];
const checked: CheckedQuery[] = [];

beforeAll(async () => {
  for (const [i, v] of vectors.queries.entries()) {
    const record = decodeNullifierQuery(bytes(v.record), 1);
    const s = v.statement;
    proved[i] = await proveQueryWith(
      proofs,
      fieldsOf(record),
      {
        d: s.d.map(BigInt) as [bigint, bigint, bigint, bigint],
        saltX: BigInt(s.saltX),
        x: BigInt(s.x),
      },
      record.query_id,
      BigInt(s.r),
    );
  }
}, 300_000);

describe.each(vectors.queries.map((v, i) => ({ ...v, i })))("$id", (v) => {
  const record = decodeNullifierQuery(bytes(v.record), 1);

  test("proves to the vector's B, and so to its query_hash", () => {
    const p = proved[v.i] as ProvedQuery;
    expect(p.record.b.equals(record.b)).toBe(true);
    expect(p.record.proof.length).toBe(PROOF_LENGTH);
    // The vector's record carries a stand-in proof; everything else is equal.
    expect(encodeNullifierQuery({ ...p.record, proof: record.proof })).toEqual(bytes(v.record));
  });

  test("passes the query check, query-proof included", async () => {
    const p = proved[v.i] as ProvedQuery;
    const result = await checkQuery(proofs, CONTEXT, encodeNullifierQuery(p.record));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.queryHash).toEqual(bytes(v.queryHash));
    expect(result.query.sigma).toBe(BigInt(v.queryPublicInputs[0] as string));
    checked[v.i] = result.query;
  });

  test("the proof agrees with the pinned bb binary", () => {
    const p = proved[v.i] as ProvedQuery;
    expect(bbVerify("nullifier_query", v.queryPublicInputs, p.record.proof)).toBe(true);
  });

  test.each([
    ["key_id", { key_id: new Uint8Array(32) }, "query-key"],
    ["group_id", { group_id: 99n }, "query-group"],
    // Only the proof binds these, through ctx and comm_in (T-21, T-30).
    ["commitment", { commitment: 12345n }, "query-proof"],
    ["query_id", { query_id: new Uint8Array(32).fill(7) }, "query-proof"],
    ["comm_in", { comm_in: 12345n }, "query-proof"],
  ] as const)("with %s changed, fails at %s", async (_, change, code) => {
    const p = proved[v.i] as ProvedQuery;
    const result = await checkQuery(
      proofs,
      CONTEXT,
      encodeNullifierQuery({ ...p.record, ...change }),
    );
    expect(result).toEqual({ ok: false, code });
  });

  test("with the other query's B, fails at query-proof", async () => {
    const p = proved[v.i] as ProvedQuery;
    const other = vectors.queries[1 - v.i];
    const b = decodeNullifierQuery(bytes(other?.record ?? ""), 1).b;
    const result = await checkQuery(proofs, CONTEXT, encodeNullifierQuery({ ...p.record, b }));
    expect(result).toEqual({ ok: false, code: "query-proof" });
  });

  test("with the other query's proof, fails at query-proof", async () => {
    const p = proved[v.i] as ProvedQuery;
    const other = proved[1 - v.i];
    if (other === undefined) throw new Error("both queries are proved first");
    const result = await checkQuery(
      proofs,
      CONTEXT,
      encodeNullifierQuery({ ...p.record, proof: other.record.proof }),
    );
    expect(result).toEqual({ ok: false, code: "query-proof" });
  });

  test("with the proof one byte short or long, fails at query-proof", async () => {
    const { record: r } = proved[v.i] as ProvedQuery;
    for (const proof of [r.proof.subarray(1), Uint8Array.from([...r.proof, 0])])
      expect(await checkQuery(proofs, CONTEXT, encodeNullifierQuery({ ...r, proof }))).toEqual({
        ok: false,
        code: "query-proof",
      });
  });
});

/** `bb verify` under the committed key and `crs/`: true only on bb's own acceptance. */
function bbVerify(circuit: NullifierCircuit, inputs: readonly string[], proof: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "abolish-bbjs-verify-"));
  try {
    writeFileSync(join(dir, "proof"), proof);
    writeFileSync(
      join(dir, "inputs"),
      Buffer.concat(
        inputs.map((x) => Buffer.from(BigInt(x).toString(16).padStart(64, "0"), "hex")),
      ),
    );
    const run = spawnSync(
      BB,
      [
        "verify",
        "-p",
        join(dir, "proof"),
        "-i",
        join(dir, "inputs"),
        "-k",
        at(`artifacts/${circuit}.vk`),
        "-t",
        "noir-recursive",
        "-c",
        at("crs"),
      ],
      { encoding: "utf8" },
    );
    return run.status === 0 && `${run.stdout}${run.stderr}`.includes("Proof verified successfully");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("answers", () => {
  test("go only to a query checkQuery passed", () => {
    const q = checked[0] as CheckedQuery;
    // The same fields, but not a checked query (T-21).
    expect(() => answerQuery(KEY, { ...q }, shareOf(0), SIGNING_SECRETS[0] as Uint8Array)).toThrow(
      TypeError,
    );
    // A seat holding shares of another key can't answer it under that one.
    expect(() =>
      answerQuery(
        { ...KEY, keyId: new Uint8Array(32) },
        q,
        shareOf(0),
        SIGNING_SECRETS[0] as Uint8Array,
      ),
    ).toThrow(RangeError);
    const answer = answerQuery(KEY, q, shareOf(0), SIGNING_SECRETS[0] as Uint8Array);
    expect(checkNullifierAnswer(KEY, q, encodeNullifierAnswer(answer)).ok).toBe(true);
  });
});

describe.each(vectors.outputs.map((v, i) => ({ ...v, i })))("output of $query", (v) => {
  const qi = vectors.queries.findIndex((q) => q.id === v.query);
  const x = BigInt(vectors.queries[qi]?.statement.x ?? "0");
  let output: Uint8Array;

  beforeAll(async () => {
    const q = checked[qi] as CheckedQuery;
    // Seats 3 and 1, out of order: proveOutput sorts them.
    const answers = [2, 0].map((i) =>
      answerQuery(KEY, q, shareOf(i), SIGNING_SECRETS[i] as Uint8Array),
    );
    output = encodeNullifierOutput(
      await proveOutput(proofs, KEY, proved[qi] as ProvedQuery, x, answers),
    );
  }, 120_000);

  test("proves to the vector's N", () => {
    const record = decodeNullifierOutput(output, 1);
    expect(record.n).toBe(BigInt(v.n));
    expect(record.answers.map((a) => a.seat)).toEqual([1, 3]);
    expect(record.proof.length).toBe(PROOF_LENGTH);
  });

  test("passes the output check, output-proof included", async () => {
    const result = await checkOutput(proofs, KEY, checked[qi] as CheckedQuery, output);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.z.equals(point(v.z.x.slice(2) + v.z.y.slice(2)))).toBe(true);
  });

  test("its proof checks in the vector's own output, whose answers the vectors' seats signed", async () => {
    // The proof binds σ, q, B, Z and N, not which k answers gave Z.
    const vector = decodeNullifierOutput(bytes(v.record), 1);
    const { proof } = decodeNullifierOutput(output, 1);
    const result = await checkOutput(
      proofs,
      VECTOR_KEY,
      checked[qi] as CheckedQuery,
      encodeNullifierOutput({ ...vector, proof }),
    );
    expect(result.ok).toBe(true);
  });

  test("the proof agrees with the pinned bb binary", () => {
    const { proof } = decodeNullifierOutput(output, 1);
    expect(bbVerify("nullifier_output", v.outputPublicInputs, proof)).toBe(true);
  });

  test("with N changed, fails at output-proof", async () => {
    const record = decodeNullifierOutput(output, 1);
    const result = await checkOutput(
      proofs,
      KEY,
      checked[qi] as CheckedQuery,
      encodeNullifierOutput({ ...record, n: (record.n + 1n) % R }),
    );
    expect(result).toEqual({ ok: false, code: "output-proof" });
  });

  test("against the other query, fails before its proof", async () => {
    const result = await checkOutput(proofs, KEY, checked[1 - qi] as CheckedQuery, output);
    expect(result).toEqual({ ok: false, code: "output-query" });
  });

  test("is checked only against a query checkQuery passed", async () => {
    const q = checked[qi] as CheckedQuery;
    await expect(checkOutput(proofs, KEY, { ...q }, output)).rejects.toThrow(TypeError);
  });

  test("fails under the other output's public inputs", async () => {
    const other = vectors.outputs[1 - v.i];
    if (other === undefined) throw new Error("two outputs expected");
    const { proof } = decodeNullifierOutput(output, 1);
    expect(
      await proofs.verify("nullifier_output", other.outputPublicInputs.map(BigInt), proof),
    ).toBe(false);
  });
});

describe("verify", () => {
  const statement = () => {
    const p = proved[0] as ProvedQuery;
    return {
      inputs: (vectors.queries[0]?.queryPublicInputs ?? []).map(BigInt),
      proof: p.record.proof,
    };
  };

  test("accepts the proof under its own public inputs", async () => {
    const { inputs, proof } = statement();
    expect(await proofs.verify("nullifier_query", inputs, proof)).toBe(true);
  });

  test("refuses it with any one public input changed", async () => {
    const { inputs, proof } = statement();
    for (const i of inputs.keys()) {
      const changed = inputs.map((v, j) => (j === i ? (v + 1n) % R : v));
      expect(await proofs.verify("nullifier_query", changed, proof), `input ${i}`).toBe(false);
    }
  });

  test("refuses it with any one proof element changed", async () => {
    const { inputs, proof } = statement();
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: PROOF_LENGTH / 32 - 1 }),
        fc.bigInt({ min: 1n, max: R - 1n }),
        async (index, delta) => {
          const tampered = Uint8Array.from(proof);
          const slot = tampered.subarray(32 * index, 32 * index + 32);
          const v = (BigInt(`0x${Buffer.from(slot).toString("hex")}`) + delta) % R;
          slot.set(bytes(v.toString(16).padStart(64, "0")));
          expect(await proofs.verify("nullifier_query", inputs, tampered)).toBe(false);
        },
      ),
      { numRuns },
    );
  }, 600_000);

  test("refuses a proof Barretenberg aborts on, and verifies again after it", async () => {
    const { inputs, proof } = statement();
    // Element 317 is a commitment's limb: changed, the point leaves the curve
    // and Barretenberg aborts deserializing it, which replaces the module.
    const tampered = Uint8Array.from(proof);
    tampered[32 * 317 + 31] = (tampered[32 * 317 + 31] ?? 0) ^ 1;
    expect(await proofs.verify("nullifier_query", inputs, tampered)).toBe(false);
    expect(await proofs.verify("nullifier_query", inputs, proof)).toBe(true);
  });

  test("refuses an element encoded at or above r", async () => {
    const { inputs, proof } = statement();
    // Every honest element is canonical.
    for (let i = 0; i < PROOF_LENGTH; i += 32)
      expect(BigInt(`0x${Buffer.from(proof.subarray(i, i + 32)).toString("hex")}`) < R).toBe(true);
    const index = Array.from({ length: PROOF_LENGTH / 32 }, (_, i) => i).find(
      (i) =>
        BigInt(`0x${Buffer.from(proof.subarray(32 * i, 32 * i + 32)).toString("hex")}`) + R <
        2n ** 256n,
    );
    if (index === undefined) throw new Error("no element small enough to re-encode");
    const slot = proof.subarray(32 * index, 32 * index + 32);
    const tampered = Uint8Array.from(proof);
    tampered.set(
      bytes((BigInt(`0x${Buffer.from(slot).toString("hex")}`) + R).toString(16).padStart(64, "0")),
      32 * index,
    );
    expect(await proofs.verify("nullifier_query", inputs, tampered)).toBe(false);
  });

  test("refuses lengths and non-canonical elements before Barretenberg, which a destroyed instance shows", async () => {
    const { inputs, proof } = statement();
    const closed = await NullifierProofs.open({ crs: CRS, keys: KEYS });
    await closed.destroy();
    // Anything that reaches the backend now throws.
    await expect(closed.verify("nullifier_query", inputs, proof)).rejects.toThrow("destroyed");
    const high = Uint8Array.from(proof);
    high.set(
      bytes(
        (BigInt(`0x${Buffer.from(proof.subarray(0, 32)).toString("hex")}`) + R)
          .toString(16)
          .padStart(64, "0"),
      ),
      0,
    );
    expect(BigInt(`0x${Buffer.from(proof.subarray(0, 32)).toString("hex")}`) + R < 2n ** 256n).toBe(
      true,
    );
    expect(await closed.verify("nullifier_query", inputs, high)).toBe(false);
    expect(await closed.verify("nullifier_query", inputs, proof.subarray(32))).toBe(false);
  }, 120_000);

  test("refuses a proof of another length without verifying", async () => {
    const { inputs, proof } = statement();
    for (const p of [
      new Uint8Array(0),
      proof.subarray(32),
      Uint8Array.from([...proof, ...proof.subarray(0, 32)]),
    ])
      expect(await proofs.verify("nullifier_query", inputs, p)).toBe(false);
  });

  test("refuses the proof under the output circuit's key, by its count of public inputs", async () => {
    const { inputs, proof } = statement();
    await expect(proofs.verify("nullifier_output", inputs, proof)).rejects.toThrow(RangeError);
  });

  test("throws on a public input that isn't a field element", async () => {
    const { inputs, proof } = statement();
    await expect(proofs.verify("nullifier_query", [R, ...inputs.slice(1)], proof)).rejects.toThrow(
      RangeError,
    );
    await expect(
      proofs.verify("nullifier_query", [-1n, ...inputs.slice(1)], proof),
    ).rejects.toThrow(RangeError);
  });
});
