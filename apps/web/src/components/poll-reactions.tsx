import { Button, useTranslate } from "@abolishus/ui";
import { Toggle } from "@abolishus/ui/ui/toggle";
import { useEffect, useRef, useState } from "react";

import {
  type Reaction,
  type ReactionCounts,
  REACTIONS,
  type ReactionsClient,
  ReactionsError,
  type ReactionsFailure,
} from "../account/reactions.ts";
import { catalogs, type Messages } from "../messages.ts";

export interface PollReactionsProps {
  /** The poll's election ID, as its page's path spells it. */
  electionId: string;
  client: ReactionsClient;
}

/**
 * Each reaction as the website draws it ([[P2-25]] part 5a: stored by name,
 * drawn here). The glyph is decoration: its name is the text beside it.
 */
const GLYPH = {
  heart: "\u2764\uFE0F",
  laugh: "\u{1F602}",
  wow: "\u{1F62E}",
  thinking: "\u{1F914}",
  sad: "\u{1F622}",
  clap: "\u{1F44F}",
} as const satisfies Record<Reaction, string>;

const NAME = {
  heart: "reaction_heart",
  laugh: "reaction_laugh",
  wow: "reaction_wow",
  thinking: "reaction_thinking",
  sad: "reaction_sad",
  clap: "reaction_clap",
} as const satisfies Record<Reaction, keyof Messages>;

const FAILURE = {
  signedOut: "reactionsSignedOut",
  unverified: "reactionsUnverified",
  hidden: "reactionsHidden",
  tooManyThisHour: "reactionsTooManyThisHour",
  failed: "reactionsFailed",
} as const satisfies Record<ReactionsFailure, keyof Messages>;

type View =
  | { readonly kind: "loading" }
  | { readonly kind: "unread" }
  | { readonly kind: "hidden" }
  | {
      readonly kind: "ready";
      readonly counts: ReactionCounts;
      /** The account's own, once the visitor chose to react; until then, none. */
      readonly own: readonly Reaction[] | undefined;
    };

const failureOf = (e: unknown): ReactionsFailure =>
  e instanceof ReactionsError ? e.failure : "failed";

const LINK = "font-medium underline underline-offset-4 focus-text";

/**
 * Reactions on a poll, on the website's poll page ([[P2-25]] part 5b). The
 * counts are for everyone; a signed-in account sets and takes back its own,
 * each a toggle. T-10, T-11: offered alike whether or not this browser
 * answered, never in the ballot client and never prompted by answering, so a
 * reaction says nothing about participation. The page's server holds no
 * account session (src/node/serve.ts), so the counts are read here, once the
 * page's script runs, without the session; the account's own are read only
 * when the visitor asks to react, so opening the page tells the server
 * nothing about which account opened it.
 */
export function PollReactions({ electionId, client }: PollReactionsProps) {
  const t = useTranslate(catalogs);
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReactionsFailure | undefined>();
  const toggles = useRef<HTMLDivElement>(null);
  /** How many times the visitor asked to react and got the toggles. */
  const [joined, setJoined] = useState(0);

  useEffect(() => {
    let live = true;
    client.counts(electionId).then(
      (counts) => live && setView({ kind: "ready", counts, own: undefined }),
      (e: unknown) => live && setView({ kind: failureOf(e) === "hidden" ? "hidden" : "unread" }),
    );
    return () => {
      live = false;
    };
  }, [client, electionId]);

  // The button that asked to react is gone: focus goes to the first toggle.
  useEffect(() => {
    if (joined > 0) toggles.current?.querySelector("button")?.focus();
  }, [joined]);

  /** Runs one call, showing its answer or why it didn't happen. */
  const run = async (call: () => Promise<{ counts: ReactionCounts; own: readonly Reaction[] }>) => {
    if (busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const { counts, own } = await call();
      setView({ kind: "ready", counts, own });
      return true;
    } catch (e) {
      const f = failureOf(e);
      if (f === "hidden") setView({ kind: "hidden" });
      else if (f === "signedOut" && view.kind === "ready")
        // Signed out, or the session ended since: the counts stay, the toggles go.
        setView({ ...view, own: undefined });
      setFailure(f);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    if (await run(() => client.own(electionId))) setJoined((n) => n + 1);
  };

  const label = (reaction: Reaction, count: number) =>
    t("reactionCount", { name: t(NAME[reaction]), count });
  /** The glyph and the count as drawn, with the words a screen reader reads instead. */
  const face = (reaction: Reaction, count: number) => (
    <>
      <span aria-hidden="true" className="text-xl leading-none">
        {GLYPH[reaction]}
      </span>
      <span aria-hidden="true" className="tabular-nums">
        {count}
      </span>
      <span className="sr-only">{label(reaction, count)}</span>
    </>
  );

  let body;
  if (view.kind === "loading")
    body = <p className="m-0 text-muted-foreground">{t("reactionsLoading")}</p>;
  else if (view.kind === "unread") body = <p className="m-0">{t("reactionsUnread")}</p>;
  else if (view.kind === "hidden") body = <p className="m-0">{t("reactionsHidden")}</p>;
  else if (view.own === undefined)
    body = (
      <>
        {/* Counts to read, not to tap: drawn as the toggles are, in a 44px
            box, they looked like the toggles they become, and a visitor's tap
            on one did nothing. Only "React to this poll" is drawn as a
            control (P2-29, the poll page's iteration 15). */}
        <ul
          aria-label={t("reactionsLabel")}
          className="m-0 flex list-none flex-wrap gap-x-5 gap-y-2 p-0"
        >
          {REACTIONS.map((r) => (
            <li key={r} className="inline-flex items-center gap-2 text-base">
              {face(r, view.counts[r])}
            </li>
          ))}
        </ul>
        <Button
          size="lg"
          variant="outline"
          className="justify-self-start"
          disabled={busy}
          onClick={() => void join()}
        >
          {t("reactionsJoin")}
        </Button>
      </>
    );
  else {
    const own = view.own;
    body = (
      <div
        ref={toggles}
        role="group"
        aria-label={t("reactionsLabel")}
        className="flex flex-wrap gap-2"
      >
        {REACTIONS.map((r) => (
          <Toggle
            key={r}
            variant="outline"
            className="min-h-11 gap-2 px-3 text-base aria-pressed:border-primary"
            pressed={own.includes(r)}
            onPressedChange={(on) => void run(() => client.set(electionId, r, on))}
          >
            {face(r, view.counts[r])}
          </Toggle>
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby="reactions-title" aria-busy={busy} className="grid max-w-3xl gap-4">
      <h2 id="reactions-title" className="m-0 font-heading text-2xl font-semibold">
        {t("reactionsTitle")}
      </h2>
      <p className="m-0 max-w-prose text-base text-pretty">{t("reactionsLede")}</p>
      {body}
      {view.kind === "ready" ? (
        <p className="m-0 text-sm text-muted-foreground">{t("reactionsPrivacy")}</p>
      ) : null}
      {failure === undefined || failure === "hidden" ? null : (
        <p role="alert" className="m-0">
          {t(FAILURE[failure])}{" "}
          {failure === "unverified" ? (
            <a className={LINK} href="/account/verify">
              {t("reactionsVerify")}
            </a>
          ) : failure === "signedOut" ? (
            <a className={LINK} href="/account">
              {t("reactionsSignIn")}
            </a>
          ) : null}
        </p>
      )}
    </section>
  );
}
