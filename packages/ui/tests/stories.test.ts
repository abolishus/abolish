import { readdirSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

// Recursive, so a component in a subdirectory can't skip its story.
const dir = new URL("../src/components/", import.meta.url);
const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) =>
  f.replaceAll("\\", "/"),
);
const components = files.filter((f) => f.endsWith(".tsx") && !f.endsWith(".stories.tsx"));

describe("components", () => {
  it("has at least one component", () => {
    expect(components.length).toBeGreaterThan(0);
  });

  // AGENTS.md "Testing": every component has a story, which is where its
  // interaction and axe checks run (`test:storybook`).
  it.each(components)("%s has a story", (component) => {
    expect(files).toContain(component.replace(/\.tsx$/, ".stories.tsx"));
  });
});
