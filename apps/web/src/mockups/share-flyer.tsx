import { Button, cn } from "@abolishus/ui";
import { Printer, ScanLine } from "lucide-react";

import { ROUND } from "./everyday-parts.tsx";
import { alsoAt, type SharePoll, shortCode, shortLink, WEB_HOST } from "./share-data.ts";
import { QrPlaceholder, ScaleToFit, SealMark } from "./share-parts.tsx";

export type Paper = "a4" | "letter";

/** Page sizes at 96 CSS pixels to the inch, and as @page names them. */
export const PAPER: Record<Paper, { width: number; height: number; page: string; name: string }> = {
  a4: { width: 794, height: 1123, page: "A4", name: "A4" },
  letter: { width: 816, height: 1056, page: "letter", name: "US Letter" },
};

const TABS = 7;

/**
 * A noticeboard flyer: the question, a large QR code, the short link to type,
 * when it closes, how to answer and that anyone can check the count, with
 * tear-off tabs carrying the link. `mono` is the black-and-white version for
 * office printers and photocopies.
 */
export function Flyer({
  poll,
  paper = "a4",
  mono = false,
}: {
  poll: SharePoll;
  paper?: Paper;
  mono?: boolean;
}) {
  const size = PAPER[paper];
  const accent = mono ? "text-black" : "text-primary";
  const many = poll.questions.length > 1;
  return (
    <div
      data-theme="light"
      data-flyer=""
      data-testid="flyer"
      className="flex flex-col overflow-hidden bg-white font-sans text-black"
      style={{ width: size.width, height: size.height }}
    >
      <div aria-hidden="true" className={cn("h-3 shrink-0", mono ? "bg-black" : "bg-primary")} />
      <div className="flex flex-1 flex-col gap-5 px-14 pt-8">
        <div className="flex items-start justify-between gap-6">
          <div className="grid gap-1">
            <p className={cn("m-0 text-[22px] font-semibold", accent)}>
              A question for {poll.place}
            </p>
            <p className="m-0 text-[20px] text-zinc-700">Asked by {poll.askedBy}</p>
          </div>
          <SealMark id={poll.id} size={72} className="border-zinc-400" />
        </div>
        <p
          className={cn(
            "m-0 font-heading leading-[1.08] font-semibold tracking-tight text-balance",
            paper === "letter" ? "text-[42px]" : "text-[46px]",
          )}
        >
          {poll.title}
        </p>
        {many ? (
          <p className="m-0 -mt-3 text-[22px] text-zinc-700">
            {poll.questions.length} short questions, about a minute.
          </p>
        ) : null}
        <div className="grid grid-cols-[auto_1fr] items-center gap-10">
          <div className={cn(" border-4 p-3", mono ? "border-black" : "border-primary")}>
            <QrPlaceholder id={poll.id} size={200} caption={false} />
          </div>
          <div className="grid content-center gap-4">
            <p className="m-0 flex items-center gap-3 text-[30px] font-semibold">
              <ScanLine aria-hidden="true" className={cn("size-9", accent)} />
              Scan to answer
            </p>
            <p className="m-0 text-[20px] text-zinc-700">or type</p>
            <p className="m-0 font-heading text-[38px] leading-none font-semibold break-all">
              {shortLink(poll.id)}
            </p>
            <p className="m-0 text-[22px]">
              Closes <span className="font-semibold">{poll.closes}</span>
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-6 border-2 border-zinc-300 p-5 text-[18px] leading-snug">
          <div className="grid content-start gap-2">
            <p className="m-0 text-[20px] font-semibold">How to answer</p>
            <p className="m-0 text-pretty">
              Open the link on a phone or computer and tap your answer. It takes about a minute, and
              you can change it until the poll closes.
            </p>
          </div>
          <div className="grid content-start gap-2">
            <p className="m-0 text-[20px] font-semibold">Anyone can check the count</p>
            <p className="m-0 text-pretty">
              Every answer is sealed and listed on a public board, never linked to who sent it.
              Anyone can recount the result.
            </p>
          </div>
        </div>
        <p className="m-0 text-[16px] text-zinc-700">
          If {WEB_HOST} doesn’t open: {alsoAt(poll.id)}. Non-binding, run by citizens.
        </p>
      </div>
      <ol
        aria-label="Tear-off tabs"
        className="m-0 mt-5 grid shrink-0 list-none border-t-2 border-dashed border-zinc-500 p-0"
        style={{
          gridTemplateColumns: `repeat(${TABS}, 1fr)`,
          height: paper === "letter" ? 120 : 136,
        }}
      >
        {Array.from({ length: TABS }, (_, i) => (
          <li
            key={i}
            className="flex items-center justify-center border-zinc-500 not-last:border-e-2 not-last:border-dashed"
          >
            <span className="text-[16px] leading-tight font-semibold [writing-mode:vertical-rl]">
              {WEB_HOST}/p/
              <br />
              {shortCode(poll.id)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The flyer page on the website: the sheet at its real size, scaled to the
 * screen, with a print button. Printing drops everything but the sheet.
 */
export function FlyerPage({
  poll,
  paper = "a4",
  mono = false,
}: {
  poll: SharePoll;
  paper?: Paper;
  mono?: boolean;
}) {
  const size = PAPER[paper];
  const print = `@page { size: ${size.page}; margin: 0; }
@media print {
  body * { visibility: hidden; }
  [data-flyer], [data-flyer] * { visibility: visible; }
  [data-flyer] { position: fixed; top: 0; left: 0; print-color-adjust: exact; }
}`;
  return (
    <div className="grid gap-6">
      <style>{print}</style>
      <div className="grid gap-3 print:hidden">
        <h1 className="m-0 font-heading text-3xl font-semibold">Print a flyer</h1>
        <p className="m-0 max-w-prose text-base text-pretty">
          For noticeboards, shop windows and meetings. {size.name}, portrait
          {mono ? ", black and white" : ""}. The code and the link open the same poll:{" "}
          {shortCode(poll.id)}.
        </p>
        <Button
          variant="outline"
          className={cn(ROUND, "justify-self-start")}
          onClick={() => window.print()}
        >
          <Printer aria-hidden="true" />
          Print this flyer
        </Button>
      </div>
      <figure className="m-0 grid max-w-3xl gap-2">
        <div className="border border-border shadow-sm print:border-0 print:shadow-none">
          <ScaleToFit width={size.width} height={size.height}>
            <Flyer poll={poll} paper={paper} mono={mono} />
          </ScaleToFit>
        </div>
        <figcaption className="text-sm text-muted-foreground print:hidden">
          {size.name} flyer, shown at {size.width} × {size.height} and scaled to fit. The QR code is
          a placeholder.
        </figcaption>
      </figure>
    </div>
  );
}
