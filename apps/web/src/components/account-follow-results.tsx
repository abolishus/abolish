import { Button, buttonVariants, useI18n, useTranslate } from "@abolishus/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  type FollowedPoll,
  type FollowResultsClient,
  FollowResultsError,
} from "../account/follow-results.ts";
import { catalogs } from "../messages.ts";
import { FOLLOWED_PAGE } from "../page-sizes.ts";
import { Section } from "./page-parts.tsx";

/** The list's links share the buttons' 48px target and underline, so a row's actions line up. */
const LINK = buttonVariants({ variant: "link", className: "px-0" });

/** Why the list, its next polls or a change didn't come through. */
type Failure = "signedOut" | "unlisted" | "more" | "dropped";

export interface AccountFollowResultsProps {
  readonly client: FollowResultsClient;
  /** The section's number on the page. */
  readonly index: string;
  /** Called when the session turns out to have ended. */
  readonly onSignedOut?: () => void;
}

/**
 * The polls the account followed whose results are in ([[P2-25]] part
 * 4c-2b): what the results e-mail and push notice send it here to see,
 * since they name no poll (T-73, T-76). Each poll by its heading, checked as
 * a stream card's, with a link to its results and a way to take it off the
 * list. The list is the account's own: only its page reads it, never a
 * poll's (T-10, T-11). Its polls' words are read a page at a time, as many
 * as a stream page's (T-52).
 */
export function AccountFollowResults({ client, index, onSignedOut }: AccountFollowResultsProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  // Every poll on the list, and those of them whose words have been read, in order.
  const [ids, setIds] = useState<readonly string[] | undefined>();
  const [shown, setShown] = useState<readonly FollowedPoll[]>([]);
  const [busy, setBusy] = useState(true);
  const [failure, setFailure] = useState<Failure | undefined>();
  const [removed, setRemoved] = useState(false);
  // Taking a poll off removes the button that had focus: focus goes back to
  // the section's heading, so keyboard users keep their place.
  const heading = useRef<HTMLHeadingElement>(null);

  const failed = useCallback(
    (e: unknown, otherwise: Failure) => {
      const why =
        e instanceof FollowResultsError && e.failure === "signedOut" ? "signedOut" : otherwise;
      setFailure(why);
      if (why === "signedOut") onSignedOut?.();
    },
    [onSignedOut],
  );

  const load = useCallback(async () => {
    setBusy(true);
    setFailure(undefined);
    let all: readonly string[];
    try {
      all = await client.list();
    } catch (e) {
      failed(e, "unlisted");
      setBusy(false);
      return;
    }
    try {
      setShown(all.length === 0 ? [] : await client.headings(all.slice(0, FOLLOWED_PAGE), locale));
      setIds(all);
    } catch (e) {
      failed(e, "unlisted");
    } finally {
      setBusy(false);
    }
  }, [client, locale, failed]);

  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (ids === undefined) return;
    setBusy(true);
    setFailure(undefined);
    setRemoved(false);
    try {
      const next = await client.headings(
        ids.slice(shown.length, shown.length + FOLLOWED_PAGE),
        locale,
      );
      setShown((s) => [...s, ...next]);
    } catch (e) {
      failed(e, "more");
    } finally {
      setBusy(false);
    }
  };

  const drop = async (electionId: string) => {
    setBusy(true);
    setFailure(undefined);
    setRemoved(false);
    try {
      await client.drop(electionId);
      setIds((all) => all?.filter((id) => id !== electionId));
      setShown((s) => s.filter((p) => p.electionId !== electionId));
      setRemoved(true);
    } catch (e) {
      failed(e, "dropped");
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  };

  const rest = ids === undefined ? 0 : ids.length - shown.length;

  return (
    <Section
      index={index}
      mark={t("followResultsMark")}
      title={t("followResultsTitle")}
      id="follow-results-title"
      titleRef={heading}
      lede={<p className="m-0">{t("followResultsLede")}</p>}
    >
      <div aria-busy={busy} className="grid gap-4">
        {/* Under the heading focus returns to, above the list, so the outcome is on the screen the account lands on. */}
        {failure === undefined ? null : (
          <div className="grid justify-items-start gap-1">
            <p role="alert" className="m-0 text-destructive">
              {t(`followResultsFailure_${failure}`)}
            </p>
            {failure === "unlisted" ? (
              <Button variant="link" className="px-0" disabled={busy} onClick={() => void load()}>
                {t("followResultsReload")}
              </Button>
            ) : null}
          </div>
        )}
        {/* Empty, it takes no room; it stays in the tree, so its words are announced when they come. */}
        <div role="status" className="text-base empty:-mt-4">
          {removed ? t("followResultsRemoved") : null}
        </div>
        {ids === undefined ? null : ids.length === 0 ? (
          <p className="m-0 border-t-2 border-foreground pt-4 text-base">
            {t("followResultsEmpty")}
          </p>
        ) : (
          <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
            {shown.map((p) => {
              // Every row has the same actions: each is described by its poll's heading.
              const which = `follow-result-${p.electionId}`;
              return (
                <li
                  key={p.electionId}
                  className="grid gap-x-6 gap-y-2 border-b border-border py-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
                >
                  <h3 id={which} className="m-0 text-lg leading-snug font-semibold break-words">
                    {p.heading ?? t("followResultsNoWords")}
                  </h3>
                  <span className="flex flex-wrap gap-x-4 text-sm md:justify-end">
                    <a
                      href={`/polls/${p.electionId}/results`}
                      aria-describedby={which}
                      className={LINK}
                    >
                      {t("followResultsSee")}
                    </a>
                    <Button
                      variant="link"
                      className="px-0"
                      aria-describedby={which}
                      disabled={busy}
                      onClick={() => void drop(p.electionId)}
                    >
                      {t("followResultsRemove")}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {rest > 0 ? (
          <div>
            <Button variant="outline" disabled={busy} onClick={() => void more()}>
              {t("followResultsMore", { count: Math.min(rest, FOLLOWED_PAGE) })}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}
