import { CircleCheckBig, CircleDot, Clock, type LucideIcon } from "lucide-react";

import type { Messages } from "../messages.ts";
import type { PollStatus } from "../poll.ts";

/** Each status in words with its own icon; colour is only ever on the icon. */
export const STATUS_MARK = {
  open: { icon: CircleDot, tone: "text-recorded", label: "status_open" },
  scheduled: { icon: Clock, tone: "text-pending", label: "status_scheduled" },
  closed: { icon: CircleCheckBig, tone: "text-muted-foreground", label: "status_closed" },
} as const satisfies Record<PollStatus, { icon: LucideIcon; tone: string; label: keyof Messages }>;
