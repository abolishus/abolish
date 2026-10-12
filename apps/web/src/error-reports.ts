// Error tracking in the browser, with no third-party code (T-55): an
// uncaught error or rejection, or one the router caught and showed as the
// error page, whose stack passes through one of our bundles is reported to
// /ingest/error on our own origin as its name, the page's template and its
// frames in our bundles. Its message, the page's path and anything else on
// the stack never leave the page (T-67).

import { type ClientError, ERROR_NAME, framesOf, pageOf } from "./analytics.ts";

/** Most reports one page load sends: a failing loop shouldn't become a flood. */
export const MAX_REPORTS = 5;

/** What reporting needs of `window`. */
export interface ReportingWindow {
  addEventListener(type: "error" | "unhandledrejection", listener: (event: Event) => void): void;
  removeEventListener(type: "error" | "unhandledrejection", listener: (event: Event) => void): void;
  readonly location: { readonly origin: string; readonly pathname: string };
}

export type Send = (report: ClientError) => Promise<void>;

/** Posts `report` to our own origin, with no cookie, following no redirect. */
export const sendReport: Send = async (report) => {
  await fetch("/ingest/error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    credentials: "omit",
    redirect: "error",
    keepalive: true,
  });
};

/** The report for `thrown` on `location`, or undefined if our code isn't on its stack. */
export function reportOf(
  thrown: unknown,
  location: ReportingWindow["location"],
): ClientError | undefined {
  if (!(thrown instanceof Error) || typeof thrown.stack !== "string") return undefined;
  // Chromium's stack opens with the error as text, message included, and a
  // message can quote anything, a frame-shaped string too: only what follows
  // it is read. Firefox's stack holds frames alone.
  let stack = thrown.stack;
  try {
    const head = String(thrown);
    if (stack.startsWith(head)) stack = stack.slice(head.length);
  } catch {
    return undefined;
  }
  // An error raised only in a browser extension or the browser itself has no
  // frame of ours, and nothing we could fix.
  const frames = framesOf(stack, location.origin);
  if (frames.length === 0) return undefined;
  return {
    page: pageOf(location.pathname),
    name: ERROR_NAME.test(thrown.name) ? thrown.name : "Error",
    frames,
  };
}

/** The installed reporter, for errors the router catches before `window` sees them. */
let active: ((thrown: unknown) => void) | undefined;

/** Reports an error the router caught (the error page), if reporting is installed. */
export function reportCaught(thrown: unknown): void {
  active?.(thrown);
}

/** Reports `target`'s uncaught errors, and caught ones, until the returned function is called. */
export function reportErrors(target: ReportingWindow, send: Send = sendReport): () => void {
  let sent = 0;
  const report = (thrown: unknown) => {
    if (sent >= MAX_REPORTS) return;
    const r = reportOf(thrown, target.location);
    if (r === undefined) return;
    sent++;
    // Reporting must never raise an error of its own.
    send(r).catch(() => {});
  };
  const onError = (event: Event) => report((event as ErrorEvent).error);
  const onRejection = (event: Event) => report((event as PromiseRejectionEvent).reason);
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  active = report;
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    if (active === report) active = undefined;
  };
}
