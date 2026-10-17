// Board data availability (docs/spec/availability.md): the trustee seats'
// availability attestations (record type 0x001b) and fetch complaints
// (0x001c), their windows, and the availability check (verifier 4.6) over
// the records the board contract emitted. The check reads L1 and the L2's
// events alone, never the board copy, so a withheld extent fails the election
// `unavailable` instead of leaving it unverifiable for good, and only a
// panel's threshold of seats attesting falsely, a coalition that can already
// open ballots, gets past it (T-24, T-25, T-53, T-54).

import { SEAT_PANELS, type SeatPanel } from "./ballot.ts";
import {
  bytesFixed,
  type Codec,
  DecodeError,
  type DecodeErrorCode,
  EncodeError,
  enum8,
  u8,
  u16,
  u32,
  Writer,
} from "./codec.ts";
import { intakeCutoff } from "./delivery.ts";
import { PARAMETERS } from "./parameters.ts";
import { RECORD_TYPES, RecordSchema, recordType } from "./record.ts";
import { p256Sig, signStatement, verifyStatement } from "./trustee.ts";

const ATTESTATION_TAG = "abolish/v1/sig/availability-attestation";
const COMPLAINT_TAG = "abolish/v1/sig/fetch-complaint";

/** The two points a seat attests: the ballot extent (through `C_A`) and the counted extent (through `C_S`). */
export const AVAILABILITY_POINTS = Object.freeze({ ballotExtent: 1, countedExtent: 2 } as const);

export type AvailabilityPoint = (typeof AVAILABILITY_POINTS)[keyof typeof AVAILABILITY_POINTS];

/**
 * `2 · MAX_TRUSTEES`: the most obligation roots a counted-extent attestation
 * names, since only ballot versions 1 to 3 fix a root, with no author panel,
 * and the contract takes one root of each kind per seat.
 */
export const MAX_ATTESTED_ROOTS = 2 * PARAMETERS.MAX_TRUSTEES;

/** `A'`, `COUNTED_FETCH_ALLOWANCE`: seconds after `t_S` by which a seat attests the counted extent. */
export const COUNTED_FETCH_ALLOWANCE = BigInt(PARAMETERS.COUNTED_FETCH_ALLOWANCE);

/** What a seat states in its attestation. */
export interface AvailabilityAttestationFields {
  readonly definition_hash: Uint8Array;
  readonly panel: SeatPanel;
  readonly seat: number;
  readonly point: AvailabilityPoint;
  /** `checkpoint_hash` of the extent's checkpoint, `C_A` or `C_S`. */
  readonly checkpoint_hash: Uint8Array;
  /** At the counted extent, the record hashes of the obligation roots it holds, strictly ascending; none at the ballot extent. */
  readonly roots: readonly Uint8Array[];
}

/** Availability attestation (`0x001b`, version 1). */
export interface AvailabilityAttestation extends AvailabilityAttestationFields {
  readonly signature: Uint8Array;
}

/** What a seat states in its fetch complaint. */
export interface FetchComplaintFields {
  readonly definition_hash: Uint8Array;
  readonly panel: SeatPanel;
  readonly seat: number;
  readonly point: AvailabilityPoint;
  /** `checkpoint_hash` of the extent's checkpoint as the seat read it from L1. */
  readonly checkpoint_hash: Uint8Array;
  /** The binary CID of the first segment object of the extent it couldn't read. */
  readonly cid: Uint8Array;
}

/** Fetch complaint (`0x001c`, version 1). */
export interface FetchComplaint extends FetchComplaintFields {
  readonly signature: Uint8Array;
}

const hash32 = bytesFixed(32);
const cid36 = bytesFixed(36);
const panelCodec = enum8<SeatPanel>([SEAT_PANELS.default, SEAT_PANELS.author]);
const pointCodec = enum8<AvailabilityPoint>([
  AVAILABILITY_POINTS.ballotExtent,
  AVAILABILITY_POINTS.countedExtent,
]);

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length && i < b.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && compareBytes(a, b) === 0;

// A segment object's CID is a raw block's or a dag-pb root's, sha2-256 of 32
// bytes (content-addressing.md): any other prefix names no segment object, so
// a complaint can't carry it.
const CID_PREFIXES: readonly (readonly number[])[] = [
  [0x01, 0x55, 0x12, 0x20],
  [0x01, 0x70, 0x12, 0x20],
];
const isSegmentCid = (cid: Uint8Array) => CID_PREFIXES.some((p) => p.every((b, i) => cid[i] === b));

const commonFields = [
  ["definition_hash", hash32],
  ["panel", panelCodec],
  ["seat", u8],
  ["point", pointCodec],
  ["checkpoint_hash", hash32],
] as const;

// `list<bytes[32], 32>`, strictly ascending, and empty at the ballot extent,
// whose extent ends before any root is due: one encoding per set of roots
// (T-31). The point is read first, so the count is judged against it.
function writeAttestationBody(w: Writer, value: AvailabilityAttestationFields): void {
  for (const [name, codec] of commonFields)
    (codec as Codec<unknown>).write(w, value[name as keyof AvailabilityAttestationFields]);
  const { roots, point } = value;
  if (!Array.isArray(roots)) throw new EncodeError("attestation: roots must be an array");
  const n = roots.length;
  if (n > MAX_ATTESTED_ROOTS)
    throw new EncodeError(`attestation: at most ${MAX_ATTESTED_ROOTS} roots`);
  if (point === AVAILABILITY_POINTS.ballotExtent && n !== 0)
    throw new EncodeError("attestation: the ballot extent names no roots");
  w.uint(4, n);
  for (let i = 0; i < n; i++) {
    const h = roots[i] as Uint8Array;
    if (i > 0 && compareBytes(h, roots[i - 1] as Uint8Array) <= 0)
      throw new EncodeError("attestation: roots must be strictly ascending");
    hash32.write(w, h);
  }
}

const attestationV1: Codec<AvailabilityAttestation> = {
  minLength: 32 + 1 + 1 + 1 + 32 + 4 + 64,
  write(w, value) {
    writeAttestationBody(w, value);
    p256Sig.write(w, value.signature);
  },
  read(r) {
    const definition_hash = hash32.read(r);
    const panel = panelCodec.read(r);
    const seat = u8.read(r);
    const point = pointCodec.read(r);
    const checkpoint_hash = hash32.read(r);
    const at = r.offset;
    const count = u32.read(r);
    if (count > MAX_ATTESTED_ROOTS) throw new DecodeError("length-over-max", at);
    if (point === AVAILABILITY_POINTS.ballotExtent && count !== 0)
      throw new DecodeError("non-canonical", at);
    const roots: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const hAt = r.offset;
      const h = hash32.read(r);
      const last = roots[roots.length - 1];
      if (last !== undefined && compareBytes(h, last) <= 0)
        throw new DecodeError("non-canonical", hAt);
      roots.push(h);
    }
    return {
      definition_hash,
      panel,
      seat,
      point,
      checkpoint_hash,
      roots,
      signature: p256Sig.read(r),
    };
  },
};

function writeComplaintBody(w: Writer, value: FetchComplaintFields): void {
  for (const [name, codec] of commonFields)
    (codec as Codec<unknown>).write(w, value[name as keyof FetchComplaintFields]);
  cid36.write(w, value.cid);
  if (!isSegmentCid(value.cid))
    throw new EncodeError("fetch complaint: cid isn't a raw or dag-pb sha2-256 CID");
}

const complaintV1: Codec<FetchComplaint> = {
  minLength: 32 + 1 + 1 + 1 + 32 + 36 + 64,
  write(w, value) {
    writeComplaintBody(w, value);
    p256Sig.write(w, value.signature);
  },
  read(r) {
    const definition_hash = hash32.read(r);
    const panel = panelCodec.read(r);
    const seat = u8.read(r);
    const point = pointCodec.read(r);
    const checkpoint_hash = hash32.read(r);
    const at = r.offset;
    const cid = cid36.read(r);
    if (!isSegmentCid(cid)) throw new DecodeError("non-canonical", at);
    return {
      definition_hash,
      panel,
      seat,
      point,
      checkpoint_hash,
      cid,
      signature: p256Sig.read(r),
    };
  },
};

/**
 * Record type `0x001b`. No profile pins it: the contract-event version whose
 * tables carry the board contract's availability call fixes it, and none does
 * yet. It counts only through the contract path.
 */
export const AVAILABILITY_ATTESTATION = recordType(RECORD_TYPES.availabilityAttestation, {
  1: attestationV1,
});

/** Record type `0x001c`, fixed and carried as the attestation is. */
export const FETCH_COMPLAINT = recordType(RECORD_TYPES.fetchComplaint, { 1: complaintV1 });

const SCHEMA = new RecordSchema([AVAILABILITY_ATTESTATION, FETCH_COMPLAINT]);

export function encodeAvailabilityAttestation(record: AvailabilityAttestation): Uint8Array {
  return SCHEMA.encode(AVAILABILITY_ATTESTATION, 1, record);
}

/** Strictly decodes an availability attestation under version 1. */
export function decodeAvailabilityAttestation(
  bytes: Uint8Array,
  pinned: 1,
): AvailabilityAttestation {
  return SCHEMA.decode(AVAILABILITY_ATTESTATION, bytes, pinned).value;
}

export function encodeFetchComplaint(record: FetchComplaint): Uint8Array {
  return SCHEMA.encode(FETCH_COMPLAINT, 1, record);
}

/** Strictly decodes a fetch complaint under version 1. */
export function decodeFetchComplaint(bytes: Uint8Array, pinned: 1): FetchComplaint {
  return SCHEMA.decode(FETCH_COMPLAINT, bytes, pinned).value;
}

/**
 * `u16(0x001b) ‖ u8(1) ‖ definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u8(point)
 * ‖ checkpoint_hash ‖ u32(r) ‖ roots`: the record without its signature,
 * header included, so a later version can't reuse a version 1 signature (T-31).
 */
export function availabilityAttestationMessage(fields: AvailabilityAttestationFields): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.availabilityAttestation);
  u8.write(w, 1);
  writeAttestationBody(w, fields);
  return w.finish();
}

/** `u16(0x001c) ‖ u8(1) ‖ definition_hash ‖ u8(panel) ‖ u8(seat) ‖ u8(point) ‖ checkpoint_hash ‖ cid`. */
export function fetchComplaintMessage(fields: FetchComplaintFields): Uint8Array {
  const w = new Writer();
  u16.write(w, RECORD_TYPES.fetchComplaint);
  u8.write(w, 1);
  writeComplaintBody(w, fields);
  return w.finish();
}

const copyFields = <T extends AvailabilityAttestationFields | FetchComplaintFields>(f: T) => ({
  definition_hash: Uint8Array.from(f.definition_hash),
  panel: f.panel,
  seat: f.seat,
  point: f.point,
  checkpoint_hash: Uint8Array.from(f.checkpoint_hash),
});

/**
 * Signs a seat's attestation with its per-election signing key. A node signs
 * only once its own copy, read by the anchored CIDs, reaches the extent's
 * checkpoint and matches every counted checkpoint through it, and names only
 * roots whose leaf objects it holds and has checked (docs/spec/availability.md,
 * What a seat does).
 */
export function signAvailabilityAttestation(
  signingSecret: Uint8Array,
  fields: AvailabilityAttestationFields,
): AvailabilityAttestation {
  const roots = fields.roots.map((h) => Uint8Array.from(h));
  const copy = { ...copyFields(fields), roots };
  return {
    ...copy,
    signature: signStatement(signingSecret, ATTESTATION_TAG, availabilityAttestationMessage(copy)),
  };
}

/** Signs a seat's fetch complaint with its per-election signing key. */
export function signFetchComplaint(
  signingSecret: Uint8Array,
  fields: FetchComplaintFields,
): FetchComplaint {
  const copy = { ...copyFields(fields), cid: Uint8Array.from(fields.cid) };
  return {
    ...copy,
    signature: signStatement(signingSecret, COMPLAINT_TAG, fetchComplaintMessage(copy)),
  };
}

/** The moments of docs/spec/availability.md, Windows, in seconds. */
export interface AvailabilityWindows {
  /** `c_I = t_D − F − R`: a seat sends its ballot-extent record by then. */
  readonly ballotCutoff: bigint;
  /** `t_A = c_I + F`: a ballot-extent record counts if submitted by then. */
  readonly ballotDeadline: bigint;
  /** `c_A' = t_S + A'`: a seat sends its counted-extent record by then. */
  readonly countedCutoff: bigint;
  /** `t_A' = t_S + A' + F`: a counted-extent record counts if submitted by then. */
  readonly countedDeadline: bigint;
  /** `t_A' + R`: no summed share over the counted set is sent before it. */
  readonly summing: bigint;
}

/**
 * The windows from the definition's `closes_at` and `l1_inclusion_bound`,
 * `t_S` (when the counted extent's checkpoint is due) and the release's `F`
 * and `R`, so every seat and verifier computes the same ones.
 */
export function availabilityWindows(
  closesAt: bigint,
  l1InclusionBound: bigint,
  countedDue: bigint,
  constants: { readonly forcedInclusion: bigint; readonly margin: bigint },
): AvailabilityWindows {
  if (typeof countedDue !== "bigint" || countedDue < 0n)
    throw new RangeError("availabilityWindows: countedDue must be a bigint ≥ 0");
  const ballotCutoff = intakeCutoff(closesAt, l1InclusionBound, constants);
  const countedCutoff = countedDue + COUNTED_FETCH_ALLOWANCE;
  const countedDeadline = countedCutoff + constants.forcedInclusion;
  return {
    ballotCutoff,
    ballotDeadline: ballotCutoff + constants.forcedInclusion,
    countedCutoff,
    countedDeadline,
    summing: countedDeadline + constants.margin,
  };
}

/** A panel as the check reads it: its threshold and its key set from the L2's registration events. */
export interface AvailabilityPanel {
  readonly panel: SeatPanel;
  /** `k_P`. */
  readonly threshold: number;
  /** Each qualified seat and its per-election signing key; empty for an author panel the board contract has no key set for. */
  readonly registered: readonly { readonly index: number; readonly signingKey: Uint8Array }[];
}

/** What the check runs against, all from L1 and the L2's events. */
export interface AvailabilityElection {
  readonly definitionHash: Uint8Array;
  /** The default panel, then the author panel if the election has one. */
  readonly panels: readonly AvailabilityPanel[];
  /** `checkpoint_hash` of `C_A` and of `C_S`, or `null` where no counted checkpoint is at or before `s_A` or `s_S`. */
  readonly checkpoints: { readonly ballot: Uint8Array | null; readonly counted: Uint8Array | null };
  /** `t_A` and `t_A'`. */
  readonly deadlines: { readonly ballot: bigint; readonly counted: bigint };
}

/** One record the board contract emitted, in its event order, with its submission time. */
export interface AvailabilityEvent {
  readonly payload: Uint8Array;
  readonly submittedAt: bigint;
}

export type AvailabilityRecordCode =
  | "availability-stray"
  | "availability-seat"
  | "availability-signature"
  | "availability-repeat"
  | "availability-late"
  | "availability-checkpoint";

export type AvailabilityRecordKind = "attestation" | "complaint";

export type AvailabilityRecordReport =
  | {
      readonly at: number;
      readonly kind: AvailabilityRecordKind;
      readonly code: "availability-stray";
      /** The seat this election's keys attribute it to, in the panel it names, or `null`. */
      readonly signer: number | null;
    }
  | {
      readonly at: number;
      readonly kind: AvailabilityRecordKind;
      readonly code: "availability-seat" | "availability-signature";
    }
  | {
      readonly at: number;
      readonly kind: AvailabilityRecordKind;
      readonly code:
        | "valid"
        | "availability-repeat"
        | "availability-late"
        | "availability-checkpoint";
      readonly panel: SeatPanel;
      readonly seat: number;
      readonly point: AvailabilityPoint;
    };

export interface PanelAvailability {
  readonly panel: SeatPanel;
  /** At least `k_P` seats attested. */
  readonly holds: boolean;
  /** The seats whose attestation of the point counts, ascending, each with the roots it names. */
  readonly attested: readonly { readonly seat: number; readonly roots: readonly Uint8Array[] }[];
  /** Seats that didn't attest but sent a valid complaint, ascending, each with its CID. */
  readonly complained: readonly { readonly seat: number; readonly cid: Uint8Array }[];
  /** Seats with neither. */
  readonly silent: readonly number[];
}

export interface PointAvailability {
  readonly point: AvailabilityPoint;
  readonly checkpoint: Uint8Array | null;
  readonly panels: readonly PanelAvailability[];
}

export interface AvailabilityReport {
  /** `unavailable` if some panel doesn't hold some point (verifier 4.6). */
  readonly verdict: "available" | "unavailable";
  /** The points and panels that failed, in the check's order. */
  readonly failures: readonly { readonly point: AvailabilityPoint; readonly panel: SeatPanel }[];
  readonly points: readonly PointAvailability[];
  /** Every record that decodes, in event order, with its code. */
  readonly records: readonly AvailabilityRecordReport[];
  /** Records that don't decode: rejected entries (8.3). */
  readonly rejected: readonly { readonly at: number; readonly error: DecodeErrorCode }[];
}

type Decoded =
  | { readonly kind: "attestation"; readonly record: AvailabilityAttestation }
  | { readonly kind: "complaint"; readonly record: FetchComplaint };

function decodeEvent(payload: Uint8Array): Decoded {
  // The type is read by the schema; only a complaint's number routes to its decoder.
  const isComplaint =
    payload.length >= 2 &&
    payload[0] === RECORD_TYPES.fetchComplaint >> 8 &&
    payload[1] === (RECORD_TYPES.fetchComplaint & 0xff);
  return isComplaint
    ? { kind: "complaint", record: decodeFetchComplaint(payload, 1) }
    : { kind: "attestation", record: decodeAvailabilityAttestation(payload, 1) };
}

function verifies(key: Uint8Array, d: Decoded): boolean {
  return d.kind === "attestation"
    ? verifyStatement(
        key,
        ATTESTATION_TAG,
        availabilityAttestationMessage(d.record),
        d.record.signature,
      )
    : verifyStatement(key, COMPLAINT_TAG, fetchComplaintMessage(d.record), d.record.signature);
}

function checkElection(election: AvailabilityElection): void {
  const name = "checkAvailability";
  const is32 = (b: unknown) => b instanceof Uint8Array && b.length === 32;
  if (!is32(election.definitionHash))
    throw new RangeError(`${name}: definitionHash must be 32 bytes`);
  const { panels, checkpoints, deadlines } = election;
  if (
    panels.length < 1 ||
    panels.length > 2 ||
    panels[0]?.panel !== SEAT_PANELS.default ||
    (panels.length === 2 && panels[1]?.panel !== SEAT_PANELS.author)
  )
    throw new RangeError(`${name}: the default panel, then the author panel if there is one`);
  for (const p of panels) {
    if (!Number.isInteger(p.threshold) || p.threshold < 1 || p.threshold > PARAMETERS.MAX_TRUSTEES)
      throw new RangeError(`${name}: a threshold is 1 to MAX_TRUSTEES`);
    const seen = new Set<number>();
    for (const k of p.registered) {
      if (
        !Number.isInteger(k.index) ||
        k.index < 1 ||
        k.index > PARAMETERS.MAX_TRUSTEES ||
        seen.has(k.index)
      )
        throw new RangeError(`${name}: registered seats are distinct, 1 to MAX_TRUSTEES`);
      seen.add(k.index);
    }
  }
  for (const c of [checkpoints.ballot, checkpoints.counted])
    if (c !== null && !is32(c))
      throw new RangeError(`${name}: a checkpoint hash is 32 bytes or null`);
  for (const t of [deadlines.ballot, deadlines.counted])
    if (typeof t !== "bigint" || t < 0n) throw new RangeError(`${name}: deadlines are bigints ≥ 0`);
}

/**
 * The availability check (docs/spec/availability.md, Availability check;
 * verifier 4.6) over the board contract's attestation and complaint events,
 * in its event order, replayed against its accumulator by the caller. Each
 * record is judged once, by the first code that applies; then each panel
 * holds a point when `k_P` of its seats' attestations of that point count.
 * It never reads the board copy, so a withheld board fails here, not
 * unverifiable (T-24, T-53). `at` is a position in `events`.
 */
export function checkAvailability(
  election: AvailabilityElection,
  events: readonly AvailabilityEvent[],
): AvailabilityReport {
  checkElection(election);
  const records: AvailabilityRecordReport[] = [];
  const rejected: { at: number; error: DecodeErrorCode }[] = [];
  // Per kind, panel, seat and point: whether a record has passed the
  // signature, so a later one is a repeat (the contract keeps only the first).
  const filled = new Set<string>();
  const attested = new Map<string, readonly Uint8Array[]>();
  const complained = new Map<string, Uint8Array>();
  let previous = 0n;
  events.forEach(({ payload, submittedAt }, at) => {
    // Events in the contract's order come from blocks in order, so their
    // timestamps never decrease; a list that does isn't one the accumulator
    // could have replayed.
    if (typeof submittedAt !== "bigint" || submittedAt < previous)
      throw new RangeError("checkAvailability: submission times are bigints that never decrease");
    previous = submittedAt;
    let d: Decoded;
    try {
      d = decodeEvent(payload);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      rejected.push({ at, error: e.code });
      return;
    }
    const { kind, record } = d;
    const panel = election.panels.find((p) => p.panel === record.panel);
    const key = panel?.registered.find((k) => k.index === record.seat)?.signingKey;
    const signedBySeat = key !== undefined && verifies(key, d);
    if (!sameBytes(record.definition_hash, election.definitionHash)) {
      records.push({
        at,
        kind,
        code: "availability-stray",
        signer: signedBySeat ? record.seat : null,
      });
      return;
    }
    if (key === undefined) {
      records.push({ at, kind, code: "availability-seat" });
      return;
    }
    if (!signedBySeat) {
      records.push({ at, kind, code: "availability-signature" });
      return;
    }
    const { point, seat } = record;
    const who = { panel: record.panel, seat, point };
    const slot = `${kind}:${record.panel}:${seat}:${point}`;
    const isBallot = point === AVAILABILITY_POINTS.ballotExtent;
    const checkpoint = isBallot ? election.checkpoints.ballot : election.checkpoints.counted;
    const deadline = isBallot ? election.deadlines.ballot : election.deadlines.counted;
    if (filled.has(slot)) {
      records.push({ at, kind, code: "availability-repeat", ...who });
      return;
    }
    filled.add(slot);
    if (submittedAt > deadline) {
      records.push({ at, kind, code: "availability-late", ...who });
      return;
    }
    if (checkpoint === null || !sameBytes(record.checkpoint_hash, checkpoint)) {
      records.push({ at, kind, code: "availability-checkpoint", ...who });
      return;
    }
    records.push({ at, kind, code: "valid", ...who });
    const seatKey = `${record.panel}:${seat}:${point}`;
    if (d.kind === "attestation") attested.set(seatKey, d.record.roots);
    else complained.set(seatKey, d.record.cid);
  });
  const failures: { point: AvailabilityPoint; panel: SeatPanel }[] = [];
  const points = (
    [AVAILABILITY_POINTS.ballotExtent, AVAILABILITY_POINTS.countedExtent] as const
  ).map((point): PointAvailability => ({
    point,
    checkpoint:
      point === AVAILABILITY_POINTS.ballotExtent
        ? election.checkpoints.ballot
        : election.checkpoints.counted,
    panels: election.panels.map((p): PanelAvailability => {
      const seats = p.registered.map((k) => k.index).sort((a, b) => a - b);
      const of = (seat: number) => `${p.panel}:${seat}:${point}`;
      const att = seats.flatMap((seat) => {
        const roots = attested.get(of(seat));
        return roots === undefined ? [] : [{ seat, roots }];
      });
      const com = seats.flatMap((seat) => {
        const cid = complained.get(of(seat));
        return cid === undefined || attested.has(of(seat)) ? [] : [{ seat, cid }];
      });
      const silent = seats.filter((s) => !attested.has(of(s)) && !complained.has(of(s)));
      const holds = att.length >= p.threshold;
      if (!holds) failures.push({ point, panel: p.panel });
      return { panel: p.panel, holds, attested: att, complained: com, silent };
    }),
  }));
  return {
    verdict: failures.length === 0 ? "available" : "unavailable",
    failures,
    points,
    records,
    rejected,
  };
}

/**
 * The counted-extent attestations of the default panel that count, each with
 * the roots it names: what the delivery check reads to decide which
 * obligation roots are available (docs/spec/delivery.md, Leaf availability).
 */
export function countedAttestations(
  report: AvailabilityReport,
): readonly { readonly seat: number; readonly roots: readonly Uint8Array[] }[] {
  const counted = report.points.find((p) => p.point === AVAILABILITY_POINTS.countedExtent);
  return counted?.panels.find((p) => p.panel === SEAT_PANELS.default)?.attested ?? [];
}
