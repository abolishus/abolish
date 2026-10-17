// An author's poll drafts, under /drafts on apps/web's origin
// ([[0032-poll-creation-operations]]; P2-22 part 2). The routes need the
// account session, and the account system lives here: the API refuses every
// account credential, so nothing that names an account reaches it (T-10,
// ADR 0017). This transport parses, asks core and serialises; the rules are
// packages/core's (src/poll-drafts.ts).
//
// T-10, T-11, T-67: a request's session names its account and nothing else
// is read from it; answers are no-store, and the request log keeps only the
// route class. CSRF: the session cookie is SameSite=Strict, and every POST
// must also carry our own Origin. T-52, T-72: bodies are bounded by the
// front, and every limit is core's.

import {
  type AccountPoll,
  createPollDraft,
  deletePollDraft,
  listAccountPolls,
  type PollDraft,
  PollDraftError,
  type PollDraftErrorCode,
  readAccountPoll,
  submitPollDraft,
  type Turnstile,
  TURNSTILE_HEADER,
  updatePollDraft,
} from "@abolishus/core";
import type { Sql } from "postgres";
import * as z from "zod";

/** Every drafts route: `METHOD /path`. Anything else is answered 404. */
export const DRAFT_ROUTES = [
  "GET /drafts",
  "POST /drafts/create",
  "POST /drafts/read",
  "POST /drafts/update",
  "POST /drafts/delete",
  "POST /drafts/submit",
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
});
const PollId = z.string().regex(/^[a-z0-9]{32}$/);

const Inputs = {
  "POST /drafts/create": z.strictObject({ draft: Draft }),
  "POST /drafts/read": z.strictObject({ id: PollId }),
  "POST /drafts/update": z.strictObject({ id: PollId, draft: Draft }),
  "POST /drafts/delete": z.strictObject({ id: PollId }),
  "POST /drafts/submit": z.strictObject({ id: PollId }),
} as const;

const toDraft = (d: z.infer<typeof Draft>): PollDraft => ({ ...d, closesAt: BigInt(d.closesAt) });

const fromDraft = (d: PollDraft) => ({ ...d, closesAt: d.closesAt.toString() });

const summary = (p: AccountPoll) => ({
  id: p.id,
  state: p.state,
  title: p.draft.title,
  closesAt: p.draft.closesAt.toString(),
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
  ...(p.submittedAt === undefined ? {} : { submittedAt: p.submittedAt.toISOString() }),
});

const answer = (status: number, body: object) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const refuse = (status: number, code: string, extra: object = {}) =>
  answer(status, { code, status, ...extra });

const ERRORS: Record<PollDraftErrorCode, [number, string]> = {
  "not-found": [404, "NOT_FOUND"],
  "not-editable": [409, "NOT_EDITABLE"],
  refused: [422, "DRAFT_REFUSED"],
  "too-many-drafts": [429, "TOO_MANY_DRAFTS"],
  "too-many-in-setup": [429, "TOO_MANY_IN_SETUP"],
  "too-many-today": [429, "TOO_MANY_TODAY"],
  "challenge-refused": [403, "TURNSTILE_REFUSED"],
  "challenge-unavailable": [503, "TURNSTILE_UNAVAILABLE"],
};

/** The drafts handler: answers every route in `DRAFT_ROUTES` for the signed-in account. */
export function createDraftsHandler({
  sql,
  accountOf,
  turnstile,
  origin,
  now = () => new Date(),
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
      }
      return refuse(404, "NOT_FOUND");
    } catch (e) {
      if (!(e instanceof PollDraftError)) throw e;
      const [status, code] = ERRORS[e.code];
      return refuse(status, code, e.problem === undefined ? {} : { problem: e.problem });
    }
  };
}
