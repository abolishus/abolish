import { I18nProvider } from "@abolishus/ui";
import type { Decorator, Preview } from "@storybook/react-vite";

import { isLocale } from "../src/locales.ts";
import "../src/styles.css";

// As in @abolishus/ui: every story renders inside a provider and on the
// theme's ground, so axe's colour-contrast rule judges the real pairing.
// `parameters.theme` picks the dark palette, `parameters.locale` the
// language (English unless a story names another of ours).
const withProviders: Decorator = (Story, { parameters }) => {
  const theme = parameters["theme"] === "dark" ? "dark" : "light";
  const locale = isLocale(parameters["locale"]) ? parameters["locale"] : "en-US";
  // On the root too, so popups portalled to <body> share the story's theme.
  document.documentElement.dataset["theme"] = theme;
  return (
    <I18nProvider locale={locale}>
      <div data-theme={theme} lang={locale} className="bg-background font-sans text-foreground">
        <Story />
      </div>
    </I18nProvider>
  );
};

const preview: Preview = {
  decorators: [withProviders],
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
