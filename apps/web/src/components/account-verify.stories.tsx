import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";

import { type Challenge, ChallengeError } from "../account/challenge.ts";
import {
  type EmailView,
  type PhoneView,
  VerifyError,
  type VerifyClient,
  type VerifyFailure,
} from "../account/verify.ts";
import { VerifyPage } from "./account-verify.tsx";

const CODE = "12345678";

/**
 * The e-mail and phone handlers in memory: a code is right when it is
 * `CODE`, and each call is kept, with the token or number it carried.
 */
function fakeVerify({
  email,
  phone,
  refuseRequest,
  refuseVerify,
  unavailable = false,
}: {
  email?: EmailView;
  phone?: PhoneView;
  /** Every request for a code is refused this way. */
  refuseRequest?: VerifyFailure;
  /** Every right code is refused this way. */
  refuseVerify?: VerifyFailure;
  /** Neither service is configured on this site. */
  unavailable?: boolean;
} = {}): VerifyClient & { calls: string[] } {
  let address = email;
  let verified = phone;
  let waiting: string | undefined;
  let tries = 5;
  const calls: string[] = [];
  const configured = () => {
    if (unavailable) throw new VerifyError("unavailable");
  };
  const check = (code: string) => {
    if (waiting === undefined) throw new VerifyError("noCode");
    if (code !== CODE) {
      tries -= 1;
      throw new VerifyError(tries === 0 ? "tooManyTries" : "wrongCode", tries);
    }
    if (refuseVerify !== undefined) throw new VerifyError(refuseVerify);
  };
  return {
    calls,
    email: async () => (configured(), address),
    requestEmailCode: async (to, token) => {
      calls.push(`requestEmailCode ${to} ${token}`);
      configured();
      if (refuseRequest !== undefined) throw new VerifyError(refuseRequest);
      waiting = to;
      tries = 5;
    },
    verifyEmailCode: async (code) => {
      calls.push(`verifyEmailCode ${code}`);
      check(code);
      address = { address: waiting ?? "", verifiedAt: "2026-10-22T09:30:00.000Z" };
      waiting = undefined;
    },
    phone: async () => (configured(), verified),
    requestPhoneCode: async (number, token) => {
      calls.push(`requestPhoneCode ${number} ${token}`);
      configured();
      if (refuseRequest !== undefined) throw new VerifyError(refuseRequest);
      waiting = number;
      tries = 5;
    },
    verifyPhoneCode: async (number, code) => {
      calls.push(`verifyPhoneCode ${number} ${code}`);
      if (number !== waiting) throw new VerifyError("noCode");
      check(code);
      verified = { verifiedOn: "2026-10-22" };
      waiting = undefined;
    },
  };
}

/**
 * Turnstile's stand-in: a button in the check's place that solves it, or a
 * check that can't load. Each solve's action is kept.
 */
function fakeChallenge({ unavailable = false } = {}): Challenge & { actions: string[] } {
  const actions: string[] = [];
  return {
    actions,
    solve: (container, action, signal) => {
      actions.push(action);
      if (unavailable) return Promise.reject(new ChallengeError());
      return new Promise((resolve, reject) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "I'm a person";
        button.onclick = () => {
          button.remove();
          resolve(`token-${actions.length}`);
        };
        signal.addEventListener("abort", () => {
          button.remove();
          reject(signal.reason);
        });
        container.append(button);
      });
    },
  };
}

const calls = (client: unknown) => (client as ReturnType<typeof fakeVerify>).calls;
const actions = (challenge: unknown) => (challenge as ReturnType<typeof fakeChallenge>).actions;

/** One step's section, by its heading. */
const step = async (canvas: ReturnType<typeof within>, name: string) =>
  within(
    (await canvas.findByRole("heading", { level: 2, name })).closest("section") as HTMLElement,
  );

const meta = {
  component: VerifyPage,
  args: { client: fakeVerify(), challenge: fakeChallenge() },
} satisfies Meta<typeof VerifyPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Neither verified yet: each step opens on its form. */
export const NotVerified: Story = {
  args: { client: fakeVerify(), challenge: fakeChallenge() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const email = await step(canvas, "Your e-mail address");
    await expect(await email.findByText("No address is verified yet.")).toBeVisible();
    await expect(email.getByLabelText("E-mail address")).toHaveAttribute("type", "email");
    const phone = await step(canvas, "Your phone number");
    await expect(await phone.findByText("No phone number is verified yet.")).toBeVisible();
    await expect(phone.getByLabelText("Phone number")).toHaveAttribute("autocomplete", "tel");
    await expect(canvas.getByRole("link", { name: "Back to your account" })).toHaveAttribute(
      "href",
      "/account",
    );
  },
};

/** An address: the check for `email-code`, the code, and the address verified. */
export const VerifiesEmail: Story = {
  args: { client: fakeVerify(), challenge: fakeChallenge() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const email = await step(canvas, "Your e-mail address");
    await userEvent.type(email.getByLabelText("E-mail address"), " sam@example.org ");
    await userEvent.click(email.getByRole("button", { name: "Send a code" }));
    await expect(email.getByRole("status")).toHaveTextContent("Complete the check");
    await userEvent.click(await email.findByRole("button", { name: "I'm a person" }));
    await expect(await email.findByLabelText("Code")).toBeVisible();
    await expect(email.getByRole("status")).toHaveTextContent(
      "We sent a message to sam@example.org.",
    );
    await expect(actions(args.challenge)).toEqual(["email-code"]);
    await expect(calls(args.client)).toEqual(["requestEmailCode sam@example.org token-1"]);
    // Focus is back on the step's heading, the button that had it gone.
    await expect(email.getByRole("heading", { level: 2 })).toHaveFocus();

    await userEvent.type(email.getByLabelText("Code"), CODE);
    await userEvent.click(email.getByRole("button", { name: "Verify" }));
    await expect(await email.findByText(/^Verified: sam@example\.org, on/)).toBeVisible();
    await expect(email.getByRole("status")).toHaveTextContent("Your e-mail address is verified.");
    await expect(email.queryByLabelText("Code")).toBeNull();
    await expect(email.getByRole("button", { name: "Use another address" })).toBeVisible();
  },
};

/** A number: a wrong code says how many tries are left; the number goes again with the code. */
export const VerifiesPhone: Story = {
  args: { client: fakeVerify(), challenge: fakeChallenge() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const phone = await step(canvas, "Your phone number");
    await userEvent.type(phone.getByLabelText("Phone number"), "(415) 555-0100");
    await userEvent.click(phone.getByRole("button", { name: "Send a code" }));
    await userEvent.click(await phone.findByRole("button", { name: "I'm a person" }));
    await expect(await phone.findByRole("status")).toHaveTextContent(
      "If (415) 555-0100 can take a code, one is on its way",
    );
    await expect(actions(args.challenge)).toEqual(["phone-code"]);

    await userEvent.type(await phone.findByLabelText("Code"), "000000");
    await userEvent.click(phone.getByRole("button", { name: "Verify" }));
    await expect(await phone.findByRole("alert")).toHaveTextContent(
      "That code isn't right. Tries left for this code: 4.",
    );
    await expect(phone.getByLabelText("Code")).toHaveAttribute("aria-invalid", "true");

    await userEvent.clear(phone.getByLabelText("Code"));
    await userEvent.type(phone.getByLabelText("Code"), CODE);
    await userEvent.click(phone.getByRole("button", { name: "Verify" }));
    await expect(await phone.findByText(/^Verified on October 22, 2026\./)).toBeVisible();
    await expect(phone.queryByRole("alert")).toBeNull();
    await expect(calls(args.client)).toEqual([
      "requestPhoneCode (415) 555-0100 token-1",
      "verifyPhoneCode (415) 555-0100 000000",
      `verifyPhoneCode (415) 555-0100 ${CODE}`,
    ]);
    // The number is gone from the page once verified: it isn't kept anywhere.
    await userEvent.click(phone.getByRole("button", { name: "Use another number" }));
    await expect(phone.getByLabelText("Phone number")).toHaveValue("");
    // And the "verified" notice goes with the old number.
    await expect(phone.getByRole("status")).toBeEmptyDOMElement();
  },
};

/** Already verified: what is held, and a way to change it. */
export const Verified: Story = {
  args: {
    client: fakeVerify({
      email: { address: "sam@example.org", verifiedAt: "2026-10-01T12:00:00.000Z" },
      phone: { verifiedOn: "2026-10-02" },
    }),
    challenge: fakeChallenge(),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const email = await step(canvas, "Your e-mail address");
    await expect(
      await email.findByText(/^Verified: sam@example\.org, on October 1, 2026.* UTC\.$/),
    ).toBeVisible();
    await expect(email.queryByLabelText("E-mail address")).toBeNull();
    await userEvent.click(email.getByRole("button", { name: "Use another address" }));
    await expect(email.getByLabelText("E-mail address")).toBeVisible();
    // Changing it can be left again, with what is held still shown.
    await userEvent.click(email.getByRole("button", { name: "Cancel" }));
    await expect(email.queryByLabelText("E-mail address")).toBeNull();
    await expect(email.getByRole("button", { name: "Use another address" })).toBeVisible();
    const phone = await step(canvas, "Your phone number");
    await expect(await phone.findByText(/^Verified on October 2, 2026\./)).toBeVisible();
  },
};

/** A virtual number is refused in the ADR's words, and the form stays to try another. */
export const VirtualNumber: Story = {
  args: { client: fakeVerify({ refuseRequest: "virtualNumber" }), challenge: fakeChallenge() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const phone = await step(canvas, "Your phone number");
    await userEvent.type(phone.getByLabelText("Phone number"), "+1 415 555 0100");
    await userEvent.click(phone.getByRole("button", { name: "Send a code" }));
    await userEvent.click(await phone.findByRole("button", { name: "I'm a person" }));
    await expect(await phone.findByRole("alert")).toHaveTextContent(
      "This looks like an internet or virtual number. Please use a mobile or home phone.",
    );
    await expect(phone.getByLabelText("Phone number")).toHaveValue("+1 415 555 0100");
    await expect(phone.queryByLabelText("Code")).toBeNull();
  },
};

/** A number another account holds is refused only with its right code, and the step starts over. */
export const NumberHeld: Story = {
  args: { client: fakeVerify({ refuseVerify: "numberHeld" }), challenge: fakeChallenge() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const phone = await step(canvas, "Your phone number");
    await userEvent.type(phone.getByLabelText("Phone number"), "4155550100");
    await userEvent.click(phone.getByRole("button", { name: "Send a code" }));
    await userEvent.click(await phone.findByRole("button", { name: "I'm a person" }));
    await userEvent.type(await phone.findByLabelText("Code"), CODE);
    await userEvent.click(phone.getByRole("button", { name: "Verify" }));
    await expect(await phone.findByRole("alert")).toHaveTextContent(
      "another account holds it, or one let it go less than 90 days ago",
    );
    await expect(phone.queryByLabelText("Code")).toBeNull();
    await expect(phone.getByLabelText("Phone number")).toBeVisible();
  },
};

/** Typing nothing asks for the address before any check is shown. */
export const NothingTyped: Story = {
  args: { client: fakeVerify(), challenge: fakeChallenge() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const email = await step(canvas, "Your e-mail address");
    await userEvent.click(email.getByRole("button", { name: "Send a code" }));
    await expect(await email.findByRole("alert")).toHaveTextContent("Enter your e-mail address.");
    await expect(actions(args.challenge)).toEqual([]);
  },
};

/** The check can't load: nothing is sent, and the form stays. */
export const ChallengeUnavailable: Story = {
  args: { client: fakeVerify(), challenge: fakeChallenge({ unavailable: true }) },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const email = await step(canvas, "Your e-mail address");
    await userEvent.type(email.getByLabelText("E-mail address"), "sam@example.org");
    await userEvent.click(email.getByRole("button", { name: "Send a code" }));
    await expect(await email.findByRole("alert")).toHaveTextContent(
      "The check that you're a person couldn't load.",
    );
    await expect(calls(args.client)).toEqual([]);
    await expect(email.getByRole("button", { name: "Send a code" })).toBeEnabled();
    // The failure isn't the address's: the field isn't marked invalid.
    await expect(email.getByLabelText("E-mail address")).not.toHaveAttribute("aria-invalid");
  },
};

/** No Turnstile site key on this site: no code can be asked for. */
export const NoSiteKey: Story = {
  args: { client: fakeVerify(), challenge: undefined },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const email = await step(canvas, "Your e-mail address");
    await userEvent.type(email.getByLabelText("E-mail address"), "sam@example.org");
    await userEvent.click(email.getByRole("button", { name: "Send a code" }));
    await expect(await email.findByRole("alert")).toHaveTextContent(
      "This site can't verify this yet.",
    );
    await expect(calls(args.client)).toEqual([]);
  },
};

/** Neither provider is configured here (staging until the owner signs up): no form at all. */
export const Unavailable: Story = {
  args: { client: fakeVerify({ unavailable: true }), challenge: fakeChallenge() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getAllByText("This site can't verify this yet.")).toHaveLength(2),
    );
    await expect(canvas.queryByRole("textbox")).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Send a code" })).toBeNull();
  },
};
