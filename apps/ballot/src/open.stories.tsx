import { encodeBoardEntry, RECORD_TYPES } from "@abolishus/crypto";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { App } from "./app.tsx";
import type { Backer } from "./backup-offer.tsx";
import type {
  CastsRead,
  CheckedReceipt,
  RecordBoardedOutcome,
  RecordCastOutcome,
  RecordReceiptOutcome,
} from "./casts.ts";
import type { CheckedElection, ElectionCheck } from "./election.ts";
import type { IdentityRead } from "./identity.ts";
import type { IntakeAnswer } from "./intake.ts";
import { parseLink } from "./link.ts";
import type { Loaded, LoadedBoard, LoadedRegistry } from "./load.ts";
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
import type { Recoverer } from "./recover.tsx";
import type { RecoveryOutcome } from "./recovery.ts";
import type { Registrar } from "./register.tsx";
import type { Tier0Answer } from "./registration.ts";
import type { SendAnswer } from "./send.ts";
import type {
  CastResult,
  ChallengeResult,
  IntakeResult,
  ReceiptResult,
  SealResult,
  Tier0OutcomeResult,
} from "./worker/protocol.ts";

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
  boardEntryVersion: undefined,
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
  hiddenAsThreat: false,
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
/** Bytes under a version-3 ballot record's header, which a board entry carries; the rest is `fill`. */
const ballotBytes = (fill: number) =>
  Uint8Array.of(RECORD_TYPES.ballot >> 8, RECORD_TYPES.ballot & 0xff, 3, ...Array(8).fill(fill));
const CAST: CastResult = {
  ok: true,
  ballot: ballotBytes(0xb0),
  ballotHash: new Uint8Array(32),
  ciphertexts: [1, 3].map((seat) => ({
    seat,
    ciphertext: new Uint8Array(4).fill(seat),
    m: new Uint8Array(32).fill(0x80 + seat),
  })),
};
const LINK = "1c".repeat(32);
const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/** The operator's answer for `payload`: an entry of the poll's pinned version at `index`. */
const boarded = (payload: Uint8Array, index = 41n): SendAnswer => ({
  kind: "boarded",
  entry: toHex(
    encodeBoardEntry({ election_id: fromHex(ELECTION_ID), index, segment: 0, payload }, 5),
  ),
  link: LINK,
});
const BOARDED = boarded(CAST.ballot);
const STUB = Uint8Array.of(0x00, 0x01, 0x05, 0x57);
const TRANSCRIPT = Uint8Array.of(0x00, 0x09, 0x01, 0x7c);
const INTAKE: IntakeResult = { ok: true, stub: STUB, transcript: TRANSCRIPT };
/** A seat's intake answer: a receipt the stories' worker reads the seat from. */
const receiptOf = (seat: number): IntakeAnswer => ({
  kind: "receipt",
  receipt: Uint8Array.of(0xec, seat),
});
type CheckedAnswer =
  | { readonly ok: true; readonly checked: CheckedReceipt }
  | Extract<ReceiptResult, { readonly ok: false }>;
/** The stories' worker passes a receipt `receiptOf` made for its seat. */
const passes = (receipt: Uint8Array): CheckedAnswer => ({
  ok: true,
  checked: { seat: receipt[1] ?? 0, receipt } as unknown as CheckedReceipt,
});

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
  /** Tier 0 registration (`registrar`), whose store then answers every identity read. */
  readonly registrar?: Registrar;
  /** The worker's stub and transcript for each seat's intake. */
  readonly intake: IntakeResult | "fail";
  /** What seat `seat`'s intake answers to its `call`th delivery (from 0). */
  readonly delivered: (seat: number, call: number) => IntakeAnswer | "fail";
  /** The worker's check of an intake's answer. */
  readonly receipts: (receipt: Uint8Array) => CheckedAnswer | "fail";
  /** What keeping a checked receipt answers. */
  readonly keptReceipt: RecordReceiptOutcome;
  /** Whether the build has every delivery route (`delivers`). */
  readonly delivers: boolean;
  /** This device's casts before the cast. */
  readonly held: CastsRead;
  /** What recording the cast answers. */
  readonly recorded: RecordCastOutcome | "not-asked";
  /** The ballot route's answers in turn, the last one repeating. */
  readonly answers: readonly (SendAnswer | "fail")[];
  /** What keeping a checked answer answers. */
  readonly kept: RecordBoardedOutcome;
}

const VOTER: Voter = {
  identity: IDENTITY,
  board: BOARD,
  cell: CELL,
  l1: L1,
  artifacts: ARTIFACTS,
  cast: CAST,
  intake: INTAKE,
  delivered: receiptOf,
  receipts: passes,
  keptReceipt: "recorded",
  delivers: true,
  held: { kind: "read", casts: [] },
  recorded: "recorded",
  answers: [BOARDED],
  kept: "recorded",
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
    readonly casts: Mock<ElectionSource["casts"]>;
    readonly record: Mock<ElectionSource["record"]>;
    readonly intake: Mock<ElectionSource["intake"]>;
    readonly deliver: Mock<ElectionSource["deliver"]>;
    readonly receipt: Mock<ElectionSource["receipt"]>;
    readonly keepReceipt: Mock<ElectionSource["keepReceipt"]>;
    readonly send: Mock<ElectionSource["send"]>;
    readonly keepBoarded: Mock<ElectionSource["keepBoarded"]>;
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
    cast: castResult,
    identityAtCast,
    registrar,
    intake: intakeResult,
    delivered,
    receipts,
    keptReceipt,
    delivers,
    held,
    recorded,
    answers,
    kept,
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
    if (castResult !== "hold") return answer(castResult);
    onProgress(2, 5);
    return new Promise((resolve) => (release = () => resolve(CAST)));
  });
  let sent = 0;
  const casts = fn<ElectionSource["casts"]>(() => Promise.resolve(held));
  const record = fn<ElectionSource["record"]>(() => Promise.resolve(recorded));
  const intake = fn<ElectionSource["intake"]>(() => answer(intakeResult));
  const deliveries = new Map<number, number>();
  const deliver = fn<ElectionSource["deliver"]>((seat) => {
    const call = deliveries.get(seat) ?? 0;
    deliveries.set(seat, call + 1);
    return answer(delivered(seat, call));
  });
  const receipt = fn<ElectionSource["receipt"]>((_, bytes) => answer(receipts(bytes)));
  const keepReceipt = fn<ElectionSource["keepReceipt"]>(() => Promise.resolve(keptReceipt));
  const send = fn<ElectionSource["send"]>(() =>
    answer(answers[Math.min(sent++, answers.length - 1)] as SendAnswer | "fail"),
  );
  const keepBoarded = fn<ElectionSource["keepBoarded"]>(() => Promise.resolve(kept));
  const made: ElectionSource = {
    load,
    check: () => answer(check),
    seal,
    challenge,
    identity: () => {
      if (registrar !== undefined) return registrar.identity();
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
    casts,
    record,
    intake,
    deliver,
    receipt,
    keepReceipt,
    send,
    keepBoarded,
    registrar,
    delivers,
  };
  MOCKS.set(made, {
    load,
    seal,
    challenge,
    loadBoard,
    findCell,
    cast,
    casts,
    record,
    intake,
    deliver,
    receipt,
    keepReceipt,
    send,
    keepBoarded,
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
  await expect(canvas.queryByText("Hidden on Abolish's website as a threat")).toBeNull();
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

export const OpensHiddenAsThreat: Story = {
  name: "A poll hidden on the website as a threat opens under a notice",
  args: { source: source([{ ...LOADED, hiddenAsThreat: true }], { ok: true, election: ELECTION }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The text is shown, checked, under the notice (docs/moderation-policy.md, Open polls).
    await expect(await canvas.findByRole("heading", { level: 1, name: QUESTION })).toBeVisible();
    await expect(canvas.getByText("Hidden on Abolish's website as a threat")).toBeVisible();
    await expect(canvas.getByText(/doesn't stop anyone voting/)).toBeVisible();
    await expect(canvas.getByText("This is the real poll, checked")).toBeVisible();
  },
};

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
  boardEntryVersion: 5,
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
    // This device's casts in the voter's tier were read before the proof.
    await expect(mocks(args.source).casts).toHaveBeenCalledOnce();
    await expect(mocks(args.source).casts).toHaveBeenCalledWith(fromHex(ELECTION_ID), 0);
    mocks(args.source).release();
    // Recorded as asked, then sent, and the checked answer kept.
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your ballot is on the board" }),
    ).toHaveFocus();
    await expect(mocks(args.source).record).toHaveBeenCalledOnce();
    // With every qualified seat's ciphertext and m_i, kept before the ballot
    // leaves ([[delivery]], Client rule 4).
    await expect(mocks(args.source).record).toHaveBeenCalledWith(
      fromHex(ELECTION_ID),
      0,
      CAST.ballot,
      CAST.ciphertexts,
      { definitionHash: fromHex(REGISTERED), cell: 2, l1Number: L1.number, l1Hash: L1.hash },
    );
    // Each seat's ct_i delivered with the poll's stub and transcript and the
    // whole record, never its m_i, and each receipt checked and kept before
    // the ballot left ([[delivery]], Client rules 1 to 4).
    await expect(mocks(args.source).intake).toHaveBeenCalledWith(fromHex(REGISTERED));
    await expect(mocks(args.source).deliver.mock.calls).toEqual(
      CAST.ciphertexts.map(({ seat, ciphertext }) => [
        seat,
        { stub: STUB, transcript: TRANSCRIPT, record: CAST.ballot, ciphertext },
      ]),
    );
    await expect(mocks(args.source).receipt.mock.calls).toEqual(
      [1, 3].map((seat) => [CAST.ballot, Uint8Array.of(0xec, seat)]),
    );
    await expect(mocks(args.source).keepReceipt.mock.calls).toEqual(
      [1, 3].map((seat) => [
        fromHex(ELECTION_ID),
        0,
        CAST.ballot,
        { seat, receipt: Uint8Array.of(0xec, seat) },
      ]),
    );
    await expect(mocks(args.source).keepReceipt.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks(args.source).send.mock.invocationCallOrder[0] ?? 0,
    );
    await expect(mocks(args.source).send).toHaveBeenCalledOnce();
    await expect(mocks(args.source).send).toHaveBeenCalledWith(fromHex(ELECTION_ID), CAST.ballot);
    await expect(mocks(args.source).keepBoarded).toHaveBeenCalledOnce();
    await expect(mocks(args.source).keepBoarded).toHaveBeenCalledWith(
      fromHex(ELECTION_ID),
      0,
      CAST.ballot,
      expect.objectContaining({ link: fromHex(LINK), index: 41n }),
    );
    await expect(canvas.getByText("Entry 41 on the board")).toBeVisible();
    await expect(
      canvas.getByRole("figure", { name: "Tracking code of your sealed ballot" }),
    ).toHaveTextContent(CODE);
    await expect(canvas.getByText(/isn't signed yet/)).toBeVisible();
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

export const ARecoveredIdentity = stopsBeforeTheSearch(
  "A recovered identity: nothing sealed until the recovered client's checks exist",
  {
    identity: {
      kind: "found",
      identity: { secret: SECRET, memberships: [{ tier: 0, group: 5n }], recovered: true },
    },
  },
  "This device can't answer with a recovered identity yet",
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

export const RecoveredByTheCast: Story = {
  name: "The identity was recovered by the time of the cast",
  args: {
    source: source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, {
      identityAtCast: {
        kind: "found",
        identity: { secret: SECRET, memberships: [{ tier: 0, group: 5n }], recovered: true },
      },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device can't answer with a recovered identity yet");
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

const castsSource = (voter: Partial<Voter>) =>
  source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, voter);

export const CastsUnreadable: Story = {
  name: "Cast, and this device's record of its casts can't be read",
  args: { source: castsSource({ held: { kind: "unreadable" } }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device's record of your ballots can't be read");
    // Never read as no casts: nothing is proved, recorded or sent (T-45).
    await expect(mocks(args.source).cast).not.toHaveBeenCalled();
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
    await expect(canvas.getByRole("button", { name: "Answer again" })).toBeVisible();
  },
};

export const CastOnABlockAlreadyUsed: Story = {
  name: "Cast on a block no newer than this device's last cast",
  args: {
    source: castsSource({
      held: {
        kind: "read",
        casts: [{ ballot: new Uint8Array(8), l1Number: L1.number, shares: [] }],
      },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "Wait a moment, then answer again");
    // It would tie the last cast: nothing is proved or sent (Client rule 3).
    await expect(mocks(args.source).cast).not.toHaveBeenCalled();
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
  },
};

export const CastRecordedMeanwhile: Story = {
  name: "Another tab recorded a cast on this block during the proof",
  args: { source: castsSource({ recorded: "not-newer" }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "Wait a moment, then answer again");
    await expect(mocks(args.source).record).toHaveBeenCalledOnce();
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
  },
};

export const CastNotAsAsked: Story = {
  name: "The ballot names something other than what was asked",
  args: { source: castsSource({ recorded: "not-asked" }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "Your ballot didn't pass this device's check");
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const CastUnrecorded: Story = {
  name: "The browser refuses to record the cast",
  args: { source: castsSource({ recorded: "unwritable" }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device couldn't record your ballot");
    // Never sent unrecorded: a retry would make a new ballot (T-25).
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
  },
};

export const SentAgainAfterABusyBoard: Story = {
  name: "The board is busy, then the same ballot is sent again",
  args: { source: castsSource({ answers: [{ kind: "busy" }, "fail", BOARDED] }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "The board is busy");
    await expect(canvas.getByText(/never a new one/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Send again" }));
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your ballot couldn't be sent" }),
    ).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Send again" }));
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your ballot is on the board" }),
    ).toHaveFocus();
    // Proved and recorded once; the same bytes sent each time.
    await expect(mocks(args.source).cast).toHaveBeenCalledOnce();
    await expect(mocks(args.source).record).toHaveBeenCalledOnce();
    await expect(mocks(args.source).send).toHaveBeenCalledTimes(3);
    for (const [, ballot] of mocks(args.source).send.mock.calls)
      await expect(ballot).toEqual(CAST.ballot);
  },
};

export const AnsweredWithAnotherBallot: Story = {
  name: "The board answers with an entry carrying other bytes",
  args: { source: castsSource({ answers: [boarded(ballotBytes(0x0b))] }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "The board's answer doesn't show your ballot");
    // Not kept, and the voter is never told the ballot is on the board.
    await expect(mocks(args.source).keepBoarded).not.toHaveBeenCalled();
    await expect(canvas.getByRole("button", { name: "Send again" })).toBeVisible();
  },
};

export const AlreadyOnTheBoard: Story = {
  name: "The board already holds a copy of the ballot",
  args: { source: castsSource({ answers: [{ kind: "rejected", code: "repeat" }] }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    // A repeat is the ballot on the board, never a failed cast ([[revoting]], Keyed by content).
    await castInto(canvas, "Your ballot is on the board");
    await expect(canvas.getByText(/already holds a copy/)).toBeVisible();
    await expect(canvas.queryByText(/^Entry \d+ on the board$/)).toBeNull();
    await expect(mocks(args.source).keepBoarded).not.toHaveBeenCalled();
  },
};

export const RefusedByTheBoard: Story = {
  name: "The board refuses the ballot, naming the check",
  args: { source: castsSource({ answers: [{ kind: "rejected", code: "ballot-l1-ref" }] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "The board refused your ballot");
    await expect(canvas.getByText("ballot-l1-ref")).toBeVisible();
    // The operator chose this answer after the proof: no retry offers it another (T-55).
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const NoDelivery: Story = {
  name: "Cast by a build without every route to the trustees",
  args: { source: castsSource({ delivers: false }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This ballot can't send your ballot yet");
    // No ballot is made, so no relay ever holds one (T-25).
    await expect(mocks(args.source).casts).not.toHaveBeenCalled();
    await expect(mocks(args.source).cast).not.toHaveBeenCalled();
    await expect(mocks(args.source).deliver).not.toHaveBeenCalled();
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const DeliveredAgainAfterARefusal: Story = {
  name: "A trustee's intake refuses, then the same ballot is delivered again and sent",
  args: {
    source: castsSource({
      delivered: (seat, call) =>
        seat === 3 && call === 0 ? { kind: "refused", code: "intake-busy" } : receiptOf(seat),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "Your ballot hasn't reached every trustee yet");
    // Never boarded with a seat undelivered, which would void an earlier ballot.
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
    await expect(mocks(args.source).keepReceipt).toHaveBeenCalledOnce();
    await userEvent.click(canvas.getByRole("button", { name: "Send again" }));
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your ballot is on the board" }),
    ).toHaveFocus();
    // Only the seat left undelivered, with the same bytes; proved and recorded once.
    await expect(mocks(args.source).deliver.mock.calls.map(([seat]) => seat)).toEqual([1, 3, 3]);
    await expect(mocks(args.source).deliver.mock.calls[2]?.[1]).toEqual(
      mocks(args.source).deliver.mock.calls[1]?.[1],
    );
    await expect(mocks(args.source).cast).toHaveBeenCalledOnce();
    await expect(mocks(args.source).record).toHaveBeenCalledOnce();
    await expect(mocks(args.source).keepReceipt).toHaveBeenCalledTimes(2);
    await expect(mocks(args.source).send).toHaveBeenCalledOnce();
  },
};

export const UndeliveredEveryWay: Story = {
  name: "No intake answers with a receipt: the relay is busy, fails or is unreachable",
  args: {
    source: castsSource({
      delivered: (seat, call) =>
        call > 0 ? "fail" : seat === 1 ? { kind: "busy" } : { kind: "unavailable" },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "Your ballot hasn't reached every trustee yet");
    await userEvent.click(canvas.getByRole("button", { name: "Send again" }));
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "Your ballot hasn't reached every trustee yet",
      }),
    ).toHaveFocus();
    await expect(mocks(args.source).deliver).toHaveBeenCalledTimes(4);
    await expect(mocks(args.source).receipt).not.toHaveBeenCalled();
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
  },
};

export const ReceiptRefusedByTheWorker: Story = {
  name: "An intake's answer fails the worker's receipt check",
  args: {
    source: castsSource({
      receipts: (receipt) =>
        receipt[1] === 3 ? { ok: false, problem: "refused" } : passes(receipt),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "Your ballot hasn't reached every trustee yet");
    // Only the passing receipt is kept: the other seat keeps its m_i (Client rule 1; T-25).
    await expect(mocks(args.source).keepReceipt).toHaveBeenCalledOnce();
    await expect(mocks(args.source).keepReceipt.mock.calls[0]?.[3]).toEqual({
      seat: 1,
      receipt: Uint8Array.of(0xec, 1),
    });
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
  },
};

export const ReceiptForAnotherSeat: Story = {
  name: "A seat's intake answers with another seat's receipt",
  args: {
    // Seat 3's relay answers with seat 1's receipt, which is seat 1's all the same.
    source: castsSource({ delivered: () => receiptOf(1) }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "Your ballot hasn't reached every trustee yet");
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
  },
};

export const ReceiptUnwritable: Story = {
  name: "The browser refuses to keep a trustee's receipt",
  args: { source: castsSource({ keptReceipt: "unwritable" }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device couldn't record your ballot");
    await expect(mocks(args.source).keepReceipt).toHaveBeenCalledOnce();
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
    await expect(canvas.getByRole("button", { name: "Answer again" })).toBeVisible();
  },
};

export const IntakeWithoutThePoll: Story = {
  name: "The worker no longer holds the poll when the ballot is delivered",
  args: { source: castsSource({ intake: { ok: false, problem: "no-election" } }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device couldn't make your ballot");
    await expect(mocks(args.source).deliver).not.toHaveBeenCalled();
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
  },
};

export const ReceiptWorkerFailed: Story = {
  name: "The worker fails while checking a receipt",
  args: { source: castsSource({ receipts: () => "fail" }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This device couldn't make your ballot");
    await expect(mocks(args.source).keepReceipt).not.toHaveBeenCalled();
    await expect(mocks(args.source).send).not.toHaveBeenCalled();
  },
};

export const BoardNotTakingBallots: Story = {
  name: "The board says the poll isn't taking ballots",
  args: { source: castsSource({ answers: [{ kind: "not-open" }] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "This poll isn't taking ballots");
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const BoardContradictsItself: Story = {
  name: "The board's answer differs from the one this device kept",
  args: { source: castsSource({ kept: "conflict" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await castInto(canvas, "The board gave two answers for one ballot");
    await expect(canvas.queryByText("Your ballot is on the board")).toBeNull();
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

const COMMITMENT = 0x1234_5678_9abc_def0_1234_5678_9abc_def0_1234_5678_9abc_def0n;
const NOW = 1_790_500_000_000;

/** The challenge frame, standing in for Turnstile's page: one tap hands over a token. */
function PassTheCheck({ onToken }: { onToken: (token: string) => void }) {
  return (
    <button type="button" onClick={() => onToken("token.1")}>
      Pass the check
    </button>
  );
}

type RegistrarMocks = {
  readonly create: Mock<Registrar["create"]>;
  readonly commitment: Mock<Registrar["commitment"]>;
  readonly send: Mock<Registrar["send"]>;
  readonly record: Mock<Registrar["record"]>;
  readonly registry: Mock<Registrar["registry"]>;
  readonly outcome: Mock<Registrar["outcome"]>;
  readonly join: Mock<Registrar["join"]>;
  readonly confirmRegistry: Mock<NonNullable<Registrar["confirmRegistry"]>>;
  readonly replace: Mock<Registrar["replace"]>;
  /** Each secret the screens handed the worker, as given, and a copy taken when it was. */
  readonly secrets: { readonly given: Uint8Array; readonly copy: Uint8Array }[];
};
const REGISTRARS = new WeakMap<Registrar, RegistrarMocks>();
const registrarMocks = (of: ElectionSource) => {
  const found = of.registrar === undefined ? undefined : REGISTRARS.get(of.registrar);
  if (found === undefined) throw new Error("not a story's registrar");
  return found;
};

/** The finalized block's time a story's registry is read at by default: just after NOW, so no request is due again. */
const READ_AT = BigInt(NOW / 1000);
const NOT_YET: Tier0OutcomeResult = { ok: true, outcome: { kind: "not-yet" } };

/**
 * A registrar for region 0 over a store that starts as `held` and keeps
 * what `create`, `record`, `join` and `replace` write, whose worker commits
 * every secret to `commitments` in turn, whose route answers `answers` in
 * turn, whose registry is read at `readAt` (or answers `registry`), whose
 * second L2 endpoint answers `confirm` (none where it is not given), and
 * whose worker gives `outcomes` in turn (each list's last answer repeats).
 */
function registrar(
  held: IdentityRead,
  answers: readonly Tier0Answer[] = ["accepted"],
  {
    created = "created",
    recorded = "recorded",
    joined = "recorded",
    readAt = READ_AT,
    registry: read,
    outcomes = [NOT_YET],
    commitments = [COMMITMENT],
    confirm,
    replaced = "replaced",
    backup,
    recovered,
  }: {
    created?: Awaited<ReturnType<Registrar["create"]>>;
    recorded?: Awaited<ReturnType<Registrar["record"]>>;
    joined?: Awaited<ReturnType<Registrar["join"]>>;
    readAt?: bigint;
    registry?: LoadedRegistry;
    outcomes?: readonly Tier0OutcomeResult[];
    commitments?: readonly bigint[];
    confirm?: LoadedRegistry;
    replaced?: Awaited<ReturnType<Registrar["replace"]>>;
    backup?: Backer;
    /** A recovery's outcome; a restored one keeps a recovered identity in the store. */
    recovered?: RecoveryOutcome;
  } = {},
): Registrar {
  let store = held;
  let sent = 0;
  let outcomesGiven = 0;
  let committed = 0;
  const secrets: { given: Uint8Array; copy: Uint8Array }[] = [];
  const create = fn<Registrar["create"]>(() => {
    if (created === "created" && store.kind === "none")
      store = { kind: "found", identity: { secret: SECRET, memberships: [] } };
    return Promise.resolve(store.kind === "none" ? created : "exists");
  });
  const commitment = fn<Registrar["commitment"]>((secret) => {
    secrets.push({ given: secret, copy: secret.slice() });
    return Promise.resolve({
      ok: true,
      commitment: commitments[Math.min(committed++, commitments.length - 1)] as bigint,
    });
  });
  const send = fn<Registrar["send"]>(() =>
    Promise.resolve(answers[Math.min(sent++, answers.length - 1)] as Tier0Answer),
  );
  const record = fn<Registrar["record"]>((_, request) => {
    if (recorded === "recorded" && store.kind === "found")
      store = { kind: "found", identity: { ...store.identity, tier0Request: request } };
    return Promise.resolve(recorded);
  });
  const registry = fn<Registrar["registry"]>(() =>
    Promise.resolve(
      read ?? { ok: true, block: 40_000_000n, timestamp: readAt, records: [BOARD_ENTRY] },
    ),
  );
  const outcome = fn<Registrar["outcome"]>((secret) => {
    secrets.push({ given: secret, copy: secret.slice() });
    return Promise.resolve(
      outcomes[Math.min(outcomesGiven++, outcomes.length - 1)] as Tier0OutcomeResult,
    );
  });
  const join = fn<Registrar["join"]>((_, group) => {
    if (joined === "recorded" && store.kind === "found")
      store = {
        kind: "found",
        identity: {
          secret: store.identity.secret,
          memberships: [{ tier: 0, group }, ...store.identity.memberships],
        },
      };
    return Promise.resolve(joined);
  });
  const confirmRegistry = fn<NonNullable<Registrar["confirmRegistry"]>>(() =>
    Promise.resolve(confirm ?? { ok: false, problem: "no-registry" }),
  );
  const replace = fn<Registrar["replace"]>((secret) => {
    secrets.push({ given: secret, copy: secret.slice() });
    if (replaced === "replaced" && store.kind === "found")
      store = { kind: "found", identity: { secret: SECRET, memberships: [] } };
    return Promise.resolve(replaced);
  });
  const recovery: Recoverer | undefined =
    recovered === undefined
      ? undefined
      : {
          recover: fn<Recoverer["recover"]>(() => {
            if (recovered.kind === "restored" && store.kind === "none")
              store = {
                kind: "found",
                identity: {
                  secret: SECRET,
                  memberships: [{ tier: 0, group: recovered.group }],
                  recovered: true,
                },
              };
            return Promise.resolve(recovered);
          }),
        };
  const made: Registrar = {
    region: 0,
    Challenge: PassTheCheck,
    create,
    identity: () =>
      Promise.resolve(
        store.kind === "found"
          ? { kind: "found", identity: { ...store.identity, secret: SECRET.slice() } }
          : store,
      ),
    commitment,
    send,
    record,
    registry,
    confirmRegistry: confirm === undefined ? undefined : confirmRegistry,
    outcome,
    join,
    replace,
    now: () => NOW,
    backup,
    recovery,
  };
  REGISTRARS.set(made, {
    create,
    commitment,
    send,
    record,
    registry,
    outcome,
    join,
    confirmRegistry,
    replace,
    secrets,
  });
  return made;
}

const registering = (voter: Partial<Voter>) =>
  source([LOADED], { ok: true, election: POLL_OF_QUESTIONS }, SEALED, OPENED, voter);

/** Every secret handed to the registrar's worker was the device's, and was zeroed after. */
async function registrarZeroed(of: ElectionSource, count: number) {
  const { secrets } = registrarMocks(of);
  await expect(secrets).toHaveLength(count);
  for (const { given, copy } of secrets) {
    await expect(copy).toEqual(SECRET);
    await expect(given.every((b) => b === 0)).toBe(true);
  }
}

const BODY = JSON.stringify({
  commitment: COMMITMENT.toString(16).padStart(64, "0"),
  region: "0",
  turnstile: "token.1",
});

/**
 * Waits for the heading `name` to take focus: the screens focus their title
 * in an effect, which can run after the heading is already in the page.
 */
const focused = (canvas: ReturnType<typeof within>, name: { level: number; name: string }) =>
  waitFor(() => expect(canvas.getByRole("heading", name)).toHaveFocus());

export const RegistersANewIdentity: Story = {
  name: "No identity: one is made, kept and registered, then the voter waits",
  args: { source: registering({ registrar: registrar({ kind: "none" }) }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "Make a voting identity on this device",
      }),
    ).toHaveFocus();
    // The board was read all the same, and nothing searched or sealed.
    await expect(mocks(args.source).loadBoard).toHaveBeenCalledOnce();
    await expect(mocks(args.source).findCell).not.toHaveBeenCalled();
    await expect(mocks(args.source).seal).not.toHaveBeenCalled();
    const { create, commitment, send, record } = registrarMocks(args.source);
    await expect(create).not.toHaveBeenCalled();
    // A double tap makes one identity.
    await userEvent.dblClick(canvas.getByRole("button", { name: "Make my voting identity" }));
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Show you're a person" }),
    ).toHaveFocus();
    // Kept before anything is sent, and its commitment worked out before the solve.
    await expect(create).toHaveBeenCalledOnce();
    await expect(commitment).toHaveBeenCalledOnce();
    await expect(send).not.toHaveBeenCalled();
    // A second token from the same frame sends nothing.
    await userEvent.dblClick(canvas.getByRole("button", { name: "Pass the check" }));
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your registration was sent" }),
    ).toHaveFocus();
    await expect(send).toHaveBeenCalledOnce();
    await expect(send).toHaveBeenCalledWith(BODY);
    // Noted beside the identity the request was for, checked by its commitment again.
    await expect(commitment).toHaveBeenCalledTimes(2);
    await expect(record).toHaveBeenCalledOnce();
    await expect(record).toHaveBeenCalledWith(expect.any(Uint8Array), {
      region: 0,
      acceptedAt: NOW,
    });
    await registrarZeroed(args.source, 2);
    await expect(record.mock.calls[0]?.[0].every((b) => b === 0)).toBe(true);
    // Back at the poll, the voter is told the request is on its way.
    await userEvent.click(canvas.getByRole("button", { name: "Back to the poll" }));
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "Your registration is on its way" });
    await expect(send).toHaveBeenCalledOnce();
    await expect(mocks(args.source).findCell).not.toHaveBeenCalled();
    // Read from the whole registry, for the region asked for.
    const { registry, outcome } = registrarMocks(args.source);
    await expect(registry).toHaveBeenCalledOnce();
    await expect(outcome).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      0,
      expect.objectContaining({ timestamp: READ_AT }),
    );
    await registrarZeroed(args.source, 3);
    await expect(canvas.getByRole("button", { name: "Check again" })).toBeVisible();
  },
};

export const BacksUpOnceSent: Story = {
  name: "Sent: the backup offered, and made",
  args: {
    source: registering({
      registrar: registrar(
        { kind: "found", identity: { secret: SECRET, memberships: [] } },
        ["accepted"],
        {
          backup: {
            credential: fn<Backer["credential"]>(() => Promise.resolve({ kind: "none" })),
            backUp: fn<Backer["backUp"]>(() =>
              Promise.resolve({ kind: "stored", syncable: true, backedUp: true }),
            ),
            now: () => NOW,
          },
        },
      ),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    // Offered only once the request went, never on the way to it.
    await expect(canvas.queryByRole("button", { name: "Back up with a passkey" })).toBeNull();
    await userEvent.click(await canvas.findByRole("button", { name: "Register it" }));
    const check = await canvas.findByRole("button", { name: "Pass the check" });
    await expect(canvas.queryByRole("button", { name: "Back up with a passkey" })).toBeNull();
    await userEvent.click(check);
    await focused(canvas, { level: 1, name: "Your registration was sent" });
    const backup = args.source.registrar?.backup;
    await userEvent.click(await canvas.findByRole("button", { name: "Back up with a passkey" }));
    await expect(await canvas.findByText("Backed up with your passkey")).toBeVisible();
    await expect(backup?.backUp).toHaveBeenCalledOnce();
    // Focus follows the pressed button to the outcome, never to the page.
    await expect(canvas.getByRole("status")).toHaveFocus();
  },
};

export const RecoversAnIdentity: Story = {
  name: "No identity: one recovered from its backup passkey, then no seal from it",
  args: {
    source: registering({
      registrar: registrar({ kind: "none" }, ["accepted"], {
        recovered: { kind: "restored", group: 5n, region: 3, syncable: true, backedUp: false },
      }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "Make a voting identity on this device" });
    const recovery = args.source.registrar?.recovery;
    await userEvent.click(canvas.getByRole("button", { name: "Recover it with a passkey" }));
    await focused(canvas, { level: 1, name: "Recover your voting identity" });
    // Nothing is asked of the passkey before the voter chooses to.
    await expect(recovery?.recover).not.toHaveBeenCalled();
    // Back goes to making a new identity, and the offer is there again.
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await focused(canvas, { level: 1, name: "Make a voting identity on this device" });
    await userEvent.click(canvas.getByRole("button", { name: "Recover it with a passkey" }));
    // A double tap runs one recovery.
    await userEvent.dblClick(await canvas.findByRole("button", { name: "Use my passkey" }));
    await focused(canvas, { level: 1, name: "Your voting identity is on this device" });
    await expect(recovery?.recover).toHaveBeenCalledOnce();
    // The area found, one device per poll, and a passkey not yet synced.
    await expect(canvas.getByText(/counts it in area 3/)).toBeVisible();
    await expect(canvas.getByText("Answer each poll from one device")).toBeVisible();
    await expect(canvas.getByText("Your passkey isn't on your other devices yet")).toBeVisible();
    // Nothing was made or sent on the way.
    const { create, send } = registrarMocks(args.source);
    await expect(create).not.toHaveBeenCalled();
    await expect(send).not.toHaveBeenCalled();
    // Back at the poll, a recovered identity seals nothing yet.
    await userEvent.click(canvas.getByRole("button", { name: "Back to the poll" }));
    await answerAndSeal(canvas);
    await focused(canvas, {
      level: 1,
      name: "This device can't answer with a recovered identity yet",
    });
    await expect(mocks(args.source).findCell).not.toHaveBeenCalled();
    await expect(mocks(args.source).seal).not.toHaveBeenCalled();
  },
};

export const RecoveryWithNoBackup: Story = {
  name: "Recovery: no backup for the passkey, another one asked for",
  args: {
    source: registering({
      registrar: registrar({ kind: "none" }, ["accepted"], {
        recovered: { kind: "stopped", problem: "no-backup" },
      }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Recover it with a passkey" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Use my passkey" }));
    await focused(canvas, { level: 1, name: "There's no backup for this passkey" });
    const recovery = args.source.registrar?.recovery;
    await userEvent.click(canvas.getByRole("button", { name: "Try another passkey" }));
    await focused(canvas, { level: 1, name: "There's no backup for this passkey" });
    await expect(recovery?.recover).toHaveBeenCalledTimes(2);
    await userEvent.click(canvas.getByRole("button", { name: "Back" }));
    await focused(canvas, { level: 1, name: "Make a voting identity on this device" });
  },
};

export const RecoveryFindsAnIdentityMeanwhile: Story = {
  name: "Recovery: an identity appeared meanwhile, and the poll decides anew",
  args: {
    source: registering({
      registrar: registrar({ kind: "none" }, ["accepted"], {
        recovered: { kind: "stopped", problem: "exists" },
      }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Recover it with a passkey" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Use my passkey" }));
    await waitFor(() => expect(args.source.registrar?.recovery?.recover).toHaveBeenCalledOnce());
    // Checked again from the start: answering anew, nothing replaced.
    await expect(await canvas.findByText("Yes")).toBeVisible();
  },
};

export const NoRecoveryForAKeptIdentity: Story = {
  name: "An identity kept but not registered: no recovery offered over it",
  args: {
    source: registering({
      registrar: registrar({ kind: "found", identity: { secret: SECRET, memberships: [] } }, [], {
        recovered: { kind: "stopped", problem: "exists" },
      }),
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "Register your voting identity" });
    await expect(canvas.queryByRole("button", { name: "Recover it with a passkey" })).toBeNull();
  },
};

export const RegistersAKeptIdentity: Story = {
  name: "An identity in no group: registered, never replaced",
  args: {
    source: registering({
      registrar: registrar({ kind: "found", identity: { secret: SECRET, memberships: [] } }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Register it" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Pass the check" }));
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your registration was sent" }),
    ).toBeVisible();
    await expect(registrarMocks(args.source).create).not.toHaveBeenCalled();
    await expect(registrarMocks(args.source).send).toHaveBeenCalledWith(BODY);
  },
};

export const ChallengeRefusedThenSolvedAgain: Story = {
  name: "A refused check is solved again in a fresh frame",
  args: {
    source: registering({
      registrar: registrar({ kind: "none" }, ["challenge-refused", "accepted"]),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Make my voting identity" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Pass the check" }));
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "The check didn't pass" }),
    ).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Pass the check" }));
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your registration was sent" }),
    ).toBeVisible();
    const { create, commitment, send } = registrarMocks(args.source);
    // The same identity and commitment: only the solve is new.
    await expect(create).toHaveBeenCalledOnce();
    await expect(send).toHaveBeenCalledTimes(2);
    await expect(commitment).toHaveBeenCalledTimes(2);
  },
};

/** A story where the route answers `answer` and registration stops at `title`. */
const routeStops = (name: string, answer: Tier0Answer, title: string, retry: boolean): Story => ({
  name,
  args: { source: registering({ registrar: registrar({ kind: "none" }, [answer]) }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Make my voting identity" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Pass the check" }));
    await expect(await canvas.findByRole("heading", { level: 1, name: title })).toHaveFocus();
    await expect(registrarMocks(args.source).record).not.toHaveBeenCalled();
    const again = canvas.queryByRole("button", { name: "Try again" });
    await expect(again !== null).toBe(retry);
  },
});

export const RegistrationBusy = routeStops(
  "The registration service is busy",
  "busy",
  "Your registration couldn't be sent",
  true,
);

export const RegistrationUnreachable = routeStops(
  "The registration service can't be reached",
  "unreachable",
  "Your registration couldn't be sent",
  true,
);

export const RegistrationMalformed = routeStops(
  "The route says the request is malformed",
  "malformed",
  "The registration service refused this request",
  false,
);

export const RegistrationUnwritable: Story = {
  name: "The browser won't keep a new identity",
  args: {
    source: registering({
      registrar: registrar({ kind: "none" }, ["accepted"], { created: "unwritable" }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Make my voting identity" }));
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "This browser won't keep a voting identity",
      }),
    ).toHaveFocus();
    await expect(registrarMocks(args.source).commitment).not.toHaveBeenCalled();
    await expect(registrarMocks(args.source).send).not.toHaveBeenCalled();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const RegistrationNotNoted: Story = {
  name: "Accepted, but the device couldn't note the request",
  args: {
    source: registering({
      registrar: registrar({ kind: "none" }, ["accepted"], { recorded: "changed" }),
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(await canvas.findByRole("button", { name: "Make my voting identity" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Pass the check" }));
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "Your registration was sent, but this device couldn't note it",
      }),
    ).toHaveFocus();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const NoRegistrationForAPollWithoutTier0: Story = {
  name: "No identity, on a poll that doesn't admit Tier 0",
  args: {
    source: source(
      [LOADED],
      { ok: true, election: { ...POLL_OF_QUESTIONS, tiers: [1, 2] } },
      SEALED,
      OPENED,
      { registrar: registrar({ kind: "none" }) },
    ),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    // Registering at Tier 0 wouldn't put the voter on this poll's list.
    await expect(
      await canvas.findByRole("heading", {
        level: 1,
        name: "This device has no voting identity yet",
      }),
    ).toHaveFocus();
    await expect(registrarMocks(args.source).create).not.toHaveBeenCalled();
    await expect(canvas.queryByRole("button")).toBeNull();
  },
};

export const UnregisteredWithoutARegistrar = stopsBeforeTheSearch(
  "An identity in no group, on a build that can't register",
  {
    identity: { kind: "found", identity: { secret: SECRET, memberships: [] } },
  },
  "Your voting identity isn't registered yet",
);

const REQUEST = { region: 0, acceptedAt: NOW };
const WAITING: IdentityRead = {
  kind: "found",
  identity: { secret: SECRET, memberships: [], tier0Request: REQUEST },
};
const ON_THE_LIST: Tier0OutcomeResult = { ok: true, outcome: { kind: "registered", group: 9n } };

export const WaitingThenRegistered: Story = {
  name: "A request on the list: kept as the identity's membership, and the poll goes on",
  args: { source: registering({ registrar: registrar(WAITING, [], { outcomes: [ON_THE_LIST] }) }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "You're registered" });
    const { join, send } = registrarMocks(args.source);
    // Kept beside the identity the outcome was read for, with the group it is counted in.
    await expect(join).toHaveBeenCalledOnce();
    await expect(join).toHaveBeenCalledWith(expect.any(Uint8Array), 9n);
    await registrarZeroed(args.source, 1);
    await expect(join.mock.calls[0]?.[0].every((b) => b === 0)).toBe(true);
    await expect(send).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Back to the poll" }));
    await answerAndSeal(canvas);
    await expect(
      await canvas.findByRole("heading", { level: 1, name: "Your answers are sealed" }),
    ).toBeVisible();
    await expect(mocks(args.source).findCell).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(Uint8Array),
      { tier: 0, group: 9n },
      [BOARD_ENTRY],
    );
  },
};

export const WaitingBesideAnotherTier: Story = {
  name: "A request beside a membership in a tier the poll doesn't admit: read once, kept beside it",
  args: {
    source: registering({
      registrar: registrar(
        {
          kind: "found",
          identity: {
            secret: SECRET,
            memberships: [{ tier: 1, group: 4n }],
            tier0Request: REQUEST,
          },
        },
        [],
        { outcomes: [ON_THE_LIST] },
      ),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "You're registered" });
    // The other tier's membership doesn't end the wait or restart the read.
    await expect(registrarMocks(args.source).registry).toHaveBeenCalledOnce();
    await expect(registrarMocks(args.source).join).toHaveBeenCalledWith(expect.any(Uint8Array), 9n);
  },
};

export const WaitingCheckedAgain: Story = {
  name: "A request not on the list yet: checked again in place",
  args: {
    source: registering({
      registrar: registrar(WAITING, [], { outcomes: [NOT_YET, ON_THE_LIST] }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "Your registration is on its way" });
    // Not due yet: nothing is offered to send.
    await expect(canvas.queryByRole("button", { name: "Send it again" })).toBeNull();
    await userEvent.click(canvas.getByRole("button", { name: "Check again" }));
    await focused(canvas, { level: 1, name: "You're registered" });
    await expect(registrarMocks(args.source).registry).toHaveBeenCalledTimes(2);
    await registrarZeroed(args.source, 2);
  },
};

export const WaitingDueSentAgain: Story = {
  name: "A request due again: the same commitment and region sent once more",
  args: {
    source: registering({
      // RETRY_AFTER (4,800 seconds) of finalized time after the request was accepted.
      registrar: registrar(WAITING, ["accepted"], { readAt: READ_AT + 4800n }),
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, {
      level: 1,
      name: "Your registration hasn't appeared yet",
    });
    await userEvent.dblClick(canvas.getByRole("button", { name: "Send it again" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Pass the check" }));
    await focused(canvas, { level: 1, name: "Your registration was sent" });
    const { create, send, record } = registrarMocks(args.source);
    await expect(create).not.toHaveBeenCalled();
    await expect(send).toHaveBeenCalledOnce();
    await expect(send).toHaveBeenCalledWith(BODY);
    await expect(record).toHaveBeenCalledWith(expect.any(Uint8Array), REQUEST);
  },
};

export const WaitingJustBeforeDue: Story = {
  name: "A request a second short of due: still waiting",
  args: {
    source: registering({ registrar: registrar(WAITING, [], { readAt: READ_AT + 4799n }) }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "Your registration is on its way" });
  },
};

const MOVED: Tier0OutcomeResult = { ok: true, outcome: { kind: "moved", group: 3n } };
/** Finalized time past the retry bound (RETRY_AFTER, 4,800 seconds) since the request. */
const PAST_BOUND = READ_AT + 4800n;
/** The second L2 endpoint's read of the registry, at its own later finalized block, past the bound. */
const CONFIRM_READ: LoadedRegistry = {
  ok: true,
  block: 40_000_007n,
  timestamp: PAST_BOUND,
  records: [BOARD_ENTRY],
};
const MOVED_TITLE = { level: 1, name: "Your voting identity was put on another area's list" };

/** A waiting identity whose move both endpoints show past the bound, with `options` on top. */
const confirmedMove = (options: Parameters<typeof registrar>[2] = {}) =>
  registering({
    registrar: registrar(WAITING, [], {
      outcomes: [MOVED],
      readAt: PAST_BOUND,
      confirm: CONFIRM_READ,
      ...options,
    }),
  });

/** A story where a move stays an unconfirmed alarm: nothing kept, sent or replaced, and a check again. */
const unconfirmedMove = (name: string, options: Parameters<typeof registrar>[2]): Story => ({
  name,
  args: { source: registering({ registrar: registrar(WAITING, [], options) }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, MOVED_TITLE);
    const { join, send, replace } = registrarMocks(args.source);
    await expect(join).not.toHaveBeenCalled();
    await expect(send).not.toHaveBeenCalled();
    await expect(replace).not.toHaveBeenCalled();
    await expect(canvas.queryByRole("button", { name: "Make a new voting identity" })).toBeNull();
    await expect(
      canvas.getByText(/a second, separate source of the list shows the same/),
    ).toBeVisible();
    // Every secret handed out was zeroed, and a check again reads the first endpoint anew.
    await registrarZeroed(args.source, registrarMocks(args.source).secrets.length);
    await userEvent.click(canvas.getByRole("button", { name: "Check again" }));
    await focused(canvas, MOVED_TITLE);
    await expect(registrarMocks(args.source).registry).toHaveBeenCalledTimes(2);
  },
});

export const WaitingMoved = unconfirmedMove(
  "A request counted in another region's group, on a build with no second endpoint: the alarm, unconfirmed",
  { outcomes: [MOVED], readAt: PAST_BOUND },
);

export const MovedSecondReadFails = unconfirmedMove(
  "A move the second endpoint can't be read for: unconfirmed",
  { outcomes: [MOVED], readAt: PAST_BOUND, confirm: { ok: false, problem: "unreachable" } },
);

const REFUSED_LOG: Tier0OutcomeResult = { ok: false, problem: "registry", code: "group-history" };

export const MovedSecondLogRefused = unconfirmedMove(
  "A move where the second endpoint's log isn't one the worker accepts: unconfirmed, not disputed",
  {
    // Each read's first endpoint, then its second, for the alarm and the check again.
    outcomes: [MOVED, REFUSED_LOG, MOVED, REFUSED_LOG],
    readAt: PAST_BOUND,
    confirm: CONFIRM_READ,
  },
);

export const MovedTooSoon = unconfirmedMove(
  "A move both endpoints show before the retry bound: unconfirmed, since the voter's own batch may still land",
  { outcomes: [MOVED], confirm: { ...CONFIRM_READ, timestamp: READ_AT } },
);

export const MovedSecondTooSoon = unconfirmedMove(
  "A move both show, the second endpoint's read before the bound: unconfirmed",
  { outcomes: [MOVED], readAt: PAST_BOUND, confirm: { ...CONFIRM_READ, timestamp: READ_AT } },
);

export const MovedRegisteredLater = unconfirmedMove(
  "A move the second endpoint, at a later block, shows registered: unconfirmed, the first may lag",
  { outcomes: [MOVED, ON_THE_LIST, MOVED, ON_THE_LIST], readAt: PAST_BOUND, confirm: CONFIRM_READ },
);

export const MovedConfirmedStartsAgain: Story = {
  name: "A move both endpoints show: read afresh on the tap, a new identity in place of the moved one, then registration",
  args: { source: confirmedMove() },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, MOVED_TITLE);
    await expect(canvas.getByText(/Two separate sources of the public list agree/)).toBeVisible();
    const { registry, confirmRegistry, outcome, replace, send } = registrarMocks(args.source);
    // The second read is the second endpoint's, of the same identity.
    await expect(registry).toHaveBeenCalledOnce();
    await expect(confirmRegistry).toHaveBeenCalledOnce();
    await expect(outcome).toHaveBeenCalledTimes(2);
    await expect(outcome.mock.calls[1]?.[2]).toEqual(CONFIRM_READ);
    await expect(replace).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Make a new voting identity" }));
    // Both endpoints read again before the replacement, then the poll
    // checked anew, which offers the new identity's registration.
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "Register your voting identity" });
    await expect(registry).toHaveBeenCalledTimes(2);
    await expect(confirmRegistry).toHaveBeenCalledTimes(2);
    await expect(replace).toHaveBeenCalledOnce();
    await expect(send).not.toHaveBeenCalled();
    // Four outcomes, four commitments and the replacement, each zeroed.
    await registrarZeroed(args.source, 9);
  },
};

export const MovedOvertakenAtTheTap: Story = {
  name: "A confirmed move the voter's own batch overtakes before the tap: registered, nothing replaced",
  args: { source: confirmedMove({ outcomes: [MOVED, MOVED, ON_THE_LIST] }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Make a new voting identity" }),
    );
    await focused(canvas, { level: 1, name: "You're registered" });
    await expect(registrarMocks(args.source).replace).not.toHaveBeenCalled();
    await expect(registrarMocks(args.source).join).toHaveBeenCalledWith(expect.any(Uint8Array), 9n);
  },
};

/** A story where the second endpoint's outcome isn't the first's move: nothing changes. */
const disputed = (name: string, second: Tier0OutcomeResult): Story => ({
  name,
  args: {
    source: confirmedMove({
      outcomes: [MOVED, second],
      // At the first endpoint's block, so a registered answer isn't explained by lag.
      confirm: { ...CONFIRM_READ, block: 40_000_000n },
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "Two sources of the list disagree" });
    const { join, replace } = registrarMocks(args.source);
    await expect(join).not.toHaveBeenCalled();
    await expect(replace).not.toHaveBeenCalled();
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible();
  },
});

export const MovedDisputedNotYet = disputed(
  "A move the second endpoint doesn't show at all",
  NOT_YET,
);
export const MovedDisputedRegistered = disputed(
  "A move where the second endpoint, at the same block, shows the voter's own region",
  ON_THE_LIST,
);
export const MovedDisputedGroup = disputed(
  "A move to another group than the first endpoint showed",
  { ok: true, outcome: { kind: "moved", group: 4n } },
);

export const MovedOtherIdentityAtTheTap: Story = {
  name: "A confirmed move, then another identity on the device by the tap: nothing replaced, the poll checked anew",
  args: {
    source: confirmedMove({
      // The two reads', the tap's first read, then another tab's identity.
      commitments: [COMMITMENT, COMMITMENT, COMMITMENT, COMMITMENT + 1n],
    }),
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Make a new voting identity" }),
    );
    await answerAndSeal(canvas);
    await focused(canvas, MOVED_TITLE);
    await expect(registrarMocks(args.source).replace).not.toHaveBeenCalled();
  },
};

export const MovedNotReplaced = stopsAtTheTap(
  "A confirmed move whose identity the store no longer holds as waiting: kept",
  "changed",
  "Your voting identity was kept",
);

export const MovedReplaceUnwritable = stopsAtTheTap(
  "A confirmed move the browser won't store a new identity for",
  "unwritable",
  "This browser won't keep a voting identity",
);

/** A confirmed move whose replacement answers `replaced`, ending at `title`. */
function stopsAtTheTap(
  name: string,
  replaced: Awaited<ReturnType<Registrar["replace"]>>,
  title: string,
): Story {
  return {
    name,
    args: { source: confirmedMove({ replaced }) },
    play: async ({ canvasElement, args }) => {
      const canvas = within(canvasElement);
      await answerAndSeal(canvas);
      await userEvent.click(
        await canvas.findByRole("button", { name: "Make a new voting identity" }),
      );
      await focused(canvas, { level: 1, name: title });
      await expect(registrarMocks(args.source).replace).toHaveBeenCalledOnce();
    },
  };
}

/** A story where reading a waiting request's outcome stops at `title`. */
const outcomeStops = (
  name: string,
  options: Parameters<typeof registrar>[2],
  title: string,
  retry: boolean,
  held: IdentityRead = WAITING,
): Story => ({
  name,
  args: { source: registering({ registrar: registrar(held, [], options) }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: title });
    await expect(registrarMocks(args.source).send).not.toHaveBeenCalled();
    const again = canvas.queryByRole("button", { name: "Try again" });
    await expect(again !== null).toBe(retry);
  },
});

export const RegistryUnreachable = outcomeStops(
  "The group registry can't be read",
  { registry: { ok: false, problem: "unreachable" } },
  "Your registration couldn't be checked",
  true,
);

export const RegistryRefused = outcomeStops(
  "The group registry's log isn't one the worker accepts",
  { outcomes: [{ ok: false, problem: "registry", code: "group-history" }] },
  "Your registration couldn't be checked",
  true,
);

export const NoGroupRegistry = outcomeStops(
  "A build that names no group registry",
  { registry: { ok: false, problem: "no-registry" } },
  "This copy of the ballot can't check registrations",
  false,
);

export const RegionChanged = outcomeStops(
  "A request for a region this build doesn't serve",
  {},
  "This copy of the ballot serves a different area",
  false,
  {
    kind: "found",
    identity: { secret: SECRET, memberships: [], tier0Request: { region: 3, acceptedAt: NOW } },
  },
);

export const JoinNotNoted = outcomeStops(
  "Registered, but the device couldn't keep it",
  { outcomes: [ON_THE_LIST], joined: "changed" },
  "You're registered, but this device couldn't note it",
  true,
);

export const WaitingWithoutARegistrar: Story = {
  name: "A request sent earlier, on a build that can't read its outcome",
  args: { source: registering({ identity: WAITING }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await answerAndSeal(canvas);
    await focused(canvas, { level: 1, name: "Your registration is on its way" });
    await expect(mocks(args.source).findCell).not.toHaveBeenCalled();
  },
};
