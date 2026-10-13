import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { ModerationLogPage, ModeratorQueuePage, ReportPage } from "./moderation-page.tsx";

const meta = {
  title: "Mockups/Web/Moderation",
  component: ModerationLogPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ModerationLogPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Log: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("never on results");
    const log = () => canvas.getByRole("list", { name: /^Moderation log/ });
    await expect(within(log()).getAllByRole("listitem")).toHaveLength(8);
    await userEvent.click(canvas.getByRole("button", { name: "Hidden" }));
    await expect(canvas.getByRole("button", { name: "Hidden" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(within(log()).getAllByRole("listitem")).toHaveLength(3);
    const grounds = canvas.getByRole("region", { name: "The only seven grounds" });
    await expect(within(grounds).getAllByRole("listitem").length).toBeGreaterThanOrEqual(7);
  },
};

export const LogDark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("figure", { name: /^All 47 decisions/ })).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Report a poll" })).toHaveAttribute(
      "href",
      "/moderation/report",
    );
  },
};

export const ReportAPoll: Story = {
  render: () => <ReportPage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Send report" }));
    const alert = canvas.getByRole("alert", { name: "There is a problem" });
    await waitFor(() => expect(alert).toHaveFocus());
    await expect(canvas.getByRole("group", { name: "Ground" })).toHaveAccessibleDescription(
      /Choose the ground/,
    );
    await userEvent.click(canvas.getByRole("radio", { name: /^Personal data/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Send report" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Report received");
    await expect(canvas.getByRole("status")).toHaveTextContent("Nothing about you was stored.");
  },
};

export const ModeratorQueue: Story = {
  render: () => <ModeratorQueuePage />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The second report is an open poll cited for impersonation: it can be delisted, not hidden.
    await userEvent.click(canvas.getByRole("button", { name: /^Should the state transit bond/ }));
    await expect(canvas.getByRole("heading", { level: 2, name: /transit bond/ })).toBeVisible();
    await userEvent.click(canvas.getByRole("radio", { name: /^Hide/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Record decision" }));
    const ground = canvas.getByRole("combobox", { name: "Ground" });
    await expect(ground).toHaveAttribute("aria-invalid", "true");
    await expect(ground).toHaveAccessibleDescription(/Choose a ground from the list/);
    await expect(canvas.getByRole("textbox", { name: "Public note" })).toHaveAccessibleDescription(
      /Write the public note/,
    );

    await userEvent.selectOptions(ground, "impersonation");
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Public note" }),
      "Presented as the state's own referendum.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Record decision" }));
    await expect(ground).toHaveAccessibleDescription(/Delist it for impersonation instead/);

    await userEvent.click(canvas.getByRole("radio", { name: /^Delist/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Record decision" }));
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Recorded as log entry 48: Delisted, Impersonation.",
    );
    await expect(
      canvas.queryByRole("button", { name: /^Should the state transit bond/ }),
    ).toBeNull();
  },
};

export const ModeratorQueueDark: Story = {
  render: () => <ModeratorQueuePage />,
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("radio", { name: /^No action/ }));
    await expect(canvas.queryByRole("combobox", { name: "Ground" })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Mark reviewed" })).toBeVisible();
  },
};
