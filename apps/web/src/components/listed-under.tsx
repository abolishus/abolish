import { useTranslate } from "@abolishus/ui";

import { catalogs, POLL_TOPIC_MESSAGES } from "../messages.ts";
import type { PollTags } from "../poll.ts";
import { streamHref, streamPlace } from "../stream.ts";

const CHIP =
  "inline-flex min-h-8 min-w-0 items-center border border-border px-2 py-1 wrap-anywhere";

const LINK = `${CHIP} underline-offset-4 hover:border-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none`;

/**
 * Where a poll is listed, as the form's preview shows it: its topic and its
 * place, each a link to the stream narrowed to it when `linked`, or plain
 * words where the stream wouldn't list the poll (a delisted one). The place is
 * its author's words or moderation's, in their own direction (`<bdi>`), and
 * only as the server checked it (src/server/load.ts, `tagsOf`; T-67). Nothing
 * when the poll is listed under neither.
 */
export function ListedUnder({ tags, linked }: { tags: PollTags; linked: boolean }) {
  const t = useTranslate(catalogs);
  const { topic, place } = tags;
  if (topic === undefined && place === undefined) return null;
  const filter = place === undefined ? undefined : streamPlace(place);
  return (
    <ul aria-label={t("listedUnder")} className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm">
      {topic === undefined ? null : (
        <li className="flex min-w-0">
          {linked ? (
            <a className={LINK} href={streamHref("new", { topic })}>
              {t(POLL_TOPIC_MESSAGES[topic])}
            </a>
          ) : (
            <span className={CHIP}>{t(POLL_TOPIC_MESSAGES[topic])}</span>
          )}
        </li>
      )}
      {place === undefined ? null : (
        <li className="flex min-w-0">
          {/* A checked place is always one the stream can filter by
              (`streamPlace`); the guard keeps a link from carrying any other. */}
          {linked && filter?.kind === "place" ? (
            <a className={LINK} href={streamHref("new", { place: filter.place })}>
              <bdi>{place}</bdi>
            </a>
          ) : (
            <span className={CHIP}>
              <bdi>{place}</bdi>
            </span>
          )}
        </li>
      )}
    </ul>
  );
}
