// The deployment record (docs/spec/deployment.md, record type 0x0020): what a
// ballot-client release is built for, as one record, its strict decoding,
// its deployment hash, the well-formedness rules of versions 1 and 2, and
// version 2's rules for the Tier 0 token keys across releases. A release
// binds the record by hash, so whoever reads the release reads the pins its
// client runs with (T-34, T-37, T-71, T-43), and from version 2 the issuer's
// key for each period, which a client takes from its release and nowhere
// else (T-74, T-10). The rules check only what the record says about itself:
// that the contracts and keys behind it are the ones it names is the
// verifier's and the release Safe's signers' (T-64).

import {
  bool,
  bytesFixed,
  bytesVar,
  type CodecValue,
  decode,
  DecodeError,
  enum8,
  list,
  struct,
  u8,
  u32,
  u64,
} from "./codec.ts";
import { ds } from "./domain-separation.ts";
import { element, H } from "./group.ts";
import { PARAMETERS } from "./parameters.ts";
import { type DecodedRecord, RECORD_TYPES, RecordSchema, recordType, UNPINNED } from "./record.ts";
// The origin and host grammar is release.md's (Well-formedness).
import {
  ascending,
  distinct,
  isHost,
  isOrigin,
  isZero,
  ORIGIN_PREFIX,
  sameBytes,
} from "./release.ts";
import { PanelError, panelId } from "./trustee.ts";

/** The record's bounds (docs/spec/deployment.md, Record and Record (version 2)). */
export const DEPLOYMENT_LIMITS = Object.freeze({
  gameTypes: 8,
  registrars: 16,
  panels: 8,
  seats: 16,
  groups: 64,
  origins: 4,
  origin: 267,
  rpId: 253,
  tokenKeys: 16,
} as const);

/** `panel`'s `kind`. */
export const PANEL_KINDS = Object.freeze({ independent: 1, transitional: 2 } as const);

const address = bytesFixed(20);

const seat = struct([
  // bytes[33] rather than p256-key, so a bad key decodes and fails
  // `panel-key` rather than the whole record failing to decode.
  ["key", bytesFixed(33)],
  ["ours", bool],
] as const);

const panel = struct([
  ["kind", enum8([PANEL_KINDS.independent, PANEL_KINDS.transitional])],
  ["threshold", u8],
  ["seats", list(seat, DEPLOYMENT_LIMITS.seats)],
] as const);

const group = struct([
  ["group_id", u64],
  ["tier", enum8([0, 1])],
  ["self_paid", bool],
  ["region", u32],
] as const);

const origins = list(bytesVar(DEPLOYMENT_LIMITS.origin), DEPLOYMENT_LIMITS.origins);

const V1_FIELDS = [
  ["l1_chain_id", u64],
  ["l2_chain_id", u64],
  ["election_registry", address],
  ["board", address],
  ["trustee_registry", address],
  ["group_registry", address],
  ["l2_from_block", u64],
  ["l2_max_sequencer_drift", u64],
  ["l1_anchor", address],
  ["l1_relay", address],
  ["l1_portal", address],
  ["dispute_game_types", list(u32, DEPLOYMENT_LIMITS.gameTypes)],
  ["anchor_epoch", u64],
  ["anchor_period", u64],
  ["anchor_deadline", u64],
  ["anchor_authority", address],
  ["contracts_commit", bytesFixed(20)],
  ["registrar_threshold", u8],
  ["registrars", list(address, DEPLOYMENT_LIMITS.registrars)],
  ["initial_panel", bytesFixed(32)],
  ["panels", list(panel, DEPLOYMENT_LIMITS.panels)],
  ["groups", list(group, DEPLOYMENT_LIMITS.groups)],
  ["api", origins],
  ["l2_rpc", origins],
  ["l1_rpc", origins],
  ["backup_rp_id", bytesVar(DEPLOYMENT_LIMITS.rpId)],
  ["backups", bool],
  ["account_rp_id", bytesVar(DEPLOYMENT_LIMITS.rpId)],
  ["membership_zkey_sha256", bytesFixed(32)],
  ["membership_wasm_sha256", bytesFixed(32)],
] as const;

const tokenKey = struct([
  ["period", u32],
  // bytes[32] rather than element, so a bad key decodes and fails `token-key`.
  ["key", bytesFixed(32)],
  ["retired", bool],
] as const);

const deploymentV1 = struct(V1_FIELDS);
// Version 1 with one field appended; every version-1 field keeps its place.
const deploymentV2 = struct([
  ...V1_FIELDS,
  ["tier0_token_keys", list(tokenKey, DEPLOYMENT_LIMITS.tokenKeys)],
] as const);

export type DeploymentRecord = CodecValue<typeof deploymentV1>;
export type DeploymentRecordV2 = CodecValue<typeof deploymentV2>;
export type DeploymentPanel = CodecValue<typeof panel>;
export type DeploymentGroup = CodecValue<typeof group>;
export type DeploymentTokenKey = CodecValue<typeof tokenKey>;

/** Record type `0x0020`, versions 1 and 2. Never on the board, and no profile pins it. */
export const DEPLOYMENT_RECORD = recordType(RECORD_TYPES.deploymentRecord, {
  1: deploymentV1,
  2: deploymentV2,
});

export type DecodedDeploymentRecord = DecodedRecord<(typeof DEPLOYMENT_RECORD)["versions"]>;

// 0x0020 is the only type this decoder knows, so any other is
// `unknown-record-type`, a release record's included (Decoding).
const SCHEMA = new RecordSchema([DEPLOYMENT_RECORD]);

export function encodeDeploymentRecord(record: DecodedDeploymentRecord): Uint8Array {
  return record.version === 1
    ? SCHEMA.encode(DEPLOYMENT_RECORD, 1, record.value)
    : SCHEMA.encode(DEPLOYMENT_RECORD, 2, record.value);
}

/**
 * Strictly decodes a deployment record of either version. A deployment
 * belongs to no election, so no profile pins its version (Decoding): the
 * caller reads `version`, and a version-1 record lists no token key.
 */
export function decodeDeploymentRecord(bytes: Uint8Array): DecodedDeploymentRecord {
  return SCHEMA.decode(DEPLOYMENT_RECORD, bytes, UNPINNED);
}

/**
 * `deployment_hash = H(DS("abolish/v1/deployment", encode(record)))`, over
 * the whole encoding, header included, so a version-1 and a version-2 record
 * of one deployment have different hashes (Deployment hash). `encoding` is
 * hashed as given: pass only bytes `decodeDeploymentRecord` accepted, so the
 * hash is always of some record's one encoding (T-31).
 */
export function deploymentHash(encoding: Uint8Array): Uint8Array {
  if (!(encoding instanceof Uint8Array))
    throw new TypeError("deploymentHash: encoding must be bytes");
  return H(ds("abolish/v1/deployment", encoding));
}

/** The origin lists, in the order the rules check them. */
export const DEPLOYMENT_ORIGIN_LISTS = Object.freeze(["api", "l2_rpc", "l1_rpc"] as const);
export type DeploymentOriginList = (typeof DEPLOYMENT_ORIGIN_LISTS)[number];

/** Version 1's well-formedness codes, in checking order. */
export const DEPLOYMENT_RULES = Object.freeze([
  "chain-id",
  "address",
  "clock",
  "drift",
  "game-types",
  "registrar-size",
  "registrar-threshold",
  "registrar-order",
  "panels-empty",
  "panel-threshold",
  "panel-key",
  "panel-duplicate-key",
  "panel-kind",
  "panel-order",
  "initial-panel",
  "groups-empty",
  "group-self-paid",
  "group-order",
  "group-repeated",
  "group-region",
  "origin",
  "origin-order",
  "origin-missing",
  "origin-shared",
  "rp-id",
  "rp-id-shared",
  "endpoint-rp",
] as const);

/** Version 2's codes after version 1's, in checking order. */
export const DEPLOYMENT_V2_RULES = Object.freeze([
  "token-keys-empty",
  "token-key",
  "token-key-repeated",
  "token-key-order",
] as const);

export type DeploymentRule =
  | (typeof DEPLOYMENT_RULES)[number]
  | (typeof DEPLOYMENT_V2_RULES)[number];

/**
 * The first rule a record breaks, with where, as the spec names it: a panel
 * or group by its index, an origin rule by its list, an `rp-id` by its field,
 * a token key by its index in `tier0_token_keys`.
 */
export type DeploymentFailure =
  | {
      readonly rule: "panel-threshold" | "panel-key" | "panel-duplicate-key" | "panel-kind";
      readonly panel: number;
    }
  | { readonly rule: "group-self-paid"; readonly group: number }
  | {
      readonly rule: "origin" | "origin-order" | "origin-missing";
      readonly list: DeploymentOriginList;
    }
  | { readonly rule: "rp-id"; readonly field: "backup_rp_id" | "account_rp_id" }
  | { readonly rule: "token-key" | "token-key-repeated"; readonly key: number }
  | {
      readonly rule: Exclude<
        DeploymentRule,
        | "panel-threshold"
        | "panel-key"
        | "panel-duplicate-key"
        | "panel-kind"
        | "group-self-paid"
        | "origin"
        | "origin-order"
        | "origin-missing"
        | "rp-id"
        | "token-key"
        | "token-key-repeated"
      >;
    };

/**
 * The first well-formedness rule a decoded record breaks (docs/spec/
 * deployment.md, Well-formedness, and for version 2, Well-formedness
 * (version 2)), or `undefined` if it is well formed. A reader rejects an
 * ill-formed record with this rule; a deployment with no well-formed record
 * has no release.
 */
export function deploymentRecordRule(
  record: DecodedDeploymentRecord,
): DeploymentFailure | undefined {
  return record.version === 1 ? v1Rule(record.value) : v2Rule(record.value);
}

function v1Rule(d: DeploymentRecord): DeploymentFailure | undefined {
  const head = headRule(d);
  if (head !== undefined) return { rule: head };
  return panelsRule(d) ?? groupsRule(d.groups) ?? originsRule(d) ?? rpIdsRule(d);
}

type HeadRule =
  | "chain-id"
  | "address"
  | "clock"
  | "drift"
  | "game-types"
  | "registrar-size"
  | "registrar-threshold"
  | "registrar-order"
  | "panels-empty";

function headRule(d: DeploymentRecord): HeadRule | undefined {
  // election-definition's `chain` rule, so every definition of this
  // deployment can pass it.
  if (d.l1_chain_id === 0n || d.l2_chain_id === 0n || d.l1_chain_id === d.l2_chain_id)
    return "chain-id";
  const l2 = [d.election_registry, d.board, d.trustee_registry, d.group_registry];
  const l1 = [d.l1_anchor, d.l1_relay, d.l1_portal, d.anchor_authority];
  if ([...l2, ...l1].some(isZero) || !distinct(l2) || !distinct(l1)) return "address";
  // With a zero deadline no anchor could ever count (board.md, Timing).
  if (d.anchor_period === 0n || d.anchor_deadline === 0n) return "clock";
  const drift = d.l2_max_sequencer_drift;
  if (drift === 0n || drift > BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT)) return "drift";
  // With no type counted, every close statement's floor would be unknown.
  const types = d.dispute_game_types;
  if (types.length === 0 || !types.every((t, i) => i === 0 || t > (types[i - 1] as number)))
    return "game-types";
  const n = d.registrars.length;
  if (n < 2) return "registrar-size";
  // T-62: no single registrar key adds or removes members.
  if (d.registrar_threshold < 2 || d.registrar_threshold > n) return "registrar-threshold";
  if (d.registrars.some(isZero) || !ascending(d.registrars)) return "registrar-order";
  if (d.panels.length === 0) return "panels-empty";
  return undefined;
}

const PANEL_RULES: Readonly<
  Record<string, "panel-threshold" | "panel-key" | "panel-duplicate-key">
> = {
  threshold: "panel-threshold",
  key: "panel-key",
  "duplicate-key": "panel-duplicate-key",
};

function panelsRule(d: DeploymentRecord): DeploymentFailure | undefined {
  const ids: Uint8Array[] = [];
  for (const [i, p] of d.panels.entries()) {
    // trustee-identity's own check, in its order: the threshold, then seat by
    // seat the key and whether an earlier seat has it (T-14, T-37).
    try {
      ids.push(panelId({ threshold: p.threshold, keys: p.seats.map((s) => s.key) }));
    } catch (e) {
      // `size` can't occur: the list's bound is MAX_TRUSTEES.
      const rule = e instanceof PanelError ? PANEL_RULES[e.code] : undefined;
      if (rule === undefined) throw e;
      return { rule, panel: i };
    }
    // 0006-trustees rule 3: at most one seat of an independent panel is ours.
    if (p.kind === PANEL_KINDS.independent && p.seats.filter((s) => s.ours).length > 1)
      return { rule: "panel-kind", panel: i };
  }
  if (!ascending(ids)) return { rule: "panel-order" };
  if (!ids.some((id) => sameBytes(id, d.initial_panel))) return { rule: "initial-panel" };
  return undefined;
}

function groupsRule(groups: readonly DeploymentGroup[]): DeploymentFailure | undefined {
  if (groups.length === 0) return { rule: "groups-empty" };
  // createSelfPaidGroup creates only Tier 0 groups.
  for (const [i, g] of groups.entries())
    if (g.self_paid && g.tier !== 0) return { rule: "group-self-paid", group: i };
  if (!groups.every((g, i) => i === 0 || g.group_id > (groups[i - 1] as DeploymentGroup).group_id))
    return { rule: "group-order" };
  const kinds = groups.map((g) => `${g.region}:${g.tier}:${g.self_paid}`);
  if (new Set(kinds).size !== kinds.length) return { rule: "group-repeated" };
  // A region the service registers in has a signed and a self-paid Tier 0
  // group, so a registrant who goes direct is in the same electorates.
  for (const g of groups)
    if (!kinds.includes(`${g.region}:0:false`) || !kinds.includes(`${g.region}:0:true`))
      return { rule: "group-region" };
  return undefined;
}

function originsRule(d: DeploymentRecord): DeploymentFailure | undefined {
  for (const name of DEPLOYMENT_ORIGIN_LISTS) {
    const list = d[name];
    if (!list.every(isOrigin)) return { rule: "origin", list: name };
    if (!ascending(list)) return { rule: "origin-order", list: name };
    if (list.length === 0) return { rule: "origin-missing", list: name };
  }
  // Each request goes to an origin trusted for that purpose only, and the
  // CSP's connect-src can't tell the lists apart.
  if (!distinct(DEPLOYMENT_ORIGIN_LISTS.flatMap((name) => d[name])))
    return { rule: "origin-shared" };
  return undefined;
}

function rpIdsRule(d: DeploymentRecord): DeploymentFailure | undefined {
  for (const field of ["backup_rp_id", "account_rp_id"] as const)
    if (!isHost(d[field])) return { rule: "rp-id", field };
  const backup = d.backup_rp_id;
  const account = d.account_rp_id;
  // T-20: no page of apps/web can evaluate the backup passkey's PRF.
  if (isUnder(backup, account) || isUnder(account, backup)) return { rule: "rp-id-shared" };
  // T-20: an endpoint under the backup's RP ID could ask for an assertion
  // under it and open a voter's backup.
  const endpoints = DEPLOYMENT_ORIGIN_LISTS.flatMap((name) => d[name]);
  if (endpoints.some((o) => isUnder(hostOf(o), backup))) return { rule: "endpoint-rp" };
  return undefined;
}

function v2Rule(d: DeploymentRecordV2): DeploymentFailure | undefined {
  const v1 = v1Rule(d);
  if (v1 !== undefined) return v1;
  const keys = d.tier0_token_keys;
  // A version-2 client registers a voter only with a token.
  if (keys.length === 0) return { rule: "token-keys-empty" };
  for (const [i, k] of keys.entries()) {
    // The client's Blind refuses the identity and any non-canonical encoding.
    if (!isElement(k.key)) return { rule: "token-key", key: i };
    // T-74: a key listed for two periods would outlive its window.
    if (keys.slice(0, i).some((e) => sameBytes(e.key, k.key)))
      return { rule: "token-key-repeated", key: i };
  }
  // One key per period, and no period inside the list without one: a key
  // retired early stays listed with `retired` set.
  if (!keys.every((k, i) => i === 0 || k.period === (keys[i - 1] as DeploymentTokenKey).period + 1))
    return { rule: "token-key-order" };
  return undefined;
}

/** Version 2's rules across releases, in checking order. */
export const DEPLOYMENT_ACROSS_RULES = Object.freeze([
  "token-key-changed",
  "token-key-reused",
  "token-key-unretired",
] as const);

export interface DeploymentAcrossFailure {
  readonly rule: (typeof DEPLOYMENT_ACROSS_RULES)[number];
  /** The period of the later record the rule is broken at, the lowest such. */
  readonly period: number;
}

/**
 * The first rule of Across releases two well-formed version-2 records break,
 * `earlier` being the one named by the release published first on L1, or
 * `undefined`. A period's key is fixed once a release lists it and belongs
 * to that period alone, and a retirement stands (T-74, T-10). A version-1
 * record lists no key, so has nothing to compare: pass only version 2, and
 * only records `deploymentRecordRule` accepted.
 */
export function deploymentAcrossRule(
  earlier: DeploymentRecordV2,
  later: DeploymentRecordV2,
): DeploymentAcrossFailure | undefined {
  // The caller checked both with deploymentRecordRule. Only the shape the
  // comparison relies on is checked again (one key per consecutive period,
  // no key twice), so a verifier comparing every pair of releases doesn't
  // redo every rule's point decoding for each pair (T-52).
  for (const [name, r] of [
    ["earlier", earlier],
    ["later", later],
  ] as const) {
    const keys = r.tier0_token_keys;
    if (
      keys.length === 0 ||
      !keys.every(
        (k, i) => i === 0 || k.period === (keys[i - 1] as DeploymentTokenKey).period + 1,
      ) ||
      !keys.every((k, i) => keys.slice(0, i).every((e) => !sameBytes(e.key, k.key)))
    )
      throw new RangeError(`deploymentAcrossRule: the ${name} record is ill formed`);
  }
  const before = new Map(earlier.tier0_token_keys.map((k) => [k.period, k]));
  // Well formed, so the later's periods ascend: the first hit is the lowest.
  for (const k of later.tier0_token_keys) {
    const e = before.get(k.period);
    if (e !== undefined && !sameBytes(e.key, k.key))
      return { rule: "token-key-changed", period: k.period };
  }
  for (const k of later.tier0_token_keys)
    if (earlier.tier0_token_keys.some((e) => sameBytes(e.key, k.key) && e.period !== k.period))
      return { rule: "token-key-reused", period: k.period };
  for (const k of later.tier0_token_keys)
    if (before.get(k.period)?.retired === true && !k.retired)
      return { rule: "token-key-unretired", period: k.period };
  return undefined;
}

// Only called on origins that passed `isOrigin`.
function hostOf(origin: Uint8Array): Uint8Array {
  const rest = origin.subarray(ORIGIN_PREFIX.length);
  const colon = rest.indexOf(0x3a);
  return colon < 0 ? rest : rest.subarray(0, colon);
}

// Whether host `a` is `b` or ends with "." followed by it.
function isUnder(a: Uint8Array, b: Uint8Array): boolean {
  if (sameBytes(a, b)) return true;
  const at = a.length - b.length - 1;
  return at >= 0 && a[at] === 0x2e && sameBytes(a.subarray(at + 1), b);
}

function isElement(b: Uint8Array): boolean {
  try {
    decode(element, b);
    return true;
  } catch (e) {
    if (e instanceof DecodeError) return false;
    throw e;
  }
}
