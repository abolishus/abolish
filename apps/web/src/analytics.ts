// What apps/web tells PostHog, decided in one place for the browser and the
// server: which page was viewed, from a fixed list of templates, and where
// our own code failed, by error name and bundle position. Never a poll ID, a
// path, a query, an error message, an account or anything that follows a
// visitor from one event to the next (T-67, T-10, T-11).

/** Every page, as a template: a poll page is `/polls/:id`, never its ID. */
export const PAGES = ["/", "/polls", "/polls/:id", "/moderation", "/account", "other"] as const;

export type Page = (typeof PAGES)[number];

/** The template for `pathname`; anything not a known page is `other`. */
export function pageOf(pathname: string): Page {
  if (pathname === "/" || pathname === "/polls" || pathname === "/moderation") return pathname;
  if (pathname === "/account") return pathname;
  // Any single segment: a malformed ID is still a poll page's 404, and the
  // segment itself is never kept.
  if (/^\/polls\/[^/]+$/.test(pathname)) return "/polls/:id";
  return "other";
}

/** An error's name as JavaScript gives it (`TypeError`, `ORPCError`): an identifier, never its message. */
export const ERROR_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/**
 * A position in one of our hashed bundles, `assets/<name>.js:<line>:<column>`.
 * Bundle names carry only a content hash, so a frame says where our code
 * failed and nothing about what it was showing.
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
 * The frames of `stack` that are positions in our bundles, innermost first.
 * Everything else in it (the message, other scripts' URLs, function names)
 * is dropped: a message can quote what the page held, and a frame in another
 * script names nothing we can fix.
 */
export function framesOf(stack: string): string[] {
  const frames: string[] = [];
  for (const match of stack.matchAll(
    /\/(assets\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.js:[0-9]{1,7}:[0-9]{1,7})(?![0-9])/g,
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
