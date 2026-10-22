import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import {
  type OwnProfileView,
  type ProfileModerationView,
  ProfilesError,
  type ProfilesClient,
} from "../account/profiles.ts";
import { AccountProfile } from "./account-profile.tsx";

const HANDLE = "k7tq2mxa4vb3pz6r";
const VISIBLE: ProfileModerationView = {
  state: "visible",
  latest: undefined,
  appealable: false,
  appeals: [],
};
const HIDDEN: ProfileModerationView = {
  state: "hidden",
  latest: {
    seq: 41n,
    action: "hide",
    reason: "impersonation",
    decidedAt: "2026-10-20T15:10:00.000Z",
  },
  appealable: true,
  appeals: [],
};

/** A profiles handler in memory: the section's calls, with no network. */
function fakeProfiles({
  profile,
  moderation = VISIBLE,
  refuse,
}: {
  profile?: OwnProfileView;
  moderation?: ProfileModerationView;
  /** Every change ends this way. */
  refuse?: ProfilesError;
} = {}): ProfilesClient & { calls: string[] } {
  let own = profile;
  let m = moderation;
  const calls: string[] = [];
  const act = (call: string) => {
    calls.push(call);
    if (refuse !== undefined) throw refuse;
  };
  return {
    calls,
    own: async () => own,
    make: async (name) => {
      act(`make ${name}`);
      own = { handle: HANDLE, name, renamableOn: "2026-10-23", pollIds: [] };
      return HANDLE;
    },
    rename: async (name) => {
      act(`rename ${name}`);
      if (own === undefined) throw new ProfilesError("changed");
      if (own.name === name) return false;
      own = { ...own, name, renamableOn: "2026-10-23" };
      return true;
    },
    remove: async () => {
      act("remove");
      own = undefined;
    },
    moderation: async () => m,
    appeal: async () => {
      act("appeal");
      if (m.latest === undefined) throw new ProfilesError("changed");
      m = {
        ...m,
        appealable: false,
        appeals: [
          {
            decisionSeq: m.latest.seq,
            filedAt: "2026-10-21T09:30:00.000Z",
            outcome: undefined,
            reviewedAt: undefined,
          },
        ],
      };
    },
  };
}

const PROFILE: OwnProfileView = {
  handle: HANDLE,
  name: "Harbor Street Neighbors",
  renamableOn: undefined,
  pollIds: ["a".repeat(32), "b".repeat(32)],
};

const meta = {
  component: AccountProfile,
  args: { index: "03", phone: true },
} satisfies Meta<typeof AccountProfile>;

export default meta;
type Story = StoryObj<typeof meta>;

const calls = (client: unknown) => (client as ReturnType<typeof fakeProfiles>).calls;

const nameField = (canvas: ReturnType<typeof within>) =>
  canvas.getByRole("textbox", { name: "The name your profile shows" });

export const None: Story = {
  args: { client: fakeProfiles() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/You don't have a profile/)).toBeVisible();
    await expect(nameField(canvas)).toHaveAttribute("dir", "auto");
    await expect(canvas.getByRole("button", { name: "Make profile" })).toBeVisible();
  },
};

export const NoneWithoutPhoneVerification: Story = {
  args: { client: fakeProfiles(), phone: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(/this site doesn't verify phone numbers yet/),
    ).toBeVisible();
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const MakeAProfile: Story = {
  args: { client: fakeProfiles() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await waitFor(() => nameField(canvas)), "Harbor Street Neighbors");
    await userEvent.click(canvas.getByRole("button", { name: "Make profile" }));
    await expect(await canvas.findByText(`/by/${HANDLE}`)).toBeVisible();
    await expect(canvas.getByText("Harbor Street Neighbors")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Your profile is made. It shows no polls until you choose them.",
    );
    // Named today, so not again until tomorrow.
    await expect(canvas.getByText(/It can change again on 2026-10-23 \(UTC\)/)).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Change name" })).toBeNull();
    await expect(
      canvas.getByRole("heading", { level: 2, name: "Your public profile" }),
    ).toHaveFocus();
    await expect(calls(args.client)).toEqual(["make Harbor Street Neighbors"]);
  },
};

export const PhoneNotVerified: Story = {
  args: { client: fakeProfiles({ refuse: new ProfilesError("phoneUnverified") }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await waitFor(() => nameField(canvas)), "Sam");
    await userEvent.click(canvas.getByRole("button", { name: "Make profile" }));
    const alert = await canvas.findByRole("alert");
    await expect(alert).toHaveTextContent("A profile needs your phone number verified first.");
    await expect(within(alert).getByRole("link", { name: "Verify your phone" })).toHaveAttribute(
      "href",
      "/account/verify",
    );
  },
};

export const RefusedName: Story = {
  args: { client: fakeProfiles({ refuse: new ProfilesError("invalidName") }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await waitFor(() => nameField(canvas)), "   ");
    await userEvent.click(canvas.getByRole("button", { name: "Make profile" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/can't have that name/);
    // The form stays, with what was typed, and the field says why.
    await expect(nameField(canvas)).toHaveValue("   ");
    await expect(nameField(canvas)).toHaveAttribute("aria-invalid", "true");
    await expect(nameField(canvas)).toHaveAccessibleDescription(/can't have that name/);
  },
};

const showsProfile: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const name = await canvas.findByText("Harbor Street Neighbors");
  // T-75: the name is isolated from the text around it.
  await expect(name.tagName).toBe("BDI");
  await expect(canvas.getByText(`/by/${HANDLE}`)).toBeVisible();
  await expect(canvas.getByText(/^2\. You choose, poll by poll/)).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Change name" })).toBeVisible();
  await expect(canvas.getByRole("button", { name: "Delete profile…" })).toBeVisible();
  // Nothing was ever decided about it, so no moderation shows.
  await expect(canvas.queryByRole("link", { name: /moderation log/i })).toBeNull();
};

export const Profile: Story = {
  args: { client: fakeProfiles({ profile: PROFILE }) },
  play: showsProfile,
};

export const ProfileDark: Story = {
  args: { client: fakeProfiles({ profile: PROFILE }) },
  parameters: { theme: "dark" },
  play: showsProfile,
};

export const RightToLeftName: Story = {
  args: { client: fakeProfiles({ profile: { ...PROFILE, name: "جيران شارع الميناء" } }) },
  play: async ({ canvasElement }) => {
    const name = await within(canvasElement).findByText("جيران شارع الميناء");
    await expect(name.tagName).toBe("BDI");
  },
};

export const Rename: Story = {
  args: { client: fakeProfiles({ profile: PROFILE }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Change name" }));
    // Steps back without a change.
    await userEvent.click(canvas.getByRole("button", { name: "Keep the name" }));
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Change name" }));
    await expect(nameField(canvas)).toHaveValue("Harbor Street Neighbors");
    await userEvent.clear(nameField(canvas));
    await userEvent.type(nameField(canvas), "Harbor Street Association");
    await userEvent.click(canvas.getByRole("button", { name: "Save name" }));
    await expect(await canvas.findByText("Harbor Street Association")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "The name is changed on your profile and every poll it shows.",
    );
    await expect(canvas.queryByRole("button", { name: "Change name" })).toBeNull();
    await expect(calls(args.client)).toEqual(["rename Harbor Street Association"]);
  },
};

export const RenameToTheSameName: Story = {
  args: { client: fakeProfiles({ profile: PROFILE }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Change name" }));
    await userEvent.click(canvas.getByRole("button", { name: "Save name" }));
    await expect(await canvas.findByRole("status")).toHaveTextContent(
      "That's the name it has already. Nothing changed.",
    );
    await expect(canvas.getByRole("button", { name: "Change name" })).toBeVisible();
  },
};

export const RenamedToday: Story = {
  args: { client: fakeProfiles({ profile: { ...PROFILE, renamableOn: "2026-10-23" } }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("The name was set today. It can change again on 2026-10-23 (UTC)."),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Change name" })).toBeNull();
  },
};

export const OneNameADay: Story = {
  args: {
    client: fakeProfiles({ profile: PROFILE, refuse: new ProfilesError("oneNameADay") }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Change name" }));
    await userEvent.type(nameField(canvas), "!");
    await userEvent.click(canvas.getByRole("button", { name: "Save name" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The name was set already today. Nothing changed.",
    );
    await expect(canvas.queryByRole("textbox")).toBeNull();
  },
};

export const Delete: Story = {
  args: { client: fakeProfiles({ profile: PROFILE }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Delete profile…" }));
    // Asks once more, and can step back.
    await userEvent.click(canvas.getByRole("button", { name: "Keep profile" }));
    await expect(canvas.queryByRole("group")).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Delete profile…" }));
    const question = canvas.getByRole("group", { name: "Delete your profile?" });
    await expect(within(question).getByText(/address is retired for good/)).toBeVisible();
    await userEvent.click(within(question).getByRole("button", { name: "Delete profile" }));
    await expect(await canvas.findByText(/You don't have a profile/)).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("Your profile is deleted.");
    await expect(calls(args.client)).toEqual(["remove"]);
  },
};

export const HiddenAndAppealed: Story = {
  args: { client: fakeProfiles({ profile: PROFILE, moderation: HIDDEN }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Profile hidden: Impersonation, October 20, 2026 at 3:10 PM UTC"),
    ).toBeVisible();
    await expect(canvas.getByText(/your polls don't say who asked them/)).toBeVisible();
    // A hidden profile's name can't change.
    await expect(canvas.queryByRole("button", { name: "Change name" })).toBeNull();
    await expect(
      canvas.getByText("The name can't change while the profile is hidden."),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Appeal this decision…" }));
    await userEvent.click(canvas.getByRole("button", { name: "Send appeal" }));
    await expect(await canvas.findByText(/You appealed decision No\. 41/)).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("Your appeal is filed.");
    await expect(canvas.queryByRole("button", { name: "Appeal this decision…" })).toBeNull();
    await expect(calls(args.client)).toEqual(["appeal"]);
  },
};

export const RestoredOnAppeal: Story = {
  args: {
    client: fakeProfiles({
      profile: PROFILE,
      moderation: {
        state: "visible",
        latest: {
          seq: 44n,
          action: "restore",
          reason: "appeal-upheld",
          decidedAt: "2026-10-22T11:00:00.000Z",
        },
        appealable: false,
        appeals: [
          {
            decisionSeq: 41n,
            filedAt: "2026-10-21T09:30:00.000Z",
            outcome: "upheld",
            reviewedAt: "2026-10-22T11:00:00.000Z",
          },
        ],
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText(
        /upheld on October 22, 2026 at 11:00 AM UTC, and the profile restored/,
      ),
    ).toBeVisible();
    await expect(canvas.getByText("Our pages show this profile again.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Change name" })).toBeVisible();
  },
};

export const SignedOut: Story = {
  args: {
    client: {
      ...fakeProfiles(),
      own: async () => {
        throw new ProfilesError("signedOut");
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByRole("alert")).toHaveTextContent(
      "You've been signed out. Sign in again to see your profile.",
    );
  },
};

export const Unloaded: Story = {
  args: {
    client: {
      ...fakeProfiles(),
      own: async () => {
        throw new ProfilesError("failed");
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Your profile couldn't be loaded. Try again shortly.",
    );
    await expect(canvas.queryByRole("textbox")).toBeNull();
  },
};
