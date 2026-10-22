// The availability duty's L1 reader (docs/spec/availability.md, What a seat
// does): an election's anchors, the anchoring clock and the finalized L1
// time, as `AvailabilitySeat` reads them. The L1 node is trusted only for
// which block is finalized (no light client yet, as for the verifier's
// header, P1-19); the clock is the deployment's pin, which the anchor's
// getters must match. Every checkpoint word is proven against the finalized
// block's state root by the verifier's own reader (`anchorsFromState`), and
// a logged checkpoint counts only if its hash is the proven word for its
// segment, so a node can hide anchors from the seat (an `L1Error`, the step
// fails and is retried) but never make it attest a checkpoint the anchor
// doesn't hold (T-24, T-51, T-53).
//
// The first segment `f` is the period of the creation's L1 origin, as the
// verifier takes it (docs/spec/contracts.md, Board anchor, Verification),
// read from the seat's own L2 node with the registration, whose definition
// must be the one the seat approved, and the origin must be the finalized L1
// block of its number. The L2 node is trusted for the drift between that
// origin and the creation, which the verifier's 4.4 bounds from the archived
// event's L2 time and the registration's logs don't carry.
import {
  type Anchor,
  type AnchorClock,
  BOARD_ENTRY,
  type BoardEntryVersion,
  electionDefinitionHash,
  electionDefinitionV5Hash,
  pinnedVersion,
  RECORD_TYPES,
} from "@abolishus/crypto";
import {
  type AnchorTiming,
  anchorTiming,
  chainId,
  finalizedHeader,
  headerRlp,
  l2Finalized,
  loggedCheckpoints,
  proofNodes,
  registration,
  type Rpc,
  RpcError,
} from "@abolishus/node";
import {
  anchorsFromState,
  checkpointSlot,
  decodeHeader,
  L1Error,
  lowestSegmentSlot,
  MAX_SEGMENTS_READ,
  NodePool,
  RlpError,
} from "@abolishus/verifier";
import type { FinalizedBoardAnchors } from "./availability.ts";
import type { ApprovedElection } from "./ceremony.ts";

export interface L1AnchorOptions {
  readonly l1: Rpc;
  readonly l1ChainId: bigint;
  /** The deployment's board anchor, 20 bytes. */
  readonly anchor: Uint8Array;
  /**
   * The anchor deployment's `epoch`, `period` and `deadline`, pinned by the
   * deployment: they are immutables no storage proof reaches, so the node's
   * getters are only compared with them.
   */
  readonly timing: AnchorTiming;
  /** The anchor's deployment block: its logs are read from here. */
  readonly l1FromBlock: bigint;
  /** The seat's own L2 node. */
  readonly l2: Rpc;
  readonly l2ChainId: bigint;
  /** The deployment's election registry, 20 bytes. */
  readonly registry: Uint8Array;
  readonly l2FromBlock: bigint;
  /** The most bytes of proof nodes one read holds (`proofNodes`' `maxBytes`). */
  readonly maxProofBytes?: number;
}

/** Why an election's reader can't be set up: none of these changes on a retry. */
export type L1AnchorRefusal =
  /** A node is on another chain than the deployment's. */
  | "chain"
  /**
   * The registry registered a definition of a version this node doesn't
   * read, or one pinning a board-entry version it doesn't read.
   */
  | "definition-version"
  /** The registered definition isn't the one the seat approved. */
  | "definition-hash"
  /** The definition names another anchor, registry or chain than the deployment's. */
  | "definition-deployment"
  /** The anchor's clock getters disagree with the pinned clock. */
  | "clock"
  /** The creation's L1 origin isn't the finalized L1 block of its number: another hash or time. */
  | "origin"
  /** The creation's L1 origin is before the anchor's epoch, or `f` or `s_A` past a `u32`. */
  | "outside-clock";

export class L1AnchorError extends Error {
  override readonly name = "L1AnchorError";
  readonly code: L1AnchorRefusal;
  constructor(code: L1AnchorRefusal) {
    super(code);
    this.code = code;
  }
}

const U32_MAX = 0xffffffffn;
const isBoardVersion = (v: number | undefined): v is BoardEntryVersion =>
  v !== undefined && Object.hasOwn(BOARD_ENTRY.versions, v);
const bytesToHex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The finalized L1 reader of one approved election's anchors. It checks
 * both nodes' chains, reads the election's creation and registration from
 * the registry in finalized L2 history, requires the registered definition
 * to be the approved one through this deployment's anchor, registry and
 * chains, requires the anchor's getters to give the pinned clock and the
 * creation's L1 origin to be a finalized L1 block, and fixes `f` from that
 * origin. It also gives the board-entry version the definition pins, which
 * the seat checks the board under. Throws `L1AnchorError` for a
 * refusal, the node package's `L2Error` when the creation or registration is
 * missing or repeated, and `RpcError` when a node's answer can't be read.
 *
 * The clock's `lastSegment` is `s_A`, not the seal: no seal is derived from
 * a definition yet ([[election-definition]], The seal), every seal is at or
 * after `s_A`, and the duty judges nothing past `C_A`, whose segment is at
 * most `s_A`. So each read proves the words of segments `f` to `s_A` only.
 */
export async function l1BoardAnchors(
  options: L1AnchorOptions,
  election: ApprovedElection,
): Promise<FinalizedBoardAnchors & { readonly boardVersion: BoardEntryVersion }> {
  const { l1, l2, anchor } = options;
  if ((await chainId(l1)) !== options.l1ChainId || (await chainId(l2)) !== options.l2ChainId)
    throw new L1AnchorError("chain");
  const reg = await registration(
    l2,
    options.registry,
    election.electionId,
    options.l2FromBlock,
    await l2Finalized(l2),
  );
  // Versions 1 and 5, the ones the seat approves (`checkStub`): both carry
  // the fields below at the same names, and each is hashed under its own layout.
  const decoded = reg.decoded;
  if (decoded.version !== 1 && decoded.version !== 5) throw new L1AnchorError("definition-version");
  const d = decoded.value;
  // The hash binds the election identifier and every field below, so the
  // registered definition is the approved one or the reader refuses it.
  const hash =
    decoded.version === 1
      ? electionDefinitionHash(decoded.value)
      : electionDefinitionV5Hash(decoded.value);
  if (!equal(hash, election.definitionHash)) throw new L1AnchorError("definition-hash");
  if (
    !equal(d.l1_anchor, anchor) ||
    !equal(d.election_registry, options.registry) ||
    d.l1_chain_id !== options.l1ChainId ||
    d.l2_chain_id !== options.l2ChainId
  )
    throw new L1AnchorError("definition-deployment");
  // The version the seat checks the board under is the registered
  // definition's own pin, so it is the one the verifier's 4.2 reads.
  const boardVersion = pinnedVersion(d, RECORD_TYPES.boardEntry);
  if (!isBoardVersion(boardVersion)) throw new L1AnchorError("definition-version");
  const finalized = await finalizedHeader(l1);
  // A wrong clock would fix `C_A` at another moment or segment, and the
  // seat's one attestation of the point would name a checkpoint the
  // verifier doesn't count, for good (T-53).
  const timing = options.timing;
  const answered = await anchorTiming(l1, anchor, finalized);
  if (
    answered.epoch !== timing.epoch ||
    answered.period !== timing.period ||
    answered.deadline !== timing.deadline
  )
    throw new L1AnchorError("clock");
  // The origin must be the finalized L1 block of its number, as the
  // verifier's 4.4 requires: the L2 node can't name a time of its own, and
  // with it a lower `f` that would count anchors made before the election
  // existed ([[contracts]], Board anchor, Pre-creation anchors).
  const created = reg.created;
  // An origin past this node's finalized block may be one the seat's L2
  // node saw finalized first: this node lagging is no refusal, and the
  // reader is set up again once it catches up (an RpcError is retried).
  if (created.number > finalized.number)
    throw new RpcError(
      "eth_getBlockByNumber: the creation's L1 origin isn't final at this node yet",
    );
  let held;
  try {
    held = decodeHeader(
      headerRlp(await l1.call("eth_getBlockByNumber", [`0x${created.number.toString(16)}`, false])),
    );
  } catch (e) {
    if (e instanceof RlpError) throw new RpcError("eth_getBlockByNumber: not a header");
    throw e;
  }
  if (
    held.number !== created.number ||
    !equal(held.hash, created.hash) ||
    held.timestamp !== created.timestamp
  )
    throw new L1AnchorError("origin");
  // `f` is the period containing the creation's L1 origin; `closes_at` is
  // after it, so `s_A = period(closes_at) + 1` is at least `f + 1`.
  const origin = created.timestamp;
  if (origin < timing.epoch || d.closes_at < origin) throw new L1AnchorError("outside-clock");
  const f = (origin - timing.epoch) / timing.period;
  const sA = (d.closes_at - timing.epoch) / timing.period + 1n;
  if (sA > U32_MAX) throw new L1AnchorError("outside-clock");
  const clock: AnchorClock = { ...timing, lastSegment: Number(sA) };

  return {
    boardVersion,
    async read(electionId) {
      if (!equal(electionId, election.electionId))
        throw new RangeError("this reader reads only its own election's anchors");
      const header = await finalizedHeader(l1);
      const logged =
        (
          await loggedCheckpoints(l1, anchor, header, options.l1FromBlock, electionId)
        ).elections.get(bytesToHex(electionId)) ?? [];
      // The last segment whose period has ended by the header's time, as the
      // reader bounds it: no later one can be anchored yet.
      const now = header.timestamp;
      const ended =
        now < clock.epoch + clock.period ? -1n : (now - clock.epoch) / clock.period - 1n;
      const last = ended < sA ? ended : sA;
      if (last - f + 1n > BigInt(MAX_SEGMENTS_READ)) throw new L1Error("l1-range-too-long");
      // Every slot the reader may walk: the lowest-segment word, then each
      // segment from `f`, since it starts at the larger of the two.
      const slots = [lowestSegmentSlot(electionId)];
      for (let s = f; s <= last; s++) slots.push(checkpointSlot(electionId, Number(s)));
      const nodes = await proofNodes(l1, anchor, header, slots, options.maxProofBytes);
      const anchors: Anchor[] = anchorsFromState(
        {
          header,
          anchor,
          firstSegment: Number(f),
          nodes: new NodePool(nodes),
          checkpoints: logged,
        },
        electionId,
        [],
        clock,
      ).map((a) => a.anchor);
      return { anchors, clock, now };
    },
  };
}
