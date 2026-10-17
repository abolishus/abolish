import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { AccountError, type AccountClient, type PasskeyView } from "../account/client.ts";
import { type DraftsClient, DraftsError } from "../account/drafts.ts";
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
};

/** The panel's own notice; the polls list below it has its own. */
const notice = async (canvas: ReturnType<typeof within>) =>
  (await canvas.findAllByRole("status"))[0];

const meta = {
  component: AccountPanel,
  args: { drafts: noPolls },
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

export const SignedIn: Story = {
  args: { client: fakeClient({ signedIn: true, passkeys: TWO }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Device passkey")).toBeVisible();
    await expect(canvas.getByText("Added October 2, 2026 at 5:40 PM UTC")).toBeVisible();
    // The account's polls come first; this one has none.
    await expect(await canvas.findByText("You haven't created a poll yet.")).toBeVisible();
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
