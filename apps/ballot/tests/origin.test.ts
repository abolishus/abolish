import { describe, expect, test } from "vite-plus/test";

import { onSharedGatewayPath } from "../src/origin.ts";

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

  test("lets the client run at the root of its own origin or under another path", () => {
    for (const path of ["/", "/index.html", "/ballot/", "/ipfsx/", "/x/ipfs/"])
      expect(onSharedGatewayPath(path), path).toBe(false);
  });
});
