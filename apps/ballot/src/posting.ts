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
// The fallback, the voter's own wallet (rule 6), is part 3c-1b-2b-2b-2d-2b-2d;
// until it exists a fallback ends the posting as not recorded, and the
// voter may try again. Once a posting was sent at all, the relay may have
// read each `m_i`, whether or not it answered (a hostile one reads the body
// and resets the connection), so a posting that ends unrecorded is
// `relayed`, never "nothing posted": the relay, or its L1 deposit, may
// still land it (Outcome, last item; T-15). Nor does the client look on L1 for a deposit the
// relay made yet (Outcome, a qualifying deposit): one only ever delays the
// fallback, and without it the client falls back sooner, never later.

import { decodeSharePosting } from "@abolishus/crypto";

import { MAX_ANSWER, readJson } from "./answer.ts";
import type { Deployment } from "./deployment.ts";
import type { Fetch, LoadedPostings } from "./load.ts";
import type { PostAnswer } from "./open.tsx";

// [[posting-relay]], Values, in seconds.
export const POSTING_CLIENT_MARGIN = 3_600n;
export const POSTING_SEND_MARGIN = 6_600n;
export const POSTING_PATIENCE = 1_800n;
export const POSTING_FORCE_AFTER = 600n;
export const POSTING_SEEN = 600n;

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
}

/**
 * Posts each of `postings`, the posting records of one ballot, through the
 * relay ([[posting-relay]], Outcome), answering `recorded` only once the
 * board's `SharePosted` events carry every one's exact bytes at the L2's
 * finalized head. Otherwise it ends once the client would fall back: the
 * relay refused one, its patience or its send cutoff `c_D −
 * POSTING_SEND_MARGIN` passed, a sent posting is neither recorded nor seen
 * at the latest head after `POSTING_FORCE_AFTER + POSTING_SEEN`, or the
 * client's deadline `c_P = c_D − POSTING_CLIENT_MARGIN` passed; and
 * answers `relayed` if any posting was sent at all, since the relay may
 * then have read its `m_i` whatever it answered, else `unreachable`
 * (Outcome, last item; T-15). A board read is given up at `c_P` between
 * its requests, and each request is the caller's to bound (`timedFetch`),
 * so the run ends within one request of `c_P` (T-25, T-50). `cutoff`
 * is the poll's `c_D`, in seconds. A deadline counts as passed once this
 * device's clock or a head's time read passes it: relying on the relay a
 * little less long only leaves the voter more time to post themselves
 * (T-25). A read that fails or throws records nothing.
 */
export async function postThroughRelay(
  io: PostingIo,
  postings: readonly Uint8Array[],
  cutoff: bigint,
): Promise<PostAnswer> {
  const deadline = cutoff - POSTING_CLIENT_MARGIN;
  const sendCutoff = cutoff - POSTING_SEND_MARGIN;
  const seconds = () => BigInt(Math.floor(io.now() / 1000));
  const started = seconds();
  const pending: Pending[] = postings.map((posting) => ({
    posting,
    sentAt: undefined,
    seen: false,
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
  const find = (head: "finalized" | "latest") =>
    io
      .find(head, from, () => time() > deadline)
      .catch((): LoadedPostings => ({ ok: false, problem: "unreachable" }));
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
    if (waited.some((p) => !p.seen)) {
      // Looked for at the latest head only once its wait is over: a sighting
      // there only keeps the client waiting, to `c_P` at most.
      const latest = await find("latest");
      if (latest.ok) {
        // A later time only ends the waiting sooner.
        if (latest.timestamp > chainTime) chainTime = latest.timestamp;
        for (const p of waited)
          if (latest.records.some((record) => equalBytes(record, p.posting))) p.seen = true;
      }
      if (waited.some((p) => !p.seen)) return unrecorded();
    }
    await io.sleep(POSTING_POLL_MS);
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
