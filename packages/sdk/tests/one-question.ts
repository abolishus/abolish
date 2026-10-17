// A one-question scenario's definition, version 4, as the tests written for
// it read it; a questions scenario's (version 5) fails the test.

import type { ElectionDefinitionV4 } from "@abolishus/crypto";
import type { SimulatedDefinition } from "../src/simulation/versions.ts";

export function oneQuestion(d: SimulatedDefinition): ElectionDefinitionV4 {
  if ("questions" in d) throw new TypeError("expected a version-4 definition");
  return d;
}
