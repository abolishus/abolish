// The ballot client's own strings. Every locale's catalog has `en-US`'s type,
// so a missing key fails type-checking (@abolishus/ui, i18n).

const enUS = {
  title: "Abolish ballot",
  lede: "To vote, open the ballot link for your election.",
  local:
    "This page loads nothing from any other site, and your choices leave this device only encrypted.",
} as const;

export type Messages = Record<keyof typeof enUS, string>;

export const catalogs: Readonly<Record<string, Messages>> = { "en-US": enUS };
