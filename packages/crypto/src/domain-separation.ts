// Domain-separation tags and the `DS` framing of
// docs/spec/domain-separation.md: every hash input is
// `u8(len(tag)) ‖ tag ‖ m` under one registered tag, so an output computed for
// one purpose is never valid for another (T-30, T-31, T-32, T-38).

/**
 * The tag registry of docs/spec/domain-separation.md, byte for byte; a test
 * checks this table against the spec. Only a `specified` tag has an input
 * layout, so only those can frame a hash input.
 */
export const TAG_REGISTRY = Object.freeze(
  (
    [
      { tag: "abolish/v1/display-text", status: "specified" },
      { tag: "abolish/v1/election-definition", status: "reserved" },
      { tag: "abolish/v1/board-entry", status: "reserved" },
      { tag: "abolish/v1/board-chain", status: "reserved" },
      { tag: "abolish/v1/merkle/leaf", status: "reserved" },
      { tag: "abolish/v1/merkle/node", status: "reserved" },
      { tag: "abolish/v1/ballot", status: "reserved" },
      { tag: "abolish/v1/receipt", status: "reserved" },
      { tag: "abolish/v1/nullifier-scope", status: "reserved" },
      { tag: "abolish/v1/fs/ballot-validity/option", status: "reserved" },
      { tag: "abolish/v1/fs/ballot-validity/sum", status: "reserved" },
      { tag: "abolish/v1/fs/ceremony/possession", status: "reserved" },
      { tag: "abolish/v1/fs/tally-share", status: "reserved" },
      { tag: "abolish/v1/ceremony-transcript", status: "reserved" },
      { tag: "abolish/v1/tally-transcript", status: "reserved" },
      { tag: "abolish/v1/event-accumulator", status: "reserved" },
      { tag: "abolish/v1/generator-h", status: "reserved" },
      { tag: "abolish/v1/kem/share", status: "reserved" },
    ] as const
  ).map((e) => Object.freeze(e)),
);

export type Tag = (typeof TAG_REGISTRY)[number]["tag"];

/** Tags whose input layout the spec defines. */
export type SpecifiedTag = Extract<(typeof TAG_REGISTRY)[number], { status: "specified" }>["tag"];

/** The tag grammar of docs/spec/domain-separation.md, for protocol major version 1. */
const TAG_GRAMMAR = /^abolish\/v1\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** Whether `tag` matches the tag grammar and fits its `u8` length prefix (12 to 255 bytes). */
export function isWellFormedTag(tag: string): boolean {
  return TAG_GRAMMAR.test(tag) && tag.length >= 12 && tag.length <= 255;
}

const SPECIFIED: ReadonlySet<string> = new Set(
  TAG_REGISTRY.filter((e) => e.status === "specified").map((e) => e.tag),
);

/**
 * `DS(tag, m) = u8(len(tag)) ‖ tag ‖ m`: the input to a plain or Fiat–Shamir
 * hash. The tag carries its own length, so the set of prefixes is prefix-free
 * and no two tags can frame the same input.
 */
export function ds(tag: SpecifiedTag, message: Uint8Array): Uint8Array {
  // Checked at run time too, for callers outside the type checker: hashing
  // under a reserved tag would use a layout the spec hasn't fixed.
  if (!SPECIFIED.has(tag)) throw new RangeError(`${String(tag)} is not a specified tag`);
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
