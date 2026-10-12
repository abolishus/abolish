import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

// Plain class maps rather than a variant library: anything `apps/ballot`
// imports carries no third-party runtime code beyond the framework (T-43).
const base =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-sm px-5 font-sans text-base font-semibold " +
  "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-accent " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-paper",
  secondary: "border-2 border-ink bg-transparent text-ink",
  quiet: "bg-transparent text-accent underline underline-offset-4",
};

/**
 * A native `<button>`, so keyboard activation, focus and its accessible role
 * come from the platform. The label is the children: callers pass translated
 * text, never a hard-coded string. Targets are at least 48px tall ("generous
 * targets"; WCAG 2.2 2.5.8 asks for 24).
 */
export function Button({ type = "button", variant = "primary", className, ...props }: ButtonProps) {
  const classes =
    className === undefined
      ? `${base} ${variants[variant]}`
      : `${base} ${variants[variant]} ${className}`;
  return <button type={type} className={classes} {...props} />;
}
