// The verifier's local input bundle (docs/spec/verifier.md, Bundle): a strict
// parser for bundle.json, and the splitter that turns board.bin into encoded
// entries. A malformed bundle is rejected whole, before any check runs: it is
// no evidence about any election. A short or unreadable board copy is not
// rejected here; the board checks decide what it means (T-53).

import {
  type Anchor,
  type AnchorClock,
  type BoardCopyStop,
  DecodeError,
  decodeCheckpoint,
  MAX_TRUSTEES,
  type Panel,
  PanelError,
  panelId,
} from "@abolishus/crypto";
import { decodeHeader, type L1Evidence, type L1Header, NodePool, RlpError } from "./l1.ts";
import type { L2BoardEvidence } from "./availability.ts";
import type { GatewayStats } from "./gateways.ts";

/**
 * Where an input came from. A local file authenticates nothing; an
 * `l1-state-proof` input is proven against the state root of the header the
 * bundle gives, so it is exactly as authentic as the header, the anchor's
 * address and the first segment, which are listed as inputs of their own. A
 * `definition` input is a field of the election definition, so it is exactly
 * as authentic as the definition, also listed as an input of its own.
 */
export type InputSource = "local-file" | "l1-state-proof" | "definition";

export interface InputSources {
  readonly electionId: InputSource;
  readonly boardEntryVersion: InputSource;
  readonly clock: InputSource;
  readonly now: InputSource;
  readonly anchors: InputSource;
  readonly l1Header?: InputSource;
  readonly anchorAddress?: InputSource;
  readonly firstSegment?: InputSource;
  readonly definition?: InputSource;
  readonly panel?: InputSource;
  readonly l1Blocks?: InputSource;
  readonly l2OutputRoot?: InputSource;
}

/**
 * How a copy read by CID came out (docs/spec/verifier.md, Board by CID): for
 * blocks.car, the store's sections read as blocks and the bytes after them;
 * for gateways, the requests sent and the blocks they served; and where the
 * copy stopped short of the counted checkpoints, if it did. `not-reached`:
 * the read never ran, because the board checks stop before they need a copy
 * (the definition, L1 or steps 1 and 2 of the board checks), and the report
 * says why.
 */
export interface CidRead {
  readonly storeBlocks?: number;
  readonly storeUnreadableBytes?: number;
  readonly gateways?: GatewayStats;
  readonly stopped?:
    | { readonly checkpoint: number; readonly reason: BoardCopyStop["reason"] }
    | { readonly reason: "not-reached" };
}

interface BundleCommon {
  readonly clock: AnchorClock;
  /** The board copy, split into encoded entries in index order. */
  readonly entries: readonly Uint8Array[];
  /** Bytes of board.bin after the last entry that could be split off; 0 for a copy read by CID. */
  readonly unreadableBytes: number;
  /** Set when the copy was read by CID from blocks.car instead of board.bin. */
  readonly byCid?: CidRead;
  readonly sources: InputSources;
}

/** Format 1: `now` and every anchor given as they are. */
export interface LocalBundle extends BundleCommon {
  readonly format: typeof BUNDLE_FORMAT;
  readonly electionId: Uint8Array;
  readonly boardEntryVersion: 1;
  readonly now: bigint;
  readonly anchors: readonly Anchor[];
}

/** Format 2: `now` and the anchors read from the board anchor's L1 state. */
export interface L1Bundle extends BundleCommon {
  readonly format: typeof BUNDLE_FORMAT_L1;
  readonly electionId: Uint8Array;
  readonly boardEntryVersion: 1;
  readonly l1: L1Evidence;
}

/**
 * Format 3: as format 2, with the election identifier, the pinned board-entry
 * version and the anchor's address taken from the election definition. The
 * definition is held as bytes: decoding it is check 2.1, not parsing, so a
 * definition that doesn't decode is the election's failure once the
 * definition is authenticated, never a malformed bundle.
 */
export interface DefinitionBundle extends BundleCommon {
  readonly format: typeof BUNDLE_FORMAT_DEFINITION;
  readonly definition: Uint8Array;
  readonly l1: Omit<L1Evidence, "anchor">;
}

/**
 * Format 4: as format 3, with the trustee panel the release pins, which the
 * key-ceremony checks (2.5, 3.1, 3.2) run against. The verifier has no pinned
 * panels yet, so the bundle gives it and it is a local input.
 */
export interface CeremonyBundle extends Omit<DefinitionBundle, "format"> {
  readonly format: typeof BUNDLE_FORMAT_CEREMONY;
  readonly panel: Panel;
}

/**
 * Format 5: as format 4, with a run of consecutive finalized L1 headers that
 * the L1 references of ballots (5.8) are judged against. Its last header is
 * the finalized head; nothing yet ties it to `l1.header`, so it is a local
 * input of its own.
 */
export interface BlocksBundle extends Omit<CeremonyBundle, "format"> {
  readonly format: typeof BUNDLE_FORMAT_BLOCKS;
  /** In increasing number, each the parent of the next; never empty. */
  readonly l1Blocks: readonly L1Header[];
}

/**
 * Format 6: as format 5, with the board contract's events and its event
 * accumulator under an L2 output root, which the availability check (4.6)
 * reads. The output root should be read from a dispute game on L1 (P1-19
 * part 3b); until then it is a local input of its own.
 */
export interface L2Bundle extends Omit<BlocksBundle, "format"> {
  readonly format: typeof BUNDLE_FORMAT_L2;
  readonly l2Board: L2BoardEvidence;
}

/** One election's inputs: the board copy, and what the board checks judge it against. */
export type Bundle =
  | LocalBundle
  | L1Bundle
  | DefinitionBundle
  | CeremonyBundle
  | BlocksBundle
  | L2Bundle;

/** A bundle that doesn't follow docs/spec/verifier.md, Bundle. */
export class BundleError extends Error {
  override readonly name = "BundleError";
}

export const BUNDLE_FORMAT = "abolish-verifier-bundle/1";
export const BUNDLE_FORMAT_L1 = "abolish-verifier-bundle/2";
export const BUNDLE_FORMAT_DEFINITION = "abolish-verifier-bundle/3";
export const BUNDLE_FORMAT_CEREMONY = "abolish-verifier-bundle/4";
export const BUNDLE_FORMAT_BLOCKS = "abolish-verifier-bundle/5";
export const BUNDLE_FORMAT_L2 = "abolish-verifier-bundle/6";

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

function hexBytes(value: unknown, what: string, length?: number): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[0-9a-f]{2})+$/.test(value) ||
    (length !== undefined && value.length !== 2 * length)
  )
    throw new BundleError(
      `${what}: expected ${length === undefined ? "non-empty" : `${2 * length} digits of`} lowercase hex`,
    );
  const b = new Uint8Array(value.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = Number.parseInt(value.slice(2 * i, 2 * i + 2), 16);
  return b;
}

const hex32 = (value: unknown, what: string) => hexBytes(value, what, 32);

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
  const a = object(
    value,
    ["electionId", "segment", "size", "head", "root", "objectCid", "hashesCid", "anchoredAt"],
    what,
  );
  return {
    checkpoint: {
      election_id: hex32(a["electionId"], `${what}.electionId`),
      segment: Number(integer(a["segment"], U32_MAX, `${what}.segment`)),
      size: integer(a["size"], U64_MAX, `${what}.size`),
      head: hex32(a["head"], `${what}.head`),
      root: hex32(a["root"], `${what}.root`),
      object_cid: hexBytes(a["objectCid"], `${what}.objectCid`, 36),
      hashes_cid: hexBytes(a["hashesCid"], `${what}.hashesCid`, 36),
    },
    anchoredAt: integer(a["anchoredAt"], U64_MAX, `${what}.anchoredAt`),
  };
}

function array(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new BundleError(`${what}: expected an array`);
  return value;
}

function parseL1(value: unknown): L1Evidence;
function parseL1(value: unknown, withAnchor: false): Omit<L1Evidence, "anchor">;
function parseL1(value: unknown, withAnchor = true): Omit<L1Evidence, "anchor"> {
  const members = ["firstSegment", "header", "nodes", "checkpoints"];
  const l = object(value, withAnchor ? ["anchor", ...members] : members, "l1");
  return {
    header: header(l["header"], "l1.header"),
    ...(withAnchor && { anchor: hexBytes(l["anchor"], "l1.anchor", 20) }),
    firstSegment: Number(integer(l["firstSegment"], U32_MAX, "l1.firstSegment")),
    nodes: new NodePool(array(l["nodes"], "l1.nodes").map((n, i) => hexBytes(n, `l1.nodes[${i}]`))),
    checkpoints: array(l["checkpoints"], "l1.checkpoints").map((c, i) => {
      const what = `l1.checkpoints[${i}]`;
      try {
        return decodeCheckpoint(hexBytes(c, what, 180));
      } catch (e) {
        if (e instanceof DecodeError) throw new BundleError(`${what}: ${e.code}`);
        throw e;
      }
    }),
  };
}

// A panel the panel identifier's rules accept (docs/spec/trustee-identity.md,
// Panel identifier): 2 ≤ k ≤ n ≤ MAX_TRUSTEES, canonical P-256 keys, no key
// in two seats. Checked here, so the ceremony checks only see a valid panel.
function parsePanel(value: unknown): Panel {
  const p = object(value, ["threshold", "keys"], "panel");
  const panel = {
    threshold: Number(integer(p["threshold"], BigInt(MAX_TRUSTEES), "panel.threshold")),
    keys: array(p["keys"], "panel.keys").map((k, i) => hexBytes(k, `panel.keys[${i}]`, 33)),
  };
  try {
    panelId(panel);
  } catch (e) {
    if (e instanceof PanelError) throw new BundleError(`panel: ${e.code}`);
    throw e;
  }
  return panel;
}

function header(value: unknown, what: string): L1Header {
  const raw = hexBytes(value, what);
  try {
    return decodeHeader(raw);
  } catch (e) {
    if (e instanceof RlpError) throw new BundleError(`${what}: ${e.message}`);
    throw e;
  }
}

/**
 * A run of L1 headers: consecutive numbers, each naming the one before as its
 * parent, with strictly increasing timestamps, as Ethereum's are. A run that
 * isn't one chain is no L1 at all, and the search for `l1_ref_min` relies on
 * the timestamps (docs/spec/revoting.md, Admission). Where it holds the block
 * `l1.header` names, it must hold that header: two L1 views of one bundle
 * can't disagree.
 */
function parseBlocks(value: unknown, anchorHeader: L1Header): readonly L1Header[] {
  const raw = array(value, "l1Blocks");
  if (raw.length === 0) throw new BundleError("l1Blocks: expected at least one header");
  const blocks = raw.map((h, i) => header(h, `l1Blocks[${i}]`));
  for (const [i, b] of blocks.entries()) {
    const before = blocks[i - 1];
    if (
      before !== undefined &&
      (b.number !== before.number + 1n ||
        !equal(b.parentHash, before.hash) ||
        b.timestamp <= before.timestamp)
    )
      throw new BundleError(`l1Blocks[${i}]: not the child of l1Blocks[${i - 1}]`);
    if (b.number === anchorHeader.number && !equal(b.hash, anchorHeader.hash))
      throw new BundleError(`l1Blocks[${i}]: another block than l1.header at its number`);
  }
  return blocks;
}

// Bytes only: decoding the events and the header, and proving the
// accumulator, are 4.6's, so evidence that doesn't hold up is reported there,
// never a rejected bundle.
function parseL2Board(value: unknown): L2BoardEvidence {
  const l = object(
    value,
    ["events", "outputRoot", "messagePasserStorageRoot", "header", "nodes"],
    "l2Board",
  );
  return {
    events: array(l["events"], "l2Board.events").map((e, i) => hexBytes(e, `l2Board.events[${i}]`)),
    proof: {
      outputRoot: hex32(l["outputRoot"], "l2Board.outputRoot"),
      messagePasserStorageRoot: hex32(
        l["messagePasserStorageRoot"],
        "l2Board.messagePasserStorageRoot",
      ),
      header: hexBytes(l["header"], "l2Board.header"),
      nodes: array(l["nodes"], "l2Board.nodes").map((n, i) => hexBytes(n, `l2Board.nodes[${i}]`)),
    },
  };
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

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
  const format =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)["format"]
      : undefined;
  if (
    format === BUNDLE_FORMAT_DEFINITION ||
    format === BUNDLE_FORMAT_CEREMONY ||
    format === BUNDLE_FORMAT_BLOCKS ||
    format === BUNDLE_FORMAT_L2
  ) {
    const l2 = format === BUNDLE_FORMAT_L2;
    const blocks = l2 || format === BUNDLE_FORMAT_BLOCKS;
    const ceremony = blocks || format === BUNDLE_FORMAT_CEREMONY;
    const members = ["format", "definition", "clock", "l1"];
    const b = object(
      value,
      l2
        ? [...members, "panel", "l1Blocks", "l2Board"]
        : blocks
          ? [...members, "panel", "l1Blocks"]
          : ceremony
            ? [...members, "panel"]
            : members,
      "bundle.json",
    );
    const definition = hexBytes(b["definition"], "definition");
    const clock = parseClock(b["clock"]);
    const l1 = parseL1(b["l1"], false);
    const panel = ceremony ? parsePanel(b["panel"]) : undefined;
    const l1Blocks = blocks ? parseBlocks(b["l1Blocks"], l1.header) : undefined;
    const l2Board = l2 ? parseL2Board(b["l2Board"]) : undefined;
    const split = splitEntries(board);
    const common = {
      definition,
      clock,
      l1,
      entries: split.entries,
      unreadableBytes: split.unreadableBytes,
    };
    const sources = {
      electionId: "definition",
      boardEntryVersion: "definition",
      clock: "local-file",
      now: "l1-state-proof",
      anchors: "l1-state-proof",
      l1Header: "local-file",
      anchorAddress: "definition",
      firstSegment: "local-file",
      definition: "local-file",
    } as const;
    if (panel === undefined) return { format: BUNDLE_FORMAT_DEFINITION, ...common, sources };
    if (l1Blocks === undefined)
      return {
        format: BUNDLE_FORMAT_CEREMONY,
        ...common,
        panel,
        sources: { ...sources, panel: "local-file" },
      };
    const withBlocks = { ...sources, panel: "local-file", l1Blocks: "local-file" } as const;
    return l2Board === undefined
      ? { format: BUNDLE_FORMAT_BLOCKS, ...common, panel, l1Blocks, sources: withBlocks }
      : {
          format: BUNDLE_FORMAT_L2,
          ...common,
          panel,
          l1Blocks,
          l2Board,
          sources: { ...withBlocks, l2OutputRoot: "local-file" },
        };
  }
  if (format !== BUNDLE_FORMAT && format !== BUNDLE_FORMAT_L1)
    throw new BundleError(
      `bundle.json: format must be ${BUNDLE_FORMAT}, ${BUNDLE_FORMAT_L1}, ${BUNDLE_FORMAT_DEFINITION}, ${BUNDLE_FORMAT_CEREMONY}, ${BUNDLE_FORMAT_BLOCKS} or ${BUNDLE_FORMAT_L2}`,
    );
  const b = object(
    value,
    format === BUNDLE_FORMAT
      ? ["format", "electionId", "boardEntryVersion", "clock", "now", "anchors"]
      : ["format", "electionId", "boardEntryVersion", "clock", "l1"],
    "bundle.json",
  );
  if (b["boardEntryVersion"] !== 1)
    throw new BundleError("bundle.json: boardEntryVersion must be the number 1");
  const common = {
    electionId: hex32(b["electionId"], "electionId"),
    boardEntryVersion: 1,
    clock: parseClock(b["clock"]),
  } as const;
  if (format === BUNDLE_FORMAT_L1) {
    const l1 = parseL1(b["l1"]);
    const split = splitEntries(board);
    return {
      format,
      ...common,
      l1,
      entries: split.entries,
      unreadableBytes: split.unreadableBytes,
      sources: {
        electionId: "local-file",
        boardEntryVersion: "local-file",
        clock: "local-file",
        now: "l1-state-proof",
        anchors: "l1-state-proof",
        l1Header: "local-file",
        anchorAddress: "local-file",
        firstSegment: "local-file",
      },
    };
  }
  const anchors = array(b["anchors"], "anchors");
  const split = splitEntries(board);
  return {
    format,
    ...common,
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
