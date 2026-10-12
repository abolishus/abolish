import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TierSwitcher, type Tier } from "../src/components/tier-switcher.tsx";

const render = (tiers: Tier[], defaultValue?: string) =>
  renderToStaticMarkup(
    <TierSwitcher
      label="Verification tier"
      tiers={tiers}
      {...(defaultValue === undefined ? {} : { defaultValue })}
    >
      {(tier) => tier.scope}
    </TierSwitcher>,
  );

const tier = (value: string): Tier => ({ value, label: value, scope: `${value} voters` });

describe("TierSwitcher", () => {
  it("renders one tab per tier", () => {
    expect(render([tier("a"), tier("b")]).match(/role="tab"/g)).toHaveLength(2);
  });

  it.each([
    ["no tiers", [], undefined],
    ["two tiers with one value", [tier("a"), tier("a")], undefined],
    ["a default that isn't a tier", [tier("a")], "b"],
  ])("refuses %s", (_, tiers, defaultValue) => {
    expect(() => render(tiers, defaultValue)).toThrow(RangeError);
  });
});
