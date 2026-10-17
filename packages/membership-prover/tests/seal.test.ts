import {
  answersMessage,
  castSealV3,
  ceremonyKeygen,
  ceremonyTranscriptHash,
  challengeSealV3,
  challengesMessage,
  checkBallotV3,
  checkCeremonyTranscript,
  decodeBallot,
  decodeElectionDefinitionV5,
  type ElectionDefinitionV5,
  electionStubV5Hash,
  encodeCeremonyTranscript,
  finishSealV3,
  identityCommitment,
  identityKey,
  keysMessage,
  type Panel,
  panelId,
  questionBallotElection,
  revealsMessage,
  sealBallotV3,
  shareCiphertextHash,
  tierTreeRoot,
} from "@abolishus/crypto";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import { proveMembership } from "../src/index.ts";

// A ballot sealed, cast and proved end to end, as the ballot client makes one
// (docs/spec/ballot-validity.md, Casting (version 3)): packages/crypto's seal
// with this package's snarkjs proof, under a version-5 definition whose key
// set comes from a real ceremony transcript and whose cell roots are made
// over Semaphore 4.14.3's identities (docs/spec/vectors/membership-prover.json).
// The finished record must pass `checkBallotV3`, which the verifier runs
// (5.1 to 5.4), with no expected value taken from the seal itself.

const vectors = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../docs/spec/vectors/${name}`, import.meta.url), "utf8"));
const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex, "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const members = (
  vectors("membership-prover.json") as { members: { secret: string }[] }
).members.map((m) => bytes(m.secret));
const cell0 = members.slice(0, 4).map(identityCommitment);

const ARTIFACTS = new URL("../artifacts/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", ARTIFACTS), "utf8")) as {
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
};
const vendored = (path: string) => {
  const entry = manifest.files.find((f) => f.path === path);
  const b = new Uint8Array(readFileSync(new URL(path, ARTIFACTS)));
  if (entry === undefined || createHash("sha256").update(b).digest("hex") !== entry.sha256)
    throw new Error(`${path}: not the manifest's bytes`);
  return b;
};
const artifacts = {
  zkey: vendored("snark-artifacts/semaphore-32.zkey"),
  wasm: vendored("snark-artifacts/semaphore-32.wasm"),
};

// ballot-v3-records.json's questions and partition, cell 0's root over the
// first four identities, and a ceremony run here by every seat.
const base = decodeElectionDefinitionV5(
  bytes(
    (vectors("ballot-v3-records.json") as { elections: { questions: { definition: string } } })
      .elections.questions.definition,
  ),
);
const identitySecrets = Array.from({ length: base.panel_size }, () =>
  crypto.getRandomValues(new Uint8Array(32)),
);
const panel: Panel = {
  threshold: base.threshold,
  keys: identitySecrets.map((s) => identityKey(s)),
};
const stub: ElectionDefinitionV5 = {
  ...base,
  panel_id: panelId(panel),
  electorate: base.electorate.map((t, i) =>
    i === 0
      ? { ...t, cells: t.cells.map((c, j) => (j === 0 ? { ...c, root: tierTreeRoot(cell0) } : c)) }
      : t,
  ),
};
const params = {
  l2ChainId: stub.l2_chain_id,
  trusteeRegistry: stub.trustee_registry,
  electionId: stub.election_id,
  stubHash: electionStubV5Hash(stub),
  panel,
};
const run = { ...params, runId: crypto.getRandomValues(new Uint8Array(32)) };
const seats = identitySecrets.map((s, i) => ceremonyKeygen(i + 1, s));
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
const checked = checkCeremonyTranscript(params, transcript, 1);
if (!checked.ok) throw new Error(`ceremony: ${checked.code}`);
const definition: ElectionDefinitionV5 = {
  ...stub,
  ceremony_transcript_hash: ceremonyTranscriptHash(transcript),
};
const election = questionBallotElection(definition, checked.registered);

const VOTES = [0, 0, 1, 1, 0, 0, 1, 1, 0] as const;
const PROOF_TIMEOUT = 60_000;

describe("a sealed ballot, proved", () => {
  test(
    "passes the admission checks, carries the core whose code was shown, and recasts with the same vote",
    async () => {
      const sealed = sealBallotV3(election, 0, [...VOTES]);
      const secret = members[2] as Uint8Array;
      const l1 = { number: 9_000_000n, hash: new Uint8Array(32).fill(0xab) };
      const casting = castSealV3(sealed, secret, cell0, l1);
      const cast = finishSealV3(casting, await proveMembership(casting.witness, artifacts));

      const record = decodeBallot(cast.ballot, 3);
      const verdict = checkBallotV3(election, record);
      if (!verdict.ok) throw new Error(verdict.code);
      expect(toHex(verdict.ballotHash)).toBe(toHex(cast.ballotHash));
      expect(verdict.nullifier).toBe(cast.nullifier);
      expect(record.cell).toBe(0);
      expect(record.l1_ref_number).toBe(l1.number);
      expect(toHex(record.l1_ref_hash)).toBe(toHex(l1.hash));
      // Every seat registered, each with the ciphertext its share hash names.
      expect(cast.ciphertexts.map((c) => c.seat)).toEqual(checked.registered.map((k) => k.index));
      for (const { seat, ciphertext } of cast.ciphertexts)
        expect(toHex(shareCiphertextHash(ciphertext))).toBe(
          toHex(record.committed_vote.share_hashes[seat - 1] as Uint8Array),
        );

      // A recast under a newer block (revoting Client rule 4): the same
      // committed vote, so the same ballot hash and nullifier, a new message.
      const later = { number: 9_000_100n, hash: new Uint8Array(32).fill(0xcd) };
      const recasting = castSealV3(sealed, secret, cell0, later);
      const recast = finishSealV3(recasting, await proveMembership(recasting.witness, artifacts));
      const again = checkBallotV3(election, decodeBallot(recast.ballot, 3));
      if (!again.ok) throw new Error(again.code);
      expect(toHex(recast.ballotHash)).toBe(toHex(cast.ballotHash));
      expect(recast.nullifier).toBe(cast.nullifier);
      expect(toHex(again.message)).not.toBe(toHex(verdict.message));
      expect(() => challengeSealV3(sealed)).toThrow(/never opened/);

      // A proof for one cast never finishes another.
      const other = castSealV3(sealBallotV3(election, 0, [...VOTES]), secret, cell0, l1);
      expect(() => finishSealV3(other, decodeProofOf(cast.ballot))).toThrow(/proof/);
    },
    3 * PROOF_TIMEOUT,
  );
});

// The membership proof's bytes inside an encoded version-3 record: after the
// header, definition hash, cell, nullifier and L1 reference.
function decodeProofOf(ballot: Uint8Array): Uint8Array {
  const at = 3 + 32 + 1 + 32 + 8 + 32;
  return ballot.slice(at, at + 256);
}
