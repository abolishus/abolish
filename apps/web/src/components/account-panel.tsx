import { Button, useI18n, useTranslate } from "@abolishus/ui";
import { useCallback, useEffect, useState } from "react";

import { AccountError, type AccountClient, type PasskeyView } from "../account/client.ts";
import { catalogs } from "../messages.ts";
import { formatUtc } from "./format.ts";

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "signed-out" }
  | { readonly kind: "signed-in"; readonly passkeys: readonly PasskeyView[] };

type Notice = "cancelled" | "unsupported" | "failed" | "signedOutOthers" | "passkeyAdded";

export interface AccountPanelProps {
  readonly client: AccountClient;
}

/**
 * Creating an account, signing in and out, and managing its passkeys. An
 * account is for creating and moderating polls; it never votes, and nothing
 * here can name a ballot (T-10). Votes are cast only in the ballot client,
 * with a voting identity kept on the device under its own passkey (ADR 0017).
 */
export function AccountPanel({ client }: AccountPanelProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = useCallback(async () => {
    if (!(await client.signedIn())) return setView({ kind: "signed-out" });
    setView({ kind: "signed-in", passkeys: await client.passkeys() });
  }, [client]);

  useEffect(() => {
    refresh().catch(() => {
      setView({ kind: "signed-out" });
      setNotice("failed");
    });
  }, [refresh]);

  /** Runs one action, then shows the account as the server now has it. */
  const act = (action: () => Promise<void>, done?: Notice) => async () => {
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
    }
  };

  return (
    <section aria-labelledby="account-title" aria-busy={busy} className="grid max-w-prose gap-6">
      <h1 id="account-title" className="text-3xl font-semibold">
        {t("accountTitle")}
      </h1>
      <p className="text-muted-foreground">{t("accountLede")}</p>
      {view.kind === "loading" ? (
        <noscript>
          <p>{t("accountNeedsScript")}</p>
        </noscript>
      ) : null}
      {view.kind === "signed-out" ? (
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={act(() => client.signUp())}>
            {t("accountSignUp")}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={act(() => client.signIn())}>
            {t("accountSignIn")}
          </Button>
        </div>
      ) : null}
      {view.kind === "signed-in" ? (
        <>
          <p>{t("accountSignedIn")}</p>
          <section aria-labelledby="passkeys-title" className="grid gap-3">
            <h2 id="passkeys-title" className="text-xl font-semibold">
              {t("passkeysTitle")}
            </h2>
            <ul className="grid gap-2">
              {view.passkeys.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3"
                >
                  <span suppressHydrationWarning>
                    {t(p.backedUp ? "passkeySynced" : "passkeyDevice", {
                      created: formatUtc(locale, new Date(p.createdAt)),
                    })}
                  </span>
                  {/* The last passkey stays: without one, nobody can sign in again. */}
                  {view.passkeys.length > 1 ? (
                    <Button
                      variant="quiet"
                      disabled={busy}
                      onClick={act(() => client.removePasskey(p.id))}
                    >
                      {t("passkeyRemove")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
            <div>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={act(() => client.addPasskey(), "passkeyAdded")}
              >
                {t("passkeyAdd")}
              </Button>
            </div>
          </section>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" disabled={busy} onClick={act(() => client.signOut())}>
              {t("accountSignOut")}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={act(() => client.signOutOthers(), "signedOutOthers")}
            >
              {t("accountSignOutOthers")}
            </Button>
          </div>
          <section aria-labelledby="delete-title" className="grid gap-3">
            <h2 id="delete-title" className="text-xl font-semibold">
              {t("accountDeleteTitle")}
            </h2>
            <p>{t("accountDeleteLede")}</p>
            {confirmDelete ? (
              <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={act(() => client.deleteAccount())}>
                  {t("accountDeleteConfirm")}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  {t("accountDeleteCancel")}
                </Button>
              </div>
            ) : (
              <div>
                <Button variant="secondary" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  {t("accountDelete")}
                </Button>
              </div>
            )}
          </section>
        </>
      ) : null}
      <div role="status" className="min-h-6">
        {notice === "signedOutOthers" || notice === "passkeyAdded" ? t(notice) : null}
      </div>
      {notice === "cancelled" || notice === "unsupported" || notice === "failed" ? (
        <p role="alert" className="m-0 text-destructive">
          {t(`accountFailure_${notice}`)}
        </p>
      ) : null}
    </section>
  );
}
