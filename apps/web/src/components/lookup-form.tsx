import { Button, useTranslate } from "@abolishus/ui";
import { useId } from "react";

import { catalogs } from "../messages.ts";

export interface LookupFormProps {
  /** What was entered last time, if it wasn't a poll ID. */
  invalid?: string | undefined;
}

/**
 * Opens a poll by its ID. A plain GET form to `/polls`, so it works before
 * the page's script loads, or without it.
 */
export function LookupForm({ invalid }: LookupFormProps) {
  const t = useTranslate(catalogs);
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  return (
    <form method="get" action="/polls" className="grid max-w-prose gap-2">
      <label htmlFor={inputId} className="font-semibold">
        {t("lookupLabel")}
      </label>
      <p id={hintId} className="m-0 text-sm text-muted-foreground">
        {t("lookupHint")}
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          id={inputId}
          name="id"
          required
          autoComplete="off"
          spellCheck={false}
          defaultValue={invalid}
          aria-describedby={invalid === undefined ? hintId : `${hintId} ${errorId}`}
          aria-invalid={invalid === undefined ? undefined : true}
          className="min-w-0 flex-1 min-h-12 rounded-md border border-input bg-background px-3 py-2 font-mono"
        />
        <Button type="submit">{t("lookupSubmit")}</Button>
      </div>
      {invalid !== undefined ? (
        <p id={errorId} role="alert" className="m-0 text-destructive">
          {t("lookupInvalid")}
        </p>
      ) : null}
    </form>
  );
}
