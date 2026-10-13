import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { EverydayPollPage } from "./everyday-poll-page.tsx";

const meta = {
  title: "Mockups/Web/Everyday/Poll",
  component: EverydayPollPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof EverydayPollPage>;

export default meta;
type Story = StoryObj<typeof meta>;

function releaseSteps(canvasElement: HTMLElement) {
  const scene = within(canvasElement).getByRole("region", {
    name: "Releases of the first question’s results",
  });
  return [...scene.querySelectorAll<HTMLElement>(":scope > ol > li")];
}

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "What should Riverside ask the city for next year?",
    );
    // The question set is the hero, and one link hands all three to the ballot app.
    await expect(canvas.getAllByRole("heading", { level: 2, name: /^Question \d:/ })).toHaveLength(
      3,
    );
    await expect(canvas.getByRole("link", { name: "Answer these 3 questions" })).toHaveAttribute(
      "href",
      "/polls/riverside/answer",
    );

    // Results so far: the latest real release, sentence first, audience in words.
    await expect(canvas.getByTestId("latest-update")).toHaveTextContent(
      "Updated 7 Nov, 12:00 UTC · 1,112 new answers since 4 Nov",
    );
    await expect(canvas.getByTestId("headline-priority")).toHaveTextContent(
      "Better lighting on the river path leads, with 41%.",
    );
    await expect(canvas.getByTestId("headline-events")).toHaveTextContent(
      "A Saturday farmers' market is the favourite: 59% would go.",
    );
    await expect(
      canvas.getAllByRole("figure", {
        name: "Among 2,418 people with an account · updated 7 Nov, 12:00 UTC",
      }),
    ).toHaveLength(3);
    await expect(canvas.getByText(/at least 50 new people have answered/)).toBeVisible();

    // Scrolling steps through the three real releases; nothing in between.
    const graphic = () => canvas.getByTestId("release-graphic");
    await expect(graphic()).toHaveAttribute("data-release", "0");
    const steps = releaseSteps(canvasElement);
    await expect(steps).toHaveLength(3);
    steps[1]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(graphic()).toHaveAttribute("data-release", "1"));
    await expect(
      within(graphic()).getByRole("figure", {
        name: "Among 1,306 people with an account · 4 Nov, 12:00 UTC",
      }),
    ).toBeVisible();
    steps[2]!.scrollIntoView({ block: "center" });
    await waitFor(() => expect(graphic()).toHaveAttribute("data-release", "2"));
    await expect(steps[2]!).toHaveTextContent("1,112 new answers since 4 Nov, 2,418 in all.");
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The evidence is one step down, in a sheet.
    await userEvent.click(canvas.getByRole("button", { name: "Show me the evidence" }));
    const sheet = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
      name: "How do we know this is real?",
    });
    await expect(within(sheet).getByTestId("trustee-statement")).toHaveTextContent(
      "During launch, Abolish alone holds the key for this poll.",
    );
    await expect(within(sheet).getByTestId("trustee-statement")).toHaveTextContent(
      "The asker added their own trustee, Riverside Library Friends, so this poll’s answers can only be opened with them too.",
    );
    await expect(
      within(sheet).getByRole("link", { name: "Open the civic record" }),
    ).toHaveAttribute("href", "/polls/riverside/record");
    // The sheet fades in over 200 ms.
    await waitFor(() =>
      expect(
        within(sheet).getByRole("img", { name: /^Fingerprint of poll b1a7 1203$/ }),
      ).toBeVisible(),
    );
    await userEvent.keyboard("{Escape}");
    // The sheet unmounts after its exit transition, which on a loaded CI
    // runner can outlast waitFor's default second.
    await waitFor(
      () => expect(within(canvasElement.ownerDocument.body).queryByRole("dialog")).toBeNull(),
      { timeout: 5_000 },
    );
  },
};

export const AfterYouAnswered: Story = {
  args: { answered: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const answered = canvas.getByRole("region", { name: "You answered" });
    await expect(answered).toHaveTextContent("Your answers are counted in the 7 Nov results.");
    await expect(within(answered).getByRole("link", { name: "Change your answer" })).toBeVisible();
    // The receipt is a small seal, linked; the page never shows the answers themselves.
    await expect(
      within(answered).getByRole("img", { name: /^Fingerprint of your receipt 4c1f 9e07$/ }),
    ).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "Answer these 3 questions" })).toBeNull();
  },
};

export const Sealed: Story = {
  args: { results: "sealed" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Results appear when it closes" }),
    ).toBeVisible();
    await expect(canvas.getByText(/sealed until 15 November, 12:00 UTC/)).toBeVisible();
    await expect(canvas.queryByText("Results so far")).toBeNull();
    await expect(canvas.queryByRole("figure")).toBeNull();
  },
};
