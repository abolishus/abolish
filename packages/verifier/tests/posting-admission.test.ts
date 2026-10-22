import { readFileSync } from "node:fs";
import { ballotHashV3, decodeBallot, encodeBallotV3 } from "@abolishus/crypto";
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { electionAdmission, postingForm, splitEntries } from "../src/index.ts";
import {
  ballots,
  definition,
  definitionBytes,
  panel,
  postedBallot,
  postingFor,
  transcript,
  transcriptEntry,
} from "./receipt-poll.ts";

// `electionAdmission`'s share-posting judge, which the operator's posting
// relay runs before it pays for a posting (docs/spec/posting-relay.md,
// Answers, steps 3 and 5): the posting decodes strictly, names this
// definition, the ballot sent with it is one of the election's whose
// recomputed ballot hash is the posting's, its seat is registered, and it
// passes the public check under that seat's registered key (T-52). The
// election's ceremony is run in tests/receipt-poll.ts, so its seats' KEM
// keys are known, and each ballot is encrypted there to them. `postingForm`,
// step 3 alone, is what the judge runs first.

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

const admission = (() => {
  const a = electionAdmission(definitionBytes, panel, [transcriptEntry]);
  if (!a.ok) throw new Error(`election refused: ${a.code}`);
  return a;
})();

const first = postedBallot(ballots[0] as (typeof ballots)[number]);
const second = postedBallot(ballots[1] as (typeof ballots)[number]);
/** `ballot`'s record with `fields` replaced, and its ballot hash recomputed. */
function rewritten(
  ballot: { readonly payload: Uint8Array },
  fields: { readonly definition_hash?: Uint8Array; readonly cell?: number },
) {
  const record = { ...decodeBallot(ballot.payload, 3), ...fields };
  const hash = ballotHashV3(
    { definitionHash: record.definition_hash, cell: record.cell, nullifier: record.nullifier },
    record.committed_vote,
  );
  return { ballot: encodeBallotV3(record), hash };
}

const SEATS = Array.from({ length: definition.panel_size }, (_, i) => i + 1);

describe("an honest posting", () => {
  test("each seat's, for each ballot, passes with what the relay counts it by", () => {
    for (const ballot of [first, second])
      for (const seat of SEATS)
        expect(admission.posting(postingFor(ballot, seat), ballot.payload)).toEqual({
          ok: true,
          ballotHash: ballot.hash,
          seat,
          tier: definition.electorate.flatMap((t) => t.cells.map(() => t.tier))[ballot.cell],
          nullifier: ballot.nullifier,
        });
  });

  test("passes with no other ballot", () => {
    expect(admission.posting(postingFor(first, 1), second.payload)).toEqual({
      ok: false,
      code: "posting-ballot",
    });
  });

  test("keeps no reference to the bytes it was given", () => {
    const posting = postingFor(first, 1);
    const ballot = Uint8Array.from(first.payload);
    const r = admission.posting(posting, ballot);
    posting.fill(0);
    ballot.fill(0);
    expect(r).toMatchObject({ ok: true, ballotHash: first.hash });
  });
});

describe("the records", () => {
  test.each([
    ["truncated", (r: Uint8Array) => r.subarray(0, r.length - 1), "truncated"],
    ["with a trailing byte", (r: Uint8Array) => Uint8Array.of(...r, 0), "trailing-bytes"],
    [
      "of another record type",
      (r: Uint8Array) => Uint8Array.of(0x00, 0x0c, ...r.subarray(2)),
      "unexpected-record-type",
    ],
    // Version 2 is ballot version 4's, never version 3's.
    [
      "of version 2",
      (r: Uint8Array) => Uint8Array.of(r[0]!, r[1]!, 2, ...r.subarray(3)),
      undefined,
    ],
    ["empty", () => new Uint8Array(0), "truncated"],
  ])("a posting %s doesn't decode", (_, change, decodeError) => {
    const r = admission.posting(change(postingFor(first, 1)), first.payload);
    expect(r).toMatchObject({ ok: false, code: "decode" });
    if (decodeError !== undefined) expect(r).toMatchObject({ decodeError });
  });

  test("a ballot that doesn't decode as a ballot record is refused before the posting is read", () => {
    for (const [ballot, decodeError] of [
      [first.payload.subarray(0, first.payload.length - 1), "truncated"],
      [Uint8Array.of(...first.payload, 0), "trailing-bytes"],
      [transcript, "unexpected-record-type"],
      [new Uint8Array(0), "truncated"],
    ] as const)
      expect(admission.posting(new Uint8Array(0), ballot)).toEqual({
        ok: false,
        code: "ballot-decode",
        decodeError,
      });
  });

  test("a ballot of a version whose postings aren't relayed yet is refused before it is decoded", () => {
    for (const version of [0, 1, 2, 4, 255]) {
      const ballot = Uint8Array.from(first.payload);
      ballot[2] = version;
      expect(admission.posting(postingFor(first, 1), ballot)).toEqual({
        ok: false,
        code: "unsupported-version",
      });
    }
  });

  test("a posting naming another definition than its ballot's is refused", () => {
    const other = new Uint8Array(32).fill(7);
    expect(
      admission.posting(postingFor(first, 1, { definitionHash: other }), first.payload),
    ).toEqual({ ok: false, code: "posting-definition" });
    const elsewhere = Uint8Array.from(first.payload);
    elsewhere[3] = (elsewhere[3] as number) ^ 1;
    expect(admission.posting(postingFor(first, 1), elsewhere)).toEqual({
      ok: false,
      code: "posting-definition",
    });
  });

  test("a posting and ballot of another definition pass the form check alone, never the election's", () => {
    const other = new Uint8Array(32).fill(7);
    const { ballot, hash } = rewritten(first, { definition_hash: other });
    const posting = postingFor(first, 1, { definitionHash: other, ballotHash: hash });
    expect(postingForm(posting, ballot)).toMatchObject({
      ok: true,
      definitionHash: other,
      ballotHash: hash,
      seat: 1,
    });
    expect(admission.posting(posting, ballot)).toEqual({ ok: false, code: "posting-definition" });
  });

  test("a ballot naming no cell of the election is refused", () => {
    const { ballot, hash } = rewritten(first, { cell: 255 });
    expect(admission.posting(postingFor(first, 1, { ballotHash: hash }), ballot)).toEqual({
      ok: false,
      code: "posting-cell",
    });
  });

  test("a posting whose ballot hash isn't the ballot's is refused", () => {
    expect(
      admission.posting(postingFor(first, 1, { ballotHash: second.hash }), first.payload),
    ).toEqual({ ok: false, code: "posting-ballot" });
  });

  test("a seat outside the registered key set is refused", () => {
    for (const seat of [0, definition.panel_size + 1, 255])
      expect(admission.posting(postingFor(first, 1, { seat }), first.payload)).toEqual({
        ok: false,
        code: "posting-seat",
      });
  });
});

describe("the public check", () => {
  test("another seat's ciphertext of the ballot fails its share hash", () => {
    expect(admission.posting(postingFor(first, 1, { ciphertextOf: 2 }), first.payload)).toEqual({
      ok: false,
      code: "posting-hash",
    });
  });

  test("another seat's ML-KEM message fails the re-encapsulation", () => {
    expect(
      admission.posting(
        postingFor(first, 1, { m: first.messages[1] as Uint8Array }),
        first.payload,
      ),
    ).toEqual({ ok: false, code: "posting-encapsulation" });
  });

  test("a ballot whose share hash for the seat is the ciphertext's, under another VSS, fails the proof", () => {
    // The ciphertext of `second`'s seat 1 under a ballot whose hashes are
    // `second`'s but whose VSS is `first`'s: its proof binds `second`'s VSS.
    const a = decodeBallot(first.payload, 3);
    const b = decodeBallot(second.payload, 3);
    const vote = { ...a.committed_vote, share_hashes: b.committed_vote.share_hashes };
    const mixed = { ...a, committed_vote: vote };
    const hash = ballotHashV3(
      { definitionHash: a.definition_hash, cell: a.cell, nullifier: a.nullifier },
      vote,
    );
    const posting = postingFor(second, 1, { ballotHash: hash });
    expect(admission.posting(posting, encodeBallotV3(mixed))).toEqual({
      ok: false,
      code: "posting-proof",
    });
  });

  test("any single-byte change to an honest posting stops it", () => {
    const posting = postingFor(first, 2);
    fc.assert(
      fc.property(
        fc.nat({ max: posting.length - 1 }),
        fc.integer({ min: 1, max: 255 }),
        (at, flip) => {
          const changed = Uint8Array.from(posting);
          changed[at] = (changed[at] as number) ^ flip;
          expect(admission.posting(changed, first.payload).ok).toBe(false);
        },
      ),
      { numRuns },
    );
  });
});

test("an election of a definition version whose postings aren't relayed yet refuses every one", () => {
  const file = JSON.parse(
    readFileSync(
      new URL("../../../docs/spec/vectors/verifier-ballots.json", import.meta.url),
      "utf8",
    ),
  ) as {
    readonly panels: Readonly<Record<string, { threshold: string; keys: string[] }>>;
    readonly cases: readonly { id: string; panel: string; definition: string; board: string }[];
  };
  const c = file.cases.find((x) => x.id === "admitted");
  if (c === undefined) throw new Error("no admitted case");
  const p = file.panels[c.panel];
  if (p === undefined) throw new Error("no panel");
  const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
  const v1 = electionAdmission(
    hex(c.definition),
    { threshold: Number(p.threshold), keys: p.keys.map(hex) },
    splitEntries(hex(c.board)).entries,
  );
  if (!v1.ok) throw new Error(`election refused: ${v1.code}`);
  expect(v1.posting(postingFor(first, 1), first.payload)).toEqual({
    ok: false,
    code: "unsupported-version",
  });
});
