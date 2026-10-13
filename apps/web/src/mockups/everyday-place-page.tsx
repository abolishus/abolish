import {
  BoardMap,
  BoardZoomGraphic,
  Button,
  type BoardMapLabels,
  type InclusionPathLabels,
} from "@abolishus/ui";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@abolishus/ui/ui/sheet";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { type ReactNode, useState } from "react";

import {
  entryHash,
  fmt,
  ledgerAround,
  RIVERSIDE_BOARD,
  RIVERSIDE_CHECKPOINT,
  RIVERSIDE_MINE,
  RIVERSIDE_MINE_AT,
  RIVERSIDE_PROOF,
} from "./board-place-data.ts";
import { EVIDENCE_HREF } from "./everyday-data.ts";
import { RIVERSIDE } from "./everyday-fixtures.ts";
import {
  Byline,
  EverydayShell,
  EvidenceDetails,
  Frame,
  Seal,
  StepScene,
} from "./everyday-parts.tsx";
import { RECEIPT } from "./fixtures.ts";

const TOTAL = RIVERSIDE_BOARD.kinds.length;
const SEG = RIVERSIDE_MINE_AT.segment;
const DAYS = new Set(RIVERSIDE_BOARD.segments.map((s) => s.group)).size;
const SPAN = 24;
const STEPS = RIVERSIDE_PROOF.siblings.length;

const MAP: BoardMapLabels = {
  caption: `Every answer on the public board, ${fmt(TOTAL)} so far`,
  description:
    "Each answer as one small square, in the order they arrived: each hour's answers form a block, one line per day.",
  kinds: {
    ballot: "Answers",
    spoiled: "Answers checked and set aside",
    trustee: "Key holders' records",
    event: "Records from Ethereum",
  },
  anchored: "Written to Ethereum",
  unanchored: "Not written yet",
  mine: "Yours",
  position: `Yours is number {index} of {total}. It arrived on 3 November in the {segment} hour, which was written to Ethereum at 15:00.`,
};

const PATH: InclusionPathLabels = {
  caption: "How anyone can check yours is there",
  leaf: "Your answer",
  entryHash: "Its fingerprint",
  leafHash: "Leaf",
  step: "Step {step} of {total}",
  given: "From the board",
  computed: "Worked out",
  range: "answers {from}–{to}",
  single: "answer {index}",
  count: { one: "{count} answer", other: "{count} answers" },
  root: "One fingerprint for all {size} answers",
  anchoredRoot: "Written to Ethereum",
  verdict: {
    verified: "They match. Your answer is part of what was written to Ethereum.",
    mismatch: "They don't match. Something is wrong with this copy of the board.",
    pending: "This matches your receipt. It's written to Ethereum on the hour.",
  },
  fingerprint: "Fingerprint of {what}, {hash}",
  levels: {
    one: "{count} step from your answer to all {size}",
    other: "{count} steps from your answer to all {size}",
  },
  full: "Every step in full",
  sides: { left: "on the left", right: "on the right" },
};

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-3">
      <h3 className="m-0 font-heading text-2xl leading-snug font-semibold text-pretty">{title}</h3>
      <p className="m-0 text-lg text-pretty">{children}</p>
    </div>
  );
}

function Place({ onBack }: { onBack?: () => void }) {
  return (
    <>
      <Frame className="grid gap-6 pt-12 pb-6 md:pt-16">
        {onBack === undefined ? null : (
          <Button variant="ghost" className="justify-self-start" onClick={onBack}>
            <ArrowLeft aria-hidden="true" data-icon="inline-start" />
            Back to the poll
          </Button>
        )}
        <Byline>
          <span>{RIVERSIDE.title}</span>
        </Byline>
        <h1 className="m-0 max-w-3xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
          Your answer is one of {fmt(TOTAL)}
        </h1>
        <p className="m-0 max-w-prose text-lg text-pretty">
          Every answer to this poll is on a public list, the board, in the order it arrived. Here is
          where yours is. What it says stays sealed; none of this shows how you answered.
        </p>
      </Frame>
      <Frame>
        <StepScene
          label="Where your answer is"
          steps={[
            <Step key="board" title={`${fmt(TOTAL)} answers, one square each`}>
              Since the poll opened on 1 November, {fmt(TOTAL)} answers have arrived over {DAYS}{" "}
              days. Each hour&rsquo;s answers are written to Ethereum, a public record no one can
              rewrite, when the hour ends.
            </Step>,
            <Step key="segment" title="Your hour">
              Yours arrived on 3 November between 14:00 and 15:00, with {fmt(SEG.size - 1)} others.
              That hour was written to Ethereum at 15:00.
            </Step>,
            <Step key="neighbourhood" title="Your neighbours">
              The answers around yours are other people&rsquo;s, sealed like yours. The board shows
              when each arrived, never who sent it.
            </Step>,
            <Step key="entry" title="This one is yours">
              Number {fmt(RIVERSIDE_MINE)}. Its fingerprint is the seal on your receipt.
            </Step>,
            <Step key="proof" title="Anyone can check it">
              {STEPS} steps link your answer&rsquo;s fingerprint to a single fingerprint for the
              first {fmt(RIVERSIDE_CHECKPOINT)} answers, and that one was written to Ethereum at
              15:00 on 3 November. They match, so your answer can&rsquo;t quietly go missing.
            </Step>,
          ]}
          graphic={(step) => (
            <BoardZoomGraphic
              step={step}
              board={{
                kinds: RIVERSIDE_BOARD.kinds,
                segments: RIVERSIDE_BOARD.segments,
                mine: RIVERSIDE_MINE,
              }}
              views={{
                board: MAP,
                segment: {
                  ...MAP,
                  caption: `3 November, 14:00 to 15:00: ${fmt(SEG.size)} answers`,
                  description: "Each answer of that hour as one square, yours marked.",
                },
                neighbourhood: {
                  ...MAP,
                  caption: "The answers around yours",
                  description: "The answers just before and after yours, one square each.",
                },
              }}
              neighbourhood={{
                span: SPAN,
                ledger: {
                  caption: "Arrived around yours, times UTC",
                  columns: { index: "Number", time: "Arrived", kind: "What", hash: "Fingerprint" },
                  fingerprintLabel: (e) => `Fingerprint of number ${fmt(Number(e.index))}`,
                  entries: ledgerAround(RIVERSIDE_BOARD, RIVERSIDE_MINE, 2).map((e) => ({
                    ...e,
                    kind: e.kind === "Ballot" ? "Answer" : "Checked, set aside",
                  })),
                },
              }}
              entry={{
                title: `Number ${fmt(RIVERSIDE_MINE)}`,
                hash: entryHash(RIVERSIDE_BOARD, RIVERSIDE_MINE),
                hashLabel: "Its fingerprint, as on your receipt",
                fingerprintLabel: `Seal of your receipt, ${RECEIPT.hash.slice(0, 4)} ${RECEIPT.hash.slice(4, 8)}`,
                facts: [{ label: "Arrived", value: RECEIPT.recorded }],
              }}
              proof={{
                ...RIVERSIDE_PROOF,
                anchor: {
                  root: RIVERSIDE_PROOF.root,
                  size: RIVERSIDE_CHECKPOINT,
                  title: "Written to Ethereum, 3 November, 15:00 UTC",
                  facts: [{ label: "Block", value: fmt(SEG.anchor!.block) }],
                },
                verdict: "verified",
                labels: PATH,
              }}
            />
          )}
        />
        <p className="m-0 max-w-prose border-t border-border py-8 text-base text-pretty">
          Want every step, hash by hash?{" "}
          <a href={EVIDENCE_HREF} className="underline underline-offset-4">
            The civic record shows the proof in full
          </a>
          , and anyone can recount the poll from Ethereum without us.
        </p>
      </Frame>
    </>
  );
}

function Teaser({ onSee }: { onSee: () => void }) {
  return (
    <section className="grid gap-4 border border-border p-4">
      <h3 className="m-0 font-heading text-lg font-semibold">
        Your answer is one of {fmt(TOTAL)} on the public board
      </h3>
      <BoardMap
        kinds={RIVERSIDE_BOARD.kinds}
        segments={RIVERSIDE_BOARD.segments}
        mine={RIVERSIDE_MINE}
        labels={{ ...MAP, position: undefined }}
        legend={false}
        maxHeight={200}
        maxCell={6}
      />
      <p className="m-0 text-sm text-pretty">
        Every square is a real answer, in the order it arrived. Yours is number{" "}
        {fmt(RIVERSIDE_MINE)}, from 3 November.
      </p>
      <Button className="justify-self-start" onClick={onSee}>
        See where
        <ArrowRight aria-hidden="true" data-icon="inline-end" />
      </Button>
    </section>
  );
}

export interface EverydayPlacePageProps {
  /** Open on the poll's page, behind "How do we know this is real?", or on the place itself. */
  start?: "poll" | "place";
}

/**
 * The everyday register's view of the reader's place on the board: the same
 * entries, segments and proof as the civic record, in calmer words, one step
 * down from "How do we know this is real?".
 */
export function EverydayPlacePage({ start = "poll" }: EverydayPlacePageProps) {
  const [view, setView] = useState(start);
  const [open, setOpen] = useState(false);
  if (view === "place")
    return (
      <EverydayShell current="/discover" signedIn>
        <Place {...(start === "poll" ? { onBack: () => setView("poll") } : {})} />
      </EverydayShell>
    );
  return (
    <EverydayShell current="/discover" signedIn>
      <Sheet open={open} onOpenChange={setOpen}>
        <Frame className="grid gap-6 pt-12 pb-16 md:pt-20">
          <Byline>
            <span>Asked by {RIVERSIDE.askedBy}</span>
          </Byline>
          <h1 className="m-0 max-w-4xl font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-6xl">
            {RIVERSIDE.title}
          </h1>
          <p className="m-0 max-w-prose text-lg text-pretty">
            You answered on 3 November. You can change your answers until it closes.
          </p>
          <SheetTrigger className="inline-flex min-h-12 items-center justify-self-start pe-3 text-start underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring focus-visible:outline-none">
            <Seal hash={RIVERSIDE.id} subject="poll">
              How do we know this is real?
            </Seal>
          </SheetTrigger>
        </Frame>
        <SheetContent className="overflow-y-auto text-base data-[side=right]:w-full data-[side=right]:sm:max-w-md">
          <SheetHeader className="gap-2 p-6 pe-16">
            <SheetTitle className="text-2xl font-semibold">How do we know this is real?</SheetTitle>
            <SheetDescription className="text-base text-muted-foreground">
              The evidence behind “{RIVERSIDE.title}”, in plain words.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-8 px-6 pb-8">
            <Teaser
              onSee={() => {
                setOpen(false);
                setView("place");
              }}
            />
            <EvidenceDetails poll={RIVERSIDE} />
          </div>
        </SheetContent>
      </Sheet>
    </EverydayShell>
  );
}
