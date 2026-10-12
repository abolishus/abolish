import type { Decorator, Preview } from "@storybook/react-vite";

import { I18nProvider } from "../src/i18n/context.tsx";
import "../src/styles.css";

// Every story renders inside a provider and on the theme's ground, so axe's
// colour-contrast rule judges the real pairing. `parameters.locale` and
// `parameters.theme` pick another locale or the dark palette.
const withProviders: Decorator = (Story, { parameters }) => {
  const locale = typeof parameters["locale"] === "string" ? parameters["locale"] : "en-US";
  const theme = parameters["theme"] === "dark" ? "dark" : "light";
  return (
    <I18nProvider locale={locale}>
      <div data-theme={theme} lang={locale} className="bg-paper p-6 font-sans text-ink">
        <Story />
      </div>
    </I18nProvider>
  );
};

const preview: Preview = {
  decorators: [withProviders],
  parameters: {
    // Fail the story's test on any axe violation, not just report it
    // (WCAG 2.2 AA target, AGENTS.md "Testing").
    a11y: {
      test: "error",
      options: {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      },
    },
  },
};

export default preview;
