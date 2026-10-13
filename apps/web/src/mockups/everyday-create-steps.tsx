import { Button, cn, Fingerprint, Hash } from "@abolishus/ui";
import { Checkbox } from "@abolishus/ui/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@abolishus/ui/ui/collapsible";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import {
  ChevronDown,
  Handshake,
  IdCard,
  Lock,
  Minus,
  Plus,
  Radio,
  Trash2,
  UserRound,
} from "lucide-react";
import { type ReactNode, useRef } from "react";

import {
  type Audience,
  AUDIENCES,
  BATCH_FLOOR,
  type Cadence,
  CADENCES,
  DEFINITION_HASH,
  type Draft,
  type Errors,
  fieldId,
  GROUP_NAMES,
  parseUtc,
  ruleText,
  scheduleText,
  STANDING_PANEL_LINE,
  type Trustee,
  type When,
} from "./everyday-create-data.ts";
import {
  ChoiceCard,
  describedBy,
  ErrorText,
  fieldInput,
  formatLocal,
  formatUtc,
  Help,
  invalid,
} from "./everyday-create-parts.tsx";

const AUDIENCE_ICONS: Record<Audience, ReactNode> = {
  account: <UserRound aria-hidden="true" className="size-5" />,
  vouched: <Handshake aria-hidden="true" className="size-5" />,
  verified: <IdCard aria-hidden="true" className="size-5" />,
};

const selectClass =
  "h-12 w-full max-w-60 rounded-none border border-input bg-background px-3 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring";

const card = "grid gap-3 border border-border p-5 sm:p-6";

/** Step 2: who can answer, in words, and the reminder that each group is shown on its own. */
export function WhoFields({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const chosen = AUDIENCES.find((a) => a.key === draft.audience);
  return (
    <>
      <fieldset className="m-0 grid gap-3 border-0 p-0">
        <legend id="audience-legend" className="mb-3 p-0 text-lg font-semibold">
          Who can answer
        </legend>
        <RadioGroup
          aria-labelledby="audience-legend"
          value={draft.audience}
          onValueChange={(value) => onChange({ ...draft, audience: value as Audience })}
          className="gap-3"
        >
          {AUDIENCES.map((a) => (
            <ChoiceCard
              key={a.key}
              value={a.key}
              selected={draft.audience === a.key}
              title={a.name}
              icon={AUDIENCE_ICONS[a.key]}
            >
              {a.body}
            </ChoiceCard>
          ))}
        </RadioGroup>
      </fieldset>
      <section aria-labelledby="separately-title" className={card}>
        <h2 id="separately-title" className="m-0 text-lg font-semibold">
          Results are always shown separately for each group
        </h2>
        <p className="m-0 text-pretty">
          Answers from each group are counted and shown on their own, never added into one number,
          so anyone can see whether, say, people with an account and verified people agree.
        </p>
        <ul aria-label="How your results will be shown" className="m-0 grid list-none gap-2 p-0">
          {(["verified", "vouched", "account"] as const).map((g) => {
            const shown = chosen?.groups.includes(g) ?? false;
            return (
              <li
                key={g}
                data-shown={shown}
                className="flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-1 border border-border px-4 py-2"
              >
                <span className={cn(!shown && "text-muted-foreground")}>{GROUP_NAMES[g]}</span>
                <span className={cn("text-sm", shown ? "font-semibold" : "text-muted-foreground")}>
                  {shown ? "Shown on its own" : "Can’t answer"}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

/** Step 3: live or sealed, and for live, when totals go out. */
export function ResultsFields({ draft, onChange }: { draft: Draft; onChange: (d: Draft) => void }) {
  const live = draft.results === "live";
  return (
    <>
      <fieldset className="m-0 grid gap-3 border-0 p-0">
        <legend id="results-legend" className="mb-3 p-0 text-lg font-semibold">
          When can people see results?
        </legend>
        <RadioGroup
          aria-labelledby="results-legend"
          value={draft.results}
          onValueChange={(value) => onChange({ ...draft, results: value as Draft["results"] })}
          className="gap-3"
        >
          <ChoiceCard
            value="live"
            selected={live}
            title="Live, as answers come in"
            icon={<Radio aria-hidden="true" className="size-5" />}
          >
            Everyone can watch the totals grow while the poll is open. Good for a neighbourhood
            check-in.
          </ChoiceCard>
          <ChoiceCard
            value="sealed"
            selected={!live}
            title="Sealed until it closes"
            icon={<Lock aria-hidden="true" className="size-5" />}
          >
            Nobody sees anything, you included, until the poll closes. Then every answer is counted
            at once.
          </ChoiceCard>
        </RadioGroup>
      </fieldset>

      {live ? (
        <section aria-labelledby="updates-title" className="grid gap-6">
          <h2 id="updates-title" className="m-0 text-xl font-semibold">
            When updates go out
          </h2>
          <fieldset className="m-0 grid gap-3 border-0 p-0">
            <legend id="cadence-legend" className="mb-3 p-0 text-base font-semibold">
              How often
            </legend>
            <RadioGroup
              aria-labelledby="cadence-legend"
              value={draft.cadence}
              onValueChange={(value) => onChange({ ...draft, cadence: value as Cadence })}
              className="flex flex-wrap gap-2"
            >
              {CADENCES.map((c) => (
                <Label
                  key={c.key}
                  className={cn(
                    "flex min-h-12 items-center gap-3 border px-4 text-sm font-normal",
                    draft.cadence === c.key
                      ? "border-2 border-primary px-[15px] font-semibold"
                      : "border-border",
                  )}
                >
                  <RadioGroupItem value={c.key} />
                  {c.label}
                </Label>
              ))}
            </RadioGroup>
          </fieldset>
          {draft.cadence === "daily" ? (
            <div className="grid gap-2">
              <Label htmlFor="release-at" className="text-base font-semibold">
                At what time (UTC)
              </Label>
              <select
                id="release-at"
                className={selectClass}
                value={draft.releaseAt}
                onChange={(e) => onChange({ ...draft, releaseAt: e.target.value })}
              >
                {Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`).map(
                  (t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ),
                )}
              </select>
            </div>
          ) : null}
          <p
            data-testid="release-sentence"
            className="m-0 border border-border p-5 text-lg text-pretty"
          >
            We publish new totals {scheduleText(draft)}, and only when at least {BATCH_FLOOR} new
            answers have come in, so no update can reveal one person’s answer.
          </p>
          <div className="grid gap-1 border-s-4 border-foreground ps-4">
            <h3 className="m-0 text-base font-semibold">Worth knowing</h3>
            <p className="m-0 text-pretty">
              Live results can sway the people who answer later. If you’d rather everyone answers
              without seeing how others did, keep it sealed.
            </p>
          </div>
        </section>
      ) : (
        <p
          data-testid="sealed-sentence"
          className="m-0 border border-border p-5 text-lg text-pretty"
        >
          Results appear once, when the poll closes. Until then, nobody can see a running total.
        </p>
      )}
    </>
  );
}

function Stepper({
  id,
  value,
  min,
  max,
  noun,
  onChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  noun: string;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        aria-label={`Fewer ${noun}`}
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
      >
        <Minus aria-hidden="true" />
      </Button>
      <output
        id={id}
        aria-live="polite"
        className="inline-flex h-12 min-w-12 items-center justify-center border border-input px-3 text-lg tabular-nums"
      >
        {value}
      </output>
      <Button
        variant="outline"
        size="icon"
        aria-label={`More ${noun}`}
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
      >
        <Plus aria-hidden="true" />
      </Button>
    </div>
  );
}

function TrusteeFields({
  t,
  index,
  errors,
  onChange,
  onRemove,
}: {
  t: Trustee;
  index: number;
  errors: Errors;
  onChange: (t: Trustee) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const nameId = fieldId.trustee(t.id, "name");
  const contactId = fieldId.trustee(t.id, "contact");
  const keyId = fieldId.trustee(t.id, "key");
  const inviteId = `t-${t.id}-invite`;
  return (
    <section
      aria-labelledby={`t-${t.id}-heading`}
      className="grid gap-5 border border-border p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={`t-${t.id}-heading`} className="m-0 text-lg font-semibold">
          Trustee {n}
        </h3>
        <Button variant="outline" onClick={onRemove}>
          <Trash2 aria-hidden="true" data-icon="inline-start" />
          Remove<span className="sr-only"> trustee {n}</span>
        </Button>
      </div>
      <div className="grid gap-2">
        <Label htmlFor={nameId} className="text-base font-semibold">
          Name
        </Label>
        <Help id={`${nameId}-help`}>A person or organisation. Shown with your poll.</Help>
        <ErrorText errors={errors} id={nameId} />
        <Input
          id={nameId}
          aria-describedby={describedBy(errors, nameId, true)}
          aria-invalid={invalid(errors, nameId)}
          className={fieldInput}
          value={t.name}
          onChange={(e) => onChange({ ...t, name: e.target.value })}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={contactId} className="text-base font-semibold">
          How to reach them
        </Label>
        <Help id={`${contactId}-help`}>An email or phone number. Only you and they see it.</Help>
        <ErrorText errors={errors} id={contactId} />
        <Input
          id={contactId}
          aria-describedby={describedBy(errors, contactId, true)}
          aria-invalid={invalid(errors, contactId)}
          className={fieldInput}
          value={t.contact}
          onChange={(e) => onChange({ ...t, contact: e.target.value })}
        />
      </div>
      <fieldset className="m-0 grid gap-3 border-0 p-0">
        <legend id={`t-${t.id}-connect`} className="mb-3 p-0 text-base font-semibold">
          How their node joins
        </legend>
        <RadioGroup
          aria-labelledby={`t-${t.id}-connect`}
          value={t.connect}
          onValueChange={(value) => onChange({ ...t, connect: value as Trustee["connect"] })}
          className="flex flex-wrap gap-2"
        >
          {(
            [
              ["invite", "Send them an invite link"],
              ["key", "Paste their node’s key"],
            ] as const
          ).map(([value, label]) => (
            <Label
              key={value}
              className={cn(
                "flex min-h-12 items-center gap-3 border px-4 text-sm font-normal",
                t.connect === value
                  ? "border-2 border-primary px-[15px] font-semibold"
                  : "border-border",
              )}
            >
              <RadioGroupItem value={value} />
              {label}
            </Label>
          ))}
        </RadioGroup>
      </fieldset>
      {t.connect === "key" ? (
        <div className="grid gap-2">
          <Label htmlFor={keyId} className="text-base font-semibold">
            Their node’s key
          </Label>
          <ErrorText errors={errors} id={keyId} />
          <Input
            id={keyId}
            spellCheck={false}
            autoComplete="off"
            aria-describedby={describedBy(errors, keyId)}
            aria-invalid={invalid(errors, keyId)}
            className={cn(fieldInput, "font-mono text-sm md:text-sm")}
            value={t.key}
            onChange={(e) => onChange({ ...t, key: e.target.value })}
          />
        </div>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor={inviteId} className="text-base font-semibold">
            Invite link
          </Label>
          <Help id={`${inviteId}-help`}>
            We’ll send it when you publish, or copy it to send yourself. Their node joins when they
            open it.
          </Help>
          <Input
            id={inviteId}
            readOnly
            aria-describedby={`${inviteId}-help`}
            className={cn(fieldInput, "font-mono text-sm md:text-sm")}
            value={`https://abolish.us/trustee/join/${t.id}-7kq2m9`}
          />
        </div>
      )}
    </section>
  );
}

/** Step 4: the standing panel in a line, and the author's own trustees under "Advanced". */
export function KeyFields({
  draft,
  errors,
  open,
  onOpenChange,
  onChange,
}: {
  draft: Draft;
  errors: Errors;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (d: Draft) => void;
}) {
  const nextId = useRef(0);
  const trustees = draft.trustees;
  const count = trustees.length;
  const setTrustees = (next: Trustee[]) =>
    onChange({
      ...draft,
      trustees: next,
      threshold: Math.max(1, Math.min(draft.threshold, next.length)),
      understood: next.length === 0 ? false : draft.understood,
    });
  return (
    <>
      <section aria-labelledby="standing-title" className={card}>
        <h2 id="standing-title" className="m-0 text-lg font-semibold">
          Who holds the key now
        </h2>
        <p className="m-0 text-pretty">{STANDING_PANEL_LINE}</p>
        <p className="m-0">
          <a
            href="/trustees"
            className="inline-flex min-h-12 items-center underline underline-offset-4"
          >
            Learn how the key works
          </a>
        </p>
      </section>

      <Collapsible open={open} onOpenChange={onOpenChange} className="grid gap-6">
        <CollapsibleTrigger className="group/advanced flex min-h-12 w-full items-center justify-between gap-4 border border-border px-5 py-3 text-start outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring">
          <span className="grid gap-0.5">
            <span className="text-sm text-muted-foreground group-hover/advanced:text-foreground">
              Advanced
            </span>
            <span className="text-lg font-semibold">Add your own trustees</span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="size-5 shrink-0 group-data-[panel-open]/advanced:rotate-180 motion-safe:transition-transform"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-6">
          <p className="m-0 max-w-prose text-pretty">
            This is how you protect your poll from us. Name people or organisations you trust to
            hold a second key. Each runs a small trustee node, which we’ll help them set up. Answers
            then open only when Abolish and enough of your trustees take part together.
          </p>
          {trustees.map((t, i) => (
            <TrusteeFields
              key={t.id}
              t={t}
              index={i}
              errors={errors}
              onChange={(next) => setTrustees(trustees.map((x) => (x.id === t.id ? next : x)))}
              onRemove={() => setTrustees(trustees.filter((x) => x.id !== t.id))}
            />
          ))}
          <div>
            <Button
              variant="outline"
              onClick={() =>
                setTrustees([
                  ...trustees,
                  {
                    id: `new-${(nextId.current += 1)}`,
                    name: "",
                    contact: "",
                    connect: "invite",
                    key: "",
                  },
                ])
              }
            >
              <Plus aria-hidden="true" data-icon="inline-start" />
              {count === 0 ? "Add a trustee" : "Add another trustee"}
            </Button>
          </div>

          {count === 0 ? null : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="threshold" className="text-base font-semibold">
                  How many of your trustees must take part?
                </Label>
                <Help id="threshold-help">
                  More protects against one of them misbehaving. Fewer protects against one of them
                  going offline.
                </Help>
                <div className="flex flex-wrap items-center gap-3">
                  <Stepper
                    id="threshold"
                    value={draft.threshold}
                    min={1}
                    max={count}
                    noun="trustees needed"
                    onChange={(threshold) => onChange({ ...draft, threshold })}
                  />
                  <span data-testid="threshold-of" className="text-lg">
                    of {count} {count === 1 ? "trustee" : "trustees"}
                  </span>
                </div>
              </div>

              <div data-testid="consequence" className="grid gap-2 border-2 border-foreground p-5">
                <p className="m-0 text-lg font-semibold text-pretty">
                  Your trustees add protection: no one can open answers without both panels. If your
                  trustees go offline, your poll can’t be counted.
                </p>
                <p className="m-0 text-pretty">
                  {count === 1
                    ? "Counting needs Abolish and your trustee, both online when the poll closes."
                    : `Counting needs Abolish and ${draft.threshold} of your ${count} trustees, online when the poll closes.`}
                </p>
              </div>

              <div className="grid gap-2">
                <ErrorText errors={errors} id={fieldId.understood} />
                <Label className="flex min-h-12 items-start gap-4 text-base leading-normal font-normal">
                  <Checkbox
                    id={fieldId.understood}
                    className="mt-1 size-5"
                    aria-describedby={describedBy(errors, fieldId.understood)}
                    aria-invalid={invalid(errors, fieldId.understood)}
                    checked={draft.understood}
                    onCheckedChange={(checked) => onChange({ ...draft, understood: checked })}
                  />
                  <span className="text-pretty">
                    {count === 1
                      ? "I understand that if my trustee is offline when the poll closes, it can never be counted."
                      : `I understand that if fewer than ${draft.threshold} of my ${count} trustees are online when the poll closes, it can never be counted.`}
                  </span>
                </Label>
              </div>
            </>
          )}
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

function WhenFields({
  id,
  legend,
  value,
  errors,
  timeZone,
  onChange,
}: {
  id: "opens" | "closes";
  legend: string;
  value: When;
  errors: Errors;
  timeZone: string;
  onChange: (w: When) => void;
}) {
  const dateId = `${id}-date`;
  const timeId = `${id}-time`;
  const parsed = parseUtc(value);
  const local = parsed === undefined ? undefined : formatLocal(parsed, timeZone);
  return (
    <fieldset aria-describedby={`${id}-local`} className="m-0 grid gap-3 border-0 p-0">
      <legend className="mb-3 p-0 text-lg font-semibold">{legend}</legend>
      <ErrorText errors={errors} id={dateId} />
      <div className="flex flex-wrap gap-4">
        <div className="grid gap-2">
          <Label htmlFor={dateId} className="text-base">
            Date
          </Label>
          <Input
            id={dateId}
            type="date"
            aria-describedby={describedBy(errors, dateId)}
            aria-invalid={invalid(errors, dateId)}
            className={cn(fieldInput, "w-48")}
            value={value.date}
            onChange={(e) => onChange({ ...value, date: e.target.value })}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={timeId} className="text-base">
            Time (UTC)
          </Label>
          <Input
            id={timeId}
            type="time"
            className={cn(fieldInput, "w-36")}
            value={value.time}
            onChange={(e) => onChange({ ...value, time: e.target.value })}
          />
        </div>
      </div>
      <p id={`${id}-local`} data-testid={`${id}-local`} className="m-0 text-muted-foreground">
        {parsed === undefined
          ? "Enter a date and time to see it in your own time."
          : local === undefined
            ? `${formatUtc(parsed)}, the same as your time.`
            : `That’s ${local}.`}
      </p>
    </fieldset>
  );
}

/** Step 5: when the poll opens and closes. */
export function ScheduleFields({
  draft,
  errors,
  timeZone,
  onChange,
}: {
  draft: Draft;
  errors: Errors;
  timeZone: string;
  onChange: (d: Draft) => void;
}) {
  const opens = parseUtc(draft.opens);
  const closes = parseUtc(draft.closes);
  const hours =
    opens !== undefined && closes !== undefined && closes > opens
      ? Math.round((closes.getTime() - opens.getTime()) / 3_600_000)
      : undefined;
  const days = hours === undefined ? 0 : Math.floor(hours / 24);
  const rest = hours === undefined ? 0 : hours % 24;
  return (
    <>
      <WhenFields
        id="opens"
        legend="Opens"
        value={draft.opens}
        errors={errors}
        timeZone={timeZone}
        onChange={(w) => onChange({ ...draft, opens: w })}
      />
      <WhenFields
        id="closes"
        legend="Closes"
        value={draft.closes}
        errors={errors}
        timeZone={timeZone}
        onChange={(w) => onChange({ ...draft, closes: w })}
      />
      <div className={card}>
        <p data-testid="window" className="m-0 font-heading text-3xl font-semibold tabular-nums">
          {hours === undefined
            ? "Set both times"
            : `Open for ${days > 0 ? `${days} ${days === 1 ? "day" : "days"}` : ""}${days > 0 && rest > 0 ? ", " : ""}${rest > 0 ? `${rest} ${rest === 1 ? "hour" : "hours"}` : ""}`}
        </p>
        <p className="m-0 text-pretty">
          Once you publish, these times are fixed: nobody, you or us, can extend the poll or close
          it early.
        </p>
      </div>
    </>
  );
}

/** Step 6: everything once more, what becomes permanent, and what moderation can do. */
export function ReviewBody({
  draft,
  published,
  onJump,
}: {
  draft: Draft;
  published: boolean;
  onJump: (step: number) => void;
}) {
  const opens = parseUtc(draft.opens);
  const closes = parseUtc(draft.closes);
  const audience = AUDIENCES.find((a) => a.key === draft.audience);
  const rows: { label: string; value: ReactNode; step: number }[] = [
    { label: "Title", value: draft.title, step: 0 },
    {
      label: "Questions",
      value: (
        <ol className="m-0 grid gap-1 ps-5">
          {draft.questions.map((q) => (
            <li key={q.id}>
              {q.text}{" "}
              <span className="text-muted-foreground">
                ({ruleText(q).toLowerCase()}, {q.options.length} options)
              </span>
            </li>
          ))}
        </ol>
      ),
      step: 0,
    },
    { label: "Who can answer", value: audience?.name ?? "", step: 1 },
    {
      label: "Results",
      value:
        draft.results === "live"
          ? `Live, updated ${scheduleText(draft)} once at least ${BATCH_FLOOR} new answers are in`
          : "Sealed until the poll closes",
      step: 2,
    },
    {
      label: "Who holds the key",
      value:
        draft.trustees.length === 0
          ? "Abolish, during launch"
          : draft.trustees.length === 1
            ? `Abolish, and your trustee ${draft.trustees[0]?.name ?? ""}`
            : `Abolish, and ${draft.threshold} of your ${draft.trustees.length} trustees (${draft.trustees.map((t) => t.name).join(", ")})`,
      step: 3,
    },
    { label: "Opens", value: opens === undefined ? "Not set" : formatUtc(opens), step: 4 },
    { label: "Closes", value: closes === undefined ? "Not set" : formatUtc(closes), step: 4 },
  ];
  return (
    <>
      <section aria-labelledby="summary-title" className="grid gap-3">
        <h2 id="summary-title" className="m-0 text-2xl font-semibold">
          Your poll
        </h2>
        <dl className="m-0 grid">
          {rows.map((r) => (
            <div
              key={r.label}
              className="grid gap-x-6 gap-y-1 border-b border-border py-4 first:border-t sm:grid-cols-[10rem_1fr_auto]"
            >
              <dt className="font-semibold">{r.label}</dt>
              <dd className="m-0 min-w-0 text-pretty break-words">{r.value}</dd>
              <dd className="m-0">
                <Button variant="link" className="h-12 px-0" onClick={() => onJump(r.step)}>
                  Change<span className="sr-only"> {r.label.toLowerCase()}</span>
                </Button>
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="permanent-title" className="grid gap-4">
        <h2 id="permanent-title" className="m-0 text-2xl font-semibold">
          What becomes permanent and public
        </h2>
        <p className="m-0 max-w-prose text-pretty">
          When you publish, these are recorded for good. Nobody can change them afterwards, you or
          us, so give them one more read.
        </p>
        <ul className="m-0 grid gap-1 ps-5">
          <li>Your questions and their options, in this order</li>
          <li>The rules: who can answer, how each question is answered, live or sealed</li>
          <li>Who holds the key, and the opening and closing times</li>
          <li>Every answer, sealed, and the final count</li>
        </ul>
        <div className="flex flex-wrap items-start gap-5 border border-border p-5">
          <Fingerprint
            value={DEFINITION_HASH}
            label={`Fingerprint of this poll ${DEFINITION_HASH.slice(0, 8)}`}
            size={64}
          />
          <div className="grid min-w-0 flex-1 basis-56 gap-2">
            <Hash value={DEFINITION_HASH} label="The poll’s fingerprint" />
            <p className="m-0 text-sm text-muted-foreground">
              Made from everything above. Anyone can use it to check that the poll they’re answering
              is the one you published.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="moderation-title" className="grid gap-2">
        <h2 id="moderation-title" className="m-0 text-2xl font-semibold">
          What moderation can withhold
        </h2>
        <p className="m-0 max-w-prose text-pretty">
          If a poll breaks one of our seven published rules, such as sharing someone’s personal
          details, moderators can hide its text or take it out of listings. Each decision is logged
          in public in the{" "}
          <a href="/moderation" className="underline underline-offset-4">
            moderation log
          </a>{" "}
          and you can appeal it once. Moderation can never touch the answers or the results.
        </p>
      </section>

      {published ? (
        <p role="status" className="m-0 border-2 border-recorded p-5 font-semibold">
          Published. Your poll opens {opens === undefined ? "" : formatUtc(opens)}.
        </p>
      ) : null}
    </>
  );
}
