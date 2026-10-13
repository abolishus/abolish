import { Button, Fingerprint } from "@abolishus/ui";
import { Check, Copy, Download, ExternalLink, Mail, Share2 } from "lucide-react";
import { useId, useState } from "react";

import { EVERYDAY_RECEIPT, type EverydayPoll } from "./everyday-fixtures.ts";
import {
  EVERYDAY_ACTION,
  EverydayFrame,
  everydayLink,
  OneTapAway,
  Part,
} from "./everyday-frame.tsx";
import {
  alsoAt,
  embedHref,
  flyerHref,
  qrPlaceholder,
  shortCode,
  shortHref,
  shortLink,
  WEB_HOST,
} from "./everyday-share-data.ts";
import { shortHex } from "./fixtures.ts";

const NEW_TAB = <span className="sr-only"> (opens in a new tab)</span>;

/** A placeholder QR code, labelled as one: the shape of the real thing, encoding nothing. */
function QrPlaceholder({ hash, size = 176 }: { hash: string; size?: number }) {
  const grid = qrPlaceholder(hash);
  const n = grid.length;
  return (
    <span className="inline-grid justify-items-start gap-1">
      <svg
        role="img"
        aria-label={`QR code for ${shortLink(hash)} (placeholder, not scannable)`}
        viewBox={`-2 -2 ${n + 4} ${n + 4}`}
        width={size}
        height={size}
        shapeRendering="crispEdges"
        className="shrink-0 bg-white text-black"
      >
        <rect x={-2} y={-2} width={n + 4} height={n + 4} fill="white" />
        {grid.flatMap((row, y) =>
          row.map((on, x) =>
            on ? (
              <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" />
            ) : null,
          ),
        )}
      </svg>
      <span aria-hidden="true" className="text-xs text-muted-foreground">
        Placeholder QR · {shortCode(hash)}
      </span>
    </span>
  );
}

const hasWebShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/**
 * Sharing from the Done screen: the poll's link, never the person's answer.
 * Quiet and below the receipt; nothing here counts who else shared.
 */
export function ShareThisPoll({
  poll,
  canShare,
}: {
  poll: EverydayPoll;
  /** Whether the browser has the Web Share API; detected when left out. */
  canShare?: boolean | undefined;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const linkId = useId();
  const titleId = useId();
  const url = shortHref(poll.definitionHash);
  const share = canShare ?? hasWebShare();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  const mail = `mailto:?subject=${encodeURIComponent(poll.title)}&body=${encodeURIComponent(url)}`;
  return (
    <section aria-labelledby={titleId} className="reveal mt-10 grid gap-4">
      <h2 id={titleId} className="m-0 font-heading text-xl font-semibold">
        Ask others
      </h2>
      <p className="m-0" data-testid="never-your-answer">
        Share the question, not your answer. The link is the same for everyone, so it says nothing
        about how you answered, or whether you did.
      </p>
      <div className="grid gap-2">
        <label htmlFor={linkId} className="font-semibold">
          Link to this poll
        </label>
        <input
          id={linkId}
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className="h-12 w-full min-w-0 rounded-lg border border-input bg-transparent px-3.5 text-base font-medium outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring"
        />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            size="lg"
            variant="outline"
            className={EVERYDAY_ACTION}
            onClick={() => void copy()}
          >
            {copied === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied === "copied" ? "Link copied" : "Copy link"}
          </Button>
          {share ? (
            <Button
              size="lg"
              variant="outline"
              className={EVERYDAY_ACTION}
              onClick={() =>
                void navigator.share({ title: poll.title, url }).catch(() => undefined)
              }
            >
              <Share2 aria-hidden="true" />
              Share…
            </Button>
          ) : (
            <a href={mail} className={everydayLink("outline")}>
              <Mail aria-hidden="true" />
              Email the link
            </a>
          )}
        </div>
        <p role="status" className="m-0 min-h-5 text-sm text-muted-foreground">
          {copied === "copied"
            ? "Link copied. Paste it anywhere."
            : copied === "failed"
              ? "Couldn't copy. Select the link above and copy it."
              : ""}
        </p>
        {share ? null : (
          <p className="m-0 text-sm text-muted-foreground" data-testid="no-web-share">
            This browser doesn't have a share menu. Copy the link and paste it where you like, or
            email it.
          </p>
        )}
      </div>
      <OneTapAway summary={<span className="font-medium">Show a QR code</span>}>
        <QrPlaceholder hash={poll.definitionHash} />
        <p className="m-0 text-sm">Someone nearby can scan it to open the poll.</p>
      </OneTapAway>
      <ul className="m-0 grid list-none gap-1 p-0">
        <li>
          <a
            href={flyerHref(poll.definitionHash)}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4"
          >
            Print a flyer
            <ExternalLink aria-hidden="true" className="size-4" />
            {NEW_TAB}
          </a>
        </li>
        <li>
          <a
            href={embedHref(poll.definitionHash)}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-12 items-center gap-2 underline underline-offset-4"
          >
            Embed on your site
            <ExternalLink aria-hidden="true" className="size-4" />
            {NEW_TAB}
          </a>
        </li>
      </ul>
      <p className="m-0 text-sm text-pretty text-muted-foreground" data-testid="also-at">
        If {WEB_HOST} doesn't open where you are: {alsoAt(poll.definitionHash)}.
      </p>
    </section>
  );
}

/**
 * The Done screen with sharing in place: after the receipt, before "Changed
 * your mind?", and never above the receipt or in the bottom bar.
 */
export function DoneWithShare({
  poll,
  canShare,
}: {
  poll: EverydayPoll;
  canShare?: boolean | undefined;
}) {
  return (
    <EverydayFrame
      poll={poll}
      primary={
        <Button size="lg" className={EVERYDAY_ACTION}>
          {poll.results === "live" ? "See results so far" : "Back to the poll's page"}
        </Button>
      }
    >
      <div className="flex items-center gap-4">
        <Fingerprint
          value={EVERYDAY_RECEIPT.hash}
          label={`Seal of your receipt, ${shortHex(EVERYDAY_RECEIPT.hash)}`}
          size={48}
        />
        <h1 className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
          Your answers are in
        </h1>
      </div>
      <p className="mt-4 mb-0 text-lg text-pretty">
        They're sealed and on the public board, and no one can see how you answered, including us.
      </p>
      <Part title="Keep your receipt">
        <p className="m-0">It shows your answers are on the board, not what they were.</p>
        <div>
          <Button size="lg" variant="outline" className={EVERYDAY_ACTION}>
            <Download aria-hidden="true" />
            Save receipt
          </Button>
        </div>
      </Part>
      <ShareThisPoll poll={poll} canShare={canShare} />
      <Part title="Changed your mind?">
        <p className="m-0">
          You can change your answers until {poll.changeUntil}; only your last answers count.
        </p>
      </Part>
    </EverydayFrame>
  );
}
