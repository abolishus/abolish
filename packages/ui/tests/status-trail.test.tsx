import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { I18nProvider } from "../src/i18n/context.tsx";
import { StatusTrail, type StepState } from "../src/components/status-trail.tsx";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);
const stateLabels = { complete: "done", pending: "in progress", upcoming: "not yet" };
const rank: Record<StepState, number> = { complete: 0, pending: 1, upcoming: 2 };

const render = (states: StepState[], stepTemplate = "{step}, {state}") =>
  renderToStaticMarkup(
    <I18nProvider locale="en-US">
      <StatusTrail
        label="Your ballot"
        stateLabels={stateLabels}
        stepTemplate={stepTemplate}
        steps={states.map((state, i) => ({ label: `Step ${i}`, state }))}
      />
    </I18nProvider>,
  );

describe("StatusTrail", () => {
  // A trail that shows a later step done before an earlier one claims more
  // than the board shows (T-53).
  it("renders exactly the trails that run complete, at most one pending, then upcoming", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<StepState>("complete", "pending", "upcoming"), { maxLength: 6 }),
        (states) => {
          const ordered = states.every(
            (s, i) => i === 0 || rank[s] >= rank[states[i - 1]!] /* i > 0 */,
          );
          const valid = ordered && states.filter((s) => s === "pending").length <= 1;
          if (valid) expect(render(states)).toContain('aria-label="Your ballot"');
          else expect(() => render(states)).toThrow(RangeError);
        },
      ),
      { numRuns },
    );
  });

  it.each(["{step}", "{state}", "Step"])(
    "refuses a step template %j that drops a part",
    (template) => {
      expect(() => render(["complete"], template)).toThrow(RangeError);
    },
  );
});
