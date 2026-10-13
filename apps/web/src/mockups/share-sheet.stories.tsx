import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { SHARE_LIVE, SHARE_SEALED } from "./share-data.ts";
import { SharePollPage } from "./share-sheet.tsx";

const meta = {
  title: "Mockups/Sharing/Share sheet",
  component: SharePollPage,
  args: { poll: SHARE_LIVE, canShare: true },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SharePollPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const URL = "https://abolish.us/p/3j55dw1";

async function openSheet(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole("button", { name: "Share this poll" }));
  const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
    name: "Share this poll",
  });
  // The dialog fades in over 100 ms.
  await waitFor(() => expect(dialog).toBeVisible());
  return within(dialog);
}

function stubClipboard() {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void writes.push(text) },
  });
  return writes;
}

export const Default: Story = {
  name: "From the poll page",
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    await expect(sheet.getByText(/never your answer/)).toBeVisible();
    await expect(sheet.getByRole("textbox", { name: "Link to this poll" })).toHaveValue(URL);

    const writes = stubClipboard();
    await userEvent.click(sheet.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(sheet.getByRole("button", { name: "Link copied" })).toBeVisible());
    await expect(sheet.getByRole("status")).toHaveTextContent("Link copied. Paste it anywhere.");
    await expect(writes).toEqual([URL]);

    // The system share menu gets the question and the link: nothing about the sharer.
    const shared: ShareData[] = [];
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data: ShareData) => void shared.push(data),
    });
    await userEvent.click(sheet.getByRole("button", { name: "Share…" }));
    await expect(shared).toEqual([{ title: SHARE_LIVE.title, url: URL }]);

    await expect(sheet.getByRole("link", { name: "Print a flyer" })).toHaveAttribute(
      "href",
      "/p/3j55dw1/flyer",
    );
    await expect(sheet.getByTestId("also-at")).toHaveTextContent(
      "If abolish.us doesn’t open where you are: open abolish.ch or abolishus.eth and enter the code 3j55dw1.",
    );
  },
};

export const NoWebShare: Story = {
  name: "No share menu in this browser",
  args: { canShare: false },
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    await expect(sheet.queryByRole("button", { name: "Share…" })).toBeNull();
    await expect(sheet.getByTestId("no-web-share")).toHaveTextContent(
      "This browser doesn’t have a share menu.",
    );
    await expect(sheet.getByRole("link", { name: "Email the link" })).toHaveAttribute(
      "href",
      `mailto:?subject=${encodeURIComponent(SHARE_LIVE.title)}&body=${encodeURIComponent(URL)}`,
    );
    const writes = stubClipboard();
    await userEvent.click(sheet.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(sheet.getByRole("button", { name: "Link copied" })).toBeVisible());
    await expect(writes).toEqual([URL]);
  },
};

export const QrCode: Story = {
  name: "QR code",
  args: { poll: SHARE_SEALED },
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    const toggle = sheet.getByRole("button", { name: "Show a QR code" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      sheet.getByRole("img", {
        name: "QR code for abolish.us/p/nya0exy (placeholder, not scannable)",
      }),
    ).toBeVisible();
  },
};

export const Embed: Story = {
  name: "Embed, from the sheet",
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    await userEvent.click(sheet.getByRole("button", { name: "Embed on your site" }));
    const body = within(canvasElement.ownerDocument.body);
    const embed = within(await body.findByRole("dialog", { name: "Embed on your site" }));
    await expect(
      (embed.getByRole("textbox", { name: "Code to paste into your page" }) as HTMLTextAreaElement)
        .value,
    ).toContain('<iframe src="https://abolish.us/embed/p/3j55dw1"');
    await userEvent.click(embed.getByRole("button", { name: "Back to sharing" }));
    await expect(await body.findByRole("dialog", { name: "Share this poll" })).toBeVisible();
  },
};

export const Dark: Story = {
  name: "From the poll page, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    stubClipboard();
    await userEvent.click(sheet.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(sheet.getByRole("button", { name: "Link copied" })).toBeVisible());
  },
};
