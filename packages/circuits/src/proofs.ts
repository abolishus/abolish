// The nullifier circuits' proofs through @aztec/bb.js, held to what
// docs/spec/nullifier-query.md (Keys and proofs) pins: UltraHonk in its
// zero-knowledge flavour with bb's `noir-recursive` settings, each circuit's
// verification key by its sha256, the vendored Ignition reference string by its
// sha256, and a proof of exactly 14,656 bytes. Barretenberg runs only as
// WebAssembly, never the native binary bb.js would otherwise spawn, and is
// handed the reference string the caller read, so nothing is downloaded (T-05,
// T-21, T-55). This file uses no node built-ins, so it runs in a browser worker
// as in a seat's process; the caller reads the files.

import { BackendType, Barretenberg, BBApiException } from "@aztec/bb.js";
import { type CompiledCircuit, Noir } from "@noir-lang/noir_js";

export const CIRCUITS = ["nullifier_query", "nullifier_output"] as const;
export type NullifierCircuit = (typeof CIRCUITS)[number];

/** Each verification key's sha256, as [[nullifier-query]] (Keys and proofs) pins it. */
export const VK_SHA256: Readonly<Record<NullifierCircuit, string>> = {
  nullifier_query: "7acd95ec349d94b384baad47d08a1d7e050f307e997544d5d3fe309d5f1ab1dc",
  nullifier_output: "b953a354fbc14d9c325ef03f311874c82f6b5ee178c16612dd516075de41d8cb",
};

/** The reference string's files' sha256 (`crs/bn254_g1.dat`, `crs/bn254_g2.dat`). */
export const CRS_SHA256 = {
  g1: "50d2f4e9567be2b8e382cedfd078b96a3428a94597b7e88c4116e105d578ce77",
  g2: "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f",
} as const;

/** A proof's length in bytes: 458 field elements, the same for both circuits. */
export const PROOF_LENGTH = 14_656;

/** Public inputs per circuit, the outputs' fields included. */
export const PUBLIC_INPUTS: Readonly<Record<NullifierCircuit, number>> = {
  nullifier_query: 5,
  nullifier_output: 7,
};

/**
 * bb's `noir-recursive` target: a Poseidon2 transcript, no IPA accumulation,
 * zero knowledge. The ZK flag is spelled out rather than left to a default,
 * so a test can hold it (circuits skill, Rules; T-13, T-15).
 */
export const PROOF_SETTINGS = Object.freeze({
  ipaAccumulation: false,
  oracleHashType: "poseidon2",
  disableZk: false,
  optimizedSolidityVerifier: false,
});

/** BN254's scalar field, the circuits' field. */
const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/** The vendored reference string: `2¹⁵` uncompressed G1 powers and `[x]₂`. */
export interface ReferenceString {
  readonly g1: Uint8Array;
  readonly g2: Uint8Array;
}

/** Both circuits' compiled programs, which only a prover needs. */
export type NullifierPrograms = Readonly<Record<NullifierCircuit, CompiledCircuit>>;

export interface ProofsOptions {
  readonly crs: ReferenceString;
  /** Each circuit's verification key; refused unless it has its pinned sha256. */
  readonly keys: Readonly<Record<NullifierCircuit, Uint8Array>>;
  readonly programs?: NullifierPrograms;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))));
}

function fieldBytes(v: bigint): Uint8Array {
  if (typeof v !== "bigint" || v < 0n || v >= R)
    throw new RangeError("a public input must be a field element below BN254's r");
  const out = new Uint8Array(32);
  for (let i = 31, x = v; i >= 0; i--, x >>= 8n) out[i] = Number(x & 0xffn);
  return out;
}

function fieldValue(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([Uint8Array.from(bytes)])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A program's ACIR, as its `bytecode` carries it: base64 of gzip. */
async function acir(program: CompiledCircuit): Promise<Uint8Array> {
  return gunzip(Uint8Array.from(atob(program.bytecode), (c) => c.charCodeAt(0)));
}

/**
 * A WebAssembly Barretenberg with the reference string loaded. `backend` set
 * means exactly this one, with no fallback to the native binary; skipSrsInit
 * stops bb.js from looking for (and downloading) a reference string itself.
 */
async function wasmBackend(crs: ReferenceString): Promise<Barretenberg> {
  const api = await Barretenberg.new({ backend: BackendType.Wasm, skipSrsInit: true });
  try {
    await api.srsInitSrs({
      pointsBuf: Uint8Array.from(crs.g1),
      numPoints: crs.g1.length / 64,
      g2Point: Uint8Array.from(crs.g2),
    });
  } catch (e) {
    await api.destroy();
    throw e;
  }
  return api;
}

/**
 * Barretenberg under the pinned keys and reference string. One instance holds
 * a WebAssembly module of its own and runs one call at a time; `destroy`
 * releases it.
 */
export class NullifierProofs {
  #api: Barretenberg;
  readonly #crs: ReferenceString;
  readonly #keys: Readonly<Record<NullifierCircuit, Uint8Array>>;
  readonly #programs: NullifierPrograms | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  private constructor(
    api: Barretenberg,
    crs: ReferenceString,
    keys: Readonly<Record<NullifierCircuit, Uint8Array>>,
    programs: NullifierPrograms | undefined,
  ) {
    this.#api = api;
    this.#crs = crs;
    this.#keys = keys;
    this.#programs = programs;
  }

  /**
   * Checks every file against its pin before Barretenberg sees it, then loads
   * the reference string into a WebAssembly backend. A file without its pinned
   * hash is an error, never a fallback to bb.js's own download (T-05, T-55).
   */
  static async open(options: ProofsOptions): Promise<NullifierProofs> {
    const { programs } = options;
    // Copies, so the files checked are the files used.
    const crs = { g1: Uint8Array.from(options.crs.g1), g2: Uint8Array.from(options.crs.g2) };
    if ((await sha256(crs.g1)) !== CRS_SHA256.g1)
      throw new RangeError("the reference string's G1 file isn't the pinned one");
    if ((await sha256(crs.g2)) !== CRS_SHA256.g2)
      throw new RangeError("the reference string's G2 file isn't the pinned one");
    const keys = {} as Record<NullifierCircuit, Uint8Array>;
    for (const circuit of CIRCUITS) {
      const key = Uint8Array.from(options.keys[circuit]);
      if ((await sha256(key)) !== VK_SHA256[circuit])
        throw new RangeError(`${circuit}: the verification key isn't the pinned one`);
      keys[circuit] = key;
    }
    return new NullifierProofs(await wasmBackend(crs), crs, Object.freeze(keys), programs);
  }

  /** Runs `call` after every earlier one, so a reset never cuts a call short. */
  #serial<T>(call: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(call);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  /**
   * Replaces the module after an abort. Barretenberg aborts by throwing
   * through WebAssembly, which skips its destructors and frees, so a module
   * that aborted may leak or hold half-updated state; a seat fed malformed
   * proofs would otherwise grow without bound.
   */
  async #reset(): Promise<void> {
    const old = this.#api;
    this.#api = await wasmBackend(this.#crs);
    await old.destroy().catch(() => undefined);
  }

  /**
   * Whether `proof` verifies under the circuit's pinned key with these public
   * inputs, in the circuit's order, which the caller builds from the records
   * and its own recomputation, never from the prover ([[nullifier-query]],
   * Keys and proofs). A proof of another length, or with an element that
   * isn't a canonical field element, is refused before Barretenberg sees it;
   * one Barretenberg aborts on (a point off the curve) is refused too.
   */
  verify(
    circuit: NullifierCircuit,
    publicInputs: readonly bigint[],
    proof: Uint8Array,
  ): Promise<boolean> {
    if (publicInputs.length !== PUBLIC_INPUTS[circuit])
      return Promise.reject(
        new RangeError(`${circuit}: expected ${PUBLIC_INPUTS[circuit]} public inputs`),
      );
    let inputs: Uint8Array[];
    try {
      inputs = publicInputs.map(fieldBytes);
    } catch (e) {
      return Promise.reject(e);
    }
    if (!(proof instanceof Uint8Array) || proof.length !== PROOF_LENGTH)
      return Promise.resolve(false);
    const elements: Uint8Array[] = [];
    for (let i = 0; i < PROOF_LENGTH; i += 32) {
      const element = proof.slice(i, i + 32);
      // One encoding per proof: bb would read an element at or above r
      // modulo r.
      if (fieldValue(element) >= R) return Promise.resolve(false);
      elements.push(element);
    }
    return this.#serial(async () => {
      try {
        const { verified } = await this.#api.circuitVerify({
          verificationKey: this.#keys[circuit],
          publicInputs: inputs,
          proof: elements,
          settings: PROOF_SETTINGS,
        });
        return verified;
      } catch (e) {
        // The inputs were checked above, so what remains is Barretenberg
        // refusing the proof's contents: a refusal of the proof.
        if (!(e instanceof BBApiException)) await this.#reset();
        return false;
      }
    });
  }

  /**
   * Proves `circuit` on `inputs` (its parameters by name, as decimal or `0x`
   * strings): the witness from noir_js, the proof from Barretenberg under the
   * pinned key. Returns the public inputs in order, the outputs' fields last,
   * and the proof, which is checked against them before it is returned, so a
   * wrong program or a prover fault is an error here rather than a refusal
   * at the seat.
   */
  async prove(
    circuit: NullifierCircuit,
    inputs: Readonly<Record<string, string | readonly string[]>>,
  ): Promise<{ readonly publicInputs: readonly bigint[]; readonly proof: Uint8Array }> {
    const program = this.#programs?.[circuit];
    if (program === undefined) throw new Error(`${circuit}: opened without its program`);
    const { witness } = await new Noir(program).execute(
      inputs as Record<string, string | string[]>,
    );
    const command = {
      witness: await gunzip(witness),
      circuit: {
        name: circuit,
        bytecode: await acir(program),
        verificationKey: this.#keys[circuit],
      },
      settings: PROOF_SETTINGS,
    };
    const result = await this.#serial(async () => {
      try {
        return await this.#api.circuitProve(command);
      } catch (e) {
        if (!(e instanceof BBApiException)) await this.#reset();
        throw e;
      }
    });
    const publicInputs = result.publicInputs.map(fieldValue);
    const proof = new Uint8Array(result.proof.length * 32);
    result.proof.forEach((element, i) => proof.set(element, 32 * i));
    if (!(await this.verify(circuit, publicInputs, proof)))
      throw new Error(`${circuit}: the proof doesn't verify under the pinned key`);
    return { publicInputs, proof };
  }

  destroy(): Promise<void> {
    return this.#serial(() => this.#api.destroy());
  }
}
