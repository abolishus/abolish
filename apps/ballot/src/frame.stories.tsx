import { Button } from "@abolishus/ui";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { ACTION, Frame, type FramePoll, Note, Part, ScreenTitle } from "./frame.tsx";

const POLL: FramePoll = {
  definitionHash: "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
  name: "Riverside Residents' Association",
  closes: "Fri 17 Oct",
};

const meta = {
  title: "Ballot/Frame",
  component: Frame,
  parameters: { layout: "fullscreen" },
  args: {
    poll: POLL,
    children: (
      <>
        <ScreenTitle title="Should the river path get better lighting?">
          <p className="m-0">Pick one.</p>
        </ScreenTitle>
        <Part title="Before you answer">
          <Note title="Nothing is sent while you choose">
            <p className="m-0">Your answer is sealed on this device before it leaves.</p>
          </Note>
        </Part>
      </>
    ),
    primary: (
      <Button size="lg" className={ACTION}>
        Next
      </Button>
    ),
    secondary: (
      <Button size="lg" variant="outline" className={ACTION}>
        Back
      </Button>
    ),
  },
} satisfies Meta<typeof Frame>;

export default meta;
type Story = StoryObj<typeof meta>;

const everyday: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // Nothing above the question but who asked, when it closes and the seal.
  await expect(canvas.getByRole("img", { name: "Seal of this poll, 3f8a 0c51" })).toBeVisible();
  await expect(canvas.getByText("Riverside Residents' Association asked")).toBeVisible();
  await expect(canvas.getByText("Closes Fri 17 Oct")).toBeVisible();
  await expect(canvas.getByText("Question 2 of 3")).toBeVisible();
  // The everyday register keeps the hash off the surface.
  await expect(canvas.queryByText(/^Election /)).toBeNull();
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Should the river path get better lighting?",
  );
  await expect(canvas.getByRole("button", { name: "Next" })).toBeEnabled();
  await expect(canvas.getByRole("button", { name: "Back" })).toBeEnabled();
};

export const Everyday: Story = {
  args: { pollClass: 1, progress: { current: 2, total: 3 } },
  play: everyday,
};

export const EverydayDark: Story = {
  args: { pollClass: 1, progress: { current: 2, total: 3 } },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: everyday,
};

export const NoClassIsEveryday: Story = {
  name: "No class yet: everyday",
  args: { progress: { current: 1, total: 3 } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("img", { name: /^Seal of this poll/ })).toBeVisible();
    await expect(canvas.getByText("Question 1 of 3")).toBeVisible();
  },
};

const civic: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(
    canvas.getByRole("img", { name: "Fingerprint of the election definition 3f8a 0c51" }),
  ).toBeVisible();
  // The civic record names the election and its hash in the evidence face.
  await expect(canvas.getByText("Riverside Residents' Association")).toBeVisible();
  await expect(canvas.getByText("Election 3f8a 0c51")).toBeVisible();
  await expect(canvas.getByText("Step 2 of 5")).toBeVisible();
  await expect(canvas.getByText("Choose")).toBeVisible();
  await expect(canvas.queryByText(/^Question /)).toBeNull();
};

export const CivicReferendum: Story = {
  args: { pollClass: 3, progress: { current: 2, total: 5 }, stepName: "Choose" },
  play: civic,
};

export const OrganisationalVote: Story = {
  args: { pollClass: 2, progress: { current: 2, total: 5 }, stepName: "Choose" },
  play: civic,
};

export const CivicDark: Story = {
  args: { pollClass: 3, progress: { current: 2, total: 5 }, stepName: "Choose" },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: civic,
};

export const WithoutAPoll: Story = {
  args: { poll: undefined, primary: undefined, secondary: undefined },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Abolish ballot")).toBeVisible();
    await expect(canvas.queryByRole("img")).toBeNull();
    // No actions, so no action bar.
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};
