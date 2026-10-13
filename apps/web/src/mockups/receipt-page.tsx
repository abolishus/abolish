import {
  BoardLedger,
  Button,
  Fingerprint,
  Hash,
  ReceiptStub,
  StatusTrail,
  type StatusStep,
} from "@abolishus/ui";
import { Textarea } from "@abolishus/ui/ui/textarea";
import { ArrowRight, Check, CircleDashed, ScanLine } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";

import { AS_OF, RECEIPT_EXCERPT, short } from "./board-data.ts";
import { Micro, Section } from "./board-parts.tsx";
import { ENTRY_POINTS, PARKS, RECEIPT } from "./fixtures.ts";
import { MockShell, PageHead } from "./shell.tsx";

type Result =
  | { state: "idle" }
  | { state: "invalid"; length: number }
  | { state: "found" }
  | { state: "missing"; hash: string };

const normalise = (value: string) => value.replace(/\s+/g, "").replace(/^0x/i, "").toLowerCase();

const TRAIL: readonly StatusStep[] = [
  {
    label: "Encrypted on your device",
    state: "complete",
    detail: "3 Nov 2026, 14:02:11 UTC",
  },
  {
    label: "Recorded on the board",
    state: "complete",
    detail: `Entry 1,203 · ${RECEIPT.recorded}`,
  },
  {
    label: "Anchored to Ethereum",
    state: "complete",
    detail: `${RECEIPT.anchoredAt} · transaction 0x${short(RECEIPT.anchorTx)}`,
  },
  {
    label: "Counted",
    state: "pending",
    detail: "After voting closes on 15 Nov 2026, 12:00 UTC",
  },
];

function ResultHeading({ id, children }: { id: string; children: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <h2
      ref={ref}
      id={id}
      tabIndex={-1}
      className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance outline-none sm:text-5xl"
    >
      {children}
    </h2>
  );
}

function Found() {
  return (
    <>
      <section aria-labelledby="found-title" className="border-t border-foreground">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 md:grid-cols-12 md:gap-x-6 md:py-24">
          <div className="grid content-start gap-5 md:col-span-12">
            <Micro>02 · Found</Micro>
            <ResultHeading id="found-title">Your ballot is on the board</ResultHeading>
            <p className="m-0 max-w-prose text-lg text-pretty">
              Entry 1,203 on the board for {PARKS.title} matches your receipt, all 64 characters. It
              shows that your encrypted ballot was recorded. It does not show how you voted.
            </p>
          </div>
          <div className="reveal md:col-span-5">
            <ReceiptStub
              title="Your receipt"
              hash={RECEIPT.hash}
              entry={RECEIPT.entry}
              recordedAt={new Date("2026-11-03T14:02:12Z")}
              labels={{
                hash: "Receipt hash",
                fingerprint: "Fingerprint of receipt 1bdd ad59",
                entry: "Board entry",
                recordedAt: "Recorded",
              }}
            />
          </div>
          <div className="reveal grid content-start gap-5 md:col-span-6 md:col-start-7">
            <h3 className="m-0 font-heading text-xl font-semibold">Where it stands</h3>
            <StatusTrail
              label="Your ballot"
              steps={TRAIL}
              stateLabels={{ complete: "done", pending: "waiting", upcoming: "not yet" }}
              stepTemplate="{step}: {state}"
            />
            <p className="m-0 border-t border-border pt-4 text-sm text-muted-foreground">
              Nothing more is needed from you. If you cast again before the close, your latest
              ballot is the one counted, and this entry stays on the board.
            </p>
          </div>
        </div>
      </section>

      <Section
        index="03"
        mark="Compare"
        title="Does yours match the board's?"
        lede="Put the receipt you kept next to the board's entry. A different fingerprint always means a different hash."
      >
        <div className="grid items-center gap-8 md:grid-cols-[1fr_auto_1fr]">
          {[
            { label: "From your receipt", note: "Saved on your device when you cast" },
            { label: "On the board", note: `Entry 1,203, ${PARKS.title}` },
          ].map((side, i) => (
            <div key={side.label} className="contents">
              {i === 1 ? (
                <span
                  aria-hidden="true"
                  className="hidden font-heading text-5xl text-muted-foreground md:block"
                >
                  =
                </span>
              ) : null}
              <figure
                aria-label={side.label}
                className="reveal m-0 grid min-w-0 justify-items-start gap-5 border-t-2 border-foreground pt-4"
              >
                <figcaption className="grid gap-1">
                  <span className="font-medium">{side.label}</span>
                  <span className="text-sm text-muted-foreground">{side.note}</span>
                </figcaption>
                <Fingerprint
                  value={RECEIPT.hash}
                  label={`${side.label}: fingerprint of 1bdd ad59`}
                  size={152}
                />
                <div className="min-w-0 [&_code]:text-sm">
                  <Hash value={RECEIPT.hash} label="Hash" />
                </div>
              </figure>
            </div>
          ))}
        </div>
        <p className="m-0 flex items-start gap-3 border-y border-foreground py-4 text-base">
          <Check aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-recorded" />
          <span>
            The two hashes are identical, character for character, so the fingerprints are too. A
            matching glyph is only as strong as what you compare, which is why the verifier checks
            every character.
          </span>
        </p>
      </Section>

      <Section
        index="04"
        mark="In the ledger"
        title="Its place on the board"
        lede="Your entry among its neighbours. The entries around it are other people's ballots: they show when, never who or how."
      >
        <BoardLedger
          caption={`${PARKS.title}, entries 1,199–1,207 of 2,418, times UTC`}
          columns={{ index: "Entry", time: "Time (UTC)", kind: "Kind", hash: "Entry hash" }}
          fingerprintLabel={(e) =>
            `Fingerprint of entry ${Number(e.index).toLocaleString("en-US")}`
          }
          entries={RECEIPT_EXCERPT}
          highlight={RECEIPT.entry}
        />
        <p className="m-0 flex flex-wrap gap-x-8 gap-y-2">
          <a
            href="/board"
            className="inline-flex min-h-12 items-center gap-2 underline decoration-primary underline-offset-4"
          >
            Read the whole board <ArrowRight aria-hidden="true" className="size-4" />
          </a>
          <a
            href="/verify"
            className="inline-flex min-h-12 items-center gap-2 underline decoration-primary underline-offset-4"
          >
            Recount the poll yourself <ArrowRight aria-hidden="true" className="size-4" />
          </a>
        </p>
      </Section>
    </>
  );
}

function Missing({ hash }: { hash: string }) {
  const steps = [
    {
      title: "Check the hash you entered",
      body: (
        <>
          Compare the fingerprint above with the one on your receipt. If they differ, a character
          was mistyped or cut off when copying.
        </>
      ),
    },
    {
      title: "Wait for the next anchor",
      body: (
        <>
          A ballot cast in the last hour reaches the board within minutes and is anchored to
          Ethereum at the end of the hour. The next anchor is at 22:00 UTC; look again after it.
        </>
      ),
    },
    {
      title: "Look it up through another entry point",
      body: (
        <>
          Each entry point reads the board on its own, so one that is behind or blocked
          doesn&rsquo;t hide your entry everywhere:
          <ul className="m-0 mt-3 grid list-none gap-1 p-0">
            {ENTRY_POINTS.map((e) => (
              <li key={e.name} className="font-mono text-sm">
                {e.name}
              </li>
            ))}
          </ul>
        </>
      ),
    },
    {
      title: "Submit it directly",
      body: (
        <>
          Your ballot client keeps the encrypted ballot until a board confirms it. While voting is
          open, it can post the ballot straight to the contract on Ethereum, without our servers:
          open the receipt in the ballot client and choose Submit directly.
        </>
      ),
    },
  ];
  return (
    <>
      <section aria-labelledby="missing-title" className="border-t border-foreground">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 md:grid-cols-12 md:gap-x-6 md:py-24">
          <div className="grid content-start gap-5 md:col-span-7">
            <Micro>02 · Not found</Micro>
            <ResultHeading id="missing-title">
              No entry with this hash is on the board yet
            </ResultHeading>
            <p className="m-0 max-w-prose text-lg text-pretty">
              That is worth checking, and it is usually explained by timing or a typing slip. The
              steps below cover each case.
            </p>
          </div>
          <figure
            aria-label="What you entered"
            className="m-0 grid min-w-0 content-start gap-4 border-t-2 border-foreground pt-4 md:col-span-5"
          >
            <figcaption className="font-medium">What you entered</figcaption>
            <div className="flex flex-wrap items-start gap-4">
              <Fingerprint
                value={hash}
                label={`Fingerprint of the hash you entered, ${hash.slice(0, 4)} ${hash.slice(4, 8)}`}
                size={88}
              />
              <div className="min-w-0 flex-1 basis-48 [&_code]:text-sm">
                <Hash value={hash} label="Hash" />
              </div>
            </div>
          </figure>
          <div className="grid gap-10 border-t border-border pt-10 sm:grid-cols-2 md:col-span-12 md:gap-x-6">
            <div className="grid content-start gap-2">
              <h3 className="m-0 font-heading text-xl font-semibold">What this means</h3>
              <p className="m-0 text-base text-pretty">
                The copy of the board this site reads has no entry with this hash, as of {AS_OF}.
              </p>
            </div>
            <div className="grid content-start gap-2">
              <h3 className="m-0 font-heading text-xl font-semibold">What it doesn&rsquo;t mean</h3>
              <p className="m-0 text-base text-pretty">
                It doesn&rsquo;t mean your ballot was rejected or lost. Nothing on the board can be
                removed, and your device still holds the ballot it encrypted.
              </p>
            </div>
          </div>
        </div>
      </section>
      <Section index="03" mark="What to do" title="Four things to try, in order">
        <ol className="m-0 grid list-none border-t border-foreground p-0">
          {steps.map((step, i) => (
            <li
              key={step.title}
              className="reveal grid gap-3 border-b border-border py-6 md:grid-cols-12 md:gap-x-6"
            >
              <span className="font-mono text-sm text-muted-foreground tabular-nums md:col-span-1">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="m-0 font-heading text-xl font-semibold md:col-span-4">{step.title}</h3>
              <div className="max-w-prose text-base text-pretty md:col-span-7">{step.body}</div>
            </li>
          ))}
        </ol>
        <p className="m-0 flex items-start gap-3 text-sm text-muted-foreground">
          <CircleDashed aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            Still missing after the next anchor, through every entry point? That is what the board
            exists to catch.{" "}
            <a
              href="/how-it-works#missing-entry"
              className="text-foreground underline underline-offset-4"
            >
              Report a missing entry
            </a>
            , with your receipt hash. Observers can check it against Ethereum without us.
          </span>
        </p>
      </Section>
    </>
  );
}

export function ReceiptPage() {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<Result>({ state: "idle" });
  const [scanning, setScanning] = useState(false);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const hash = normalise(value);
    if (!/^[0-9a-f]{64}$/.test(hash)) setResult({ state: "invalid", length: hash.length });
    else if (hash === RECEIPT.hash) setResult({ state: "found" });
    else setResult({ state: "missing", hash });
  };
  const invalid = result.state === "invalid";

  return (
    <MockShell current="/verify">
      <PageHead
        eyebrow="Verify · Find your receipt"
        title="Find your ballot on the board"
        lede="Your receipt holds a 64-character hash. Enter it, or scan the QR code you saved, to see the entry it matches and how far it has got. A receipt shows that your ballot was recorded; it never shows how you voted."
      />
      <Section index="01" mark="Look up" title="Enter your receipt hash">
        <div className="grid gap-12 md:grid-cols-12 md:gap-x-6">
          <form
            onSubmit={submit}
            aria-label="Look up a receipt"
            className="grid content-start gap-3 md:col-span-7"
          >
            <label htmlFor={inputId} className="text-base font-medium">
              Receipt hash
            </label>
            <p id={hintId} className="m-0 text-sm text-muted-foreground">
              64 characters, 0–9 and a–f. Spaces and capital letters are ignored, so you can paste
              it as it appears on the receipt.
            </p>
            <Textarea
              id={inputId}
              name="receipt"
              rows={2}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              translate="no"
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? `${hintId} ${errorId}` : hintId}
              className="min-h-24 font-mono text-base leading-relaxed break-all md:text-base"
            />
            {invalid ? (
              <p id={errorId} role="alert" className="m-0 text-sm text-destructive">
                A receipt hash is 64 characters, 0–9 and a–f. What you entered has {result.length}.
              </p>
            ) : null}
            <div className="flex flex-wrap gap-3 pt-2">
              <Button type="submit">Look up</Button>
              <Button
                variant="outline"
                aria-expanded={scanning}
                onClick={() => setScanning((s) => !s)}
              >
                <ScanLine aria-hidden="true" data-icon="inline-start" />
                Scan the QR code
              </Button>
            </div>
            {scanning ? (
              <div className="mt-3 grid gap-4 border border-dashed border-foreground p-5 sm:grid-cols-[8rem_1fr] sm:items-center">
                <span aria-hidden="true" className="relative block size-32 bg-muted">
                  <span className="absolute top-2 left-2 size-5 border-t-2 border-l-2 border-foreground" />
                  <span className="absolute top-2 right-2 size-5 border-t-2 border-r-2 border-foreground" />
                  <span className="absolute bottom-2 left-2 size-5 border-b-2 border-l-2 border-foreground" />
                  <span className="absolute right-2 bottom-2 size-5 border-r-2 border-b-2 border-foreground" />
                </span>
                <p className="m-0 text-sm">
                  Your browser asks before it uses the camera. The picture stays on this device:
                  only the hash read from the code goes into the field above.
                </p>
              </div>
            ) : null}
          </form>
          <div className="grid content-start gap-4 md:col-span-4 md:col-start-9">
            <h3 className="m-0 font-heading text-xl font-semibold">Where to find it</h3>
            <dl className="m-0 grid gap-4 border-t border-foreground pt-4 text-sm">
              <div className="grid gap-1">
                <dt className="font-medium">In the ballot client</dt>
                <dd className="m-0 text-muted-foreground">
                  Receipts lists every ballot you have cast on this device.
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="font-medium">As a QR code</dt>
                <dd className="m-0 text-muted-foreground">
                  On the receipt screen after you cast, if you saved or printed it.
                </dd>
              </div>
              <div className="grid gap-1">
                <dt className="font-medium">Lost it?</dt>
                <dd className="m-0 text-muted-foreground">
                  Then no one can find your entry, us included: the board doesn&rsquo;t know whose
                  ballot is whose. That is what keeps your vote secret.
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </Section>
      {result.state === "found" ? <Found /> : null}
      {result.state === "missing" ? <Missing key={result.hash} hash={result.hash} /> : null}
    </MockShell>
  );
}
