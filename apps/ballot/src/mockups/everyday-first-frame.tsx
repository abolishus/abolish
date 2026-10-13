import { Button, cn, Fingerprint } from "@abolishus/ui";
import { Check, Clock, KeyRound, Lock } from "lucide-react";
import type { ReactNode } from "react";

import type { EverydayPoll } from "./everyday-fixtures.ts";
import { VOTING_APP_HOST } from "./everyday-first-fixtures.ts";
import { Note, OneTapAway } from "./everyday-frame.tsx";
import { shortHex } from "./fixtures.ts";

/** The poll's seal as the website draws it: the fingerprint in a small round mount. */
export function PollSeal({ poll }: { poll: EverydayPoll }) {
  return (
    <span className="grid size-11 shrink-0 place-items-center rounded-full border border-border">
      <Fingerprint
        value={poll.definitionHash}
        label={`Seal of this poll, ${shortHex(poll.definitionHash)}`}
        size={26}
      />
    </span>
  );
}

/**
 * The everyday ballot frame with the website's wordmark on top, so the two
 * sides of the handoff read as one product: the same wordmark, the same seal
 * in the same mount, then who asked, one task, and the actions at the bottom.
 */
export function FirstFrame({
  poll,
  question,
  primary,
  secondary,
  children,
}: {
  poll: EverydayPoll;
  question?: number;
  primary?: ReactNode;
  secondary?: ReactNode;
  children: ReactNode;
}) {
  const total = poll.questions.length;
  return (
    <div className="flex min-h-dvh flex-col bg-background font-sans text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-xl flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-3">
          <p className="m-0 flex items-baseline gap-2">
            <span className="font-heading text-2xl font-semibold tracking-tight">Abolish</span>
            <span className="text-sm text-muted-foreground">voting app</span>
          </p>
          <p className="m-0 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Lock aria-hidden="true" className="size-3.5" />
            {VOTING_APP_HOST}
          </p>
        </div>
        <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
          <PollSeal poll={poll} />
          <p className="m-0 min-w-0 flex-1 text-sm">
            <span className="font-semibold">{poll.askedBy}</span>
            <span className="text-muted-foreground"> asked</span>
          </p>
          <p className="m-0 shrink-0 text-sm text-muted-foreground">{poll.closesShort}</p>
        </div>
        {question === undefined || total < 2 ? null : (
          <div className="mx-auto flex max-w-xl items-center gap-4 px-4 pb-3">
            <p className="m-0 shrink-0 text-sm font-semibold tabular-nums">
              Question {question} of {total}
            </p>
            <ol aria-hidden="true" className="m-0 flex flex-1 list-none gap-1.5 p-0">
              {poll.questions.map((q, i) => (
                <li
                  key={q.key}
                  className={cn(
                    "h-1.5 flex-1 rounded-full",
                    i + 1 < question && "bg-foreground/60",
                    i + 1 === question && "bg-primary",
                    i + 1 > question && "bg-border",
                  )}
                />
              ))}
            </ol>
          </div>
        )}
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-8 pb-12">{children}</main>
      {primary === undefined && secondary === undefined ? null : (
        <div className="sticky bottom-0 border-t border-border bg-background">
          <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-4 sm:flex-row-reverse sm:justify-between">
            {primary}
            {secondary}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The one line a first visit adds above the question. Everything else about
 * setup, and the way in for someone who has answered on another device, is
 * one tap down.
 */
export function FirstTimeHere({ onRestore }: { onRestore: () => void }) {
  return (
    <OneTapAway
      summary={
        <span>
          <span className="font-semibold">First time here?</span> This device gets set up while you
          answer; there's nothing extra to do.
        </span>
      }
    >
      <div className="grid gap-2">
        <p className="m-0 font-semibold">What setting up means</p>
        <p className="m-0 text-pretty">
          Cloudflare checks that you're a person, not a bot; now and then it asks you to tick a box.
          Then this device makes a voting identity of its own. It isn't tied to an account, your
          name or your email, and it never leaves this device.
        </p>
      </div>
      <div className="grid gap-2">
        <p className="m-0 font-semibold">Answered before on another device?</p>
        <p className="m-0 text-pretty">
          If you backed up there with a passkey, use it here and carry on as the same person.
        </p>
        <div>
          <Button variant="outline" onClick={onRestore}>
            <KeyRound aria-hidden="true" />
            Use my passkey backup
          </Button>
        </div>
        <p className="m-0 text-pretty">
          Without a backup, this device starts as someone new. What you answered on the other device
          still counts; to change those answers, use that device.
        </p>
      </div>
    </OneTapAway>
  );
}

/** Where this device's setup stands: the bot check, the new identity and its registration. */
export type Setup = "working" | "check" | "ready" | "failed";

/**
 * Cloudflare's widget, shown only when it can't decide on its own. It runs on
 * its own page (ADR 0024), framed here at the widget's own size, and never
 * sees the answer. In the mockup the box is a plain checkbox.
 */
function CheckBox({ onDone }: { onDone: () => void }) {
  return (
    <div
      role="group"
      aria-label="Cloudflare's check"
      className="flex h-16 w-full max-w-75 items-center justify-between gap-3 rounded-md border border-border bg-background px-3"
    >
      <label className="flex min-h-12 cursor-pointer items-center gap-3">
        <input type="checkbox" className="size-6 accent-primary" onChange={onDone} />
        <span>Verify you are human</span>
      </label>
      <span className="text-xs text-muted-foreground">Cloudflare</span>
    </div>
  );
}

/**
 * The setup as one still line beside the answer: no spinner, no separate
 * step. It speaks up only when the person has something to do.
 */
export function SetupLine({
  setup,
  onChecked,
  onRetry,
}: {
  setup: Setup;
  onChecked: () => void;
  onRetry: () => void;
}) {
  return (
    <div role="status" className="grid gap-3">
      {setup === "working" || setup === "ready" ? (
        <div className="flex items-start gap-3 rounded-xl border border-border px-4 py-3">
          {setup === "working" ? (
            <Clock aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-pending" />
          ) : (
            <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-recorded" />
          )}
          <p className="m-0 grid gap-0.5">
            <span className="font-medium">
              {setup === "working"
                ? "Setting up this device to answer"
                : "This device is set up to answer"}
            </span>
            <span className="text-sm text-muted-foreground">
              {setup === "working"
                ? "Nothing for you to do. You can send whenever you're ready."
                : "Nothing for you to do."}
            </span>
          </p>
        </div>
      ) : null}
      {setup === "check" ? (
        <Note title="One quick check">
          <p className="m-0">
            Tick the box to show you're a person. It's Cloudflare's check, and it never sees your
            answer.
          </p>
          <CheckBox onDone={onChecked} />
        </Note>
      ) : null}
      {setup === "failed" ? (
        <Note tone="warn" title="We couldn't confirm you're a person">
          <p className="m-0">
            Cloudflare's check didn't go through, so this device isn't set up yet. Your answer is
            still chosen here, and nothing was sent.
          </p>
          <p className="m-0">
            Try the check again. If it fails again, open this page in another browser: private
            windows and some extensions can block the check.
          </p>
          <div>
            <Button variant="outline" onClick={onRetry}>
              Try the check again
            </Button>
          </div>
        </Note>
      ) : null}
    </div>
  );
}

/** Where the passkey backup stands, once the first answer is sealed. */
export type Backup = "offer" | "saved" | "skipped" | "unsupported";

/**
 * The backup offer, after the first answer and never before it. One sentence
 * of why, two equal choices, and what skipping means, without alarm.
 */
export function BackupOffer({
  backup,
  onBackUp,
  onSkip,
}: {
  backup: Backup;
  onBackUp: () => void;
  onSkip: () => void;
}) {
  return (
    <section aria-labelledby="backup-title" className="mt-8 grid gap-4">
      {backup === "offer" ? (
        <div className="grid gap-4 rounded-xl border border-border px-4 py-5">
          <h2 id="backup-title" className="m-0 font-heading text-xl font-semibold">
            Back up with a passkey?
          </h2>
          <p className="m-0 text-pretty">
            So you can change your answers, and keep answering, from your other devices as the same
            person.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button size="lg" variant="outline" onClick={onBackUp}>
              <KeyRound aria-hidden="true" />
              Back up with a passkey
            </Button>
            <Button size="lg" variant="ghost" onClick={onSkip}>
              Not now
            </Button>
          </div>
          <p className="m-0 text-sm text-pretty text-muted-foreground">
            If you skip it, you can still answer on this device. A new device would start as someone
            new. Your receipts stay on this device either way.
          </p>
        </div>
      ) : (
        <>
          <h2 id="backup-title" className="sr-only">
            Passkey backup
          </h2>
          <div role="status">
            {backup === "saved" ? (
              <Note tone="done" title="Backed up with your passkey">
                <p className="m-0">
                  On another device, open the voting app and choose “Use my passkey backup”. Your
                  receipts stay on this device.
                </p>
              </Note>
            ) : null}
            {backup === "skipped" ? (
              <p className="m-0 text-pretty text-muted-foreground">
                No backup for now. You can keep answering on this device, and back up later from
                this app.
              </p>
            ) : null}
            {backup === "unsupported" ? (
              <Note title="This passkey can't hold a backup">
                <p className="m-0">
                  Your browser or passkey app doesn't support what the backup needs, so nothing was
                  saved. You can keep answering on this device. To back up later, try another
                  browser or passkey app.
                </p>
              </Note>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
