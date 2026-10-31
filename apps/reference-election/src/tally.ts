// Stage 6 of the reference election, and the trustees' side of stage 4: each
// seat's intake of every cast ballot, its share receipts boarded as the
// ballot's delivery records (docs/spec/share-encryption.md, Intake and
// receipts; docs/spec/delivery.md), then, past the close, the cell's tally
// from the counted ballots' shares (docs/spec/tally.md: Summed shares,
// Summed-share message, Combination, Opening record) and each seat's
// destruction statement (Destruction). The fixture runs every trustee node
// here, through @abolishus/crypto's production entry points; it judges
// nothing for the run: the verifier does (7.1 to 7.3, 8.5).

import {
  aggregateCell,
  aggregateHash,
  type BallotElection,
  type CommittedVote,
  decodeBallot,
  encodeDestructionStatement,
  encodeShareReceipt,
  encodeTallyOpening,
  intakeBallot,
  openCell,
  openSummedShares,
  type QuestionBallotElection,
  type RegisteredKeys,
  sealSummedShares,
  type Share,
  shareReceiptRecord,
  signDestructionStatement,
  signTallyOpening,
  sumShares,
  tallyRules,
} from "@abolishus/crypto";
import { definitionHash, type FixtureDefinition, type SeatKeys } from "./election.ts";

/**
 * The definitions the fixture tallies: one question or questions over a
 * fixed electorate, or a rolling poll's questions, one cell per rolling tier
 * (docs/spec/tally.md, Rolling tiers).
 */
type Tallied = FixtureDefinition;

/** A ballot as every seat took it in: its share receipts to board, and each seat's shares. */
export interface Intake {
  /** Each seat's share receipt (`0x000b`), in seat order: the ballot's delivery records. */
  readonly receipts: readonly Uint8Array[];
  /** Each seat's decrypted shares of the ballot, by seat. */
  readonly shares: ReadonlyMap<number, readonly Share[]>;
}

/**
 * Every seat's intake of one cast ballot, `record`, with its ciphertext
 * (`ciphertexts[i]` is seat `i + 1`'s): the admission checks, decryption and
 * the signed receipt, as a trustee node runs them before receipting. An
 * honest ballot that any seat refuses stops the run, since that is a fault
 * in the protocol code, not something to board.
 */
export function intake(
  election: BallotElection | QuestionBallotElection,
  secrets: readonly SeatKeys[],
  record: Uint8Array,
  ciphertexts: readonly Uint8Array[],
): Intake {
  const receipts: Uint8Array[] = [];
  const shares = new Map<number, readonly Share[]>();
  for (const s of secrets) {
    const ciphertext = ciphertexts[s.index - 1];
    if (ciphertext === undefined) throw new Error(`no share ciphertext for seat ${s.index}`);
    const keys = { seat: s.index, kemSecret: s.kemSecret, signingSecret: s.signingSecret };
    const taken = intakeBallot(election, keys, record, ciphertext);
    if (!taken.ok) throw new Error(`seat ${s.index} refused an honest ballot: ${taken.code}`);
    receipts.push(encodeShareReceipt(shareReceiptRecord(election.definitionHash, s.index, taken)));
    shares.set(s.index, taken.shares);
  }
  return { receipts, shares };
}

/** A counted ballot: its boarded record and the shares each seat took from it. */
export interface Counted {
  readonly payload: Uint8Array;
  readonly shares: ReadonlyMap<number, readonly Share[]>;
}

/**
 * The ballot's VSS commitments, decoded under the ballot version the
 * definition pins: under a rolling poll's ballot version 5, the default
 * panel's, the only half a poll without an author panel has.
 */
function vssOf(d: Tallied, payload: Uint8Array): CommittedVote["vss"] {
  switch (d.version) {
    case 1:
      return decodeBallot(payload, 1).committed_vote.vss;
    case 5:
      return decodeBallot(payload, 3).committed_vote.vss;
    case 7:
      return decodeBallot(payload, 5).committed_vote.vss;
  }
}

/**
 * The one cell's tally opening (`0x0006`, version 1) over `counted`, the
 * cell's counted set: every seat sums its shares of the counted ballots
 * (Summed shares) and seals its sums to seat 1 in a summed-share message,
 * under seat 1's registered KEM key and signed with its own key (T-37,
 * T-39); seat 1 opens each against its own aggregate (T-29), combines the
 * `k` lowest passing seats (Combination) and signs the opening. Summed shares
 * never reach the board ([[0015-tally-publication]]; T-15).
 */
export function tallyOpening(
  d: Tallied,
  registered: readonly RegisteredKeys[],
  secrets: readonly SeatKeys[],
  counted: readonly Counted[],
): Uint8Array {
  const rules = tallyRules(d);
  const vss = counted.map((b) => vssOf(d, b.payload));
  const aggregate = aggregateCell(rules, vss);
  const sums = new Map(
    secrets.map((s) => [
      s.index,
      sumShares(
        rules,
        counted.map((b) => {
          const share = b.shares.get(s.index);
          if (share === undefined) throw new Error(`seat ${s.index} holds no share of a ballot`);
          return share;
        }),
      ),
    ]),
  );
  const [combiner] = secrets;
  if (combiner === undefined) throw new Error("no seat to combine");
  const held = new Map<number, readonly Share[]>([
    [combiner.index, sums.get(combiner.index) as readonly Share[]],
  ]);
  const election = { definition: d, aggregates: [aggregate], registered };
  for (const s of secrets.slice(1)) {
    const sealed = sealSummedShares(
      { definition: d, cell: 0, aggregate },
      registered,
      { index: s.index, signingSecret: s.signingSecret },
      combiner.index,
      sums.get(s.index) as readonly Share[],
    );
    const got = openSummedShares(
      election,
      { index: combiner.index, secretKey: combiner.kemSecret },
      sealed,
    );
    if (!got.ok || got.cell !== 0 || got.sender !== s.index)
      throw new Error(`seat ${s.index}'s summed-share message didn't pass`);
    held.set(got.sender, got.summed);
  }
  const opened = openCell(rules, vss, held);
  if (!opened.ok) throw new Error(`the cell didn't open: ${opened.code}`);
  const signer = opened.combined[0] as number;
  const secret = secrets.find((s) => s.index === signer);
  if (secret === undefined) throw new Error("the signer holds no key");
  return encodeTallyOpening(
    signTallyOpening(secret.signingSecret, {
      definition_hash: definitionHash(d),
      cell: 0,
      aggregate_hash: aggregateHash(aggregate),
      signer,
      opening: opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint })),
    }),
  );
}

/**
 * Each seat's destruction statement (`0x000f`, version 1), signed once its
 * node has seen every cell's opening anchored: the signing key's last use
 * (docs/spec/tally.md, Destruction; T-14, T-40, T-69).
 */
export function destructionStatements(d: Tallied, secrets: readonly SeatKeys[]): Uint8Array[] {
  const hash = definitionHash(d);
  return secrets.map((s) =>
    encodeDestructionStatement(
      signDestructionStatement(s.signingSecret, { definition_hash: hash, signer: s.index }),
    ),
  );
}
