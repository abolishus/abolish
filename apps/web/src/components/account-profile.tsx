import { Button, useI18n, useTranslate } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { EyeOff, type LucideIcon, RotateCcw, UserRound } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from "react";

import {
  type OwnProfileView,
  type ProfileAppealView,
  type ProfileModerationView,
  ProfilesError,
  type ProfilesClient,
  type ProfilesFailure,
} from "../account/profiles.ts";
import { catalogs } from "../messages.ts";
import { formatUtc } from "./format.ts";
import { Section } from "./page-parts.tsx";

const FIELD = "min-h-12 px-3 text-base md:text-base";

const ACTION_ICON = {
  hide: EyeOff,
  restore: RotateCcw,
} as const satisfies Record<NonNullable<ProfileModerationView["latest"]>["action"], LucideIcon>;

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "none" }
  | {
      readonly kind: "profile";
      readonly profile: OwnProfileView;
      /** None if it couldn't be read: the profile still shows. */
      readonly moderation: ProfileModerationView | undefined;
    };

type Done =
  | "profileMade"
  | "profileRenamed"
  | "profileSameName"
  | "profileDeleted"
  | "profileAppealed";
type Failure = ProfilesFailure | "unloaded";

/** Which question waits for its second click. */
type Confirming = "delete" | "appeal" | undefined;

export interface AccountProfileProps {
  readonly client: ProfilesClient;
  /** The section's number on the page. */
  readonly index: string;
  /** Whether this deployment verifies a phone, which making a profile needs. */
  readonly phone: boolean;
  /** Called when the session turns out to have ended. */
  readonly onSignedOut?: () => void;
}

/**
 * The account's public profile, which it may have or not
 * ([[0040-creator-profiles]]): making it under a name, renaming it once a
 * UTC day, deleting it, and what moderation decided about it with the
 * author's appeal. Its handle is shown, never chosen. Which polls it shows
 * is chosen poll by poll, not here. Nothing here is about answering a poll,
 * and the profile names nothing of the account (T-10, T-75).
 */
export function AccountProfile({ client, index, phone, onSignedOut }: AccountProfileProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(true);
  const [done, setDone] = useState<Done | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();
  const [confirming, setConfirming] = useState<Confirming>();
  // The name being typed, while the form is open: making, or renaming.
  const [name, setName] = useState<string | undefined>();
  // An action replaces the controls that had focus: focus goes back to the
  // section's heading, so keyboard users keep their place.
  const heading = useRef<HTMLHeadingElement>(null);
  const fieldId = useId();
  const failureId = `${fieldId}-failure`;

  const refresh = useCallback(async () => {
    const profile = await client.own();
    if (profile === undefined) return setView({ kind: "none" });
    // The moderation is read apart, so a failure there still shows the profile.
    const moderation = await client.moderation().catch(() => undefined);
    setView({ kind: "profile", profile, moderation });
  }, [client]);

  const failed = useCallback(
    (e: unknown, otherwise: Failure) => {
      const why = e instanceof ProfilesError && e.failure !== "failed" ? e.failure : otherwise;
      setFailure(why);
      if (why === "signedOut") onSignedOut?.();
    },
    [onSignedOut],
  );

  useEffect(() => {
    refresh()
      .catch((e: unknown) => failed(e, "unloaded"))
      .finally(() => setBusy(false));
  }, [refresh, failed]);

  /**
   * Runs one action, then shows the profile as the server now has it. The
   * form stays open, with what was typed, only when the name was refused.
   */
  const act = async (action: () => Promise<Done>) => {
    setBusy(true);
    setDone(undefined);
    setFailure(undefined);
    setConfirming(undefined);
    let keepForm = false;
    try {
      setDone(await action());
      setName(undefined);
    } catch (e) {
      failed(e, "failed");
      keepForm = e instanceof ProfilesError && e.failure === "invalidName";
      if (!keepForm) setName(undefined);
    }
    try {
      await refresh();
    } catch (e) {
      failed(e, "unloaded");
    } finally {
      setBusy(false);
      if (!keepForm) heading.current?.focus();
    }
  };

  const submit = (e: FormEvent, make: boolean) => {
    e.preventDefault();
    const typed = name ?? "";
    void act(async () => {
      if (make) {
        await client.make(typed);
        return "profileMade";
      }
      return (await client.rename(typed)) ? "profileRenamed" : "profileSameName";
    });
  };

  const at = (iso: string) => formatUtc(locale, new Date(iso));
  const nameInvalid = failure === "invalidName";

  const nameForm = (make: boolean) => (
    <form noValidate onSubmit={(e) => submit(e, make)} className="grid max-w-prose gap-4">
      <div className="grid gap-2">
        <Label htmlFor={fieldId} className="text-base font-semibold">
          {t("profileNameLabel")}
        </Label>
        <p id={`${fieldId}-help`} className="m-0 text-sm text-pretty text-muted-foreground">
          {t("profileNameHelp")}
        </p>
        <Input
          id={fieldId}
          className={FIELD}
          // T-75: a right-to-left name is laid out on its own, never reordering the page.
          dir="auto"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={nameInvalid ? `${fieldId}-help ${failureId}` : `${fieldId}-help`}
          aria-invalid={nameInvalid ? true : undefined}
          disabled={busy}
          value={name ?? ""}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="lg" disabled={busy}>
          {t(make ? "profileMake" : "profileRenameSave")}
        </Button>
        {make ? null : (
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setName(undefined);
              setFailure(undefined);
            }}
          >
            {t("profileRenameCancel")}
          </Button>
        )}
      </div>
    </form>
  );

  const outcome = (a: ProfileAppealView) =>
    a.outcome === undefined || a.reviewedAt === undefined
      ? t("moderationAppealPending")
      : t(`profileAppeal_${a.outcome}`, { when: at(a.reviewedAt) });

  const moderation = (m: ProfileModerationView) => {
    const latest = m.latest;
    // A profile nothing was ever decided about shows nothing here.
    if (latest === undefined && m.appeals.length === 0) return null;
    const Icon = latest === undefined ? undefined : ACTION_ICON[latest.action];
    return (
      <div
        role="group"
        aria-labelledby="profile-moderation"
        className="grid gap-3 border-s-2 border-foreground ps-4 text-sm"
      >
        <p
          id="profile-moderation"
          className="m-0 flex items-center gap-2 font-semibold"
          suppressHydrationWarning
        >
          {Icon === undefined ? null : <Icon aria-hidden="true" className="size-4 shrink-0" />}
          {latest === undefined
            ? t("moderationOfPoll")
            : t("moderationDecision", {
                action: t(latest.action === "hide" ? "profileAction_hide" : "action_restore"),
                reason: t(`reason_${latest.reason}`),
                when: at(latest.decidedAt),
              })}
        </p>
        {latest === undefined ? null : (
          <p className="m-0 max-w-prose text-pretty text-muted-foreground">
            {t(`profileMeans_${m.state}`)}
          </p>
        )}
        {m.appeals.length === 0 ? null : (
          <ul className="m-0 grid list-none gap-1 p-0">
            {m.appeals.map((a) => (
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
        {m.appealable && confirming !== "appeal" ? (
          <p className="m-0">
            <Button
              variant="link"
              className="h-auto px-0"
              disabled={busy}
              onClick={() => setConfirming("appeal")}
            >
              {t("moderationAppeal")}
            </Button>
          </p>
        ) : null}
        {m.appealable && confirming === "appeal" ? (
          <div
            role="group"
            aria-labelledby="profile-appeal-confirm"
            className="grid gap-4 border-2 border-foreground p-5"
          >
            <p id="profile-appeal-confirm" className="m-0 max-w-prose font-semibold text-pretty">
              {t("moderationAppealQuestion")}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await client.appeal();
                    return "profileAppealed";
                  })
                }
              >
                {t("moderationAppealConfirm")}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setConfirming(undefined)}>
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
      </div>
    );
  };

  const profile = (p: OwnProfileView, m: ProfileModerationView | undefined) => {
    const hidden = m?.state === "hidden";
    return (
      <div className="grid gap-6">
        <dl className="m-0 grid border-t-2 border-foreground md:grid-cols-[12rem_minmax(0,1fr)]">
          <dt className="pt-4 text-sm font-semibold md:border-b md:border-border md:pb-4">
            {t("profileName")}
          </dt>
          <dd className="m-0 border-b border-border pb-4 text-lg break-words md:pt-4">
            {/* T-75: isolated, so a right-to-left name can't reorder the text around it. */}
            <bdi>{p.name}</bdi>
          </dd>
          <dt className="pt-4 text-sm font-semibold md:border-b md:border-border md:pb-4">
            {t("profileAddress")}
          </dt>
          <dd className="m-0 grid gap-1 border-b border-border pb-4 md:pt-4">
            <span className="font-mono text-sm break-all">/by/{p.handle}</span>
            <span className="text-sm text-muted-foreground">{t("profileAddressHelp")}</span>
          </dd>
          <dt className="pt-4 text-sm font-semibold md:border-b md:border-border md:pb-4">
            {t("profilePolls")}
          </dt>
          <dd className="m-0 border-b border-border pb-4 text-base md:pt-4">
            {p.pollIds.length === 0
              ? t("profilePollsNone")
              : t("profilePollsSome", { count: p.pollIds.length.toString() })}
          </dd>
        </dl>

        {m === undefined ? (
          <p className="m-0 text-sm text-destructive">{t("profileFailure_moderationUnloaded")}</p>
        ) : (
          moderation(m)
        )}

        {name !== undefined ? (
          nameForm(false)
        ) : hidden ? (
          <p className="m-0 max-w-prose text-sm text-muted-foreground">
            {t("profileRenameHidden")}
          </p>
        ) : p.renamableOn !== undefined ? (
          <p className="m-0 max-w-prose text-sm text-muted-foreground" suppressHydrationWarning>
            {t("profileRenameOn", { day: p.renamableOn })}
          </p>
        ) : (
          <div>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setName(p.name);
                setDone(undefined);
                setFailure(undefined);
              }}
            >
              {t("profileRename")}
            </Button>
          </div>
        )}

        {confirming === "delete" ? (
          <div
            role="group"
            aria-labelledby="profile-delete-confirm"
            className="grid max-w-prose gap-4 border-2 border-destructive p-5"
          >
            <p id="profile-delete-confirm" className="m-0 font-semibold">
              {t("profileDeleteQuestion")}
            </p>
            <p className="m-0 text-sm text-pretty">{t("profileDeleteMeans")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await client.remove();
                    return "profileDeleted";
                  })
                }
              >
                {t("profileDeleteConfirm")}
              </Button>
              <Button variant="outline" disabled={busy} onClick={() => setConfirming(undefined)}>
                {t("profileDeleteCancel")}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirming("delete");
                setDone(undefined);
              }}
            >
              {t("profileDelete")}
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <Section
      index={index}
      mark={t("profileMark")}
      title={t("profileTitle")}
      id="profile-title"
      titleRef={heading}
      lede={<p className="m-0">{t("profileLede")}</p>}
    >
      <div aria-busy={busy} className="grid gap-4">
        {view.kind === "none" ? (
          <div className="grid gap-6 border-t-2 border-foreground pt-6">
            <p className="m-0 flex max-w-prose items-start gap-3 text-base text-pretty">
              <UserRound aria-hidden="true" className="mt-1 size-5 shrink-0" />
              {t("profileNone")}
            </p>
            {phone ? (
              nameForm(true)
            ) : (
              <p className="m-0 max-w-prose text-base text-muted-foreground">
                {t("profileNeedsPhoneHere")}
              </p>
            )}
          </div>
        ) : null}
        {view.kind === "profile" ? profile(view.profile, view.moderation) : null}
        <div role="status" className="min-h-6 text-base">
          {done === undefined ? null : t(done)}
        </div>
        {failure === undefined ? null : (
          <p id={failureId} role="alert" className="m-0 text-destructive">
            {t(`profileFailure_${failure}`)}
            {failure === "phoneUnverified" ? (
              <>
                {" "}
                <a href="/account/verify" className="underline underline-offset-4">
                  {t("profileVerifyPhone")}
                </a>
              </>
            ) : null}
          </p>
        )}
      </div>
    </Section>
  );
}
