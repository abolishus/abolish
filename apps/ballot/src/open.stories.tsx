import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { App } from "./app.tsx";
import type { CheckedElection, ElectionCheck } from "./election.ts";
import type { IdentityRead } from "./identity.ts";
import { parseLink } from "./link.ts";
import type { Loaded, LoadedBoard } from "./load.ts";
import type { ProverArtifacts } from "./prover-artifacts.ts";
import {
  type ArtifactProblem,
  BrokenLink,
  type CellAnswer,
  Checking,
  type ElectionSource,
  type L1Block,
  Unavailable,
} from "./open.tsx";
import type { CastResult, ChallengeResult, SealResult } from "./worker/protocol.ts";

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
  tiers: [],
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

const SECRET = fromHex(`01${"0b".repeat(31)}`);
const IDENTITY: IdentityRead = {
  kind: "found",
  identity: { secret: SECRET, memberships: [{ tier: 0, group: 5n }] },
};
const BOARD_ENTRY = Uint8Array.of(1, 2, 3);
const BOARD: LoadedBoard = { ok: true, entries: [BOARD_ENTRY] };
const CELL: CellAnswer = { ok: true, cell: 2 };
const L1: L1Block = { number: 21_000_000n, hash: fromHex("e1".repeat(32)) };
const ARTIFACTS: ProverArtifacts = { zkey: new Uint8Array(4), wasm: new Uint8Array(4) };
const CAST: CastResult = {
  ok: true,
  ballot: new Uint8Array(8),
  ballotHash: new Uint8Array(32),
  ciphertexts: [],
};

/** The voter's side of a story's source: what the device holds and what the board and the cast answer. */
interface Voter {
  readonly identity: IdentityRead;
  readonly board: LoadedBoard;
  readonly cell: CellAnswer | "fail";
  readonly l1: L1Block | undefined;
  readonly artifacts: ProverArtifacts | ArtifactProblem;
  /** `hold`: the cast reports a step, then waits for `release`. */
  readonly cast: CastResult | "fail" | "hold";
  /** The identity read at the cast, when it isn't the first read's. */
  readonly identityAtCast?: IdentityRead;
}

const VOTER: Voter = {
  identity: IDENTITY,
  board: BOARD,
  cell: CELL,
  l1: L1,
  artifacts: ARTIFACTS,
  cast: CAST,
};

type Mock<F extends (...args: never[]) => unknown> = F & ReturnType<typeof fn<F>>;

/** The mocks behind a story's source, to assert on. */
const MOCKS = new WeakMap<
  ElectionSource,
  {
    readonly load: Mock<ElectionSource["load"]>;
    readonly seal: Mock<ElectionSource["seal"]>;
    readonly challenge: Mock<ElectionSource["challenge"]>;
    readonly loadBoard: Mock<ElectionSource["loadBoard"]>;
    readonly findCell: Mock<ElectionSource["findCell"]>;
    readonly cast: Mock<ElectionSource["cast"]>;
    /** Each secret the page handed on, as given, and a copy taken when it was. */
    readonly secrets: { readonly given: Uint8Array; readonly copy: Uint8Array }[];
    /** Finishes a held cast. */
    readonly release: () => void;
  }
>();
const mocks = (of: ElectionSource) => {
  const found = MOCKS.get(of);
  if (found === undefined) throw new Error("not a story's source");
  return found;
};

/**
 * A source whose loads answer from `loads` in turn (the last one repeats),
 * whose check answers `check`, whose seal and challenge answer `sealed`
 * and `opened`, and whose identity, board, cell, L1 block and cast are
 * `voter`'s. Each identity read hands out a fresh copy of the secret, as
 * identity.ts does.
 */
function source(
  loads: readonly Loaded[],
  check: ElectionCheck | "fail",
  sealed: SealResult | "fail" = SEALED,
  opened: ChallengeResult | "fail" = OPENED,
  voter: Partial<Voter> = {},
): ElectionSource {
  const {
    identity,
    board,
    cell,
    l1,
    artifacts,
    cast: casts,
    identityAtCast,
  } = {
    ...VOTER,
    ...voter,
  };
  let reads = 0;
  let call = 0;
  const answer = <T,>(result: T | "fail") =>
    result === "fail" ? Promise.reject(new Error("worker stopped")) : Promise.resolve(result);
  const secrets: { given: Uint8Array; copy: Uint8Array }[] = [];
  const handed = (secret: Uint8Array) => secrets.push({ given: secret, copy: secret.slice() });
  let release = () => {};
  const load = fn<ElectionSource["load"]>(() =>
    Promise.resolve(loads[Math.min(call++, loads.length - 1)] as Loaded),
  );
  const seal = fn<ElectionSource["seal"]>(() => answer(sealed));
  const challenge = fn<ElectionSource["challenge"]>(() => answer(opened));
  const loadBoard = fn<ElectionSource["loadBoard"]>(() => Promise.resolve(board));
  const findCell = fn<ElectionSource["findCell"]>((_, secret) => {
    handed(secret);
    return answer(cell);
  });
  const cast = fn<ElectionSource["cast"]>((_, secret, __, ___, onProgress) => {
    handed(secret);
    if (casts !== "hold") return answer(casts);
    onProgress(2, 5);
    return new Promise((resolve) => (release = () => resolve(CAST)));
  });
  const made: ElectionSource = {
    load,
    check: () => answer(check),
    seal,
    challenge,
    identity: () => {
      const read = reads++ > 0 && identityAtCast !== undefined ? identityAtCast : identity;
      return Promise.resolve(
        read.kind === "found"
          ? { kind: "found", identity: { ...read.identity, secret: SECRET.slice() } }
          : read,
      );
    },
    loadArtifacts: () => Promise.resolve(artifacts),
    loadBoard,
    findCell,
    l1Block: () => Promise.resolve(l1),
    cast,
  };
  MOCKS.set(made, {
    load,
    seal,
    challenge,
    loadBoard,
    findCell,
    cast,
    secrets,
    release: () => release(),
  });
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
  tiers: [0],
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

/** Every secret the page handed on was zeroed after, and each was the device's. */
async function zeroedAfterUse(of: ElectionSource, count: number) {
  const { secrets } = mocks(of);
  await expect(secrets).toHaveLength(count);
  for (const { given, copy } of secrets) {
    await expect(copy).toEqual(SECRET);
    await expect(given.every((b) => b === 0)).toBe(true);
  }
}

export const SealedThenCast: Story = {
  name: "Found on the list, sealed, then cast through the proof",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cast: "hold",
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your answers are sealed" }),
    ).toHaveFocus();
    // The whole board, by the election alone, and the voter's cell from it in their tier and group.
    await expect(mocks(args.source).loadBoard).toHaveBeenCalledOnce();
    await expect(mocks(args.source).loadBoard).toHaveBeenCalledWith(fromHex(ELECTION_ID));
    await expect(mocks(args.source).findCell).toHaveBeenCalledOnce();
    await expect(mocks(args.source).findCell).toHaveBeenCalledWith(
      fromHex(REGISTERED),
      expect.any(Uint8Array),
      { tier: 0, group: 5n },
      [BOARD_ENTRY],
    );
    // That cell, and one vote per option, every question's in order.
    await expect(mocks(args.source).seal).toHaveBeenCalledOnce();
    await expect(mocks(args.source).seal).toHaveBeenCalledWith(
      fromHex(REGISTERED),
      2,
      [1, 0, 0, 1],
    );
    await zeroedAfterUse(args.source, 1);
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
    // A double tap casts once.
    await userEvent.dblClick(canvas.getByRole("button", { name: "Cast this ballot" }));
    // The proof only now, with the prover's own steps.
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Proving you can answer" }),
    ).toHaveFocus();
    await expect(canvas.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "2 of 5 steps");
    await expect(mocks(args.source).cast).toHaveBeenCalledOnce();
    await expect(mocks(args.source).cast).toHaveBeenCalledWith(
      7,
      expect.any(Uint8Array),
      L1,
      ARTIFACTS,
      expect.any(Function),
    );
    mocks(args.source).release();
    // Sending is part 3c: nothing leaves, the client says so, and the seal is never opened.
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your answers weren't sent" }),
    ).toHaveFocus();
    await expect(canvas.getByText(/made your ballot and checked it/)).toBeVisible();
    await zeroedAfterUse(args.source, 2);
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

export const InTheFirstOfItsTiers: Story = {
  name: "A voter in several of the poll's tiers casts in the first",
  args: {
    source: source(
      [LOADED],
      { ok: true, election: { ...POLL_OF_QUESTIONS, tiers: [1, 2] } },
      SEALED,
      OPENED,
      {
        identity: {
          kind: "found",
          identity: {
            secret: SECRET,
            memberships: [
              { tier: 0, group: 5n },
              { tier: 1, group: 9n },
              { tier: 2, group: 12n },
            ],
          },
        },
      },
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your answers are sealed" }),
    ).toBeVisible();
    await expect(mocks(args.source).findCell).toHaveBeenCalledOnce();
    await expect(mocks(args.source).findCell).toHaveBeenCalledWith(
      fromHex(REGISTERED),
      expect.any(Uint8Array),
      { tier: 1, group: 9n },
      [BOARD_ENTRY],
    );
  },
};

/**
 * A story where sealing stops at `title` before any search, with no way to
 * retry. The board is read all the same, whatever the device holds (T-10).
 */
const stopsBeforeTheSearch = (name: string, voter: Partial<Voter>, title: string): Story => ({
  name,
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, voter),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(await canvas.findByRole("heading", { level: 1, name: title })).toHaveFocus();
    await expect(mocks(args.source).loadBoard).toHaveBeenCalledOnce();
    await expect(mocks(args.source).findCell).not.toHaveBeenCalled();
    await expect(mocks(args.source).seal).not.toHaveBeenCalled();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
});

export const NoIdentityOnTheDevice = stopsBeforeTheSearch(
  "No voting identity on this device",
  { identity: { kind: "none" } },
  "This device has no voting identity yet",
);

export const AnUnreadableIdentity = stopsBeforeTheSearch(
  "The voting identity can't be read",
  { identity: { kind: "unreadable" } },
  "The voting identity on this device can't be read",
);

export const NotInThePollsTiers = stopsBeforeTheSearch(
  "Registered only in a tier the poll doesn't list",
  {
    identity: {
      kind: "found",
      identity: { secret: SECRET, memberships: [{ tier: 1, group: 9n }] },
    },
  },
  "You aren't on this poll's list",
);

/** A story where the worker's search answers `cell`, which stops at `title`. */
const searchStops = (name: string, cell: CellAnswer, title: string, retry: boolean): Story => ({
  name,
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, { cell }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(await canvas.findByRole("heading", { level: 1, name: title })).toHaveFocus();
    await expect(mocks(args.source).seal).not.toHaveBeenCalled();
    await zeroedAfterUse(args.source, 1);
    const again = canvas.queryByRole("button", { name: "Answer again" });
    await expect(again !== null).toBe(retry);
  },
});

export const NoRegistrarsPinned = searchStops(
  "A build that pins no group registry",
  { ok: false, problem: "no-registrars" },
  "This copy of the ballot can't find you on a poll's list yet",
  false,
);

export const SearchRefusedTheSecret = searchStops(
  "The worker refused the stored secret",
  { ok: false, problem: "secret" },
  "The voting identity on this device can't be read",
  false,
);

export const SearchForAnotherPoll = searchStops(
  "The worker holds no such poll",
  { ok: false, problem: "no-election" },
  "This device couldn't seal your answers",
  true,
);

export const BoardUnreadable: Story = {
  name: "The board couldn't be read, then the poll is checked again",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      board: { ok: false, problem: "unreachable" },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "The poll's public board couldn't be read",
      }),
    ).toHaveFocus();
    await expect(canvas.getByText("unreachable")).toBeVisible();
    await expect(mocks(args.source).findCell).not.toHaveBeenCalled();
    // The board comes first: the identity wasn't even read.
    await zeroedAfterUse(args.source, 0);
    await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
    await expect(await canvas.findByRole("heading", { level: 1, name: FIRST })).toBeVisible();
    await expect(mocks(args.source).load).toHaveBeenCalledTimes(2);
  },
};

export const NotFoundOnTheBoard: Story = {
  name: "The worker didn't find the voter's cell",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cell: { ok: false, problem: "cell", code: "not-a-member" },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "Your place on the poll's list couldn't be found",
      }),
    ).toHaveFocus();
    await expect(canvas.getByText("not-a-member")).toBeVisible();
    await expect(mocks(args.source).seal).not.toHaveBeenCalled();
    await zeroedAfterUse(args.source, 1);
    await expect(canvas.getByRole("button", { name: "Answer again" })).toBeVisible();
  },
};

export const FindCellWorkerFailed: Story = {
  name: "The worker failed while finding the voter's cell",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cell: "fail",
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "This device couldn't seal your answers",
      }),
    ).toBeVisible();
    await zeroedAfterUse(args.source, 1);
    await expect(canvas.getByRole("button", { name: "Answer again" })).toBeVisible();
  },
};

/** Seals POLL_OF_QUESTIONS and casts it under `voter`, which `title` then stops. */
async function castInto(canvas: ReturnType<typeof within>, title: string) {
  await answerAndSeal(canvas);
  await userEvent.click(await canvas.findByRole("button", { name: "Cast this ballot" }));
  await expect(await canvas.findByRole("heading", { level: 1, name: title })).toHaveFocus();
}

export const NoL1Block: Story = {
  name: "Cast with no L1 block to name",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      l1: undefined,
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This ballot can't read Ethereum yet");
    await expect(mocks(args.source).cast).not.toHaveBeenCalled();
    await expect(mocks(args.source).challenge).not.toHaveBeenCalled();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const CastNotAMember: Story = {
  name: "Cast, and the proof is refused",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cast: { ok: false, problem: "not-a-member" },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "You aren't on this poll's list");
    await expect(canvas.getByText("not-a-member")).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull();
    await zeroedAfterUse(args.source, 2);
  },
};

export const CastWorkerFailed: Story = {
  name: "A worker failed while casting",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cast: "fail",
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device stopped while making the proof");
    // The prover may have seen the witness: no retry (T-55).
    await expect(canvas.queryByRole("button")).toBeNull();
    await zeroedAfterUse(args.source, 2);
  },
};

export const CastFaulty: Story = {
  name: "Cast, and the record fails the device's own check",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cast: { ok: false, problem: "ballot", code: "ballot-cell" },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "Your ballot didn't pass this device's check");
    await expect(canvas.getByText("ballot-cell")).toBeVisible();
    await expect(canvas.queryByRole("button")).toBeNull();
    await zeroedAfterUse(args.source, 2);
  },
};

export const ArtifactsUnavailable: Story = {
  name: "Cast, and the prover's files couldn't be fetched",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      artifacts: { ok: false, problem: "unavailable" },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "The files for making proofs couldn't be fetched");
    // Before any prover or secret: the identity isn't read, and a retry is safe.
    await expect(mocks(args.source).cast).not.toHaveBeenCalled();
    await zeroedAfterUse(args.source, 1);
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await expect(await canvas.findByRole("heading", { level: 1, name: FIRST })).toBeVisible();
    await expect(mocks(args.source).load).toHaveBeenCalledTimes(2);
  },
};

export const CastRootRefused: Story = {
  name: "Cast, and the leaves don't add up to the cell's root",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cast: { ok: false, problem: "root" },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "The list of members doesn't match the poll");
    // Refused before the witness was built: another try fetches the board again.
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
  },
};

export const IdentityGoneAtTheCast: Story = {
  name: "The identity is gone by the time of the cast",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      identityAtCast: { kind: "none" },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device has no voting identity yet");
    await expect(mocks(args.source).cast).not.toHaveBeenCalled();
    await expect(mocks(args.source).challenge).not.toHaveBeenCalled();
  },
};

export const CastUnknownSeal: Story = {
  name: "Cast, and the worker doesn't hold the seal",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cast: { ok: false, problem: "unknown" },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device couldn't make your ballot");
    await expect(canvas.getByText("unknown")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Answer again" })).toBeVisible();
  },
};

export const CastAnotherCell: Story = {
  name: "Cast, and the worker holds no cell for the seal",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      cast: { ok: false, problem: "no-cell" },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device couldn't make your ballot");
    await expect(canvas.getByText("no-cell")).toBeVisible();
    // Refused before any witness: the poll can be checked and answered again.
    await userEvent.click(canvas.getByRole("button", { name: "Answer again" }));
    await expect(await canvas.findByRole("heading", { level: 1, name: FIRST })).toBeVisible();
    await expect(mocks(args.source).challenge).not.toHaveBeenCalled();
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
