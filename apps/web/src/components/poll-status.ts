import { CircleCheckBig, CircleDot, Clock, type LucideIcon } from "lucide-react";

import type { Messages } from "../messages.ts";
import type { Counting, Instruction, PollStatus } from "../poll.ts";

/** Each status in words with its own icon; colour is only ever on the icon. */
export const STATUS_MARK = {
  open: { icon: CircleDot, tone: "text-recorded", label: "status_open" },
  scheduled: { icon: Clock, tone: "text-pending", label: "status_scheduled" },
  closed: { icon: CircleCheckBig, tone: "text-muted-foreground", label: "status_closed" },
} as const satisfies Record<PollStatus, { icon: LucideIcon; tone: string; label: keyof Messages }>;

/** Each status in the words a poll's own pages head it with. */
export const STATUS_TEXT = {
  open: "pollStatus_open",
  scheduled: "pollStatus_scheduled",
  closed: "pollStatus_closed",
} as const satisfies Record<PollStatus, keyof Messages>;

/** How a poll is counted, in words. */
export const COUNTING_LABEL = {
  plurality: "typePlurality",
  approval: "typeApproval",
  questions: "typeQuestions",
} as const satisfies Record<Counting, keyof Messages>;

/** A question's instruction, in words, with the values its message names. */
export function instructionMessage(i: Instruction): {
  key: keyof Messages;
  values: Record<string, number>;
} {
  switch (i.kind) {
    case "one":
    case "any":
      return { key: `instruction_${i.kind}`, values: {} };
    case "upTo":
      return { key: "instruction_upTo", values: { max: i.max } };
    case "exactly":
      return { key: "instruction_exactly", values: { count: i.count } };
    case "atLeast":
      return { key: "instruction_atLeast", values: { min: i.min } };
    case "between":
      return { key: "instruction_between", values: { min: i.min, max: i.max } };
  }
}
