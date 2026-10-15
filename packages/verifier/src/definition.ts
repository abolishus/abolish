// The definition versions this verifier reads (docs/spec/verifier.md,
// Definition, step 1): versions 1, 3 and 4 as @abolishus/crypto's
// `decodeElectionDefinitionRecord` reads them, and version 5 (questions,
// P2-14). Version 6 and any later one stay `unknown-version` at the version
// byte, before any field, so they are unverifiable, never failed (T-36).

import {
  type AnyElectionDefinitionRecord,
  type BoardEntryVersion,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  type ElectionDefinitionRecord,
  electionDefinitionHash,
  electionDefinitionRule,
  electionDefinitionV3Hash,
  electionDefinitionV3Rule,
  electionDefinitionV4Hash,
  electionDefinitionV4Rule,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  type ElectionDefinitionV5Rule,
  electionStubHash,
  electionStubV3Hash,
  electionStubV4Hash,
  electionStubV5Hash,
  RECORD_TYPES,
} from "@abolishus/crypto";

/** A decoded definition of a version this verifier reads. */
export type VerifiedDefinition =
  | ElectionDefinitionRecord
  | Extract<AnyElectionDefinitionRecord, { readonly version: 5 }>;

/**
 * Strictly decodes a definition of version 1, 3, 4 or 5, each under its own
 * layout and self-pin (docs/spec/election-definition.md, Decoding). Throws
 * `DecodeError`, `unknown-version` at offset 2 for any other version.
 */
export function decodeDefinition(bytes: Uint8Array): VerifiedDefinition {
  // Only the version byte routes the record: decodeElectionDefinitionV5
  // still checks the self-pin, so a version-5 layout pinning another version
  // is `profile-mismatch`, as it is to the other versions' decoder.
  if (
    bytes.length >= 3 &&
    bytes[0] === 0 &&
    bytes[1] === RECORD_TYPES.electionDefinition &&
    bytes[2] === 5
  )
    return { version: 5, value: decodeElectionDefinitionV5(bytes) };
  return decodeElectionDefinitionRecord(bytes);
}

/**
 * What the checks take from a decoded definition, by its version: its hash,
 * its stub hash (which the key ceremony binds) and the first well-formedness
 * rule it breaks. Exhaustive: a version crypto adds doesn't compile until it
 * is read here (docs/spec/election-definition.md, Layout; T-34, T-37).
 */
export function readDefinition(record: VerifiedDefinition): {
  readonly hash: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly rule: ElectionDefinitionV5Rule | undefined;
  /** Under version 5, `option-count`'s and `selections`' first failing question. */
  readonly question?: number;
} {
  switch (record.version) {
    case 1:
      return {
        hash: electionDefinitionHash(record.value),
        stubHash: electionStubHash(record.value),
        rule: electionDefinitionRule(record.value),
      };
    case 3:
      return {
        hash: electionDefinitionV3Hash(record.value),
        stubHash: electionStubV3Hash(record.value),
        rule: electionDefinitionV3Rule(record.value),
      };
    case 4:
      return {
        hash: electionDefinitionV4Hash(record.value),
        stubHash: electionStubV4Hash(record.value),
        rule: electionDefinitionV4Rule(record.value),
      };
    case 5: {
      const failure = electionDefinitionV5Rule(record.value);
      return {
        hash: electionDefinitionV5Hash(record.value),
        stubHash: electionStubV5Hash(record.value),
        rule: failure?.rule,
        ...(failure !== undefined && "question" in failure && { question: failure.question }),
      };
    }
    default: {
      const unread: never = record;
      throw new Error(`unread definition version ${String(unread)}`);
    }
  }
}

const READABLE: ReadonlySet<number> = new Set<BoardEntryVersion>([1, 3, 4, 5]);

/** Whether this verifier reads a board under the pinned board-entry version. */
export const isReadable = (v: number | undefined): v is BoardEntryVersion =>
  v !== undefined && READABLE.has(v);
