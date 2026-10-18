// A poll page's link preview, from what the page's loader has: the decoded
// definition and the board head. The API doesn't serve question text, who
// asked, the board's answer count or released totals yet, so today's preview
// shows the poll's seal, its canonical code and short link (once its
// registration is recorded) and when it closes, and its results are `open` or
// `counting`, never a result.

import type { PollView } from "../poll.ts";
import type { PollPreview, PreviewFormat } from "./model.ts";
import { previewText } from "./text.ts";

/**
 * Bumped whenever the card's layout or the model's fields change, so every
 * preview gets a new version: a model with no code serializes as one from
 * before codes were optional, since `JSON.stringify` drops `undefined`.
 */
const LAYOUT = 2;

export function pollPreview(
  poll: PollView,
  code: string | undefined,
  host: string,
  now: number,
): PollPreview {
  const closes = poll.closesAt.iso;
  const closed = closes !== undefined && Date.parse(closes) <= now;
  return {
    seal: poll.definitionHash,
    code,
    host,
    question: undefined,
    askedBy: undefined,
    place: undefined,
    // An ill-formed version-5 definition can have no questions; its card
    // still draws one, as the page shows the broken rule beside it.
    questionCount: Math.max(1, poll.questions.length),
    answers: undefined,
    closesAt: closes,
    civic: false,
    results: closed ? { state: "counting" } : { state: "open" },
  };
}

/**
 * A preview's version: changes whenever anything it draws does (a new
 * release, the close, the layout), so a versioned URL can be cached for good
 * and a chat that cached the last one sees a new URL.
 */
export async function previewVersion(model: PollPreview, format: PreviewFormat): Promise<string> {
  const text = JSON.stringify([LAYOUT, format, model]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest).subarray(0, 12), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The preview image's path for poll `electionId`, without a version. */
export const previewPath = (electionId: string, format: PreviewFormat) =>
  `/polls/${electionId}/preview.png${format === "square" ? "?format=square" : ""}`;

/** What the poll page's head needs: the image's versioned URL and the text beside it. */
export interface PreviewMeta {
  readonly image: string;
  readonly title: string;
  readonly description: string;
}

export async function previewMeta(
  poll: PollView,
  code: string | undefined,
  origin: string,
  now: number,
): Promise<PreviewMeta> {
  const model = pollPreview(poll, code, new URL(origin).host, now);
  const version = await previewVersion(model, "landscape");
  return {
    image: `${origin}${previewPath(poll.electionId, "landscape")}?v=${version}`,
    ...previewText(model),
  };
}
