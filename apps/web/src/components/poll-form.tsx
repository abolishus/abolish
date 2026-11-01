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
  openLength,
  type PollForm,
  selectionRange,
  type TextField,
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

/**
 * Our own words with each hyphenated word kept on one line: on a phone the
 * review's `text-pretty` broke "e-mail" at its hyphen, "e-" ending one line
 * and "mail address" starting the next (P2-29, creating a poll's iteration
 * 14). Never for an asker's text, whose long hyphenated words must still wrap.
 */
function wholeWords(text: string): ReactNode {
  return text.split(/(\S+-\S+)/).map((part, i) =>
    i % 2 === 1 ? (
      <span key={i} className="whitespace-nowrap">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

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

/** A length in days and hours in words, leaving out a part that is zero. */
function lengthText(t: Translate, { days, hours }: { days: number; hours: number }): string {
  const d = t("pollFormOpenDays", { count: days });
  const h = t("pollFormOpenHours", { count: hours });
  if (days === 0) return h;
  return hours === 0 ? d : t("pollFormOpenDaysHours", { days: d, hours: h });
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

/** The fields outside any question, by their labels on the page. */
const FIELD_LABELS: Partial<Record<TextField, keyof Messages>> = {
  title: "pollFormTitleLabel",
  description: "pollFormDescriptionLabel",
  place: "pollFormPlaceLabel",
};

/**
 * A problem's words, saying which question, and which of its options, it is
 * in. Where the problem's own words don't name their field ("This is too
 * long."), the summary does: otherwise a question's and its explanation's,
 * or the title's and the description's, read the same (P2-29, creating a
 * poll's iteration 16).
 */
const say = (t: Translate, e: FieldError) => {
  const problem = t(`pollForm_${e.problem}`);
  const unnamed = e.problem === "tooLong" || e.problem === "unstorable";
  if (e.question === undefined) {
    const label = e.field === undefined ? undefined : FIELD_LABELS[e.field];
    return unnamed && label !== undefined
      ? t("pollFormInField", { field: t(label), problem })
      : problem;
  }
  if (e.option === undefined)
    return unnamed && e.field === "questionDescription"
      ? t("pollFormInExplanation", { n: e.question, problem })
      : t("pollFormInQuestion", { n: e.question, problem });
  return unnamed && e.field === "optionDescription"
    ? t("pollFormInDetails", { n: e.question, o: e.option, problem })
    : t("pollFormInOption", { n: e.question, o: e.option, problem });
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
  // A list's only item has nowhere to move: two buttons that are always
  // disabled would only be read out and skipped (P2-29, creating a poll's
  // iteration 12).
  const canMove = count > 1;
  if (!canMove && !canRemove) return null;
  return (
    <div className="flex shrink-0 gap-1">
      {canMove ? (
        <>
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
        </>
      ) : null}
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
          // One column of full-width choices on a phone, where five boxes of
          // their words' widths wrapped two, one, one and one (P2-29, creating
          // a poll's iteration 6). Their words are the blank choice's size
          // below them, where they were smaller (iteration 7).
          className="grid gap-2 sm:flex sm:flex-wrap"
        >
          {ANSWER_RULES.map((r) => (
            <Label
              key={r}
              className={cn(
                "flex min-h-12 items-center gap-3 border px-4 text-base leading-tight font-normal",
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
    // The everyday register's soft rule, not the civic record's heavy frame
    // (P2-29, creating a poll's iteration 6). The author's text breaks a long
    // word anywhere: with `break-words` a pasted link still set its column's
    // width, so the page scrolled sideways on a phone (iteration 16).
    <div className="grid gap-6 border border-border p-5 sm:p-6">
      <div className="grid gap-2">
        <p
          className={cn(
            "m-0 font-heading text-2xl font-semibold wrap-anywhere",
            form.title === "" && placeholder,
          )}
        >
          {form.title === "" ? t("pollFormPreviewEmpty") : form.title}
        </p>
        {form.description === "" ? null : (
          <p className="m-0 text-base whitespace-pre-line wrap-anywhere">{form.description}</p>
        )}
        {/* In the poll's own words' face, as the poll page states its close:
            12px monospace is the civic record's mark for evidence, and at
            360px it split "3:00" from "PM UTC" (P2-29, creating a poll's
            iteration 18). */}
        {closesAt === undefined ? null : (
          <p className="m-0 text-sm text-muted-foreground" suppressHydrationWarning>
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
                  "m-0 text-lg font-semibold wrap-anywhere",
                  q.question === "" && placeholder,
                )}
              >
                {q.question === "" ? t("pollFormPreviewQuestionEmpty") : q.question}
              </p>
              {/* The ballot client sets the explanation at its options' size, so
                  here too it is never the smallest words on the question
                  (P2-29, creating a poll's iteration 19). */}
              {q.description === "" ? null : (
                <p className="m-0 text-base whitespace-pre-line wrap-anywhere">{q.description}</p>
              )}
              {/* The ballot client's own words for the range, read from it as
                  the ballot client reads them, and its note on a question
                  that can't be skipped: the form's rule names (a "One" left
                  blank, "Any number" that can't be) aren't what people read
                  (P2-29, creating a poll's iteration 20). */}
              <p className="m-0 text-sm text-muted-foreground">
                <span>{instructionText(t, min, max, q.options.length)}</span>
                {min === 0 ? null : <span> {t("pollFormPreviewCantSkip")}</span>}
              </p>
              <ul className="m-0 grid list-none gap-2 p-0">
                {q.options.map((o) => (
                  <li
                    key={o.key}
                    className="flex items-center gap-3 border border-border px-3 py-2"
                  >
                    {/* The ballot client's empty mark: round where an answer
                        picks one, square where it may pick more, so the
                        preview shows which kind of choice this is (iteration 19). */}
                    <span
                      aria-hidden="true"
                      data-mark={max === 1 ? "one" : "many"}
                      className={cn(
                        "size-5 shrink-0 border-2 border-foreground",
                        max === 1 && "rounded-full",
                      )}
                    />
                    <span className="grid min-w-0 flex-1 gap-1">
                      <span className={cn("wrap-anywhere", o.label === "" && placeholder)}>
                        {o.label === "" ? t("pollFormPreviewOptionEmpty") : o.label}
                      </span>
                      {o.description === "" ? null : (
                        <span className="text-sm text-muted-foreground wrap-anywhere">
                          {o.description}
                        </span>
                      )}
                    </span>
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
 * The instruction the ballot client gives over a question answering from
 * `min` to `max` of `all` options (apps/ballot/src/answers.ts,
 * `instructionOf`), in its words.
 */
function instructionText(t: Translate, min: number, max: number, all: number): string {
  if (min === 0) {
    if (max === 1) return t("pollFormPreviewChooseOne");
    return max === all
      ? t("pollFormPreviewChooseAny")
      : t("pollFormPreviewChooseUpTo", { count: max });
  }
  if (min === max) return t("pollFormPreviewChooseExactly", { count: min });
  return max === all
    ? t("pollFormPreviewChooseAtLeast", { count: min })
    : t("pollFormPreviewChooseBetween", { min, max });
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
  locked,
  onJump,
}: {
  t: Translate;
  rows: readonly ReviewRow[];
  /** The draft is on its way to setup, so no field takes an edit any more. */
  locked: boolean;
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
            {/* A row nothing on the page changes keeps the link's room, so its
                value sits where every other row's does rather than 20px
                higher (P2-29, creating a poll's iteration 8). Once the draft
                is sent, every row is one nothing changes: a "Change" then led
                to a field that drops what is typed into it (iteration 15). */}
            {r.field === undefined || locked ? (
              <span aria-hidden="true" className="invisible inline-flex min-h-12 items-center">
                {t("pollFormReviewChange")}
              </span>
            ) : (
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
  locked,
  onJump,
}: {
  t: Translate;
  form: PollForm;
  phoneVerification: boolean;
  locked: boolean;
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
    // The description is in the definition as the title is, so it is
    // recorded for good too; the review left it out, as if it could change
    // after submitting (P2-29, creating a poll's iteration 17).
    {
      label: t("pollFormReviewDescription"),
      value:
        form.description === "" ? (
          <span className="text-muted-foreground">{t("pollFormReviewNoDescription")}</span>
        ) : (
          <span className="whitespace-pre-line">{form.description}</span>
        ),
      field: fieldId.description,
    },
    {
      label: t("pollFormReviewQuestions"),
      value: (
        <>
          {t("pollFormReviewQuestionCount", { count: form.questions.length })}
          {form.questions.length === 0 ? null : (
            // Numbered as the form's "Question 1" and "Question 2" are; the
            // reset's bare list read as a stray indent (iteration 15).
            // A question emptied since the save reads as one, as the title
            // does, where it left a bare number (iteration 18).
            <ol className="m-0 mt-1 grid list-decimal gap-1 ps-5">
              {form.questions.map((q) => (
                <li key={q.key}>
                  {q.question === "" ? (
                    <span className="text-muted-foreground">{t("pollFormReviewNoQuestion")}</span>
                  ) : (
                    q.question
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      ),
      field: first === undefined ? fieldId.addQuestion : fieldId.question(first.key),
    },
    {
      label: t("pollFormReviewWho"),
      value: wholeWords(form.tiers.map((tier) => whoName(t, tier, phoneVerification)).join(", ")),
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
    // The definition pins its trustee panel (`panel_id`), and the form
    // offers only the launch panel, so who holds the key is recorded for
    // good with the rest. Said before submitting, as every page of the poll
    // says it after ([[0027-trustee-panels-and-live-results]], Part 3, rule
    // 1; T-14), from the create mockup's "Who holds the key now" (P2-19).
    // Nothing on the page changes it, so the row has no "Change".
    {
      label: t("pollFormReviewKey"),
      value: (
        <span className="grid justify-items-start gap-1">
          <span>{t("pollFormReviewKeyValue")}</span>
          <a
            href="/trustees"
            className="inline-flex min-h-12 items-center underline underline-offset-4"
          >
            {t("pollFormReviewKeyLink")}
          </a>
        </span>
      ),
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
        <ReviewList t={t} rows={permanent} locked={locked} onJump={onJump} />
      </div>
      <div className="grid gap-3">
        <h4 className="m-0 text-base font-semibold">{t("pollFormReviewListing")}</h4>
        <p className="m-0 max-w-prose text-sm text-muted-foreground">
          {t("pollFormReviewListingLede")}
        </p>
        <ReviewList t={t} rows={listing} locked={locked} onJump={onJump} />
      </div>
      {/* What moderation can and can't do to the poll once it's submitted,
          from the create mockup's last step (P2-19): said before submitting,
          so its limits are known before anything is recorded for good
          (docs/moderation-policy.md; T-68). */}
      <div className="grid gap-3">
        <h4 className="m-0 text-base font-semibold">{t("pollFormReviewModeration")}</h4>
        <p className="m-0 max-w-prose text-sm text-muted-foreground">
          {t("pollFormReviewModerationLede")}
        </p>
        <p className="m-0 text-sm">
          <a href="/moderation" className="underline underline-offset-4">
            {t("moderationLogLink")}
          </a>
        </p>
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
  /** For a new poll, one of the author's own whose words it starts with: one that didn't open and can't be tried again. */
  readonly from?: string | undefined;
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
  from,
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
  // Whether a new poll's words came from `from`, which the lede then says.
  const [copied, setCopied] = useState(false);
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
    setCopied(false);
    if (id === undefined && from !== undefined && ID.test(from)) {
      // The poll's words, not its closing time: chosen for a poll that never
      // opened, it has often passed, and a new poll's close is chosen anew.
      setForm(undefined);
      setBusy(true);
      let live = true;
      client
        .read(from)
        .then(({ draft }) => {
          if (!live) return;
          setForm({ ...formOf(draft, zone), closesDate: "", closesTime: "" });
          setCopied(true);
        })
        // The link promised a new poll, and an empty one still is: nothing
        // was saved, so there is nothing to lose by starting from nothing.
        .catch(() => live && setForm(newPollForm(zone)))
        .finally(() => live && setBusy(false));
      return () => {
        live = false;
      };
    }
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
  }, [client, id, from, timeZone]);

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
      lede={t(isNew && copied ? "pollFormCopiedLede" : "pollFormLede")}
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
  const length = closesAt === undefined ? undefined : openLength(closesAt, seconds());
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
              {/* Apart, so problems that wrap don't read as one paragraph (P2-29,
                  creating a poll's iteration 6), and by padding rather than a
                  minimum height, which left a problem of two lines no room
                  inside its target: wrapped ones sat 16px apart where one-line
                  ones sat 40px apart (iteration 10). */}
              <ul className="m-0 grid list-none p-0">
                {errors.map((e) => (
                  <li key={`${e.id}-${e.problem}`}>
                    <a
                      href={`#${e.id}`}
                      onClick={(event) => jump(event, e.id)}
                      className="inline-flex py-3 text-destructive underline underline-offset-4"
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
              {/* Side by side, the place's hint runs to three lines and the
                  topic's to one, so each field sits at its column's foot and
                  the two line up (P2-29, creating a poll's iteration 13). */}
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
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
                    className={cn(FIELD, "mt-auto")}
                    {...described(errors, fieldId.place, `${fieldId.place}-help`)}
                    value={form.place}
                    onChange={(e) => change({ ...form, place: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor={fieldId.topic} className="text-base font-semibold">
                    {t("pollFormTopicLabel")}
                    <Optional t={t} />
                  </Label>
                  <p id={`${fieldId.topic}-help`} className="m-0 text-sm text-muted-foreground">
                    {t("pollFormTopicHelp")}
                  </p>
                  <NativeSelect
                    id={fieldId.topic}
                    className="mt-auto w-full"
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
                    // The form edits only drafts, which the profile lists once they open.
                    unopened
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

          <Section title={t("pollFormQuestionsTitle")} id="poll-form-questions">
            {/* What a question holds follows the heading in the section's own
                column, as in Who can answer and Ready to ask: beside the heading
                from 768px, its four lines made the heading's row 104px tall
                over an empty band (P2-29, creating a poll's iteration 10). */}
            <div className="grid gap-6">
              <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
                {t("pollFormQuestionsLede")}
              </p>
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

          <Section title={t("pollFormWhoTitle")} id="poll-form-who">
            {/* The answer to the heading first, then what counts once: as the
                heading's lede, the six lines of the latter came before the
                answer and, beside the heading from 768px, left it under an
                empty band (P2-29, creating a poll's iteration 8). */}
            <div className="grid gap-3">
              {/* Rules only between tiers: around the one tier there is today
                  they drew an empty row above the next section's rule
                  (iteration 7). */}
              <ul className="m-0 grid list-none divide-y divide-border p-0">
                {form.tiers.map((tier) => (
                  <li key={tier} className="py-3 text-base font-semibold first:pt-0 last:pb-0">
                    {wholeWords(whoName(t, tier, phoneVerification))}
                  </li>
                ))}
              </ul>
              <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
                {t(phoneVerification ? "pollFormWhoLede_phone" : "pollFormWhoLede_email")}
              </p>
            </div>
          </Section>

          <Section title={t("pollFormWhenTitle")} id="poll-form-when">
            {/* Whose clock the time is on comes under the heading, before the
                fields it explains (iteration 10). */}
            <div className="grid gap-4">
              <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
                {t("pollFormWhenLede", { zone: zoneName(locale, form.timeZone, now()) })}
              </p>
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
              {/* How long it stays open, from the mockup's step 5: a closing
                  time alone left the author to work out the length, and
                  setup's half hour comes out of it (P2-19 part 53). */}
              {length === undefined ? null : (
                <p className="m-0 text-sm text-muted-foreground" suppressHydrationWarning>
                  {t("pollFormOpenFor", { length: lengthText(t, length) })}
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
          <Section title={t("pollFormSubmitTitle")} id="poll-form-submit">
            {/* What submitting does follows the heading in the section's own
                column: beside the heading from 768px, it and the Cloudflare
                note made the heading's row 224px tall over an empty band
                (P2-29, creating a poll's iteration 9). */}
            <div className="grid gap-8">
              <p className="m-0 max-w-prose text-base text-pretty text-muted-foreground">
                {t("pollFormSubmitLede")}
              </p>
              {/* Only a saved draft can be submitted, so before the first save
                  there is nothing to check through and no button that could
                  only refuse. */}
              {isNew ? (
                <p className="m-0 max-w-prose text-base font-semibold">
                  {t("pollFormSubmitAfterSave")}
                </p>
              ) : (
                <div className="grid gap-4">
                  <PollReview
                    t={t}
                    form={form}
                    phoneVerification={phoneVerification}
                    locked={submitting === "sending" || submitting === "sent"}
                    onJump={jump}
                  />
                  {/* The note on Cloudflare's check sits by the button that
                      starts it, where it was read a whole review earlier
                      (T-11, iteration 9). */}
                  <p className="m-0 max-w-prose text-sm text-muted-foreground">
                    {t("pollFormSubmitCloudflare")}
                  </p>
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
            </div>
          </Section>
        </div>
      </form>
    </div>
  );
}
