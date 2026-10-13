import { Button, buttonVariants, cn } from "@abolishus/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@abolishus/ui/ui/dialog";
import { Input } from "@abolishus/ui/ui/input";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Code,
  Copy,
  Mail,
  Printer,
  QrCode,
  Share2,
} from "lucide-react";
import { useId, useState } from "react";

import { answerHref } from "./everyday-data.ts";
import { Byline, EverydayShell, Frame, ROUND, Seal } from "./everyday-parts.tsx";
import { DIALOG_CONTENT, EmbedHeader, EmbedPanel } from "./share-embed.tsx";
import { alsoAt, flyerHref, type SharePoll, shortCode, shortHref, WEB_HOST } from "./share-data.ts";
import { QrPlaceholder, useCopy } from "./share-parts.tsx";

/** What every share surface says about the sharer's own answer. */
export const NEVER_YOUR_ANSWER =
  "Sharing sends the question and this link, never your answer. The link is the same for everyone, so it doesn’t say who shared it or whether they answered.";

const ROW =
  "flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-start text-base hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

const hasWebShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/**
 * The share sheet's body: the link and copy first, the system share menu
 * where the browser has one, then the quieter ways (a QR code, a flyer, an
 * embed). No counts of who else shared, nothing to nudge with.
 */
export function SharePanel({
  poll,
  canShare,
  onEmbed,
}: {
  poll: SharePoll;
  /** Whether the browser has the Web Share API; detected when left out. */
  canShare?: boolean | undefined;
  onEmbed: () => void;
}) {
  const { state, copy } = useCopy();
  const [qr, setQr] = useState(false);
  const linkId = useId();
  const qrId = useId();
  const url = shortHref(poll.id);
  const share = canShare ?? hasWebShare();
  const mail = `mailto:?subject=${encodeURIComponent(poll.title)}&body=${encodeURIComponent(url)}`;
  return (
    <div className="grid gap-6 text-base">
      <div className="grid gap-2">
        <label htmlFor={linkId} className="font-semibold">
          Link to this poll
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id={linkId}
            readOnly
            value={url}
            className="font-medium"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button className={cn(ROUND, "sm:min-w-40")} onClick={() => void copy(url)}>
            {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {state === "copied" ? "Link copied" : "Copy link"}
          </Button>
        </div>
        <p role="status" className="m-0 min-h-5 text-sm text-muted-foreground">
          {state === "copied"
            ? "Link copied. Paste it anywhere."
            : state === "failed"
              ? "Couldn’t copy. Select the link above and copy it."
              : ""}
        </p>
      </div>
      {share ? (
        <Button
          variant="outline"
          className={cn(ROUND, "justify-self-start")}
          onClick={() => void navigator.share({ title: poll.title, url }).catch(() => undefined)}
        >
          <Share2 aria-hidden="true" />
          Share…
        </Button>
      ) : (
        <div className="grid gap-2" data-testid="no-web-share">
          <p className="m-0 text-sm text-pretty text-muted-foreground">
            This browser doesn’t have a share menu. Copy the link and paste it where you like, or
            email it.
          </p>
          <a
            href={mail}
            className={cn(buttonVariants({ variant: "outline" }), ROUND, "justify-self-start")}
          >
            <Mail aria-hidden="true" />
            Email the link
          </a>
        </div>
      )}
      <ul className="m-0 grid list-none gap-1 border-t border-border p-0 pt-4">
        <li>
          <button
            type="button"
            className={ROW}
            aria-expanded={qr}
            aria-controls={qrId}
            onClick={() => setQr(!qr)}
          >
            <QrCode aria-hidden="true" className="size-5" />
            <span className="flex-1">Show a QR code</span>
            <ChevronDown aria-hidden="true" className={cn("size-5", qr && "rotate-180")} />
          </button>
          <div id={qrId} hidden={!qr} className="grid justify-items-start gap-2 px-3 pt-2 pb-4">
            <QrPlaceholder id={poll.id} size={176} />
            <p className="m-0 text-sm text-pretty text-muted-foreground">
              For a screen or a slide. For a noticeboard, print a flyer.
            </p>
          </div>
        </li>
        <li>
          <a href={flyerHref(poll.id)} className={ROW}>
            <Printer aria-hidden="true" className="size-5" />
            <span className="flex-1">Print a flyer</span>
            <ArrowRight aria-hidden="true" className="size-5" />
          </a>
        </li>
        <li>
          <button type="button" className={ROW} onClick={onEmbed}>
            <Code aria-hidden="true" className="size-5" />
            <span className="flex-1">Embed on your site</span>
            <ArrowRight aria-hidden="true" className="size-5" />
          </button>
        </li>
      </ul>
      <p className="m-0 text-sm text-pretty text-muted-foreground" data-testid="also-at">
        If {WEB_HOST} doesn’t open where you are: {alsoAt(poll.id)}.
      </p>
    </div>
  );
}

/** "Share this poll" on the poll's page: a dialog with the panel, and the embed one step in. */
export function ShareDialog({
  poll,
  canShare,
  defaultOpen,
}: {
  poll: SharePoll;
  canShare?: boolean | undefined;
  defaultOpen?: boolean | undefined;
}) {
  const [view, setView] = useState<"share" | "embed">("share");
  return (
    <Dialog
      defaultOpen={defaultOpen ?? false}
      onOpenChange={(open) => {
        if (!open) setView("share");
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" size="lg" className={cn(ROUND, "justify-between")} />}
      >
        Share this poll
        <Share2 aria-hidden="true" />
      </DialogTrigger>
      <DialogContent
        className={view === "share" ? `${DIALOG_CONTENT} sm:max-w-lg` : DIALOG_CONTENT}
      >
        {view === "share" ? (
          <>
            <DialogHeader className="gap-2 pe-12">
              <DialogTitle className="text-2xl font-semibold">Share this poll</DialogTitle>
              <DialogDescription className="text-base text-pretty text-muted-foreground">
                {NEVER_YOUR_ANSWER}
              </DialogDescription>
            </DialogHeader>
            <SharePanel poll={poll} canShare={canShare} onEmbed={() => setView("embed")} />
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              className={cn(ROUND, "-ms-3 justify-self-start")}
              onClick={() => setView("share")}
            >
              <ArrowLeft aria-hidden="true" />
              Back to sharing
            </Button>
            <EmbedHeader />
            <EmbedPanel poll={poll} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The poll page's hero with its share button, to judge the sheet in place. */
export function SharePollPage({
  poll,
  canShare,
  defaultOpen,
}: {
  poll: SharePoll;
  canShare?: boolean | undefined;
  defaultOpen?: boolean | undefined;
}) {
  return (
    <EverydayShell current="/discover">
      <Frame className="grid gap-8 pt-12 pb-16 md:pt-20">
        <div className="grid gap-6">
          <Byline>
            <span>Asked by {poll.askedBy}</span>
            <span aria-hidden="true">·</span>
            <span>Closes {poll.closesDay}</span>
          </Byline>
          <h1 className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
            {poll.title}
          </h1>
        </div>
        <div className="grid max-w-md gap-3">
          <a
            href={answerHref(shortCode(poll.id))}
            className={cn(buttonVariants({ size: "lg" }), ROUND, "justify-between")}
          >
            Answer this question
            <ArrowRight aria-hidden="true" />
          </a>
          <ShareDialog poll={poll} canShare={canShare} defaultOpen={defaultOpen} />
          <Seal hash={poll.id} subject="poll">
            How do we know this is real?
          </Seal>
        </div>
      </Frame>
    </EverydayShell>
  );
}
