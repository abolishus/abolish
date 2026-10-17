import { describe, expect, test } from "vite-plus/test";

import { createHash } from "node:crypto";

import {
  BALLOT_CSP_TEXT,
  distViolations,
  htmlViolations,
  isProverBuild,
  moduleListViolations,
  moduleViolations,
  packageOf,
  PROVER_ARTIFACTS,
} from "../src/ballot.ts";

const repo = "/repo";
const pnpm = (name: string, file: string) =>
  `${repo}/node_modules/.pnpm/${name.replace("/", "+")}@1.0.0/node_modules/${name}/${file}`;

const policy = BALLOT_CSP_TEXT;

const page = (csp = policy, extra = "") => `<!doctype html>
<html lang="en-US">
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="${csp}"
    />
    <meta name="referrer" content="no-referrer" />
    <title>Abolish ballot</title>
    <script type="module" crossorigin src="./assets/index-BuPP35rj.js"></script>
    <link rel="stylesheet" crossorigin href="./assets/index-C6Etfezz.css">${extra}
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

const dist = (overrides: Record<string, string> = {}) =>
  new Map(
    Object.entries({
      "index.html": page(),
      "assets/index-BuPP35rj.js":
        'const s="http://www.w3.org/2000/svg";throw Error("https://react.dev/errors/"+e)',
      "assets/index-C6Etfezz.css":
        "/*! tailwindcss | https://tailwindcss.com */@font-face{src:url(./oxanium-latin-wght-normal-CDDApCn2.woff2)}",
      "assets/oxanium-latin-wght-normal-CDDApCn2.woff2": "wOF2",
      "third-party-licenses.md": "# Licenses",
      "font-licenses.txt": "SIL Open Font License, Version 1.1 http://scripts.sil.org/OFL",
      ...overrides,
    }),
  );

describe("packageOf", () => {
  test("names the package of a file in its pnpm store entry, scoped or not", () => {
    expect(packageOf(pnpm("react-dom", "cjs/react-dom.production.js"), repo)).toBe("react-dom");
    expect(packageOf(pnpm("@scope/pkg", "index.js"), repo)).toBe("@scope/pkg");
  });

  test("names nothing for paths that only look like a package", () => {
    for (const id of [
      `${repo}/apps/ballot/src/main.tsx`,
      `${repo}/node_modules/react/index.js`,
      `${repo}/tools/node_modules/react/x.js`,
      `${repo}/node_modules/.pnpm/evil@1.0.0/node_modules/evil/node_modules/react/x.js`,
      "/elsewhere/node_modules/.pnpm/react@1.0.0/node_modules/react/x.js",
    ])
      expect(packageOf(id, repo), id).toBeUndefined();
  });
});

describe("moduleViolations", () => {
  const allowed = [
    pnpm("react", "index.js"),
    pnpm("react-dom", "client.js"),
    pnpm("scheduler", "index.js"),
    `${repo}/apps/ballot/index.html`,
    `${repo}/apps/ballot/src/main.tsx`,
    `${repo}/packages/ui/src/index.ts`,
    `${repo}/packages/crypto/dist/index.mjs`,
    pnpm("@noble/curves", "ed25519.js"),
    pnpm("@noble/hashes", "sha2.js"),
    pnpm("@noble/ciphers", "chacha.js"),
    pnpm("@noble/post-quantum", "ml-kem.js"),
    `${repo}/apps/ballot/src/worker.ts?worker&url`,
  ];

  test("accepts React, @abolishus/crypto's build, its @noble/* libraries and the allowed workspace sources", () => {
    expect(moduleViolations(allowed, repo)).toEqual([]);
  });

  test("rejects @abolishus/crypto's source and @noble/* packages it doesn't use", () => {
    for (const id of [
      `${repo}/packages/crypto/src/index.ts`,
      `${repo}/packages/crypto/package.json`,
      `${repo}/packages/crypto-evil/dist/index.mjs`,
      pnpm("@noble/secp256k1", "index.js"),
      pnpm("@noble-evil/curves", "index.js"),
    ])
      expect(moduleViolations([id], repo), id).toHaveLength(1);
  });

  test("rejects any other npm package", () => {
    expect(moduleViolations([...allowed, pnpm("posthog-js", "dist/module.js")], repo)).toHaveLength(
      1,
    );
    expect(moduleViolations([pnpm("@sentry/browser", "index.js")], repo)).toHaveLength(1);
  });

  test("rejects workspace code outside the client and @abolishus/ui", () => {
    for (const id of [
      `${repo}/packages/core/src/index.ts`,
      `${repo}/apps/ballot/tests/csp.ts`,
      `${repo}/apps/ballot/vite.config.ts`,
      `${repo}/packages/ui-evil/src/index.ts`,
      "/elsewhere/evil.js",
    ])
      expect(moduleViolations([id], repo), id).toHaveLength(1);
  });

  test("rejects virtual modules a plugin makes up", () => {
    expect(moduleViolations(["\0virtual:tracker", "virtual:tracker"], repo)).toHaveLength(2);
    expect(moduleViolations([`\0${pnpm("react", "index.js")}`], repo)).toHaveLength(1);
  });

  test("rejects React-named code outside its store entry", () => {
    for (const id of [
      `${repo}/tools/node_modules/react/x.js`,
      `${repo}/apps/ballot/src/node_modules/react/x.js`,
      "/elsewhere/node_modules/react/x.js",
      `${repo}/node_modules/.pnpm/evil@1.0.0/node_modules/evil/node_modules/react/x.js`,
    ])
      expect(moduleViolations([id], repo), id).toHaveLength(1);
  });
});

describe("moduleListViolations", () => {
  const react = [pnpm("react", "index.js"), pnpm("react-dom", "client.js")];
  const pageBuild = (modules: string[] = react) => ({
    worker: false,
    chunks: ["assets/index-BuPP35rj.js"],
    modules,
  });
  const workerBuild = (chunk: string, modules: string[]) => ({
    worker: true,
    chunks: [chunk],
    modules,
  });
  const snarkjs = pnpm("snarkjs", "build/browser.esm.js");
  const ffjavascript = pnpm("ffjavascript", "build/browser.esm.js");
  const adapter = `${repo}/packages/membership-prover/src/index.ts`;
  const prover = workerBuild("assets/prover-D4bX0ZyQ.js", [
    `${repo}/apps/ballot/src/prover/prover.ts`,
    adapter,
    snarkjs,
    ffjavascript,
    `${repo}/packages/crypto/dist/index.mjs`,
  ]);
  const ballotWorker = workerBuild("assets/worker-D4bX0ZyQ.js", [
    `${repo}/apps/ballot/src/worker/worker.ts`,
    pnpm("@noble/curves", "ed25519.js"),
  ]);

  test("accepts builds of allowed modules that include react-dom", () => {
    expect(moduleListViolations([pageBuild()], repo)).toEqual([]);
    expect(moduleListViolations([pageBuild(), ballotWorker], repo)).toEqual([]);
  });

  test("rejects a report that isn't a list of builds", () => {
    for (const report of [
      null,
      {},
      "x",
      react,
      [1],
      [pageBuild(), null],
      [{ ...pageBuild(), worker: "false" }],
      [{ ...pageBuild(), modules: [...react, null] }],
      [{ ...pageBuild(), chunks: "assets/index.js" }],
    ])
      expect(moduleListViolations(report, repo).length, JSON.stringify(report)).toBeGreaterThan(0);
  });

  test("rejects a report without react-dom, which would make the check vacuous", () => {
    expect(moduleListViolations([], repo).length).toBeGreaterThan(0);
    expect(
      moduleListViolations([pageBuild([pnpm("react", "index.js")])], repo).length,
    ).toBeGreaterThan(0);
  });

  test("admits snarkjs's and ffjavascript's browser builds and their adapter in the prover worker", () => {
    expect(isProverBuild(prover)).toBe(true);
    expect(moduleListViolations([pageBuild(), ballotWorker, prover], repo)).toEqual([]);
  });

  test("rejects the prover's code in the page or the ballot worker", () => {
    for (const id of [snarkjs, ffjavascript, adapter]) {
      expect(moduleListViolations([pageBuild([...react, id])], repo), id).toHaveLength(1);
      const worker = { ...ballotWorker, modules: [...ballotWorker.modules, id] };
      expect(moduleListViolations([pageBuild(), worker], repo), id).toHaveLength(1);
    }
  });

  test("tells the prover worker by its one chunk's name, built as a worker", () => {
    for (const build of [
      { ...prover, worker: false },
      { ...prover, chunks: ["assets/worker-D4bX0ZyQ.js"] },
      { ...prover, chunks: ["assets/prover-D4bX0ZyQ.js", "assets/x-D4bX0ZyQ.js"] },
      { ...prover, chunks: [] },
      { ...prover, chunks: ["assets/prover.js"] },
      { ...prover, chunks: ["prover-D4bX0ZyQ.js"] },
    ]) {
      expect(isProverBuild(build), JSON.stringify(build.chunks)).toBe(false);
      expect(moduleListViolations([pageBuild(), build], repo).length).toBeGreaterThan(0);
    }
  });

  test("admits no other file of snarkjs or ffjavascript, and no other package, in the prover worker", () => {
    for (const id of [
      pnpm("snarkjs", "main.js"),
      pnpm("snarkjs", "build/main.cjs"),
      pnpm("snarkjs", "build/snarkjs.min.js"),
      pnpm("ffjavascript", "main.js"),
      pnpm("ffjavascript", "build/browser.esm.js.map"),
      pnpm("circom_runtime", "build/main.cjs"),
      pnpm("fastfile", "src/fastfile.js"),
      pnpm("wasmcurves", "index.js"),
      pnpm("web-worker", "index.js"),
      `${repo}/node_modules/.pnpm/snarkjs@0.7.5/node_modules/snarkjs/node_modules/x/build/browser.esm.js`,
      `${repo}/packages/membership-prover/package.json`,
      `${repo}/packages/membership-prover/artifacts/x.js`,
      `${repo}/packages/membership-prover-evil/src/index.ts`,
      `${repo}/packages/core/src/index.ts`,
    ]) {
      const build = { ...prover, modules: [...prover.modules, id] };
      expect(moduleListViolations([pageBuild(), build], repo), id).toHaveLength(1);
    }
  });
});

describe("htmlViolations", () => {
  test("accepts the client's page", () => {
    expect(htmlViolations(page())).toEqual([]);
  });

  test("pins script-src 'self' 'wasm-unsafe-eval' and connect-src 'self' before the two origins", () => {
    expect(policy).toContain("; script-src 'self' 'wasm-unsafe-eval'; ");
    expect(policy).toContain(
      "; connect-src 'self' https://api-staging.abolish.us https://sepolia.base.org; ",
    );
  });

  test("rejects any change to the pinned policy", () => {
    for (const csp of [
      policy.replace("script-src 'self' 'wasm-unsafe-eval'", "script-src 'self'"),
      policy.replace(" 'wasm-unsafe-eval'", " 'unsafe-eval'"),
      policy.replace(" 'wasm-unsafe-eval'", " 'wasm-unsafe-eval' 'unsafe-eval'"),
      policy.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      policy.replace("connect-src 'self' ", "connect-src "),
      policy.replace("connect-src 'self' ", "connect-src https: "),
      policy.replace("connect-src 'self' ", "connect-src 'self' https: "),
      policy.replace("connect-src 'self' ", "connect-src * "),
      policy.replace("https://sepolia.base.org", "https://sepolia.base.org.example.com"),
      policy.replace(" https://sepolia.base.org", ""),
      policy.replace("; trusted-types ballot-worker", ""),
      policy.replace(
        "trusted-types ballot-worker",
        "trusted-types ballot-worker 'allow-duplicates'",
      ),
      policy.replace("trusted-types ballot-worker", "trusted-types ballot-worker other"),
      policy.replace("worker-src 'self'", "worker-src 'self' blob:"),
      policy.replace("; worker-src 'self'", ""),
      `${policy}; worker-src *`,
      policy.replace("; ", ";"),
      ` ${policy}`,
      `${policy}; script-src *`,
    ])
      expect(htmlViolations(page(csp)).length, csp).toBeGreaterThan(0);
  });

  test("rejects anything placed before the policy", () => {
    const early = page().replace(
      '<meta charset="utf-8" />',
      '<meta charset="utf-8" /><img src="./assets/x.js">',
    );
    expect(htmlViolations(early).length).toBeGreaterThan(0);
  });

  test("rejects a policy hidden in a comment, and any element outside the fixed set", () => {
    const commented = page().replace(
      '<meta charset="utf-8" />',
      `<!-- <meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${policy}" /> -->`,
    );
    const stripped = commented.replace(
      /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/>\n/,
      "",
    );
    expect(htmlViolations(stripped).length).toBeGreaterThan(0);
    for (const extra of [
      "<!-- note -->",
      "<![CDATA[x]]>",
      "<template><img src=x></template>",
      "<noscript><img src=x></noscript>",
      "<textarea></textarea>",
      "<iframe></iframe>",
      "<base href=x>",
    ])
      expect(htmlViolations(page(policy, extra)).length, extra).toBeGreaterThan(0);
  });

  test("rejects pages a browser parses with no policy", () => {
    const csp = `<meta\n      http-equiv="Content-Security-Policy"\n      content="${policy}"\n    />`;
    for (const [label, edit] of [
      ["bogus comment <?", (p: string) => p.replace(csp, `<?${csp}`)],
      ["bogus comment </<", (p: string) => p.replace(csp, `</${csp}`)],
      ["text closes <head>", (p: string) => p.replace("<head>", "<head>&nbsp;")],
      ["invisible text closes <head>", (p: string) => p.replace("<head>", "<head>\u200b")],
      ["no doctype", (p: string) => p.replace("<!doctype html>", "")],
      [
        "vertical tab in the meta tag",
        (p: string) => p.replace("<meta\n      http-equiv", "<meta\vhttp-equiv"),
      ],
      [
        "vertical tab in the policy",
        (p: string) => p.replace("default-src 'none'", "default-src\v'none'"),
      ],
      ["policy after the title", (p: string) => p.replace(csp, "<title>x</title>" + csp)],
    ] as const) {
      const edited = edit(page());
      expect(edited, label).not.toBe(page());
      expect(htmlViolations(edited).length, label).toBeGreaterThan(0);
    }
  });

  test("rejects a second policy, however it is written", () => {
    expect(
      htmlViolations(
        page(policy, `<meta content="script-src *" http-equiv=content-security-policy>`),
      ).length,
    ).toBeGreaterThan(0);
  });

  test("rejects any <meta> but the four the client uses", () => {
    for (const extra of [
      '<meta http-equiv="refresh" content="0;//evil.example/ballot">',
      '<meta http-equiv="refresh" content="0; url= //evil.example">',
      '<meta http-equiv="refresh" content="0;url=\\\\evil.example">',
      '<meta name="referrer" content="unsafe-url" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" http-equiv="refresh" />',
    ])
      expect(htmlViolations(page(policy, extra)).length, extra).toBeGreaterThan(0);
  });

  test("rejects inline code and foreign references", () => {
    for (const extra of [
      "<script>alert(1)</script>",
      '<script src="https://cdn.example.com/x.js"></script>',
      "<style>body{}</style>",
      '<div style="color:red"></div>',
      '<img src="./assets/x.js" onerror="alert(1)">',
      '<link rel="stylesheet" href="//cdn.example.com/x.css">',
      "<img src=https://example.com/pixel.gif>",
    ])
      expect(htmlViolations(page(policy, extra)).length, extra).toBeGreaterThan(0);
  });
});

describe("distViolations", () => {
  test("accepts the client's output", () => {
    expect(distViolations(dist())).toEqual([]);
  });

  test("leaves the page exactly the ballot worker and the prover worker to start", () => {
    const worker = "assets/worker-D4bX0ZyQ.js";
    const prover = "assets/prover-Bo9fY3VB.js";
    const code = "self.onmessage=e=>postMessage(e.data)";
    expect(distViolations(dist({ [worker]: code }))).toEqual([]);
    expect(distViolations(dist({ [worker]: code, [prover]: code }))).toEqual([]);
    for (const extra of [
      { "assets/other-D4bX0ZyQ.js": code },
      { "assets/index-D4bX0ZyQ.js": code },
      { "assets/worker-Bo9fY3VB.js": code },
      { "assets/prover-D4bX0ZyQ.js": code },
    ])
      expect(
        distViolations(dist({ [worker]: code, [prover]: code, ...extra })).length,
        Object.keys(extra)[0],
      ).toBeGreaterThan(0);
    // ...and loads neither itself, where its code would run beside the page's.
    for (const name of [worker, prover]) {
      const loaded = page(policy, `<script type="module" src="./${name}"></script>`);
      expect(
        distViolations(dist({ "index.html": loaded, [name]: code })).length,
        name,
      ).toBeGreaterThan(0);
    }
  });

  test("lets only the scripts index.html loads reach the network or load code", () => {
    const page = "assets/index-BuPP35rj.js";
    const worker = "assets/worker-D4bX0ZyQ.js";
    expect(distViolations(dist({ [page]: 'fetch("./definition")' }))).toEqual([]);
    expect(distViolations(dist({ [worker]: "self.onmessage=e=>postMessage(e.data)" }))).toEqual([]);
    // Lookalike names a minified library carries aren't the APIs.
    expect(distViolations(dist({ [worker]: "x.fetchPriority;prefetchDNS();y.Workers" }))).toEqual(
      [],
    );
    for (const code of [
      'fetch("https://x")',
      "self.fetch(u)",
      "new XMLHttpRequest",
      "new WebSocket(u)",
      "new WebTransport(u)",
      "new EventSource(u)",
      'importScripts("./x.js")',
      "new Worker(u)",
      "new SharedWorker(u)",
      'import("./x.js")',
    ]) {
      expect(distViolations(dist({ [worker]: code })).length, code).toBeGreaterThan(0);
      // The prover worker's chunk, snarkjs and all, is held to the same ban.
      const prover = "assets/prover-Bo9fY3VB.js";
      expect(distViolations(dist({ [prover]: code })).length, code).toBeGreaterThan(0);
    }
  });

  test("lets the scripts name Base UI's error-decoder link, and nothing else on its host", () => {
    const page = "assets/index-BuPP35rj.js";
    expect(
      distViolations(dist({ [page]: 'f("https://base-ui.com/production-error","Base UI")' })),
    ).toEqual([]);
    for (const url of [
      "https://base-ui.com/",
      "https://base-ui.com/production-error/x",
      "https://base-ui.com.example.com/production-error",
    ])
      expect(distViolations(dist({ [page]: `fetch("${url}")` })).length, url).toBeGreaterThan(0);
  });

  test("lets the scripts name the allowed origins, but no lookalike of them", () => {
    const page = "assets/index-BuPP35rj.js";
    for (const url of [
      "https://api-staging.abolish.us",
      "https://api-staging.abolish.us/elections",
      "https://sepolia.base.org/",
    ])
      expect(distViolations(dist({ [page]: `fetch("${url}")` })), url).toEqual([]);
    for (const url of [
      "https://api-staging.abolish.us.example.com/",
      "https://api-staging.abolish.us@example.com/",
      "https://abolish.us/",
      "https://api.abolish.us/",
      "http://api-staging.abolish.us/",
      "https://sepolia.base.org.example.com",
    ])
      expect(distViolations(dist({ [page]: `fetch("${url}")` })).length, url).toBeGreaterThan(0);
  });

  test("rejects WebRTC anywhere, which no CSP directive governs", () => {
    for (const name of ["assets/index-BuPP35rj.js", "assets/worker-D4bX0ZyQ.js"])
      for (const code of ["new RTCPeerConnection(c)", "RTCDataChannel"])
        expect(distViolations(dist({ [name]: code })).length, `${name}: ${code}`).toBeGreaterThan(
          0,
        );
  });

  test("rejects unexpected files", () => {
    for (const name of [
      "sw.js",
      "assets/x.wasm",
      "assets/x.zkey",
      "assets/tracker.png",
      ".well-known/x",
      "semaphore-32.zkey",
      "assets/sub/x.wasm",
    ])
      expect(distViolations(dist({ [name]: "" })).length, name).toBeGreaterThan(0);
  });

  test("emits the prover's key and witness calculator only as the pinned bytes", () => {
    expect(Object.keys(PROVER_ARTIFACTS).sort()).toEqual(["wasm", "zkey"]);
    // Bytes with the real digests can't be made up, so stand-ins are pinned.
    const sha256 = (text: string) => createHash("sha256").update(text, "latin1").digest("hex");
    const pins = { zkey: sha256("zkey\x00\xff"), wasm: sha256("\x00asm") };
    const zkey = "assets/semaphore-32-D4bX0ZyQ.zkey";
    const wasm = "assets/semaphore-32-D4bX0ZyQ.wasm";
    expect(distViolations(dist({ [zkey]: "zkey\x00\xff", [wasm]: "\x00asm" }), pins)).toEqual([]);
    for (const [name, text] of [
      [zkey, "zkey\x00\xfe"],
      [wasm, "zkey\x00\xff"],
      [zkey, "\x00asm"],
    ] as const)
      expect(distViolations(dist({ [name]: text }), pins), name).toHaveLength(1);
    // The real pins refuse the stand-ins.
    expect(distViolations(dist({ [zkey]: "zkey\x00\xff" }))).toHaveLength(1);
  });

  test("rejects a build without index.html", () => {
    const files = dist();
    files.delete("index.html");
    expect(distViolations(files).length).toBeGreaterThan(0);
  });

  test("rejects analytics markers, foreign URLs and string evaluation", () => {
    for (const js of [
      'import("posthog-js")',
      'fetch("https://collector.example.com/e")',
      'new WebSocket("wss://x.example.com")',
      'fetch("//collector.example.com/e")',
      'fetch("\\/\\/collector.example.com/e")',
      'fetch("https:\\/\\/collector.example.com/e")',
      "navigator.sendBeacon(u,d)",
      'eval("1")',
      'new Function("return 1")',
      'setTimeout("x()",1)',
    ])
      expect(distViolations(dist({ "assets/index-BuPP35rj.js": js })).length, js).toBeGreaterThan(
        0,
      );
  });

  test("rejects foreign URLs in stylesheets too", () => {
    expect(
      distViolations(
        dist({ "assets/index-C6Etfezz.css": "@import url(https://fonts.example.com/x.css)" }),
      ).length,
    ).toBeGreaterThan(0);
  });
});
