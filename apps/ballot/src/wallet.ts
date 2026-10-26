// A posting from the voter's own wallet, once the operator's relay fell back
// ([[posting-relay]], Own wallet; [[0042-posting-relay]], rule 6, option
// B): the browser's EIP-1193 provider sends `submitPosting(posting, ballot)`
// to the board this build pins, paid by an account the voter chose, and the
// client stands down, as through the relay, only once the board's own
// `SharePosted` event carries each record's exact bytes at the L2's
// finalized head, read through the build's L2 endpoint, never the wallet's
// (Outcome; T-25).
//
// The account that pays is published beside the ballot, and through the
// nullifier beside the voter's re-votes, so the offer asks for a fresh one
// funded privately (T-11, T-13); and the wallet and its node read each
// `m_i` before the chain does, at the estimate (T-18). A posting the latest
// head already shows, from the relay or a deposit, is waited on rather than
// paid for again beside it (T-13). A posting the wallet sent that a
// sequencer doesn't take is forced through L1 from the same account, a
// deposit to the portal the release pins (Forced through L1; T-50), and so
// is one whose send the wallet's node refused, with the gas from the
// build's own estimate. No code
// of the wallet's runs here: the provider is the browser's, and the client
// only calls its `request`.

import type { Deployment } from "./deployment.ts";
import type { LoadedDeposits, LoadedPostings } from "./load.ts";
import {
  POSTING_FINALITY,
  POSTING_FORCE_AFTER,
  POSTING_GAS_LIMIT_MAX,
  POSTING_POLL_MS,
  POSTING_SEEN,
} from "./posting.ts";

/** The one method of an EIP-1193 provider the client calls. */
export interface Eip1193 {
  request(args: {
    readonly method: string;
    readonly params?: readonly unknown[];
  }): Promise<unknown>;
}

/**
 * The longest the client waits on one wallet request, the voter's own
 * confirmation included: a wallet that never answers can't hold the
 * election's lock, and every tab's delivery with it, for longer (T-25, T-52).
 */
export const WALLET_REQUEST_MS = 300_000;

/**
 * Seconds the client waits, after a wallet's send or a sighting at the
 * latest head, for the posting to be recorded at the finalized head
 * ([[posting-relay]], Own wallet).
 */
export const WALLET_WAIT = POSTING_SEEN + POSTING_FINALITY;

/**
 * Seconds a head's time may be ahead of this device's clock and still count
 * toward the cutoff: two requests' time, for the wallet's account and chain
 * before a send. An endpoint answering a head further ahead could refuse
 * every send (T-25).
 */
export const WALLET_HOLD_MARGIN = BigInt((2 * WALLET_REQUEST_MS) / 1000);

/**
 * Seconds before `c_D` by which a deposit must be asked for: the estimate
 * and the voter's confirmation, `WALLET_REQUEST` each, then
 * `POSTING_DEPOSIT_SPAN` (five minutes) for L1 to include it, so its L1
 * block is by `c_D` and it reaches L2 by `t_D` ([[posting-relay]], Own
 * wallet, Forced through L1).
 */
export const WALLET_DEPOSIT_SPAN = BigInt((2 * WALLET_REQUEST_MS) / 1000) + 300n;

/**
 * Seconds before `c_D` at which a latest-head sighting stops holding a
 * posting back: the send's six requests at their longest (the account, the
 * chain read twice around a switch, the estimate and the confirmation),
 * then `POSTING_FORCE_AFTER` for the sequencer to take it, then a deposit's
 * span, which a prompt switch to L1 leaves whole (Known-weak). The latest head is the untrusted endpoint's word,
 * and a sequencer can show a call it never batches, so a sighting may delay
 * the voter's own send but never push it, or its forcing, past `c_D` (T-25,
 * T-50).
 */
export const WALLET_FORCE_MARGIN =
  BigInt((6 * WALLET_REQUEST_MS) / 1000) + POSTING_FORCE_AFTER + WALLET_DEPOSIT_SPAN;

/**
 * A wallet run's outcome ([[posting-relay]], Own wallet):
 *
 * - `recorded`: every posting is recorded at the finalized head;
 * - `forced`: the wallet deposited a posting on L1, and every posting not
 *   recorded has a qualifying deposit there (`loadDeposits`) whose block is
 *   by `c_D`, so it reaches L2 by `t_D`, or the safe head shows it;
 * - `sent`: the wallet sent one, or may have, and not every posting is
 *   recorded by the wait: it may still land, so sending again first looks
 *   for it;
 * - `rejected`: the voter refused a request in the wallet;
 * - `refused`: the board refuses the call at the wallet's estimate;
 * - `wrong-chain`: the wallet isn't on the release's L2 and didn't switch;
 * - `no-wallet`: this browser has no wallet;
 * - `late`: the poll's `c_D` passed;
 * - `failed`: the wallet or its node answered with an error, or nothing.
 *
 * Every outcome but `recorded` and `forced` with a send behind it is
 * `sent`, which outranks what the later postings met.
 */
export type WalletAnswer =
  | "recorded"
  | "forced"
  | "sent"
  | "rejected"
  | "refused"
  | "wrong-chain"
  | "no-wallet"
  | "late"
  | "failed";

/** The browser's wallet (`window.ethereum`, EIP-1193), if it has one. */
export function injectedWallet(scope: object = globalThis): Eip1193 | undefined {
  const ethereum: unknown = Reflect.get(scope, "ethereum");
  if (typeof ethereum !== "object" || ethereum === null) return undefined;
  const request: unknown = Reflect.get(ethereum, "request");
  if (typeof request !== "function") return undefined;
  // Async, so a provider that throws as it is called rejects instead.
  return { request: async (args) => (await Reflect.apply(request, ethereum, [args])) as unknown };
}

const TIMEOUT = Symbol("timeout");

/** `request`, or `TIMEOUT` once `ms` pass with no answer. */
async function bounded(
  wallet: Eip1193,
  ms: number,
  method: string,
  params?: readonly unknown[],
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    return await Promise.race([
      wallet.request(params === undefined ? { method } : { method, params }),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where a wallet's transaction stopped: `before` the parts reached it, at
 * its `estimate`, the first request to carry them, or at its `send`, which
 * may follow a broadcast.
 */
export type WalletStage = "before" | "estimate" | "send";

/** What stopped a wallet request before it sent anything (`WalletAnswer`), and where. */
export class WalletRefusal extends Error {
  constructor(
    readonly answer: Exclude<WalletAnswer, "recorded" | "forced" | "sent">,
    readonly at: WalletStage = "before",
  ) {
    super(answer);
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** EIP-1193's "User Rejected Request". */
const rejectedByVoter = (error: unknown) => isRecord(error) && error["code"] === 4001;

/**
 * Whether a wallet's error carries revert data, wherever the wallet put it
 * (`data`, `data.data`, or a wrapped `error` or `cause`): the board refused
 * the call, as against a network or wallet failure.
 */
function reverted(error: unknown): boolean {
  const seen = new Set<unknown>();
  const visit = (e: unknown): boolean => {
    if (!isRecord(e) || seen.has(e)) return false;
    seen.add(e);
    const { data } = e;
    if (typeof data === "string") return /^0x(?:[0-9a-fA-F]{2})+$/.test(data);
    return visit(data) || visit(e["error"]) || visit(e["cause"]);
  };
  return visit(error);
}

const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
const ACCOUNT = /^0x[0-9a-fA-F]{40}$/;
const TRANSACTION = /^0x[0-9a-fA-F]{64}$/;

const quantity = (v: bigint) => `0x${v.toString(16)}`;
const toHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

// `depositTransaction(address,uint256,uint64,bool,bytes)`'s selector,
// keccak256's first four bytes: the OP Stack portal's deposit.
const DEPOSIT_TRANSACTION = Uint8Array.of(0xe9, 0xe0, 0x5c, 0x42);

/**
 * `depositTransaction(board, 0, gasLimit, false, call)`'s calldata, in the
 * ABI's canonical form: the selector, the board's address, value 0, the gas
 * limit, no creation, the call's offset, then its length and bytes
 * zero-padded to a whole word ([[posting-relay]], Own wallet, Forced through
 * L1). It holds the posting's `m_i`, so the caller zeroes it once done (T-18).
 */
export function depositCalldata(board: string, gasLimit: bigint, call: Uint8Array): Uint8Array {
  if (!/^0x[0-9a-f]{40}$/.test(board)) throw new RangeError("depositCalldata: board address");
  if (gasLimit < 0n || gasLimit >= 1n << 64n) throw new RangeError("depositCalldata: gas limit");
  const out = new Uint8Array(4 + 6 * 32 + Math.ceil(call.length / 32) * 32);
  const view = new DataView(out.buffer);
  out.set(DEPOSIT_TRANSACTION, 0);
  for (let i = 0; i < 20; i++)
    out[4 + 12 + i] = Number.parseInt(board.slice(2 + 2 * i, 4 + 2 * i), 16);
  // Value (word 2) and creation (word 4) stay zero.
  view.setBigUint64(4 + 2 * 32 + 24, gasLimit);
  view.setUint32(4 + 4 * 32 + 28, 5 * 32);
  view.setUint32(4 + 5 * 32 + 28, call.length);
  out.set(call, 4 + 6 * 32);
  return out;
}

/**
 * The gas limit a deposit gives `call` on L2, from `gas`, the limit the
 * wallet's L2 send gave it: never below the portal's minimum for its data,
 * `21,000 + 40 · d`, below which the deposit reverts on L1, and never above
 * `POSTING_GAS_LIMIT_MAX`, which an honest posting never needs, so a wallet
 * node that inflated its estimate can't price the deposit past the portal's
 * caps (T-50). One that understated it leaves a deposit that runs out of
 * gas on L2, which the client never reads as forced: a qualifying deposit
 * needs the build's own estimate (`loadDeposits`).
 */
export function depositGas(gas: bigint, call: Uint8Array): bigint {
  const floor = 21_000n + 40n * BigInt(call.length);
  const raised = gas > floor ? gas : floor;
  return raised < POSTING_GAS_LIMIT_MAX ? raised : POSTING_GAS_LIMIT_MAX;
}

/** What the wallet answered a send or a deposit (`WalletSession`). */
export interface WalletSent {
  /** `unknown` when the wallet didn't answer in time and may still send it. */
  readonly sent: "sent" | "unknown";
  /** The gas limit the transaction was given. */
  readonly gas: bigint;
}

/**
 * A posting run's wallet: the provider and the chains, board and portal it
 * must send to.
 */
export class WalletSession {
  private account: string | undefined;

  constructor(
    private readonly wallet: Eip1193,
    /** The release's L2 (`Deployment.chainId`). */
    private readonly chainId: bigint,
    /** The board the release pins, and its L2's portal on L1 (`Deployment.board`). */
    private readonly board: Pick<NonNullable<Deployment["board"]>, "address" | "portal">,
    /** The release's L1 (`Deployment.l1ChainId`). */
    private readonly l1ChainId: bigint,
    private readonly ms = WALLET_REQUEST_MS,
  ) {}

  private async ask(
    method: string,
    params?: readonly unknown[],
    at: WalletStage = "before",
  ): Promise<unknown> {
    let answer: unknown;
    try {
      answer = await bounded(this.wallet, this.ms, method, params);
    } catch (error) {
      if (rejectedByVoter(error)) throw new WalletRefusal("rejected", at);
      throw new WalletRefusal(at === "estimate" && reverted(error) ? "refused" : "failed", at);
    }
    if (answer === TIMEOUT) throw new WalletRefusal("failed", at);
    return answer;
  }

  /**
   * The wallet on `chainId`, asked to switch to it once if it isn't there:
   * a posting on another chain would put `m_i` where no trustee or
   * verifier of this election reads, delivering nothing (T-18, T-34).
   */
  private async onChain(chainId: bigint): Promise<void> {
    const read = async () => {
      const id = await this.ask("eth_chainId");
      if (typeof id !== "string" || !QUANTITY.test(id)) throw new WalletRefusal("failed");
      return BigInt(id);
    };
    if ((await read()) === chainId) return;
    await this.ask("wallet_switchEthereumChain", [{ chainId: quantity(chainId) }]).catch(
      (error: unknown) => {
        // A switch the voter refused or the wallet can't make: the chain read
        // again below says which, and either way nothing is sent.
        if (error instanceof WalletRefusal && error.answer === "rejected") throw error;
      },
    );
    if ((await read()) !== chainId) throw new WalletRefusal("wrong-chain");
  }

  /** The wallet's first account, asked for once a run. */
  private async from(): Promise<string> {
    if (this.account !== undefined) return this.account;
    const accounts = await this.ask("eth_requestAccounts");
    const [first] = Array.isArray(accounts) ? accounts : [];
    if (typeof first !== "string" || !ACCOUNT.test(first)) throw new WalletRefusal("failed");
    this.account = first.toLowerCase();
    return this.account;
  }

  /**
   * Sends `data` to `to` on `chainId` from the wallet: the chain checked
   * first, and named in the transaction, so a wallet that switches in
   * between refuses it rather than sending it elsewhere (T-34); the call
   * asked through the wallet's estimate first, so one the chain refuses
   * spends none of the voter's gas; and given a quarter more gas than the
   * estimate.
   */
  private async transact(
    chainId: bigint,
    to: string,
    data: Uint8Array,
    late: () => boolean,
  ): Promise<WalletSent> {
    const from = await this.from();
    await this.onChain(chainId);
    // Checked again here, after the requests that may each have waited on
    // the voter: the estimate is the first to carry the parts (T-18).
    if (late()) throw new WalletRefusal("late");
    const tx = { from, to, data: toHex(data), value: "0x0" };
    const estimate = await this.ask("eth_estimateGas", [tx], "estimate");
    if (typeof estimate !== "string" || !QUANTITY.test(estimate))
      throw new WalletRefusal("failed", "estimate");
    const gas = BigInt(estimate) + BigInt(estimate) / 4n;
    let hash: unknown;
    try {
      hash = await bounded(this.wallet, this.ms, "eth_sendTransaction", [
        { ...tx, gas: quantity(gas), chainId: quantity(chainId) },
      ]);
    } catch (error) {
      if (rejectedByVoter(error)) throw new WalletRefusal("rejected", "send");
      // Even a revert here may follow a broadcast, so it never reads as
      // refused, which says nothing was sent.
      throw new WalletRefusal("failed", "send");
    }
    // A confirmation the voter is still reading may yet send it.
    if (hash === TIMEOUT) return { sent: "unknown", gas };
    if (typeof hash !== "string" || !TRANSACTION.test(hash)) return { sent: "unknown", gas };
    return { sent: "sent", gas };
  }

  /**
   * Sends `submitPosting`'s calldata `call` to the board on the release's
   * L2, given a quarter more gas than the estimate, since the ballot
   * check's pairing reverts the call unless its gas is left ([[contracts]],
   * Board, Membership proofs).
   */
  send(call: Uint8Array, late: () => boolean = () => false): Promise<WalletSent> {
    return this.transact(this.chainId, this.board.address, call, late);
  }

  /**
   * Forces `call` through L1 from the same account: `depositTransaction`
   * on the portal the release pins, on the release's L1, to the board,
   * value 0, with `gas`, the gas limit its L2 send was given, held between
   * the portal's minimum and `POSTING_GAS_LIMIT_MAX` (`depositGas`), as the
   * call's gas on L2 ([[posting-relay]], Own wallet, Forced through L1;
   * T-50). An
   * account without code keeps its address on L2, so the board sees the
   * same call; one with code is aliased there, which the board, taking a
   * posting from anyone, doesn't weigh. The L1 estimate prices the portal's
   * burn, which follows the deposit market and `gas`, and a quarter more
   * covers its rise before the deposit is mined.
   */
  deposit(call: Uint8Array, gas: bigint, late: () => boolean = () => false): Promise<WalletSent> {
    const data = depositCalldata(this.board.address, depositGas(gas, call), call);
    return this.transact(this.l1ChainId, this.board.portal, data, late).finally(() => data.fill(0));
  }
}

/** What a wallet run needs from the network and the clocks, injectable for tests. */
export interface WalletIo {
  /**
   * Sends one posting's calldata from the wallet (`WalletSession.send`),
   * refusing as `late` once `late` says the cutoff passed.
   */
  send(call: Uint8Array, late: () => boolean): Promise<WalletSent>;
  /**
   * Forces one posting's calldata through L1 from the wallet with the gas
   * limit its send was given (`WalletSession.deposit`), refusing as `late`
   * once `late` says the deposit cutoff passed.
   */
  deposit(call: Uint8Array, gas: bigint, late: () => boolean): Promise<WalletSent>;
  /**
   * The build's own L2 endpoint's `eth_estimateGas` of one posting's
   * calldata to the board (`estimatePosting`), or `undefined` where it
   * reverts or the endpoint can't answer.
   */
  estimate(call: Uint8Array): Promise<bigint | undefined>;
  /** `loadPostings` for the ballot through the build's L2 endpoint, as the relay's run reads it. */
  find(
    head: "finalized" | "safe" | "latest",
    from: bigint | undefined,
    stop: () => boolean,
  ): Promise<LoadedPostings>;
  /**
   * `loadDeposits` for every posting's call, in order, through the build's
   * L1 endpoint, from L1 time `since` on, given up as soon as `stop` says so.
   */
  deposits(since: bigint, stop: () => boolean): Promise<LoadedDeposits>;
  /** This device's clock, in milliseconds since the epoch. */
  now(): number;
  /** Waits `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

interface Pending {
  readonly posting: Uint8Array;
  readonly call: Uint8Array;
  /** When the wallet sent it, or may have, on L2 or forced through L1, in seconds. */
  sentAt: bigint | undefined;
  /**
   * The gas limit a deposit gives it: the one the wallet's send gave it, or
   * the build's own estimate a quarter over where the send failed, asked
   * only once it is due (`undefined` until then, `null` where that estimate
   * refuses it).
   */
  gas: bigint | null | undefined;
  /** When the latest head first showed it, in seconds. */
  seenAt: bigint | undefined;
  /** Whether the safe head showed it: the sequencer batched it to L1. */
  safe: boolean;
  /** When the wallet deposited it on L1, or may have, in seconds. */
  depositedAt: bigint | undefined;
}

/**
 * Posts each of `postings`, one ballot's posting records, whose
 * `submitPosting` calldata is `calls` in the same order, from the voter's
 * wallet ([[posting-relay]], Own wallet). Each round reads the finalized
 * head, then the latest; a posting the latest head shows isn't sent but
 * waited on for `WALLET_WAIT`, so the voter's address isn't put beside a
 * posting the relay or its deposit already landed (T-13), and is sent once
 * that passes with no record, or once `c_D − WALLET_FORCE_MARGIN` passes;
 * every other is sent once, only while neither this device's clock nor a
 * head's time read is past `cutoff`, the poll's `c_D`, so it is in time
 * forced or not ([[delivery]], Client rule 4).
 *
 * A posting the wallet sent that the L2's safe head doesn't show
 * `POSTING_FORCE_AFTER` later is deposited on L1 from the same account,
 * once, while the deposit can still be asked for by `c_D −
 * WALLET_DEPOSIT_SPAN`: the safe head, since a censoring sequencer can show
 * a call at the latest head that it never batches (Forced through L1;
 * T-50). A deposit the wallet doesn't make ends the forcing for the run,
 * never the run. A posting whose estimate the wallet's node refused once it
 * was given the call is deposited at once, with the gas limit from the
 * build's own estimate, and only if that estimate passes: the wallet's
 * node, which a censoring sequencer's endpoint can be, can't keep the
 * voter's posting off L2 (T-50). One whose send failed may have been
 * broadcast, so it counts as sent, and is forced as any sent one is, with
 * the build's estimate for its gas.
 *
 * It answers `recorded` only once the finalized head carries every
 * posting's exact bytes; otherwise, once every unrecorded posting was sent,
 * and deposited if it was, at least `WALLET_WAIT` ago, `forced` if one was
 * deposited and L1 then shows a qualifying deposit by `cutoff` for each the
 * safe head doesn't, read once through the build's own L1 endpoint, else
 * `sent`; or what stopped the first send. A
 * read that fails or throws records and forces nothing, and each read is
 * given up once every wait is over (T-25, T-52).
 */
export async function postFromWallet(
  io: WalletIo,
  postings: readonly Uint8Array[],
  calls: readonly Uint8Array[],
  cutoff: bigint,
): Promise<WalletAnswer> {
  if (calls.length !== postings.length)
    throw new RangeError("postFromWallet: one call for each posting");
  const seconds = () => BigInt(Math.floor(io.now() / 1000));
  const pending: Pending[] = postings.map((posting, i) => ({
    posting,
    call: calls[i] as Uint8Array,
    sentAt: undefined,
    gas: undefined,
    seenAt: undefined,
    safe: false,
    depositedAt: undefined,
  }));
  const recorded = new Set<Pending>();
  let from: bigint | undefined;
  let chainTime = 0n;
  let sent = false;
  // Whether a deposit may still be asked for: a voter who declined one, or a
  // wallet that couldn't make it, isn't asked again this run.
  let forcing = true;
  const time = () => (seconds() > chainTime ? seconds() : chainTime);
  // A head's time counts toward the cutoff only within `WALLET_HOLD_MARGIN`
  // of this device's clock: the endpoint is untrusted, and one answering a
  // far-future head would otherwise refuse every send (T-25, T-50).
  const heard = (timestamp: bigint) => {
    if (timestamp > chainTime && timestamp <= seconds() + WALLET_HOLD_MARGIN) chainTime = timestamp;
  };
  const started = seconds();
  // The run ends once every wait has: a read past it is given up.
  const horizon = () =>
    pending.reduce((end, p) => {
      for (const since of [p.sentAt ?? p.seenAt, p.depositedAt])
        if (since !== undefined && since + WALLET_WAIT > end) end = since + WALLET_WAIT;
      return end;
    }, started + WALLET_WAIT);
  const find = (head: "finalized" | "safe" | "latest") =>
    io
      .find(head, head === "finalized" ? from : undefined, () => time() > horizon())
      .catch((): LoadedPostings => ({ ok: false, problem: "unreachable" }));
  const holds = (since: bigint | undefined) => since !== undefined && time() - since < WALLET_WAIT;
  const forceable = () => forcing && time() + WALLET_DEPOSIT_SPAN <= cutoff;
  const shows = (read: LoadedPostings, p: Pending) =>
    read.ok && read.records.some((record) => equalBytes(record, p.posting));
  // A deposit's gas limit from the build's own estimate, a quarter over as
  // the wallet's send gives its own, so the deposit qualifies by the same
  // estimate the outcome judges it by (`loadDeposits`). A call that estimate
  // refuses too is one the board refuses, and one past
  // `POSTING_GAS_LIMIT_MAX` could never qualify at the portal's cap: neither
  // is paid for on L1.
  const built = async (call: Uint8Array) => {
    const estimated = await io.estimate(call).catch(() => undefined);
    if (estimated === undefined || estimated > POSTING_GAS_LIMIT_MAX) return null;
    return estimated + estimated / 4n;
  };
  // Forced through L1 at once: a posting whose estimate the wallet's node
  // refused after it was given the call. It answers what to end the run
  // with when nothing could be deposited.
  const forceRefused = async (p: Pending, refusal: WalletRefusal) => {
    if (
      refusal.at !== "estimate" ||
      (refusal.answer !== "refused" && refusal.answer !== "failed") ||
      !forceable()
    )
      return refusal.answer;
    const gas = await built(p.call);
    if (gas === null) return refusal.answer;
    try {
      await io.deposit(p.call, gas, () => !forceable());
    } catch (error) {
      forcing = false;
      // A deposit's send that failed may follow a broadcast, so it counts
      // as deposited; a request the voter declined is theirs to say.
      if (!(error instanceof WalletRefusal)) return refusal.answer;
      if (error.answer === "rejected") return "rejected";
      if (error.at !== "send") return refusal.answer;
    }
    p.sentAt = p.depositedAt = time();
    p.gas = gas;
    return undefined;
  };
  for (;;) {
    const final = await find("finalized");
    if (final.ok) {
      from = final.block + 1n;
      heard(final.timestamp);
      for (const p of pending) if (shows(final, p)) recorded.add(p);
    }
    const left = pending.filter((p) => !recorded.has(p));
    if (left.length === 0) return "recorded";
    const latest = await find("latest");
    if (latest.ok) {
      heard(latest.timestamp);
      for (const p of left) if (p.seenAt === undefined && shows(latest, p)) p.seenAt = time();
    }
    for (const p of left) {
      if (p.sentAt !== undefined || (holds(p.seenAt) && time() + WALLET_FORCE_MARGIN < cutoff))
        continue;
      if (time() > cutoff) return sent ? "sent" : "late";
      let met: WalletSent;
      try {
        met = await io.send(p.call, () => time() > cutoff);
      } catch (error) {
        // A send that failed may follow a broadcast: sent, as one the
        // wallet never answered, and forced if the safe head doesn't show
        // it, rather than paid for on L1 beside it at once (T-13, T-54).
        if (error instanceof WalletRefusal && error.at === "send" && error.answer === "failed") {
          sent = true;
          p.sentAt = time();
          continue;
        }
        const ended = await forceRefused(
          p,
          error instanceof WalletRefusal ? error : new WalletRefusal("failed"),
        );
        if (ended === undefined) {
          sent = true;
          continue;
        }
        return sent ? "sent" : ended;
      }
      sent = true;
      p.sentAt = time();
      p.gas = met.gas;
    }
    // Forced through L1: what the wallet sent and the sequencer hasn't
    // batched by `POSTING_FORCE_AFTER`.
    const due = () =>
      left.filter(
        (p) =>
          p.sentAt !== undefined &&
          p.depositedAt === undefined &&
          !p.safe &&
          time() - p.sentAt >= POSTING_FORCE_AFTER,
      );
    if (forceable() && due().length > 0) {
      const safe = await find("safe");
      if (safe.ok) {
        heard(safe.timestamp);
        for (const p of due()) if (shows(safe, p)) p.safe = true;
        for (const p of due()) {
          if (!forceable()) break;
          if (p.gas === undefined) p.gas = await built(p.call);
          if (p.gas === null) continue;
          try {
            await io.deposit(p.call, p.gas, () => !forceable());
          } catch {
            forcing = false;
            break;
          }
          p.depositedAt = time();
        }
      }
    }
    // Every unrecorded posting sent, and deposited if it was, and its wait
    // over: it may still land.
    if (left.every((p) => p.sentAt !== undefined && !holds(p.sentAt) && !holds(p.depositedAt))) {
      if (!left.some((p) => p.depositedAt !== undefined)) return "sent";
      // Once, through the build's own L1 endpoint: the wallet's word that it
      // sent a deposit is no evidence it was mined, nor by `c_D`.
      const ending = time();
      const l1 = await io
        .deposits(started, () => time() > ending + WALLET_WAIT)
        .catch((): LoadedDeposits => ({ ok: false, problem: "unreachable" }));
      // Each either batched to L1 by the sequencer or deposited there by `c_D`.
      const forced =
        l1.ok &&
        left.every((p) => {
          const landed = l1.landed[pending.indexOf(p)];
          return p.safe || (landed !== undefined && landed <= cutoff);
        });
      return forced ? "forced" : "sent";
    }
    await io.sleep(POSTING_POLL_MS);
  }
}
