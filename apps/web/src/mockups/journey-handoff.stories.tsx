import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { BackOnSite, HandoffPage } from "./journey-handoff.tsx";
import { LIBRARY_JOURNEY } from "./journey-data.ts";

const meta = {
  title: "Mockups/Journey/Handoff",
  component: HandoffPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HandoffPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const LIBRARY_HREF = `https://abolish.ch/#poll=${LIBRARY_JOURNEY.hash}&pick=ten`;

// Tap 1 of 2 for a one-question poll; Send in the voting app is the other.
const tapOne: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const answers = canvas.getByRole("list", {
    name: "Answers to “When should the main library open on Sundays?”",
  });
  const ten = within(answers).getByRole("link", { name: "10:00 to 16:00" });
  // The pick travels in the fragment, so it never reaches a server.
  await expect(ten).toHaveAttribute("href", LIBRARY_HREF);
  await expect(
    canvas.getAllByRole("img", { name: /^Fingerprint of poll c3f9 a1d2/ })[0],
  ).toBeVisible();
  await userEvent.click(ten);
  const heading = canvas.getByRole("heading", { level: 1 });
  await expect(heading).toHaveTextContent("Opening the secure voting app");
  await waitFor(() => expect(heading).toHaveFocus());
  await expect(
    canvas.getByText("Your answer is sealed on your device, in an app nobody can change for you."),
  ).toBeVisible();
  // The same seal and question as the card, the answer, and where it opens.
  await expect(canvas.getByRole("img", { name: /^Fingerprint of poll c3f9 a1d2/ })).toBeVisible();
  await expect(canvas.getByText(LIBRARY_JOURNEY.title)).toBeVisible();
  await expect(canvas.getByText("10:00 to 16:00")).toBeVisible();
  await expect(canvas.getByText("abolish.ch")).toBeVisible();
  await expect(canvas.getByRole("link", { name: "Open it now" })).toHaveAttribute(
    "href",
    LIBRARY_HREF,
  );
  // Nothing moves on its own: no spinner, no countdown.
  await expect(canvas.queryByRole("progressbar")).toBeNull();
  await userEvent.click(canvas.getByRole("button", { name: "Stay on the website" }));
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "What people are asking",
  );
};

export const OneQuestion: Story = { name: "Tap an answer", play: tapOne };

export const ThreeQuestions: Story = {
  name: "Tap question 1 of 3",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answers = canvas.getByRole("list", {
      name: "Answers to “Which one improvement matters most to you?”",
    });
    await expect(canvas.getByText(/with 2 more questions to go/)).toBeVisible();
    await userEvent.click(
      within(answers).getByRole("link", { name: "Public toilets open all year" }),
    );
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Opening the secure voting app",
    );
    await expect(
      canvas.getByText("Question 1 of 3: Which one improvement matters most to you?"),
    ).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Open it now" })).toHaveAttribute(
      "href",
      expect.stringMatching(/^https:\/\/abolish\.ch\/#poll=b1a71203.*&pick=toilets$/),
    );
  },
};

export const Back: Story = {
  name: "Back on the website",
  render: () => <BackOnSite />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Back from the voting app",
    );
    await expect(
      canvas.getByText(/never learns how you answered, or whether you did/),
    ).toBeVisible();
  },
};

export const Dark: Story = {
  name: "Tap an answer, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: tapOne,
};
