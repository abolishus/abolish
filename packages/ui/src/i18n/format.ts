/**
 * Message formatting for every user-facing string (AGENTS.md, Code rules:
 * "every user-facing string goes through i18n"; brief: "WCAG 2.2 AA and i18n
 * from the first UI component").
 *
 * Deliberately small and built on the platform's `Intl`: anything
 * `apps/ballot` imports may carry no third-party runtime code beyond the
 * framework (AGENTS.md, Dependencies; T-43).
 *
 * A message is a string with `{name}` placeholders, or a plural: an object
 * keyed by `Intl.PluralRules` category (`other` required) chosen by the
 * numeric `count` parameter. Numbers are formatted for the locale.
 * Substitution is a single pass, so a parameter's value is never read as a
 * placeholder, and React renders the result as text, never as markup.
 */

export type PluralCategory = Intl.LDMLPluralRule;

export type Plural = { readonly other: string } & {
  readonly [C in Exclude<PluralCategory, "other">]?: string;
};

export type Message = string | Plural;

export type Catalog = Readonly<Record<string, Message>>;

export type Params = Readonly<Record<string, string | number | bigint>>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

export class MessageFormatError extends Error {
  override name = "MessageFormatError";
}

/** The placeholder names a template uses, in order of first use. */
export function placeholders(template: string): string[] {
  return [...new Set(Array.from(template.matchAll(PLACEHOLDER), (m) => m[1] ?? ""))];
}

/** Every template a message holds: one for a string, one per category for a plural. */
export function templates(message: Message): string[] {
  return typeof message === "string" ? [message] : Object.values(message);
}

export function formatMessage(locale: string, message: Message, params: Params = {}): string {
  const template = typeof message === "string" ? message : selectPlural(locale, message, params);
  const numbers = new Intl.NumberFormat(locale);
  return template.replace(PLACEHOLDER, (_, name: string) => {
    // A missing parameter is a programming error: fail loudly rather than
    // show a voter a raw `{name}` or an empty gap.
    if (!Object.hasOwn(params, name)) {
      throw new MessageFormatError(`missing parameter "${name}"`);
    }
    const value = params[name];
    return typeof value === "string" ? value : numbers.format(value as number | bigint);
  });
}

function selectPlural(locale: string, message: Plural, params: Params): string {
  const count = params["count"];
  if (typeof count !== "number" && typeof count !== "bigint") {
    throw new MessageFormatError('a plural message needs a numeric "count" parameter');
  }
  // `Intl.PluralRules.select` takes a number, so above
  // Number.MAX_SAFE_INTEGER the category is approximate (CLDR's `many` in
  // fr, es, it and pt tests `i % 1000000 = 0`). No count gets near that.
  const category = new Intl.PluralRules(locale).select(Number(count));
  return message[category] ?? message.other;
}
