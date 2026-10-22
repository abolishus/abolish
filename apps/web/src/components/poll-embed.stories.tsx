import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";

import { instant } from "../poll.ts";
import { EmbedCard, EmbedNotice } from "./poll-embed.tsx";

const CODE = "mhanrsz";
const URL = `https://abolish.us/p/${CODE}`;
const ID = "7c".repeat(32);
const HASH = "3a51c6f0b2e94d7781aa0c3f5e6d2b9817c4e0f9a3b5d1c7e8f2a4b6c9d0e1f2";
const BALLOT = "https://abolish.ch/";
const QUESTION = { optionCount: 3, minSelections: 1, maxSelections: 1 };
const TEXT = {
  language: "en",
  heading: "What should the city fix first on the river path?",
  question: undefined,
  options: ["Better lighting", "Wider paths", "More benches"],
};

const meta = {
  component: EmbedCard,
  args: {
    poll: {
      electionId: ID,
      definitionHash: HASH,
      questions: [QUESTION],
      opensAt: instant(1_793_000_000n),
      closesAt: instant(1_794_758_400n),
    },
    asOf: instant(1_793_500_000n),
    url: URL,
    title: `Poll ${CODE}`,
    text: TEXT,
    ballot: BALLOT,
  },
  // The narrowest and widest columns the card is meant for.
  render: (args) => (
    <div className="grid gap-10">
      <div className="max-w-[320px]" data-testid="narrow">
        <EmbedCard {...args} />
      </div>
      <div className="max-w-[640px]" data-testid="wide">
        <EmbedCard {...args} />
      </div>
    </div>
  ),
} satisfies Meta<typeof EmbedCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Checks the card is links only: nothing in it can hold or send an answer, and every link opens a new tab. */
async function linksOnly(canvasElement: HTMLElement) {
  for (const card of within(canvasElement).getAllByTestId("embed-card")) {
    await expect(card.querySelector("form, input, button, select, textarea, iframe")).toBeNull();
    for (const link of within(card).getAllByRole("link")) {
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener");
    }
  }
}

const card = (canvasElement: HTMLElement) =>
  within(within(canvasElement).getByTestId("narrow").firstElementChild as HTMLElement);

export const Open: Story = {
  name: "Open, one question",
  play: async ({ canvasElement }) => {
    await linksOnly(canvasElement);
    const c = card(canvasElement);
    await expect(c.getByRole("heading", { level: 1 })).toHaveTextContent(TEXT.heading);
    // The pick rides in the fragment, which no server sees.
    await expect(c.getByRole("link", { name: "Wider paths (opens in a new tab)" })).toHaveAttribute(
      "href",
      `${BALLOT}#election=${ID}&pick=1`,
    );
    await expect(
      c.getByRole("link", { name: "Answer on Abolish (opens in a new tab)" }),
    ).toHaveAttribute("href", `${BALLOT}#election=${ID}`);
    await expect(
      c.getByText("Answers are taken only on Abolish, never in this card."),
    ).toBeVisible();
    await expect(
      c.getByRole("link", { name: "abolish.us/p/mhanrsz (opens in a new tab)" }),
    ).toHaveAttribute("href", URL);
    await expect(c.getByTestId("embed-status")).toHaveTextContent(/^Closes /);
    // Nothing about answers: no count, no lead.
    await expect(canvasElement.textContent).not.toMatch(/%|answers so far/);
  },
};

export const OpenDark: Story = {
  name: "Open, dark",
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => linksOnly(canvasElement),
};

export const Several: Story = {
  name: "Several questions",
  args: {
    poll: {
      electionId: ID,
      definitionHash: HASH,
      questions: [QUESTION, { optionCount: 2, minSelections: 1, maxSelections: 1 }],
      opensAt: instant(1_793_000_000n),
      closesAt: instant(1_794_758_400n),
    },
    text: { ...TEXT, heading: "The river path", question: TEXT.heading },
  },
  play: async ({ canvasElement }) => {
    await linksOnly(canvasElement);
    const c = card(canvasElement);
    await expect(c.getByRole("heading", { level: 1 })).toHaveTextContent("The river path");
    await expect(c.getByText(TEXT.heading)).toBeVisible();
    await expect(c.getByText("A poll on abolish.us · 2 questions")).toBeVisible();
    await expect(c.getByText(/^Pick an answer to question 1 of 2\./)).toBeVisible();
    await expect(
      c.getByRole("link", { name: "Answer 2 questions on Abolish (opens in a new tab)" }),
    ).toBeVisible();
  },
};

export const Closed: Story = {
  name: "Closed",
  args: { asOf: instant(1_795_000_000n) },
  play: async ({ canvasElement }) => {
    await linksOnly(canvasElement);
    const c = card(canvasElement);
    await expect(c.queryByRole("link", { name: /^Better lighting/ })).toBeNull();
    await expect(c.getByTestId("embed-status")).toHaveTextContent(/^Closed /);
    await expect(
      c.getByRole("link", { name: "See the poll on abolish.us (opens in a new tab)" }),
    ).toHaveAttribute("href", URL);
  },
};

export const Scheduled: Story = {
  name: "Not open yet",
  args: { asOf: instant(1_792_000_000n) },
  play: async ({ canvasElement }) => {
    const c = card(canvasElement);
    await expect(c.queryByRole("link", { name: /^Better lighting/ })).toBeNull();
    await expect(c.getByTestId("embed-status")).toHaveTextContent(/^Opens /);
  },
};

export const NoText: Story = {
  name: "No text to show",
  args: { text: undefined },
  play: async ({ canvasElement }) => {
    const c = card(canvasElement);
    // The link preview's headline, and no answers to pick without their words.
    await expect(c.getByRole("heading", { level: 1 })).toHaveTextContent(`Poll ${CODE}`);
    await expect(c.queryByRole("list")).toBeNull();
    await expect(c.getByRole("link", { name: /^See the poll on abolish\.us/ })).toBeVisible();
  },
};

export const NoBallot: Story = {
  name: "No ballot client on this deployment",
  args: { ballot: null },
  play: async ({ canvasElement }) => {
    const c = card(canvasElement);
    await expect(c.queryByRole("link", { name: /^Better lighting/ })).toBeNull();
    await expect(c.getByRole("link", { name: /^See the poll on abolish\.us/ })).toBeVisible();
  },
};

export const Hidden: Story = {
  name: "Hidden by moderation",
  render: () => <EmbedNotice kind="hidden" url={URL} />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByRole("heading", { level: 1 })).toHaveTextContent("This poll is hidden");
    await expect(
      page.getByRole("link", { name: "See why on its page (opens in a new tab)" }),
    ).toHaveAttribute("href", URL);
  },
};

export const NotFound: Story = {
  name: "No poll at the link",
  render: () => <EmbedNotice kind="not-found" />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByRole("heading", { level: 1 })).toHaveTextContent("No poll here");
    await expect(page.queryByRole("link")).toBeNull();
  },
};
