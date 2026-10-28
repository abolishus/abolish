import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";

import { Failed, NotFound, Offline, SiteLayout } from "./site-layout.tsx";

const meta = {
  component: SiteLayout,
  parameters: { layout: "fullscreen" },
  args: { children: <NotFound /> },
} satisfies Meta<typeof SiteLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

const play: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const nav = canvas.getByRole("navigation", { name: "Site" });
  await expect(within(nav).getByRole("link", { name: "Discover" })).toHaveAttribute(
    "href",
    "/discover",
  );
  // A phone's header leaves out the three links that don't fit; the footer
  // lists all five at every width.
  const wide = canvasElement.ownerDocument.documentElement.clientWidth >= 768;
  await expect(within(nav).queryAllByRole("link")).toHaveLength(wide ? 5 : 2);
  const footer = canvas.getByRole("navigation", { name: "The record" });
  await expect(within(footer).getByRole("link", { name: "Moderation log" })).toHaveAttribute(
    "href",
    "/moderation",
  );
  await expect(within(footer).getAllByRole("link")).toHaveLength(5);
  await expect(canvas.getByRole("main")).toBeVisible();
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
    "There is no page at this address",
  );
  const ways = canvas.getByRole("navigation", { name: "Other places to go" });
  await expect(within(ways).getByRole("link", { name: /^Polls/ })).toHaveAttribute(
    "href",
    "/polls",
  );
  // Where an everyday visitor finds a shared poll again, by its question.
  await expect(within(ways).getByRole("link", { name: /^Discover/ })).toHaveAttribute(
    "href",
    "/discover",
  );
  await expect(within(ways).getAllByRole("link")).toHaveLength(4);
  // Everyday words: a lost visitor knows a site, not a server.
  await expect(ways).not.toHaveTextContent(/server/);
  await expect(canvas.getByRole("main")).not.toHaveTextContent(/64-character|board entries/);
  await userEvent.tab();
  await expect(canvas.getByRole("link", { name: "Skip to content" })).toHaveFocus();
};

export const Default: Story = { play };

export const Dark: Story = { parameters: { theme: "dark" }, play };

/**
 * The frame in Spanish (P2-28 part 4): its words, the footer's languages
 * with Español the current one, and the longer words still in one header
 * row on a phone (the phone project runs every story at 360px).
 */
export const Spanish: Story = {
  parameters: { locale: "es-US" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole("navigation", { name: "Sitio" });
    await expect(within(nav).getByRole("link", { name: "Descubrir" })).toHaveAttribute(
      "href",
      "/discover",
    );
    await expect(canvas.getByRole("link", { name: "Saltar al contenido" })).toBeInTheDocument();
    const languages = canvas.getByRole("navigation", { name: "Idioma" });
    await expect(within(languages).getByText("Español")).toHaveAttribute("aria-current", "true");
    await expect(within(languages).getByRole("button", { name: "English" })).toHaveAttribute(
      "lang",
      "en-US",
    );
    // One row is 72px (48px targets and 12px above and below); two would be 120.
    const header = canvasElement.querySelector("header");
    await expect(header?.getBoundingClientRect().height).toBeLessThanOrEqual(73);
  },
};

export const Current: Story = {
  args: { current: "/polls" },
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole("navigation", { name: "Site" });
    await expect(within(nav).getByRole("link", { name: "Polls" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(within(nav).getByRole("link", { name: "Discover" })).not.toHaveAttribute(
      "aria-current",
    );
    const footer = within(canvasElement).getByRole("navigation", { name: "The record" });
    await expect(within(footer).getByRole("link", { name: "Polls" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  },
};

/**
 * On a phone, a page whose link is only in the footer is marked there: the
 * header names no current page, and the footer's link says it is this one.
 */
export const CurrentPhone: Story = {
  args: { current: "/moderation" },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const nav = canvas.getByRole("navigation", { name: "Site" });
    // Its header link is there but hidden below 768px.
    await expect(
      within(nav)
        .getAllByRole("link")
        .filter((a) => a.hasAttribute("aria-current")),
    ).toHaveLength(0);
    const footer = canvas.getByRole("navigation", { name: "The record" });
    const here = within(footer).getByRole("link", { name: "Moderation log" });
    await expect(here).toHaveAttribute("aria-current", "page");
    await expect(getComputedStyle(here).fontWeight).toBe("600");
    await expect(footer.querySelectorAll("[aria-current]")).toHaveLength(1);
  },
};

export const Error: Story = {
  args: { children: <Failed /> },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Something went wrong on our side",
    );
    // Says nothing about the error itself: no codes, traces or request IDs.
    await expect(canvasElement.querySelector("main")?.textContent ?? "").not.toMatch(
      /\b(5\d\d|stack|exception|request id|trace)\b/i,
    );
    await expect(canvas.getByRole("button", { name: "Try again" })).toBeEnabled();
    // The ballot reassurance is its own paragraph, under the plain account.
    await expect(canvas.getByText(/never handles ballots/).tagName).toBe("P");
    await expect(canvas.getByText(/^This page couldn't be shown/)).not.toHaveTextContent(/ballot/);
    // No label above the title repeating it.
    await expect(canvasElement.querySelector("main .font-mono")).toBeNull();
  },
};

// Its own dark story, so axe judges the error page's colours in both themes
// as it does not found's and the offline page's.
export const ErrorDark: Story = { ...Error, parameters: { theme: "dark" } };

const offline: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent("You're offline");
  await expect(canvas.getByText(/keeps only this page and its fonts/)).toBeVisible();
  // Served with no script, trying again is a link to the address in the bar
  // (tests/ssr.test.ts has the served page's own, empty, `href`).
  await expect(canvas.getByRole("link", { name: "Try again" })).toHaveAttribute(
    "href",
    "/polls?after=3",
  );
  await expect(canvas.queryByRole("button")).toBeNull();
  // Offline, every other page fails as this one did, so it offers none:
  // not in the body, nor in the frame's header and footer.
  await expect(canvas.queryByRole("navigation")).toBeNull();
  await expect(canvas.getAllByRole("link").map((a) => a.textContent)).toEqual([
    "Skip to content",
    "Try again",
  ]);
  await expect(canvas.getByText("Abolish")).toBeVisible();
  await expect(getComputedStyle(canvas.getByRole("link", { name: "Try again" })).fontSize).toBe(
    "16px",
  );
};

/** What the offline shell shows when a page can't be fetched (src/app/offline.ts). */
export const OfflinePage: Story = {
  args: { links: false, children: <Offline retry="/polls?after=3" /> },
  play: offline,
};

export const OfflineDark: Story = {
  args: { links: false, children: <Offline retry="/polls?after=3" /> },
  parameters: { theme: "dark" },
  play: offline,
};

// A small phone's first screen: 360 by 640, the frame's header included.
const firstScreen = async (canvasElement: HTMLElement, first: HTMLElement) => {
  await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
  await expect(first.getBoundingClientRect().top).toBeLessThan(640 - 48);
};

/** The error page's one action is on a small phone's first screen. */
export const ErrorPhone: Story = {
  args: { children: <Failed /> },
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const retry = within(canvasElement).getByRole("button", { name: "Try again" });
    await firstScreen(canvasElement, retry);
    await expect(retry.getBoundingClientRect().bottom).toBeLessThanOrEqual(640);
  },
};

/** Not found's first place to go starts on a small phone's first screen. */
export const NotFoundPhone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const ways = within(canvasElement).getByRole("navigation", { name: "Other places to go" });
    await firstScreen(canvasElement, within(ways).getByRole("link", { name: /^Discover/ }));
  },
};

/** A phone's header is one row: the wordmark, Discover, Polls and Account. */
export const HeaderPhone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const nav = canvas.getByRole("navigation", { name: "Site" });
    await expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Discover", "Polls"]);
    // 48px links and the header's padding: wrapped, it was 177px tall.
    const header = canvasElement.querySelector("header");
    await expect(header?.getBoundingClientRect().height).toBeLessThan(80);
    const account = canvas.getByRole("link", { name: "Account" });
    await expect(account.getBoundingClientRect().top).toBe(
      within(nav).getByRole("link", { name: "Discover" }).getBoundingClientRect().top,
    );
  },
};

/** On a phone the footer follows a short page without a screen's worth of blank. */
export const FooterPhone: Story = {
  globals: { viewport: { value: "phone", isRotated: false } },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.ownerDocument.documentElement.clientWidth).toBe(360);
    const ways = within(canvasElement).getByRole("navigation", { name: "Other places to go" });
    const footer = canvasElement.querySelector("footer");
    // The page's padding and the footer's margin: it was 136px, a fifth of the screen.
    await expect(
      (footer?.getBoundingClientRect().top ?? 0) - ways.getBoundingClientRect().bottom,
    ).toBeLessThanOrEqual(88);
  },
};
