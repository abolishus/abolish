import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import { expect } from "vite-plus/test";
import {
  type ContractEventRecord,
  decodeElectionDefinition,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV7,
  electionDefinitionHash,
  electionDefinitionV5Hash,
  electionDefinitionV7Hash,
  electionStubHash,
  electionStubV5Hash,
  electionStubV7Hash,
  encodeElectionDefinition,
  encodeElectionDefinitionV5,
  encodeElectionDefinitionV7,
  type ElectionDefinition,
  type ElectionDefinitionV5,
  type ElectionDefinitionV7,
} from "@abolishus/crypto";
import type { RegistrationRelease } from "../src/index.ts";
import { definitionOf, hex, read, word } from "./registry-logs.ts";

// The election registry's `DefinitionRegistered` and the trustee registry's
// `CeremonyRegistered` as the registries log them, for the registration
// check (docs/spec/verifier.md, Registration) here and the trustee node's.
// Topic 0 of each comes from contract-event-v8.json's independent generator,
// and the key set, its hash and the approvals' signatures from
// key-set.json's, never from the code under test (T-34, T-37, T-71).

const events = read<{
  readonly events: readonly { readonly signature: string; readonly topic0: string }[];
}>("contract-event-v8.json");
const topic0 = (signature: string) => {
  const found = events.events.find((e) => e.signature === signature);
  if (found === undefined) throw new Error(`no event ${signature}`);
  expect(Buffer.from(keccak_256(new TextEncoder().encode(signature))).toString("hex")).toBe(
    found.topic0,
  );
  return hex(found.topic0);
};
export const DEFINITION_REGISTERED = topic0(
  "DefinitionRegistered(bytes32,bytes32,uint64,uint64,bytes32,bytes)",
);
export const CEREMONY_REGISTERED = topic0("CeremonyRegistered(bytes32,bytes32,bytes32,bytes)");

const keySets = read<{
  readonly keySets: readonly {
    readonly id: string;
    readonly keySetHash: string;
    readonly entries: readonly {
      readonly index: number;
      readonly kemKeyHash: string;
      readonly x: string;
      readonly y: string;
    }[];
  }[];
  readonly statements: readonly {
    readonly keySet: string;
    readonly stubHash: string;
    readonly index: number;
    readonly signature: string;
  }[];
}>("key-set.json");
const keySetOf = (id: string) => {
  const found = keySets.keySets.find((k) => k.id === id);
  if (found === undefined) throw new Error(`no key set ${id}`);
  return found;
};
const seven = keySetOf("key-set-7");
const sixOfSeven = keySetOf("key-set-6-of-7");
/** key-set-7's hash, as key-set.json states it. */
export const KEY_SET = hex(seven.keySetHash);
/** Another key set's (key-set-6-of-7's) hash. */
export const OTHER_KEY_SET = hex(sixOfSeven.keySetHash);

// Four of the seats' approvals of key-set-7 for one stub: signatures in the
// form the record takes; the check reads none of them (the registry did).
const firstStub = keySets.statements.find((s) => s.keySet === "key-set-7")?.stubHash;
const approvals = keySets.statements
  .filter((s) => s.keySet === "key-set-7" && s.stubHash === firstStub)
  .slice(0, 4);

const typicalV1 = decodeElectionDefinition(
  definitionOf("election-definition.json", "definition-typical"),
);
const typicalV5 = decodeElectionDefinitionV5(
  definitionOf("election-definition-v5.json", "definition-v5-typical"),
);
const typicalV7 = decodeElectionDefinitionV7(
  definitionOf("election-definition-v7.json", "definition-v7-rolling-typical"),
);
/** The vectors' typical definition with the contract-event pin at `version`. */
const pinned = <D extends ElectionDefinition | ElectionDefinitionV5 | ElectionDefinitionV7>(
  d: D,
  version: number,
): D => ({
  ...d,
  profile: {
    ...d.profile,
    pins: d.profile.pins.map((p) => (p.record_type === 8 ? { ...p, version } : p)),
  },
});
export const v1Definition = (version = 1) => ({
  version: 1 as const,
  value: pinned(typicalV1, version),
});
export const v5Definition = (version = 8) => ({
  version: 5 as const,
  value: pinned(typicalV5, version),
});
// Version 7's own registration reads only under contract-event version 13
// (docs/spec/contracts.md, Event tables (version 13)).
export const v7Definition = (version = 13) => ({
  version: 7 as const,
  value: pinned(typicalV7, version),
});
export type Definition = ReturnType<typeof v1Definition> | ReturnType<typeof v5Definition>;
/** `Definition`, or a version 7, which only this package's registration check reads. */
export type AnyDefinition = Definition | ReturnType<typeof v7Definition>;

export const releaseOf = (d: AnyDefinition): RegistrationRelease => ({
  chainId: d.value.l2_chain_id,
  electionRegistry: d.value.election_registry,
  trusteeRegistry: d.value.trustee_registry,
});

export const encodingOf = (d: AnyDefinition) =>
  d.version === 1
    ? encodeElectionDefinition(d.value)
    : d.version === 5
      ? encodeElectionDefinitionV5(d.value)
      : encodeElectionDefinitionV7(d.value);
export const hashOf = (d: AnyDefinition) =>
  d.version === 1
    ? electionDefinitionHash(d.value)
    : d.version === 5
      ? electionDefinitionV5Hash(d.value)
      : electionDefinitionV7Hash(d.value);
export const stubOf = (d: AnyDefinition) =>
  d.version === 1
    ? electionStubHash(d.value)
    : d.version === 5
      ? electionStubV5Hash(d.value)
      : electionStubV7Hash(d.value);

const abiBytes = (b: Uint8Array) => {
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
  padded.set(b);
  return concatBytes(word(32n), word(BigInt(b.length)), padded);
};

const base = (contract: Uint8Array, block: bigint) => ({
  contract,
  n: 0n,
  l2_block: block,
  l2_timestamp: 0n,
});

/** `DefinitionRegistered` for `d`'s election, logging `encoding` (by default `d`'s own) under `hash`. */
export function definitionRegistered(
  d: AnyDefinition,
  encoding = encodingOf(d),
  hash = hashOf(d),
  block = 20n,
): ContractEventRecord {
  return {
    ...base(d.value.election_registry, block),
    topics: [DEFINITION_REGISTERED, d.value.election_id, hash],
    data: concatBytes(
      word(5n),
      word(1_760_000_000n),
      new Uint8Array(32).fill(0xab),
      word(128n),
      abiBytes(encoding).subarray(32),
    ),
  };
}

export interface CeremonyFields {
  readonly panelId: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly transcriptHash: Uint8Array;
  /** The key set's vector id; under contract-event version 1 no key set is logged. */
  readonly keySet: "key-set-7" | "key-set-6-of-7";
  readonly version: number;
}

/**
 * `CeremonyRegistered` for `d`'s ceremony as the trustee registry logs it
 * under contract-event `version` (1: header and approvals; 2 on: with the
 * key set), with `changes` to the topics or the record.
 */
export function ceremonyRegistered(
  d: AnyDefinition,
  changes: Partial<CeremonyFields> & { readonly header?: Partial<CeremonyFields> } = {},
  block = 15n,
): ContractEventRecord {
  const fields: CeremonyFields = {
    panelId: d.value.panel_id,
    stubHash: stubOf(d),
    transcriptHash: d.value.ceremony_transcript_hash,
    keySet: "key-set-7",
    version: 8,
    ...changes,
  };
  const h = { ...fields, ...changes.header };
  const seats = keySetOf(h.keySet).entries;
  const approved = concatBytes(
    Uint8Array.of(approvals.length),
    ...approvals.map((a) => concatBytes(Uint8Array.of(a.index), hex(a.signature))),
  );
  const record =
    fields.version === 1
      ? concatBytes(h.panelId, h.stubHash, h.transcriptHash, approved)
      : concatBytes(
          h.panelId,
          h.stubHash,
          h.transcriptHash,
          Uint8Array.of(seats.length),
          ...seats.map((e) =>
            concatBytes(Uint8Array.of(e.index), hex(e.kemKeyHash), hex(e.x), hex(e.y)),
          ),
          approved,
        );
  return {
    ...base(d.value.trustee_registry, block),
    topics: [CEREMONY_REGISTERED, fields.stubHash, fields.panelId, fields.transcriptHash],
    data: abiBytes(record),
  };
}
