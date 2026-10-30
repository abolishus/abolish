import { useTranslate } from "@abolishus/ui";
import { Checkbox } from "@abolishus/ui/ui/checkbox";
import { Label } from "@abolishus/ui/ui/label";
import { useEffect, useId, useState } from "react";

import { type OwnProfileView, ProfilesError, type ProfilesClient } from "../account/profiles.ts";
import { catalogs } from "../messages.ts";

type Done = "profileChoiceShown" | "profileChoiceShownOnceOpen" | "profileChoiceUnshown";
/** `show` refuses only these: the session ended, or the profile or poll is gone. */
type Failure = "signedOut" | "changed" | "failed";

export interface ProfileChoiceProps {
  readonly client: ProfilesClient;
  /** The account's profile, as last read. */
  readonly profile: OwnProfileView;
  /** The poll, once it is saved; none for a new poll's form before its first save. */
  readonly pollId: string | undefined;
  /** Before the first save: whether the poll is to be shown once it is saved. */
  readonly wanted?: boolean;
  /** Before the first save: the author's choice, which the form applies after saving. */
  readonly onWant?: (on: boolean) => void;
  /** A saved poll that hasn't opened yet, and may yet: the profile shows it only once it opens. */
  readonly unopened?: boolean;
  /** Help said once for a list of boxes, which describes this one; none to draw the box's own. */
  readonly helpId?: string;
  /** The element naming the poll, so each row's box says which poll it is. */
  readonly describedBy?: string;
  /** Called after every change sent, refused or not, so the page reads the profile again. */
  readonly onChanged?: () => void;
  /** Called when the session turns out to have ended. */
  readonly onSignedOut?: () => void;
}

/**
 * Whether the author's profile shows one of their polls
 * ([[0040-creator-profiles]]; P2-27 part 1d-3): a box the author ticks,
 * poll by poll, which is the only way a poll comes to say who asked it. It
 * sends the poll's ID and the choice, never a handle or anything about
 * answering (T-10); the server takes only the author's own polls. The
 * profile's name is laid out on its own (T-75).
 */
export function ProfileChoice({
  client,
  profile,
  pollId,
  wanted = false,
  onWant,
  unopened = false,
  helpId,
  describedBy,
  onChanged,
  onSignedOut,
}: ProfileChoiceProps) {
  const t = useTranslate(catalogs);
  const id = useId();
  const stored = pollId === undefined ? wanted : profile.pollIds.includes(pollId);
  // What the box shows while a change is on its way, then what the server has.
  const [checked, setChecked] = useState(stored);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | undefined>();
  const [failure, setFailure] = useState<Failure | undefined>();

  useEffect(() => setChecked(stored), [stored]);

  const choose = async (on: boolean) => {
    setDone(undefined);
    setFailure(undefined);
    setChecked(on);
    if (pollId === undefined) return onWant?.(on);
    setBusy(true);
    try {
      await client.show(pollId, on);
      // The public profile lists only registered polls, so a tick on one not yet open is a promise.
      setDone(
        on
          ? unopened
            ? "profileChoiceShownOnceOpen"
            : "profileChoiceShown"
          : "profileChoiceUnshown",
      );
    } catch (e) {
      const why: Failure =
        e instanceof ProfilesError && (e.failure === "signedOut" || e.failure === "changed")
          ? e.failure
          : "failed";
      setChecked(stored);
      setFailure(why);
      if (why === "signedOut") onSignedOut?.();
    } finally {
      setBusy(false);
      // Even a refusal can mean the profile changed elsewhere: read it again.
      onChanged?.();
    }
  };

  const help = helpId ?? `${id}-help`;
  return (
    <div className="grid gap-1">
      <Label className="flex min-h-12 items-center gap-3 text-base font-normal">
        <Checkbox
          className="size-5"
          checked={checked}
          disabled={busy}
          aria-describedby={describedBy === undefined ? help : `${describedBy} ${help}`}
          onCheckedChange={(on) => void choose(on)}
        />
        <span>
          {t("profileChoiceLabel")} <bdi className="font-semibold">{profile.name}</bdi>
        </span>
      </Label>
      {helpId === undefined ? (
        <p id={help} className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
          {t(
            pollId === undefined
              ? "profileChoiceHelpUnsaved"
              : unopened
                ? "profileChoiceHelpUnopened"
                : "profileChoiceHelp",
          )}
        </p>
      ) : null}
      <div role="status" className="text-sm">
        {done === undefined ? null : t(done)}
      </div>
      {failure === undefined ? null : (
        <p role="alert" className="m-0 text-sm text-destructive">
          {t(`profileChoiceFailure_${failure}`)}
        </p>
      )}
    </div>
  );
}
