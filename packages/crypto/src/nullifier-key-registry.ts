// The group registry's record of the Tier 2 scope's nullifier keys
// (docs/spec/contracts.md, Group registry, Nullifier keys): the statements an
// initial key's approvals, a successor's approvals and the old panel's
// consents sign, the two records `recordNullifierKey` and
// `recordNullifierReshare` take, and the registry's checks replayed over its
// log, for the verifier ([[verifier]] 2.4) and the trustee node. The contract
// applies the same rules to the same bytes, and both are checked against
// docs/spec/vectors/nullifier-key-registry.json. ECDSA is @noble's, through
// trustee.ts; this module only fixes the encodings and the checks
// (T-03, T-54, T-31, T-71).

import { Reader } from "./codec.ts";
import { MAX_KEY_WINDOW } from "./nullifier-key.ts";
import {
  type NullifierKeyRegistryScope,
  nullifierKeyApprovalStatement,
  nullifierReshareApprovalStatement,
  nullifierReshareConsentStatement,
  STATEMENT_TAGS,
} from "./nullifier-key-statements.ts";
import { MAX_RESHARE_WINDOW } from "./nullifier-reshare.ts";
import { type Panel, panelId, verifyStatement } from "./trustee.ts";

const MAX_U64 = (1n << 64n) - 1n;
const APPROVAL = 65; // u8(index) ‖ p256-sig
const KEY_HEADER = 41; // u64(deadline) ‖ key_id ‖ u8(count)
const RESHARE_HEADER = 105; // predecessor ‖ new_panel_id ‖ u64(deadline) ‖ key_id ‖ u8(consents)

/** One seat's signature in a record, as the record carries it. */
export interface SeatSignature {
  readonly index: number;
  readonly signature: Uint8Array;
}

/** `recordNullifierKey`'s record: `u64(deadline) ‖ key_id ‖ u8(count) ‖ approval × count`. */
export interface NullifierKeyRecord {
  readonly deadline: bigint;
  readonly keyId: Uint8Array;
  readonly approvals: readonly SeatSignature[];
}

/**
 * `recordNullifierReshare`'s record: `predecessor ‖ new_panel_id ‖ u64(deadline) ‖
 * key_id ‖ u8(consents) ‖ approval × consents ‖ u8(count) ‖ approval × count`.
 */
export interface NullifierReshareRecord {
  readonly predecessor: Uint8Array;
  readonly newPanelId: Uint8Array;
  readonly deadline: bigint;
  readonly keyId: Uint8Array;
  readonly consents: readonly SeatSignature[];
  readonly approvals: readonly SeatSignature[];
}

function bytesArg(v: unknown, length: number, name: string): Uint8Array {
  if (!(v instanceof Uint8Array) || !ArrayBuffer.isView(v) || v.length !== length)
    throw new RangeError(`nullifier key registry: ${name} must be ${length} bytes`);
  return Uint8Array.from(v);
}

function deadlineArg(v: unknown): bigint {
  if (typeof v !== "bigint" || v < 0n || v > MAX_U64)
    throw new RangeError("nullifier key registry: deadline must be a u64");
  return v;
}

function writeSignatures(out: number[], list: readonly SeatSignature[], name: string): void {
  if (!Array.isArray(list) || list.length > 255)
    throw new RangeError(`nullifier key registry: at most 255 ${name}`);
  out.push(list.length);
  for (const { index, signature } of list.slice()) {
    // Any byte, so a test can encode the out-of-range seats the registry refuses.
    if (!Number.isSafeInteger(index) || index < 0 || index > 255)
      throw new RangeError(`nullifier key registry: a ${name} index must be a byte`);
    out.push(index, ...bytesArg(signature, 64, "a signature"));
  }
}

function u64Bytes(v: bigint): number[] {
  return Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(56 - 8 * i)) & 0xffn));
}

export function encodeNullifierKeyRecord(record: NullifierKeyRecord): Uint8Array {
  const { deadline, keyId, approvals } = record;
  const out = [...u64Bytes(deadlineArg(deadline)), ...bytesArg(keyId, 32, "keyId")];
  writeSignatures(out, approvals, "approvals");
  return Uint8Array.from(out);
}

export function encodeNullifierReshareRecord(record: NullifierReshareRecord): Uint8Array {
  const { predecessor, newPanelId, deadline, keyId, consents, approvals } = record;
  const out = [
    ...bytesArg(predecessor, 32, "predecessor"),
    ...bytesArg(newPanelId, 32, "newPanelId"),
    ...u64Bytes(deadlineArg(deadline)),
    ...bytesArg(keyId, 32, "keyId"),
  ];
  writeSignatures(out, consents, "consents");
  writeSignatures(out, approvals, "approvals");
  return Uint8Array.from(out);
}

function copyRecord(bytes: unknown): Uint8Array {
  if (!(bytes instanceof Uint8Array) || !ArrayBuffer.isView(bytes))
    throw new TypeError("nullifier key registry: expected a Uint8Array");
  // Copied once, so the length checked is the length read.
  return new Uint8Array(bytes);
}

function readU64(r: Reader): bigint {
  let v = 0n;
  for (const x of r.take(8)) v = (v << 8n) | BigInt(x);
  return v;
}

function readSignatures(r: Reader, count: number): SeatSignature[] {
  const out: SeatSignature[] = [];
  for (let i = 0; i < count; i++)
    out.push({ index: r.uint(1), signature: Uint8Array.from(r.take(64)) });
  return out;
}

/**
 * Decodes a `recordNullifierKey` record: `null` unless it is exactly
 * `41 + 65 · count` bytes (check 2), the only check that needs no state.
 */
export function decodeNullifierKeyRecord(bytes: Uint8Array): NullifierKeyRecord | null {
  const b = copyRecord(bytes);
  if (b.length < KEY_HEADER) return null;
  const count = b[KEY_HEADER - 1] as number;
  if (b.length !== KEY_HEADER + APPROVAL * count) return null;
  const r = new Reader(b);
  const deadline = readU64(r);
  const keyId = Uint8Array.from(r.take(32));
  r.uint(1);
  const approvals = readSignatures(r, count);
  r.end();
  return { deadline, keyId, approvals };
}

/**
 * Decodes a `recordNullifierReshare` record: `null` unless it is at least
 * 105 bytes, at least `106 + 65 · consents`, and exactly
 * `106 + 65 · (consents + count)` (check 2).
 */
export function decodeNullifierReshareRecord(bytes: Uint8Array): NullifierReshareRecord | null {
  const b = copyRecord(bytes);
  if (b.length < RESHARE_HEADER) return null;
  const consents = b[RESHARE_HEADER - 1] as number;
  const countAt = RESHARE_HEADER + APPROVAL * consents;
  if (b.length < countAt + 1) return null;
  const count = b[countAt] as number;
  if (b.length !== countAt + 1 + APPROVAL * count) return null;
  const r = new Reader(b);
  const predecessor = Uint8Array.from(r.take(32));
  const newPanelId = Uint8Array.from(r.take(32));
  const deadline = readU64(r);
  const keyId = Uint8Array.from(r.take(32));
  const c = readSignatures(r, r.uint(1));
  const a = readSignatures(r, r.uint(1));
  r.end();
  return { predecessor, newPanelId, deadline, keyId, consents: c, approvals: a };
}

/** What the replay checks a log against: the release's pins. */
export interface NullifierKeyReplayPins extends NullifierKeyRegistryScope {
  /** The scope's initial panel, which the registry's `initialPanelId` immutable must name. */
  readonly initialPanel: Panel;
  /** Every panel the deployment's trustee registry pins, the initial panel among them. */
  readonly panels: readonly Panel[];
}

/** One logged nullifier-key record, in log order, with its event's topics and the L2 block its log carries. */
export type NullifierKeyLogRecord =
  | {
      readonly kind: "initial";
      readonly l2Block: bigint;
      readonly keyId: Uint8Array;
      readonly record: Uint8Array;
    }
  | {
      readonly kind: "reshare";
      readonly l2Block: bigint;
      readonly predecessor: Uint8Array;
      readonly keyId: Uint8Array;
      readonly newPanelId: Uint8Array;
      readonly record: Uint8Array;
    };

/** A key the registry recorded, in the chain from the initial key. */
export interface RecordedNullifierKey {
  readonly keyId: Uint8Array;
  readonly panelId: Uint8Array;
  readonly deadline: bigint;
  readonly l2Block: bigint;
  /** `null` for the initial key. */
  readonly predecessor: Uint8Array | null;
}

/**
 * Why a logged record breaks the chain, in the order the replay reports it:
 * the record's length, then its event's topics, then the registry's own
 * checks in its order.
 */
export type NullifierKeyHistoryReason =
  | "length"
  | "topic"
  | "key-recorded"
  | "predecessor"
  | "panel"
  | "deadline"
  | "key-id"
  | "quorum"
  | "seat"
  | "signature";

export type NullifierKeyReplayResult =
  | { readonly ok: true; readonly keys: readonly RecordedNullifierKey[] }
  | {
      readonly ok: false;
      /** The first failing record's position in the log. */
      readonly at: number;
      readonly reason: NullifierKeyHistoryReason;
      /** The chain before it, which still stands; that record and every later one don't. */
      readonly keys: readonly RecordedNullifierKey[];
    };

interface PinnedPanel {
  readonly id: Uint8Array;
  readonly keys: readonly Uint8Array[];
  readonly quorum: number;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function pinnedPanel(panel: Panel): PinnedPanel {
  if (panel === null || typeof panel !== "object")
    throw new TypeError("nullifier key registry: expected a panel");
  const threshold = panel.threshold;
  const keys = Array.isArray(panel.keys) ? panel.keys.map((k) => Uint8Array.from(k)) : [];
  // panelId checks the panel's rules and throws on a panel that breaks them.
  const id = panelId({ threshold, keys });
  // `max(k, n − 1)` from the panel's own `k` and `n`, never a ceremony `q` ([[0006-trustees]] rule 7).
  return { id, keys, quorum: Math.max(threshold, keys.length - 1) };
}

// Checks 7 and 8 (a reshare's 8 and 9) for one list: seats strictly increasing
// from 1 to `n`, so each seat counts once, never each signature (T-31), and
// every signature verifying, including any beyond the quorum.
function signaturesCode(
  list: readonly SeatSignature[],
  panel: PinnedPanel,
  verify: (key: Uint8Array, index: number, signature: Uint8Array) => boolean,
): "seat" | "signature" | null {
  let last = 0;
  for (const { index, signature } of list) {
    if (index <= last || index > panel.keys.length) return "seat";
    last = index;
    if (!verify(panel.keys[index - 1] as Uint8Array, index, signature)) return "signature";
  }
  return null;
}

/**
 * The registry's checks over its log of nullifier-key records, replayed with
 * no state taken from the chain (docs/spec/contracts.md, Group registry,
 * Nullifier keys, and Verification): each record decodes strictly, its
 * event's topics equal its fields, the first is an initial key and every
 * later one a reshare of the key the one before made current, each deadline
 * lies from the record's block to at most the window beyond it, no `key_id`
 * repeats, and quorums of distinct seats' signatures verify under the pinned
 * panels. On an honest L2 history no logged record fails, so a failing one
 * was rewritten or comes from other code: the chain stops there (T-71, T-03).
 * What the registry can't check (each key's transcript, and that each new
 * panel is one the release allows as a successor) is the verifier's to add.
 */
export function replayNullifierKeyRecords(
  records: readonly NullifierKeyLogRecord[],
  pins: NullifierKeyReplayPins,
): NullifierKeyReplayResult {
  if (pins === null || typeof pins !== "object") throw new TypeError("pins: expected an object");
  // Each field read once, so a getter can't show one record one panel and the next another.
  const { l2ChainId, groupRegistry: registry, initialPanel, panels } = pins;
  const scope = { l2ChainId, groupRegistry: bytesArg(registry, 20, "groupRegistry") };
  const initial = pinnedPanel(initialPanel);
  if (!Array.isArray(panels)) throw new TypeError("pins.panels: expected an array");
  const pinned = new Map(panels.map((p) => pinnedPanel(p)).map((p) => [hex(p.id), p]));
  if (!pinned.has(hex(initial.id)))
    throw new RangeError("nullifier key registry: the trustee registry must pin the initial panel");
  if (!Array.isArray(records)) throw new TypeError("records: expected an array");

  const keys: RecordedNullifierKey[] = [];
  const recorded = new Set<string>();
  let current: { keyId: Uint8Array; panel: PinnedPanel } | null = null;
  const zero = (b: Uint8Array) => b.every((x) => x === 0);

  for (const [at, entry] of records.slice().entries()) {
    const fail = (reason: NullifierKeyHistoryReason): NullifierKeyReplayResult => ({
      ok: false,
      at,
      reason,
      keys: keys.slice(),
    });
    const { kind, l2Block } = entry;
    if (typeof l2Block !== "bigint" || l2Block < 0n)
      throw new TypeError(`records[${at}]: l2Block must be a non-negative bigint`);
    if (kind === "initial") {
      const r = decodeNullifierKeyRecord(entry.record);
      if (r === null) return fail("length");
      if (hex(bytesArg(entry.keyId, 32, "keyId")) !== hex(r.keyId)) return fail("topic");
      if (current !== null) return fail("key-recorded");
      if (r.deadline < l2Block || r.deadline > l2Block + MAX_KEY_WINDOW) return fail("deadline");
      if (zero(r.keyId)) return fail("key-id");
      if (r.approvals.length < initial.quorum) return fail("quorum");
      const code = signaturesCode(r.approvals, initial, (key, index, sig) =>
        verifyStatement(
          key,
          STATEMENT_TAGS.keyApproval,
          nullifierKeyApprovalStatement(scope, initial.id, index, r.keyId, r.deadline),
          sig,
        ),
      );
      if (code !== null) return fail(code);
      current = { keyId: r.keyId, panel: initial };
      recorded.add(hex(r.keyId));
      keys.push({
        keyId: r.keyId,
        panelId: initial.id,
        deadline: r.deadline,
        l2Block,
        predecessor: null,
      });
    } else if (kind === "reshare") {
      const r = decodeNullifierReshareRecord(entry.record);
      if (r === null) return fail("length");
      if (
        hex(bytesArg(entry.predecessor, 32, "predecessor")) !== hex(r.predecessor) ||
        hex(bytesArg(entry.keyId, 32, "keyId")) !== hex(r.keyId) ||
        hex(bytesArg(entry.newPanelId, 32, "newPanelId")) !== hex(r.newPanelId)
      )
        return fail("topic");
      if (current === null || hex(r.predecessor) !== hex(current.keyId)) return fail("predecessor");
      const next = pinned.get(hex(r.newPanelId));
      if (next === undefined) return fail("panel");
      if (r.deadline < l2Block || r.deadline > l2Block + MAX_RESHARE_WINDOW)
        return fail("deadline");
      if (zero(r.keyId)) return fail("key-id");
      if (recorded.has(hex(r.keyId))) return fail("key-recorded");
      const old = current.panel;
      if (r.consents.length < old.quorum || r.approvals.length < next.quorum) return fail("quorum");
      const code =
        signaturesCode(r.consents, old, (key, index, sig) =>
          verifyStatement(
            key,
            STATEMENT_TAGS.consent,
            nullifierReshareConsentStatement(
              scope,
              old.id,
              index,
              r.predecessor,
              next.id,
              r.keyId,
              r.deadline,
            ),
            sig,
          ),
        ) ??
        signaturesCode(r.approvals, next, (key, index, sig) =>
          verifyStatement(
            key,
            STATEMENT_TAGS.reshareApproval,
            nullifierReshareApprovalStatement(
              scope,
              next.id,
              index,
              r.predecessor,
              r.keyId,
              r.deadline,
            ),
            sig,
          ),
        );
      if (code !== null) return fail(code);
      current = { keyId: r.keyId, panel: next };
      recorded.add(hex(r.keyId));
      keys.push({
        keyId: r.keyId,
        panelId: next.id,
        deadline: r.deadline,
        l2Block,
        predecessor: r.predecessor,
      });
    } else throw new TypeError(`records[${at}]: kind must be "initial" or "reshare"`);
  }
  return { ok: true, keys };
}
