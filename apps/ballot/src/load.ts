// The page's side of opening an election: it reads the definition hash the
// election registry holds for the linked election from the L2, then fetches
// the definition, its display text, the board's first entry (where the
// operator boards the ceremony transcript) and the poll's moderation state
// from the API, and hands the records to the worker, which decides whether
// the election may be shown (election.ts, worker/session.ts). The
// worker does no I/O (T-43); this module decides nothing about the records,
// only whether they could be fetched (T-34, T-41), and whether the
// moderation policy lets this client show them (T-68). It also reads the
// whole board, for the voter's cell, and the whole group registry from the
// L2, for a Tier 0 registration's outcome, each naming nothing about the
// voter (T-10, T-13).
//
// Every answer is untrusted. A wrong one ends in a refusal: here, when it
// isn't even shaped like an answer, or in the worker, when the records don't
// hash to the registry's hash. What this module can't catch is an RPC that
// lies about the registry's state; see Known-weak in docs/status/P2-8.md.

import {
  encodeContractEvent,
  MAX_EVENT_DATA,
  MAX_EVENT_TOPICS,
  PARAMETERS,
} from "@abolishus/crypto";

import type { Deployment } from "./deployment.ts";

/** Why the client couldn't fetch what it checks. */
export type LoadProblem =
  /** This build names no election registry, so it can check no election. */
  | "no-registry"
  /** The RPC serves another chain than the one this build pins. */
  | "wrong-chain"
  /** The registry holds no definition for this election: no such election, or not registered yet. */
  | "not-registered"
  /** The API holds no definition or display text for a registered election. */
  | "not-found"
  /** The poll's text is withheld under the moderation policy, from this client too. */
  | "withheld"
  /** The network failed, or a server answered with an error it shouldn't. */
  | "unreachable"
  /** A server answered with something that isn't an answer. */
  | "bad-answer";

export type Loaded =
  | {
      readonly ok: true;
      /** The definition hash the registry holds for the election: 32 bytes, never zero. */
      readonly registeredHash: Uint8Array;
      readonly definition: Uint8Array;
      readonly displayText: Uint8Array;
      /** The board's first entry, or none on an empty board: the worker looks for the transcript there. */
      readonly entries: readonly Uint8Array[];
      /** Whether our web pages withhold the text as a threat while the poll is open, so the client shows it under a notice. */
      readonly hiddenAsThreat: boolean;
    }
  | { readonly ok: false; readonly problem: LoadProblem };

/** `fetch`, injectable for tests. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** `definitionHashOf(bytes32)`'s selector: the first four bytes of its signature's Keccak-256. */
export const DEFINITION_HASH_OF = "d325433f";

// The registry's state as of the L2's finalized head: a registration still in
// an unsafe block could be reorganised away and replaced (T-34).
const BLOCK = "finalized";

// The largest answer read, from the largest record each carries as hex, plus
// room for its JSON. Anything longer is refused unread rather than buffered
// (T-52).
const JSON_ROOM = 256;
const MAX_DEFINITION_ANSWER = 2 * PARAMETERS.MAX_BOARD_PAYLOAD + JSON_ROOM;
const MAX_DISPLAY_TEXT_ANSWER = 2 * PARAMETERS.MAX_DISPLAY_TEXT + JSON_ROOM;
// One board entry: its payload and the envelope around it (docs/spec/board.md).
const BOARD_ENTRY_OVERHEAD = 3 + 32 + 8 + 4 + 4;
const MAX_ENTRY = PARAMETERS.MAX_BOARD_PAYLOAD + BOARD_ENTRY_OVERHEAD;
const MAX_ENTRIES_ANSWER = 2 * MAX_ENTRY + JSON_ROOM;
// A page of the whole board: the API's page size and byte cap
// (packages/api-contract, `MAX_PAGE` and `MAX_PAGE_BYTES`), as hex, with a
// quote pair and a comma per entry. A page may exceed the byte cap only by
// holding one entry.
const PAGE_ENTRIES = 256;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_ANSWER = 2 * Math.max(MAX_PAGE_BYTES, MAX_ENTRY) + 3 * PAGE_ENTRIES + JSON_ROOM;
// The most of a board the client reads before it gives up: the group
// registry's records for a large tier run to tens of megabytes (P2-21 part
// 3, Known-weak), and a server that never ends the board must not exhaust
// the device (T-52). Each entry is charged its bytes and a fixed cost, and
// each page a fixed cost, so a server answering with tiny entries, one per
// page, runs the budget out within a few thousand requests too.
const MAX_BOARD_BYTES = 256 * 1024 * 1024;
const ENTRY_COST = 64;
const PAGE_COST = 64 * 1024;
const MAX_RPC_ANSWER = 4096;
// `{ state, latest: { seq, action, reason, decidedAt } }` with room to spare.
const MAX_STATUS_ANSWER = 1024;

// No cookie, no referrer, no cache and no redirect to anywhere else: each
// request names only the election, which is all the server needs (T-10, T-11).
const REQUEST: RequestInit = {
  credentials: "omit",
  referrerPolicy: "no-referrer",
  cache: "no-store",
  redirect: "error",
  mode: "cors",
};

/** A failure that ends the load with `problem`. */
class Stop extends Error {
  constructor(readonly problem: LoadProblem) {
    super(problem);
  }
}

/** Fetches what `checkElection` needs for `electionId` (32 bytes) from `deployment`. */
export async function loadElection(
  deployment: Deployment,
  electionId: Uint8Array,
  fetchFn: Fetch,
): Promise<Loaded> {
  if (deployment.electionRegistry === undefined) return { ok: false, problem: "no-registry" };
  const registry = deployment.electionRegistry;
  try {
    const registeredHash = await registeredHashOf(deployment, registry, electionId, fetchFn);
    if (registeredHash.every((b) => b === 0)) return { ok: false, problem: "not-registered" };
    const id = toHex(electionId);
    const [[[definition, displayText], entries], moderation] = await both(
      both(
        both(
          apiRecord(deployment, "definition", id, "definition", MAX_DEFINITION_ANSWER, fetchFn),
          apiRecord(
            deployment,
            "display-text",
            id,
            "displayText",
            MAX_DISPLAY_TEXT_ANSWER,
            fetchFn,
          ),
        ),
        firstEntry(deployment, id, fetchFn),
      ),
      moderationOf(deployment, id, fetchFn),
    );
    return {
      ok: true,
      registeredHash,
      definition,
      displayText,
      entries,
      hiddenAsThreat: moderation === "threat",
    };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, problem: error.problem };
    throw error;
  }
}

async function registeredHashOf(
  deployment: Deployment,
  registry: string,
  electionId: Uint8Array,
  fetchFn: Fetch,
): Promise<Uint8Array> {
  const [, word] = await both(
    checkChain(deployment, fetchFn),
    rpc(deployment, fetchFn, 2, "eth_call", [
      { to: registry, data: `0x${DEFINITION_HASH_OF}${toHex(electionId)}` },
      BLOCK,
    ]),
  );
  // A bytes32 return value: exactly one ABI word.
  if (!/^0x[0-9a-f]{64}$/.test(word)) throw new Stop("bad-answer");
  return fromHex(word.slice(2));
}

// When both of two requests fail, the problem shown is the one first here,
// whichever failed first: the same answers always give the same screen.
const PRECEDENCE: readonly LoadProblem[] = [
  "wrong-chain",
  "withheld",
  "not-found",
  "bad-answer",
  "unreachable",
];

/**
 * Both results, or the failure that takes precedence. `fetch`'s TypeError
 * (the network or CORS failed) counts as unreachable; any other error (an
 * abort, a fault of this page) is thrown as it is.
 */
async function both<A, B>(a: Promise<A>, b: Promise<B>): Promise<[A, B]> {
  const [x, y] = await Promise.allSettled([a, b]);
  if (x.status === "fulfilled" && y.status === "fulfilled") return [x.value, y.value];
  const errors = [x, y].flatMap((r) =>
    r.status === "fulfilled"
      ? []
      : [r.reason instanceof TypeError ? new Stop("unreachable") : (r.reason as unknown)],
  );
  const other = errors.find((e) => !(e instanceof Stop));
  if (other !== undefined) throw other;
  const stops = errors as Stop[];
  throw stops.reduce((p, q) =>
    PRECEDENCE.indexOf(q.problem) < PRECEDENCE.indexOf(p.problem) ? q : p,
  );
}

/** Request 1: the RPC must serve the chain this build pins. */
async function checkChain(deployment: Deployment, fetchFn: Fetch): Promise<void> {
  const id = await rpc(deployment, fetchFn, 1, "eth_chainId", []);
  if (!QUANTITY.test(id)) throw new Stop("bad-answer");
  if (BigInt(id) !== deployment.chainId) throw new Stop("wrong-chain");
}

/** A JSON-RPC quantity of at most 64 bits, as nodes serialize it: lowercase, no leading zero. */
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/;

/** One JSON-RPC call; its `result`, which must be a string. */
async function rpc(
  deployment: Deployment,
  fetchFn: Fetch,
  id: number,
  method: string,
  params: readonly unknown[],
): Promise<string> {
  const result = await rpcResult(deployment, fetchFn, id, method, params, MAX_RPC_ANSWER);
  if (typeof result !== "string") throw new Stop("bad-answer");
  return result;
}

/** One JSON-RPC call, its answer read up to `maxAnswer` bytes; its `result`. */
async function rpcResult(
  deployment: Deployment,
  fetchFn: Fetch,
  id: number,
  method: string,
  params: readonly unknown[],
  maxAnswer: number,
): Promise<unknown> {
  const response = await fetchFn(deployment.rpc, {
    ...REQUEST,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  if (!response.ok) throw new Stop("unreachable");
  const answer = await readJson(response, maxAnswer);
  if (!isRecord(answer) || answer["jsonrpc"] !== "2.0" || answer["id"] !== id)
    throw new Stop("bad-answer");
  // A node that can't answer (rate-limited, behind, misconfigured) says so in
  // `error`; that is the node's trouble, not a claim about the registry.
  if ("error" in answer) throw new Stop("unreachable");
  return answer["result"];
}

/** A record from one of the API's GET routes, as bytes. */
async function apiRecord(
  deployment: Deployment,
  route: "definition" | "display-text",
  electionId: string,
  field: "definition" | "displayText",
  maxAnswer: number,
  fetchFn: Fetch,
): Promise<Uint8Array> {
  const url = `${deployment.api}/elections/${route}?electionId=${electionId}`;
  const response = await fetchFn(url, { ...REQUEST, method: "GET" });
  if (response.status === 451) throw new Stop("withheld");
  if (response.status === 404) throw new Stop("not-found");
  if (!response.ok) throw new Stop("unreachable");
  const answer = await readJson(response, maxAnswer);
  if (!isRecord(answer) || Object.keys(answer).length !== 1) throw new Stop("bad-answer");
  const value = answer[field];
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})*$/.test(value)) throw new Stop("bad-answer");
  return fromHex(value);
}

/**
 * What the moderation policy lets this client do with the poll's text
 * (docs/moderation-policy.md, Open polls), from `GET /moderation/status`:
 * `withheld` (thrown, so it ranks as the display-text route's 451 does) for
 * a poll hidden under any ground but `threat` as its newest decision,
 * `threat` for one hidden as a threat, `shown` otherwise. The
 * display-text route already withholds what the policy withholds (451); this
 * read gives the threat notice, and keeps the text of a poll whose newest
 * decision withholds it from being shown even if that route served it. It
 * sees only the newest decision, so a withholding hide re-cited as `threat`
 * is withheld by the route alone (docs/status/P2-10.md, Known-weak). A status that can't be read, or isn't
 * shaped like one, is `shown`: an outage, or someone blocking this route,
 * must not stop voting through our client (T-68). It rejects otherwise only
 * for a fault of this page (an abort).
 */
async function moderationOf(
  deployment: Deployment,
  electionId: string,
  fetchFn: Fetch,
): Promise<"shown" | "threat"> {
  let answer: unknown;
  try {
    const url = `${deployment.api}/moderation/status?electionId=${electionId}`;
    const response = await fetchFn(url, { ...REQUEST, method: "GET" });
    if (!response.ok) return "shown";
    answer = await readJson(response, MAX_STATUS_ANSWER);
  } catch (error) {
    if (error instanceof Stop || error instanceof TypeError) return "shown";
    throw error;
  }
  if (!isRecord(answer) || answer["state"] !== "hidden") return "shown";
  const latest = answer["latest"];
  // A hidden poll's newest decision is the hide (packages/core, moderation).
  if (!isRecord(latest) || latest["action"] !== "hide") return "shown";
  const reason = latest["reason"];
  if (reason === "threat") return "threat";
  if (typeof reason === "string" && WITHHOLDING.has(reason)) throw new Stop("withheld");
  return "shown";
}

// The policy's removal grounds but `threat` (docs/moderation-policy.md, Reasons).
const WITHHOLDING: ReadonlySet<string> = new Set([
  "illegal",
  "personal-data",
  "harassment",
  "spam",
  "impersonation",
  "legal-notice",
]);

/**
 * The board's first entry (`GET /board/entries` from 0, one entry), or none
 * on an empty board. The request names the election and a position,
 * nothing about the voter (T-10).
 */
async function firstEntry(
  deployment: Deployment,
  electionId: string,
  fetchFn: Fetch,
): Promise<Uint8Array[]> {
  const url = `${deployment.api}/board/entries?electionId=${electionId}&start=0&limit=1`;
  const response = await fetchFn(url, { ...REQUEST, method: "GET" });
  if (response.status === 404) throw new Stop("not-found");
  if (!response.ok) throw new Stop("unreachable");
  return entriesOf(await readJson(response, MAX_ENTRIES_ANSWER), 1);
}

export type LoadedBoard =
  | { readonly ok: true; readonly entries: readonly Uint8Array[] }
  | { readonly ok: false; readonly problem: LoadProblem };

/**
 * The whole board of `electionId`, page by page from position 0 until an
 * empty page, for the worker to find the voter's cell in (`find-cell`). The
 * requests name the election and positions only, never a group, region or
 * leaf: a board filtered to the voter's group would tell the server their
 * region (T-10, T-13). A page longer than asked for, an entry that isn't
 * lowercase hex, or a board that runs out the `maxBytes` budget is
 * `bad-answer`.
 */
export async function loadBoard(
  deployment: Deployment,
  electionId: Uint8Array,
  fetchFn: Fetch,
  maxBytes = MAX_BOARD_BYTES,
): Promise<LoadedBoard> {
  const id = toHex(electionId);
  const entries: Uint8Array[] = [];
  let budget = maxBytes;
  try {
    for (;;) {
      const url = `${deployment.api}/board/entries?electionId=${id}&start=${entries.length}&limit=${PAGE_ENTRIES}`;
      // `fetch` rejects with a TypeError when the network fails.
      const response = await fetchFn(url, { ...REQUEST, method: "GET" }).catch((e: unknown) => {
        throw e instanceof TypeError ? new Stop("unreachable") : e;
      });
      if (response.status === 404) throw new Stop("not-found");
      if (!response.ok) throw new Stop("unreachable");
      const page = entriesOf(await readJson(response, MAX_PAGE_ANSWER), PAGE_ENTRIES);
      if (page.length === 0) return { ok: true, entries };
      budget -= PAGE_COST;
      for (const entry of page) {
        budget -= entry.length + ENTRY_COST;
        if (budget < 0) throw new Stop("bad-answer");
        entries.push(entry);
      }
    }
  } catch (error) {
    if (error instanceof Stop) return { ok: false, problem: error.problem };
    throw error;
  }
}

export type LoadedRegistry =
  | {
      readonly ok: true;
      /** The finalized L2 block the registry was read up to, and its timestamp. */
      readonly block: bigint;
      readonly timestamp: bigint;
      /**
       * Every log the group registry emitted from its deployment to `block`,
       * in log order, each as a contract-event record (`0x0008`) under the
       * deployment's `eventVersion`, numbered `n` from 0. Their
       * `l2_timestamp` is 0, not the chain's, so they are for the outcome's
       * replay alone: never archived or checked against an accumulator.
       */
      readonly records: readonly Uint8Array[];
    }
  | { readonly ok: false; readonly problem: LoadProblem };

/** The most blocks one `eth_getLogs` call spans: public endpoints cap ranges (the worker's `TIER0_LOG_RANGE`). */
export const LOG_RANGE = 10_000n;
// A finalized block's header with its transaction hashes, and a range's
// logs: each log at most a `MembersAdded` or self-paid record as hex, with
// its JSON. The whole read shares the board's budget (T-52).
const MAX_BLOCK_ANSWER = 2 * 1024 * 1024;
const MAX_LOGS_ANSWER = 64 * 1024 * 1024;
// Each range's charge: small, since the number of ranges grows with the
// chain's age, not with what the RPC chooses to serve, yet enough that a
// node claiming a head far ahead runs the budget out (256 MiB is 262,144
// ranges, about 166 years of Base blocks).
const RANGE_COST = 1024;

/**
 * The deployment's group registry as of the L2's finalized head: every log
 * it emitted since it was deployed, as the outcome of a Tier 0 registration
 * is read from them (`tier0Registration`, in the worker). The requests name
 * the registry and block ranges only, never a group or a commitment, so the
 * RPC learns nothing of the voter's registration (T-10, T-11, T-13).
 *
 * The RPC is trusted for which logs exist (Known-weak); what it can't do
 * here is answer outside its forms: a log of another address, outside the
 * range asked, reorganised away, out of log order or repeated, or a read
 * that runs out the `maxBytes` budget, is `bad-answer`. The logs are
 * numbered by their place in the whole sequence, which the event
 * accumulator binds; `l2_timestamp` is 0, since the replay reads none.
 */
export async function loadGroupRegistry(
  deployment: Deployment,
  fetchFn: Fetch,
  maxBytes = MAX_BOARD_BYTES,
  range = LOG_RANGE,
): Promise<LoadedRegistry> {
  const registry = deployment.groupRegistry;
  if (registry === undefined) return { ok: false, problem: "no-registry" };
  const contract = fromHex(registry.address.slice(2));
  const records: Uint8Array[] = [];
  let budget = maxBytes;
  try {
    const [, head] = await both(
      checkChain(deployment, fetchFn),
      finalizedHead(deployment, fetchFn),
    );
    // The last log read, as (block, logIndex): each must come strictly after it.
    let last: readonly [bigint, bigint] | undefined;
    let id = 3;
    for (let from = registry.deployedAt; from <= head.block; from += range) {
      const to = from + range - 1n < head.block ? from + range - 1n : head.block;
      const logs = await rpcResult(
        deployment,
        fetchFn,
        id++,
        "eth_getLogs",
        [{ address: registry.address, fromBlock: quantity(from), toBlock: quantity(to) }],
        MAX_LOGS_ANSWER,
      ).catch((e: unknown) => {
        throw e instanceof TypeError ? new Stop("unreachable") : e;
      });
      if (!Array.isArray(logs)) throw new Stop("bad-answer");
      // Charged before the logs, so a node that claims a head far ahead,
      // with nothing in its ranges, runs the budget out too.
      budget -= RANGE_COST;
      if (budget < 0) throw new Stop("bad-answer");
      for (const log of logs as unknown[]) {
        const read = logOf(log, registry.address, from, to);
        if (
          last !== undefined &&
          !(read.block > last[0] || (read.block === last[0] && read.index > last[1]))
        )
          throw new Stop("bad-answer");
        last = [read.block, read.index];
        budget -= read.data.length + 32 * read.topics.length + ENTRY_COST;
        if (budget < 0) throw new Stop("bad-answer");
        records.push(
          encodeContractEvent(
            {
              contract,
              n: BigInt(records.length),
              l2_block: read.block,
              l2_timestamp: 0n,
              topics: read.topics,
              data: read.data,
            },
            registry.eventVersion,
          ),
        );
      }
    }
    return { ok: true, block: head.block, timestamp: head.timestamp, records };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, problem: error.problem };
    throw error;
  }
}

export type LoadedChainTime =
  | { readonly ok: true; readonly timestamp: bigint }
  | { readonly ok: false; readonly problem: LoadProblem };

/**
 * The timestamp of the L2's finalized head, the chain's time as far as a
 * contract-path record's submission time is concerned ([[delivery]],
 * Windows): what the client judges a poll's posting cutoff by, beside the
 * device's own clock, before it erases what a posting would need (T-18).
 * Finalized, so it lags the chain and never runs ahead of it.
 */
export async function loadChainTime(
  deployment: Deployment,
  fetchFn: Fetch,
): Promise<LoadedChainTime> {
  try {
    const [, head] = await both(
      checkChain(deployment, fetchFn),
      finalizedHead(deployment, fetchFn),
    );
    return { ok: true, timestamp: head.timestamp };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, problem: error.problem };
    throw error;
  }
}

/** Request 2: the L2's finalized block, by number and timestamp: logs past it could be reorganised away (T-34). */
async function finalizedHead(
  deployment: Deployment,
  fetchFn: Fetch,
): Promise<{ block: bigint; timestamp: bigint }> {
  const block = await rpcResult(
    deployment,
    fetchFn,
    2,
    "eth_getBlockByNumber",
    [BLOCK, false],
    MAX_BLOCK_ANSWER,
  );
  if (!isRecord(block)) throw new Stop("bad-answer");
  const { number, timestamp } = block;
  if (typeof number !== "string" || !QUANTITY.test(number)) throw new Stop("bad-answer");
  if (typeof timestamp !== "string" || !QUANTITY.test(timestamp)) throw new Stop("bad-answer");
  return { block: BigInt(number), timestamp: BigInt(timestamp) };
}

const quantity = (n: bigint) => `0x${n.toString(16)}`;

const WORD = /^0x[0-9a-f]{64}$/;
const DATA = /^0x(?:[0-9a-f]{2})*$/;

/**
 * One log of `address` in blocks `from` to `to`, as the event's fields, or
 * `bad-answer`. Topics and data are lowercase hex, as nodes serialize them
 * and as every other answer is read; the address is compared in any case,
 * since some nodes give its checksum spelling.
 */
function logOf(log: unknown, address: string, from: bigint, to: bigint) {
  if (!isRecord(log)) throw new Stop("bad-answer");
  const { address: emitter, topics, data, blockNumber, logIndex, removed } = log;
  if (
    removed === true ||
    typeof emitter !== "string" ||
    emitter.toLowerCase() !== address ||
    !Array.isArray(topics) ||
    topics.length < 1 ||
    topics.length > MAX_EVENT_TOPICS ||
    !topics.every((t) => typeof t === "string" && WORD.test(t)) ||
    typeof data !== "string" ||
    !DATA.test(data) ||
    (data.length - 2) / 2 > MAX_EVENT_DATA ||
    typeof blockNumber !== "string" ||
    !QUANTITY.test(blockNumber) ||
    typeof logIndex !== "string" ||
    !QUANTITY.test(logIndex)
  )
    throw new Stop("bad-answer");
  const block = BigInt(blockNumber);
  if (block < from || block > to) throw new Stop("bad-answer");
  return {
    block,
    index: BigInt(logIndex),
    topics: (topics as string[]).map((t) => fromHex(t.slice(2))),
    data: fromHex(data.slice(2)),
  };
}

/** A `{ entries }` answer of at most `limit` entries, each lowercase hex, as bytes. */
function entriesOf(answer: unknown, limit: number): Uint8Array[] {
  if (!isRecord(answer) || Object.keys(answer).length !== 1) throw new Stop("bad-answer");
  const entries = answer["entries"];
  if (
    !Array.isArray(entries) ||
    entries.length > limit ||
    !entries.every((e) => typeof e === "string" && /^(?:[0-9a-f]{2})+$/.test(e))
  )
    throw new Stop("bad-answer");
  return entries.map((e: string) => fromHex(e));
}

/** The body as JSON, read only up to `maxBytes`. */
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const body = response.body;
  if (body === null) throw new Stop("bad-answer");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Stop("bad-answer");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Stop("bad-answer");
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Lowercase hex, already checked, to bytes. */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}
