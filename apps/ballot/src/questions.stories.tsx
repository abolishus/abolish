import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import type { BallotQuestion } from "./answers.ts";
import { ArrivalCheck, ArrivalChecklist } from "./check.tsx";
import type { FramePoll } from "./frame.tsx";
import { AnswerQuestions } from "./questions.tsx";

const HASH = "b1a71203bc63c46c88c27d024456c4d70c953a796284a33280b376fabc89c490";

const POLL: FramePoll = {
  definitionHash: HASH,
  name: "Riverside Neighbours",
  closes: "15 Nov",
};

const option = (label: string, description = "") => ({ label, description });

const PRIORITY: BallotQuestion = {
  question: "Which one improvement matters most to you?",
  description: "",
  options: [
    option("Better lighting on the river path"),
    option("Public toilets open all year"),
    option("Resurfaced basketball courts"),
    option("Two hundred new street trees"),
  ],
  minSelections: 0,
  maxSelections: 1,
};

const EVENTS: BallotQuestion = {
  question: "Which events would you go to?",
  description: "Each would run from May to September.",
  options: [
    option("A Saturday farmers' market"),
    option("Outdoor cinema in summer", "Fridays, in the park"),
    option("Monthly river clean-up"),
    option("Free concerts in the bandstand"),
  ],
  minSelections: 0,
  maxSelections: 2,
};

const SAFE: BallotQuestion = {
  question: "How safe do you feel walking along the river after dark?",
  description: "",
  options: [
    option("Very safe"),
    option("Mostly safe"),
    option("Not sure"),
    option("Not very safe"),
    option("I avoid it"),
  ],
  minSelections: 0,
  maxSelections: 1,
};

const RIVERSIDE = [PRIORITY, EVENTS, SAFE];

const meta = {
  title: "Ballot/Questions",
  component: AnswerQuestions,
  parameters: { layout: "fullscreen" },
  args: {
    poll: POLL,
    questions: RIVERSIDE,
    arrival: <ArrivalCheck definitionHash={HASH} />,
    onSend: fn(),
    onChallenge: fn(),
  },
} satisfies Meta<typeof AnswerQuestions>;

export default meta;
type Story = StoryObj<typeof meta>;

type Canvas = ReturnType<typeof within>;

async function next(canvas: Canvas) {
  await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
}

const pickOne: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("Question 1 of 3")).toBeVisible();
  await expect(canvas.getByText("This is the real poll, checked")).toBeVisible();
  // The question, then how to answer, then the options; nothing chosen for the voter.
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(PRIORITY.question);
  await expect(canvas.getAllByText("Choose one.")[0]).toBeVisible();
  for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
  await expect(canvas.getByText("Nothing chosen yet.")).toBeVisible();
  await expect(canvas.queryByRole("button", { name: "Back" })).toBeNull();
  await userEvent.click(canvas.getByText("Two hundred new street trees"));
  await expect(canvas.getByRole("radio", { name: "Two hundred new street trees" })).toBeChecked();
  await expect(canvas.getByText("Selected")).toBeVisible();
  await expect(canvas.getByText("You chose: Two hundred new street trees.")).toBeVisible();
  await userEvent.click(canvas.getByText("Public toilets open all year"));
  await expect(canvas.getByRole("radio", { name: "Public toilets open all year" })).toBeChecked();
  await expect(
    canvas.getByRole("radio", { name: "Two hundred new street trees" }),
  ).not.toBeChecked();
  await next(canvas);
  await expect(canvas.getByText("Question 2 of 3")).toBeVisible();
  // Focus follows to the new question's heading.
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
  await userEvent.click(canvas.getByRole("button", { name: "Back" }));
  await expect(canvas.getByRole("radio", { name: "Public toilets open all year" })).toBeChecked();
};

export const PickOne: Story = { name: "Pick one", play: pickOne };

const upToTwo: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText("Public toilets open all year"));
  await next(canvas);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(EVENTS.question);
  await expect(canvas.getByText(EVENTS.description)).toBeVisible();
  await expect(canvas.getAllByText("Choose up to 2.")[0]).toBeVisible();
  await expect(
    canvas.getByRole("checkbox", { name: "Outdoor cinema in summer" }),
  ).toHaveAccessibleDescription("Fridays, in the park");
  await expect(canvas.getByText("0 of 2 chosen")).toBeVisible();
  await userEvent.click(canvas.getByText("A Saturday farmers' market"));
  await userEvent.click(canvas.getByText("Monthly river clean-up"));
  await expect(canvas.getByText("2 of 2 chosen")).toBeVisible();
  await expect(canvas.getByText("No more choices left")).toBeVisible();
  // A third is refused in words, and nothing already chosen changes.
  await userEvent.click(canvas.getByText("Outdoor cinema in summer"));
  await expect(canvas.getByText("You've already chosen 2")).toBeVisible();
  await expect(canvas.getByText(/To choose “Outdoor cinema in summer”/)).toBeVisible();
  await expect(
    canvas.getByRole("checkbox", { name: "Outdoor cinema in summer" }),
  ).not.toBeChecked();
  await expect(canvas.getByRole("checkbox", { name: "A Saturday farmers' market" })).toBeChecked();
  await expect(canvas.getByRole("checkbox", { name: "Monthly river clean-up" })).toBeChecked();
  // Taking one back makes room, and the message goes.
  await userEvent.click(canvas.getByText("Monthly river clean-up"));
  await expect(canvas.getByText("1 of 2 chosen")).toBeVisible();
  await expect(canvas.queryByText("You've already chosen 2")).toBeNull();
};

export const UpToTwo: Story = { name: "Pick up to two, and a third refused", play: upToTwo };

export const UpToTwoDark: Story = {
  name: "Pick up to two, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: upToTwo,
};

export const Skip: Story = {
  name: "Skipping a question",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Going on with nothing chosen asks first, in plain words.
    await next(canvas);
    await expect(canvas.getByText("Skip this question?")).toBeVisible();
    await expect(canvas.getByText(/A skipped question counts as no answer/)).toBeVisible();
    await expect(canvas.getByText("Question 1 of 3")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Keep answering" }));
    await expect(canvas.queryByText("Skip this question?")).toBeNull();
    // Skipping on purpose clears what was chosen, after saying so.
    await userEvent.click(canvas.getByText("Resurfaced basketball courts"));
    await userEvent.click(canvas.getByRole("button", { name: "Skip this question" }));
    await expect(canvas.getByText(/Skipping clears what you chose here/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Skip and go on" }));
    await expect(canvas.getByText("Question 2 of 3")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
  },
};

const EXACTLY_TWO: BallotQuestion = { ...EVENTS, minSelections: 2, maxSelections: 2 };

export const ExactlyTwo: Story = {
  name: "Pick exactly two, can't be skipped",
  args: { questions: [EXACTLY_TWO, SAFE] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Choose exactly 2.")[0]).toBeVisible();
    await expect(canvas.getByText(/This question can't be skipped/)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Skip this question" })).toBeNull();
    await next(canvas);
    await expect(canvas.getByText("This question needs exactly 2")).toBeVisible();
    await expect(canvas.getByText(/Choose 2 more to go on/)).toBeVisible();
    await expect(canvas.queryByText("Skip this question?")).toBeNull();
    await userEvent.click(canvas.getByText("A Saturday farmers' market"));
    await next(canvas);
    await expect(canvas.getByText(/Choose 1 more to go on/)).toBeVisible();
    await expect(canvas.getByText("Question 1 of 2")).toBeVisible();
    await userEvent.click(canvas.getByText("Outdoor cinema in summer"));
    await next(canvas);
    await expect(canvas.getByText("Question 2 of 2")).toBeVisible();
  },
};

const AT_LEAST_ONE: BallotQuestion = { ...EVENTS, minSelections: 1, maxSelections: 4 };

export const AtLeastOne: Story = {
  name: "Pick at least one",
  args: { questions: [AT_LEAST_ONE] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByText("Choose at least one.")[0]).toBeVisible();
    await expect(canvas.getByText("Question 1 of 1")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
    await expect(canvas.getByText("This question needs at least one")).toBeVisible();
    await userEvent.click(canvas.getByText("Monthly river clean-up"));
    await userEvent.click(canvas.getByText("A Saturday farmers' market"));
    await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
    await userEvent.click(canvas.getByRole("button", { name: "Send my answers" }));
    await expect(args.onSend).toHaveBeenCalledWith([[0, 2]]);
  },
};

const answerAll: Story["play"] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByText("Public toilets open all year"));
  await next(canvas);
  await userEvent.click(canvas.getByText("Monthly river clean-up"));
  await userEvent.click(canvas.getByText("A Saturday farmers' market"));
  await next(canvas);
  await userEvent.click(canvas.getByText("Not very safe"));
  await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Check your answers");
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
  const questions = [...canvas.getByRole("list", { name: "Your answers" }).children];
  await expect(questions).toHaveLength(3);
  await expect(questions[0]).toHaveTextContent("Public toilets open all year");
  await expect(questions[1]).toHaveTextContent("A Saturday farmers' market");
  await expect(questions[1]).toHaveTextContent("Monthly river clean-up");
  await expect(questions[2]).toHaveTextContent("Not very safe");
  await expect(canvas.queryByText(/You skipped/)).toBeNull();
  // Change returns to that question with the answer kept, and then straight back here.
  await userEvent.click(canvas.getByRole("button", { name: "Change your answer to question 2" }));
  await expect(canvas.getByText("Question 2 of 3")).toBeVisible();
  await expect(canvas.getByRole("checkbox", { name: "A Saturday farmers' market" })).toBeChecked();
  await userEvent.click(canvas.getByText("Monthly river clean-up"));
  await userEvent.click(canvas.getByText("Free concerts in the bandstand"));
  await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
  await expect(canvas.getByText("Free concerts in the bandstand")).toBeVisible();
  await expect(canvas.queryByText("Monthly river clean-up")).toBeNull();
  await expect(args.onSend).not.toHaveBeenCalled();
  await userEvent.click(canvas.getByRole("button", { name: "Check the encryption first" }));
  await expect(args.onChallenge).toHaveBeenCalledWith([[1], [0, 3], [3]]);
  await userEvent.click(canvas.getByRole("button", { name: "Send my answers" }));
  await expect(args.onSend).toHaveBeenCalledWith([[1], [0, 3], [3]]);
};

export const CheckYourAnswers: Story = { name: "Check your answers", play: answerAll };

export const CheckYourAnswersDark: Story = {
  name: "Check your answers, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: answerAll,
};

export const CheckWithASkip: Story = {
  name: "Check your answers, with a skipped question",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText("Public toilets open all year"));
    await next(canvas);
    await userEvent.click(canvas.getByRole("button", { name: "Skip this question" }));
    await userEvent.click(canvas.getByRole("button", { name: "Skip and go on" }));
    await userEvent.click(canvas.getByText("Mostly safe"));
    await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
    await expect(canvas.getByText("You skipped question 2")).toBeVisible();
    await expect(canvas.getByText("Skipped: counts as no answer")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Change your answer to question 2" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(EVENTS.question);
    await expect(canvas.getByText("0 of 2 chosen")).toBeVisible();
  },
};

const CIVIC = {
  pollClass: 3,
  poll: { ...POLL, name: "Riverside levy 2026" },
  questions: [PRIORITY, SAFE],
  arrival: (
    <ArrivalChecklist
      definitionHash={HASH}
      origin="https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.example.net"
    />
  ),
} satisfies Story["args"];

const civic: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  // Steps count the questions and then the check.
  await expect(canvas.getByText("Step 1 of 3: Question 1")).toBeVisible();
  await expect(canvas.getByText("What this device checked")).toBeVisible();
  await userEvent.click(canvas.getByText("Better lighting on the river path"));
  await next(canvas);
  await expect(canvas.getByText("Step 2 of 3: Question 2")).toBeVisible();
  await userEvent.click(canvas.getByText("I avoid it"));
  await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
  await expect(canvas.getByText("Step 3 of 3: Check your answers")).toBeVisible();
};

export const Civic: Story = { name: "Civic record", args: CIVIC, play: civic };

export const CivicDark: Story = {
  name: "Civic record, dark",
  args: CIVIC,
  parameters: { layout: "fullscreen", theme: "dark" },
  play: civic,
};
