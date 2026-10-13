import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { SHARE_LIVE, SHARE_MULTI, SHARE_SEALED } from "./share-data.ts";
import { EmbedDialog, HostPage } from "./share-embed.tsx";

const meta = {
  title: "Mockups/Sharing/Embed",
  component: HostPage,
  args: { poll: SHARE_LIVE, theme: "light", width: "wide" },
  render: (args) => (
    <div className="grid gap-10">
      <HostPage {...args} width="narrow" />
      <HostPage {...args} width="wide" />
    </div>
  ),
} satisfies Meta<typeof HostPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The card is links only: nothing in it can hold or send an answer. */
const linksOnly = async (canvasElement: HTMLElement) => {
  for (const card of within(canvasElement).getAllByTestId("embed-card")) {
    await expect(card.querySelector("form, input, button, select, textarea, iframe")).toBeNull();
    for (const link of within(card).getAllByRole("link")) {
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toHaveAttribute("rel", "noopener");
    }
  }
};

export const OneQuestion: Story = {
  name: "One question, light",
  play: async ({ canvasElement }) => {
    await linksOnly(canvasElement);
    const narrow = within(within(canvasElement).getByTestId("host-narrow"));
    await expect(
      narrow.getByRole("link", { name: /^Better lighting on the river path 41%/ }),
    ).toHaveAttribute("href", `https://abolish.ch/#poll=${SHARE_LIVE.id}&pick=lights`);
    await expect(narrow.getByRole("link", { name: /^Answer on Abolish/ })).toHaveAttribute(
      "href",
      `https://abolish.ch/#poll=${SHARE_LIVE.id}`,
    );
    await expect(narrow.getByTestId("embed-status")).toHaveTextContent(
      "Results so far among 2,418 people with an account · updated 7 Nov, 12:00 UTC",
    );
  },
};

export const OneQuestionDark: Story = {
  name: "One question, dark",
  args: { theme: "dark" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => linksOnly(canvasElement),
};

export const SeveralQuestions: Story = {
  name: "Several questions, light",
  args: { poll: SHARE_MULTI },
  play: async ({ canvasElement }) => {
    await linksOnly(canvasElement);
    const [card] = within(canvasElement).getAllByTestId("embed-card");
    await expect(
      within(card!).getByRole("link", { name: /^Answer 3 questions on Abolish/ }),
    ).toBeVisible();
    await expect(card!.querySelectorAll("ol > li")).toHaveLength(3);
  },
};

export const SeveralQuestionsDark: Story = {
  name: "Several questions, dark",
  args: { poll: SHARE_MULTI, theme: "dark" },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => linksOnly(canvasElement),
};

export const Sealed: Story = {
  name: "Sealed results",
  args: { poll: SHARE_SEALED },
  play: async ({ canvasElement }) => {
    await linksOnly(canvasElement);
    for (const card of within(canvasElement).getAllByTestId("embed-card")) {
      await expect(card.textContent).not.toMatch(/\d\s?%/);
      await expect(within(card).getByTestId("embed-status")).toHaveTextContent(
        "Results appear when it closes on 15 Nov.",
      );
    }
  },
};

export const Dialog: Story = {
  name: "Embed on your site",
  render: () => <EmbedDialog poll={SHARE_LIVE} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "Embed on your site" }));
    const dialog = within(await body.findByRole("dialog", { name: "Embed on your site" }));

    const snippet = dialog.getByRole("textbox", { name: "Code to paste into your page" });
    await expect(snippet).toHaveValue(
      [
        '<iframe src="https://abolish.us/embed/p/3j55dw1"',
        '  title="Poll: Which one improvement should Riverside ask the city for next year?"',
        '  width="100%" height="604" style="max-width:640px;border:0"',
        '  loading="lazy" referrerpolicy="no-referrer"',
        '  sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>',
      ].join("\n"),
    );
    // The dialog fades in over 100 ms.
    await waitFor(() => expect(dialog.getByTestId("embed-card")).toBeVisible());

    await userEvent.click(dialog.getByRole("radio", { name: "Dark" }));
    await expect((snippet as HTMLTextAreaElement).value).toContain(
      'src="https://abolish.us/embed/p/3j55dw1?theme=dark"',
    );

    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void writes.push(text) },
    });
    await userEvent.click(dialog.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(dialog.getByRole("button", { name: "Code copied" })).toBeVisible());
    await expect(writes[0]).toContain("<iframe");

    await userEvent.click(dialog.getByRole("radio", { name: /^A plain link/ }));
    await expect((snippet as HTMLTextAreaElement).value).toContain(
      '<p><a href="https://abolish.us/p/3j55dw1">',
    );
    await expect(dialog.queryByTestId("embed-card")).toBeNull();
  },
};
