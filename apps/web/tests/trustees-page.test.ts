import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

import { SEATS, THRESHOLD } from "../src/components/how-it-works-diagrams.tsx";
import { SECTIONS } from "../src/components/trustees-page.tsx";
import { catalogs } from "../src/messages.ts";

// The page restates the launch panel's rules, so the facts it states are tied
// to the ADR that decides them: a page that misstated who holds the key would
// be the one claim about trustees every voter reads (T-14).
const adr = readFileSync(
  new URL("../../../docs/adr/0027-trustee-panels-and-live-results.md", import.meta.url),
  "utf8",
);
const part3 = adr.slice(
  adr.indexOf("## Part 3: the transitional panel"),
  adr.indexOf("## Recommendation"),
);

describe("the trustees page", () => {
  test("states the launch panel's shape as the ADR decides it", () => {
    expect(part3).toContain(`the decided shape, ${THRESHOLD}-of-${SEATS}`);
    expect(part3).toContain(`holds \`k\` = ${THRESHOLD} seats`);
  });

  test("leads with the label every page of a launch poll carries", () => {
    const label = /says: "(During launch, Abolish alone holds the key) for this poll\."/.exec(
      part3,
    );
    expect(label?.[1]).toBe(catalogs["en-US"]?.keysTitle);
  });

  test("names each section in every catalog", () => {
    for (const messages of Object.values(catalogs))
      for (const { mark } of SECTIONS) expect(messages[mark]).toBeTruthy();
  });
});
