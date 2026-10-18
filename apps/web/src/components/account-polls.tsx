import { Button, buttonVariants, useI18n, useTranslate } from "@abolishus/ui";
import type { PollState } from "@abolishus/core";
import { CircleAlert, CircleDot, Hourglass, type LucideIcon, PencilLine, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DraftsError,
  type DraftsClient,
  type DraftsFailure,
  type PollSummary,
} from "../account/drafts.ts";
import { catalogs, type Messages, POLL_FAILURE_MESSAGES } from "../messages.ts";
import { formatUtc } from "./format.ts";
import { Section } from "./page-parts.tsx";

type Shown = "drafted" | "setup" | "open" | "failed";

/** Setup's steps are one state to the author: they wait, and can leave (T-34: no hashes). */
const SHOWN: Readonly<Record<PollState, Shown>> = {
  drafted: "drafted",
  submitted: "setup",
  created: "setup",
  rooted: "setup",
  ceremony: "setup",
  registered: "setup",
  open: "open",
  failed: "failed",
};

/** Each state in words with its own icon; colour is only ever on the icon. */
const MARK = {
  drafted: { icon: PencilLine, tone: "text-muted-foreground" },
  setup: { icon: Hourglass, tone: "text-pending" },
  open: { icon: CircleDot, tone: "text-recorded" },
  failed: { icon: CircleAlert, tone: "text-destructive" },
} as const satisfies Record<Shown, { icon: LucideIcon; tone: string }>;

type Done = "pollsRemoved" | "pollsRetried" | "pollsDiscarded";

/** An action waiting for its second click: which poll, and what it does. */
type Confirming = { readonly id: string; readonly action: "remove" | "discard" };

export interface AccountPollsProps {
  readonly client: DraftsClient;
  /** The section's number on the page. */
  readonly index: string;
  /** Called when the session turns out to have ended. */
  readonly onSignedOut?: () => void;
}

/**
 * The polls an account created: drafts, polls in setup, open polls and
 * those that failed in setup, each failure in plain words with what the
 * author can do about it (ADR 0032, rule 14). A failed poll that can be
 * retried goes back to its draft or is discarded; one whose election is
 * registered stays, as an open poll does.
 */
export function AccountPolls({ client, index, onSignedOut }: AccountPollsProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [polls, setPolls] = useState<readonly PollSummary[] | undefined>();
  const [busy, setBusy] = useState(true);
  const [done, setDone] = useState<Done | undefined>();
  const [failure, setFailure] = useState<DraftsFailure | "unlisted" | undefined>();
  const [confirming, setConfirming] = useState<Confirming | undefined>();
  // An action removes or replaces the buttons that had focus: focus goes
  // back to the section's heading, so keyboard users keep their place.
  const heading = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async () => setPolls(await client.list()), [client]);

  const failed = useCallback(
    (e: unknown, otherwise: DraftsFailure | "unlisted") => {
      const why = e instanceof DraftsError && e.failure !== "failed" ? e.failure : otherwise;
      setFailure(why);
      if (why === "signedOut") onSignedOut?.();
    },
    [onSignedOut],
  );

  useEffect(() => {
    refresh()
      .catch((e: unknown) => failed(e, "unlisted"))
      .finally(() => setBusy(false));
  }, [refresh, failed]);

  /** Runs one action, then shows the list as the server now has it. */
  const act = (action: () => Promise<void>, then: Done) => async () => {
    setBusy(true);
    setDone(undefined);
    setFailure(undefined);
    setConfirming(undefined);
    try {
      await action();
      setDone(then);
    } catch (e) {
      failed(e, "failed");
    }
    try {
      await refresh();
    } catch (e) {
      failed(e, "unlisted");
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  };

  const at = (iso: string) => formatUtc(locale, new Date(iso));

  const when = (p: PollSummary) => {
    switch (SHOWN[p.state]) {
      case "drafted":
        return t("pollsEdited", { when: at(p.updatedAt) });
      case "open":
        return t("pollsCloses", { when: formatUtc(locale, new Date(Number(p.closesAt) * 1000)) });
      default:
        return t("pollsSubmitted", { when: at(p.submittedAt ?? p.updatedAt) });
    }
  };

  const confirm = (p: PollSummary, title: string, c: Confirming["action"]) => {
    const question = c === "remove" ? "pollsDeleteQuestion" : "pollsDiscardQuestion";
    const questionId = `poll-${p.id}-confirm`;
    return (
      <div
        role="group"
        aria-labelledby={questionId}
        className="grid gap-4 border-2 border-destructive p-5 md:col-span-full"
      >
        <p id={questionId} className="m-0 font-semibold">
          {t(question)} <span className="sr-only">{title}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="destructive"
            disabled={busy}
            onClick={
              c === "remove"
                ? act(() => client.remove(p.id), "pollsRemoved")
                : act(() => client.discard(p.id), "pollsDiscarded")
            }
          >
            {t(c === "remove" ? "pollsDeleteConfirm" : "pollsDiscardConfirm")}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setConfirming(undefined)}>
            {t("pollsKeep")}
          </Button>
        </div>
      </div>
    );
  };

  const actions = (p: PollSummary) => {
    // Every row has the same buttons: each is described by its poll's title.
    const which = `poll-${p.id}-title`;
    if (p.state === "drafted")
      return (
        <span className="flex flex-wrap gap-x-4 md:justify-end">
          <a
            href={`/account/polls/${p.id}`}
            aria-describedby={which}
            className="inline-flex h-9 items-center underline underline-offset-4"
          >
            {t("pollsEdit")}
          </a>
          <Button
            variant="link"
            className="px-0"
            aria-describedby={which}
            disabled={busy}
            onClick={() => setConfirming({ id: p.id, action: "remove" })}
          >
            {t("pollsDelete")}
          </Button>
        </span>
      );
    if (p.state !== "failed" || !p.retryable) return null;
    return (
      <span className="flex flex-wrap gap-x-4">
        <Button
          variant="link"
          className="px-0"
          aria-describedby={which}
          disabled={busy}
          onClick={act(() => client.retry(p.id), "pollsRetried")}
        >
          {t("pollsRetry")}
        </Button>
        <Button
          variant="link"
          className="px-0"
          aria-describedby={which}
          disabled={busy}
          onClick={() => setConfirming({ id: p.id, action: "discard" })}
        >
          {t("pollsDiscard")}
        </Button>
      </span>
    );
  };

  return (
    <Section
      index={index}
      mark={t("pollsMark")}
      title={t("pollsTitle")}
      id="polls-title"
      titleRef={heading}
      lede={<p className="m-0">{t("pollsLede")}</p>}
    >
      <div aria-busy={busy} className="grid gap-4">
        <p className="m-0">
          <a href="/account/polls/new" className={buttonVariants({ size: "lg" })}>
            <Plus aria-hidden="true" data-icon="inline-start" />
            {t("pollsCreate")}
          </a>
        </p>
        {polls === undefined ? null : polls.length === 0 ? (
          <p className="m-0 border-t-2 border-foreground pt-4 text-base">{t("pollsEmpty")}</p>
        ) : (
          <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
            {polls.map((p) => {
              const shown = SHOWN[p.state];
              const { icon: Icon, tone } = MARK[shown];
              const title = p.title === "" ? t("pollsUntitled") : p.title;
              const help: keyof Messages | undefined =
                p.failure !== undefined
                  ? POLL_FAILURE_MESSAGES[p.failure]
                  : shown === "setup"
                    ? "pollsSetupHelp"
                    : undefined;
              return (
                <li
                  key={p.id}
                  className="grid gap-x-6 gap-y-2 border-b border-border py-5 md:grid-cols-[minmax(0,1fr)_9rem_minmax(0,16rem)_auto] md:items-start"
                >
                  <h3
                    id={`poll-${p.id}-title`}
                    className="m-0 text-lg leading-snug font-semibold break-words"
                  >
                    {title}
                  </h3>
                  <p className="m-0 flex items-center gap-2 text-sm">
                    <Icon aria-hidden="true" className={`size-4 shrink-0 ${tone}`} />
                    {t(`pollsState_${shown}`)}
                  </p>
                  <p className="m-0 font-mono text-xs tracking-wide" suppressHydrationWarning>
                    {when(p)}
                  </p>
                  <div className="text-sm md:text-end">{actions(p)}</div>
                  {help === undefined ? null : (
                    <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground md:col-span-full">
                      {t(help)}
                    </p>
                  )}
                  {confirming?.id === p.id ? confirm(p, title, confirming.action) : null}
                </li>
              );
            })}
          </ul>
        )}
        <div role="status" className="min-h-6 text-base">
          {done === undefined ? null : t(done)}
        </div>
        {failure === undefined ? null : (
          <p role="alert" className="m-0 text-destructive">
            {t(`pollsFailure_${failure}`)}
          </p>
        )}
      </div>
    </Section>
  );
}
