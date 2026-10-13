import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { SignedInPage, SignedOutPage } from "./account-page.tsx";

const meta = {
  title: "Mockups/Web/Account",
  component: SignedOutPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SignedOutPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SignedOut: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Sign in" })).toBeVisible();
    await expect(
      canvas.getByRole("heading", { name: "Your account is not your vote" }),
    ).toBeVisible();
    await expect(canvas.getByText("Never joined")).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Sign in with a passkey" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Waiting for your passkey.");
  },
};

export const SignedIn: Story = {
  render: () => <SignedInPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "Account" })).toHaveAttribute("href", "/account");
    const polls = canvas.getByRole("region", { name: "Polls you created" });
    await expect(within(polls).getAllByRole("heading", { level: 3 })).toHaveLength(5);

    const digest = canvas.getByRole("switch", { name: /A weekly list of new polls/ });
    await expect(digest).not.toBeChecked();
    await userEvent.click(digest);
    await expect(digest).toBeChecked();

    await userEvent.click(canvas.getByRole("button", { name: "Remove Security key" }));
    await expect(canvas.queryByText("Security key")).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Delete account" }));
    const body = within(canvasElement.ownerDocument.body);
    const dialog = await body.findByRole("alertdialog", { name: "Delete your account?" });
    await waitFor(() => expect(dialog).toBeVisible());
    await userEvent.click(within(dialog).getByRole("button", { name: "Keep my account" }));
    await waitFor(() => expect(body.queryByRole("alertdialog")).toBeNull());
  },
};

export const SignedInDark: Story = {
  render: () => <SignedInPage />,
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await expect(
      canvas.getByRole("textbox", { name: /Email for notices/ }),
    ).toHaveAccessibleDescription(/We use it for nothing else/);
  },
};

export const SignedOutDark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Create an account" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Creating a passkey.");
  },
};
