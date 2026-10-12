import { useTranslate } from "@abolishus/ui";
import { createFileRoute } from "@tanstack/react-router";

import { LookupForm } from "../components/lookup-form.tsx";
import { catalogs } from "../messages.ts";

function Home() {
  const t = useTranslate(catalogs);
  return (
    <div className="grid gap-8">
      <section className="grid max-w-prose gap-4">
        <h1 className="text-4xl font-semibold">{t("homeTitle")}</h1>
        <p className="text-lg">{t("homeLede")}</p>
      </section>
      <LookupForm />
    </div>
  );
}

export const Route = createFileRoute("/")({ component: Home });
