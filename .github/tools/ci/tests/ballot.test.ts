import { describe, expect, test } from "vite-plus/test";

import {
  BALLOT_CSP_TEXT,
  distViolations,
  htmlViolations,
  moduleViolations,
  packageOf,
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
        "/*! tailwindcss | https://tailwindcss.com */@font-face{src:url(./ibm-plex-sans-latin-400-normal-CDDApCn2.woff2)}",
      "assets/ibm-plex-sans-latin-400-normal-CDDApCn2.woff2": "wOF2",
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
  ];

  test("accepts React and the allowed workspace sources", () => {
    expect(moduleViolations(allowed, repo)).toEqual([]);
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

describe("htmlViolations", () => {
  test("accepts the client's page", () => {
    expect(htmlViolations(page())).toEqual([]);
  });

  test("rejects any change to the pinned policy", () => {
    for (const csp of [
      policy.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      policy.replace("connect-src 'none'", "connect-src https:"),
      policy.replace("; trusted-types 'none'", ""),
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

  test("rejects unexpected files", () => {
    for (const name of ["sw.js", "assets/x.wasm", "assets/tracker.png", ".well-known/x"])
      expect(distViolations(dist({ [name]: "" })).length, name).toBeGreaterThan(0);
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
