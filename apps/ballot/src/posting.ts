// A posting the voter chose, through the operator's posting relay
// ([[posting-relay]]; [[0042-posting-relay]], option A): the client sends
// each seat's posting record with the ballot it delivers to `POST
// /postings`, and stands down only once the board's own `SharePosted` event
// carries the record's exact bytes at the L2's finalized head (Outcome).
// Every answer of the relay is a hint (rule 2): busy or unreachable is sent
// again until the relay's patience runs out, refused falls back at once,
// and sent is waited on for as long as a forced inclusion takes, then falls
// back unless the latest head shows it, and at the client's deadline `c_P`
// whatever happened (T-25, T-50).
//
// A fallback ends the run as not recorded, and the voter may then try
// again or post from their own wallet (rule 6; wallet.ts). Once a posting
// was sent at all, the relay may have
// read each `m_i`, whether or not it answered (a hostile one reads the body
// and resets the connection), so a posting that ends unrecorded is
// `relayed`, never "nothing posted": the relay, or its L1 deposit, may
// still land it (Outcome, last item; T-15). A sent posting no head shows
// once its wait is over is looked for on L1, through the client's own L1
// endpoint: a qualifying deposit keeps the client waiting until it reaches
// L2, an L1 block time plus `F`, and to `c_P` at most (Outcome, a
// qualifying deposit; T-50).

import { decodeSharePosting } from "@abolishus/crypto";

import { MAX_ANSWER, readJson } from "./answer.ts";
import type { Deployment } from "./deployment.ts";
import { WALLET_HOLD_MARGIN } from "./lapse.ts";
import type { Fetch, LoadedDeposits, LoadedPostings } from "./load.ts";
import type { PostAnswer } from "./open.tsx";

// [[posting-relay]], Values, in seconds.
export const POSTING_CLIENT_MARGIN = 3_600n;
export const POSTING_SEND_MARGIN = 6_600n;
export const POSTING_PATIENCE = 1_800n;
export const POSTING_FORCE_AFTER = 600n;
export const POSTING_SEEN = 600n;
export const POSTING_FINALITY = 1_800n;
/**
 * The most gas limit any posting's call or deposit is given: the board's
 * test measures the largest pair well within it, so an honest posting
 * never needs more ([[posting-relay]], Values).
 */
export const POSTING_GAS_LIMIT_MAX = 10_000_000n;

/** How long the client waits between rounds of sending and reading the board. */
export const POSTING_POLL_MS = 30_000;

/**
 * The longest one request of the posting loop may take, its body included:
 * the route's `POSTING_WAIT` of 20 seconds and room for the network. A relay
 * or an RPC that holds a request open past it can't hold the client past
 * its deadlines (T-25, T-50).
 */
export const POSTING_REQUEST_MS = 30_000;

/** `fetchFn` with every request, its body's reading included, aborted after `ms`. */
export function timedFetch(fetchFn: Fetch, ms = POSTING_REQUEST_MS): Fetch {
  return (url, init) => fetchFn(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** What the relay answered, as the client acts on it. */
export type RelayAnswer =
  /** Sent: the hash of the last transaction that carried it, on L2 or, forced, on L1. */
  | { readonly kind: "sent"; readonly transaction: Uint8Array; readonly layer: "l2" | "l1" }
  /** The relay won't send it, with its code: the client falls back at once. */
  | { readonly kind: "refused"; readonly code: string }
  /** Not sent yet (busy, rate-limited, or the relay unavailable here): send the same bytes again. */
  | { readonly kind: "busy" }
  /** The network failed, or the answer isn't one the route gives. */
  | { readonly kind: "unreachable" };

// The route's error codes (`ErrorCode` in @abolishus/api-contract).
const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_CODE = 64;
const HASH = /^[0-9a-f]{64}$/;

// Each answer that means "not sent yet", by its status and code: a code at
// another status isn't the route's and is read as unreachable.
const BUSY: Readonly<Record<string, number>> = {
  RATE_LIMITED: 429,
  RELAY_UNAVAILABLE: 503,
  RELAY_BUSY: 503,
};

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Lowercase hex, already checked, to bytes. */
const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * Sends `posting`, a share posting record, with `ballot`, the ballot record
 * it delivers, to the deployment's posting relay, and reads the answer
 * ([[posting-relay]], Request, Answers). Like every request the client
 * makes, it carries no cookie, referrer or credential (T-10), and follows
 * no redirect. A retry sends these same bytes again, which the relay never
 * pays for twice.
 */
export async function sendPosting(
  deployment: Pick<Deployment, "api">,
  posting: Uint8Array,
  ballot: Uint8Array,
  fetchFn: Fetch,
): Promise<RelayAnswer> {
  let response: Response;
  try {
    response = await fetchFn(`${deployment.api}/postings`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      mode: "cors",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ posting: toHex(posting), ballot: toHex(ballot) }),
    });
  } catch {
    return { kind: "unreachable" };
  }
  const garbled: RelayAnswer = { kind: "unreachable" };
  const answer = await readJson(response, MAX_ANSWER);
  if (!isRecord(answer)) return garbled;
  if (response.status === 200) {
    const { transaction, layer } = answer;
    if (
      Object.keys(answer).length !== 2 ||
      typeof transaction !== "string" ||
      !HASH.test(transaction) ||
      (layer !== "l2" && layer !== "l1")
    )
      return garbled;
    return { kind: "sent", transaction: fromHex(transaction), layer };
  }
  const { code } = answer;
  if (response.status === 422 && code === "POSTING_REFUSED") {
    const data = answer["data"];
    const reason = isRecord(data) ? data["code"] : undefined;
    return typeof reason === "string" && reason.length <= MAX_CODE && CODE.test(reason)
      ? { kind: "refused", code: reason }
      : garbled;
  }
  // A body the route's forms refuse is this client's bug, never fixed by
  // sending it again.
  if (response.status === 400 && code === "BAD_REQUEST")
    return { kind: "refused", code: "malformed" };
  return typeof code === "string" && Object.hasOwn(BUSY, code) && BUSY[code] === response.status
    ? { kind: "busy" }
    : garbled;
}

// `submitPosting(bytes,bytes)`'s selector, keccak256's first four bytes.
const SUBMIT_POSTING = Uint8Array.of(0x4b, 0x6f, 0xf1, 0xd0);

/**
 * `submitPosting(posting, ballot)`'s calldata, in the ABI's canonical
 * form: the selector, both records' offsets, then each record's length and
 * bytes zero-padded to a whole word ([[posting-relay]], Answers, step 2).
 * It holds the posting's `m_i`, so the caller zeroes it once done (T-18).
 */
export function postingCalldata(posting: Uint8Array, ballot: Uint8Array): Uint8Array {
  const padded = (n: number) => Math.ceil(n / 32) * 32;
  const word = (n: number) => {
    const w = new Uint8Array(32);
    new DataView(w.buffer).setUint32(28, n);
    return w;
  };
  const out = new Uint8Array(4 + 4 * 32 + padded(posting.length) + padded(ballot.length));
  out.set(SUBMIT_POSTING, 0);
  out.set(word(64), 4);
  out.set(word(96 + padded(posting.length)), 36);
  out.set(word(posting.length), 68);
  out.set(posting, 100);
  const at = 100 + padded(posting.length);
  out.set(word(ballot.length), at);
  out.set(ballot, at + 32);
  return out;
}

/** What the posting loop needs from the network and the clocks, injectable for tests. */
export interface PostingIo {
  /** `sendPosting` for one record and the ballot. */
  send(posting: Uint8Array): Promise<RelayAnswer>;
  /**
   * `loadPostings` for the ballot, at `head`, from block `from` (the
   * board's deployment when absent), given up as soon as `stop` says so.
   */
  find(
    head: "finalized" | "latest",
    from: bigint | undefined,
    stop: () => boolean,
  ): Promise<LoadedPostings>;
  /**
   * `loadDeposits` for every posting, in order, from L1 time `since` on,
   * given up as soon as `stop` says so.
   */
  deposits(since: bigint, stop: () => boolean): Promise<LoadedDeposits>;
  /** This device's clock, in milliseconds since the epoch. */
  now(): number;
  /** Waits `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

interface Pending {
  readonly posting: Uint8Array;
  /** When the relay last answered `sent`, in seconds by this device's clock. */
  sentAt: bigint | undefined;
  /** Whether the latest head carried it once it was sent. */
  seen: boolean;
  /**
   * When its qualifying deposit on L1 reaches L2 at the latest, its L1
   * block's time plus `F`, in seconds, once one is found.
   */
  lands: bigint | undefined;
}

/**
 * Posts each of `postings`, the posting records of one ballot, through the
 * relay ([[posting-relay]], Outcome), answering `recorded` only once the
 * board's `SharePosted` events carry every one's exact bytes at the L2's
 * finalized head. Otherwise it ends once the client would fall back: the
 * relay refused one, its patience or its send cutoff `c_L −
 * POSTING_SEND_MARGIN` passed, a sent posting is neither recorded nor seen
 * at the latest head after `POSTING_FORCE_AFTER + POSTING_SEEN` and has no
 * qualifying deposit on L1 whose block's time plus `forcedInclusion` (`F`)
 * is still ahead, or the client's deadline `c_P = c_L − POSTING_CLIENT_MARGIN` passed; and
 * answers `relayed` if any posting was sent at all, since the relay may
 * then have read its `m_i` whatever it answered, else `unreachable`
 * (Outcome, last item; T-15). A board or L1 read is given up at `c_P`
 * between its requests, and each request is the caller's to bound (`timedFetch`),
 * so the run ends within one request of `c_P` (T-25, T-50). `cutoff`
 * is the poll's force cutoff `c_L` (`PostingCutoffs.force`), in seconds,
 * never `c_D`: a run that ends at `c_P` leaves the voter's wallet the whole
 * `POSTING_CLIENT_MARGIN` to send and force a posting before `c_L`, and a
 * posting recorded later than the close helps no ballot of this client's
 * ([[posting-relay]], The ballot's own deadline). A run that starts with the
 * send cutoff already passed by this device's clock is a **late** run,
 * best effort: no deposit can then be forced in time, but an honest relay
 * with a live sequencer still records a posting within about twenty
 * minutes. It runs only where `late` is given, once the voter was told so
 * (else it answers `unreachable` and sends nothing), and sends, resends and
 * reads the finalized head until `late.lastOffer`, the last-offer cutoff
 * `c_E`, which is its deadline, with no fallback on a posting no head
 * shows; what it handed out is then the page's wait to read for, without
 * the election's lock (`waitForRecord`); one started past `c_E` sends
 * nothing and reads the finalized head once, for a posting an earlier run
 * handed out (The ballot's own deadline, A late relay run, Sending after a
 * run; T-15, T-25, T-52). L1 is read from `handed`, the cast's mark, the
 * time the first run of its seal was about to hand the same bytes out, so
 * a deposit an earlier run's relay made, before a reload, still holds the
 * client while it can land; never from before the run's start less
 * `forcedInclusion`, since an older deposit has had its time to reach L2,
 * nor after the run's start (Outcome, The read; T-13, T-52). Without it, from
 * the run's start. A deadline counts as passed once this
 * device's clock or a head's time read passes it: relying on the relay a
 * little less long only leaves the voter more time to post themselves
 * (T-25). In a late run, which has nothing to fall back to in time, a
 * head's time counts only within `WALLET_HOLD_MARGIN` of this device's
 * clock, as for the wallet's sends and the offer, so an endpoint answering
 * a far-future head can't end it before it sends (T-25). A read that fails
 * or throws records nothing.
 */
export async function postThroughRelay(
  io: PostingIo,
  postings: readonly Uint8Array[],
  cutoff: bigint,
  forcedInclusion: bigint,
  late?: { readonly lastOffer: bigint },
  handed?: bigint,
): Promise<PostAnswer> {
  const seconds = () => BigInt(Math.floor(io.now() / 1000));
  const started = seconds();
  // A deposit older than `F` before the run has had its time to land.
  const oldest = started > forcedInclusion ? started - forcedInclusion : 0n;
  const since =
    handed === undefined || handed >= started ? started : handed > oldest ? handed : oldest;
  const isLate = started > cutoff - POSTING_SEND_MARGIN;
  // A late run the voter wasn't told of hands nothing out (T-15).
  if (isLate && late === undefined) return "unreachable";
  const deadline = isLate ? (late?.lastOffer ?? 0n) : cutoff - POSTING_CLIENT_MARGIN;
  const sendCutoff = isLate ? (late?.lastOffer ?? 0n) : cutoff - POSTING_SEND_MARGIN;
  const pending: Pending[] = postings.map((posting) => ({
    posting,
    sentAt: undefined,
    seen: false,
    lands: undefined,
  }));
  const recorded = new Set<Pending>();
  // The finalized head is read from where the last read ended: a record
  // there stays recorded, and the board's whole log is read only once.
  let from: bigint | undefined;
  let chainTime = 0n;
  // Whether the relay may have had the postings' bytes: any send at all.
  let read = false;
  const unrecorded = (): PostAnswer => (read ? "relayed" : "unreachable");
  // The later of the device's clock and the last head's time read.
  const time = () => (seconds() > chainTime ? seconds() : chainTime);
  // A later time only ends the waiting sooner; in a late run, only within
  // `WALLET_HOLD_MARGIN` of this device's clock (T-25).
  const heard = (timestamp: bigint) => {
    if (timestamp > chainTime && (!isLate || timestamp <= seconds() + WALLET_HOLD_MARGIN))
      chainTime = timestamp;
  };
  const find = (head: "finalized" | "latest") =>
    io
      .find(head, from, () => time() > deadline)
      .catch((): LoadedPostings => ({ ok: false, problem: "unreachable" }));
  for (;;) {
    const final = await find("finalized");
    if (final.ok) {
      from = final.block + 1n;
      heard(final.timestamp);
      for (const p of pending)
        if (final.records.some((record) => equalBytes(record, p.posting))) recorded.add(p);
    }
    const left = pending.filter((p) => !recorded.has(p));
    if (left.length === 0) return "recorded";
    if (time() > deadline) return unrecorded();
    for (const p of left) {
      if (p.sentAt !== undefined) continue;
      const now = time();
      // Read again before each send, since a send can take a request's whole timeout.
      if (now > deadline || now - started >= POSTING_PATIENCE || now > sendCutoff)
        return unrecorded();
      read = true;
      const answer = await io.send(p.posting).catch((): RelayAnswer => ({ kind: "unreachable" }));
      if (answer.kind === "refused") return unrecorded();
      if (answer.kind === "sent") p.sentAt = seconds();
    }
    const waited = left.filter(
      (p) => p.sentAt !== undefined && time() - p.sentAt >= POSTING_FORCE_AFTER + POSTING_SEEN,
    );
    // Still waited on: seen at the latest head, or its deposit still to reach L2.
    const held = (p: Pending) => p.seen || (p.lands !== undefined && time() < p.lands);
    // A late run has nothing to fall back to in time, so it waits for the
    // record to its deadline, `c_E`, whatever the heads show.
    if (!isLate && !waited.every(held)) {
      // Looked for at the latest head only once its wait is over: a sighting
      // there only keeps the client waiting, to `c_P` at most.
      const latest = await find("latest");
      if (latest.ok) {
        heard(latest.timestamp);
        for (const p of waited)
          if (latest.records.some((record) => equalBytes(record, p.posting))) p.seen = true;
      }
      // Then on L1, once, for a posting neither head shows: a deposit whose
      // time to reach L2 has passed without its event failed, and isn't
      // looked for again (Outcome, a qualifying deposit).
      if (waited.some((p) => !p.seen && p.lands === undefined)) {
        const read = (from: bigint) =>
          io
            .deposits(from, () => time() > deadline)
            .catch((): LoadedDeposits => ({ ok: false, problem: "unreachable" }));
        let l1 = await read(since);
        // A wider read from an earlier run's mark that is a bad answer (more
        // deposits to the board than its bounds take) is read again from this run's
        // start, so the mark never leaves the client worse off (T-52).
        if (!l1.ok && l1.problem === "bad-answer" && since < started && time() <= deadline)
          l1 = await read(started);
        if (l1.ok) {
          heard(l1.timestamp);
          for (const p of waited) {
            const landed = l1.landed[pending.indexOf(p)];
            if (!p.seen && p.lands === undefined && landed !== undefined)
              p.lands = landed + forcedInclusion;
          }
        }
      }
      if (!waited.every(held)) return unrecorded();
    }
    await io.sleep(POSTING_POLL_MS);
  }
}

/** What the wait after a run needs from the page, the network and the clocks, injectable for tests. */
export interface RecordWaitIo {
  /**
   * The posting records of the cast's seats still unreceipted, made afresh
   * for each read from what this device keeps (the page's `postable`): none
   * once every seat is receipted, `undefined` once the cast is no longer
   * there to send (declined, erased, or its records unreadable). The wait
   * zeroes them once it has read for them.
   */
  postings(): Promise<readonly Uint8Array[] | undefined>;
  /**
   * `loadPostings` for the ballot `postings` name, at the L2's finalized
   * head, from block `from` (the board's deployment when absent), given up
   * as soon as `stop` says so.
   */
  find(
    postings: readonly Uint8Array[],
    from: bigint | undefined,
    stop: () => boolean,
  ): Promise<LoadedPostings>;
  /** This device's clock, in milliseconds since the epoch. */
  now(): number;
  /** Waits `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  /** Whether the page gave the wait up: the voter left the offer, or another run started. */
  ended(): boolean;
}

/**
 * How the wait after a run ended: every seat receipted or its posting
 * `recorded`, with the send cutoff not passed; the cutoff `lapsed`; the cast
 * `gone`; or `ended` by the page.
 */
export type RecordWait = "recorded" | "lapsed" | "gone" | "ended";

/**
 * Sending after a run ([[posting-relay]], The ballot's own deadline): once a
 * run handed postings out and ended without every one recorded, the page
 * waits for them, with no lock, no offer and no posting of its own (T-25,
 * T-52). Every `POSTING_POLL_MS`, a run's read cadence and no more often,
 * it makes the cast's posting records afresh (`io.postings`), so a seat
 * another tab receipted since is no longer waited for and a cast declined or
 * erased since ends the wait, and reads the finalized head from where the
 * last read ended for their exact bytes. It answers `recorded` once each one
 * is among the records read, while neither this device's clock nor a head's
 * time is past `send`, the send cutoff `c_S`, past which a record no longer
 * sends the ballot (`lapsed`). As in a late run and the offer, a head's time
 * counts only within `WALLET_HOLD_MARGIN` of this device's clock: an
 * endpoint whose head runs further ahead can't end the wait, and one within
 * it can only bring `c_S` sooner, which hiding the event already lets it do
 * (T-25). The records the board carries are public, so the ones read are
 * kept between reads; the page's records hold each `m_i` and are zeroed
 * after each read (T-18). A read that fails or throws records nothing.
 */
export async function waitForRecord(io: RecordWaitIo, send: bigint): Promise<RecordWait> {
  const seconds = () => BigInt(Math.floor(io.now() / 1000));
  let chainTime = 0n;
  const passed = () => seconds() > send || chainTime > send;
  const stop = () => io.ended() || passed();
  let from: bigint | undefined;
  const onBoard: Uint8Array[] = [];
  for (;;) {
    // The run that handed them out has just read the head.
    await io.sleep(POSTING_POLL_MS);
    if (io.ended()) return "ended";
    if (passed()) return "lapsed";
    const postings = await io.postings();
    if (postings === undefined) return "gone";
    try {
      if (io.ended()) return "ended";
      if (postings.length > 0) {
        const final = await io
          .find(postings, from, stop)
          .catch((): LoadedPostings => ({ ok: false, problem: "unreachable" }));
        if (io.ended()) return "ended";
        if (final.ok) {
          from = final.block + 1n;
          if (final.timestamp > chainTime && final.timestamp <= seconds() + WALLET_HOLD_MARGIN)
            chainTime = final.timestamp;
          onBoard.push(...final.records);
        }
      }
      if (postings.every((p) => onBoard.some((record) => equalBytes(record, p))))
        return passed() ? "lapsed" : "recorded";
    } finally {
      for (const p of postings) p.fill(0);
    }
  }
}

/**
 * The definition and ballot hashes `postings` name, which must be one
 * ballot's: the topics their `SharePosted` events are read under.
 */
export function postingTopics(postings: readonly Uint8Array[]): {
  readonly definitionHash: Uint8Array;
  readonly ballotHash: Uint8Array;
} {
  const decoded = postings.map((p) => decodeSharePosting(p, 1));
  try {
    const [first, ...rest] = decoded;
    if (first === undefined) throw new RangeError("postingTopics: no posting");
    for (const p of rest)
      if (
        !equalBytes(p.definition_hash, first.definition_hash) ||
        !equalBytes(p.ballot_hash, first.ballot_hash)
      )
        throw new RangeError("postingTopics: postings of different ballots");
    return { definitionHash: first.definition_hash, ballotHash: first.ballot_hash };
  } finally {
    // The decoder's copies of each `m_i` (T-18).
    for (const p of decoded) p.m.fill(0);
  }
}
