import { REFILE_REASONS, REMOVAL_REASONS, RESTORE_REASONS } from "@abolishus/api-contract";
import { describe, expect, test } from "vite-plus/test";

import { REMOVAL_GROUNDS, RESTORE_GROUNDS } from "../src/components/moderation-log.tsx";
import { catalogs } from "../src/messages.ts";

describe("the moderation page's grounds", () => {
  // The page lists the policy's grounds as the only ones (T-68): a ground the
  // API accepts but the page leaves out, or one it lists that the API
  // doesn't know, would misstate the policy.
  test("are exactly the API's removal and restore reasons, in the policy's order", () => {
    expect(REMOVAL_GROUNDS).toEqual(REMOVAL_REASONS);
    expect(RESTORE_GROUNDS).toEqual(RESTORE_REASONS);
  });

  test("each has a name and a description in every catalog", () => {
    for (const messages of Object.values(catalogs))
      for (const ground of [...REMOVAL_GROUNDS, ...RESTORE_GROUNDS]) {
        expect(messages[`reason_${ground}`]).toBeTruthy();
        expect(messages[`ground_${ground}`]).toBeTruthy();
      }
  });

  test("a refiling's every ground has a name in every catalog", () => {
    for (const messages of Object.values(catalogs))
      for (const ground of REFILE_REASONS) expect(messages[`reason_${ground}`]).toBeTruthy();
  });
});
