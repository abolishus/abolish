import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";

import { onSharedGatewayPath } from "../src/origin.ts";

const numRuns = Number(process.env["FC_NUM_RUNS"] ?? 100);

describe("onSharedGatewayPath", () => {
  test("recognises IPFS and IPNS path-gateway URLs", () => {
    for (const path of [
      "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/",
      "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/index.html",
      "/ipns/abolishus.eth/",
      "/IPFS/x/",
      "/ipfs",
    ])
      expect(onSharedGatewayPath(path), path).toBe(true);
  });

  test("recognises them however the path is spelled", () => {
    for (const path of [
      "/%69pfs/x/",
      "/%2569pfs/x/",
      "/%252569pns/x/",
      "//ipfs/x/",
      "/./ipfs/x/",
      "\\ipfs\\x\\",
      "/%2Fipfs/x/",
      "/i%70f%73/x/",
      "/x/%2F..%2Fipfs/x/",
      "/x/..%2Fipfs/x/",
      "/x/%5C..%5Cipfs/x/",
    ])
      expect(onSharedGatewayPath(path), path).toBe(true);
  });

  test("refuses paths it can't decode, or that keep decoding", () => {
    expect(onSharedGatewayPath("/%E0%A4%A/")).toBe(true);
    expect(onSharedGatewayPath(`/${"%25".repeat(6)}69pfs/`)).toBe(true);
  });

  test("recognises any percent-encoding of the first segment", () => {
    const spelled = (word: string) =>
      fc
        .tuple(
          ...word
            .split("")
            .map((c) =>
              fc.constantFrom(
                c,
                c.toUpperCase(),
                `%${c.charCodeAt(0).toString(16)}`,
                `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
              ),
            ),
        )
        .map((parts) => parts.join(""));
    fc.assert(
      fc.property(fc.constantFrom("ipfs", "ipns").chain(spelled), fc.string(), (segment, rest) =>
        onSharedGatewayPath(`/${segment}/${encodeURIComponent(rest)}`),
      ),
      { numRuns },
    );
  });

  test("lets the client run at the root of its own origin or under another path", () => {
    for (const path of ["/", "/index.html", "/ballot/", "/ipfsx/", "/x/ipfs/", "/%69pfsx/"])
      expect(onSharedGatewayPath(path), path).toBe(false);
  });
});
