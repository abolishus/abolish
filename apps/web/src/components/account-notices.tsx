import { useTranslate } from "@abolishus/ui";
import { Label } from "@abolishus/ui/ui/label";
import { Switch } from "@abolishus/ui/ui/switch";
import { useCallback, useEffect, useRef, useState } from "react";

import { FollowResultsError, type NoticeChoicesClient } from "../account/follow-results.ts";
import { type PushClient, PushError, type PushFailure, type PushState } from "../account/push.ts";
import { catalogs, type Messages } from "../messages.ts";
import { Section } from "./page-parts.tsx";

export interface AccountNoticesProps {
  /** This browser's web push subscription. */
  readonly push: PushClient;
  /** Whether results of followed polls reach the account by e-mail. */
  readonly choices: NoticeChoicesClient;
  /** The section's number on the page. */
  readonly index: string;
  /** Called when the session turns out to have ended. */
  readonly onSignedOut?: () => void;
}

/** What the switch row says under it, for each state that has no switch to use. */
const STATE_TEXT: Readonly<Record<Exclude<PushState, "on" | "off">, keyof Messages>> = {
  unsupported: "pushUnsupported",
  unavailable: "pushUnavailable",
  denied: "pushDenied",
};

/**
 * What the account is told, and how (P2-27 parts 3c-1, 3c-2b and 4b).
 * Moderation notices can't be turned off, since an appeal needs the author
 * to know; results of a followed poll ([[P2-25]] part 4c) can, and are on
 * until the account says otherwise. Either goes to the verified address the
 * next day, saying only that there was one (packages/core's
 * `account-notices.ts`, T-73). Turning results off keeps them on this
 * page's list: only the e-mail is left out. The push switch also wakes this
 * browser when the e-mail goes out, with a fixed notice its push service
 * never reads (T-76); it is this browser's alone, so it starts off on every
 * device, while the results choice is the account's, the same on all of them.
 */
export function AccountNotices({ push, choices, index, onSignedOut }: AccountNoticesProps) {
  const t = useTranslate(catalogs);
  const [state, setState] = useState<PushState | undefined>();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<boolean | undefined>();
  const [resultsBusy, setResultsBusy] = useState(false);
  const [failure, setFailure] = useState<PushFailure | undefined>();
  // A switch is disabled while it works, which can drop focus to the
  // page: then it goes back to the switch, so keyboard users keep their place.
  const toggle = useRef<HTMLElement>(null);
  const resultsToggle = useRef<HTMLElement>(null);

  const fail = useCallback(
    (e: unknown) => {
      const why = e instanceof PushError || e instanceof FollowResultsError ? e.failure : "failed";
      setFailure(why);
      if (why === "signedOut") onSignedOut?.();
    },
    [onSignedOut],
  );

  useEffect(() => {
    let live = true;
    push.state().then(
      (s) => live && setState(s),
      (e: unknown) => {
        if (!live) return;
        // Unknown: shown as off, so the switch can try again.
        setState("off");
        fail(e);
      },
    );
    return () => {
      live = false;
    };
  }, [push, fail]);

  useEffect(() => {
    let live = true;
    choices.results().then(
      (on) => live && setResults(on),
      (e: unknown) => live && fail(e),
    );
    return () => {
      live = false;
    };
  }, [choices, fail]);

  const change = async (on: boolean) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await (on ? push.enable() : push.disable());
      setState(on ? "on" : "off");
    } catch (e) {
      // Whatever happened, the browser now says where it stands.
      setState(await push.state().catch(() => "off" as const));
      fail(e);
    } finally {
      setBusy(false);
      const at = document.activeElement;
      if (at === null || at === document.body) toggle.current?.focus();
    }
  };

  const changeResults = async (on: boolean) => {
    setResultsBusy(true);
    setFailure(undefined);
    try {
      await choices.setResults(on);
      setResults(on);
    } catch (e) {
      // Unknown whether it took: read it again rather than guess.
      setResults(await choices.results().catch(() => undefined));
      fail(e);
    } finally {
      setResultsBusy(false);
      const at = document.activeElement;
      if (at === null || at === document.body) resultsToggle.current?.focus();
    }
  };

  const usable = state === "on" || state === "off";

  return (
    <Section
      index={index}
      mark={t("noticesMark")}
      title={t("noticesTitle")}
      id="notices-title"
      lede={<p className="m-0">{t("noticesLede")}</p>}
    >
      <div className="grid max-w-prose gap-4 text-base text-pretty">
        <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
          <li className="grid gap-0.5 border-b border-border py-4">
            <span className="font-semibold">{t("noticesModeration")}</span>
            <span className="text-sm text-muted-foreground">{t("noticesModerationHelp")}</span>
          </li>
          <li className="grid gap-2 border-b border-border py-4">
            <Label className="flex min-h-12 w-full items-center justify-between gap-6 text-base font-normal">
              <span className="grid gap-0.5">
                <span className="font-semibold">{t("noticesResults")}</span>
                <span className="text-sm text-muted-foreground">{t("noticesResultsHelp")}</span>
              </span>
              <Switch
                ref={resultsToggle}
                checked={results === true}
                disabled={results === undefined || resultsBusy}
                onCheckedChange={(checked) => void changeResults(checked)}
              />
            </Label>
            <span role="status" className="min-h-5 text-sm text-muted-foreground">
              {results === undefined ? null : t(results ? "noticesResultsOn" : "noticesResultsOff")}
            </span>
          </li>
          <li className="grid gap-2 border-b border-border py-4">
            <Label className="flex min-h-12 w-full items-center justify-between gap-6 text-base font-normal">
              <span className="grid gap-0.5">
                <span className="font-semibold">{t("pushLabel")}</span>
                <span className="text-sm text-muted-foreground">{t("pushHelp")}</span>
              </span>
              <Switch
                ref={toggle}
                checked={state === "on"}
                disabled={!usable || busy}
                onCheckedChange={(checked) => void change(checked)}
              />
            </Label>
            <span role="status" className="min-h-5 text-sm text-muted-foreground">
              {state === undefined
                ? null
                : usable
                  ? t(state === "on" ? "pushOn" : "pushOff")
                  : t(STATE_TEXT[state])}
            </span>
          </li>
        </ul>
        {failure === undefined ? null : (
          <p role="alert" className="m-0 text-destructive">
            {t(`pushFailure_${failure}`)}
          </p>
        )}
        <p className="m-0">{t("noticesWhen")}</p>
      </div>
    </Section>
  );
}
