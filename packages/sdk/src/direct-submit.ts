// The ballot client's direct submission (docs/spec/contracts.md, Board
// (direct submit); P4-2): a ballot record sent straight to the board
// contract on L2 through the voter's own wallet, when our servers refuse it
// or can't be reached (T-25). It holds no key and picks no account: the
// wallet behind the EIP-1193 provider signs and pays, so the account it
// uses is linked to the ballot on chain, and funding it can link the voter
// (T-25, Residual; T-11). It needs no third-party code, so `apps/ballot` can
// call it (AGENTS.md, Dependencies).
//
// The wallet's RPC sees the record, the paying account and the voter's
// network address, at the first question as well as at sending: the board's
// own preflight carries no account, but the estimate and the transaction do
// (T-11). So the account should be fresh and privately funded, and the RPC
// one the voter chose (T-25, Residual).
//
// One call is one attempt. It never sends a record the board would refuse:
// it asks the board first with `eth_call` and returns the board's own
// refusal, decoded to the spec's codes, so a voter's gas isn't spent on a
// revert. A byte-identical record the board already accepted, by this path
// or forced through the L1 relay, is a no-op on chain (Calls, Repeats), so it
// looks for that copy before sending. What it returns, a refusal included,
// is only what the provider's node reports: a client MUST NOT stand down on
// an acceptance, since until a storage proof covers the event only a node it
// trusts has shown it (docs/spec/contracts.md, Contract-event record;
// docs/spec/delivery.md, Client rules), and SHOULD confirm a refusal through
// a node it chose before telling the voter the ballot can't go this way: a
// censoring RPC can forge one (T-25).

import { frameBallot } from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/** The one method of an EIP-1193 provider this needs. */
export interface Eip1193Provider {
  request(args: {
    readonly method: string;
    readonly params?: readonly unknown[];
  }): Promise<unknown>;
}

export const SUBMIT_BALLOT_SIGNATURE = "submitBallot(bytes)";
export const BALLOT_SUBMITTED_SIGNATURE = "BallotSubmitted(bytes32,bytes32,bytes)";
export const RELAYED_BALLOT_SUBMITTED_SIGNATURE =
  "RelayedBallotSubmitted(bytes32,bytes32,uint64,uint64,uint64,uint64,bytes)";

const utf8 = (s: string) => new TextEncoder().encode(s);
const selectorOf = (signature: string) => keccak_256(utf8(signature)).slice(0, 4);

const SUBMIT_BALLOT = selectorOf(SUBMIT_BALLOT_SIGNATURE);
const BALLOT_SUBMITTED = keccak_256(utf8(BALLOT_SUBMITTED_SIGNATURE));
const RELAYED_BALLOT_SUBMITTED = keccak_256(utf8(RELAYED_BALLOT_SUBMITTED_SIGNATURE));

const U64_MAX = (1n << 64n) - 1n;
const pad32 = (n: number) => Math.ceil(n / 32) * 32;

function word(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

function readWord(b: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = at; i < at + 32; i++) v = (v << 8n) | BigInt(b[i] ?? 0);
  return v;
}

/** `abi.encode(bytes)`: the offset, the length, the bytes zero-padded to a word. */
function encodeBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(64 + pad32(b.length));
  out.set(word(32n), 0);
  out.set(word(BigInt(b.length)), 32);
  out.set(b, 64);
  return out;
}

/** `abi.decode(data, (bytes))` with every word as `abi.encode` writes it, else `undefined`. */
function decodeBytesAt(data: Uint8Array, head: number): Uint8Array | undefined {
  if (data.length < head + 32 || readWord(data, head) !== BigInt(32 * (head / 32 + 1)))
    return undefined;
  const at = head + 32;
  if (data.length < at + 32) return undefined;
  const length = readWord(data, at);
  if (length > BigInt(data.length) || data.length !== at + 32 + pad32(Number(length)))
    return undefined;
  const end = at + 32 + Number(length);
  if (data.subarray(end).some((b) => b !== 0)) return undefined;
  return data.subarray(at + 32, end);
}

/**
 * `submitBallot(record)`'s calldata in the one encoding the board accepts
 * (Calls; `CanonicalCalldata`): the selector, the offset `0x20`, the length,
 * the record zero-padded to a word and nothing after, so the transaction
 * carries no byte the record doesn't (T-17).
 */
export function submitBallotCalldata(record: Uint8Array): Uint8Array {
  if (!(record instanceof Uint8Array)) throw new TypeError("record must be a Uint8Array");
  const args = encodeBytes(record);
  const out = new Uint8Array(4 + args.length);
  out.set(SUBMIT_BALLOT, 0);
  out.set(args, 4);
  return out;
}

/** A decode error the board reports, in `ElectionDefinitionLib.DecodeError`'s order. */
const DECODE_CODES = [
  "truncated",
  "trailing-bytes",
  "length-over-max",
  "unknown-record-type",
  "unexpected-record-type",
  "unknown-version",
  "invalid-enum",
  "non-canonical",
  "profile-mismatch",
] as const;
export type BoardDecodeCode = (typeof DECODE_CODES)[number];

/** An admission code the board reports, in `BallotCheckLib.Code`'s order. */
const ADMISSION_CODES = [
  "ballot-stray",
  "ballot-tier",
  "ballot-cell",
  "validity-shape",
  "share-hash-unqualified",
  "membership-proof",
] as const;
export type BoardAdmissionCode = (typeof ADMISSION_CODES)[number];

/**
 * Why the board refuses a ballot (docs/spec/contracts.md, Board, Ballots and
 * Calls), from its revert data:
 *
 * - `malformed` and `refused`: the record itself, which resending doesn't
 *   change. An honest client's ballot is refused only if it was made for
 *   another election or deployment, or isn't a member's (T-25: the board
 *   refuses only what the verifier rejects). It is the provider's report
 *   (module comment).
 * - `window`: the block's time is outside the election's window. Before
 *   `opensAt` it can be sent later; after `closesAt` this path is shut, and
 *   only a ballot already relayed through L1 can still count (docs/spec/close.md).
 * - `gas`: the call had too little gas for the membership check's pairing,
 *   which reverts unless `PAIRING_GAS + PAIRING_GAS / 63 + 1,000` (about
 *   610,500) is left (Membership proofs).
 * - `calldata`: not the canonical encoding; this client never sends one.
 * - `unknown`: revert data the board's ballot path doesn't produce.
 */
export type BoardBallotRefusal =
  | { readonly kind: "malformed"; readonly code: BoardDecodeCode; readonly offset: number }
  | { readonly kind: "refused"; readonly code: BoardAdmissionCode }
  | {
      readonly kind: "window";
      readonly timestamp: bigint;
      readonly opensAt: bigint;
      readonly closesAt: bigint;
    }
  | { readonly kind: "gas" }
  | { readonly kind: "calldata" }
  | { readonly kind: "unknown"; readonly data: Uint8Array };

const ERRORS = {
  malformed: selectorOf("BallotMalformed(uint8,uint256)"),
  refused: selectorOf("BallotRefused(uint8)"),
  window: selectorOf("BallotWindow(uint256,uint64,uint64)"),
  calldata: selectorOf("NonCanonicalCalldata()"),
  insufficientGas: selectorOf("InsufficientGas()"),
  precompileFailed: selectorOf("PrecompileFailed()"),
};

/** Reads the board's revert data for `submitBallot`; anything it doesn't produce is `unknown`. */
export function decodeBoardBallotRevert(data: Uint8Array): BoardBallotRefusal {
  if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
  const unknown = { kind: "unknown", data: data.slice() } as const;
  // Each error's selector and exactly its static arguments, nothing after.
  const is = (selector: Uint8Array, words: number) =>
    data.length === 4 + 32 * words && selector.every((b, i) => data[i] === b);
  const index = (codes: readonly string[]) => {
    const v = readWord(data, 4);
    return v < BigInt(codes.length) ? Number(v) : undefined;
  };
  if (is(ERRORS.malformed, 2)) {
    const i = index(DECODE_CODES);
    const offset = readWord(data, 36);
    if (i === undefined || offset > BigInt(Number.MAX_SAFE_INTEGER)) return unknown;
    return { kind: "malformed", code: DECODE_CODES[i] as BoardDecodeCode, offset: Number(offset) };
  }
  if (is(ERRORS.refused, 1)) {
    const i = index(ADMISSION_CODES);
    return i === undefined
      ? unknown
      : { kind: "refused", code: ADMISSION_CODES[i] as BoardAdmissionCode };
  }
  if (is(ERRORS.window, 3)) {
    const [timestamp, opensAt, closesAt] = [4, 36, 68].map((at) => readWord(data, at)) as [
      bigint,
      bigint,
      bigint,
    ];
    if (opensAt > U64_MAX || closesAt > U64_MAX) return unknown;
    return { kind: "window", timestamp, opensAt, closesAt };
  }
  if (is(ERRORS.insufficientGas, 0) || is(ERRORS.precompileFailed, 0)) return { kind: "gas" };
  if (is(ERRORS.calldata, 0)) return { kind: "calldata" };
  return unknown;
}

/** Where the board's event for the record is, as the provider's node reports it. */
export interface BoardEventLocation {
  /** `ordinary` for `BallotSubmitted`, `relayed` for a deposit's `RelayedBallotSubmitted`. */
  readonly path: "ordinary" | "relayed";
  readonly transactionHash: Uint8Array;
  readonly blockNumber: bigint;
  readonly blockHash: Uint8Array;
  readonly logIndex: bigint;
}

export type DirectSubmitResult =
  /** This call's transaction emitted the record's event. */
  | ({ readonly status: "submitted" } & BoardEventLocation)
  /** The board already held the record, through an earlier call by anyone, on either path. */
  | ({ readonly status: "already-on-board" } & BoardEventLocation)
  /** The board refuses the record; nothing was sent, or the transaction reverted. */
  | {
      readonly status: "refused";
      readonly refusal: BoardBallotRefusal;
      /** The reverted transaction, if the refusal came after sending. */
      readonly transactionHash?: Uint8Array;
    };

export type DirectSubmitErrorCode =
  /** The provider's chain isn't the election's L2 (`l2_chain_id`). */
  | "wrong-chain"
  /**
   * The provider answered with something no Ethereum node returns, or
   * something the board can't have done (accepting a record it can't frame).
   */
  | "bad-response"
  /** The transaction wasn't mined within the polls allowed. */
  | "receipt-timeout"
  /** The transaction reverted and the board, asked again, accepts the record. */
  | "reverted"
  /**
   * The board's event for the record carries another ballot hash than the
   * record's, or the board accepted the record without any event the
   * provider can find.
   */
  | "event-mismatch";

export class DirectSubmitError extends Error {
  override readonly name = "DirectSubmitError";
  constructor(
    readonly code: DirectSubmitErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface DirectSubmitOptions {
  /** The wallet's provider, connected to the election's L2. */
  readonly provider: Eip1193Provider;
  /** The definition's `l2_chain_id`. */
  readonly chainId: bigint;
  /** The definition's `board`, 20 bytes. */
  readonly board: Uint8Array;
  /**
   * The account that signs and pays, 20 bytes: one the wallet holds, fresh
   * and privately funded, since it is linked to the ballot on chain (T-25).
   */
  readonly from: Uint8Array;
  /** The ballot record (`0x0002`) as cast; the board judges it, not this client. */
  readonly record: Uint8Array;
  /**
   * The first L2 block the search for an earlier copy reads: the election's
   * registration block, since no ballot can precede it. Required, as public
   * RPCs cap the range `eth_getLogs` reads.
   */
  readonly fromBlock: bigint;
  /** Polls for the transaction's receipt before `receipt-timeout` (default 120). */
  readonly maxPolls?: number;
  /** Milliseconds between polls (default 1,000). */
  readonly pollInterval?: number;
  /** Waits between polls; injectable so tests and apps own time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const hex = (b: Uint8Array) => `0x${bytesToHex(b)}`;
const quantity = (v: bigint) => `0x${v.toString(16)}`;

function bytesArg(name: string, b: unknown, length?: number): Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
  if (length !== undefined && b.length !== length)
    throw new TypeError(`${name} must be ${length} bytes`);
  return b;
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function bad(what: string, cause?: unknown): DirectSubmitError {
  return new DirectSubmitError("bad-response", `the provider returned ${what}`, { cause });
}

function dataOf(value: unknown, what: string): Uint8Array {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw bad(what);
  return hexToBytes(value.slice(2));
}

function quantityOf(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw bad(what);
  return BigInt(value);
}

function fixed(value: unknown, length: number, what: string): Uint8Array {
  const b = dataOf(value, what);
  if (b.length !== length) throw bad(what);
  return b;
}

/**
 * The revert data in a provider's error, wherever the node or wallet put it
 * (`data`, or `data.data`, or a wrapped `error.data`); `undefined` if the
 * error isn't a revert, such as a network failure or a rejected request.
 */
export function revertDataOf(error: unknown): Uint8Array | undefined {
  const seen = new Set<unknown>();
  const visit = (e: unknown): Uint8Array | undefined => {
    if (typeof e !== "object" || e === null || seen.has(e)) return undefined;
    seen.add(e);
    const record = e as { data?: unknown; error?: unknown; cause?: unknown };
    if (typeof record.data === "string" && /^0x([0-9a-fA-F]{2})*$/.test(record.data))
      return hexToBytes(record.data.slice(2));
    return visit(record.data) ?? visit(record.error) ?? visit(record.cause);
  };
  return visit(error);
}

interface RpcLog {
  readonly address: Uint8Array;
  readonly topics: readonly Uint8Array[];
  readonly data: Uint8Array;
  readonly removed: boolean;
  readonly transactionHash: Uint8Array;
  readonly blockNumber: bigint;
  readonly blockHash: Uint8Array;
  readonly logIndex: bigint;
}

function parseLog(value: unknown): RpcLog {
  if (typeof value !== "object" || value === null) throw bad("a log that isn't an object");
  const log = value as Record<string, unknown>;
  if (!Array.isArray(log.topics)) throw bad("a log without topics");
  if (log.removed !== undefined && typeof log.removed !== "boolean")
    throw bad("a log's removed flag");
  return {
    address: fixed(log.address, 20, "a log address"),
    topics: log.topics.map((t: unknown) => fixed(t, 32, "a log topic")),
    data: dataOf(log.data, "log data"),
    removed: log.removed === true,
    transactionHash: fixed(log.transactionHash, 32, "a log's transaction hash"),
    blockNumber: quantityOf(log.blockNumber, "a log's block number"),
    blockHash: fixed(log.blockHash, 32, "a log's block hash"),
    logIndex: quantityOf(log.logIndex, "a log index"),
  };
}

/** The record an event of the board carries, by its topic 0, if its data is well formed. */
function eventRecord(
  topic0: Uint8Array,
  data: Uint8Array,
): ["ordinary" | "relayed", Uint8Array] | undefined {
  if (equal(topic0, BALLOT_SUBMITTED)) {
    const record = decodeBytesAt(data, 0);
    return record === undefined ? undefined : ["ordinary", record];
  }
  if (equal(topic0, RELAYED_BALLOT_SUBMITTED)) {
    // abi.encode(index, l1Block, stamp, gasLimit, record): four uint64 words.
    for (let at = 0; at < 128; at += 32) if (readWord(data, at) > U64_MAX) return undefined;
    const record = decodeBytesAt(data, 128);
    return record === undefined ? undefined : ["relayed", record];
  }
  return undefined;
}

/**
 * The record's event among `logs`, if any: from the board, not removed by a
 * reorganisation, `BallotSubmitted` or `RelayedBallotSubmitted` under the
 * record's definition hash, carrying the record whole. One carrying the
 * record under another ballot hash means the board or the provider disagrees
 * with crypto's hash of it, never an honest answer.
 */
function findEvent(
  logs: readonly RpcLog[],
  board: Uint8Array,
  record: Uint8Array,
  framed: { readonly definitionHash: Uint8Array; readonly ballotHash: Uint8Array },
): BoardEventLocation | undefined {
  for (const log of logs) {
    const [topic0, topic1, topic2] = log.topics;
    if (log.removed || !equal(log.address, board) || log.topics.length !== 3) continue;
    if (topic0 === undefined || topic1 === undefined || topic2 === undefined) continue;
    if (!equal(topic1, framed.definitionHash)) continue;
    const carried = eventRecord(topic0, log.data);
    if (carried === undefined || !equal(carried[1], record)) continue;
    if (!equal(topic2, framed.ballotHash))
      throw new DirectSubmitError(
        "event-mismatch",
        `the board's event names ballot hash ${hex(topic2)}, not ${hex(framed.ballotHash)}`,
      );
    const { transactionHash, blockNumber, blockHash, logIndex } = log;
    return { path: carried[0], transactionHash, blockNumber, blockHash, logIndex };
  }
  return undefined;
}

/**
 * Sends `record` to the board through the voter's wallet, once (module
 * comment). Returns where the board's event is, or the board's refusal;
 * throws a `DirectSubmitError`, or the provider's own error, when it can't
 * tell. Retrying is the caller's: any result but `submitted` or
 * `already-on-board` leaves the ballot off this path.
 */
export async function directSubmitBallot(
  options: DirectSubmitOptions,
): Promise<DirectSubmitResult> {
  const { provider } = options;
  const board = bytesArg("board", options.board, 20);
  const from = bytesArg("from", options.from, 20);
  const record = bytesArg("record", options.record);
  if (typeof options.chainId !== "bigint" || options.chainId <= 0n)
    throw new TypeError("chainId must be a positive bigint");
  const { fromBlock } = options;
  const maxPolls = options.maxPolls ?? 120;
  const pollInterval = options.pollInterval ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (typeof fromBlock !== "bigint" || fromBlock < 0n) throw new TypeError("fromBlock must be ≥ 0");
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1) throw new TypeError("maxPolls must be ≥ 1");

  // T-34, T-41: a wallet on another chain would put the ballot where no
  // verifier of this election reads. Checked again before the receipt is
  // read, and the transaction names the chain, so a switch in between is
  // refused by the wallet rather than sent elsewhere.
  const onChain = async () => {
    const chainId = quantityOf(await provider.request({ method: "eth_chainId" }), "a chain ID");
    if (chainId !== options.chainId)
      throw new DirectSubmitError(
        "wrong-chain",
        `the wallet is on chain ${chainId}, the election's L2 is ${options.chainId}`,
      );
  };
  await onChain();

  const data = hex(submitBallotCalldata(record));
  // The board never reads the sender on this path, so its question carries
  // none (T-11).
  const preflight = { to: hex(board), data };
  const call = { from: hex(from), ...preflight };
  const refusalOf = (e: unknown): BoardBallotRefusal => {
    const revert = revertDataOf(e);
    if (revert === undefined) throw e;
    return decodeBoardBallotRevert(revert);
  };
  const ask = async (): Promise<BoardBallotRefusal | undefined> => {
    try {
      await provider.request({ method: "eth_call", params: [preflight, "latest"] });
      return undefined;
    } catch (e) {
      return refusalOf(e);
    }
  };

  const refusal = await ask();
  if (refusal !== undefined) return { status: "refused", refusal };
  // The board accepted it, so it frames: its hashes are crypto's, never the
  // caller's (docs/spec/ballot-validity.md, Ballot hash).
  const framed = frameBallot(record);
  if (framed === undefined) throw bad("the board's acceptance of a record it can't frame");

  const earlier = async (): Promise<BoardEventLocation | undefined> => {
    const logs = await provider.request({
      method: "eth_getLogs",
      params: [
        {
          address: hex(board),
          fromBlock: quantity(fromBlock),
          toBlock: "latest",
          topics: [
            [hex(BALLOT_SUBMITTED), hex(RELAYED_BALLOT_SUBMITTED)],
            hex(framed.definitionHash),
            hex(framed.ballotHash),
          ],
        },
      ],
    });
    if (!Array.isArray(logs)) throw bad("logs that aren't a list");
    return findEvent(logs.map(parseLog), board, record, framed);
  };
  // The board takes a repeat as a no-op that emits nothing, whichever path
  // brought the first copy, so a copy it already holds is found, not sent
  // again (Calls, Repeats; Relayed ballots; T-17).
  const held = await earlier();
  if (held !== undefined) return { status: "already-on-board", ...held };

  let estimate: bigint;
  try {
    estimate = quantityOf(
      await provider.request({ method: "eth_estimateGas", params: [call] }),
      "a gas estimate",
    );
  } catch (e) {
    // The window may close, or the chain move, between the two questions.
    if (e instanceof DirectSubmitError) throw e;
    return { status: "refused", refusal: refusalOf(e) };
  }
  // A quarter more than the estimate: the membership check reverts unless
  // the pairing's gas is left, so a tight limit is a revert, never a
  // cheaper success (Membership proofs).
  const gas = estimate + estimate / 4n;
  const transactionHash = fixed(
    await provider.request({
      method: "eth_sendTransaction",
      params: [{ ...call, gas: quantity(gas), chainId: quantity(options.chainId) }],
    }),
    32,
    "a transaction hash",
  );
  await onChain();

  let receipt: unknown = null;
  for (let poll = 0; receipt === null || receipt === undefined; poll++) {
    if (poll === maxPolls)
      throw new DirectSubmitError(
        "receipt-timeout",
        `transaction ${hex(transactionHash)} wasn't mined after ${maxPolls} polls`,
      );
    if (poll > 0) await sleep(pollInterval);
    receipt = await provider.request({
      method: "eth_getTransactionReceipt",
      params: [hex(transactionHash)],
    });
  }
  if (typeof receipt !== "object") throw bad("a receipt that isn't an object");
  const fields = receipt as { transactionHash?: unknown; status?: unknown; logs?: unknown };
  if (!equal(fixed(fields.transactionHash, 32, "a receipt's transaction hash"), transactionHash))
    throw bad("another transaction's receipt");
  if (quantityOf(fields.status, "a receipt status") !== 1n) {
    // Mined and reverted: the window closed, gas ran short or the chain
    // moved. The board's answer now says which; if it accepts the record,
    // the caller may send again.
    const now = await ask();
    if (now !== undefined) return { status: "refused", refusal: now, transactionHash };
    const copy = await earlier();
    if (copy !== undefined) return { status: "already-on-board", ...copy };
    throw new DirectSubmitError(
      "reverted",
      `transaction ${hex(transactionHash)} reverted, and the board accepts the record now`,
    );
  }
  if (!Array.isArray(fields.logs)) throw bad("a receipt without logs");
  const ours = fields.logs
    .map(parseLog)
    .filter((log) => equal(log.transactionHash, transactionHash));
  const emitted = findEvent(ours, board, record, framed);
  if (emitted !== undefined) return { status: "submitted", ...emitted };
  // Accepted without an event: another call put the same bytes on the board
  // first, so this one was the no-op.
  const copy = await earlier();
  if (copy !== undefined) return { status: "already-on-board", ...copy };
  throw new DirectSubmitError(
    "event-mismatch",
    `transaction ${hex(transactionHash)} succeeded with no event for the record`,
  );
}
