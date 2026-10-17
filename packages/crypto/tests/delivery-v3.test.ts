import { sha256 } from "@noble/hashes/sha2.js";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";
import {
  ballotHashV3,
  type BallotRecordV3,
  checkDelivery,
  decodeBallot,
  type DeliveryBallot,
  deliveryBallotHash,
  type DeliveryElection,
  type DeliveryEntry,
  encodeShareReceipt,
  identityKey,
  kemKeygen,
  type RegisteredKeys,
  shareReceiptRecord,
  shareReceiptStatement,
  signStatement,
} from "../src/index.ts";
import { hex, SPEC_VECTORS } from "./spec-vectors.ts";

// Delivery for ballot version 3 (docs/spec/ballot-validity.md, Shares and
// delivery (version 3)): version 1's records and windows, with the ballot
// hash a record names recomputed under version 3, over the question range
// proofs (Hashes (version 3)). The ballots and their expected ballot hashes
// are docs/spec/vectors/ballot-v3-records.json's, from an independent Python
// implementation (scripts/ballot-v3-records-vectors.py), never from the code
// under test; the seats' signing keys and receipts are this test's own.

const vectors = JSON.parse(
  readFileSync(new URL("ballot-v3-records.json", SPEC_VECTORS), "utf8"),
) as {
  readonly ballots: readonly {
    readonly id: string;
    readonly encoding: string;
    readonly ballotHash: string;
    readonly result: string;
  }[];
};

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const text = (s: string) => new TextEncoder().encode(s);

const decoded = vectors.ballots.map((b) => ({
  ...b,
  record: decodeBallot(hex(b.encoding), 3) as BallotRecordV3,
}));
const admitted = decoded.filter((b) => b.result === "ok");

const asDelivery = (r: BallotRecordV3): Extract<DeliveryBallot, { ballotVersion: 3 }> => ({
  ballotVersion: 3,
  cell: r.cell,
  nullifier: r.nullifier,
  vote: r.committed_vote,
});

describe("the ballot hash a version-3 ballot's delivery records name", () => {
  test("is the vectors' version-3 ballot hash for every record", () => {
    expect(decoded.length).toBeGreaterThan(0);
    for (const b of decoded)
      expect(toHex(deliveryBallotHash(b.record.definition_hash, asDelivery(b.record)))).toBe(
        b.ballotHash,
      );
  });
});

describe("checkDelivery over a version-3 ballot", () => {
  const [first] = admitted as [(typeof admitted)[number], ...(typeof admitted)[number][]];
  const r = first.record;
  const definitionHash = r.definition_hash;
  const panelSize = r.committed_vote.share_hashes.length;
  const seats = Array.from({ length: panelSize }, (_, i) => i + 1);
  const secret = (seat: number) => sha256(text(`delivery-v3.test seat ${seat}`));
  const kemKey = kemKeygen().publicKey;
  const registered: RegisteredKeys[] = seats.map((index) => ({
    index,
    kemKey,
    signingKey: identityKey(secret(index)),
  }));
  const election: DeliveryElection = {
    definitionHash,
    panelSize,
    registered,
    segments: { delivery: 10n, complaint: 20n },
    deadlines: { delivery: 1_000n, complaint: 2_000n },
  };
  const ballot = asDelivery(r);

  /** Seat `seat`'s version-1 receipt for the ballot hash `ballotHash`, boarded in segment 5. */
  const receipt = (seat: number, ballotHash: Uint8Array): DeliveryEntry => {
    const shareHash = r.committed_vote.share_hashes[seat - 1] as Uint8Array;
    const m = shareReceiptStatement({
      definition_hash: definitionHash,
      ballot_hash: ballotHash,
      seat,
      share_hash: shareHash,
    });
    const payload = encodeShareReceipt(
      shareReceiptRecord(definitionHash, seat, {
        ballotHash,
        shareHash,
        receipt: signStatement(secret(seat), "abolish/v1/sig/share-receipt", m),
      }),
    );
    return { path: "board", segment: 5, payload };
  };
  const own = ballotHashV3(
    { definitionHash, cell: r.cell, nullifier: r.nullifier },
    r.committed_vote,
  );

  test("every seat's receipt over its version-3 hash delivers it", () => {
    const got = checkDelivery(
      election,
      [ballot],
      seats.map((s) => receipt(s, own)),
      1,
    );
    expect(got.ballots).toEqual([
      { ballotHash: own, counted: true, delivered: true, missing: [], excludedBy: [] },
    ]);
    expect(got.records).toEqual([]);
  });

  test("a receipt over the same ballot named in another cell delivers nothing (T-38)", () => {
    const other = ballotHashV3(
      { definitionHash, cell: (r.cell + 1) % 256, nullifier: r.nullifier },
      r.committed_vote,
    );
    const got = checkDelivery(
      election,
      [ballot],
      [receipt(1, other), ...seats.slice(1).map((s) => receipt(s, own))],
      1,
    );
    expect(got.ballots[0]).toMatchObject({ counted: false, delivered: false, missing: [1] });
  });

  test("refuses a version-3 ballot that didn't pass validity-shape", () => {
    const short: DeliveryBallot = {
      ...asDelivery(r),
      vote: { ...r.committed_vote, share_hashes: r.committed_vote.share_hashes.slice(1) },
    };
    expect(() => checkDelivery(election, [short], [], 1)).toThrow(RangeError);
  });
});
