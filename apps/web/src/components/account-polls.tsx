import { Button, buttonVariants, useI18n, useTranslate } from "@abolishus/ui";
import type { PollState } from "@abolishus/core";
import {
  CircleAlert,
  CircleCheckBig,
  CircleDot,
  Hourglass,
  type LucideIcon,
  PencilLine,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DraftsError,
  type DraftsClient,
  type DraftsFailure,
  type PollSummary,
} from "../account/drafts.ts";
import type { OwnProfileView, ProfilesClient } from "../account/profiles.ts";
import { catalogs, type Messages, POLL_FAILURE_MESSAGES } from "../messages.ts";
import { formatUtc } from "./format.ts";
import { Section } from "./page-parts.tsx";
import { PollModeration } from "./poll-moderation.tsx";
import { ProfileChoice } from "./profile-choice.tsx";

type Shown = "drafted" | "setup" | "open" | "closed" | "failed";

/**
 * Setup's steps are one state to the author: they wait, and can leave (T-34:
 * no hashes). An open poll past its close is shown closed (`shownAt`).
 */
const SHOWN: Readonly<Record<PollState, Exclude<Shown, "closed">>> = {
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
  closed: { icon: CircleCheckBig, tone: "text-muted-foreground" },
  failed: { icon: CircleAlert, tone: "text-destructive" },
} as const satisfies Record<Shown, { icon: LucideIcon; tone: string }>;

/**
 * A poll's state as its author reads it at `now`. The list's state stays
 * `open` after the close, so the close time decides, as on the poll's page:
 * a ballot counts through `closes_at`'s second (docs/spec/revoting.md).
 */
const shownAt = (p: PollSummary, now: Date): Shown =>
  p.state === "open" && BigInt(Math.floor(now.getTime() / 1000)) > p.closesAt
    ? "closed"
    : SHOWN[p.state];

/** The list's links share the buttons' 48px target and underline, so a row's actions line up. */
const LINK = buttonVariants({ variant: "link", className: "px-0" });

type Done = "pollsRemoved" | "pollsRetried" | "pollsDiscarded";

/** An action waiting for its second click: which poll, and what it does. */
type Confirming = { readonly id: string; readonly action: "remove" | "discard" };

export interface AccountPollsProps {
  readonly client: DraftsClient;
  /** The section's number on the page. */
  readonly index: string;
  /** Called when the session turns out to have ended. */
  readonly onSignedOut?: () => void;
  /** The account's profile, for each poll's choice of whether it shows the poll; none to offer no choice. */
  readonly profiles?: ProfilesClient;
  /** Bumped when the profile may have changed elsewhere on the page, so it is read again. */
  readonly profileRevision?: number;
  /** Called after each poll's choice is sent, so the rest of the page reads the profile again. */
  readonly onProfileChanged?: () => void;
  /** The clock that says whether an open poll has closed. */
  readonly now?: () => Date;
}

/**
 * The polls an account created: drafts, polls in setup, open polls and
 * those that failed in setup, each failure in plain words with what the
 * author can do about it (ADR 0032, rule 14). A failed poll that can be
 * retried goes back to its draft or is discarded; one whose election is
 * registered stays, as an open poll does. Under each poll past its draft,
 * what moderation decided about it and the author's appeal. Where the
 * account has a profile, each poll has its choice of whether the profile
 * shows it (P2-27 part 1d-3).
 */
export function AccountPolls({
  client,
  index,
  onSignedOut,
  profiles,
  profileRevision = 0,
  onProfileChanged,
  now = () => new Date(),
}: AccountPollsProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [polls, setPolls] = useState<readonly PollSummary[] | undefined>();
  const [busy, setBusy] = useState(true);
  const [done, setDone] = useState<Done | undefined>();
  const [failure, setFailure] = useState<DraftsFailure | "unlisted" | undefined>();
  const [confirming, setConfirming] = useState<Confirming | undefined>();
  const [profile, setProfile] = useState<OwnProfileView | undefined>();
  // Bumped after a poll's choice changed, so the profile is read again here too.
  const [chosen, setChosen] = useState(0);
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

  // The profile's own section says when it can't be read; here a failed
  // read keeps the boxes as last read, and none before a first read.
  useEffect(() => {
    if (profiles === undefined) return;
    let live = true;
    profiles
      .own()
      .then((p) => live && setProfile(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [profiles, profileRevision, chosen]);

  const choiceChanged = () => {
    setChosen((n) => n + 1);
    onProfileChanged?.();
  };

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

  const when = (p: PollSummary, shown: Shown) => {
    const closes = () => formatUtc(locale, new Date(Number(p.closesAt) * 1000));
    switch (shown) {
      case "drafted":
        return t("pollsEdited", { when: at(p.updatedAt) });
      case "open":
        return t("pollsCloses", { when: closes() });
      case "closed":
        return t("pollsClosed", { when: closes() });
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

  const actions = (p: PollSummary, shown: Shown) => {
    // Every row has the same buttons: each is described by its poll's title.
    const which = `poll-${p.id}-title`;
    if (p.state === "drafted")
      return (
        <span className="flex flex-wrap gap-x-4 md:justify-end">
          <a href={`/account/polls/${p.id}`} aria-describedby={which} className={LINK}>
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
    const link = (href: string, words: "pollsFollowSetup" | "pollsPage") => (
      <a href={href} aria-describedby={which} className={LINK}>
        {t(words)}
      </a>
    );
    if (shown === "setup") return link(`/account/polls/${p.id}/setup`, "pollsFollowSetup");
    if (shown === "open" || shown === "closed")
      return p.electionId === undefined ? null : link(`/polls/${p.electionId}`, "pollsPage");
    if (p.state !== "failed" || !p.retryable) return null;
    return (
      <span className="flex flex-wrap gap-x-4 md:justify-end">
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
              const shown = shownAt(p, now());
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
                  className="grid gap-x-6 gap-y-2 border-b border-border py-5 md:grid-cols-[10rem_minmax(0,1fr)_auto] md:items-center"
                >
                  {/* The title has the row's whole width, so it never narrows to a word a line. */}
                  <h3
                    id={`poll-${p.id}-title`}
                    className="m-0 text-lg leading-snug font-semibold break-words md:col-span-full"
                  >
                    {title}
                  </h3>
                  <p className="m-0 flex items-center gap-2 text-sm md:col-start-1 md:row-start-2">
                    <Icon aria-hidden="true" className={`size-4 shrink-0 ${tone}`} />
                    {t(`pollsState_${shown}`)}
                  </p>
                  {/* A time is a fact in the body's face, as on the poll's page; the mono mark is for evidence. */}
                  <p
                    className="m-0 text-sm text-muted-foreground md:col-start-2 md:row-start-2"
                    suppressHydrationWarning
                  >
                    {when(p, shown)}
                  </p>
                  {/* The reason comes before its actions, as a phone and a screen reader read them; from 768px the actions stay on the state's line. */}
                  {help === undefined ? null : (
                    <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground md:col-span-full md:row-start-3">
                      {t(help)}
                    </p>
                  )}
                  {/* An action's 48px even where there is none, so every row's line is one height. */}
                  <div className="text-sm md:col-start-3 md:row-start-2 md:min-h-12 md:text-end">
                    {actions(p, shown)}
                  </div>
                  {confirming?.id === p.id ? confirm(p, title, confirming.action) : null}
                  {profiles === undefined || profile === undefined ? null : (
                    <div className="md:col-span-full">
                      <ProfileChoice
                        client={profiles}
                        profile={profile}
                        pollId={p.id}
                        describedBy={`poll-${p.id}-title`}
                        onChanged={choiceChanged}
                        {...(onSignedOut === undefined ? {} : { onSignedOut })}
                      />
                    </div>
                  )}
                  {/* A draft has no election, so nothing to moderate. */}
                  {shown === "drafted" ? null : (
                    <PollModeration
                      client={client}
                      pollId={p.id}
                      titleId={`poll-${p.id}-title`}
                      {...(onSignedOut === undefined ? {} : { onSignedOut })}
                    />
                  )}
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
