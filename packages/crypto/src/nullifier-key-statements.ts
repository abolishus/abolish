// The statements the group registry checks for the Tier 2 scope's nullifier
// keys (docs/spec/nullifier-key.md, Approval; docs/spec/nullifier-reshare.md,
// Approval and Consent): an initial key's approval, a successor's approval and
// the old panel's consent, each binding the run's deadline (T-54, T-37).
// Shared by nullifier-key.ts and nullifier-reshare.ts, which sign them, and
// nullifier-key-registry.ts, which checks the registry's records of them.

import { bytesFixed, encode, struct, u64, u8 } from "./codec.ts";
import { PARAMETERS } from "./parameters.ts";

const { MAX_TRUSTEES } = PARAMETERS;

const KEY_APPROVAL_TAG = "abolish/v1/sig/nullifier-key-approval-3";
const RESHARE_APPROVAL_TAG = "abolish/v1/sig/nullifier-reshare-approval-2";
const CONSENT_TAG = "abolish/v1/sig/nullifier-reshare-consent";

/** The scope a statement is for: the chain and the group registry. */
export interface NullifierKeyRegistryScope {
  readonly l2ChainId: bigint;
  readonly groupRegistry: Uint8Array;
}

const KEY_APPROVAL = struct([
  ["l2_chain_id", u64],
  ["group_registry", bytesFixed(20)],
  ["panel_id", bytesFixed(32)],
  ["index", u8],
  ["key_id", bytesFixed(32)],
  ["deadline", u64],
] as const);

const RESHARE_APPROVAL = struct([
  ["l2_chain_id", u64],
  ["group_registry", bytesFixed(20)],
  ["new_panel_id", bytesFixed(32)],
  ["index", u8],
  ["predecessor", bytesFixed(32)],
  ["key_id", bytesFixed(32)],
  ["deadline", u64],
] as const);

const CONSENT = struct([
  ["l2_chain_id", u64],
  ["group_registry", bytesFixed(20)],
  ["old_panel_id", bytesFixed(32)],
  ["index", u8],
  ["predecessor", bytesFixed(32)],
  ["new_panel_id", bytesFixed(32)],
  ["key_id", bytesFixed(32)],
  ["deadline", u64],
] as const);

function seatArg(index: number): number {
  if (!Number.isSafeInteger(index) || index < 1 || index > MAX_TRUSTEES)
    throw new RangeError(`nullifier key registry: index must be a seat from 1 to ${MAX_TRUSTEES}`);
  return index;
}

/**
 * The 101-byte statement seat `index` of the initial panel signs under
 * `abolish/v1/sig/nullifier-key-approval-3` (docs/spec/nullifier-key.md,
 * Approval). The deadline is in it because the registry can't read it from
 * `key_id` (The deadline is in the statement; T-54).
 */
export function nullifierKeyApprovalStatement(
  scope: NullifierKeyRegistryScope,
  panel: Uint8Array,
  index: number,
  keyId: Uint8Array,
  deadline: bigint,
): Uint8Array {
  return encode(KEY_APPROVAL, {
    l2_chain_id: scope.l2ChainId,
    group_registry: scope.groupRegistry,
    panel_id: panel,
    index: seatArg(index),
    key_id: keyId,
    deadline,
  });
}

/**
 * The 133-byte statement new seat `index` signs under
 * `abolish/v1/sig/nullifier-reshare-approval-2` (docs/spec/nullifier-reshare.md,
 * Approval).
 */
export function nullifierReshareApprovalStatement(
  scope: NullifierKeyRegistryScope,
  newPanel: Uint8Array,
  index: number,
  predecessor: Uint8Array,
  keyId: Uint8Array,
  deadline: bigint,
): Uint8Array {
  return encode(RESHARE_APPROVAL, {
    l2_chain_id: scope.l2ChainId,
    group_registry: scope.groupRegistry,
    new_panel_id: newPanel,
    index: seatArg(index),
    predecessor,
    key_id: keyId,
    deadline,
  });
}

/**
 * The 165-byte statement old seat `index` signs under
 * `abolish/v1/sig/nullifier-reshare-consent` (docs/spec/nullifier-reshare.md,
 * Consent): the old panel's agreement to the succession, on chain, since the
 * registry can't count qualified dealers (T-37, T-40).
 */
export function nullifierReshareConsentStatement(
  scope: NullifierKeyRegistryScope,
  oldPanel: Uint8Array,
  index: number,
  predecessor: Uint8Array,
  newPanel: Uint8Array,
  keyId: Uint8Array,
  deadline: bigint,
): Uint8Array {
  return encode(CONSENT, {
    l2_chain_id: scope.l2ChainId,
    group_registry: scope.groupRegistry,
    old_panel_id: oldPanel,
    index: seatArg(index),
    predecessor,
    new_panel_id: newPanel,
    key_id: keyId,
    deadline,
  });
}

/** @internal The three statements' tags, for the modules that sign and check them. */
export const STATEMENT_TAGS = {
  keyApproval: KEY_APPROVAL_TAG,
  reshareApproval: RESHARE_APPROVAL_TAG,
  consent: CONSENT_TAG,
} as const;
