// Draft model, sample drafts and checks for the everyday Create a poll mockup (Storybook only).

import { RIVERSIDE, type EverydayQuestion } from "./everyday-fixtures.ts";

export type AnswerRule = "one" | "any" | "upTo" | "exactly";
export type Audience = "account" | "vouched" | "verified";
export type Cadence = "daily" | "twice" | "hourly";

export interface DraftOption {
  id: string;
  label: string;
}

export interface DraftQuestion {
  id: string;
  text: string;
  hint: string;
  rule: AnswerRule;
  /** The N in "pick up to N" and "pick exactly N". */
  n: number;
  options: DraftOption[];
}

export interface Trustee {
  id: string;
  name: string;
  contact: string;
  connect: "key" | "invite";
  key: string;
}

export interface When {
  /** yyyy-mm-dd, UTC. */
  date: string;
  /** hh:mm, UTC. */
  time: string;
}

export interface Draft {
  title: string;
  place: string;
  topic: string;
  questions: DraftQuestion[];
  audience: Audience;
  results: "live" | "sealed";
  cadence: Cadence;
  /** hh:mm UTC of the daily release. */
  releaseAt: string;
  trustees: Trustee[];
  /** How many of the author's trustees must take part. */
  threshold: number;
  understood: boolean;
  opens: When;
  closes: When;
}

export const STEPS = [
  { key: "ask", label: "Ask" },
  { key: "who", label: "Who can answer" },
  { key: "results", label: "Results" },
  { key: "key", label: "Who holds the key" },
  { key: "schedule", label: "Schedule" },
  { key: "review", label: "Review" },
] as const;

export type StepKey = (typeof STEPS)[number]["key"];

export const ASKED_BY = RIVERSIDE.askedBy;
/** The minimum number of new answers before a live update (set by Abolish, not the author). */
export const BATCH_FLOOR = RIVERSIDE.batchFloor;
/** The definition fingerprint the mock draft would have. */
export const DEFINITION_HASH = RIVERSIDE.id;
/** The standing panel during launch: Abolish alone. */
export const STANDING_PANEL_LINE =
  "During launch, Abolish alone holds the key for everyday polls. We could read individual answers (not who gave them), we promise not to, and we destroy the key after the final count. To protect your poll from us too, add your own trustees.";

export const MAX_QUESTIONS = 10;
export const MAX_OPTIONS = 12;

export const RULES: readonly { key: AnswerRule | "ranked"; label: string; later?: boolean }[] = [
  { key: "one", label: "Pick one" },
  { key: "any", label: "Pick any" },
  { key: "upTo", label: "Pick up to…" },
  { key: "exactly", label: "Pick exactly…" },
  { key: "ranked", label: "Rank them", later: true },
];

export const AUDIENCES: readonly {
  key: Audience;
  name: string;
  body: string;
  /** Which groups' results the poll will show, in words. */
  groups: readonly Audience[];
}[] = [
  {
    key: "account",
    name: "Anyone with an account",
    body: "The quickest way in. One person can make more than one account, so their answers are shown on their own.",
    groups: ["account", "vouched", "verified"],
  },
  {
    key: "vouched",
    name: "People vouched for by others",
    body: "Someone already trusted has vouched that they're a real person. People who verified a passport or licence can answer too.",
    groups: ["vouched", "verified"],
  },
  {
    key: "verified",
    name: "People who verified a passport or licence",
    body: "One answer per real person, checked on their own phone without showing anyone who they are.",
    groups: ["verified"],
  },
];

export const GROUP_NAMES: Record<Audience, string> = {
  account: "People with an account",
  vouched: "People vouched for by others",
  verified: "People who verified a passport or licence",
};

export const CADENCES: readonly { key: Cadence; label: string }[] = [
  { key: "daily", label: "Once a day" },
  { key: "twice", label: "Twice a day" },
  { key: "hourly", label: "Every hour" },
];

export function ruleText(q: Pick<DraftQuestion, "rule" | "n">): string {
  switch (q.rule) {
    case "one":
      return "Pick one";
    case "any":
      return "Pick any that apply";
    case "upTo":
      return `Pick up to ${q.n}`;
    case "exactly":
      return `Pick exactly ${q.n}`;
  }
}

export function scheduleText(d: Pick<Draft, "cadence" | "releaseAt">): string {
  switch (d.cadence) {
    case "daily":
      return `daily at ${d.releaseAt} UTC`;
    case "twice":
      return "twice a day, at 00:00 and 12:00 UTC";
    case "hourly":
      return "every hour, on the hour";
  }
}

function fromFixture(q: EverydayQuestion): DraftQuestion {
  const rule = q.rule;
  return {
    id: q.key,
    text: q.text,
    hint: q.hint ?? "",
    rule: rule.kind,
    n: rule.kind === "upTo" ? rule.max : rule.kind === "exactly" ? rule.count : 2,
    options: q.options.map((o) => ({ id: o.key, label: o.label })),
  };
}

export const RIVERSIDE_DRAFT: Draft = {
  title: RIVERSIDE.title,
  place: RIVERSIDE.place,
  topic: RIVERSIDE.topic,
  questions: RIVERSIDE.questions.map(fromFixture),
  audience: "account",
  results: "live",
  cadence: "daily",
  releaseAt: "12:00",
  trustees: [],
  threshold: 1,
  understood: false,
  opens: { date: "2026-11-01", time: "12:00" },
  closes: { date: "2026-11-15", time: "12:00" },
};

export const LIBRARY_TRUSTEE: Trustee = {
  id: "library",
  name: "Riverside Library Friends",
  contact: "trustee@riversidelibraryfriends.org",
  connect: "key",
  key: "npk1q8w3x2m7d9f4h6k0p5r8t2v4y7z3c6e9g1j5n8s0u2",
};

export const WITH_TRUSTEE: Draft = {
  ...RIVERSIDE_DRAFT,
  trustees: [LIBRARY_TRUSTEE],
  threshold: 1,
};

/** Three problems at once: one option, "up to 3" with two options, and an empty question. */
export const BROKEN_DRAFT: Draft = {
  ...RIVERSIDE_DRAFT,
  questions: [
    {
      id: "priority",
      text: "Which one improvement matters most to you?",
      hint: "",
      rule: "one",
      n: 2,
      options: [{ id: "lights", label: "Better lighting on the river path" }],
    },
    {
      id: "events",
      text: "Which events would you go to?",
      hint: "",
      rule: "upTo",
      n: 3,
      options: [
        { id: "market", label: "A Saturday farmers' market" },
        { id: "cinema", label: "Outdoor cinema in summer" },
      ],
    },
    {
      id: "blank",
      text: "",
      hint: "",
      rule: "one",
      n: 2,
      options: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "No" },
      ],
    },
  ],
};

export function parseUtc(w: When): Date | undefined {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w.date);
  const t = /^(\d{2}):(\d{2})$/.exec(w.time);
  if (!d || !t) return undefined;
  const date = new Date(
    Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2])),
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Field id to message, in page order: the error summary lists them in this order. */
export type Errors = [string, string][];

export const fieldId = {
  title: "poll-title",
  question: (q: string) => `q-${q}-text`,
  options: (q: string) => `q-${q}-options`,
  option: (q: string, o: string) => `q-${q}-opt-${o}`,
  addOption: (q: string) => `q-${q}-add`,
  n: (q: string) => `q-${q}-n`,
  trustee: (t: string, field: "name" | "contact" | "key") => `t-${t}-${field}`,
  understood: "trustees-understood",
  opens: "opens-date",
  closes: "closes-date",
} as const;

export function validate(step: StepKey, d: Draft): Errors {
  const e: Errors = [];
  if (step === "ask") {
    if (d.title.trim() === "") e.push([fieldId.title, "Give your poll a title."]);
    d.questions.forEach((q, i) => {
      const n = i + 1;
      if (q.text.trim() === "") e.push([fieldId.question(q.id), `Write question ${n}.`]);
      const labels = q.options.map((o) => o.label.trim());
      q.options.forEach((o, j) => {
        const label = labels[j] ?? "";
        if (label === "" && q.options.length > 1) {
          e.push([
            fieldId.option(q.id, o.id),
            `Write option ${j + 1} of question ${n}, or remove it.`,
          ]);
        } else if (label !== "" && labels.indexOf(label) < j) {
          e.push([
            fieldId.option(q.id, o.id),
            `Option ${j + 1} of question ${n} is the same as option ${labels.indexOf(label) + 1}.`,
          ]);
        }
      });
      const count = q.options.length;
      if (count < 2) {
        e.push([fieldId.addOption(q.id), `Question ${n} needs at least two options to pick from.`]);
      } else if (q.rule === "upTo" && q.n > count) {
        e.push([
          fieldId.n(q.id),
          `Question ${n} lets people pick up to ${q.n}, but has only ${count} options. Add an option or lower the number.`,
        ]);
      } else if (q.rule === "exactly" && q.n >= count) {
        e.push([
          fieldId.n(q.id),
          `Question ${n} asks people to pick exactly ${q.n} of ${count} options, which leaves no choice. Add an option or lower the number.`,
        ]);
      }
    });
  }
  if (step === "key" && d.trustees.length > 0) {
    d.trustees.forEach((t, i) => {
      if (t.name.trim() === "")
        e.push([fieldId.trustee(t.id, "name"), `Enter trustee ${i + 1}’s name.`]);
      if (t.contact.trim() === "")
        e.push([fieldId.trustee(t.id, "contact"), `Enter how to reach trustee ${i + 1}.`]);
      if (t.connect === "key" && t.key.trim() === "")
        e.push([
          fieldId.trustee(t.id, "key"),
          `Paste trustee ${i + 1}’s node key, or send them an invite link instead.`,
        ]);
    });
    if (!d.understood)
      e.push([
        fieldId.understood,
        "Confirm you understand what happens if your trustees go offline.",
      ]);
  }
  if (step === "schedule") {
    const opens = parseUtc(d.opens);
    const closes = parseUtc(d.closes);
    if (opens === undefined) e.push([fieldId.opens, "Enter the date and time the poll opens."]);
    if (closes === undefined) e.push([fieldId.closes, "Enter the date and time the poll closes."]);
    if (
      opens !== undefined &&
      closes !== undefined &&
      closes.getTime() - opens.getTime() < 3_600_000
    )
      e.push([fieldId.closes, "The poll must close at least an hour after it opens."]);
  }
  return e;
}
