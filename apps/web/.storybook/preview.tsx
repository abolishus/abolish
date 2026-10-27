import { I18nProvider } from "@abolishus/ui";
import type { Decorator, Preview } from "@storybook/react-vite";

import { DEFAULT_LOCALE, isLocale } from "../src/locales.ts";
import { loadCatalog } from "../src/messages.ts";
import "../src/styles.css";

// As in @abolishus/ui: every story renders inside a provider and on the
// theme's ground, so axe's colour-contrast rule judges the real pairing.
// `parameters.theme` picks the dark palette, `parameters.locale` a language.
const withProviders: Decorator = (Story, { parameters }) => {
  const locale = isLocale(parameters["locale"]) ? parameters["locale"] : DEFAULT_LOCALE;
  const theme = parameters["theme"] === "dark" ? "dark" : "light";
  // On the root too, so popups portalled to <body> share the story's theme.
  document.documentElement.dataset["theme"] = theme;
  const padding = parameters["layout"] === "fullscreen" ? "" : "p-6";
  return (
    <I18nProvider locale={locale}>
      <div
        data-theme={theme}
        lang={locale}
        className={`bg-background font-sans text-foreground ${padding}`}
      >
        <Story />
      </div>
    </I18nProvider>
  );
};

const preview: Preview = {
  decorators: [withProviders],
  // A story in another language needs its catalog, as a page does.
  loaders: [
    async ({ parameters }) => {
      if (isLocale(parameters["locale"])) await loadCatalog(parameters["locale"]);
      return {};
    },
  ],
  // No page scrolls sideways, at any width the tests run (the phone project
  // runs at 360px): long hashes wrap or truncate, tables reflow.
  afterEach: ({ canvasElement }) => {
    const root = canvasElement.ownerDocument.documentElement;
    const overflow = root.scrollWidth - root.clientWidth;
    if (overflow > 1) throw new Error(`The page scrolls sideways by ${overflow}px`);
  },
  // The phone test project sets VITE_STORYBOOK_VIEWPORT to "phone".
  initialGlobals: {
    viewport: { value: import.meta.env["VITE_STORYBOOK_VIEWPORT"] || undefined, isRotated: false },
  },
  parameters: {
    viewport: {
      options: {
        phone: { name: "Small phone", styles: { width: "360px", height: "780px" }, type: "mobile" },
        // The narrowest screen in use, a folded Galaxy Z Fold; a
        // 360px phone zoomed to 125% is little wider (288px).
        folded: {
          name: "Folded phone",
          styles: { width: "280px", height: "653px" },
          type: "mobile",
        },
        desktop: { name: "Desktop", styles: { width: "1280px", height: "800px" }, type: "desktop" },
      },
    },
    // Fail the story's test on any axe violation (WCAG 2.2 AA, AGENTS.md "Testing").
    a11y: {
      test: "error",
      options: {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      },
    },
  },
};

export default preview;
