import {
  DecodeError,
  encodeCeremonyTranscript,
  encodeElectionDefinition,
  electionStubHash,
} from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  asked,
  decodeApprovalPost,
  decodeMessagePost,
  decodeRequests,
  encodeApprovalPost,
  encodeMessagePost,
  encodeRequests,
  requestTranscript,
  stubHashOf,
} from "../src/wire.ts";
import { election, runCeremony } from "./fixture.ts";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 100);
const bytes = (min: number, max: number) => fc.uint8Array({ minLength: min, maxLength: max });
const hash = bytes(32, 32);

describe("envelopes", () => {
  test("requests, messages and approvals round-trip, and refuse trailing bytes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ stub: bytes(0, 64), transcript: bytes(0, 64) }), { maxLength: 16 }),
        fc.record({ stub_hash: hash, transcript: bytes(0, 64) }),
        (requests, message) => {
          const r = encodeRequests(requests);
          expect(decodeRequests(r)).toEqual(requests);
          expect(() => decodeRequests(Uint8Array.of(...r, 0))).toThrow(DecodeError);
          const m = encodeMessagePost(message);
          expect(decodeMessagePost(m)).toEqual(message);
          expect(() => decodeMessagePost(m.subarray(0, m.length - 1))).toThrow(DecodeError);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  test("more than 16 requests have no encoding", () => {
    const many = Array.from({ length: 17 }, () => ({
      stub: new Uint8Array(),
      transcript: new Uint8Array(),
    }));
    expect(() => encodeRequests(many)).toThrow();
  });

  test("an approval round-trips, and a high-s signature has no decoding", async () => {
    const e = election(3, 2);
    const run = await runCeremony(e);
    const result = await e.seats[0]?.approve(e.stubBytes, run.transcript);
    if (result?.ok !== true) expect.fail("no approval");
    const post = {
      stub_hash: result.value.registration.stubHash,
      ceremony_transcript_hash: result.value.registration.ceremonyTranscriptHash,
      key_set_hash: result.value.registration.keySetHash,
      signature: result.value.signature,
    };
    const encoded = encodeApprovalPost(post);
    expect(decodeApprovalPost(encoded)).toEqual(post);
    const bad = Uint8Array.from(encoded);
    bad.fill(0xff, bad.length - 32);
    expect(() => decodeApprovalPost(bad)).toThrow(DecodeError);
  });
});

describe("the round a transcript asks for", () => {
  test("is its first empty round, approval when all four hold messages, and nothing when a later round follows an empty one", async () => {
    const e = election(3, 2);
    const run = await runCeremony(e);
    const rounds = [run.keys, run.challenges, run.answers, run.reveals] as const;
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), (present) => {
        const [keys, challenges, answers, reveals] = rounds.map((r, i) => (present[i] ? r : []));
        const t = requestTranscript(
          encodeCeremonyTranscript({
            run_id: run.runId,
            keys: keys as typeof run.keys,
            challenges: challenges as typeof run.challenges,
            answers: answers as typeof run.answers,
            reveals: reveals as typeof run.reveals,
          }),
        );
        const first = present.indexOf(false);
        const expected =
          first === -1 ? "approve" : present.slice(first).some(Boolean) ? undefined : first + 1;
        expect(asked(t)).toBe(expected);
      }),
      { numRuns: Math.min(NUM_RUNS, 64) },
    );
  });
});

describe("the stub hash", () => {
  test("is recomputed from a version-1 stub, and is nothing for bytes that aren't one", () => {
    const e = election(3, 2);
    expect(stubHashOf(e.stubBytes)).toEqual(electionStubHash(e.stub));
    expect(stubHashOf(encodeElectionDefinition(e.stub))).toEqual(e.stubHash);
    fc.assert(
      fc.property(bytes(0, 64), (b) => {
        expect(stubHashOf(b)).toBeUndefined();
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
