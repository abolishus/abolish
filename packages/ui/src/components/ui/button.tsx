import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "cn";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-none border border-transparent bg-clip-padding text-xs font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/80",
        outline:
          "border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50",
        // Adapted for WCAG 2.2 AA contrast: the CLI's tinted fill put the
        // destructive text at 4:1 in light, and its primary link text at
        // 2.6:1 in dark. Text stays on the page's own ground instead.
        destructive:
          "border-destructive bg-background text-destructive hover:underline focus-visible:border-destructive",
        link: "text-foreground underline decoration-primary underline-offset-4 hover:decoration-2",
      },
      // Every size is at least 48px ("generous targets", brief; WCAG 2.2
      // 2.5.8 asks for 24), so the CLI's xs and sm sizes are left out.
      size: {
        default:
          "h-12 gap-2 px-5 text-sm has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        lg: "h-14 gap-2 px-6 text-base has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5",
        icon: "size-12 [&_svg:not([class*='size-'])]:size-5",
        "icon-lg": "size-14 [&_svg:not([class*='size-'])]:size-6",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

/**
 * Added with `shadcn add button` (preset b2CQ2Q281) and adapted: larger
 * sizes and a full-strength focus ring. Base UI renders a native `<button>`
 * with `type="button"` unless told otherwise, so keyboard activation and its
 * role come from the platform and a button inside a form never submits it by
 * accident. The label is the children: callers pass translated text.
 */
function Button({ className, variant = "default", size = "default", ...props }: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>;

export { Button, buttonVariants, type ButtonProps };
