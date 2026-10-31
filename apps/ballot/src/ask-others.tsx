import { Button, buttonVariants, cn, QrCode, useTranslate } from "@abolishus/ui";
import { Input } from "@abolishus/ui/ui/input";
import { Check, ChevronDown, Copy, ExternalLink, Mail, Printer, Share2 } from "lucide-react";
import { useId, useState } from "react";

import { AnsweredCard } from "./answered-card.tsx";
import { ACTION } from "./frame.tsx";
import { catalogs } from "./messages.ts";

/** What "Ask others" shares: the poll's short link and its first question, nothing of the voter's. */
export interface Share {
  readonly url: string;
  readonly title: string;
}

const ROW =
  "flex min-h-12 w-full items-center gap-3 px-3 text-start text-base hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

const hasWebShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/**
 * "Ask others" after answering (docs/design/sharing.md, Share sheet): the
 * poll's short link with Copy link, the system's share menu where the
 * browser has one or an email where it doesn't, a QR code of the same link
 * and the website's printable flyer. Placed after the tracking code and
 * never in the bottom bar, whose actions stay the screen's own. The link is
 * the same for everyone, so sharing it can't tie the voter to the poll, let
 * alone to an answer; copying and the share menu happen on the device, and
 * nothing here reaches a server (T-10). The flyer opens the website in a new
 * tab: navigating there names the poll's code to the website, as any visit
 * to the link does, and nothing else (T-11).
 */
export function AskOthers({
  share,
  seal,
  canShare,
  canShareCard,
}: {
  share: Share;
  /** The poll's definition hash, the seal the "I answered" card carries. */
  seal: string;
  /** Whether the browser has the Web Share API; detected when left out. */
  canShare?: boolean | undefined;
  /** Whether its share menu takes the card's picture; detected when left out. */
  canShareCard?: boolean | undefined;
}) {
  const { url, title } = share;
  const t = useTranslate(catalogs);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [qr, setQr] = useState(false);
  const [card, setCard] = useState(false);
  const linkId = useId();
  const qrId = useId();
  const cardId = useId();
  const titleId = useId();
  const menu = canShare ?? hasWebShare();
  // Only `{ title, url }` (docs/design/sharing.md): nothing about the sharer.
  const mail = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  return (
    // Named by its heading, unlike the screen's other parts: a region a
    // screen reader can jump to past the tracking code.
    <section aria-labelledby={titleId} className="mt-10 grid gap-4">
      <h2 id={titleId} className="m-0 font-heading text-xl font-semibold">
        {t("askOthersTitle")}
      </h2>
      <p className="m-0" data-testid="never-your-answer">
        {t("askOthersNeverYourAnswer")}
      </p>
      <div className="grid gap-2">
        <label htmlFor={linkId} className="font-semibold">
          {t("askOthersLinkLabel")}
        </label>
        <Input
          id={linkId}
          readOnly
          value={url}
          className="font-medium"
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="flex flex-col gap-3 sm:flex-row">
          <Button size="lg" variant="outline" className={ACTION} onClick={() => void copy()}>
            {copied === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {t(copied === "copied" ? "askOthersCopied" : "askOthersCopy")}
          </Button>
          {menu ? (
            <Button
              size="lg"
              variant="outline"
              className={ACTION}
              // A dismissed menu rejects; there's nothing to tell the voter.
              onClick={() => void navigator.share({ title, url }).catch(() => undefined)}
            >
              <Share2 aria-hidden="true" />
              {t("askOthersMenu")}
            </Button>
          ) : (
            <a
              href={mail}
              className={cn(buttonVariants({ size: "lg", variant: "outline" }), ACTION)}
            >
              <Mail aria-hidden="true" />
              {t("askOthersEmail")}
            </a>
          )}
        </div>
        <p role="status" className="m-0 min-h-5 text-sm text-muted-foreground">
          {copied === "copied"
            ? t("askOthersCopiedStatus")
            : copied === "failed"
              ? t("askOthersCopyFailed")
              : ""}
        </p>
        {menu ? null : (
          <p className="m-0 text-sm text-pretty text-muted-foreground" data-testid="no-web-share">
            {t("askOthersNoMenu")}
          </p>
        )}
      </div>
      <ul className="m-0 grid list-none gap-1 p-0">
        <li>
          <button
            type="button"
            className={ROW}
            aria-expanded={qr}
            aria-controls={qrId}
            onClick={() => setQr(!qr)}
          >
            <span className="flex-1">{t("askOthersQrShow")}</span>
            <ChevronDown aria-hidden="true" className={cn("size-5", qr && "rotate-180")} />
          </button>
          <div id={qrId} hidden={!qr} className="grid justify-items-start gap-2 px-3 pt-2 pb-4">
            {qr ? (
              <QrCode
                // The upper-case link, as the website draws it: alphanumeric
                // mode keeps it at version 2, the easiest grid to scan. Hosts
                // and codes are case-insensitive, and the website's router
                // matches `/P/` (docs/design/sharing.md, Short links).
                value={url.toUpperCase()}
                label={t("askOthersQrLabel", { link: url.replace(/^https?:\/\//, "") })}
                size={176}
              />
            ) : null}
            <p className="m-0 text-sm text-pretty text-muted-foreground">{t("askOthersQrNote")}</p>
          </div>
        </li>
        <li>
          <button
            type="button"
            className={ROW}
            aria-expanded={card}
            aria-controls={cardId}
            onClick={() => setCard(!card)}
          >
            <span className="flex-1">{t("answeredCardShow")}</span>
            <ChevronDown aria-hidden="true" className={cn("size-5", card && "rotate-180")} />
          </button>
          <div id={cardId} hidden={!card} className="px-3 pt-2 pb-4">
            {/* Drawn only when asked for, like the QR code. */}
            {card ? <AnsweredCard share={share} seal={seal} canShare={canShareCard} /> : null}
          </div>
        </li>
        <li>
          <a href={`${url}/flyer`} target="_blank" rel="noopener noreferrer" className={ROW}>
            <Printer aria-hidden="true" className="size-5" />
            <span className="flex-1">
              {t("askOthersFlyer")}
              <span className="sr-only"> {t("askOthersNewTab")}</span>
            </span>
            <ExternalLink aria-hidden="true" className="size-4" />
          </a>
        </li>
      </ul>
    </section>
  );
}
