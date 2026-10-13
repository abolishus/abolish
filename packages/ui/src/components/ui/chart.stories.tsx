import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bar, BarChart, XAxis } from "recharts";
import { expect, waitFor, within } from "storybook/test";

import { ChartContainer, ChartLegend, ChartLegendContent, type ChartConfig } from "./chart.tsx";

const results = [
  { tier: "Tier 1", yes: 21480, no: 18632 },
  { tier: "Tier 2", yes: 9120, no: 7344 },
  { tier: "Tier 3", yes: 2210, no: 1980 },
];

const config = {
  yes: { label: "Yes", color: "var(--primary)" },
  no: { label: "No", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

const meta = {
  component: ChartContainer,
  args: { config, children: <></> },
  render: (args) => (
    <ChartContainer
      config={args.config}
      role="figure"
      aria-label="Library levy results by tier"
      className="w-96"
    >
      <BarChart data={results} accessibilityLayer={false}>
        <XAxis dataKey="tier" tickLine={false} axisLine={false} />
        <Bar dataKey="yes" fill="var(--color-yes)" isAnimationActive={false} />
        <Bar dataKey="no" fill="var(--color-no)" isAnimationActive={false} />
        <ChartLegend content={<ChartLegendContent />} />
      </BarChart>
    </ChartContainer>
  ),
} satisfies Meta<typeof ChartContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const chart = within(canvasElement).getByRole("figure", {
      name: "Library levy results by tier",
    });
    await waitFor(() => expect(chart.querySelectorAll(".recharts-bar-rectangle")).toHaveLength(6));
    await expect(within(chart).getByText("Yes")).toBeVisible();
    await expect(within(chart).getByText("Tier 2")).toBeVisible();
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getByText("No")).toBeVisible());
  },
};
