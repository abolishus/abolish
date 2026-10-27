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
  checkContractEvent,
  encodeContractEvent,
  MAX_EVENT_DATA,
  MAX_EVENT_TOPICS,
  PARAMETERS,
} from "@abolishus/crypto";

import { type Deployment, onL1 } from "./deployment.ts";
import { isCodeOf, shortLink } from "./share.ts";

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
      /**
       * The poll's short link on the website (share.ts), or `undefined` where
       * the build names no website or the code couldn't be read as one of
       * the registered hash's.
       */
      readonly shortLink: string | undefined;
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
// `{ code }`, a code being at most 52 characters.
const MAX_CODE_ANSWER = 128;

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
    const [[[[definition, displayText], entries], moderation], code] = await both(
      both(
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
      ),
      codeOf(deployment, id, registeredHash, fetchFn),
    );
    return {
      ok: true,
      registeredHash,
      definition,
      displayText,
      entries,
      hiddenAsThreat: moderation === "threat",
      shortLink:
        deployment.web === undefined || code === undefined
          ? undefined
          : shortLink(deployment.web, code),
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

/**
 * The poll's short code (`GET /elections/code`), asked for beside the
 * records, so it tells the API nothing they don't: never after answering,
 * which would mark who answered (T-10). Only where the build names a
 * website, and only a code that is a prefix of `registeredHash` (share.ts).
 * Anything else is `undefined`: a missing code only leaves the link out, so
 * it never stops voting. It rejects only for a fault of this page (an abort).
 */
async function codeOf(
  deployment: Deployment,
  electionId: string,
  registeredHash: Uint8Array,
  fetchFn: Fetch,
): Promise<string | undefined> {
  if (deployment.web === undefined) return undefined;
  let answer: unknown;
  try {
    const url = `${deployment.api}/elections/code?electionId=${electionId}`;
    const response = await fetchFn(url, { ...REQUEST, method: "GET" });
    if (!response.ok) return undefined;
    answer = await readJson(response, MAX_CODE_ANSWER);
  } catch (error) {
    if (error instanceof Stop || error instanceof TypeError) return undefined;
    throw error;
  }
  if (!isRecord(answer) || Object.keys(answer).length !== 1) return undefined;
  const code = answer["code"];
  return typeof code === "string" && isCodeOf(code, registeredHash) ? code : undefined;
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

// The most of the board's logs one postings read takes: a ballot has at most
// one posting per seat, a few KiB each, so this is room for any honest board
// with thousands to spare, and a node serving more is lying (T-52).
const MAX_POSTINGS_BYTES = 16 * 1024 * 1024;

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
 * Windows): what the client judges a poll's close by, beside the
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

export type LoadedPostings =
  | {
      readonly ok: true;
      /** The head block read up to, and its timestamp. */
      readonly block: bigint;
      readonly timestamp: bigint;
      /** The share postings the board's `SharePosted` events carry for the ballot, in log order. */
      readonly records: readonly Uint8Array[];
    }
  | { readonly ok: false; readonly problem: LoadProblem };

/**
 * The share postings the deployment's board recorded for the ballot whose
 * definition and ballot hashes are `definitionHash` and `ballotHash`, from
 * block `from` (the board's deployment when absent) to the L2's `head`:
 * `finalized` for a posting the client may stand down on, `latest` only for
 * a sighting that delays its fallback, never one that cancels it
 * ([[posting-relay]], Outcome; T-25, T-50), and `safe` for one the
 * sequencer batched to L1, which the voter's wallet then doesn't force (Own
 * wallet, Forced through L1). Each log is read as a board
 * event under the deployment's `eventVersion` and kept only if it is a
 * `SharePosted` whose topics are these hashes and whose record the board
 * frames (`checkContractEvent`), so a node can't pass off another event's
 * record as a posting. The requests name the two hashes, as the spec's
 * read does: the RPC learns which ballot the client watches, from the
 * voter's address, before the ballot or any posting of it is public, and
 * even if neither ever is (Known-weak in docs/status/P2-8.md; T-11, T-13).
 * The RPC is trusted for
 * which logs exist: one that hides a posting only delays the client to its
 * fallback; one that invents a log can't make it carry another record.
 * As the group registry's read, it runs out a `maxBytes` budget, charged
 * each range and each log's data, so a node that claims a head far ahead,
 * or serves logs without end, ends it as `bad-answer` (T-52); and it is
 * given up, as `unreachable`, as soon as `stop` says so before a request,
 * so a node that answers each range slowly can't hold the caller past its
 * deadline (T-25).
 */
export async function loadPostings(
  deployment: Deployment,
  definitionHash: Uint8Array,
  ballotHash: Uint8Array,
  fetchFn: Fetch,
  head: "finalized" | "safe" | "latest",
  from?: bigint,
  range = LOG_RANGE,
  maxBytes = MAX_POSTINGS_BYTES,
  stop: () => boolean = () => false,
): Promise<LoadedPostings> {
  const board = deployment.board;
  if (board === undefined) return { ok: false, problem: "no-registry" };
  if (definitionHash.length !== 32 || ballotHash.length !== 32)
    throw new RangeError("definitionHash and ballotHash: expected 32 bytes");
  const contract = fromHex(board.address.slice(2));
  // The event check names each contract by its role; only the board's logs
  // are asked for, so the others are an address no contract has.
  const contracts = {
    electionRegistry: new Uint8Array(20),
    trusteeRegistry: new Uint8Array(20),
    groupRegistry: new Uint8Array(20),
    board: contract,
  };
  const topics = [null, `0x${toHex(definitionHash)}`, `0x${toHex(ballotHash)}`];
  const records: Uint8Array[] = [];
  let budget = maxBytes;
  try {
    const [, at] = await both(
      checkChain(deployment, fetchFn),
      headBlock(deployment, fetchFn, head),
    );
    let id = 3;
    let last: readonly [bigint, bigint] | undefined;
    for (let start = from ?? board.deployedAt; start <= at.block; start += range) {
      if (stop()) throw new Stop("unreachable");
      const to = start + range - 1n < at.block ? start + range - 1n : at.block;
      const logs = await rpcResult(
        deployment,
        fetchFn,
        id++,
        "eth_getLogs",
        [{ address: board.address, topics, fromBlock: quantity(start), toBlock: quantity(to) }],
        MAX_LOGS_ANSWER,
      ).catch((e: unknown) => {
        throw e instanceof TypeError ? new Stop("unreachable") : e;
      });
      if (!Array.isArray(logs)) throw new Stop("bad-answer");
      budget -= RANGE_COST;
      if (budget < 0) throw new Stop("bad-answer");
      for (const log of logs as unknown[]) {
        const read = logOf(log, board.address, start, to);
        if (
          last !== undefined &&
          !(read.block > last[0] || (read.block === last[0] && read.index > last[1]))
        )
          throw new Stop("bad-answer");
        last = [read.block, read.index];
        budget -= read.data.length + ENTRY_COST;
        if (budget < 0) throw new Stop("bad-answer");
        const checked = checkContractEvent(
          {
            contract,
            n: 0n,
            l2_block: read.block,
            l2_timestamp: 0n,
            topics: read.topics,
            data: read.data,
          },
          contracts,
          board.eventVersion,
        );
        if (
          checked.ok &&
          checked.event.event === "SharePosted" &&
          equalBytes(checked.event.definitionHash, definitionHash) &&
          equalBytes(checked.event.ballotHash, ballotHash)
        )
          records.push(checked.event.record);
      }
    }
    return { ok: true, block: at.block, timestamp: at.timestamp, records };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, problem: error.problem };
    throw error;
  }
}

export type LoadedDeposits =
  | {
      readonly ok: true;
      /** The L1 head's timestamp. */
      readonly timestamp: bigint;
      /**
       * For each call asked about, in order, the timestamp of the L1 block
       * of its newest qualifying deposit, or `undefined` where none is.
       */
      readonly landed: readonly (bigint | undefined)[];
    }
  | { readonly ok: false; readonly problem: LoadProblem };

// keccak256("TransactionDeposited(address,address,uint256,bytes)"): the
// portal's deposit event, version 0's (OP Stack, Deposits).
const DEPOSITED = "b3813568d9991fc951961fcb4c784893574240a28925604d09fc577c55bb7c32";
// The most of the portal's logs one deposits read takes. Every deposit to
// the board in the window is read, a forced ballot's of up to 120 KB among
// them, so this is room for hundreds; a node serving more, or an L1 flooded
// with deposits to the board, only brings the fallback sooner (T-52).
const MAX_DEPOSITS_BYTES = 64 * 1024 * 1024;
// A deposit's `opaqueData`: `mint` and `value` (32 bytes each), `gasLimit`
// (8) and `isCreation` (1), then the call's data.
const OPAQUE_HEAD = 73;
// The furthest back a deposits read starts, in L1 blocks (about 27 hours of
// 12-second slots), and the most blocks holding deposits to the board whose
// times it reads: room for any honest run, and a node claiming more only
// brings the fallback sooner (T-52).
export const MAX_DEPOSIT_LOOKBACK = 8_192n;
const MAX_DEPOSIT_BLOCKS = 256;

/**
 * Looks on L1, through the deployment's own L1 endpoint, for a deposit that
 * forces each of `calls` (each a posting's `submitPosting` calldata) to the
 * board: a **qualifying deposit** ([[posting-relay]], Outcome) is a
 * `TransactionDeposited` event of the portal the release pins, version 0,
 * from any sender, to the board, with `value` 0, no creation, the call's
 * exact data, and a gas limit at least the client's own `eth_estimateGas`
 * of the call through its L2 endpoint, so a deposit made to fail for want
 * of gas never holds the client (T-25). It reads the L1 head and every
 * deposit to the board from the newest block whose time is by `since`
 * (found by going back in doubling steps, at most `MAX_DEPOSIT_LOOKBACK`
 * blocks), with the time of each block holding one, and answers, for each call, the
 * time of its newest qualifying deposit's L1 block, which reaches L2 by
 * that time plus `F` ([[0004-l2-choice]], Forced inclusion).
 *
 * The requests to L1 name only the portal and the board, never a posting,
 * so the L1 endpoint learns nothing of which ballot the client watches
 * (T-11, T-13). A call is estimated on L2 here only once a deposit on L1
 * carries its exact bytes, which are then public (T-18); forcing a send the
 * wallet's node refused estimates it before (`estimatePosting`). Either
 * endpoint is trusted only to delay: a deposit the L1 one makes up, or an
 * estimate the L2 one understates so that a deposit made to fail
 * qualifies, keeps the client waiting, to its deadline `c_P` at most; one
 * it hides, or an estimate failed or inflated, only brings the fallback
 * sooner. As the board's reads, it runs out a `maxBytes` budget, charged
 * each block looked up, each range and each log (T-52), and is given up, as
 * `unreachable`, as soon as `stop` says so before a request (T-25).
 */
export async function loadDeposits(
  deployment: Deployment,
  calls: readonly Uint8Array[],
  since: bigint,
  fetchFn: Fetch,
  stop: () => boolean = () => false,
  range = LOG_RANGE,
  maxBytes = MAX_DEPOSITS_BYTES,
): Promise<LoadedDeposits> {
  const board = deployment.board;
  if (board === undefined) return { ok: false, problem: "no-registry" };
  const l1 = onL1(deployment);
  const boardTopic = `${"0".repeat(24)}${board.address.slice(2)}`;
  const topics = [`0x${DEPOSITED}`, null, `0x${boardTopic}`, `0x${"0".repeat(64)}`];
  // Each call's deposits, by gas limit and L1 block.
  const found: { gasLimit: bigint; block: bigint }[][] = calls.map(() => []);
  // The blocks holding any deposit to the board, in order.
  const blocks = new Set<bigint>();
  let budget = maxBytes;
  const charge = (cost: number) => {
    budget -= cost;
    if (budget < 0) throw new Stop("bad-answer");
  };
  const ask = () => {
    if (stop()) throw new Stop("unreachable");
  };
  try {
    const [, head] = await both(checkChain(l1, fetchFn), headBlock(l1, fetchFn, "latest"));
    // Back in doubling steps to a block by `since`, at most
    // MAX_DEPOSIT_LOOKBACK blocks: a run's read comes within about an hour
    // of its start, and from at most `F` (13 hours on Base) before it, and
    // an endpoint whose every block is later than `since` can't send the
    // read back to the chain's start (T-52). A start time `F` back takes the
    // last step, so the read can span the whole lookback, about 27 hours:
    // `MAX_DEPOSIT_BLOCKS` and the budget then bound more deposits, and a
    // run reads again from its own start where this read fails (posting.ts).
    let start: bigint | undefined;
    for (let back = 64n; start === undefined; back *= 2n) {
      if (back > MAX_DEPOSIT_LOOKBACK) throw new Stop("bad-answer");
      ask();
      charge(RANGE_COST);
      const at = head.block > back ? head.block - back : 0n;
      if (at === 0n || (await blockTime(l1, fetchFn, at)) <= since) start = at;
    }
    let id = 3;
    let last: readonly [bigint, bigint] | undefined;
    for (let from = start; from <= head.block; from += range) {
      ask();
      const to = from + range - 1n < head.block ? from + range - 1n : head.block;
      const logs = await rpcResult(
        l1,
        fetchFn,
        id++,
        "eth_getLogs",
        [{ address: board.portal, topics, fromBlock: quantity(from), toBlock: quantity(to) }],
        MAX_LOGS_ANSWER,
      ).catch((e: unknown) => {
        throw e instanceof TypeError ? new Stop("unreachable") : e;
      });
      if (!Array.isArray(logs)) throw new Stop("bad-answer");
      charge(RANGE_COST);
      for (const log of logs as unknown[]) {
        const read = logOf(log, board.portal, from, to);
        if (
          last !== undefined &&
          !(read.block > last[0] || (read.block === last[0] && read.index > last[1]))
        )
          throw new Stop("bad-answer");
        last = [read.block, read.index];
        charge(read.data.length + ENTRY_COST);
        const deposit = depositOf(read.topics, read.data, boardTopic);
        if (deposit === undefined) continue;
        blocks.add(read.block);
        calls.forEach((call, i) => {
          if (equalBytes(deposit.data, call))
            found[i]?.push({ gasLimit: deposit.gasLimit, block: read.block });
        });
      }
    }
    // The time of every block holding a deposit to the board, whichever
    // call it carries, so the requests to L1 are the same whether or not
    // one of the client's calls is among them (T-11, T-13).
    if (blocks.size > MAX_DEPOSIT_BLOCKS) throw new Stop("bad-answer");
    const times = new Map<bigint, bigint>();
    for (const block of blocks) {
      ask();
      const time = await blockTime(l1, fetchFn, block);
      // Never ahead of the head it was read under (T-25).
      if (time > head.timestamp) throw new Stop("bad-answer");
      times.set(block, time);
    }
    const landed: (bigint | undefined)[] = [];
    for (const [i, call] of calls.entries()) {
      const deposits = found[i] ?? [];
      let newest: bigint | undefined;
      if (deposits.length > 0) {
        ask();
        const needed = await estimate(deployment, fetchFn, board.address, call);
        for (const { gasLimit, block } of deposits)
          if (
            needed !== undefined &&
            gasLimit >= needed &&
            (newest === undefined || block > newest)
          )
            newest = block;
      }
      landed.push(newest === undefined ? undefined : times.get(newest));
    }
    return { ok: true, timestamp: head.timestamp, landed };
  } catch (error) {
    if (error instanceof Stop) return { ok: false, problem: error.problem };
    throw error;
  }
}

/**
 * The deposit a portal log is, or `undefined` where it isn't one to the
 * board under version 0, or carries value or a creation (which the board,
 * not payable, would refuse): its gas limit and the call's data. The log's
 * data is the ABI encoding of one `bytes`, `opaqueData`, which must be
 * canonical: offset 32, its length, and zero padding to a whole word.
 */
function depositOf(
  topics: readonly Uint8Array[],
  data: Uint8Array,
  boardTopic: string,
): { gasLimit: bigint; data: Uint8Array } | undefined {
  // At most four topics, as `logOf` reads them.
  const [event, , to, version] = topics;
  if (
    event === undefined ||
    to === undefined ||
    version === undefined ||
    toHex(event) !== DEPOSITED ||
    toHex(to) !== boardTopic ||
    version.some((b) => b !== 0) ||
    data.length < 64
  )
    return undefined;
  const word = (at: number) => BigInt(`0x${toHex(data.subarray(at, at + 32))}`);
  const length = word(32);
  if (word(0) !== 32n || length < BigInt(OPAQUE_HEAD) || length > BigInt(data.length))
    return undefined;
  const n = Number(length);
  if (data.length !== 64 + Math.ceil(n / 32) * 32 || data.subarray(64 + n).some((b) => b !== 0))
    return undefined;
  const opaque = data.subarray(64, 64 + n);
  // `value` and `isCreation` zero; `mint` is the sender's to credit itself.
  if (opaque.subarray(32, 64).some((b) => b !== 0) || opaque[72] !== 0) return undefined;
  return {
    gasLimit: BigInt(`0x${toHex(opaque.subarray(64, 72))}`),
    data: opaque.subarray(OPAQUE_HEAD),
  };
}

/**
 * The build's own L2 endpoint's `eth_estimateGas` of one posting's
 * `submitPosting` calldata `call` to the board the deployment pins, or
 * `undefined` where the call reverts or the endpoint can't answer: the gas
 * a deposit forcing a posting the wallet's node refused is given, judged
 * by the same estimate `loadDeposits` qualifies it by ([[posting-relay]],
 * Own wallet, Forced through L1). The call carries `m_i`, so it is asked
 * only once the wallet's node reverted it, or the wallet may have sent it
 * (T-18). Any failure, a timeout's abort included, is `undefined`.
 */
export async function estimatePosting(
  deployment: Deployment,
  call: Uint8Array,
  fetchFn: Fetch,
): Promise<bigint | undefined> {
  const board = deployment.board;
  if (board === undefined) return undefined;
  return estimate(deployment, fetchFn, board.address, call).catch(() => undefined);
}

/**
 * The L2 endpoint's `eth_estimateGas` of `call` to the board at its latest
 * block, or `undefined` if it can't give one (the call reverts, or the
 * node fails or isn't on the deployment's chain): then no deposit of the
 * call qualifies, which only brings the fallback sooner.
 */
async function estimate(
  deployment: Deployment,
  fetchFn: Fetch,
  board: string,
  call: Uint8Array,
): Promise<bigint | undefined> {
  try {
    await checkChain(deployment, fetchFn);
    const gas = await rpc(deployment, fetchFn, 3, "eth_estimateGas", [
      { to: board, data: `0x${toHex(call)}` },
    ]);
    if (!QUANTITY.test(gas)) return undefined;
    return BigInt(gas);
  } catch (error) {
    if (error instanceof Stop || error instanceof TypeError) return undefined;
    throw error;
  }
}

/** The timestamp of block `n`, which the node must answer as that block. */
async function blockTime(deployment: Deployment, fetchFn: Fetch, n: bigint): Promise<bigint> {
  const block = await headBlock(deployment, fetchFn, quantity(n)).catch((e: unknown) => {
    throw e instanceof TypeError ? new Stop("unreachable") : e;
  });
  if (block.block !== n) throw new Stop("bad-answer");
  return block.timestamp;
}

/** Request 2: the L2's finalized block, by number and timestamp: logs past it could be reorganised away (T-34). */
const finalizedHead = (deployment: Deployment, fetchFn: Fetch) =>
  headBlock(deployment, fetchFn, BLOCK);

/** The chain's block at `tag` (a head's name, or a number as a quantity), by number and timestamp. */
async function headBlock(
  deployment: Deployment,
  fetchFn: Fetch,
  tag: string,
): Promise<{ block: bigint; timestamp: bigint }> {
  const block = await rpcResult(
    deployment,
    fetchFn,
    2,
    "eth_getBlockByNumber",
    [tag, false],
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

const equalBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Lowercase hex, already checked, to bytes. */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return bytes;
}
