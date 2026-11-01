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
import { Label } from "@abolishus/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { Textarea } from "@abolishus/ui/ui/textarea";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Code,
  Copy,
  ExternalLink,
  Mail,
  Printer,
  QrCode as QrCodeIcon,
  Share2,
} from "lucide-react";
import { useId, useState } from "react";

import { catalogs, type Messages } from "../messages.ts";
import {
  EMBED_THEMES,
  type EmbedKind,
  embedSnippet,
  embedSrc,
  type EmbedTheme,
} from "./poll-embed.tsx";

export interface PollShareProps {
  /** The poll's short link, the same for everyone who shares it. */
  readonly url: string;
  /** What the link is called in a share menu or an email's subject. */
  readonly title: string;
  /** Whether the browser has the Web Share API; detected when left out. */
  readonly canShare?: boolean | undefined;
  /** The poll's flyer page, `/p/<code>/flyer`. */
  readonly flyer?: string | undefined;
  /** The poll's embed: its address, `<origin>/embed/p/<code>`, and the frame's height. */
  readonly embed?: { readonly page: string; readonly height: number } | undefined;
}

type CopyState = "idle" | "copied" | "failed";

/** Copying `text` to the clipboard, and how it went. */
function useCopy() {
  const [state, setState] = useState<CopyState>("idle");
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  };
  return { state, copy, reset: () => setState("idle") };
}

const ROW =
  "flex min-h-12 w-full items-center gap-3 px-3 text-start text-base hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

const hasWebShare = () => typeof navigator !== "undefined" && typeof navigator.share === "function";

/**
 * "Share this poll" (docs/design/sharing.md, Share sheet): the short link
 * with Copy link, then the system's share menu where the browser has one,
 * or an email where it doesn't, then a QR code of the same link, drawn in
 * the browser by our own encoder, a printable flyer carrying it, and the
 * poll's embed for other sites (src/components/poll-embed.tsx). The link
 * carries no per-person code, so sharing it can't tie the sharer to the
 * poll, let alone to an answer, and nothing here reaches our servers or
 * analytics: the copy and the share happen in the browser (T-10, T-67). No count of who else shared, nothing
 * to nudge with.
 */
export function PollShare({ url, title, canShare, flyer, embed }: PollShareProps) {
  const t = useTranslate(catalogs);
  const { state: copied, copy, reset } = useCopy();
  const [qr, setQr] = useState(false);
  const [view, setView] = useState<"share" | "embed">("share");
  const linkId = useId();
  const qrId = useId();
  // The panel only renders once the dialog opens in the browser, so the
  // detection never differs between the server's HTML and hydration.
  const share = canShare ?? hasWebShare();
  // Only `{ title, url }` (docs/design/sharing.md): nothing about the sharer.
  const mail = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}`;
  return (
    <Dialog
      onOpenChange={() => {
        reset();
        setQr(false);
        setView("share");
      }}
    >
      {/* As wide as its words, its icon after them, as the green way in
          beside it is: a minimum width put the icon at the far edge of a box
          wider than that button (P2-29, the poll page's iteration 14). */}
      <DialogTrigger render={<Button variant="outline" size="lg" />}>
        {t("shareOpen")}
        <Share2 aria-hidden="true" />
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] gap-6 overflow-y-auto p-6 text-base sm:max-w-lg">
        <DialogHeader className="gap-2 pe-12">
          <DialogTitle className="text-2xl font-semibold">
            {t(view === "embed" ? "embedTitle" : "shareOpen")}
          </DialogTitle>
          <DialogDescription className="text-base text-pretty text-muted-foreground">
            {t(view === "embed" ? "embedDescription" : "shareNeverYourAnswer")}
          </DialogDescription>
        </DialogHeader>
        {view === "embed" && embed !== undefined ? (
          <EmbedPanel {...embed} url={url} title={title} onBack={() => setView("share")} />
        ) : (
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
                <Button className="sm:min-w-40" onClick={() => void copy(url)}>
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
                <div
                  id={qrId}
                  hidden={!qr}
                  className="grid justify-items-start gap-2 px-3 pt-2 pb-4"
                >
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
                  <p className="m-0 text-sm text-pretty text-muted-foreground">
                    {t("shareQrNote")}
                  </p>
                </div>
              </li>
              {flyer === undefined ? null : (
                <li>
                  <a href={flyer} className={ROW}>
                    <Printer aria-hidden="true" className="size-5" />
                    <span className="flex-1">{t("shareFlyer")}</span>
                  </a>
                </li>
              )}
              {embed === undefined ? null : (
                <li>
                  <button type="button" className={ROW} onClick={() => setView("embed")}>
                    <Code aria-hidden="true" className="size-5" />
                    <span className="flex-1">{t("shareEmbed")}</span>
                  </button>
                </li>
              )}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const KINDS = [
  { key: "card", label: "embedKindCard", note: "embedKindCardNote" },
  { key: "link", label: "embedKindLink", note: "embedKindLinkNote" },
] as const satisfies readonly { key: EmbedKind; label: keyof Messages; note: keyof Messages }[];

const THEME_LABEL = {
  auto: "embedThemeAuto",
  light: "embedThemeLight",
  dark: "embedThemeDark",
} as const satisfies Record<EmbedTheme, keyof Messages>;

interface EmbedPanelProps {
  /** The embed's address, `<origin>/embed/p/<code>`. */
  readonly page: string;
  /** The frame's height for the poll's shape (`embedHeight`). */
  readonly height: number;
  readonly url: string;
  readonly title: string;
  readonly onBack: () => void;
}

/**
 * "Embed on your site" (docs/design/sharing.md, The embed decision): the
 * script-free card in an iframe, or a plain link that loads nothing from us,
 * with the card's colours, the code to paste and a way to see the card. The
 * code is the same for every poll's sharer and names no one (T-10); nothing
 * here reaches our servers or analytics (T-67).
 */
function EmbedPanel({ page, height, url, title, onBack }: EmbedPanelProps) {
  const t = useTranslate(catalogs);
  const [kind, setKind] = useState<EmbedKind>("card");
  const [theme, setTheme] = useState<EmbedTheme>("auto");
  const { state, copy, reset } = useCopy();
  const kindId = useId();
  const themeId = useId();
  const codeId = useId();
  const src = embedSrc(page, theme);
  const host = new URL(url).host;
  const snippet = embedSnippet(kind, { src, url, title, height }, t("embedLinkLine"));
  return (
    <div className="grid gap-6 text-base">
      <div className="grid gap-3">
        <p id={kindId} className="m-0 font-semibold">
          {t("embedKind")}
        </p>
        <RadioGroup
          aria-labelledby={kindId}
          value={kind}
          onValueChange={(value) => {
            setKind(value as EmbedKind);
            reset();
          }}
        >
          {KINDS.map((k) => (
            <Label
              key={k.key}
              className={cn(
                "flex min-h-12 items-start gap-3 border p-4 text-base leading-normal font-normal",
                kind === k.key ? "border-primary" : "border-border",
              )}
            >
              <RadioGroupItem value={k.key} className="mt-1" />
              <span className="grid gap-1">
                <span className="font-semibold">{t(k.label)}</span>
                <span className="text-sm text-pretty text-muted-foreground">
                  {t(k.note, { host })}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </div>
      {kind === "card" ? (
        <div className="grid gap-3">
          <p id={themeId} className="m-0 font-semibold">
            {t("embedTheme")}
          </p>
          <RadioGroup
            aria-labelledby={themeId}
            value={theme}
            onValueChange={(value) => {
              setTheme(value as EmbedTheme);
              reset();
            }}
            className="flex flex-wrap gap-x-6 gap-y-2"
          >
            {EMBED_THEMES.map((key) => (
              <Label key={key} className="min-h-12 text-base font-normal">
                <RadioGroupItem value={key} />
                {t(THEME_LABEL[key])}
              </Label>
            ))}
          </RadioGroup>
        </div>
      ) : null}
      <div className="grid gap-2">
        <label htmlFor={codeId} className="font-semibold">
          {t("embedCode")}
        </label>
        <Textarea
          id={codeId}
          readOnly
          value={snippet}
          spellCheck={false}
          className="min-h-36 font-mono text-sm break-all"
          onFocus={(event) => event.currentTarget.select()}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => void copy(snippet)}>
            {state === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {t(state === "copied" ? "embedCopied" : "embedCopy")}
          </Button>
          <p role="status" className="m-0 text-sm text-muted-foreground">
            {state === "failed" ? t("embedCopyFailed") : ""}
          </p>
        </div>
      </div>
      <div className="grid gap-2">
        <p className="m-0 text-sm text-pretty text-muted-foreground">
          {t(kind === "card" ? "embedCardNote" : "embedLinkNote", { host })}
        </p>
        {kind === "card" ? (
          <a
            href={src}
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
          >
            {t("embedPreview")}
            <ExternalLink aria-hidden="true" className="size-4" />
            <span className="sr-only"> {t("embedNewTab")}</span>
          </a>
        ) : null}
      </div>
      <Button variant="ghost" className="justify-self-start" onClick={onBack}>
        <ArrowLeft aria-hidden="true" />
        {t("embedBack")}
      </Button>
    </div>
  );
}
