import { readFileSync } from "node:fs";

import { encodeBoardEntry } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { ceremonyView } from "../src/ceremony.ts";
import { fromHex, toHex } from "../src/values.ts";

const runs = { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100) };

// The published cross-language vectors (docs/spec/vectors/ceremony.json),
// never values computed by the code under test.
interface TranscriptVector {
  id: string;
  transcript: string;
  result: { ok: boolean; hash?: string };
}
const vectors = JSON.parse(
  readFileSync(new URL("../../../docs/spec/vectors/ceremony.json", import.meta.url), "utf8"),
) as {
  transcripts: TranscriptVector[];
  decode: { id: string; transcript: string }[];
};
const vector = (id: string) => {
  const v = vectors.transcripts.find((t) => t.id === id);
  if (v === undefined) throw new Error(`vector ${id} missing`);
  return v;
};
const hashOf = (id: string) => {
  const hash = vector(id).result.hash;
  if (hash === undefined) throw new Error(`vector ${id} has no hash`);
  return hash;
};

const ID = "52".repeat(32);

/** The board's first entry carrying `payload`, as the API serves it. */
const entry = (payload: string) =>
  toHex(
    encodeBoardEntry(
      { election_id: fromHex(ID), index: 0n, segment: 0, payload: fromHex(payload) },
      1,
    ),
  );

const committed = (id: string) => ({ hash: hashOf(id), pinned: true });

describe("ceremonyView", () => {
  test("an honest transcript the definition commits to: every seat sent all four rounds", () => {
    expect(ceremonyView(entry(vector("honest-4").transcript), 1, committed("honest-4"), 4)).toEqual(
      {
        kind: "transcript",
        hash: hashOf("honest-4"),
        committed: true,
        seats: [1, 2, 3, 4].map((index) => ({ index, rounds: 4 })),
      },
    );
  });

  test.each([
    // Seat 4 sends nothing.
    ["absent", [4, 4, 4, 0]],
    // Seat 2 sends keys and answers, but no challenges and so no reveals.
    ["no-challenges", [4, 2, 4, 4]],
    ["no-answers", [4, 4, 3, 4]],
    ["no-reveals", [3, 4, 4, 4]],
  ] as const)("%s: counts each seat's rounds from the decoded messages", (id, rounds) => {
    const view = ceremonyView(entry(vector(id).transcript), 1, committed(id), 4);
    expect(view).toEqual({
      kind: "transcript",
      hash: hashOf(id),
      committed: true,
      seats: rounds.map((count, i) => ({ index: i + 1, rounds: count })),
    });
  });

  test("a transcript of another run isn't the committed one, though it decodes (T-34, T-37)", () => {
    const view = ceremonyView(entry(vector("absent").transcript), 1, committed("honest-4"), 4);
    expect(view).toMatchObject({ kind: "transcript", committed: false, hash: hashOf("absent") });
  });

  test("lists every seat the definition sizes, whichever the transcript names", () => {
    const view = ceremonyView(entry(vector("honest-2").transcript), 1, committed("honest-2"), 3);
    expect(view.kind === "transcript" ? view.seats : undefined).toEqual([
      { index: 1, rounds: 4 },
      { index: 2, rounds: 4 },
      { index: 3, rounds: 0 },
    ]);
  });

  test("a first entry of another kind is a missing ceremony", () => {
    // A contract-event record's header: type 0x0008, version 1.
    expect(ceremonyView(entry("000801ab"), 1, committed("honest-4"), 4)).toEqual({
      kind: "missing",
    });
  });

  // Only those that are ceremony records: the board allows no other type a
  // decoding vector names, so none of them can be a first entry.
  const decoding = vectors.decode.filter((v) => v.transcript.startsWith("0005"));

  test("has decoding vectors of ceremony records", () => {
    expect(decoding.length).toBeGreaterThan(2);
  });

  test.each(decoding.map((v) => [v.id, v.transcript] as const))(
    "%s: a transcript that doesn't decode is refused",
    (_, transcript) => {
      expect(ceremonyView(entry(transcript), 1, committed("honest-4"), 4)).toEqual({
        kind: "undecodable",
      });
    },
  );

  test("a profile that pins no transcript version decodes none", () => {
    const view = ceremonyView(
      entry(vector("honest-4").transcript),
      1,
      { hash: hashOf("honest-4"), pinned: false },
      4,
    );
    expect(view).toEqual({ kind: "undecodable" });
  });

  test("never throws on an arbitrary ceremony payload, and finds it committed only by its hash", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (tail) => {
        const payload = `000501${toHex(tail)}`;
        const view = ceremonyView(entry(payload), 1, committed("honest-4"), 4);
        expect(["transcript", "undecodable"]).toContain(view.kind);
        if (view.kind === "transcript") {
          expect(view.committed).toBe(view.hash === hashOf("honest-4"));
          expect(view.seats.map((s) => s.index)).toEqual([1, 2, 3, 4]);
          for (const s of view.seats) expect(s.rounds).toBeLessThanOrEqual(4);
        }
      }),
      runs,
    );
    // Each run decodes and hashes a transcript of several KiB; CI runs 1000.
  }, 60_000);

  test("a changed byte of the committed transcript is never the committed one", () => {
    const bytes = fromHex(vector("honest-4").transcript);
    fc.assert(
      fc.property(
        fc.integer({ min: 3, max: bytes.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = bytes.slice();
          changed[at]! ^= flip;
          const view = ceremonyView(entry(toHex(changed)), 1, committed("honest-4"), 4);
          expect(view.kind === "transcript" && view.committed).toBe(false);
        },
      ),
      runs,
    );
    // Each run decodes and hashes a transcript of several KiB; CI runs 1000.
  }, 60_000);
});
