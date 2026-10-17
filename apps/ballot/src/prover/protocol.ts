// The messages to and from the prover worker, which runs snarkjs in a realm
// of its own (ADR 0009, Amendment of 2026-10-17). The page starts one prover
// worker per proof and hands it the proving key, the witness calculator and
// one end of a MessageChannel whose other end goes to the ballot worker. The
// witness, built from the identity secret, travels from the ballot worker to
// the prover over that channel and the proof travels back, so neither passes
// through the page; the prover tells the page only how far it has got.
// Nothing a prover sends is trusted: the ballot worker verifies its proof
// against inputs it computed and re-randomises it (T-12, T-55).

import type { MembershipWitness } from "@abolishus/crypto";

export const PROVER_PROTOCOL_VERSION = 1;

/** Page to prover, once: the artifacts the page fetched and checked, and the ballot worker's port. */
export interface ProverStart {
  readonly v: typeof PROVER_PROTOCOL_VERSION;
  readonly kind: "start";
  readonly zkey: Uint8Array;
  readonly wasm: Uint8Array;
  readonly ballot: MessagePort;
}

/** Prover to page: `done` of `of` steps have happened (never elapsed time). */
export interface ProverProgress {
  readonly v: typeof PROVER_PROTOCOL_VERSION;
  readonly kind: "progress";
  readonly done: number;
  readonly of: number;
}

/** Ballot worker to prover, once, over the channel. */
export interface ProverWitness {
  readonly v: typeof PROVER_PROTOCOL_VERSION;
  readonly kind: "witness";
  readonly witness: MembershipWitness;
}

/**
 * Prover to ballot worker, once, over the channel: the proof's 256 bytes, an
 * artifact the prover refused by its pinned sha256, or a bare failure, which
 * names no detail that could quote the secret.
 */
export type ProverAnswer =
  | {
      readonly v: typeof PROVER_PROTOCOL_VERSION;
      readonly kind: "proof";
      readonly proof: Uint8Array;
    }
  | {
      readonly v: typeof PROVER_PROTOCOL_VERSION;
      readonly kind: "refused";
      readonly problem: "zkey" | "wasm";
    }
  | { readonly v: typeof PROVER_PROTOCOL_VERSION; readonly kind: "error" };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const hasKeys = (data: Record<string, unknown>, expected: readonly string[]) => {
  const keys = Object.keys(data).sort();
  return keys.length === expected.length && keys.every((k, i) => k === expected[i]);
};

const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const isDecimal = (x: unknown): x is string => typeof x === "string" && DECIMAL.test(x);

const WITNESS_KEYS = [
  "merkleProofIndex",
  "merkleProofLength",
  "merkleProofSiblings",
  "message",
  "scope",
  "secret",
];

export function parseStart(data: unknown): ProverStart | undefined {
  if (!isRecord(data) || data["v"] !== PROVER_PROTOCOL_VERSION || data["kind"] !== "start")
    return undefined;
  if (!hasKeys(data, ["ballot", "kind", "v", "wasm", "zkey"])) return undefined;
  const { zkey, wasm, ballot } = data;
  if (!(zkey instanceof Uint8Array) || !(wasm instanceof Uint8Array)) return undefined;
  if (!(ballot instanceof MessagePort)) return undefined;
  return { v: PROVER_PROTOCOL_VERSION, kind: "start", zkey, wasm, ballot };
}

export function parseProgress(data: unknown): ProverProgress | undefined {
  if (!isRecord(data) || data["v"] !== PROVER_PROTOCOL_VERSION || data["kind"] !== "progress")
    return undefined;
  if (!hasKeys(data, ["done", "kind", "of", "v"])) return undefined;
  const { done, of } = data;
  if (!Number.isSafeInteger(of) || !Number.isSafeInteger(done)) return undefined;
  if ((of as number) < 1 || (done as number) < 0 || (done as number) > (of as number))
    return undefined;
  return { v: PROVER_PROTOCOL_VERSION, kind: "progress", done: done as number, of: of as number };
}

/** A witness the prover takes: exact keys, every value a decimal string, as snarkjs takes them. */
export function parseWitness(data: unknown): ProverWitness | undefined {
  if (!isRecord(data) || data["v"] !== PROVER_PROTOCOL_VERSION || data["kind"] !== "witness")
    return undefined;
  if (!hasKeys(data, ["kind", "v", "witness"])) return undefined;
  const w = data["witness"];
  if (!isRecord(w) || !hasKeys(w, WITNESS_KEYS)) return undefined;
  const { secret, merkleProofLength, merkleProofIndex, merkleProofSiblings, scope, message } = w;
  if (
    !isDecimal(secret) ||
    !isDecimal(merkleProofLength) ||
    !isDecimal(merkleProofIndex) ||
    !Array.isArray(merkleProofSiblings) ||
    !merkleProofSiblings.every(isDecimal) ||
    !isDecimal(scope) ||
    !isDecimal(message)
  )
    return undefined;
  return {
    v: PROVER_PROTOCOL_VERSION,
    kind: "witness",
    witness: {
      secret,
      merkleProofLength,
      merkleProofIndex,
      merkleProofSiblings: merkleProofSiblings as string[],
      scope,
      message,
    },
  };
}

export function parseAnswer(data: unknown): ProverAnswer | undefined {
  if (!isRecord(data) || data["v"] !== PROVER_PROTOCOL_VERSION) return undefined;
  const v = PROVER_PROTOCOL_VERSION;
  if (data["kind"] === "proof" && hasKeys(data, ["kind", "proof", "v"])) {
    const { proof } = data;
    return proof instanceof Uint8Array ? { v, kind: "proof", proof } : undefined;
  }
  if (data["kind"] === "refused" && hasKeys(data, ["kind", "problem", "v"])) {
    const { problem } = data;
    return problem === "zkey" || problem === "wasm" ? { v, kind: "refused", problem } : undefined;
  }
  if (data["kind"] === "error" && hasKeys(data, ["kind", "v"])) return { v, kind: "error" };
  return undefined;
}
