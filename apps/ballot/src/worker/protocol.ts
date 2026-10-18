// The messages between the page and the ballot worker. Versioned, so a page
// and a worker from different builds (a stale cache) refuse each other rather
// than misread a message. Each request carries an id its response repeats.
//
// The worker holds what must never leave the device (the identity secret
// while it builds a membership proof's witness, and the plaintext choice
// and its randomness in a seal), and the page does all I/O. A worker
// takes no CSP from the page's <meta>, so on a host that sends no CSP header
// nothing in the browser restricts it: only the absence of network APIs from
// its bytes keeps it off the network (T-43).

import type {
  BallotV2Code,
  ContractEventVersion,
  MembershipProverErrorCode,
  Panel,
  Tier0Registration,
  TierMembershipErrorCode,
  VoterCellCode,
} from "@abolishus/crypto";

import type { ElectionCheck } from "../election.ts";

export const PROTOCOL_VERSION = 7;

/**
 * How long the prover may take. Generous: a proof took 24 s in Chromium at
 * 6× CPU throttling (P2-21 part 1), and a slow phone may take longer.
 */
export const PROVER_TIMEOUT_MS = 180_000;

export interface CheckElectionRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "check-election";
  readonly electionId: Uint8Array;
  /** The definition hash the L2 election registry holds for `electionId`. */
  readonly registeredHash: Uint8Array;
  readonly definition: Uint8Array;
  readonly displayText: Uint8Array;
  /**
   * Board entries that may carry the election's ceremony transcript (the
   * board's first, where the operator boards it), and the panels this build
   * pins: a version-5 poll is shown only once its transcript checks under
   * the panel it names (`sealingElectionV5`; T-37, T-54).
   */
  readonly entries: readonly Uint8Array[];
  readonly panels: readonly Panel[];
}

/**
 * Seals `votes` (0 or 1 per option, every question's options in order) in
 * `cell` of the version-5 poll the worker last checked, which
 * `definitionHash` must name: the worker keeps the seal and answers with its
 * tracking code (docs/spec/challenge.md, Client rules; T-42).
 */
export interface SealRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "seal";
  readonly definitionHash: Uint8Array;
  readonly cell: number;
  readonly votes: readonly (0 | 1)[];
}

/**
 * Finds the voter's cell in the version-5 poll the worker last checked,
 * which `definitionHash` must name, from `entries`, the whole board as the
 * API serves it (`voterCellV5`; T-10, T-13): the identity commitment of
 * `secret`, registered in `tier` and `group`, replayed under `registrars`
 * and `threshold`, which the page takes from its build's deployment, as it
 * does the panels (the worker trusts the page with them as it does with the
 * secret; a wrong set only refuses, since the cell's root still binds the
 * leaves at the cast). The worker keeps the cell's
 * leaves and the commitment for `cast`; the page gets the cell to seal in.
 */
export interface FindCellRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "find-cell";
  readonly definitionHash: Uint8Array;
  /** 32 bytes; the worker zeroes its copy once it has the commitment. */
  readonly secret: Uint8Array;
  readonly tier: number;
  readonly group: bigint;
  readonly entries: readonly Uint8Array[];
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
}

/** The voter challenged seal `seal`: its opening, and the seal is spent (T-42, T-45). */
export interface ChallengeRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "challenge";
  readonly seal: number;
}

/**
 * The voter cast seal `seal` (docs/spec/ballot-validity.md, Casting (version
 * 3), steps 2 to 4): its record under the L1 block the page read
 * (`l1Number`, `l1Hash`), proved for `secret`, the identity `find-cell`
 * found, over the leaves of the cell it found, which must be the seal's
 * (checked against the cell's root, T-10, T-13), by the prover worker at
 * the other end of `prover`. The witness goes
 * over that port; the page gets the finished record, never the witness. A
 * cast seal is never opened, and may be cast again with the same secret
 * (revoting Client rule 4).
 */
export interface CastRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "cast";
  readonly seal: number;
  /** 32 bytes; the worker zeroes its copy once the witness is built. */
  readonly secret: Uint8Array;
  readonly l1Number: bigint;
  readonly l1Hash: Uint8Array;
  readonly prover: MessagePort;
}

/**
 * The identity commitment of `secret`, `Poseidon2(s · B8)`
 * ([[identity-backup]], Identity secret), which a Tier 0 registration sends
 * ([[registration]], Request). Asked of the worker, like every use of the
 * secret, so the page never computes with it (T-12); it needs no poll.
 */
export interface CommitmentRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "commitment";
  /** 32 bytes; the worker zeroes its copy once it has the commitment. */
  readonly secret: Uint8Array;
}

/**
 * Where the identity commitment of `secret` stands among the deployment's
 * published Tier 0 groups (`groups`) at the finalized L2 block `block`, for
 * a request that asked for `region` ([[registration]], Outcome):
 * `tier0Registration` over `records`, every log the group registry
 * (`registry`, on `chainId`) emitted up to `block`, as contract-event
 * records under `version`, replayed under `registrars` and `threshold`. The
 * page reads the logs (`loadGroupRegistry`) and takes the rest from its
 * build's deployment, as it does for `find-cell`; it needs no poll.
 */
export interface Tier0OutcomeRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "tier0-outcome";
  /** 32 bytes; the worker zeroes its copy once it has the commitment. */
  readonly secret: Uint8Array;
  readonly region: number;
  readonly block: bigint;
  readonly groups: readonly { readonly group_id: bigint; readonly region: number }[];
  readonly records: readonly Uint8Array[];
  /** 20 bytes. */
  readonly registry: Uint8Array;
  readonly chainId: bigint;
  readonly version: ContractEventVersion;
  readonly registrars: readonly Uint8Array[];
  readonly threshold: number;
}

/**
 * Seals `secret` for the backup passkey whose PRF output is `prf`
 * (`sealIdentityBackup`; [[identity-backup]], Sealing): the envelope and the
 * locator the page stores it under. Asked of the worker, like every use of
 * the secret (T-12); the page holds the PRF output only between the
 * ceremony and this request, and needs no poll.
 */
export interface BackupSealRequest {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly kind: "backup-seal";
  /** 32 bytes, the PRF's `results.first`; the worker zeroes its copy. */
  readonly prf: Uint8Array;
  /** 32 bytes; the worker zeroes its copy once it is sealed. */
  readonly secret: Uint8Array;
}

export type WorkerRequest =
  | CheckElectionRequest
  | CommitmentRequest
  | BackupSealRequest
  | Tier0OutcomeRequest
  | FindCellRequest
  | SealRequest
  | ChallengeRequest
  | CastRequest;

/**
 * Why no proof came back: one of `MembershipProverError`'s codes, or
 * `prover` when the prover worker failed, answered out of turn or not in
 * time. Each is a reason the client shows, never a retry.
 */
export type MembershipProofProblem = MembershipProverErrorCode | "prover";

/**
 * The voter's cell, `sealBallotV3`'s index, or why there is none: no
 * version-5 poll checked under that definition hash in this worker, a
 * secret that isn't an identity secret, or `voterCellV5`'s refusal (`cell`,
 * with its code), which the page shows, never retries.
 */
export type FindCellResult =
  | { readonly ok: true; readonly cell: number }
  | { readonly ok: false; readonly problem: "no-election" | "secret" }
  | { readonly ok: false; readonly problem: "cell"; readonly code: VoterCellCode };

/** The commitment, or `secret` for bytes that aren't an identity secret. */
export type CommitmentResult =
  | { readonly ok: true; readonly commitment: bigint }
  | { readonly ok: false; readonly problem: "secret" };

/**
 * The envelope (record `0x000a`, 63 bytes) and the 32-byte locator to store
 * it under, or `secret` for bytes that aren't an identity secret.
 */
export type BackupSealResult =
  | { readonly ok: true; readonly locator: Uint8Array; readonly envelope: Uint8Array }
  | { readonly ok: false; readonly problem: "secret" };

/**
 * The registration's outcome, or why there is none: bytes that aren't an
 * identity secret, or whose commitment can't be registered (`secret`), a
 * record that isn't a contract-event record of the pinned version
 * (`record`), or `tier0Registration`'s refusal of the registry's history
 * (`registry`, with its code), which the page shows, never retries.
 */
export type Tier0OutcomeResult =
  | { readonly ok: true; readonly outcome: Tier0Registration }
  | { readonly ok: false; readonly problem: "secret" | "record" }
  | { readonly ok: false; readonly problem: "registry"; readonly code: TierMembershipErrorCode };

/**
 * A seal, or why none was made: no version-5 poll checked under that
 * definition hash in this worker, or votes or a cell the poll doesn't allow,
 * which the question screens never send.
 */
export type SealResult =
  | { readonly ok: true; readonly seal: number; readonly trackingCode: Uint8Array }
  | { readonly ok: false; readonly problem: "no-election" | "refused" };

/**
 * The opening (`0x0003` version 2) of a seal, or why there is none: a seal
 * this worker doesn't hold (`unknown`), or one the voter chose to cast, which
 * is never opened (`cast`; T-45).
 */
export type ChallengeResult =
  | { readonly ok: true; readonly opening: Uint8Array; readonly trackingCode: Uint8Array }
  | { readonly ok: false; readonly problem: "unknown" | "cast" };

/**
 * A finished ballot: the record (`0x0002` version 3) as it is boarded, its
 * hash, and each qualified seat's share ciphertext for its intake. Or why
 * there is none: a seal this worker doesn't hold or the voter challenged
 * (`unknown`), no cell found for the poll or a seal in another cell than
 * the one found (`no-cell`), a secret other than the one `find-cell` was
 * given (`secret`), the membership proof's refusal (`MembershipProofProblem`), or
 * a record that failed the client's own admission checks (`ballot`, with the
 * verifier's code), which is never sent. None is retried by the worker.
 */
export type CastResult =
  | {
      readonly ok: true;
      readonly ballot: Uint8Array;
      readonly ballotHash: Uint8Array;
      readonly ciphertexts: readonly { readonly seat: number; readonly ciphertext: Uint8Array }[];
    }
  | { readonly ok: false; readonly problem: "unknown" | "no-cell" | MembershipProofProblem }
  | { readonly ok: false; readonly problem: "ballot"; readonly code: BallotV2Code };

export type WorkerResponse =
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "check-election";
      readonly result: ElectionCheck;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "commitment";
      readonly result: CommitmentResult;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "backup-seal";
      readonly result: BackupSealResult;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "tier0-outcome";
      readonly result: Tier0OutcomeResult;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "find-cell";
      readonly result: FindCellResult;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "seal";
      readonly result: SealResult;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "challenge";
      readonly result: ChallengeResult;
    }
  | {
      readonly v: typeof PROTOCOL_VERSION;
      readonly id: number;
      readonly kind: "cast";
      readonly result: CastResult;
    }
  /** The request was malformed or the worker failed; it names no detail, which could quote a secret. */
  | { readonly v: typeof PROTOCOL_VERSION; readonly id: number; readonly kind: "error" };

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isId = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;

const isBytes = (x: unknown, length?: number): x is Uint8Array =>
  x instanceof Uint8Array && (length === undefined || x.length === length);

/** A list whose every element passes `is`: holes, which `every` would skip, fail too. */
const isListOf = <T>(x: unknown, is: (e: unknown) => e is T): x is T[] =>
  Array.isArray(x) && Array.from(x as unknown[]).every(is);

const isVote = (x: unknown): x is 0 | 1 => x === 0 || x === 1;
const isAnyBytes = (x: unknown): x is Uint8Array => isBytes(x);

const hasKeys = (data: Record<string, unknown>, expected: readonly string[]) => {
  const keys = Object.keys(data).sort();
  return keys.length === expected.length && keys.every((k, i) => k === expected[i]);
};

const CHECK_KEYS = [
  "definition",
  "displayText",
  "electionId",
  "entries",
  "id",
  "kind",
  "panels",
  "registeredHash",
  "v",
];
const FIND_CELL_KEYS = [
  "definitionHash",
  "entries",
  "group",
  "id",
  "kind",
  "registrars",
  "secret",
  "threshold",
  "tier",
  "v",
];
const COMMITMENT_KEYS = ["id", "kind", "secret", "v"];
const BACKUP_SEAL_KEYS = ["id", "kind", "prf", "secret", "v"];
const OUTCOME_KEYS = [
  "block",
  "chainId",
  "groups",
  "id",
  "kind",
  "records",
  "region",
  "registrars",
  "registry",
  "secret",
  "threshold",
  "v",
  "version",
];

const isU64 = (x: unknown): x is bigint => typeof x === "bigint" && x >= 0n && x >> 64n === 0n;

const isTier0Group = (x: unknown): x is { group_id: bigint; region: number } =>
  isRecord(x) &&
  hasKeys(x, ["group_id", "region"]) &&
  isU64(x["group_id"]) &&
  Number.isSafeInteger(x["region"]);

const isEventVersion = (x: unknown): x is ContractEventVersion =>
  Number.isInteger(x) && (x as number) >= 1 && (x as number) <= 8;
const SEAL_KEYS = ["cell", "definitionHash", "id", "kind", "v", "votes"];
const CHALLENGE_KEYS = ["id", "kind", "seal", "v"];
const CAST_KEYS = ["id", "kind", "l1Hash", "l1Number", "prover", "seal", "secret", "v"];

const isPanel = (x: unknown): x is Panel =>
  isRecord(x) &&
  hasKeys(x, ["keys", "threshold"]) &&
  Number.isSafeInteger(x["threshold"]) &&
  isListOf(x["keys"], isAnyBytes);

/**
 * A request the worker accepts, or `undefined`: exact keys and exact types.
 * Only the shapes are checked here; the values (the secret's range, the
 * cell, the seal) are the session's to refuse.
 */
export function parseRequest(data: unknown): WorkerRequest | undefined {
  if (!isRecord(data) || data["v"] !== PROTOCOL_VERSION || !isId(data["id"])) return undefined;
  const v = PROTOCOL_VERSION;
  const id = data["id"];
  if (data["kind"] === "check-election") {
    if (!hasKeys(data, CHECK_KEYS)) return undefined;
    const { electionId, registeredHash, definition, displayText, entries, panels } = data;
    if (
      !isBytes(electionId, 32) ||
      !isBytes(registeredHash, 32) ||
      !isBytes(definition) ||
      !isBytes(displayText) ||
      !isListOf(entries, isAnyBytes) ||
      !isListOf(panels, isPanel)
    )
      return undefined;
    return {
      v,
      id,
      kind: "check-election",
      electionId,
      registeredHash,
      definition,
      displayText,
      entries,
      panels,
    };
  }
  if (data["kind"] === "commitment") {
    if (!hasKeys(data, COMMITMENT_KEYS) || !isBytes(data["secret"], 32)) return undefined;
    return { v, id, kind: "commitment", secret: data["secret"] };
  }
  if (data["kind"] === "backup-seal") {
    if (!hasKeys(data, BACKUP_SEAL_KEYS)) return undefined;
    const { prf, secret } = data;
    if (!isBytes(prf, 32) || !isBytes(secret, 32)) return undefined;
    return { v, id, kind: "backup-seal", prf, secret };
  }
  if (data["kind"] === "tier0-outcome") {
    if (!hasKeys(data, OUTCOME_KEYS)) return undefined;
    const { secret, region, block, groups, records, registry, chainId, version } = data;
    const { registrars, threshold } = data;
    if (
      !isBytes(secret, 32) ||
      !Number.isSafeInteger(region) ||
      !isU64(block) ||
      !isListOf(groups, isTier0Group) ||
      !isListOf(records, isAnyBytes) ||
      !isBytes(registry, 20) ||
      !isU64(chainId) ||
      !isEventVersion(version) ||
      !isListOf(registrars, isAnyBytes) ||
      !Number.isSafeInteger(threshold)
    )
      return undefined;
    return {
      v,
      id,
      kind: "tier0-outcome",
      secret,
      region: region as number,
      block,
      groups,
      records,
      registry,
      chainId,
      version,
      registrars,
      threshold: threshold as number,
    };
  }
  if (data["kind"] === "find-cell") {
    if (!hasKeys(data, FIND_CELL_KEYS)) return undefined;
    const { definitionHash, secret, tier, group, entries, registrars, threshold } = data;
    if (
      !isBytes(definitionHash, 32) ||
      !isBytes(secret, 32) ||
      !Number.isSafeInteger(tier) ||
      typeof group !== "bigint" ||
      group < 0n ||
      group >> 64n !== 0n ||
      !isListOf(entries, isAnyBytes) ||
      !isListOf(registrars, isAnyBytes) ||
      !Number.isSafeInteger(threshold)
    )
      return undefined;
    return {
      v,
      id,
      kind: "find-cell",
      definitionHash,
      secret,
      tier: tier as number,
      group,
      entries,
      registrars,
      threshold: threshold as number,
    };
  }
  if (data["kind"] === "seal") {
    if (!hasKeys(data, SEAL_KEYS)) return undefined;
    const { definitionHash, cell, votes } = data;
    if (!isBytes(definitionHash, 32) || !Number.isSafeInteger(cell) || !isListOf(votes, isVote))
      return undefined;
    return {
      v,
      id,
      kind: "seal",
      definitionHash,
      cell: cell as number,
      votes,
    };
  }
  if (data["kind"] === "challenge") {
    if (!hasKeys(data, CHALLENGE_KEYS) || !isId(data["seal"])) return undefined;
    return { v, id, kind: "challenge", seal: data["seal"] };
  }
  if (data["kind"] === "cast") {
    if (!hasKeys(data, CAST_KEYS)) return undefined;
    const { seal, secret, l1Number, l1Hash, prover } = data;
    if (
      !isId(seal) ||
      !isBytes(secret, 32) ||
      typeof l1Number !== "bigint" ||
      l1Number < 0n ||
      l1Number >> 64n !== 0n ||
      !isBytes(l1Hash, 32) ||
      !(prover instanceof MessagePort)
    )
      return undefined;
    return {
      v,
      id,
      kind: "cast",
      seal,
      secret,
      l1Number,
      l1Hash,
      prover,
    };
  }
  return undefined;
}

/** The id of a request the worker refuses, so its error can be matched; `undefined` if it has none. */
export function requestId(data: unknown): number | undefined {
  return isRecord(data) && isId(data["id"]) ? data["id"] : undefined;
}

const RESPONSE_KINDS: ReadonlySet<unknown> = new Set([
  "check-election",
  "commitment",
  "backup-seal",
  "tier0-outcome",
  "find-cell",
  "seal",
  "challenge",
  "cast",
  "error",
]);

/** The request id a response answers, if it is one of this version's responses. */
export function responseId(data: unknown): number | undefined {
  if (!isRecord(data) || data["v"] !== PROTOCOL_VERSION || !isId(data["id"])) return undefined;
  return RESPONSE_KINDS.has(data["kind"]) ? data["id"] : undefined;
}
