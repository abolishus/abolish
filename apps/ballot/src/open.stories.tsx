import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { App } from "./app.tsx";
import type { CheckedElection, ElectionCheck } from "./election.ts";
import { parseLink } from "./link.ts";
import type { Loaded } from "./load.ts";
import { BrokenLink, Checking, type ElectionSource, Unavailable } from "./open.tsx";

// Opening a poll from its link (open.tsx), with the network and the worker
// replaced by a source that answers at once: what each end of the fetch and
// the check shows, and that a checked poll's questions follow.

const ELECTION_ID = "5d2c9a40b7e31f6688c0a1d2e3f405162738495a6b7c8d9eaf01b2c3d4e5f607";
const REGISTERED = "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
const SERVED = "9c1e77a04b2d3f60e8a5c1d27b9043fe6a18c5d2e7f04b3a96c8d1e2f3a4b5c6";
const ORIGIN = "https://ballot.example";

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const QUESTION = "Which one improvement matters most to you?";

const option = (label: string, description = "") => ({ label, description });

const ELECTION: CheckedElection = {
  electionId: ELECTION_ID,
  definitionHash: REGISTERED,
  electionType: "plurality",
  minSelections: 0,
  maxSelections: 1,
  opensAt: 1_790_000_000n,
  closesAt: 1_792_000_000n,
  translations: [
    {
      language: "en",
      question: QUESTION,
      description: "",
      options: [
        option("Better lighting on the river path"),
        option("Public toilets open all year"),
        option("Two hundred new street trees"),
      ],
    },
    {
      language: "es",
      question: "¿Qué mejora le importa más?",
      description: "",
      options: [
        option("Mejor iluminación en el camino del río"),
        option("Baños públicos abiertos todo el año"),
        option("Doscientos árboles nuevos"),
      ],
    },
  ],
};

const LOADED: Loaded = {
  ok: true,
  registeredHash: fromHex(REGISTERED),
  definition: new Uint8Array(8),
  displayText: new Uint8Array(8),
};

/** A source whose loads answer from `loads` in turn (the last one repeats) and whose check answers `check`. */
function source(loads: readonly Loaded[], check: ElectionCheck | "fail"): ElectionSource {
  let call = 0;
  return {
    load: () => Promise.resolve(loads[Math.min(call++, loads.length - 1)] as Loaded),
    check: () =>
      check === "fail" ? Promise.reject(new Error("worker stopped")) : Promise.resolve(check),
  };
}

const meta = {
  title: "Ballot/Open",
  component: App,
  parameters: { layout: "fullscreen" },
  args: {
    link: parseLink(`#election=${ELECTION_ID}`),
    source: source([LOADED], { ok: true, election: ELECTION }),
    origin: ORIGIN,
    languages: ["en-US"],
  },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

const opens: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(await canvas.findByRole("heading", { level: 1, name: QUESTION })).toBeVisible();
  // The checked poll's seal, in the frame and in the arrival line.
  await expect(canvas.getByText("This is the real poll, checked")).toBeVisible();
  await expect(
    canvas.getAllByRole("img", { name: "Seal of this poll, 3f8a 0c51" })[0],
  ).toBeVisible();
  // A version-1 definition names no one who asked, so the frame names the election.
  await expect(canvas.getByText("Election 3f8a 0c51")).toBeVisible();
  for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
  await userEvent.click(canvas.getByText("Two hundred new street trees"));
  await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
  await userEvent.click(canvas.getByRole("button", { name: "Send my answers" }));
  // Nothing is sealed or sent yet, and the client says so.
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "Your answers weren't sent",
  );
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
  await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
  // A fresh start: nothing chosen carries over.
  for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
};

export const Opens: Story = { name: "A checked poll opens", play: opens };

export const OpensDark: Story = {
  name: "A checked poll opens, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  play: opens,
};

export const InTheReadersLanguage: Story = {
  name: "In the reader's language",
  args: { languages: ["es-MX", "en-US"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "¿Qué mejora le importa más?" }),
    ).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Doscientos árboles nuevos" })).toBeVisible();
  },
};

export const RefusedByTheCheck: Story = {
  name: "Refused by the worker's check",
  args: {
    source: source([LOADED], {
      ok: false,
      problem: "unregistered-definition",
      servedHash: SERVED,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Don't vote from this link" }),
    ).toBeVisible();
    await expect(canvas.getByText("The election doesn't match the registry")).toBeVisible();
    // Both fingerprints, the registry's and the served one's, and no poll text.
    await expect(
      canvas.getByRole("img", { name: "Fingerprint of the registered definition, 3f8a 0c51" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("img", {
        name: "Fingerprint of the definition this link served, 9c1e 77a0",
      }),
    ).toBeVisible();
    await expect(canvas.queryByRole("radio")).toBeNull();
  },
};

export const RetriedAfterAFailure: Story = {
  name: "Unreachable, then tried again",
  args: {
    source: source([{ ok: false, problem: "unreachable" }, LOADED], {
      ok: true,
      election: ELECTION,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "This device couldn't reach the servers",
      }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(await canvas.findByRole("heading", { level: 1, name: QUESTION })).toBeVisible();
  },
};

export const WorkerFailed: Story = {
  name: "The worker failed",
  args: { source: source([LOADED], "fail") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "This device couldn't check the poll" }),
    ).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(canvas.queryByRole("radio")).toBeNull();
  },
};

export const ACheckInProgress: Story = {
  name: "Checking",
  render: () => <Checking />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("Checking this poll");
    await expect(canvas.getByRole("status")).toHaveTextContent(/election registry/);
    // No poll text and nothing to press before the check passes.
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvas.queryByRole("img")).toBeNull();
  },
};

export const AFragmentThatNamesNoPoll: Story = {
  name: "A link that names no poll",
  args: { link: parseLink("#election=5d2c") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This link doesn't open a poll",
    );
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const ABrokenLink: Story = {
  name: "Broken link, dark",
  parameters: { layout: "fullscreen", theme: "dark" },
  render: () => <BrokenLink />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("heading", { level: 1 })).toHaveTextContent(
      "This link doesn't open a poll",
    );
  },
};

const unavailable = (
  name: string,
  problem: Parameters<typeof Unavailable>[0]["problem"],
  title: string,
  retry: boolean,
): Story => ({
  name,
  render: () => <Unavailable problem={problem} onRetry={onRetry} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(title);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(canvas.queryByRole("radio")).toBeNull();
    const button = canvas.queryByRole("button", { name: "Try again" });
    if (!retry) {
      await expect(button).toBeNull();
      return;
    }
    onRetry.mockClear();
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledOnce());
  },
});

const onRetry = fn();

export const NoRegistry = unavailable(
  "No registry pinned",
  "no-registry",
  "This copy of the ballot can't check polls yet",
  false,
);
export const WrongChain = unavailable(
  "Another chain",
  "wrong-chain",
  "The election registry couldn't be read",
  true,
);
export const NotRegistered = unavailable(
  "Not registered",
  "not-registered",
  "This poll isn't registered",
  true,
);
export const NotFound = unavailable(
  "Not on the server",
  "not-found",
  "This poll's questions aren't available",
  true,
);
export const Withheld = unavailable(
  "Withheld under moderation",
  "withheld",
  "This poll's wording is withheld",
  false,
);
export const BadAnswer = unavailable(
  "A malformed answer",
  "bad-answer",
  "A server sent something that isn't a poll",
  true,
);
