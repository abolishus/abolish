// An author's poll drafts, under /drafts on apps/web's origin
// ([[0032-poll-creation-operations]]; P2-22 part 2). The routes need the
// account session, and the account system lives here: the API refuses every
// account credential, so nothing that names an account reaches it (T-10,
// ADR 0017). This transport parses, asks core and serialises; the rules are
// packages/core's (src/poll-drafts.ts, src/appeals.ts).
//
// A creator also sees their poll's moderation and appeals its newest removal
// here (docs/moderation-policy.md, Appeals; P2-10 part 3b-2): an appeal names
// its creator's account, so it is filed where accounts are, never through
// the API (T-10, T-68). The answer carries the public state and decisions,
// never a moderator.
//
// A poll that failed in setup carries its failure's code, which the page
// words (`pollFailure_<code>`, src/messages.ts), and whether the author can
// retry it (back to a draft, to edit and submit again) or discard it
// (ADR 0032, rule 14; P2-22 part 5d-2). An open poll carries its election's
// identifier, so the author's pages link to the poll's public page (part 6d);
// a poll in setup carries none, as the website names no step's hash (T-34).
// `answered` says how many have answered each of the account's open polls so
// far, one count per tier its draft opened it to, as the API serves the count
// to anyone and the poll's page shows it (P2-19 part 57), all in one read of
// the API (part 58; T-52). The API is asked by election IDs alone, from this
// server, so it learns nothing of the account (T-10); the count is the API's
// claim, as on every page that shows it.
//
// T-10, T-11, T-67: a request's session names its account and nothing else
// is read from it; answers are no-store, and the request log keeps only the
// route class. CSRF: the session cookie is SameSite=Strict, and every POST
// must also carry our own Origin. T-52, T-72: bodies are bounded by the
// front, and every limit is core's.

import {
  type AccountPoll,
  AppealError,
  type AppealErrorCode,
  createPollDraft,
  deletePollDraft,
  discardFailedPoll,
  fileAppeal,
  listAccountPolls,
  type PollDraft,
  PollDraftError,
  type PollDraftErrorCode,
  type PollModeration,
  type PollTopic,
  readAccountPoll,
  readPollModeration,
  retryableFailure,
  retryFailedPoll,
  submitPollDraft,
  type Turnstile,
  TURNSTILE_HEADER,
  updatePollDraft,
} from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

import { toHex } from "../values.ts";

/** Every drafts route: `METHOD /path`. Anything else is answered 404. */
export const DRAFT_ROUTES = [
  "GET /drafts",
  "POST /drafts/create",
  "POST /drafts/read",
  "POST /drafts/update",
  "POST /drafts/delete",
  "POST /drafts/submit",
  "POST /drafts/retry",
  "POST /drafts/discard",
  "POST /drafts/moderation",
  "POST /drafts/appeal",
  "POST /drafts/answered",
] as const;

const ROUTES: ReadonlySet<string> = new Set(DRAFT_ROUTES);

export interface DraftsOptions {
  readonly sql: Sql;
  /** The signed-in account behind a request's cookies (`Accounts.accountOf`). */
  readonly accountOf: (headers: Headers) => Promise<string | undefined>;
  /** Checks the `poll-create` token a submission carries in `TURNSTILE_HEADER`. */
  readonly turnstile: Turnstile;
  /** apps/web's origin: every POST must come from it. */
  readonly origin: string;
  /** The clock; the system's by default. Injected so tests can set it. */
  readonly now?: () => Date;
  /**
   * How many the API says have answered each of `electionIds` (1 to 100
   * distinct, lowercase hex) so far, tier by tier, as `POST
   * /elections/answered` serves them, an election it doesn't know left out;
   * rejects when the API can't say. None to answer every count unavailable.
   */
  readonly answered?: (electionIds: readonly string[]) => Promise<readonly ServedElection[]>;
}

/** One tier's count as `GET /elections/answered` serves it: a decimal `u64`. */
export interface ServedCount {
  readonly tier: number;
  readonly answered: string;
}

/** One election's counts as `POST /elections/answered` serves them. */
export interface ServedElection {
  readonly electionId: string;
  readonly tiers: readonly ServedCount[];
}

// Transport bounds only, at the codec's own field limits
// (docs/spec/display-text.md, Layout (version 2)): what a draft means, and
// whether it is acceptable, is core's (T-31).
const DraftOption = z.strictObject({
  label: z.string().max(512),
  description: z.string().max(1024),
});
const Count = z.int().min(0).max(0xffff);
const DraftQuestion = z.strictObject({
  question: z.string().max(1024),
  description: z.string().max(8192),
  options: z.array(DraftOption).max(64),
  minSelections: Count,
  maxSelections: Count,
});
const Draft = z.strictObject({
  language: z.string().max(35),
  title: z.string().max(1024),
  description: z.string().max(8192),
  questions: z.array(DraftQuestion).max(32),
  tiers: z.array(z.int().min(0).max(255)).max(3),
  /** UNIX seconds, as a canonical decimal `u64`. */
  closesAt: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/),
  // Above the longest topic code, and a place's `MAX_PLACE_LENGTH` code
  // points as UTF-16 (ADR 0041).
  topic: z.string().max(16).optional(),
  place: z.string().max(160).optional(),
});
const PollId = z.string().regex(/^[a-z0-9]{32}$/);

const Inputs = {
  "POST /drafts/create": z.strictObject({ draft: Draft }),
  "POST /drafts/read": z.strictObject({ id: PollId }),
  "POST /drafts/update": z.strictObject({ id: PollId, draft: Draft }),
  "POST /drafts/delete": z.strictObject({ id: PollId }),
  "POST /drafts/submit": z.strictObject({ id: PollId }),
  "POST /drafts/retry": z.strictObject({ id: PollId }),
  "POST /drafts/discard": z.strictObject({ id: PollId }),
  "POST /drafts/moderation": z.strictObject({ id: PollId }),
  "POST /drafts/appeal": z.strictObject({ id: PollId }),
  "POST /drafts/answered": z.strictObject({}),
} as const;

const toDraft = ({ topic, place, ...d }: z.infer<typeof Draft>): PollDraft => ({
  ...d,
  closesAt: BigInt(d.closesAt),
  // Core refuses a topic outside `POLL_TOPICS` (`topic`).
  ...(topic === undefined ? {} : { topic: topic as PollTopic }),
  ...(place === undefined ? {} : { place }),
});

const fromDraft = (d: PollDraft) => ({ ...d, closesAt: d.closesAt.toString() });

const summary = (p: AccountPoll) => ({
  id: p.id,
  state: p.state,
  title: p.draft.title,
  closesAt: p.draft.closesAt.toString(),
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  ...(p.submittedAt === undefined ? {} : { submittedAt: p.submittedAt.toISOString() }),
  ...(p.failure === undefined
    ? {}
    : { failure: p.failure, retryable: retryableFailure(p.failure) }),
  ...(p.state === "open" && p.electionId !== undefined ? { electionId: toHex(p.electionId) } : {}),
});

// Sequence numbers are Postgres `bigint`s, so decimal strings, as the API's log.
const moderation = (m: PollModeration) => ({
  state: m.state,
  ...(m.latest === undefined
    ? {}
    : {
        latest: {
          seq: m.latest.seq.toString(),
          action: m.latest.action,
          reason: m.latest.reason,
          decidedAt: m.latest.decidedAt.toISOString(),
        },
      }),
  appealable: m.appealable,
  appeals: m.appeals.map((a) => ({
    decisionSeq: a.decisionSeq.toString(),
    filedAt: a.filedAt.toISOString(),
    ...(a.outcome === undefined ? {} : { outcome: a.outcome }),
    ...(a.reviewedAt === undefined ? {} : { reviewedAt: a.reviewedAt.toISOString() }),
  })),
});

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string, extra: object = {}) =>
  answer(status, { code, status, ...extra });

const ERRORS: Record<PollDraftErrorCode, [number, string]> = {
  "not-found": [404, "NOT_FOUND"],
  "not-editable": [409, "NOT_EDITABLE"],
  "not-failed": [409, "NOT_FAILED"],
  registered: [409, "REGISTERED"],
  refused: [422, "DRAFT_REFUSED"],
  "too-many-drafts": [429, "TOO_MANY_DRAFTS"],
  "too-many-in-setup": [429, "TOO_MANY_IN_SETUP"],
  "too-many-today": [429, "TOO_MANY_TODAY"],
  "challenge-refused": [403, "TURNSTILE_REFUSED"],
  "challenge-unavailable": [503, "TURNSTILE_UNAVAILABLE"],
};

// `fileAppeal` and `readPollModeration` can refuse only these, given a
// signed-in account and an ID the schema took.
const APPEAL_ERRORS: Partial<Record<AppealErrorCode, [number, string]>> = {
  "not-found": [404, "NOT_FOUND"],
  "not-appealable": [409, "NOT_APPEALABLE"],
  "already-appealed": [409, "ALREADY_APPEALED"],
};

/** The drafts handler: answers every route in `DRAFT_ROUTES` for the signed-in account. */
export function createDraftsHandler({
  sql,
  accountOf,
  turnstile,
  origin,
  now = () => new Date(),
  answered,
}: DraftsOptions): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route) || url.search !== "") return refuse(404, "NOT_FOUND");
    if (request.method === "POST") {
      // A browser sends Origin on every POST; another site's form or script can't send ours.
      if (request.headers.get("origin") !== origin) return refuse(403, "FORBIDDEN_ORIGIN");
      if (request.headers.get("content-type") !== "application/json")
        return refuse(415, "UNSUPPORTED_MEDIA_TYPE");
    }
    const account = await accountOf(request.headers);
    if (account === undefined) return refuse(401, "SIGNED_OUT");
    if (route === "GET /drafts")
      return answer(200, { polls: (await listAccountPolls(sql, account)).map(summary) });

    let body: unknown;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return refuse(400, "BAD_REQUEST");
    }
    try {
      switch (route) {
        case "POST /drafts/create": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const id = await createPollDraft(sql, account, toDraft(input.data.draft), now());
          return answer(201, { id });
        }
        case "POST /drafts/read": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const poll = await readAccountPoll(sql, account, input.data.id);
          if (poll === undefined) return refuse(404, "NOT_FOUND");
          return answer(200, { ...summary(poll), draft: fromDraft(poll.draft) });
        }
        case "POST /drafts/update": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await updatePollDraft(sql, account, input.data.id, toDraft(input.data.draft), now());
          return answer(200, {});
        }
        case "POST /drafts/delete": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await deletePollDraft(sql, account, input.data.id);
          return answer(200, {});
        }
        case "POST /drafts/submit": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await submitPollDraft(sql, account, input.data.id, {
            turnstile,
            token: request.headers.get(TURNSTILE_HEADER),
            now: now(),
          });
          return answer(202, {});
        }
        case "POST /drafts/retry": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await retryFailedPoll(sql, account, input.data.id, now());
          return answer(200, {});
        }
        case "POST /drafts/discard": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          await discardFailedPoll(sql, account, input.data.id);
          return answer(200, {});
        }
        case "POST /drafts/moderation": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const m = await readPollModeration(sql, account, input.data.id);
          if (m === undefined) return refuse(404, "NOT_FOUND");
          return answer(200, moderation(m));
        }
        case "POST /drafts/answered": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          // Only an open poll has an election the website names (T-34). The
          // list holds at most core's MAX_LISTED_POLLS, which is as many as
          // the API reads at once.
          const open = (await listAccountPolls(sql, account)).flatMap((poll) =>
            poll.state === "open" && poll.electionId !== undefined
              ? [{ poll, electionId: toHex(poll.electionId) }]
              : [],
          );
          if (open.length === 0) return answer(200, { polls: [] });
          if (answered === undefined) return refuse(503, "UNAVAILABLE");
          let served: readonly ServedElection[];
          try {
            served = await answered(open.map((p) => p.electionId));
          } catch {
            return refuse(503, "UNAVAILABLE");
          }
          const byElection = new Map(served.map((e) => [e.electionId, e.tiers]));
          return answer(200, {
            // A poll the API doesn't know is left out, as a failed read shows
            // nothing, never a zero. The rest are placed on the tiers the
            // poll was opened to, as the definition built from its draft
            // names them, a tier with none served at 0; a count for any other
            // tier is left out, as `cardAnswered` leaves it (T-01).
            polls: open.flatMap(({ poll, electionId }) => {
              const tiers = byElection.get(electionId);
              if (tiers === undefined) return [];
              return [
                {
                  id: poll.id,
                  tiers: poll.draft.tiers.map((tier) => ({
                    tier,
                    answered: tiers.find((count) => count.tier === tier)?.answered ?? "0",
                  })),
                },
              ];
            }),
          });
        }
        case "POST /drafts/appeal": {
          const input = Inputs[route].safeParse(body);
          if (!input.success) return refuse(400, "BAD_REQUEST");
          const seq = await fileAppeal(sql, account, input.data.id);
          return answer(201, { decisionSeq: seq.toString() });
        }
      }
      return refuse(404, "NOT_FOUND");
    } catch (e) {
      if (e instanceof AppealError) {
        const known = APPEAL_ERRORS[e.code];
        if (known === undefined) throw e;
        return refuse(known[0], known[1]);
      }
      if (!(e instanceof PollDraftError)) throw e;
      const [status, code] = ERRORS[e.code];
      return refuse(status, code, e.problem === undefined ? {} : { problem: e.problem });
    }
  };
}
