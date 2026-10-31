// The moderation policy's grounds, apart from components/moderation-log.tsx
// so the pages that report or appeal don't load the log page itself.

import type { ModerationLog } from "./server/load.ts";

type Reason = ModerationLog["entries"][number]["reason"];

/** The policy's removal grounds, in its order; `moderation.test.ts` ties them to the API's. */
export const REMOVAL_GROUNDS = [
  "illegal",
  "personal-data",
  "threat",
  "harassment",
  "spam",
  "impersonation",
  "legal-notice",
] as const satisfies readonly Reason[];

export type RemovalGround = (typeof REMOVAL_GROUNDS)[number];

/** The policy's grounds for restoring a poll, tied to the API's as above. */
export const RESTORE_GROUNDS = [
  "appeal-upheld",
  "error",
  "notice-withdrawn",
] as const satisfies readonly Reason[];
