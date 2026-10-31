// The profile page's report (`/by/<handle>`; [[0040-creator-profiles]]):
// `POST /profiles/report` on our own origin (src/node/profiles.ts). The
// front strips the session cookie from this one path, and the call sends no
// credentials either, so no account is ever joined to the profile it
// reported (T-10, T-11). Core counts the report per handle and ground, with
// nothing about who sent it.

import type { RemovalGround } from "./moderation-grounds.ts";

/** How a report ended. */
export type ReportOutcome =
  | "reported"
  /** No profile has the handle now: deleted since the page was read. */
  | "gone"
  /** Anything else: nothing was counted, or it can't be told. */
  | "failed";

/** Reports the profile at `handle` under `reason`. Never throws. */
export type ReportProfile = (handle: string, reason: RemovalGround) => Promise<ReportOutcome>;

export const reportProfile: ReportProfile = async (handle, reason) => {
  let response: Response;
  try {
    response = await fetch("/profiles/report", {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, reason }),
    });
  } catch {
    return "failed";
  }
  if (response.ok) return "reported";
  if (response.status === 404) {
    const body: unknown = await response.json().catch(() => undefined);
    if ((body as { code?: unknown } | undefined)?.code === "UNKNOWN_PROFILE") return "gone";
  }
  return "failed";
};
