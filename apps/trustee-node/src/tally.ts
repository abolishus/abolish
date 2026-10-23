// A seat's tally duty (docs/spec/tally.md: Summed shares, Summed-share
// message, Combination, Opening record): once the counted set is fixed and
// anchored, the seat sums its shares of each cell's counted ballots, checks
// its own sums against the cell's aggregate, seals them to every other
// registered seat in a summed-share message, checks the messages it
// receives, and, holding passing sums from `k` seats for a cell, combines
// them and signs the cell's opening. It signs at most one opening per cell:
// the opening is written once before it is handed out, so a crash or a later
// message never makes it sign a second (T-29, T-14, T-15, T-37).
//
// The duty reads the counted set only once the summed-share rule allows:
// past `t_A' + R`, with each point's quorum of attestations read from the
// seat's own nodes (`summingRule`; docs/spec/availability.md, What a seat
// does), and never if the election failed `unavailable` (T-54, T-24). The
// counted set is the deployment's to read, from the anchored counted extent
// through packages/verifier; the channel between nodes is the deployment's
// too. This duty never chooses a set: it sums over
// exactly what the source fixes, only for the cells of the registered
// partition, and refuses to go on if the source ever gives another set
// (T-14, T-16, T-29).
//
// Summed shares and the messages received are held in memory only, never in
// the store: they are among what the seat destroys after the tally, and are
// recomputed or resent after a restart (Destruction; [[0015-tally-publication]]).
import {
  aggregateCell,
  aggregateHash,
  ballotHash,
  ballotHashV3,
  bytesFixed,
  type CellAggregate,
  ceremonyTranscriptHash,
  checkCeremonyTranscript,
  checkSummedShares,
  type CommittedVote,
  decodeBallot,
  DecodeError,
  EncodeError,
  type ElectionDefinition,
  electionDefinitionHash,
  type ElectionDefinitionV5,
  electionDefinitionV5Hash,
  encodeTallyOpening,
  identityKey,
  KEM_PUBLIC_KEY,
  encode,
  keySetEntry,
  keySetHash,
  openCell,
  openSummedShares,
  type RegisteredKeys,
  sealSummedShares,
  type Share,
  signTallyOpening,
  sumShares,
  type TallyRules,
  tallyRules,
} from "@abolishus/crypto";
import type { ApprovedElection, IntakeSecrets } from "./ceremony.ts";
import { heldShares } from "./intake.ts";
import type { SeatStore } from "./store.ts";
import type { SummingRule } from "./summing.ts";
import type { Pins } from "./stub.ts";

/**
 * A registered definition of a version the tally reads: version 1 (one cell
 * per tier, one question) or version 5 (every tier's regional cells, several
 * questions), the stubs the ceremony and intake take. A bare definition is
 * version 1's, as crypto's summed-share calls read it.
 */
export type TallyDefinition =
  | ElectionDefinition
  | { readonly version: 1; readonly value: ElectionDefinition }
  | { readonly version: 5; readonly value: ElectionDefinitionV5 };

/** What the deployment reads of the counted set, from the anchored counted extent. */
export type CountedSet =
  /** The counted extent isn't read yet: nothing is fixed. */
  | { readonly state: "waiting" }
  /**
   * A panel's threshold didn't attest the ballot extent or the counted
   * extent in time: the election failed `unavailable`, and no summed share
   * is ever sent (docs/spec/availability.md; T-54, T-24).
   */
  | { readonly state: "unavailable" }
  /**
   * The source can't give a set the verifier would recompute: the extent
   * carries a contract event the seat's own L2 node doesn't show, a row is
   * undecided for a reason no later input changes, or the seat holds no
   * counted extent. The duty reports it as its own `refused` and sends
   * nothing (T-14, T-16).
   */
  | { readonly state: "refused"; readonly reason: string }
  /**
   * The counted set, fixed: for each cell of the registered partition, in
   * order, the ballot records of its counted ballots (version 1 under
   * definition version 1, version 3 under version 5), as the
   * anchored counted extent holds them. It must come from the seat's own
   * finalized L1 and L2 nodes through packages/verifier, never a served
   * value: sums over a set other than the anchored one, beside the
   * published opening, let `k − 1` other trustees open the ballots the sets
   * differ by (T-14, T-16).
   */
  | { readonly state: "fixed"; readonly cells: readonly (readonly Uint8Array[])[] };

/** The channel to the other seats' nodes, which negotiates hybrid post-quantum TLS. */
export interface SummedSharePeers {
  /**
   * Sends a summed-share message to seat `recipient`'s node; resolves once
   * it is sent, and throws if it can't be sent now. The receiving node
   * acknowledges a message on arrival, before and whatever `receive` makes
   * of it, so neither its answer nor its timing tells the sender which
   * check failed (docs/spec/tally.md, Summed-share message, Notes; T-39). Never through the board,
   * IPFS, the archive or any store that keeps it after delivery
   * ([[0015-tally-publication]]; T-15).
   */
  send(recipient: number, message: Uint8Array): Promise<void>;
}

export interface TallyDutyOptions extends Pins {
  readonly election: ApprovedElection;
  /** The transcript and key set the seat's approval signed for. */
  readonly secrets: Pick<IntakeSecrets, "transcriptHash" | "keySetHash">;
  /**
   * The registered definition (version 1 or 5) and its ceremony transcript, as
   * the deployment reads them. Checked against what the seat approved, never
   * trusted: the definition must hash to the approved definition hash, and
   * the transcript's check must return the approved key set (T-37).
   */
  readonly definition: TallyDefinition;
  readonly transcript: Uint8Array;
  readonly store: SeatStore;
  /**
   * The summed-share rule (`summingRule` over the seat's own nodes), asked
   * before the counted set is read, with the panel the approved key set
   * gives: nothing is read or sent until it finds both points available.
   */
  readonly summing: SummingRule;
  /** Read only once `summing` allows. */
  readonly counted: (election: ApprovedElection) => Promise<CountedSet>;
  readonly peers: SummedSharePeers;
}

/** Where one cell stands after a step. */
export type CellStatus =
  /** The seat signed the cell's opening; it is in `openings()`. */
  | { readonly state: "opened" }
  /**
   * The seat holds passing sums from `held` seats, fewer than `k`, and sent
   * its own to `sent` of the other seats this step (none if it holds no
   * sums of its own).
   */
  | { readonly state: "combining"; readonly held: number; readonly sent: number }
  /**
   * The seat holds no shares of `missing` of the cell's counted ballots, so
   * it has no sums of its own to send; it can still combine the other seats'.
   * An alarm for the node's operator.
   */
  | { readonly state: "missing-shares"; readonly missing: number; readonly held: number };

/** Where the tally duty stands after a step. */
export type TallyDutyStatus =
  /** The summed-share rule doesn't allow summing yet, or the counted set isn't read. */
  | { readonly state: "waiting" }
  /** A point lacks a panel's quorum of attestations in time: no summed share is ever sent. */
  | { readonly state: "unavailable" }
  /**
   * The source gave a counted set the seat can't sum over: a ballot of
   * another election or cell, one that doesn't decode or match the
   * election's shape, a voter counted twice, another number of cells, or a
   * set other than the one it gave before; or the definition or transcript
   * isn't the approved one, or an attestation that counts names a root
   * whose leaf object the seat doesn't hold. The seat sends nothing for the
   * election. An alarm for the node's operator.
   */
  | { readonly state: "refused"; readonly reason: string }
  | { readonly state: "tallying"; readonly cells: readonly CellStatus[] };

interface Cell {
  readonly vss: readonly CommittedVote["vss"][];
  readonly aggregate: CellAggregate;
  /** The seat's own sums, which passed its own check; none if it lacks shares of `missing` counted ballots. */
  readonly own: readonly Share[] | undefined;
  readonly missing: number;
}

type Definition = Exclude<TallyDefinition, ElectionDefinition>;

interface Fixed {
  readonly definition: Definition;
  readonly registered: readonly RegisteredKeys[];
  readonly rules: TallyRules;
  readonly cells: readonly Cell[];
}

// The node's own storage, not protocol bytes.
const HASH = bytesFixed(32);

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

class Refused extends Error {}

/**
 * The tally duty of one seat for one election it approved. `step` is
 * idempotent: the node calls it on a schedule, and hands every summed-share
 * message that reaches it to `receive`.
 */
export class TallyDuty {
  readonly #o: TallyDutyOptions;
  #fixed: Fixed | undefined;
  // The definition and key set once checked against the approval: the rule
  // is asked each step, for as long as it waits.
  #approved: { definition: Definition; registered: readonly RegisteredKeys[] } | undefined;
  // Each cell's passing sums by sending seat, from messages received since
  // the node started: they are resent by their senders after a restart.
  readonly #received = new Map<number, Map<number, readonly Share[]>>();

  constructor(options: TallyDutyOptions) {
    this.#o = options;
  }

  async step(): Promise<TallyDutyStatus> {
    const fixed = await this.#fix();
    if (!("rules" in fixed)) return fixed;
    const { election, peers } = this.#o;
    const recipients = fixed.registered.map((k) => k.index).filter((i) => i !== election.index);
    const cells: CellStatus[] = [];
    for (const [c, cell] of fixed.cells.entries()) {
      const held = this.#held(c, cell);
      let opened = await this.#opening(c);
      if (opened === undefined && held.size >= fixed.rules.threshold)
        opened = await this.#combine(fixed, c, cell, held);
      if (opened !== undefined) {
        cells.push({ state: "opened" });
        continue;
      }
      if (cell.own === undefined) {
        cells.push({ state: "missing-shares", missing: cell.missing, held: held.size });
        continue;
      }
      // Until its own opening is signed, the seat resends its sums each
      // step: nothing tells it which seats hold them (Resending).
      let sent = 0;
      for (const recipient of recipients) {
        const message = sealSummedShares(
          { definition: fixed.definition, cell: c, aggregate: cell.aggregate },
          fixed.registered,
          { index: election.index, signingSecret: election.signingSecret },
          recipient,
          cell.own,
        );
        try {
          await peers.send(recipient, message);
          sent++;
        } catch {
          // Sent again next step; one unreachable seat never holds up the rest.
        }
      }
      cells.push({ state: "combining", held: held.size, sent });
    }
    return { state: "tallying", cells };
  }

  /**
   * Checks a summed-share message from another seat (Receiving) and keeps
   * the sums if they pass. A message that fails, or one that arrives before
   * `step` has fixed the counted set, is ignored; nothing about the result
   * goes back to its sender, so the transport acknowledges every message on
   * arrival, before calling this (T-39).
   */
  async receive(message: Uint8Array): Promise<void> {
    // Only `step` reads the counted set: a message, which anyone reaching
    // the node can send, never makes it read or sum (T-54).
    const fixed = this.#fixed;
    if (fixed === undefined) return;
    const { election } = this.#o;
    const result = openSummedShares(
      {
        definition: fixed.definition,
        aggregates: fixed.cells.map((c) => c.aggregate),
        registered: fixed.registered,
      },
      { index: election.index, secretKey: election.kemKeyPair.secretKey },
      message,
    );
    if (!result.ok) return;
    let byCell = this.#received.get(result.cell);
    if (byCell === undefined) this.#received.set(result.cell, (byCell = new Map()));
    // Every passing message from a seat carries the same sums (binding).
    if (!byCell.has(result.sender)) byCell.set(result.sender, result.summed);
  }

  /** The tally openings (`0x0006`, version 1) the seat signed, by cell. */
  async openings(): Promise<Map<number, Uint8Array>> {
    const out = new Map<number, Uint8Array>();
    const { store, election } = this.#o;
    for (const name of await store.list(`tally/${hex(election.stubHash)}/openings`)) {
      const bytes = await store.get(`tally/${hex(election.stubHash)}/openings/${name}`);
      if (bytes !== undefined) out.set(Number(name), bytes);
    }
    return out;
  }

  /** The seat's own sums and every passing sum received for cell `c`. */
  #held(c: number, cell: Cell): Map<number, readonly Share[]> {
    const held = new Map(this.#received.get(c) ?? []);
    if (cell.own !== undefined) held.set(this.#o.election.index, cell.own);
    return held;
  }

  async #opening(c: number): Promise<Uint8Array | undefined> {
    const { store, election } = this.#o;
    return store.get(`tally/${hex(election.stubHash)}/openings/${c}`);
  }

  /**
   * The `k` lowest passing seats combined, the opening checks run on the
   * result (`openCell`), and the opening signed and written once: an earlier
   * or concurrent step's opening wins, so the seat never signs two different
   * openings of a cell (Opening record, Signature; T-29).
   */
  async #combine(
    fixed: Fixed,
    c: number,
    cell: Cell,
    held: ReadonlyMap<number, readonly Share[]>,
  ): Promise<Uint8Array | undefined> {
    const { election, store } = this.#o;
    const opened = openCell(fixed.rules, cell.vss, held);
    // Every sum held passed the summed-share check, so only a broken binding
    // could fail here: the seat signs nothing rather than a failing opening.
    if (!opened.ok) return undefined;
    const record = encodeTallyOpening(
      signTallyOpening(election.signingSecret, {
        definition_hash: election.definitionHash,
        cell: c,
        aggregate_hash: aggregateHash(cell.aggregate),
        signer: election.index,
        opening: opened.counts.map((v, j) => ({ v, r: opened.randomness[j] as bigint })),
      }),
    );
    return (await store.putOnce(`tally/${hex(election.stubHash)}/openings/${c}`, record)).value;
  }

  /** The election's definition, key set and counted cells, once the source fixes them. */
  async #fix(): Promise<Fixed | Exclude<TallyDutyStatus, { state: "tallying" }>> {
    if (this.#fixed !== undefined) return this.#fixed;
    const { store, election } = this.#o;
    // The verdict is final once the rule gives it, so it is kept: a later
    // read, from a node that lags or lies, never makes the seat sum over an
    // election it found failed (T-54).
    const unavailable = `tally/${hex(election.stubHash)}/unavailable`;
    if ((await store.get(unavailable)) !== undefined) return { state: "unavailable" };
    try {
      const checked = (this.#approved ??= this.#checked());
      // Nothing about the counted set is read before the rule allows it, so
      // no seat's sums exist while an attestation could still be withheld
      // or a failed point still be summed over (T-54).
      const allowed = await this.#o.summing.check({
        threshold: tallyRules(checked.definition).threshold,
        registered: checked.registered.map((k) => ({ index: k.index, signingKey: k.signingKey })),
      });
      if (allowed.state === "waiting") return { state: "waiting" };
      if (allowed.state === "unavailable") {
        await store.putOnce(unavailable, Uint8Array.of(1));
        return { state: "unavailable" };
      }
      if (allowed.state === "unheld-roots")
        throw new Refused("an attested root whose leaf object the seat doesn't hold");
      const counted = await this.#o.counted(this.#o.election);
      if (counted.state !== "fixed") return counted;
      this.#fixed = await this.#cells(checked, counted.cells);
    } catch (e) {
      if (e instanceof Refused) return { state: "refused", reason: e.message };
      throw e;
    }
    return this.#fixed;
  }

  async #cells(
    { definition, registered }: { definition: Definition; registered: readonly RegisteredKeys[] },
    counted: readonly (readonly Uint8Array[])[],
  ): Promise<Fixed> {
    const { election, store } = this.#o;
    const rules = tallyRules(definition);
    // The partition's cells, each with its tier: under version 1 one per
    // `electorate` entry, under version 5 every tier's cells numbered across
    // the definition (verifier 2.8). No more and no fewer: a sum over any
    // other set could disclose a difference of sums (T-14, T-16).
    const tiers =
      definition.version === 1
        ? definition.value.electorate.map((t) => t.tier)
        : definition.value.electorate.flatMap((t) => t.cells.map(() => t.tier));
    if (counted.length !== tiers.length)
      throw new Refused("another number of cells than the partition's");
    const voters = new Set<string>();
    const cells: Cell[] = [];
    for (const [c, records] of counted.entries()) {
      const tier = tiers[c] as number;
      const vss: CommittedVote["vss"][] = [];
      const shares: (readonly Share[])[] = [];
      let missing = 0;
      for (const bytes of records) {
        const b = countedBallot(definition.version, election.definitionHash, c, tier, bytes);
        // Re-voting selects one ballot per voter (T-45): two would count
        // twice. A nullifier is the tier's, so under version 5 a voter is
        // one across the tier's cells, and a second in another cell is
        // refused as one in the same cell is.
        const voter = `${tier}/${b.nullifier}`;
        if (voters.has(voter)) throw new Refused("a voter counted twice");
        voters.add(voter);
        vss.push(b.vss);
        const held = await heldShares(store, election.stubHash, b.hash);
        if (held === undefined) missing++;
        else shares.push(held);
      }
      let aggregate: CellAggregate;
      try {
        aggregate = aggregateCell(rules, vss);
      } catch (e) {
        if (e instanceof RangeError) throw new Refused("a counted ballot of another shape");
        throw e;
      }
      let own: Cell["own"];
      if (missing === 0) {
        const sums = sumShares(rules, shares);
        // Each share passed its check at intake, so its sums pass too; a seat
        // whose store gives sums that fail sends nothing (Resending).
        if (!checkSummedShares(aggregate, election.index, sums))
          throw new Refused("the seat's own sums fail the summed-share check");
        own = sums;
      }
      cells.push({ vss, aggregate, own, missing });
    }
    // Written once, after every cell passed the checks above: an anchored
    // counted set never changes, so a source that later gives another one
    // is refused, never summed over (T-29).
    for (const [c, cell] of cells.entries()) {
      const hash = aggregateHash(cell.aggregate);
      const name = `tally/${hex(election.stubHash)}/aggregates/${c}`;
      if (!equal((await store.putOnce(name, encode(HASH, hash))).value, hash))
        throw new Refused("a counted set other than the one fixed before");
    }
    return { definition, registered, rules, cells };
  }

  /**
   * The definition and key set, checked against the seat's approval: the
   * definition hashes to the approved definition hash, its transcript is the
   * approved one, and that transcript's check under the pinned panel
   * returns the key set the approval signed, with this seat's own keys in it.
   */
  #checked(): { definition: Definition; registered: readonly RegisteredKeys[] } {
    const { transcript, election, secrets, panel } = this.#o;
    const definition: Definition =
      "version" in this.#o.definition && "value" in this.#o.definition
        ? this.#o.definition
        : { version: 1, value: this.#o.definition };
    const d = definition.value;
    // Implied by the approved definition hash, which the seat computed from
    // a stub its pins passed; checked so the transcript is read against them.
    // Each version is hashed under its own layout, so a definition read
    // under another never matches, and one tagged with a version whose
    // layout it doesn't have doesn't encode (T-34).
    let hash: Uint8Array | undefined;
    try {
      hash =
        definition.version === 1
          ? electionDefinitionHash(definition.value)
          : electionDefinitionV5Hash(definition.value);
    } catch (e) {
      if (!(e instanceof EncodeError)) throw e;
    }
    if (
      hash === undefined ||
      d.l2_chain_id !== this.#o.l2ChainId ||
      !equal(d.trustee_registry, this.#o.trusteeRegistry) ||
      !equal(hash, election.definitionHash)
    )
      throw new Refused("the definition isn't the one the seat approved");
    const transcriptHash = ceremonyTranscriptHash(transcript);
    if (
      !equal(transcriptHash, secrets.transcriptHash) ||
      !equal(transcriptHash, d.ceremony_transcript_hash)
    )
      throw new Refused("the transcript isn't the one the seat approved");
    const result = checkCeremonyTranscript(
      {
        l2ChainId: this.#o.l2ChainId,
        trusteeRegistry: this.#o.trusteeRegistry,
        electionId: d.election_id,
        stubHash: election.stubHash,
        panel,
      },
      transcript,
      1,
    );
    const own = result.ok ? result.registered.find((k) => k.index === election.index) : undefined;
    if (
      !result.ok ||
      !equal(keySetHash(result.registered.map(keySetEntry)), secrets.keySetHash) ||
      own === undefined ||
      !equal(own.signingKey, identityKey(election.signingSecret)) ||
      !equal(
        encode(KEM_PUBLIC_KEY, own.kemKey),
        encode(KEM_PUBLIC_KEY, election.kemKeyPair.publicKey),
      )
    )
      throw new Refused("the transcript's key set isn't the one the seat approved");
    return { definition, registered: result.registered };
  }
}

/**
 * A counted ballot of cell `c` read under the ballot version the definition
 * pins (1 under definition version 1, 3 under version 5), with its ballot
 * hash recomputed from the record. T-38: intake's shares are looked up by
 * that hash, so the source can't pair one ballot's vote with another's
 * shares; it binds the ballot version and the tier or cell, so a record
 * relabelled to another layout or cell never finds the shares of the one it
 * copies (T-34).
 */
function countedBallot(
  version: Definition["version"],
  definitionHash: Uint8Array,
  c: number,
  tier: number,
  bytes: Uint8Array,
): { readonly nullifier: bigint; readonly vss: CommittedVote["vss"]; readonly hash: Uint8Array } {
  try {
    if (version === 1) {
      const b = decodeBallot(bytes, 1);
      if (!equal(b.definition_hash, definitionHash) || b.tier !== tier)
        throw new Refused("a counted ballot of another election or cell");
      const hash = ballotHash({ definitionHash, tier, nullifier: b.nullifier }, b.committed_vote);
      return { nullifier: b.nullifier, vss: b.committed_vote.vss, hash };
    }
    const b = decodeBallot(bytes, 3);
    if (!equal(b.definition_hash, definitionHash) || b.cell !== c)
      throw new Refused("a counted ballot of another election or cell");
    const hash = ballotHashV3(
      { definitionHash, cell: c, nullifier: b.nullifier },
      b.committed_vote,
    );
    return { nullifier: b.nullifier, vss: b.committed_vote.vss, hash };
  } catch (e) {
    if (e instanceof DecodeError) throw new Refused("a counted ballot doesn't decode");
    throw e;
  }
}
