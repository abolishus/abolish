// The election definition, record type 0x0001 versions 1, 3, 4, 5 and 6
// (docs/spec/election-definition.md): the layouts, the well-formedness
// rules a decoded definition must also meet, and when a listed receipt key
// judges the election. Version 2 is never assigned: a
// frozen vector uses it as the version with no layout. Its hash, registered on L2 before
// voting opens and bound into every ballot and proof, is what stops an
// election's rules changing or differing between voters (T-34).

import {
  bytesFixed,
  type CodecValue,
  enum8,
  fieldBn254,
  list,
  struct,
  u16,
  u32,
  u64,
  u8,
} from "./codec.ts";
import { RECORD_TYPES, recordType } from "./record.ts";
import { foldRegions } from "./regional-cells.ts";
import { authorPanelRule, p256Key } from "./trustee.ts";

const address = bytesFixed(20);
const hash = bytesFixed(32);

const recordPin = struct([
  ["record_type", u16],
  ["version", u8],
] as const);

const profile = struct([
  ["protocol_major", u8],
  ["pins", list(recordPin, 64)],
] as const);

/** The identity tiers of the brief: 0 passkey, 1 vouched, 2 ZK proof of personhood. */
export const TIERS = Object.freeze([0, 1, 2] as const);

const tierGroup = struct([
  ["tier", enum8(TIERS)],
  ["group_id", u64],
  ["root", fieldBn254],
  ["root_l2_block", u64],
  ["group_size", u64],
] as const);

export const ELECTION_TYPES = Object.freeze({ plurality: 1, approval: 2 } as const);
export const TALLY_SCHEMES = Object.freeze({ pedersenVss: 1 } as const);

// The fields up to `l1_relay`, the same in every version.
const ADDRESSES = [
  ["profile", profile],
  ["election_id", hash],
  ["l2_chain_id", u64],
  ["l1_chain_id", u64],
  ["election_registry", address],
  ["board", address],
  ["trustee_registry", address],
  ["group_registry", address],
  ["l1_anchor", address],
  ["l1_relay", address],
] as const;

// The fields before `electorate` in versions 1, 3 and 4.
const HEAD = [
  ...ADDRESSES,
  ["election_type", enum8([ELECTION_TYPES.plurality, ELECTION_TYPES.approval])],
  ["tally_scheme", enum8([TALLY_SCHEMES.pedersenVss])],
  ["option_count", u16],
  ["min_selections", u16],
  ["max_selections", u16],
] as const;

const TAIL = [
  ["membership_vk_hash", hash],
  ["panel_id", hash],
  ["threshold", u8],
  ["panel_size", u8],
  ["ceremony_transcript_hash", hash],
  ["opens_at", u64],
  ["closes_at", u64],
  ["l1_inclusion_bound", u32],
  ["sequencing_window", u64],
  ["max_sequencer_drift", u64],
  ["display_text_commitment", hash],
] as const;

const electionDefinitionV1 = struct([
  ...HEAD,
  ["electorate", list(tierGroup, 3)],
  ...TAIL,
] as const);

const regionGroup = struct([
  ["group_id", u64],
  ["region", u16],
] as const);

const cell = struct([
  ["root", fieldBn254],
  ["members", u64],
] as const);

/** Version 3's per-tier limits (docs/spec/election-definition.md, Layout (version 3)). */
export const DEFINITION_V3_LIMITS = Object.freeze({
  groupsPerTier: 1024,
  regionsPerTier: 1024,
  // The range of the u8 `cell` in tally-opening version 1 and the summed-share
  // message: a partition with more cells couldn't be opened.
  cells: 256,
} as const);

const tierElectorate = struct([
  ["tier", enum8(TIERS)],
  ["root_l2_block", u64],
  ["groups", list(regionGroup, DEFINITION_V3_LIMITS.groupsPerTier)],
  ["regions", list(u64, DEFINITION_V3_LIMITS.regionsPerTier)],
  ["cells", list(cell, DEFINITION_V3_LIMITS.cells)],
] as const);

// Version 1's fields, in order, with the electorate replaced by regional
// cells (0019-regional-cells).
const electionDefinitionV3 = struct([
  ...HEAD,
  ["electorate", list(tierElectorate, 3)],
  ...TAIL,
] as const);

/** Version 4's limit on `receipt_keys`: room to rotate a key during an election. */
export const DEFINITION_V4_LIMITS = Object.freeze({ receiptKeys: 4 } as const);

// Version 3's fields, in order, then the receipt keys that judge the
// election's receipts (0023-receipt-evidence).
const electionDefinitionV4 = struct([
  ...HEAD,
  ["electorate", list(tierElectorate, 3)],
  ...TAIL,
  ["receipt_keys", list(p256Key, DEFINITION_V4_LIMITS.receiptKeys)],
] as const);

/** The question methods of version 5: 1, selection within the question's limits. */
export const QUESTION_METHODS = Object.freeze({ selection: 1 } as const);

/**
 * Version 5's limits (docs/spec/election-definition.md, Layout (version 5)),
 * written out like version 1's so raising a protocol-wide limit can never
 * change what version 5 accepts; a test ties them to PARAMETERS.
 */
export const DEFINITION_V5_LIMITS = Object.freeze({ maxQuestions: 32, maxOptions: 64 } as const);

const question = struct([
  ["method", enum8([QUESTION_METHODS.selection])],
  ["option_count", u16],
  ["min_selections", u16],
  ["max_selections", u16],
] as const);

// Version 4's fields, in order, with `election_type`, `option_count`,
// `min_selections` and `max_selections` replaced at `election_type`'s
// position by the list of questions (0026-multi-question-ballots).
const electionDefinitionV5 = struct([
  ...ADDRESSES,
  ["questions", list(question, DEFINITION_V5_LIMITS.maxQuestions)],
  ["tally_scheme", enum8([TALLY_SCHEMES.pedersenVss])],
  ["electorate", list(tierElectorate, 3)],
  ...TAIL,
  ["receipt_keys", list(p256Key, DEFINITION_V4_LIMITS.receiptKeys)],
] as const);

/** The poll classes of version 6: classes 2 and 3 are on the civic record. */
export const POLL_CLASSES = Object.freeze({
  everyday: 1,
  organisational: 2,
  civicReferendum: 3,
} as const);

/** The results modes of version 6: sealed until the final tally, or live running totals. */
export const RESULTS_MODES = Object.freeze({ sealed: 1, live: 2 } as const);

/**
 * Version 6's limits (docs/spec/election-definition.md, Layout (version 6)),
 * written out like version 5's so changing a protocol-wide parameter can
 * never change what version 6 accepts; a test ties them to PARAMETERS.
 */
export const DEFINITION_V6_LIMITS = Object.freeze({ authorKeys: 16, minLiveBatch: 20 } as const);

// Version 5's fields, in order, then the poll class, the results mode and the
// author panel (0027-trustee-panels-and-live-results), so version 6's bytes
// are version 5's followed by the new fields.
const electionDefinitionV6 = struct([
  ...ADDRESSES,
  ["questions", list(question, DEFINITION_V5_LIMITS.maxQuestions)],
  ["tally_scheme", enum8([TALLY_SCHEMES.pedersenVss])],
  ["electorate", list(tierElectorate, 3)],
  ...TAIL,
  ["receipt_keys", list(p256Key, DEFINITION_V4_LIMITS.receiptKeys)],
  [
    "poll_class",
    enum8([POLL_CLASSES.everyday, POLL_CLASSES.organisational, POLL_CLASSES.civicReferendum]),
  ],
  ["results_mode", enum8([RESULTS_MODES.sealed, RESULTS_MODES.live])],
  ["live_every", u32],
  ["live_batch", u32],
  ["author_threshold", u8],
  ["author_keys", list(p256Key, DEFINITION_V6_LIMITS.authorKeys)],
  ["author_transcript_hash", hash],
] as const);

/** Record type 0x0001, versions 1, 3, 4, 5 and 6 (docs/spec/election-definition.md). */
export const ELECTION_DEFINITION = recordType(RECORD_TYPES.electionDefinition, {
  1: electionDefinitionV1,
  3: electionDefinitionV3,
  4: electionDefinitionV4,
  5: electionDefinitionV5,
  6: electionDefinitionV6,
});

export type ElectionDefinition = CodecValue<typeof electionDefinitionV1>;
export type ElectionDefinitionV3 = CodecValue<typeof electionDefinitionV3>;
export type ElectionDefinitionV4 = CodecValue<typeof electionDefinitionV4>;
export type ElectionDefinitionV5 = CodecValue<typeof electionDefinitionV5>;
export type ElectionDefinitionV6 = CodecValue<typeof electionDefinitionV6>;
export type Question = CodecValue<typeof question>;
export type TierElectorate = CodecValue<typeof tierElectorate>;

// Version 1's limits, written out rather than read from PARAMETERS: raising a
// protocol-wide limit is a new record version (parameters.md), so it must
// never change what version 1 accepts. A test ties them to PARAMETERS.
export const DEFINITION_V1_LIMITS = Object.freeze({ maxOptions: 64, maxTrustees: 16 } as const);

/** The well-formedness rule codes of docs/spec/election-definition.md, in checking order. */
export type ElectionDefinitionRule =
  | "protocol-major"
  | "profile-order"
  | "profile-types"
  | "profile-version"
  | "option-count"
  | "selections"
  | "electorate"
  | "panel"
  | "chain"
  | "timing";

// Plurality and approval use exactly the types 0x0001 to 0x0009. Fixed here,
// not derived from RECORD_TYPES, so registering a new type can't change which
// version-1 definitions are well formed.
const REQUIRED_TYPES: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);

function strictlyAscending(xs: readonly number[]): boolean {
  for (let i = 1; i < xs.length; i++) if ((xs[i - 1] as number) >= (xs[i] as number)) return false;
  return true;
}

const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const pairwiseDistinct = (xs: readonly Uint8Array[]) =>
  xs.every((a, i) => xs.slice(i + 1).every((b) => !sameBytes(a, b)));

/**
 * The first well-formedness rule a decoded definition breaks, or `undefined`
 * if it is well formed. A failure fails the election ([[verifier]] 2.x); it
 * never makes the bytes undecodable. Whether the verifier supports each pinned
 * version, and everything checked against the chain or the board, is outside
 * these rules.
 */
export function electionDefinitionRule(d: ElectionDefinition): ElectionDefinitionRule | undefined {
  return headRule(d) ?? electorateV1Rule(d) ?? tailRule(d);
}

/** The well-formedness rule codes of version 3, in checking order: version 1's, with `cells` after `electorate`. */
export type ElectionDefinitionV3Rule = ElectionDefinitionRule | "cells";

/**
 * Version 3's `electionDefinitionRule`: version 1's rules, with `electorate`
 * read for regional cells and `cells` after it (docs/spec/election-definition.md,
 * Well-formedness). `cells` checks the stated cells against the fold of the
 * stated region counts, so the floor on every split tier follows from the
 * counts, which the verifier checks against the board (2.4; T-16, T-34).
 */
export function electionDefinitionV3Rule(
  d: ElectionDefinitionV3,
): ElectionDefinitionV3Rule | undefined {
  return headRule(d) ?? electorateV3Rule(d) ?? cellsRule(d) ?? tailRule(d);
}

/** The well-formedness rule codes of version 4, in checking order: version 3's, then `receipt-keys`. */
export type ElectionDefinitionV4Rule = ElectionDefinitionV3Rule | "receipt-keys";

/**
 * Version 4's `electionDefinitionRule`: version 3's rules, then
 * `receipt-keys`, a non-empty list in strictly ascending byte order, so no
 * key is listed twice. Whether each key judges the election is
 * `receiptKeyJudgement`'s, against L1 ([[verifier]] 2.9; T-26).
 */
export function electionDefinitionV4Rule(
  d: ElectionDefinitionV4,
): ElectionDefinitionV4Rule | undefined {
  return electionDefinitionV3Rule(d) ?? receiptKeysRule(d);
}

function receiptKeysRule(
  d: Pick<ElectionDefinitionV4, "receipt_keys">,
): "receipt-keys" | undefined {
  const keys = d.receipt_keys;
  if (keys.length === 0) return "receipt-keys";
  for (let i = 1; i < keys.length; i++)
    if (compareBytes(keys[i - 1] as Uint8Array, keys[i] as Uint8Array) >= 0) return "receipt-keys";
  return undefined;
}

/**
 * The well-formedness rule codes of version 5, in checking order: version
 * 4's, with `questions` before `option-count`, and `option-count` and
 * `selections` read per question.
 */
export type ElectionDefinitionV5Rule = ElectionDefinitionV4Rule | "questions";

/**
 * The first rule a version-5 definition breaks: its code and, for
 * `option-count` and `selections`, the first failing question, which
 * [[verifier]] 2.1 reports as `at` `{"question": q}`.
 */
export type ElectionDefinitionV5Failure =
  | { readonly rule: "option-count" | "selections"; readonly question: number }
  | { readonly rule: Exclude<ElectionDefinitionV5Rule, "option-count" | "selections"> };

/**
 * Version 5's `electionDefinitionRule` (docs/spec/election-definition.md,
 * Well-formedness): the profile rules, then `questions` (non-empty),
 * `option-count` (walking the questions, every `m_q ≥ 2` and the running
 * total within `MAX_OPTIONS`, so the poll's whole option vector fits every
 * per-option bound) and `selections` (each question's range answerable and
 * not forbidding every answer), each naming the first failing question, then
 * version 4's rules from `electorate` on. A question no ballot can answer
 * would let an election register that no one can vote in (T-28, T-34).
 */
export function electionDefinitionV5Rule(
  d: ElectionDefinitionV5,
): ElectionDefinitionV5Failure | undefined {
  const profileFailure = profileRule(d);
  if (profileFailure !== undefined) return { rule: profileFailure };
  const questionsFailure = questionsRule(d.questions);
  if (questionsFailure !== undefined) return questionsFailure;
  const rule = electorateV3Rule(d) ?? cellsRule(d) ?? tailRule(d) ?? receiptKeysRule(d);
  return rule === undefined ? undefined : { rule };
}

/**
 * The well-formedness rule codes of version 6, in checking order: version
 * 5's, then `results`, `civic-sealed` and `author-panel`.
 */
export type ElectionDefinitionV6Rule =
  | ElectionDefinitionV5Rule
  | "results"
  | "civic-sealed"
  | "author-panel";

/** The first rule a version-6 definition breaks, as `ElectionDefinitionV5Failure`. */
export type ElectionDefinitionV6Failure =
  | ElectionDefinitionV5Failure
  | { readonly rule: "results" | "civic-sealed" | "author-panel" };

/**
 * Version 6's `electionDefinitionRule` (docs/spec/election-definition.md,
 * Well-formedness): version 5's rules, then `results` (a sealed poll carries
 * no schedule or batch, and a live one has both, its batch at least
 * `MIN_LIVE_BATCH`, so running totals are never released in batches small
 * enough to be unanimous; T-16, T-17), `civic-sealed` (a civic referendum is
 * sealed) and `author-panel` (no author panel at all, or a valid one under
 * trustee-identity rules 1 to 3 with a non-zero transcript hash; T-14,
 * T-17, T-37). That no author key is a default seat's is [[verifier]] 2.5's.
 */
export function electionDefinitionV6Rule(
  d: ElectionDefinitionV6,
): ElectionDefinitionV6Failure | undefined {
  const v5 = electionDefinitionV5Rule(d);
  if (v5 !== undefined) return v5;
  const rule = resultsRule(d) ?? civicSealedRule(d) ?? authorPanelDefinitionRule(d);
  return rule === undefined ? undefined : { rule };
}

function resultsRule(
  d: Pick<ElectionDefinitionV6, "results_mode" | "live_every" | "live_batch">,
): "results" | undefined {
  if (d.results_mode === RESULTS_MODES.sealed)
    return d.live_every === 0 && d.live_batch === 0 ? undefined : "results";
  return d.live_every >= 1 && d.live_batch >= DEFINITION_V6_LIMITS.minLiveBatch
    ? undefined
    : "results";
}

function civicSealedRule(
  d: Pick<ElectionDefinitionV6, "poll_class" | "results_mode">,
): "civic-sealed" | undefined {
  return d.poll_class === POLL_CLASSES.civicReferendum && d.results_mode !== RESULTS_MODES.sealed
    ? "civic-sealed"
    : undefined;
}

function authorPanelDefinitionRule(
  d: Pick<ElectionDefinitionV6, "author_threshold" | "author_keys" | "author_transcript_hash">,
): "author-panel" | undefined {
  const transcript = d.author_transcript_hash;
  if (d.author_keys.length === 0)
    // No author panel is all three empty: a threshold or transcript hash
    // with no keys would be chosen bytes (T-17).
    return d.author_threshold === 0 && isZero(transcript) ? undefined : "author-panel";
  // A zero transcript hash with a panel would make `author_stub_hash` and
  // `stub_hash` the same bytes, so one stub hash could stand for both
  // panels' stubs (T-37).
  if (isZero(transcript)) return "author-panel";
  return authorPanelRule({ threshold: d.author_threshold, keys: d.author_keys }) === undefined
    ? undefined
    : "author-panel";
}

function questionsRule(questions: readonly Question[]): ElectionDefinitionV5Failure | undefined {
  if (questions.length === 0) return { rule: "questions" };
  // Every question's count before any question's limits: `selections`
  // compares against `m_q`, so it is read only once every `m_q` is in range.
  let total = 0;
  for (const [q, { option_count: m }] of questions.entries()) {
    total += m;
    if (m < 2 || total > DEFINITION_V5_LIMITS.maxOptions)
      return { rule: "option-count", question: q };
  }
  for (const [q, x] of questions.entries())
    if (
      x.min_selections > x.max_selections ||
      x.max_selections > x.option_count ||
      x.max_selections < 1
    )
      return { rule: "selections", question: q };
  return undefined;
}

/**
 * The flat index of each question's first option under version 5
 * (docs/spec/election-definition.md, Questions): `o_q = m_0 + … + m_{q−1}`,
 * and `total`, the poll's `T`. The ballot, shares, openings and tally work
 * over the `T` options in this order; results and display text name an
 * option by (question, option).
 */
export function questionOffsets(questions: readonly Pick<Question, "option_count">[]): {
  readonly offsets: readonly number[];
  readonly total: number;
} {
  const offsets: number[] = [];
  let total = 0;
  for (const q of questions) {
    offsets.push(total);
    total += q.option_count;
  }
  return { offsets, total };
}

/** The flat index of option `option` of question `question`; throws outside the definition. */
export function flatOptionIndex(
  questions: readonly Pick<Question, "option_count">[],
  question: number,
  option: number,
): number {
  const m = questions[question]?.option_count;
  if (!Number.isInteger(question) || m === undefined)
    throw new RangeError("question outside the definition");
  if (!Number.isInteger(option) || option < 0 || option >= m)
    throw new RangeError("option outside the question");
  return (questionOffsets(questions).offsets[question] as number) + option;
}

/** The (question, option) a flat index names; throws for an index at or past `T`. */
export function questionOption(
  questions: readonly Pick<Question, "option_count">[],
  flat: number,
): { readonly question: number; readonly option: number } {
  if (!Number.isInteger(flat) || flat < 0) throw new RangeError("flat index outside the poll");
  let first = 0;
  for (const [q, { option_count: m }] of questions.entries()) {
    if (flat < first + m) return { question: q, option: flat - first };
    first += m;
  }
  throw new RangeError("flat index outside the poll");
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  return a.length - b.length;
}

/**
 * One key's word in the anchor's receipt-key record (docs/spec/contracts.md,
 * Board anchor, Receipt keys), read from L1 state at a finalized block: the
 * L1 timestamps of its registration and retirement, 0 for none.
 */
export interface ReceiptKeyRecord {
  readonly registeredAt: bigint;
  readonly retiredAt: bigint;
}

/** What a listed key's record says about one election ([[verifier]] 2.9). */
export type ReceiptKeyJudgement = "judges" | "unregistered" | "retired" | "unsettled";

/**
 * Whether a listed key judges an election that opens at `opensAt`, from its
 * record at a finalized L1 block whose timestamp is `provenAt`
 * (docs/spec/election-definition.md, Receipt keys; [[verifier]] 2.9):
 *
 * - `judges`: registered before `opensAt` and not retired by then, read at a
 *   block at or after `opensAt`, so no later write can change it;
 * - `unregistered`: not registered before `opensAt`, read at such a block;
 * - `retired`: registered before `opensAt` and retired at or before it,
 *   final whenever it is read;
 * - `unsettled`: read at a block before `opensAt` and not yet retired, so a
 *   registration or a retirement may still come.
 *
 * Every value is a u64 timestamp. A record retired but not registered,
 * retired before it was registered, or written after `provenAt` can't be the
 * anchor's at that block, so it throws: the caller read the wrong word.
 */
export function receiptKeyJudgement(
  record: ReceiptKeyRecord,
  opensAt: bigint,
  provenAt: bigint,
): ReceiptKeyJudgement {
  const { registeredAt, retiredAt } = record;
  for (const v of [registeredAt, retiredAt, opensAt, provenAt])
    if (typeof v !== "bigint" || v < 0n || v >= 1n << 64n)
      throw new RangeError("receipt-key times must be u64 bigints");
  if (
    registeredAt > provenAt ||
    retiredAt > provenAt ||
    (retiredAt !== 0n && (registeredAt === 0n || retiredAt < registeredAt))
  )
    throw new RangeError("not a receipt-key record the anchor can hold at that block");
  // Any write after opensAt has a later timestamp and changes nothing for
  // this election, so a block at or after opensAt settles every key; before
  // it, only a retirement is already final (T-26, T-69).
  const registeredBefore = registeredAt !== 0n && registeredAt < opensAt;
  if (registeredBefore && retiredAt !== 0n && retiredAt <= opensAt) return "retired";
  if (provenAt < opensAt) return "unsettled";
  return registeredBefore ? "judges" : "unregistered";
}

const U64_MASK = (1n << 64n) - 1n;

/**
 * The record a key's 32-byte word in the anchor's receipt-key record holds
 * (docs/spec/contracts.md, Board anchor, Receipt keys: `registered_at` in its
 * low 64 bits, `retired_at` in the next 64), proven at an L1 block whose
 * timestamp is `provenAt`; undefined for a word the release code can't write
 * there: a high bit set, a retirement without a registration or before it,
 * or a time after the block (the anchor writes `block.timestamp`). The
 * verifier fails the election on such a word (2.9, `receipt-key-record`) and
 * the ballot client refuses to cast (T-26).
 */
export function receiptKeyRecordFromWord(
  word: Uint8Array,
  provenAt: bigint,
): ReceiptKeyRecord | undefined {
  if (word.length !== 32) throw new RangeError("a storage word is 32 bytes");
  if (typeof provenAt !== "bigint" || provenAt < 0n || provenAt > U64_MASK)
    throw new RangeError("provenAt must be a u64 bigint");
  let w = 0n;
  for (const x of word) w = (w << 8n) | BigInt(x);
  const registeredAt = w & U64_MASK;
  const retiredAt = (w >> 64n) & U64_MASK;
  if (w >> 128n !== 0n) return undefined;
  if (retiredAt !== 0n && (registeredAt === 0n || registeredAt > retiredAt)) return undefined;
  if (registeredAt > provenAt || retiredAt > provenAt) return undefined;
  return { registeredAt, retiredAt };
}

/** The ballot client's check of a definition's listed receipt keys before casting. */
export type ReceiptKeysCastCheck =
  | { readonly castable: true }
  | { readonly castable: false; readonly code: "receipt-key-unjudged"; readonly key: number };

/**
 * Whether the ballot client may cast in a version-4 election that opens at
 * `opensAt`, from the receipt-key record's words of every key the definition
 * lists, in list order, proven at the latest finalized L1 block the client
 * knows, whose timestamp is `provenAt` (docs/spec/election-definition.md,
 * Receipt keys). Each key must be registered before `opensAt` and not
 * retired by then: a key that `receiptKeyJudgement` calls `judges`, or, read
 * before `opensAt`, `unsettled` but already registered. Otherwise, or for a
 * word the release code can't write, the client refuses at the first such
 * key (`receipt-key-unjudged`), so it never casts for a receipt no listed key
 * may give as evidence (T-26, T-69).
 *
 * Read before `opensAt`, a retirement between that block and `opensAt` can't
 * be seen yet; it fails the election ([[verifier]] 2.9), which the client's
 * later checks report as `board-failed`. A definition lists at least one key
 * (`receipt-keys`), so an empty list throws.
 */
export function receiptKeysCastCheck(
  words: readonly Uint8Array[],
  opensAt: bigint,
  provenAt: bigint,
): ReceiptKeysCastCheck {
  if (words.length === 0) throw new RangeError("a version-4 definition lists receipt keys");
  if (typeof opensAt !== "bigint" || opensAt < 0n || opensAt > U64_MASK)
    throw new RangeError("opensAt must be a u64 bigint");
  for (const [i, word] of words.entries()) {
    const r = receiptKeyRecordFromWord(word, provenAt);
    const judgement = r === undefined ? undefined : receiptKeyJudgement(r, opensAt, provenAt);
    const registered =
      judgement === "judges" || (judgement === "unsettled" && r?.registeredAt !== 0n);
    if (!registered) return { castable: false, code: "receipt-key-unjudged", key: i };
  }
  return { castable: true };
}

type Head = Pick<
  ElectionDefinition,
  "profile" | "election_type" | "option_count" | "min_selections" | "max_selections"
>;

// The same in every version: version 5's selection questions use the same
// record types as plurality and approval.
function profileRule(
  d: Pick<ElectionDefinition, "profile">,
): "protocol-major" | "profile-order" | "profile-types" | "profile-version" | undefined {
  const pinnedTypes = d.profile.pins.map((p) => p.record_type);
  if (d.profile.protocol_major !== 1) return "protocol-major";
  if (!strictlyAscending(pinnedTypes)) return "profile-order";
  if (
    pinnedTypes.length !== REQUIRED_TYPES.length ||
    !pinnedTypes.every((t, i) => t === REQUIRED_TYPES[i])
  )
    return "profile-types";
  if (d.profile.pins.some((p) => p.version < 1)) return "profile-version";
  return undefined;
}

function headRule(d: Head): ElectionDefinitionRule | undefined {
  const profileFailure = profileRule(d);
  if (profileFailure !== undefined) return profileFailure;
  if (d.option_count < 2 || d.option_count > DEFINITION_V1_LIMITS.maxOptions) return "option-count";
  if (
    d.min_selections > d.max_selections ||
    d.max_selections > d.option_count ||
    d.max_selections < 1 ||
    // A blank plurality ballot is valid (0003-tally-scheme), so plurality is
    // exactly the range [0, 1].
    (d.election_type === ELECTION_TYPES.plurality &&
      (d.min_selections !== 0 || d.max_selections !== 1))
  )
    return "selections";
  return undefined;
}

function electorateV1Rule(d: ElectionDefinition): ElectionDefinitionRule | undefined {
  // Ascending tiers make the tiers-only partition one cell per tier, none
  // repeated (verifier 2.8; T-29, T-36). Distinct roots keep two cells from
  // sharing one membership proof, which would let a voter's claimed tier pick
  // the cell, merging them (T-01, T-16).
  const tiers = d.electorate.map((g) => g.tier);
  const groupIds = new Set(d.electorate.map((g) => g.group_id));
  const roots = new Set(d.electorate.map((g) => g.root));
  if (
    tiers.length === 0 ||
    !strictlyAscending(tiers) ||
    groupIds.size !== tiers.length ||
    roots.size !== tiers.length ||
    d.electorate.some((g) => g.group_size < 1n)
  )
    return "electorate";
  return undefined;
}

function electorateV3Rule(d: Pick<ElectionDefinitionV3, "electorate">): "electorate" | undefined {
  const tiers = d.electorate.map((t) => t.tier);
  if (tiers.length === 0 || !strictlyAscending(tiers)) return "electorate";
  const seen = new Set<bigint>();
  for (const t of d.electorate) {
    if (t.groups.length === 0 || t.regions.length === 0) return "electorate";
    // Ascending group IDs put each group in one region; distinct across tiers
    // puts it in one tier, so no member is counted in two cells (T-01, G-2).
    for (const [i, g] of t.groups.entries()) {
      if (i > 0 && (t.groups[i - 1] as (typeof t.groups)[number]).group_id >= g.group_id)
        return "electorate";
      if (seen.has(g.group_id)) return "electorate";
      seen.add(g.group_id);
    }
    const named = new Set(t.groups.map((g) => g.region));
    if (t.groups.some((g) => g.region >= t.regions.length) || named.size !== t.regions.length)
      return "electorate";
    if (t.regions.some((n) => n < 1n)) return "electorate";
  }
  return undefined;
}

function cellsRule(d: Pick<ElectionDefinitionV3, "electorate">): "cells" | undefined {
  let total = 0;
  const roots = new Set<bigint>();
  for (const t of d.electorate) {
    const derived = foldRegions(t.regions);
    if (derived.length !== t.cells.length) return "cells";
    for (const [i, regions] of derived.entries()) {
      const stated = t.cells[i] as (typeof t.cells)[number];
      // Over unbounded integers: a sum above u64 never equals a stated count.
      const sum = regions.reduce((n, r) => n + (t.regions[r] as bigint), 0n);
      if (stated.members !== sum) return "cells";
      roots.add(stated.root);
    }
    total += t.cells.length;
  }
  // Distinct roots keep one membership proof from fitting two cells (T-01,
  // T-16); 256 cells is the range of the tally opening's u8 `cell`.
  if (roots.size !== total || total > DEFINITION_V3_LIMITS.cells) return "cells";
  return undefined;
}

type Tail = Pick<
  ElectionDefinition,
  | "threshold"
  | "panel_size"
  | "election_registry"
  | "board"
  | "trustee_registry"
  | "group_registry"
  | "l1_anchor"
  | "l1_relay"
  | "l2_chain_id"
  | "l1_chain_id"
  | "opens_at"
  | "closes_at"
  | "l1_inclusion_bound"
>;

function tailRule(d: Tail): "panel" | "chain" | "timing" | undefined {
  // At least two trustees must combine shares: a 1-of-n panel lets one party
  // open every voter's sharing alone, which the brief forbids (T-14).
  if (
    d.threshold < 2 ||
    d.threshold > d.panel_size ||
    d.panel_size > DEFINITION_V1_LIMITS.maxTrustees
  )
    return "panel";
  const l2 = [d.election_registry, d.board, d.trustee_registry, d.group_registry];
  const l1 = [d.l1_anchor, d.l1_relay];
  if (
    d.l2_chain_id === 0n ||
    d.l1_chain_id === 0n ||
    d.l2_chain_id === d.l1_chain_id ||
    [...l2, ...l1].some(isZero) ||
    !pairwiseDistinct(l2) ||
    !pairwiseDistinct(l1)
  )
    return "chain";
  // The close rule's deadline is closes_at + δ; it must not overflow a u64.
  if (d.opens_at >= d.closes_at || d.closes_at + BigInt(d.l1_inclusion_bound) >= 1n << 64n)
    return "timing";
  return undefined;
}
