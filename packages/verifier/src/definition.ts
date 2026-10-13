// The definition versions this verifier reads (docs/spec/verifier.md,
// Definition, step 1): versions 1, 3 and 4 as @abolishus/crypto's
// `decodeElectionDefinitionRecord` reads them, and version 5 (questions,
// P2-14). Version 6 and any later one stay `unknown-version` at the version
// byte, before any field, so they are unverifiable, never failed (T-36).

import {
  type AnyElectionDefinitionRecord,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  type ElectionDefinitionRecord,
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
