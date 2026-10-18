// The challenge page's build for one deployment: the page's own settings,
// the deployment as a module the page imports, and `headers.json`, the
// headers whoever serves the page must send with it (`frame-ancestors`
// among them, which the page's `<meta>` policy can't carry). Both come from
// the same values, so the page never hands a token to an origin the headers
// don't let frame it (T-43).

import type { Plugin, UserConfig } from "vite-plus";

import type { ChallengeDeployment } from "./src/deployment.ts";
import { checkDeployment, pageHeaders } from "./src/policy.ts";

const VIRTUAL = "virtual:challenge-deployment";
const RESOLVED = `\0${VIRTUAL}`;

function deploymentPlugin(deployment: ChallengeDeployment): Plugin {
  checkDeployment(deployment);
  return {
    name: "challenge-deployment",
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : undefined),
    load: (id) =>
      id === RESOLVED
        ? `export const SITE_KEY = ${JSON.stringify(deployment.siteKey ?? null)};\n` +
          `export const ENTRY_POINTS = Object.freeze(${JSON.stringify(deployment.entryPoints)});\n`
        : undefined,
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "headers.json",
        source: `${JSON.stringify(pageHeaders(deployment), null, 2)}\n`,
      });
    },
  };
}

/** The build settings for `deployment`: `vite.config.ts` pins staging's, the e2e a test one. */
export function pageBuild(deployment: ChallengeDeployment): UserConfig {
  return {
    plugins: [deploymentPlugin(deployment)],
    // Relative URLs, so the same bytes serve at any path.
    base: "./",
    build: {
      modulePreload: { polyfill: false },
      // Nothing is inlined as a data: URL, so the policy needs no data: source.
      assetsInlineLimit: 0,
      sourcemap: false,
    },
  };
}
