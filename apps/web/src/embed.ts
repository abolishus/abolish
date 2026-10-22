// The embed's size, apart from its component (src/components/poll-embed.tsx)
// so the poll page's loader reads it without bringing the card's script into
// every page's (P2-28 part 2b).

import type { PollView } from "./poll.ts";

/**
 * A height that fits the card at the widths it's meant for (320 to 640
 * pixels): the frame can't size itself without script, so the snippet says
 * it, and the page scrolls inside past it.
 */
export function embedHeight(poll: Pick<PollView, "questions">): number {
  const [first] = poll.questions;
  return poll.questions.length > 1 || first === undefined ? 640 : 420 + first.optionCount * 56;
}
