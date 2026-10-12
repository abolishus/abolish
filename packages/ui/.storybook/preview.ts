import type { Preview } from "@storybook/react-vite";

const preview: Preview = {
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
