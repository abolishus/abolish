import { Button, useTranslate } from "@abolishus/ui";
import { useEffect, useRef, useState } from "react";

import { type FollowsClient, FollowsError, type FollowsFailure } from "../account/follows.ts";
import { catalogs, type Messages } from "../messages.ts";

export interface PollFollowProps {
  /** The poll's election ID, as its page's path spells it. */
  electionId: string;
  client: FollowsClient;
}

const FAILURE = {
  signedOut: "followSignedOut",
  unverified: "followUnverified",
  hidden: "followHidden",
  tooManyThisHour: "followTooManyThisHour",
  failed: "followFailed",
} as const satisfies Record<FollowsFailure, keyof Messages>;

const LINK = "font-medium underline underline-offset-4 focus-text";

/**
 * Following a poll, on the website's poll page ([[P2-25]] part 4b): a
 * signed-in account follows it, to be told when its results land, and can
 * stop. T-10, T-11: offered alike whether or not this browser answered,
 * never in the ballot client and never prompted by answering, so a follow
 * says nothing about participation. The page's server holds no account
 * session (src/node/serve.ts) and this reads nothing on its own: the account
 * is named beside the poll only when the visitor presses a button, so
 * opening the page tells the server nothing about which account opened it.
 * The cost is that an account already following is first offered to follow,
 * which changes nothing and then offers to stop.
 */
export function PollFollow({ electionId, client }: PollFollowProps) {
  const t = useTranslate(catalogs);
  /** Whether the account follows the poll, once it has said; until then, unknown. */
  const [following, setFollowing] = useState<boolean | undefined>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FollowsFailure | undefined>();
  const button = useRef<HTMLButtonElement>(null);
  /** How many presses have settled. */
  const [settled, setSettled] = useState(0);

  // Disabled while its call runs, the button drops focus to the page: once
  // the call settles it gets it back, whatever it now offers.
  useEffect(() => {
    if (settled > 0) button.current?.focus();
  }, [settled]);

  const set = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      setFollowing(await client.set(electionId, on));
    } catch (e) {
      const f = e instanceof FollowsError ? e.failure : "failed";
      // Signed out, or the session ended since: what it follows is unknown again.
      if (f === "signedOut") setFollowing(undefined);
      setFailure(f);
    } finally {
      setBusy(false);
      setSettled((n) => n + 1);
    }
  };

  return (
    <section aria-labelledby="follow-title" aria-busy={busy} className="grid max-w-3xl gap-4">
      <h2 id="follow-title" className="m-0 font-heading text-2xl font-semibold">
        {t("followTitle")}
      </h2>
      <p className="m-0 max-w-prose text-base text-pretty">{t("followLede")}</p>
      {following === undefined ? null : (
        <p role="status" className="m-0 text-base">
          {t(following ? "followFollowing" : "followStopped")}
        </p>
      )}
      <Button
        ref={button}
        size="lg"
        variant="outline"
        className="justify-self-start"
        disabled={busy}
        onClick={() => void set(following !== true)}
      >
        {t(following === true ? "followStop" : "followJoin")}
      </Button>
      <p className="m-0 text-sm text-muted-foreground">{t("followPrivacy")}</p>
      {failure === undefined ? null : (
        <p role="alert" className="m-0">
          {t(FAILURE[failure])}{" "}
          {failure === "unverified" ? (
            <a className={LINK} href="/account/verify">
              {t("followVerify")}
            </a>
          ) : failure === "signedOut" ? (
            <a className={LINK} href="/account">
              {t("followSignIn")}
            </a>
          ) : null}
        </p>
      )}
    </section>
  );
}
