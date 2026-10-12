import { useI18n } from "../i18n/context.tsx";

export interface CountProps {
  value: number | bigint;
}

/**
 * A count, grouped for the reader's locale, in tabular figures so columns of
 * counts line up (brief: "Tabular figures for every count"). The `<data>`
 * element carries the exact machine value next to the formatted one.
 */
export function Count({ value }: CountProps) {
  const { locale } = useI18n();
  if ((typeof value === "number" && !Number.isSafeInteger(value)) || value < 0) {
    throw new RangeError("Count takes a non-negative safe integer or bigint");
  }
  return (
    <data value={value.toString()} className="tabular-nums">
      {new Intl.NumberFormat(locale).format(value)}
    </data>
  );
}
