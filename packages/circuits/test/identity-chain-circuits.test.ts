// The vendored disclosure circuits of [[identity-chain]] (The chain): the
// `age` and `nationality` binaries take the public inputs the spec lists, in
// its order, and output the four fields `checkIdentityChain` in
// @abolishus/crypto builds their statements with (T-05, T-21). The `dsc`,
// `id` and `integrity` binaries come with the pinned circuit list.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";

interface Abi {
  readonly parameters: readonly {
    readonly name: string;
    readonly type: unknown;
    readonly visibility: string;
  }[];
  readonly return_type: { readonly abi_type: unknown; readonly visibility: string } | null;
}

const ROOT = new URL("../", import.meta.url);
const FIELD = { kind: "field" };
const CIRCUITS = ["compare_age", "inclusion_check_nationality"] as const;

describe("the disclosure circuits", () => {
  test.each(CIRCUITS)(
    "%s takes comm_in, current_date and the two scopes public and outputs four fields",
    (circuit) => {
      execFileSync("nargo", ["compile", "--package", circuit], { cwd: fileURLToPath(ROOT) });
      const { abi } = JSON.parse(readFileSync(new URL(`target/${circuit}.json`, ROOT), "utf8")) as {
        abi: Abi;
      };
      // Public inputs enter the proof in the circuit's order, whatever their
      // place among the private ones: the checker supplies them in this order.
      expect(
        abi.parameters.filter((p) => p.visibility === "public").map((p) => [p.name, p.type]),
      ).toEqual([
        ["comm_in", FIELD],
        ["current_date", { kind: "integer", sign: "unsigned", width: 64 }],
        ["service_scope", FIELD],
        ["service_subscope", FIELD],
      ]);
      expect(
        abi.parameters.every((p) => p.visibility === "public" || p.visibility === "private"),
      ).toBe(true);
      // param_commitment, nullifier_type, nullifier, oprf_pk_hash.
      expect(abi.return_type).toEqual({
        abi_type: { kind: "tuple", fields: [FIELD, FIELD, FIELD, FIELD] },
        visibility: "public",
      });
    },
    600_000,
  );
});
