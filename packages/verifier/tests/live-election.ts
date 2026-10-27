// Test only: a live election cast under a sealed version-6 or fixed
// version-7 definition made live, for tests/live.test.ts and
// tests/live-definition-v7.test.ts. `releaseChecks` runs on it with
// @abolishus/crypto's client and trustee paths (`shareVoteV4`,
// `proveValidityV4`, the receipt and running-opening signatures,
// `openCell`), never with the checks under test. Every ballot, receipt and
// opening binds the hash `readDefinition` gives, unless a test signs a
// receipt or an opening for another one.

import { readFileSync } from "node:fs";
import {
  aggregateCell,
  aggregateHash,
  type AnchorClock,
  ballotHashV4,
  type CommittedVoteV4,
  decode,
  decodeBoardEntry,
  encodeBoardEntry,
  encodeElectionDefinitionV6,
  encodeElectionDefinitionV7,
  encodeRunningOpening,
  encodeShareReceiptV2,
  identityKey,
  KEM_PUBLIC_KEY,
  openCell,
  proveValidityV4,
  type QuestionRules,
  RECORD_TYPES,
  type RegisteredKeys,
  RESULTS_MODES,
  type Share,
  shareReceiptRecordV2,
  shareReceiptStatementV4,
  shareVoteV4,
  signRunningOpening,
  signStatement,
  sumShares,
  tallyRules,
  type VoteSharingV4,
} from "@abolishus/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { type LiveBallotCopy } from "../src/ballots.ts";
import { decodeDefinition, type PanelledRecord, readDefinition } from "../src/definition.ts";
import { decodeHeader, splitEntries } from "../src/index.ts";
import { type ReleaseInputs } from "../src/live.ts";
import { run, toHex } from "./headers.ts";

const VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);
const hex = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const text = (s: string) => new TextEncoder().encode(s);

const delivery = JSON.parse(readFileSync(new URL("delivery-v2.json", VECTORS), "utf8")) as {
  readonly seats: { readonly default: readonly { readonly kemKey: string }[] };
};
const KEM = decode(
  KEM_PUBLIC_KEY,
  hex((delivery.seats.default[0] as { readonly kemKey: string }).kemKey),
);

export interface Cast {
  readonly cell: number;
  readonly nullifier: bigint;
  readonly vote: CommittedVoteV4;
  readonly hash: Uint8Array;
  readonly sharing: VoteSharingV4;
}

// Pick the first option of each question: one of three, up to two of four,
// exactly one of two.
export const VOTE: readonly (0 | 1)[] = [1, 0, 0, 1, 0, 0, 0, 1, 0];
const OTHER: readonly (0 | 1)[] = [0, 1, 0, 0, 1, 0, 0, 0, 1];

export const counts = (ballots: number, votes: readonly (0 | 1)[]) =>
  votes.map((v) => String(v * ballots));

/** `sealed`'s definition record with the live fields, under its own version. */
function madeLive(sealed: PanelledRecord): PanelledRecord {
  const live = { results_mode: RESULTS_MODES.live, live_every: 24, live_batch: 20 };
  const encoded =
    sealed.version === 6
      ? encodeElectionDefinitionV6({ ...sealed.value, ...live })
      : encodeElectionDefinitionV7({ ...sealed.value, ...live });
  return decodeDefinition(encoded) as PanelledRecord;
}

/**
 * A sealed definition (hex) made live: releases every 24 hourly periods, a
 * batch of 20. Under verifier-ballots-v4.json's `admitted` definition and its
 * version-7 copy, tier 0 has cells 0 and 1 and tier 2 cell 2. `board` is a
 * board of that definition's whose first ballot payload stands for every
 * ballot's entry: `releaseChecks` reads its copies from admission.
 */
export function liveElection(sealedHex: string, board: string) {
  const definition = madeLive(decodeDefinition(hex(sealedHex)) as PanelledRecord);
  const d = definition.value;
  const { hash, rule } = readDefinition(definition);
  const RULES = tallyRules(definition);
  const OPENS = d.opens_at;
  const CLOSES = d.closes_at;
  const CLOCK: AnchorClock = { epoch: OPENS, period: 3600n, deadline: 600n, lastSegment: 1000 };

  // Seats 1 to 3 of the 3-of-4 default panel, with signing keys of the test's own.
  const SEATS = [1, 2, 3];
  const SECRETS = [1, 2, 3, 4].map((i) => sha256(text(`live.test seat ${i}`)));
  const secret = (seat: number) => SECRETS[seat - 1] as Uint8Array;
  const REGISTERED: RegisteredKeys[] = SEATS.map((index) => ({
    index,
    kemKey: KEM,
    signingKey: identityKey(secret(index)),
  }));

  // A finalized header every 12 hours from just before opening to after close.
  const BLOCKS = run(
    21_000_000n,
    Array.from({ length: 17 }, (_, k) => OPENS - 12n + BigInt(k) * 43_200n),
  ).map((h) => decodeHeader(h.encoded));
  const REFERENCE = 21_000_000n;

  let nextNullifier = 5_000n;
  const rules = {
    questions: RULES.questions as readonly QuestionRules[],
    threshold: RULES.threshold,
    panelSize: RULES.panelSize,
    authorThreshold: 0,
    authorPanelSize: 0,
  };
  /** A version-4 ballot in cell 2 with these flat votes, by a new nullifier unless one is given. */
  function cast(votes: readonly (0 | 1)[], nullifier = nextNullifier++): Cast {
    const sharing = shareVoteV4(rules, votes);
    const shareHashes = Array.from({ length: RULES.panelSize }, (_, i) =>
      SEATS.includes(i + 1)
        ? sha256(text(`share ${nullifier} ${i + 1} ${votes.join("")}`))
        : new Uint8Array(32),
    );
    const vote = proveValidityV4(
      { ...rules, definitionHash: hash, cell: 2, nullifier },
      sharing,
      shareHashes,
      [],
    );
    return {
      cell: 2,
      nullifier,
      vote,
      hash: ballotHashV4({ definitionHash: hash, cell: 2, nullifier }, vote),
      sharing,
    };
  }

  const BATCH_A = Array.from({ length: 20 }, () => cast(VOTE));
  const BATCH_B = Array.from({ length: 20 }, () => cast(OTHER));
  // A re-voter: two distinct ballots of one nullifier before the first snapshot.
  const FIRST = cast(VOTE);
  const SECOND = cast(OTHER, FIRST.nullifier);
  const PLACEHOLDER = (() => {
    const { entries } = splitEntries(hex(board));
    for (const e of entries) {
      const { payload } = decodeBoardEntry(e, 5);
      if (((payload[0] as number) << 8) + (payload[1] as number) === RECORD_TYPES.ballot)
        return payload;
    }
    throw new Error("fixture: no ballot");
  })();

  /** One board under board-entry version 6, which carries running openings. */
  function election() {
    const entries: Uint8Array[] = [];
    const copies: LiveBallotCopy[] = [];
    const board = (segment: number, payload: Uint8Array) => {
      entries.push(
        encodeBoardEntry(
          { election_id: d.election_id, index: BigInt(entries.length), segment, payload },
          6,
        ),
      );
      return entries.length - 1;
    };
    /** `b`'s copy; `message` stands in for M, one per ballot unless another L1 reference is given. */
    const ballot = (b: Cast, segment: number, message = sha256(b.hash)) => {
      const entry = board(segment, PLACEHOLDER);
      copies.push({
        entry,
        segment,
        tier: 2,
        cell: b.cell,
        nullifier: b.nullifier,
        message,
        member: true,
        rejected: false,
        reference: REFERENCE,
        referenceKnown: true,
        tally: {
          cell: b.cell,
          vss: b.vote.vss,
          deliveryV4: { cell: b.cell, nullifier: b.nullifier, vote: b.vote },
        },
      });
    };
    /** Seat `seat`'s receipt for `b`, made for `definitionHash` (the election's unless given). */
    const receipt = (b: Cast, seat: number, signer = seat, definitionHash = hash) => {
      const shareHash = b.vote.share_hashes[seat - 1] as Uint8Array;
      const m = shareReceiptStatementV4({
        definition_hash: definitionHash,
        ballot_hash: b.hash,
        panel: 1,
        seat,
        share_hash: shareHash,
      });
      return encodeShareReceiptV2(
        shareReceiptRecordV2(definitionHash, seat, {
          panel: 1,
          ballotHash: b.hash,
          shareHash,
          receipt: signStatement(secret(signer), "abolish/v1/sig/share-receipt-2", m),
        }),
      );
    };
    const deliver = (
      ballots: readonly Cast[],
      segment: number,
      seats = SEATS,
      definitionHash = hash,
    ) => {
      for (const b of ballots)
        for (const seat of seats) board(segment, receipt(b, seat, seat, definitionHash));
    };
    /**
     * Seats 1 to k's opening of `set` in cell 2 as release `snapshot`, signed
     * by `signer` for `definitionHash` (the election's unless given).
     */
    const opening = (
      set: readonly Cast[],
      snapshot: number,
      signer: number,
      tamper?: (o: Share[]) => Share[],
      definitionHash = hash,
    ) => {
      const vss = set.map((b) => b.vote.vss);
      const summed = new Map(
        SEATS.slice(0, RULES.threshold).map((seat) => [
          seat,
          sumShares(
            RULES,
            set.map((b) => b.sharing.shares[seat - 1] as readonly Share[]),
          ),
        ]),
      );
      const opened = openCell(RULES, vss, summed);
      if (!opened.ok) throw new Error(`fixture: the set doesn't open (${opened.code})`);
      const shares = opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint }));
      return encodeRunningOpening(
        signRunningOpening(secret(signer), {
          definition_hash: definitionHash,
          cell: 2,
          snapshot,
          aggregate_hash: aggregateHash(aggregateCell(RULES, vss)),
          signer,
          opening: tamper === undefined ? shares : tamper(shares),
        }),
      );
    };
    const counted = (ballots: readonly Cast[]) => [
      new Set<string>(),
      new Set<string>(),
      new Set(ballots.map((b) => toHex(sha256(b.hash)))),
    ];
    const inputs = (over: Partial<ReleaseInputs> = {}): ReleaseInputs => ({
      definition,
      definitionHash: hash,
      registered: REGISTERED,
      copies,
      entries,
      boardEntryVersion: 6,
      extent: entries.length,
      clock: CLOCK,
      blocks: BLOCKS,
      counted: counted([...BATCH_A, ...BATCH_B, SECOND]),
      ...over,
    });
    return { entries, board, ballot, deliver, opening, inputs };
  }

  /**
   * Batch A cast and receipted before snapshot 1 (σ_1 = 23), batch B before
   * snapshot 2 (σ_2 = 47), and a re-voter's two ballots before snapshot 1.
   */
  function honest(withhold = false) {
    const e = election();
    for (const b of BATCH_A) e.ballot(b, 10);
    e.ballot(FIRST, 10);
    e.ballot(SECOND, 12);
    // Seat 3's receipts for batch A wait until after snapshot 1 when it withholds them.
    e.deliver([...BATCH_A], 11, withhold ? [1, 2] : SEATS);
    if (withhold) e.deliver([...BATCH_A], 30, [3]);
    e.deliver([FIRST, SECOND], 13);
    for (const b of BATCH_B) e.ballot(b, 30);
    e.deliver([...BATCH_B], 31);
    return e;
  }

  return {
    definition,
    hash,
    rule,
    OPENS,
    CLOSES,
    BLOCKS,
    BATCH_A,
    BATCH_B,
    election,
    honest,
  };
}
