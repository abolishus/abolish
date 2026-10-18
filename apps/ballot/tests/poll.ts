// Test only: a version-5 poll as the client opens one, with its ceremony run
// here by every seat of the panel it names (docs/spec/ceremony.md), the
// transcript as the board's first entry, and the hash the registry would
// hold, computed with node:crypto rather than the code under test. The
// first tier is one group in one region, a single cell holding four of
// Semaphore 4.14.3's identities (docs/spec/vectors/membership-prover.json),
// added in one batch signed by group-registry.json's test registrars and
// boarded after the transcript as the registry logs it, so the client finds
// its voters' cell from the board and a seal there can be cast.
// For tests/session.test.ts, tests/cast.test.ts and tests/worker.e2e.ts.

import { keccak_256 } from "@noble/hashes/sha3.js";
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
  type ContractEventRecord,
  encodeBoardEntry,
  encodeCeremonyTranscript,
  encodeContractEvent,
  encodeElectionDefinitionV5,
  encodeGroupAddition,
  groupAdditionDigest,
  groupRegistryDomainSeparator,
  identityCommitment,
  identityKey,
  keysMessage,
  membershipVkHash,
  type Panel,
  panelId,
  RECORD_TYPES,
  revealsMessage,
  signGroupApproval,
  tierTreeRoot,
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
/** The identity secrets of cell 0's members, in leaf order. */
export const members = (
  JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/membership-prover.json", import.meta.url),
      "utf8",
    ),
  ) as { members: { secret: string }[] }
).members
  .slice(0, 4)
  .map((m) => hex(m.secret));
/** Cell 0's leaves, as the client rebuilds them from the board. */
export const cellLeaves = members.map(identityCommitment);

/** The group cell 0's members registered in. */
export const GROUP = 1n;

const shape: ElectionDefinitionV5 = {
  ...typical,
  electorate: typical.electorate.map((t, i) =>
    i === 0
      ? {
          ...t,
          groups: [{ group_id: GROUP, region: 0 }],
          regions: [BigInt(cellLeaves.length)],
          cells: [{ root: tierTreeRoot(cellLeaves), members: BigInt(cellLeaves.length) }],
        }
      : t,
  ),
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
        [RECORD_TYPES.contractEvent, 8],
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

const registryVectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/group-registry.json", import.meta.url), "utf8"),
) as { registrars: { threshold: number; secretKeys: string[]; addresses: string[] } };
/** The registrars a build pins, as `find-cell` takes them. */
export const registrars = {
  registrars: registryVectors.registrars.addresses.map(hex),
  threshold: registryVectors.registrars.threshold,
};

const word = (v: bigint) => hex(v.toString(16).padStart(64, "0"));
const topic0 = (signature: string) => keccak_256(new TextEncoder().encode(signature));
const log = (n: bigint, topics: Uint8Array[], data: Uint8Array): ContractEventRecord => ({
  contract: definition.group_registry,
  n,
  l2_block: 10n * n,
  l2_timestamp: 1_760_000_000n + n,
  topics,
  data,
});
/** `bytes` as an ABI-encoded dynamic argument. */
const abiBytes = (b: Uint8Array) => {
  const padded = new Uint8Array(Math.ceil(b.length / 32) * 32);
  padded.set(b);
  return Uint8Array.from([...word(32n), ...word(BigInt(b.length)), ...padded]);
};

/**
 * The group registry's log: `GROUP` created at Tier 0 and `commitments`
 * added to it in one batch the test registrars signed, under the
 * definition's chain and group registry, numbered from 1.
 */
function groupLog(commitments: readonly bigint[]): ContractEventRecord[] {
  const domain = groupRegistryDomainSeparator(definition.l2_chain_id, definition.group_registry);
  const digest = groupAdditionDigest(domain, {
    groupId: GROUP,
    tier: 0,
    firstIndex: 0n,
    commitments,
  });
  const approvals = registryVectors.registrars.secretKeys
    .slice(0, registrars.threshold)
    .map((k, i) => signGroupApproval(digest, i + 1, hex(k)));
  return [
    log(1n, [topic0("GroupCreated(uint64,uint8)"), word(GROUP), word(0n)], new Uint8Array(0)),
    log(
      2n,
      [topic0("MembersAdded(uint64,uint64,bytes)"), word(GROUP), word(0n)],
      abiBytes(encodeGroupAddition({ groupId: GROUP, firstIndex: 0n, commitments, approvals })),
    ),
  ];
}

/**
 * The whole board: the transcript, then the first tier's group created and
 * `commitments` added to it (`groupLog`).
 */
export function boardWith(commitments: readonly bigint[]): Uint8Array[] {
  return [
    entry,
    ...groupLog(commitments).map((r, i) =>
      encodeBoardEntry(
        {
          election_id: definition.election_id,
          index: BigInt(i + 1),
          segment: 0,
          payload: encodeContractEvent(r, 8),
        },
        5,
      ),
    ),
  ];
}

/** A second Tier 0 group, created before `GROUP` and never added to. */
export const OTHER_GROUP = 2n;

/**
 * The whole group registry as the page reads it from the L2, as
 * contract-event records of version 8: `OTHER_GROUP` created at Tier 0,
 * then `groupLog(commitments)`.
 */
export function registryWith(commitments: readonly bigint[]): Uint8Array[] {
  return [
    log(0n, [topic0("GroupCreated(uint64,uint8)"), word(OTHER_GROUP), word(0n)], new Uint8Array(0)),
    ...groupLog(commitments),
  ].map((r) => encodeContractEvent(r, 8));
}

/** The board as the API serves it. */
export const board = boardWith(cellLeaves);
