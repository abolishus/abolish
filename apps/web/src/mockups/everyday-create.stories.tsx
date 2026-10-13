import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";

import { BROKEN_DRAFT, RIVERSIDE_DRAFT, WITH_TRUSTEE } from "./everyday-create-data.ts";
import { EverydayCreateFlow } from "./everyday-create-flow.tsx";

const meta = {
  title: "Mockups/Web/Everyday/Create a poll",
  component: EverydayCreateFlow,
  parameters: { layout: "fullscreen" },
  args: { initialDraft: RIVERSIDE_DRAFT, timeZone: "America/New_York" },
} satisfies Meta<typeof EverydayCreateFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

const h1 = (el: HTMLElement) => within(el).getByRole("heading", { level: 1 });
const preview = (el: HTMLElement) => within(el).getByRole("complementary", { name: "Preview" });
const question = (el: HTMLElement, n: number) =>
  within(el).getByRole("region", { name: `Question ${n}` });

export const Ask: Story = {
  args: { initialStep: "ask" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(h1(canvasElement)).toHaveTextContent("What would you like to ask?");
    await expect(canvas.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    // Add a question: focus lands in its text field, and the preview grows.
    await userEvent.click(canvas.getByRole("button", { name: "Add a question" }));
    const fourth = question(canvasElement, 4);
    const text = within(fourth).getByRole("textbox", { name: "What do you want to ask?" });
    await waitFor(() => expect(text).toHaveFocus());
    await userEvent.type(text, "Would you help run any of these?");
    await expect(within(preview(canvasElement)).getByTestId("preview-q-4")).toHaveTextContent(
      "Would you help run any of these?",
    );

    // Change question 1 to "up to N": the preview says so, and follows the number.
    const first = question(canvasElement, 1);
    await userEvent.click(within(first).getByRole("radio", { name: /Pick up to/ }));
    const q1 = within(preview(canvasElement)).getByTestId("preview-q-1");
    await expect(q1).toHaveTextContent("Pick up to 2");
    await userEvent.click(within(first).getByRole("button", { name: "More for question 1" }));
    await expect(q1).toHaveTextContent("Pick up to 3");

    // Ranked choice is visible but not yet available.
    await expect(within(first).getByRole("radio", { name: /Rank them/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    // Add an option to question 1 and type it.
    await userEvent.click(within(first).getByRole("button", { name: /Add an option/ }));
    const fifth = within(first).getByRole("textbox", { name: "Option 5" });
    await waitFor(() => expect(fifth).toHaveFocus());
    await userEvent.type(fifth, "A bike repair station");
    await expect(q1).toHaveTextContent("A bike repair station");

    // Reorder with buttons: question 2 moves to the top and keeps focus on its control.
    await userEvent.click(canvas.getByRole("button", { name: "Move question 2 up" }));
    await expect(within(preview(canvasElement)).getByTestId("preview-q-1")).toHaveTextContent(
      "Which events would you go to?",
    );
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Move question 1 down" })).toHaveFocus(),
    );
    await expect(canvas.getByRole("status")).toHaveTextContent("Question 2 is now question 1.");

    // Remove a question.
    await userEvent.click(canvas.getByRole("button", { name: "Remove question 4" }));
    await expect(canvas.queryByRole("region", { name: "Question 4" })).toBeNull();
  },
};

export const AskValidation: Story = {
  args: { initialStep: "ask", initialDraft: BROKEN_DRAFT },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    const summary = canvas.getByRole("alert", { name: "There is a problem" });
    await waitFor(() => expect(summary).toHaveFocus());
    const links = within(summary).getAllByRole("link");
    await expect(links.map((l) => l.textContent)).toEqual([
      "Question 1 needs at least two options to pick from.",
      "Question 2 lets people pick up to 3, but has only 2 options. Add an option or lower the number.",
      "Write question 3.",
    ]);
    await expect(h1(canvasElement)).toHaveTextContent("What would you like to ask?");

    const empty = within(question(canvasElement, 3)).getByRole("textbox", {
      name: "What do you want to ask?",
    });
    await expect(empty).toHaveAttribute("aria-invalid", "true");
    await expect(empty).toHaveAccessibleDescription("Error: Write question 3.");

    // Following a link puts the cursor in the field; fixing it removes the error.
    await userEvent.click(within(summary).getByRole("link", { name: "Write question 3." }));
    await expect(empty).toHaveFocus();
    await userEvent.type(empty, "Should the path stay open at night?");
    await expect(within(summary).queryByRole("link", { name: "Write question 3." })).toBeNull();
    await expect(empty).not.toHaveAttribute("aria-invalid");

    // Adding an option to question 2 clears its error too; question 1's remains.
    await userEvent.click(
      within(question(canvasElement, 2)).getByRole("button", { name: /Add an option/ }),
    );
    await expect(within(summary).getAllByRole("link")).toHaveLength(1);
  },
};

export const WhoCanAnswer: Story = {
  args: { initialStep: "who" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(h1(canvasElement)).toHaveTextContent("Who can answer?");
    await expect(canvas.queryByText(/Tier/)).toBeNull();
    const groups = canvas.getByRole("list", { name: "How your results will be shown" });
    await expect(within(groups).getAllByText("Shown on its own")).toHaveLength(3);
    await userEvent.click(
      canvas.getByRole("radio", { name: /^People who verified a passport or licence/ }),
    );
    await expect(within(groups).getAllByText("Shown on its own")).toHaveLength(1);
    await expect(within(groups).getAllByText("Can’t answer")).toHaveLength(2);
    await expect(within(preview(canvasElement)).getByTestId("preview-audience")).toHaveTextContent(
      "Open to people who verified a passport or licence",
    );
  },
};

export const Results: Story = {
  args: { initialStep: "results" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const results = within(preview(canvasElement)).getByTestId("preview-results");
    await expect(canvas.getByTestId("release-sentence")).toHaveTextContent(
      "We publish new totals daily at 12:00 UTC, and only when at least 50 new answers have come in, so no update can reveal one person’s answer.",
    );
    await expect(canvas.getByText(/Live results can sway/)).toBeVisible();

    await userEvent.click(canvas.getByRole("radio", { name: /Sealed until it closes/ }));
    await expect(canvas.queryByTestId("release-sentence")).toBeNull();
    await expect(results).toHaveTextContent("Results appear when the poll closes");

    await userEvent.click(canvas.getByRole("radio", { name: /Live, as answers come in/ }));
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "At what time (UTC)" }),
      "18:00",
    );
    await expect(canvas.getByTestId("release-sentence")).toHaveTextContent("daily at 18:00 UTC");
    await expect(results).toHaveTextContent("Results so far, updated daily at 18:00 UTC");
    await userEvent.click(canvas.getByRole("radio", { name: "Twice a day" }));
    await expect(canvas.queryByRole("combobox", { name: "At what time (UTC)" })).toBeNull();
    await expect(canvas.getByTestId("release-sentence")).toHaveTextContent(
      "twice a day, at 00:00 and 12:00 UTC",
    );
  },
};

export const TrusteesDefault: Story = {
  args: { initialStep: "key" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(h1(canvasElement)).toHaveTextContent("Who holds the key?");
    await expect(canvas.getByText(/During launch, Abolish alone holds the key/)).toBeVisible();
    const trigger = canvas.getByRole("button", { name: /Add your own trustees/ });
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.queryByTestId("consequence")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Add a trustee" }));
    await expect(canvas.getByTestId("consequence")).toHaveTextContent(
      "Your trustees add protection: no one can open answers without both panels. If your trustees go offline, your poll can’t be counted.",
    );
    // Nothing added? Collapsing and continuing is fine; with a trustee, it needs details.
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    const summary = canvas.getByRole("alert", { name: "There is a problem" });
    await expect(
      within(summary).getByRole("link", { name: "Enter trustee 1’s name." }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Remove trustee 1" }));
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(h1(canvasElement)).toHaveTextContent("When can people answer?");
  },
};

export const Trustees: Story = {
  args: { initialStep: "key", initialDraft: WITH_TRUSTEE, advancedOpen: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const consequence = canvas.getByTestId("consequence");
    await expect(consequence).toHaveTextContent(
      "Counting needs Abolish and your trustee, both online",
    );

    await userEvent.click(canvas.getByRole("button", { name: "Add another trustee" }));
    const second = canvas.getByRole("region", { name: "Trustee 2" });
    await userEvent.type(within(second).getByRole("textbox", { name: "Name" }), "Ana Okafor");
    await userEvent.type(
      within(second).getByRole("textbox", { name: "How to reach them" }),
      "ana@example.org",
    );
    await expect(within(second).getByRole("textbox", { name: "Invite link" })).toHaveAttribute(
      "readonly",
    );
    await expect(canvas.getByTestId("threshold-of")).toHaveTextContent("of 2 trustees");
    await userEvent.click(canvas.getByRole("button", { name: "More trustees needed" }));
    await expect(consequence).toHaveTextContent("Counting needs Abolish and 2 of your 2 trustees");

    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    const summary = canvas.getByRole("alert", { name: "There is a problem" });
    await waitFor(() => expect(summary).toHaveFocus());
    await expect(summary).toHaveTextContent(
      "Confirm you understand what happens if your trustees go offline.",
    );
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /if fewer than 2 of my 2 trustees/ }),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(h1(canvasElement)).toHaveTextContent("When can people answer?");
  },
};

export const Schedule: Story = {
  args: { initialStep: "schedule" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("window")).toHaveTextContent("Open for 14 days");
    await expect(canvas.getByTestId("opens-local")).toHaveTextContent(
      "That’s Sunday 1 November, 07:00 your time (New York).",
    );
    const closes = canvas.getByRole("group", { name: "Closes" });
    fireEvent.change(within(closes).getByLabelText("Date"), { target: { value: "2026-11-22" } });
    await expect(canvas.getByTestId("window")).toHaveTextContent("Open for 21 days");
    await expect(
      within(preview(canvasElement)).getByText(/closes 22 November, 12:00 UTC/),
    ).toBeVisible();

    fireEvent.change(within(closes).getByLabelText("Date"), { target: { value: "2026-10-30" } });
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    const summary = canvas.getByRole("alert", { name: "There is a problem" });
    await expect(summary).toHaveTextContent("The poll must close at least an hour after it opens.");

    fireEvent.change(within(closes).getByLabelText("Date"), { target: { value: "2026-11-15" } });
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(h1(canvasElement)).toHaveTextContent("Ready to publish?");
  },
};

export const Review: Story = {
  args: { initialStep: "review", initialDraft: WITH_TRUSTEE },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("figure", { name: "The poll’s fingerprint" })).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "What becomes permanent and public" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "What moderation can withhold" }),
    ).toBeVisible();
    await expect(canvas.getByText(/never touch the answers or the results/)).toBeVisible();
    await expect(
      canvas.getByText("Abolish, and your trustee Riverside Library Friends"),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Publish poll" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Published.");
  },
};

export const ReviewChange: Story = {
  args: { initialStep: "review" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Change results" }));
    await expect(h1(canvasElement)).toHaveTextContent("How should results appear?");
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await expect(h1(canvasElement)).toHaveTextContent("Who can answer?");
  },
};

export const AskDark: Story = {
  args: { initialStep: "ask" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      within(question(canvasElement, 2)).getByRole("radio", { name: /Pick exactly/ }),
    );
    await expect(within(preview(canvasElement)).getByTestId("preview-q-2")).toHaveTextContent(
      "Pick exactly 2",
    );
    await expect(canvas.getByRole("list", { name: "Steps" })).toBeVisible();
  },
};

export const ReviewDark: Story = {
  args: { initialStep: "review", initialDraft: WITH_TRUSTEE },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Publish poll" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Published.");
  },
};
