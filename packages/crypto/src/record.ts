// Record framing (docs/spec/notation.md, "Records") and the record-type
// registry (docs/spec/versioning.md). A record is `u16 record_type ‖ u8
// version ‖ fields`. Unknown types and versions are rejected, never guessed
// (T-31), and a decoder that knows the election's profile rejects any other
// version right after the header, so old rules can't be mixed into a newer
// election (T-34).

import { type Codec, type CodecValue, DecodeError, EncodeError, Reader, Writer } from "./codec.ts";

/**
 * `record_type` numbers from the registry in docs/spec/versioning.md; a test
 * checks this table against it. A number here only names a type: a decoder
 * knows it once a `RecordType` with a specified layout is in its schema.
 */
export const RECORD_TYPES = {
  electionDefinition: 0x0001,
  ballot: 0x0002,
  spoiledBallotOpening: 0x0003,
  receipt: 0x0004,
  ceremonyTranscript: 0x0005,
  tallyTranscript: 0x0006,
  boardEntry: 0x0007,
  contractEvent: 0x0008,
  displayText: 0x0009,
} as const;

/** `0xff00`–`0xffff`: used only by vector files to exercise framing. */
export const TEST_RECORD_TYPES = { first: 0xff00, last: 0xffff } as const;

const isTestType = (t: number) => t >= TEST_RECORD_TYPES.first && t <= TEST_RECORD_TYPES.last;

type Versions = Readonly<Record<number, Codec<unknown>>>;

/** One record type: its number and the layout of each version it has. */
export interface RecordType<V extends Versions = Versions> {
  readonly recordType: number;
  readonly versions: V;
}

export type RecordVersion<V extends Versions> = keyof V & number;

/** A decoded record: its version, and the value under that version's layout. */
export type DecodedRecord<V extends Versions> = {
  readonly [K in RecordVersion<V>]: { readonly version: K; readonly value: CodecValue<V[K]> };
}[RecordVersion<V>];

export function recordType<const V extends Versions>(type: number, versions: V): RecordType<V> {
  // 0x0000 is never valid, and neither is version 0x00 (notation.md).
  if (!Number.isInteger(type) || type < 1 || type > 0xffff)
    throw new RangeError("record type must be an integer from 1 to 0xffff");
  const keys = Object.keys(versions);
  if (keys.length === 0) throw new RangeError("a record type needs at least one version");
  for (const k of keys) {
    const v = Number(k);
    if (!Number.isInteger(v) || v < 1 || v > 0xff || String(v) !== k)
      throw new RangeError(`version ${k} must be an integer from 1 to 255`);
  }
  // Frozen, so a registered layout can't be swapped after a schema has it.
  return Object.freeze({ recordType: type, versions: Object.freeze({ ...versions }) });
}

function layoutOf(type: RecordType, version: number): Codec<unknown> | undefined {
  return Object.hasOwn(type.versions, version) ? type.versions[version] : undefined;
}

export interface RecordSchemaOptions {
  /** Admit the test range. Only vector files may; production decoders reject it. */
  readonly allowTestRange?: boolean;
}

export interface DecodeRecordOptions {
  /**
   * The version the election's profile pins for this type
   * (docs/spec/versioning.md). Any other version is `profile-mismatch`, even
   * one this schema could decode.
   */
  readonly version?: number;
}

/** The set of record types (and their versions) a decoder knows. */
export class RecordSchema {
  readonly #types = new Map<number, RecordType>();

  constructor(types: readonly RecordType[], options: RecordSchemaOptions = {}) {
    for (const t of types) {
      if (this.#types.has(t.recordType))
        throw new RangeError(`record type ${t.recordType} listed twice`);
      if (isTestType(t.recordType) && options.allowTestRange !== true)
        throw new RangeError(`record type ${t.recordType} is in the test range`);
      this.#types.set(t.recordType, t);
    }
  }

  // Only types this schema registered are encoded or expected, so a caller
  // can't frame bytes under a type its own decoders would reject, or read a
  // record with a layout other than the registered one.
  #check(type: RecordType): void {
    if (this.#types.get(type.recordType) !== type)
      throw new RangeError(`record type ${type.recordType} is not in this schema`);
  }

  encode<V extends Versions, K extends RecordVersion<V>>(
    type: RecordType<V>,
    version: K,
    value: CodecValue<V[K]>,
  ): Uint8Array {
    this.#check(type);
    const layout = layoutOf(type, version);
    if (layout === undefined)
      throw new EncodeError(`record type ${type.recordType} has no version ${version}`);
    const w = new Writer();
    w.uint(2, type.recordType);
    w.uint(1, version);
    layout.write(w, value);
    return w.finish();
  }

  /** Strictly decodes a complete input as a record of `type`. */
  decode<V extends Versions>(
    type: RecordType<V>,
    bytes: Uint8Array,
    options: DecodeRecordOptions = {},
  ): DecodedRecord<V> {
    this.#check(type);
    const r = new Reader(bytes);
    // The type is checked before the version byte is read (notation.md).
    const at = r.offset;
    const t = r.uint(2);
    if (!this.#types.has(t)) throw new DecodeError("unknown-record-type", at);
    if (t !== type.recordType) throw new DecodeError("unexpected-record-type", at);
    const vAt = r.offset;
    const v = r.uint(1);
    const layout = layoutOf(type, v);
    if (layout === undefined) throw new DecodeError("unknown-version", vAt);
    if (options.version !== undefined && v !== options.version)
      throw new DecodeError("profile-mismatch", vAt);
    const value = layout.read(r);
    r.end();
    return { version: v, value } as DecodedRecord<V>;
  }
}
