// A poll page's report ([[moderation-policy]], Reports): the server function
// `sendPollReport` (src/data.ts) on our own origin, which asks the API's
// `POST /moderation/reports` with the poll and the ground alone. Server
// functions never get the account cookie (src/node/serve.ts), so no account
// is ever joined to the poll it reported, and the API counts the report per
// poll and ground with nothing about who sent it (T-10, T-11).

import type { RemovalGround } from "./components/moderation-log.tsx";
import { sendPollReport } from "./data.ts";
import type { ReportOutcome } from "./profile-report.ts";

/** Reports the poll `electionId` under `reason`. Never throws. */
export type ReportPoll = (electionId: string, reason: RemovalGround) => Promise<ReportOutcome>;

export const reportPoll: ReportPoll = async (electionId, reason) => {
  try {
    return await sendPollReport({ data: { electionId, reason } });
  } catch {
    return "failed";
  }
};
