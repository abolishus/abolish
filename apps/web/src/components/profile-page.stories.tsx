import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import type { PollView } from "../poll.ts";
import type { ReportOutcome } from "../profile-report.ts";
import type { StreamCard } from "../stream.ts";
import { ProfilePage } from "./profile-page.tsx";

const poll = (electionId: string): PollView => ({
  electionId,
  definitionHash: "a4555c67fbc57b7ed42f873f73f36360baba11fa0de1f0ba0f104780a4071750",
  version: 5,
  illFormed: undefined,
  rolling: false,
  counting: "questions",
  questions: [{ optionCount: 3, minSelections: 0, maxSelections: 1 }],
  electorate: [{ tier: 0, groupSize: "5000" }],
  threshold: 1,
  panelSize: 1,
  opensAt: { seconds: "1767225600", iso: "2026-01-01T00:00:00.000Z" },
  closesAt: { seconds: "1767830400", iso: "2026-01-08T00:00:00.000Z" },
});

const HANDLE = "k7qa2mzr5xw3bn4d";
const LIBRARY = "10".repeat(32);
const UNREADABLE = "40".repeat(32);
const BALLOT = "https://ballot.example/";

const cards: StreamCard[] = [
  {
    kind: "poll",
    poll: poll(LIBRARY),
    text: {
      language: "en",
      heading: "Library hours",
      question: "When should the main library open on Sundays?",
      options: ["At 10", "At noon", "Stay closed"],
    },
    tags: { topic: "culture", place: "Eastside" },
  },
  { kind: "unavailable", electionId: UNREADABLE, problem: "text" },
];

const reporting = (outcome: ReportOutcome) =>
  fn(async (_handle: string, _reason: string) => outcome);

const meta = {
  component: ProfilePage,
  args: {
    handle: HANDLE,
    profile: { kind: "profile", name: "Eastside Library Friends", cards, next: LIBRARY },
    paged: false,
    ballot: BALLOT,
    report: reporting("reported"),
  },
} satisfies Meta<typeof ProfilePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Shown: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Eastside Library Friends",
    );
    await expect(canvas.getByText(/names aren't checked and needn't be unique/)).toBeVisible();
    await expect(canvas.getByText(/It isn't part of any poll/)).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Library hours" })).toHaveAttribute(
      "href",
      `/polls/${LIBRARY}`,
    );
    await expect(canvas.getByRole("link", { name: /At noon/ })).toHaveAttribute(
      "href",
      `${BALLOT}#election=${LIBRARY}&pick=1`,
    );
    await expect(canvas.getByRole("link", { name: "More polls" })).toHaveAttribute(
      "href",
      `/by/${HANDLE}?after=${LIBRARY}`,
    );
    await expect(canvas.queryByRole("link", { name: "Start from the top" })).toBeNull();
  },
};

/** A later page links back to the top. */
export const LaterPage: Story = {
  args: {
    profile: { kind: "profile", name: "Eastside Library Friends", cards, next: undefined },
    paged: true,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Start from the top" })).toHaveAttribute(
      "href",
      `/by/${HANDLE}`,
    );
    await expect(canvas.queryByRole("link", { name: "More polls" })).toBeNull();
  },
};

/** A right-to-left name stays in its own isolate (T-75). */
export const RightToLeftName: Story = {
  args: {
    profile: { kind: "profile", name: "שכנים של הנהר", cards, next: undefined },
  },
  play: async ({ canvasElement }) => {
    const title = within(canvasElement).getByRole("heading", { level: 1 });
    await expect(title.querySelector("bdi")).toHaveTextContent("שכנים של הנהר");
  },
};

export const NoPolls: Story = {
  args: { profile: { kind: "profile", name: "Nobody yet", cards: [], next: undefined } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("No polls to show")).toBeVisible();
  },
};

/** No ballot client here: the cards link only to each poll's page. */
export const NoBallot: Story = {
  args: { ballot: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("link", { name: /At noon/ })).toBeNull();
  },
};

/** Hidden: the decision's ground alone, no name, no polls and no report (T-68). */
export const Hidden: Story = {
  args: { profile: { kind: "hidden", reason: "harassment" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This profile is hidden",
    );
    await expect(canvas.getByText(/for Harassment\./)).toBeVisible();
    await expect(canvas.queryByText("Eastside Library Friends")).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Report this profile" })).toBeNull();
    await expect(
      canvas.getByRole("link", { name: "See the decision in the public moderation log" }),
    ).toHaveAttribute("href", "/moderation");
  },
};

const choose = async (canvas: ReturnType<typeof within>, ground: string) => {
  await userEvent.click(canvas.getByRole("button", { name: "Report this profile" }));
  await expect(canvas.getByRole("button", { name: "Send report" })).toBeDisabled();
  await userEvent.click(canvas.getByRole("radio", { name: ground }));
  await userEvent.click(canvas.getByRole("button", { name: "Send report" }));
};

/** Nothing is sent until a ground is chosen and the report sent. */
export const Report: Story = {
  args: { report: reporting("reported") },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/Reports are counted, never who sent them/)).toBeVisible();
    await choose(canvas, "Impersonation");
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "Reported. A moderator will look at it.",
    );
    await expect(args.report).toHaveBeenCalledTimes(1);
    await expect(args.report).toHaveBeenCalledWith(HANDLE, "impersonation");
    await expect(canvas.getByRole("button", { name: "Report this profile" })).toBeVisible();
  },
};

export const ReportCancelled: Story = {
  args: { report: reporting("reported") },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Report this profile" }));
    await userEvent.click(canvas.getByRole("radio", { name: "Spam" }));
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await expect(canvas.getByRole("button", { name: "Report this profile" })).toBeVisible();
    await expect(args.report).not.toHaveBeenCalled();
  },
};

export const ReportedProfileGone: Story = {
  args: { report: reporting("gone") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await choose(canvas, "Spam");
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "This profile no longer exists, so nothing was reported.",
    );
  },
};

/** A failure keeps the form and the chosen ground, so the report can be sent again. */
export const ReportFailed: Story = {
  args: { report: reporting("failed") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await choose(canvas, "Threat");
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "That didn't work. Nothing was reported; try again shortly.",
    );
    await expect(canvas.getByRole("radio", { name: "Threat" })).toBeChecked();
    await expect(canvas.getByRole("button", { name: "Send report" })).toBeEnabled();
  },
};

export const Dark: Story = { parameters: { theme: "dark" } };
