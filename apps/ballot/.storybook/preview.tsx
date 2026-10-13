import { I18nProvider } from "@abolishus/ui";
import type { Decorator, Preview } from "@storybook/react-vite";

import "../src/styles.css";

// As in @abolishus/ui: every story renders inside a provider and on the
// theme's ground, so axe's colour-contrast rule judges the real pairing.
// `parameters.theme` picks the dark palette.
const withProviders: Decorator = (Story, { parameters }) => {
  const theme = parameters["theme"] === "dark" ? "dark" : "light";
  // On the root too, so popups portalled to <body> share the story's theme.
  document.documentElement.dataset["theme"] = theme;
  return (
    <I18nProvider locale="en-US">
      <div data-theme={theme} lang="en-US" className="bg-background font-sans text-foreground">
        <Story />
      </div>
    </I18nProvider>
  );
};

const preview: Preview = {
  decorators: [withProviders],
  parameters: {
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
