import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { Opened, Sealed, SealStopped, Sent, Unsent, Working } from "./sealed.tsx";

// The screens between sealing and the board (sealed.tsx), with the worker
// and the network left out: each story is one screen as the voter meets it.

const POLL = {
  definitionHash: "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
  name: "Riverside Residents' Association",
  closes: "Fri 17 Oct",
};
const ELECTION_ID = "5d2c9a40b7e31f6688c0a1d2e3f405162738495a6b7c8d9eaf01b2c3d4e5f607";
const CODE = "c0de5eed0123456789abcdef0123456789abcdef0123456789abcdef01234567";

const meta = {
  title: "Ballot/Sealed",
  component: Sealed,
  parameters: { layout: "fullscreen" },
  args: {
    poll: POLL,
    electionId: ELECTION_ID,
    trackingCode: CODE,
    onCast: fn(),
    onChallenge: fn(),
  },
} satisfies Meta<typeof Sealed>;

export default meta;
type Story = StoryObj<typeof meta>;

const sealed: Story["play"] = async ({ canvasElement, args }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your answers are sealed",
  );
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
  const qr = canvas.getByRole("img", { name: "QR code of the tracking code c0de 5eed" });
  // Dark modules on a light ground in both themes, at a size a phone can scan.
  await expect(qr).toHaveAttribute("width", "208");
  await expect(
    canvas.getByRole("figure", { name: "Tracking code of your sealed ballot" }),
  ).toHaveTextContent(CODE);
  await expect(
    canvas.getByRole("heading", { name: "Scan it now with your other device" }),
  ).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Check the encryption first" }));
  await expect(args.onChallenge).toHaveBeenCalledOnce();
  await userEvent.click(canvas.getByRole("button", { name: "Cast this ballot" }));
  await expect(args.onCast).toHaveBeenCalledOnce();
};

export const TheTrackingCode: Story = {
  name: "The tracking code, before the choice",
  play: sealed,
};

export const TheTrackingCodeDark: Story = {
  name: "The tracking code, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: sealed,
};

const OPENING = Uint8Array.from({ length: 64 }, (_, i) => 255 - i);

const opened: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your sealed ballot is opened",
  );
  await expect(
    canvas.getByRole("figure", { name: "The tracking code it opened" }),
  ).toHaveTextContent(CODE);
  const save = await canvas.findByRole("link", { name: "Save the opening" });
  await expect(save).toHaveAttribute("download", "abolish-opening-c0de5eed01234567.bin");
  await expect(
    new Uint8Array(await (await fetch(save.getAttribute("href") ?? "")).arrayBuffer()),
  ).toEqual(OPENING);
  await expect(
    canvas.getByRole("heading", { name: "Check it on your other device" }),
  ).toBeVisible();
  // Nothing here casts, and nothing claims the opening checks.
  await expect(canvas.queryByRole("button", { name: "Cast this ballot" })).toBeNull();
  await expect(canvas.queryByText(/This is what you chose/)).toBeNull();
};

export const TheOpening: Story = {
  name: "A challenged ballot, opened",
  render: () => <Opened poll={POLL} trackingCode={CODE} opening={OPENING} onAgain={() => {}} />,
  play: opened,
};

export const TheOpeningDark: Story = {
  name: "A challenged ballot, opened, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  render: () => <Opened poll={POLL} trackingCode={CODE} opening={OPENING} onAgain={() => {}} />,
  play: opened,
};

export const Sealing: Story = {
  name: "Sealing",
  render: () => <Working poll={POLL} kind="sealing" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Sealing your answers",
    );
    await expect(canvas.getByRole("status")).toHaveTextContent("Nothing is sent.");
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const Opening: Story = {
  name: "Opening",
  render: () => <Working poll={POLL} kind="opening" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Opening your sealed ballot",
    );
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

const onAgain = fn();

export const SealFailed: Story = {
  name: "Sealing failed",
  render: () => <SealStopped poll={POLL} problem="seal-failed" onAgain={onAgain} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This device couldn't seal your answers",
    );
    onAgain.mockClear();
    await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
    await expect(onAgain).toHaveBeenCalledOnce();
  },
};

export const OpenFailed: Story = {
  name: "Opening failed",
  render: () => <SealStopped poll={POLL} problem="open-failed" onAgain={onAgain} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This device couldn't open the sealed ballot",
    );
    await expect(canvas.getByText(/can't be counted now/)).toBeVisible();
  },
};

export const NoIdentity: Story = {
  name: "No voting identity on this device",
  render: () => <SealStopped poll={POLL} problem="no-identity" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This device has no voting identity yet",
    );
    await expect(canvas.getByText(/Nothing was sealed or sent/)).toBeVisible();
    // Nothing a retry could change.
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const CellRefused: Story = {
  name: "The voter's place on the list couldn't be found",
  render: () => (
    <SealStopped poll={POLL} problem="cell-refused" code="not-a-member" onAgain={onAgain} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your place on the poll's list couldn't be found",
    );
    // The check's own name, for whoever the voter reports it to.
    await expect(canvas.getByText("not-a-member")).toBeVisible();
    onAgain.mockClear();
    await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
    await expect(onAgain).toHaveBeenCalledOnce();
  },
};

export const NoL1: Story = {
  name: "No L1 block to name yet",
  render: () => <SealStopped poll={POLL} problem="no-l1" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This ballot can't read Ethereum yet",
    );
    await expect(canvas.getByText(/Your ballot wasn't made/)).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const Sending: Story = {
  name: "Sending a cast ballot",
  render: () => <Working poll={POLL} kind="sending" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Sending your ballot",
    );
    await expect(canvas.getByRole("status")).toHaveTextContent(/recorded your sealed ballot/);
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

const onSend = fn();

export const UnsentBusy: Story = {
  name: "The board is busy: send the same ballot again",
  render: () => <Unsent poll={POLL} trackingCode={CODE} reason="busy" onSend={onSend} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("The board is busy");
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(
      canvas.getByRole("figure", { name: "Tracking code of your sealed ballot" }),
    ).toHaveTextContent(CODE);
    // The same ballot, never a new one (T-25).
    await expect(canvas.getByText(/never a new one/)).toBeVisible();
    onSend.mockClear();
    await userEvent.click(canvas.getByRole("button", { name: "Send again" }));
    await expect(onSend).toHaveBeenCalledOnce();
  },
};

export const UnsentUnconfirmed: Story = {
  name: "The board's answer doesn't carry the ballot",
  render: () => <Unsent poll={POLL} trackingCode={CODE} reason="unconfirmed" onSend={onSend} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "The board's answer doesn't show your ballot",
    );
    await expect(canvas.getByRole("button", { name: "Send again" })).toBeVisible();
  },
};

const sent: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your ballot is on the board",
  );
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
  await expect(canvas.getByText("Entry 41 on the board")).toBeVisible();
  await expect(
    canvas.getByRole("figure", { name: "Tracking code of your sealed ballot" }),
  ).toHaveTextContent(CODE);
  // Unsigned: the board's word, and said so (T-26).
  await expect(canvas.getByText(/it is the board's word/)).toBeVisible();
  onAgain.mockClear();
  await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
  await expect(onAgain).toHaveBeenCalledOnce();
};

export const OnTheBoard: Story = {
  name: "The cast ballot is on the board",
  render: () => <Sent poll={POLL} trackingCode={CODE} index={41n} onAgain={onAgain} />,
  play: sent,
};

export const OnTheBoardDark: Story = {
  name: "The cast ballot is on the board, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  render: () => <Sent poll={POLL} trackingCode={CODE} index={41n} onAgain={onAgain} />,
  play: sent,
};

export const OnTheBoardAsACopy: Story = {
  name: "A copy of the cast ballot was already on the board",
  render: () => <Sent poll={POLL} trackingCode={CODE} onAgain={onAgain} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your ballot is on the board",
    );
    await expect(canvas.getByText(/already holds a copy/)).toBeVisible();
    await expect(canvas.queryByText(/^Entry/)).toBeNull();
  },
};

export const AnswerConflict: Story = {
  name: "The board gave two answers for one ballot",
  render: () => <SealStopped poll={POLL} problem="answer-conflict" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "The board gave two answers for one ballot",
    );
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};
