import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { PollResultsPage } from "./poll-results-page.tsx";

const meta = {
  title: "Mockups/Web/Poll results",
  component: PollResultsPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PollResultsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

// Base UI keeps an outgoing tab panel mounted until its exit ends, so read
// the panel the selected tab controls.
function selectedPanel(root: HTMLElement): HTMLElement {
  const tab = within(root).getByRole("tab", { selected: true });
  const panel = root.ownerDocument.getElementById(tab.getAttribute("aria-controls") ?? "");
  if (panel === null) throw new Error("no panel for the selected tab");
  return panel;
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      /renew the 0\.2% library levy/,
    );
    const tabs = within(canvas.getByRole("tablist", { name: "Verification tier" })).getAllByRole(
      "tab",
    );
    // One tab per tier, and no blended one.
    await expect(tabs).toHaveLength(3);
    await expect(tabs.some((t) => /all/i.test(t.textContent ?? ""))).toBe(false);
    await expect(selectedPanel(canvasElement)).toHaveTextContent(
      "58.4%chose “Yes, renew the levy” among 40,112 document-verified voters.",
    );
    await expect(
      within(selectedPanel(canvasElement)).getByRole("figure", {
        name: "Among 40,112 document-verified voters",
      }),
    ).toBeVisible();

    // Switching tier swaps the tally and its scope.
    await userEvent.click(canvas.getByRole("tab", { name: /Passkey only/ }));
    await waitFor(() =>
      expect(selectedPanel(canvasElement)).toHaveTextContent(
        "56.0%chose “No, let it expire” among 112,950 passkey-only voters.",
      ),
    );

    // Scrolling the scene's last step to the middle redraws the chart at the close.
    const scene = canvas.getByRole("region", { name: "Turnout through the voting day" });
    const graphic = canvas.getByTestId("turnout-graphic");
    await expect(graphic).toHaveAttribute("data-through", "08:00");
    const steps = within(scene).getAllByRole("listitem");
    steps[1]?.scrollIntoView({ block: "center" });
    await waitFor(() =>
      expect(canvas.getByTestId("turnout-graphic")).toHaveAttribute("data-through", "12:00"),
    );
    steps.at(-1)?.scrollIntoView({ block: "center" });
    await waitFor(() =>
      expect(canvas.getByTestId("turnout-graphic")).toHaveAttribute("data-focus", "tier0"),
    );
    await expect(
      canvas.getByRole("img", { name: /as of 20:00 UTC, when voting closed/ }),
    ).toBeInTheDocument();
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const regions = canvas.getByRole("region", { name: "Where the ballots came from" });
    // Seven named regions and the below-floor remainder, each an equal tile.
    await expect(within(regions).getAllByRole("listitem")).toHaveLength(8);
    await expect(within(regions).getByText(/fewer than 500 ballots/)).toBeVisible();
    await expect(canvas.getByText("4 of 7")).toBeVisible();
  },
};

export const Decrypting: Story = {
  args: { stage: "decrypting" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Closed, decrypting")).toBeVisible();
    // Ballots per tier are public; what they say is not yet.
    await expect(selectedPanel(canvasElement)).toHaveTextContent("40,112");
    await expect(within(selectedPanel(canvasElement)).queryByText("58.4%")).toBeNull();
    await expect(within(selectedPanel(canvasElement)).getAllByText("Sealed")).toHaveLength(2);
    await expect(canvas.getByText("3 of 7")).toBeVisible();
  },
};

export const DecryptingDark: Story = {
  args: { stage: "decrypting" },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByText("Not yet")).toHaveLength(4);
  },
};
