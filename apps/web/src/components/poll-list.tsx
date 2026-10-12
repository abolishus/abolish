import { useTranslate } from "@abolishus/ui";

import { catalogs } from "../messages.ts";
import type { PollList as List } from "../server/load.ts";
import { When } from "./poll-summary.tsx";

/** A poll's link: the start of its ID, since a definition carries no title of its own. */
function PollLink({ electionId }: { electionId: string }) {
  const t = useTranslate(catalogs);
  return (
    <a
      className="font-mono underline underline-offset-4"
      translate="no"
      href={`/polls/${electionId}`}
    >
      {t("shortId", { prefix: electionId.slice(0, 16) })}
    </a>
  );
}

/**
 * The polls our API lists for discovery, a page at a time. The listing
 * leaves out delisted and hidden polls (T-68), and it is only ours: the
 * page says that the registry on chain names every poll (T-34).
 */
export function PollList({ list }: { list: List }) {
  const t = useTranslate(catalogs);
  return (
    <section aria-labelledby="list-title" className="grid gap-6">
      <h2 id="list-title" className="text-2xl font-semibold">
        {t("listTitle")}
      </h2>
      <p className="max-w-prose text-muted-foreground">{t("listLede")}</p>
      {list.polls.length === 0 ? (
        <p>{t("listEmpty")}</p>
      ) : (
        <ul className="m-0 grid list-none gap-0 p-0">
          {list.polls.map((entry) => (
            <li
              key={entry.kind === "poll" ? entry.poll.electionId : entry.electionId}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-border py-3"
            >
              {entry.kind === "poll" ? (
                <>
                  <PollLink electionId={entry.poll.electionId} />
                  <span>
                    {t(entry.poll.electionType === "approval" ? "typeApproval" : "typePlurality")}
                  </span>
                  <span className="text-muted-foreground">
                    {t("listCloses")} <When instant={entry.poll.closesAt} />
                  </span>
                  {entry.poll.illFormed !== undefined ? (
                    <span className="text-destructive">{t("listIllFormed")}</span>
                  ) : null}
                </>
              ) : (
                <>
                  <PollLink electionId={entry.electionId} />
                  <span className="text-muted-foreground">
                    {t(entry.problem === "undecodable" ? "listUndecodable" : "listMismatch")}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {list.next !== undefined ? (
        <a className="underline underline-offset-4" href={`/polls?after=${list.next}`}>
          {t("listMore")}
        </a>
      ) : null}
    </section>
  );
}
