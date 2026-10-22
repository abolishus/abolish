import { Button, buttonVariants, cn, QrCode, useTranslate } from "@abolishus/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@abolishus/ui/ui/dialog";
import { Input } from "@abolishus/ui/ui/input";
import { Check, ChevronDown, Copy, Mail, QrCode as QrCodeIcon, Share2 } from "lucide-react";
import { useId, useState } from "react";

import { catalogs } from "../messages.ts";

export interface PollShareProps {
  /** The poll's short link, the same for everyone who shares it. */
  readonly url: string;
  /** What the link is called in a share menu or an email's subject. */
  readonly title: string;
  /** Whether the browser has the Web Share API; detected when left out. */
  readonly canShare?: boolean | undefined;
}

type CopyState = "idle" | "copied" | "failed";

const ROW =
  "flex min-h-12 w-full items-center gap-3 px-3 text-start text-base hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

const hasWebShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/**
 * "Share this poll" (docs/design/sharing.md, Share sheet): the short link
 * with Copy link, then the system's share menu where the browser has one,
 * or an email where it doesn't, then a QR code of the same link, drawn in
 * the browser by our own encoder. The link carries no per-person code, so
 * sharing it can't tie the sharer to the poll, let alone to an answer, and
 * nothing here reaches our servers or analytics: the copy and the share
 * happen in the browser (T-10, T-67). No count of who else shared, nothing
 * to nudge with.
 */
export function PollShare({ url, title, canShare }: PollShareProps) {
  const t = useTranslate(catalogs);
  const [copied, setCopied] = useState<CopyState>("idle");
  const [qr, setQr] = useState(false);
  const linkId = useId();
  const qrId = useId();
  // The panel only renders once the dialog opens in the browser, so the
  // detection never differs between the server's HTML and hydration.
  const share = canShare ?? hasWebShare();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  // Only `{ title, url }` (docs/design/sharing.md): nothing about the sharer.
  const mail = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`;
  return (
    <Dialog
      onOpenChange={() => {
        setCopied("idle");
        setQr(false);
      }}
    >
      <DialogTrigger
        render={<Button variant="outline" size="lg" className="justify-between sm:min-w-64" />}
      >
        {t("shareOpen")}
        <Share2 aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] gap-6 overflow-y-auto p-6 text-base sm:max-w-lg">
        <DialogHeader className="gap-2 pe-12">
          <DialogTitle className="text-2xl font-semibold">{t("shareOpen")}</DialogTitle>
          <DialogDescription className="text-base text-pretty text-muted-foreground">
            {t("shareNeverYourAnswer")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 text-base">
          <div className="grid gap-2">
            <label htmlFor={linkId} className="font-semibold">
              {t("shareLinkLabel")}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={linkId}
                readOnly
                value={url}
                className="font-medium"
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button className="sm:min-w-40" onClick={() => void copy()}>
                {copied === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {t(copied === "copied" ? "shareCopied" : "shareCopy")}
              </Button>
            </div>
            <p role="status" className="m-0 min-h-5 text-sm text-muted-foreground">
              {copied === "copied"
                ? t("shareCopiedStatus")
                : copied === "failed"
                  ? t("shareCopyFailed")
                  : ""}
            </p>
          </div>
          {share ? (
            <Button
              variant="outline"
              className="justify-self-start"
              // A dismissed menu rejects; there's nothing to tell the sharer.
              onClick={() => void navigator.share({ title, url }).catch(() => undefined)}
            >
              <Share2 aria-hidden="true" />
              {t("shareMenu")}
            </Button>
          ) : (
            <div className="grid gap-2" data-testid="no-web-share">
              <p className="m-0 text-sm text-pretty text-muted-foreground">{t("shareNoMenu")}</p>
              <a
                href={mail}
                className={cn(buttonVariants({ variant: "outline" }), "justify-self-start")}
              >
                <Mail aria-hidden="true" />
                {t("shareEmail")}
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
                <QrCodeIcon aria-hidden="true" className="size-5" />
                <span className="flex-1">{t("shareQrShow")}</span>
                <ChevronDown aria-hidden="true" className={cn("size-5", qr && "rotate-180")} />
              </button>
              <div id={qrId} hidden={!qr} className="grid justify-items-start gap-2 px-3 pt-2 pb-4">
                {qr ? (
                  <QrCode
                    // The upper-case link (docs/design/sharing.md, Short links):
                    // alphanumeric mode keeps it at version 2, the coarsest grid
                    // and so the easiest to scan from across a room. Hosts and
                    // codes are case-insensitive, and the router matches `/P/`.
                    value={url.toUpperCase()}
                    label={t("shareQrLabel", { link: url.replace(/^https?:\/\//, "") })}
                    size={176}
                  />
                ) : null}
                <p className="m-0 text-sm text-pretty text-muted-foreground">{t("shareQrNote")}</p>
              </div>
            </li>
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
