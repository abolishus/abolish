import { Button, cn, useTranslate } from "@abolishus/ui";
import { Label } from "@abolishus/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { Flag } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { catalogs, type Messages } from "../messages.ts";
import type { ReportOutcome } from "../profile-report.ts";
import { REMOVAL_GROUNDS, type RemovalGround } from "../moderation-grounds.ts";

/** The words that name what is reported; the rest are the same for a profile and a poll. */
export interface ReportWords {
  readonly title: keyof Messages;
  readonly help: keyof Messages;
  readonly open: keyof Messages;
  readonly legend: keyof Messages;
  /** What is said when the thing reported is gone. */
  readonly gone: keyof Messages;
}

/**
 * Reporting a profile or a poll to moderators, under one of the policy's
 * removal grounds (docs/moderation-policy.md): nothing is sent until a
 * ground is chosen and the report confirmed, and nothing about the reporter
 * is sent at all (src/profile-report.ts, src/poll-report.ts; T-10, T-11).
 */
export function ReportSection({
  words,
  send,
}: {
  words: ReportWords;
  /** Sends the report under `reason`. Never throws. */
  send: (reason: RemovalGround) => Promise<ReportOutcome>;
}) {
  const t = useTranslate(catalogs);
  const legendId = useId();
  const helpId = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<RemovalGround | undefined>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ReportOutcome | undefined>();
  const legend = useRef<HTMLLegendElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const said = { reported: "byReportDone", gone: words.gone, failed: "byReportFailed" } as const;

  // Focus moves once React has rendered the change, which can come after
  // the next frame: the form's question when it opens, the button that
  // opened it when it closes.
  const moved = useRef(false);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    (open ? legend.current : opener.current)?.focus();
  }, [open]);

  const start = () => {
    setOutcome(undefined);
    setReason(undefined);
    moved.current = true;
    setOpen(true);
  };

  const close = () => {
    moved.current = true;
    setOpen(false);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason === undefined) return;
    setBusy(true);
    const result = await send(reason);
    setBusy(false);
    setOutcome(result);
    if (result !== "failed") close();
  };

  return (
    <section
      aria-labelledby={`${legendId}-title`}
      className="grid gap-4 border-t border-border pt-8"
    >
      <h2 id={`${legendId}-title`} className="m-0 font-heading text-xl font-semibold">
        {t(words.title)}
      </h2>
      <p id={helpId} className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
        {t(words.help)}{" "}
        <a className="underline underline-offset-4" href="/moderation">
          {t("byReportPolicy")}
        </a>
      </p>
      {open ? (
        <form className="grid gap-4" aria-busy={busy} onSubmit={(e) => void submit(e)}>
          <fieldset className="m-0 grid gap-3 border-0 p-0" aria-describedby={helpId}>
            <legend
              id={legendId}
              ref={legend}
              tabIndex={-1}
              className="mb-3 p-0 text-base font-semibold outline-none"
            >
              {t(words.legend)}
            </legend>
            <RadioGroup
              aria-labelledby={legendId}
              value={reason ?? ""}
              onValueChange={(value) => setReason(value as RemovalGround)}
              className="flex flex-wrap gap-2"
            >
              {REMOVAL_GROUNDS.map((r) => (
                <Label
                  key={r}
                  className={cn(
                    "flex min-h-12 items-center gap-3 border px-4 text-sm leading-tight font-normal",
                    reason === r
                      ? "border-2 border-primary px-[15px] font-semibold"
                      : "border-border",
                  )}
                >
                  <RadioGroupItem value={r} />
                  {t(`reason_${r}`)}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={busy || reason === undefined}>
              {t("byReportSend")}
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              {t("byReportCancel")}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          ref={opener}
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={start}
        >
          <Flag aria-hidden="true" />
          {t(words.open)}
        </Button>
      )}
      <p role="status" className="m-0 text-sm empty:hidden">
        {outcome === undefined ? null : t(said[outcome])}
      </p>
    </section>
  );
}
