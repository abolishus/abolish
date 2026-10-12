import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { TierSwitcher } from "./tier-switcher.tsx";

const tiers = [
  { value: "tier-2", label: "Document-verified", scope: "40,112 voters" },
  { value: "tier-1", label: "Vouched", scope: "8,301 voters" },
  { value: "tier-0", label: "Unverified accounts", scope: "112,950 voters" },
];

const meta = {
  component: TierSwitcher,
  args: {
    label: "Verification tier",
    tiers,
    onValueChange: fn(),
    children: (tier) => <p>Results among {tier.scope}</p>,
  },
} satisfies Meta<typeof TierSwitcher>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("tablist", { name: "Verification tier" });
    const tabs = within(list).getAllByRole("tab");
    // One tab per tier, each naming its scope; no blended "all tiers" tab.
    await expect(tabs.map((t) => t.textContent)).toEqual([
      "Document-verified40,112 voters",
      "Vouched8,301 voters",
      "Unverified accounts112,950 voters",
    ]);
    await expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Results among 40,112 voters");
    for (const tab of tabs) {
      await expect(tab.getBoundingClientRect().height).toBeGreaterThanOrEqual(48);
    }
  },
};

export const Switching: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: /Vouched/ }));
    await expect(args.onValueChange).toHaveBeenCalledWith("tier-1");
    await expect(canvas.getByRole("tabpanel")).toHaveTextContent("Results among 8,301 voters");
  },
};

export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole("tab", { name: /Document-verified/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: /Vouched/ })).toHaveFocus();
  },
};

export const StartsOnAnotherTier: Story = {
  args: { defaultValue: "tier-0" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("tabpanel")).toHaveTextContent(
      "Results among 112,950 voters",
    );
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("tablist")).toBeVisible();
  },
};
