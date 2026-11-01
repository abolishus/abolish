import { buttonVariants, cn, useTranslate } from "@abolishus/ui";
import { ArrowRight, Check, KeyRound, Lock } from "lucide-react";
import type { ReactNode } from "react";

import { catalogs, type Messages } from "../messages.ts";
import { StepScene } from "./step-scene.tsx";

// The transitional panel's shape ([[0027-trustee-panels-and-live-results]],
// Part 3): every everyday poll at launch runs under it.
const THRESHOLD = 4;
const SEATS = 7;

const STEPS = [
  ["trust1Title", "trust1Body", "trust1Detail"],
  ["trust2Title", "trust2Body", "trust2Detail"],
  ["trust3Title", "trust3Body", "trust3Detail"],
  ["trust4Title", "trust4Body", "trust4Detail"],
] as const satisfies readonly (readonly [keyof Messages, keyof Messages, keyof Messages])[];

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-3 border border-border p-4">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// Drawn as SVG geometry, not inline widths: the CSP's style-src 'self'
// blocks `style` attributes. Illustrative shares, not any poll's count.
const SHARES = [0.62, 0.27, 0.11];

function Bars() {
  return (
    <svg viewBox="0 0 100 34" preserveAspectRatio="none" className="h-10 w-full">
      {SHARES.map((share, i) => (
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

/** The scene's picture for each step: a diagram, hidden from assistive technology. */
function TrustGraphic({ step }: { step: number }) {
  const t = useTranslate(catalogs);
  return (
    <div
      aria-hidden="true"
      data-testid="trust-graphic"
      data-step={step}
      className="mx-auto grid w-full max-w-lg gap-4"
    >
      {step === 0 ? (
        <div className="grid items-center gap-4 sm:grid-cols-[1fr_auto_1fr]">
          <Panel label={t("graphicAnswer")}>
            <span className="border border-border px-3 py-2 text-base">{t("graphicOption")}</span>
          </Panel>
          <ArrowRight className="mx-auto size-6 rotate-90 text-muted-foreground sm:rotate-0" />
          <Panel label={t("graphicSealed")}>
            <Lock className="size-10" />
          </Panel>
        </div>
      ) : null}
      {step === 1 ? (
        <Panel label={t("graphicBoard")}>
          <ol className="m-0 grid list-none gap-2 p-0">
            {[0, 1, 2, 3, 4].map((row) => (
              <li
                key={row}
                className={cn(
                  "flex items-center gap-3 border px-3 py-2",
                  row === 3 ? "border-primary" : "border-border",
                )}
              >
                <Lock className="size-4 text-muted-foreground" />
                <span className="h-2 flex-1 bg-muted" />
                {row === 3 ? (
                  <span className="text-sm font-medium">{t("graphicYours")}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </Panel>
      ) : null}
      {step === 2 ? (
        <Panel label={t("graphicOpen")}>
          {/* The keys wrap as one row: one at a time, a phone's card left
              the seventh alone under the lock, which reads as a lone seat. */}
          <span className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Lock className="size-8" />
            <span data-testid="trust-keys" className="flex items-center gap-1 sm:gap-2">
              {Array.from({ length: SEATS }, (_, seat) => (
                <KeyRound
                  key={seat}
                  className={cn(
                    "size-6",
                    seat < THRESHOLD ? "text-primary" : "text-muted-foreground",
                  )}
                />
              ))}
            </span>
          </span>
          <span className="text-base">
            {t("graphicSeats", { threshold: THRESHOLD, seats: SEATS })}
          </span>
        </Panel>
      ) : null}
      {step >= 3 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Panel label={t("graphicPublished")}>
            <Bars />
          </Panel>
          <Panel label={t("graphicRecount")}>
            <Bars />
          </Panel>
          <span className="flex items-center gap-2 text-base font-medium sm:col-span-2">
            <Check className="size-5 text-recorded" />
            {t("graphicMatch")}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** "Why you can trust a casual poll": what happens to an answer, in four steps. */
export function TrustScene() {
  const t = useTranslate(catalogs);
  return (
    <section aria-labelledby="trust-title" className="grid gap-6 border-t border-border pt-16">
      <div className="grid gap-4 lg:grid-cols-12 lg:gap-x-10">
        <h2
          id="trust-title"
          className="m-0 font-heading text-3xl leading-tight font-semibold text-balance sm:text-5xl lg:col-span-6"
        >
          {t("trustTitle")}
        </h2>
        <p className="m-0 max-w-prose text-lg text-pretty lg:col-span-6 lg:self-end">
          {t("trustLede")}
        </p>
      </div>
      <StepScene
        label={t("trustLabel")}
        steps={STEPS.map(([title, body, detail], i) => (
          <div key={title} className="grid gap-3">
            <p className="m-0 text-sm text-muted-foreground">
              {t("trustStep", { step: i + 1, total: STEPS.length })}
            </p>
            <h3 className="m-0 font-heading text-2xl font-semibold">{t(title)}</h3>
            <p className="m-0 text-lg text-pretty">{t(body)}</p>
            <p className="m-0 text-sm text-muted-foreground">
              {t(detail, { threshold: THRESHOLD, seats: SEATS })}
            </p>
          </div>
        ))}
        graphic={(step) => <TrustGraphic step={step} />}
      />
      {/* The mockup's band ends on where to read more and where to count
          again. The second link keeps how it works' words for the verify
          page: that page says no poll of ours can be recounted until boards
          are anchored (P4-1), so the link promises the how, not a result.
          Both wrap, since the Spanish words outgrow a phone's width. */}
      <div className="flex flex-wrap gap-3">
        <a
          href="/how-it-works"
          className={cn(
            buttonVariants({ size: "lg" }),
            "h-auto min-h-12 max-w-full py-3 whitespace-normal",
          )}
        >
          {t("trustHowItWorks")}
        </a>
        <a
          href="/verify"
          className={cn(
            buttonVariants({ size: "lg", variant: "outline" }),
            "h-auto min-h-12 max-w-full py-3 whitespace-normal",
          )}
        >
          {t("howVerify")}
        </a>
      </div>
    </section>
  );
}
