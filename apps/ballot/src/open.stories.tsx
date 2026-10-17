import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { App } from "./app.tsx";
import type { CheckedElection, ElectionCheck } from "./election.ts";
import { parseLink } from "./link.ts";
import type { Loaded } from "./load.ts";
import { BrokenLink, Checking, type ElectionSource, Unavailable } from "./open.tsx";
import type { ChallengeResult, SealResult } from "./worker/protocol.ts";

// Opening a poll from its link (open.tsx), with the network and the worker
// replaced by a source that answers at once: what each end of the fetch and
// the check shows, and that a checked poll's questions follow.

const ELECTION_ID = "5d2c9a40b7e31f6688c0a1d2e3f405162738495a6b7c8d9eaf01b2c3d4e5f607";
const REGISTERED = "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718";
const SERVED = "9c1e77a04b2d3f60e8a5c1d27b9043fe6a18c5d2e7f04b3a96c8d1e2f3a4b5c6";
const CODE = "c0de5eed0123456789abcdef0123456789abcdef0123456789abcdef01234567";
const ORIGIN = "https://ballot.example";

const fromHex = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));

const QUESTION = "Which one improvement matters most to you?";

const option = (label: string, description = "") => ({ label, description });

const ELECTION: CheckedElection = {
  electionId: ELECTION_ID,
  definitionHash: REGISTERED,
  version: 1,
  questions: [{ minSelections: 0, maxSelections: 1 }],
  cells: 0,
  opensAt: 1_790_000_000n,
  closesAt: 1_792_000_000n,
  translations: [
    {
      language: "en",
      title: "",
      description: "",
      questions: [
        {
          question: QUESTION,
          description: "",
          options: [
            option("Better lighting on the river path"),
            option("Public toilets open all year"),
            option("Two hundred new street trees"),
          ],
        },
      ],
    },
    {
      language: "es",
      title: "",
      description: "",
      questions: [
        {
          question: "¿Qué mejora le importa más?",
          description: "",
          options: [
            option("Mejor iluminación en el camino del río"),
            option("Baños públicos abiertos todo el año"),
            option("Doscientos árboles nuevos"),
          ],
        },
      ],
    },
  ],
};

const LOADED: Loaded = {
  ok: true,
  registeredHash: fromHex(REGISTERED),
  definition: new Uint8Array(8),
  displayText: new Uint8Array(8),
  entries: [],
};

const SEALED: SealResult = { ok: true, seal: 7, trackingCode: fromHex(CODE) };
const OPENING = Uint8Array.from({ length: 96 }, (_, i) => i);
const OPENED: ChallengeResult = { ok: true, opening: OPENING, trackingCode: fromHex(CODE) };

type Mock<F extends (...args: never[]) => unknown> = F & ReturnType<typeof fn<F>>;

/** The mocks behind a story's source, to assert on. */
const MOCKS = new WeakMap<
  ElectionSource,
  {
    readonly load: Mock<ElectionSource["load"]>;
    readonly seal: Mock<ElectionSource["seal"]>;
    readonly challenge: Mock<ElectionSource["challenge"]>;
  }
>();
const mocks = (of: ElectionSource) => {
  const found = MOCKS.get(of);
  if (found === undefined) throw new Error("not a story's source");
  return found;
};

/**
 * A source whose loads answer from `loads` in turn (the last one repeats),
 * whose check answers `check`, and whose seal and challenge answer `sealed`
 * and `opened`.
 */
function source(
  loads: readonly Loaded[],
  check: ElectionCheck | "fail",
  sealed: SealResult | "fail" = SEALED,
  opened: ChallengeResult | "fail" = OPENED,
): ElectionSource {
  let call = 0;
  const answer = <T,>(result: T | "fail") =>
    result === "fail" ? Promise.reject(new Error("worker stopped")) : Promise.resolve(result);
  const load = fn<ElectionSource["load"]>(() =>
    Promise.resolve(loads[Math.min(call++, loads.length - 1)] as Loaded),
  );
  const seal = fn<ElectionSource["seal"]>(() => answer(sealed));
  const challenge = fn<ElectionSource["challenge"]>(() => answer(opened));
  const made: ElectionSource = { load, check: () => answer(check), seal, challenge };
  MOCKS.set(made, { load, seal, challenge });
  return made;
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
  await userEvent.click(canvas.getByRole("button", { name: "Seal my answers" }));
  // No poll creates version-1 definitions, and this client never seals one.
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "This ballot can't seal answers for this poll yet",
  );
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
  await expect(canvas.getByText(/an older kind/)).toBeVisible();
  await expect(canvas.queryByRole("button")).toBeNull();
};

export const Opens: Story = { name: "A checked poll opens", play: opens };

const FIRST = "Should the park stay open late?";
const SECOND = "Should the library open on Sundays?";

/** A version-5 poll of two questions, the second required: what P2-22 creates. */
const POLL_OF_QUESTIONS: CheckedElection = {
  ...ELECTION,
  version: 5,
  questions: [
    { minSelections: 0, maxSelections: 1 },
    { minSelections: 1, maxSelections: 1 },
  ],
  cells: 1,
  translations: [
    {
      language: "en",
      title: "Park and library",
      description: "",
      questions: [
        { question: FIRST, description: "", options: [option("Yes"), option("No")] },
        { question: SECOND, description: "", options: [option("Yes"), option("No")] },
      ],
    },
  ],
};

export const OpensQuestions: Story = {
  name: "A checked poll of two questions opens",
  args: { source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("heading", { level: 1, name: FIRST })).toBeVisible();
    await expect(canvas.getByText("Question 1 of 2")).toBeVisible();
    await userEvent.click(canvas.getByText("Yes"));
    await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
    // Each question in the definition's order, with its own limits: the second can't be skipped.
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(SECOND);
    await expect(canvas.getByText("Question 2 of 2")).toBeVisible();
    await userEvent.click(canvas.getByText("No"));
    await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
    await expect(canvas.getByText(FIRST)).toBeVisible();
    await expect(canvas.getByText(SECOND)).toBeVisible();
  },
};

/** Answers both questions of POLL_OF_QUESTIONS (yes, then no) and seals them. */
async function answerAndSeal(canvas: ReturnType<typeof within>) {
  await userEvent.click(await canvas.findByText("Yes"));
  await userEvent.click(canvas.getByRole("button", { name: "Next question" }));
  await userEvent.click(canvas.getByText("No"));
  await userEvent.click(canvas.getByRole("button", { name: "Check your answers" }));
  await userEvent.click(canvas.getByRole("button", { name: "Seal my answers" }));
}

export const SealedThenCast: Story = {
  name: "Sealed: the tracking code before the choice, then cast",
  args: { source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your answers are sealed" }),
    ).toHaveFocus();
    // The poll's one cell, and one vote per option, every question's in order.
    await expect(mocks(args.source).seal).toHaveBeenCalledOnce();
    await expect(mocks(args.source).seal).toHaveBeenCalledWith(
      fromHex(REGISTERED),
      0,
      [1, 0, 0, 1],
    );
    // The full code, as a QR code, a fingerprint and hex, before either choice.
    await expect(
      canvas.getByRole("img", { name: "QR code of the tracking code c0de 5eed" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("img", { name: "Fingerprint of the tracking code c0de 5eed" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("figure", { name: "Tracking code of your sealed ballot" }),
    ).toHaveTextContent(CODE);
    await expect(canvas.getByRole("button", { name: "Check the encryption first" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Cast this ballot" }));
    // Sending is part 3c: nothing leaves, the client says so, and the seal is never opened.
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Your answers weren't sent",
    );
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveFocus();
    await expect(mocks(args.source).challenge).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
    // A fresh start: nothing chosen carries over.
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(FIRST);
    for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
  },
};

export const SealedThenChallenged: Story = {
  name: "Sealed, then challenged: the opening for the other device",
  args: { source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    // A double tap asks once.
    await userEvent.dblClick(
      await canvas.findByRole("button", { name: "Check the encryption first" }),
    );
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your sealed ballot is opened" }),
    ).toHaveFocus();
    await expect(mocks(args.source).challenge).toHaveBeenCalledOnce();
    await expect(mocks(args.source).challenge).toHaveBeenCalledWith(7);
    await expect(
      canvas.getByRole("figure", { name: "The tracking code it opened" }),
    ).toHaveTextContent(CODE);
    // The opening's bytes as a file; this device never says what it holds.
    const save = await canvas.findByRole("link", { name: "Save the opening" });
    await expect(save).toHaveAttribute("download", "abolish-opening-c0de5eed01234567.bin");
    const href = save.getAttribute("href") ?? "";
    await expect(href).toMatch(/^blob:/);
    const saved = new Uint8Array(await (await fetch(href)).arrayBuffer());
    await expect(saved).toEqual(OPENING);
    await expect(canvas.queryByText("Yes")).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Cast this ballot" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(FIRST);
    for (const radio of canvas.getAllByRole("radio")) await expect(radio).not.toBeChecked();
  },
};

export const OpenedAnotherCode: Story = {
  name: "Challenged, and the opening is of another code",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, {
      ...OPENED,
      trackingCode: fromHex(SERVED),
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Check the encryption first" }),
    );
    // Never handed over: the worker opened a core other than the one shown.
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "This device couldn't open the sealed ballot",
      }),
    ).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "Save the opening" })).toBeNull();
  },
};

export const SealRefused: Story = {
  name: "The worker refused to seal, then the poll is checked again",
  args: {
    source: source(
      [LOADED],
      { ok: true, election: POLL_OF_QUESTIONS },
      {
        ok: false,
        problem: "no-election",
      },
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "This device couldn't seal your answers",
      }),
    ).toHaveFocus();
    await expect(mocks(args.source).load).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
    // The worker holds the poll it seals for, so it is checked anew.
    await expect(await canvas.findByRole("heading", { level: 1, name: FIRST })).toBeVisible();
    await expect(mocks(args.source).load).toHaveBeenCalledTimes(2);
  },
};

export const SealWorkerFailed: Story = {
  name: "The worker failed while sealing",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, "fail"),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "This device couldn't seal your answers",
      }),
    ).toBeVisible();
  },
};

export const SplitIntoCells: Story = {
  name: "A poll of several cells isn't sealed yet",
  args: {
    source: source([LOADED], { ok: true, election: { ...POLL_OF_QUESTIONS, cells: 2 } }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "This ballot can't seal answers for this poll yet",
    );
    await expect(canvas.getByText(/split by region/)).toBeVisible();
    await expect(mocks(args.source).seal).not.toHaveBeenCalled();
  },
};

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
    // Marked as Spanish for assistive technology, inside the English screens.
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveAttribute("lang", "es");
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
