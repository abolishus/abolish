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
// paid for again beside it (T-13). No code of the wallet's runs here: the
// provider is the browser's, and the client only calls its `request`.

import type { Deployment } from "./deployment.ts";
import type { LoadedPostings } from "./load.ts";
import { POSTING_FINALITY, POSTING_POLL_MS, POSTING_SEEN } from "./posting.ts";

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
 * A wallet run's outcome ([[posting-relay]], Own wallet):
 *
 * - `recorded`: every posting is recorded at the finalized head;
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
 * Every outcome but `recorded` with a send behind it is `sent`, which
 * outranks what the later postings met.
 */
export type WalletAnswer =
  | "recorded"
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

/** What stopped a wallet request before it sent anything (`WalletAnswer`). */
export class WalletRefusal extends Error {
  constructor(readonly answer: Exclude<WalletAnswer, "recorded" | "sent">) {
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

/** A posting run's wallet: the provider and the chain and board it must send to. */
export class WalletSession {
  private account: string | undefined;

  constructor(
    private readonly wallet: Eip1193,
    /** The release's L2 (`Deployment.chainId`). */
    private readonly chainId: bigint,
    /** The board the release pins (`Deployment.board`). */
    private readonly board: Pick<NonNullable<Deployment["board"]>, "address">,
    private readonly ms = WALLET_REQUEST_MS,
  ) {}

  private async ask(method: string, params?: readonly unknown[]): Promise<unknown> {
    let answer: unknown;
    try {
      answer = await bounded(this.wallet, this.ms, method, params);
    } catch (error) {
      if (rejectedByVoter(error)) throw new WalletRefusal("rejected");
      throw new WalletRefusal("failed");
    }
    if (answer === TIMEOUT) throw new WalletRefusal("failed");
    return answer;
  }

  /**
   * The wallet on the release's L2, asked to switch to it once if it isn't
   * there: a posting on another chain would put `m_i` where no trustee or
   * verifier of this election reads, delivering nothing (T-18, T-34).
   */
  private async onChain(): Promise<void> {
    const read = async () => {
      const id = await this.ask("eth_chainId");
      if (typeof id !== "string" || !QUANTITY.test(id)) throw new WalletRefusal("failed");
      return BigInt(id);
    };
    if ((await read()) === this.chainId) return;
    await this.ask("wallet_switchEthereumChain", [{ chainId: quantity(this.chainId) }]).catch(
      (error: unknown) => {
        // A switch the voter refused or the wallet can't make: the chain read
        // again below says which, and either way nothing is sent.
        if (error instanceof WalletRefusal && error.answer === "rejected") throw error;
      },
    );
    if ((await read()) !== this.chainId) throw new WalletRefusal("wrong-chain");
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
   * Sends `submitPosting`'s calldata `call` to the board from the wallet:
   * the chain checked first, and named in the transaction, so a wallet that
   * switches in between refuses it rather than sending it elsewhere (T-34);
   * the board asked through the wallet's estimate first, so a call it
   * refuses spends none of the voter's gas; and given a quarter more gas
   * than the estimate, since the ballot check's pairing reverts the call
   * unless its gas is left ([[contracts]], Board, Membership proofs).
   * Answers `sent`, or `unknown` when the wallet didn't answer in time and
   * may still send it.
   */
  async send(call: Uint8Array): Promise<"sent" | "unknown"> {
    const from = await this.from();
    await this.onChain();
    const tx = { from, to: this.board.address, data: toHex(call), value: "0x0" };
    let estimate: unknown;
    try {
      estimate = await bounded(this.wallet, this.ms, "eth_estimateGas", [tx]);
    } catch (error) {
      if (rejectedByVoter(error)) throw new WalletRefusal("rejected");
      throw new WalletRefusal(reverted(error) ? "refused" : "failed");
    }
    if (typeof estimate !== "string" || !QUANTITY.test(estimate)) throw new WalletRefusal("failed");
    const gas = BigInt(estimate);
    let hash: unknown;
    try {
      hash = await bounded(this.wallet, this.ms, "eth_sendTransaction", [
        { ...tx, gas: quantity(gas + gas / 4n), chainId: quantity(this.chainId) },
      ]);
    } catch (error) {
      if (rejectedByVoter(error)) throw new WalletRefusal("rejected");
      throw new WalletRefusal(reverted(error) ? "refused" : "failed");
    }
    // A confirmation the voter is still reading may yet send it.
    if (hash === TIMEOUT) return "unknown";
    if (typeof hash !== "string" || !TRANSACTION.test(hash)) return "unknown";
    return "sent";
  }
}

/** What a wallet run needs from the network and the clocks, injectable for tests. */
export interface WalletIo {
  /** Sends one posting's calldata from the wallet (`WalletSession.send`). */
  send(call: Uint8Array): Promise<"sent" | "unknown">;
  /** `loadPostings` for the ballot through the build's L2 endpoint, as the relay's run reads it. */
  find(
    head: "finalized" | "latest",
    from: bigint | undefined,
    stop: () => boolean,
  ): Promise<LoadedPostings>;
  /** This device's clock, in milliseconds since the epoch. */
  now(): number;
  /** Waits `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

interface Pending {
  readonly posting: Uint8Array;
  readonly call: Uint8Array;
  /** When the wallet sent it, or may have, in seconds. */
  sentAt: bigint | undefined;
  /** When the latest head first showed it, in seconds. */
  seenAt: bigint | undefined;
}

/**
 * Posts each of `postings`, one ballot's posting records, whose
 * `submitPosting` calldata is `calls` in the same order, from the voter's
 * wallet ([[posting-relay]], Own wallet). Each round reads the finalized
 * head, then the latest; a posting the latest head shows isn't sent but
 * waited on for `WALLET_WAIT`, so the voter's address isn't put beside a
 * posting the relay or its deposit already landed (T-13), and is sent once
 * that passes with no record; every other is sent once, only while neither
 * this device's clock nor a head's time read is past `cutoff`, the poll's
 * `c_D`, so it is in time forced or not ([[delivery]], Client rule 4). It
 * answers `recorded` only once the finalized head carries every posting's
 * exact bytes, and otherwise `sent` once every unrecorded posting was sent
 * at least `WALLET_WAIT` ago, or what stopped the first send. A read that
 * fails or throws records nothing, and each read is given up once every
 * wait is over (T-25, T-52).
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
    seenAt: undefined,
  }));
  const recorded = new Set<Pending>();
  let from: bigint | undefined;
  let chainTime = 0n;
  let sent = false;
  const time = () => (seconds() > chainTime ? seconds() : chainTime);
  const started = seconds();
  // The run ends once every wait has: a read past it is given up.
  const horizon = () =>
    pending.reduce((end, p) => {
      const since = p.sentAt ?? p.seenAt;
      return since !== undefined && since + WALLET_WAIT > end ? since + WALLET_WAIT : end;
    }, started + WALLET_WAIT);
  const find = (head: "finalized" | "latest") =>
    io
      .find(head, head === "finalized" ? from : undefined, () => time() > horizon())
      .catch((): LoadedPostings => ({ ok: false, problem: "unreachable" }));
  const holds = (since: bigint | undefined) => since !== undefined && time() - since < WALLET_WAIT;
  for (;;) {
    const final = await find("finalized");
    if (final.ok) {
      from = final.block + 1n;
      if (final.timestamp > chainTime) chainTime = final.timestamp;
      for (const p of pending)
        if (final.records.some((record) => equalBytes(record, p.posting))) recorded.add(p);
    }
    const left = pending.filter((p) => !recorded.has(p));
    if (left.length === 0) return "recorded";
    const latest = await find("latest");
    if (latest.ok) {
      if (latest.timestamp > chainTime) chainTime = latest.timestamp;
      for (const p of left)
        if (
          p.seenAt === undefined &&
          latest.records.some((record) => equalBytes(record, p.posting))
        )
          p.seenAt = time();
    }
    for (const p of left) {
      if (p.sentAt !== undefined || holds(p.seenAt)) continue;
      if (time() > cutoff) return sent ? "sent" : "late";
      try {
        await io.send(p.call);
      } catch (error) {
        if (sent) return "sent";
        if (error instanceof WalletRefusal) return error.answer;
        return "failed";
      }
      sent = true;
      p.sentAt = time();
    }
    // Every unrecorded posting sent, and its wait over: it may still land.
    if (left.every((p) => p.sentAt !== undefined && !holds(p.sentAt))) return "sent";
    await io.sleep(POSTING_POLL_MS);
  }
}
