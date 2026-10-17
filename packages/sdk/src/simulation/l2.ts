// The simulated L2 registries (docs/spec/contracts.md, Trustee registry and
// Election registry): a trustee registry that pins the run's panel with the
// quorum rule 7 sets and records a ceremony only from a quorum of distinct
// seats' valid approvals, and an election registry that assigns the
// election's identifier from its own counter and registers its one
// definition only once the trustee registry has recorded the ceremony the
// definition names. Each approval is checked with @abolishus/crypto's
// `verifyCeremonyRegistration` over crypto's `keySetHash` of the record's
// seats, and the definition with crypto's well-formedness rules and stub
// hash, so the run exercises the binding a deployed registry enforces (T-37,
// T-14, T-34, T-24, T-71). At registration the election registry also
// records the board's parameters, which the simulated board contract reads
// (./board-contract.ts). The contracts and their chain are simulated:
// records live in memory, the registries emit no event and the verifier
// doesn't read them yet (SIMULATION_STUBS).

import {
  EncodeError,
  type ElectionDefinitionV4,
  electionDefinitionV4Hash,
  electionDefinitionV4Rule,
  type ElectionDefinitionV4Rule,
  electionId,
  electionStubV4Hash,
  encodeElectionDefinitionV4,
  type KeySetEntry,
  keySetHash,
  PARAMETERS,
  type Panel,
  panelId,
  pinnedVersion,
  RECORD_TYPES,
  verifyCeremonyRegistration,
} from "@abolishus/crypto";

/** Seconds between simulated L2 blocks, Base's 2. */
export const SIMULATED_L2_BLOCK_TIME = 2n;

/**
 * How long before `opens_at` the election's creator registers its definition:
 * a day, so the registry's `block.timestamp < opens_at` holds with room
 * (docs/spec/contracts.md, Election registry, Registration, rule 6). The
 * election is created a day before that, so its creation is finalized before
 * the stub is written and the ceremony runs (Election identifier).
 */
export const SIMULATED_REGISTRATION_LEAD = 86_400n;

/** An L2 block, as a registry call sees it: `block.number` and `block.timestamp`. */
export interface L2Block {
  readonly number: bigint;
  readonly timestamp: bigint;
}

/** The simulated L2 block that holds a call made at `seconds`. */
export function l2BlockAt(seconds: bigint): L2Block {
  if (seconds < 0n) throw new RangeError("simulation: L2 time starts at 0");
  const number = seconds / SIMULATED_L2_BLOCK_TIME;
  return { number, timestamp: number * SIMULATED_L2_BLOCK_TIME };
}

/**
 * The deployment a definition must name ([[election-definition]], What gets
 * admitted). The L2 addresses are fresh per run, so two runs never share an
 * election identifier even though each registry counts from 0; the L1 ones
 * name the simulated anchor and a relay nothing calls.
 */
export interface SimulatedDeployment {
  readonly l2ChainId: bigint;
  readonly electionRegistry: Uint8Array;
  readonly board: Uint8Array;
  readonly trusteeRegistry: Uint8Array;
  readonly groupRegistry: Uint8Array;
  readonly l1ChainId: bigint;
  readonly l1Anchor: Uint8Array;
  readonly l1Relay: Uint8Array;
  /** The anchoring clock's start, the anchor's epoch (./anchor.ts). */
  readonly epoch: bigint;
}

/** One seat's approval in a registration record: its index and its 64-byte `r ‖ s`. */
export interface CeremonyApproval {
  readonly index: number;
  readonly signature: Uint8Array;
}

/**
 * The trustee registry's registration record (docs/spec/contracts.md,
 * Trustee registry, Registration), held as values rather than bytes: the
 * simulated registry takes no calldata, so the record's byte layout and its
 * canonical-calldata and length checks (1 and 2) aren't exercised here.
 */
export interface CeremonyRegistrationRecord {
  readonly panelId: Uint8Array;
  readonly stubHash: Uint8Array;
  readonly ceremonyTranscriptHash: Uint8Array;
  /** The key set the approvals sign, in seat order. */
  readonly seats: readonly KeySetEntry[];
  readonly approvals: readonly CeremonyApproval[];
}

/** The trustee registry's refusals, by the contract's error names, in its checking order. */
export type CeremonyRefusal =
  | "UnknownPanel"
  | "ZeroTranscriptHash"
  | "BelowQuorum"
  | "AlreadyRecorded"
  | "KeySetTooSmall"
  | "KeySetSeatsOutOfOrder"
  | "InvalidSigningKey"
  | "DuplicateSigningKey"
  | "SeatsOutOfOrder"
  | "InvalidSignature";

/** The election registry's refusals, by the contract's error names, in its checking order. */
export type DefinitionRefusal =
  | "DefinitionIllFormed"
  | "WrongDeployment"
  | "UnknownElection"
  | "NotCreator"
  | "AlreadyRegistered"
  | "OpensBeforeEpoch"
  | "AlreadyOpen"
  | "InclusionBoundOutOfRange"
  | "SequencingWindowTooLarge"
  | "SequencerDriftTooLarge"
  | "RootNotInPast"
  | "CeremonyNotRecorded"
  | "ProfileNotServed";

export type RegistryResult<R> =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: R; readonly rule?: ElectionDefinitionV4Rule };

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
const isZero = (b: Uint8Array) => b.every((x) => x === 0);
const copySeat = (s: KeySetEntry): KeySetEntry => ({
  index: s.index,
  kemKeyHash: Uint8Array.from(s.kemKeyHash),
  signingKey: Uint8Array.from(s.signingKey),
});

/** The quorum every deployment sets for a panel: `max(k, n − 1)` ([[0006-trustees]] rule 7). */
export function rule7Quorum(panel: Panel): number {
  return Math.max(panel.threshold, panel.keys.length - 1);
}

interface PinnedPanel {
  readonly panel: Panel;
  readonly quorum: number;
}

interface RecordedCeremony {
  readonly transcriptHash: Uint8Array;
  readonly keySetHash: Uint8Array;
  readonly seats: readonly KeySetEntry[];
}

export class SimulatedTrusteeRegistry {
  readonly #address: Uint8Array;
  readonly #panels = new Map<string, PinnedPanel>();
  // Keyed by stub hash and panel identifier, so another pinned panel's
  // quorum can't block a stub's own panel (Per stub and panel; T-25).
  readonly #recorded = new Map<string, RecordedCeremony>();

  /** The chain and address every approval signs over. */
  readonly l2ChainId: bigint;
  get address(): Uint8Array {
    return Uint8Array.from(this.#address);
  }

  /**
   * A registry at `address` on `l2ChainId` pinning each panel with its
   * quorum, which must be from `k` to `n`. Panels are fixed here: nothing
   * adds, changes or removes one afterwards.
   */
  constructor(
    l2ChainId: bigint,
    address: Uint8Array,
    panels: readonly { readonly panel: Panel; readonly quorum: number }[],
  ) {
    if (panels.length === 0) throw new RangeError("simulation: a trustee registry pins a panel");
    this.l2ChainId = l2ChainId;
    this.#address = Uint8Array.from(address);
    for (const { panel, quorum } of panels) {
      // In the contract's order: panelId checks the panel rules (size,
      // threshold, keys, repeats), then the quorum, then a repeated panel.
      const id = hex(panelId(panel));
      if (!Number.isSafeInteger(quorum) || quorum < panel.threshold || quorum > panel.keys.length)
        throw new RangeError("simulation: a panel's quorum must be from k to n");
      if (this.#panels.has(id)) throw new RangeError("simulation: a panel pinned twice");
      this.#panels.set(id, {
        panel: { threshold: panel.threshold, keys: panel.keys.map((k) => Uint8Array.from(k)) },
        quorum,
      });
    }
  }

  /**
   * `registerCeremony`'s checks 3 to 10, in the contract's order, then the
   * record. Every approval must verify, under its seat's pinned key, on the
   * statement over this registry, its chain and the key set's hash, and
   * seats count once each, never signatures (T-14, T-37, T-31). The sender
   * isn't an input: anyone may submit (T-71).
   */
  registerCeremony(r: CeremonyRegistrationRecord): RegistryResult<CeremonyRefusal> {
    const refuse = (refusal: CeremonyRefusal) => ({ ok: false as const, refusal });
    const pinned = this.#panels.get(hex(r.panelId));
    if (pinned === undefined) return refuse("UnknownPanel");
    const { panel, quorum } = pinned;
    const n = panel.keys.length;
    if (isZero(r.ceremonyTranscriptHash)) return refuse("ZeroTranscriptHash");
    if (r.approvals.length < quorum) return refuse("BelowQuorum");
    const key = `${hex(r.stubHash)}:${hex(r.panelId)}`;
    if (this.#recorded.has(key)) return refuse("AlreadyRecorded");
    if (r.seats.length < panel.threshold) return refuse("KeySetTooSmall");
    let previous = 0;
    for (const [i, seat] of r.seats.entries()) {
      if (!Number.isSafeInteger(seat.index) || seat.index <= previous || seat.index > n)
        return refuse("KeySetSeatsOutOfOrder");
      previous = seat.index;
      // A seat's signing key must be a P-256 point, as `p256-key` decodes
      // it; encoding the seat alone is that check.
      try {
        keySetHash([{ ...seat, index: 1 }]);
      } catch (e) {
        if (e instanceof EncodeError) return refuse("InvalidSigningKey");
        throw e;
      }
      // One key never signs for two seats, and no identity key signs as a
      // per-election key (T-37). The contract compares points; a p256-key
      // encodes one point, so comparing encodings is the same test.
      if (
        r.seats.slice(0, i).some((s) => same(s.signingKey, seat.signingKey)) ||
        panel.keys.some((k) => same(k, seat.signingKey))
      )
        return refuse("DuplicateSigningKey");
    }
    const setHash = keySetHash(r.seats);
    previous = 0;
    for (const a of r.approvals) {
      if (!Number.isSafeInteger(a.index) || a.index <= previous || a.index > n)
        return refuse("SeatsOutOfOrder");
      previous = a.index;
      const statement = {
        l2ChainId: this.l2ChainId,
        trusteeRegistry: this.#address,
        index: a.index,
        stubHash: r.stubHash,
        ceremonyTranscriptHash: r.ceremonyTranscriptHash,
        keySetHash: setHash,
      };
      if (!verifyCeremonyRegistration(panel, statement, a.signature))
        return refuse("InvalidSignature");
    }
    this.#recorded.set(key, {
      transcriptHash: Uint8Array.from(r.ceremonyTranscriptHash),
      keySetHash: setHash,
      seats: r.seats.map(copySeat),
    });
    return { ok: true };
  }

  /**
   * True exactly when `panelId` is pinned with that threshold and size and
   * the transcript recorded for the stub and panel is `transcriptHash`.
   */
  ceremonyRecorded(
    stubHash: Uint8Array,
    transcriptHash: Uint8Array,
    id: Uint8Array,
    threshold: number,
    panelSize: number,
  ): boolean {
    const pinned = this.#panels.get(hex(id));
    if (pinned === undefined) return false;
    if (pinned.panel.threshold !== threshold || pinned.panel.keys.length !== panelSize)
      return false;
    const recorded = this.#recorded.get(`${hex(stubHash)}:${hex(id)}`);
    return recorded !== undefined && same(recorded.transcriptHash, transcriptHash);
  }

  /** The key set recorded for the stub and panel, as `keySetOf` and `signingKeyOf` give it, or `undefined`. */
  keySetOf(
    stubHash: Uint8Array,
    id: Uint8Array,
  ): { readonly keySetHash: Uint8Array; readonly seats: readonly KeySetEntry[] } | undefined {
    const recorded = this.#recorded.get(`${hex(stubHash)}:${hex(id)}`);
    return recorded === undefined
      ? undefined
      : { keySetHash: Uint8Array.from(recorded.keySetHash), seats: recorded.seats.map(copySeat) };
  }

  /** The quorum pinned for `id`, or `undefined` for a panel it doesn't pin. */
  quorumOf(id: Uint8Array): number | undefined {
    return this.#panels.get(hex(id))?.quorum;
  }

  /**
   * The panel pinned as `id`, as a copy, or `undefined` for a panel it
   * doesn't pin: what a reader of the deployment takes the panel from when
   * no release pins it (SIMULATION_STUBS).
   */
  panelOf(id: Uint8Array): Panel | undefined {
    const pinned = this.#panels.get(hex(id));
    return pinned === undefined
      ? undefined
      : {
          threshold: pinned.panel.threshold,
          keys: pinned.panel.keys.map((k) => Uint8Array.from(k)),
        };
  }
}

/**
 * Rule 9 for a version-4 definition, the only version the simulation
 * registers: ballot version 2, spoiled-ballot opening version 2, board-entry
 * version 5, contract-event version 7 and display-text version 1, the
 * versions the deployment's board and the verifier serve for it
 * ([[contracts]], Election registry, Registration).
 */
const SERVED_V4: ReadonlyMap<number, number> = new Map([
  [RECORD_TYPES.ballot, 2],
  [RECORD_TYPES.spoiledBallotOpening, 2],
  [RECORD_TYPES.boardEntry, 5],
  [RECORD_TYPES.contractEvent, 7],
  [RECORD_TYPES.displayText, 1],
]);

const servedProfile = (d: ElectionDefinitionV4) =>
  [...SERVED_V4].every(([type, version]) => pinnedVersion(d, type) === version);

/**
 * What the registry records for the board, keyed by `definition_hash`
 * (docs/spec/contracts.md, Election registry, Parameters): the fields a
 * direct submission's checks read, each from the registered definition, so
 * the board takes nothing about the election from a submitter (T-25, T-71).
 * Definition version 4 has one question and no author panel.
 */
export interface BoardParameters {
  readonly ballotVersion: number;
  readonly threshold: number;
  readonly panelSize: number;
  readonly optionCount: number;
  readonly cellCount: number;
  readonly opensAt: bigint;
  readonly closesAt: bigint;
  readonly l1InclusionBound: number;
  /** Each question's method, option count and selection limits, in ballot order. */
  readonly questions: readonly {
    readonly method: number;
    readonly options: number;
    readonly minSelections: number;
    readonly maxSelections: number;
  }[];
  /** Each cell's tier and root, in partition order: tier by tier, each tier's cells in order. */
  readonly cells: readonly { readonly tier: number; readonly root: bigint }[];
  /** Where the trustee registry recorded the election's key set. */
  readonly ceremony: { readonly stubHash: Uint8Array; readonly panelId: Uint8Array };
}

function boardParameters(d: ElectionDefinitionV4): BoardParameters {
  return {
    ballotVersion: pinnedVersion(d, RECORD_TYPES.ballot) ?? 0,
    threshold: d.threshold,
    panelSize: d.panel_size,
    optionCount: d.option_count,
    cellCount: d.electorate.reduce((n, t) => n + t.cells.length, 0),
    opensAt: d.opens_at,
    closesAt: d.closes_at,
    l1InclusionBound: d.l1_inclusion_bound,
    questions: [
      {
        method: 1,
        options: d.option_count,
        minSelections: d.min_selections,
        maxSelections: d.max_selections,
      },
    ],
    cells: d.electorate.flatMap((t) => t.cells.map((c) => ({ tier: t.tier, root: c.root }))),
    ceremony: { stubHash: electionStubV4Hash(d), panelId: Uint8Array.from(d.panel_id) },
  };
}

const copyParameters = (p: BoardParameters): BoardParameters => ({
  ...p,
  questions: p.questions.map((q) => ({ ...q })),
  cells: p.cells.map((c) => ({ ...c })),
  ceremony: {
    stubHash: Uint8Array.from(p.ceremony.stubHash),
    panelId: Uint8Array.from(p.ceremony.panelId),
  },
});

export class SimulatedElectionRegistry {
  readonly #deployment: SimulatedDeployment;
  // The board's parameters, by definition hash, recorded with the same code
  // that checks the definition (docs/spec/contracts.md, Parameters).
  readonly #parameters = new Map<string, BoardParameters>();
  readonly #trustees: SimulatedTrusteeRegistry;
  readonly #creators = new Map<string, string>();
  readonly #definitions = new Map<string, Uint8Array>();
  // Each registered definition's canonical encoding, as its registration's
  // calldata carries it on L2 ([[contracts]], Election registry), so a
  // reader rebuilding from chain finds the definition there.
  readonly #encodings = new Map<string, Uint8Array>();
  #counter = 0n;

  /**
   * A registry for `deployment`, asking `trustees`, which must be the
   * deployment's trustee registry: the contract calls the definition's
   * `trustee_registry`, so approvals always sign that address (T-37).
   * Throws, as the contract's deployment reverts, unless the deployment
   * could appear in a well-formed definition (the `chain` rule).
   */
  constructor(deployment: SimulatedDeployment, trustees: SimulatedTrusteeRegistry) {
    const l2 = [
      deployment.electionRegistry,
      deployment.board,
      deployment.trusteeRegistry,
      deployment.groupRegistry,
    ];
    const l1 = [deployment.l1Anchor, deployment.l1Relay];
    if (
      [...l2, ...l1].some((a) => a.length !== 20 || isZero(a)) ||
      l2.some((a, i) => l2.slice(i + 1).some((b) => same(a, b))) ||
      same(deployment.l1Anchor, deployment.l1Relay) ||
      deployment.l1ChainId === 0n ||
      deployment.l1ChainId === deployment.l2ChainId
    )
      throw new RangeError("simulation: an election registry's deployment breaks the chain rule");
    if (
      trustees.l2ChainId !== deployment.l2ChainId ||
      !same(trustees.address, deployment.trusteeRegistry)
    )
      throw new RangeError("simulation: the trustee registry isn't the deployment's");
    this.#deployment = {
      ...deployment,
      electionRegistry: Uint8Array.from(deployment.electionRegistry),
      board: Uint8Array.from(deployment.board),
      trusteeRegistry: Uint8Array.from(deployment.trusteeRegistry),
      groupRegistry: Uint8Array.from(deployment.groupRegistry),
      l1Anchor: Uint8Array.from(deployment.l1Anchor),
      l1Relay: Uint8Array.from(deployment.l1Relay),
    };
    this.#trustees = trustees;
  }

  /**
   * `createElection()`: the next counter's identifier, with `creator` the
   * only account that may register its definition.
   */
  createElection(creator: string): Uint8Array {
    const id = electionId(
      this.#deployment.l2ChainId,
      this.#deployment.electionRegistry,
      this.#counter,
    );
    this.#counter += 1n;
    this.#creators.set(hex(id), creator);
    return id;
  }

  /**
   * `registerDefinition`'s checks 3 to 9 in the contract's order, then the
   * write-once record of the definition's hash. Strict decoding (2) is the
   * caller's: the registry takes a decoded definition. Only the creator check
   * reads the caller, and only for its own identifier (T-25, T-71); the
   * ceremony check compares hashes (T-37).
   */
  registerDefinition(
    caller: string,
    d: ElectionDefinitionV4,
    block: L2Block,
  ): RegistryResult<DefinitionRefusal> {
    const refuse = (refusal: DefinitionRefusal) => ({ ok: false as const, refusal });
    const rule = electionDefinitionV4Rule(d);
    if (rule !== undefined) return { ok: false, refusal: "DefinitionIllFormed", rule };
    const dep = this.#deployment;
    if (
      d.l2_chain_id !== dep.l2ChainId ||
      d.l1_chain_id !== dep.l1ChainId ||
      !same(d.election_registry, dep.electionRegistry) ||
      !same(d.board, dep.board) ||
      !same(d.trustee_registry, dep.trusteeRegistry) ||
      !same(d.group_registry, dep.groupRegistry) ||
      !same(d.l1_anchor, dep.l1Anchor) ||
      !same(d.l1_relay, dep.l1Relay)
    )
      return refuse("WrongDeployment");
    const id = hex(d.election_id);
    const creator = this.#creators.get(id);
    if (creator === undefined) return refuse("UnknownElection");
    if (creator !== caller) return refuse("NotCreator");
    if (this.#definitions.has(id)) return refuse("AlreadyRegistered");
    if (d.opens_at < dep.epoch) return refuse("OpensBeforeEpoch");
    if (block.timestamp >= d.opens_at) return refuse("AlreadyOpen");
    const delta = d.l1_inclusion_bound;
    if (delta < PARAMETERS.MIN_INCLUSION_BOUND || delta > PARAMETERS.MAX_INCLUSION_BOUND)
      return refuse("InclusionBoundOutOfRange");
    if (d.sequencing_window > BigInt(PARAMETERS.MAX_SEQUENCING_WINDOW))
      return refuse("SequencingWindowTooLarge");
    if (d.max_sequencer_drift > BigInt(PARAMETERS.MAX_SEQUENCER_DRIFT))
      return refuse("SequencerDriftTooLarge");
    // The electorate is fixed in L2 history before the definition is (T-08, T-13).
    if (d.electorate.some((t) => t.root_l2_block >= block.number)) return refuse("RootNotInPast");
    if (
      !this.#trustees.ceremonyRecorded(
        electionStubV4Hash(d),
        d.ceremony_transcript_hash,
        d.panel_id,
        d.threshold,
        d.panel_size,
      )
    )
      return refuse("CeremonyNotRecorded");
    if (!servedProfile(d)) return refuse("ProfileNotServed");
    const hash = electionDefinitionV4Hash(d);
    this.#definitions.set(id, hash);
    this.#encodings.set(id, encodeElectionDefinitionV4(d));
    this.#parameters.set(hex(hash), boardParameters(d));
    return { ok: true };
  }

  /**
   * The definition registered for `election`, in its canonical encoding, or
   * `undefined` before registration: the bytes the registration carried,
   * which a reader decodes strictly and compares with `definitionHashOf`.
   */
  definitionOf(election: Uint8Array): Uint8Array | undefined {
    const e = this.#encodings.get(hex(election));
    return e === undefined ? undefined : Uint8Array.from(e);
  }

  /**
   * `parameters`, `cell` and `ceremony` for `definitionHash` together, as a
   * copy, or `undefined` for a hash never registered (`ballot_version` 0).
   */
  parametersOf(definitionHash: Uint8Array): BoardParameters | undefined {
    const p = this.#parameters.get(hex(definitionHash));
    return p === undefined ? undefined : copyParameters(p);
  }

  /** The hash registered for `election`, or `undefined` before registration. */
  definitionHashOf(election: Uint8Array): Uint8Array | undefined {
    const h = this.#definitions.get(hex(election));
    return h === undefined ? undefined : Uint8Array.from(h);
  }
}
