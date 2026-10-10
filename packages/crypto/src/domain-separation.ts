// Domain-separation tags and the `DS` framing of
// docs/spec/domain-separation.md: every hash input is
// `u8(len(tag)) ‖ tag ‖ m` under one registered tag, so an output computed for
// one purpose is never valid for another (T-30, T-31, T-32, T-38).

/**
 * The tag registry of docs/spec/domain-separation.md, byte for byte; a test
 * checks this table against the spec. Only a `specified` tag has an input
 * layout, so only those can be used, and each only with its own primitive.
 */
export const TAG_REGISTRY = Object.freeze(
  (
    [
      { tag: "abolish/v1/display-text", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/election-definition", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/board-entry", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/board-chain", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/merkle/leaf", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/merkle/node", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/ballot", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/receipt", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/nullifier-scope", primitive: "in-circuit", status: "reserved" },
      { tag: "abolish/v1/fs/ballot-validity/option", primitive: "fiat-shamir", status: "reserved" },
      { tag: "abolish/v1/fs/ballot-validity/sum", primitive: "fiat-shamir", status: "reserved" },
      { tag: "abolish/v1/fs/ceremony/possession", primitive: "fiat-shamir", status: "reserved" },
      { tag: "abolish/v1/fs/tally-share", primitive: "fiat-shamir", status: "reserved" },
      { tag: "abolish/v1/ceremony-transcript", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/tally-transcript", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/event-accumulator", primitive: "plain", status: "reserved" },
      { tag: "abolish/v1/generator-h", primitive: "hash-to-curve", status: "specified" },
      { tag: "abolish/v1/kem/share", primitive: "kdf-aead", status: "reserved" },
    ] as const
  ).map((e) => Object.freeze(e)),
);

export type Tag = (typeof TAG_REGISTRY)[number]["tag"];

export type TagPrimitive = (typeof TAG_REGISTRY)[number]["primitive"];

/** Tags whose input layout the spec defines. */
export type SpecifiedTag = Extract<(typeof TAG_REGISTRY)[number], { status: "specified" }>["tag"];

/** Specified tags of one primitive. */
export type SpecifiedTagOf<P extends TagPrimitive> = Extract<
  (typeof TAG_REGISTRY)[number],
  { status: "specified"; primitive: P }
>["tag"];

/** Specified tags that frame their input with `DS`: plain hashes, and KDF and AEAD inputs. */
export type DsTag = SpecifiedTagOf<"plain" | "kdf-aead">;

/** The tag grammar of docs/spec/domain-separation.md, for protocol major version 1. */
const TAG_GRAMMAR = /^abolish\/v1\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** Whether `tag` matches the tag grammar and fits its `u8` length prefix (12 to 255 bytes). */
export function isWellFormedTag(tag: string): boolean {
  return TAG_GRAMMAR.test(tag) && tag.length >= 12 && tag.length <= 255;
}

/**
 * Throws unless `tag` is a specified tag of one of `primitives`. Checked at
 * run time too, for callers outside the type checker: a reserved tag has no
 * layout yet, and a tag used with another primitive's construction would give
 * one tag two input layouts (docs/spec/domain-separation.md, Rules).
 */
export function assertSpecifiedTag(tag: unknown, primitives: readonly TagPrimitive[]): void {
  const entry = TAG_REGISTRY.find((e) => e.tag === tag);
  if (entry?.status !== "specified" || !primitives.includes(entry.primitive))
    throw new RangeError(`${String(tag)} is not a specified ${primitives.join(" or ")} tag`);
}

/**
 * `DS(tag, m) = u8(len(tag)) ‖ tag ‖ m`: the input to a plain hash, or a KDF
 * or AEAD input (Fiat–Shamir uses the tag as a `DST` instead, docs/spec/group.md). The tag carries its own length, so the set of prefixes is prefix-free
 * and no two tags can frame the same input.
 */
export function ds(tag: DsTag, message: Uint8Array): Uint8Array {
  assertSpecifiedTag(tag, ["plain", "kdf-aead"]);
  if (!(message instanceof Uint8Array) || !ArrayBuffer.isView(message))
    throw new TypeError("ds: message must be a Uint8Array");
  // Copied first, so the length used and the bytes written are the same.
  const m = new Uint8Array(message);
  const out = new Uint8Array(1 + tag.length + m.length);
  out[0] = tag.length;
  // The grammar admits only ASCII, so each character is one byte.
  for (let i = 0; i < tag.length; i++) out[1 + i] = tag.charCodeAt(i);
  out.set(m, 1 + tag.length);
  return out;
}
