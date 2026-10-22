import { useTranslate } from "@abolishus/ui";

import { EverydayFrame, Note, Part, ScreenTitle } from "./frame.tsx";
import type { Link } from "./link.ts";
import { catalogs } from "./messages.ts";
import { BrokenLink, type ElectionSource, OpenElection } from "./open.tsx";

/**
 * The client on an origin of its own (main.tsx): the election the link
 * names, or what the client is when it names none. `origin` is the page's
 * own; `languages` the reader's preferred ones, most preferred first.
 */
export function App({
  link,
  source,
  origin,
  languages,
}: {
  link: Link;
  source: ElectionSource;
  origin: string;
  languages: readonly string[];
}) {
  switch (link.kind) {
    case "none":
      return <Home />;
    case "malformed":
      return <BrokenLink />;
    case "election":
      return (
        <OpenElection
          // Another election starts from nothing: no state of this one carries over.
          key={link.hex}
          electionId={link.electionId}
          pick={link.pick}
          source={source}
          origin={origin}
          languages={languages}
        />
      );
  }
}

/** What this client is, before any poll is open: in the everyday register, the default. */
export function Home() {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame>
      <ScreenTitle title={t("title")}>
        <p className="m-0">{t("lede")}</p>
      </ScreenTitle>
      <div className="mt-8">
        <Note title={t("localTitle")}>
          <p className="m-0">{t("local")}</p>
        </Note>
      </div>
    </EverydayFrame>
  );
}

/**
 * Shown instead of the client on an origin it must not run from
 * (`origin.ts`; T-43): no ballot and no way forward but another address.
 * `address` is the page's own origin and path, shown so the voter can see
 * which address was refused; it never leaves the device.
 */
export function SharedOrigin({ address }: { address: string }) {
  const t = useTranslate(catalogs);
  return (
    <EverydayFrame>
      <ScreenTitle title={t("sharedOriginTitle")}>
        <p className="m-0">{t("sharedOrigin")}</p>
      </ScreenTitle>
      <div className="mt-6 grid gap-2">
        <p className="m-0 text-sm text-muted-foreground">{t("sharedOriginAddress")}</p>
        <p translate="no" className="m-0 font-mono text-sm break-all">
          {address}
        </p>
      </div>
      <Part title={t("nothingSentTitle")}>
        <p className="m-0">{t("nothingSent")}</p>
      </Part>
      <Part title={t("otherAddressTitle")}>
        <p className="m-0">{t("otherAddress")}</p>
      </Part>
    </EverydayFrame>
  );
}
