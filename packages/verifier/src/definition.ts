// The definition versions this verifier reads (docs/spec/verifier.md,
// Definition, step 1): versions 1, 3 and 4 as @abolishus/crypto's
// `decodeElectionDefinitionRecord` reads them, version 5 (questions, P2-14)
// and version 6 (poll class, results mode and author panel, P2-16). Version
// 7 and any later one stay `unknown-version` at the version byte, before any
// field, so they are unverifiable, never failed (T-36).

import {
  type AnyElectionDefinitionRecord,
  type BoardEntryVersion,
  decodeElectionDefinitionRecord,
  decodeElectionDefinitionV5,
  decodeElectionDefinitionV6,
  electionAuthorStubV6Hash,
  type ElectionDefinitionRecord,
  electionDefinitionHash,
  electionDefinitionRule,
  electionDefinitionV3Hash,
  electionDefinitionV3Rule,
  electionDefinitionV4Hash,
  electionDefinitionV4Rule,
  electionDefinitionV5Hash,
  electionDefinitionV5Rule,
  electionDefinitionV6Hash,
  electionDefinitionV6Rule,
  type ElectionDefinitionV6Rule,
  electionStubHash,
  electionStubV3Hash,
  electionStubV4Hash,
  electionStubV5Hash,
  electionStubV6Hash,
  RECORD_TYPES,
} from "@abolishus/crypto";
import type { AuthorRun } from "./ceremony.ts";

/** A decoded definition of a version this verifier reads. */
export type VerifiedDefinition =
  | ElectionDefinitionRecord
  | Extract<AnyElectionDefinitionRecord, { readonly version: 5 | 6 }>;

/**
 * Strictly decodes a definition of version 1, 3, 4, 5 or 6, each under its
 * own layout and self-pin (docs/spec/election-definition.md, Decoding).
 * Throws `DecodeError`, `unknown-version` at offset 2 for any other version.
 */
export function decodeDefinition(bytes: Uint8Array): VerifiedDefinition {
  // Only the version byte routes the record: decodeElectionDefinitionV5 and
  // V6 still check the self-pin, so a version-5 or version-6 layout pinning
  // another version is `profile-mismatch`, as it is to the other versions'
  // decoder.
  if (bytes.length >= 3 && bytes[0] === 0 && bytes[1] === RECORD_TYPES.electionDefinition) {
    if (bytes[2] === 5) return { version: 5, value: decodeElectionDefinitionV5(bytes) };
    if (bytes[2] === 6) return { version: 6, value: decodeElectionDefinitionV6(bytes) };
  }
  return decodeElectionDefinitionRecord(bytes);
}

/**
 * The definition's author panel and what its run binds: version 6's
 * `author_threshold`, `author_keys`, `author_transcript_hash` and its
 * `author_stub_hash`, recomputed here; undefined when it has no author
 * panel, as under every earlier version, which has none
 * (docs/spec/election-definition.md, Author panel; T-37).
 */
export function authorRunOf(record: VerifiedDefinition): AuthorRun | undefined {
  if (record.version !== 6 || record.value.author_keys.length === 0) return undefined;
  const d = record.value;
  return {
    panel: { threshold: d.author_threshold, keys: d.author_keys },
    stubHash: electionAuthorStubV6Hash(d),
    transcriptHash: d.author_transcript_hash,
  };
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
  readonly rule: ElectionDefinitionV6Rule | undefined;
  /** Under versions 5 and 6, `option-count`'s and `selections`' first failing question. */
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
    case 6: {
      // Version 5's rules, then `results`, `civic-sealed` and `author-panel`
      // (2.1); the stub is the default panel's, which keeps
      // `author_transcript_hash`, so the default seats' ceremony binds the
      // author panel's transcript (election-definition.md, Stub hash; T-37).
      const failure = electionDefinitionV6Rule(record.value);
      return {
        hash: electionDefinitionV6Hash(record.value),
        stubHash: electionStubV6Hash(record.value),
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

// Version 6 (a live poll's running openings) and version 7 (an author
// panel's approvals) are read so 2.3 can fail the profiles that pin them;
// no profile 2.3 passes pins either yet (T-16, T-17).
const READABLE: ReadonlySet<number> = new Set<BoardEntryVersion>([1, 3, 4, 5, 6, 7]);

/** Whether this verifier reads a board under the pinned board-entry version. */
export const isReadable = (v: number | undefined): v is BoardEntryVersion =>
  v !== undefined && READABLE.has(v);
