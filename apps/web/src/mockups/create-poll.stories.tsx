import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { EMPTY_DRAFT, SAMPLE_DRAFT } from "./create-poll-data.ts";
import { CreatePollFlow } from "./create-poll-flow.tsx";

const meta = {
  title: "Mockups/Web/Create a poll",
  component: CreatePollFlow,
  parameters: { layout: "fullscreen" },
  args: { initialDraft: SAMPLE_DRAFT },
} satisfies Meta<typeof CreatePollFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

const h1 = (canvasElement: HTMLElement) => within(canvasElement).getByRole("heading", { level: 1 });

export const Question: Story = {
  args: { initialStep: "question", initialDraft: { ...EMPTY_DRAFT } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(h1(canvasElement)).toHaveTextContent("What are you asking?");
    const question = canvas.getByRole("textbox", { name: "Question" });
    await expect(question).toHaveAccessibleDescription(/Up to 200 characters/);
    await userEvent.type(question, "Should the Harbor library open on Sundays?");
    await expect(canvas.getByText(/158 left/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(h1(canvasElement)).toHaveTextContent("What can voters choose?");
  },
};

export const Options: Story = {
  args: { initialStep: "options" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(h1(canvasElement)).toHaveTextContent("What can voters choose?");
    await userEvent.click(canvas.getByRole("button", { name: "Add an option" }));
    const fourth = canvas.getByRole("textbox", { name: "Option 4" });
    await userEvent.type(fourth, "Two hundred new street trees");
    await expect(fourth).toHaveValue("Two hundred new street trees");
    await expect(canvas.getByText("4 of 10")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Remove option 3" }));
    await expect(canvas.queryByRole("textbox", { name: "Option 4" })).toBeNull();
    await expect(canvas.getByRole("textbox", { name: "Option 3" })).toHaveValue(
      "Two hundred new street trees",
    );
  },
};

export const Method: Story = {
  args: { initialStep: "method" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("radio", { name: /^Ranked choice/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(canvas.getByRole("radio", { name: /^Approval/ })).toBeChecked();
    await expect(canvas.getByText("Example: a voter approves two options")).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: /^Plurality/ }));
    await expect(canvas.getByRole("radio", { name: /^Plurality/ })).toBeChecked();
    await expect(canvas.getByText("Example: a voter chooses one option")).toBeVisible();
  },
};

export const Eligibility: Story = {
  args: { initialStep: "eligibility" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const preview = canvas.getByRole("figure", {
      name: "How the results page will report this poll",
    });
    await expect(within(preview).getAllByText("Reported on its own")).toHaveLength(2);
    await userEvent.click(canvas.getByRole("radio", { name: /^Document-verified only/ }));
    await expect(within(preview).getAllByText("Reported on its own")).toHaveLength(1);
    await expect(within(preview).getAllByText("Not eligible")).toHaveLength(2);
  },
};

export const Schedule: Story = {
  args: { initialStep: "schedule" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("window")).toHaveTextContent("14 days");
    const closes = canvas.getByRole("group", { name: "Voting closes" });
    const day = within(closes).getByRole("textbox", { name: "Day" });
    await userEvent.clear(day);
    await userEvent.type(day, "22");
    await expect(canvas.getByTestId("window")).toHaveTextContent("21 days");
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(h1(canvasElement)).toHaveTextContent("Check your poll before publishing");
  },
};

export const Review: Story = {
  args: { initialStep: "review" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("figure", { name: "Definition hash" })).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Moderation" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Publish poll" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Published.");
  },
};

export const ReviewChange: Story = {
  args: { initialStep: "review" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Change options" }));
    await expect(h1(canvasElement)).toHaveTextContent("What can voters choose?");
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(h1(canvasElement)).toHaveTextContent("What are you asking?");
  },
};

export const ValidationError: Story = {
  args: {
    initialStep: "options",
    initialDraft: { ...SAMPLE_DRAFT, options: ["Better lighting on the river path", ""] },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    const summary = canvas.getByRole("alert", { name: "There is a problem" });
    await waitFor(() => expect(summary).toHaveFocus());
    await expect(
      within(summary).getByRole("link", { name: "Enter at least two options." }),
    ).toHaveAttribute("href", "#option-1");
    const second = canvas.getByRole("textbox", { name: "Option 2" });
    await expect(second).toHaveAttribute("aria-invalid", "true");
    await expect(second).toHaveAccessibleDescription("Error: Enter at least two options.");
    await expect(h1(canvasElement)).toHaveTextContent("What can voters choose?");
  },
};

export const Dark: Story = {
  args: { initialStep: "method" },
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("list", { name: "Steps" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(h1(canvasElement)).toHaveTextContent("What can voters choose?");
  },
};
