import { Button, useI18n, useTranslate } from "@abolishus/ui";
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

type Done = "moderationAppealFiled";
// Only these reach the page (`failed` below); the submission's refusals never do.
type Failure = Extract<DraftsFailure, "signedOut" | "gone" | "changed" | "failed"> | "unloaded";

export interface PollModerationProps {
  readonly client: DraftsClient;
  readonly pollId: string;
  /** The ID of the element naming the poll, which describes the appeal's buttons. */
  readonly titleId: string;
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
export function PollModeration({ client, pollId, titleId, onSignedOut }: PollModerationProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [view, setView] = useState<PollModerationView | undefined>();
  const [busy, setBusy] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<Done | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  // Filing replaces the button that had focus: focus goes to the block's heading.
  const heading = useRef<HTMLParagraphElement>(null);

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
      <p
        id={headingId}
        ref={heading}
        tabIndex={-1}
        className="m-0 flex items-center gap-2 font-semibold"
        suppressHydrationWarning
      >
        {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4 shrink-0" />}
        {latest === undefined
          ? t("moderationOfPoll")
          : t("moderationDecision", {
              action: t(`action_${latest.action}`),
              reason: t(`reason_${latest.reason}`),
              when: at(latest.decidedAt),
            })}
      </p>
      {view === undefined || latest === undefined ? null : (
        <p className="m-0 max-w-prose text-pretty text-muted-foreground">
          {t(`moderationMeans_${view.state}`)}
        </p>
      )}
      {appeals.length === 0 ? null : (
        <ul className="m-0 grid list-none gap-1 p-0">
          {appeals.map((a) => (
            <li key={a.decisionSeq.toString()} suppressHydrationWarning>
              {t("moderationAppealed", {
                seq: a.decisionSeq.toString(),
                when: at(a.filedAt),
                outcome: outcome(a),
              })}
            </li>
          ))}
        </ul>
      )}
      {view?.appealable === true && !confirming ? (
        <p className="m-0">
          <Button
            variant="link"
            className="h-auto px-0"
            aria-describedby={titleId}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("moderationAppeal")}
          </Button>
        </p>
      ) : null}
      {view?.appealable === true && confirming ? (
        <div
          role="group"
          aria-labelledby={`${headingId}-confirm`}
          className="grid gap-4 border-2 border-foreground p-5"
        >
          <p id={`${headingId}-confirm`} className="m-0 max-w-prose font-semibold text-pretty">
            {t("moderationAppealQuestion")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void appeal()}>
              {t("moderationAppealConfirm")}
            </Button>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
              {t("moderationAppealCancel")}
            </Button>
          </div>
        </div>
      ) : null}
      <p className="m-0">
        <a href="/moderation" className="underline underline-offset-4">
          {t("moderationLogLink")}
        </a>
      </p>
      <div role="status">{notice}</div>
      {alert === null ? null : (
        <p role="alert" className="m-0 text-destructive">
          {alert}
        </p>
      )}
    </div>
  );
}
