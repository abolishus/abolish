import { useTranslate } from "@abolishus/ui";

import { catalogs } from "./messages.ts";

export function App() {
  const t = useTranslate(catalogs);
  return (
    <main className="mx-auto max-w-prose px-4 py-12 font-sans text-ink">
      <h1 className="font-serif text-3xl font-semibold">{t("title")}</h1>
      <p className="mt-6 text-lg">{t("lede")}</p>
      <p className="mt-4 text-pencil">{t("local")}</p>
    </main>
  );
}

/** Shown instead of the client on an origin it must not run from (`origin.ts`). */
export function SharedOrigin() {
  const t = useTranslate(catalogs);
  return (
    <main className="mx-auto max-w-prose px-4 py-12 font-sans text-ink">
      <h1 className="font-serif text-3xl font-semibold">{t("sharedOriginTitle")}</h1>
      <p className="mt-6 text-lg">{t("sharedOrigin")}</p>
    </main>
  );
}
