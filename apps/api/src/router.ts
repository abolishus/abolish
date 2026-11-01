import { contract, MAX_PAGE_BYTES } from "@abolishus/api-contract";
import {
  BoardReadError,
  checkPostingRequest,
  countListedPolls,
  listedPlaces,
  deleteIdentityBackup,
  hasDefinition,
  IdentityBackupStoreError,
  ListingError,
  type ListingOrder,
  answeredByTier,
  answeredByTiers,
  listPolls,
  listPollsBefore,
  lookupShortCode,
  ModerationError,
  moderationStatus,
  putIdentityBackup,
  readConsistencyProof,
  readDefinition,
  readServedDisplayText,
  readEntries,
  readHead,
  readIdentityBackup,
  readInclusionProof,
  readLatestCheckpoints,
  readBoardedEntry,
  readEntryAt,
  readPollTags,
  readPublicModerationCounts,
  readPublicModerationLog,
  readPublicModerationLogBefore,
  report,
  SearchQueryError,
  searchTerms,
  shortCodeOf,
  parseTier0Request,
  placeKey,
  parseTier1Request,
  type PostingRelay,
  PostingRelayError,
  Tier0RegistrationError,
  type Tier0Registrations,
  type Tier1Relay,
  type TierAnswered,
  Tier1RelayError,
} from "@abolishus/core";
import type { PeriodClock } from "@abolishus/crypto";
import { implement, ORPCError } from "@orpc/server";
import type {
  BallotQueue,
  DestructionQueue,
  OpeningQueue,
  ReceiptQueue,
  ResultsQueue,
} from "@abolishus/worker/ballot-queue";
import type { Sql } from "postgres";

// The contract's procedures (packages/api-contract). Each handler parses its
// already-validated input into bytes, calls core and serialises the answer:
// no protocol logic lives here (AGENTS.md, Architecture). Every answer is a
// claim the caller checks with @abolishus/crypto (T-23, T-24, T-34).
//
// The context holds the database, the worker's ballot, receipt, opening,
// destruction and results queues, Tier 0 registration, the Tier 1 relay, the
// posting relay, the clock and the boards' anchoring clock, and nothing of the request: no handler can see a request's
// headers, cookies or address, so no procedure can tie what it serves or
// receives to a person or session (T-10, T-11).

/** What `ballots.submit` needs of the worker's queue. */
export type BallotSubmitter = Pick<BallotQueue, "submit">;

/** What `receipts.submit` needs of the worker's queue. */
export type ReceiptSubmitter = Pick<ReceiptQueue, "submit">;

/** What `openings.submit` needs of the worker's queue. */
export type OpeningSubmitter = Pick<OpeningQueue, "submit">;

/** What `destructions.submit` needs of the worker's queue. */
export type DestructionSubmitter = Pick<DestructionQueue, "submit">;

/** What `elections.getResults` needs of the worker's queue. */
export type ResultsReader = Pick<ResultsQueue, "read">;

export interface Context {
  readonly sql: Sql;
  /** Absent when this server has no ballot queue: it then boards no ballot. */
  readonly ballots?: BallotSubmitter | undefined;
  /** Absent when this server has no receipt queue: it then boards no share receipt. */
  readonly receipts?: ReceiptSubmitter | undefined;
  /** Absent when this server has no opening queue: it then boards no tally opening. */
  readonly openings?: OpeningSubmitter | undefined;
  /** Absent when this server has no destruction queue: it then boards no destruction statement. */
  readonly destructions?: DestructionSubmitter | undefined;
  /** Absent when this server has no results queue: it then counts no results. */
  readonly results?: ResultsReader | undefined;
  /** UNIX time in seconds. */
  readonly now: () => bigint;
  /** Absent when this server isn't configured for Tier 0 registration: it then queues nothing. */
  readonly tier0?: Tier0Registrations | undefined;
  /** Absent when this server isn't configured for the Tier 1 relay: it then queues nothing. */
  readonly tier1?: Tier1Relay | undefined;
  /** Absent when this server isn't configured for the posting relay: it then queues nothing. */
  readonly postings?: Pick<PostingRelay, "relay"> | undefined;
  /** The anchoring clock our boards' segments follow; absent, the `answered` order is unavailable. */
  readonly boardClock?: PeriodClock | undefined;
}

const os = implement(contract).$context<Context>();

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const served = (tiers: readonly TierAnswered[]) =>
  tiers.map(({ tier, voters }) => ({ tier, answered: String(voters) }));
const ZERO_HASH = "00".repeat(32);

/** The board's position errors, as the contract names them. */
function boardError(e: unknown, outOfRange: () => Error): never {
  if (e instanceof BoardReadError) {
    if (e.code === "beyond-board") throw outOfRange();
    throw new ORPCError("BAD_REQUEST", { message: "No tree of these sizes has these positions." });
  }
  throw e;
}

/** Board procedures answer only for elections whose definition this server holds. */
async function knownElection(sql: Sql, electionId: string, notFound: () => Error) {
  const id = fromHex(electionId);
  if (!(await hasDefinition(sql, id))) throw notFound();
  return id;
}

export const router = os.router({
  elections: {
    // Discovery leaves out delisted and hidden polls (docs/moderation-policy.md; T-68).
    list: os.elections.list.handler(async ({ input, context, errors }) => {
      const after = input.after === undefined ? undefined : fromHex(input.after);
      const sort = input.sort ?? "id";
      let order: ListingOrder;
      if (sort === "id") order = { sort };
      else if (sort !== "answered") order = { sort, now: context.now() };
      else if (context.boardClock === undefined) throw errors.SORT_UNAVAILABLE();
      else order = { sort, now: context.now(), clock: context.boardClock };
      try {
        // The query is matched and dropped: like every query string, it is
        // never logged (T-11, T-67).
        const terms = input.q === undefined ? [] : searchTerms(input.q);
        const placeKeyOf = input.place === undefined ? undefined : placeKey(input.place);
        // Quoting nothing of the place, as of the query (T-11).
        if (input.place !== undefined && placeKeyOf === undefined)
          throw new ORPCError("BAD_REQUEST", { message: "No place is left once normalised." });
        const tags = {
          ...(input.topic === undefined ? {} : { topic: input.topic }),
          ...(placeKeyOf === undefined ? {} : { placeKey: placeKeyOf }),
        };
        const limit = Number(input.limit);
        // The contract takes `before` only alone, under the `id` order.
        const elections =
          input.before === undefined
            ? await listPolls(context.sql, after, limit, order, terms, tags)
            : await listPollsBefore(context.sql, fromHex(input.before), limit, terms, tags);
        return { elections: elections.map(toHex) };
      } catch (e) {
        if (e instanceof ListingError) throw errors.CURSOR_NOT_FOUND();
        // Quoting nothing of the query (T-11).
        if (e instanceof SearchQueryError)
          throw new ORPCError("BAD_REQUEST", {
            message: "No search term is left once normalised.",
          });
        throw e;
      }
    }),
    // The listing's counts by the same rules and clock, in one statement (T-68).
    getCounts: os.elections.getCounts.handler(async ({ context }) => {
      const counts = await countListedPolls(context.sql, context.now());
      return {
        listed: String(counts.listed),
        open: String(counts.open),
        scheduled: String(counts.scheduled),
      };
    }),
    // Listed polls' places only, as the listing leaves out (T-68).
    getPlaces: os.elections.getPlaces.handler(async ({ context }) => ({
      places: [...(await listedPlaces(context.sql))],
    })),
    getDefinition: os.elections.getDefinition.handler(async ({ input, context, errors }) => {
      const definition = await readDefinition(context.sql, fromHex(input.electionId));
      if (definition === undefined) throw errors.ELECTION_NOT_FOUND();
      return { definition: toHex(definition) };
    }),
    // What is served follows the moderation policy, which core applies
    // (docs/moderation-policy.md, Open polls; T-68).
    getDisplayText: os.elections.getDisplayText.handler(async ({ input, context, errors }) => {
      const text = await readServedDisplayText(
        context.sql,
        fromHex(input.electionId),
        context.now(),
      );
      if (text === undefined) throw errors.ELECTION_NOT_FOUND();
      if (text.served === "withheld") throw errors.DISPLAY_TEXT_WITHHELD();
      if (text.served === "none") throw errors.DISPLAY_TEXT_NOT_FOUND();
      return { displayText: toHex(text.displayText) };
    }),
    // Moderation decides what is served, as for the text: a hidden poll's
    // place is its author's words (docs/moderation-policy.md, Refiling; T-68).
    getTags: os.elections.getTags.handler(async ({ input, context, errors }) => {
      const view = await readPollTags(context.sql, fromHex(input.electionId));
      if (view === undefined) throw errors.ELECTION_NOT_FOUND();
      if (view.tags === undefined) throw errors.TAGS_WITHHELD();
      return view.tags;
    }),
    // A count of the public board, tier by tier, which moderation never
    // withholds, as it never withholds the board (T-01, T-68).
    getAnswered: os.elections.getAnswered.handler(async ({ input, context, errors }) => {
      const tiers = await answeredByTier(context.sql, fromHex(input.electionId));
      if (tiers === undefined) throw errors.ELECTION_NOT_FOUND();
      return { tiers: served(tiers) };
    }),
    // The same counts for a page's several polls, in one read (T-52); an
    // unknown election is left out, as the contract says.
    getAnsweredMany: os.elections.getAnsweredMany.handler(async ({ input, context }) => {
      const counts = await answeredByTiers(context.sql, input.electionIds.map(fromHex));
      return {
        elections: input.electionIds.flatMap((electionId, i) => {
          const tiers = counts[i];
          return tiers === undefined ? [] : [{ electionId, tiers: served(tiers) }];
        }),
      };
    }),
    // The results the boarded openings give, read in the worker by core's
    // OpeningBoardings over the counted tally it judges them against, which
    // the verifier's `countedResults` computes, never here (T-29, T-52).
    // Moderation never withholds a result (docs/moderation-policy.md). A
    // server without the queue boards no opening, so counts none.
    getResults: os.elections.getResults.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      if (context.results === undefined) throw errors.RESULTS_NOT_COUNTED();
      const outcome = await context.results.read(id);
      if (outcome.ok) {
        const { ok: _, ...results } = outcome;
        return results;
      }
      switch (outcome.code) {
        case "unknown-election":
          throw errors.ELECTION_NOT_FOUND();
        case "not-open":
          throw errors.RESULTS_NOT_COUNTED();
        case "not-ready":
          throw errors.RESULTS_NOT_READY();
        case "unavailable":
          throw errors.RESULTS_UNAVAILABLE();
      }
    }),
    // Short links (docs/design/sharing.md). A refusal never quotes the input,
    // and the request log records only the route (T-11, T-67).
    resolveCode: os.elections.resolveCode.handler(async ({ input, context, errors }) => {
      const match = await lookupShortCode(context.sql, input.code);
      if (match === undefined) throw errors.CODE_NOT_FOUND();
      return { electionId: toHex(match.electionId), code: match.code };
    }),
    getCode: os.elections.getCode.handler(async ({ input, context, errors }) => {
      const code = await shortCodeOf(context.sql, fromHex(input.electionId));
      if (code === undefined) throw errors.CODE_NOT_FOUND();
      return { code };
    }),
  },
  board: {
    getHead: os.board.getHead.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const head = await readHead(context.sql, id);
      // An empty board has no chain head or root (docs/spec/board.md never
      // hashes an empty tree): size 0 comes with zeros, which no client checks
      // anything against.
      return {
        treeSize: head.size.toString(),
        chainHead: head.head === undefined ? ZERO_HASH : toHex(head.head),
        root: head.root === undefined ? ZERO_HASH : toHex(head.root),
      };
    }),
    getEntries: os.board.getEntries.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const entries = await readEntries(
        context.sql,
        id,
        BigInt(input.start),
        Number(input.limit),
        MAX_PAGE_BYTES,
      ).catch((e: unknown) => boardError(e, errors.OUT_OF_RANGE));
      return { entries: entries.map(toHex) };
    }),
    getCheckpoints: os.board.getCheckpoints.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const checkpoints = await readLatestCheckpoints(
        context.sql,
        id,
        Number(input.limit),
        input.before === undefined ? undefined : BigInt(input.before),
      );
      return { checkpoints: checkpoints.map(toHex) };
    }),
    getInclusionProof: os.board.getInclusionProof.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const path = await readInclusionProof(
        context.sql,
        id,
        BigInt(input.index),
        BigInt(input.treeSize),
      ).catch((e: unknown) => boardError(e, errors.OUT_OF_RANGE));
      return { path: path.map(toHex) };
    }),
    getConsistencyProof: os.board.getConsistencyProof.handler(
      async ({ input, context, errors }) => {
        const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
        const path = await readConsistencyProof(
          context.sql,
          id,
          BigInt(input.firstSize),
          BigInt(input.secondSize),
        ).catch((e: unknown) => boardError(e, errors.OUT_OF_RANGE));
        return { path: path.map(toHex) };
      },
    ),
  },
  ballots: {
    // Admission is @abolishus/verifier's (5.1 to 5.4 against the registered
    // key set), through core, before anything is boarded (T-17, T-52, T-53),
    // and runs in the worker, in batches: this process verifies no proof
    // (T-52). Only an election this server holds is queued. A server without
    // the queue can't judge a ballot, so it boards none and fails closed.
    // Either way a refused voter can submit directly (T-25).
    submit: os.ballots.submit.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      if (context.ballots === undefined) throw errors.ELECTION_NOT_OPEN();
      const ballot = fromHex(input.ballot);
      const outcome = await context.ballots.submit(id, ballot);
      if (outcome.ok) {
        // The answer is read from the board, never taken on the worker's word.
        const boarded = await readBoardedEntry(context.sql, id, BigInt(outcome.index), ballot);
        if (boarded === undefined) throw new Error("the board doesn't carry the boarded ballot");
        return { entry: toHex(boarded.entry), link: toHex(boarded.link) };
      }
      switch (outcome.code) {
        case "unknown-election":
          throw errors.ELECTION_NOT_FOUND();
        case "not-open":
          throw errors.ELECTION_NOT_OPEN();
        case "rejected":
          throw errors.BALLOT_REJECTED({ data: { code: outcome.admission ?? "decode" } });
        case "unavailable":
          throw errors.BALLOTS_UNAVAILABLE();
      }
    }),
  },
  receipts: {
    // The board path for share receipts (docs/spec/delivery.md, Boarding):
    // judged in the worker by core's submitReceipt, which calls the
    // verifier's checks, never here (T-17, T-52). A server without the queue
    // boards none; the receipt still has the contract path (T-25).
    submit: os.receipts.submit.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      if (context.receipts === undefined) throw errors.ELECTION_NOT_OPEN();
      const record = fromHex(input.record);
      const outcome = await context.receipts.submit(id, record);
      if (outcome.ok) {
        // Read from the board, never taken on the worker's word: the entry
        // carries the bytes sent, or, for an earlier receipt, whatever the
        // board holds there, which the sender checks against its ballot.
        // An earlier entry must at least be a record of the type and
        // version sent (its 3-byte header), so a worker's wrong position
        // never hands the sender a ballot or another record as its receipt.
        const index = BigInt(outcome.index);
        let boarded;
        if (outcome.earlier) {
          const at = await readEntryAt(context.sql, id, index);
          const header = (b: Uint8Array) => Buffer.from(b.subarray(0, 3)).toString("hex");
          if (at !== undefined && header(at.payload) === header(record)) boarded = at;
        } else boarded = await readBoardedEntry(context.sql, id, index, record);
        if (boarded === undefined) throw new Error("the board doesn't carry the boarded receipt");
        return { entry: toHex(boarded.entry), link: toHex(boarded.link), earlier: outcome.earlier };
      }
      switch (outcome.code) {
        case "unknown-election":
          throw errors.ELECTION_NOT_FOUND();
        case "not-open":
          throw errors.ELECTION_NOT_OPEN();
        case "rejected":
          throw errors.RECEIPT_REJECTED({ data: { code: outcome.rejection ?? "decode" } });
        case "unavailable":
          throw errors.RECEIPTS_UNAVAILABLE();
      }
    }),
  },
  openings: {
    // The board path for tally openings (docs/spec/tally.md, Opening record,
    // Boarding): judged in the worker by core's OpeningBoardings over the
    // anchored counted set, which crypto's judge and the verifier's counted
    // set decide, never here (T-17, T-29, T-52). Only an election this
    // server holds is queued. A server without the queue boards none.
    submit: os.openings.submit.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      if (context.openings === undefined) throw errors.ELECTION_NOT_OPEN();
      const opening = fromHex(input.opening);
      const outcome = await context.openings.submit(id, opening);
      if (outcome.ok) {
        // Read from the board, never taken on the worker's word: the entry
        // carries the bytes sent or, for a resend of the same signed
        // message in other bytes, the opening boarded before, which must at
        // least be a record of the type and version sent (its 3-byte
        // header), and which the seat checks against its own.
        const index = BigInt(outcome.index);
        let boarded = await readBoardedEntry(context.sql, id, index, opening);
        let earlier = false;
        if (boarded === undefined) {
          const at = await readEntryAt(context.sql, id, index);
          const header = (b: Uint8Array) => Buffer.from(b.subarray(0, 3)).toString("hex");
          if (at !== undefined && header(at.payload) === header(opening)) {
            boarded = at;
            earlier = true;
          }
        }
        if (boarded === undefined) throw new Error("the board doesn't carry the boarded opening");
        return { entry: toHex(boarded.entry), link: toHex(boarded.link), earlier };
      }
      switch (outcome.code) {
        case "unknown-election":
          throw errors.ELECTION_NOT_FOUND();
        case "not-open":
          throw errors.ELECTION_NOT_OPEN();
        case "not-ready":
          throw errors.OPENING_NOT_READY();
        case "rejected":
          throw errors.OPENING_REJECTED({ data: { code: outcome.rejection ?? "decode" } });
        case "unavailable":
          throw errors.OPENINGS_UNAVAILABLE();
      }
    }),
  },
  destructions: {
    // The board path for destruction statements (docs/spec/tally.md,
    // Destruction, Boarding): judged in the worker by core's
    // DestructionBoardings, which crypto's judge decides, never here (T-17,
    // T-52). Only an election this server holds is queued. A server without
    // the queue boards none; the seat can still publish its signed statement
    // elsewhere (docs/spec/tally.md, Residuals).
    submit: os.destructions.submit.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      if (context.destructions === undefined) throw errors.ELECTION_NOT_OPEN();
      const statement = fromHex(input.statement);
      const outcome = await context.destructions.submit(id, statement);
      if (outcome.ok) {
        // Read from the board, never taken on the worker's word: the entry
        // carries the bytes sent or, for a resend of the seat's message in
        // other bytes, the statement boarded before, which must at least be
        // a record of the type and version sent (its 3-byte header), and
        // which the seat checks against its own.
        const index = BigInt(outcome.index);
        let boarded = await readBoardedEntry(context.sql, id, index, statement);
        let earlier = false;
        if (boarded === undefined) {
          const at = await readEntryAt(context.sql, id, index);
          const header = (b: Uint8Array) => Buffer.from(b.subarray(0, 3)).toString("hex");
          if (at !== undefined && header(at.payload) === header(statement)) {
            boarded = at;
            earlier = true;
          }
        }
        if (boarded === undefined) throw new Error("the board doesn't carry the boarded statement");
        return { entry: toHex(boarded.entry), link: toHex(boarded.link), earlier };
      }
      switch (outcome.code) {
        case "unknown-election":
          throw errors.ELECTION_NOT_FOUND();
        case "not-open":
          throw errors.ELECTION_NOT_OPEN();
        case "not-ready":
          throw errors.DESTRUCTION_NOT_READY();
        case "rejected":
          throw errors.DESTRUCTION_REJECTED({ data: { code: outcome.rejection ?? "decode" } });
        case "unavailable":
          throw errors.DESTRUCTIONS_UNAVAILABLE();
      }
    }),
  },

  postings: {
    // The posting relay (docs/spec/posting-relay.md, Answers): core checks
    // steps 2 to 7 in order. A server without the relay is unavailable once
    // the records' own checks pass, as the registration routes are.
    submit: os.postings.submit.handler(async ({ input, context, errors }) => {
      try {
        if (context.postings === undefined) {
          checkPostingRequest(input);
          throw new PostingRelayError("unavailable");
        }
        const { transaction, layer } = await context.postings.relay(input);
        return { transaction: toHex(transaction), layer };
      } catch (e) {
        if (!(e instanceof PostingRelayError)) throw e;
        switch (e.code) {
          case "form":
            // The pair's calldata over its bound: the contract's schema
            // checks each field alone, core the two together.
            throw new ORPCError("BAD_REQUEST");
          case "malformed":
            throw errors.POSTING_REFUSED({
              data: { code: "malformed", ...(e.malformed !== undefined && { check: e.malformed }) },
            });
          case "unknown-election":
          case "too-late":
            throw errors.POSTING_REFUSED({ data: { code: e.code } });
          case "refused":
            throw errors.POSTING_REFUSED({ data: { code: e.refusal ?? "refused" } });
          case "unavailable":
            throw errors.RELAY_UNAVAILABLE();
          case "busy":
            throw errors.RELAY_BUSY();
        }
      }
    }),
  },
  // The public moderation log, a poll's state, and reports
  // (docs/moderation-policy.md; T-68). Nothing here names a moderator or a
  // reporter, and a report reaches no one but the moderators' queue.
  moderation: {
    // Profiles' decisions name the public handle only, from the operational
    // log table; the API still reads no account table (T-10).
    getLog: os.moderation.getLog.handler(async ({ input, context }) => {
      const entries =
        input.before === undefined
          ? await readPublicModerationLog(
              context.sql,
              BigInt(input.after ?? "0"),
              Number(input.limit),
            )
          : await readPublicModerationLogBefore(
              context.sql,
              BigInt(input.before),
              Number(input.limit),
            );
      return {
        entries: entries.map((e) => {
          const common = { seq: e.seq.toString(), decidedAt: e.decidedAt.toISOString() };
          switch (e.target) {
            case "poll":
              return {
                ...common,
                electionId: toHex(e.electionId),
                action: e.action,
                reason: e.reason,
              };
            // What a refiling changed, never a place's words (T-17).
            case "refiling":
              return {
                ...common,
                electionId: toHex(e.electionId),
                action: "refile" as const,
                reason: e.reason,
                ...(e.topic === undefined ? {} : { topic: e.topic }),
                ...(e.place === undefined ? {} : { place: e.place }),
              };
            case "profile":
              return { ...common, handle: e.handle, action: e.action, reason: e.reason };
          }
        }),
      };
    }),
    // The same three log tables, counted in one snapshot.
    getCounts: os.moderation.getCounts.handler(async ({ context }) => {
      const counts = await readPublicModerationCounts(context.sql);
      return {
        delist: String(counts.delist),
        hide: String(counts.hide),
        hideProfile: String(counts.hideProfile),
        restore: String(counts.restore),
        refile: String(counts.refile),
        total: String(counts.total),
        ...(counts.since === undefined ? {} : { since: counts.since.toISOString() }),
      };
    }),
    getStatus: os.moderation.getStatus.handler(async ({ input, context, errors }) => {
      const id = await knownElection(context.sql, input.electionId, errors.ELECTION_NOT_FOUND);
      const { state, latest } = await moderationStatus(context.sql, id);
      if (latest === undefined) return { state };
      return {
        state,
        latest: {
          seq: latest.seq.toString(),
          action: latest.action,
          reason: latest.reason,
          decidedAt: latest.decidedAt.toISOString(),
        },
      };
    }),
    report: os.moderation.report.handler(async ({ input, context, errors }) => {
      await report(context.sql, fromHex(input.electionId), input.reason).catch((e: unknown) => {
        if (e instanceof ModerationError && e.code === "unknown-election")
          throw errors.ELECTION_NOT_FOUND();
        throw e;
      });
      return {};
    }),
  },
  // Identity backups (ADR 0017, option A, step 5): the envelope is stored,
  // served and deleted by locator, which core hashes before it reaches the
  // table. Like every route, these see no header, cookie or address (T-10).
  backups: {
    put: os.backups.put.handler(async ({ input, context, errors }) => {
      await putIdentityBackup(context.sql, fromHex(input.locator), fromHex(input.envelope)).catch(
        (e: unknown) => {
          if (e instanceof IdentityBackupStoreError)
            throw errors.BACKUP_REJECTED({ data: { code: e.code } });
          throw e;
        },
      );
      return {};
    }),
    fetch: os.backups.fetch.handler(async ({ input, context, errors }) => {
      const envelope = await readIdentityBackup(context.sql, fromHex(input.locator));
      if (envelope === undefined) throw errors.BACKUP_NOT_FOUND();
      return { envelope: toHex(envelope) };
    }),
    delete: os.backups.delete.handler(async ({ input, context, errors }) => {
      if (!(await deleteIdentityBackup(context.sql, fromHex(input.locator))))
        throw errors.BACKUP_NOT_FOUND();
      return {};
    }),
  },
  // Tier 0 registration (docs/spec/registration.md, Answers): core checks
  // steps 2 to 8 in order. Like every route this sees the body alone, never
  // a header, cookie or address, and no answer quotes the request (T-10,
  // T-11). A server without the service publishes no group, so after the
  // form checks it answers unavailable for every region.
  registrations: {
    tier0: os.registrations.tier0.handler(async ({ input, context, errors }) => {
      try {
        if (context.tier0 === undefined) {
          parseTier0Request(input);
          throw new Tier0RegistrationError("unavailable");
        }
        await context.tier0.register(input);
        return {};
      } catch (e) {
        if (!(e instanceof Tier0RegistrationError)) throw e;
        switch (e.code) {
          case "malformed":
            throw errors.REGISTRATION_MALFORMED({ data: { code: e.malformed ?? "malformed" } });
          case "region-unknown":
            throw errors.REGION_UNKNOWN();
          case "busy":
            throw errors.REGISTRATION_BUSY();
          case "unavailable":
            throw errors.REGISTRATION_UNAVAILABLE();
          case "challenge-refused":
            throw errors.CHALLENGE_REFUSED();
          case "challenge-unavailable":
            throw errors.CHALLENGE_UNAVAILABLE();
        }
      }
    }),
    // The Tier 1 relay (docs/spec/tier1-relay.md, Answers): core checks
    // steps 2 to 8 in order, and no answer depends on the commitment's
    // state (T-13, T-22). A server without the relay is unavailable once the
    // record's own checks pass, whatever its group, as Tier 0's route is.
    tier1: os.registrations.tier1.handler(async ({ input, context, errors }) => {
      try {
        if (context.tier1 === undefined) {
          parseTier1Request(input);
          throw new Tier1RelayError("unavailable");
        }
        await context.tier1.relay(input);
        return {};
      } catch (e) {
        if (!(e instanceof Tier1RelayError)) throw e;
        switch (e.code) {
          case "form":
            // The contract's schema refuses these first; core checks again.
            throw new ORPCError("BAD_REQUEST");
          case "malformed":
            throw errors.RELAY_MALFORMED({
              data: {
                code: e.malformed ?? "malformed",
                ...(e.vouch !== undefined && { vouch: e.vouch }),
              },
            });
          case "group-unknown":
            throw errors.GROUP_UNKNOWN();
          case "unavailable":
            throw errors.RELAY_UNAVAILABLE();
          case "vouch-window":
            throw errors.VOUCH_WINDOW();
          case "challenge-refused":
            throw errors.CHALLENGE_REFUSED();
          case "challenge-unavailable":
            throw errors.CHALLENGE_UNAVAILABLE();
          case "busy":
            throw errors.RELAY_BUSY();
        }
      }
    }),
  },
});
