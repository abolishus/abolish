import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { AccountError, type AccountClient, type PasskeyView } from "../account/client.ts";
import { type DraftsClient, DraftsError } from "../account/drafts.ts";
import { type ProfilesClient, ProfilesError } from "../account/profiles.ts";
import {
  type EmailView,
  type PhoneView,
  VerifyError,
  type VerifyClient,
} from "../account/verify.ts";
import { AccountPanel } from "./account-panel.tsx";

/** An account handler in memory: the panel's calls, with no network and no passkey prompt. */
function fakeClient({
  signedIn = false,
  passkeys = [] as PasskeyView[],
  fail,
}: {
  signedIn?: boolean;
  passkeys?: PasskeyView[];
  /** Every passkey prompt ends this way. */
  fail?: "cancelled" | "unsupported";
} = {}): AccountClient & { calls: string[] } {
  let session = signedIn;
  let keys = [...passkeys];
  let next = keys.length;
  const calls: string[] = [];
  const passkey = (): PasskeyView => ({
    id: `pk-${next++}`,
    createdAt: "2026-10-01T12:00:00.000Z",
    backedUp: true,
  });
  const prompt = () => {
    if (fail !== undefined) throw new AccountError(fail);
  };
  return {
    calls,
    signedIn: async () => session,
    signUp: async () => {
      calls.push("signUp");
      prompt();
      keys = [passkey()];
      session = true;
    },
    signIn: async () => {
      calls.push("signIn");
      prompt();
      session = true;
    },
    signOut: async () => {
      calls.push("signOut");
      session = false;
    },
    signOutOthers: async () => void calls.push("signOutOthers"),
    passkeys: async () => keys,
    addPasskey: async () => {
      calls.push("addPasskey");
      prompt();
      keys = [...keys, passkey()];
    },
    removePasskey: async (id) => {
      calls.push(`removePasskey ${id}`);
      keys = keys.filter((k) => k.id !== id);
    },
    deleteAccount: async () => {
      calls.push("deleteAccount");
      keys = [];
      session = false;
    },
  };
}

const ONE: PasskeyView[] = [{ id: "pk-a", createdAt: "2026-09-30T08:15:00.000Z", backedUp: true }];
const TWO: PasskeyView[] = [
  ...ONE,
  { id: "pk-b", createdAt: "2026-10-02T17:40:00.000Z", backedUp: false },
];

/** An account with no polls: the list's own stories are in account-polls.stories.tsx. */
const noPolls: DraftsClient = {
  list: async () => [],
  remove: async () => {},
  retry: async () => {},
  discard: async () => {},
  read: async () => {
    throw new DraftsError("gone");
  },
  create: async () => {
    throw new DraftsError("failed");
  },
  update: async () => {},
  moderation: async () => {
    throw new DraftsError("gone");
  },
  appeal: async () => {
    throw new DraftsError("gone");
  },
  answered: async () => {
    throw new DraftsError("gone");
  },
  submit: async () => {},
};

/** An account with no profile: the profile's own stories are in account-profile.stories.tsx. */
const noProfile: ProfilesClient = {
  own: async () => undefined,
  make: async () => {
    throw new ProfilesError("failed");
  },
  rename: async () => {
    throw new ProfilesError("changed");
  },
  remove: async () => {
    throw new ProfilesError("changed");
  },
  moderation: async () => {
    throw new ProfilesError("changed");
  },
  appeal: async () => {
    throw new ProfilesError("changed");
  },
  show: async () => {
    throw new ProfilesError("changed");
  },
};

/** An account's e-mail and phone as the handlers hold them; the verification page's stories are in account-verify.stories.tsx. */
function fakeVerify({ email, phone }: { email?: EmailView; phone?: PhoneView } = {}): VerifyClient {
  const refused = async () => {
    throw new VerifyError("failed");
  };
  return {
    email: async () => email,
    phone: async () => phone,
    requestEmailCode: refused,
    verifyEmailCode: refused,
    requestPhoneCode: refused,
    verifyPhoneCode: refused,
  };
}

/** The panel's own notice; the polls list below it has its own. */
const notice = async (canvas: ReturnType<typeof within>) =>
  (await canvas.findAllByRole("status"))[0];

const meta = {
  component: AccountPanel,
  args: {
    drafts: noPolls,
    profiles: noProfile,
    verify: fakeVerify(),
    accountExport: { download: async () => {} },
    push: { state: async () => "off", enable: async () => {}, disable: async () => {} },
    // None yet: the list's own stories are in account-follow-results.stories.tsx.
    followResults: { list: async () => [], drop: async () => {}, headings: async () => [] },
    noticeChoices: { results: async () => true, setResults: async () => {} },
    phone: true,
  },
} satisfies Meta<typeof AccountPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

const signsUp: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(
    await canvas.findByRole("button", { name: "Create an account with a passkey" }),
  );
  await expect(await canvas.findByText("Synced passkey")).toBeVisible();
  await expect(await notice(canvas)).toHaveTextContent("You're signed in.");
  // The button that had focus is gone: focus is back on the heading.
  await expect(canvas.getByRole("heading", { level: 1, name: "Your account" })).toHaveFocus();
  // One passkey: it can't be removed.
  await expect(canvas.queryByRole("button", { name: /^Remove/ })).toBeNull();
  await expect(canvas.getByText("Your last passkey")).toBeVisible();
  // Signed in, the page no longer explains the separation; it lists the passkeys.
  await expect(canvas.queryByRole("region", { name: "Your account is not your vote" })).toBeNull();
  await userEvent.click(canvas.getByRole("button", { name: "Sign out" }));
  await expect(await canvas.findByRole("button", { name: "Sign in with a passkey" })).toBeVisible();
  await expect(await notice(canvas)).toHaveTextContent("You're signed out.");
};

const separates: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(
    await canvas.findByRole("heading", { level: 1, name: "Sign in, or create an account" }),
  ).toBeVisible();
  const separation = canvas.getByRole("region", { name: "Your account is not your vote" });
  await expect(within(separation).getByText("Never joined")).toBeVisible();
  await expect(
    within(separation).getByRole("heading", { level: 3, name: "Your voting identity" }),
  ).toBeVisible();
};

export const SignedOut: Story = {
  args: { client: fakeClient() },
  play: async (context) => {
    await separates(context);
    await signsUp(context);
  },
};

export const SignedOutDark: Story = {
  args: { client: fakeClient() },
  parameters: { theme: "dark" },
  play: separates,
};

/** Came from home's "Ask a question": signing in goes on to the new poll's form, not the account. */
export const Asking: Story = {
  args: { client: fakeClient(), ask: fn() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Sign in to ask your question" }),
    ).toBeVisible();
    await expect(canvas.getByText(/the question's form opens next/)).toBeVisible();
    await expect(args.ask).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Sign in with a passkey" }));
    await waitFor(() => expect(args.ask).toHaveBeenCalledOnce());
    // It never drew the account it is leaving.
    await expect(canvas.queryByRole("heading", { level: 1, name: "Your account" })).toBeNull();
    await expect(canvas.queryByText("You haven't created a poll yet.")).toBeNull();
  },
};

export const AskingDark: Story = {
  args: { client: fakeClient(), ask: fn() },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("heading", { name: "Sign in to ask your question" }),
    ).toBeVisible();
  },
};

/** Already signed in, asking goes straight on to the form. */
export const AskingSignedIn: Story = {
  args: { client: fakeClient({ signedIn: true, passkeys: ONE }), ask: fn() },
  play: async ({ canvasElement, args }) => {
    await waitFor(() => expect(args.ask).toHaveBeenCalledOnce());
    await expect(within(canvasElement).queryByText("Synced passkey")).toBeNull();
  },
};

export const SignedIn: Story = {
  args: { client: fakeClient({ signedIn: true, passkeys: TWO }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Device passkey")).toBeVisible();
    await expect(canvas.getByText("Added October 2, 2026 at 5:40 PM UTC")).toBeVisible();
    // Its verification comes first, then its polls; this one has none. The
    // phone is asked for at its first vote, so only the e-mail is pressed for.
    await expect(await canvas.findByText("Not verified yet")).toBeVisible();
    await expect(canvas.getByText("Asked for when you first vote")).toBeVisible();
    await expect(canvas.getByRole("link", { name: "Verify your e-mail" })).toHaveAttribute(
      "href",
      "/account/verify",
    );
    await expect(await canvas.findByText("You haven't created a poll yet.")).toBeVisible();
    // What it's told by e-mail, then its data, before its deletion.
    await expect(canvas.getByRole("heading", { name: "What we tell you about" })).toBeVisible();
    // Beside them, the polls it followed whose results are in.
    await expect(
      canvas.getByRole("heading", { name: "Results for polls you followed" }),
    ).toBeVisible();
    await expect(await canvas.findByText(/^Nothing here yet\./)).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Download your data" })).toBeVisible();
    const remove = canvas.getAllByRole("button", { name: /^Remove the passkey added/ });
    await expect(remove).toHaveLength(2);
    await expect(remove[1]).toHaveAccessibleName(
      "Remove the passkey added October 2, 2026 at 5:40 PM UTC",
    );
    await userEvent.click(remove[1]!);
    await waitFor(() => expect(canvas.queryByText("Device passkey")).toBeNull());
    await expect(canvas.queryByRole("button", { name: /^Remove/ })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Add a passkey" }));
    await expect(await notice(canvas)).toHaveTextContent("Passkey added.");
    await userEvent.click(canvas.getByRole("button", { name: "Sign out everywhere else" }));
    await expect(await notice(canvas)).toHaveTextContent(
      "Every other session of this account is signed out.",
    );
    const client = args.client as ReturnType<typeof fakeClient>;
    await expect(client.calls).toEqual(["removePasskey pk-b", "addPasskey", "signOutOthers"]);
  },
};

export const SignedInDark: Story = {
  args: { client: fakeClient({ signedIn: true, passkeys: TWO }) },
  parameters: { theme: "dark" },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText("Device passkey")).toBeVisible();
  },
};

export const DeleteAccount: Story = {
  args: { client: fakeClient({ signedIn: true, passkeys: ONE }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Delete account…" }));
    // Asks once more, and can step back.
    await userEvent.click(canvas.getByRole("button", { name: "Keep account" }));
    await userEvent.click(canvas.getByRole("button", { name: "Delete account…" }));
    const confirm = canvas.getByRole("group", {
      name: "Delete this account? This can't be undone.",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Delete account permanently" }),
    );
    await expect(
      await canvas.findByRole("button", { name: "Create an account with a passkey" }),
    ).toBeVisible();
    await expect(await notice(canvas)).toHaveTextContent("The account is deleted.");
    await expect((args.client as ReturnType<typeof fakeClient>).calls).toEqual(["deleteAccount"]);
  },
};

export const PromptDismissed: Story = {
  args: { client: fakeClient({ fail: "cancelled" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Sign in with a passkey" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The passkey prompt was dismissed.",
    );
    await expect(canvas.getByRole("button", { name: "Sign in with a passkey" })).toBeEnabled();
  },
};

export const NoPasskeySupport: Story = {
  args: { client: fakeClient({ fail: "unsupported" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Create an account with a passkey" }),
    );
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "This browser doesn't support passkeys.",
    );
  },
};

export const SessionEndedUnderThePolls: Story = {
  args: {
    client: fakeClient({ signedIn: true, passkeys: ONE }),
    drafts: {
      ...noPolls,
      list: async () => {
        throw new DraftsError("signedOut");
      },
    },
  },
  play: async ({ canvasElement }) => {
    // The drafts handler found no session: the panel shows the way back in.
    await expect(
      await within(canvasElement).findByRole("button", { name: "Sign in with a passkey" }),
    ).toBeVisible();
  },
};

export const Verified: Story = {
  args: {
    client: fakeClient({ signedIn: true, passkeys: ONE }),
    verify: fakeVerify({
      email: { address: "sam@example.org", verifiedAt: "2026-10-01T12:00:00.000Z" },
      phone: { verifiedOn: "2026-10-02" },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = canvas.getByRole("region", { name: "E-mail and phone" });
    await expect(await within(section).findByText("Verified: sam@example.org")).toBeVisible();
    await expect(within(section).getByText("Verified on October 2, 2026")).toBeVisible();
    await expect(
      within(section).getByRole("link", { name: "Manage your e-mail and phone" }),
    ).toHaveAttribute("href", "/account/verify");
  },
};

/** Phone verification off for this deployment: the e-mail alone, and no number asked for or read. */
export const PhoneOff: Story = {
  args: {
    client: fakeClient({ signedIn: true, passkeys: ONE }),
    verify: {
      ...fakeVerify({
        email: { address: "sam@example.org", verifiedAt: "2026-10-01T12:00:00.000Z" },
      }),
      phone: async () => {
        throw new Error("the phone is never read with phone verification off");
      },
    },
    phone: false,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = canvas.getByRole("region", { name: "E-mail" });
    await expect(await within(section).findByText("Verified: sam@example.org")).toBeVisible();
    await expect(within(section).queryByText("Phone")).toBeNull();
    await expect(
      within(section).getByText("Voting needs a verified e-mail address: one account per address."),
    ).toBeVisible();
    await expect(within(section).getByRole("link", { name: "Change your e-mail" })).toHaveAttribute(
      "href",
      "/account/verify",
    );
  },
};

/** Signed out with phone verification off: no number among what the account holds. */
export const SignedOutPhoneOff: Story = {
  args: { client: fakeClient(), phone: false },
  play: async (context) => {
    await separates(context);
    const separation = within(context.canvasElement).getByRole("region", {
      name: "Your account is not your vote",
    });
    await expect(within(separation).getByText("Your e-mail address, encrypted")).toBeVisible();
    await expect(within(separation).queryByText(/phone number/)).toBeNull();
  },
};

export const VerificationUnavailable: Story = {
  args: {
    client: fakeClient({ signedIn: true, passkeys: ONE }),
    verify: {
      ...fakeVerify(),
      email: async () => {
        throw new VerifyError("unavailable");
      },
      phone: async () => {
        throw new VerifyError("unavailable");
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findAllByText("Not available on this site yet")).toHaveLength(2);
  },
};
