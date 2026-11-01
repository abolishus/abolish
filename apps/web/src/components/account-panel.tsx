import { Button, useI18n, useTranslate } from "@abolishus/ui";
import { Cloud, KeyRound, Server, Smartphone, UserPlus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import {
  AccountError,
  type AccountClient,
  type AccountFailure,
  type PasskeyView,
} from "../account/client.ts";
import type { DraftsClient } from "../account/drafts.ts";
import type { ExportClient } from "../account/export.ts";
import type { FollowResultsClient, NoticeChoicesClient } from "../account/follow-results.ts";
import type { PushClient } from "../account/push.ts";
import type { ProfilesClient } from "../account/profiles.ts";
import type { VerifyClient } from "../account/verify.ts";
import { catalogs, type Messages } from "../messages.ts";
import { AccountExport } from "./account-export.tsx";
import { AccountFollowResults } from "./account-follow-results.tsx";
import { AccountNotices } from "./account-notices.tsx";
import { AccountPolls } from "./account-polls.tsx";
import { AccountProfile } from "./account-profile.tsx";
import { AccountVerification } from "./account-verify.tsx";
import { formatUtc } from "./format.ts";
import { PageHeader, Section } from "./page-parts.tsx";

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "signed-in"; readonly passkeys: readonly PasskeyView[] };

/** What an action did, announced politely. */
type Done =
  | "signedIn"
  | "signedOut"
  | "signedOutOthers"
  | "passkeyAdded"
  | "passkeyRemoved"
  | "accountDeleted";

type Notice = Done | AccountFailure;

const isFailure = (n: Notice): n is AccountFailure =>
  n === "cancelled" || n === "unsupported" || n === "failed";

const RULED = "m-0 grid list-none border-t border-foreground p-0";

/**
 * The account on our servers beside the voting identity on the device, with
 * nothing joining them (T-10): what each holds, as the design keeps it. The
 * phone's line only where this deployment verifies phones.
 */
function Separation({ phone }: { phone: boolean }) {
  const t = useTranslate(catalogs);
  const side = (
    icon: ReactNode,
    where: keyof Messages,
    title: keyof Messages,
    items: readonly (keyof Messages)[],
    note: keyof Messages,
  ) => (
    <div className="grid content-start gap-4 py-6 md:px-8 md:first:ps-0 md:last:pe-0">
      <p className="m-0 flex items-center gap-2 font-mono text-xs tracking-widest uppercase">
        <span aria-hidden="true">{icon}</span>
        {t(where)}
      </p>
      <h3 className="m-0 font-heading text-2xl font-semibold">{t(title)}</h3>
      <ul className={RULED}>
        {items.map((item) => (
          <li key={item} className="border-b border-border py-3 text-base">
            {t(item)}
          </li>
        ))}
      </ul>
      <p className="m-0 text-sm text-muted-foreground">{t(note)}</p>
    </div>
  );
  return (
    <div className="grid border-t-2 border-foreground md:grid-cols-[1fr_auto_1fr]">
      {side(
        <Server className="size-4" />,
        "separationServer",
        "separationAccount",
        [
          "separationAccount_passkeys",
          "separationAccount_sessions",
          "separationAccount_email",
          ...(phone ? (["separationAccount_phone"] as const) : []),
        ],
        "separationAccountNote",
      )}
      <div className="flex items-center gap-3 border-y border-border py-3 md:flex-col md:justify-center md:border-y-0 md:border-x md:px-3 md:py-0">
        <span aria-hidden="true" className="h-px flex-1 bg-foreground md:h-auto md:w-px" />
        <span className="font-mono text-xs tracking-widest uppercase md:[writing-mode:vertical-rl]">
          {t("separationNeverJoined")}
        </span>
        <span aria-hidden="true" className="h-px flex-1 bg-foreground md:h-auto md:w-px" />
      </div>
      {side(
        <Smartphone className="size-4" />,
        "separationDevice",
        "separationIdentity",
        ["separationIdentity_secret", "separationIdentity_receipts"],
        "separationIdentityNote",
      )}
    </div>
  );
}

export interface AccountPanelProps {
  readonly client: AccountClient;
  /** The signed-in account's polls. */
  readonly drafts: DraftsClient;
  /** The signed-in account's public profile. */
  readonly profiles: ProfilesClient;
  /** The signed-in account's e-mail and phone. */
  readonly verify: VerifyClient;
  /** The signed-in account's own data, to download. */
  readonly accountExport: ExportClient;
  /** This browser's web push subscription. */
  readonly push: PushClient;
  /** The polls the account followed whose results are in. */
  readonly followResults: FollowResultsClient;
  /** Whether results of followed polls reach the account by e-mail. */
  readonly noticeChoices: NoticeChoicesClient;
  /** Whether this deployment verifies a phone before an account votes. */
  readonly phone: boolean;
  /**
   * Set when the visitor came to ask a question (home's "Ask a question"):
   * the page asks them to sign in for that, and once they are, calls this
   * to go on to a new poll's form instead of showing the account.
   */
  readonly ask?: (() => void) | undefined;
}

/**
 * Creating an account, signing in and out, and managing its passkeys. An
 * account is for creating and moderating polls; it never votes, and nothing
 * here can name a ballot (T-10). Votes are cast only in the ballot client,
 * with a voting identity kept on the device under its own passkey (ADR 0017).
 */
export function AccountPanel({
  client,
  drafts,
  profiles,
  verify,
  accountExport,
  push,
  followResults,
  noticeChoices,
  phone,
  ask,
}: AccountPanelProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [view, setView] = useState<View>({ kind: "loading" });
  // Busy until the session is known, so assistive technology waits for it.
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The polls' choices and the profile section each read the profile: a
  // change in one has the other read it again.
  const [pollsRevision, setPollsRevision] = useState(0);
  const [profileRevision, setProfileRevision] = useState(0);
  // An action disables the button that had focus, and may replace it: focus
  // goes back to the heading, so keyboard users keep their place.
  const heading = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(async () => {
    if (!(await client.signedIn())) return setView({ kind: "signed-out" });
    if (ask !== undefined) return ask();
    setView({ kind: "signed-in", passkeys: await client.passkeys() });
  }, [client, ask]);

  useEffect(() => {
    refresh()
      .catch(() => {
        setView({ kind: "signed-out" });
        setNotice("failed");
      })
      .finally(() => setBusy(false));
  }, [refresh]);

  /** Runs one action, then shows the account as the server now has it. */
  const act = (action: () => Promise<void>, done?: Done) => async () => {
    setBusy(true);
    setNotice(undefined);
    try {
      await action();
      setConfirmDelete(false);
      if (done !== undefined) setNotice(done);
    } catch (e) {
      setNotice(e instanceof AccountError ? e.failure : "failed");
    }
    try {
      await refresh();
    } catch {
      setNotice("failed");
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  };

  // Stable, so the polls list doesn't reload each time the panel renders.
  const signedOut = useCallback(() => setView({ kind: "signed-out" }), []);

  const signedIn = view.kind === "signed-in";
  const added = (p: PasskeyView) => formatUtc(locale, new Date(p.createdAt));

  return (
    <section aria-labelledby="account-title" aria-busy={busy} className="grid gap-16">
      <PageHeader
        eyebrow={t(signedIn ? "accountEyebrowSignedIn" : "accountEyebrow")}
        title={t(signedIn ? "accountTitleSignedIn" : ask ? "accountTitleAsk" : "accountTitle")}
        titleId="account-title"
        titleRef={heading}
        lede={t(signedIn ? "accountLedeSignedIn" : ask ? "accountLedeAsk" : "accountLede")}
      >
        {signedIn ? (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={act(() => client.signOut(), "signedOut")}
            >
              {t("accountSignOut")}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={act(() => client.signOutOthers(), "signedOutOthers")}
            >
              {t("accountSignOutOthers")}
            </Button>
          </div>
        ) : null}
      </PageHeader>

      <div className="grid gap-4">
        {view.kind === "loading" ? (
          <noscript>
            <p className="m-0 text-lg">{t("accountNeedsScript")}</p>
          </noscript>
        ) : null}
        {view.kind === "signed-out" ? (
          <div className="grid border-t-2 border-foreground md:grid-cols-2">
            <div className="grid content-start gap-4 border-b border-border py-8 md:border-e md:border-b-0 md:pe-8">
              <h2 className="m-0 text-2xl font-semibold">{t("accountHaveOne")}</h2>
              <p className="m-0 max-w-prose text-base">{t("accountHaveOneLede")}</p>
              <div>
                <Button size="lg" disabled={busy} onClick={act(() => client.signIn(), "signedIn")}>
                  <KeyRound aria-hidden="true" data-icon="inline-start" />
                  {t("accountSignIn")}
                </Button>
              </div>
            </div>
            <div className="grid content-start gap-4 py-8 md:ps-8">
              <h2 className="m-0 text-2xl font-semibold">{t("accountNew")}</h2>
              <p className="m-0 max-w-prose text-base">{t("accountNewLede")}</p>
              <div>
                <Button
                  size="lg"
                  variant="outline"
                  disabled={busy}
                  onClick={act(() => client.signUp(), "signedIn")}
                >
                  <UserPlus aria-hidden="true" data-icon="inline-start" />
                  {t("accountSignUp")}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <div role="status" className="min-h-6 text-base">
          {notice !== undefined && !isFailure(notice) ? t(notice) : null}
        </div>
        {notice !== undefined && isFailure(notice) ? (
          <p role="alert" className="m-0 text-destructive">
            {t(
              notice === "failed" && view.kind !== "signed-in"
                ? "accountFailure_failedSignedOut"
                : `accountFailure_${notice}`,
            )}
          </p>
        ) : null}
      </div>

      {view.kind === "signed-in" ? (
        <>
          {/* First, so an account that hasn't verified sees it at sign-in (P2-31 part 4). */}
          <AccountVerification client={verify} index="01" phone={phone} />
          <AccountPolls
            client={drafts}
            index="02"
            onSignedOut={signedOut}
            phoneVerification={phone}
            profiles={profiles}
            profileRevision={pollsRevision}
            onProfileChanged={() => setProfileRevision((n) => n + 1)}
          />
          <AccountProfile
            client={profiles}
            index="03"
            phone={phone}
            onSignedOut={signedOut}
            revision={profileRevision}
            onChanged={() => setPollsRevision((n) => n + 1)}
          />
          <AccountNotices push={push} choices={noticeChoices} index="04" onSignedOut={signedOut} />
          {/* Beside the notices, since the results e-mail sends the account here to see which poll (T-73). */}
          <AccountFollowResults client={followResults} index="05" onSignedOut={signedOut} />
          <Section
            index="06"
            mark={t("passkeysTitle")}
            title={t("passkeysHeading")}
            id="passkeys-title"
            lede={<p className="m-0">{t("passkeysLede")}</p>}
          >
            <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
              {view.passkeys.map((p) => (
                <li
                  key={p.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 border-b border-border py-4 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,16rem)_auto]"
                >
                  <span aria-hidden="true">
                    {p.backedUp ? <Cloud className="size-5" /> : <KeyRound className="size-5" />}
                  </span>
                  <span className="grid gap-0.5">
                    <span className="font-semibold">
                      {t(p.backedUp ? "passkeySynced" : "passkeyDevice")}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t(p.backedUp ? "passkeySyncedHelp" : "passkeyDeviceHelp")}
                    </span>
                  </span>
                  <span
                    className="col-start-2 font-mono text-xs md:col-start-auto"
                    suppressHydrationWarning
                  >
                    {t("passkeyAddedAt", { created: added(p) })}
                  </span>
                  <span className="col-start-2 md:col-start-auto">
                    {/* The last passkey stays: without one, nobody can sign in again. */}
                    {view.passkeys.length > 1 ? (
                      <Button
                        variant="link"
                        className="px-0 md:px-5"
                        disabled={busy}
                        onClick={act(() => client.removePasskey(p.id), "passkeyRemoved")}
                      >
                        {t("passkeyRemove")}
                        <span className="sr-only" suppressHydrationWarning>
                          {" "}
                          {t("passkeyRemoveWhich", { created: added(p) })}
                        </span>
                      </Button>
                    ) : (
                      <span className="text-sm text-muted-foreground">{t("passkeyLast")}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
            <div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={act(() => client.addPasskey(), "passkeyAdded")}
              >
                <KeyRound aria-hidden="true" data-icon="inline-start" />
                {t("passkeyAdd")}
              </Button>
            </div>
          </Section>

          <AccountExport client={accountExport} index="07" onSignedOut={signedOut} />

          <Section
            index="08"
            mark={t("accountDeleteMark")}
            title={t("accountDeleteTitle")}
            id="delete-title"
          >
            <div className="grid max-w-prose gap-4 text-base text-pretty">
              <p className="m-0">{t("accountDeleteLede")}</p>
              <p className="m-0">{t("accountDeleteStays")}</p>
              {confirmDelete ? (
                <div
                  role="group"
                  aria-labelledby="delete-confirm"
                  className="grid gap-4 border-2 border-destructive p-5"
                >
                  <p id="delete-confirm" className="m-0 font-semibold">
                    {t("accountDeleteQuestion")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={act(() => client.deleteAccount(), "accountDeleted")}
                    >
                      {t("accountDeleteConfirm")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmDelete(false)}
                    >
                      {t("accountDeleteCancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <div>
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {t("accountDelete")}
                  </Button>
                </div>
              )}
            </div>
          </Section>
        </>
      ) : (
        <Section
          index="01"
          mark={t("separationMark")}
          title={t("separationTitle")}
          id="separate-title"
          lede={<p className="m-0">{t("separationLede")}</p>}
        >
          <Separation phone={phone} />
        </Section>
      )}
    </section>
  );
}
