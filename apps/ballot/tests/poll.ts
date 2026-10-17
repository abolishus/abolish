// Test only: a version-5 poll as the client opens one, with its ceremony run
// here by every seat of the panel it names (docs/spec/ceremony.md), the
// transcript as the board's first entry, and the hash the registry would
// hold, computed with node:crypto rather than the code under test. For
// tests/session.test.ts and tests/worker.e2e.ts.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  answersMessage,
  ceremonyKeygen,
  ceremonyTranscriptHash,
  challengesMessage,
  decodeElectionDefinitionV5,
  type ElectionDefinitionV5,
  electionStubV5Hash,
  encodeBoardEntry,
  encodeCeremonyTranscript,
  encodeElectionDefinitionV5,
  identityKey,
  keysMessage,
  membershipVkHash,
  type Panel,
  panelId,
  RECORD_TYPES,
  revealsMessage,
} from "@abolishus/crypto";

const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));

const vectors = (name: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../../../docs/spec/vectors/${name}.json`, import.meta.url), "utf8"),
    ) as { vectors: { id: string; encoding: string; definition?: unknown }[] }
  ).vectors;
const vector = (name: string, id: string) => {
  const found = vectors(name).find((v) => v.id === id);
  if (found === undefined) throw new Error(`no vector ${id}`);
  return found;
};

/** The definition hash by the spec's formula, with node:crypto rather than the code under test. */
const definitionHash = (bytes: Uint8Array) => {
  const tag = Buffer.from("abolish/v1/election-definition", "ascii");
  return Uint8Array.from(
    createHash("sha256")
      .update(Buffer.concat([Buffer.from([tag.length]), tag, bytes]))
      .digest(),
  );
};

// The typical version-5 definition with display-text-v2's two questions (pick
// one of 3, exactly one of 2), under the profile every poll pins today
// (packages/core's POLL_DEFINITION_PROFILE) and the release's membership key.
const text = vector("display-text-v2", "display-text-v2-two-questions") as {
  encoding: string;
  definition: { optionCounts: string[]; displayTextCommitment: string };
};
const typical = decodeElectionDefinitionV5(
  hex(vector("election-definition-v5", "definition-v5-typical").encoding),
);
const shape: ElectionDefinitionV5 = {
  ...typical,
  questions: text.definition.optionCounts.map((m) => ({
    method: 1,
    option_count: Number(m),
    min_selections: 1,
    max_selections: 1,
  })),
  display_text_commitment: hex(text.definition.displayTextCommitment),
  membership_vk_hash: membershipVkHash(),
  profile: {
    protocol_major: 1,
    pins: (
      [
        [RECORD_TYPES.electionDefinition, 5],
        [RECORD_TYPES.ballot, 3],
        [RECORD_TYPES.spoiledBallotOpening, 2],
        [RECORD_TYPES.receipt, 1],
        [RECORD_TYPES.ceremonyTranscript, 1],
        [RECORD_TYPES.tallyOpening, 1],
        [RECORD_TYPES.boardEntry, 5],
        [RECORD_TYPES.contractEvent, 7],
        [RECORD_TYPES.displayText, 2],
      ] as const
    ).map(([record_type, version]) => ({ record_type, version })),
  },
};

// Every seat of the definition's panel runs the ceremony.
const secrets = Array.from({ length: shape.panel_size }, () =>
  crypto.getRandomValues(new Uint8Array(32)),
);
export const panel: Panel = {
  threshold: shape.threshold,
  keys: secrets.map((s) => identityKey(s)),
};
const stub: ElectionDefinitionV5 = { ...shape, panel_id: panelId(panel) };
const run = {
  l2ChainId: stub.l2_chain_id,
  trusteeRegistry: stub.trustee_registry,
  electionId: stub.election_id,
  stubHash: electionStubV5Hash(stub),
  panel,
  runId: crypto.getRandomValues(new Uint8Array(32)),
};
const seats = secrets.map((s, i) => ceremonyKeygen(i + 1, s));
const keys = seats.map((s) => keysMessage(run, s));
const challenges = seats.map((s) => challengesMessage(run, s, keys));
const round2 = challenges.map((c) => c.message);
const answers = seats.map((s) => answersMessage(run, s, keys, round2));
const reveals = seats.map((s, i) =>
  revealsMessage(run, s, { keys, challenges: round2, answers }, challenges[i]?.secrets ?? []),
);
const transcript = encodeCeremonyTranscript({
  run_id: run.runId,
  keys,
  challenges: round2,
  answers,
  reveals,
});
export const definition: ElectionDefinitionV5 = {
  ...stub,
  ceremony_transcript_hash: ceremonyTranscriptHash(transcript),
};
export const definitionBytes = encodeElectionDefinitionV5(definition);
/** What the registry holds for the poll. */
export const registeredHash = definitionHash(definitionBytes);
export const displayText = hex(text.encoding);
/** The board's first entry: the transcript. */
export const entry = encodeBoardEntry(
  { election_id: definition.election_id, index: 0n, segment: 0, payload: transcript },
  5,
);
