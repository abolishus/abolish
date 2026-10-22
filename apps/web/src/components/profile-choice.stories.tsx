import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { type OwnProfileView, ProfilesError, type ProfilesClient } from "../account/profiles.ts";
import { ProfileChoice } from "./profile-choice.tsx";
import { fakeProfiles, HANDLE } from "./profiles-fake.ts";

const POLL = "c".repeat(32);
const PROFILE: OwnProfileView = {
  handle: HANDLE,
  name: "Harbor Street Neighbors",
  renamableOn: undefined,
  pollIds: [],
};

/** The choice as a page holds it: the profile read again after each change. */
function Reading({ client, pollId }: { client: ProfilesClient; pollId: string }) {
  const [profile, setProfile] = useState(PROFILE);
  return (
    <>
      <h3 id="poll-title">Repaint the bandstand?</h3>
      <ProfileChoice
        client={client}
        profile={profile}
        pollId={pollId}
        describedBy="poll-title"
        onChanged={() => void client.own().then((p) => p !== undefined && setProfile(p))}
      />
    </>
  );
}

const meta = {
  component: ProfileChoice,
  args: { client: fakeProfiles({ profile: PROFILE }), profile: PROFILE, pollId: POLL },
} satisfies Meta<typeof ProfileChoice>;

export default meta;
type Story = StoryObj<typeof meta>;

const calls = (client: unknown) => (client as ReturnType<typeof fakeProfiles>).calls;

const box = (canvas: ReturnType<typeof within>) =>
  canvas.getByRole("checkbox", { name: "Show on your profile, Harbor Street Neighbors" });

export const ShowAndTakeBack: Story = {
  args: { client: fakeProfiles({ profile: PROFILE }) },
  render: (args) => <Reading client={args.client} pollId={POLL} />,
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const choice = box(canvas);
    await expect(choice).not.toBeChecked();
    await expect(choice).toHaveAccessibleDescription(/^Repaint the bandstand\? Your profile lists/);
    await userEvent.click(choice);
    await expect(await canvas.findByText("Your profile shows this poll.")).toBeVisible();
    await waitFor(() => expect(box(canvas)).toBeChecked());
    await userEvent.click(box(canvas));
    await expect(await canvas.findByText("Your profile doesn't show this poll.")).toBeVisible();
    await waitFor(() => expect(box(canvas)).not.toBeChecked());
    await expect(calls(args.client)).toEqual([`show ${POLL} true`, `show ${POLL} false`]);
  },
};

export const AlreadyShown: Story = {
  args: { client: fakeProfiles({ profile: PROFILE }), profile: { ...PROFILE, pollIds: [POLL] } },
  play: async ({ canvasElement }) => {
    await expect(box(within(canvasElement))).toBeChecked();
  },
};

/** A new poll's box before its first save: the choice stays on the page, sending nothing. */
export const BeforeTheFirstSave: Story = {
  args: {
    client: fakeProfiles({ profile: PROFILE }),
    pollId: undefined,
    wanted: false,
    onWant: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/^Saving the draft puts it on your profile\./)).toBeVisible();
    await userEvent.click(box(canvas));
    await expect(args.onWant).toHaveBeenCalledWith(true);
    await expect(box(canvas)).toBeChecked();
    await expect(calls(args.client)).toEqual([]);
  },
};

export const ProfileGone: Story = {
  args: {
    client: fakeProfiles({ profile: PROFILE, refuse: new ProfilesError("changed") }),
    onChanged: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(box(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your profile or this poll changed since the page read it. Nothing changed here.",
    );
    await expect(box(canvas)).not.toBeChecked();
    await expect(args.onChanged).toHaveBeenCalled();
  },
};

export const SignedOut: Story = {
  args: {
    client: fakeProfiles({ profile: PROFILE, refuse: new ProfilesError("signedOut") }),
    onSignedOut: fn(),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(box(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "You've been signed out. Sign in again to choose.",
    );
    await expect(args.onSignedOut).toHaveBeenCalled();
  },
};

export const Failed: Story = {
  args: { client: fakeProfiles({ profile: PROFILE, refuse: new ProfilesError("failed") }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(box(canvas));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "That didn't work. Nothing changed; try again shortly.",
    );
  },
};

/** T-75: a right-to-left name is laid out on its own. */
export const RightToLeftName: Story = {
  args: { profile: { ...PROFILE, name: "جيران شارع الميناء" } },
  play: async ({ canvasElement }) => {
    const name = within(canvasElement).getByText("جيران شارع الميناء");
    await expect(name.tagName).toBe("BDI");
  },
};
