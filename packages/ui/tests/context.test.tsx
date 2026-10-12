import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Count } from "../src/components/count.tsx";
import { I18nProvider, useTranslate } from "../src/i18n/context.tsx";

const en = { voters: { one: "{count} voter", other: "{count} voters" }, close: "Close" };
const catalogs: Record<string, typeof en> = {
  "en-US": en,
  "es-US": { voters: { one: "{count} votante", other: "{count} votantes" }, close: "Cerrar" },
};

function Voters({ count }: { count: number }) {
  const t = useTranslate(catalogs);
  return <p>{t("voters", { count })}</p>;
}

describe("I18nProvider", () => {
  it("translates with the provider's locale and catalog", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="es-US">
        <Voters count={2} />
      </I18nProvider>,
    );
    expect(html).toBe("<p>2 votantes</p>");
  });

  it("refuses to render outside a provider rather than guess a locale", () => {
    expect(() => renderToStaticMarkup(<Count value={1} />)).toThrow(/I18nProvider/);
  });

  it("refuses a locale with no catalog", () => {
    expect(() =>
      renderToStaticMarkup(
        <I18nProvider locale="fr-FR">
          <Voters count={1} />
        </I18nProvider>,
      ),
    ).toThrow(/fr-FR/);
  });

  it("escapes translated text as text, never markup", () => {
    const html = renderToStaticMarkup(
      <I18nProvider locale="en-US">
        <p>
          <Translated template="<b>{x}</b>" x="<i>" />
        </p>
      </I18nProvider>,
    );
    expect(html).toBe("<p>&lt;b&gt;&lt;i&gt;&lt;/b&gt;</p>");
  });
});

function Translated({ template, x }: { template: string; x: string }) {
  const t = useTranslate({ "en-US": { m: template } });
  return <>{t("m", { x })}</>;
}
