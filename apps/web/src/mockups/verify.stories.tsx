import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { VerifyPage } from "./verify-page.tsx";

const meta = {
  title: "Mockups/Web/Verify",
  component: VerifyPage,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof VerifyPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Recount any election without us",
    );

    // The report ticks through the checks as the narrative scrolls past.
    const report = canvas.getByTestId("verifier-report");
    await expect(report).toHaveAttribute("data-step", "0");
    await expect(report).toHaveTextContent("Verdict: reading…");
    const scene = canvas.getByRole("region", { name: "The verifier's checks, in order" });
    const steps = within(scene)
      .getAllByRole("listitem")
      .filter((li) => li.parentElement?.parentElement === scene);
    steps.at(-1)?.scrollIntoView({ block: "center" });
    await waitFor(() => expect(report).toHaveAttribute("data-step", "5"));
    await expect(report).toHaveTextContent("Verdict: verified");
    await expect(within(report).getAllByText("pass")).toHaveLength(6);

    // Copying a command reports what happened, whether or not the clipboard allows it.
    const install = canvas.getByRole("figure", { name: "Install the verifier" });
    await expect(install).toHaveTextContent("npm install --global @abolishus/verifier@1.0.0");
    await userEvent.click(
      within(install).getByRole("button", { name: "Copy: Install the verifier" }),
    );
    await waitFor(() =>
      expect(within(install).getByText(/^(Copied|Select the text to copy)$/)).toBeVisible(),
    );
  },
};

export const Dark: Story = {
  parameters: { layout: "fullscreen", theme: "dark" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const codes = canvas.getByRole("table", { name: "What the exit code means" });
    await expect(within(codes).getAllByRole("row")).toHaveLength(5);
    await expect(within(codes).getByRole("cell", { name: "21" })).toBeVisible();
    const client = canvas.getByRole("figure", { name: "Ballot client release 1.4.0" });
    await expect(
      within(client).getByRole("img", { name: /ballot client 1\.4\.0, 723b 32ae/ }),
    ).toBeVisible();
    await expect(canvas.getByRole("navigation", { name: "On this page" })).toBeVisible();
  },
};
