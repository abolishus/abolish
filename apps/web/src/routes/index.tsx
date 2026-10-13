import { buttonVariants, useTranslate } from "@abolishus/ui";
import { createFileRoute } from "@tanstack/react-router";

import { LookupForm } from "../components/lookup-form.tsx";
import { PollList } from "../components/poll-list.tsx";
import { TrustScene } from "../components/trust-scene.tsx";
import { fetchFirstPolls } from "../data.ts";
import { catalogs } from "../messages.ts";

function Home() {
  const t = useTranslate(catalogs);
  const list = Route.useLoaderData();
  return (
    <div className="grid gap-16">
      <section className="grid gap-12 pt-2 md:pt-10 lg:grid-cols-12 lg:gap-x-10">
        <div className="grid content-start gap-8 lg:col-span-7">
          <h1 className="m-0 font-heading text-5xl leading-none font-semibold tracking-tight text-balance sm:text-7xl">
            {t("homeTitle")}
          </h1>
          <p className="m-0 max-w-prose text-xl text-pretty">{t("homeLede")}</p>
          <div className="flex flex-wrap gap-3">
            <a href="/polls" className={buttonVariants({ size: "lg" })}>
              {t("homeBrowse")}
            </a>
          </div>
          <p className="m-0 text-base text-muted-foreground">{t("homeNonBinding")}</p>
        </div>
        <section
          aria-labelledby="lookup-title"
          className="grid content-start gap-5 border border-border p-5 sm:p-7 lg:col-span-5"
        >
          <h2 id="lookup-title" className="m-0 font-heading text-2xl font-semibold">
            {t("homeLookupTitle")}
          </h2>
          <LookupForm />
        </section>
      </section>
      {list === undefined ? (
        <p className="m-0 border-t border-border pt-16 text-lg">{t("homeListUnavailable")}</p>
      ) : (
        <div className="border-t border-border pt-16">
          <PollList list={list} />
        </div>
      )}
      <TrustScene />
    </div>
  );
}

/** Polls the home page shows from the start of the list. */
const HOME_LIST = 6;

export const Route = createFileRoute("/")({
  // The front page and its lookup form stay up when the API doesn't answer:
  // only the list is left out, and the error says nothing (T-67).
  loader: () => fetchFirstPolls({ data: HOME_LIST }).catch(() => undefined),
  component: Home,
});
