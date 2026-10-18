import { I18nProvider } from "@abolishus/ui";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import { Home, SharedOrigin } from "../src/app.tsx";
import { ArrivalCheck, ArrivalChecklist, ElectionRefused } from "../src/check.tsx";
import type { CheckedElection, ElectionRefusal } from "../src/election.ts";
import { Frame, Note, Part, ScreenTitle, type PollClass } from "../src/frame.tsx";
import { Ballot, BrokenLink, Checking, NotSent, Unavailable } from "../src/open.tsx";
import { AnswerQuestions, CheckAnswers, QuestionStep } from "../src/questions.tsx";
import { Opened, Sealed, SealStopped, Working } from "../src/sealed.tsx";

// The client's CSP has `style-src 'self'`, which blocks every inline `style`
// attribute (T-43); the e2e test renders only the screens without a poll, so
// this renders each frame with one, every part filled.

const POLL = {
  definitionHash: "3f8a0c51d2e4b69788a1c0d3e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718",
  name: "Riverside Residents' Association",
  closes: "Fri 17 Oct",
};

const render = (node: ReactNode) =>
  renderToStaticMarkup(createElement(I18nProvider, { locale: "en-US", children: node }));

function framed(pollClass: PollClass | undefined): string {
  return render(
    createElement(Frame, {
      pollClass,
      poll: POLL,
      progress: { current: 2, total: 5 },
      stepName: "Choose",
      primary: createElement("button", { type: "button" }, "Next"),
      secondary: createElement("button", { type: "button" }, "Back"),
      children: [
        createElement(ScreenTitle, { key: "t", title: "A question" }, "Pick one."),
        createElement(Part, {
          key: "p",
          title: "A part",
          children: [
            createElement(Note, { key: "i", tone: "info", title: "Info" }),
            createElement(Note, { key: "w", tone: "warn", title: "Warn" }),
            createElement(Note, { key: "d", tone: "done", title: "Done" }),
          ],
        }),
      ],
    }),
  );
}

describe("the frame under the client's CSP", () => {
  test.each([undefined, 1, 2, 3] as const)("poll class %s renders no inline style", (c) => {
    const html = framed(c);
    expect(html).toContain("A question");
    expect(html).not.toMatch(/\sstyle=/i);
  });

  test("the screens without a poll render no inline style either", () => {
    for (const html of [
      render(createElement(Home)),
      render(createElement(SharedOrigin, { address: "https://gateway.example/ipfs/x/" })),
      render(createElement(Checking)),
      render(createElement(BrokenLink)),
      ...(
        [
          "no-registry",
          "wrong-chain",
          "not-registered",
          "not-found",
          "withheld",
          "unreachable",
          "bad-answer",
          "worker-failed",
        ] as const
      ).map((problem) => render(createElement(Unavailable, { problem, onRetry: () => {} }))),
    ])
      expect(html).not.toMatch(/\sstyle=/i);
  });

  test("a checked election's ballot, and the screen after it, render no inline style", () => {
    const election: CheckedElection = {
      electionId: "5d".repeat(32),
      definitionHash: POLL.definitionHash,
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
              question: "A question",
              description: "",
              options: [
                { label: "One", description: "" },
                { label: "Two", description: "" },
              ],
            },
          ],
        },
      ],
    };
    const ballot = render(
      createElement(Ballot, {
        election,
        source: {
          seal: () => new Promise<never>(() => {}),
          challenge: () => new Promise<never>(() => {}),
          identity: () => new Promise<never>(() => {}),
          loadBoard: () => new Promise<never>(() => {}),
          findCell: () => new Promise<never>(() => {}),
          l1Block: () => new Promise<never>(() => {}),
          cast: () => new Promise<never>(() => {}),
        },
        languages: ["en-US"],
        onRestart: () => {},
      }),
    );
    // A version-1 definition names no one who asked: the frame names the election.
    expect(ballot).toContain("Election 3f8a 0c51");
    expect(ballot).not.toContain("asked");
    // The poll's own text carries its translation's tag; the screens' chrome doesn't.
    expect(ballot).toContain('<h1 lang="en"');
    expect(ballot).toMatch(/<span lang="en"[^>]*><span[^>]*>One<\/span>/);
    for (const html of [
      ballot,
      render(
        createElement(NotSent, {
          definitionHash: POLL.definitionHash,
          closes: "Fri 17 Oct",
          onAgain: () => {},
        }),
      ),
    ])
      expect(html).not.toMatch(/\sstyle=/i);
  });

  test("the sealed ballot's screens render no inline style", () => {
    const code = "9c1e77a04b2d3f60e8a5c1d27b9043fe6a18c5d2e7f04b3a96c8d1e2f3a4b5c6";
    const none = () => {};
    for (const html of [
      render(createElement(Working, { poll: POLL, kind: "finding" })),
      render(createElement(Working, { poll: POLL, kind: "sealing" })),
      render(createElement(Working, { poll: POLL, kind: "opening" })),
      render(
        createElement(Sealed, {
          poll: POLL,
          electionId: "5d".repeat(32),
          trackingCode: code,
          onCast: none,
          onChallenge: none,
        }),
      ),
      render(
        createElement(Opened, {
          poll: POLL,
          trackingCode: code,
          opening: new Uint8Array(8),
          onAgain: none,
        }),
      ),
      ...(
        [
          "cant-seal-version",
          "no-identity",
          "identity-unreadable",
          "not-listed",
          "board-unavailable",
          "no-registrars",
          "cell-refused",
          "seal-failed",
          "open-failed",
          "no-l1",
          "cast-failed",
          "cast-faulty",
        ] as const
      ).map((problem) =>
        render(createElement(SealStopped, { poll: POLL, problem, code: "root", onAgain: none })),
      ),
    ]) {
      expect(html).toContain("<h1");
      expect(html).not.toMatch(/\sstyle=/i);
    }
  });

  test("the class picks the register: civic for organisational votes and referendums", () => {
    for (const c of [2, 3] as const) expect(framed(c)).toContain("Election 3f8a 0c51");
    for (const c of [undefined, 1] as const) {
      expect(framed(c)).not.toContain("Election 3f8a 0c51");
      expect(framed(c)).toContain("Question 2 of 5");
    }
  });

  test.each<ElectionRefusal>([
    { problem: "definition-undecodable" },
    { problem: "another-election" },
    { problem: "unregistered-definition", servedHash: "ab".repeat(32) },
    { problem: "definition-ill-formed", rule: "timing" },
    { problem: "display-text-undecodable" },
    { problem: "display-text-ill-formed", rule: "commitment" },
    { problem: "display-text-ill-formed", rule: "labels" },
  ])("the refusal of $problem renders no inline style", (refusal) => {
    const html = render(
      createElement(ElectionRefused, {
        refusal,
        registeredHash: POLL.definitionHash,
        origin: "https://ballot.example",
      }),
    );
    expect(html).toContain("Don&#x27;t vote from this link");
    expect(html).not.toMatch(/\sstyle=/i);
  });

  test("the arrival checks render no inline style", () => {
    for (const html of [
      render(createElement(ArrivalCheck, { definitionHash: POLL.definitionHash })),
      render(
        createElement(ArrivalChecklist, {
          definitionHash: POLL.definitionHash,
          origin: "https://ballot.example",
        }),
      ),
    ])
      expect(html).not.toMatch(/\sstyle=/i);
  });

  const QUESTIONS = [
    {
      question: "Which one improvement matters most?",
      description: "Pick the one you'd use most.",
      options: [
        { label: "Lighting", description: "On the river path" },
        { label: "Toilets", description: "" },
      ],
      minSelections: 0,
      maxSelections: 1,
    },
    {
      question: "Which events would you go to?",
      description: "",
      options: [
        { label: "Market", description: "" },
        { label: "Cinema", description: "" },
        { label: "Clean-up", description: "" },
      ],
      minSelections: 2,
      maxSelections: 2,
    },
  ];
  const none = () => {};

  test.each([undefined, 1, 2, 3] as const)(
    "the question screens of poll class %s render no inline style",
    (pollClass) => {
      for (const html of [
        render(
          createElement(AnswerQuestions, {
            pollClass,
            poll: POLL,
            questions: QUESTIONS,
            arrival: createElement(ArrivalCheck, { definitionHash: POLL.definitionHash }),
            onSeal: none,
          }),
        ),
        render(
          createElement(QuestionStep, {
            pollClass,
            poll: POLL,
            questions: QUESTIONS,
            index: 1,
            selection: [0, 2],
            toCheck: true,
            onChange: none,
            onBack: none,
            onNext: none,
            onSkip: none,
          }),
        ),
        render(
          createElement(CheckAnswers, {
            pollClass,
            poll: POLL,
            questions: QUESTIONS,
            answers: [[], [0, 2]],
            onChange: none,
            onSeal: none,
          }),
        ),
      ]) {
        expect(html).toContain("Which");
        expect(html).not.toMatch(/\sstyle=/i);
      }
    },
  );

  test("the questions start with nothing chosen", () => {
    const html = render(
      createElement(AnswerQuestions, {
        poll: POLL,
        questions: QUESTIONS,
        onSeal: none,
      }),
    );
    expect(html).toContain("Question 1 of 2");
    expect(html).not.toMatch(/\schecked/i);
  });

  test("an election with no questions isn't shown", () => {
    expect(() =>
      render(
        createElement(AnswerQuestions, {
          poll: POLL,
          questions: [],
          onSeal: none,
        }),
      ),
    ).toThrow(RangeError);
  });
});
