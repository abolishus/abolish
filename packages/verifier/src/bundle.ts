// The verifier's local input bundle (docs/spec/verifier.md, Bundle): a strict
// parser for bundle.json, and the splitter that turns board.bin into encoded
// entries. A malformed bundle is rejected whole, before any check runs: it is
// no evidence about any election. A short or unreadable board copy is not
// rejected here; the board checks decide what it means (T-53).

import type { Anchor, AnchorClock } from "@abolishus/crypto";

/** Where an input came from. Only L1 or the pinned roots authenticate one; a local file never does. */
export type InputSource = "local-file";

export interface InputSources {
  readonly electionId: InputSource;
  readonly boardEntryVersion: InputSource;
  readonly clock: InputSource;
  readonly now: InputSource;
  readonly anchors: InputSource;
}

/** One election's inputs: the board copy, and what the board checks judge it against. */
export interface Bundle {
  readonly electionId: Uint8Array;
  readonly boardEntryVersion: 1;
  readonly clock: AnchorClock;
  readonly now: bigint;
  readonly anchors: readonly Anchor[];
  /** The board copy, split into encoded entries in index order. */
  readonly entries: readonly Uint8Array[];
  /** Bytes of board.bin after the last entry that could be split off. */
  readonly unreadableBytes: number;
  readonly sources: InputSources;
}

/** A bundle that doesn't follow docs/spec/verifier.md, Bundle. */
export class BundleError extends Error {
  override readonly name = "BundleError";
}

export const BUNDLE_FORMAT = "abolish-verifier-bundle/1";

const U32_MAX = 2n ** 32n - 1n;
const U64_MAX = 2n ** 64n - 1n;

function object(value: unknown, keys: readonly string[], what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new BundleError(`${what}: expected an object`);
  const o = value as Record<string, unknown>;
  const got = Object.keys(o);
  for (const k of got) if (!keys.includes(k)) throw new BundleError(`${what}: unknown member ${k}`);
  for (const k of keys) if (!got.includes(k)) throw new BundleError(`${what}: missing ${k}`);
  return o;
}

function hex32(value: unknown, what: string): Uint8Array {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw new BundleError(`${what}: expected 64 lowercase hex digits`);
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = Number.parseInt(value.slice(2 * i, 2 * i + 2), 16);
  return b;
}

// Canonical decimal only, so two readers can't take one string for two values.
function integer(value: unknown, max: bigint, what: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value))
    throw new BundleError(`${what}: expected a decimal string with no sign or leading zero`);
  const n = BigInt(value);
  if (n > max) throw new BundleError(`${what}: over ${max}`);
  return n;
}

function parseClock(value: unknown): AnchorClock {
  const c = object(value, ["epoch", "period", "deadline", "lastSegment"], "clock");
  const period = integer(c["period"], U64_MAX, "clock.period");
  if (period < 1n) throw new BundleError("clock.period: must be at least 1");
  return {
    epoch: integer(c["epoch"], U64_MAX, "clock.epoch"),
    period,
    deadline: integer(c["deadline"], U64_MAX, "clock.deadline"),
    lastSegment: Number(integer(c["lastSegment"], U32_MAX, "clock.lastSegment")),
  };
}

function parseAnchor(value: unknown, j: number): Anchor {
  const what = `anchors[${j}]`;
  const a = object(value, ["electionId", "segment", "size", "head", "root", "anchoredAt"], what);
  return {
    checkpoint: {
      election_id: hex32(a["electionId"], `${what}.electionId`),
      segment: Number(integer(a["segment"], U32_MAX, `${what}.segment`)),
      size: integer(a["size"], U64_MAX, `${what}.size`),
      head: hex32(a["head"], `${what}.head`),
      root: hex32(a["root"], `${what}.root`),
    },
    anchoredAt: integer(a["anchoredAt"], U64_MAX, `${what}.anchoredAt`),
  };
}

// The version-1 entry layout: record header (3), election_id (32), index (8)
// and segment (4), then the payload's u32 length and the payload.
const FIXED = 3 + 32 + 8 + 4;
const LENGTH = 4;

/**
 * Splits a board copy into encoded entries by their length fields alone. It
 * stops where fewer bytes remain than the next entry needs, and returns how
 * many bytes it left. Nothing is decoded, not even a length over
 * `MAX_BOARD_PAYLOAD`: the bytes are already held, and such an entry is the
 * operator's to answer for, so 4.1 must see it and fail it (`decode`), not
 * leave the copy short and the election unverifiable (T-23).
 */
export function splitEntries(board: Uint8Array): {
  readonly entries: readonly Uint8Array[];
  readonly unreadableBytes: number;
} {
  if (!(board instanceof Uint8Array)) throw new TypeError("board must be a Uint8Array");
  const bytes = new Uint8Array(board);
  const entries: Uint8Array[] = [];
  let at = 0;
  while (bytes.length - at >= FIXED + LENGTH) {
    const n = new DataView(bytes.buffer, at + FIXED, LENGTH).getUint32(0);
    if (bytes.length - at - FIXED - LENGTH < n) break;
    const end = at + FIXED + LENGTH + n;
    entries.push(bytes.slice(at, end));
    at = end;
  }
  return { entries, unreadableBytes: bytes.length - at };
}

/**
 * Throws if any object in a JSON text (already parsed once) repeats a member
 * name. `JSON.parse` keeps the last of them, and another reader might keep
 * the first, so two verifiers could judge different inputs from one file.
 */
function rejectDuplicateMembers(json: string): void {
  // One frame per open object or array: the member names seen so far, or
  // null for an array.
  const frames: (Set<string> | null)[] = [];
  let expectName = false;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (c === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      const names = frames.at(-1);
      if (expectName && names instanceof Set) {
        const name = JSON.parse(json.slice(i, j + 1)) as string;
        if (names.has(name)) throw new BundleError(`bundle.json: duplicate member ${name}`);
        names.add(name);
        expectName = false;
      }
      i = j;
    } else if (c === "{") {
      frames.push(new Set());
      expectName = true;
    } else if (c === "[") frames.push(null);
    else if (c === "}" || c === "]") frames.pop();
    else if (c === ",") expectName = frames.at(-1) instanceof Set;
  }
}

/**
 * Parses a bundle from the text of bundle.json and the bytes of board.bin.
 * Every member is checked for shape and range here, so the board checks only
 * ever see well-formed values.
 */
export function parseBundle(json: string, board: Uint8Array): Bundle {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new BundleError("bundle.json: not JSON");
  }
  rejectDuplicateMembers(json);
  const b = object(
    value,
    ["format", "electionId", "boardEntryVersion", "clock", "now", "anchors"],
    "bundle.json",
  );
  if (b["format"] !== BUNDLE_FORMAT)
    throw new BundleError(`bundle.json: format must be ${BUNDLE_FORMAT}`);
  if (b["boardEntryVersion"] !== 1)
    throw new BundleError("bundle.json: boardEntryVersion must be the number 1");
  const anchors = b["anchors"];
  if (!Array.isArray(anchors)) throw new BundleError("anchors: expected an array");
  const split = splitEntries(board);
  return {
    electionId: hex32(b["electionId"], "electionId"),
    boardEntryVersion: 1,
    clock: parseClock(b["clock"]),
    now: integer(b["now"], U64_MAX, "now"),
    anchors: anchors.map(parseAnchor),
    entries: split.entries,
    unreadableBytes: split.unreadableBytes,
    sources: {
      electionId: "local-file",
      boardEntryVersion: "local-file",
      clock: "local-file",
      now: "local-file",
      anchors: "local-file",
    },
  };
}
