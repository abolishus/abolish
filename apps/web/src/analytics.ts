// What apps/web tells PostHog, decided in one place for the browser and the
// server: which page was viewed, from a fixed list of templates, and where
// our own code failed, by error name and bundle position. Never a poll ID, a
// path, a query, an error message, an account or anything that follows a
// visitor from one event to the next (T-67, T-10, T-11).

/** Every page, as a template: a poll page is `/polls/:id`, never its ID. */
export const PAGES = [
  "/",
  "/discover",
  "/polls",
  "/polls/:id",
  "/polls/:id/board",
  "/polls/:id/results",
  "/p/:code",
  "/p/:code/flyer",
  "/embed/p/:code",
  "/by/:handle",
  "/moderation",
  "/account",
  "/account/polls/:id",
  "/account/polls/:id/setup",
  "/account/verify",
  "/how-it-works",
  "/verify",
  "other",
] as const;

export type Page = (typeof PAGES)[number];

/** The template for `pathname`; anything not a known page is `other`. */
export function pageOf(pathname: string): Page {
  if (pathname === "/" || pathname === "/polls" || pathname === "/moderation") return pathname;
  if (pathname === "/account" || pathname === "/account/verify" || pathname === "/how-it-works")
    return pathname;
  if (pathname === "/verify") return pathname;
  // Its order and page are in the query, never kept.
  if (pathname === "/discover") return pathname;
  // Any single segment: a malformed ID is still a poll page's 404, and the
  // segment itself is never kept.
  if (/^\/polls\/[^/]+$/.test(pathname)) return "/polls/:id";
  // Its board's pages: the entry a page starts at is in the query, never kept.
  if (/^\/polls\/[^/]+\/board$/.test(pathname)) return "/polls/:id/board";
  if (/^\/polls\/[^/]+\/results$/.test(pathname)) return "/polls/:id/results";
  // An author's draft (or `new`): its ID is the account's, never kept (T-10).
  if (/^\/account\/polls\/[^/]+$/.test(pathname)) return "/account/polls/:id";
  if (/^\/account\/polls\/[^/]+\/setup$/.test(pathname)) return "/account/polls/:id/setup";
  // A short link, in either case (a QR code carries `/P/<CODE>`): the code
  // names a poll as surely as its ID does, so it is never kept either.
  if (/^\/[pP]\/[^/]+$/.test(pathname)) return "/p/:code";
  // Its flyer: the paper and ink are in the query, never kept.
  if (/^\/p\/[^/]+\/flyer$/i.test(pathname)) return "/p/:code/flyer";
  // Its embed, loaded by every reader of a page that carries it: the code
  // and the theme are never kept, nor which site it was on (T-11).
  if (/^\/embed\/p\/[^/]+$/i.test(pathname)) return "/embed/p/:code";
  // A creator's profile: the handle names it as surely as a code names a
  // poll, so it is never kept ([[0040-creator-profiles]]).
  if (/^\/by\/[^/]+$/.test(pathname)) return "/by/:handle";
  return "other";
}

/**
 * An error's name as JavaScript gives it (`TypeError`, `ORPCError`): an
 * identifier, never its message, and too short to hold a poll ID.
 */
export const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/;

/**
 * A position in one of our bundles, `assets/<name>.js:<line>:<column>`.
 * A bundle's name is its module's (a route's, say, which is no more than the
 * page's template) and a content hash, so a frame says where our code failed
 * and nothing about what it was showing. The front accepts only names of
 * bundles it serves (src/node/serve.ts).
 */
export const FRAME = /^assets\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js:[0-9]{1,7}:[0-9]{1,7}$/;

/** Most frames kept from one stack. */
export const MAX_FRAMES = 20;

/** A failure in the browser, as reported to `/ingest/error`. */
export interface ClientError {
  readonly page: Page;
  readonly name: string;
  readonly frames: readonly string[];
}

/**
 * The frames of `stack` that are positions in our bundles on `origin`,
 * innermost first. Everything else in it (other scripts' URLs, an
 * extension's own `assets/`, function names) is dropped: a frame elsewhere
 * names nothing we can fix. The caller removes the message first
 * (src/error-reports.ts), since a message can quote what the page held.
 */
export function framesOf(stack: string, origin: string): string[] {
  const frames: string[] = [];
  const at = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const match of stack.matchAll(
    new RegExp(
      `(?<![^\\s(@])${at}\\/(assets\\/[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*\\.js:[0-9]{1,7}:[0-9]{1,7})(?![0-9])`,
      "g",
    ),
  )) {
    frames.push(match[1]!);
    if (frames.length === MAX_FRAMES) break;
  }
  return frames;
}

/** `value` as a `ClientError`, or undefined if it is anything else: no extra keys, no other values. */
export function parseClientError(value: unknown): ClientError | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !["page", "name", "frames"].every((k) => keys.includes(k)))
    return undefined;
  const { page, name, frames } = value as Record<string, unknown>;
  if (!(PAGES as readonly unknown[]).includes(page)) return undefined;
  if (typeof name !== "string" || !ERROR_NAME.test(name)) return undefined;
  if (!Array.isArray(frames) || frames.length > MAX_FRAMES) return undefined;
  if (!frames.every((f) => typeof f === "string" && FRAME.test(f))) return undefined;
  return { page: page as Page, name, frames: frames as string[] };
}
