import { Button, Fingerprint, SectionMark, TallyBars, cn } from "@abolishus/ui";
import { Label } from "@abolishus/ui/ui/label";
import { NativeSelect, NativeSelectOption } from "@abolishus/ui/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { Textarea } from "@abolishus/ui/ui/textarea";
import { Ban, EyeOff, ListX, RotateCcw } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { PARKS } from "./fixtures.ts";
import {
  GROUNDS,
  LOG,
  LOG_TOTAL,
  NEVER_GROUNDS,
  QUEUE,
  type QueueItem,
  RESTORE_GROUNDS,
} from "./moderation-data.ts";
import { Frame, MockShell, PageHead } from "./shell.tsx";

const short = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;

function SectionHead({
  index,
  mark,
  id,
  title,
  children,
}: {
  index: string;
  mark: string;
  id: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-12">
      <SectionMark index={index} className="lg:col-span-12">
        {mark}
      </SectionMark>
      <h2
        id={id}
        className="m-0 font-heading text-3xl leading-tight font-semibold tracking-tight text-balance sm:text-4xl lg:col-span-7"
      >
        {title}
      </h2>
      {children === undefined ? null : (
        <div className="max-w-prose text-base text-pretty lg:col-span-5 lg:pt-2">{children}</div>
      )}
    </div>
  );
}

const ACTION_ICON: Record<string, ReactNode> = {
  Delisted: <ListX className="size-4" />,
  Hidden: <EyeOff className="size-4" />,
  Restored: <RotateCcw className="size-4" />,
};

function ErrorText({ id, children }: { id: string; children: ReactNode }) {
  return (
    <p id={id} className="m-0 text-sm font-medium text-destructive">
      <span className="sr-only">Error: </span>
      {children}
    </p>
  );
}

/** What moderation can and can't reach, stated before anything else. */
function Boundary() {
  return (
    <div className="grid border-y-2 border-foreground md:grid-cols-2">
      <div className="grid content-start gap-4 border-b border-border py-8 md:border-e md:border-b-0 md:pe-8">
        <p className="m-0 font-mono text-xs tracking-widest uppercase">Acts on</p>
        <ul className="m-0 grid list-none gap-0 border-t border-foreground p-0 text-lg">
          <li className="border-b border-border py-3">
            A poll’s question, options and description
          </li>
          <li className="border-b border-border py-3">Whether our pages list the poll</li>
        </ul>
      </div>
      <div className="grid content-start gap-4 py-8 md:ps-8">
        <p className="m-0 flex items-center gap-2 font-mono text-xs tracking-widest uppercase">
          <Ban aria-hidden="true" className="size-4" />
          Never acts on
        </p>
        <ul className="m-0 grid list-none gap-0 border-t border-foreground p-0 text-lg">
          <li className="border-b border-border py-3">Ballots and the board</li>
          <li className="border-b border-border py-3">
            A poll’s definition, electorate or closing time
          </li>
          <li className="border-b border-border py-3">The count and the result</li>
        </ul>
      </div>
    </div>
  );
}

type Filter = "All" | "Delisted" | "Hidden" | "Restored";

export function ModerationLogPage() {
  const [filter, setFilter] = useState<Filter>("All");
  const rows = LOG.filter((r) => filter === "All" || r.action === filter);
  return (
    <MockShell current="/moderation">
      <PageHead
        eyebrow="Moderation · Public and append-only"
        title="Moderation acts on poll text, never on results"
        lede="Every decision we make about a poll is a row in this log, in the order we made it. Rows are only ever added: a decision is reversed by a later one, which stays beside it. The log doesn’t name the moderator, the person who reported a poll, or its creator."
      />
      <Frame className="grid gap-20">
        <section aria-label="What moderation can reach">
          <Boundary />
          <p className="m-0 max-w-prose pt-6 text-base text-pretty">
            Every result stays verifiable from Ethereum and IPFS by the public verifier, whatever
            our pages show.
          </p>
        </section>

        <section aria-labelledby="log-title" className="grid gap-8">
          <SectionHead index="01" mark="The log" id="log-title" title="Decisions, newest first">
            <p className="m-0">
              Times are the database’s clock, in UTC, not the moderator’s. The same log is served at{" "}
              <code className="font-mono text-sm">GET /moderation/log</code> for anyone to copy.
            </p>
          </SectionHead>

          <TallyBars
            caption={`All ${LOG_TOTAL} decisions since 1 September 2026, by action`}
            total={LOG_TOTAL}
            highlight="Delisted"
            rows={[
              { key: "Delisted", label: "Delisted", count: 29 },
              { key: "Hidden", label: "Hidden", count: 11 },
              { key: "Restored", label: "Restored", count: 7 },
            ]}
          />

          <div className="grid gap-4">
            <div role="group" aria-label="Show decisions" className="flex flex-wrap gap-2">
              {(["All", "Delisted", "Hidden", "Restored"] as const).map((f) => (
                <Button
                  key={f}
                  variant={filter === f ? "default" : "outline"}
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                >
                  {f}
                </Button>
              ))}
            </div>
            <div
              aria-hidden="true"
              className="hidden grid-cols-[4rem_12rem_minmax(0,1fr)_8rem_9rem_minmax(0,1fr)] gap-x-4 border-b border-foreground pb-2 font-mono text-xs tracking-wide text-muted-foreground uppercase lg:grid"
            >
              <span>No.</span>
              <span>Time</span>
              <span>Poll</span>
              <span>Action</span>
              <span>Ground</span>
              <span>Note</span>
            </div>
            <ol
              aria-label={`Moderation log, showing ${rows.length} of ${LOG_TOTAL} entries`}
              className="m-0 grid list-none border-t-2 border-foreground p-0 lg:border-t-0"
            >
              {rows.map((r) => (
                <li key={r.seq} className="border-b border-border py-4">
                  <dl className="m-0 grid grid-cols-[6rem_1fr] gap-x-4 gap-y-1.5 lg:grid-cols-[4rem_12rem_minmax(0,1fr)_8rem_9rem_minmax(0,1fr)] lg:items-baseline">
                    <dt className="text-sm text-muted-foreground lg:sr-only">Entry</dt>
                    <dd className="m-0 font-mono text-sm tabular-nums">{r.seq}</dd>
                    <dt className="text-sm text-muted-foreground lg:sr-only">Time</dt>
                    <dd className="m-0 font-mono text-xs tracking-wide">{r.at}</dd>
                    <dt className="text-sm text-muted-foreground lg:sr-only">Poll</dt>
                    <dd className="m-0 grid gap-0.5">
                      <span className="font-semibold">{r.poll}</span>
                      <code className="font-mono text-xs text-muted-foreground">
                        {short(r.pollId)}
                      </code>
                    </dd>
                    <dt className="text-sm text-muted-foreground lg:sr-only">Action</dt>
                    <dd className="m-0 flex items-center gap-2 text-sm">
                      <span aria-hidden="true">{ACTION_ICON[r.action]}</span>
                      {r.action}
                    </dd>
                    <dt className="text-sm text-muted-foreground lg:sr-only">Ground</dt>
                    <dd className="m-0 text-sm">{r.reason}</dd>
                    <dt className="text-sm text-muted-foreground lg:sr-only">Note</dt>
                    <dd className="m-0 text-sm text-pretty">{r.note}</dd>
                  </dl>
                </li>
              ))}
            </ol>
            <p className="m-0 font-mono text-xs tracking-wide text-muted-foreground">
              Showing {rows.length} of {LOG_TOTAL} entries.{" "}
              <a href="/moderation?page=2" className="text-foreground underline underline-offset-4">
                Older entries
              </a>
            </p>
          </div>
        </section>

        <section aria-labelledby="grounds-title" className="grid gap-8">
          <SectionHead index="02" mark="Grounds" id="grounds-title" title="The only seven grounds">
            <p className="m-0">
              Every removal cites exactly one. We use the least restrictive action: a poll is
              delisted unless showing its text does harm itself.
            </p>
          </SectionHead>
          <ol className="m-0 grid list-none border-t-2 border-foreground p-0 md:grid-cols-2">
            {GROUNDS.map((g, i) => (
              <li
                key={g.code}
                className="reveal grid grid-cols-[2.5rem_1fr] gap-x-4 gap-y-1 border-b border-border py-5 md:odd:border-e md:odd:pe-6 md:even:ps-6"
              >
                <span className="font-mono text-sm tabular-nums">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="m-0 text-lg font-semibold">
                  {g.name} <code className="ms-1 font-mono text-xs font-normal">{g.code}</code>
                </h3>
                <p className="col-start-2 m-0 text-sm text-pretty">{g.description}</p>
              </li>
            ))}
          </ol>
          <div className="grid gap-10 md:grid-cols-2">
            <div className="grid content-start gap-3">
              <h3 className="m-0 text-xl font-semibold">Never grounds, whatever the pressure</h3>
              <ul className="m-0 grid list-none border-t border-foreground p-0">
                {NEVER_GROUNDS.map((n) => (
                  <li key={n} className="flex gap-3 border-b border-border py-3 text-base">
                    <Ban aria-hidden="true" className="mt-1 size-4 shrink-0" />
                    {n}
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid content-start gap-3">
              <h3 className="m-0 text-xl font-semibold">Grounds for restoring a poll</h3>
              <ul className="m-0 grid list-none border-t border-foreground p-0">
                {RESTORE_GROUNDS.map((r) => (
                  <li key={r.code} className="grid gap-0.5 border-b border-border py-3">
                    <span className="font-semibold">
                      {r.name} <code className="ms-1 font-mono text-xs font-normal">{r.code}</code>
                    </span>
                    <span className="text-sm">{r.description}</span>
                  </li>
                ))}
              </ul>
              <p className="m-0 text-sm text-muted-foreground">
                A poll’s creator can appeal any decision once. A different moderator reviews it.
              </p>
            </div>
          </div>
        </section>

        <section
          aria-labelledby="report-title"
          className="grid gap-6 border-t-2 border-foreground pt-8 md:grid-cols-12"
        >
          <div className="grid gap-3 md:col-span-7">
            <SectionMark index="03">Reports</SectionMark>
            <h2 id="report-title" className="m-0 font-heading text-3xl font-semibold">
              See a poll that breaks these rules?
            </h2>
            <p className="m-0 max-w-prose text-base">
              Anyone can report a poll, without an account. A report records the poll and the ground
              you cite, and nothing about you.
            </p>
          </div>
          <div className="md:col-span-5 md:self-end md:justify-self-end">
            <a
              href="/moderation/report"
              className="inline-flex h-12 items-center border border-foreground px-5 text-sm font-medium hover:bg-muted"
            >
              Report a poll
            </a>
          </div>
        </section>
      </Frame>
    </MockShell>
  );
}

export function ReportPage() {
  const [ground, setGround] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [sent, setSent] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (attempt > 0) errorRef.current?.focus();
  }, [attempt]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ground === "") {
      setError("Choose the ground that best fits what is wrong with this poll.");
      setAttempt((a) => a + 1);
      return;
    }
    setError(undefined);
    setSent(true);
  };

  return (
    <MockShell current="/moderation">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 pt-12 md:pt-20 lg:grid-cols-12 lg:gap-x-8">
        <div className="grid content-start gap-6 lg:col-span-7">
          <p className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase">
            Moderation · Report a poll
          </p>
          <h1 className="m-0 font-heading text-4xl leading-[1.05] font-semibold tracking-tight text-balance sm:text-5xl">
            {sent ? "Report received" : "What is wrong with this poll?"}
          </h1>
          {sent ? (
            <div role="status" className="grid gap-4 border-s-4 border-recorded ps-5 text-lg">
              <p className="m-0">
                A moderator will judge the poll against the published grounds. If they act, the
                decision appears in the public log with its ground.
              </p>
              <p className="m-0 text-base">
                We kept the poll and the ground you chose. Nothing about you was stored.
              </p>
              <p className="m-0 text-base">
                <a href="/moderation" className="underline underline-offset-4">
                  Back to the moderation log
                </a>
              </p>
            </div>
          ) : (
            <form noValidate onSubmit={submit} className="grid gap-8">
              <p className="m-0 max-w-prose text-lg text-pretty">
                Choose the one ground that fits best. How many people report a poll doesn’t change
                the decision; whether it breaks a rule does.
              </p>
              {error === undefined ? null : (
                <div
                  ref={errorRef}
                  tabIndex={-1}
                  role="alert"
                  aria-labelledby="report-error-title"
                  className="grid gap-2 border-2 border-destructive p-5 outline-none focus-visible:ring-3 focus-visible:ring-ring"
                >
                  <h2 id="report-error-title" className="m-0 text-lg font-semibold">
                    There is a problem
                  </h2>
                  <a href="#ground" className="text-destructive underline underline-offset-4">
                    {error}
                  </a>
                </div>
              )}
              <fieldset
                id="ground"
                aria-describedby={error === undefined ? undefined : "ground-error"}
                className="m-0 grid gap-3 border-0 p-0"
              >
                <legend className="mb-3 p-0 text-lg font-semibold">Ground</legend>
                {error === undefined ? null : <ErrorText id="ground-error">{error}</ErrorText>}
                <RadioGroup
                  value={ground}
                  onValueChange={(v) => setGround(String(v))}
                  className="gap-0 border-t border-foreground"
                >
                  {GROUNDS.map((g) => (
                    <Label
                      key={g.code}
                      className={cn(
                        "flex min-h-12 w-full items-start gap-4 border-b border-border py-4 ps-1 text-base font-normal",
                        ground === g.code && "border-s-4 border-s-primary ps-3",
                      )}
                    >
                      <RadioGroupItem
                        value={g.code}
                        aria-invalid={error === undefined ? undefined : true}
                        className="mt-1"
                      />
                      <span className="grid gap-0.5">
                        <span className="font-semibold">{g.name}</span>
                        <span className="text-sm text-muted-foreground">{g.description}</span>
                      </span>
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>
              <div className="flex flex-wrap gap-3 border-t-2 border-foreground pt-6">
                <Button type="submit" size="lg">
                  Send report
                </Button>
              </div>
            </form>
          )}
        </div>
        <aside aria-labelledby="reported-title" className="lg:col-span-4 lg:col-start-9 lg:pt-10">
          <div className="grid gap-4 border-t-2 border-foreground pt-4">
            <h2
              id="reported-title"
              className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase"
            >
              The poll you are reporting
            </h2>
            <p className="m-0 text-xl font-semibold text-balance">{PARKS.title}</p>
            <p className="m-0 text-sm text-pretty">{PARKS.question}</p>
            <div className="flex items-center gap-3">
              <Fingerprint
                value={PARKS.id}
                label={`Fingerprint of poll ${PARKS.id.slice(0, 8)}`}
                size={40}
              />
              <code className="min-w-0 font-mono text-xs break-all">{PARKS.id}</code>
            </div>
            <p className="m-0 border-t border-border pt-4 text-sm text-muted-foreground">
              No account needed. We store the poll and the ground only: not your account, your
              address, or any text.
            </p>
          </div>
        </aside>
      </div>
    </MockShell>
  );
}

type Action = "delist" | "hide" | "none";
type DecisionErrors = Partial<Record<"ground" | "note", string>>;

export function ModeratorQueuePage() {
  const [queue, setQueue] = useState<readonly QueueItem[]>(QUEUE);
  const [selected, setSelected] = useState<string>(QUEUE[0]?.id ?? "");
  const [action, setAction] = useState<Action>("delist");
  const [ground, setGround] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<DecisionErrors>({});
  const [recorded, setRecorded] = useState<string | undefined>();
  const item = queue.find((q) => q.id === selected);
  const cited = GROUNDS.find((g) => g.code === item?.ground);

  const pick = (id: string) => {
    setSelected(id);
    setAction("delist");
    setGround("");
    setNote("");
    setErrors({});
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (item === undefined) return;
    const found: DecisionErrors = {};
    if (action !== "none") {
      const g = GROUNDS.find((x) => x.code === ground);
      if (g === undefined) found.ground = "Choose a ground from the list.";
      else if (action === "hide" && item.open && !g.hidesOpen)
        found.ground = `An open poll can be hidden only for illegal content, personal data or a threat. Delist it for ${g.name.toLowerCase()} instead.`;
      if (note.trim() === "") found.note = "Write the public note that explains the decision.";
    }
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setRecorded(
      action === "none"
        ? `Reports on “${item.poll}” marked as reviewed. No decision was made, so nothing was added to the log.`
        : `Recorded as log entry ${LOG_TOTAL + 1}: ${action === "hide" ? "Hidden" : "Delisted"}, ${GROUNDS.find((g) => g.code === ground)?.name}.`,
    );
    const rest = queue.filter((q) => q.id !== item.id);
    setQueue(rest);
    pick(rest[0]?.id ?? "");
  };

  return (
    <MockShell current="/moderation" signedIn>
      <PageHead
        eyebrow="Moderation · Acting as moderator m-07"
        title="Reports awaiting a decision"
        lede="Judge each poll against the published grounds, not against how many people reported it. Every decision you record is public; the reports and your review are not."
      />
      <Frame className="grid gap-10 lg:grid-cols-12 lg:gap-x-8">
        <section aria-labelledby="queue-title" className="grid content-start gap-4 lg:col-span-5">
          <h2
            id="queue-title"
            className="m-0 font-mono text-xs tracking-widest text-muted-foreground uppercase"
          >
            Queue · {queue.length} {queue.length === 1 ? "poll" : "polls"}, oldest first
          </h2>
          <p role="status" className="m-0 text-base empty:hidden">
            {recorded}
          </p>
          <ul className="m-0 grid list-none border-t-2 border-foreground p-0">
            {queue.map((q) => {
              const g = GROUNDS.find((x) => x.code === q.ground);
              const here = q.id === selected;
              return (
                <li
                  key={q.id}
                  className={cn("border-b border-border", here && "border-s-4 border-s-primary")}
                >
                  <button
                    type="button"
                    aria-current={here ? "true" : undefined}
                    onClick={() => pick(q.id)}
                    className="grid min-h-12 w-full gap-1 px-3 py-4 text-start hover:bg-muted"
                  >
                    <span className="font-semibold">{q.poll}</span>
                    <span className="text-sm">
                      Cited: {g?.name} · {q.reports} {q.reports === 1 ? "report" : "reports"}
                    </span>
                    <span className="font-mono text-xs">
                      {q.open ? "Open" : "Closed"} · waiting since {q.waitingSince}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {queue.length === 0 ? <p className="m-0 text-base">No reports are waiting.</p> : null}
        </section>

        {item === undefined ? null : (
          <section
            aria-labelledby="decision-title"
            className="grid content-start gap-8 lg:col-span-7"
          >
            <div className="grid gap-4 border-t-2 border-foreground pt-4">
              <h2
                id="decision-title"
                className="m-0 font-heading text-3xl font-semibold text-balance"
              >
                {item.poll}
              </h2>
              <dl className="m-0 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
                <dt className="text-muted-foreground">Poll</dt>
                <dd className="m-0 flex min-w-0 items-center gap-3">
                  <Fingerprint
                    value={item.pollId}
                    label={`Fingerprint of poll ${item.pollId.slice(0, 8)}`}
                    size={28}
                  />
                  <code className="min-w-0 font-mono text-xs break-all">{short(item.pollId)}</code>
                </dd>
                <dt className="text-muted-foreground">State</dt>
                <dd className="m-0">
                  {item.open ? `Open, closes ${item.closes}` : `Closed ${item.closes}`}
                </dd>
                <dt className="text-muted-foreground">Reports</dt>
                <dd className="m-0">
                  {item.reports} citing {cited?.name.toLowerCase()}
                </dd>
                <dt className="text-muted-foreground">Text</dt>
                <dd className="m-0 border-s-2 border-border ps-3 text-base text-pretty">
                  {item.text}
                </dd>
              </dl>
            </div>

            <form noValidate onSubmit={submit} className="grid gap-8">
              <fieldset className="m-0 grid gap-3 border-0 p-0">
                <legend className="mb-3 p-0 text-lg font-semibold">Decision</legend>
                <RadioGroup
                  value={action}
                  onValueChange={(v) => setAction(v as Action)}
                  className="gap-0 border-t border-foreground"
                >
                  {(
                    [
                      [
                        "delist",
                        "Delist",
                        "Leaves discovery and search. The link still works, the text still shows and people can still vote.",
                      ],
                      [
                        "hide",
                        "Hide",
                        "As delist, and the text is withheld. On an open poll, only for illegal content, personal data or a threat.",
                      ],
                      [
                        "none",
                        "No action",
                        "Mark these reports reviewed. Nothing is added to the log.",
                      ],
                    ] as const
                  ).map(([value, name, help]) => (
                    <Label
                      key={value}
                      className="flex min-h-12 w-full items-start gap-4 border-b border-border py-4 ps-1 text-base font-normal"
                    >
                      <RadioGroupItem value={value} className="mt-1" />
                      <span className="grid gap-0.5">
                        <span className="font-semibold">{name}</span>
                        <span className="text-sm text-muted-foreground">{help}</span>
                      </span>
                    </Label>
                  ))}
                </RadioGroup>
              </fieldset>

              {action === "none" ? null : (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="decision-ground" className="text-base font-semibold">
                      Ground
                    </Label>
                    <p id="decision-ground-help" className="m-0 text-sm text-muted-foreground">
                      One of the seven published grounds. It may differ from what reporters cited.
                    </p>
                    {errors.ground === undefined ? null : (
                      <ErrorText id="decision-ground-error">{errors.ground}</ErrorText>
                    )}
                    <NativeSelect
                      id="decision-ground"
                      className="w-full max-w-md [&_select]:h-12 [&_select]:text-base"
                      aria-invalid={errors.ground === undefined ? undefined : true}
                      aria-describedby={`decision-ground-help${errors.ground === undefined ? "" : " decision-ground-error"}`}
                      value={ground}
                      onChange={(e) => setGround(e.target.value)}
                    >
                      <NativeSelectOption value="">Choose a ground</NativeSelectOption>
                      {GROUNDS.map((g) => (
                        <NativeSelectOption key={g.code} value={g.code}>
                          {g.name} ({g.code})
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="decision-note" className="text-base font-semibold">
                      Public note
                    </Label>
                    <p id="decision-note-help" className="m-0 text-sm text-muted-foreground">
                      Shown in the log beside the decision. Say what in the text breaks the rule,
                      without repeating it. Never include personal data.
                    </p>
                    {errors.note === undefined ? null : (
                      <ErrorText id="decision-note-error">{errors.note}</ErrorText>
                    )}
                    <Textarea
                      id="decision-note"
                      rows={3}
                      aria-invalid={errors.note === undefined ? undefined : true}
                      aria-describedby={`decision-note-help${errors.note === undefined ? "" : " decision-note-error"}`}
                      className="min-h-24 p-3 text-base md:text-base"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                    />
                  </div>
                </>
              )}

              <div className="flex flex-wrap items-center gap-4 border-t-2 border-foreground pt-6">
                <Button type="submit" size="lg">
                  {action === "none" ? "Mark reviewed" : "Record decision"}
                </Button>
                <p className="m-0 text-sm text-muted-foreground">
                  The time is taken from the database’s clock.
                </p>
              </div>
            </form>
          </section>
        )}
      </Frame>
    </MockShell>
  );
}
