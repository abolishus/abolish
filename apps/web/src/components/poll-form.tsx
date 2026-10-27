import { POLL_TOPICS, type PollTopic } from "@abolishus/core/poll-draft-rules";
import { Button, cn, useI18n, useTranslate } from "@abolishus/ui";
import { Checkbox } from "@abolishus/ui/ui/checkbox";
import { Input } from "@abolishus/ui/ui/input";
import { Label } from "@abolishus/ui/ui/label";
import { NativeSelect, NativeSelectOption } from "@abolishus/ui/ui/native-select";
import { RadioGroup, RadioGroupItem } from "@abolishus/ui/ui/radio-group";
import { Textarea } from "@abolishus/ui/ui/textarea";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import {
  type FormEvent,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { Challenge } from "../account/challenge.ts";
import { DraftsError, type DraftsClient, type DraftsFailure } from "../account/drafts.ts";
import type { OwnProfileView, ProfilesClient } from "../account/profiles.ts";
import {
  ANSWER_RULES,
  type AnswerRule,
  checkForm,
  closesAtOf,
  type FieldError,
  fieldErrors,
  closesErrors,
  fieldId,
  type FormQuestion,
  formOf,
  MAX_OPTIONS,
  newOption,
  newPollForm,
  newQuestion,
  type PollForm,
  selectionRange,
  tidyPlace,
} from "../account/poll-form.ts";
import { catalogs, type Messages, POLL_TOPIC_MESSAGES, tierMessage } from "../messages.ts";
import { formatUtc } from "./format.ts";
import { PageHeader, Section } from "./page-parts.tsx";
import { ProfileChoice } from "./profile-choice.tsx";

const FIELD = "min-h-12 px-3 text-base md:text-base";

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** The select's value as a topic; anything else is none. */
const topicOf = (value: string): PollTopic | "" =>
  (POLL_TOPICS as readonly string[]).includes(value) ? (value as PollTopic) : "";

/** What the page shows instead of the form, when it can't show one. */
type Unavailable = "signedOut" | "gone" | "notDraft" | "unloaded";

type Translate = ReturnType<typeof useTranslate<Messages>>;

/** A tier's name, or its number for one that has none. */
const tierName = (t: Translate, tier: number, phoneVerification: boolean) => {
  const key = tierMessage(tier, phoneVerification);
  return key === undefined ? String(tier) : t(key);
};

/**
 * Who can answer, in the everyday register's words rather than a tier's code
 * (P2-29, creating a poll's iteration 2): Tier 0 by what the token issuer
 * checks, any other tier by its name.
 */
const whoName = (t: Translate, tier: number, phoneVerification: boolean) =>
  tier === 0
    ? t(phoneVerification ? "pollFormWho_phone" : "pollFormWho_email")
    : tierName(t, tier, phoneVerification);

/** A date and time for `locale` on `timeZone`'s clock, for what only the browser shows. */
function formatIn(locale: string, timeZone: string, date: Date): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

/**
 * The closing time in UTC beside the author's own, as its time alone where
 * both clocks are on the same day, so the review doesn't say the date twice
 * (P2-29, creating a poll's iteration 4).
 */
function utcBeside(locale: string, timeZone: string, date: Date): string {
  const day = (zone: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: zone }).format(date);
  return day(timeZone) === day("UTC")
    ? new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "UTC" }).format(date)
    : formatUtc(locale, date);
}

/**
 * `timeZone`'s name for `locale` as people say it ("Eastern Time"), or its
 * IANA ID where the browser has no such name.
 */
function zoneName(locale: string, timeZone: string, at: Date): string {
  const name = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "longGeneric" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  return name ?? timeZone.replaceAll("_", " ");
}

/** A problem's words, saying which question it is in. */
const say = (t: Translate, e: FieldError) => {
  const problem = t(`pollForm_${e.problem}`);
  return e.question === undefined ? problem : t("pollFormInQuestion", { n: e.question, problem });
};

function Errors({ t, errors, id }: { t: Translate; errors: readonly FieldError[]; id: string }) {
  const mine = errors.filter((e) => e.id === id);
  if (mine.length === 0) return null;
  return (
    <p id={`${id}-error`} className="m-0 font-semibold text-destructive">
      {mine.map((e) => t(`pollForm_${e.problem}`)).join(" ")}
    </p>
  );
}

/** The `aria-describedby` and `aria-invalid` of a field with `help` and its errors. */
function described(errors: readonly FieldError[], id: string, help?: string) {
  const bad = errors.some((e) => e.id === id);
  const ids = [help, bad ? `${id}-error` : undefined].filter((x) => x !== undefined).join(" ");
  return {
    "aria-describedby": ids === "" ? undefined : ids,
    "aria-invalid": bad ? true : undefined,
  } as const;
}

/** Up, down and remove for one item in a list: buttons, so nothing depends on dragging. */
function ItemControls({
  t,
  what,
  index,
  count,
  canRemove,
  onMove,
  onRemove,
}: {
  t: Translate;
  what: string;
  index: number;
  count: number;
  canRemove: boolean;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex shrink-0 gap-1">
      <Button
        variant="outline"
        size="icon"
        aria-label={t("pollFormMoveUp", { what })}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp aria-hidden="true" />
      </Button>
      <Button
        variant="outline"
        size="icon"
        aria-label={t("pollFormMoveDown", { what })}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown aria-hidden="true" />
      </Button>
      {canRemove ? (
        <Button
          variant="outline"
          size="icon"
          aria-label={t("pollFormRemove", { what })}
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

function Optional({ t }: { t: Translate }) {
  return <span className="font-normal text-muted-foreground"> {t("pollFormOptional")}</span>;
}

/** A count of picks, clamped to what the codec can hold; the field checks judge the rest. */
function Picks({
  t,
  id,
  label,
  value,
  errors,
  onChange,
}: {
  t: Translate;
  id: string;
  label: string;
  value: number;
  errors: readonly FieldError[];
  onChange: (n: number) => void;
}) {
  // The text as typed, so the field can be cleared to retype; the count is
  // what it parses to (0 while empty), judged by the field checks.
  const [typed, setTyped] = useState(String(value));
  const shown = Number.parseInt(typed, 10) === value ? typed : String(value);
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={id} className="text-base font-semibold">
        {label}
      </Label>
      <Errors t={t} errors={errors} id={id} />
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_OPTIONS}
        step={1}
        className={cn(FIELD, "w-24 tabular-nums")}
        {...described(errors, id)}
        value={typed === "" && value === 0 ? "" : shown}
        onChange={(e) => {
          setTyped(e.target.value);
          const n = Number.parseInt(e.target.value, 10);
          onChange(Number.isInteger(n) ? Math.min(Math.max(n, 0), MAX_OPTIONS) : 0);
        }}
      />
    </div>
  );
}

function QuestionFields({
  t,
  q,
  index,
  count,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  t: Translate;
  q: FormQuestion;
  index: number;
  count: number;
  errors: readonly FieldError[];
  onChange: (q: FormQuestion) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const heading = `${q.key}-heading`;
  const ruleLegend = `${q.key}-rule`;
  const textId = fieldId.question(q.key);
  const descriptionId = fieldId.questionDescription(q.key);
  const addId = fieldId.addOption(q.key);
  const m = q.options.length;
  return (
    <section aria-labelledby={heading} className="grid gap-6 border border-border p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={heading} className="m-0 text-xl font-semibold">
          {t("pollFormQuestion", { n })}
        </h3>
        <ItemControls
          t={t}
          what={t("pollFormWhatQuestion", { n })}
          index={index}
          count={count}
          canRemove={count > 1}
          onMove={onMove}
          onRemove={onRemove}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={textId} className="text-base font-semibold">
          {t("pollFormQuestionLabel")}
        </Label>
        <Errors t={t} errors={errors} id={textId} />
        <Textarea
          id={textId}
          rows={2}
          className="min-h-20 p-3 text-lg md:text-lg"
          {...described(errors, textId)}
          value={q.question}
          onChange={(e) => onChange({ ...q, question: e.target.value })}
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor={descriptionId} className="text-base font-semibold">
          {t("pollFormQuestionDescriptionLabel")}
          <Optional t={t} />
        </Label>
        <p id={`${descriptionId}-help`} className="m-0 text-sm text-muted-foreground">
          {t("pollFormQuestionDescriptionHelp")}
        </p>
        <Errors t={t} errors={errors} id={descriptionId} />
        <Textarea
          id={descriptionId}
          rows={2}
          className="p-3 text-base md:text-base"
          {...described(errors, descriptionId, `${descriptionId}-help`)}
          value={q.description}
          onChange={(e) => onChange({ ...q, description: e.target.value })}
        />
      </div>

      <fieldset className="m-0 grid gap-4 border-0 p-0">
        <legend id={ruleLegend} className="mb-3 p-0 text-base font-semibold">
          {t("pollFormRuleLegend")}
        </legend>
        <RadioGroup
          aria-labelledby={ruleLegend}
          value={q.rule}
          onValueChange={(value) => {
            const rule = value as AnswerRule;
            // Start from the range the question already has, so switching rules loses nothing.
            const { min, max } = selectionRange(q);
            onChange({
              ...q,
              rule,
              min: rule === "between" ? Math.max(min, 1) : q.min,
              max: rule === "exactly" || rule === "upTo" ? Math.max(max, 2) : max,
            });
          }}
          className="flex flex-wrap gap-2"
        >
          {ANSWER_RULES.map((r) => (
            <Label
              key={r}
              className={cn(
                "flex min-h-12 items-center gap-3 border px-4 text-sm leading-tight font-normal",
                q.rule === r ? "border-2 border-primary px-[15px] font-semibold" : "border-border",
              )}
            >
              <RadioGroupItem value={r} />
              {t(`pollFormRule_${r}`)}
            </Label>
          ))}
        </RadioGroup>
        {q.rule === "upTo" || q.rule === "exactly" || q.rule === "between" ? (
          <div className="flex flex-wrap gap-6">
            {q.rule === "between" ? (
              <Picks
                t={t}
                id={fieldId.min(q.key)}
                label={t("pollFormMinLabel")}
                value={q.min}
                errors={errors}
                onChange={(min) => onChange({ ...q, min })}
              />
            ) : null}
            <Picks
              t={t}
              id={fieldId.max(q.key)}
              label={t(`pollFormMaxLabel_${q.rule}`)}
              value={q.max}
              errors={errors}
              onChange={(max) => onChange({ ...q, max })}
            />
          </div>
        ) : null}
        {q.rule === "exactly" || q.rule === "between" ? null : (
          <Label className="flex min-h-12 items-center gap-3 text-base font-normal">
            <Checkbox
              className="size-5"
              checked={q.optional}
              onCheckedChange={(checked) => onChange({ ...q, optional: checked })}
            />
            {t("pollFormOptionalLabel")}
          </Label>
        )}
      </fieldset>

      <fieldset className="m-0 grid gap-4 border-0 p-0">
        <legend className="mb-3 p-0 text-base font-semibold">{t("pollFormOptionsLegend")}</legend>
        <ol className="m-0 grid list-none gap-6 p-0">
          {q.options.map((o, j) => {
            const labelId = fieldId.label(q.key, o.key);
            const detailId = fieldId.optionDescription(q.key, o.key);
            return (
              <li key={o.key} className="grid gap-2">
                {/* The controls share the label's row, as a question's share its
                    heading's, so on a phone they never wrap between the option's
                    field and its details (P2-29, creating a poll's iteration 3). */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Label htmlFor={labelId} className="text-sm font-semibold">
                    {t("pollFormOption", { n: j + 1 })}
                  </Label>
                  <ItemControls
                    t={t}
                    what={t("pollFormWhatOption", { n: j + 1, q: n })}
                    index={j}
                    count={m}
                    canRemove={m > 1}
                    onMove={(dir) => onChange({ ...q, options: move(q.options, j, j + dir) })}
                    onRemove={() =>
                      onChange({ ...q, options: q.options.filter((x) => x.key !== o.key) })
                    }
                  />
                </div>
                <Errors t={t} errors={errors} id={labelId} />
                <Input
                  id={labelId}
                  className={FIELD}
                  {...described(errors, labelId)}
                  value={o.label}
                  onChange={(e) =>
                    onChange({
                      ...q,
                      options: q.options.map((x) =>
                        x.key === o.key ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                />
                <Label htmlFor={detailId} className="text-sm font-normal text-muted-foreground">
                  {t("pollFormOptionDescriptionLabel", { n: j + 1 })}
                  <Optional t={t} />
                </Label>
                <Errors t={t} errors={errors} id={detailId} />
                <Input
                  id={detailId}
                  className={FIELD}
                  {...described(errors, detailId)}
                  value={o.description}
                  onChange={(e) =>
                    onChange({
                      ...q,
                      options: q.options.map((x) =>
                        x.key === o.key ? { ...x, description: e.target.value } : x,
                      ),
                    })
                  }
                />
              </li>
            );
          })}
        </ol>
        <Errors t={t} errors={errors} id={addId} />
        <div>
          <Button
            id={addId}
            variant="outline"
            {...described(errors, addId)}
            onClick={() => onChange({ ...q, options: [...q.options, newOption()] })}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            {t("pollFormAddOption")}
            <span className="sr-only"> {t("pollFormAddOptionTo", { n })}</span>
          </Button>
        </div>
      </fieldset>
    </section>
  );
}

/** The poll as people answering will read it, redrawn from the form as the author edits. */
function PollPreview({ t, form }: { t: Translate; form: PollForm }) {
  const { locale } = useI18n();
  const closesAt = closesAtOf(form);
  const placeholder = "text-muted-foreground italic";
  return (
    <div className="grid gap-6 border-2 border-foreground p-5 sm:p-6">
      <div className="grid gap-2">
        <p
          className={cn(
            "m-0 font-heading text-2xl font-semibold break-words",
            form.title === "" && placeholder,
          )}
        >
          {form.title === "" ? t("pollFormPreviewEmpty") : form.title}
        </p>
        {form.description === "" ? null : (
          <p className="m-0 text-base whitespace-pre-line break-words">{form.description}</p>
        )}
        {closesAt === undefined ? null : (
          <p className="m-0 font-mono text-xs tracking-wide" suppressHydrationWarning>
            {t("pollFormPreviewCloses", {
              when: formatUtc(locale, new Date(Number(closesAt) * 1000)),
            })}
          </p>
        )}
      </div>
      <ol className="m-0 grid list-none gap-6 p-0">
        {form.questions.map((q) => {
          const { min, max } = selectionRange(q);
          return (
            <li key={q.key} className="grid gap-3 border-t border-border pt-4">
              <p
                className={cn(
                  "m-0 text-lg font-semibold break-words",
                  q.question === "" && placeholder,
                )}
              >
                {q.question === "" ? t("pollFormPreviewQuestionEmpty") : q.question}
              </p>
              {q.description === "" ? null : (
                <p className="m-0 text-sm whitespace-pre-line break-words">{q.description}</p>
              )}
              <p className="m-0 text-sm text-muted-foreground">
                {q.rule === "between"
                  ? t("pollFormPreviewRule_between", { min, max })
                  : q.rule === "upTo" || q.rule === "exactly"
                    ? t(`pollFormPreviewRule_${q.rule}`, { count: max })
                    : t(`pollFormPreviewRule_${q.rule}`)}
                {min === 0 ? ` ${t("pollFormPreviewOptional")}` : null}
              </p>
              <ul className="m-0 grid list-none gap-2 p-0">
                {q.options.map((o) => (
                  <li key={o.key} className="grid gap-1 border border-border px-3 py-2">
                    <span className={cn("break-words", o.label === "" && placeholder)}>
                      {o.label === "" ? t("pollFormPreviewOptionEmpty") : o.label}
                    </span>
                    {o.description === "" ? null : (
                      <span className="text-sm text-muted-foreground break-words">
                        {o.description}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * Where the poll will be listed, apart from the poll itself: the topic and
 * place are the listing's, not words people answer (ADR 0041, rule 4; T-34).
 * The place keeps its own direction, so a right-to-left name can't reorder
 * the words around it.
 */
function ListingPreview({ t, form }: { t: Translate; form: PollForm }) {
  const place = tidyPlace(form.place);
  if (form.topic === "" && place === "")
    return <p className="m-0 text-sm text-muted-foreground">{t("pollFormPreviewNotListed")}</p>;
  return (
    <ul
      aria-labelledby="poll-form-listed"
      className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm"
    >
      {form.topic === "" ? null : (
        <li className="border border-border px-2 py-1">{t(POLL_TOPIC_MESSAGES[form.topic])}</li>
      )}
      {place === "" ? null : (
        <li className="min-w-0 border border-border px-2 py-1 wrap-anywhere">
          <bdi>{place}</bdi>
        </li>
      )}
    </ul>
  );
}

/** One row of the review: what it is, what the form says, and the field that changes it. */
interface ReviewRow {
  readonly label: string;
  readonly value: ReactNode;
  /** The field to go back to; none when nothing on the page changes it. */
  readonly field?: string;
}

function ReviewList({
  t,
  rows,
  onJump,
}: {
  t: Translate;
  rows: readonly ReviewRow[];
  onJump: (event: SyntheticEvent, target: string) => void;
}) {
  return (
    <dl className="m-0 grid">
      {rows.map((r) => (
        // Below sm, "Change" shares its label's row rather than taking a 48px
        // row of its own under every value (P2-29, creating a poll's iteration 4).
        // From sm the columns share a baseline, so "Change", centred in its
        // 48px target, reads on its label's line rather than 12px under it
        // (iteration 5).
        <div
          key={r.label}
          className="grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-1 border-b border-border py-3 first:border-t sm:grid-cols-[9rem_1fr_auto] sm:items-baseline"
        >
          <dt className="font-semibold">{r.label}</dt>
          <dd className="col-span-2 m-0 min-w-0 text-pretty wrap-anywhere sm:col-span-1">
            {r.value}
          </dd>
          <dd className="col-start-2 row-start-1 m-0 sm:col-start-3">
            {r.field === undefined ? null : (
              <a
                href={`#${r.field}`}
                onClick={(event) => onJump(event, r.field ?? "")}
                className="inline-flex min-h-12 items-center underline underline-offset-4"
              >
                {t("pollFormReviewChange")}
                <span className="sr-only"> {r.label}</span>
              </a>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The review before submitting (P2-26 part 1b): what goes on the public
 * record for good, apart from where the poll is listed, which moderation can
 * change (ADR 0041, rules 3 and 4; T-68). Drawn from the form, which
 * submission requires to be the saved draft.
 */
function PollReview({
  t,
  form,
  phoneVerification,
  onJump,
}: {
  t: Translate;
  form: PollForm;
  phoneVerification: boolean;
  onJump: (event: SyntheticEvent, target: string) => void;
}) {
  const { locale } = useI18n();
  const closesAt = closesAtOf(form);
  const place = tidyPlace(form.place);
  const first = form.questions[0];
  const none = <span className="text-muted-foreground">{t("pollFormReviewNone")}</span>;
  const permanent: ReviewRow[] = [
    {
      label: t("pollFormReviewTitleRow"),
      value:
        form.title === "" ? (
          <span className="text-muted-foreground">{t("pollFormReviewUntitled")}</span>
        ) : (
          form.title
        ),
      field: fieldId.title,
    },
    {
      label: t("pollFormReviewQuestions"),
      value: (
        <>
          {t("pollFormReviewQuestionCount", { count: form.questions.length })}
          {form.questions.length === 0 ? null : (
            <ol className="m-0 mt-1 grid gap-1 ps-5">
              {form.questions.map((q) => (
                <li key={q.key}>{q.question}</li>
              ))}
            </ol>
          )}
        </>
      ),
      field: first === undefined ? fieldId.addQuestion : fieldId.question(first.key),
    },
    {
      label: t("pollFormReviewWho"),
      value: form.tiers.map((tier) => whoName(t, tier, phoneVerification)).join(", "),
    },
    {
      label: t("pollFormReviewCloses"),
      value:
        closesAt === undefined ? (
          <span className="text-muted-foreground">{t("pollFormReviewNotSet")}</span>
        ) : (
          <span suppressHydrationWarning>
            {t("pollFormReviewClosesAt", {
              when: formatIn(locale, form.timeZone, new Date(Number(closesAt) * 1000)),
              utc: utcBeside(locale, form.timeZone, new Date(Number(closesAt) * 1000)),
            })}
          </span>
        ),
      field: fieldId.closes,
    },
  ];
  const listing: ReviewRow[] = [
    {
      label: t("pollFormReviewPlace"),
      value: place === "" ? none : <bdi className="wrap-anywhere">{place}</bdi>,
      field: fieldId.place,
    },
    {
      label: t("pollFormReviewTopic"),
      value: form.topic === "" ? none : t(POLL_TOPIC_MESSAGES[form.topic]),
      field: fieldId.topic,
    },
  ];
  return (
    <section aria-labelledby="poll-form-review" className="grid gap-6">
      <div className="grid gap-2">
        <h3 id="poll-form-review" className="m-0 text-xl font-semibold">
          {t("pollFormReviewTitle")}
        </h3>
        <p className="m-0 max-w-prose">{t("pollFormReviewLede")}</p>
      </div>
      <div className="grid gap-3">
        <h4 className="m-0 text-base font-semibold">{t("pollFormReviewPermanent")}</h4>
        <p className="m-0 max-w-prose text-sm text-muted-foreground">
          {t("pollFormReviewPermanentLede")}
        </p>
        <ReviewList t={t} rows={permanent} onJump={onJump} />
      </div>
      <div className="grid gap-3">
        <h4 className="m-0 text-base font-semibold">{t("pollFormReviewListing")}</h4>
        <p className="m-0 max-w-prose text-sm text-muted-foreground">
          {t("pollFormReviewListingLede")}
        </p>
        <ReviewList t={t} rows={listing} onJump={onJump} />
      </div>
    </section>
  );
}

const ID = /^[a-z0-9]{32}$/;

/** Why a submission didn't go: the handler's refusal, or the page's own reason. */
type SubmitFailure =
  | DraftsFailure
  /** The form has changes the saved draft doesn't, or nothing is saved yet. */
  | "saveFirst"
  /** This deployment names no Turnstile site key. */
  | "noChallenge";

const SUBMIT_MESSAGES: Partial<Record<SubmitFailure, keyof Messages>> = {
  saveFirst: "pollFormSubmitSaveFirst",
  noChallenge: "pollFormSubmitUnavailable",
  signedOut: "pollFormSignedOut",
  refused: "pollFormSubmitRefused",
};

export interface PollFormPageProps {
  readonly client: DraftsClient;
  /** The draft to edit; none for a new poll. */
  readonly id?: string | undefined;
  /** Called once a new draft is saved, with its ID, so the page's address can name it. */
  readonly onCreated?: (id: string) => void;
  /** The account's profile, for the choice of whether it shows the poll; none to offer no choice. */
  readonly profiles?: ProfilesClient;
  /** The check a submission's token comes from; none if this deployment has no site key. */
  readonly challenge?: Challenge | undefined;
  /** Called once the draft is submitted for setup, with its poll's ID. */
  readonly onSubmitted?: (id: string) => void;
  /** Whether this deployment verifies a phone before an account votes, which names Tier 0. */
  readonly phoneVerification: boolean;
  /** The clock; the system's by default. */
  readonly now?: () => Date;
  /** The author's own time zone, the closing time's clock; the browser's by default. */
  readonly timeZone?: string;
}

/**
 * Writing a poll and saving it as a draft (P2-22 part 6b): its title, its
 * questions with their options and selection rules, who can answer and when
 * it closes, with a preview of what people answering will see. A draft is
 * checked by the definition's own rules before it is sent, so the handler
 * never refuses one the page let through (T-34, T-72). Only the author's
 * own text and closing time leave the page; nothing names a voter (T-10).
 *
 * Submitting a saved draft for setup (part 6c) takes a Turnstile solve for
 * `poll-create`: the check is loaded only when the author submits, and its
 * token is spent on that one request (T-72; src/account/challenge.ts).
 *
 * Where the account has a profile, the author chooses whether it shows the
 * poll (P2-27 part 1d-3): at once for a saved draft, and for a new one
 * right after its first save, since the choice names the poll's ID.
 */
export function PollFormPage({
  client,
  id,
  onCreated,
  profiles,
  challenge,
  onSubmitted,
  phoneVerification,
  now = () => new Date(),
  timeZone,
}: PollFormPageProps) {
  const t = useTranslate(catalogs);
  const { locale } = useI18n();
  // No form until the page's script runs, for a new poll too: saving needs
  // the script, Base UI's radios and checkboxes carry inline styles the CSP
  // refuses in server-rendered markup (P2-19), and list keys are the
  // browser's own.
  const [form, setForm] = useState<PollForm | undefined>();
  const [unavailable, setUnavailable] = useState<Unavailable | undefined>();
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(id !== undefined);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<DraftsFailure | undefined>();
  // Whether the form holds anything the saved draft doesn't: only a saved
  // draft, as it is stored, can be submitted.
  const [dirty, setDirty] = useState(false);
  const [submitting, setSubmitting] = useState<"idle" | "checking" | "sending" | "sent">("idle");
  const [submitFailure, setSubmitFailure] = useState<SubmitFailure | undefined>();
  // Whether the problems listed stopped a submission rather than a save.
  const [errorsStopped, setErrorsStopped] = useState<"save" | "submit">("save");
  // The account's profile: none while unread or unreadable, `null` if it has none.
  const [profile, setProfile] = useState<OwnProfileView | null | undefined>();
  // A new poll's choice, made before its first save gives it an ID.
  const [wantShown, setWantShown] = useState(false);
  // The draft saved, but its choice to be shown didn't go through.
  const [unshown, setUnshown] = useState(false);
  // The draft this page saves to: the one it opened, or the one its first save made.
  const savedId = useRef<string | undefined>(undefined);
  // Where the check is shown, and the way to take it down again.
  const checkBox = useRef<HTMLDivElement>(null);
  const solving = useRef<AbortController | undefined>(undefined);
  // Counts the form's edits, so a save knows whether it stored what the page shows.
  const edits = useRef(0);
  const summary = useRef<HTMLDivElement>(null);
  // After a save, focus goes to the heading, and the status line below says what happened.
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // A new draft's own ID arriving in the address names what is already on the page.
    if (id !== undefined && id === savedId.current) return;
    // Any other address is another poll: nothing of the last one stays.
    savedId.current = undefined;
    solving.current?.abort();
    setErrors([]);
    setSaved(false);
    setFailure(undefined);
    setDirty(false);
    setSubmitting("idle");
    setSubmitFailure(undefined);
    setUnavailable(undefined);
    setWantShown(false);
    setUnshown(false);
    // The author's own clock, as the browser knows it: the form only exists in the browser.
    const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    setForm(id === undefined ? newPollForm(zone) : undefined);
    if (id === undefined) return setBusy(false);
    setBusy(true);
    if (!ID.test(id)) {
      setUnavailable("gone");
      setBusy(false);
      return;
    }
    let live = true;
    client
      .read(id)
      .then(({ summary: poll, draft }) => {
        if (!live) return;
        if (poll.state !== "drafted") return setUnavailable("notDraft");
        savedId.current = id;
        setForm(formOf(draft, zone));
      })
      .catch((e: unknown) => {
        if (!live) return;
        const why = e instanceof DraftsError ? e.failure : "failed";
        setUnavailable(why === "signedOut" ? "signedOut" : why === "gone" ? "gone" : "unloaded");
      })
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [client, id, timeZone]);

  useEffect(() => {
    if (attempt > 0) summary.current?.focus();
  }, [attempt]);

  // A check still showing when the page goes is taken down with it.
  useEffect(() => () => solving.current?.abort(), []);

  // Counts the profile's reads, so only the newest one's answer is kept.
  const profileReads = useRef(0);
  const readProfile = useCallback(async () => {
    if (profiles === undefined) return;
    const read = ++profileReads.current;
    // A failed read keeps the profile as last read, or no choice before a
    // first read: the account page says why.
    const p = await profiles.own().then(
      (p) => p ?? null,
      () => undefined,
    );
    if (p !== undefined && read === profileReads.current) setProfile(p);
  }, [profiles]);

  useEffect(() => void readProfile(), [readProfile]);

  const seconds = () => BigInt(Math.floor(now().getTime() / 1000));

  // A fixed field drops its error at once; new problems wait for the next save.
  const change = (next: PollForm) => {
    // The draft as saved is on its way to setup: an edit now would be lost unsaid.
    if (submitting === "sending" || submitting === "sent") return;
    edits.current += 1;
    setForm(next);
    setSaved(false);
    setDirty(true);
    // A check under way was for the draft as saved; the author saves again first.
    if (solving.current !== undefined) {
      solving.current.abort();
      setSubmitting("idle");
    }
    if (errors.length === 0) return;
    const still = [...fieldErrors(next), ...closesErrors(next, seconds())];
    setErrors(errors.filter((e) => still.some((s) => s.id === e.id && s.problem === e.problem)));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (form === undefined || busy || submitting === "sending" || submitting === "sent") return;
    setSaved(false);
    setFailure(undefined);
    const checked = checkForm(form, seconds());
    setErrors(checked.errors);
    setErrorsStopped("save");
    if (checked.draft === undefined) {
      setAttempt((a) => a + 1);
      return;
    }
    setBusy(true);
    setSubmitFailure(undefined);
    // A check under way would submit the draft this save replaces.
    if (solving.current !== undefined) {
      solving.current.abort();
      setSubmitting("idle");
    }
    // Only the form as it was sent is saved: an edit during the save keeps it unsaved.
    const sent = edits.current;
    try {
      if (savedId.current === undefined) {
        const created = await client.create(checked.draft);
        // Before the page names the new draft, so its box never shows the choice undone.
        if (wantShown && profiles !== undefined) {
          setUnshown(
            !(await profiles.show(created, true).then(
              () => true,
              () => false,
            )),
          );
          await readProfile();
        }
        savedId.current = created;
        onCreated?.(created);
      } else await client.update(savedId.current, checked.draft);
      if (edits.current === sent) {
        setSaved(true);
        setDirty(false);
      }
    } catch (e) {
      const why = e instanceof DraftsError ? e.failure : "failed";
      if (why === "changed") setUnavailable("notDraft");
      else if (why === "gone") setUnavailable("gone");
      else setFailure(why);
    } finally {
      setBusy(false);
      heading.current?.focus();
    }
  };

  const submit = async () => {
    const poll = savedId.current;
    if (form === undefined || busy || submitting !== "idle") return;
    setSaved(false);
    setFailure(undefined);
    setSubmitFailure(undefined);
    if (poll === undefined || dirty) return setSubmitFailure("saveFirst");
    // The closing time is judged again now: a draft saved a while ago may no
    // longer leave setup its time, and the handler would refuse it.
    const checked = checkForm(form, seconds());
    if (checked.draft === undefined) {
      setErrors(checked.errors);
      setErrorsStopped("submit");
      setAttempt((a) => a + 1);
      return;
    }
    if (challenge === undefined) return setSubmitFailure("noChallenge");
    const container = checkBox.current;
    if (container === null) return;
    const controller = new AbortController();
    solving.current = controller;
    setSubmitting("checking");
    let token: string;
    try {
      token = await challenge.solve(container, "poll-create", controller.signal);
    } catch {
      if (controller.signal.aborted) return;
      setSubmitting("idle");
      setSubmitFailure("challengeUnavailable");
      return;
    } finally {
      if (solving.current === controller) solving.current = undefined;
    }
    if (controller.signal.aborted) return;
    setSubmitting("sending");
    try {
      await client.submit(poll, token);
      setSubmitting("sent");
      onSubmitted?.(poll);
    } catch (e) {
      setSubmitting("idle");
      // The token is spent either way: submitting again takes a new check.
      const why = e instanceof DraftsError ? e.failure : "failed";
      if (why === "changed") setUnavailable("notDraft");
      else if (why === "gone") setUnavailable("gone");
      else setSubmitFailure(why);
    }
  };

  const jump = (event: SyntheticEvent, target: string) => {
    const element = document.getElementById(target);
    if (element === null) return;
    event.preventDefault();
    element.focus();
    element.scrollIntoView({ block: "center" });
  };

  // A poll not yet saved has no list to go back to: a first-time asker has
  // none, and the frame's own Account link is there for anyone who has.
  const isNew = id === undefined && savedId.current === undefined;
  const back = isNew ? null : (
    <a href="/account" className="underline underline-offset-4">
      {t("pollFormBack")}
    </a>
  );

  const header = (
    <PageHeader
      eyebrow={t(isNew ? "pollFormNewEyebrow" : "pollFormEyebrow")}
      title={t(isNew ? "pollFormNewTitle" : "pollFormEditTitle")}
      titleRef={heading}
      lede={t("pollFormLede")}
    >
      {back === null ? null : <p className="m-0">{back}</p>}
      <noscript>
        <p className="m-0 text-lg">{t("pollFormNeedsScript")}</p>
      </noscript>
    </PageHeader>
  );

  if (unavailable !== undefined || form === undefined)
    return (
      <div className="grid gap-12">
        {header}
        <p
          role={unavailable === undefined ? "status" : "alert"}
          className="m-0 max-w-prose text-lg"
        >
          {unavailable === undefined
            ? id === undefined
              ? null
              : t("pollFormLoading")
            : t(
                (
                  {
                    signedOut: "pollFormSignedOut",
                    gone: "pollFormGone",
                    notDraft: "pollFormNotDraft",
                    unloaded: "pollFormUnloaded",
                  } as const
                )[unavailable],
              )}
        </p>
      </div>
    );

  const closesAt = closesAtOf(form);
  // A saved draft with nothing unsaved has one next step, submitting, so its
  // button is the page's primary one and "Save draft" steps back; any edit
  // gives the primary back to saving (P2-29, creating a poll's iteration 5).
  const ready = !isNew && !dirty;
  const setQuestion = (i: number, q: FormQuestion) =>
    change({ ...form, questions: form.questions.map((x, j) => (j === i ? q : x)) });

  return (
    <div className="grid gap-12">
      {header}
      <form
        id={fieldId.form}
        tabIndex={-1}
        noValidate
        aria-busy={busy}
        onSubmit={save}
        className="grid gap-14 outline-none lg:grid-cols-12 lg:gap-x-12 lg:gap-y-12"
      >
        <div className="grid min-w-0 content-start gap-12 lg:col-span-7">
          {errors.length > 0 ? (
            <div
              ref={summary}
              tabIndex={-1}
              role="region"
              aria-labelledby="poll-form-errors"
              className="grid gap-2 border-2 border-destructive p-5 outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              <h2 id="poll-form-errors" className="m-0 text-lg font-semibold">
                {t(errorsStopped === "save" ? "pollFormErrorsTitle" : "pollFormSubmitErrorsTitle")}
              </h2>
              <p className="m-0">{t("pollFormErrorsLede")}</p>
              <ul className="m-0 grid list-none p-0">
                {errors.map((e) => (
                  <li key={`${e.id}-${e.problem}`}>
                    <a
                      href={`#${e.id}`}
                      onClick={(event) => jump(event, e.id)}
                      className="inline-flex min-h-12 items-center text-destructive underline underline-offset-4"
                    >
                      {say(t, e)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <Section title={t("pollFormAboutTitle")} id="poll-form-about">
            <div className="grid gap-6">
              <div className="grid gap-2">
                <Label htmlFor={fieldId.title} className="text-base font-semibold">
                  {t("pollFormTitleLabel")}
                </Label>
                <p id={`${fieldId.title}-help`} className="m-0 text-sm text-muted-foreground">
                  {t("pollFormTitleHelp")}
                </p>
                <Errors t={t} errors={errors} id={fieldId.title} />
                <Input
                  id={fieldId.title}
                  className={cn(FIELD, "text-lg md:text-lg")}
                  {...described(errors, fieldId.title, `${fieldId.title}-help`)}
                  value={form.title}
                  onChange={(e) => change({ ...form, title: e.target.value })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor={fieldId.description} className="text-base font-semibold">
                  {t("pollFormDescriptionLabel")}
                  <Optional t={t} />
                </Label>
                <p id={`${fieldId.description}-help`} className="m-0 text-sm text-muted-foreground">
                  {t("pollFormDescriptionHelp")}
                </p>
                <Errors t={t} errors={errors} id={fieldId.description} />
                <Textarea
                  id={fieldId.description}
                  rows={4}
                  className="p-3 text-base md:text-base"
                  {...described(errors, fieldId.description, `${fieldId.description}-help`)}
                  value={form.description}
                  onChange={(e) => change({ ...form, description: e.target.value })}
                />
              </div>
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="grid content-start gap-2">
                  <Label htmlFor={fieldId.place} className="text-base font-semibold">
                    {t("pollFormPlaceLabel")}
                    <Optional t={t} />
                  </Label>
                  <p id={`${fieldId.place}-help`} className="m-0 text-sm text-muted-foreground">
                    {t("pollFormPlaceHelp")}
                  </p>
                  <Errors t={t} errors={errors} id={fieldId.place} />
                  <Input
                    id={fieldId.place}
                    dir="auto"
                    autoComplete="off"
                    className={FIELD}
                    {...described(errors, fieldId.place, `${fieldId.place}-help`)}
                    value={form.place}
                    onChange={(e) => change({ ...form, place: e.target.value })}
                  />
                </div>
                <div className="grid content-start gap-2">
                  <Label htmlFor={fieldId.topic} className="text-base font-semibold">
                    {t("pollFormTopicLabel")}
                    <Optional t={t} />
                  </Label>
                  <p id={`${fieldId.topic}-help`} className="m-0 text-sm text-muted-foreground">
                    {t("pollFormTopicHelp")}
                  </p>
                  <NativeSelect
                    id={fieldId.topic}
                    className="w-full"
                    aria-describedby={`${fieldId.topic}-help`}
                    value={form.topic}
                    onChange={(e) => change({ ...form, topic: topicOf(e.target.value) })}
                  >
                    <NativeSelectOption value="">{t("pollFormTopicNone")}</NativeSelectOption>
                    {POLL_TOPICS.map((topic) => (
                      <NativeSelectOption key={topic} value={topic}>
                        {t(POLL_TOPIC_MESSAGES[topic])}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <p className="m-0 max-w-prose text-sm text-muted-foreground">
                {t("pollFormTagsNote")}
              </p>
              {profiles === undefined || profile === undefined ? null : profile === null ? (
                <p className="m-0 max-w-prose text-sm text-pretty text-muted-foreground">
                  {t("profileChoiceNone")}{" "}
                  <a href="/account#profile-title" className="underline underline-offset-4">
                    {t("profileChoiceNoneLink")}
                  </a>
                </p>
              ) : (
                <div className="grid gap-1">
                  <ProfileChoice
                    client={profiles}
                    profile={profile}
                    pollId={savedId.current}
                    wanted={wantShown}
                    onWant={(on) => {
                      setWantShown(on);
                      setUnshown(false);
                    }}
                    onChanged={() => {
                      setUnshown(false);
                      void readProfile();
                    }}
                  />
                  {unshown ? (
                    <p role="alert" className="m-0 text-sm text-destructive">
                      {t("profileChoiceFailure_unsaved")}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </Section>

          <Section
            title={t("pollFormQuestionsTitle")}
            id="poll-form-questions"
            lede={<p className="m-0">{t("pollFormQuestionsLede")}</p>}
          >
            <div className="grid gap-6">
              {form.questions.map((q, i) => (
                <QuestionFields
                  key={q.key}
                  t={t}
                  q={q}
                  index={i}
                  count={form.questions.length}
                  errors={errors}
                  onChange={(next) => setQuestion(i, next)}
                  onMove={(dir) => change({ ...form, questions: move(form.questions, i, i + dir) })}
                  onRemove={() =>
                    change({ ...form, questions: form.questions.filter((x) => x.key !== q.key) })
                  }
                />
              ))}
              <Errors t={t} errors={errors} id={fieldId.addQuestion} />
              <div>
                <Button
                  id={fieldId.addQuestion}
                  variant="outline"
                  {...described(errors, fieldId.addQuestion)}
                  onClick={() => change({ ...form, questions: [...form.questions, newQuestion()] })}
                >
                  <Plus aria-hidden="true" data-icon="inline-start" />
                  {t("pollFormAddQuestion")}
                </Button>
              </div>
            </div>
          </Section>

          <Section
            title={t("pollFormWhoTitle")}
            id="poll-form-who"
            lede={
              <p className="m-0">
                {t(phoneVerification ? "pollFormWhoLede_phone" : "pollFormWhoLede_email")}
              </p>
            }
          >
            <ul className="m-0 grid list-none border-t border-border p-0">
              {form.tiers.map((tier) => (
                <li key={tier} className="border-b border-border py-3 text-base font-semibold">
                  {whoName(t, tier, phoneVerification)}
                </li>
              ))}
            </ul>
          </Section>

          <Section
            title={t("pollFormWhenTitle")}
            id="poll-form-when"
            lede={
              <p className="m-0">
                {t("pollFormWhenLede", { zone: zoneName(locale, form.timeZone, now()) })}
              </p>
            }
          >
            <div className="grid gap-4">
              <Errors t={t} errors={errors} id={fieldId.closes} />
              <div className="flex flex-wrap gap-6">
                <div className="grid gap-2">
                  <Label htmlFor={fieldId.closes} className="text-base font-semibold">
                    {t("pollFormDateLabel")}
                  </Label>
                  <Input
                    id={fieldId.closes}
                    type="date"
                    className={cn(FIELD, "w-48")}
                    {...described(errors, fieldId.closes)}
                    value={form.closesDate}
                    onChange={(e) => change({ ...form, closesDate: e.target.value })}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="poll-closes-time" className="text-base font-semibold">
                    {t("pollFormTimeLabel")}
                  </Label>
                  <Input
                    id="poll-closes-time"
                    type="time"
                    className={cn(FIELD, "w-36")}
                    {...described(errors, fieldId.closes)}
                    value={form.closesTime}
                    onChange={(e) => change({ ...form, closesTime: e.target.value })}
                  />
                </div>
              </div>
              {closesAt === undefined ? null : (
                <p className="m-0 text-sm text-muted-foreground" suppressHydrationWarning>
                  {t("pollFormUtc", {
                    when: formatUtc(locale, new Date(Number(closesAt) * 1000)),
                  })}
                </p>
              )}
            </div>
          </Section>

          <div className="grid gap-4 border-t border-border pt-6">
            <div className="flex flex-wrap items-center gap-4">
              <Button
                type="submit"
                size="lg"
                variant={ready ? "outline" : "default"}
                disabled={busy || submitting === "sending" || submitting === "sent"}
              >
                {t("pollFormSave")}
              </Button>
              {back}
            </div>
            <div role="status" className="min-h-6 text-base">
              {saved ? t("pollFormSaved") : null}
            </div>
            {failure === undefined ? null : (
              <p role="alert" className="m-0 text-destructive">
                {failure === "signedOut" ? t("pollFormSignedOut") : t(`pollsFailure_${failure}`)}
              </p>
            )}
          </div>
        </div>

        {/* Where the preview stacks, it comes between saving and submitting, so
            an author sees what people will see before the review (P2-29,
            creating a poll's iteration 2); from lg it is the second column. */}
        <aside
          aria-labelledby="poll-form-preview"
          className="min-w-0 lg:col-span-5 lg:col-start-8 lg:row-span-2 lg:row-start-1"
        >
          {/* No mono marks over the preview or the listing: the everyday
              register keeps them for evidence, and "Preview" only repeated the
              heading (P2-29, creating a poll's iteration 5). */}
          <div className="grid gap-4 lg:sticky lg:top-6">
            <h2 id="poll-form-preview" className="m-0 font-heading text-2xl font-semibold">
              {t("pollFormPreviewTitle")}
            </h2>
            <PollPreview t={t} form={form} />
            <h3 id="poll-form-listed" className="m-0 mt-2 text-base font-semibold">
              {t("pollFormPreviewListed")}
            </h3>
            <ListingPreview t={t} form={form} />
          </div>
        </aside>

        <div className="grid min-w-0 content-start gap-12 lg:col-span-7">
          <Section
            title={t("pollFormSubmitTitle")}
            id="poll-form-submit"
            lede={
              <div className="grid gap-3">
                <p className="m-0">{t("pollFormSubmitLede")}</p>
                {isNew ? null : (
                  <p className="m-0 text-sm text-muted-foreground">
                    {t("pollFormSubmitCloudflare")}
                  </p>
                )}
              </div>
            }
          >
            {/* Only a saved draft can be submitted, so before the first save
                there is nothing to check through and no button that could
                only refuse. */}
            {isNew ? (
              <p className="m-0 max-w-prose text-base font-semibold">
                {t("pollFormSubmitAfterSave")}
              </p>
            ) : (
              <div className="grid gap-4">
                <PollReview t={t} form={form} phoneVerification={phoneVerification} onJump={jump} />
                <div>
                  <Button
                    type="button"
                    size="lg"
                    variant={ready ? "default" : "outline"}
                    disabled={busy || submitting !== "idle"}
                    onClick={() => void submit()}
                  >
                    {t("pollFormSubmit")}
                  </Button>
                </div>
                {/* Turnstile renders its frame here (src/account/challenge.ts). */}
                <div
                  ref={checkBox}
                  role="group"
                  aria-label={t("pollFormSubmitCheckLabel")}
                  hidden={submitting !== "checking"}
                />
                <div role="status" className="min-h-6 text-base">
                  {submitting === "checking"
                    ? t("pollFormSubmitChecking")
                    : submitting === "sending"
                      ? t("pollFormSubmitting")
                      : submitting === "sent"
                        ? t("pollFormSubmitted")
                        : null}
                </div>
                {submitFailure === undefined ? null : (
                  <p role="alert" className="m-0 text-destructive">
                    {t(
                      SUBMIT_MESSAGES[submitFailure] ??
                        `pollsFailure_${submitFailure as DraftsFailure}`,
                    )}
                  </p>
                )}
              </div>
            )}
          </Section>
        </div>
      </form>
    </div>
  );
}
