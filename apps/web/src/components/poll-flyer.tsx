import { Button, cn, Fingerprint, QrCode, useI18n, useTranslate } from "@abolishus/ui";
import { ArrowLeft, Printer, ScanLine } from "lucide-react";

import { INKS, type Ink, PAPERS, type Paper } from "../flyer.ts";
import { catalogs } from "../messages.ts";
import { type Instant, pollStatus, type PollView } from "../poll.ts";
import { formatUtc } from "./format.ts";

export interface PollFlyerProps {
  poll: Pick<PollView, "definitionHash" | "questions" | "opensAt" | "closesAt">;
  /** When the page was loaded: the poll's status is read at this time. */
  asOf: Instant;
  /** The poll's canonical short code. */
  code: string;
  /** Its short link, `<origin>/p/<code>`, the same for everyone. */
  url: string;
  /** The link preview's headline: the question once the API serves it. */
  title: string;
  paper: Paper;
  ink: Ink;
}

/**
 * Each paper's sheet. Sizes inside the sheet are in container units, so it
 * is the same drawing on a phone's screen and on paper; the wrapper's print
 * width is the paper's, and the sheet names the `@page` (src/styles.css)
 * that prints it with no margin.
 */
const SHEET = {
  a4: {
    frame: "max-w-[210mm] print:w-[210mm]",
    sheet: "aspect-[210/297] [page:flyer-a4]",
    tabs: "h-[17cqw]",
  },
  letter: {
    frame: "max-w-[8.5in] print:w-[8.5in]",
    sheet: "aspect-[17/22] [page:flyer-letter]",
    tabs: "h-[14.5cqw]",
  },
} as const satisfies Record<Paper, { frame: string; sheet: string; tabs: string }>;

/** How many tabs to tear off along the foot. */
const TABS = 7;

/** An instant as the flyer prints it, in UTC like every time on the board. */
function useWhen() {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  return (instant: Instant) =>
    instant.iso === undefined
      ? instant.seconds
      : t("utcTime", { time: formatUtc(locale, new Date(instant.iso)) });
}

/**
 * The flyer itself (docs/design/sharing.md, Printable flyer): the headline,
 * a large QR code of the short link at level Q, the link to type, when the
 * poll closes, how to answer, that anyone can check the count, and tear-off
 * tabs carrying the link. It holds the same link as every other way of
 * sharing, so a flyer says nothing about who put it up (T-10), and nothing
 * about answers: no count, no lead. Always the light palette, as paper is;
 * `mono` drops the emerald band and frame for office printers.
 */
export function FlyerSheet({ poll, asOf, code, url, title, paper, ink }: PollFlyerProps) {
  const t = useTranslate(catalogs);
  const when = useWhen();
  const status = pollStatus(poll, asOf);
  const mono = ink === "mono";
  const accent = mono ? "text-black" : "text-primary";
  const link = url.replace(/^https?:\/\//, "");
  const host = link.slice(0, link.indexOf("/"));
  const many = poll.questions.length > 1;
  return (
    <div
      data-flyer=""
      data-theme="light"
      data-testid="flyer"
      className={cn(
        "flex flex-col overflow-hidden bg-white font-sans text-black",
        SHEET[paper].sheet,
      )}
    >
      {mono ? null : <div aria-hidden="true" className="h-[1.5cqw] shrink-0 bg-primary" />}
      {/* Spread down the sheet, so a short question leaves no hole above the tabs. */}
      <div className="flex min-h-0 flex-1 flex-col justify-between gap-[2.6cqw] px-[7cqw] py-[4.5cqw]">
        <div className="flex items-start justify-between gap-[3cqw]">
          <p className={cn("m-0 text-[length:2.8cqw] font-semibold", accent)}>
            {t("flyerKicker", { host })}
          </p>
          <span className="block size-[9cqw] shrink-0 [&>svg]:size-full">
            <Fingerprint
              value={poll.definitionHash}
              label={t("fingerprintDefinition", { prefix: poll.definitionHash.slice(0, 8) })}
            />
          </span>
        </div>
        <div className="grid gap-[1.4cqw]">
          <h2 className="m-0 line-clamp-4 font-heading text-[length:5.8cqw] leading-[1.08] font-semibold tracking-tight text-balance break-words">
            {title}
          </h2>
          {many ? (
            <p className="m-0 text-[length:2.8cqw] text-zinc-700">
              {t("flyerQuestions", { count: poll.questions.length })}
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-[auto_1fr] items-center gap-[5cqw]">
          <div
            className={cn(
              "border-[0.6cqw] bg-white p-[1cqw]",
              mono ? "border-black" : "border-primary",
            )}
          >
            <span className="block size-[26cqw] [&>svg]:size-full">
              <QrCode
                // The upper-case link: alphanumeric mode keeps it to the
                // coarsest grid at level Q, which survives a crease, a smudge
                // or a pin through a corner (docs/design/sharing.md, QR codes).
                value={url.toUpperCase()}
                label={t("shareQrLabel", { link })}
                level="Q"
              />
            </span>
          </div>
          <div className="grid min-w-0 content-center gap-[1.8cqw]">
            <p className="m-0 flex items-center gap-[1.4cqw] text-[length:3.8cqw] leading-tight font-semibold">
              <ScanLine aria-hidden="true" className={cn("size-[4.6cqw] shrink-0", accent)} />
              {t(status === "closed" ? "flyerScanClosed" : "flyerScan")}
            </p>
            <p className="m-0 text-[length:2.5cqw] text-zinc-700">{t("flyerOrType")}</p>
            <p className="m-0 font-heading text-[length:4.4cqw] leading-none font-semibold break-all">
              {link}
            </p>
            <p className="m-0 text-[length:2.6cqw] text-pretty">
              {status === "scheduled"
                ? t("flyerOpens", { opens: when(poll.opensAt), closes: when(poll.closesAt) })
                : t(status === "closed" ? "flyerClosed" : "flyerCloses", {
                    time: when(poll.closesAt),
                  })}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-[3cqw] border-[0.25cqw] border-zinc-300 p-[2.6cqw] text-[length:2.2cqw] leading-snug">
          <div className="grid content-start gap-[1cqw]">
            <h3 className="m-0 text-[length:2.5cqw] font-semibold">
              {t(status === "closed" ? "flyerClosedTitle" : "flyerHowTitle")}
            </h3>
            <p className="m-0 text-pretty">
              {t(status === "closed" ? "flyerClosedBody" : "flyerHow")}
            </p>
          </div>
          <div className="grid content-start gap-[1cqw]">
            <h3 className="m-0 text-[length:2.5cqw] font-semibold">{t("flyerCheckTitle")}</h3>
            <p className="m-0 text-pretty">{t("flyerCheck")}</p>
          </div>
        </div>
        <p className="m-0 text-[length:2cqw] text-pretty text-zinc-700">{t("flyerFoot")}</p>
      </div>
      <ul
        aria-label={t("flyerTabs")}
        className={cn(
          "m-0 grid shrink-0 list-none grid-cols-7 grid-rows-1 border-t-[0.25cqw] border-dashed border-zinc-500 p-0",
          SHEET[paper].tabs,
        )}
      >
        {Array.from({ length: TABS }, (_, i) => (
          <li
            key={i}
            className="flex items-center justify-center border-zinc-500 not-last:border-e-[0.25cqw] not-last:border-dashed"
          >
            {/* A host too long for the tab breaks onto another line rather than
                running off its edge. */}
            <span className="text-[length:2cqw] max-h-full leading-tight font-semibold wrap-anywhere [writing-mode:vertical-rl]">
              {host}/p/
              <br />
              {code}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CHOICE =
  "inline-flex min-h-12 items-center border border-border px-4 text-base underline-offset-4 hover:bg-muted aria-[current=page]:border-foreground aria-[current=page]:font-semibold aria-[current=page]:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none";

/** The flyer page's address for one paper and ink. */
export const flyerHref = (code: string, paper: Paper, ink: Ink) =>
  `/p/${code}/flyer?paper=${paper}&ink=${ink}`;

/**
 * The flyer page: the sheet as it prints, scaled to the screen, with links
 * to the other paper and ink and a print button. The choices are links, so
 * they work without the page's script; only the button needs it, and the
 * browser's own Print prints the same sheet (src/styles.css).
 */
export function PollFlyer(props: PollFlyerProps) {
  const t = useTranslate(catalogs);
  const { code, paper, ink } = props;
  const choices = [
    {
      id: "flyer-paper",
      label: t("flyerPaper"),
      options: PAPERS.map((p) => ({
        key: p,
        text: t(p === "a4" ? "flyerPaperA4" : "flyerPaperLetter"),
        href: flyerHref(code, p, ink),
        current: p === paper,
      })),
    },
    {
      id: "flyer-ink",
      label: t("flyerInk"),
      options: INKS.map((i) => ({
        key: i,
        text: t(i === "mono" ? "flyerInkMono" : "flyerInkColor"),
        href: flyerHref(code, paper, i),
        current: i === ink,
      })),
    },
  ];
  return (
    <div className="grid gap-10">
      <div className="grid gap-6 pt-2 md:pt-10 print:hidden">
        <a
          href={`/p/${code}`}
          className="inline-flex min-h-12 items-center gap-2 justify-self-start underline underline-offset-4"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          {t("flyerBack")}
        </a>
        <h1 className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
          {t("flyerTitle")}
        </h1>
        <p className="m-0 max-w-prose text-lg text-pretty">{t("flyerIntro")}</p>
        {choices.map((choice) => (
          <div key={choice.id} className="grid gap-2">
            <p id={choice.id} className="m-0 font-semibold">
              {choice.label}
            </p>
            <ul aria-labelledby={choice.id} className="m-0 flex list-none flex-wrap gap-2 p-0">
              {choice.options.map((option) => (
                <li key={option.key}>
                  <a
                    href={option.href}
                    aria-current={option.current ? "page" : undefined}
                    className={CHOICE}
                  >
                    {option.text}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <div className="grid gap-2">
          <Button size="lg" className="justify-self-start" onClick={() => window.print()}>
            <Printer aria-hidden="true" />
            {t("flyerPrint")}
          </Button>
          <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
            {t("flyerPrintNote")}
          </p>
        </div>
      </div>
      <figure
        aria-label={t("flyerPreview")}
        className={cn("m-0 @container w-full border border-border shadow-sm", SHEET[paper].frame)}
      >
        <FlyerSheet {...props} />
      </figure>
    </div>
  );
}
