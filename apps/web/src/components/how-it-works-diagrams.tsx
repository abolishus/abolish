import { cn, useTranslate } from "@abolishus/ui";
import {
  ArrowDown,
  ArrowRight,
  Check,
  CircleSlash,
  KeyRound,
  Lock,
  ShieldCheck,
  X,
} from "lucide-react";
import type { ReactNode } from "react";

import { catalogs, type Messages } from "../messages.ts";

// The diagrams beside each chapter of /how-it-works. Each is a picture of
// the step's text, hidden from assistive technology, and shows no number the
// text doesn't state. None sets an inline `style`: the CSP's style-src 'self'
// blocks them, so every shape is a class or an SVG attribute.

type Key = keyof Messages;

const label = "m-0 text-sm text-muted-foreground";

/** A diagram's frame: what it shows, and which step it is drawing. */
function Stage({
  testId,
  section,
  step,
  total,
  children,
}: {
  testId: string;
  section: Key;
  step: number;
  total: number;
  children: ReactNode;
}) {
  const t = useTranslate(catalogs);
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      data-step={step}
      className="mx-auto grid w-full max-w-lg gap-4"
    >
      <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground uppercase">
        {t("dgTitle", { section: t(section), step: step + 1, total })}
      </p>
      {children}
    </div>
  );
}

/** A box in a diagram: square, with its state in line style as well as colour. */
function Box({
  active = false,
  muted = false,
  className,
  children,
}: {
  active?: boolean;
  muted?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid min-w-0 content-start gap-2 border p-3 transition-colors duration-300 ease-out motion-reduce:transition-none",
        active ? "border-foreground border-s-4 border-s-primary" : "border-border",
        muted && "border-dashed text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="border border-border px-1.5 py-0.5 font-mono text-xs text-muted-foreground uppercase">
      {children}
    </span>
  );
}

/* Who can vote ----------------------------------------------------------- */

const TIERS = [
  { name: "tier2", fake: "dgFake2", cost: 3, rank: 2 },
  { name: "tier1", fake: "dgFake1", cost: 2, rank: 1 },
  { name: "tier0", fake: "dgFake0", cost: 1, rank: 0 },
] as const satisfies readonly { name: Key; fake: Key; cost: number; rank: number }[];

export function TiersDiagram({ step, total }: { step: number; total: number }) {
  const t = useTranslate(catalogs);
  return (
    <Stage testId="diagram-tiers" section="howTiersMark" step={step} total={total}>
      {TIERS.map((tier) => (
        <Box
          key={tier.name}
          active={step < 3 && tier.rank === step}
          muted={step < 3 && tier.rank > step}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="m-0 text-base font-semibold">{t(tier.name)}</p>
            <Tag>{tier.rank === 0 ? t("dgToday") : t("dgPlanned")}</Tag>
          </div>
          {step < 3 ? (
            <div className="flex items-center gap-3">
              <span className="flex gap-0.5">
                {[1, 2, 3].map((cell) => (
                  <span
                    key={cell}
                    className={cn(
                      "h-2 w-6 border border-foreground",
                      cell <= tier.cost && tier.rank <= step ? "bg-foreground" : "bg-transparent",
                    )}
                  />
                ))}
              </span>
              <span className="text-sm text-muted-foreground">
                {t("dgFake")}: {t(tier.fake)}
              </span>
            </div>
          ) : (
            <span className="text-sm">{t("dgResult")}</span>
          )}
        </Box>
      ))}
      {step >= 3 ? <p className="m-0 text-base font-medium">{t("dgNoTotal")}</p> : null}
    </Stage>
  );
}

/* Ballot secrecy --------------------------------------------------------- */

// Seats drawn in the secrecy and counting diagrams: the transitional panel's
// shape ([[0027-trustee-panels-and-live-results]], Part 3), which the text
// beside them states.
export const THRESHOLD = 4;
export const SEATS = 7;

function Seats({ lit, className }: { lit: number; className?: string }) {
  return (
    <span className={cn("flex flex-wrap gap-1.5", className)}>
      {Array.from({ length: SEATS }, (_, seat) => (
        <KeyRound
          key={seat}
          className={cn("size-5", seat < lit ? "text-primary" : "text-muted-foreground")}
        />
      ))}
    </span>
  );
}

export function SecrecyDiagram({ step, total }: { step: number; total: number }) {
  const t = useTranslate(catalogs);
  return (
    <Stage testId="diagram-secrecy" section="howSecrecyMark" step={step} total={total}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Box active={step === 0}>
          <span className={label}>{t("dgDevice")}</span>
          <span className="flex items-center gap-2 text-base">
            <Lock className="size-4" />
            {t("dgChoice")}
          </span>
        </Box>
        <div className="grid content-start gap-2">
          <span className={label}>{t("dgLeaves")}</span>
          {step >= 1 ? (
            <Box active={step === 1}>
              <span className="flex items-center gap-2 text-base font-medium">
                <Lock className="size-4" />
                {t("dgCommitment")}
              </span>
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <ArrowRight className="size-3.5" />
                {t("dgToBoard")}
              </span>
            </Box>
          ) : null}
          {step >= 2 ? (
            <Box active={step === 2}>
              <span className="text-base font-medium">{t("dgShares")}</span>
              <Seats lit={SEATS} />
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <ArrowRight className="size-3.5" />
                {t("dgToSeats")}
              </span>
            </Box>
          ) : null}
          {step >= 3 ? (
            <Box active={step === 3}>
              <span className="flex items-center gap-2 text-base font-medium">
                <ShieldCheck className="size-4" />
                {t("dgProofs")}
              </span>
              <span className="flex items-center gap-1 text-sm text-muted-foreground">
                <ArrowRight className="size-3.5" />
                {t("dgToBoard")}
              </span>
            </Box>
          ) : null}
        </div>
      </div>
    </Stage>
  );
}

/* Cast as intended ------------------------------------------------------- */

export function ChallengeDiagram({ step, total }: { step: number; total: number }) {
  const t = useTranslate(catalogs);
  return (
    <Stage testId="diagram-challenge" section="howChallengeMark" step={step} total={total}>
      {step === 0 ? (
        <Box active>
          <span className="flex items-center gap-2 text-base font-medium">
            <Lock className="size-4" />
            {t("dgSealed")}
          </span>
          <span className="flex gap-2">
            <span className="border border-foreground px-3 py-1 text-sm">{t("dgCast")}</span>
            <span className="border border-foreground px-3 py-1 text-sm">{t("dgCheck")}</span>
          </span>
        </Box>
      ) : null}
      {step === 1 ? (
        <Box active>
          <span className="text-base font-medium">{t("dgOpened")}</span>
          <span className="flex items-center gap-2 text-sm">
            <Check className="size-4 text-recorded" />
            {t("dgRebuilt")}
          </span>
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleSlash className="size-4" />
            {t("dgNotCounted")}
          </span>
        </Box>
      ) : null}
      {step >= 2 ? (
        <ol className="m-0 grid list-none gap-2 p-0">
          {[0, 1, 2].map((ballot) => {
            const cast = ballot === 2;
            return (
              <li key={ballot}>
                <Box active={step === 2 ? cast : !cast} muted={!cast}>
                  <span className="flex flex-wrap items-center justify-between gap-2 text-base">
                    <span className="flex items-center gap-2">
                      <Lock className="size-4" />
                      {cast ? t("dgSealedAgain") : t("dgSealed")}
                    </span>
                    <Tag>{cast ? t("dgCast") : t("dgChecked")}</Tag>
                  </span>
                </Box>
              </li>
            );
          })}
        </ol>
      ) : null}
    </Stage>
  );
}

/* Recorded as cast ------------------------------------------------------- */

const YOURS = 3;

export function RecordedDiagram({ step, total }: { step: number; total: number }) {
  const t = useTranslate(catalogs);
  return (
    <Stage testId="diagram-recorded" section="howRecordedMark" step={step} total={total}>
      <ol className="m-0 grid list-none gap-1.5 p-0">
        {[0, 1, 2, 3, 4].map((entry) => (
          <li
            key={entry}
            className={cn(
              "flex items-center gap-3 border px-3 py-1.5 font-mono text-xs",
              entry === YOURS ? "border-primary" : "border-border",
            )}
          >
            <Lock className="size-3.5 text-muted-foreground" />
            <span>{t("dgEntry", { index: entry })}</span>
            <span className="h-1.5 flex-1 bg-muted" />
            {entry === YOURS ? <span className="font-sans text-sm">{t("dgYours")}</span> : null}
          </li>
        ))}
      </ol>
      {step >= 1 ? (
        <>
          <ArrowDown className="mx-auto size-5 text-muted-foreground" />
          <Box active={step === 1 || step === 2}>
            <span className={label}>{t("dgReceipt")}</span>
            <span className="text-base">{t("dgReceiptEntry")}</span>
            {step >= 2 ? (
              <span className="flex items-center gap-2 text-sm">
                <Check className="size-4 text-recorded" />
                {t("dgInclusion")}: {t("dgStillThere")}
              </span>
            ) : null}
          </Box>
        </>
      ) : null}
      {step >= 3 ? (
        <Box active muted>
          <span className="flex flex-wrap items-center justify-between gap-2 text-base">
            {t("dgAnchor")}
            <Tag>{t("dgPlanned")}</Tag>
          </span>
        </Box>
      ) : null}
    </Stage>
  );
}

/* Counted as recorded ---------------------------------------------------- */

// Drawn as SVG geometry (CSP), illustrative shares and not any poll's count.
const BARS = [0.58, 0.31, 0.11];

function Bars() {
  return (
    <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="h-10 w-full">
      {BARS.map((share, i) => (
        <g key={i}>
          <rect x="0" y={i * 12} width="100" height="10" className="fill-muted" />
          <rect
            x="0"
            y={i * 12}
            width={share * 100}
            height="10"
            className={i === 0 ? "fill-primary" : "fill-foreground/55"}
          />
        </g>
      ))}
    </svg>
  );
}

export function CountedDiagram({ step, total }: { step: number; total: number }) {
  const t = useTranslate(catalogs);
  return (
    <Stage testId="diagram-counted" section="howCountedMark" step={step} total={total}>
      {step === 0 ? (
        <div className="grid gap-3">
          <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
            {[0, 1, 2, 3, 4].map((ballot) => (
              <span key={ballot} className="flex items-center gap-2">
                {ballot > 0 ? <span className="text-sm">+</span> : null}
                <Lock className="size-5" />
              </span>
            ))}
          </span>
          <Box active>
            <span className="flex items-center gap-2 text-base font-medium">
              <Lock className="size-5" />
              {t("dgTotal")}
            </span>
          </Box>
        </div>
      ) : null}
      {step === 1 || step === 2 ? (
        <Box active>
          <span className="text-base font-medium">{t("dgSum")}</span>
          <Seats lit={step === 1 ? SEATS : THRESHOLD} />
          <span data-testid="seat-count" className="text-base">
            {t("graphicSeats", { threshold: THRESHOLD, seats: SEATS })}
          </span>
          <span className="text-sm text-muted-foreground">{t("dgOurs")}</span>
        </Box>
      ) : null}
      {step >= 3 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Box>
            <span className={label}>{t("graphicPublished")}</span>
            <Bars />
          </Box>
          <Box>
            <span className={label}>{t("graphicRecount")}</span>
            <Bars />
          </Box>
          <span className="flex items-center gap-2 text-base font-medium sm:col-span-2">
            <Check className="size-5 text-recorded" />
            {t("graphicMatch")}
          </span>
        </div>
      ) : null}
    </Stage>
  );
}

/* What survives a takedown ----------------------------------------------- */

const LAYERS = [
  { name: "dgDomain", ours: true, from: 3 },
  { name: "dgServers", ours: true, from: 3 },
  { name: "dgRegistry", ours: false, from: 0 },
  { name: "dgDirect", ours: false, from: 1 },
  { name: "dgMirrors", ours: false, from: 2 },
  { name: "dgAnchors", ours: false, from: 2 },
  { name: "dgVerifier", ours: false, from: 3 },
] as const satisfies readonly { name: Key; ours: boolean; from: number }[];

export function SurvivesDiagram({ step, total }: { step: number; total: number }) {
  const t = useTranslate(catalogs);
  return (
    <Stage testId="diagram-survives" section="howSurvivesMark" step={step} total={total}>
      <ul className="m-0 grid list-none gap-1.5 p-0">
        {LAYERS.map((layer) => {
          const down = layer.ours && step >= 3;
          const shown = layer.ours || step >= layer.from;
          return (
            <li key={layer.name} data-down={down ? "" : undefined}>
              <Box active={!layer.ours && step === layer.from} muted={down || !shown}>
                <span className="flex flex-wrap items-center justify-between gap-2 text-base">
                  <span className={cn(down && "line-through")}>{t(layer.name)}</span>
                  {down ? (
                    <span className="flex items-center gap-1 text-sm">
                      <X className="size-4" />
                      {t("dgDown")}
                    </span>
                  ) : layer.ours ? null : shown ? (
                    <Tag>{t("dgPlanned")}</Tag>
                  ) : null}
                </span>
              </Box>
            </li>
          );
        })}
      </ul>
    </Stage>
  );
}
