import type { ButtonHTMLAttributes } from "react";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement>;

/**
 * A native `<button>`, so keyboard activation, focus and its accessible role
 * come from the platform. The label is the children: callers pass translated
 * text, never a hard-coded string.
 */
export function Button({ type = "button", ...props }: ButtonProps) {
  return <button type={type} {...props} />;
}
