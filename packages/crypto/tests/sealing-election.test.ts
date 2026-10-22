import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
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
  identityKey,
  keysMessage,
  type Panel,
  panelId,
  pinnedVersion,
  RECORD_TYPES,
  revealsMessage,
  sealBallotV3,
  type SealingElectionCode,
  sealingElectionV5,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// The context a version-5 poll's ballots are sealed under, from its ceremony
// transcript as the board carries it (docs/spec/ceremony.md, Transcript
// check; [[verifier]] 2.5, 3.1 and 3.2). Every transcript here is a real run
// of the four rounds by this test's seats, so each refusal is the one check
// that differs from an honest run.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const v3 = JSON.parse(readFileSync(new URL("ballot-v3-records.json", SPEC_VECTORS), "utf8")) as {
  readonly elections: Readonly<Record<string, { readonly definition: string }>>;
};
const vector = decodeElectionDefinitionV5(
  hex((v3.elections["questions"] as { definition: string }).definition),
);
// The vector's questions and partition under the profile every poll pins
// today (packages/core's POLL_DEFINITION_PROFILE; docs/spec/contracts.md,
// Registration, rule 9), which profileCombinationRule passes.
const base: ElectionDefinitionV5 = {
  ...vector,
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
const boardVersion = pinnedVersion(base, RECORD_TYPES.boardEntry) as 5;

interface Run {
  readonly definition: ElectionDefinitionV5;
  readonly panel: Panel;
  readonly transcript: Uint8Array;
}

/**
 * A ceremony of a `size`-seat panel of threshold `threshold` in which only
 * `present` take part, and the definition naming its panel and transcript.
 */
function ceremony(
  threshold: number,
  size: number,
  present: readonly number[],
  tamper: (transcript: Uint8Array) => Uint8Array = (t) => t,
): Run {
  const secrets = Array.from({ length: size }, () => crypto.getRandomValues(new Uint8Array(32)));
  const panel: Panel = { threshold, keys: secrets.map((s) => identityKey(s)) };
  const stub: ElectionDefinitionV5 = {
    ...base,
    threshold,
    panel_size: size,
    panel_id: panelId(panel),
  };
  const run = {
    l2ChainId: stub.l2_chain_id,
    trusteeRegistry: stub.trustee_registry,
    electionId: stub.election_id,
    stubHash: electionStubV5Hash(stub),
    panel,
    runId: crypto.getRandomValues(new Uint8Array(32)),
  };
  const seats = present.map((i) => ceremonyKeygen(i, secrets[i - 1] as Uint8Array));
  const keys = seats.map((s) => keysMessage(run, s));
  const challenges = seats.map((s) => challengesMessage(run, s, keys));
  const round2 = challenges.map((c) => c.message);
  const answers = seats.map((s) => answersMessage(run, s, keys, round2));
  const reveals = seats.map((s, i) =>
    revealsMessage(run, s, { keys, challenges: round2, answers }, challenges[i]?.secrets ?? []),
  );
  const transcript = tamper(
    encodeCeremonyTranscript({ run_id: run.runId, keys, challenges: round2, answers, reveals }),
  );
  return {
    definition: { ...stub, ceremony_transcript_hash: ceremonyTranscriptHash(transcript) },
    panel,
    transcript,
  };
}

const entryOf = (payload: Uint8Array, electionId = base.election_id, version = boardVersion) =>
  encodeBoardEntry({ election_id: electionId, index: 0n, segment: 0, payload }, version);

const honest = ceremony(
  base.threshold,
  base.panel_size,
  Array.from({ length: base.panel_size }, (_, i) => i + 1),
);
const transcriptEntry = entryOf(honest.transcript);

function code(run: Run, entries: readonly Uint8Array[], panels = [run.panel]): SealingElectionCode {
  const result = sealingElectionV5(run.definition, panels, entries);
  if (result.ok) throw new Error("expected a refusal");
  return result.code;
}

describe("sealingElectionV5", () => {
  test("seals to every seat a ceremony of the pinned panel registered", () => {
    const result = sealingElectionV5(honest.definition, [honest.panel], [transcriptEntry]);
    if (!result.ok) throw new Error(result.code);
    expect(result.transcript).toEqual(honest.transcript);
    expect([...result.election.qualified]).toEqual(
      Array.from({ length: base.panel_size }, (_, i) => i + 1),
    );
    expect(toHex(result.election.definitionHash)).not.toBe("");
    expect(sealBallotV3(result.election, 0, [1, 0, 0, 0, 1, 1, 0, 0, 1]).trackingCode).toHaveLength(
      32,
    );
  });

  test("finds the transcript wherever it sits among other elections' and undecodable entries", () => {
    const other = new Uint8Array(32).fill(9);
    const noise = fc.oneof(
      fc.uint8Array({ maxLength: 64 }),
      fc.constant(entryOf(honest.transcript, other)),
      fc.constant(entryOf(Uint8Array.of(0x00, 0x05, 0x01, 0x00), base.election_id)),
    );
    fc.assert(
      fc.property(fc.array(noise, { maxLength: 4 }), fc.nat(), (others, at) => {
        const entries = [...others];
        entries.splice(at % (others.length + 1), 0, transcriptEntry);
        expect(sealingElectionV5(honest.definition, [honest.panel], entries).ok).toBe(true);
        expect(code(honest, others)).toBe("ceremony-transcript-missing");
      }),
      // Each run checks the transcript's signatures.
      { numRuns: Math.max(10, Math.floor(numRuns / 20)) },
    );
  }, 120_000);

  test("refuses a panel this release doesn't pin, or pins with another threshold or size", () => {
    expect(code(honest, [transcriptEntry], [])).toBe("panel-unpinned");
    const stranger = ceremony(base.threshold, base.panel_size, [1]).panel;
    expect(code(honest, [transcriptEntry], [stranger])).toBe("panel-unpinned");
    for (const changed of [
      { ...honest.definition, threshold: honest.definition.threshold + 1 },
      { ...honest.definition, panel_size: honest.definition.panel_size + 1 },
    ])
      expect(code({ ...honest, definition: changed }, [transcriptEntry])).toBe("panel-unpinned");
    // Among others, the one the definition names is used.
    expect(
      sealingElectionV5(honest.definition, [stranger, honest.panel], [transcriptEntry]).ok,
    ).toBe(true);
  });

  test("refuses another membership key, a zero cell root and an unread transcript version", () => {
    const vk = Uint8Array.from(base.membership_vk_hash);
    vk[0] = (vk[0] as number) ^ 1;
    expect(
      code({ ...honest, definition: { ...honest.definition, membership_vk_hash: vk } }, []),
    ).toBe("membership-key");
    const zero: ElectionDefinitionV5 = {
      ...honest.definition,
      electorate: honest.definition.electorate.map((t, i) =>
        i === 0 ? { ...t, cells: t.cells.map((c) => ({ ...c, root: 0n })) } : t,
      ),
    };
    expect(code({ ...honest, definition: zero }, [transcriptEntry])).toBe("cell-root");
    const pins = honest.definition.profile.pins.map((p) =>
      p.record_type === RECORD_TYPES.ceremonyTranscript ? { ...p, version: 2 } : p,
    );
    const later = { ...honest.definition, profile: { ...honest.definition.profile, pins } };
    expect(code({ ...honest, definition: later }, [transcriptEntry])).toBe("unsupported-version");
  });

  test("refuses a profile 2.3 refuses", () => {
    const pins = honest.definition.profile.pins.filter(
      (p) => p.record_type !== RECORD_TYPES.ballot,
    );
    const broken = { ...honest.definition, profile: { ...honest.definition.profile, pins } };
    expect(code({ ...honest, definition: broken }, [transcriptEntry])).toBe("profile-combination");
  });

  test("refuses bytes the definition binds that aren't a transcript", () => {
    const junk = Uint8Array.of(0x00, 0x05, 0x01, 0xff, 0xff);
    const run = {
      ...honest,
      definition: { ...honest.definition, ceremony_transcript_hash: ceremonyTranscriptHash(junk) },
    };
    const result = sealingElectionV5(run.definition, [run.panel], [entryOf(junk)]);
    expect(result).toMatchObject({ ok: false, code: "ceremony-decode" });
  });

  test("refuses a transcript a seat's signature doesn't cover", () => {
    // The last byte is inside the last reveal's signature.
    const run = ceremony(
      base.threshold,
      base.panel_size,
      [1, 2, 3].slice(0, base.panel_size),
      (t) => {
        const copy = Uint8Array.from(t);
        copy[copy.length - 1] = (copy[copy.length - 1] as number) ^ 1;
        return copy;
      },
    );
    expect(code(run, [entryOf(run.transcript)])).toBe("ceremony-signature");
  });

  test("refuses a transcript run under another election's context", () => {
    // The same transcript bytes, named by a definition of another election ID.
    const elsewhere = new Uint8Array(32).fill(3);
    const run = { ...honest, definition: { ...honest.definition, election_id: elsewhere } };
    expect(code(run, [entryOf(honest.transcript, elsewhere)])).toBe("ceremony-signature");
  });

  test("refuses fewer than k qualified seats, and fewer than max(k, n − 1)", () => {
    // 2 of 4: participation needs 3.
    const quorum = ceremony(2, 4, [1]);
    expect(code(quorum, [entryOf(quorum.transcript)])).toBe("ceremony-quorum");
    const short = ceremony(2, 4, [1, 2]);
    expect(code(short, [entryOf(short.transcript)])).toBe("ceremony-participation");
    const enough = ceremony(2, 4, [1, 2, 4]);
    const result = sealingElectionV5(
      enough.definition,
      [enough.panel],
      [entryOf(enough.transcript)],
    );
    if (!result.ok) throw new Error(result.code);
    expect([...result.election.qualified]).toEqual([1, 2, 4]);
  });
});
