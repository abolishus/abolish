// The ballot client's forced path (docs/spec/contracts.md, L1 relay; P4-2
// part 2): when the sequencer censors a voter's direct submission, the
// ballot record goes to the L1 relay through the voter's own L1 wallet. The
// relay records the call with its L1 block and timestamp, the stamp the close
// rule judges, and deposits the record to the board through the L2's portal,
// which the L2 must include within its sequencing window whatever the
// sequencer wants (T-50, T-25; docs/adr/0004-l2-choice.md, Forced inclusion).
//
// It holds no key and picks no account: the wallet signs and pays on L1, so
// the paying account is linked to the ballot on L1 for good, in the call, the
// portal's log and the deposit, as a direct submission's is on L2 (T-25,
// Residual; T-11). The L2 provider only reads, and needs no account.
//
// One call is one attempt, and every attempt that lands is paid for and
// archived: the board takes every relayed deposit it accepts, a repeat
// included (Board, Relayed ballots, No repeats on this path). So it asks
// first: the relay's framing, locally; whether the board already holds a
// relayed copy of the record that the relay's stored word matches; and the
// board, on L2, as the deposit will run (from the relay's alias, at the L1
// head's stamp), returning its refusal without spending L1 gas. It gives the
// deposit a gas limit a quarter over the board's own estimate, never below
// what the deposit needs by its size alone (`relayDepositGasFloor`, which no
// node's answer lowers) or the portal's minimum, since too little leaves the
// call recorded and the deposit reverted on L2, read as the caller's mistake
// (L1 relay, The gas limit is the caller's). And it refuses a call whose L1
// transaction would cost more than one transaction may spend (EIP-7825's
// 2²⁴): the portal burns L1 gas in proportion to the deposit's gas limit and
// the deposit market's price, so a state actor filling that market can price
// a large forced ballot out (T-50).
//
// What it returns is what the providers' nodes report: as on the ordinary
// path, a client MUST NOT stand down on `relayed` or `already-relayed` until
// the board's event is derivable from finalized L1 data through a node it
// chose (docs/spec/delivery.md, Client rules), and SHOULD confirm a refusal
// through a node it chose (T-25). The deposit reaches L2 minutes to hours
// later; `findRelayedBallot` looks for its event there.

import {
  frameBallot,
  frameRelayRecord,
  l2Alias,
  RELAY_EVENT_SIGNATURE,
  relayBallotCalldata,
  relayCallHash,
  relayDepositData,
} from "@abolishus/crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { concatBytes } from "@noble/hashes/utils.js";
import {
  bad,
  type BoardBallotRefusal,
  type BoardEventLocation,
  bytesArg,
  dataOf,
  decodeBoardBallotRevert,
  DirectSubmitError,
  type Eip1193Provider,
  equal,
  findEvent,
  fixed,
  hex,
  parseLog,
  quantity,
  quantityOf,
  readWord,
  RELAYED_BALLOT_SUBMITTED_SIGNATURE,
  type RelayedCallFields,
  revertDataOf,
  U64_MAX,
  word,
} from "./direct-submit.ts";

const utf8 = (s: string) => new TextEncoder().encode(s);
const selectorOf = (signature: string) => keccak_256(utf8(signature)).slice(0, 4);

const RELAYED_BALLOT_SUBMITTED = keccak_256(utf8(RELAYED_BALLOT_SUBMITTED_SIGNATURE));
const BALLOT_RELAYED = keccak_256(utf8(RELAY_EVENT_SIGNATURE));
const RELAY_BOARD = selectorOf("board()");
const RELAY_CALL_COUNT = selectorOf("callCount()");
const RELAY_CALL_HASH = selectorOf("callHash(uint64)");
/** How nodes word an estimate that needs more gas than they will search (geth, reth, Anvil). */
const OVER_ALLOWANCE =
  /exceeds (the )?allowance|exceeds block gas limit|gas limit too high|out of gas/i;

/**
 * EIP-7825's cap on one transaction's gas, 2²⁴: a relay call whose estimate
 * passes it can't be sent at all until the deposit market's price falls.
 */
export const MAX_TRANSACTION_GAS = 1n << 24n;

/**
 * The OP Stack portal's floor on a deposit's gas limit for `n` bytes of data,
 * `21,000 + 40n` (`OptimismPortal2.minimumGasLimit`): below it the deposit,
 * and so the relay call, reverts on L1.
 */
export function portalMinimumGasLimit(dataLength: number): bigint {
  if (!Number.isSafeInteger(dataLength) || dataLength < 0)
    throw new RangeError("dataLength must be a non-negative integer");
  return 21_000n + 40n * BigInt(dataLength);
}

/**
 * What the board's relayed-ballot call needs whatever any node says: the
 * pairing's reserve, `PAIRING_GAS + PAIRING_GAS / 63 + 1,000` with
 * `PAIRING_GAS` 600,000 (Board, Membership proofs), without which the
 * membership check reverts.
 */
const MEMBERSHIP_RESERVE = 600_000n + 600_000n / 63n + 1_000n;
/** The ballot check's framing and hashing, at most about 22 gas a record byte (Board, Gas), doubled. */
const CHECK_GAS_PER_BYTE = 40n;
/** Cold registry reads, the accepted-bytes word, the accumulator step and the event, generously. */
const CHECK_GAS_BASE = 150_000n;

/**
 * The least gas limit the client gives a deposit of `data` carrying a
 * `recordLength`-byte record, from the data alone: its intrinsic gas at
 * EIP-7623's floor price (10 a token, a non-zero byte four tokens, which
 * covers the standard price too), the membership check's reserve, and the
 * ballot check's cost by the record's size. An L2 node's estimate only ever
 * raises the limit above this, so a node that understates it can't make the
 * deposit run out of gas, which the verifier would read as the caller's
 * mistake (L1 relay, The gas limit is the caller's; T-50).
 */
export function relayDepositGasFloor(data: Uint8Array, recordLength: number): bigint {
  if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
  if (!Number.isSafeInteger(recordLength) || recordLength < 0)
    throw new RangeError("recordLength must be a non-negative integer");
  let tokens = 0n;
  for (const b of data) tokens += b === 0 ? 1n : 4n;
  return (
    21_000n +
    10n * tokens +
    MEMBERSHIP_RESERVE +
    CHECK_GAS_PER_BYTE * BigInt(recordLength) +
    CHECK_GAS_BASE
  );
}

/**
 * Why the board refuses a relayed deposit (Board, Relayed ballots), from its
 * revert data: the ordinary path's refusals, read as `decodeBoardBallotRevert`
 * reads them, with `relay-window` as `window` (the stamp in `timestamp`) and
 * `relay-sender`, which only a board deployed for another relay gives.
 */
export type RelayedBallotRefusal = BoardBallotRefusal | { readonly kind: "sender" };

const BOARD_ERRORS = {
  relaySender: selectorOf("RelaySender(address)"),
  relayWindow: selectorOf("RelayWindow(uint64,uint64,uint64)"),
};

const has = (data: Uint8Array, selector: Uint8Array, words: number) =>
  data.length === 4 + 32 * words && selector.every((b, i) => data[i] === b);

/** Reads the board's revert data for `submitRelayedBallot`; anything it doesn't produce is `unknown`. */
export function decodeRelayedBallotRevert(data: Uint8Array): RelayedBallotRefusal {
  if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
  if (has(data, BOARD_ERRORS.relaySender, 1))
    return readWord(data, 4) < 1n << 160n
      ? { kind: "sender" }
      : { kind: "unknown", data: data.slice() };
  if (has(data, BOARD_ERRORS.relayWindow, 3)) {
    const [timestamp, opensAt, closesAt] = [4, 36, 68].map((at) => readWord(data, at)) as [
      bigint,
      bigint,
      bigint,
    ];
    if ([timestamp, opensAt, closesAt].some((v) => v > U64_MAX))
      return { kind: "unknown", data: data.slice() };
    return { kind: "window", timestamp, opensAt, closesAt };
  }
  // The ordinary path's window error isn't the relayed path's.
  const ordinary = decodeBoardBallotRevert(data);
  return ordinary.kind === "window" ? { kind: "unknown", data: data.slice() } : ordinary;
}

/**
 * Why the relay refuses a call (L1 relay, Relaying), in its order:
 * `relay-calldata` (`calldata`; this client never sends one), then the
 * framing codes with the length or type the relay reports, and `unknown`
 * for anything else, a portal's revert included (a gas limit outside its
 * metering's bounds).
 */
export type RelayRefusal =
  | { readonly kind: "calldata" }
  | { readonly kind: "relay-too-large"; readonly length: bigint }
  | { readonly kind: "relay-truncated"; readonly length: bigint }
  | { readonly kind: "relay-record-type"; readonly recordType: number }
  | { readonly kind: "unknown"; readonly data: Uint8Array };

const RELAY_ERRORS = {
  calldata: selectorOf("NonCanonicalCalldata()"),
  tooLarge: selectorOf("RelayTooLarge(uint256)"),
  truncated: selectorOf("RelayTruncated(uint256)"),
  recordType: selectorOf("RelayRecordType(uint16)"),
};

/** Reads the relay's revert data for `relayBallot`; anything it doesn't produce is `unknown`. */
export function decodeRelayRevert(data: Uint8Array): RelayRefusal {
  if (!(data instanceof Uint8Array)) throw new TypeError("data must be a Uint8Array");
  if (has(data, RELAY_ERRORS.calldata, 0)) return { kind: "calldata" };
  if (has(data, RELAY_ERRORS.tooLarge, 1))
    return { kind: "relay-too-large", length: readWord(data, 4) };
  if (has(data, RELAY_ERRORS.truncated, 1))
    return { kind: "relay-truncated", length: readWord(data, 4) };
  if (has(data, RELAY_ERRORS.recordType, 1)) {
    const recordType = readWord(data, 4);
    if (recordType <= 0xffffn) return { kind: "relay-record-type", recordType: Number(recordType) };
  }
  return { kind: "unknown", data: data.slice() };
}

/** The call the relay recorded for this attempt, as its L1 receipt and block show it. */
export interface RelayedCall extends RelayedCallFields {
  /** The word the relay stored for the call, recomputed from its fields and the record. */
  readonly callHash: Uint8Array;
  readonly transactionHash: Uint8Array;
  /** The L1 block the call ran in, whose number and timestamp are `l1Block` and `stamp`. */
  readonly blockHash: Uint8Array;
}

export type RelayBallotResult =
  /** The relay recorded the call and made the deposit; `findRelayedBallot` finds it on L2. */
  | { readonly status: "relayed"; readonly call: RelayedCall }
  /** The board already holds a relayed copy of the record (on any call), so none was made. */
  | ({ readonly status: "already-relayed" } & BoardEventLocation)
  /** The board, asked on L2 as the deposit would run, refuses the record; nothing was sent. */
  | { readonly status: "refused"; readonly by: "board"; readonly refusal: RelayedBallotRefusal }
  /** The relay refuses the call; nothing was sent, or the transaction reverted. */
  | {
      readonly status: "refused";
      readonly by: "relay";
      readonly refusal: RelayRefusal;
      /** The reverted transaction, if the refusal came after sending. */
      readonly transactionHash?: Uint8Array;
    }
  /**
   * The call's L1 transaction would need more than `MAX_TRANSACTION_GAS`
   * (`estimate`, or none where the node found no estimate under its cap):
   * the deposit market is priced too high for this ballot now (T-50).
   */
  | { readonly status: "over-cap"; readonly estimate?: bigint; readonly gasLimit: bigint };

export interface RelayBallotOptions {
  /** The voter's L1 wallet. */
  readonly l1Provider: Eip1193Provider;
  /** The definition's `l1_chain_id`. */
  readonly l1ChainId: bigint;
  /** The definition's `l1_relay`, 20 bytes. */
  readonly relay: Uint8Array;
  /** A provider on the election's L2, only read. */
  readonly l2Provider: Eip1193Provider;
  /** The definition's `l2_chain_id`. */
  readonly l2ChainId: bigint;
  /** The definition's `board`, 20 bytes. */
  readonly board: Uint8Array;
  /**
   * The L1 account that signs and pays, 20 bytes: fresh and privately
   * funded, since it is linked to the ballot for good (T-25, T-11).
   */
  readonly from: Uint8Array;
  /** The ballot record (`0x0002`) as cast. */
  readonly record: Uint8Array;
  /** The first L2 block the search for a relayed copy reads: the election's registration block. */
  readonly fromBlock: bigint;
  /** Polls for the L1 receipt before `receipt-timeout` (default 120). */
  readonly maxPolls?: number;
  /** Milliseconds between polls (default 1,000). */
  readonly pollInterval?: number;
  /** Waits between polls; injectable so tests and apps own time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Head {
  readonly number: bigint;
  readonly timestamp: bigint;
  readonly hash: Uint8Array;
}

function headOf(value: unknown, what: string): Head {
  if (typeof value !== "object" || value === null) throw bad(what);
  const block = value as { number?: unknown; timestamp?: unknown; hash?: unknown };
  return {
    number: quantityOf(block.number, `${what}'s number`),
    timestamp: quantityOf(block.timestamp, `${what}'s timestamp`),
    hash: fixed(block.hash, 32, `${what}'s hash`),
  };
}

function chainIdArg(name: string, v: unknown): bigint {
  if (typeof v !== "bigint" || v <= 0n || v > U64_MAX)
    throw new TypeError(`${name} must be a positive bigint below 2^64`);
  return v;
}

async function onChain(provider: Eip1193Provider, expected: bigint, which: string) {
  const chainId = quantityOf(await provider.request({ method: "eth_chainId" }), "a chain ID");
  if (chainId !== expected)
    throw new DirectSubmitError(
      "wrong-chain",
      `the ${which} provider is on chain ${chainId}, the election's is ${expected}`,
    );
}

/** The board's relayed events for `record`, from `fromBlock`, by the provider's report. */
async function relayedCopies(
  provider: Eip1193Provider,
  board: Uint8Array,
  record: Uint8Array,
  framed: { readonly definitionHash: Uint8Array; readonly ballotHash: Uint8Array },
  fromBlock: bigint,
  accept: (call: RelayedCallFields) => boolean,
): Promise<(BoardEventLocation & { readonly path: "relayed" })[]> {
  const logs = await provider.request({
    method: "eth_getLogs",
    params: [
      {
        address: hex(board),
        fromBlock: quantity(fromBlock),
        toBlock: "latest",
        topics: [hex(RELAYED_BALLOT_SUBMITTED), hex(framed.definitionHash), hex(framed.ballotHash)],
      },
    ],
  });
  if (!Array.isArray(logs)) throw bad("logs that aren't a list");
  return logs.flatMap((log) => {
    const found = findEvent(
      [parseLog(log)],
      board,
      record,
      framed,
      (carried) => carried.path === "relayed" && accept(carried.call),
    );
    return found?.path === "relayed" ? [found] : [];
  });
}

/**
 * Forces `record` through the L1 relay with the voter's L1 wallet, once
 * (module comment). Returns the call the relay recorded, the board's relayed
 * copy already on L2, or why nothing was sent; throws a `DirectSubmitError`,
 * or a provider's own error, when it can't tell.
 */
export async function relayBallot(options: RelayBallotOptions): Promise<RelayBallotResult> {
  const { l1Provider, l2Provider } = options;
  const relay = bytesArg("relay", options.relay, 20);
  const board = bytesArg("board", options.board, 20);
  const from = bytesArg("from", options.from, 20);
  const record = bytesArg("record", options.record);
  const l1ChainId = chainIdArg("l1ChainId", options.l1ChainId);
  const l2ChainId = chainIdArg("l2ChainId", options.l2ChainId);
  const { fromBlock } = options;
  const maxPolls = options.maxPolls ?? 120;
  const pollInterval = options.pollInterval ?? 1_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (typeof fromBlock !== "bigint" || fromBlock < 0n) throw new TypeError("fromBlock must be ≥ 0");
  if (!Number.isSafeInteger(maxPolls) || maxPolls < 1) throw new TypeError("maxPolls must be ≥ 1");

  // The relay's own framing needs no node, and a record it refuses is
  // refused on every path.
  const framing = frameRelayRecord(record);
  if (!framing.ok) {
    const refusal: RelayRefusal =
      framing.code === "relay-record-type"
        ? { kind: framing.code, recordType: ((record[0] ?? 0) << 8) | (record[1] ?? 0) }
        : { kind: framing.code, length: BigInt(record.length) };
    return { status: "refused", by: "relay", refusal };
  }

  // T-34, T-41: a provider on another chain would record the call, or read
  // the board, where no verifier of this election looks.
  await onChain(l1Provider, l1ChainId, "L1");
  await onChain(l2Provider, l2ChainId, "L2");

  // A relay deployed for another board deposits where this election's
  // verifier never reads; the board's sender check below is the converse.
  const relayBoard = dataOf(
    await l1Provider.request({
      method: "eth_call",
      params: [{ to: hex(relay), data: hex(RELAY_BOARD) }, "latest"],
    }),
    "the relay's board",
  );
  if (relayBoard.length !== 32 || readWord(relayBoard, 0) >= 1n << 160n)
    throw bad("the relay's board");
  if (!equal(relayBoard.subarray(12), board))
    throw new DirectSubmitError(
      "wrong-relay",
      `the relay deposits to ${hex(relayBoard.subarray(12))}, not the election's board ${hex(board)}`,
    );
  const count = dataOf(
    await l1Provider.request({
      method: "eth_call",
      params: [{ to: hex(relay), data: hex(RELAY_CALL_COUNT) }, "latest"],
    }),
    "the relay's count",
  );
  if (count.length !== 32 || readWord(count, 0) > U64_MAX) throw bad("the relay's count");
  const head = headOf(
    await l1Provider.request({ method: "eth_getBlockByNumber", params: ["latest", false] }),
    "the L1 head",
  );
  if (head.number >= U64_MAX || head.timestamp >= U64_MAX) throw bad("the L1 head");

  // Every relayed copy the board accepted is archived and judged by its own
  // stamp, so one is enough, even after close; an ordinary copy isn't, since
  // the sequencer can withhold its batch past L_δ (Relayed ballots, No
  // repeats on this path). A copy is taken only if the relay's stored word
  // for its index matches it, so a deposit forged from the alias (T-71),
  // which 4.5 rejects, never makes the client stand down. A record that
  // doesn't frame is the board's to refuse below.
  const framed = frameBallot(record);
  if (framed !== undefined)
    for (const copy of await relayedCopies(
      l2Provider,
      board,
      record,
      framed,
      fromBlock,
      () => true,
    )) {
      const stored = dataOf(
        await l1Provider.request({
          method: "eth_call",
          params: [
            {
              to: hex(relay),
              data: hex(concatBytes(RELAY_CALL_HASH, word(copy.call.index))),
            },
            "latest",
          ],
        }),
        "the relay's call hash",
      );
      const { index, l1Block, stamp, gasLimit } = copy.call;
      const matches = equal(
        stored,
        relayCallHash({ l1ChainId, relay, index, l1Block, l1Timestamp: stamp, gasLimit, record }),
      );
      if (matches) return { status: "already-relayed", ...copy };
    }

  // The deposit as it would run now: the relay's next index, the next L1
  // block, the head's time as the stamp and a gas limit word of the size a
  // real one has. The board judges the record and the stamp, and carries the
  // rest, so its answer and estimate are the deposit's.
  const deposit = (gasLimit: bigint) =>
    relayDepositData(readWord(count, 0), head.number + 1n, head.timestamp, gasLimit, record);
  const probe = {
    from: hex(l2Alias(relay)),
    to: hex(board),
    data: hex(deposit(MAX_TRANSACTION_GAS)),
  };
  try {
    await l2Provider.request({ method: "eth_call", params: [probe, "latest"] });
  } catch (e) {
    const revert = revertDataOf(e);
    if (revert === undefined) throw e;
    return { status: "refused", by: "board", refusal: decodeRelayedBallotRevert(revert) };
  }
  if (framed === undefined) throw bad("the board's acceptance of a record it can't frame");

  let estimate: bigint;
  try {
    estimate = quantityOf(
      await l2Provider.request({ method: "eth_estimateGas", params: [probe] }),
      "a gas estimate",
    );
  } catch (e) {
    if (e instanceof DirectSubmitError) throw e;
    const revert = revertDataOf(e);
    if (revert === undefined) throw e;
    return { status: "refused", by: "board", refusal: decodeRelayedBallotRevert(revert) };
  }
  // A quarter over the estimate, never below what the deposit needs by its
  // size alone (a node can understate an estimate) or the portal's floor.
  const gasLimit = [
    estimate + estimate / 4n,
    // Every word at its widest, so the floor holds for the words the call gets.
    relayDepositGasFloor(
      relayDepositData(U64_MAX, U64_MAX, U64_MAX, U64_MAX, record),
      record.length,
    ),
    portalMinimumGasLimit(deposit(0n).length),
  ].reduce((a, b) => (a > b ? a : b));
  if (gasLimit > U64_MAX) throw bad("a gas estimate");

  const data = hex(relayBallotCalldata(gasLimit, record));
  const ask = async (): Promise<RelayRefusal | undefined> => {
    try {
      await l1Provider.request({
        method: "eth_call",
        params: [{ to: hex(relay), data }, "latest"],
      });
      return undefined;
    } catch (e) {
      const revert = revertDataOf(e);
      if (revert === undefined) throw e;
      return decodeRelayRevert(revert);
    }
  };
  const refusal = await ask();
  if (refusal !== undefined) return { status: "refused", by: "relay", refusal };

  const call = { from: hex(from), to: hex(relay), data };
  let l1Estimate: bigint;
  try {
    l1Estimate = quantityOf(
      await l1Provider.request({ method: "eth_estimateGas", params: [call] }),
      "a gas estimate",
    );
  } catch (e) {
    if (e instanceof DirectSubmitError) throw e;
    const revert = revertDataOf(e);
    // Nodes search for an estimate only up to the transaction cap, and fail
    // without revert data past it.
    if (revert === undefined && OVER_ALLOWANCE.test(e instanceof Error ? e.message : String(e)))
      return { status: "over-cap", gasLimit };
    if (revert === undefined) throw e;
    return { status: "refused", by: "relay", refusal: decodeRelayRevert(revert) };
  }
  if (l1Estimate > MAX_TRANSACTION_GAS)
    return { status: "over-cap", estimate: l1Estimate, gasLimit };
  // A quarter over the estimate, as the deposit market's price can rise
  // between blocks, and never past what one transaction may spend.
  const withMargin = l1Estimate + l1Estimate / 4n;
  const gas = withMargin < MAX_TRANSACTION_GAS ? withMargin : MAX_TRANSACTION_GAS;
  const transactionHash = fixed(
    await l1Provider.request({
      method: "eth_sendTransaction",
      params: [{ ...call, gas: quantity(gas), chainId: quantity(l1ChainId) }],
    }),
    32,
    "a transaction hash",
  );
  await onChain(l1Provider, l1ChainId, "L1");

  let receipt: unknown = null;
  for (let poll = 0; receipt === null || receipt === undefined; poll++) {
    if (poll === maxPolls)
      throw new DirectSubmitError(
        "receipt-timeout",
        `transaction ${hex(transactionHash)} wasn't mined after ${maxPolls} polls`,
      );
    if (poll > 0) await sleep(pollInterval);
    receipt = await l1Provider.request({
      method: "eth_getTransactionReceipt",
      params: [hex(transactionHash)],
    });
  }
  if (typeof receipt !== "object") throw bad("a receipt that isn't an object");
  const fields = receipt as {
    from?: unknown;
    transactionHash?: unknown;
    status?: unknown;
    logs?: unknown;
    blockHash?: unknown;
    blockNumber?: unknown;
  };
  if (!equal(fixed(fields.transactionHash, 32, "a receipt's transaction hash"), transactionHash))
    throw bad("another transaction's receipt");
  // The account is linked to the ballot for good, so one the caller didn't
  // choose is reported, never passed over (T-11).
  if (!equal(fixed(fields.from, 20, "a receipt's sender"), from))
    throw bad("a transaction sent from another account than `from`");
  if (quantityOf(fields.status, "a receipt status") !== 1n) {
    // Mined and reverted: the price rose past the gas given, or the relay
    // refuses now. Nothing was recorded either way.
    const now = await ask();
    if (now !== undefined) return { status: "refused", by: "relay", refusal: now, transactionHash };
    throw new DirectSubmitError(
      "reverted",
      `transaction ${hex(transactionHash)} reverted, and the relay accepts the call now`,
    );
  }
  if (!Array.isArray(fields.logs)) throw bad("a receipt without logs");
  const blockHash = fixed(fields.blockHash, 32, "a receipt's block hash");
  const l1Block = quantityOf(fields.blockNumber, "a receipt's block number");
  const events = fields.logs
    .map(parseLog)
    .filter(
      (log) =>
        !log.removed &&
        equal(log.transactionHash, transactionHash) &&
        equal(log.address, relay) &&
        equal(log.topics[0] ?? new Uint8Array(), BALLOT_RELAYED),
    );
  const [event] = events;
  if (event === undefined || events.length !== 1)
    throw new DirectSubmitError(
      "event-mismatch",
      `transaction ${hex(transactionHash)} has ${events.length} BallotRelayed events, not one`,
    );
  const [, topic1, topic2] = event.topics;
  if (
    event.topics.length !== 3 ||
    topic1 === undefined ||
    topic2 === undefined ||
    !equal(topic1, framing.definitionHash) ||
    readWord(topic2, 0) > U64_MAX ||
    event.data.length !== 32 ||
    !equal(event.blockHash, blockHash) ||
    event.blockNumber !== l1Block
  )
    throw new DirectSubmitError(
      "event-mismatch",
      `the relay's event in ${hex(transactionHash)} isn't this record's call`,
    );
  // The stamp is the timestamp of the block the call ran in, read by its
  // hash so it is that block's, not a reorganised one's.
  const block = headOf(
    await l1Provider.request({ method: "eth_getBlockByHash", params: [hex(blockHash), false] }),
    "the call's L1 block",
  );
  if (block.number !== l1Block || !equal(block.hash, blockHash)) throw bad("another L1 block");
  const index = readWord(topic2, 0);
  const callHash = relayCallHash({
    l1ChainId,
    relay,
    index,
    l1Block,
    l1Timestamp: block.timestamp,
    gasLimit,
    record,
  });
  if (!equal(callHash, event.data))
    throw new DirectSubmitError(
      "event-mismatch",
      `the relay recorded call hash ${hex(event.data)}, not this call's ${hex(callHash)}`,
    );
  return {
    status: "relayed",
    call: {
      index,
      l1Block,
      stamp: block.timestamp,
      gasLimit,
      callHash,
      transactionHash,
      blockHash,
    },
  };
}

export interface FindRelayedBallotOptions {
  /** A provider on the election's L2, only read. */
  readonly provider: Eip1193Provider;
  /** The definition's `l2_chain_id`. */
  readonly chainId: bigint;
  /** The definition's `board`, 20 bytes. */
  readonly board: Uint8Array;
  /** The record the call carried. */
  readonly record: Uint8Array;
  /** The call `relayBallot` returned. */
  readonly call: RelayedCallFields;
  /** The first L2 block to read: the election's registration block. */
  readonly fromBlock: bigint;
}

/**
 * The board's event for a relay call's deposit, once the L2 has included
 * it, by the provider's report: `RelayedBallotSubmitted` carrying the record
 * and naming exactly the call's index, block, stamp and gas limit. Undefined
 * while it hasn't arrived; a deposit the board refused (too little gas, a
 * stamp outside the window) never arrives, and the verifier reports its call
 * (L1 relay, Verification, Calls with no event).
 */
export async function findRelayedBallot(
  options: FindRelayedBallotOptions,
): Promise<BoardEventLocation | undefined> {
  const { provider, call } = options;
  const board = bytesArg("board", options.board, 20);
  const record = bytesArg("record", options.record);
  const chainId = chainIdArg("chainId", options.chainId);
  if (typeof options.fromBlock !== "bigint" || options.fromBlock < 0n)
    throw new TypeError("fromBlock must be ≥ 0");
  const { index, l1Block, stamp, gasLimit } = call;
  for (const [name, v] of Object.entries({ index, l1Block, stamp, gasLimit }))
    if (typeof v !== "bigint" || v < 0n || v > U64_MAX)
      throw new TypeError(`call.${name} must be a bigint from 0 to 2^64 - 1`);
  const framed = frameBallot(record);
  if (framed === undefined) throw new TypeError("record must be a ballot record that frames");
  await onChain(provider, chainId, "L2");
  const [found] = await relayedCopies(
    provider,
    board,
    record,
    framed,
    options.fromBlock,
    (c) =>
      c.index === call.index &&
      c.l1Block === call.l1Block &&
      c.stamp === call.stamp &&
      c.gasLimit === call.gasLimit,
  );
  return found;
}
