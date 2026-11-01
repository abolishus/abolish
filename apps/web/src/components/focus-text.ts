import { expect } from "storybook/test";

/**
 * Stories' check that a text link takes `focus-text` (styles.css): focused
 * from the keyboard, a solid 3px outline 2px out, the square shape every box
 * draws, rather than the browser's thin rounded outline across the link's
 * underline (P2-29, the stream's iteration 33 and the poll page's iteration 4).
 */
export async function expectTextFocus(link: HTMLElement): Promise<void> {
  link.focus();
  await expect(link.matches(":focus-visible")).toBe(true);
  const style = getComputedStyle(link);
  await expect(`${style.outlineStyle} ${style.outlineWidth}`).toBe("solid 3px");
  await expect(style.outlineOffset).toBe("2px");
  link.blur();
}
