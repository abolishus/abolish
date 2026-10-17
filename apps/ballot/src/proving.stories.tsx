import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { Proving, type ProvingProblem, ProvingRefused } from "./proving.tsx";

// The proving screen and its refusals (proving.tsx), with the workers left
// out: each story is what one report or one refusal shows.

const meta = {
  title: "Ballot/Proving",
  component: Proving,
  parameters: { layout: "fullscreen" },
  args: { steps: { done: 4, of: 10 } },
} satisfies Meta<typeof Proving>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The screen's shared shape: its heading, the bar's state in words, nothing to press and nothing spinning. */
async function provingWith(canvasElement: HTMLElement, valueText: string) {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Proving you can answer",
  );
  const bar = canvas.getByRole("progressbar", { name: "Your proof" });
  await expect(bar).toHaveAttribute("aria-valuetext", valueText);
  await expect(canvas.getByText(valueText)).toBeVisible();
  await expect(canvas.getByText("Made on this device")).toBeVisible();
  await expect(canvas.queryByRole("button")).toBeNull();
  await expect(canvasElement.querySelector(".animate-spin")).toBeNull();
  return bar;
}

const midway: Story["play"] = async ({ canvasElement }) => {
  const bar = await provingWith(canvasElement, "4 of 10 steps");
  await expect(bar).toHaveAttribute("aria-valuenow", "4");
  await expect(bar).toHaveAttribute("aria-valuemax", "10");
  // Still: the bar jumps to each reported step rather than easing into it.
  const indicator = bar.querySelector<HTMLElement>("[data-slot=progress-indicator]");
  await expect(indicator).not.toBeNull();
  await expect(getComputedStyle(indicator as HTMLElement).transitionProperty).toBe("none");
};

export const Midway: Story = { name: "Four steps of ten", play: midway };

export const MidwayDark: Story = {
  name: "Four steps of ten, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: midway,
};

export const Starting: Story = {
  name: "Before the first step",
  args: { steps: undefined },
  play: async ({ canvasElement }) => {
    // No report yet, so no value: the bar claims no progress it hasn't seen.
    const bar = await provingWith(canvasElement, "Starting");
    await expect(bar).not.toHaveAttribute("aria-valuenow");
  },
};

export const Finished: Story = {
  name: "Every step done",
  args: { steps: { done: 10, of: 10 } },
  play: async ({ canvasElement }) => {
    const bar = await provingWith(canvasElement, "10 of 10 steps");
    await expect(bar).toHaveAttribute("aria-valuenow", "10");
  },
};

// The refusals, one story each, so every problem has its words.

type RefusedStory = StoryObj<Meta<typeof ProvingRefused>>;

/** A refusal for `problem`: its heading, the check named, nothing sent, and a retry exactly where one helps. */
function refused(problem: ProvingProblem, heading: string, retry: boolean): RefusedStory {
  return {
    name: `Refused: ${problem}`,
    render: (args) => <ProvingRefused {...args} />,
    args: { problem, onRetry: fn() },
    play: async ({ canvasElement, args }) => {
      const canvas = within(canvasElement);
      await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(heading);
      await expect(canvas.getByText(problem, { selector: "code" })).toBeVisible();
      await expect(canvas.getByText("Nothing was sent")).toBeVisible();
      await expect(canvas.queryByRole("progressbar")).toBeNull();
      const button = canvas.queryByRole("button", { name: "Try again" });
      if (!retry) {
        await expect(button).toBeNull();
        return;
      }
      await expect(button).not.toBeNull();
      await userEvent.click(button as HTMLElement);
      await expect(args.onRetry).toHaveBeenCalledOnce();
    },
  };
}

export const NotAMember = refused("not-a-member", "You aren't on this poll's list", false);
export const Secret = refused("secret", "Your voting identity on this device can't be used", false);
export const Root = refused("root", "The list of members doesn't match the poll", true);
export const Unavailable = refused(
  "unavailable",
  "The files for making proofs couldn't be fetched",
  true,
);
export const Zkey = refused("zkey", "The proving key isn't the published one", true);
export const Wasm = refused("wasm", "The proof's calculator isn't the published one", true);
export const Prover = refused("prover", "The part that makes proofs didn't answer properly", true);
export const WorkerFailed = refused(
  "worker-failed",
  "This device stopped while making the proof",
  true,
);
export const Wrong = refused("proof", "The proof didn't pass this device's check", false);
export const Fault = refused(
  "rerandomised",
  "This device made a fault while finishing the proof",
  false,
);

export const WrongDark: RefusedStory = {
  ...refused("proof", "The proof didn't pass this device's check", false),
  name: "Refused: proof, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
};
