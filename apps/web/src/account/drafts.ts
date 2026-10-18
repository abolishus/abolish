// The account pages' calls to the drafts handler on our own origin
// (src/node/drafts.ts, /drafts): the author's polls, writing and editing a
// draft, and what they can do with a draft or a poll that failed in setup
// (ADR 0032, rule 14). The
// session cookie goes only because the call is same-origin, as the account
// client's does (src/account/client.ts); the handler names the account
// from it, and nothing here names one (T-10).

import type { PollState } from "@abolishus/core";
import type { DraftQuestion, PollDraft } from "@abolishus/core/poll-draft-rules";
import { type PollFailure, POLL_FAILURES } from "@abolishus/core/poll-failures";

// Every state core's table admits (`satisfies` keeps this list core's).
const STATES: ReadonlySet<string> = new Set([
  "drafted",
  "submitted",
  "created",
  "rooted",
  "ceremony",
  "registered",
  "open",
  "failed",
] as const satisfies readonly PollState[]);
const FAILURES: ReadonlySet<string> = new Set(POLL_FAILURES);

/** One of the author's polls, as much of it as the list shows. */
export interface PollSummary {
  readonly id: string;
  readonly state: PollState;
  /** The draft's title, as the author wrote it; possibly empty. */
  readonly title: string;
  /** UNIX seconds. */
  readonly closesAt: bigint;
  /** ISO 8601. */
  readonly updatedAt: string;
  /** ISO 8601; none for a draft. */
  readonly submittedAt: string | undefined;
  /** Why setup failed, for a `failed` poll. */
  readonly failure: PollFailure | undefined;
  /** Whether a failed poll can go back to a draft or be discarded. */
  readonly retryable: boolean;
}

/** Why a drafts action didn't happen. */
export type DraftsFailure =
  /** The session ended: sign in again. */
  | "signedOut"
  /** No such poll: another tab deleted or discarded it. */
  | "gone"
  /** The poll moved on since the list was read (submitted, retried, opened). */
  | "changed"
  /** Its election is registered on chain, so it stays. */
  | "registered"
  /** The account holds as many drafts as it may. */
  | "tooManyDrafts"
  /** The handler found the draft breaks one of the definition's rules. */
  | "refused"
  /** The server refused or failed, or the network did. */
  | "failed";

export class DraftsError extends Error {
  readonly failure: DraftsFailure;
  constructor(failure: DraftsFailure) {
    super(`drafts action ${failure}`);
    this.name = "DraftsError";
    this.failure = failure;
  }
}

/** One of the author's polls with its draft, as the form edits it. */
export interface PollWithDraft {
  readonly summary: PollSummary;
  readonly draft: PollDraft;
}

/** Every call the pages make, so they can be shown with stand-ins (stories, tests). */
export interface DraftsClient {
  /** The account's polls, newest first. */
  list(): Promise<readonly PollSummary[]>;
  /** Deletes a draft. */
  remove(id: string): Promise<void>;
  /** Returns a failed poll to its draft, to edit and submit again. */
  retry(id: string): Promise<void>;
  /** Deletes a failed poll. */
  discard(id: string): Promise<void>;
  /** One poll and its draft. */
  read(id: string): Promise<PollWithDraft>;
  /** Saves a new draft, returning its poll's ID. */
  create(draft: PollDraft): Promise<string>;
  /** Replaces a draft, which must still be one. */
  update(id: string, draft: PollDraft): Promise<void>;
}

// The handler's refusal codes (src/node/drafts.ts), as the page tells them.
const REFUSALS: Readonly<Record<string, DraftsFailure>> = {
  SIGNED_OUT: "signedOut",
  NOT_FOUND: "gone",
  NOT_EDITABLE: "changed",
  NOT_FAILED: "changed",
  REGISTERED: "registered",
  TOO_MANY_DRAFTS: "tooManyDrafts",
  DRAFT_REFUSED: "refused",
};

async function call(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`/drafts${path}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    // Exactly this type, with no charset: the handler refuses anything else.
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  }).catch(() => {
    throw new DraftsError("failed");
  });
  const answer: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code =
      typeof answer === "object" && answer !== null
        ? (answer as Record<string, unknown>).code
        : undefined;
    throw new DraftsError((typeof code === "string" && REFUSALS[code]) || "failed");
  }
  if (answer === undefined) throw new DraftsError("failed");
  return answer;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;

function summary(value: unknown): PollSummary {
  if (typeof value !== "object" || value === null) throw new DraftsError("failed");
  const { id, state, title, closesAt, updatedAt, submittedAt, failure, retryable } =
    value as Record<string, unknown>;
  if (
    typeof id !== "string" ||
    typeof state !== "string" ||
    !STATES.has(state) ||
    typeof title !== "string" ||
    typeof closesAt !== "string" ||
    !U64.test(closesAt) ||
    typeof updatedAt !== "string" ||
    !ISO.test(updatedAt) ||
    (submittedAt !== undefined && (typeof submittedAt !== "string" || !ISO.test(submittedAt)))
  )
    throw new DraftsError("failed");
  // A failed poll carries its code and whether it can be retried; no other does.
  if (state === "failed") {
    if (typeof failure !== "string" || !FAILURES.has(failure) || typeof retryable !== "boolean")
      throw new DraftsError("failed");
  } else if (failure !== undefined || retryable !== undefined) throw new DraftsError("failed");
  return {
    id,
    state: state as PollState,
    title,
    closesAt: BigInt(closesAt),
    updatedAt,
    submittedAt,
    failure: failure as PollFailure | undefined,
    retryable: retryable === true,
  };
}

const ID = /^[a-z0-9]{32}$/;

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DraftsError("failed");
  return value as Record<string, unknown>;
};

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new DraftsError("failed");
  return value;
};

const count = (value: unknown): number => {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffff)
    throw new DraftsError("failed");
  return value as number;
};

const array = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new DraftsError("failed");
  return value;
};

/**
 * A stored draft as the handler answers it, field for field. Whether it
 * keeps the definition's rules is the form's check, as for any draft; this
 * only refuses an answer that isn't a draft at all.
 */
function draftOf(value: unknown): PollDraft {
  const d = record(value);
  if (typeof d.closesAt !== "string" || !U64.test(d.closesAt)) throw new DraftsError("failed");
  return {
    language: text(d.language),
    title: text(d.title),
    description: text(d.description),
    questions: array(d.questions).map((v): DraftQuestion => {
      const q = record(v);
      return {
        question: text(q.question),
        description: text(q.description),
        options: array(q.options).map((w) => {
          const o = record(w);
          return { label: text(o.label), description: text(o.description) };
        }),
        minSelections: count(q.minSelections),
        maxSelections: count(q.maxSelections),
      };
    }),
    tiers: array(d.tiers).map((t) => {
      if (!Number.isInteger(t) || (t as number) < 0 || (t as number) > 255)
        throw new DraftsError("failed");
      return t as number;
    }),
    closesAt: BigInt(d.closesAt),
  };
}

// The handler's own wire form: `closesAt` a decimal string.
const wire = (d: PollDraft) => ({ ...d, closesAt: d.closesAt.toString() });

/** The client for this origin's drafts handler. */
export const draftsClient: DraftsClient = {
  async list() {
    const answer = await call("");
    const polls =
      typeof answer === "object" && answer !== null
        ? (answer as Record<string, unknown>).polls
        : undefined;
    if (!Array.isArray(polls)) throw new DraftsError("failed");
    return polls.map(summary);
  },
  async remove(id) {
    await call("/delete", { id });
  },
  async retry(id) {
    await call("/retry", { id });
  },
  async discard(id) {
    await call("/discard", { id });
  },
  async read(id) {
    const answer = record(await call("/read", { id }));
    const { draft, ...rest } = answer;
    const read = { summary: summary(rest), draft: draftOf(draft) };
    // The handler answers the poll asked for; anything else is not this page's.
    if (read.summary.id !== id) throw new DraftsError("failed");
    return read;
  },
  async create(draft) {
    const { id } = record(await call("/create", { draft: wire(draft) }));
    if (typeof id !== "string" || !ID.test(id)) throw new DraftsError("failed");
    return id;
  },
  async update(id, draft) {
    await call("/update", { id, draft: wire(draft) });
  },
};
