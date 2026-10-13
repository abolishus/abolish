import { I18nProvider } from "@abolishus/ui";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";

import { App, SharedOrigin } from "../src/app.tsx";
import { Frame, Note, Part, ScreenTitle, type PollClass } from "../src/frame.tsx";

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
      render(createElement(App)),
      render(createElement(SharedOrigin, { address: "https://gateway.example/ipfs/x/" })),
    ])
      expect(html).not.toMatch(/\sstyle=/i);
  });

  test("the class picks the register: civic for organisational votes and referendums", () => {
    for (const c of [2, 3] as const) expect(framed(c)).toContain("Election 3f8a 0c51");
    for (const c of [undefined, 1] as const) {
      expect(framed(c)).not.toContain("Election 3f8a 0c51");
      expect(framed(c)).toContain("Question 2 of 5");
    }
  });
});
