// The summed-share message (docs/spec/tally.md, Summed-share message; record
// type 0x000b): a trustee's summed shares for one cell, sealed to one other
// trustee under the hybrid KEM of share-encryption.ts with its own tags, and
// signed with the sender's per-election signing key. It never reaches the
// board, IPFS or the archive (ADR 0015; T-15). The recipient checks context
// and signature before it decapsulates, so only a registered seat can make it
// run ML-KEM decapsulation on a chosen ciphertext (T-39), then the summed
// shares themselves against the cell's aggregate (T-29). Version 2, which
// tally-opening version 3 fixes, names the panel whose half the sums are of:
// sender and recipient are seats of that panel, so summed shares never cross
// between panels (docs/spec/tally.md, Summed-share message (version 2); T-14,
// T-15, T-37).

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { type Share, SHARES } from "./ballot-validity.ts";
import {
  bytesFixed,
  bytesVar,
  type CodecValue,
  decode,
  encode,
  enum8,
  struct,
  u16,
  u8,
  Writer,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { type Element, element, G, GROUP_ORDER, H } from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import { checkedTranscriptHash, type RegisteredKeys } from "./ceremony.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import {
  AEAD_TAG_LEN,
  KEM_PUBLIC_KEY,
  KEM_SECRET_KEY,
  type KemSecretKey,
  MLKEM_CT_LEN,
  MLKEM_MSG_LEN,
  nonZeroRandom,
} from "./share-encryption.ts";
import {
  type CellAggregate,
  checkSummedShares,
  panelTallyRules,
  type TallyRules,
  tallyRules,
} from "./tally.ts";
import type { ElectionDefinition, ElectionDefinitionV6 } from "./election-definition.ts";
import {
  type AnyElectionDefinitionRecord,
  electionDefinitionHash,
  electionDefinitionV3Hash,
  electionDefinitionV4Hash,
  electionDefinitionV5Hash,
  electionDefinitionV6Hash,
  UnsupportedVersionError,
} from "./protocol.ts";
import { aggregateHash } from "./tally-opening.ts";
import { identityKey, p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const { MAX_OPTIONS, MAX_TRUSTEES } = PARAMETERS;

const TAG = "abolish/v1/sig/summed-share";

/** The longest sealed summed shares: `SHARES` at `MAX_OPTIONS` and the tag. */
const MAX_SEALED = 4 + 64 * MAX_OPTIONS + AEAD_TAG_LEN;

const statementFields = [
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["aggregate_hash", bytesFixed(32)],
  ["sender", u8],
  ["recipient", u8],
  ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
  ["ct_dh", element],
  ["sealed", bytesVar(MAX_SEALED)],
] as const;

const statementV1 = struct(statementFields);

const summedShareV1 = struct([...statementFields, ["signature", p256Sig]] as const);

// Version 1's fields with `panel` after `cell`.
const statementFieldsV2 = [
  ["definition_hash", bytesFixed(32)],
  ["cell", u8],
  ["panel", enum8([1, 2])],
  ["aggregate_hash", bytesFixed(32)],
  ["sender", u8],
  ["recipient", u8],
  ["ct_mlkem", bytesFixed(MLKEM_CT_LEN)],
  ["ct_dh", element],
  ["sealed", bytesVar(MAX_SEALED)],
] as const;

const statementV2 = struct(statementFieldsV2);

const summedShareV2 = struct([...statementFieldsV2, ["signature", p256Sig]] as const);

/** Summed-share message, version 1 (docs/spec/tally.md, Summed-share message). */
export type SummedShareMessage = CodecValue<typeof summedShareV1>;

/** Summed-share message, version 2 (docs/spec/tally.md, Summed-share message (version 2)). */
export type PanelSummedShareMessage = CodecValue<typeof summedShareV2>;

/**
 * Record type `0x000b`. No profile pins it: the pinned tally-opening version
 * fixes it, version 1 under tally-opening version 1 and version 2 under
 * version 3.
 */
export const SUMMED_SHARE = recordType(RECORD_TYPES.summedShareMessage, {
  1: summedShareV1,
  2: summedShareV2,
});

const SCHEMA = new RecordSchema([SUMMED_SHARE]);

export function encodeSummedShareMessage(message: SummedShareMessage): Uint8Array {
  return SCHEMA.encode(SUMMED_SHARE, 1, message);
}

/** Strictly decodes a summed-share message under version 1, the version tally opening 1 fixes. */
export function decodeSummedShareMessage(bytes: Uint8Array, pinned: 1): SummedShareMessage {
  const r = SCHEMA.decode(SUMMED_SHARE, bytes, pinned);
  // Unreachable: the pin refused every other version.
  if (r.version !== 1) throw new RangeError("summed share: not version 1");
  return r.value;
}

export function encodePanelSummedShareMessage(message: PanelSummedShareMessage): Uint8Array {
  return SCHEMA.encode(SUMMED_SHARE, 2, message);
}

/** Strictly decodes a summed-share message under version 2, the version tally opening 3 fixes. */
export function decodePanelSummedShareMessage(
  bytes: Uint8Array,
  pinned: 2,
): PanelSummedShareMessage {
  const r = SCHEMA.decode(SUMMED_SHARE, bytes, pinned);
  // Unreachable: the pin refused every other version.
  if (r.version !== 2) throw new RangeError("summed share: not version 2");
  return r.value;
}

type AnyStatement =
  | CodecValue<typeof statementV1>
  | (CodecValue<typeof statementV1> & { readonly panel: 1 | 2 });

/**
 * What the sender signs: the record's encoding without its signature, header
 * included, version 2 when the message names a panel. Both versions' bytes
 * start with the record type and version, so neither's signature serves for
 * the other (T-31).
 */
function signedBytes(m: AnyStatement): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.summedShareMessage);
  const common = {
    definition_hash: m.definition_hash,
    cell: m.cell,
    aggregate_hash: m.aggregate_hash,
    sender: m.sender,
    recipient: m.recipient,
    ct_mlkem: m.ct_mlkem,
    ct_dh: m.ct_dh,
    sealed: m.sealed,
  };
  // Through the struct, so only these fields are read even from a whole record.
  if ("panel" in m) {
    u8.write(w, 2);
    statementV2.write(w, { ...common, panel: m.panel });
  } else {
    u8.write(w, 1);
    statementV1.write(w, common);
  }
  return w.finish();
}

/**
 * A registered definition a tally runs under: a version-1 definition, or a
 * decoded record of version 1, 3, 4 or 5 (`tallyRules`; a version-6 one is
 * refused until P2-16 tallies ballot version 4).
 */
export type SummedShareDefinition = ElectionDefinition | AnyElectionDefinitionRecord;

/** A version-6 definition with an author panel: its tally is per panel, under summed-share version 2. */
export type PanelSummedShareDefinition = {
  readonly version: 6;
  readonly value: ElectionDefinitionV6;
};

/**
 * The cell a message is about: the registered definition, the cell's
 * position in its partition and its aggregate over the anchored counted set.
 */
export interface SummedShareCell {
  readonly definition: SummedShareDefinition;
  readonly cell: number;
  readonly aggregate: CellAggregate;
}

/**
 * What the definition fixes for a message: its hash (bound by the AAD and the
 * signature), the transcript whose key set the message may use, and the
 * tally rules. Derived here from one definition, never taken separately, so
 * a caller can't pair one election's hash with another transcript (T-37).
 */
interface DefinitionContext {
  readonly definitionHash: Uint8Array;
  /**
   * Under version 2, the panel whose half is summed (`rules.panel`); absent
   * under version 1. It decides the message version.
   */
  readonly panel?: 1 | 2;
  /**
   * The transcript whose checked key set the message's seats are from: the
   * definition's `ceremony_transcript_hash`, or for the author panel its
   * `author_transcript_hash` (docs/spec/tally.md, Panels and counted set).
   */
  readonly ceremonyTranscriptHash: Uint8Array;
  readonly rules: TallyRules;
  /**
   * The number of cells in the registered partition: under definition version
   * 1, one per `electorate` entry, under versions 3 to 5 every tier's cells
   * (verifier 2.8). A trustee sums only for
   * these cells, so no request for another cell, over a subset of a counted
   * set, can make it disclose a difference of sums (T-14, T-16).
   */
  readonly cells: number;
}

function contextOf(definition: SummedShareDefinition): DefinitionContext {
  const record: AnyElectionDefinitionRecord =
    "version" in definition && "value" in definition
      ? definition
      : { version: 1, value: definition };
  // Summed-share message version 1 under definition version 6 is the
  // trustee node's tally of a poll without an author panel, which isn't
  // built yet: refused, as before tallyRules read version 6 (T-36).
  if (record.version === 6)
    throw new UnsupportedVersionError(RECORD_TYPES.electionDefinition, record.version);
  // Refuses a definition that isn't well-formed (T-28).
  const rules = tallyRules(record);
  switch (record.version) {
    case 1:
      return {
        definitionHash: electionDefinitionHash(record.value),
        ceremonyTranscriptHash: Uint8Array.from(record.value.ceremony_transcript_hash),
        rules,
        cells: record.value.electorate.length,
      };
    case 3:
    case 4:
    case 5:
      return {
        definitionHash:
          record.version === 3
            ? electionDefinitionV3Hash(record.value)
            : record.version === 4
              ? electionDefinitionV4Hash(record.value)
              : electionDefinitionV5Hash(record.value),
        ceremonyTranscriptHash: Uint8Array.from(record.value.ceremony_transcript_hash),
        rules,
        // Every tier's cells, numbered across the definition (verifier 2.8).
        cells: record.value.electorate.reduce((n, t) => n + t.cells.length, 0),
      };
    default:
      // Unreachable: tallyRules refused every other version.
      throw new RangeError("summed share: unsupported definition version");
  }
}

/**
 * Panel `panel`'s values from a version-6 definition with an author panel:
 * its hash, the transcript its seats' key set comes from, its half's rules
 * and the partition's cells (T-37).
 */
function panelContextOf(definition: PanelSummedShareDefinition, panel: 1 | 2): DefinitionContext {
  // Refuses another version, a definition that isn't well-formed and one
  // without an author panel (T-28, T-36).
  const rules = panelTallyRules(definition, panel);
  const d = definition.value;
  return {
    definitionHash: electionDefinitionV6Hash(d),
    panel,
    ceremonyTranscriptHash: Uint8Array.from(
      panel === 1 ? d.ceremony_transcript_hash : d.author_transcript_hash,
    ),
    rules,
    cells: d.electorate.reduce((n, t) => n + t.cells.length, 0),
  };
}

/** Internal: a cell with its definition's values already derived (tests and vectors). */
export interface SummedShareCellContext extends DefinitionContext {
  readonly cell: number;
  readonly aggregate: CellAggregate;
}

/** `K`: share-encryption's X-Wing-style combiner, under this message's own tag. */
function combine(ssM: Uint8Array, ssDh: Element, ctDh: Element, dh: Element): Uint8Array {
  const w = new Writer();
  w.bytes(ssM);
  element.write(w, ssDh);
  element.write(w, ctDh);
  element.write(w, dh);
  return H(ds("abolish/v1/kem/summed-share", w.finish()));
}

function associatedData(
  definitionHash: Uint8Array,
  cell: number,
  panel: 1 | 2 | undefined,
  aggregate: Uint8Array,
  sender: number,
  recipient: number,
): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.summedShareMessage);
  u8.write(w, panel === undefined ? 1 : 2);
  w.bytes(definitionHash);
  u8.write(w, cell);
  // Version 2 binds the panel, so a message sealed for one panel's seat
  // never opens as the other's (T-37).
  if (panel !== undefined) u8.write(w, panel);
  w.bytes(aggregate);
  u8.write(w, sender);
  u8.write(w, recipient);
  return ds("abolish/v1/kem/summed-share-aad", w.finish());
}

// Each AEAD key seals exactly one message: it hashes a fresh 32-byte ML-KEM
// message and a fresh ephemeral, so a fixed nonce never repeats under a key.
const NONCE = new Uint8Array(12);

// Public values only: hashes and keys.
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Refuses a key set that `checkCeremonyTranscript` didn't return for the
 * transcript the definition names: a set served from an API, a cache or a
 * file, or another run's or another election's, could put a key its holder
 * controls under any seat (T-37, T-15).
 */
function requireCheckedSet(
  registered: readonly RegisteredKeys[],
  ceremonyTranscriptHash: Uint8Array,
): void {
  const hash = checkedTranscriptHash(registered);
  if (hash === undefined)
    throw new TypeError(
      "summed share: the key set must come from checkCeremonyTranscript, unchanged",
    );
  if (!(ceremonyTranscriptHash instanceof Uint8Array) || !sameBytes(hash, ceremonyTranscriptHash))
    throw new TypeError(
      "summed share: the key set is from a transcript this definition doesn't name",
    );
  if (new Set(registered.map((k) => k.index)).size !== registered.length)
    throw new RangeError("summed share: the registered key set names a seat twice");
}

function checkSeat(seat: number, n: number, what: string): void {
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > Math.min(n, MAX_TRUSTEES))
    throw new RangeError(`${what} must be a seat from 1 to n`);
}

function checkPanel(c: DefinitionContext): void {
  if (c.panel !== undefined && c.panel !== 1 && c.panel !== 2)
    throw new RangeError("summed share: panel is 1 or 2");
  if (c.panel !== c.rules.panel)
    throw new RangeError("summed share: the rules are another panel's");
}

function checkCell(c: SummedShareCellContext): void {
  if (!(c.definitionHash instanceof Uint8Array) || c.definitionHash.length !== 32)
    throw new RangeError("summed share: definitionHash must be 32 bytes");
  checkPanel(c);
  if (!Number.isSafeInteger(c.cell) || c.cell < 0 || c.cell >= c.cells)
    throw new RangeError("summed share: cell must be a cell of the registered partition");
  const { optionCount: m, threshold: k } = c.rules;
  if (c.aggregate.length !== m || c.aggregate.some((row) => row.length !== k))
    throw new RangeError("summed share: the aggregate doesn't match the rules");
}

/** The sender: its seat and per-election signing secret. */
export interface SummedShareSender {
  readonly index: number;
  readonly signingSecret: Uint8Array;
}

/**
 * Internal: seals with the given ML-KEM message `mu` and ephemeral `e`, for
 * a cell whose definition values are given directly. Production code calls
 * `sealSummedShares`; the package entry point doesn't export this.
 */
export function sealSummedSharesWith(
  cell: SummedShareCellContext,
  registered: readonly RegisteredKeys[],
  sender: SummedShareSender,
  recipientIndex: number,
  summed: readonly Share[],
  mu: Uint8Array,
  e: bigint,
): Uint8Array {
  checkCell(cell);
  const n = cell.rules.panelSize;
  checkSeat(sender.index, n, "sender");
  checkSeat(recipientIndex, n, "recipient");
  if (sender.index === recipientIndex)
    throw new RangeError("summed share: a trustee never sends its sums to itself");
  // The recipient's KEM key is looked up by seat in the key set the
  // definition's transcript registered, never taken from the caller (ADR 0015;
  // T-37, T-15). The sender must be registered under its own key.
  requireCheckedSet(registered, cell.ceremonyTranscriptHash);
  const recipient = registered.find((k) => k.index === recipientIndex);
  if (recipient === undefined)
    throw new RangeError("summed share: the recipient isn't a registered seat");
  const self = registered.find((k) => k.index === sender.index);
  if (self === undefined || !sameBytes(self.signingKey, identityKey(sender.signingSecret)))
    throw new RangeError("summed share: the sender isn't registered under this signing key");
  if (!(mu instanceof Uint8Array) || mu.length !== MLKEM_MSG_LEN)
    throw new RangeError("summed share: mu must be 32 bytes");
  if (typeof e !== "bigint" || e <= 0n || e >= GROUP_ORDER)
    throw new RangeError("summed share: e must be a scalar from 1 to ℓ − 1");
  // A node sends only sums over the anchored counted set that pass its own
  // check (docs/spec/tally.md, Summed-share message, Resending).
  if (!checkSummedShares(cell.aggregate, sender.index, summed))
    throw new RangeError("summed share: the sums fail the summed-share check");
  // Round-trips the key through its codec: the modulus check and a
  // non-identity DH key, whatever the caller passed (T-39).
  const key = decode(KEM_PUBLIC_KEY, encode(KEM_PUBLIC_KEY, recipient.kemKey));
  const aggregate = aggregateHash(cell.aggregate);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(key.ek, mu);
  const ctDh = G.multiply(e);
  const k = combine(sharedSecret, key.dh.multiply(e), ctDh, key.dh);
  sharedSecret.fill(0);
  const aad = associatedData(
    cell.definitionHash,
    cell.cell,
    cell.panel,
    aggregate,
    sender.index,
    recipientIndex,
  );
  const plain = encode(SHARES, summed);
  const sealed = chacha20poly1305(k, NONCE, aad).encrypt(plain);
  k.fill(0);
  plain.fill(0);
  const statement = {
    definition_hash: Uint8Array.from(cell.definitionHash),
    cell: cell.cell,
    aggregate_hash: aggregate,
    sender: sender.index,
    recipient: recipientIndex,
    ct_mlkem: cipherText,
    ct_dh: ctDh,
    sealed,
  };
  if (cell.panel === undefined)
    return encodeSummedShareMessage({
      ...statement,
      signature: signStatement(sender.signingSecret, TAG, signedBytes(statement)),
    });
  const v2 = { ...statement, panel: cell.panel };
  return encodePanelSummedShareMessage({
    ...v2,
    signature: signStatement(sender.signingSecret, TAG, signedBytes(v2)),
  });
}

/**
 * Seals a trustee's summed shares for one cell to seat `recipientIndex`'s KEM
 * key in the ceremony's registered key set (`checkCeremonyTranscript`) and
 * signs the message (docs/spec/tally.md, Summed-share
 * message), with `μ` and `e` fresh from the CSPRNG.
 */
export function sealSummedShares(
  cell: SummedShareCell,
  registered: readonly RegisteredKeys[],
  sender: SummedShareSender,
  recipientIndex: number,
  summed: readonly Share[],
): Uint8Array {
  return sealSummedSharesWith(
    { ...contextOf(cell.definition), cell: cell.cell, aggregate: cell.aggregate },
    registered,
    sender,
    recipientIndex,
    summed,
    randomBytes(MLKEM_MSG_LEN),
    nonZeroRandom(),
  );
}

/** The cell a version-2 message is about: one panel's half of it. */
export interface PanelSummedShareCell {
  readonly definition: PanelSummedShareDefinition;
  readonly cell: number;
  /** The sender's panel: 1 the default panel, 2 the author panel. */
  readonly panel: 1 | 2;
  /** Panel `panel`'s aggregate for the cell over the anchored counted set. */
  readonly aggregate: CellAggregate;
}

/**
 * Seals seat `(panel, sender)`'s summed shares of its panel's half of one
 * cell to seat `(panel, recipientIndex)`'s KEM key and signs the message
 * (docs/spec/tally.md, Summed-share message (version 2)). `registered` is the
 * key set `checkCeremonyTranscript` returned for the panel's transcript, the
 * author transcript once the author approvals approve it; the recipient is
 * looked up there, so no seat of the other panel can be named (T-14, T-37).
 */
export function sealPanelSummedShares(
  cell: PanelSummedShareCell,
  registered: readonly RegisteredKeys[],
  sender: SummedShareSender,
  recipientIndex: number,
  summed: readonly Share[],
): Uint8Array {
  return sealSummedSharesWith(
    { ...panelContextOf(cell.definition, cell.panel), cell: cell.cell, aggregate: cell.aggregate },
    registered,
    sender,
    recipientIndex,
    summed,
    randomBytes(MLKEM_MSG_LEN),
    nonZeroRandom(),
  );
}

export type SummedShareCode =
  | "summed-malformed"
  | "summed-context"
  | "summed-signature"
  | "summed-decrypt"
  | "summed-check";

export type SummedShareResult =
  | {
      readonly ok: true;
      readonly cell: number;
      readonly sender: number;
      readonly summed: readonly Share[];
    }
  | { readonly ok: false; readonly code: SummedShareCode };

/** What a recipient checks a message against, all from data it has already checked. */
export interface SummedShareElection {
  /** The registered definition. */
  readonly definition: SummedShareDefinition;
  /** Each cell's aggregate over the anchored counted set, in partition order. */
  readonly aggregates: readonly CellAggregate[];
  /**
   * The key set `checkCeremonyTranscript` returned for the transcript the
   * definition names: each qualified seat and its per-election keys.
   */
  readonly registered: readonly RegisteredKeys[];
}

/** What a seat of panel `panel` checks a version-2 message against. */
export interface PanelSummedShareElection {
  readonly definition: PanelSummedShareDefinition;
  /** The recipient's panel. */
  readonly panel: 1 | 2;
  /** The panel's aggregate of each cell over the anchored counted set, in partition order. */
  readonly aggregates: readonly CellAggregate[];
  /** The key set `checkCeremonyTranscript` returned for the panel's transcript. */
  readonly registered: readonly RegisteredKeys[];
}

/**
 * Seat `(panel, recipient)`'s check of a version-2 summed-share message:
 * version 1's checks in its order (`openSummedShares`), with the message's
 * `panel` the recipient's own, its sender a seat of that panel and its sums
 * checked against that panel's aggregate (docs/spec/tally.md, Summed-share
 * message (version 2)).
 */
export function openPanelSummedShares(
  election: PanelSummedShareElection,
  recipient: { readonly index: number; readonly secretKey: KemSecretKey },
  bytes: Uint8Array,
): SummedShareResult {
  return openSummedSharesWith(
    {
      ...panelContextOf(election.definition, election.panel),
      aggregates: election.aggregates,
      registered: election.registered,
    },
    recipient,
    bytes,
  );
}

/** Internal: an election with its definition's values already derived (tests and vectors). */
export interface SummedShareElectionContext extends DefinitionContext {
  readonly aggregates: readonly CellAggregate[];
  readonly registered: readonly RegisteredKeys[];
}

/**
 * Trustee `recipient`'s check of a summed-share message (docs/spec/tally.md,
 * Summed-share message, Receiving), in order: it decodes, names this
 * election, a cell of the partition, this recipient, a registered sender
 * other than it and the cell's aggregate as the recipient computed it; the
 * sender's registered key signed it; it decrypts to `m` canonical summed
 * shares; and they pass the summed-share check. A message that fails is
 * ignored.
 */
export function openSummedShares(
  election: SummedShareElection,
  recipient: { readonly index: number; readonly secretKey: KemSecretKey },
  bytes: Uint8Array,
): SummedShareResult {
  return openSummedSharesWith(
    {
      ...contextOf(election.definition),
      aggregates: election.aggregates,
      registered: election.registered,
    },
    recipient,
    bytes,
  );
}

/**
 * Internal: `openSummedShares` for an election whose definition values are
 * given directly. The package entry point doesn't export this.
 */
export function openSummedSharesWith(
  election: SummedShareElectionContext,
  recipient: { readonly index: number; readonly secretKey: KemSecretKey },
  bytes: Uint8Array,
): SummedShareResult {
  if (!(election.definitionHash instanceof Uint8Array) || election.definitionHash.length !== 32)
    throw new RangeError("summed share: definitionHash must be 32 bytes");
  checkPanel(election);
  const n = election.rules.panelSize;
  checkSeat(recipient.index, n, "recipient");
  // Only the definition's checked key set decides whose signature lets a
  // message reach decapsulation (T-39, T-37).
  requireCheckedSet(election.registered, election.ceremonyTranscriptHash);
  const { optionCount, threshold } = election.rules;
  // One aggregate per cell of the registered partition, no more (T-14, T-16).
  if (election.aggregates.length !== election.cells)
    throw new RangeError("summed share: one aggregate per cell of the registered partition");
  if (
    election.aggregates.some(
      (a) => a.length !== optionCount || a.some((row) => row.length !== threshold),
    )
  )
    throw new RangeError("summed share: an aggregate doesn't match the rules");
  // Round-trips the secret key: a 64-byte seed and x in 1 to ℓ − 1.
  const secret = decode(KEM_SECRET_KEY, encode(KEM_SECRET_KEY, recipient.secretKey));
  let msg: SummedShareMessage | PanelSummedShareMessage;
  let panel: 1 | 2 | undefined;
  try {
    if (election.panel === undefined) msg = decodeSummedShareMessage(bytes, 1);
    else {
      const v2 = decodePanelSummedShareMessage(bytes, 2);
      panel = v2.panel;
      msg = v2;
    }
  } catch {
    return { ok: false, code: "summed-malformed" };
  }
  const aggregate = election.aggregates[msg.cell];
  const signer = election.registered.find((k) => k.index === msg.sender);
  if (
    !sameBytes(msg.definition_hash, election.definitionHash) ||
    panel !== election.panel ||
    aggregate === undefined ||
    msg.recipient !== recipient.index ||
    msg.sender === recipient.index ||
    signer === undefined ||
    !sameBytes(msg.aggregate_hash, aggregateHash(aggregate))
  )
    return { ok: false, code: "summed-context" };
  if (!verifyStatement(signer.signingKey, TAG, signedBytes(msg), msg.signature))
    return { ok: false, code: "summed-signature" };
  const { secretKey: dk } = ml_kem768.keygen(secret.seed);
  // FIPS 203 Decaps: implicit rejection returns a pseudorandom secret for a
  // ciphertext that fails re-encryption, so the AEAD then fails.
  const ssM = ml_kem768.decapsulate(msg.ct_mlkem, dk);
  dk.fill(0);
  const dh = G.multiply(secret.x);
  const k = combine(ssM, msg.ct_dh.multiply(secret.x), msg.ct_dh, dh);
  ssM.fill(0);
  const aad = associatedData(
    msg.definition_hash,
    msg.cell,
    panel,
    msg.aggregate_hash,
    msg.sender,
    msg.recipient,
  );
  let summed: readonly Share[];
  let plain: Uint8Array | undefined;
  try {
    plain = chacha20poly1305(k, NONCE, aad).decrypt(msg.sealed);
    summed = decode(SHARES, plain);
  } catch {
    return { ok: false, code: "summed-decrypt" };
  } finally {
    k.fill(0);
    // Also when the plaintext opened but doesn't decode.
    plain?.fill(0);
  }
  if (summed.length !== election.rules.optionCount) return { ok: false, code: "summed-decrypt" };
  if (!checkSummedShares(aggregate, msg.sender, summed)) return { ok: false, code: "summed-check" };
  return { ok: true, cell: msg.cell, sender: msg.sender, summed };
}
