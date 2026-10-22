import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { PollShare } from "./poll-share.tsx";

const URL = "https://abolish.us/p/mhanrsz";
const TITLE = "Poll mhanrsz";
const EMBED = "https://abolish.us/embed/p/mhanrsz";

const meta = {
  component: PollShare,
  args: {
    url: URL,
    title: TITLE,
    canShare: true,
    flyer: "/p/mhanrsz/flyer",
    embed: { page: EMBED, height: 588 },
  },
} satisfies Meta<typeof PollShare>;

export default meta;
type Story = StoryObj<typeof meta>;

async function openSheet(canvasElement: HTMLElement) {
  await userEvent.click(within(canvasElement).getByRole("button", { name: "Share this poll" }));
  const dialog = await within(canvasElement.ownerDocument.body).findByRole("dialog", {
    name: "Share this poll",
  });
  // The dialog fades in.
  await waitFor(() => expect(dialog).toBeVisible());
  return within(dialog);
}

function stubClipboard(fails = false) {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        if (fails) throw new DOMException("Denied", "NotAllowedError");
        writes.push(text);
      },
    },
  });
  return writes;
}

const play: Story["play"] = async ({ canvasElement }) => {
  const sheet = await openSheet(canvasElement);
  await expect(sheet.getByText(/never your answer/)).toBeVisible();
  await expect(sheet.getByRole("textbox", { name: "Link to this poll" })).toHaveValue(URL);

  const writes = stubClipboard();
  await userEvent.click(sheet.getByRole("button", { name: "Copy link" }));
  await waitFor(() => expect(sheet.getByRole("button", { name: "Link copied" })).toBeVisible());
  await expect(sheet.getByRole("status")).toHaveTextContent("Link copied. Paste it anywhere.");
  await expect(writes).toEqual([URL]);

  // The system share menu gets the title and the link: nothing about the sharer.
  const shared: ShareData[] = [];
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (data: ShareData) => void shared.push(data),
  });
  await userEvent.click(sheet.getByRole("button", { name: "Share…" }));
  await expect(shared).toEqual([{ title: TITLE, url: URL }]);
  await expect(sheet.queryByRole("link", { name: "Email the link" })).toBeNull();
  // The flyer is a page of its own, for the same link.
  await expect(sheet.getByRole("link", { name: "Print a flyer" })).toHaveAttribute(
    "href",
    "/p/mhanrsz/flyer",
  );
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

export const NoWebShare: Story = {
  name: "No share menu in this browser",
  args: { canShare: false },
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    await expect(sheet.queryByRole("button", { name: "Share…" })).toBeNull();
    await expect(sheet.getByTestId("no-web-share")).toHaveTextContent(
      "This browser doesn't have a share menu.",
    );
    await expect(sheet.getByRole("link", { name: "Email the link" })).toHaveAttribute(
      "href",
      `mailto:?subject=${encodeURIComponent(TITLE)}&body=${encodeURIComponent(URL)}`,
    );
  },
};

export const CopyFails: Story = {
  name: "Copying fails",
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    stubClipboard(true);
    await userEvent.click(sheet.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
      expect(sheet.getByRole("status")).toHaveTextContent(
        "Couldn't copy. Select the link above and copy it.",
      ),
    );
    await expect(sheet.getByRole("button", { name: "Copy link" })).toBeVisible();
  },
};

export const QrCode: Story = {
  name: "QR code",
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    const toggle = sheet.getByRole("button", { name: "Show a QR code" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(sheet.queryByRole("img")).toBeNull();
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const code = sheet.getByRole("img", { name: "QR code for abolish.us/p/mhanrsz" });
    await expect(code).toBeVisible();
    // The upper-case link fits version 2 (25 modules and the 4-module quiet
    // zone) in alphanumeric mode; the lower-case one would need version 3.
    await expect(code).toHaveAttribute("viewBox", "0 0 33 33");
    await expect(code.querySelector("rect")).toHaveAttribute("fill", "#ffffff");
    await userEvent.click(toggle);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(sheet.queryByRole("img")).toBeNull();
  },
};

export const QrCodeDark: Story = {
  name: "QR code, dark",
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    await userEvent.click(sheet.getByRole("button", { name: "Show a QR code" }));
    // Dark modules on a light ground in both themes: many scanners can't read an inverted code.
    const code = sheet.getByRole("img", { name: "QR code for abolish.us/p/mhanrsz" });
    await expect(code.querySelector("path")).toHaveAttribute("fill", "#000000");
    await expect(code.querySelector("rect")).toHaveAttribute("fill", "#ffffff");
  },
};

export const Embed: Story = {
  name: "Embed on your site",
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    await userEvent.click(sheet.getByRole("button", { name: "Embed on your site" }));
    const body = within(canvasElement.ownerDocument.body);
    const panel = within(await body.findByRole("dialog", { name: "Embed on your site" }));
    const code = panel.getByRole("textbox", { name: "Code to paste into your page" });
    // A script-free frame that asks for no referrer, sandboxed as the page sandboxes itself.
    await expect(code).toHaveValue(
      [
        `<iframe src="${EMBED}"`,
        `  title="${TITLE}"`,
        `  width="100%" height="588" style="max-width:640px;border:0"`,
        `  loading="lazy" referrerpolicy="no-referrer"`,
        `  sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"></iframe>`,
      ].join("\n"),
    );
    await expect(
      panel.getByRole("link", { name: "Open the card in a new tab (opens in a new tab)" }),
    ).toHaveAttribute("href", EMBED);

    await userEvent.click(panel.getByRole("radio", { name: "Dark" }));
    await expect((code as HTMLTextAreaElement).value).toContain(`src="${EMBED}?theme=dark"`);
    await expect(panel.getByRole("link", { name: /^Open the card in a new tab/ })).toHaveAttribute(
      "href",
      `${EMBED}?theme=dark`,
    );

    const writes = stubClipboard();
    await userEvent.click(panel.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(panel.getByRole("button", { name: "Code copied" })).toBeVisible());
    await expect(writes).toEqual([(code as HTMLTextAreaElement).value]);

    // A plain link loads nothing from us, so it has no colours to choose.
    await userEvent.click(panel.getByRole("radio", { name: /^A plain link/ }));
    await expect(panel.queryByRole("radio", { name: "Dark" })).toBeNull();
    await expect(code).toHaveValue(
      `<p><a href="${URL}">${TITLE}</a><br>\nAnswer on Abolish; anyone can check the count.</p>`,
    );
    await expect(panel.getByRole("button", { name: "Copy code" })).toBeVisible();

    await userEvent.click(panel.getByRole("button", { name: "Back to sharing" }));
    await expect(await body.findByRole("dialog", { name: "Share this poll" })).toBeVisible();
  },
};

export const EmbedDark: Story = {
  name: "Embed on your site, dark",
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    const sheet = await openSheet(canvasElement);
    await userEvent.click(sheet.getByRole("button", { name: "Embed on your site" }));
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "Embed on your site",
      }),
    ).toBeVisible();
  },
};
