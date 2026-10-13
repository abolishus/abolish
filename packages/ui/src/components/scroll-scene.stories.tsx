import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, waitFor, within } from "storybook/test";

import { ScrollScene } from "./scroll-scene.tsx";
import { TallyBars } from "./tally-bars.tsx";

const steps = [
  { at: "09:00 UTC", yes: 812, no: 640 },
  { at: "13:00 UTC", yes: 9204, no: 7311 },
  { at: "20:00 UTC, closed", yes: 23425, no: 16687 },
];

const meta = {
  component: ScrollScene,
  parameters: { layout: "fullscreen" },
  args: {
    label: "How the count grew",
    steps: steps.map((s) => (
      <p key={s.at} className="m-0">
        By {s.at}, {(s.yes + s.no).toLocaleString("en-US")} document-verified voters had cast a
        ballot.
      </p>
    )),
    graphic: (step, progress) => {
      const s = steps[step] ?? steps[0]!;
      return (
        <div data-testid="graphic" data-step={step} data-progress={progress.toFixed(2)}>
          <TallyBars
            caption={`As of ${s.at}`}
            total={s.yes + s.no}
            highlight="yes"
            rows={[
              { key: "yes", label: "Yes", count: s.yes },
              { key: "no", label: "No", count: s.no },
            ]}
          />
        </div>
      );
    },
  },
} satisfies Meta<typeof ScrollScene>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const scene = canvas.getByRole("region", { name: "How the count grew" });
    await expect(canvas.getByTestId("graphic")).toHaveAttribute("data-step", "0");
    // Scrolling the last step to the middle of the viewport redraws the graphic.
    const last = within(scene).getAllByRole("listitem").at(-1)!;
    last.scrollIntoView({ block: "center" });
    await waitFor(() => expect(canvas.getByTestId("graphic")).toHaveAttribute("data-step", "2"));
    await expect(canvas.getByRole("figure", { name: "As of 20:00 UTC, closed" })).toBeVisible();
    await expect(last).toHaveAttribute("data-active");
  },
};

export const Dark: Story = {
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getAllByRole("listitem").length).toBeGreaterThan(0);
  },
};
