import { Button, buttonVariants, cn } from "@abolishus/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@abolishus/ui/ui/dialog";
import { Label } from "@abolishus/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { Textarea } from "@abolishus/ui/ui/textarea";
import { Check, Code, Copy, ExternalLink } from "lucide-react";
import { useId, useState } from "react";

import { num, pct } from "./everyday-data.ts";
import { ROUND } from "./everyday-parts.tsx";
import {
  ballotHref,
  embedSrc,
  type EmbedTheme,
  type SharePoll,
  shortHref,
  shortLink,
  WEB_HOST,
} from "./share-data.ts";
import { SealMark, useCopy } from "./share-parts.tsx";

const NEW_TAB = <span className="sr-only"> (opens in a new tab)</span>;

/**
 * The embedded poll: what apps/web serves at /embed/p/<code> for an iframe,
 * as plain server-rendered HTML with no script. Every answer is a link that
 * opens the ballot client in a new tab, which refuses to be framed; the card
 * itself has no form and can never take an answer.
 */
export function EmbedCard({
  poll,
  theme,
}: {
  poll: SharePoll;
  theme?: "light" | "dark" | undefined;
}) {
  const titleId = useId();
  const many = poll.questions.length > 1;
  const live = poll.state !== "sealed";
  const answer = many
    ? `Answer ${poll.questions.length} questions on Abolish`
    : "Answer on Abolish";
  return (
    <article
      aria-labelledby={titleId}
      data-theme={theme}
      data-testid="embed-card"
      className="@container grid gap-4 rounded-xl border border-border bg-background p-5 font-sans text-foreground"
    >
      <header className="flex items-center gap-3">
        <SealMark id={poll.id} size={40} />
        <p className="m-0 min-w-0 flex-1 text-sm text-muted-foreground">
          Asked by <span className="font-medium text-foreground">{poll.askedBy}</span> ·{" "}
          {poll.place}
        </p>
      </header>
      <h2
        id={titleId}
        className="m-0 font-heading text-xl leading-snug font-semibold text-pretty @lg:text-2xl"
      >
        {poll.title}
      </h2>
      {many ? (
        <ol className="m-0 grid list-none gap-2 p-0">
          {poll.questions.map((text, i) => (
            <li key={text} className="grid grid-cols-[1.75rem_1fr] gap-2 text-base">
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-full bg-muted text-sm font-semibold"
              >
                {i + 1}
              </span>
              <span className="text-pretty">
                <span className="sr-only">Question {i + 1}: </span>
                {text}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="grid gap-2">
          <p className="m-0 text-sm text-muted-foreground">
            Pick one. Your pick opens Abolish in a new tab, where you check it and send it.
          </p>
          <ul className="m-0 grid list-none gap-2 p-0 @xl:grid-cols-2">
            {poll.options.map((option) => {
              const share = live ? (option.count ?? 0) / poll.answers : undefined;
              return (
                <li key={option.key}>
                  <a
                    href={ballotHref(poll.id, option.key)}
                    target="_blank"
                    rel="noopener"
                    className="grid min-h-12 gap-1.5 rounded-lg border border-border px-4 py-3 hover:border-foreground focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="flex items-baseline justify-between gap-3">
                      <span className="text-base text-pretty">{option.label}</span>
                      {share === undefined ? (
                        <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
                      ) : (
                        <span className="shrink-0 text-sm tabular-nums">{pct(share)}</span>
                      )}
                    </span>
                    {share === undefined ? null : (
                      <span aria-hidden="true" className="block h-1.5 rounded-full bg-muted">
                        <span
                          className="block h-full rounded-full bg-foreground/55"
                          style={{ width: `${share * 100}%` }}
                        />
                      </span>
                    )}
                    {NEW_TAB}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <p className="m-0 text-sm text-muted-foreground" data-testid="embed-status">
        {poll.state === "sealed"
          ? `${num(poll.answers)} answers so far. Results appear when it closes on ${poll.closesDay}.`
          : many
            ? `${num(poll.answers)} answers so far · results on Abolish, updated ${poll.updated}`
            : `Results so far among ${num(poll.answers)} people with an account · updated ${poll.updated}`}
      </p>
      <a
        href={ballotHref(poll.id)}
        target="_blank"
        rel="noopener"
        className={cn(
          buttonVariants({ size: "lg" }),
          ROUND,
          "h-auto min-h-14 justify-between py-3 text-start whitespace-normal",
        )}
      >
        {answer}
        <ExternalLink aria-hidden="true" />
        {NEW_TAB}
      </a>
      <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-sm text-muted-foreground">
        <span>Answers are taken only on Abolish, never in this card.</span>
        <a
          href={shortHref(poll.id)}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-6 items-center text-foreground underline underline-offset-4"
        >
          {shortLink(poll.id)}
          {NEW_TAB}
        </a>
      </footer>
    </article>
  );
}

/** A height that fits the card at the widths it's meant for; the page scrolls inside past that. */
export const embedHeight = (poll: SharePoll) =>
  poll.questions.length > 1 ? 480 : 300 + poll.options.length * 76;

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c,
  );

export type EmbedKind = "card" | "link";

/** The code a site pastes: a sandboxed, script-free iframe, or a plain link that loads nothing. */
export function embedSnippet(poll: SharePoll, kind: EmbedKind, theme: EmbedTheme): string {
  const title = escapeHtml(poll.title);
  if (kind === "link") {
    return [
      `<p><a href="${shortHref(poll.id)}">${title}</a><br>`,
      `Asked by ${escapeHtml(poll.askedBy)}. Answer on Abolish; anyone can check the count.</p>`,
    ].join("\n");
  }
  return [
    `<iframe src="${embedSrc(poll.id, theme)}"`,
    `  title="Poll: ${title}"`,
    `  width="100%" height="${embedHeight(poll)}" style="max-width:640px;border:0"`,
    `  loading="lazy" referrerpolicy="no-referrer"`,
    `  sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>`,
  ].join("\n");
}

const THEMES: readonly { key: EmbedTheme; label: string }[] = [
  { key: "auto", label: "Match the reader’s setting" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

const KINDS: readonly { key: EmbedKind; label: string; note: string }[] = [
  {
    key: "card",
    label: "The poll card",
    note: "Shows the question and, when they’re public, the latest results. Loads from abolish.us with no script and no cookies.",
  },
  {
    key: "link",
    label: "A plain link",
    note: "Just the question as a link. Nothing loads from abolish.us until someone clicks.",
  },
];

/** "Embed on your site": choose, copy, and see what readers will see. */
export function EmbedPanel({ poll }: { poll: SharePoll }) {
  const [kind, setKind] = useState<EmbedKind>("card");
  const [theme, setTheme] = useState<EmbedTheme>("auto");
  const { state, copy } = useCopy();
  const snippetId = useId();
  const snippet = embedSnippet(poll, kind, theme);
  return (
    <div className="grid gap-6 text-base">
      <fieldset className="m-0 grid gap-3 border-0 p-0">
        <legend className="mb-3 font-semibold">What to embed</legend>
        <RadioGroup value={kind} onValueChange={(value) => setKind(value as EmbedKind)}>
          {KINDS.map((k) => (
            <Label
              key={k.key}
              className={cn(
                "flex min-h-12 items-start gap-3 rounded-lg border p-4 text-base leading-normal font-normal",
                kind === k.key ? "border-primary" : "border-border",
              )}
            >
              <RadioGroupItem value={k.key} className="mt-1" />
              <span className="grid gap-1">
                <span className="font-semibold">{k.label}</span>
                <span className="text-sm text-pretty text-muted-foreground">{k.note}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </fieldset>
      {kind === "card" ? (
        <fieldset className="m-0 grid gap-3 border-0 p-0">
          <legend className="mb-3 font-semibold">Colours</legend>
          <RadioGroup
            value={theme}
            onValueChange={(value) => setTheme(value as EmbedTheme)}
            className="flex flex-wrap gap-x-6 gap-y-2"
          >
            {THEMES.map((t) => (
              <Label key={t.key} className="min-h-12 text-base font-normal">
                <RadioGroupItem value={t.key} />
                {t.label}
              </Label>
            ))}
          </RadioGroup>
        </fieldset>
      ) : null}
      <div className="grid gap-2">
        <label htmlFor={snippetId} className="font-semibold">
          Code to paste into your page
        </label>
        <Textarea
          id={snippetId}
          readOnly
          value={snippet}
          spellCheck={false}
          className="font-mono text-sm break-all"
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" className={ROUND} onClick={() => void copy(snippet)}>
            {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {state === "copied" ? "Code copied" : "Copy code"}
          </Button>
          <span role="status" className="text-sm text-muted-foreground">
            {state === "failed" ? "Couldn’t copy. Select the code above and copy it." : ""}
          </span>
        </div>
      </div>
      <section aria-label="Preview" className="grid gap-3">
        <p className="m-0 font-semibold">Preview</p>
        {kind === "card" ? (
          <EmbedCard poll={poll} theme={theme === "auto" ? undefined : theme} />
        ) : (
          <p className="m-0 rounded-lg border border-dashed border-border p-4">
            <a href={shortHref(poll.id)} className="underline underline-offset-4">
              {poll.title}
            </a>
            <br />
            Asked by {poll.askedBy}. Answer on Abolish; anyone can check the count.
          </p>
        )}
        <p className="m-0 text-sm text-pretty text-muted-foreground">
          {kind === "card"
            ? `The card can’t take an answer: every answer opens Abolish in a new tab. It loads from ${WEB_HOST} each time your page is read, so readers’ browsers contact ${WEB_HOST}, without cookies or a referrer.`
            : "The link carries nothing about you, your site or your readers."}
        </p>
      </section>
    </div>
  );
}

/** A local page carrying the card, to judge it at a real column width. */
export function HostPage({
  poll,
  theme,
  width,
}: {
  poll: SharePoll;
  theme: "light" | "dark";
  width: "narrow" | "wide";
}) {
  return (
    <div
      data-theme={theme}
      className="grid gap-4 bg-background p-4 text-foreground sm:p-6"
      style={{ maxWidth: width === "narrow" ? 320 + 48 : 640 + 48 }}
    >
      <p className="m-0 text-sm text-muted-foreground">Community news · Riverside</p>
      <p className="m-0 font-heading text-2xl leading-tight font-semibold text-balance">
        Neighbours weigh in on next year’s requests to the city
      </p>
      <p className="m-0 text-base text-pretty">
        Riverside Neighbours is collecting views before the city’s budget hearings. You can answer
        below; the answers are counted on Abolish.
      </p>
      <div
        className="w-full"
        style={{ maxWidth: width === "narrow" ? 320 : 640 }}
        data-testid={`host-${width}`}
      >
        <EmbedCard poll={poll} theme={theme} />
      </div>
    </div>
  );
}

export const EMBED_DESCRIPTION =
  "Put this poll on a news page or a community site. The card shows the question and, when they’re public, the latest results. It never takes an answer: every answer opens Abolish in a new tab.";

/** The dialog title and description, shared with the share sheet's embed view. */
export function EmbedHeader() {
  return (
    <DialogHeader className="gap-2 pe-12">
      <DialogTitle className="text-2xl font-semibold">Embed on your site</DialogTitle>
      <DialogDescription className="text-base text-pretty text-muted-foreground">
        {EMBED_DESCRIPTION}
      </DialogDescription>
    </DialogHeader>
  );
}

export const DIALOG_CONTENT = "max-h-[90dvh] gap-6 overflow-y-auto p-6 text-base sm:max-w-2xl";

/** "Embed on your site" on its own, as the poll page's menu would open it. */
export function EmbedDialog({ poll, defaultOpen }: { poll: SharePoll; defaultOpen?: boolean }) {
  return (
    <Dialog defaultOpen={defaultOpen ?? false}>
      <DialogTrigger render={<Button variant="outline" className={ROUND} />}>
        <Code aria-hidden="true" />
        Embed on your site
      </DialogTrigger>
      <DialogContent className={DIALOG_CONTENT}>
        <EmbedHeader />
        <EmbedPanel poll={poll} />
      </DialogContent>
    </Dialog>
  );
}
