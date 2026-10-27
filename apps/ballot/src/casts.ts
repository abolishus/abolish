// This device's records of the ballots it cast ([[revoting]], Client rule
// 3): for each election and tier, every ballot it let leave, in the order of
// the L1 blocks they name, with the board entry the operator answered for it
// once that answer passed `checkBoarded` (send.ts). A cast is recorded before
// its ballot leaves the device, so each later one names a strictly newer
// block and never ties it (T-45, T-38), and a retry after a failure or a
// crash resends the identical bytes from here, never a new ballot on the same
// block (T-25). Each cast keeps every qualified seat's share ciphertext and
// ML-KEM message `m_i` beside its ballot, recorded before the ballot leaves,
// so delivery to each seat's intake, and the posting a voter may choose for
// a seat that never receipts, survive a reload ([[delivery]], Client rule 4).
// Once a seat's receipt passes for the ballot, the receipt is kept in its
// place and that seat's `m_i` erased from every cast it receipts, so a
// receipted seat is never posted (Client rules 1 to 3); once the ballot is
// boarded and the operator's board path answers for the receipt with an
// entry that passes, that entry is kept beside it (Client rule 3). Once the
// poll closes, a seat still holding its `m_i` has its `ct_i` and `m_i`
// erased from every cast: no path admits the ballot any more, so no
// posting of it can help; and once the voter declines to post a cast's unreceipted seats,
// theirs are erased from it and from every recast of the same seal (Client
// rule 4). Before a run through the relay or the voter's wallet may hand any
// of a cast's postings out, the cast is marked `handed` with the time, so a
// page that went away still waits for them once the poll is opened again,
// and a later run looks on L1 for a deposit an earlier one's relay made
// ([[posting-relay]], Sending after a run; Outcome, The read).
// Kept in this origin's IndexedDB and nowhere else: the records
// say this device voted in these polls, as the identity says it can (T-18).
//
// What is stored is checked on every read as strictly as a decoder: a record
// of another version, a ballot that doesn't decode or blocks out of order is
// unreadable, never guessed at, and the client then casts nothing more in
// that election and tier until the voter decides.

import {
  ballotHashV3,
  type BallotRecordV3,
  type CastShare,
  cellCoreHash,
  decodeBallot,
  decodeShareReceipt,
  MAX_BOARD_PAYLOAD,
  shareCiphertextHash,
  type ShareReceiptRecord,
} from "@abolishus/crypto";

import { withStore } from "./store.ts";

/** The operator's answer for a ballot, as `checkBoarded` passed it. */
export interface Boarded {
  /** The board entry carrying exactly the ballot's bytes. */
  readonly entry: Uint8Array;
  /** The chain link after it, 32 bytes. */
  readonly link: Uint8Array;
}

/**
 * One qualified seat's share as a cast keeps it: its `ct_i`, and either its
 * `m_i`, while no receipt for the ballot has passed, or that receipt once
 * one has, `m_i` then erased ([[delivery]], Client rule 2), with the board
 * entry the operator answered for it once that answer passed (Client rule
 * 3); or nothing but the seat, once the poll closed with
 * no receipt kept for it, its `ct_i` and `m_i` then erased (Client rule 4).
 */
export type KeptShare =
  | { readonly seat: number; readonly ciphertext: Uint8Array; readonly m: Uint8Array }
  | { readonly seat: number; readonly erased: true }
  | {
      readonly seat: number;
      readonly ciphertext: Uint8Array;
      readonly receipt: Uint8Array;
      /**
       * The board entry carrying a receipt that passed for this seat of the
       * ballot, and the link after it: this one, or an earlier receipt for
       * the seat the board path already carried ([[delivery]], Boarding,
       * rule 5), which the worker passed as it did this one. Later checks
       * of the board (an anchored inclusion, a resubmission) are of the
       * receipt this entry carries, which may not be `receipt`.
       */
      readonly boarded?: Boarded;
    };

/** One ballot this device cast, a version-3 ballot record ([[ballot-validity]]). */
export interface CastRecord {
  /** The record's bytes, exactly as sent and as any retry sends them again. */
  readonly ballot: Uint8Array;
  /** Its `l1_ref_number`, read from the bytes. */
  readonly l1Number: bigint;
  /**
   * Each qualified seat's `ct_i` with its `m_i` or its receipt, in seat
   * order: exactly the seats whose share hash in the ballot isn't zero, each
   * ciphertext hashing to its seat's share hash.
   */
  readonly shares: readonly KeptShare[];
  /** The operator's checked answer, once one passed. */
  readonly boarded?: Boarded;
  /**
   * A run may have handed its postings to the relay or a wallet: marked
   * before any run starts, so the parts may reach the board whatever the
   * run met, and the page waits for them across a reload ([[posting-relay]],
   * Sending after a run; T-15, T-25). The time, in seconds by this device's
   * clock, the first run of its seal was about to hand them out: a later
   * run looks for an earlier one's deposit on L1 from then (Outcome, The
   * read).
   */
  readonly handed?: bigint;
}

/** The casts of one election and tier, oldest block first, or a store this device couldn't read. */
export type CastsRead =
  | { readonly kind: "read"; readonly casts: readonly CastRecord[] }
  | { readonly kind: "unreadable" };

/** `recordCast`'s outcome: only `recorded` lets the ballot leave the device. */
export type RecordCastOutcome =
  | "recorded"
  | "not-newer"
  | "other-election"
  | "unreceipted"
  | "unreadable"
  | "unwritable";

declare const CHECKED: unique symbol;

/**
 * A seat's receipt the worker passed for a cast under the poll's registered
 * signing keys (`castReceiptSeatV3`, worker-client.ts `receipt`), the only
 * maker of one: so an intake's raw answer can't reach `recordReceipt`, which
 * erases the seat's `m_i`, unchecked (Client rule 1; T-25).
 */
export interface CheckedReceipt {
  readonly seat: number;
  readonly receipt: Uint8Array;
  readonly [CHECKED]: true;
}

/** `recordReceipt`'s outcome. */
export type RecordReceiptOutcome = "recorded" | "missing" | "unreadable" | "unwritable";

/** A receipted seat of a cast whose receipt no kept board entry carries yet, as `unboardedReceipts` finds it. */
export interface UnboardedReceipt {
  readonly seat: number;
  readonly receipt: Uint8Array;
}

/** `declinePosting`'s outcome. */
export type DeclinePostingOutcome = "declined" | "missing" | "unreadable" | "unwritable";

/** `eraseShares`'s outcome. */
export type EraseSharesOutcome = "erased" | "none" | "unreadable" | "unwritable";

/** `recordHanded`'s outcome: the cast's mark once it is recorded. */
export type RecordHandedOutcome =
  | { readonly handed: bigint }
  | "missing"
  | "unreadable"
  | "unwritable";

/** `recordBoarded`'s outcome. */
export type RecordBoardedOutcome =
  | "recorded"
  | "missing"
  | "conflict"
  | "unreadable"
  | "unwritable";

/** The IndexedDB database and object store the casts live under. */
export const CASTS_DB = "abolish-ballot-casts";
const STORE = "casts";

/**
 * The stored record's version: another is unreadable, never migrated by
 * guessing. Version 1 kept no shares, version 2 no receipts, version 3 no
 * receipts' board entries, version 4 no erased shares, version 5 no
 * `handed` mark and version 6 no time in it; no build wrote any of them,
 * since none recorded a cast before it delivered, and none delivers yet.
 */
const RECORD_VERSION = 7;

/** The length of an ML-KEM-768 message `m` ([[share-encryption]], Ciphertext). */
const M_LENGTH = 32;

/** The ballot record version these casts are of: the one definition version 5 pins. */
const BALLOT_VERSION = 3;

/** What a board entry adds around its payload (docs/spec/board.md): header, id, index, segment, length. */
const BOARD_ENTRY_OVERHEAD = 3 + 32 + 8 + 4 + 4;

const TIERS = [0, 1, 2];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const hasExactly = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The store's key for one election and tier: each tier's casts are its own (Client rule 7). */
function keyOf(electionId: Uint8Array, tier: number): string {
  if (!(electionId instanceof Uint8Array) || electionId.length !== 32)
    throw new RangeError("electionId: expected 32 bytes");
  if (!TIERS.some((t) => Object.is(t, tier))) throw new RangeError("tier: expected 0, 1 or 2");
  return `${toHex(electionId)}/${tier}`;
}

/** The decoded ballot, or `undefined` for bytes that aren't a version-3 ballot record. */
function decodedOf(ballot: Uint8Array): BallotRecordV3 | undefined {
  try {
    return decodeBallot(ballot, BALLOT_VERSION);
  } catch {
    return undefined;
  }
}

const isZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);

// Each decoded record's ballot hash, made only when a receipt is checked
// against it: hashing the committed vote costs as much again as decoding it.
const HASHES = new WeakMap<BallotRecordV3, Uint8Array>();

/** The ballot hash of a decoded version-3 record, as its receipts sign it. */
function ballotHashOf(record: BallotRecordV3): Uint8Array {
  let hash = HASHES.get(record);
  if (hash === undefined) {
    hash = ballotHashV3(
      { definitionHash: record.definition_hash, cell: record.cell, nullifier: record.nullifier },
      record.committed_vote,
    );
    HASHES.set(record, hash);
  }
  return hash;
}

/**
 * Whether `receipt` is a share receipt record (version 1, the one ballot
 * version 3 fixes) for `seat` naming exactly `record`'s definition, ballot
 * hash and share hash for that seat. Its signature isn't checked
 * here: the worker checked it under the poll's registered keys before the
 * receipt was recorded (`castReceiptSeatV3`), and this storage, like the
 * rest of the record, is trusted no further than this origin (T-18).
 */
function receiptFits(record: BallotRecordV3, seat: number, receipt: Uint8Array): boolean {
  let decoded: ShareReceiptRecord;
  try {
    decoded = decodeShareReceipt(receipt, 1);
  } catch {
    return false;
  }
  const shareHash = record.committed_vote.share_hashes[seat - 1];
  return (
    decoded.seat === seat &&
    shareHash !== undefined &&
    // An unqualified seat has no share to receipt.
    !isZero(shareHash) &&
    equalBytes(decoded.definition_hash, record.definition_hash) &&
    equalBytes(decoded.share_hash, shareHash) &&
    equalBytes(decoded.ballot_hash, ballotHashOf(record))
  );
}

/**
 * Copies of stored `shares` if they are exactly the qualified seats' of
 * `record`: one per seat whose share hash isn't zero, in seat order, each a
 * ciphertext hashing to that share hash with either a 32-byte `m`, no
 * receipt and no board entry, or a receipt fitting the ballot, no `m`, and
 * a board entry carrying a receipt that fits the ballot for that seat or
 * none; or, for an erased share, none of the four; `undefined` otherwise. So a cast kept here carries a share for
 * every seat its ballot must be delivered to and none it doesn't name, and
 * never both a seat's receipt and its `m_i` (T-25, T-38).
 */
function sharesFor(record: BallotRecordV3, shares: unknown): KeptShare[] | undefined {
  // A cloned array keeps any extra own properties: only the indices are a record's.
  if (!Array.isArray(shares) || Object.keys(shares).length !== shares.length) return undefined;
  const seats = record.committed_vote.share_hashes.flatMap((shareHash, i) =>
    isZero(shareHash) ? [] : [{ seat: i + 1, hash: shareHash }],
  );
  if (shares.length !== seats.length) return undefined;
  const copies: KeptShare[] = [];
  for (let i = 0; i < seats.length; i++) {
    const share: unknown = shares[i];
    const expected = seats[i] as (typeof seats)[number];
    if (!isRecord(share) || !hasExactly(share, ["seat", "ciphertext", "m", "receipt", "boarded"]))
      return undefined;
    const { seat, ciphertext, m, receipt, boarded } = share;
    if (seat !== expected.seat) return undefined;
    if (ciphertext === null && m === null && receipt === null && boarded === null) {
      copies.push({ seat, erased: true });
      continue;
    }
    if (
      !(ciphertext instanceof Uint8Array) ||
      ciphertext.length > MAX_BOARD_PAYLOAD ||
      !equalBytes(shareCiphertextHash(ciphertext), expected.hash)
    )
      return undefined;
    if (m instanceof Uint8Array && m.length === M_LENGTH && receipt === null && boarded === null)
      copies.push({ seat, ciphertext: ciphertext.slice(), m: m.slice() });
    else if (
      m === null &&
      receipt instanceof Uint8Array &&
      receipt.length <= MAX_BOARD_PAYLOAD &&
      receiptFits(record, seat, receipt)
    ) {
      const copy = { seat, ciphertext: ciphertext.slice(), receipt: receipt.slice() };
      if (boarded === null) copies.push(copy);
      else {
        const entry = receiptEntryOf(boarded, record, seat);
        if (entry === undefined) return undefined;
        copies.push({ ...copy, boarded: entry });
      }
    } else return undefined;
  }
  return copies;
}

/** A kept share as `sharesFor` reads it back. */
const storedShare = (share: KeptShare) => ({
  seat: share.seat,
  ciphertext: "erased" in share ? null : share.ciphertext.slice(),
  m: "m" in share ? share.m.slice() : null,
  receipt: "receipt" in share ? share.receipt.slice() : null,
  boarded:
    "receipt" in share && share.boarded !== undefined
      ? { entry: share.boarded.entry.slice(), link: share.boarded.link.slice() }
      : null,
});

// Where a board entry's fields sit (docs/spec/board.md): after the record
// header, `election_id`, then `index` and `segment`, then the payload's
// u32 length and the payload.
const ENTRY_ELECTION = 3;
const ENTRY_PAYLOAD_LENGTH = 3 + 32 + 8 + 4;

/** The election a board entry names: what `checkBoarded` compared, read again from the stored bytes. */
const entryElection = (entry: Uint8Array) => entry.subarray(ENTRY_ELECTION, ENTRY_ELECTION + 32);

/**
 * A stored entry and link whose entry carries a payload `fits` passes, of at
 * most `MAX_BOARD_PAYLOAD` bytes, as copies; `undefined` otherwise.
 */
function entryOf(v: unknown, fits: (payload: Uint8Array) => boolean): Boarded | undefined {
  if (!isRecord(v) || !hasExactly(v, ["entry", "link"])) return undefined;
  const { entry, link } = v;
  if (!(link instanceof Uint8Array) || link.length !== 32) return undefined;
  if (
    !(entry instanceof Uint8Array) ||
    entry.length < BOARD_ENTRY_OVERHEAD ||
    entry.length > MAX_BOARD_PAYLOAD + BOARD_ENTRY_OVERHEAD
  )
    return undefined;
  const length = new DataView(entry.buffer, entry.byteOffset).getUint32(ENTRY_PAYLOAD_LENGTH);
  const payload = entry.subarray(BOARD_ENTRY_OVERHEAD);
  if (length !== payload.length || !fits(payload)) return undefined;
  return { entry: entry.slice(), link: link.slice() };
}

// The entry carries exactly the ballot, so its payload is the ballot's
// bytes: a store that holds another entry beside this cast is unreadable,
// not this cast's answer.
const boardedOf = (v: unknown, ballot: Uint8Array) =>
  entryOf(v, (payload) => equalBytes(payload, ballot));

// The entry carries a receipt for `seat` of exactly this ballot, whose
// signature the worker passed before it was kept, as the kept receipt's.
const receiptEntryOf = (v: unknown, record: BallotRecordV3, seat: number) =>
  entryOf(v, (payload) => receiptFits(record, seat, payload));

/** What a cast asked the worker for: the poll, the voter's cell and the L1 block its ballot names. */
export interface CastAsked {
  /** 32 bytes. */
  readonly definitionHash: Uint8Array;
  readonly cell: number;
  readonly l1Number: bigint;
  /** 32 bytes. */
  readonly l1Hash: Uint8Array;
}

/**
 * Whether `ballot` is a version-3 ballot record naming exactly what the cast
 * asked for: the poll's definition, the voter's cell and the L1 block this
 * client read ([[revoting]], Client rules 1 and 3). Checked before the cast
 * is recorded, so a worker that made a ballot on another block can't have
 * this device record, and send, a cast that ties or outranks the wrong one
 * (T-45, T-38). `recordCast` checks the shares beside it.
 */
export function castAsAsked(ballot: Uint8Array, asked: CastAsked): boolean {
  const decoded = decodedOf(ballot);
  if (decoded === undefined) return false;
  return (
    equalBytes(decoded.definition_hash, asked.definitionHash) &&
    decoded.cell === asked.cell &&
    decoded.l1_ref_number === asked.l1Number &&
    equalBytes(decoded.l1_ref_hash, asked.l1Hash)
  );
}

/** Every board entry a cast keeps: its ballot's, then its receipts'. */
const entriesOf = (cast: CastRecord): Boarded[] => [
  ...(cast.boarded === undefined ? [] : [cast.boarded]),
  ...cast.shares.flatMap((share) =>
    "receipt" in share && share.boarded !== undefined ? [share.boarded] : [],
  ),
];

/** The definition hash a decoded ballot record names, after its header. */
const definitionOf = (ballot: Uint8Array) => ballot.subarray(3, 35);

function castOf(v: unknown): CastRecord | undefined {
  if (!isRecord(v) || !hasExactly(v, ["ballot", "shares", "boarded", "handed"])) return undefined;
  const { ballot, shares, boarded, handed } = v;
  if (!(ballot instanceof Uint8Array) || ballot.length > MAX_BOARD_PAYLOAD) return undefined;
  if (handed !== null && !Number.isSafeInteger(handed)) return undefined;
  // One encoding of each time: `-0` is not 0's.
  if (typeof handed === "number" && (handed < 0 || Object.is(handed, -0))) return undefined;
  const decoded = decodedOf(ballot);
  if (decoded === undefined) return undefined;
  const kept = sharesFor(decoded, shares);
  if (kept === undefined) return undefined;
  const cast = {
    ballot: ballot.slice(),
    l1Number: decoded.l1_ref_number,
    shares: kept,
    ...(handed === null ? {} : { handed: BigInt(handed as number) }),
  };
  if (boarded === null) return cast;
  const answer = boardedOf(boarded, ballot);
  return answer === undefined ? undefined : { ...cast, boarded: answer };
}

/**
 * The casts a stored value holds, or `undefined` if it isn't exactly a
 * record this client writes: version 7 and a list of version-3 ballot
 * records naming strictly ascending L1 blocks, each with its qualified
 * seats' shares, each with its `m_i` or its receipt, its checked board
 * entry or `null`, and the time it was marked `handed` or `null`. Every byte array is a
 * copy.
 */
export function parseStoredCasts(value: unknown): CastRecord[] | undefined {
  if (!isRecord(value) || !hasExactly(value, ["v", "casts"])) return undefined;
  const { v, casts } = value;
  if (v !== RECORD_VERSION) return undefined;
  // A cloned array keeps any extra own properties: only the indices are a record's.
  if (!Array.isArray(casts) || Object.keys(casts).length !== casts.length) return undefined;
  const parsed: CastRecord[] = [];
  let election: Uint8Array | undefined;
  // Indexed, not `map`: that skips a list's holes.
  for (let i = 0; i < casts.length; i++) {
    const cast = castOf(casts[i]);
    const last = parsed.at(-1);
    if (cast === undefined || (last !== undefined && cast.l1Number <= last.l1Number))
      return undefined;
    // One election's casts: every ballot names the same definition, and
    // every answer the same election.
    const first = parsed[0];
    if (first !== undefined && !equalBytes(definitionOf(cast.ballot), definitionOf(first.ballot)))
      return undefined;
    // Every entry kept, a ballot's or a receipt's, names the same election.
    for (const { entry } of entriesOf(cast)) {
      election ??= entryElection(entry);
      if (!equalBytes(entryElection(entry), election)) return undefined;
    }
    parsed.push(cast);
  }
  return parsed;
}

/** The record `parseStoredCasts` reads back as `casts`; throws on casts it would refuse. */
export function storedCasts(casts: readonly CastRecord[]): Record<string, unknown> {
  const record = {
    v: RECORD_VERSION,
    casts: casts.map(({ ballot, shares, boarded, handed }) => ({
      ballot: ballot.slice(),
      shares: shares.map(storedShare),
      boarded:
        boarded === undefined ? null : { entry: boarded.entry.slice(), link: boarded.link.slice() },
      handed: handed === undefined ? null : Number(handed),
    })),
  };
  const back = parseStoredCasts(record);
  if (
    back === undefined ||
    back.length !== casts.length ||
    back.some((cast, i) => cast.l1Number !== casts[i]?.l1Number)
  )
    throw new TypeError("not casts this client stores");
  return record;
}

/** The newest L1 block any of `casts` names, or `undefined` for none. */
export function newestBlock(casts: readonly CastRecord[]): bigint | undefined {
  return casts.at(-1)?.l1Number;
}

/** A recorded cast the board hasn't confirmed, as `unsentCast` finds it. */
export interface UnsentCast {
  /** The record's bytes, exactly as recorded: every send of it sends them. */
  readonly ballot: Uint8Array;
  /** Its tracking code, the core hash the voter was shown before casting it ([[challenge]], Core and tracking code). */
  readonly trackingCode: Uint8Array;
  /** Its qualified seats with no receipt kept, each with its `ct_i`, in seat order. */
  readonly undelivered: readonly { readonly seat: number; readonly ciphertext: Uint8Array }[];
  /** A run may have handed its postings out (`CastRecord.handed`): the page waits for them. */
  readonly handed?: true;
}

/**
 * The newest of `casts` if no checked answer of the board is kept for it,
 * so a page that went away after recording it (a reload, a crash, a closed
 * tab) can still deliver its unreceipted seats and send it, with the same
 * bytes ([[revoting]], Client rule 3; [[delivery]], Client rule 4). Only
 * the newest: an older one is outranked by it wherever both are boarded, so
 * sending it could only matter if the newest never went, and then the
 * newest is the voter's last choice. `undefined` when the newest is
 * boarded, holds a share erased at the poll's close (its seat can then be
 * neither delivered nor posted in time, and its ballot no longer sent), or
 * none is held; `other-election` for a newest cast that isn't
 * a version-3 record naming `definitionHash`, which the poll's own casts
 * never are, so nothing is sent from them (T-25, T-45).
 */
export function unsentCast(
  casts: readonly CastRecord[],
  definitionHash: Uint8Array,
): UnsentCast | "other-election" | undefined {
  const newest = casts.at(-1);
  if (newest === undefined || newest.boarded !== undefined) return undefined;
  if (newest.shares.some((share) => "erased" in share)) return undefined;
  const record = decodedOf(newest.ballot);
  if (record === undefined || !equalBytes(record.definition_hash, definitionHash))
    return "other-election";
  return {
    ballot: newest.ballot.slice(),
    trackingCode: trackingCodeOf(record),
    // A receipted seat's `m_i` is gone, so it is never delivered or posted
    // again; every other seat is, with the `ct_i` recorded before the
    // ballot first left (Client rules 2 and 4).
    undelivered: newest.shares.flatMap((share) =>
      "m" in share ? [{ seat: share.seat, ciphertext: share.ciphertext.slice() }] : [],
    ),
    ...(newest.handed === undefined ? {} : { handed: true as const }),
  };
}

/**
 * The tracking code of the newest of `casts` once a checked answer of the
 * board is kept for it, so the poll opens on "You've already answered"
 * rather than on the questions (P2-25 part 3): the device's own record,
 * never the server's word on whether this voter answered (T-10, T-11).
 * Only the newest: a later cast the board never confirmed is `unsentCast`'s
 * to finish, and under one the voter declined or whose shares were erased
 * the screen would have to say which ballot stands, so the poll opens on
 * the questions as before. `undefined` too for a newest cast that isn't a
 * version-3 record naming `definitionHash`.
 */
export function answeredCast(
  casts: readonly CastRecord[],
  definitionHash: Uint8Array,
): Uint8Array | undefined {
  const newest = casts.at(-1);
  if (newest?.boarded === undefined) return undefined;
  const record = decodedOf(newest.ballot);
  if (record === undefined || !equalBytes(record.definition_hash, definitionHash)) return undefined;
  return trackingCodeOf(record);
}

/** A cast's tracking code, the core hash the voter was shown before casting it ([[challenge]], Core and tracking code). */
function trackingCodeOf(record: BallotRecordV3): Uint8Array {
  return cellCoreHash({
    definitionHash: record.definition_hash,
    ballotVersion: BALLOT_VERSION,
    cell: record.cell,
    vss: record.committed_vote.vss,
    shareHashes: record.committed_vote.share_hashes,
  });
}

/**
 * This device's casts in `electionId` at `tier`, read afresh: none is an
 * empty list. Storage the browser refuses, or a record `parseStoredCasts`
 * refuses, is `unreadable`: the voter is told, never cast for as if this
 * device had cast nothing, which could tie an earlier ballot (T-45).
 */
export async function readCasts(
  electionId: Uint8Array,
  tier: number,
  factory: IDBFactory = indexedDB,
): Promise<CastsRead> {
  const key = keyOf(electionId, tier);
  let value: unknown;
  try {
    value = await withStore<unknown>(factory, CASTS_DB, STORE, "readonly", (store) => {
      const get = store.get(key);
      return () => get.result as unknown;
    });
  } catch {
    return { kind: "unreadable" };
  }
  if (value === undefined) return { kind: "read", casts: [] };
  const casts = parseStoredCasts(value);
  return casts === undefined ? { kind: "unreadable" } : { kind: "read", casts };
}

/**
 * Replaces the casts of `key` with what `change` makes of them, in one
 * transaction with the read, only while they are readable; `change`
 * returning a string leaves them as they are and is the outcome.
 */
async function updateCasts<T extends string>(
  key: string,
  factory: IDBFactory,
  change: (casts: CastRecord[]) => CastRecord[] | T,
): Promise<"recorded" | "unreadable" | "unwritable" | T> {
  try {
    return await withStore(factory, CASTS_DB, STORE, "readwrite", (store) => {
      let outcome: "recorded" | "unreadable" | T = "unreadable";
      const get = store.get(key);
      get.onsuccess = () => {
        const value: unknown = get.result;
        const held = value === undefined ? [] : parseStoredCasts(value);
        if (held === undefined) return;
        const changed = change(held);
        if (typeof changed === "string") {
          outcome = changed;
          return;
        }
        store.put(storedCasts(changed), key);
        outcome = "recorded";
      };
      return () => outcome;
    });
  } catch {
    return "unwritable";
  }
}

/**
 * `casts` with `ballot`, a version-3 ballot record about to be sent, cast
 * after them with its qualified seats' `shares` ([[revoting]], Client rule
 * 3; [[delivery]], Client rule 4): `not-newer` unless it names a block
 * strictly newer than every one of them (T-45), and `other-election` for a
 * ballot naming another definition than theirs. A seat whose receipt for an
 * earlier cast also receipts this one (a recast of the same seal, which
 * carries its ballot hash) keeps that receipt in place of its `m_i`, so a
 * receipted seat's `m_i` is never stored again (Client rule 2); the worker
 * hands none for a seat whose receipt it passed for the seal
 * (`receiptSealV3`), and such a share is kept only with an earlier cast's
 * receipt for it: `unreceipted` if none is held, since this device would
 * then keep neither the seat's `m_i` nor its receipt. Throws on bytes that
 * aren't a version-3 ballot record, and on shares that aren't exactly its
 * qualified seats', each hashing to its share hash with a 32-byte `m` or
 * none: the worker's own output, so a mismatch is this client's fault. A
 * recast of a seal whose earlier cast is marked `handed` is marked too, with
 * the same time: it carries the same ballot hash and shares, so the
 * postings a run may have handed out are its postings too, byte for byte
 * ([[posting-relay]], Sending after a run).
 */
export function withCast(
  casts: readonly CastRecord[],
  ballot: Uint8Array,
  shares: readonly CastShare[],
): CastRecord[] | "not-newer" | "other-election" | "unreceipted" {
  const decoded = ballot instanceof Uint8Array ? decodedOf(ballot) : undefined;
  if (decoded === undefined || ballot.length > MAX_BOARD_PAYLOAD)
    throw new TypeError("not a version-3 ballot record");
  // An earlier cast's share for `seat` whose receipt also receipts this
  // one, with the board entry kept for it, if any: it receipts the same
  // ballot hash, so it carries this one's receipt too.
  const carriedShare = (seat: number) =>
    casts
      .flatMap((cast) => cast.shares)
      .find(
        (held): held is Extract<KeptShare, { receipt: Uint8Array }> =>
          held.seat === seat && "receipt" in held && receiptFits(decoded, seat, held.receipt),
      );
  const carried = (seat: number) => carriedShare(seat)?.receipt;
  // In the form `sharesFor` reads: a share without `m` takes its carried
  // receipt, or none (`unreceipted` below); `shape` stands an `m` in its
  // place, so the shares are judged in full before anything is read.
  const asStored = (missing: (seat: number) => { m: unknown; receipt: unknown }): unknown =>
    Array.isArray(shares)
      ? shares.map((share: unknown) => {
          if (!isRecord(share)) return null;
          if (hasExactly(share, ["seat", "ciphertext", "m"]))
            return { ...share, receipt: null, boarded: null };
          if (!hasExactly(share, ["seat", "ciphertext"]) || typeof share["seat"] !== "number")
            return null;
          return { ...share, ...missing(share["seat"]), boarded: null };
        })
      : shares;
  const shape = asStored(() => ({ m: new Uint8Array(M_LENGTH), receipt: null }));
  // A share is erased only in storage, at the close: never one the worker hands over.
  const judged = sharesFor(decoded, shape);
  if (judged === undefined || judged.some((share) => "erased" in share))
    throw new TypeError("not the ballot's qualified seats' shares");
  const first = casts[0];
  if (first !== undefined && !equalBytes(definitionOf(first.ballot), definitionOf(ballot)))
    return "other-election";
  const l1Number = decoded.l1_ref_number;
  const newest = newestBlock(casts);
  if (newest !== undefined && l1Number <= newest) return "not-newer";
  // The shape passed, so only a share with no receipt to carry fails here.
  const kept = sharesFor(
    decoded,
    asStored((seat) => ({ m: null, receipt: carried(seat) ?? null })),
  );
  if (kept === undefined) return "unreceipted";
  const receipted = kept.map((share): KeptShare => {
    const held = carriedShare(share.seat);
    // `kept` holds no erased share once the shape passed: this only narrows.
    if (held === undefined || "erased" in share) return share;
    const { ciphertext } = share;
    const receipt = held.receipt.slice();
    return held.boarded === undefined
      ? { seat: share.seat, ciphertext, receipt }
      : {
          seat: share.seat,
          ciphertext,
          receipt,
          boarded: { entry: held.boarded.entry.slice(), link: held.boarded.link.slice() },
        };
  });
  const hash = ballotHashOf(decoded);
  const handed = casts.find(
    (cast) =>
      cast.handed !== undefined &&
      // Every cast held decoded when it was read.
      equalBytes(ballotHashOf(decodedOf(cast.ballot) as BallotRecordV3), hash),
  )?.handed;
  return [
    ...casts,
    {
      ballot: ballot.slice(),
      l1Number,
      shares: receipted,
      ...(handed === undefined ? {} : { handed }),
    },
  ];
}

/**
 * Records `ballot` as cast in `electionId` at `tier` with its qualified
 * seats' `shares` (`withCast`), before it leaves the device, in the same
 * transaction as the read, so two tabs can't both record a cast on one
 * block: only `recorded` lets the ballot leave (T-45). `unreadable` for
 * casts this device can't read, which are never replaced; `unwritable` for
 * storage the browser refuses. Throws as `withCast` does, before reading.
 */
export async function recordCast(
  electionId: Uint8Array,
  tier: number,
  ballot: Uint8Array,
  shares: readonly CastShare[],
  factory: IDBFactory = indexedDB,
): Promise<RecordCastOutcome> {
  const key = keyOf(electionId, tier);
  withCast([], ballot, shares);
  return updateCasts(key, factory, (casts) => withCast(casts, ballot, shares));
}

/**
 * `casts` with `checked`'s receipt for its seat, which the worker passed
 * for the cast whose bytes are exactly `ballot` (`castReceiptSeatV3`;
 * [[delivery]], Client rule 1), kept in place of that seat's `m_i` in every
 * cast it receipts: that cast and any recast of the same seal, which
 * carries the same ballot hash and share (Client rule 2; T-18). A seat
 * already receipted keeps its first receipt, which passed as well.
 * `missing` if no cast has these bytes, or if that cast's seat was erased
 * at the close. Throws on a receipt that doesn't
 * name `seat` and exactly this ballot, which the worker never passes.
 */
export function withReceipt(
  casts: readonly CastRecord[],
  ballot: Uint8Array,
  checked: CheckedReceipt,
): CastRecord[] | "missing" {
  const { seat, receipt } = checked;
  const decoded = ballot instanceof Uint8Array ? decodedOf(ballot) : undefined;
  if (
    decoded === undefined ||
    !(receipt instanceof Uint8Array) ||
    !receiptFits(decoded, seat, receipt)
  )
    throw new TypeError("not a receipt for this ballot");
  const own = casts.find((cast) => equalBytes(cast.ballot, ballot));
  // A seat erased at the close has no share left to take the
  // receipt's place: never answered as kept, so the caller stops rather
  // than counting the seat receipted (found by the in-session review).
  if (own === undefined || own.shares.some((share) => share.seat === seat && "erased" in share))
    return "missing";
  return casts.map((cast) => {
    const at = cast.shares.findIndex((share) => share.seat === seat && "m" in share);
    const share = cast.shares[at];
    if (share === undefined || !("m" in share)) return cast;
    // Every cast held decoded when it was read.
    const record = decodedOf(cast.ballot) as BallotRecordV3;
    if (!receiptFits(record, seat, receipt)) return cast;
    return {
      ...cast,
      shares: cast.shares.with(at, {
        seat,
        ciphertext: share.ciphertext,
        receipt: receipt.slice(),
      }),
    };
  });
}

/**
 * Records a receipt (`withReceipt`) in `electionId` at `tier`, erasing the
 * seat's `m_i` from what this origin's storage hands back; the browser may
 * keep the replaced bytes on disk until it compacts them (T-18). Throws as
 * `withReceipt` does, before reading.
 */
export async function recordReceipt(
  electionId: Uint8Array,
  tier: number,
  ballot: Uint8Array,
  checked: CheckedReceipt,
  factory: IDBFactory = indexedDB,
): Promise<RecordReceiptOutcome> {
  const key = keyOf(electionId, tier);
  withReceipt([], ballot, checked);
  return updateCasts(key, factory, (casts) => withReceipt(casts, ballot, checked));
}

/**
 * `casts` with the cast whose bytes are exactly `ballot` marked `handed`,
 * before a run through the relay or the voter's wallet may hand any of its
 * postings out, so a page that went away before they were recorded still
 * waits for them, and sends the ballot once they are, when the poll is
 * opened again ([[posting-relay]], Sending after a run; T-25), and so is
 * every other cast of the same seal, whose postings are these. Every cast
 * of the seal takes one mark: the earliest of `at`, this device's clock in
 * seconds, and any mark one of them holds, so the first run's, from which a
 * later run looks for an earlier one's deposit on L1 (Outcome, The read). A mark is never taken back: whatever a run met, its
 * parts may still reach the board (T-15). `missing` if no cast has these
 * bytes. Throws on an `at` that isn't a time `parseStoredCasts` reads.
 */
export function withHanded(
  casts: readonly CastRecord[],
  ballot: Uint8Array,
  at: bigint,
): CastRecord[] | "missing" {
  if (typeof at !== "bigint" || at < 0n || at > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError("at: expected seconds since the epoch");
  const own = casts.find((cast) => equalBytes(cast.ballot, ballot));
  if (own === undefined) return "missing";
  // Every cast held decoded when it was read.
  const hashOf = (cast: CastRecord) => ballotHashOf(decodedOf(cast.ballot) as BallotRecordV3);
  const hash = hashOf(own);
  const seal = (cast: CastRecord) => equalBytes(hashOf(cast), hash);
  const handed = casts.reduce(
    (first, cast) =>
      cast.handed !== undefined && cast.handed < first && seal(cast) ? cast.handed : first,
    at,
  );
  // A recast of the same seal recorded before the mark: its postings are
  // these, byte for byte, so it is marked too.
  return casts.map((cast) => (seal(cast) ? { ...cast, handed } : cast));
}

/**
 * Marks the recorded cast whose bytes are exactly `ballot` in `electionId`
 * at `tier` as `handed` at `at` (`withHanded`), in one transaction with the
 * read, and answers its mark. `unreadable` for casts this device can't
 * read, which are never replaced, and `unwritable` for storage the browser
 * refuses: the caller then hands nothing out.
 */
export async function recordHanded(
  electionId: Uint8Array,
  tier: number,
  ballot: Uint8Array,
  at: bigint,
  factory: IDBFactory = indexedDB,
): Promise<RecordHandedOutcome> {
  const key = keyOf(electionId, tier);
  withHanded([], ballot, at);
  let handed: bigint | undefined;
  const outcome = await updateCasts(key, factory, (casts) => {
    const changed = withHanded(casts, ballot, at);
    if (typeof changed !== "string")
      handed = changed.find((cast) => equalBytes(cast.ballot, ballot))?.handed;
    return changed;
  });
  if (outcome !== "recorded") return outcome;
  // Recorded only with the cast found and marked.
  return { handed: handed as bigint };
}

/**
 * Records the operator's checked answer (`checkBoarded`) for the recorded
 * cast whose bytes are exactly `ballot`. The first answer kept stays: a
 * resend of the same bytes is answered with the same entry, so another one
 * is `conflict` and changes nothing. `missing` if no recorded cast has these
 * bytes. Throws on an entry that doesn't carry exactly `ballot` in
 * `electionId`, which `checkBoarded` never passes.
 */
export async function recordBoarded(
  electionId: Uint8Array,
  tier: number,
  ballot: Uint8Array,
  boarded: Boarded,
  factory: IDBFactory = indexedDB,
): Promise<RecordBoardedOutcome> {
  const key = keyOf(electionId, tier);
  // Only the entry and the link are kept: a `CheckedBoarded` also carries
  // where the entry says it is, which the entry itself holds.
  const answer = boardedOf({ entry: boarded.entry, link: boarded.link }, ballot);
  if (answer === undefined || !equalBytes(entryElection(answer.entry), electionId))
    throw new TypeError("not a board entry for this ballot");
  return updateCasts(key, factory, (casts) => {
    const at = casts.findIndex((cast) => equalBytes(cast.ballot, ballot));
    const cast = casts[at];
    if (cast === undefined) return "missing";
    if (cast.boarded !== undefined)
      return equalBytes(cast.boarded.entry, answer.entry) &&
        equalBytes(cast.boarded.link, answer.link)
        ? "recorded"
        : "conflict";
    return casts.with(at, { ...cast, boarded: answer });
  });
}

/**
 * The receipted seats of the cast whose bytes are exactly `ballot` whose
 * receipt no kept board entry carries yet, in seat order, as copies: what
 * the client submits through the operator's board path once the ballot is
 * boarded ([[delivery]], Client rule 3). None for a ballot no cast has.
 */
export function unboardedReceipts(
  casts: readonly CastRecord[],
  ballot: Uint8Array,
): UnboardedReceipt[] {
  const cast = casts.find((c) => equalBytes(c.ballot, ballot));
  return (cast?.shares ?? []).flatMap((share) =>
    "receipt" in share && share.boarded === undefined
      ? [{ seat: share.seat, receipt: share.receipt.slice() }]
      : [],
  );
}

/**
 * `casts` with `boarded`, the operator's checked board entry for a receipt
 * of `checked`'s seat, kept beside that seat's receipt in every cast it
 * receipts: the cast whose bytes are exactly `ballot` and any recast of the
 * same seal ([[delivery]], Client rule 3). `checked` is the entry's own
 * payload, which the worker passed for the ballot under the poll's
 * registered keys: this device's receipt, or an earlier one the board path
 * already carried for the seat (Boarding, rule 5). A share already holding
 * an entry keeps its first, which passed as well. `missing` if no cast has
 * these bytes with that seat receipted. Throws on an entry whose payload
 * isn't `checked`'s receipt, or on a receipt that doesn't name the seat
 * and exactly this ballot, which the page never passes on.
 */
export function withReceiptBoarded(
  casts: readonly CastRecord[],
  ballot: Uint8Array,
  checked: CheckedReceipt,
  boarded: Boarded,
): CastRecord[] | "missing" {
  const { seat, receipt } = checked;
  const decoded = ballot instanceof Uint8Array ? decodedOf(ballot) : undefined;
  const entry =
    decoded === undefined || !(receipt instanceof Uint8Array)
      ? undefined
      : entryOf({ entry: boarded.entry, link: boarded.link }, (payload) =>
          equalBytes(payload, receipt),
        );
  if (decoded === undefined || entry === undefined || !receiptFits(decoded, seat, receipt))
    throw new TypeError("not a board entry of a receipt for this ballot");
  const holds = (cast: CastRecord) =>
    cast.shares.some((share) => share.seat === seat && "receipt" in share);
  if (!casts.some((cast) => equalBytes(cast.ballot, ballot) && holds(cast))) return "missing";
  return casts.map((cast) => {
    const at = cast.shares.findIndex(
      (share) => share.seat === seat && "receipt" in share && share.boarded === undefined,
    );
    const share = cast.shares[at];
    if (share === undefined || !("receipt" in share)) return cast;
    // Every cast held decoded when it was read.
    const record = decodedOf(cast.ballot) as BallotRecordV3;
    if (!receiptFits(record, seat, receipt)) return cast;
    return {
      ...cast,
      shares: cast.shares.with(at, {
        ...share,
        boarded: { entry: entry.entry.slice(), link: entry.link.slice() },
      }),
    };
  });
}

/**
 * Records the operator's checked board entry for a receipt
 * (`withReceiptBoarded`) in `electionId` at `tier`. Throws as
 * `withReceiptBoarded` does, and on an entry naming another election,
 * before reading.
 */
export async function recordReceiptBoarded(
  electionId: Uint8Array,
  tier: number,
  ballot: Uint8Array,
  checked: CheckedReceipt,
  boarded: Boarded,
  factory: IDBFactory = indexedDB,
): Promise<RecordReceiptOutcome> {
  const key = keyOf(electionId, tier);
  withReceiptBoarded([], ballot, checked, boarded);
  if (!equalBytes(entryElection(boarded.entry), electionId))
    throw new TypeError("not a board entry for this election");
  return updateCasts(key, factory, (casts) => withReceiptBoarded(casts, ballot, checked, boarded));
}

/** Whether any of `casts` still keeps a seat's `m_i`: what a posting would need, and what `withSharesErased` erases. */
export const keepsShares = (casts: readonly CastRecord[]): boolean =>
  casts.some((cast) => cast.shares.some((share) => "m" in share));

/**
 * `casts` with every seat still holding its `m_i` left with nothing but the
 * seat, its `ct_i` and `m_i` erased, in every cast: what the client does once
 * the poll closed, after which no posting helps one of its own ballots
 * ([[delivery]], Client rule 4; [[posting-relay]], The ballot's own
 * deadline; T-18). Receipted seats keep their `ct_i`,
 * receipt and board entry, which hold nothing a posting needs and are kept
 * to be seen onto the board (Client rule 3). `none` if no seat holds an
 * `m_i`.
 */
export function withSharesErased(casts: readonly CastRecord[]): CastRecord[] | "none" {
  if (!keepsShares(casts)) return "none";
  return casts.map((cast) => ({
    ...cast,
    shares: cast.shares.map((share) =>
      "m" in share ? { seat: share.seat, erased: true as const } : share,
    ),
  }));
}

/**
 * Erases every unreceipted seat's `ct_i` and `m_i` from the casts in
 * `electionId` at `tier` (`withSharesErased`), in one transaction with the
 * read; the caller has judged the poll's close passed. As with a
 * receipt, the browser may keep the replaced bytes on disk until it
 * compacts them (T-18). `none` if no seat holds one, `unreadable` for casts
 * this device can't read, which are never replaced, and `unwritable` for
 * storage the browser refuses.
 */
export async function eraseShares(
  electionId: Uint8Array,
  tier: number,
  factory: IDBFactory = indexedDB,
): Promise<EraseSharesOutcome> {
  const key = keyOf(electionId, tier);
  const outcome = await updateCasts(key, factory, withSharesErased);
  return outcome === "recorded" ? "erased" : outcome;
}

/**
 * `casts` once the voter declined to post the unreceipted seats of the cast
 * whose bytes are exactly `ballot` ([[delivery]], Client rule 4; T-18):
 * each of its seats still holding an `m_i` is left with nothing but the
 * seat, and so is the same seat's share in every other cast holding the
 * same `ct_i`, a recast of the same seal, whose `m_i` is the same. Receipted
 * seats keep everything, for Client rule 3, and so does every other cast:
 * the voter declined this ballot's posting, not an earlier one's. A cast
 * holding an erased seat is never resumed (`unsentCast`), so the declined
 * ballot is never sent from here. `missing` if no cast has these bytes.
 */
export function withPostingDeclined(
  casts: readonly CastRecord[],
  ballot: Uint8Array,
): CastRecord[] | "missing" {
  const own = casts.find((cast) => equalBytes(cast.ballot, ballot));
  if (own === undefined) return "missing";
  const declined = own.shares.flatMap((share) => ("m" in share ? [share] : []));
  return casts.map((cast) => ({
    ...cast,
    shares: cast.shares.map((share) =>
      "m" in share &&
      declined.some((d) => d.seat === share.seat && equalBytes(d.ciphertext, share.ciphertext))
        ? { seat: share.seat, erased: true as const }
        : share,
    ),
  }));
}

/**
 * Records the voter's decline (`withPostingDeclined`) in `electionId` at
 * `tier`, in one transaction with the read. As with a receipt, the browser
 * may keep the replaced bytes on disk until it compacts them (T-18).
 * `unreadable` for casts this device can't read, which are never replaced,
 * and `unwritable` for storage the browser refuses.
 */
export async function declinePosting(
  electionId: Uint8Array,
  tier: number,
  ballot: Uint8Array,
  factory: IDBFactory = indexedDB,
): Promise<DeclinePostingOutcome> {
  const key = keyOf(electionId, tier);
  const outcome = await updateCasts(key, factory, (casts) => withPostingDeclined(casts, ballot));
  return outcome === "recorded" ? "declined" : outcome;
}
