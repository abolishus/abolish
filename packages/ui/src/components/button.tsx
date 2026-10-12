import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "quiet";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const base =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-md px-5 font-sans text-base font-semibold " +
  "focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  secondary: "border border-input bg-background text-foreground hover:bg-muted",
  quiet: "bg-transparent text-foreground underline decoration-primary underline-offset-4",
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
