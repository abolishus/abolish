import { Button, buttonVariants, useI18n, useTranslate } from "@abolishus/ui";
import { EyeOff, ListX, type LucideIcon, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  DraftsError,
  type DraftsClient,
  type DraftsFailure,
  type ModerationAppeal,
  type PollModerationView,
} from "../account/drafts.ts";
import { catalogs } from "../messages.ts";
import { formatUtcWhole } from "./format.ts";

const ACTION_ICON = {
  delist: ListX,
  hide: EyeOff,
  restore: RotateCcw,
} as const satisfies Record<NonNullable<PollModerationView["latest"]>["action"], LucideIcon>;

/** The poll row's links: the buttons' 48px target and underline, so the history's actions match the row's. */
const LINK = buttonVariants({ variant: "link", className: "px-0" });

// `moderationNone`: loaded again on request, and nothing was ever decided,
// which is said rather than the block vanishing with focus in it.
type Done = "moderationAppealFiled" | "moderationNone";
// Only these reach the page (`failed` below); the submission's refusals never do.
type Failure = Extract<DraftsFailure, "signedOut" | "gone" | "changed" | "failed"> | "unloaded";

export interface PollModerationProps {
  readonly client: DraftsClient;
  readonly pollId: string;
  /** The ID of the element naming the poll, which describes the appeal's buttons. */
  readonly titleId: string;
  /** The poll's title as the row shows it, which the appeal's question names. */
  readonly title: string;
  /** Called when the session turns out to have ended. */
  readonly onSignedOut?: () => void;
}

/**
 * What moderation decided about one of the author's polls, their appeals
 * with each outcome, and the appeal itself while the newest decision is a
 * removal not yet appealed (docs/moderation-policy.md, Appeals). Nothing
 * shows while nothing was ever decided. The decision and its ground are
 * the public log's; the moderator and the reviewer are never shown, since
 * the handler never sends them (T-68).
 */
export function PollModeration({
  client,
  pollId,
  titleId,
  title,
  onSignedOut,
}: PollModerationProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [view, setView] = useState<PollModerationView | undefined>();
  const [busy, setBusy] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Done | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  // Filing replaces the button that had focus: focus goes to the block's heading.
  const heading = useRef<HTMLParagraphElement>(null);
  // Asking replaces the appeal button and "Not now" removes itself: focus
  // moves once React has drawn the change, to the question when it opens,
  // back to the appeal button when it closes.
  const question = useRef<HTMLParagraphElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    (confirming ? question.current : opener.current)?.focus();
  }, [confirming]);
  const ask = (open: boolean) => {
    moved.current = true;
    setConfirming(open);
  };

  const failed = useCallback(
    (e: unknown, otherwise: Failure) => {
      const why = e instanceof DraftsError ? e.failure : undefined;
      const shown: Failure =
        why === "signedOut" || why === "gone" || why === "changed" ? why : otherwise;
      setFailure(shown);
      if (shown === "signedOut") onSignedOut?.();
    },
    [onSignedOut],
  );

  const refresh = useCallback(
    async () => setView(await client.moderation(pollId)),
    [client, pollId],
  );

  useEffect(() => {
    refresh()
      .catch((e: unknown) => failed(e, "unloaded"))
      .finally(() => setBusy(false));
  }, [refresh, failed]);

  const appeal = async () => {
    setBusy(true);
    setDone(undefined);
    setFailure(undefined);
    setConfirming(false);
    try {
      await client.appeal(pollId);
      setDone("moderationAppealFiled");
    } catch (e) {
      failed(e, "failed");
    }
    // Shown as the server now has it, whether the appeal went through or not.
    try {
      await refresh();
    } catch (e) {
      failed(e, "unloaded");
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  };

  /** Reads this poll's moderation again after it couldn't be loaded, without reloading the page. */
  const reload = async () => {
    // The failure stays on screen until the answer comes: cleared first, the
    // block would vanish with the focused button in it.
    setBusy(true);
    try {
      const fresh = await client.moderation(pollId);
      setFailure(undefined);
      setView(fresh);
      if (fresh.latest === undefined && fresh.appeals.length === 0) setDone("moderationNone");
    } catch (e) {
      failed(e, "unloaded");
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  };

  const at = (iso: string) => formatUtcWhole(locale, new Date(iso));

  const outcome = (a: ModerationAppeal) =>
    a.outcome === undefined || a.reviewedAt === undefined
      ? t("moderationAppealPending")
      : t(`moderationAppeal_${a.outcome}`, { when: at(a.reviewedAt) });

  const latest = view?.latest;
  const appeals = view?.appeals ?? [];
  const notice = done === undefined ? null : t(done);
  const alert = failure === undefined ? null : t(`moderationFailure_${failure}`);
  // A poll nothing was ever decided about shows nothing, unless something went wrong.
  if (latest === undefined && appeals.length === 0 && notice === null && alert === null)
    return null;

  const Icon = latest === undefined ? undefined : ACTION_ICON[latest.action];
  const headingId = `${titleId}-moderation`;

  return (
    <div
      role="group"
      aria-labelledby={headingId}
      aria-busy={busy}
      className="grid gap-3 border-s-2 border-foreground ps-4 text-sm md:col-span-full"
    >
      {/* The icon sits on the first line, as the account's checks do: centred on a heading that wraps, it fell between the lines. Focus comes here only by script, after filing, so it draws no ring, as the list's heading and questions draw none: the browser's crossed the history's rule and the time under it. */}
      <p
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="m-0 flex items-start gap-2 font-semibold outline-none"
        suppressHydrationWarning
      >
        {Icon === undefined ? null : <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
        {latest === undefined ? (
          t("moderationOfPoll")
        ) : (
          // The time on a line of its own under the decision, as each row's time is under its state: run on after the reason, a narrow heading broke it between "October" and "16". Its log number is there too, since the appeals below name decisions by it.
          <span>
            {t("moderationDecisionWhat", {
              action: t(`action_${latest.action}`),
              reason: t(`reason_${latest.reason}`),
            })}
            <span className="block font-normal text-muted-foreground">
              {t("moderationDecidedOn", {
                seq: latest.seq.toString(),
                when: at(latest.decidedAt),
              })}
            </span>
          </span>
        )}
      </p>
      {/* Under the heading focus returns to after filing, as the list's own outcomes are under its heading: at the block's end, it sat under the means line, the appeals and the log link. Empty, it is out of the grid, so it takes no gap; it stays in the tree, so its words are announced when they come. */}
      <div role="status" className="max-w-prose text-pretty empty:absolute">
        {notice}
      </div>
      {/* A poll's moderation that couldn't load offers the way to load it alone again, as the list does, rather than the whole account page. */}
      {alert === null ? null : (
        <div className="grid justify-items-start gap-1">
          <p role="alert" className="m-0 max-w-prose text-pretty text-destructive">
            {alert}
          </p>
          {failure === "unloaded" ? (
            <Button
              variant="link"
              className="px-0"
              aria-describedby={titleId}
              disabled={busy}
              onClick={() => void reload()}
            >
              {t("moderationReload")}
            </Button>
          ) : null}
        </div>
      )}
      {view === undefined || latest === undefined ? null : (
        <p className="m-0 max-w-prose text-pretty text-muted-foreground">
          {t(`moderationMeans_${view.state}`)}
        </p>
      )}
      {/* Each appeal is a sentence of four lines on a phone: 4px apart, two read as one paragraph, so they keep the block's own gap between them. Newest decision first, as the server's are oldest first: the appeal of the decision in the heading comes right under it, not after appeals of decisions the block doesn't show. */}
      {appeals.length === 0 ? null : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {appeals.toReversed().map((a) => (
            // The measure every other sentence in the list keeps, not the row's whole width.
            <li
              key={a.decisionSeq.toString()}
              className="max-w-prose text-pretty"
              suppressHydrationWarning
            >
              {t("moderationAppealed", {
                seq: a.decisionSeq.toString(),
                when: at(a.filedAt),
                outcome: outcome(a),
              })}
            </li>
          ))}
        </ul>
      )}
      {view?.appealable === true && confirming ? (
        <div
          role="group"
          aria-labelledby={`${headingId}-confirm`}
          className="grid gap-4 border-2 border-foreground p-5"
        >
          <p
            id={`${headingId}-confirm`}
            ref={question}
            tabIndex={-1}
            className="m-0 max-w-prose font-semibold text-pretty outline-none"
          >
            {/* Focus lands here, away from the button its title described: the question names the poll, as the list's own questions do. */}
            {t("moderationAppealQuestion")} <span className="sr-only">{title}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void appeal()}>
              {t("moderationAppealConfirm")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => ask(false)}>
              {t("moderationAppealCancel")}
            </Button>
          </div>
        </div>
      ) : null}
      <p className="m-0 flex flex-wrap gap-x-4">
        {view?.appealable === true && !confirming ? (
          <Button
            ref={opener}
            variant="link"
            className="px-0"
            aria-describedby={titleId}
            disabled={busy}
            onClick={() => ask(true)}
          >
            {t("moderationAppeal")}
          </Button>
        ) : null}
        {/* The log opens at the decision the heading names, its first row, with the earlier ones after it: from the latest, a decision 50 or more back was a page or more away, with nothing saying which. */}
        {latest === undefined ? (
          <a href="/moderation" className={LINK}>
            {t("moderationLogLink")}
          </a>
        ) : (
          <a href={`/moderation?before=${latest.seq + 1n}`} className={LINK}>
            {t("moderationLogAt")}
          </a>
        )}
      </p>
    </div>
  );
}
