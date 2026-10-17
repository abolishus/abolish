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
      { tag: "abolish/v1/election-stub", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/board-entry", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/board-chain", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/merkle/leaf", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/merkle/node", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/board-checkpoint", primitive: "plain", status: "retired" },
      { tag: "abolish/v1/ballot", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/sig/receipt", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/receipt-commitment", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/nullifier-scope", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/rolling-nullifier-scope", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/membership-message", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/membership-vk", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/ballot-statement", primitive: "plain", status: "specified" },
      {
        tag: "abolish/v1/fs/ballot-validity/option",
        primitive: "fiat-shamir",
        status: "specified",
      },
      { tag: "abolish/v1/fs/ballot-validity/sum", primitive: "fiat-shamir", status: "specified" },
      { tag: "abolish/v1/fs/ceremony/possession", primitive: "fiat-shamir", status: "specified" },
      { tag: "abolish/v1/fs/tally-share", primitive: "fiat-shamir", status: "retired" },
      { tag: "abolish/v1/ceremony-transcript", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/tally-transcript", primitive: "plain", status: "retired" },
      { tag: "abolish/v1/event-accumulator", primitive: "plain", status: "retired" },
      { tag: "abolish/v1/election-id", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/generator-h", primitive: "hash-to-curve", status: "specified" },
      { tag: "abolish/v1/kem/share", primitive: "kdf-aead", status: "specified" },
      { tag: "abolish/v1/kem/share-aad", primitive: "kdf-aead", status: "specified" },
      { tag: "abolish/v1/share-ciphertext", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/fs/share-ephemeral", primitive: "fiat-shamir", status: "specified" },
      { tag: "abolish/v1/fs/share-complaint", primitive: "fiat-shamir", status: "specified" },
      { tag: "abolish/v1/sig/share-receipt", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/sig/share-complaint", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/circuit-tag", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/panel", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/author-panel", primitive: "plain", status: "specified" },
      {
        tag: "abolish/v1/sig/ceremony-registration",
        primitive: "signature",
        status: "retired",
      },
      { tag: "abolish/v1/ceremony-context", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/ceremony-round", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/ceremony-challenge", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/ceremony-answer", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/sig/ceremony-message", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/sig/ceremony-signing-key", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/sig/tally-opening", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/tally-aggregate", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/identity-backup/prf-salt", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/identity-backup/wrap-key", primitive: "kdf-aead", status: "specified" },
      { tag: "abolish/v1/identity-backup/locator", primitive: "kdf-aead", status: "specified" },
      { tag: "abolish/v1/identity-backup/id", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/identity-backup/aad", primitive: "kdf-aead", status: "specified" },
      { tag: "abolish/v1/kem/summed-share", primitive: "kdf-aead", status: "specified" },
      { tag: "abolish/v1/kem/summed-share-aad", primitive: "kdf-aead", status: "specified" },
      { tag: "abolish/v1/sig/summed-share", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/sig/destruction", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/vouch", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/vouch-slot", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/vouch-message", primitive: "plain", status: "specified" },
      {
        tag: "abolish/v1/keyed-nullifier/generator-j",
        primitive: "plain",
        status: "specified",
      },
      {
        tag: "abolish/v1/fs/keyed-nullifier/evaluation",
        primitive: "fiat-shamir-bjj",
        status: "specified",
      },
      { tag: "abolish/v1/sig/nullifier-answer", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/ballot-core", primitive: "plain", status: "specified" },
      {
        tag: "abolish/v1/keyed-nullifier/key-context",
        primitive: "plain",
        status: "specified",
      },
      { tag: "abolish/v1/keyed-nullifier/key-round", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/keyed-nullifier/key", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/keyed-nullifier/key-share", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/kem/nullifier-key-share", primitive: "kdf-aead", status: "specified" },
      {
        tag: "abolish/v1/kem/nullifier-key-share-aad",
        primitive: "kdf-aead",
        status: "specified",
      },
      { tag: "abolish/v1/sig/nullifier-key-message", primitive: "signature", status: "specified" },
      {
        tag: "abolish/v1/sig/nullifier-key-signing-key",
        primitive: "signature",
        status: "specified",
      },
      {
        tag: "abolish/v1/sig/nullifier-key-approval",
        primitive: "signature",
        status: "specified",
      },
      { tag: "abolish/v1/event-accumulator-2", primitive: "plain", status: "specified" },
      {
        tag: "abolish/v1/keyed-nullifier/reshare-context",
        primitive: "plain",
        status: "specified",
      },
      {
        tag: "abolish/v1/keyed-nullifier/reshare-round",
        primitive: "plain",
        status: "specified",
      },
      {
        tag: "abolish/v1/keyed-nullifier/reshared-key",
        primitive: "plain",
        status: "specified",
      },
      {
        tag: "abolish/v1/keyed-nullifier/reshare-share",
        primitive: "plain",
        status: "specified",
      },
      {
        tag: "abolish/v1/kem/nullifier-reshare-share",
        primitive: "kdf-aead",
        status: "specified",
      },
      {
        tag: "abolish/v1/kem/nullifier-reshare-share-aad",
        primitive: "kdf-aead",
        status: "specified",
      },
      {
        tag: "abolish/v1/sig/nullifier-reshare-message",
        primitive: "signature",
        status: "specified",
      },
      {
        tag: "abolish/v1/sig/nullifier-reshare-signing-key",
        primitive: "signature",
        status: "specified",
      },
      {
        tag: "abolish/v1/sig/nullifier-reshare-approval",
        primitive: "signature",
        status: "specified",
      },
      { tag: "abolish/v1/keyed-nullifier/scope", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/keyed-nullifier/h1", primitive: "in-circuit", status: "specified" },
      { tag: "abolish/v1/keyed-nullifier/h2", primitive: "in-circuit", status: "specified" },
      {
        tag: "abolish/v1/fs/ballot-validity/question-sum",
        primitive: "fiat-shamir",
        status: "specified",
      },
      { tag: "abolish/v1/board-checkpoint-2", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/kem-key", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/key-set", primitive: "plain", status: "specified" },
      {
        tag: "abolish/v1/sig/ceremony-registration-2",
        primitive: "signature",
        status: "specified",
      },
      { tag: "abolish/v1/sig/share-receipt-2", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/sig/share-complaint-2", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/fs/share-complaint-2", primitive: "fiat-shamir", status: "specified" },
      { tag: "abolish/v1/sig/close-statement", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/relay-call", primitive: "plain", status: "specified" },
      {
        tag: "abolish/v1/sig/share-receipt-batch",
        primitive: "signature",
        status: "specified",
      },
      {
        tag: "abolish/v1/sig/share-complaint-batch",
        primitive: "signature",
        status: "specified",
      },
      { tag: "abolish/v1/sig/running-opening", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/sig/obligation-root", primitive: "signature", status: "specified" },
      { tag: "abolish/v1/obligation-root", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/obligation/leaf", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/obligation/node", primitive: "plain", status: "specified" },
      { tag: "abolish/v1/sig/partial-opening", primitive: "signature", status: "specified" },
      {
        tag: "abolish/v1/sig/availability-attestation",
        primitive: "signature",
        status: "specified",
      },
      { tag: "abolish/v1/sig/availability-complaint", primitive: "signature", status: "specified" },
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
  return frame(tag, message);
}

/**
 * `DS(tag, m)` as the message a trustee signs (docs/spec/trustee-identity.md).
 * Kept apart from `ds` so a signature tag never frames a plain hash and a
 * plain-hash tag never frames a signed message: each tag has one layout and
 * one primitive.
 */
export function dsSignature(tag: SpecifiedTagOf<"signature">, message: Uint8Array): Uint8Array {
  assertSpecifiedTag(tag, ["signature"]);
  return frame(tag, message);
}

function frame(tag: string, message: Uint8Array): Uint8Array {
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
