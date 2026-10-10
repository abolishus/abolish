// Reader for the cross-language vector files of docs/spec/vectors/
// (format `abolish-vectors/1`, docs/spec/vectors/README.md). It builds codecs
// from the files' type descriptors, so the expected bytes and values come from
// the spec's vectors, never from the code under test.

import { ristretto255 } from "@noble/curves/ed25519.js";
import { readFileSync } from "node:fs";
import {
  bool,
  bytesFixed,
  bytesVar,
  type Codec,
  element,
  elementOrIdentity,
  enum8,
  fieldBn254,
  list,
  RecordSchema,
  type RecordType,
  recordType,
  scalar,
  struct,
  u16,
  u32,
  u64,
  u8,
  utf8,
} from "../src/index.ts";

export const SPEC_VECTORS = new URL("../../../docs/spec/vectors/", import.meta.url);

export type TypeDescriptor =
  | { readonly kind: "u8" | "u16" | "u32" | "u64" | "bool" }
  | { readonly kind: "enum8"; readonly values: readonly string[] }
  | { readonly kind: "bytes"; readonly length: number }
  | { readonly kind: "bytes"; readonly max: number }
  | { readonly kind: "utf8"; readonly max: number }
  | { readonly kind: "field"; readonly field: string }
  | { readonly kind: "scalar" }
  | { readonly kind: "element"; readonly identity: "allowed" | "rejected" }
  | { readonly kind: "list"; readonly max: number; readonly of: TypeDescriptor }
  | { readonly kind: "struct"; readonly fields: readonly FieldDescriptor[] }
  | { readonly kind: "ref"; readonly name: string }
  | {
      readonly kind: "record";
      readonly recordType: string;
      readonly version: number;
      readonly fields: readonly FieldDescriptor[];
    };

export interface FieldDescriptor {
  readonly name: string;
  readonly type: TypeDescriptor;
}

/** Named descriptors of a file's `types`, which `ref` descriptors point to. */
export type NamedTypes = Readonly<Record<string, TypeDescriptor>>;

export type RecordDescriptor = Extract<TypeDescriptor, { kind: "record" }>;

export interface Vector {
  readonly id: string;
  readonly description?: string;
  readonly type: TypeDescriptor;
  readonly encoding: string;
  readonly value?: unknown;
  readonly error?: string;
  readonly illFormed?: string;
  readonly hash?: string;
  readonly commitment?: string;
  readonly pinned?: number;
  readonly definition?: { readonly optionCount: string; readonly displayTextCommitment: string };
}

export interface VectorFile {
  readonly format: string;
  readonly title: string;
  readonly spec: string;
  readonly generator: string;
  readonly draft?: boolean;
  readonly types?: NamedTypes;
  readonly vectors: readonly Vector[];
}

export function readVectorFile(name: string): VectorFile {
  const file = JSON.parse(readFileSync(new URL(name, SPEC_VECTORS), "utf8")) as VectorFile;
  if (file.format !== "abolish-vectors/1")
    throw new Error(`${name}: unknown format ${file.format}`);
  return file;
}

// Strict, so a malformed vector fails instead of quietly testing another
// input: Buffer.from(s, "hex") stops at the first bad digit, and Number("")
// is 0.
export function hex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(s)) throw new Error(`not lowercase hex bytes: ${s}`);
  return Uint8Array.from(Buffer.from(s, "hex"));
}

const decimal = (s: string) => {
  if (!/^(?:0|[1-9][0-9]*)$/.test(s)) throw new Error(`not a decimal integer: ${s}`);
  return BigInt(s);
};

/** A codec for a non-record descriptor, and how to turn its JSON value into a codec value. */
export interface Built {
  readonly codec: Codec<unknown>;
  readonly fromJson: (v: unknown) => unknown;
}

const asString = (v: unknown) => {
  if (typeof v !== "string") throw new Error(`expected a JSON string, got ${JSON.stringify(v)}`);
  return v;
};

/** `t`, with a `ref` replaced by the descriptor it names. */
export function resolve(t: TypeDescriptor, types: NamedTypes = {}): TypeDescriptor {
  if (t.kind !== "ref") return t;
  const named = Object.hasOwn(types, t.name) ? types[t.name] : undefined;
  if (named === undefined || named.kind === "ref") throw new Error(`bad type ref ${t.name}`);
  return named;
}

export function build(descriptor: TypeDescriptor, types: NamedTypes = {}): Built {
  const t = resolve(descriptor, types);
  switch (t.kind) {
    case "u8":
    case "u16":
    case "u32": {
      const codec = { u8, u16, u32 }[t.kind];
      return { codec, fromJson: (v) => Number(decimal(asString(v))) };
    }
    case "u64":
      return { codec: u64, fromJson: (v) => decimal(asString(v)) };
    case "bool":
      return { codec: bool, fromJson: (v) => v };
    case "enum8":
      return {
        codec: enum8(t.values.map((x) => Number(decimal(x)))),
        fromJson: (v) => Number(decimal(asString(v))),
      };
    case "bytes":
      return {
        codec: "length" in t ? bytesFixed(t.length) : bytesVar(t.max),
        fromJson: (v) => hex(asString(v)),
      };
    case "utf8":
      return { codec: utf8(t.max), fromJson: (v) => hex(asString(v)) };
    case "field":
      if (t.field !== "bn254") throw new Error(`unknown field ${t.field}`);
      return {
        codec: fieldBn254,
        fromJson: (v) => {
          const b = hex(asString(v));
          if (b.length !== 32) throw new Error("a field value is 32 bytes");
          return BigInt(`0x${asString(v)}`);
        },
      };
    case "scalar":
      return { codec: scalar, fromJson: (v) => decimal(asString(v)) };
    case "element":
      if (t.identity !== "allowed" && t.identity !== "rejected")
        throw new Error(`unknown identity rule ${String(t.identity)}`);
      return {
        codec: t.identity === "allowed" ? elementOrIdentity : element,
        // Decoded by @noble/curves directly, not through the codec under test.
        fromJson: (v) => ristretto255.Point.fromBytes(hex(asString(v))),
      };
    case "list": {
      const of = build(t.of, types);
      return {
        codec: list(of.codec, t.max),
        fromJson: (v) => (v as unknown[]).map(of.fromJson),
      };
    }
    case "struct":
      return buildFields(t.fields, types);
    case "ref":
      throw new Error("unreachable: resolved above");
    case "record":
      throw new Error("records are built with buildSchema");
  }
}

function buildFields(fieldList: readonly FieldDescriptor[], types: NamedTypes): Built {
  const fields = fieldList.map((f) => [f.name, build(f.type, types)] as const);
  return {
    codec: struct(fields.map(([name, b]) => [name, b.codec] as const)),
    fromJson: (v) =>
      Object.fromEntries(
        fields.map(([name, b]) => [name, b.fromJson((v as Record<string, unknown>)[name])]),
      ),
  };
}

const typeNumber = (r: RecordDescriptor) => Number.parseInt(r.recordType, 16);

/**
 * The schema of a vector file: the known record types are exactly those that
 * appear as a `recordType` in the file, with exactly the versions that appear
 * with them (docs/spec/vectors/README.md, Rules).
 */
export function buildSchema(file: VectorFile): {
  readonly schema: RecordSchema;
  readonly type: (r: TypeDescriptor) => {
    readonly recordType: RecordType;
    readonly built: Built;
  };
} {
  const layouts = new Map<number, Map<number, { json: string; built: Built }>>();
  const types = file.types ?? {};
  for (const v of file.vectors) {
    const t = resolve(v.type, types);
    if (t.kind !== "record") continue;
    const versions = layouts.get(typeNumber(t)) ?? new Map();
    layouts.set(typeNumber(t), versions);
    const json = JSON.stringify(t.fields);
    const seen = versions.get(t.version);
    // One (type, version) pair is one layout; a file that disagrees with
    // itself is a broken vector file, not something to pick a side of.
    if (seen !== undefined && seen.json !== json)
      throw new Error(`${v.id}: ${t.recordType} v${t.version} has two layouts`);
    versions.set(t.version, seen ?? { json, built: buildFields(t.fields, types) });
  }
  const made = new Map<number, RecordType>();
  for (const [n, versions] of layouts)
    made.set(
      n,
      recordType(n, Object.fromEntries([...versions].map(([k, l]) => [k, l.built.codec]))),
    );
  const schema = new RecordSchema([...made.values()], { allowTestRange: true });
  return {
    schema,
    type: (descriptor) => {
      const r = resolve(descriptor, types);
      if (r.kind !== "record") throw new Error("not a record type");
      const recordType = made.get(typeNumber(r));
      const built = layouts.get(typeNumber(r))?.get(r.version)?.built;
      if (recordType === undefined || built === undefined) throw new Error("unreachable");
      return { recordType, built };
    },
  };
}
